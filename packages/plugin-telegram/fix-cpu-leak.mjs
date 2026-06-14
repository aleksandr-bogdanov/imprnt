#!/usr/bin/env node
// Re-apply the 409-poller CPU-leak fix to the official Telegram channel plugin.
//
// imprnt's telegram plugin wraps telegram@claude-plugins-official because only
// Anthropic-allowlisted channels can register, so we inherit its bugs. v0.0.6
// leaks 100%-CPU orphan pollers that survive their session (reparent to launchd)
// and ignore SIGTERM: github.com/anthropics/claude-plugins-official/issues/2229.
//
// Root cause: onStart resets the retry counter, so a 409 Conflict makes the
// backoff Math.min(1000*0, 15000) = 0ms -> hot loop pins a core; the wedged
// event loop can't service SIGTERM, so orphans accumulate one per session.
//
// The fix (community branch adamlahbib:fix/telegram-409-poller-cpu-leak):
//   1. authoritative eviction at startup (SIGTERM -> wait 3s -> SIGKILL)
//   2. module-scope pollErrors/pollConflicts counters reset only on a real
//      inbound update, so backoff can't collapse to 0ms and give-up is reachable
//
// The patch lives in a managed cache dir, so any plugin update rewrites the file
// and drops it. This patcher is idempotent and version-agnostic (globs every
// installed version dir) -- run it again after any telegram plugin update.
//
//   node fix-cpu-leak.mjs          patch every installed version, in place
//   node fix-cpu-leak.mjs --reap   also SIGKILL orphaned pollers (ppid 1)
//   node fix-cpu-leak.mjs --check  report patched/unpatched, change nothing

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'

const PLUGIN_DIR = join(
  homedir(),
  '.claude/plugins/cache/claude-plugins-official/telegram',
)

const argv = new Set(process.argv.slice(2))
const CHECK = argv.has('--check')
const REAP = argv.has('--reap')

// Each edit: a literal substring that must be present exactly once on an
// unpatched file. Order does not matter -- all are verified before any write.
const EDITS = [
  {
    label: 'authoritative eviction (SIGTERM -> 3s -> SIGKILL)',
    find: "process.kill(stale, 'SIGTERM')\n  }",
    repl:
      "process.kill(stale, 'SIGTERM')\n" +
      "    // A poller wedged in a 0ms 409-retry loop can't service SIGTERM (its\n" +
      "    // event loop never idles). Wait up to 3s, then escalate to SIGKILL so\n" +
      "    // two pollers never fight over the token. (imprnt patch, issue #2229)\n" +
      '    const deadline = Date.now() + 3000\n' +
      '    while (Date.now() < deadline) {\n' +
      '      try { process.kill(stale, 0) } catch { break } // ESRCH: it is gone\n' +
      '      Bun.sleepSync(100)\n' +
      '    }\n' +
      "    try { process.kill(stale, 0); process.kill(stale, 'SIGKILL') } catch {}\n" +
      '  }',
  },
  {
    label: 'module-scope poll counters + reset-on-update middleware',
    find: "let botUsername = ''",
    repl:
      "let botUsername = ''\n\n" +
      '// Poll-retry counters. Reset ONLY on a real inbound update -- never in\n' +
      '// onStart, which fires on every restart and collapsed backoff to 0ms on a\n' +
      '// 409, pinning a core. (imprnt patch, issue #2229)\n' +
      'let pollErrors = 0\n' +
      'let pollConflicts = 0\n' +
      'bot.use((_ctx, next) => { pollErrors = 0; pollConflicts = 0; return next() })',
  },
  {
    label: 'drop attempt-counter from poll loop header',
    find: 'for (let attempt = 1; ; attempt++) {',
    repl: 'for (;;) {',
  },
  {
    label: 'drop attempt reset in onStart (the 0ms-collapse trigger)',
    find: '          attempt = 0\n',
    repl: '',
  },
  {
    label: 'give-up after 8 consecutive 409s (counter, not attempt)',
    find: 'if (is409 && attempt >= 8) {',
    repl: 'if (is409 && ++pollConflicts >= 8) {',
  },
  {
    label: 'give-up message uses the conflict counter',
    find: 'after ${attempt} attempts',
    repl: 'after ${pollConflicts} attempts',
  },
  {
    label: 'backoff uses error counter (cannot collapse to 0ms)',
    find: 'const delay = Math.min(1000 * attempt, 15000)',
    repl: 'const delay = Math.min(1000 * ++pollErrors, 15000)',
  },
  {
    label: 'first-409 detail uses the conflict counter',
    find: '${attempt === 1 ?',
    repl: '${pollConflicts === 1 ?',
  },
]

function versionDirs() {
  if (!existsSync(PLUGIN_DIR)) return []
  return readdirSync(PLUGIN_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(PLUGIN_DIR, d.name, 'server.ts'))
    .filter(existsSync)
}

function patchFile(path) {
  const src = readFileSync(path, 'utf8')
  if (src.includes('pollConflicts')) return { path, status: 'already-patched' }

  let out = src
  for (const e of EDITS) {
    if (!out.includes(e.find)) {
      return { path, status: 'anchor-missing', detail: e.label }
    }
    out = out.replace(e.find, e.repl)
  }
  if (!CHECK) writeFileSync(path, out)
  return { path, status: CHECK ? 'would-patch' : 'patched' }
}

function reapOrphans() {
  let pids = []
  try {
    pids = execSync('pgrep -f "telegram/.*/server.ts"', { encoding: 'utf8' })
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
  } catch {
    return [] // pgrep exits non-zero when nothing matches
  }
  const killed = []
  for (const pid of pids) {
    let ppid = ''
    try {
      ppid = execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf8' }).trim()
    } catch {
      continue
    }
    if (ppid === '1') {
      try {
        execSync(`kill -9 ${pid}`)
        killed.push(pid)
      } catch {}
    }
  }
  return killed
}

const files = versionDirs()
if (files.length === 0) {
  console.log(`no installed telegram plugin found under ${PLUGIN_DIR}`)
  process.exit(0)
}

let bad = false
for (const f of files) {
  const r = patchFile(f)
  console.log(`${r.status}${r.detail ? ` (${r.detail})` : ''}: ${r.path}`)
  if (r.status === 'anchor-missing') bad = true
}

if (REAP) {
  const killed = reapOrphans()
  console.log(
    killed.length
      ? `reaped ${killed.length} orphaned poller(s): ${killed.join(' ')}`
      : 'no orphaned pollers to reap',
  )
}

// anchor-missing means upstream changed the file (possibly already fixed). Exit
// non-zero so a wrapper notices, but never write a half-patched file.
process.exit(bad ? 1 : 0)
