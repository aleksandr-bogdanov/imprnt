import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, seam, type Cluster } from "./helpers/cluster.ts"
import { stageHub, insertInbound, superStore } from "./helpers/hub-fixture.ts"
import { controlledAdapter, observe, retrySettings } from "./helpers/rollout-runner.ts"
import { proveRolloutRunner } from "../live/prove-rollout-runner.ts"
import { runRunner } from "../src/runner/run.ts"
import { clearOutage } from "../src/runner/outage.ts"
import { putRow } from "../src/records/statesheet.ts"

let cluster: Cluster
beforeAll(async () => { await proveRolloutRunner(); cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

test("ROLL-25 cause other remains local with zero notices to the other person", async () => {
  for (const defective of [true, false]) {
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1, outage_retry_seconds: 2 },
    people: [{ id: "p1", language: "en" }, { id: "p2", language: "ru" }],
    credentials: [{ id: "shared-login", kind: "claude-login", owner: "household", file: "/tmp/synthetic-unused-login" }],
    preset: { credential: "shared-login" },
    agents: [{ id: "p2-lair", person: "p2", preset: "daily", runner: "runner-pi", door: "door-fake", chat: "0000000000" }],
    registry: base => ({ ...base, agents: base.agents!.map(a => ({ ...a, runner: "runner-pi" })) }),
  })
  retrySettings(it)
  const edge = controlledAdapter(it.adapterName)
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
    await insertInbound(cluster, it.db, { id: "healthy-control", body: "accepted" })
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "healthy-control"))).toBe(true)
    const target = edge.sessions.find(r => r.fed.some(m => m.id === "healthy-control"))!
    target.loop.setRefusal({ cause: defective ? "login" : "other", said: "synthetic local refusal" })
    target.loop.setUsage({ ...target.loop.usage, raw: { evidence: defective ? { kind: "authenticated-response", status: 401, credential: "shared-login" } : null } })
    await insertInbound(cluster, it.db, { id: "local-refusal", body: "retry locally" })
    expect(await observe(async () => (await it.read.ledger({ subject: "local-refusal" })).some(r => r.stream === "refusal"))).toBe(true)
    const zeroOther = (notices: { person: string | null }[]) => expect(notices.filter(r => r.person === "p2"), "D-177 local refusal must not notify the other person").toEqual([])
    // The refusal diary row is committed on its own, and the two outage notices
    // land in transactions after it, so the row above is not evidence that the
    // second person's notice exists yet. Only this branch expects that notice,
    // so only this branch waits for it, and the other must never see one.
    if (defective) expect(await observe(async () => (await it.read.noticeRows()).some(r => r.person === "p2"), 15_000),
      "the credential-scoped outage notice for the second person").toBe(true)
    const notices = await it.read.noticeRows()
    // Scoped mutation upgrades only the local refusal to verified shared login.
    // The actual runner writes the notices in both paths.
    if (defective) { expect(() => zeroOther(notices)).toThrow(); continue }
    zeroOther(notices)
    expect(await it.read.outageSheet()).toEqual([])
    expect((await it.read.sheet("agent_health")).some(r => r.id === "p1-lair" && typeof r.data.retry_at === "string")).toBe(true)
    target.loop.setRefusal(null)
    expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "local-refusal"), 5000)).toBe(true)
  } finally { await runner?.stop(); await edge.stop(); await it.stop() }
  }
})

// D-177 names classifyRefusal, but leaves its argument spelling to the build.
// These checks propose one evidence object and assert the resulting scope.
for (const scenario of [
  { name: "other", refusal: { cause: "other", said: "local policy" }, evidence: null, scope: "local" },
  { name: "transport 429", refusal: { cause: "window", said: "too many requests" }, evidence: { kind: "transport", status: 429 }, scope: "local" },
  { name: "unverified login", refusal: { cause: "login", said: "api error" }, evidence: null, scope: "local" },
  { name: "verified login", refusal: { cause: "login", said: "login refused" }, evidence: { kind: "authenticated-response", status: 401, credential: "shared-login" }, scope: "credential" },
  { name: "verified window", refusal: { cause: "window", said: "plan exhausted" }, evidence: { kind: "plan-window", utilization: 1, credential: "shared-login" }, scope: "credential" },
]) test(`ROLL-25 classifyRefusal ${scenario.name} requires source evidence`, async () => {
  const module = await seam("src/runner/outage.ts")
  expect(typeof module.classifyRefusal, "D-177 missing classifyRefusal").toBe("function")
  const classify = module.classifyRefusal as Function
  const input = { credential: "shared-login", refused: scenario.refusal, evidence: scenario.evidence, thresholds: { pause_at: 85, notice_at: 95, hold_at: 100 } }
  const result = classify(input)
  expect(result.scope).toBe(scenario.scope)
  if (scenario.scope === "credential") {
    expect(classify({ ...input, evidence: null }).scope).toBe("local")
    expect(classify({ ...input, evidence: { ...scenario.evidence, credential: "other-login" } }).scope).toBe("local")
  } else expect(() => expect({ ...result, scope: "credential" }.scope).toBe("local")).toThrow()
})

