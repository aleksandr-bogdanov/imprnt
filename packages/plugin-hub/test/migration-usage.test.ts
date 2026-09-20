// A one-off migration command called with the wrong arguments says what it takes.
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hubPath } from "./helpers/cluster.ts"

for (const script of ["convert-v2-chatlog", "convert-v2-registry", "handoff-v2", "harvest-v2"]) test(`D-181b ${script} called wrong exits 2 and names the one absolute manifest path it takes`, () => {
  const dir = mkdtempSync(join(tmpdir(), "migration-usage-"))
  try {
    const invoke = (args: string[]) => Bun.spawnSync([process.execPath, hubPath(`scripts/${script}.ts`), ...args], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 15000 })
    // Control on the same entry: a refused manifest already says why on stderr.
    const refused = invoke([join(dir, "absent-manifest.json")])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr.toString()).toContain("migration-refused")
    // The procedure's old harvest form, a relative path, and no argument at all.
    for (const args of [[], ["manifest.json"], [join(dir, "registry.toml"), "p2", "2026-07-01T00:00:00.000Z", "2026-08-15T00:00:00.000Z"]]) {
      const wrong = invoke(args)
      expect(wrong.exitCode, `argv ${JSON.stringify(args)}`).toBe(2)
      expect(wrong.stdout.toString()).toBe("")
      const said = wrong.stderr.toString()
      expect(said, `argv ${JSON.stringify(args)} is answered with the usage line`).toStartWith(`usage: bun run scripts/${script}.ts <manifest>, one absolute path to `)
      expect(said).toContain("version 1")
      expect(said.trim().split("\n")).toHaveLength(1)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
