// After a restart. A runner that went down while the window held its
// rows reads the hold back on startup and treats the window it finds the way a
// running runner treats the window on its next wake.
//
// THE HOLD CANNOT BE A FLAG IN THE AGENT LOOP'S MEMORY: a runner
// that comes back up with the window already fine then releases nothing, and
// its rows sat on a `retry_at` an hour out because nothing but the transition
// out of the hold clears it.
//
// THE RECOVERED READING KEEPS ITS RESET IN THE FUTURE, and that is what makes
// the release stage able to fail. A reading whose own reset has passed releases
// itself: the rows' `retry_at` is that same reset, so `claimNext` takes them
// with no help. Only a fresh reading under the hold threshold, planted while
// the runner is down the way a sibling runner's turn would write it, leaves the
// rows waiting on a deadline that no longer means anything.
//
// THE CONTROL restarts into a window that is STILL used up, and nothing may
// move: a build that cleared every retry on startup passes the release stage
// and fails this one.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import {
  PERSON,
  RUNNER,
  insertInbound,
  stageHub,
  superStore,
  type StagedHub,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 120_000;
const CREDENTIAL = "household-claude";
const TICK_SECONDS = 2;
const RETRY_SECONDS = 2;
const HELD = ["r-held-human", "r-held-triage"];

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

interface Held {
  it: StagedHub;
  resetsAt: string;
  outageSince: string;
  retryAt: Map<string, number>;
}

async function startRunner(it: StagedHub): Promise<{ stop(): Promise<void> }> {
  const { runRunner } = await seam("src/runner/run.ts");
  return (await (runRunner as Function)({
    runner: RUNNER,
    registryFile: it.registryFile,
    adapters: { [it.adapterName]: it.scripted.adapter },
  })) as { stop(): Promise<void> };
}

async function plant(it: StagedHub, id: string, kind: "human" | "triage"): Promise<void> {
  await insertInbound(cluster, it.db, { id, body: `${kind} work called ${id}`, kind });
}

async function answered(it: StagedHub, id: string): Promise<boolean> {
  const rows = await it.read.sql(
    "select 1 from ledger_event where stream = 'inbound' and kind = 'answered' and subject = $1",
    [id],
  );
  return rows.length > 0;
}

async function retryOf(it: StagedHub, id: string): Promise<number | null> {
  const [row] = await it.read.sql("select retry_at from inbound where id = $1", [id]);
  return row?.retry_at ? new Date(String(row.retry_at)).getTime() : null;
}

function prefixed(rows: { notice_key: string | null }[], prefix: string) {
  return rows.filter((row) => String(row.notice_key).startsWith(prefix));
}

/**
 * One runner holds two rows, one of each rank, on a used-up window whose reset
 * is an hour out, and then goes down. What the store holds when it returns is
 * exactly what a hold leaves behind and nothing else.
 */
async function holdThenStop(): Promise<Held> {
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  const it = await stageHub(cluster, {
    hub: { tick_seconds: TICK_SECONDS, outage_retry_seconds: RETRY_SECONDS },
    people: [{ id: PERSON, language: "en" }],
    credentials: [
      {
        id: CREDENTIAL,
        kind: "claude-login",
        file: "/var/lib/imprnt-hub/credentials/claude.json",
        owner: "household",
      },
    ],
    preset: {
      credential: CREDENTIAL,
      window_pause_at: 60,
      window_notice_at: 70,
      window_hold_at: 80,
    },
  });
  let runner: { stop(): Promise<void> } | null = null;
  try {
    it.scripted.setWindow({ utilization: 0.1, resets_at: resetsAt });
    runner = await startRunner(it);

    // One turn carries the household past its hold threshold.
    it.scripted.setWindow({ utilization: 0.85, resets_at: resetsAt });
    await plant(it, "r-human-1", "human");
    await until(
      "the reading past the hold threshold landed",
      () => answered(it, "r-human-1"),
      45_000,
      async () => JSON.stringify(await it.read.inbound()),
    );
    await until(
      "the hold was opened",
      async () => (await it.read.outageSheet()).length === 1,
      30_000,
      async () => JSON.stringify(await it.read.outageSheet()),
    );

    // Two rows arrive during the hold and are put on the window's own reset.
    await plant(it, HELD[0], "human");
    await plant(it, HELD[1], "triage");
    await until(
      "both rows were put on the window's own reset",
      async () => {
        for (const id of HELD) {
          const at = await retryOf(it, id);
          if (at === null || Math.abs(at - Date.parse(resetsAt)) >= 2000) return false;
        }
        return true;
      },
      30_000,
      async () => JSON.stringify(await it.read.sql("select id, retry_at from inbound")),
    );

    await runner.stop();
    runner = null;

    // The precondition, asserted rather than assumed: the rows are held, the
    // hold is on the sheet with its own cause, and the person was told once.
    for (const id of HELD) expect(await answered(it, id)).toBe(false);
    const sheet = await it.read.outageSheet();
    expect(sheet.length).toBe(1);
    expect(sheet[0].data.cause).toBe("window");
    expect(prefixed(await it.read.noticeRows(), "outage:").length).toBe(1);
    expect(prefixed(await it.read.noticeRows(), "outage-over:").length).toBe(0);

    const retryAt = new Map<string, number>();
    for (const id of HELD) retryAt.set(id, (await retryOf(it, id))!);
    return { it, resetsAt, outageSince: String(sheet[0].data.since), retryAt };
  } catch (error) {
    if (runner) await runner.stop();
    await it.stop();
    throw error;
  }
}

