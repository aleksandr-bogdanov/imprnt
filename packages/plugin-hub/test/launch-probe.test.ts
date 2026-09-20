// IMP-162. An agent launch survives a slow login probe.
//
// Before every child, the launch asked the installed `claude` five questions
// (`probeLoopCapabilities`, D-176). Measured on the Linux box, `auth status
// --json` hung until the 10 s timeout in 4 of 36 traced runs. The probe read the
// empty answer as a CLI that cannot select a login and refused the launch as
// `credential-source-unsupported`, so an agent went quiet now and then and the
// operator was told a sound credential source was unsupported.
//
// Against a scripted `claude` that answers the probe the way the real one does:
//   1. a call that hangs once is asked again, and the launch goes ahead;
//   2. a call that hangs every time refuses the launch AS A TIMEOUT, and check
//      reports a timeout rather than an unsupported source;
//   3. a second launch on the same login and the same binary asks nothing,
//      once both files have stood unchanged for a few seconds, and a file
//      changed more recently than that is probed on every launch.
// The controls: a login or binary replaced, or rewritten in place at the same
// inode and size, is asked again, and an answer kept from an earlier launch
// never lets a removed or wrong-shaped login through, because the source itself
// is checked every time.
//
// Red reasons: behaviour absent. Before the change a hang is never asked again,
// the refusal says "unsupported", and every launch probes from scratch. Before
// the settling rule a file written a moment ago was kept on its first stamp.

