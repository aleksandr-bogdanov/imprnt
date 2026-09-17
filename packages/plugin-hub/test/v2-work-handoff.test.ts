import { beforeAll, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { seam, startCluster, startReadySubprocess, type ReadyProcess } from "./helpers/cluster.ts"
import { stageHub, insertInbound, chatLogFile } from "./helpers/hub-fixture.ts"
import { migrationFixture, privateJson, jsonlBytes, digest, inventory } from "./helpers/rollout-migration.ts"
import { proveMigrationFixtures } from "../live/prove-rollout-migration.ts"
import { deliveryEdge, proveDeliveryEdge } from "./helpers/rollout-delivery.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"
import { observe } from "./helpers/rollout-runner.ts"

beforeAll(async () => {
  await proveMigrationFixtures()
  await proveDeliveryEdge()
  const f = migrationFixture()
  let child: ReadyProcess | undefined
  try {
    const file = join(f.dir, "append.jsonl")
    const config = privateJson(join(f.dir, "crash-proof.json"), { point: "append-before-fsync", proof: true, file, line: { id: "synthetic-line", text: "durable boundary" } })
    child = await startReadySubprocess("test/helpers/rollout-crash-child.ts", [config], 5000)
    expect(JSON.parse(readFileSync(file, "utf8")).id).toBe("synthetic-line")
    await child.stop(9)
    expect(child.proc.signalCode).toBe("SIGKILL")
    console.log("H08 crash proof: reused append-before-fsync child and SIGKILL cleanup")
  } finally { await child?.stop(9); f.stop() }
})
async function handoff() {
  const module = await seam("src/migrate/handoff.ts")
  expect(typeof module.prepareHandoff).toBe("function")
  expect(typeof module.applyHandoff).toBe("function")
  return module as { prepareHandoff: (manifest: any) => Promise<any>, applyHandoff: (manifest: any, options: any) => Promise<any> }
}
async function stage(cluster: Awaited<ReturnType<typeof startCluster>>, name: string) {
  const h = await stageHub(cluster, { hub: { cutover_batch: "synthetic-cutover", tick_seconds: 1 }, people: [{ id: "p1" }, { id: "p2" }], registry: base => ({ ...base, agents: [{ id: "p1-lair", person: "p1", preset: "daily", runner: "runner-pi", door: "door-fake", chat: "0000000000" }], run: [{ id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 }] }) })
  writeFileSync(h.registryFile, readFileSync(h.registryFile, "utf8").replace('id = "p1"\n', 'id = "p1"\nallowed_senders = { door-fake = ["p1"] }\n'))
  return { h, edge: deliveryEdge(name as "telegram" | "discord") }
}

for (const name of ["telegram", "discord"] as const) test(`ROLL-18 ${name} frozen work conserves pending answers receipts cursors and never replays completed history`, async () => {
  const f = migrationFixture()
  try {
    const api = await handoff()
    const cluster = await startCluster()
    const { h, edge } = await stage(cluster, name)
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      const manifest = structuredClone(f.handoffManifest)
      manifest.items.forEach((i: any) => { i.platform = name })
      const prepared = await api.prepareHandoff(manifest)
      expect(prepared.source_inventory).toEqual(manifest.source_inventory)
      expect(prepared.sources).toEqual(manifest.sources)
      // Refusal control: same door must start after the batch is complete.
      let refusal: unknown
      try { door = await runDoor({ door: "door-fake", registryFile: h.registryFile, platform: edge.platform }) }
      catch (error) { refusal = error }
      await door?.stop(); door = undefined
      expect(String(refusal)).toMatch(/cutover|handoff|batch/i)
      expect(edge.pulls()).toHaveLength(0)
      await api.applyHandoff(prepared, { registryFile: h.registryFile })
      const queued = await h.read.inbound()
      expect(queued.some(r => r.body === "completed synthetic instruction")).toBe(false)
      expect((await h.read.sql("select * from ledger_event where subject = $1", [`${name}:0000000000:1`]))).toHaveLength(0)
      const firstLogs = jsonlBytes(h.stateDir, "p1", "p1-lair")
      await api.applyHandoff(prepared, { registryFile: h.registryFile })
      expect(await h.read.inbound()).toEqual(queued)
      expect(jsonlBytes(h.stateDir, "p1", "p1-lair")).toEqual(firstLogs)
      const gates = await h.read.sheet("cutover")
      expect(gates.find(r => r.id === manifest.batch_id)?.data.complete).toBe(true)
      expect((await h.read.sheet("door_cursor")).find(r => r.id === "door-fake/0000000000")?.data.cursor).toBe("5")
      edge.batch([{ platform_message_id: "6", chat: "0000000000", sender_id: "p1", from: "p1", text: "later arrival", at: new Date().toISOString(), media: [] }], "6")
      runner = await runRunner({ runner: "runner-pi", registryFile: h.registryFile, adapters: { [h.adapterName]: h.scripted.adapter } })
      door = await runDoor({ door: "door-fake", registryFile: h.registryFile, platform: edge.platform })
      expect(await observe(() => edge.posts().some(r => r.text === "reply to later arrival"), 7000)).toBe(true)
      const accepts = (texts: string[], calls: string[]) => {
        expect(texts.filter(s => s === "fully owed")).toHaveLength(1)
        expect(texts.filter(s => s === "remaining owed")).toHaveLength(1)
        expect(texts).not.toContain("already delivered")
        for (const text of ["pending synthetic two", "pending synthetic three", "later arrival"]) {
          expect(texts.filter(s => s === `reply to ${text}`)).toHaveLength(1)
          expect(calls.filter(s => s === text)).toHaveLength(1)
        }
        expect(calls).not.toContain("completed synthetic instruction")
        expect(calls).not.toContain("answered already")
        expect(calls).not.toContain("partly answered already")
      }
      const sent = () => edge.posts().map(r => r.text)
      const fed = () => h.scripted.fed().map(r => r.text)
      accepts(sent(), fed())
      expect(edge.pulls()[0].cursor).toBe("5")
      expect(await h.read.sql("select * from ledger_event where kind = 'imported'")).not.toHaveLength(0)
      await api.applyHandoff(prepared, { registryFile: h.registryFile })
      await door.stop(); door = undefined
      const count = edge.posts().length
      door = await runDoor({ door: "door-fake", registryFile: h.registryFile, platform: edge.platform })
      await Bun.sleep(100)
      expect(edge.posts()).toHaveLength(count)
      // F18 mutation runs the real runner on wrongly enqueued completed history.
      await insertInbound(cluster, h.db, { id: "defective-replayed-completed", body: "completed synthetic instruction" })
      expect(await observe(() => fed().includes("completed synthetic instruction"))).toBe(true)
      expect(() => accepts(sent(), fed())).toThrow()
      const defective = await stage(cluster, name)
      let badDoor: Awaited<ReturnType<typeof runDoor>> | undefined
      let badRunner: Awaited<ReturnType<typeof runRunner>> | undefined
      try {
        await api.applyHandoff(prepared, { registryFile: defective.h.registryFile })
        const conserved = (rows: any[]) => expect(rows.filter(r => r.body === "fully owed")).toHaveLength(1)
        conserved(await defective.h.read.outbox())
        await defective.h.read.sql("delete from outbox where body = 'fully owed'")
        const lost = await defective.h.read.outbox()
        expect(() => conserved(lost)).toThrow()
        defective.edge.batch([{ platform_message_id: "6", chat: "0000000000", sender_id: "p1", from: "p1", text: "later arrival", at: new Date().toISOString(), media: [] }], "6")
        badRunner = await runRunner({ runner: "runner-pi", registryFile: defective.h.registryFile, adapters: { [defective.h.adapterName]: defective.h.scripted.adapter } })
        badDoor = await runDoor({ door: "door-fake", registryFile: defective.h.registryFile, platform: defective.edge.platform })
        expect(await observe(() => defective.edge.posts().some(r => r.text === "reply to later arrival"), 7000)).toBe(true)
        expect(() => accepts(defective.edge.posts().map(r => r.text), defective.h.scripted.fed().map(r => r.text))).toThrow()
      } finally { await badDoor?.stop(); await badRunner?.stop(); await defective.h.stop() }
    } finally { edge.release(); await door?.stop(); await runner?.stop(); await h.stop(); await cluster.stop() }
  } finally { f.stop() }
})

