import { beforeAll, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { boxContextFor } from "../src/box/index.ts"
import { boxGate } from "./helpers/box-gate.ts"
import { loopFixture, launchInput, stateFiles, nativeWrap, fileProbe } from "./helpers/rollout-loop.ts"
beforeAll(async () => { await import("../live/prove-rollout-loop.ts") })

for (const os of ["linux", "darwin"]) if (process.platform !== os) console.log(`SKIP: requires ${os === "linux" ? "Linux" : "macOS"} (ROLL-16 ROLL-30 native state probes)`)
for (const os of ["linux", "darwin"]) for (const purpose of ["ordinary", "harvest"]) {
  test.skipIf(process.platform !== os)(`ROLL-16 ROLL-30 ${os} ${purpose} own state read-only and other state denied through aliases${process.platform !== os ? ` SKIP: requires ${os === "linux" ? "Linux" : "macOS"}` : ""}`, () => {
    expect(boxGate().ok).toBe(true)
    const base = loopFixture()
    // /tmp is readable in the old box. Removing only the state mask therefore
    // exposes the files on both kernels, including macOS's broad scratch grant.
    const root = realpathSync(mkdtempSync("/tmp/hub-rollout-state-"))
    const f = { ...base, stateDir: root }
    const files = stateFiles(f)
    const input = launchInput(f, purpose)
    const ctx = { ...boxContextFor(f.registry(), "p1-lair"), stateRoot: join(root, "p1"), otherStateRoots: [join(root, "p2")], sessionDir: input.sessionDir, purpose }
    const box = nativeWrap(ctx)
    const broken = nativeWrap({ ...ctx, otherStateRoots: [] } as any)
    try {
      // Every refusal has the identical accessible file and operation unboxed.
      for (const file of Object.values(files)) for (const op of ["read", "write"] as const) expect(fileProbe([], file, op).code).toBe(0)
      const probe = (wrapper: typeof box, file: string, op: "read" | "write") => {
        const command = wrapper.wrap(["/bin/sh", "-c", op === "read" ? 'cat "$1"' : 'printf synthetic-write >> "$1"', "sh", file])
        const done = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: 5000 })
        return { code: done.exitCode, text: done.stdout.toString() }
      }
      const denied = (result: { code: number; text: string }) => {
        expect(result.code).not.toBe(0)
        expect(result.text).not.toContain("p2-")
      }
      for (const key of ["p2-chatlog", "p2-inbox", "p2-chatlog-link", "p2-inbox-link"]) {
        for (const op of ["read", "write"] as const) {
          const control = probe(broken, files[key], op)
          expect(control.code).toBe(0)
          expect(() => denied(control)).toThrow()
        }
      }
      const vaultFile = join(f.trees.person("p1").tree, "CLAUDE.md")
      expect(fileProbe([], vaultFile, "write").code).toBe(0)
      expect(probe(box, vaultFile, "read").code).toBe(0)
      if (purpose === "ordinary") expect(probe(box, vaultFile, "write").code).toBe(0)
      else expect(probe(box, vaultFile, "write").code).not.toBe(0)
      for (const key of ["p1-chatlog", "p1-inbox", "p1-chatlog-link", "p1-inbox-link"]) {
        expect(probe(box, files[key], "read").text).toContain(key.startsWith("p1-chatlog") ? "p1-chatlog-sentinel" : "p1-inbox-sentinel")
        expect(probe(box, files[key], "write").code, "D-176 own state mutation must be denied").not.toBe(0)
      }
      for (const key of ["p2-chatlog", "p2-inbox", "p2-chatlog-link", "p2-inbox-link"]) for (const op of ["read", "write"] as const) denied(probe(box, files[key], op))
      expect(probe(box, join(input.sessionDir, "session-write"), "write").code).toBe(0)
    } finally { broken.stop(); box.stop(); rmSync(root, { recursive: true, force: true }); base.stop() }
  })
}
