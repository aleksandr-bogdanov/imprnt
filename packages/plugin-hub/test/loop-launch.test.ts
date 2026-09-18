import { beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs"
import { join } from "node:path"
import { claudeCode } from "../src/adapters/claude-code.ts"
import { loopFixture, launchInput, launchSeam, captureCli, ending } from "./helpers/rollout-loop.ts"
beforeAll(async () => { await import("../live/prove-rollout-loop.ts") })

for (const purpose of ["ordinary", "harvest"]) test(`ROLL-06 ROLL-30 ${purpose} actual child receives explicit launch configuration`, async () => {
  const f = loopFixture()
  let session: Awaited<ReturnType<typeof claudeCode.start>> | undefined
  try {
    const make = await launchSeam()
    const input = launchInput(f, purpose)
    const launch = await make(input)
    expect(typeof launch.wrap).toBe("function")
    const capture = join(input.sessionDir, "launch.json")
    // Interpose only the executable. Production options still cross Adapter.start.
    session = await claudeCode.start({ ...launch, preset: input.preset, sessionId: null, wrap: argv => launch.wrap(captureCli(capture, f)(argv)) })
    await ending(session)
    const got = JSON.parse(readFileSync(capture, "utf8"))
    const accepts = (value: any) => {
      expect(value.argv).toContain("--strict-mcp-config")
      expect(value.settings).toEqual(purpose === "ordinary" ? JSON.parse(readFileSync(f.files.settings, "utf8")) : {})
      expect(value.fragment).toBe(purpose === "ordinary" ? readFileSync(f.files.fragment, "utf8") : null)
      const n = value.argv.indexOf("--tools")
      expect(n).toBeGreaterThan(-1)
      const tail = value.argv.slice(n + 1)
      const next = tail.findIndex((arg: string) => arg.startsWith("--"))
      const tools = tail.slice(0, next < 0 ? undefined : next).flatMap((arg: string) => arg.split(/[, ]/)).filter(Boolean).sort()
      expect(tools).toEqual((purpose === "ordinary" ? ["Read", "Write", "Glob", "Grep"] : ["Read", "Glob", "Grep"]).sort())
      if (purpose === "ordinary") expect(value.argv).toContain("--dangerously-skip-permissions")
      else {
        expect(tools).not.toContain("Write")
        expect(value.argv).not.toContain("--dangerously-skip-permissions")
        expect(value.mcp).toEqual({ mcpServers: {} })
      }
      expect(value.cwd.startsWith(input.sessionDir)).toBe(true)
    }
    if (purpose === "ordinary") expect(() => accepts({ ...got, fragment: "missing-instruction-control" })).toThrow()
    else {
      const changed = [...got.argv]
      changed.splice(changed.indexOf("--tools") + 1, 0, "Write")
      expect(() => accepts({ ...got, argv: changed })).toThrow()
    }
    accepts(got)
  } finally { await session?.close(); f.stop() }
})

test("ROLL-06 absent sources and empty tools remain explicit in child argv", async () => {
  const f = loopFixture()
  try {
    const make = await launchSeam()
    for (const tools of [undefined, []]) {
      const input = launchInput(f)
      input.agent = { ...input.agent, fragment: undefined, settings: undefined, mcp: undefined, tools }
      const launch = await make(input)
      const capture = join(input.sessionDir, "defaults.json")
      const session = await claudeCode.start({ ...launch, preset: input.preset, sessionId: null, wrap: argv => launch.wrap(captureCli(capture, f)(argv)) })
      try {
        await ending(session)
        const got = JSON.parse(readFileSync(capture, "utf8"))
        expect(got.fragment).toBeNull()
        expect(got.settings).toEqual({})
        expect(got.mcp).toEqual({ mcpServers: {} })
        expect(got.argv).toContain("--strict-mcp-config")
        if (tools) expect(got.argv[got.argv.indexOf("--tools") + 1]).toBe("")
        else expect(got.argv[got.argv.indexOf("--tools") + 1]).toBe("default")
      } finally { await session.close() }
    }
  } finally { f.stop() }
})

test("ROLL-30 bypass without a box and failed box construction start no child", async () => {
  const f = loopFixture()
  try {
    const make = await launchSeam()
    const input = launchInput(f)
    const good = await make(input)
    expect(typeof good.wrap).toBe("function")
    let calls = 0
    const start = async (options: any) => claudeCode.start({ ...options, preset: input.preset, sessionId: null,
      ...(options.wrap ? { wrap: (argv: string[]) => { calls++; return options.wrap(argv) } } : {}) })
    await expect(make({ ...input, box: null })).rejects.toThrow(/box/)
    const boxedBypass = (value: any) => {
      expect(typeof value.wrap).toBe("function")
      expect(value.argv).toContain("--dangerously-skip-permissions")
    }
    expect(() => boxedBypass({ ...good, wrap: undefined })).toThrow()
    boxedBypass(good)
    // Run the missing-wrap case in a child whose PATH contains ONLY our fake
    // executable. Even a defective adapter cannot find an installed real CLI.
    const bin = join(f.dir, "bin"), receipt = join(f.dir, "unboxed-start")
    mkdirSync(bin)
    const fake = join(bin, "claude")
    writeFileSync(fake, `#!/bin/sh\nprintf started > '${receipt}'\n`)
    chmodSync(fake, 0o700)
    const module = new URL("../src/adapters/claude-code.ts", import.meta.url).href
    const options = { ...good, preset: input.preset, sessionId: null, wrap: undefined,
      argv: [fake, ...good.argv.slice(1)], env: { HOME: f.home, PATH: bin } }
    const code = `const {claudeCode}=await import(${JSON.stringify(module)});let session;try {session=await claudeCode.start(${JSON.stringify(options)});process.stdout.write("UNSAFE")}catch(error){process.stdout.write(/box/i.test(String(error))?"BOX-REFUSED":"WRONG-REFUSAL")}finally{await session?.close()}`
    const child = Bun.spawnSync([process.execPath, "-e", code], { env: { HOME: f.home, PATH: bin }, stdout: "pipe", stderr: "pipe", timeout: 5000 })
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toBe("BOX-REFUSED")
    expect(existsSync(receipt)).toBe(false)
    await expect(start({ ...good, wrap: () => { throw new Error("synthetic box construction refusal") } })).rejects.toThrow("synthetic box construction refusal")
    expect(calls).toBe(1)
  } finally { f.stop() }
})
