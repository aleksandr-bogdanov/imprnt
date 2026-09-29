import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { AGENT, PERSON, DOOR, RUNNER, insertInbound, stageHub, superStore } from "./helpers/hub-fixture.ts";
import { putRow, removeRow } from "../src/records/statesheet.ts";
import { startingFindings } from "../src/check/waits.ts";
import { unattemptedReplyFindings } from "../src/check/delivery.ts";
import { appendChunks } from "../src/store/outbox.ts";

let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

test("overdue starting is visible without inbound work, scoped to the runner, and clears", async () => {
  const it = await stageHub(cluster);
  const store = await superStore(cluster, it.db);
  const now = new Date();
  const args = { store, agents: [{ id: AGENT, person: PERSON, runner: RUNNER }],
    startedSeconds: () => 60, machine: "fixture", now };
  try {
    expect(await startingFindings(args)).toHaveLength(0);
    await putRow(store, "agent_wait", AGENT, { kind: "starting", at: new Date(+now - 61000).toISOString() });
    const [finding] = await startingFindings(args);
    expect(finding.kind).toBe("agent-starting");
    expect(finding.fix).toContain(RUNNER);
    expect(await startingFindings({ ...args, agents: [] })).toHaveLength(0);
    expect(await startingFindings({ ...args, startedSeconds: () => 120 })).toHaveLength(0);
    await putRow(store, "agent_wait", AGENT, { kind: "harvest", at: new Date(+now - 61000).toISOString() });
    expect(await startingFindings(args)).toHaveLength(0);
    await removeRow(store, "agent_wait", AGENT);
    expect(await startingFindings(args)).toHaveLength(0);
  } finally { await store.close(); await it.stop(); }
});

test("settled replies with no delivery attempt use the delivered clock, identify the door, and clear", async () => {
  const it = await stageHub(cluster);
  const store = await superStore(cluster, it.db);
  const now = new Date();
  const args = { store, doors: new Set([DOOR]), doorOf: () => DOOR,
    deliveredSeconds: () => 60, machine: "fixture", now };
  try {
    await insertInbound(cluster, it.db, { id: "undelivered", body: "fixture question" });
    await appendChunks(store, "undelivered", ["first", "second"]);
    for (const kind of ["acked", "started"]) await store.sql`insert into ledger_event (stream, subject, kind, actor, detail)
      values ('inbound', 'undelivered', ${kind}, 'runner', '{}')`;
    await store.sql`insert into ledger_event (stream, subject, kind, actor, at, detail)
      values ('inbound', 'undelivered', 'answered', 'runner', ${new Date(+now - 61000)}, '{}')`;
    const [finding] = await unattemptedReplyFindings(args);
    expect(finding.kind).toBe("reply-unattempted");
    expect(finding.fix).toContain(DOOR);
    expect(await unattemptedReplyFindings(args)).toHaveLength(1);
    expect(await unattemptedReplyFindings({ ...args, doors: new Set(["other-door"]) })).toHaveLength(0);
    expect(await unattemptedReplyFindings({ ...args, deliveredSeconds: () => 120 })).toHaveLength(0);
    await store.sql`update outbox set attempts = 1 where inbound_id = 'undelivered'`;
    expect(await unattemptedReplyFindings(args)).toHaveLength(0);
    await store.sql`update outbox set attempts = 0, delivery_state = 'delivered', delivered_at = now() where inbound_id = 'undelivered'`;
    expect(await unattemptedReplyFindings(args)).toHaveLength(0);
    // Half-written replies during a turn are deliberately not deliverable.
    await insertInbound(cluster, it.db, { id: "unfinished", body: "fixture question" });
    await appendChunks(store, "unfinished", ["partial"]);
    for (const kind of ["acked", "started"]) await store.sql`insert into ledger_event (stream, subject, kind, actor, detail)
      values ('inbound', 'unfinished', ${kind}, 'runner', '{}')`;
    expect(await unattemptedReplyFindings(args)).toHaveLength(0);
  } finally { await store.close(); await it.stop(); }
});
