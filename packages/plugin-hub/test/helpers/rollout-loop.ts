// Test infrastructure only. No loop policy is implemented here.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync, rmSync, symlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { rolloutFixture } from "./rollout-fixtures.ts"
import { fakeClaudeCli, healthyResult } from "./fake-cli.ts"
import { seam } from "./cluster.ts"
import { loadRegistry } from "../../src/registry/load.ts"
import { boxCommand } from "../../src/box/index.ts"
import type { BoxContext } from "../../src/box/types.ts"
import type { AdapterSession, TurnEnd } from "../../src/adapters/types.ts"

export function loopFixture() {
  const f = rolloutFixture()
  const home = join(f.dir, "ambient")
  const login = join(f.dir, "login", ".credentials.json")
  const marker = "synthetic-declared-login-" + crypto.randomUUID()
  const poison = "synthetic-ambient-login-" + crypto.randomUUID()
  const credential = { id: "loop-login", kind: "claude-login", file: login, owner: "p1" }
  const loginBytes = (value: string) => JSON.stringify({ claudeAiOauth: { accessToken: value, refreshToken: value, refreshTokenExpiresAt: 4102444800000 } })
  for (const dir of [dirname(login), join(home, ".claude", "plugins"), join(home, ".claude"), join(f.trees.person("p1").tree, ".claude")]) mkdirSync(dir, { recursive: true })
  writeFileSync(login, loginBytes(marker), { mode: 0o600 })
  writeFileSync(join(home, ".claude", ".credentials.json"), loginBytes(poison))
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "ambient-hook-sentinel" }] }] }, enabledPlugins: { "ambient-plugin-sentinel": true } }))
  writeFileSync(join(home, ".claude", "CLAUDE.md"), "ambient-account-instruction-sentinel")
  writeFileSync(join(f.trees.person("p1").tree, "CLAUDE.md"), "ambient-project-instruction-sentinel")
  writeFileSync(join(f.trees.person("p1").tree, ".claude", "settings.local.json"), '{"env":{"AMBIENT_SENTINEL":"ambient-local-settings-sentinel"}}')
  writeFileSync(f.files.fragment, "declared-fragment-sentinel\nRead the declared files.\n")
  writeFileSync(f.files.filing_rules, "declared-filing-rules-sentinel\nUse the synthetic note envelope.\n")
  let text = f.base.replace('adapter = "synthetic-loop"', 'adapter = "claude-code"')
  text = text.replace('[presets.daily]\n', '[presets.daily]\ncredential = "loop-login"\n')
  for (const key of ["fragment", "settings", "mcp"]) text = f.field("p1-lair", key, JSON.stringify(f.files[key]), text)
  text = f.field("p1-lair", "tools", '["Read", "Write", "Glob", "Grep"]', text)
  text = f.field("p1", "filing_rules", JSON.stringify(f.files.filing_rules), text)
  text += `\n[[credentials]]\nid = "loop-login"\nkind = "claude-login"\nfile = ${JSON.stringify(login)}\nowner = "p1"\n`
  f.write(text)
  const session = (generation: string) => {
    const path = join(f.stateDir, "p1", "sessions", "p1-lair", generation)
    mkdirSync(path, { recursive: true })
    return path
  }
  return { ...f, home, login, marker, poison, credential, loginBytes, session, registry: () => loadRegistry(f.file), text }
}
export type LoopFixture = ReturnType<typeof loopFixture>

// Only the synchronous launch preparation sees the planted parent environment.
// Restore it before the actual child or kernel wrapper executes.
export async function withAmbient<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value
    return await run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
export async function launchSeam() {
  const module = await seam("src/adapters/launch.ts")
  if (typeof module.makeLoopLaunch !== "function") throw new Error("D-176 missing makeLoopLaunch")
  const make = module.makeLoopLaunch as (options: Record<string, unknown>) => Promise<any>
  return (options: Record<string, unknown>) => withAmbient((options.ambientEnv ?? {}) as Record<string, string>, () => make(options))
}

// D-176 pins the inputs and outputs, not the spelling of the options object.
export function launchInput(f: LoopFixture, purpose = "ordinary", generation: string = crypto.randomUUID()) {
  const registry = f.registry()
  const sessionDir = f.session(generation)
  const agent = (registry as any).agents.find((one: any) => one.id === "p1-lair")
  return { registry, preset: (registry as any).presets.daily, credential: f.credential, agent,
    sessionDir, purpose, ambientEnv: { HOME: f.home, CLAUDE_CONFIG_DIR: join(f.home, ".claude"), CLAUDE_SECURESTORAGE_CONFIG_DIR: join(f.home, ".claude") }, box: { agent: "p1-lair", person: "p1", tree: f.trees.person("p1").tree,
      sharedZone: f.trees.sharedZone, otherTrees: [f.trees.person("p2").tree],
      stateRoot: join(f.stateDir, "p1"), otherStateRoots: [join(f.stateDir, "p2")], sessionDir, purpose } }
}

