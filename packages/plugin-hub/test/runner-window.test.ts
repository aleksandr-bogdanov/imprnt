// A used-up plan window is the same outage, and every threshold comes
// from the file.
//
// SPEC §6 and L10 rule 4: at the pause threshold proactive work pauses, at the
// notice threshold one line goes into the person's chat, at the hold threshold
// rows wait, and "an agent on a per-token key has no window". SPEC §6's
// Forbidden carries "a window threshold in code" and "a setting nothing in
// production reads".
//
// THE THRESHOLDS IN THIS FIXTURE ARE 60, 70 AND 80, deliberately not v2's 85,
// 95 and 100, so a build carrying those numbers in code passes no stage here.
// The pair at the end is what makes criterion 9 a behaviour rather than a
// grep: the SAME reading against a file that says 85, 95 and 100 claims the
// rank-1 row that the file saying 60, 70 and 80 holds.
//
// `inbound.rank` is generated from `kind` (0 for `human` and `report`, 1 for
// `triage`, `room` and `harvest`), so a rank-1 row is a `triage` row and needs
// no schema change.
//
// TWO SCRIPTED LOOPS, one per runner, for the reason test/runner-outage.test.ts
// gives: one fixture serves one open turn at a time.
//
// Red reason: export missing, `claimNext`'s `maxRank`, and import missing,
// `src/runner/outage.ts`. The shipped `claimNext` takes any rank and nothing
// pauses rank 1.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import { createScriptedAdapter } from "./helpers/scripted-adapter.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  insertInbound,
  stageHub,
  superStore,
  type StagedHub,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 120_000;
const RUNNER_PI = "runner-pi";
const RUNNER_MAC = "runner-mac";
const CREDENTIAL = "household-claude";
const RETRY_SECONDS = 2;
/** The first person's second agent, on a per-token key, on the second runner. */
const AGENT_KEY = "p1-study";

/** The household's own numbers, which are not v2's. */
const PAUSE_AT = 60;
const NOTICE_AT = 70;
const HOLD_AT = 80;

/** The pinned strings, written out by the TEST and never imported. */
function windowNotice(percent: number): string {
  return `[door] the plan window is ${percent}% used. Proactive work is paused and your messages still go first.`;
}

const OUTAGE_WINDOW_EN = `[door] the plan's usage window is used up. Messages are waiting and nothing is lost. I try again every ${RETRY_SECONDS} s and will say when it works.`;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

interface Staged {
  it: StagedHub;
  loops: Record<string, ReturnType<typeof createScriptedAdapter>>;
  resetsAt: string;
}

/**
 * Three agents, and each one is there to fail a different wrong build.
 *
 * `p1-lair` is on the PLAN preset and is the only one whose loop ever reports
 * a window. `p2-lair` is a SECOND PERSON on the SAME plan preset and the same
 * credential, on the other runner, and its loop reports nothing: the allowance
 * is one account's, so it has to be paused by the FIRST person's reading (the
 * finding, and v2's own incident, where one person's burn was
 * invisible to the other's pause). `p1-study` is on a per-token KEY preset
 * beside it, and it is never paused at all.
 *
 * The two agents on the second runner share one scripted loop, which is safe
 * now that a loop holds one open turn PER SESSION rather than one per fixture.
 */