for (const fault of ["unknown-receipt", "omitted-open-item", "changed-source", "cursor-past-omission", "missing-media", "changed-media"] as const) test(`ROLL-18 ${fault} blocks all application and repaired manifest passes`, async () => {
  const f = migrationFixture()
  try {
    const api = await handoff()
    const cluster = await startCluster()
    const { h } = await stage(cluster, "telegram")
    try {
      const manifest = structuredClone(f.handoffManifest)
      let frozen = readFileSync(f.frozen, "utf8")
      if (fault === "missing-media" || fault === "changed-media") {
        const path = join(f.dir, "saved-media.bin")
        writeFileSync(path, "synthetic media")
        const media = { path, sha256: digest("synthetic media"), kind: "file", name: "saved-media.bin" }
        f.handoffManifest.items[1].media = [media]
        manifest.items[1].media = [{ ...media, ...(fault === "missing-media" ? { path: path + ".missing" } : {}) }]
        privateJson(f.frozen, { agents: f.handoffManifest.agents, items: f.handoffManifest.items })
        frozen = readFileSync(f.frozen, "utf8")
        f.handoffManifest.sources = inventory([f.frozen])
        manifest.sources = f.handoffManifest.sources
        if (fault === "changed-media") writeFileSync(path, "changed bytes")
      }
      if (fault === "unknown-receipt") manifest.items[4].parts[0].receipt.outcome = "unknown"
      if (fault === "omitted-open-item") manifest.items = manifest.items.filter((i: any) => i.source_id !== "4")
      if (fault === "cursor-past-omission") { manifest.items = manifest.items.filter((i: any) => i.source_id !== "2"); manifest.cursors[0].cursor = "6" }
      if (fault === "changed-source") writeFileSync(f.frozen, frozen + " ")
      await expect(api.applyHandoff(manifest, { registryFile: h.registryFile })).rejects.toThrow(/unknown|receipt|inventory|omitt|digest|source|cursor|media|ENOENT/i)
      expect(await h.read.inbound()).toHaveLength(0)
      expect(await h.read.outbox()).toHaveLength(0)
      expect(await h.read.sheet("cutover")).toHaveLength(0)
      expect(await h.read.sheet("door_cursor")).toHaveLength(0)
      expect(jsonlBytes(h.stateDir, "p1", "p1-lair")).toEqual({})
      writeFileSync(f.frozen, frozen)
      if (fault === "missing-media" || fault === "changed-media") writeFileSync(join(f.dir, "saved-media.bin"), "synthetic media")
      await api.applyHandoff(await api.prepareHandoff(f.handoffManifest), { registryFile: h.registryFile })
      expect((await h.read.sheet("cutover"))[0].data.complete).toBe(true)
    } finally { await h.stop(); await cluster.stop() }
  } finally { f.stop() }
})