export function nativeWrap(ctx: BoxContext) {
  const profiles = new Set<string>()
  return {
    wrap(argv: string[]) {
      const command = boxCommand(argv, ctx)
      if (command.profile) {
        writeFileSync(command.profile.path, command.profile.text)
        profiles.add(command.profile.path)
      }
      return command.argv
    },
    stop() { for (const path of profiles) rmSync(path, { force: true }) },
  }
}

// Extend the existing fake CLI stream. The added preamble observes the actual
// process and declared sources. Its source-discovery model is a plumbing oracle,
// not evidence that the installed CLI obeys these options.
export function captureCli(file: string, f: LoopFixture) {
  return (argv: string[]) => {
    const script = fakeClaudeCli([healthyResult("synthetic answer")])([])[2]
    const preamble = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(1);
const value = name => { const n = args.indexOf(name); return n < 0 ? null : args[n+1]; };
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const source = value => { if (value === null) return null; try { return JSON.parse(value); } catch { const bytes = read(value); try { return JSON.parse(bytes); } catch { return bytes; } } };
const home = process.env.HOME || '';
const loginDir = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR || path.join(home, '.claude');
const login = path.join(loginDir, '.credentials.json');
const secret = read(login);
let selectedSecrets = [];
try { const oauth = JSON.parse(secret).claudeAiOauth; selectedSecrets = [oauth.accessToken, oauth.refreshToken].filter(v => typeof v === 'string' && v.length >= 8); } catch {}
const config = process.env.CLAUDE_CONFIG_DIR;
if (config) { fs.mkdirSync(config, {recursive:true}); fs.writeFileSync(path.join(config, 'session-write'), 'synthetic-session-state'); }
const noSettings = value('--setting-sources') === '';
const noInstructions = process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1' && noSettings;
const planted = ${JSON.stringify(f.trees.person("p1").tree)};
const ambient = noSettings ? [] : [read(path.join(home,'.claude','settings.json')), read(path.join(planted,'.claude','settings.local.json'))];
if (!noInstructions) ambient.push(read(path.join(home,'.claude','CLAUDE.md')), read(path.join(planted,'CLAUDE.md')));
const data = { argv: args, cwd: process.cwd(), env: { HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR },
  credential: login, credentialDigest: secret === null ? null : new Bun.CryptoHasher('sha256').update(secret).digest('hex'),
  leaked: Object.values(process.env).some(v => [${JSON.stringify(f.marker)},${JSON.stringify(f.poison)},...selectedSecrets].some(s => String(v).includes(s))),
  fragment: value('--append-system-prompt-file') ? read(value('--append-system-prompt-file')) : value('--append-system-prompt'),
  settings: source(value('--settings')), mcp: source(value('--mcp-config')), ambient: ambient.filter(Boolean) };
fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify(data));
`
    return [process.execPath, "-e", preamble + script, "--", ...argv]
  }
}

export async function ending(session: AdapterSession, text = "synthetic input", timeoutMs = 5000): Promise<TurnEnd> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = new Promise<TurnEnd>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("loop stream did not finish within its observation deadline")), timeoutMs)
      session.onTurnEnd(resolve)
    })
    await session.feed({ id: crypto.randomUUID(), text })
    return await result
  } finally { clearTimeout(timer) }
}

export function digest(bytes: string) { return new Bun.CryptoHasher("sha256").update(bytes).digest("hex") }

export function stateFiles(f: LoopFixture) {
  const files: Record<string, string> = {}
  for (const person of ["p1", "p2"]) {
    for (const kind of ["chatlog", "inbox"]) {
      const file = join(f.stateDir, person, kind, "probe.txt")
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${person}-${kind}-sentinel`)
      files[`${person}-${kind}`] = file
      const alias = join(f.trees.person("p1").tree, `${person}-${kind}-link`)
      symlinkSync(file, alias)
      files[`${person}-${kind}-link`] = alias
    }
  }
  return files
}

export function fileProbe(argv: string[], file: string, operation: "read" | "write") {
  const done = Bun.spawnSync([...argv, "/bin/sh", "-c", operation === "read" ? 'cat "$1"' : 'printf synthetic-write >> "$1"', "sh", file], { stdout: "pipe", stderr: "pipe", timeout: 5000 })
  return { code: done.exitCode, text: done.stdout.toString() }
}

