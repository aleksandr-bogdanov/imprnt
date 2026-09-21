// A cold agent yields its first child to a resident agent's waiting harvest,
// and a harvest the plan window has paused is not waiting.
//
// The runner gives a resident agent's unclaimed harvest the next child before
// an agent with no live session starts one, and wakes that agent again on a
// capacity change. Above the window's pause threshold every rank-1 row waits
// for the pause to lift, a harvest included, so no child is ever started for
// it and no capacity change ever follows. The yield therefore has to count
// only a harvest the current window lets run, or every on-demand agent on the
// runner parks its person's message behind a row that cannot move.
//
// The stage is one runner with two agents on the same plan credential: the
// default agent resident with a harvest row waiting, and a second agent
// on-demand with no session. The reading sits at 88% against the shipped 85,
// 95 and 100, which is the pause and short of the hold, so rank 0 still flows.
//
// Red reason: a build that asks whether a resident harvest is waiting without
// the window's rank ceiling sees the paused harvest as waiting, the cold agent
// never claims its human row, and the wait below times out with that row
// still `received` and unclaimed.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCluster, until, type Cluster } from "./helpers/cluster.ts";
import {
  AGENT,
  CHAT,
  DOOR,
  PERSON,
  RUNNER,
  insertInbound,
  stageHub,
  superStore,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
import { runRunner } from "../src/runner/run.ts";
import { recordWindow } from "../src/runner/outage.ts";
import { encodeHarvestBody, harvestRowId } from "../src/harvest/row.ts";

let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

const CREDENTIAL = "household-claude";
/** The same person's second agent, on-demand, on the same runner and plan. */
const COLD = "p1-drinks";
/** Past the shipped pause at 85 and short of the hold at 100. */
const PAUSED = 0.88;

async function answered(it: StagedHub, id: string): Promise<boolean> {
  const rows = await it.read.sql(
    "select 1 from ledger_event where stream = 'inbound' and kind = 'answered' and subject = $1",
    [id],
  );
  return rows.length > 0;
}

async function rowOf(it: StagedHub, id: string): Promise<Record<string, unknown>> {
  const rows = await it.read.sql("select id, state, claimed_by from inbound where id = $1", [id]);
  return rows[0];
}

test("a cold agent answers its person while the plan window has paused a resident agent's harvest", async () => {
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  const window = { utilization: PAUSED, resets_at: resetsAt };
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    credentials: [
      {
        id: CREDENTIAL,
        kind: "claude-login",
        file: "/var/lib/imprnt-hub/credentials/claude.json",
        owner: "household",
      },
    ],
    // No window thresholds here: a plan preset gets the shipped 85, 95 and 100.
    preset: { credential: CREDENTIAL },
    // Every turn reports the same reading, so no turn in this stage can move
    // the household off the pause.
    adapter: { window },
    agents: [
      {
        id: COLD,
        person: PERSON,
        preset: "daily",
        chat: `${CHAT}2`,
        door: DOOR,
        runner: RUNNER,
        mode: "on-demand",
      },
    ],
  });
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
  try {
    // The household is already past its pause before the runner reads a row,
    // exactly as a runner restarted into a busy window finds it.
    const owner = await superStore(cluster, it.db);
    try {
      await recordWindow(owner, {
        credential: CREDENTIAL,
        utilization: PAUSED,
        resetsAt,
        runner: RUNNER,
      });
    } finally {
      await owner.close();
    }

    const harvestUntil = new Date(Date.now() - 1000).toISOString();
    const harvest = harvestRowId(AGENT, harvestUntil);
    await insertInbound(cluster, it.db, {
      id: harvest,
      kind: "harvest",
      agent: AGENT,
      body: encodeHarvestBody({ from: null, until: harvestUntil, reason: "quiet", lines: 1 }),
    });

    runner = await runRunner({
      runner: RUNNER,
      registryFile: it.registryFile,
      adapters: { [it.adapterName]: it.scripted.adapter },
    });
    // The pause is in effect: the resident agent's loop is up and leaves its
    // rank-1 harvest alone.
    await Bun.sleep(2500);
    expect(await rowOf(it, harvest)).toMatchObject({ state: "received", claimed_by: null });

    // The cold agent's first work ever, so it has no session when it reads it.
    await insertInbound(cluster, it.db, { id: "cold-human", agent: COLD, body: "what is in the fridge" });
    await until(
      "the cold agent's human row was answered while the resident harvest sat paused",
      () => answered(it, "cold-human"),
      30_000,
      async () => JSON.stringify(
        (await it.read.inbound()).map(({ id, agent, kind, state, claimed_by }) => ({ id, agent, kind, state, claimed_by })),
      ),
    );

    // The resident agent still answers rank 0 beside it, so its loop is alive
    // and the harvest it leaves waiting is waiting on the window.
    await insertInbound(cluster, it.db, { id: "resident-human", agent: AGENT, body: "and in the freezer" });
    await until("the resident agent's human row was answered", () => answered(it, "resident-human"), 30_000);
    await Bun.sleep(2500);
    expect(await rowOf(it, harvest)).toMatchObject({ state: "received", claimed_by: null });
    expect(await answered(it, harvest)).toBe(false);
  } finally {
    await runner?.stop();
    await it.stop();
  }
}, 120_000);