async function stageWindow(
  thresholds: { pause: number; notice: number; hold: number },
  options: { resetsInMs?: number } = {},
): Promise<Staged> {
  // An hour out by default, and the same value for every reading, so the
  // window-notice key never changes underneath the check. It is also far
  // enough from `now + outage_retry_seconds` that a held row's retry cannot be
  // mistaken for the login outage's interval. The natural-release stage asks
  // for a reset that really arrives instead.
  const resetsAt = new Date(Date.now() + (options.resetsInMs ?? 3_600_000)).toISOString();
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 2, outage_retry_seconds: RETRY_SECONDS },
    people: [
      { id: PERSON, language: "en" },
      { id: PERSON2, language: "en" },
    ],
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
      window_pause_at: thresholds.pause,
      window_notice_at: thresholds.notice,
      window_hold_at: thresholds.hold,
    },
    agents: [
      {
        id: AGENT2,
        person: PERSON2,
        preset: "daily",
        chat: `${CHAT}1`,
        door: DOOR,
        runner: RUNNER_MAC,
      },
      {
        id: AGENT_KEY,
        person: PERSON,
        preset: "metered",
        chat: `${CHAT}2`,
        door: DOOR,
        runner: RUNNER_MAC,
      },
    ],
    registry: (base) => ({
      ...base,
      presets: {
        ...base.presets,
        // A per-token key has no window and carries no window field, which the
        // loader refuses there.
        metered: {
          adapter: String(base.presets?.daily?.adapter ?? ""),
          model: "a-model-name",
          provider: "a-provider",
          effort: "medium",
          paid: "key",
        },
      },
      agents: (base.agents ?? []).map((agent) =>
        agent.id === AGENT ? { ...agent, runner: RUNNER_PI } : agent,
      ),
    }),
  });
  const loops: Record<string, ReturnType<typeof createScriptedAdapter>> = {
    // The ONLY loop that reports a window. Everything the other runner is held
    // by, it is held by because this one's reading reached the household's own
    // row.
    [RUNNER_PI]: createScriptedAdapter({ name: it.adapterName }),
    [RUNNER_MAC]: createScriptedAdapter({ name: it.adapterName }),
  };
  return { it, loops, resetsAt };
}

async function startRunner(staged: Staged, id: string): Promise<{ stop(): Promise<void> }> {
  const { runRunner } = await seam("src/runner/run.ts");
  return (await (runRunner as Function)({
    runner: id,
    registryFile: staged.it.registryFile,
    adapters: { [staged.it.adapterName]: staged.loops[id].adapter },
  })) as { stop(): Promise<void> };
}

async function plant(
  it: StagedHub,
  id: string,
  kind: "human" | "triage",
  agent = AGENT,
  person = PERSON,
): Promise<void> {
  await insertInbound(cluster, it.db, {
    id,
    body: `${kind} work called ${id}`,
    kind,
    agent,
    person,
  });
}

async function answered(it: StagedHub, id: string): Promise<boolean> {
  const rows = await it.read.sql(
    "select 1 from ledger_event where stream = 'inbound' and kind = 'answered' and subject = $1",
    [id],
  );
  return rows.length > 0;
}

async function stateOf(it: StagedHub, id: string): Promise<Record<string, unknown>> {
  const rows = await it.read.sql(
    "select id, state, claimed_by, retry_at from inbound where id = $1",
    [id],
  );
  return rows[0];
}

function windowNotices(rows: { notice_key: string | null }[]): { notice_key: string | null }[] {
  return rows.filter((row) => String(row.notice_key).startsWith("window-notice:"));
}

