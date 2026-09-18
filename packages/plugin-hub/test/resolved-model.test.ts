import { rmSync } from "node:fs"
import { boxCommand, boxContextFor } from "../src/box/index.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { beforeAll, afterAll, expect, test } from "bun:test"
import { claudeCode } from "../src/adapters/claude-code.ts"
import { fakeClaudeCli, healthyResult } from "./helpers/fake-cli.ts"
import { ending } from "./helpers/rollout-loop.ts"
import { startCluster, type Cluster, until } from "./helpers/cluster.ts"
import { stageHub, insertInbound } from "./helpers/hub-fixture.ts"
import { stageHarvest, plantLine } from "./helpers/harvest-stage.ts"
import { expectedPresetId } from "./helpers/preset-oracle.ts"
import { runRunner } from "../src/runner/run.ts"
import type { RegistrySpec } from "./helpers/registry.ts"
import type { Adapter } from "../src/adapters/types.ts"
let cluster: Cluster | undefined
beforeAll(async () => { await import("../live/prove-rollout-loop.ts") })
afterAll(async () => { await cluster?.stop() })
const modelUsage = { "synthetic-side-model": { inputTokens: 900, outputTokens: 30 }, "synthetic-primary-model": { inputTokens: 3, outputTokens: 2 } }
const preset = { adapter: "claude-code", model: "synthetic-alias", provider: "synthetic-provider", effort: "medium", paid: "key" }
function wire(evidence: "direct" | "usage" | "none") {
  return [...(evidence === "direct" ? [{ type: "stream_event", event: { type: "message_start", message: { model: "synthetic-primary-model" } } }, { type: "assistant", message: { model: "synthetic-primary-model", content: [{ type: "text", text: "synthetic answer" }] } }] : []),
    { ...healthyResult("nothing"), ...(evidence === "none" ? {} : { modelUsage }) }]
}
for (const evidence of ["direct", "usage", "none"] as const) test(`ROLL-06 parser keeps ${evidence} resolved model evidence without guessing primary`, async () => {
  const session = await claudeCode.start({ preset, sessionId: null, wrap: fakeClaudeCli(wire(evidence)) })
  try {
    const end: any = await ending(session)
    expect(end.text).toBe("nothing")
    const accepts = (value: any) => {
      expect(value.usage.resolved_model_ids).toEqual(evidence === "none" ? [] : ["synthetic-primary-model", "synthetic-side-model"])
      expect(value.usage.primary_model_id).toBe(evidence === "direct" ? "synthetic-primary-model" : null)
      if (evidence !== "none") expect(value.usage.raw.modelUsage).toEqual(modelUsage)
    }
    expect(() => accepts({ ...end, usage: { ...end.usage, resolved_model_ids: [preset.model], primary_model_id: "synthetic-side-model" } })).toThrow()
    accepts(end)
  } finally { await session.close() }
})

for (const kind of ["ordinary", "tail", "harvest"]) for (const evidence of ["direct", "none"] as const) test(`ROLL-06 ${kind} settlement retains alias identity and ${evidence} model evidence`, async () => {
  cluster ??= await startCluster()
  const common = { preset: { model: "synthetic-alias", paid: "key" }, registry: (base: RegistrySpec) => ({ ...base, agents: base.agents!.map(agent => ({ ...agent, runner: "runner-pi" })) }) }
  const harvest = kind === "harvest" ? await stageHarvest(cluster, common) : null
  const it = harvest?.hub ?? await stageHub(cluster, common)
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    if (kind === "tail") {
      const { appendChatLine } = await import("../src/chatlog.ts")
      await appendChatLine({ stateDir: it.stateDir, person: "p1", agent: "p1-lair" }, { at: new Date().toISOString(), direction: "in", from: "p1", text: "synthetic tail codeword" })
    }
    const adapter: Adapter = { name: it.adapterName, start: options => claudeCode.start({ ...options, wrap: fakeClaudeCli(wire(evidence)) }) }
    if (harvest) {
      const at = new Date(Date.now() - 10_000).toISOString()
      plantLine(harvest, { at, direction: "in", from: "p1", text: "synthetic harvest codeword" })
      const sql = cluster.connect(it.db)
      await sql`insert into inbound (id,person,agent,kind,body) values ('resolved-harvest','p1','p1-lair','harvest',${JSON.stringify({ person: "p1", agent: "p1-lair", until: new Date().toISOString(), reason: "demand", from: null, lines: 1 })})`
    } else await insertInbound(cluster, it.db, { id: "resolved-human", body: "synthetic input" })
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: adapter } })
    await until("resolved-model settlement", async () => (await it.read.ledger({ stream: "turn" })).some(row => kind === "tail" ? row.detail.tail === true : row.subject === (harvest ? "resolved-harvest" : "resolved-human")), 15_000)
    const record = (await it.read.ledger({ stream: "turn" })).find(row => kind === "tail" ? row.detail.tail === true : row.subject === (harvest ? "resolved-harvest" : "resolved-human"))!.detail
    expect(record.preset_id).toBe(expectedPresetId(record.preset_settings as Record<string, string>))
    expect((record.preset_settings as any).model).toBe(harvest ? harvest.harvesterPreset.model : "synthetic-alias")
    expect(record.resolved_model_ids, "D-165 settlement must retain resolved evidence").toEqual(evidence === "none" ? [] : ["synthetic-primary-model", "synthetic-side-model"])
    expect(record.primary_model_id).toBe(evidence === "none" ? null : "synthetic-primary-model")
    if (evidence === "none") expect(record.lacks).toContain("resolved_model")
    else expect((record.raw_usage as any).modelUsage).toEqual(modelUsage)
  } finally {
    await runner?.stop()
    const profile = boxCommand([], boxContextFor(loadRegistry(it.registryFile), "p1-lair")).profile
    if (profile) rmSync(profile.path, { force: true })
    if (harvest) await harvest.stop(); else await it.stop() }
})
