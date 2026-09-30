// `check` reports a live council that has waited for its owner or its master past the grace, one whose card
// cannot be shown, and a person with a live council and no General to hear about it in: once per council (or
// person), and clears it when the council moves. A worker that is only quiet or slow is not a finding.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore } from "./helpers/hub-fixture.ts";
import type { RunSpec } from "./helpers/registry.ts";
import { fakeProber } from "./helpers/prober.ts";
import { councilFindings, type LiveCouncil } from "../src/check/council.ts";
import { runCheck, type Finding } from "../src/check/run.ts";
import { loadRegistry } from "../src/registry/load.ts";

const HERE = process.platform === "darwin" ? "mac" : "pi";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const T0 = new Date("2026-09-26T10:00:00.000Z");
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

const live = (over: Partial<LiveCouncil> = {}): LiveCouncil => ({
  id: "council:abc", person: "p1", agent: "p1-lair", lifecycle: "waiting_owner", origin_kind: "owner_request",
  updated_at: T0, waiting: { kind: "members_missing" }, card: "confirmed", ...over });

async function stagedRegistry(general: boolean) {
  const it = await stageHub(cluster, {
    people: [{ id: "p1", allowed_senders: { "door-fake": ["p1"] }, ...(general ? { general: "p1-lair" } : {}) } as never],
  });
  return { it, registry: loadRegistry(it.registryFile) };
}

test("the findings are arithmetic over the live council rows: waiting for the owner or the master past the grace, an undeliverable card, no General; one each, none for another machine's agent", async () => {
  const withGeneral = await stagedRegistry(true);
  const without = await stagedRegistry(false);
  try {
    const args = { agents: new Set(["p1-lair"]), graceSeconds: 300, machine: HERE, registry: withGeneral.registry };
    expect(councilFindings({ ...args, councils: [live()], now: later(300) }), "not yet past the grace").toEqual([]);
    const owner = councilFindings({ ...args, councils: [live()], now: later(301) });
    expect(owner).toHaveLength(1);
    expect(owner[0]).toMatchObject({ id: `${HERE}/council-waiting-owner:council:abc`, kind: "council-waiting-owner", subject: "council:abc", machine: HERE });
    expect(owner[0].says).toContain("301 seconds");
    expect(owner[0].says).toContain("nothing is rerun, replaced or left out until they choose");

    const master = councilFindings({ ...args, councils: [live({ lifecycle: "waiting_master", waiting: null })], now: later(400) });
    expect(master.map(one => one.kind)).toEqual(["council-waiting-master"]);
    const assessing = councilFindings({ ...args, councils: [live({ lifecycle: "assessing", waiting: null })], now: later(400) });
    expect(assessing.map(one => one.kind)).toEqual(["council-waiting-master"]);
    // A council that is running is not a finding, however long it takes, and neither is one a worker is quiet on.
    expect(councilFindings({ ...args, councils: [live({ lifecycle: "running", waiting: null })], now: later(100_000) })).toEqual([]);

    for (const card of ["failed", "missing", "unknown"]) {
      const found = councilFindings({ ...args, councils: [live({ lifecycle: "running", waiting: null, card })], now: later(1) });
      expect(found.map(one => one.kind), card).toEqual(["council-card"]);
      expect(found[0].says).toContain(card);
    }
    expect(councilFindings({ ...args, councils: [live({ lifecycle: "running", waiting: null, card: "not_sent" })], now: later(1) })).toEqual([]);

    // No General: one finding per person, however many councils they have, and not for a legacy council.
    const noGeneral = { ...args, registry: without.registry };
    const two = councilFindings({ ...noGeneral, councils: [live({ lifecycle: "running", waiting: null }), live({ id: "council:def", lifecycle: "running", waiting: null })], now: later(1) });
    expect(two.filter(one => one.kind === "council-no-general")).toEqual([expect.objectContaining({ id: `${HERE}/council-no-general:p1`, subject: "p1" })]);
    expect(councilFindings({ ...noGeneral, councils: [live({ origin_kind: "legacy", lifecycle: "running", waiting: null })], now: later(1) })).toEqual([]);
    expect(councilFindings({ ...args, councils: [live({ lifecycle: "running", waiting: null })], now: later(1) }), "a General is configured").toEqual([]);
    // Another machine's agent is not this machine's to report.
    expect(councilFindings({ ...args, agents: new Set(["p2-lair"]), councils: [live()], now: later(100_000) })).toEqual([]);
  } finally { await withGeneral.it.stop(); await without.it.stop(); }
});

test("check reports the real council row and clears it when the council moves on", async () => {
  const DOOR_ENTRY: RunSpec = { id: "door-fake", kind: "door", machine: HERE, platform: "fake", person: "p1",
    token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 };
  const RUNNER_ENTRY: RunSpec = { id: "runner-test", kind: "runner", machine: HERE, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 };
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1, job_grace_seconds: 60 },
    machines: [{ id: HERE, os: HERE_OS }],
    people: [{ id: "p1", allowed_senders: { "door-fake": ["p1"] }, general: "p1-lair" } as never],
    run: [DOOR_ENTRY, RUNNER_ENTRY],
  });
  let store: Awaited<ReturnType<typeof superStore>> | null = null;
  try {
    store = await superStore(cluster, it.db);
    const check = async (now: Date) => ((await runCheck({
      machine: HERE, registryFile: it.registryFile, store: store!, os: null, kernel: null, credentials: fakeProber({}), now,
    })) as Finding[]).filter((one) => one.kind.startsWith("council-"));
    expect(await check(later(100))).toEqual([]);
    const at = new Date().toISOString();
    await store.sql`insert into council (id, person, agent, origin_kind, origin, return_route, operation_id, question, lifecycle, waiting, checkpoint_deadline, status_effect_key, updated_at)
      values ('council:live', 'p1', 'p1-lair', 'owner_request', ${{ at }}::jsonb, ${{ agent: "p1-lair", door: "door-fake", chat: "1000000001" }}::jsonb,
              'op-live', 'weigh it', 'waiting_owner', ${{ kind: "members_missing" }}::jsonb, now() + interval '30 minutes', 'council-status:council:live', now() - interval '10 minutes')`;
    const found = await check(new Date());
    expect(found.map(one => [one.kind, one.subject])).toEqual([["council-waiting-owner", "council:live"]]);
    // The council moves on: the finding clears.
    await store.sql`update council set lifecycle = 'running', waiting = null, updated_at = now() where id = 'council:live'`;
    expect(await check(new Date())).toEqual([]);
    await store.sql`update council set lifecycle = 'complete' where id = 'council:live'`;
    expect(await check(new Date(Date.now() + 3_600_000))).toEqual([]);
  } finally {
    await store?.close();
    await it.stop();
  }
}, 60_000);