test(
  "RUN-19 a runner restarted after the window came back releases the rows its hold left waiting, and says it works again once",
  async () => {
    const held = await holdThenStop();
    const it = held.it;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      // The window comes back while nothing is running: a fresh reading under
      // the hold threshold whose reset is still an hour out, which is what a
      // sibling runner's next turn writes into the household's one row.
      const owner = await superStore(cluster, it.db);
      try {
        const { putRow } = await seam("src/records/statesheet.ts");
        await (putRow as Function)(owner, "window", CREDENTIAL, {
          utilization: 0.1,
          resets_at: held.resetsAt,
          at: new Date().toISOString(),
          reported_by: "runner-other",
        });
      } finally {
        await owner.close();
      }
      it.scripted.setWindow({ utilization: 0.1, resets_at: held.resetsAt });

      runner = await startRunner(it);
      // Promptly means a few of the runner's own wakes, and an hour before the
      // reset the rows were put on.
      await until(
        "both held rows were answered once the restarted runner saw the window had come back",
        async () => (await answered(it, HELD[0])) && (await answered(it, HELD[1])),
        6 * TICK_SECONDS * 1000,
        async () =>
          `inbound=${JSON.stringify(
            await it.read.sql("select id, state, claimed_by, retry_at from inbound order by id"),
          )} outage=${JSON.stringify(await it.read.outageSheet())}`,
      );
      expect(Date.now()).toBeLessThan(Date.parse(held.resetsAt));

      // The same path a running runner takes: the hold is closed on the sheet
      // and the person is told it works again, once, on the hold's own key.
      await until(
        "the hold was closed",
        async () => (await it.read.outageSheet()).length === 0,
        10_000,
        async () => JSON.stringify(await it.read.outageSheet()),
      );
      const over = prefixed(await it.read.noticeRows(), "outage-over:");
      expect(over.length).toBe(1);
      expect(String(over[0].notice_key)).toBe(
        `outage-over:${CREDENTIAL}:${held.outageSince}:${PERSON}`,
      );
      expect(prefixed(await it.read.noticeRows(), "outage:").length).toBe(1);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "RUN-19 a runner restarted while the window is still used up keeps every held row on the window's own reset and says nothing new",
  async () => {
    const held = await holdThenStop();
    const it = held.it;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      // Nothing changed while the runner was down, and the loop still reports
      // the used-up window if the restart feeds it anything.
      it.scripted.setWindow({ utilization: 0.85, resets_at: held.resetsAt });
      runner = await startRunner(it);

      // A row that arrives after the restart is held on the same reset, which
      // is the evidence that the restarted runner is awake and reading the
      // window rather than simply not running yet.
      await plant(it, "r-late", "human");
      await until(
        "the restarted runner held the row that arrived after it came up",
        async () => {
          const at = await retryOf(it, "r-late");
          return at !== null && Math.abs(at - Date.parse(held.resetsAt)) < 2000;
        },
        30_000,
        async () => JSON.stringify(await it.read.sql("select id, retry_at from inbound")),
      );
      // Several more of its wakes, and still nothing moves.
      await Bun.sleep(3 * TICK_SECONDS * 1000);

      for (const id of [...HELD, "r-late"]) {
        expect(await answered(it, id)).toBe(false);
      }
      for (const id of HELD) {
        expect(await retryOf(it, id)).toBe(held.retryAt.get(id)!);
      }
      const sheet = await it.read.outageSheet();
      expect(sheet.length).toBe(1);
      expect(sheet[0].data.cause).toBe("window");
      expect(String(sheet[0].data.since)).toBe(held.outageSince);
      expect(prefixed(await it.read.noticeRows(), "outage:").length).toBe(1);
      expect(prefixed(await it.read.noticeRows(), "outage-over:").length).toBe(0);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);