test("ROLL-25 shared episodes deduplicate and only same-source valid evidence clears them", async () => {
  const module = await seam("src/runner/outage.ts")
  expect(typeof module.classifyRefusal, "D-177 missing classifyRefusal").toBe("function")
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1, outage_retry_seconds: 1 },
    people: [{ id: "p1", language: "en" }, { id: "p2", language: "ru" }],
    credentials: ["shared-login", "other-login"].map(id => ({ id, kind: "claude-login", owner: "household", file: `/tmp/synthetic-${id}` })),
    preset: { credential: "shared-login" },
    agents: [
      { id: "p2-lair", person: "p2", preset: "daily", runner: "runner-pi", door: "door-fake", chat: "0000000000" },
      { id: "p1-lair-other", person: "p1", preset: "separate", runner: "runner-pi", door: "door-fake", chat: "1000000001" },
    ],
    registry: base => ({ ...base, presets: { ...base.presets, separate: { ...base.presets!.daily, model: "synthetic-separate", credential: "other-login" } }, agents: base.agents!.map(a => ({ ...a, runner: "runner-pi" })) }),
  })
  const edge = controlledAdapter(it.adapterName)
  let mode: "healthy" | "login" | "window" | "unrelated" | "valid" = "healthy"
  let episodeCause: "login" | "window" = "login"
  const configure = (row: typeof edge.sessions[number]) => {
    if (row.preset.model === "synthetic-separate") return
    const refused = mode === "login" || mode === "window"
    row.loop.setRefusal(refused ? { cause: mode as "login" | "window", said: "synthetic verified refusal" } : null)
    row.loop.setWindow(mode === "window" ? { utilization: 1, resets_at: new Date(Date.now() + 1000).toISOString() }
      : mode === "valid" && episodeCause === "window" ? { utilization: 0.1, resets_at: null } : null)
    const evidence = mode === "login" ? { kind: "authenticated-response", status: 401, credential: "shared-login" }
      : mode === "window" ? { kind: "plan-window", utilization: 1, credential: "shared-login" }
      : mode === "valid" ? { kind: "authenticated-response", status: 200, credential: "shared-login" }
      : { kind: "transport", status: 429 }
    row.loop.setUsage({ ...row.loop.usage, raw: { evidence } })
  }
  edge.onStart(configure)
  const setMode = (value: typeof mode) => { mode = value; for (const row of edge.sessions) configure(row) }
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  const store = await superStore(cluster, it.db)
  try {
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } })
    const separate = edge.sessions.find(r => r.preset.model === "synthetic-separate")!
    for (const cause of ["login", "window"] as const) {
      episodeCause = cause
      setMode(cause)
      for (const person of ["p1", "p2"]) await insertInbound(cluster, it.db, { id: `${cause}-${person}`, person, agent: `${person}-lair`, body: "waiting" })
      expect(await observe(async () => (await it.read.outageSheet()).length === 1)).toBe(true)
      const episode = (await it.read.outageSheet())[0]
      await Bun.sleep(1200)
      const notices = (await it.read.noticeRows()).filter(r => r.notice_key?.startsWith(`outage:shared-login:${episode.data.since}:`))
      expect(notices.map(r => r.person).sort()).toEqual(["p1", "p2"])
      separate.loop.setRefusal(null)
      await insertInbound(cluster, it.db, { id: `${cause}-other-success`, person: "p1", agent: "p1-lair-other", body: "other source succeeds" })
      expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === `${cause}-other-success`))).toBe(true)
      const standing = (rows: { id: string }[]) => expect(rows.some(r => r.id === "shared-login"), "D-177 unrelated success cannot clear shared outage").toBe(true)
      standing(await it.read.outageSheet())
      // Defective clear after another source's success. Read the real sheet,
      // require the standing-outage predicate to fail, then restore the episode.
      await clearOutage(store, { credential: "shared-login" })
      const wronglyCleared = await it.read.outageSheet()
      expect(() => standing(wronglyCleared)).toThrow()
      await putRow(store, "outage", "shared-login", episode.data)
      setMode("unrelated")
      await Bun.sleep(1200)
      standing(await it.read.outageSheet())
      setMode("valid")
      for (const person of ["p1", "p2"]) await insertInbound(cluster, it.db, { id: `${cause}-repair-${person}`, person, agent: `${person}-lair`, body: "valid recovery" })
      expect(await observe(async () => (await it.read.outageSheet()).length === 0, 5000)).toBe(true)
      const recovered = (await it.read.noticeRows()).filter(r => r.notice_key?.startsWith(`outage-over:shared-login:${episode.data.since}:`))
      expect(recovered.map(r => r.person).sort()).toEqual(["p1", "p2"])
    }
  } finally { await runner?.stop(); await edge.stop(); await store.close(); await it.stop() }
})
