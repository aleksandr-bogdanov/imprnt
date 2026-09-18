// HARV-03 and HARV-05. The door learns when a chat is worth harvesting, and it
// writes ONE row per harvest through the one table it owns.
//
// SPEC §4's three triggers: "the chat goes quiet (no message for N minutes) and
// the slice since the watermark is at least the minimum size; the daily
// backstop over yesterday for chats that never went quiet, where small slices
// merge into one turn; and on demand." SPEC §2: the door writes `inbound` and
// nobody else does. SPEC §1's Forbidden: "polling where a notification exists",
// which is why the quiet clock is a deadline the door holds and not a query it
// repeats. L19, L1.
//
// NO CHECK HERE WAITS OUT A REAL QUIET PERIOD AND NONE WAITS FOR MIDNIGHT. Every
// chat line is planted with a chosen `at` IN THE PAST, so the deadline the door
// derives from it has already expired when the door's first pass runs, and the
// row appears within a tick. The clock is real, the arithmetic is real, and
// only the planted times are this file's.
//
// The cluster is started with statement logging, because check 6 opens a
// zero-statement window of its own over an idle door. That window is what
// test/door-typing.test.ts would otherwise make for the fourth task by
// accident, and making it here means a build that reads the watermark on every
// pass fails in the plan that introduced the task.
//
// Red reasons: check 6 is import missing, `src/harvest/row.ts`, reached through
// `src/door/run.ts`. Check 7's tag is behaviour absent and what it OBSERVES is
// import missing, for the same reason: `src/harvest/row.ts` carries the pure
// midnight arithmetic its first half binds and the module is not on disk this
// round. Check 8 is behaviour absent: `src/door/run.ts`'s `read` enqueues every
// pulled message as a human row and nothing anywhere compares a text to a
// phrase.

import { writeRegistry, stageHub } from "./helpers/authorized-registry.ts";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  foreignBackends,
  seam,
  startCluster,
  startReadySubprocess,
  statementWatch,
  until,
  type Cluster,
  type ReadyProcess,
} from "./helpers/cluster.ts";
import { cpuSeconds } from "./helpers/cpu.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  RUNNER,
  chatLogFile,
  chatLogLines,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
import { type PersonSpec, type PresetSpec } from "./helpers/registry.ts";
import {
  announceClock,
  clockGate,
  clockSuffix,
} from "./helpers/clock-gate.ts";

let cluster: Cluster;

const SLOW = 120_000;
/** Short, so a pass happens inside every bound below. */
const TICK_SECONDS = 2;
/** The processor-time bound and window, the same pair test/wait-idle.test.ts uses. */
const CPU_WINDOW_MS = 3_000;
const CPU_BOUND_SECONDS = 0.3;

/** The tests' own copy of a harvest row's body, never imported from the build. */
interface HarvestBody {
  from: string | null;
  until: string;
  reason: string;
  lines: number;
  said?: string;
}

/** The harvester preset, beside the agent's `daily`, in every stage below. */
const HARVEST_PRESET: PresetSpec = {
  adapter: "a-loop",
  model: "a-stronger-model-name",
  provider: "a-provider",
  effort: "high",
  paid: "plan",
};

