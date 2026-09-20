// Criterion 1. Every watermark is younger than its last quiet period plus the
// daily backstop, or a finding. And a household that has chosen no harvester at
// all is told so, loudly, rather than left wondering.
//
// L19's check line: "every chat log's watermark is younger than its last quiet
// period plus the daily backstop, or a finding". HARV-05's "defaults per model,
// set at install" needs a household that has installed nothing yet to be told,
// which is what the second finding does. SPEC §2's "a silent day is never a
// finding" is what the absent-log rule honours.
//
// Everything is planted and nothing is slept for: chat log files written by
// this check with chosen `at` values, watermark rows written through the
// superuser connection, and `runCheck` handed its own `now`, exactly as
// test/check-stamps.test.ts and test/check-silence.test.ts do it. The prober is
// `fakeProber` so no credential finding is reached.
//
// THE OLDEST UNHARVESTED LINE IS THE AGE, and never the newest.
// Under a newest-line rule a BUSY chat never fires at all, however
// long its watermark has been stuck, because its newest line is minutes old
// every day for ever. A busy chat whose backstop is broken is exactly the
// failure criterion 1 names, because the backstop is the thing that exists for
// chats that never go quiet.
//
// Every assertion here filters to `harvest-stale` and `harvest-undeclared`, so
// the credential and stamp findings the stage also produces break nothing. That
// is the discipline test/check-stamps.test.ts already follows.
//
// Red reason: import missing, `src/check/harvest.ts`. `runCheck` reports
// nothing about harvest at all.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import { fakeProber } from "./helpers/prober.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  chatLogFile,
  stageHub,
  superStore,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
import { writeRegistry, type PersonSpec } from "./helpers/registry.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listPeople } from "../src/registry/entries.ts";

let cluster: Cluster;

const SLOW = 90_000;

const RUNNER_PI = "runner-pi";
const RUNNER_MAC = "runner-mac";

/** A third and a fourth person, fixtures like every other id in this suite. */
const PERSON3 = "p3";
const PERSON4 = "p4";
const AGENT3 = "p3-lair";
const AGENT4 = "p4-lair";
/** Three more chats of the first person, one per non-case. */
const AGENT_EMPTY = "p1-empty";
const AGENT_DONE = "p1-done";
const AGENT_MACHINERY = "p1-machinery";

/**
 * THE HARVESTER'S OWN PRESET, which every registry below must define.
 *
 * THE FINDING: the people declare
 * `harvester = "harvest"` and the stage's default registry defines only
 * `daily`, so once the loader carries check 1's refusal 1 the whole file is
 * refused before `runCheck` can produce a single finding, and this check would
 * be red on a fixture rather than on the behaviour it names.
 */
const HARVEST_PRESET = {
  adapter: "a-loop",
  model: "a-stronger-model-name",
  provider: "a-provider",
  effort: "high",
  paid: "plan",
};

const MACHINES = [
  { id: "pi", os: "linux" },
  { id: "mac", os: "macos" },
];

/** The tests' own copy of a finding, for the reason test/helpers/finding.ts gives. */
interface Finding {
  id: string;
  kind: string;
  subject: string;
  machine: string;
  says: string;
  fix: string;
}

/**
 * The two people who name a harvester carry DIFFERENT quiet periods, so a build
 * reading one person's number for everybody fails. The third names none and the
 * fourth's agent is on another machine.
 */