export function controlledMcp() {
  const receipts: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const message = await request.json() as any
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
    let result: unknown
    if (message.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "synthetic", version: "1" } }
    else if (message.method === "tools/list") result = { tools: [{ name: "receipt", description: "Record a synthetic receipt", inputSchema: { type: "object", properties: { codeword: { type: "string" } }, required: ["codeword"] } }] }
    else if (message.method === "tools/call" && message.params?.name === "receipt") {
      receipts.push(String(message.params.arguments.codeword))
      result = { content: [{ type: "text", text: "synthetic receipt recorded" }] }
    } else return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } })
    return Response.json({ jsonrpc: "2.0", id: message.id, result })
  } })
  return { url: `http://127.0.0.1:${server.port}/mcp`, receipts, stop() { server.stop(true) } }
}

export function capabilityProbe(bin: string, env: Record<string, string | undefined>) {
  const ask = (flag: string) => {
    try { return Bun.spawnSync([bin, flag], { env, stdout: "pipe", stderr: "pipe", timeout: 5000 }) }
    catch { return { exitCode: 127, stdout: Buffer.from("") } }
  }
  const version = ask("--version")
  const help = ask("--help")
  return { ok: version.exitCode === 0 && help.exitCode === 0,
    version: version.stdout.toString().trim(),
    flags: ["--settings", "--setting-sources", "--strict-mcp-config", "--append-system-prompt-file", "--tools"].filter(flag => help.stdout.toString().includes(flag)) }
}

/**
 * An installed `claude` as the capability probe meets it (D-176, IMP-162).
 *
 * It answers the five calls `probeLoopCapabilities` makes the way the real CLI
 * does: a version, a help text naming the isolation flags, and `auth status
 * --json` read from the canonical login directory ONLY, never from the session
 * store the probe poisons. `hang` makes `auth status` hang the way it was
 * measured to on the Linux box: on its first call only, or on every call.
 * Every invocation is written down before it answers, so a check counts probe
 * calls, including the ones that were killed.
 *
 * It lives under /tmp because the probe runs it INSIDE the box, and /tmp is the
 * one place both boxes let a command read and write that is nobody's tree.
 */
export type Hang = "never" | "first" | "always"
export function scriptedClaude(hang: Hang = "never") {
  const dir = realpathSync(mkdtempSync("/tmp/hub-scripted-claude-"))
  const bin = join(dir, "claude"), log = join(dir, "calls")
  writeFileSync(log, "")
  const hangs = { never: "", first: '    [ "$n" -eq 1 ] && exec sleep 120', always: "    exec sleep 120" }
  // Written aside and renamed in, so a replaced binary is a new file, as an update is.
  const install = (mode: Hang) => {
    writeFileSync(bin + ".next", [
      "#!/bin/sh",
      `log=${JSON.stringify(log)}`,
      'printf \'%s\\n\' "$*" >> "$log"',
      'case "$1" in',
      "  --version) echo '2.1.0 (Claude Code)' ;;",
      "  --help) echo 'Options: --settings --setting-sources --strict-mcp-config --tools' ;;",
      "  auth)",
      "    n=$(grep -c '^auth status' \"$log\")",
      hangs[mode],
      '    login="$CLAUDE_SECURESTORAGE_CONFIG_DIR/.credentials.json"',
      '    if [ -f "$login" ]; then',
      "      tier=$(sed -n 's/.*\"subscriptionType\":\"\\([a-z]*\\)\".*/\\1/p' \"$login\")",
      "      printf '{\"loggedIn\":true,\"subscriptionType\":\"%s\"}\\n' \"$tier\"",
      "    else",
      "      echo '{\"loggedIn\":false}'",
      "    fi ;;",
      "  *) exit 2 ;;",
      "esac",
      "",
    ].join("\n"), { mode: 0o755 })
    renameSync(bin + ".next", bin)
  }
  install(hang)
  const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean)
  // The same file overwritten where it stands: same inode, same size, other bytes.
  const rewrite = () => {
    const text = readFileSync(bin, "utf8")
    writeFileSync(bin, text.includes("2.1.0 (") ? text.replace("2.1.0 (", "2.1.1 (") : text.replace("2.1.1 (", "2.1.0 ("))
  }
  return { dir, bin, calls, auth: () => calls().filter(line => line.startsWith("auth status")).length,
    replace: install, rewrite, stop() { rmSync(dir, { recursive: true, force: true }) } }
}
