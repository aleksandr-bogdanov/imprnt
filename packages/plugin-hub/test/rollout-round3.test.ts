// Round 3 command composition. Every input is a disposable synthetic fixture.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { startCluster, hubPath, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { migrationFixture, privateJson } from "./helpers/rollout-migration.ts"
import { harvestPreload, discordPreload } from "./helpers/rollout-preload.ts"
import { provePreload } from "../live/prove-rollout-preload.ts"
import { loadRegistry } from "../src/registry/load.ts"
let cluster: Cluster
beforeAll(async () => { provePreload(); cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

test("C159 D-181c harvest command forwards distinct nonempty bounds and awaits refusal", async () => {
  const f = migrationFixture()
  const it = await rolloutStage(cluster, "telegram")
  try {
    const entry = hubPath("scripts/harvest-v2.ts")
    expect(existsSync(entry), "D-181c harvest command is absent").toBe(true)
    const module = hubPath("src/migrate/harvest.ts")
    expect(existsSync(module), "D-181c shared catch-up library is absent").toBe(true)
    const capture = join(f.dir, "harvest-capture.json")
    for (const [from, until] of [["2026-07-01T12:00:00.000Z", "2026-08-15T12:00:00.000Z"], ["2026-07-03T12:00:00.000Z", "2026-08-15T12:00:00.000Z"], ["2026-07-01T12:00:00.000Z", "2026-07-04T12:00:00.000Z"]]) {
      for (const refuse of [false, true]) {
        rmSync(capture, { force: true })
        const manifest = { version: 1, registry: it.registryFile, person: "p2", from, until }
        const file = privateJson(join(f.dir, "manifest.json"), manifest)
        const preload = harvestPreload(f.dir, module, capture, refuse)
        const child = Bun.spawnSync([process.execPath, "--preload", preload, entry, file], { stdout: "pipe", stderr: "pipe", timeout: 15000 })
        expect(existsSync(capture), "C159 a validate-only command never calls catch-up").toBe(true)
        const wanted = { person: "p2", from, until, store: (loadRegistry(it.registryFile).data.hub as Record<string, unknown>).store_url }
        const forwarded = (got: unknown) => expect(got, "C159 both manifest bounds reach shared catch-up unchanged").toEqual(wanted)
        for (const key of ["from", "until"]) expect(() => forwarded({ ...wanted, [key]: "2026-01-01T00:00:00.000Z" })).toThrow()
        forwarded(JSON.parse(readFileSync(capture, "utf8")))
        expect(child.exitCode, "D-181c await shared catch-up refusal").toBe(refuse ? 1 : 0)
      }
    }
  } finally { await it.stop(); f.stop() }
})

test("C156 D-168c registry command uses authenticated Discord lookup and rejects absent or ambiguous names", () => {
  const entry = hubPath("scripts/convert-v2-registry.ts")
  expect(existsSync(entry), "D-168c registry command is absent").toBe(true)
  for (const mode of ["first", "changed", "absent", "ambiguous"] as const) {
    const f = migrationFixture()
    try {
      const capture = join(f.dir, "discord-capture.jsonl")
      const id = mode === "changed" ? "1000000001" : "0000000000"
      const channels = mode === "absent" ? [] : mode === "ambiguous" ? [{ id: "0000000000", name: "synthetic-channel" }, { id: "1000000001", name: "synthetic-channel" }] : [{ id, name: "synthetic-channel" }]
      const file = privateJson(join(f.dir, "manifest.json"), f.registryManifest)
      const preload = discordPreload(f.dir, capture, channels)
      const child = Bun.spawnSync([process.execPath, "--preload", preload, entry, file], { stdout: "pipe", stderr: "pipe", timeout: 15000 })
      expect(existsSync(capture), "C156 command must ask the platform for its channel mapping").toBe(true)
      const calls = readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line))
      expect(calls).toEqual([{ url: "https://discord.com/api/v10/guilds/synthetic-guild/channels", method: "GET", authorization: "Bot synthetic-token" }])
      if (mode === "absent" || mode === "ambiguous") {
        expect(child.exitCode).toBe(1)
        expect(existsSync(f.registryManifest.candidate)).toBe(false)
      } else {
        expect(child.exitCode).toBe(0)
        const inventory = JSON.parse(readFileSync(f.registryManifest.inventory, "utf8"))
        expect(inventory.agents.find((a: any) => a.id === "p1-lair").chat, "C156 command output follows actual lookup response").toBe(id)
        expect(loadRegistry(f.registryManifest.candidate).agents.find(a => a.id === "p1-lair")!.chat).toBe(id)
      }
    } finally { f.stop() }
  }
})