import { beforeAll, expect, test } from "bun:test"
import { lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { loopLaunch } from "../src/adapters/index.ts"
import { LOOP_PROBE_SETTLED_MS } from "../src/adapters/launch.ts"
import { loopFixture, launchInput, scriptedClaude, type LoopFixture } from "./helpers/rollout-loop.ts"
import { startCluster } from "./helpers/cluster.ts"
import { DOOR, PERSON, stageHub, superStore } from "./helpers/hub-fixture.ts"
import { runCheck } from "../src/check/run.ts"
beforeAll(async () => { await import("../live/prove-rollout-loop.ts") })

// Production waits 10 s per call. A hang costs the check this instead. A call
// that answers takes milliseconds alone and has kept well inside this with the
// full suite loading the machine.
const WAIT = 5000

// The scripted CLI records every call it was asked in its own directory, and it
// runs INSIDE the probe's box, where the host is read-only. So that directory is
// handed to the probe as a write path, the way a declared repository is handed
// to an agent's box.
function launch(f: LoopFixture, bin: string, input: Record<string, unknown> = {}, writePaths: string[] = [dirname(bin)]) {
  return loopLaunch({ ...launchInput(f), ...input } as never, { bin, timeoutMs: WAIT, writePaths })
}

test("IMP-162 a login probe that hangs once is asked again and the launch goes ahead", async () => {
  const f = loopFixture(), cli = scriptedClaude("first")
  try {
    const got = await launch(f, cli.bin).then(value => value as { credentialId?: string }, (error: Error) => error)
    expect(got instanceof Error ? got.message : "launched").toBe("launched")
    expect((got as { credentialId?: string }).credentialId).toBe(f.credential.id)
    // The probe reads the login three times. The one that hung was asked once more.
    expect(cli.auth()).toBe(4)
  } finally { cli.stop(); f.stop() }
}, 60_000)

test("IMP-162 a login probe that hangs every time refuses the launch as a timeout, never as unsupported", async () => {
  const f = loopFixture(), cli = scriptedClaude("always")
  try {
    const got = await launch(f, cli.bin).then(() => null, (error: Error) => error)
    expect(got).toBeInstanceOf(Error)
    expect(got!.message).toContain("timed out")
    expect(got!.message).not.toContain("unsupported")
    // One call and one retry, then it gives up rather than asking the next question.
    expect(cli.auth()).toBe(2)
  } finally { cli.stop(); f.stop() }
}, 60_000)

test("IMP-162 a launch probes nothing once the login and binary have settled, and probes again after any change to either", async () => {
  const f = loopFixture(), cli = scriptedClaude()
  // How many calls one launch made to the binary.
  const probes = async () => {
    const before = cli.calls().length
    await launch(f, cli.bin)
    return cli.calls().length - before
  }
  // A kept answer is trusted only for files that stood unchanged this long.
  const settle = () => Bun.sleep(LOOP_PROBE_SETTLED_MS + 250)
  // After a change: probed, probed again until it settles, then kept. The
  // first launch after it settles is the one that keeps the answer, and it
  // may already have been the second one on a slow machine, so it is not counted.
  const changed = async (what: string) => {
    expect(await probes(), `${what} is probed again`).toBeGreaterThan(0)
    expect(await probes(), `${what} is probed on every launch until it settles`).toBeGreaterThan(0)
    await settle()
    await probes()
    expect(await probes(), `${what}, once settled, is not probed again`).toBe(0)
  }
  try {
    // A second write inside one timestamp tick can leave every field a stat
    // reports as it was, so files written seconds ago are never kept.
    await changed("a login and binary written seconds ago")

    // The login replaced atomically, as a refresh or a new login does it (ROLL-13).
    const inode = lstatSync(f.login).ino
    writeFileSync(f.login + ".next", f.loginBytes("synthetic-replacement-" + crypto.randomUUID()), { mode: 0o600 })
    renameSync(f.login + ".next", f.login)
    expect(lstatSync(f.login).ino).not.toBe(inode)
    await changed("a replaced login")

    // The login rewritten in place, at the same inode and the same size.
    const login = statSync(f.login)
    writeFileSync(f.login, readFileSync(f.login))
    expect([statSync(f.login).ino, statSync(f.login).size]).toEqual([login.ino, login.size])
    await changed("a login rewritten in place")

    // The binary replaced, as an update does it.
    cli.replace("never")
    await changed("a replaced binary")

    // The binary rewritten in place, at the same inode and the same size, to other bytes.
    const binary = statSync(cli.bin), bytes = readFileSync(cli.bin, "utf8")
    cli.rewrite()
    expect([statSync(cli.bin).ino, statSync(cli.bin).size]).toEqual([binary.ino, binary.size])
    expect(readFileSync(cli.bin, "utf8")).not.toBe(bytes)
    await changed("a binary rewritten in place")

    // A kept answer never admits a login the loop cannot select.
    const wrong = join(f.dir, "unsupported-login-name.json")
    writeFileSync(wrong, f.loginBytes(f.marker), { mode: 0o600 })
    await expect(launch(f, cli.bin, { credential: { ...f.credential, file: wrong } })).rejects.toThrow(/credential-source-unsupported/)
    rmSync(f.login)
    await expect(launch(f, cli.bin)).rejects.toThrow(/credential.*(missing|unreadable)|ENOENT/)
  } finally { cli.stop(); f.stop() }
}, 90_000)

test("IMP-162 check reports a login probe that keeps hanging as a timeout, not as an unsupported source, and a sound one as nothing", async () => {
  const cluster = await startCluster()
  const f = loopFixture(), hung = scriptedClaude("always"), sound = scriptedClaude()
  try {
    const it = await stageHub(cluster, {
      machines: [{ id: "pi", os: "linux" }],
      run: [
        { id: DOOR, kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      ],
      registry: (base: Record<string, any>) => ({
        ...base,
        credentials: [f.credential],
        presets: { ...base.presets, loop: { adapter: "claude-code", model: "a-model-name", provider: "a-provider", effort: "medium", paid: "plan", credential: f.credential.id } },
        agents: (base.agents ?? []).map((agent: Record<string, unknown>) => ({ ...agent, preset: "loop", runner: "runner-pi" })),
      }) as never,
    })
    const probeFindings = async (bin: string) => {
      const store = await superStore(cluster, it.db)
      try {
        const found = await runCheck({ machine: "pi", registryFile: it.registryFile, store, os: null, kernel: null, loopProbe: { bin, timeoutMs: WAIT, writePaths: [dirname(bin)] } })
        return found.filter(one => one.subject === "loop" && one.kind !== "credential-undeclared")
      } finally { await store.close().catch(() => {}) }
    }
    try {
      expect(await probeFindings(sound.bin), "a sound CLI is no finding").toEqual([])
      const found = await probeFindings(hung.bin)
      expect(found.map(one => one.kind)).toEqual(["loop-probe-timeout"])
      expect(found[0].says).toContain("timed out")
      expect(found[0].says).not.toContain("unsupported")
      expect(found[0].id).toBe("pi/loop-probe-timeout:loop")
    } finally { await it.stop() }
  } finally { hung.stop(); sound.stop(); f.stop(); await cluster.stop() }
}, 90_000)
