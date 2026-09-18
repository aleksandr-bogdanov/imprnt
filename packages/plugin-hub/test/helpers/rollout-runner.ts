// Test edges only. Queue, retry, lifetime and outage policy remain in src/.
import { readFileSync, writeFileSync, rmSync } from "node:fs"
import { createScriptedAdapter, childGone, growChild, growFileFor, residentBytes } from "./scripted-adapter.ts"
import type { Adapter, AdapterSession } from "../../src/adapters/types.ts"
import type { StagedHub } from "./hub-fixture.ts"
import { toml } from "../../src/migrate/files.ts"

export async function observe(predicate: () => boolean | Promise<boolean>, milliseconds = 3500) {
  const end = performance.now() + milliseconds
  do {
    if (await predicate()) return true
    await Bun.sleep(20)
  } while (performance.now() < end)
  return false
}

export function editAgent(file: string, id: string, fields: Record<string, string | number | boolean>) {
  let text = readFileSync(file, "utf8")
  let found = false
  text = text.replace(/\[\[agents\]\][\s\S]*?(?=\n\[|$)/g, block => {
    if (!block.includes(`id = ${JSON.stringify(id)}`)) return block
    found = true
    for (const [key, value] of Object.entries(fields)) {
      const line = `${key} = ${JSON.stringify(value)}`
      const pattern = new RegExp(`^${key} = .*?$`, "m")
      block = pattern.test(block) ? block.replace(pattern, line) : block.trimEnd() + "\n" + line + "\n"
    }
    return block
  })
  if (!found) {
    const data = Bun.TOML.parse(text) as { agents?: Record<string, unknown>[] }
    const agent = data.agents?.find(row => row.id === id)
    if (!agent) throw new Error("synthetic agent missing")
    Object.assign(agent, fields)
    text = toml(data)
  }
  writeFileSync(file, text)
}

export function retrySettings(it: StagedHub) {
  writeFileSync(it.registryFile, readFileSync(it.registryFile, "utf8") + "\n[runner]\ntask_retry_seconds = 1\n")
}

export function processTree(root: number): number[] {
  const done = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" })
  if (done.exitCode !== 0) throw new Error("synthetic process tree could not be sampled")
  const rows = done.stdout.toString().trim().split("\n").map(line => line.trim().split(/\s+/).map(Number))
  const own = new Set([root])
  for (let previous = -1; previous !== own.size;) {
    previous = own.size
    for (const [pid, parent] of rows) if (own.has(parent)) own.add(pid)
  }
  return [...own].filter(pid => !childGone(pid))
}

export function treeBytes(root: number) { return processTree(root).reduce((sum, pid) => sum + residentBytes(pid), 0) }

export function controlledAdapter(name = "controlled-" + crypto.randomUUID(), descendants = false) {
  const profiles = new Set<string>()
  const sessions: {
    loop: ReturnType<typeof createScriptedAdapter>, session: AdapterSession & { exited: Promise<unknown> },
    preset: Parameters<Adapter["start"]>[0]["preset"], fed: { id: string, text: string }[],
    closed: boolean, fail(cause?: string): void, grow(mb: number): void,
  }[] = []
  let configure: (row: typeof sessions[number]) => void = () => {}
  let hold: (message: { id: string, text: string }) => boolean = () => false
  let throwFeed: (message: { id: string, text: string }) => boolean = () => false
  let startFailure = 0
  let failStart: (options: Parameters<Adapter["start"]>[0]) => boolean = () => true
  let suppressExit = false
  let suppressClose = false
  const adapter: Adapter = {
    name,
    async start(options) {
      if (startFailure > 0 && failStart(options)) { startFailure--; throw new Error("synthetic-task-start-failure") }
      // One scripted loop per session avoids the shipped helper's single-turn gate
      // being shared between concurrent agents or a harvester.
      const loop = createScriptedAdapter({ name, child: true })
      const nested = (argv: string[]) => {
        const script = `const children = [0,1].map(() => Bun.spawn(${JSON.stringify(argv)}, {stdout:'ignore',stderr:'ignore'}));
          setInterval(() => { if (process.ppid === 1) { for (const child of children) child.kill(); process.exit(0) } }, 50);
          process.on('SIGTERM', () => { for (const child of children) child.kill(); process.exit(0) });`
        const command = [process.execPath, "-e", script]
        return options.wrap ? options.wrap(command) : command
      }
      const base = await loop.adapter.start(descendants ? { ...options, wrap: nested } : options)
      for (const spawn of loop.spawns()) if (spawn.profile) profiles.add(spawn.profile)
      const owned = new Set<number>()
      let resolve!: (value: unknown) => void
      const exited = new Promise(resolveExit => { resolve = resolveExit })
      let terminal = false
      const finish = (cause: string) => {
        if (terminal || suppressExit) return
        terminal = true
        resolve({ cause, code: 9 })
      }
      const watcher = setInterval(() => {
        if (base.pid && childGone(base.pid)) finish("child-exited")
      }, 10)
      const row = {
        loop, preset: options.preset, fed: [] as { id: string, text: string }[], closed: false,
        session: null as unknown as AdapterSession & { exited: Promise<unknown> },
        fail(cause = "child-exited") {
          if (descendants) for (const pid of processTree(base.pid!).slice(1)) { owned.add(pid); try { process.kill(pid, 9) } catch {} }
          for (const child of loop.children()) child.kill()
          finish(cause)
        },
        grow(mb: number) {
          if (mb === 0) return
          const pids = descendants ? processTree(base.pid!).slice(1) : [base.pid!]
          if (pids.length === 0) throw new Error("synthetic descendants have not started")
          for (const pid of pids) { owned.add(pid); growChild(pid, mb) }
        },
      }
      row.session = {
        ...base, exited,
        async feed(message) {
          row.fed.push({ ...message })
          if (throwFeed(message)) throw new Error("synthetic-task-feed-failure")
          loop.holdTurnEnd(hold(message))
          await base.feed(message)
        },
        async close() {
          if (suppressClose) return
          row.closed = true
          clearInterval(watcher)
          if (descendants) for (const pid of processTree(base.pid!).slice(1)) { owned.add(pid); try { process.kill(pid, 9) } catch {} }
          await base.close()
          for (const pid of owned) rmSync(growFileFor(pid), { force: true })
          finish("closed")
        },
      }
      sessions.push(row)
      configure(row)
      return row.session
    },
  }
  return {
    adapter, sessions,
    onStart(callback: typeof configure) { configure = callback },
    hold(predicate: typeof hold) { hold = predicate },
    throwFeed(predicate: typeof throwFeed) { throwFeed = predicate },
    failStarts(count: number, predicate: typeof failStart = () => true) { startFailure = count; failStart = predicate },
    suppressExit(on: boolean) { suppressExit = on },
    suppressClose(on: boolean) { suppressClose = on },
    async stop() {
      suppressClose = false
      await Promise.all(sessions.map(row => row.session.close()))
      for (const path of profiles) rmSync(path, { force: true })
    },
  }
}

// Extend the existing fake CLI script, preserving its measured receipt shape.
export function brokenStream(wrap: (argv: string[]) => string[], mode: "exit" | "eof" | "parse") {
  const argv = wrap([])
  const action = mode === "exit" ? "process.exit(7)" : mode === "eof"
    ? "setTimeout(() => require('node:fs').closeSync(1), 10)" : "process.stdout.write('not-json\\n')"
  return (_argv: string[]) => [mode === "eof" ? (Bun.which("node") ?? "node") : argv[0], argv[1], argv[2].replace("for (const one of LINES) say(one);", action)]
}
