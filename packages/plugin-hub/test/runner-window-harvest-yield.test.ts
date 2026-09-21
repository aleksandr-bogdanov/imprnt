// A cold agent yields its first child to a resident agent's waiting harvest,
// and a harvest counts as waiting only when its OWN agent's window lets it run.
//
// The runner gives a resident agent's unclaimed harvest the next child before
// an agent with no live session starts one, and wakes that agent again on a
// capacity change. Above the window's pause threshold every rank-1 row waits
// for the pause to lift, a harvest included, so no child is ever started for
// it and no capacity change ever follows. Whether a harvest is waiting is
// therefore a question about the resident's window, whatever window the cold
// agent itself is on, or every on-demand agent on the runner parks its
// person's message behind a row that cannot move.
//
// Every stage is one runner with two agents of one person: the default agent
// resident with a harvest row, and a second agent on-demand with no session.
// The plan preset reads 88% against the shipped 85, 95 and 100, which is the
// pause and short of the hold, so rank 0 still flows on it. The per-token
// preset has no window at all.
//
// Red reason: a build that asks whether a resident harvest is waiting with no
// rank ceiling, or with the COLD agent's ceiling in place of the resident's,
// sees a paused harvest as waiting in one of the first two stages, and the
// wait there times out with the cold agent's row still `received` and
// unclaimed. A build that stops yielding altogether answers the cold row while
// the resident is busy in the control, and fails there.

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
/** The same person's second agent, on-demand, on the same runner. */
const COLD = "p1-drinks";
/** Past the shipped pause at 85 and short of the hold at 100. */
const PAUSED = 0.88;
/** The plan preset the stage ships, and a per-token one beside it. */
const PLAN = "daily";
const KEY = "metered";

type Runner = Awaited<ReturnType<typeof runRunner>>;

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

async function inboundNow(it: StagedHub): Promise<string> {
  return JSON.stringify(
    (await it.read.inbound()).map(({ id, agent, kind, state, claimed_by }) => ({ id, agent, kind, state, claimed_by })),
  );
}

/**
 * The resident agent and the cold one, each on the preset named, with the
 * household's plan window already past its pause before the runner reads a
 * row, exactly as a runner restarted into a busy window finds it.
 */
async function stage(presets: { resident: string; cold: string }): Promise<StagedHub> {
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
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
    // Every turn reports the same reading, so no turn in a stage can move the
    // household off the pause.
    adapter: { window: { utilization: PAUSED, resets_at: resetsAt } },
    agents: [
      {
        id: COLD,
        person: PERSON,
        preset: presets.cold,
        chat: `${CHAT}2`,
        door: DOOR,
        runner: RUNNER,
        mode: "on-demand",
      },
    ],
    registry: (base) => ({
      ...base,
      presets: {
        ...base.presets,
        // A per-token key has no window and carries no window field, which the
        // loader refuses there.
        [KEY]: {
          adapter: String(base.presets?.[PLAN]?.adapter ?? ""),
          model: "a-model-name",
          provider: "a-provider",
          effort: "medium",
          paid: "key",
        },
      },
      agents: (base.agents ?? []).map((agent) =>
        agent.id === AGENT ? { ...agent, preset: presets.resident } : agent,
      ),
    }),
  });
  const owner = await superStore(cluster, it.db);
  try {
    await recordWindow(owner, { credential: CREDENTIAL, utilization: PAUSED, resetsAt, runner: RUNNER });
  } finally {
    await owner.close();
  }
  return it;
}

async function plantHarvest(it: StagedHub): Promise<string> {
  const until = new Date(Date.now() - 1000).toISOString();
  const id = harvestRowId(AGENT, until);
  await insertInbound(cluster, it.db, {
    id,
    kind: "harvest",
    agent: AGENT,
    body: encodeHarvestBody({ from: null, until, reason: "quiet", lines: 1 }),
  });
  return id;
}

async function start(it: StagedHub): Promise<Runner> {
  return await runRunner({
    runner: RUNNER,
    registryFile: it.registryFile,
    adapters: { [it.adapterName]: it.scripted.adapter },
  });
}

/** The resident is on the plan at its pause, whatever the cold agent is on. */
async function coldAnswersBesidePausedHarvest(cold: string): Promise<void> {
  const it = await stage({ resident: PLAN, cold });
  let runner: Runner | undefined;
  try {
    const harvest = await plantHarvest(it);
    runner = await start(it);
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
      () => inboundNow(it),
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
}

test("a cold agent answers its person while the plan window has paused a resident agent's harvest", async () => {
  await coldAnswersBesidePausedHarvest(PLAN);
}, 120_000);

test("a cold agent on a per-token key answers its person while the plan window has paused a resident agent's harvest", async () => {
  await coldAnswersBesidePausedHarvest(KEY);
}, 120_000);

test("a cold agent at its own window's pause still yields its first child to a resident harvest that can run", async () => {
  // The resident is on the per-token key, so its harvest can always run, and
  // the cold agent is the one on the paused plan.
  const it = await stage({ resident: KEY, cold: PLAN });
  let runner: Runner | undefined;
  try {
    runner = await start(it);
    await Bun.sleep(1500);
    // The resident is busy with a turn that has not ended, so its harvest
    // cannot be claimed yet and the cold agent reads it as waiting.
    it.scripted.holdTurnEnd(true);
    await insertInbound(cluster, it.db, { id: "resident-busy", agent: AGENT, body: "a long question" });
    await until(
      "the resident agent was fed its human row",
      () => it.scripted.fed().some((one) => one.id === "resident-busy"),
      30_000,
      () => inboundNow(it),
    );
    const harvest = await plantHarvest(it);
    await insertInbound(cluster, it.db, { id: "cold-human", agent: COLD, body: "what is in the fridge" });
    await Bun.sleep(2500);
    expect(await rowOf(it, "cold-human")).toMatchObject({ state: "received", claimed_by: null });
    expect(it.scripted.fed().some((one) => one.id === "cold-human")).toBe(false);

    // The resident's turn ends, it takes its harvest, and that is what lets
    // the cold agent start its child.
    it.scripted.holdTurnEnd(false);
    await until(
      "the cold agent's human row was answered after the harvest",
      () => answered(it, "cold-human"),
      30_000,
      () => inboundNow(it),
    );
    const settled = (await it.read.ledger({ stream: "inbound", subject: harvest, kind: "answered" }))[0];
    const cold = (await it.read.ledger({ stream: "inbound", subject: "cold-human" }))
      .filter((row) => row.kind !== "received");
    expect(settled).toBeDefined();
    expect(cold.length).toBeGreaterThan(0);
    expect(settled.seq).toBeLessThan(cold[0].seq);
  } finally {
    it.scripted.holdTurnEnd(false);
    await runner?.stop();
    await it.stop();
  }
}, 120_000);