test(
  "RUN-19 a used-up plan window pauses proactive work, says one line, holds everything and releases, with every threshold read from the file: the same reading against two files behaves two ways and a per-token key is never paused (SPEC §6, L10 rule 4)",
  async () => {
    // --- the arithmetic first, PURE, so the three-threshold rule is readable
    //     without a store and a build that inverted two of them fails here
    //     rather than four stages later.
    const { maxRankFor, WINDOW_SHEET, recordWindow, readWindow } = await seam(
      "src/runner/outage.ts",
    );
    expect(typeof maxRankFor).toBe("function");
    expect(WINDOW_SHEET).toBe("window");
    expect(typeof recordWindow).toBe("function");
    expect(typeof readWindow).toBe("function");

    const thresholds = { pause_at: PAUSE_AT, notice_at: NOTICE_AT, hold_at: HOLD_AT };
    const reading = (utilization: number) => ({ utilization, resets_at: null });
    expect((maxRankFor as Function)(reading(0.1), thresholds)).toBe(1);
    expect((maxRankFor as Function)(reading(0.59), thresholds)).toBe(1);
    expect((maxRankFor as Function)(reading(0.6), thresholds)).toBe(0);
    expect((maxRankFor as Function)(reading(0.75), thresholds)).toBe(0);
    expect((maxRankFor as Function)(reading(0.8), thresholds)).toBeNull();
    // No reading at all, and no thresholds at all, are both "claim anything":
    // a household that has never seen a window is not a household on hold.
    expect((maxRankFor as Function)(null, thresholds)).toBe(1);
    expect((maxRankFor as Function)(reading(0.99), null)).toBe(1);

    const staged = await stageWindow({ pause: PAUSE_AT, notice: NOTICE_AT, hold: HOLD_AT });
    const it = staged.it;
    const say = (utilization: number) =>
      staged.loops[RUNNER_PI].setWindow({ utilization, resets_at: staged.resetsAt });
    let pi: { stop(): Promise<void> } | null = null;
    let mac: { stop(): Promise<void> } | null = null;
    try {
      say(0.1);
      pi = await startRunner(staged, RUNNER_PI);
      mac = await startRunner(staged, RUNNER_MAC);

      // --- stage 1, healthy. Both ranks land, which is the control that says
      //     the pause is not always on.
      await plant(it, "w-human-1", "human");
      await plant(it, "w-triage-1", "triage");
      await until(
        "both ranks were answered while the window was low",
        async () => (await answered(it, "w-human-1")) && (await answered(it, "w-triage-1")),
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      expect((await it.read.noticeRows()).length).toBe(0);

      // --- stage 2, at the pause. One more human turn carries the reading up
      //     to 65, which is past the household's 60 and short of its 70.
      say(0.65);
      await plant(it, "w-human-2", "human");
      await until(
        "the turn that carried the reading up was answered",
        () => answered(it, "w-human-2"),
        45_000,
      );
      await plant(it, "w-triage-2", "triage");
      await plant(it, "w-human-3", "human");
      await until(
        "the human row was answered while paused",
        () => answered(it, "w-human-3"),
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      await Bun.sleep(RETRY_SECONDS * 1000 + 1000);
      // "At the pause threshold proactive work pauses": the rank-1 row waits
      // and the rank-0 row beside it did not.
      const paused = await stateOf(it, "w-triage-2");
      expect(paused.state).toBe("received");
      expect(paused.claimed_by).toBeNull();
      expect(await answered(it, "w-triage-2")).toBe(false);
      expect(windowNotices(await it.read.noticeRows()).length).toBe(0);

      // AND THE OTHER PERSON'S PLAN AGENT IS PAUSED BY THE SAME READING, at
      // the pause threshold as well as at the hold. Its own loop has reported
      // no window at all: what reaches it is the household's one row.
      await plant(it, "w-other-triage", "triage", AGENT2, PERSON2);
      await plant(it, "w-other-human", "human", AGENT2, PERSON2);
      await until(
        "the other person's rank-0 row was answered while the household was paused",
        () => answered(it, "w-other-human"),
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      await Bun.sleep(RETRY_SECONDS * 1000 + 1000);
      expect(await answered(it, "w-other-triage")).toBe(false);
      expect((await stateOf(it, "w-other-triage")).claimed_by).toBeNull();

      // --- stage 3, at the line. One line into the person's chat, once.
      say(0.75);
      await plant(it, "w-human-4", "human");
      await until(
        "the reading past the notice threshold landed",
        async () =>
          windowNotices(await it.read.noticeRows()).length >= 1 &&
          (await answered(it, "w-human-4")),
        45_000,
        async () => JSON.stringify(await it.read.noticeRows()),
      );
      // ONE LINE PER PERSON WITH A PLAN AGENT ON THIS CREDENTIAL, which is
      // TWO here (a reader named the old "exactly one" as the fixture
      // being out of step with the rule: the allowance is the household's, so
      // everybody whose agent it pauses is told). The keys are the window's
      // own reset and each person's own id.
      await until(
        "both people were told the window is nearly used up",
        async () => windowNotices(await it.read.noticeRows()).length >= 2,
        45_000,
        async () => JSON.stringify(await it.read.noticeRows()),
      );
      const said = windowNotices(await it.read.noticeRows());
      expect(said.length).toBe(2);
      expect(said.map((row) => String(row.notice_key)).sort()).toEqual(
        [
          `window-notice:${CREDENTIAL}:${staged.resetsAt}:${PERSON}`,
          `window-notice:${CREDENTIAL}:${staged.resetsAt}:${PERSON2}`,
        ].sort(),
      );
      for (const row of said) {
        expect((row as unknown as { body: string }).body).toBe(windowNotice(75));
      }
      // And the person whose agent is on a per-token key is NOT told, because
      // no window of theirs is nearly used up.
      expect(said.length).toBe(
        new Set(said.map((row) => (row as unknown as { person: string }).person)).size,
      );

      // A second turn at a higher utilisation says NOTHING more: the key is
      // the window's own reset, and utilisation ticking is not a new event.
      say(0.76);
      await plant(it, "w-human-5", "human");
      await until("the next turn was answered", () => answered(it, "w-human-5"), 45_000);
      await Bun.sleep(RETRY_SECONDS * 1000 + 1000);
      expect(windowNotices(await it.read.noticeRows()).length).toBe(2);
      // Rank-0 work still lands and rank 1 still waits.
      expect(await answered(it, "w-triage-2")).toBe(false);

      // --- stage 4, the hold. Nothing is claimed, rank 0 included.
      say(0.85);
      await plant(it, "w-human-6", "human");
      await until(
        "the reading past the hold threshold landed",
        () => answered(it, "w-human-6"),
        45_000,
      );
      await plant(it, "w-human-7", "human");
      await Bun.sleep(RETRY_SECONDS * 1000 + 3000);

      const held = await stateOf(it, "w-human-7");
      expect(held.state).toBe("received");
      expect(held.claimed_by).toBeNull();
      expect(await answered(it, "w-human-7")).toBe(false);
      // The outage is the same one, with its own cause.
      const sheet = await it.read.outageSheet();
      expect(sheet.length).toBe(1);
      expect(sheet[0].id).toBe(CREDENTIAL);
      expect(sheet[0].data.cause).toBe("window");
      // ONE OUTAGE NOTICE PER PERSON held by this credential, which is two:
      // the hold reaches both people's plan agents, so both are told, once
      // each, in the same words.
      await until(
        "both people were told the window is used up",
        async () =>
          (await it.read.noticeRows()).filter((row) =>
            String(row.notice_key).startsWith("outage:"),
          ).length >= 2,
        30_000,
        async () => JSON.stringify(await it.read.noticeRows()),
      );
      const outageNotices = (await it.read.noticeRows()).filter((row) =>
        String(row.notice_key).startsWith("outage:"),
      );
      expect(outageNotices.length).toBe(2);
      expect(outageNotices.map((row) => String(row.person)).sort()).toEqual(
        [PERSON, PERSON2].sort(),
      );
      for (const row of outageNotices) expect(row.body).toBe(OUTAGE_WINDOW_EN);
      // Zero chunks reference the held rows.
      const chunks = await it.read.outbox();
      expect(chunks.filter((row) => row.inbound_id === "w-human-7")).toEqual([]);
      // THE ONE A COPY-PASTE BUILD GETS WRONG: a window hold waits for the
      // window's own reset, not for the login outage's fixed interval.
      const retryAt = new Date(String(held.retry_at)).getTime();
      expect(Math.abs(retryAt - new Date(staged.resetsAt).getTime())).toBeLessThan(2000);
      expect(retryAt - Date.now()).toBeGreaterThan(RETRY_SECONDS * 1000 + 30_000);

      // --- THE HOUSEHOLD IS HELD, not the reporting person (the
      //     finding, and v2's own incident). The second person's agent is on
      //     the SAME plan preset and the same credential, on the OTHER runner,
      //     and its loop has never reported a window: the only reading in this
      //     household came from the first person's turn. A build that applied
      //     the reading to the reporting agent alone answers this row and
      //     fails here, and the person whose burn was invisible is the person
      //     who waits.
      await plant(it, "w-other-1", "human", AGENT2, PERSON2);
      await Bun.sleep(RETRY_SECONDS * 1000 + 3000);
      const otherHeld = await stateOf(it, "w-other-1");
      expect(otherHeld.state).toBe("received");
      expect(otherHeld.claimed_by).toBeNull();
      expect(await answered(it, "w-other-1")).toBe(false);
      // Both people were told, once each, and the second person's notice says
      // the same thing in their own language.
      expect(
        (await it.read.noticeRows()).filter(
          (row) => String(row.notice_key).startsWith("outage:") && row.person === PERSON2,
        ).length,
      ).toBe(1);

      // --- the key-preset control, read in the middle of the same hold: the
      //     first person's OTHER agent is on a per-token key, its loop reports
      //     no window, and it is not paused at any rank while the plan agents
      //     of both people are held. Without it a build that paused every
      //     agent of every person passes the half above.
      await plant(it, "w-key-1", "triage", AGENT_KEY, PERSON);
      await until(
        "the key agent's proactive row was answered during the hold",
        () => answered(it, "w-key-1"),
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );

      // --- stage 5, the release. A lower reading arrives, which is what a
      //     sibling runner's next turn writes into the household's one row.
      const owner = await superStore(cluster, it.db);
      try {
        const { putRow } = await seam("src/records/statesheet.ts");
        await (putRow as Function)(owner, "window", CREDENTIAL, {
          utilization: 0.1,
          resets_at: staged.resetsAt,
          at: new Date().toISOString(),
          reported_by: RUNNER_MAC,
        });
      } finally {
        await owner.close();
      }
      say(0.1);

      await until(
        "every held row was answered once the window came back, for both people",
        async () =>
          (await answered(it, "w-human-7")) &&
          (await answered(it, "w-triage-2")) &&
          (await answered(it, "w-other-1")) &&
          (await answered(it, "w-other-triage")),
        60_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      expect(await it.read.outageSheet()).toEqual([]);
      // One catch-up per person, which is two here, and one each.
      const over = (await it.read.noticeRows()).filter((row) =>
        String(row.notice_key).startsWith("outage-over:"),
      );
      expect(over.length).toBe(2);
      expect(over.map((row) => row.person).sort()).toEqual([PERSON, PERSON2]);
    } finally {
      if (pi) await pi.stop();
      if (mac) await mac.stop();
      await it.stop();
    }

    // --- THE RELEASE THE CONTRACT NAMES: the window's own reset arrives, the
    //     runner claims again, ITS OWN TURN reports a lower reading, and the
    //     hold goes. Nothing is planted into the household's row here (the
    // a reader called the planted stage a different path, and it is
    //     right: what production does is report through a turn). The stage
    //     above keeps the planted reading as its second case.
    const natural = await stageWindow(
      { pause: PAUSE_AT, notice: NOTICE_AT, hold: HOLD_AT },
      { resetsInMs: 6000 },
    );
    let pi3: { stop(): Promise<void> } | null = null;
    let mac3: { stop(): Promise<void> } | null = null;
    try {
      pi3 = await startRunner(natural, RUNNER_PI);
      mac3 = await startRunner(natural, RUNNER_MAC);
      // Arm the same six-second reset after setup, when the first turn can
      // actually report it. Database and runner startup are not this window.
      const reset = Date.now() + 6000;
      natural.resetsAt = new Date(reset).toISOString();
      natural.loops[RUNNER_PI].setWindow({
        utilization: 0.9,
        resets_at: natural.resetsAt,
      });

      // One turn carries the household past its hold threshold.
      await plant(natural.it, "n-human-1", "human");
      await until(
        "the reading past the hold threshold landed",
        () => answered(natural.it, "n-human-1"),
        45_000,
        async () => JSON.stringify(await natural.it.read.inbound()),
      );
      await until(
        "the hold was opened",
        async () => (await natural.it.read.outageSheet()).length === 1,
        30_000,
        async () => JSON.stringify(await natural.it.read.outageSheet()),
      );

      // Both people's plan agents now have work waiting, and both are held.
      await plant(natural.it, "n-held-1", "human");
      await plant(natural.it, "n-held-2", "human", AGENT2, PERSON2);
      await Bun.sleep(1000);
      expect(await answered(natural.it, "n-held-1")).toBe(false);
      expect(await answered(natural.it, "n-held-2")).toBe(false);

      // The loop's next reading is a low one. NOTHING writes the household's
      // row: the only way it can change is a turn, and the only way a turn can
      // happen is the reset arriving on the rows' own `retry_at`.
      natural.loops[RUNNER_PI].setWindow({
        utilization: 0.05,
        resets_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      natural.loops[RUNNER_MAC].setWindow({
        utilization: 0.05,
        resets_at: new Date(Date.now() + 3_600_000).toISOString(),
      });

      await until(
        "the reset arrived, a turn reported the lower reading and both held rows were answered",
        async () =>
          (await answered(natural.it, "n-held-1")) && (await answered(natural.it, "n-held-2")),
        60_000,
        async () =>
          `inbound=${JSON.stringify(await natural.it.read.inbound())} outage=${JSON.stringify(
            await natural.it.read.outageSheet(),
          )}`,
      );
      // Nothing was answered BEFORE the reset, so what released the hold is the
      // deadline the rows carried and not a tick that ignored it.
      const releasedAt = Date.now();
      expect(releasedAt).toBeGreaterThanOrEqual(reset);
      expect(await natural.it.read.outageSheet()).toEqual([]);
      const back = (await natural.it.read.noticeRows()).filter((row) =>
        String(row.notice_key).startsWith("outage-over:"),
      );
      expect(back.length).toBe(2);
      expect(back.map((row) => String(row.person)).sort()).toEqual([PERSON, PERSON2].sort());
    } finally {
      if (pi3) await pi3.stop();
      if (mac3) await mac3.stop();
      await natural.it.stop();
    }

    // --- THE PAIR THAT MAKES CRITERION 9 REAL. The same reading, a different
    //     file, a different behaviour. A build with 85, 95 and 100 in code
    //     answers this stage's rank-1 row too, and fails every stage above.
    const generous = await stageWindow({ pause: 85, notice: 95, hold: 100 });
    let pi2: { stop(): Promise<void> } | null = null;
    let mac2: { stop(): Promise<void> } | null = null;
    try {
      generous.loops[RUNNER_PI].setWindow({ utilization: 0.65, resets_at: generous.resetsAt });
      pi2 = await startRunner(generous, RUNNER_PI);
      mac2 = await startRunner(generous, RUNNER_MAC);
      await plant(generous.it, "g-human-1", "human");
      await until(
        "the reading landed on the second file",
        () => answered(generous.it, "g-human-1"),
        45_000,
      );
      await plant(generous.it, "g-triage-1", "triage");
      await until(
        "the proactive row was answered, because 65 is under this file's 85",
        () => answered(generous.it, "g-triage-1"),
        45_000,
        async () => JSON.stringify(await generous.it.read.inbound()),
      );
      expect(await generous.it.read.noticeRows()).toEqual([]);
    } finally {
      if (pi2) await pi2.stop();
      if (mac2) await mac2.stop();
      await generous.it.stop();
    }
  },
  SLOW,
);
