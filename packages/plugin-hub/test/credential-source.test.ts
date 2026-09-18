import { beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync, renameSync, readdirSync, lstatSync } from "node:fs"
import { join } from "node:path"
import { claudeCode } from "../src/adapters/claude-code.ts"
import { realProber, copyFindings } from "../src/check/credentials.ts"
import { seam } from "./helpers/cluster.ts"
import { loopFixture, launchInput, launchSeam, captureCli, ending, digest } from "./helpers/rollout-loop.ts"
beforeAll(async () => { await import("../live/prove-rollout-loop.ts") })

test("ROLL-13 declared login matches prober and fresh sessions read atomic replacement without copies", async () => {
  const f = loopFixture()
  try {
    const prober = realProber()
    const noCopies = async () => expect(await copyFindings({ entries: [f.credential], prober, roots: [join(f.stateDir, "p1", "sessions")], machine: "mac" })).toEqual([])
    const sessionDir = f.session("copy-control")
    await noCopies()
    writeFileSync(join(sessionDir, "copied-login"), readFileSync(f.login))
    await expect(noCopies()).rejects.toThrow()
    const { rmSync } = await import("node:fs")
    rmSync(join(sessionDir, "copied-login"))
    await noCopies()
    const module = await seam("src/adapters/launch.ts")
    expect(typeof module.credentialSource).toBe("function")
    const source = module.credentialSource as Function
    const make = await launchSeam()
    const seenDirectories: string[] = []
    for (const marker of [f.marker, "synthetic-replacement-" + crypto.randomUUID()]) for (const purpose of ["ordinary", "harvest"]) {
      const before = lstatSync(f.login).ino
      writeFileSync(f.login + ".next", f.loginBytes(marker), { mode: 0o600 })
      renameSync(f.login + ".next", f.login)
      expect(lstatSync(f.login).ino).not.toBe(before)
      const selected = await source(f.registry(), "daily")
      expect(selected.file).toBe(f.login)
      expect(await prober.open(selected)).toEqual({ ok: true })
      const input = launchInput(f, purpose)
      const launch = await make(input)
      const capture = join(input.sessionDir, "credential.json")
      const session = await claudeCode.start({ ...launch, preset: input.preset, sessionId: null, wrap: argv => launch.wrap(captureCli(capture, f)(argv)) })
      try {
        await ending(session)
        const got = JSON.parse(readFileSync(capture, "utf8"))
        const correctSource = (one: any) => {
          expect(one.credential).toBe(selected.file)
          expect(one.credentialDigest).toBe(digest(readFileSync(selected.file, "utf8")))
        }
        expect(() => correctSource({ ...got, credential: join(f.home, ".claude", ".credentials.json"), credentialDigest: digest(f.loginBytes(f.poison)) })).toThrow()
        correctSource(got)
        expect(got.leaked).toBe(false)
        expect(JSON.stringify(got)).not.toContain(marker)
        expect(got.env.CLAUDE_CONFIG_DIR.startsWith(input.sessionDir)).toBe(true)
        expect(seenDirectories).not.toContain(got.env.CLAUDE_CONFIG_DIR)
        seenDirectories.push(got.env.CLAUDE_CONFIG_DIR)
        expect(readFileSync(join(got.env.CLAUDE_CONFIG_DIR, "session-write"), "utf8")).toBe("synthetic-session-state")
        const scan = (dir: string) => {
          for (const name of readdirSync(dir)) {
            const path = join(dir, name), stat = lstatSync(path)
            if (stat.isDirectory()) scan(path)
            else if (stat.isFile()) expect(readFileSync(path, "utf8")).not.toContain(marker)
          }
        }
        scan(input.sessionDir)
        await noCopies()
      } finally { await session.close() }
    }
  } finally { f.stop() }
})

for (const bad of ["missing", "unsupported"]) test(`ROLL-13 ${bad} credential source refuses without ambient fallback`, async () => {
  const f = loopFixture()
  try {
    const make = await launchSeam()
    const input = launchInput(f)
    expect((await make(input)).argv.length).toBeGreaterThan(0)
    const file = join(f.dir, bad === "missing" ? "absent/.credentials.json" : "unsupported-login-name.json")
    if (bad === "unsupported") writeFileSync(file, readFileSync(f.login))
    await expect(make({ ...input, credential: { ...f.credential, file } })).rejects.toThrow(bad === "unsupported" ? /credential-source-unsupported/ : /credential.*(missing|unreadable)|ENOENT/)
  } finally { f.stop() }
})
