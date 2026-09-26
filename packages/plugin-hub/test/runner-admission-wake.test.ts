// An agent waiting on admission is let in when a registry edit makes room,
// within a tick and with no restart.
//
// The admission used to re-check only when a child started or was released.
// A runner whose slots were all held by resident agents never released one,
// so an agent waiting for a slot waited for ever, and a registry edit that
// raised `max_active_children` changed nothing until a restart, against the
// rule that a routine edit takes effect within a tick.
//
// Two resident agents on a runner with one slot: the first takes it, the
// second records its wait and sits. The edit raises the count to two, and the
// second agent's message is answered.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, until, type Cluster } from "./helpers/cluster.ts"
import { AGENT, CHAT, DOOR, PERSON, RUNNER, insertInbound, stageHub } from "./helpers/hub-fixture.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const SECOND = "p1-second"

test("a resident waiting for a slot is admitted within a tick of the registry raising max_active_children", async () => {
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    agents: [{ id: SECOND, person: PERSON, preset: "daily", chat: `${CHAT}2`, door: DOOR, runner: RUNNER }],
  })
  const setCount = (count: number) => writeFileSync(it.registryFile, readFileSync(it.registryFile, "utf8")
    .replace(/\nmax_active_children = \d+/g, "")
    .replace(`id = ${JSON.stringify(RUNNER)}\n`, `id = ${JSON.stringify(RUNNER)}\nmax_active_children = ${count}\n`))
  setCount(1)
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
    // One slot, two residents: exactly one of them waits, and says so once.
    await until("one agent recorded its wait for a slot",
      async () => (await it.read.ledger({ stream: "runner", kind: "admission.wait" })).length === 1, 15_000)
    const waiting = (await it.read.ledger({ stream: "runner", kind: "admission.wait" }))[0].subject
    const served = waiting === AGENT ? SECOND : AGENT
    expect([AGENT, SECOND]).toContain(waiting)
    await insertInbound(cluster, it.db, { id: "to-the-waiting-one", agent: waiting, body: "are you there" })
    await insertInbound(cluster, it.db, { id: "to-the-served-one", agent: served, body: "and you" })
    await until("the served agent answers", async () => (await it.read.outbox()).some(r => r.inbound_id === "to-the-served-one"), 15_000)
    // The control: with one slot held by a resident, the waiting agent's
    // message stays unanswered across several ticks.
    await Bun.sleep(3000)
    expect((await it.read.outbox()).some(r => r.inbound_id === "to-the-waiting-one"), "no room, no answer").toBe(false)

    setCount(2)
    await until("the edit let the waiting agent in and its message was answered",
      async () => (await it.read.outbox()).some(r => r.inbound_id === "to-the-waiting-one"), 15_000)
  } finally { await runner?.stop(); await it.stop() }
}, 90_000)