beforeAll(async () => {
  cluster = await startCluster({
    settings: {
      log_statement: "'all'",
      log_line_prefix: "'pid=%p '",
      log_min_duration_statement: "-1",
    },
  });
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** One chat line, written the way the door writes one. */
function plant(
  it: StagedHub,
  args: {
    at: Date;
    text: string;
    person?: string;
    agent?: string;
    from?: string;
    direction?: "in" | "out";
  },
): void {
  const person = args.person ?? PERSON;
  const agent = args.agent ?? AGENT;
  const file = chatLogFile({ stateDir: it.stateDir, person, agent, at: args.at });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    JSON.stringify({
      at: args.at.toISOString(),
      direction: args.direction ?? "in",
      from: args.from ?? person,
      text: args.text,
    }) + "\n",
    "utf8",
  );
}

// THE CLOCK GATES, one per check, asked ONCE at module load so a test name can
// carry its own reason. Each number is that check's own need: the age of the
// oldest line it plants plus the wall time it takes, so the whole of it runs
// inside one UTC day.
//
// Check 6 plants three minutes back and takes about a minute of bounded waits
// plus a three second processor window, so eight. Check 7 plants TWO DAYS back
// on purpose (that is what a backstop is) and needs only its own running time
// on this side of a midnight, so two. Check 8 plants five minutes back and
// delivers ten near misses at a two second tick, so ten.
const GATE_6 = clockGate(8);
const GATE_7 = clockGate(2);
const GATE_8 = clockGate(10);
announceClock(GATE_6, "check 6, the quiet trigger and its two windows");
announceClock(GATE_7, "check 7, the daily backstop");
announceClock(GATE_8, "check 8, the demand phrase");

/**
 * The store backends this door holds right now, by pid.
 *
 * A door that reloaded its configuration by EXITING and being restarted opens
 * new connections, so the set of pids changes. A door that re-read the file on
 * its own tick keeps them. That is a measurement of the process, which is what
 * RUN-09's "a routine operation never restarts a process" is about, and what a
 * comparison of a test's own handle variable against its own saved copy is not.
 */
async function doorBackends(it: StagedHub): Promise<number[]> {
  return (
    (await it.read.sql(
      `select pid from pg_stat_activity
        where datname = current_database()
          and usename = 'hub_door'
          and backend_type = 'client backend'
        order by pid`,
    )) as { pid: number }[]
  ).map((row) => Number(row.pid));
}

/** Every `harvest` row on the table right now, oldest first. */
async function harvestRows(it: StagedHub): Promise<Record<string, unknown>[]> {
  return (await it.read.sql(
    `select id, person, agent, kind, body, rank, state, received_at
       from inbound where kind = 'harvest' order by received_at, id`,
  )) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Check 6.
// ---------------------------------------------------------------------------

test.skipIf(!GATE_6.ok)(
  "HARV-03 and HARV-05 a quiet chat with enough to say gets one harvest row with its bounds fixed, a quiet chat with too little waits, the registry is what says how long and how much with nothing restarted, and an expired deadline that fired nothing is not a hot loop (SPEC §4 and §1, L19, D-142, D-144, D-145, D-161)" + clockSuffix(GATE_6),
  async () => {
    const { harvestRowId, decodeHarvestBody } = await seam("src/harvest/row.ts");
    expect(typeof harvestRowId).toBe("function");
    expect(typeof decodeHarvestBody).toBe("function");
    const rowIdOf = harvestRowId as (agent: string, until: string) => string;
    const bodyOf = decodeHarvestBody as (body: string) => HarvestBody;
    const { runDoor } = await seam("src/door/run.ts");

    const it = await stageHub(cluster, {
      hub: { tick_seconds: TICK_SECONDS },
      imprnt: "imprnt",
      harvest: {
        harvester: "harvest",
        vault: "/var/lib/imprnt-hub/p1/vault-project",
        quiet_minutes: 2,
        min_messages: 3,
      },
      registry: (base) => ({
        ...base,
        presets: { ...(base.presets ?? {}), harvest: HARVEST_PRESET },
      }),
    });
    let handle: { stop(): Promise<void> } | null = null;
    let subprocess: ReadyProcess | null = null;
    let clocks: StagedHub | null = null;
    let clocksDoor: { stop(): Promise<void> } | null = null;
    let quiet: StagedHub | null = null;
    let control: StagedHub | null = null;
    let controlDoor: { stop(): Promise<void> } | null = null;
    try {
      const now = Date.now();
      const ago = (minutes: number) => new Date(now - minutes * 60_000);
      // NO RUNNER IS STARTED. This check is about the door alone, and a runner
      // would claim the row and change what is on the table while the check is
      // reading it.

      // ---------------------------------------------------------------
      // THE ORDER OF THESE STAGES IS THE FIXTURE'S WHOLE CORRECTNESS, and the
      // second seat found the first version had it wrong.
      //
      // D-145 sets the door's in-memory `bound` to the `until` of whatever it
      // last fired, and a quiet trigger's `until` is `now`. So the moment a row
      // is written, every line already on disk is BEHIND the bound and counts
      // towards nothing. A stage that fired first and then planted older lines
      // expecting a second row was asking a correct door to break its own rule.
      // D-145 states that case outright and calls it right: "a bound ahead of a
      // stuck watermark is correct and is left alone."
      //
      // So the registry edit is exercised BEFORE anything fires, while the
      // bound is still null, and the watermark stage runs against a door that
      // has been RESTARTED, because a door arms its bound from the sheet at
      // connect (D-144) and that is the honest way to put a bound behind a
      // planted line without waiting out a real quiet period.
      // ---------------------------------------------------------------

      // ---------------------------------------------------------------
      // Stage 1: TOO LITTLE TO SAY, on its own and asserted first, so a door
      // that harvests everything fails here before any other stage runs. Two
      // person lines five minutes ago against a two minute quiet period, so the
      // deadline expired three minutes ago, and the count is two against a
      // minimum of three.
      //
      // A DOOR LINE IS PLANTED BESIDE THEM. Counting it would make three, so a
      // build whose count includes machinery fires here and fails.
      // ---------------------------------------------------------------
      // THE MINIMUM NEVER CHANGES. The second seat's finding: with the quiet
      // period and the minimum edited together, a door that reloads the MINIMUM
      // and keeps the timeout it started with produces exactly the sequence the
      // check wanted, and never applies the edited timeout at all. So the
      // minimum is pinned at what the stage declared and only
      // `harvest_quiet_minutes` moves.
      const MIN_MESSAGES = 3;
      const rewrite = (quietMinutes: number, minMessages = MIN_MESSAGES): void => {
        const person: PersonSpec = {
          id: PERSON,
          harvester: "harvest",
          vault: "/var/lib/imprnt-hub/p1/vault-project",
          harvest_quiet_minutes: quietMinutes,
          harvest_min_messages: minMessages,
        };
        writeRegistry(it.stateDir, {
          hub: {
            store_url: it.storeUrl,
            state_dir: it.stateDir,
            tick_seconds: TICK_SECONDS,
            imprnt: "imprnt",
          },
          people: [person],
          presets: {
            daily: {
              adapter: it.adapterName,
              model: "a-model-name",
              provider: "a-provider",
              effort: "medium",
              paid: "plan",
            },
            harvest: HARVEST_PRESET,
          },
          agents: [
            { id: AGENT, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: RUNNER },
          ],
        });
      };

      plant(it, { at: ago(5), text: "the dentist moved it to Thursday" });
      plant(it, { at: ago(5), text: "and the gym membership is cancelled" });
      plant(it, {
        at: ago(5),
        direction: "out",
        from: DOOR,
        text: "[door] still waiting: the loop has not accepted this message. 45 s so far.",
      });

      handle = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      await Bun.sleep(TICK_SECONDS * 2 * 1000 + 500);
      expect(await harvestRows(it)).toEqual([]);

      // ---------------------------------------------------------------
      // Stage 2: THE QUIET TIMEOUT IS EDITED ALONE, and it is what gates the
      // firing. SPEC section 4's Forbidden "a harvest cost that cannot be
      // changed in the registry", made a behaviour that only the timeout can
      // satisfy.
      //
      // The minimum stays at three throughout. The third line makes the count
      // three, so from here the ONLY thing holding the row back is the quiet
      // period, and it is moved to ten hours before the line is planted and
      // back to two minutes afterwards. A door that reloads the minimum and
      // keeps the two minute timeout it started with fires during the ten hour
      // window and fails the assertion below.
      // ---------------------------------------------------------------
      const backendsBefore = await doorBackends(it);
      expect(backendsBefore.length).toBeGreaterThan(0);

      rewrite(600);
      await Bun.sleep(TICK_SECONDS * 1000 + 500);
      plant(it, { at: ago(5), text: "the wifi password is on the router" });
      await Bun.sleep(TICK_SECONDS * 2 * 1000 + 500);
      // Five minutes is not ten hours.
      expect(await harvestRows(it)).toEqual([]);

      rewrite(2);
      await until(
        "the edited quiet timeout produced the first harvest row",
        async () => (await harvestRows(it)).length === 1,
        TICK_SECONDS * 8 * 1000,
        async () => JSON.stringify(await it.read.inbound()),
      );

      // THE DOOR NEVER RESTARTED, measured on the PROCESS and not on a test
      // variable. The old `expect(handle).toBe(started)` compared a local to
      // its own saved copy and could not have failed, which the second seat
      // called a tautology and it was right. A door that reloaded by exiting
      // and being restarted opens new connections to the store, so the set of
      // backend pids it holds is what says the process is the one that started.
      expect(await doorBackends(it)).toEqual(backendsBefore);

      // ---------------------------------------------------------------
      // Stage 3: the row this edit produced, read whole.
      // ---------------------------------------------------------------
      const [row] = await harvestRows(it);
      // 1. one row, at rank 1, which the schema generates from the kind.
      expect(Number(row.rank)).toBe(1);
      // 3. its body, decoded. `from` is null because nothing has been
      //    harvested yet, and `lines` is THREE rather than the four lines in
      //    the file, because the door line is not a line a harvest takes.
      const body = bodyOf(String(row.body));
      expect(body.from).toBeNull();
      expect(body.reason).toBe("quiet");
      expect(body.lines).toBe(3);
      expect(typeof body.until).toBe("string");
      // 2. its id, computed by the TEST from the pinned shape.
      expect(row.id).toBe(rowIdOf(AGENT, body.until));
      expect(String(row.id).startsWith(`harvest:${AGENT}:`)).toBe(true);
      // 4. its person, its agent, its state and the stamp `enqueueInbound`
      //    writes inside the caller's own transaction.
      expect(row.person).toBe(PERSON);
      expect(row.agent).toBe(AGENT);
      expect(row.state).toBe("received");
      const stamps = await it.read.ledger({ stream: "inbound", subject: String(row.id) });
      expect(stamps.map((one) => one.kind)).toEqual(["received"]);
      expect(stamps[0].actor).toBe("door");

      // 5. THE BOUNDS ARE FIXED at the moment the row was written. A line that
      //    arrives after it belongs to the NEXT harvest, and the row already on
      //    the table is not edited to take it in.
      plant(it, { at: ago(3), text: "and the car is booked in for Friday" });
      await Bun.sleep(TICK_SECONDS * 2 * 1000 + 500);
      const [unchanged] = await harvestRows(it);
      expect(unchanged.body).toBe(row.body);
      // And no SECOND row either, which is the mirror case D-145 names and
      // calls correct: the line is behind the bound the first firing set, so
      // the door leaves it to the harvest that row already covers.
      expect((await harvestRows(it)).length).toBe(1);

      // ---------------------------------------------------------------
      // Stage 4: THE WATERMARK IS WHAT `from` COMES FROM, once one exists.
      // D-145: on firing, take `from` from the sheet and never from the cached
      // bound.
      //
      // THE DOOR IS RESTARTED ON PURPOSE HERE, and it is the only restart in
      // this check. A door arms its in-memory bound from the watermark at
      // connect (D-144), so a restart is what puts the bound behind a line that
      // is already on disk without waiting out a real quiet period. Stage 2's
      // no-restart assertion is already made and is not weakened by it.
      // ---------------------------------------------------------------
      if (handle) await handle.stop();
      handle = null;

      // Between the three lines of stage 2 (five minutes back) and the one line
      // of stage 3 (three minutes back), so the restarted door's bound leaves
      // exactly one line in range. That line is three minutes old against a two
      // minute quiet period, so the deadline has passed and the pass fires at
      // once rather than waiting anything out.
      const watermarkAt = new Date(now - 4 * 60_000).toISOString();
      await it.read.sql(
        `insert into state_row (sheet, id, data)
         values ('harvest', $1, $2::jsonb)
         on conflict (sheet, id) do update set data = excluded.data`,
        [
          `${PERSON}/${AGENT}`,
          JSON.stringify({
            at: watermarkAt,
            row: String(row.id),
            harvested_at: watermarkAt,
            notes: 1,
            lines: 3,
          }),
        ],
      );

      handle = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      await until(
        "the restarted door wrote a harvest row whose from is the watermark",
        async () => (await harvestRows(it)).length === 2,
        TICK_SECONDS * 8 * 1000,
        async () => JSON.stringify(await harvestRows(it)),
      );
      const third = bodyOf(String((await harvestRows(it))[1].body));
      expect(third.from).toBe(watermarkAt);
      expect(third.reason).toBe("quiet");
      // Only the ONE line after the watermark: the three-minute-old line
      // planted in stage 3. Everything older is behind it.
      expect(third.lines).toBe(1);

      // ---------------------------------------------------------------
      // Stage 5: WHAT RE-ARMS THE QUIET CLOCK AND WHAT DOES NOT.
      //
      // The second seat's finding on D, and it is right: every stage above
      // plants person lines, so a door that derived quietness from what the
      // PERSON said and ignored the agent would pass all of them. The helper
      // check binds `newestLine`, and nothing bound the door's own wiring.
      //
      // Two chats in one hub, a two minute quiet period and a minimum of one,
      // each holding a person line five minutes back and one newer line at the
      // moment the door starts:
      //   the first chat's newer line is the DOOR's, and machinery must not
      //   extend a quiet period, so the chat is quiet and a row is owed,
      //   the second chat's newer line is the AGENT's, and an agent line is
      //   half of a conversation, so the chat is NOT quiet and no row is owed.
      // A door reading only person lines fires in both. A door counting every
      // line fires in neither. Only the rule fires in exactly one.
      // ---------------------------------------------------------------
      clocks = await stageHub(cluster, {
        hub: { tick_seconds: TICK_SECONDS },
        people: [
          {
            id: PERSON,
            harvester: "harvest",
            vault: "/var/lib/imprnt-hub/p1/vault-project",
            harvest_quiet_minutes: 2,
            harvest_min_messages: 1,
          },
        ],
        agents: [
          { id: AGENT2, person: PERSON, preset: "daily", chat: `${CHAT}2`, door: DOOR, runner: RUNNER },
        ],
        registry: (base) => ({
          ...base,
          presets: { ...(base.presets ?? {}), harvest: HARVEST_PRESET },
        }),
      });
      plant(clocks, { at: ago(5), text: "the boiler service is booked" });
      plant(clocks, {
        at: new Date(Date.now()),
        direction: "out",
        from: DOOR,
        text: "[door] still waiting: the turn has not ended. 90 s so far.",
      });
      plant(clocks, { agent: AGENT2, at: ago(5), text: "and the lease renews in March" });
      plant(clocks, {
        agent: AGENT2,
        at: new Date(Date.now()),
        direction: "out",
        from: AGENT2,
        text: "noted, March it is",
      });

      clocksDoor = await (runDoor as Function)({
        door: DOOR,
        registryFile: clocks.registryFile,
        platform: clocks.fake.platform,
      });
      await until(
        "the chat whose newest line is MACHINERY was harvested",
        async () => (await harvestRows(clocks!)).some((one) => one.agent === AGENT),
        TICK_SECONDS * 8 * 1000,
        async () => JSON.stringify(await harvestRows(clocks!)),
      );
      // And the chat whose newest line is the AGENT'S was not, because an agent
      // line is a line in the conversation and it re-armed the clock.
      await Bun.sleep(TICK_SECONDS * 2 * 1000);
      expect((await harvestRows(clocks)).some((one) => one.agent === AGENT2)).toBe(false);

      // ---------------------------------------------------------------
      // Window (i): ZERO STATEMENTS over an idle door.
      //
      // The registry goes back to a thirty minute quiet period with nothing
      // due, and no statement may be issued by any backend that is not this
      // check's own. That is the assertion test/door-typing.test.ts would
      // otherwise make for this task by accident, and making it here means a
      // build that reads the watermark on every pass fails in the plan that
      // introduced the task rather than in a phase 4 check whose name says
      // nothing about harvest.
      // ---------------------------------------------------------------
      rewrite(30, 99);  // both, deliberately: this window wants nothing due at all
      await Bun.sleep(TICK_SECONDS * 1000 + 500);
      const mine = [await it.read.pid()];
      const watch = await statementWatch(cluster, mine);
      const before = await watch.count();
      await Bun.sleep(TICK_SECONDS * 3 * 1000);
      const issued = await watch.count();
      expect(issued - before).toBe(0);
      // And the door really was there to be quiet, rather than gone.
      expect(
        (await foreignBackends(cluster, it.db, mine)).length,
      ).toBeGreaterThan(0);

      if (handle) await handle.stop();
      handle = null;

      // ---------------------------------------------------------------
      // Window (ii): NOT A HOT LOOP, over an EXPIRED deadline that fired
      // nothing. THIS IS THE ASSERTION NOTHING ELSE IN THE SUITE CAN MAKE.
      //
      // D-144 says why. A builder copying `attend`'s bound
      // (`Math.max(0, due - Date.now())`) gets zero for a deadline that has
      // already passed, so the task re-passes continuously, reading two FILES
      // at a time and issuing NO statement. Window (i) above passes it,
      // test/door-typing.test.ts passes it, and test/wait-idle.test.ts never
      // reaches it because its own stage declares no harvester and the task
      // sleeps a tick there.
      //
      // The rule that makes this pass is D-144's: a quiet deadline contributes
      // to the bound only while it is in the FUTURE, and once it has passed
      // with nothing fired the next wake is the tick. Nothing is counted
      // inside production code for it. The processor time is the external
      // signal, which is exactly the argument test/wait-idle.test.ts was
      // written on, and the busy control beside it is what proves the reader
      // can see a spin at all.
      // ---------------------------------------------------------------
      quiet = await stageHub(cluster, {
        servers: true,
        hub: { tick_seconds: TICK_SECONDS },
        harvest: {
          harvester: "harvest",
          vault: "/var/lib/imprnt-hub/p1/vault-project",
          quiet_minutes: 1,
          min_messages: 3,
        },
        registry: (base) => ({
          ...base,
          presets: { ...(base.presets ?? {}), harvest: HARVEST_PRESET },
        }),
      });
      plant(quiet, { at: ago(3), text: "the dentist moved it to Thursday" });
      plant(quiet, { at: ago(3), text: "and the gym membership is cancelled" });

      const busy = Bun.spawn(
        [
          process.execPath,
          "-e",
          "setInterval(() => { let s = 0; for (let i = 0; i < 6e7; i++) s += i; globalThis.__sink = s; }, 100); setInterval(() => {}, 1e9);",
        ],
        { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
      );
      try {
        subprocess = await startReadySubprocess("test/helpers/door-subprocess.ts", [
          quiet.registryFile,
          DOOR,
          quiet.platformUrl,
        ]);
        // A beat, so the window holds the waiting and not the connect.
        await Bun.sleep(TICK_SECONDS * 1000 + 500);
        const cpuBefore = { door: cpuSeconds(subprocess.pid), busy: cpuSeconds(busy.pid) };
        expect(cpuBefore.door).not.toBeNull();
        expect(cpuBefore.busy).not.toBeNull();
        await Bun.sleep(CPU_WINDOW_MS);
        const cpuAfter = { door: cpuSeconds(subprocess.pid), busy: cpuSeconds(busy.pid) };
        expect(cpuAfter.door).not.toBeNull();
        expect(cpuAfter.busy).not.toBeNull();
        // THE CONTROL FIRST, so a broken probe fails here rather than
        // reporting a beautifully quiet door it cannot actually read.
        expect(cpuAfter.busy! - cpuBefore.busy!).toBeGreaterThan(CPU_BOUND_SECONDS);
        expect(cpuAfter.door! - cpuBefore.door!).toBeLessThan(CPU_BOUND_SECONDS);
        // And nothing fired in all that time, which is the state the bound is
        // about: the deadline passed and the count is still under the minimum.
        expect(await harvestRows(quiet)).toEqual([]);
      } finally {
        busy.kill(9);
        await busy.exited.catch(() => {});
      }

      // ---------------------------------------------------------------
      // The control: a stage whose person names NO harvester produces no
      // harvest row ever, however quiet the chat and however many lines. A
      // build whose door harvested unconditionally passes every stage above
      // and fails this.
      // ---------------------------------------------------------------
      control = await stageHub(cluster, { hub: { tick_seconds: TICK_SECONDS } });
      for (const at of [3, 3, 3, 3]) {
        plant(control, { at: ago(at), text: `an unharvested line from ${at} minutes ago` });
      }
      controlDoor = await (runDoor as Function)({
        door: DOOR,
        registryFile: control.registryFile,
        platform: control.fake.platform,
      });
      await Bun.sleep(TICK_SECONDS * 3 * 1000 + 500);
      expect(await harvestRows(control)).toEqual([]);
    } finally {
      if (controlDoor) await controlDoor.stop().catch(() => {});
      if (clocksDoor) await clocksDoor.stop().catch(() => {});
      if (handle) await handle.stop().catch(() => {});
      if (subprocess) await subprocess.stop().catch(() => {});
      if (control) await control.stop();
      if (quiet) await quiet.stop();
      if (clocks) await clocks.stop();
      await it.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 7.
// ---------------------------------------------------------------------------

test.skipIf(!GATE_7.ok)(
  "HARV-03 a chat that never goes quiet is harvested once a day over everything still unharvested, whatever the minimum says, and a door that slept through a midnight serves it the moment it comes up (SPEC §4, L19, D-145)" + clockSuffix(GATE_7),
  async () => {
    const { lastMidnight, nextMidnight, dueTrigger } = await seam("src/harvest/row.ts");
    expect(typeof lastMidnight).toBe("function");
    expect(typeof nextMidnight).toBe("function");
    expect(typeof dueTrigger).toBe("function");
    const last = lastMidnight as (now: Date) => number;
    const next = nextMidnight as (now: Date) => number;
    const due = dueTrigger as (args: {
      newest: string | null;
      oldest: string | null;
      count: number;
      quietMinutes: number;
      minMessages: number;
      now: Date;
    }) => string | null;
    const { decodeHarvestBody } = await seam("src/harvest/row.ts");
    const bodyOf = decodeHarvestBody as (body: string) => HarvestBody;
    const { runDoor } = await seam("src/door/run.ts");

    // -----------------------------------------------------------------
    // HALF ONE: THE ARITHMETIC, PURE. No store, no door, and nothing waits
    // for a midnight.
    // -----------------------------------------------------------------

    // 1. Both midnights are UTC, asserted either side of a boundary and in a
    //    month with a leap day. A build that used the local timezone answers
    //    differently in at least one of these on every machine this suite runs
    //    on except CI.
    for (const [now, midnight] of [
      ["2026-09-16T11:30:00.000Z", "2026-09-16T00:00:00.000Z"],
      ["2026-09-16T23:59:59.999Z", "2026-09-16T00:00:00.000Z"],
      ["2026-09-16T00:00:00.000Z", "2026-09-16T00:00:00.000Z"],
      ["2026-09-16T00:00:00.001Z", "2026-09-16T00:00:00.000Z"],
      ["2024-02-29T13:00:00.000Z", "2024-02-29T00:00:00.000Z"],
    ] as [string, string][]) {
      expect(new Date(last(new Date(now))).toISOString()).toBe(midnight);
      expect(next(new Date(now))).toBe(last(new Date(now)) + 86_400_000);
      expect(next(new Date(now))).toBeGreaterThan(new Date(now).getTime());
    }
    // One millisecond BEFORE a midnight, the next one is that midnight.
    expect(new Date(next(new Date("2026-09-16T23:59:59.999Z"))).toISOString()).toBe(
      "2026-09-17T00:00:00.000Z",
    );

    // 2. `dueTrigger` over the whole table.
    const NOW = new Date("2026-09-16T11:30:00.000Z");
    const yesterday = "2026-09-15T22:00:00.000Z";
    const today = "2026-09-16T09:00:00.000Z";
    const justNow = "2026-09-16T11:29:00.000Z";

    // an oldest unharvested line BEFORE the last midnight answers backstop,
    // whatever the count and whatever the minimum. L19's "small slices merge
    // into one turn".
    expect(
      due({ newest: justNow, oldest: yesterday, count: 1, quietMinutes: 30, minMessages: 99, now: NOW }),
    ).toBe("backstop");
    // THE BACKSTOP IS ASKED FIRST: a case where both would fire answers
    // backstop, because its slice is the wider one and a quiet row underneath
    // it would be the empty row D-149 describes.
    expect(
      due({ newest: yesterday, oldest: yesterday, count: 9, quietMinutes: 30, minMessages: 1, now: NOW }),
    ).toBe("backstop");
    // an oldest line after that midnight, a newest line older than the quiet
    // period, and a count at or above the minimum answers quiet.
    expect(
      due({ newest: today, oldest: today, count: 3, quietMinutes: 30, minMessages: 3, now: NOW }),
    ).toBe("quiet");
    // the same with the count BELOW the minimum answers null, and the pair is
    // what catches an off-by-one.
    expect(
      due({ newest: today, oldest: today, count: 2, quietMinutes: 30, minMessages: 3, now: NOW }),
    ).toBeNull();
    // the same with the newest line INSIDE the quiet period answers null.
    expect(
      due({ newest: justNow, oldest: today, count: 9, quietMinutes: 30, minMessages: 1, now: NOW }),
    ).toBeNull();
    // no unharvested line at all answers null, whatever the times.
    expect(
      due({ newest: null, oldest: null, count: 0, quietMinutes: 30, minMessages: 1, now: NOW }),
    ).toBeNull();
    expect(
      due({ newest: today, oldest: null, count: 0, quietMinutes: 30, minMessages: 1, now: NOW }),
    ).toBeNull();

    // -----------------------------------------------------------------
    // HALF TWO: THE BEHAVIOUR, through the REAL door.
    //
    // The quiet trigger can NEVER fire here: ten hours and ninety-nine
    // messages. The two lines are planted two days back, so they were already
    // on the wrong side of a midnight before the door started, whatever the
    // hour this check runs at. THAT IS WHAT THIS HALF IS: a door coming up
    // after a midnight it slept through, serving the backstop at once, with
    // nothing in the fixture waiting for a midnight at all.
    // -----------------------------------------------------------------
    const it = await stageHub(cluster, {
      hub: { tick_seconds: TICK_SECONDS },
      harvest: {
        harvester: "harvest",
        vault: "/var/lib/imprnt-hub/p1/vault-project",
        quiet_minutes: 600,
        min_messages: 99,
      },
      registry: (base) => ({
        ...base,
        presets: { ...(base.presets ?? {}), harvest: HARVEST_PRESET },
      }),
    });
    let handle: { stop(): Promise<void> } | null = null;
    let control: StagedHub | null = null;
    let controlDoor: { stop(): Promise<void> } | null = null;
    try {
      const now = Date.now();
      const twoDaysBack = new Date(now - 2 * 86_400_000);
      plant(it, { at: twoDaysBack, text: "the lease renews in March" });
      plant(it, { at: new Date(twoDaysBack.getTime() + 60_000), text: "and the notice period is two months" });

      handle = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });

      // 4. exactly ONE row, over yesterday.
      await until(
        "the door served the backstop it slept through",
        async () => (await harvestRows(it)).length === 1,
        TICK_SECONDS * 6 * 1000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      const body = bodyOf(String((await harvestRows(it))[0].body));
      expect(body.reason).toBe("backstop");
      // 5. the minimum was IGNORED: two lines against ninety-nine.
      expect(body.lines).toBe(2);
      // `until` is the MIDNIGHT and never `now`. L19's words are "over
      // yesterday", and a backstop that ran to `now` would swallow today's
      // still-live conversation into yesterday's slice. Computed by the TEST.
      expect(body.until).toBe(new Date(last(new Date())).toISOString());

      // 6. a second pass writes no second row. The id carries its `until`, so
      //    a second write meets the same primary key and `enqueueInbound`'s
      //    `on conflict (id) do nothing` makes it a no-op, which is the same
      //    machinery a redelivered platform message already meets.
      await Bun.sleep(TICK_SECONDS * 3 * 1000 + 500);
      expect((await harvestRows(it)).length).toBe(1);

      // 6b. AND IT DOES NOT KEEP TRYING. The second seat's finding: a row count
      //     cannot see an insert that meets `on conflict (id) do nothing`, so a
      //     door that re-attempts the same backstop every tick for ever passes
      //     assertion 6 and quietly costs the store a write per tick per chat.
      //     The suite already observes issued statements, so this is a window
      //     rather than an argument: over two ticks with the backstop already
      //     served, no backend but this check's own may issue a statement that
      //     touches `inbound` at all.
      //
      //     Once the backstop is served the watermark is still absent (no
      //     runner has settled anything), so what stops the door is its own
      //     in-memory bound at the midnight it already fired on, which is
      //     D-145's arithmetic and not a database refusal.
      const mine = [await it.read.pid()];
      const watch = await statementWatch(cluster, mine);
      await Bun.sleep(TICK_SECONDS * 2 * 1000 + 500);
      const wrote = (await watch.lines()).filter((line) => /inbound/i.test(line));
      expect(wrote).toEqual([]);

      // ---------------------------------------------------------------
      // The control: the same stage with its two lines dated AFTER the most
      // recent midnight produces NO row at all, because nothing is owed. A
      // build whose backstop fired on every pass passes assertions 4 to 6 and
      // fails this.
      // ---------------------------------------------------------------
      control = await stageHub(cluster, {
        hub: { tick_seconds: TICK_SECONDS },
        harvest: {
          harvester: "harvest",
          vault: "/var/lib/imprnt-hub/p1/vault-project",
          quiet_minutes: 600,
          min_messages: 99,
        },
        registry: (base) => ({
          ...base,
          presets: { ...(base.presets ?? {}), harvest: HARVEST_PRESET },
        }),
      });
      // One second after the last midnight, so the line is on today's side of
      // it whatever the hour, and one minute ago, so the quiet clock is armed
      // and far from running out.
      const afterMidnight = new Date(last(new Date()) + 1000);
      plant(control, { at: afterMidnight, text: "said after the midnight" });
      plant(control, { at: new Date(now - 60_000), text: "and said a minute ago" });
      controlDoor = await (runDoor as Function)({
        door: DOOR,
        registryFile: control.registryFile,
        platform: control.fake.platform,
      });
      await Bun.sleep(TICK_SECONDS * 3 * 1000 + 500);
      expect(await harvestRows(control)).toEqual([]);
    } finally {
      if (controlDoor) await controlDoor.stop().catch(() => {});
      if (handle) await handle.stop().catch(() => {});
      if (control) await control.stop();
      await it.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 8.
// ---------------------------------------------------------------------------

test.skipIf(!GATE_8.ok)(
  "HARV-03 the phrase harvests at once in either language, its own bytes travel in the row, the chat log still gets the line, and the agent is never asked to answer it (SPEC §4 and §2, L19, L1, D-146, D-147)" + clockSuffix(GATE_8),
  async () => {
    const { runDoor } = await seam("src/door/run.ts");

    // Two people, one in `en` and one in `ru`, one agent each, with a ten hour
    // quiet period and a minimum of ninety-nine on both, so NOTHING BUT A
    // DEMAND CAN FIRE.
    const people: PersonSpec[] = [
      {
        id: PERSON,
        language: "en",
        harvester: "harvest",
        vault: "/var/lib/imprnt-hub/p1/vault-project",
        harvest_quiet_minutes: 600,
        harvest_min_messages: 99,
      },
      {
        id: PERSON2,
        language: "ru",
        harvester: "harvest",
        vault: "/var/lib/imprnt-hub/p2/vault-project",
        harvest_quiet_minutes: 600,
        harvest_min_messages: 99,
      },
    ];
    const it = await stageHub(cluster, {
      hub: { tick_seconds: TICK_SECONDS },
      people,
      agents: [
        { id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}1`, door: DOOR, runner: RUNNER },
      ],
      registry: (base) => ({
        ...base,
        presets: { ...(base.presets ?? {}), harvest: HARVEST_PRESET },
      }),
    });
    let handle: { stop(): Promise<void> } | null = null;
    try {
      const now = Date.now();
      // PLAIN OFFSETS, strictly ordered. The clock gate above is what keeps
      // this stage on one side of a UTC midnight, and a clamp on the times
      // themselves was withdrawn: it produced future timestamps before 00:01
      // and collapsed distinct offsets onto one instant after it.
      const ago = (minutes: number) => new Date(now - minutes * 60_000);
      // Three lines in each chat, a few minutes old.
      for (const [person, agent] of [
        [PERSON, AGENT],
        [PERSON2, AGENT2],
      ] as [string, string][]) {
        for (const at of [5, 4, 3]) {
          plant(it, { person, agent, at: ago(at), text: `something said ${at} minutes ago` });
        }
      }

      handle = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });

      const rowsFor = async (agent: string) =>
        (await harvestRows(it)).filter((row) => row.agent === agent);

      // -------------------------------------------------------------
      // The first person's chat, in English.
      // -------------------------------------------------------------
      it.fake.deliver({ chat: CHAT, text: "harvest this" });
      await until(
        "the phrase produced one harvest row at once",
        async () => (await rowsFor(AGENT)).length === 1,
        TICK_SECONDS * 6 * 1000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      const first = (await rowsFor(AGENT))[0];
      const body = JSON.parse(String(first.body)) as HarvestBody;
      // 1. it fired AT ONCE, with no quiet period waited out, and it carries
      //    the person's own bytes. `said` is what makes L1's "every human
      //    message is on disk" true of a demand in the one table the hub
      //    queries.
      expect(body.reason).toBe("demand");
      expect(body.said).toBe("harvest this");
      expect(Date.parse(body.until)).toBeGreaterThanOrEqual(now);
      // 4 and 5. the minimum was ignored, and the phrase is NOT in the slice
      //    it triggered: three lines and not four.
      expect(body.lines).toBe(3);

      // 2. NO HUMAN ROW WAS WRITTEN FOR IT, asserted positively over the whole
      //    table rather than by a count. D-146: a message addressed to the
      //    machinery and answered by the agent is the confusing half.
      const everything = await it.read.sql(
        "select id, kind, body from inbound order by received_at, id",
      );
      expect(
        everything.some((row) => row.kind === "human" && String(row.body) === "harvest this"),
      ).toBe(false);

      // 3. THE CHAT LOG DID GET THE LINE. The diary holds every message in
      //    both directions (MSG-12), and a demand is a message.
      await until(
        "the chat log holds the phrase as an in line from the person",
        () =>
          chatLogLines(it.stateDir, PERSON, AGENT).some(
            (line) =>
              line.direction === "in" && line.from === PERSON && line.text === "harvest this",
          ),
        TICK_SECONDS * 4 * 1000,
        () => JSON.stringify(chatLogLines(it.stateDir, PERSON, AGENT)),
      );

      // -------------------------------------------------------------
      // The second person's chat, in Russian.
      // -------------------------------------------------------------
      it.fake.deliver({ chat: `${CHAT}1`, text: "сохрани важное" });
      await until(
        "the Russian phrase produced one harvest row at once",
        async () => (await rowsFor(AGENT2)).length === 1,
        TICK_SECONDS * 6 * 1000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      const ru = JSON.parse(String((await rowsFor(AGENT2))[0].body)) as HarvestBody;
      expect(ru.reason).toBe("demand");
      expect(ru.said).toBe("сохрани важное");
      expect(ru.lines).toBe(3);
      expect(
        (await it.read.sql("select id, kind, body from inbound order by id")).some(
          (row) => row.kind === "human" && String(row.body) === "сохрани важное",
        ),
      ).toBe(false);
      expect(
        chatLogLines(it.stateDir, PERSON2, AGENT2).some(
          (line) => line.direction === "in" && line.text === "сохрани важное",
        ),
      ).toBe(true);

      // 6. EITHER PHRASE IN EITHER CHAT. The English phrase, delivered into
      //    the chat of the person whose language is `ru`, harvests. A phrase
      //    that works in one language is a trap for a bilingual household and
      //    neither is a plausible ordinary message. The line that comes BACK
      //    is in that person's own language, which is check 13's.
      it.fake.deliver({ chat: `${CHAT}1`, text: "harvest this" });
      await until(
        "the English phrase harvested the Russian person's chat too",
        async () => (await rowsFor(AGENT2)).length === 2,
        TICK_SECONDS * 6 * 1000,
        async () => JSON.stringify(await rowsFor(AGENT2)),
      );
      expect(
        (JSON.parse(String((await rowsFor(AGENT2))[1].body)) as HarvestBody).said,
      ).toBe("harvest this");

      // -------------------------------------------------------------
      // The controls. Each writes a HUMAN row and no harvest row.
      //
      // BOTH LANGUAGES GET THE SAME THREE NEAR MISSES, which is the second
      // seat's finding: with whole-phrase controls in English only, a door that
      // exact-matches the English phrase and PREFIX-matches the Russian one
      // passes every positive case and every control above, and then eats
      // ordinary Russian messages as commands. A prefix, a suffix and a mention
      // in each language is what closes that.
      // -------------------------------------------------------------
      const beforeEn = (await rowsFor(AGENT)).length;
      const beforeRu = (await rowsFor(AGENT2)).length;
      const NEAR_MISSES: [string, string][] = [
          [CHAT, "can you harvest this later?"],
        [CHAT, "harvest"],
        [CHAT, "harvest this one"],
        [CHAT, "please harvest this"],
        [CHAT, "what is for dinner"],
        [`${CHAT}1`, "сохрани важное сообщение из вчерашнего разговора"],
        [`${CHAT}1`, "быстро сохрани важное"],
        [`${CHAT}1`, "можешь сохрани важное потом?"],
        [`${CHAT}1`, "сохрани"],
        [`${CHAT}1`, "что на ужин"],
      ];
      for (const [chat, text] of NEAR_MISSES) {
        it.fake.deliver({ chat, text });
        await until(
          `the near miss ${JSON.stringify(text)} became a human row`,
          async () =>
            (
              await it.read.sql("select id, kind, body from inbound where kind = 'human'")
            ).some((row) => String(row.body) === text),
          TICK_SECONDS * 6 * 1000,
          async () => JSON.stringify(await it.read.inbound()),
        );
      }
      // And not one of them harvested anything, in either chat.
      await Bun.sleep(TICK_SECONDS * 2 * 1000);
      expect((await rowsFor(AGENT)).length).toBe(beforeEn);
      expect((await rowsFor(AGENT2)).length).toBe(beforeRu);
    } finally {
      if (handle) await handle.stop().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);
