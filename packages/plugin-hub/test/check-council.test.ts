// `check` reports a council past the grace with seats still open, once per
// council, naming the seats that have not answered in the fix, and clears it
// when the merge lands (the row is gone) or the seats answer.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore } from "./helpers/hub-fixture.ts";
import type { RunSpec } from "./helpers/registry.ts";
import { fakeProber } from "./helpers/prober.ts";
import { appendRow, putRow, removeRow } from "../src/records/statesheet.ts";
import { COUNCIL_SHEET, type CouncilRow } from "../src/door/council.ts";
import { councilFindings } from "../src/check/council.ts";
import { runCheck, type Finding } from "../src/check/run.ts";

const HERE = process.platform === "darwin" ? "mac" : "pi";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const T0 = new Date("2026-09-26T10:00:00.000Z");
const SEATS = ["p1-seat-1", "p1-seat-2", "p1-seat-3"];
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

function council(over: Partial<CouncilRow> = {}): CouncilRow {
  return { person: "p1", agent: "p1-lair", door: "door-fake", chat: "1000000001", task: "weigh it",
    seats: SEATS, at: T0.toISOString(), answered: {}, ...over };
}

test("the finding is pure arithmetic over the sheet: one per open council past the grace, none for a council of another machine's agent, none once every seat is in", () => {
  const args = { agents: new Set(["p1-lair"]), graceSeconds: 300, machine: HERE };
  const open = { id: "council:telegram:1000000001:1", ...council() };
  expect(councilFindings({ ...args, councils: [open], now: later(300) })).toEqual([]);
  const found = councilFindings({ ...args, councils: [open], now: later(301) });
  expect(found).toHaveLength(1);
  expect(found[0]).toEqual({
    id: `${HERE}/council-overdue:${open.id}`, kind: "council-overdue", subject: open.id, machine: HERE,
    says: `${open.id} was convened for p1-lair 301 seconds ago and 3 of its 3 seats have not answered, which is 1 seconds past the 300 second grace`,
    fix: "read the runner log for p1-seat-1, p1-seat-2, p1-seat-3",
  });
  // Two seats in, one open: the fix names the one. A dead seat (null) counts as in.
  const two = { ...open, answered: { "p1-seat-1": "yes", "p1-seat-3": null } };
  expect(councilFindings({ ...args, councils: [two], now: later(1000) })[0].fix).toBe("read the runner log for p1-seat-2");
  // Every seat in: nothing, even though the row has not been removed yet.
  const all = { ...open, answered: { "p1-seat-1": "yes", "p1-seat-2": "no", "p1-seat-3": null } };
  expect(councilFindings({ ...args, councils: [all], now: later(1000) })).toEqual([]);
  // Another machine's agent: not this machine's to report.
  expect(councilFindings({ ...args, agents: new Set(["p2-lair"]), councils: [open], now: later(1000) })).toEqual([]);
});

test("check reports council-overdue against the real sheet and clears it when the row goes", async () => {
  const DOOR_ENTRY: RunSpec = { id: "door-fake", kind: "door", machine: HERE, platform: "fake", person: "p1",
    token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 };
  const RUNNER_ENTRY: RunSpec = { id: "runner-test", kind: "runner", machine: HERE, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 };
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1, job_grace_seconds: 60 },
    machines: [{ id: HERE, os: HERE_OS }],
    agents: SEATS.map((id) => ({ id, person: "p1", preset: "daily", runner: "runner-test", role: "council" })),
    run: [DOOR_ENTRY, RUNNER_ENTRY],
  });
  let store: Awaited<ReturnType<typeof superStore>> | null = null;
  try {
    store = await superStore(cluster, it.db);
    const check = async (now: Date) => ((await runCheck({
      machine: HERE, registryFile: it.registryFile, store: store!, os: null, kernel: null, credentials: fakeProber({}), now,
    })) as Finding[]).filter((one) => one.kind === "council-overdue");
    const id = "council:telegram:1000000001:7";
    expect(await check(later(100))).toEqual([]);
    await appendRow(store, COUNCIL_SHEET, id, council() as unknown as Record<string, unknown>);
    expect(await check(later(60))).toEqual([]);
    const found = await check(later(61));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "council-overdue", subject: id, machine: HERE, fix: `read the runner log for ${SEATS.join(", ")}` });
    // Two seats land: the fix narrows to the one still open.
    await putRow(store, COUNCIL_SHEET, id, council({ answered: { "p1-seat-1": "yes", "p1-seat-2": null } }) as unknown as Record<string, unknown>);
    expect((await check(later(61)))[0].fix).toBe("read the runner log for p1-seat-3");
    // The merge landed, the row is gone, the finding clears.
    await removeRow(store, COUNCIL_SHEET, id);
    expect(await check(later(1000))).toEqual([]);
  } finally {
    await store?.close();
    await it.stop();
  }
}, 60_000);