test("ROLL-18 crash after append before fsync and final gate resumes with stable IDs", async () => {
  const f = migrationFixture()
  try {
    const api = await handoff()
    const cluster = await startCluster()
    const { h } = await stage(cluster, "telegram")
    let child: ReadyProcess | undefined
    try {
      const manifest = await api.prepareHandoff(f.handoffManifest)
      const file = chatLogFile({ stateDir: h.stateDir, person: "p1", agent: "p1-lair", at: new Date(manifest.freeze_at) })
      mkdirSync(dirname(file), { recursive: true })
      const config = privateJson(join(f.dir, "crash.json"), { mode: "migration", point: "append-before-fsync", file, manifest, registryFile: h.registryFile })
      child = await startReadySubprocess("test/helpers/rollout-crash-child.ts", [config], 5000)
      expect(readFileSync(file, "utf8").trim().length).toBeGreaterThan(0)
      expect((await h.read.sheet("cutover")).some(r => r.data.complete)).toBe(false)
      expect(await h.read.sheet("door_cursor")).toHaveLength(0)
      await child.stop(9)
      await api.applyHandoff(manifest, { registryFile: h.registryFile })
      const once = jsonlBytes(h.stateDir, "p1", "p1-lair")
      const ids = Object.values(once).join("").trim().split("\n").map(s => JSON.parse(s).id)
      expect(ids.every(Boolean)).toBe(true)
      expect(new Set(ids).size).toBe(ids.length)
      await api.applyHandoff(manifest, { registryFile: h.registryFile })
      expect(jsonlBytes(h.stateDir, "p1", "p1-lair")).toEqual(once)
      expect((await h.read.sheet("cutover"))[0].data.complete).toBe(true)
    } finally { await child?.stop(9); await h.stop(); await cluster.stop() }
  } finally { f.stop() }
})

test("L14 handoff uses door and runner roles for each actual mutation", async () => {
  const f = migrationFixture()
  try {
    const api = await handoff()
    const cluster = await startCluster()
    const { h } = await stage(cluster, "telegram")
    try {
      await h.read.sql("create table handoff_audit (relation text, role text, sheet text, operation text)")
      await h.read.sql(`create function handoff_observe() returns trigger language plpgsql as $$ begin
        insert into handoff_audit values (TG_TABLE_NAME, current_user, case when TG_TABLE_NAME = 'state_row' then to_jsonb(NEW)->>'sheet' else null end, TG_OP);
        return NEW;
      end $$`)
      await h.read.sql("grant insert on handoff_audit to hub_door, hub_runner, hub_hub")
      for (const table of ["inbound", "outbox", "state_row"]) await h.read.sql(`create trigger observe_handoff after insert or update on ${table} for each row execute function handoff_observe()`)
      await api.applyHandoff(await api.prepareHandoff(f.handoffManifest), { registryFile: h.registryFile })
      const roles = (rows: any[]) => {
        for (const [relation, role, sheet] of [["inbound", "hub_door", null], ["outbox", "hub_runner", null], ["state_row", "hub_door", "door_cursor"]]) {
          const writes = rows.filter(r => r.relation === relation && (relation !== "inbound" || r.operation === "INSERT") && (sheet === null || r.sheet === sheet))
          expect(writes.length, "L14 real handoff write observations").toBeGreaterThan(0)
          expect(writes.every(r => r.role === role), "D-181 narrow writer role").toBe(true)
        }
      }
      const rows = await h.read.sql("select * from handoff_audit")
      expect(() => roles(rows.map(r => ({ ...r, role: "hub_hub" })))).toThrow()
      roles(rows)
    } finally { await h.stop(); await cluster.stop() }
  } finally { f.stop() }
})