function people(harvesterOnThird: boolean): PersonSpec[] {
  return [
    {
      id: PERSON,
      tree: "/var/lib/imprnt-hub/p1",
      language: "en",
      harvester: "harvest",
      vault: "/var/lib/imprnt-hub/p1/vault-project",
      harvest_quiet_minutes: 30,
    },
    {
      id: PERSON2,
      tree: "/var/lib/imprnt-hub/p2",
      language: "en",
      harvester: "harvest",
      vault: "/var/lib/imprnt-hub/p2/vault-project",
      harvest_quiet_minutes: 600,
    },
    {
      id: PERSON3,
      tree: "/var/lib/imprnt-hub/p3",
      language: "en",
      ...(harvesterOnThird
        ? {
            harvester: "harvest",
            vault: "/var/lib/imprnt-hub/p3/vault-project",
            harvest_quiet_minutes: 30,
          }
        : {}),
    },
    {
      id: PERSON4,
      tree: "/var/lib/imprnt-hub/p4",
      language: "en",
      harvester: "harvest",
      vault: "/var/lib/imprnt-hub/p4/vault-project",
      harvest_quiet_minutes: 30,
    },
  ];
}

const AGENTS = [
  { id: AGENT_EMPTY, person: PERSON, preset: "daily", chat: `${CHAT}1`, door: DOOR, runner: RUNNER_PI },
  { id: AGENT_DONE, person: PERSON, preset: "daily", chat: `${CHAT}2`, door: DOOR, runner: RUNNER_PI },
  { id: AGENT_MACHINERY, person: PERSON, preset: "daily", chat: `${CHAT}3`, door: DOOR, runner: RUNNER_PI },
  { id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}4`, door: DOOR, runner: RUNNER_PI },
  { id: AGENT3, person: PERSON3, preset: "daily", chat: `${CHAT}5`, door: DOOR, runner: RUNNER_PI },
  { id: AGENT4, person: PERSON4, preset: "daily", chat: `${CHAT}6`, door: DOOR, runner: RUNNER_MAC },
];

const RUN = [
  {
    id: DOOR,
    kind: "door",
    machine: "pi",
    platform: "fake",
    person: PERSON,
    token_file: "/dev/null",
    schedule: "always",
    memory_limit_mb: 192,
  },
  {
    id: RUNNER_PI,
    kind: "runner",
    machine: "pi",
    schedule: "always",
    memory_limit_mb: 512,
    child_memory_limit_mb: 512,
  },
  {
    id: RUNNER_MAC,
    kind: "runner",
    machine: "mac",
    schedule: "always",
    memory_limit_mb: 512,
    child_memory_limit_mb: 512,
  },
];

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** One chat line, written the way the door writes one. */
function plant(
  it: StagedHub,
  args: { person: string; agent: string; at: Date; from: string; direction: "in" | "out"; text: string },
): void {
  const file = chatLogFile({
    stateDir: it.stateDir,
    person: args.person,
    agent: args.agent,
    at: args.at,
  });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    JSON.stringify({
      at: args.at.toISOString(),
      direction: args.direction,
      from: args.from,
      text: args.text,
    }) + "\n",
    "utf8",
  );
}

/** A watermark row for one chat, written directly as the runner's settle would. */
async function plantWatermark(
  it: StagedHub,
  person: string,
  agent: string,
  at: Date,
): Promise<void> {
  await it.read.sql(
    `insert into state_row (sheet, id, data)
     values ('harvest', $1, $2::jsonb)
     on conflict (sheet, id) do update set data = excluded.data, updated_at = now()`,
    [
      `${person}/${agent}`,
      JSON.stringify({
        at: at.toISOString(),
        row: `harvest:${agent}:${at.toISOString()}`,
        harvested_at: at.toISOString(),
        notes: 1,
        lines: 1,
      }),
    ],
  );
}

function harvestOnly(findings: Finding[]): Finding[] {
  return findings.filter(
    (one) => one.kind === "harvest-stale" || one.kind === "harvest-undeclared",
  );
}

test(
  "criterion 1 a chat whose OLDEST unharvested line has outlived that person's own quiet period plus a day is a finding that clears when the watermark passes it, a person with an agent here who names no harvester is told exactly once, and a chat with no log, no unharvested line or only machinery is never a finding (SPEC §4 and §2, L19, D-160)",
  async () => {
    const { readHarvestState, harvestFindings } = await seam("src/check/harvest.ts");
    expect(typeof readHarvestState).toBe("function");
    expect(typeof harvestFindings).toBe("function");
    const { runCheck, CHECK_SHEET } = await seam("src/check/run.ts");

    const it = await stageHub(cluster, {
      machines: MACHINES,
      people: people(false),
      agents: AGENTS,
      run: RUN,
      registry: (base) => ({
        ...base,
        presets: {
          ...(base.presets ?? {}),
          harvest: { ...HARVEST_PRESET, adapter: base.presets?.daily?.adapter as string },
        },
        agents: (base.agents ?? []).map((agent) =>
          agent.id === AGENT ? { ...agent, runner: RUNNER_PI } : agent,
        ),
      }),
    });

    try {
      // THE FILE ITSELF LOADS, asserted before a single finding is asked for.
      // Every person below names `harvester = "harvest"`, and a registry that
      // did not define that preset would be refused by check 1's own loader,
      // which would make this check red on a fixture rather than on the
      // behaviour it names.
      expect(listPeople(loadRegistry(it.registryFile)).length).toBe(4);

      const now = new Date();
      const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
      const store = await superStore(cluster, it.db);
      const prober = fakeProber({});
      const ask = async (at: Date = now): Promise<Finding[]> =>
        harvestOnly(
          (await (runCheck as Function)({
            machine: "pi",
            registryFile: it.registryFile,
            store,
            os: null,
            kernel: null,
            credentials: prober,
            now: at,
          })) as Finding[],
        );

      // p1's allowance is 30 minutes plus a day = 88200 s. p2's is 600 minutes
      // plus a day = 122400 s. Both numbers are computed here from the file's
      // own values so an off-by-one in the build has somewhere to fail.
      const P1_ALLOWANCE = 30 * 60 + 86400;
      const P2_ALLOWANCE = 600 * 60 + 86400;

      // --- p1's chat: three person lines, the oldest one minute PAST the
      //     allowance, and a watermark before all of them.
      const p1Oldest = ago(P1_ALLOWANCE + 60);
      plant(it, { person: PERSON, agent: AGENT, at: p1Oldest, from: PERSON, direction: "in", text: "the dentist moved it" });
      plant(it, { person: PERSON, agent: AGENT, at: ago(P1_ALLOWANCE - 600), from: AGENT, direction: "out", text: "noted" });
      plant(it, { person: PERSON, agent: AGENT, at: ago(300), from: PERSON, direction: "in", text: "and the gym is cancelled" });
      await plantWatermark(it, PERSON, AGENT, ago(P1_ALLOWANCE + 3600));

      // --- p2's chat: a BUSY one. A line four days old and a line one minute
      //     old, with a watermark before both.
      plant(it, { person: PERSON2, agent: AGENT2, at: ago(4 * 86400), from: PERSON2, direction: "in", text: "the lease renews in March" });
      plant(it, { person: PERSON2, agent: AGENT2, at: ago(60), from: PERSON2, direction: "in", text: "what is for dinner" });
      await plantWatermark(it, PERSON2, AGENT2, ago(5 * 86400));

      // --- p3's chat: three ANCIENT unharvested lines and no harvester named.
      for (const back of [10 * 86400, 9 * 86400, 8 * 86400]) {
        plant(it, { person: PERSON3, agent: AGENT3, at: ago(back), from: PERSON3, direction: "in", text: "something worth keeping" });
      }

      // --- p4's chat, on ANOTHER machine's runner, equally ancient.
      plant(it, { person: PERSON4, agent: AGENT4, at: ago(10 * 86400), from: PERSON4, direction: "in", text: "also worth keeping" });

      // --- the three non-cases.
      //     `p1-empty` gets NO log directory at all.
      plant(it, { person: PERSON, agent: AGENT_DONE, at: ago(10 * 86400), from: PERSON, direction: "in", text: "long ago and harvested" });
      await plantWatermark(it, PERSON, AGENT_DONE, ago(9 * 86400));
      for (const back of [10 * 86400, 9 * 86400]) {
        plant(it, {
          person: PERSON,
          agent: AGENT_MACHINERY,
          at: ago(back),
          from: DOOR,
          direction: "out",
          text: "[door] still waiting: the loop has not accepted this message. 45 s so far.",
        });
      }
      await plantWatermark(it, PERSON, AGENT_MACHINERY, ago(11 * 86400));

      // -----------------------------------------------------------------
      // The first run.
      // -----------------------------------------------------------------
      const first = await ask();
      const stale = first.filter((one) => one.kind === "harvest-stale");
      const undeclared = first.filter((one) => one.kind === "harvest-undeclared");

      // --- 1. it FIRES for p1, with the pinned id and a line that says what a
      //     household needs to act.
      const p1Finding = stale.find((one) => one.subject === `${PERSON}/${AGENT}`)!;
      expect(p1Finding).toBeDefined();
      expect(p1Finding.id).toBe(`pi/harvest-stale:${PERSON}/${AGENT}`);
      expect(p1Finding.machine).toBe("pi");
      expect(p1Finding.says).toContain(PERSON);
      expect(p1Finding.says).toContain(AGENT);
      // Three lines are waiting, which is what a harvest would take.
      expect(p1Finding.says).toContain("3");
      // The DOOR's unit, because the door is what writes a harvest row.
      expect(p1Finding.fix).toContain(`imprnt-hub-${DOOR}`);
      expect(p1Finding.fix).toContain(AGENT);

      // --- 3. THE BUSY CHAT. p2's newest line is a minute old and its oldest
      //     unharvested one is four days old, which is past ten hours plus a
      //     day. A build reading the NEWEST line passes case 1 and fails here.
      expect(4 * 86400).toBeGreaterThan(P2_ALLOWANCE);
      expect(stale.some((one) => one.subject === `${PERSON2}/${AGENT2}`)).toBe(true);

      // --- 6, 7, 8. The three non-cases.
      expect(stale.some((one) => one.subject === `${PERSON}/${AGENT_EMPTY}`)).toBe(false);
      expect(stale.some((one) => one.subject === `${PERSON}/${AGENT_DONE}`)).toBe(false);
      expect(stale.some((one) => one.subject === `${PERSON}/${AGENT_MACHINERY}`)).toBe(false);

      // --- 9. `harvest-undeclared` fires for the third person.
      const p3Finding = undeclared.find((one) => one.subject === PERSON3)!;
      expect(p3Finding).toBeDefined();
      expect(p3Finding.id).toBe(`pi/harvest-undeclared:${PERSON3}`);
      expect(p3Finding.says).toContain(PERSON3);
      expect(p3Finding.fix).toContain("harvester");
      expect(p3Finding.fix).toContain("vault");
      expect(p3Finding.fix).toContain(it.registryFile);

      // --- 10. and NOT for the two who named one.
      expect(undeclared.some((one) => one.subject === PERSON)).toBe(false);
      expect(undeclared.some((one) => one.subject === PERSON2)).toBe(false);

      // --- 11. and NOT for the fourth, whose agent is on another machine's
      //     runner, so two machines running `check` do not both report one
      //     person.
      expect(undeclared.some((one) => one.subject === PERSON4)).toBe(false);
      expect(stale.some((one) => one.subject === `${PERSON4}/${AGENT4}`)).toBe(false);

      // --- 12. a person with no harvester gets `harvest-undeclared` and NEVER
      //     `harvest-stale`, though their chat holds three ancient unharvested
      //     lines. Two findings saying one thing is noise and the household can
      //     act on only one of them.
      expect(stale.some((one) => one.subject === `${PERSON3}/${AGENT3}`)).toBe(false);
      expect(undeclared.length).toBe(1);

      // --- 13. both are on the `check` sheet with their ids, which is
      //     test/check-sheet.test.ts's own property asserted here in miniature
      //     over the two new kinds.
      const sheet = (await it.read.sheet(CHECK_SHEET as string)) as {
        id: string;
        data: Record<string, unknown>;
      }[];
      const onSheet = new Set(sheet.map((row) => row.id));
      for (const one of first) expect(onSheet.has(one.id)).toBe(true);

      // -----------------------------------------------------------------
      // 2. The pair that makes the threshold real: one minute INSIDE the
      //    allowance is no finding. The watermark moves to just after p1's
      //    oldest line, so the oldest unharvested one is now the middle line.
      // -----------------------------------------------------------------
      await plantWatermark(it, PERSON, AGENT, ago(P1_ALLOWANCE - 61));
      const inside = await ask();
      expect(
        inside.filter((one) => one.kind === "harvest-stale").some((one) => one.subject === `${PERSON}/${AGENT}`),
      ).toBe(false);

      // -----------------------------------------------------------------
      // 4. THE PERSON'S OWN QUIET PERIOD. One age, two people, two answers.
      //    An age between the two allowances fires for p1 and not for p2.
      // -----------------------------------------------------------------
      const between = Math.floor((P1_ALLOWANCE + P2_ALLOWANCE) / 2);
      expect(between).toBeGreaterThan(P1_ALLOWANCE);
      expect(between).toBeLessThan(P2_ALLOWANCE);
      await plantWatermark(it, PERSON, AGENT, ago(between + 120));
      await plantWatermark(it, PERSON2, AGENT2, ago(between + 120));
      plant(it, { person: PERSON, agent: AGENT, at: ago(between), from: PERSON, direction: "in", text: "one age" });
      plant(it, { person: PERSON2, agent: AGENT2, at: ago(between), from: PERSON2, direction: "in", text: "one age" });
      const twoAnswers = (await ask()).filter((one) => one.kind === "harvest-stale");
      expect(twoAnswers.some((one) => one.subject === `${PERSON}/${AGENT}`)).toBe(true);
      expect(twoAnswers.some((one) => one.subject === `${PERSON2}/${AGENT2}`)).toBe(false);

      // -----------------------------------------------------------------
      // 5. IT CLEARS. The watermark passes every line, and the finding is gone
      //    from the returned set AND its row is gone from the sheet, swept by
      //    the machinery `runCheck` already runs.
      // -----------------------------------------------------------------
      const staleId = `pi/harvest-stale:${PERSON}/${AGENT}`;
      await plantWatermark(it, PERSON, AGENT, now);
      const cleared = await ask();
      expect(cleared.some((one) => one.id === staleId)).toBe(false);
      const afterSheet = (await it.read.sheet(CHECK_SHEET as string)) as { id: string }[];
      expect(afterSheet.some((row) => row.id === staleId)).toBe(false);

      // -----------------------------------------------------------------
      // The control: every watermark current and every person naming a
      // harvester produces NEITHER kind. A build that reported every chat
      // passes cases 1, 3 and 9 and fails this.
      // -----------------------------------------------------------------
      writeRegistry(it.stateDir, {
        hub: { store_url: it.storeUrl, state_dir: it.stateDir, tick_seconds: 5 },
        machines: MACHINES,
        people: people(true),
        presets: {
          daily: {
            adapter: it.adapterName,
            model: "a-model-name",
            provider: "a-provider",
            effort: "medium",
            paid: "plan",
          },
          harvest: { ...HARVEST_PRESET, adapter: it.adapterName },
        },
        agents: [
          { id: AGENT, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: RUNNER_PI },
          ...AGENTS,
        ],
        run: RUN,
      });
      for (const [person, agent] of [
        [PERSON, AGENT],
        [PERSON, AGENT_DONE],
        [PERSON, AGENT_MACHINERY],
        [PERSON2, AGENT2],
        [PERSON3, AGENT3],
      ] as [string, string][]) {
        await plantWatermark(it, person, agent, now);
      }
      expect(listPeople(loadRegistry(it.registryFile)).length).toBe(4);
      expect(await ask()).toEqual([]);
    } finally {
      await it.stop();
    }
  },
  SLOW,
);
