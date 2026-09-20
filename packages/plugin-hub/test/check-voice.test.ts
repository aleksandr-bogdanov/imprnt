// `check` watches the transcriber the way it watches a door, and opens no port
// to do it. (SPEC §6, L4, L6, L13)
//
// Four things, no probe. The three shipped findings reach the transcriber for
// free because it is an ordinary resident `always` entry. `memory-over-limit`
// is new and is for EVERY resident, doors and the hub included, because the hub
// already samples each resident pid on its tick and the reading it takes is
// what a household can compare against the limit it asked for. Two more are
// voice's own: the recognizer has been failing, and a row has been waiting for
// its text too long.
//
// EVERYTHING IS PLANTED AND NOTHING IS SLEPT FOR. `runCheck` takes its own
// `now`, so every age below is arithmetic, exactly the way
// `test/check-stamps.test.ts` and `test/check-silence.test.ts` do it. A memory
// reading is a row on the peak sheet and no process here is grown to make one.
//
// A HEALTH READ IS NOT A READ. The recognizer's own `/health` does not answer
// while a decode is running, and under socket activation reading it STARTS the
// service being probed. So a `check` that asked the port a question could block
// a person's note or bring the model into memory, and the assertion is a real
// listener on the port the registry names with zero accepts after the run.
//
// Which of the six protected windows this could reach: the check-silence one.
// `check` reads the health sheet, the peak sheet and the rows the stamp reader
// already reads, and writes the `check` sheet and nothing else. That property
// is asserted here for the kinds this file adds.
//
// Red reason: import missing, `src/check/voice.ts`. Behind it the limit
// comparison is red for behaviour: the hub records a peak and nothing anywhere
// compares a reading to what the registry asked for.
//
// WHICH ASSERTIONS ARE GREEN FROM THE FIRST RUN, said here rather than
// discovered: the household that installed no recognizer, because a `check`
// that knows nothing about voice says nothing about it either. Everything about
// a limit, a recognizer's episode and a waiting row was red for behaviour.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, seam, type Cluster } from "./helpers/cluster.ts";
import { fakeProber } from "./helpers/prober.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  stageHub,
  superStore,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
import type { MachineSpec, PersonSpec, RecognizerSpec, RunSpec } from "./helpers/registry.ts";
import type { OsSeam, UnitState } from "../src/os/types.ts";
import type { Store } from "../src/store/connect.ts";
import { putRow } from "../src/records/statesheet.ts";
import { VOICE_HEALTH_SHEET } from "../src/voice/health.ts";

const SLOW = 120_000;

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

interface Finding {
  id: string;
  kind: string;
  subject: string;
  machine: string;
  says: string;
  fix: string;
}

/** The kinds this file adds, so every assertion filters to its own. */
const VOICE_KINDS = [
  "memory-over-limit",
  "transcriber-failed",
  "transcribing-stale",
] as const;

const RUNNER_PI = "runner-pi";
const HUB_PI = "hub-pi";
const TRANSCRIBER = "transcriber";
const RUNNER_MAC = "runner-mac";
const DOOR_MAC = "door-mac";
const TRANSCRIBER_MAC = "transcriber-mac";
const AGENT_MAC = "p2-mac";
const MODEL = "a-speech-model-directory";
const RUNTIME = "/var/lib/imprnt-hub/voice";

/** Megabytes as the bytes a reading carries, so no assertion multiplies by hand. */
const MB = 1024 * 1024;

/** Two machines, so `runEntriesFor` and the `mine` set both really filter. */
const MACHINES: MachineSpec[] = [
  { id: "pi", os: "linux" },
  { id: "mac", os: "macos" },
];

/**
 * Two people whose transcribing patience differs, and the grace is small, so
 * one age gives two answers: p1 waits 120 + 10 s and p2 waits 30 + 10 s.
 */
const GRACE_SECONDS = 10;
const PEOPLE: PersonSpec[] = [
  { id: PERSON, language: "en", transcribed_seconds: 120 },
  { id: PERSON2, language: "en", transcribed_seconds: 30 },
];

const LOCAL: Record<string, RecognizerSpec> = {
  local: { provider: "sherpa-onnx", model: MODEL, runtime: RUNTIME, chunk_seconds: 60 },
};

/**
 * A manager that carries nothing and is asked nothing it can act on.
 *
 * `list` answers with whatever the caller planted, `show` with nothing, so
 * every declared entry is missing unless the plant says otherwise. Only the
 * reading verbs exist as anything: a `check` that tried to act would reach a
 * function that throws, which is the assertion made structural.
 */
function fakeOs(listed: UnitState[], flavour: "systemd" | "launchd" = "systemd"): OsSeam {
  const refuse = (verb: string) => () => {
    throw new Error(`check acted on the manager: ${verb}`);
  };
  return {
    flavour,
    render: refuse("render") as unknown as OsSeam["render"],
    install: refuse("install") as unknown as OsSeam["install"],
    remove: refuse("remove") as unknown as OsSeam["remove"],
    start: refuse("start") as unknown as OsSeam["start"],
    stop: refuse("stop") as unknown as OsSeam["stop"],
    restart: refuse("restart") as unknown as OsSeam["restart"],
    async list() {
      return listed.map((one) => ({ ...one }));
    },
    async show() {
      return null;
    },
    async memory() {
      return { current_bytes: 0, peak_bytes: null, source: "ps-rss" as const };
    },
    async available() {
      return { ok: true, reason: "a manager that carries nothing" };
    },
  };
}

/** A unit the manager is carrying and running, in the shape `list` answers with. */
function carried(name: string): UnitState {
  return {
    name,
    loaded: true,
    running: true,
    pid: null,
    runs: 1,
    ran: true,
    restarts: 0,
    lastExit: null,
    since: null,
    state: "running",
    result: null,
  };
}

/** The `[[run]]` entries of a household that transcribes, on two machines. */
function voiceRun(port: number, macPort: number): RunSpec[] {
  return [
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
    { id: RUNNER_PI, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    { id: HUB_PI, kind: "hub", machine: "pi", schedule: "always", memory_limit_mb: 128 },
    {
      id: TRANSCRIBER,
      kind: "transcriber",
      machine: "pi",
      schedule: "always",
      memory_limit_mb: 2048,
      port,
      residency: "resident",
    },
    // A scheduled piece and an on-demand one, each with a reading far over its
    // own limit, so "only a resident" is asserted against a real temptation.
    { id: "watch-bikes", kind: "runner", machine: "pi", schedule: "every 30m", memory_limit_mb: 128, child_memory_limit_mb: 2048 },
    { id: "spare-runner", kind: "runner", machine: "pi", schedule: "on demand", memory_limit_mb: 64, child_memory_limit_mb: 2048 },
    // The other machine, so a row its agent owns is reported by its own run
    // and never by this one.
    {
      id: DOOR_MAC,
      kind: "door",
      machine: "mac",
      platform: "fake",
      person: PERSON2,
      token_file: "/dev/null",
      schedule: "always",
      memory_limit_mb: 192,
    },
    { id: RUNNER_MAC, kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    {
      id: TRANSCRIBER_MAC,
      kind: "transcriber",
      machine: "mac",
      schedule: "always",
      memory_limit_mb: 2048,
      port: macPort,
    },
  ];
}

/** A household that transcribes, staged whole. */
async function voiceStage(port: number, macPort: number): Promise<StagedHub> {
  return await stageHub(cluster, {
    hub: { job_grace_seconds: GRACE_SECONDS },
    machines: MACHINES,
    people: PEOPLE,
    run: voiceRun(port, macPort),
    agents: [
      { id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}1`, door: DOOR, runner: RUNNER_PI },
      { id: AGENT_MAC, person: PERSON2, preset: "daily", chat: `${CHAT}2`, door: DOOR_MAC, runner: RUNNER_MAC },
    ],
    registry: (base) => ({
      ...base,
      voice: {
        recognizer: "local",
        retry_seconds: 300,
        give_up_hours: 24,
        chunk_deadline_seconds: 120,
      },
      recognizers: LOCAL,
      agents: (base.agents ?? []).map((agent) =>
        agent.id === AGENT ? { ...agent, runner: RUNNER_PI } : agent,
      ),
    }),
  });
}

/**
 * One inbound row planted whole, transcription state included.
 *
 * `log_ready` defaults to TRUE and the shipped trigger closes the media columns
 * on a row that has been shown to somebody, so a row that is still waiting for
 * its words is written unready in the one insert rather than updated into that
 * state afterwards.
 */
async function plantVoiceRow(
  it: StagedHub,
  row: {
    id: string;
    person?: string;
    agent?: string;
    receivedAt: Date;
    mediaState: string | null;
    doneAt?: Date | null;
  },
): Promise<void> {
  await it.read.sql(
    `insert into inbound (id, person, agent, body, received_at, log_ready,
                          media_state, media_done_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.id,
      row.person ?? PERSON,
      row.agent ?? AGENT,
      "(voice /tmp/a-note.ogg)",
      row.receivedAt.toISOString(),
      // A row still waiting for its words has not been shown to anybody, which
      // is what leaves its transcription state open to the door.
      row.mediaState !== "pending",
      row.mediaState,
      row.doneAt ? row.doneAt.toISOString() : null,
    ],
  );
}

/**
 * One `voice_health` row, planted through the writer the door's step uses.
 *
 * NOT A HAND-WRITTEN INSERT. This client sends a bound jsonb parameter as a
 * JSON string, so an insert that binds an already serialised object stores a
 * jsonb SCALAR STRING whose contents are the object, and every reader sees a
 * row with none of the fields in it. Writing it the way production writes it is
 * the only plant that is really the shape production makes.
 */
async function plantHealth(
  store: Store,
  recognizer: string,
  data: Record<string, unknown>,
): Promise<void> {
  await putRow(store, VOICE_HEALTH_SHEET, recognizer, data);
}

/** Every finding of one kind, by subject. */
function of(found: Finding[], kind: string): Map<string, Finding> {
  return new Map(found.filter((one) => one.kind === kind).map((one) => [one.subject, one]));
}

test(
  "RUN-13 the transcriber is an ordinary resident to `check`: it reaches unit-missing, unit-extra and peak-missing with no code path of its own, it is never asked for a job stamp however old the clock is, `check` opens no connection to its port, and the run writes the check sheet and nothing else (SPEC §6, L4, L6, L13, D-97, D-75, D-197)",
  async () => {
    const { runCheck, CHECK_SHEET } = await seam("src/check/run.ts");
    const { recordPeak } = await seam("src/hub/peak.ts");
    const { JOB_SUCCESS_SHEET } = await seam("src/check/schedule.ts");
    // The module this file is really about. Named first so the red reason is
    // the absent one rather than whichever assertion happens to run first.
    const voice = await seam("src/check/voice.ts");
    expect(typeof voice.readVoiceState).toBe("function");
    expect(typeof voice.voiceFindings).toBe("function");
    expect(typeof voice.transcribingFindings).toBe("function");

    // A REAL LISTENER on the port the registry names, counting accepts. Opened
    // before the stage, because the registry has to carry the port it got.
    let accepts = 0;
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          accepts += 1;
          socket.end();
        },
        data() {},
        error() {},
      },
    });
    const it = await voiceStage(listener.port, 8799);
    let store: Store | null = null;
    try {
      store = await superStore(cluster, it.db);
      const now = new Date();
      const prober = fakeProber({});
      const os = fakeOs([
        // A v2-shaped stray under the scan prefix, which is a name 7a
        // deliberately never renders.
        carried("imprnt-transcribe.service"),
      ]);
      const run = async (options: Record<string, unknown> = {}) =>
        (await (runCheck as Function)({
          machine: "pi",
          registryFile: it.registryFile,
          store,
          os,
          kernel: null,
          credentials: prober,
          now,
          ...options,
        })) as Finding[];

      // --- 1. the two unit findings, reaching the transcriber for free.
      const first = await run();
      const missing = of(first, "unit-missing");
      expect(missing.has(TRANSCRIBER)).toBe(true);
      expect(missing.get(TRANSCRIBER)!.id).toBe(`pi/unit-missing:${TRANSCRIBER}`);
      expect(missing.get(TRANSCRIBER)!.machine).toBe("pi");
      expect(missing.get(TRANSCRIBER)!.fix).toBe(
        `systemctl --user start imprnt-hub-${TRANSCRIBER}.service`,
      );
      // Its own machine's entries only: the other machine's transcriber is not
      // this run's to report.
      expect(missing.has(TRANSCRIBER_MAC)).toBe(false);

      const extra = of(first, "unit-extra");
      expect(extra.has("imprnt-transcribe.service")).toBe(true);
      expect(extra.get("imprnt-transcribe.service")!.fix).toBe(
        "systemctl --user stop imprnt-transcribe.service",
      );

      // --- 2. peak-missing reaches it because it is a resident `always` entry,
      //        and it clears when a peak is recorded. No new code path.
      expect(of(first, "peak-missing").has(TRANSCRIBER)).toBe(true);
      await (recordPeak as Function)(store, {
        id: TRANSCRIBER,
        bytes: 900 * MB,
        reading_bytes: 900 * MB,
        how: "sampled",
        machine: "pi",
        pid: 4242,
      });
      const second = await run();
      expect(of(second, "peak-missing").has(TRANSCRIBER)).toBe(false);

      // --- 3. never a scheduled job, however old the clock is. `intervalOf`
      //        answers null for `always`, and a resident service that was asked
      //        for a stamp would be a permanent finding.
      const weekOn = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      const later = await run({ now: weekOn });
      for (const kind of ["job-stale", "job-no-stamp"]) {
        expect(of(later, kind).has(TRANSCRIBER)).toBe(false);
      }
      // And nothing ever wrote it a success stamp either, because success for
      // the transcriber is a real note and not a job that landed.
      const stamps = (await it.read.sql("select id from state_row where sheet = $1", [
        String(JOB_SUCCESS_SHEET),
      ])) as { id: string }[];
      expect(stamps.map((row) => row.id)).not.toContain(TRANSCRIBER);

      // --- 17. ZERO ACCEPTS. A read that could start or block a decode is not
      //         a read, so there is no read at all.
      expect(accepts).toBe(0);

      // --- 18. the run writes the check sheet and nothing else.
      const snapshot = async () => ({
        ledger: JSON.stringify(
          await it.read.sql("select count(*)::int as n, coalesce(max(seq), 0)::int as top from ledger_event"),
        ),
        health: JSON.stringify(
          await it.read.sql("select id, data from state_row where sheet = 'voice_health' order by id"),
        ),
        peaks: JSON.stringify(
          await it.read.sql("select id, data from state_row where sheet = 'memory_peak' order by id"),
        ),
        outbox: JSON.stringify(await it.read.sql("select count(*)::int as n from outbox")),
        inbound: JSON.stringify(
          await it.read.sql("select id, media_state, media_attempts, media_done_at from inbound order by id"),
        ),
      });
      const before = await snapshot();
      const third = await run();
      expect(await snapshot()).toEqual(before);

      // --- 19. the sheet equals the findings the same run returned, in
      //         miniature over the kinds this file adds.
      const sheetRows = (await it.read.sql(
        "select id, data from state_row where sheet = $1 order by id",
        [String(CHECK_SHEET)],
      )) as { id: string; data: Record<string, unknown> }[];
      const onSheet = sheetRows
        .filter((row) => VOICE_KINDS.includes(String(row.data.kind) as (typeof VOICE_KINDS)[number]))
        .map((row) => row.id)
        .sort();
      const returned = third
        .filter((one) => VOICE_KINDS.includes(one.kind as (typeof VOICE_KINDS)[number]))
        .map((one) => one.id)
        .sort();
      expect(onSheet).toEqual(returned);
    } finally {
      listener.stop(true);
      await store?.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);

test(
  "RUN-13 a resident holding more than the registry asked for is a finding, for a door and the hub as much as for the transcriber: it does not fire at the limit, never for a piece that is not resident, never for a resident nothing has measured, it clears when the reading falls, and the peak does not fall with it (SPEC §6, L4, D-197)",
  async () => {
    const { runCheck } = await seam("src/check/run.ts");
    const { recordPeak, overLimit } = await seam("src/hub/peak.ts");
    expect(typeof overLimit).toBe("function");

    const it = await voiceStage(8798, 8799);
    let store: Store | null = null;
    try {
      store = await superStore(cluster, it.db);
      const now = new Date();
      const prober = fakeProber({});
      const run = async () =>
        (await (runCheck as Function)({
          machine: "pi",
          registryFile: it.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: prober,
          now,
        })) as Finding[];
      const record = async (id: string, peakMb: number, readingMb: number, bytes?: number) =>
        await (recordPeak as Function)(store, {
          id,
          bytes: peakMb * MB,
          reading_bytes: bytes ?? readingMb * MB,
          how: "sampled",
          machine: "pi",
          pid: 4242,
        });

      // Every resident but `runner-pi`, so a resident nothing has measured is
      // its own case below.
      await record(TRANSCRIBER, 2100, 2100);
      await record(DOOR, 300, 300);
      await record(HUB_PI, 200, 200);
      await record("postgres", 99_999, 99_999);
      // Not resident, and far over their own limits.
      await record("watch-bikes", 99_999, 99_999);
      await record("spare-runner", 99_999, 99_999);

      const first = await run();
      const over = of(first, "memory-over-limit");

      // --- 4. the transcriber, with the numbers and the two levers in it.
      const one = over.get(TRANSCRIBER)!;
      expect(one).toBeDefined();
      expect(one.id).toBe(`pi/memory-over-limit:${TRANSCRIBER}`);
      expect(one.machine).toBe("pi");
      expect(one.says).toContain(TRANSCRIBER);
      expect(one.says).toContain("2100");
      expect(one.says).toContain("2048");
      expect(one.fix).toContain(TRANSCRIBER);
      // A unit's own limit is inert on a box whose firmware leaves the memory
      // cgroup off, so the fix names the two kernel findings that are the real
      // levers rather than pretending MemoryMax will hold.
      expect(one.fix).toContain("kernel-memory-cgroup");
      expect(one.fix).toContain("kernel-earlyoom");

      // --- 5. a door and the hub on the same terms.
      expect(over.get(DOOR)?.says).toContain("300");
      expect(over.get(DOOR)?.says).toContain("192");
      expect(over.get(HUB_PI)?.says).toContain("200");
      expect(over.get(HUB_PI)?.says).toContain("128");

      // --- 6. never a scheduled or on-demand piece, however large its reading,
      //        and never the store, which is resident under a fixed id and
      //        declares no limit for anything to compare against.
      expect(over.has("watch-bikes")).toBe(false);
      expect(over.has("spare-runner")).toBe(false);
      expect(over.has("postgres")).toBe(false);

      // --- 8. a resident nothing has measured is peak-missing and is NOT over
      //        its limit: "nothing has measured it" and "it is over" are
      //        different facts and two findings saying one thing is noise.
      expect(of(first, "peak-missing").has(RUNNER_PI)).toBe(true);
      expect(over.has(RUNNER_PI)).toBe(false);

      // --- 6 again, the boundary. Exactly at the limit is not over it.
      await record(RUNNER_PI, 512, 512);
      const atLimit = await run();
      expect(of(atLimit, "memory-over-limit").has(RUNNER_PI)).toBe(false);
      expect(of(atLimit, "peak-missing").has(RUNNER_PI)).toBe(false);

      // ... and one byte more is.
      await record(RUNNER_PI, 512, 0, 512 * MB + 1);
      const overByOne = await run();
      expect(of(overByOne, "memory-over-limit").has(RUNNER_PI)).toBe(true);

      // --- 7. the reading falls and the finding clears, and THE PEAK DOES NOT
      //        FALL WITH IT. That pair is the whole reason the reading is a
      //        field of its own.
      await record(TRANSCRIBER, 1, 100);
      const fallen = await run();
      expect(of(fallen, "memory-over-limit").has(TRANSCRIBER)).toBe(false);
      const row = (await it.read.sql(
        "select data from state_row where sheet = 'memory_peak' and id = $1",
        [TRANSCRIBER],
      )) as { data: Record<string, unknown> }[];
      expect(row.length).toBe(1);
      expect(Number(row[0].data.bytes)).toBe(2100 * MB);
      expect(Number(row[0].data.reading_bytes)).toBe(100 * MB);
    } finally {
      await store?.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);

test(
  "RUN-13 the recognizer that has been failing and the row that has been waiting are both findings that clear on their own: one per recognizer name however many people wait, one per row against that person's own patience, never on a row already answered, and this machine reports only its own agents' rows (SPEC §6, L6, D-193, D-197)",
  async () => {
    const { runCheck, CHECK_SHEET } = await seam("src/check/run.ts");
    const it = await voiceStage(8798, 8799);
    let store: Store | null = null;
    try {
      store = await superStore(cluster, it.db);
      const now = new Date();
      const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
      const prober = fakeProber({});
      const run = async (machine = "pi") =>
        (await (runCheck as Function)({
          machine,
          registryFile: it.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: prober,
          now,
        })) as Finding[];

      // --- the recognizer's episode, one row for the household's one name.
      await plantHealth(store, "local", {
        since: ago(5400).toISOString(),
        class: "infra",
        cause: "connection refused",
        attempts: 7,
        retry_at: new Date(now.getTime() + 300_000).toISOString(),
        last_ok_at: ago(9000).toISOString(),
        last_ok_recognizer: "local",
      });

      // --- the rows. p1 waits 120 + 10 s, p2 waits 30 + 10 s.
      await plantVoiceRow(it, { id: "v-p1-late", receivedAt: ago(200), mediaState: "pending" });
      await plantVoiceRow(it, { id: "v-p1-boundary", receivedAt: ago(130), mediaState: "pending" });
      await plantVoiceRow(it, { id: "v-p1-under", receivedAt: ago(129), mediaState: "pending" });
      // ONE AGE, TWO ANSWERS: 60 s is nothing to p1 and late for p2.
      await plantVoiceRow(it, { id: "v-p1-sixty", receivedAt: ago(60), mediaState: "pending" });
      await plantVoiceRow(it, {
        id: "v-p2-sixty",
        person: PERSON2,
        agent: AGENT2,
        receivedAt: ago(60),
        mediaState: "pending",
      });
      // A row whose words landed, and one the door already gave up on: the
      // person has had that sentence said to them and a finding beside it is
      // the second of two saying one thing.
      await plantVoiceRow(it, {
        id: "v-done",
        receivedAt: ago(9000),
        mediaState: "done",
        doneAt: ago(8900),
      });
      await plantVoiceRow(it, { id: "v-failed", receivedAt: ago(9000), mediaState: "failed" });
      // The other machine's agent, waiting forever.
      await plantVoiceRow(it, {
        id: "v-mac",
        person: PERSON2,
        agent: AGENT_MAC,
        receivedAt: ago(9000),
        mediaState: "pending",
      });

      const found = await run();

      // --- 9 and 11. one finding, named for the recognizer and not for a
      //     person, with the class, the cause, the age and the attempts in it,
      //     and a fix naming the unit that runs a local recognizer.
      const failed = found.filter((one) => one.kind === "transcriber-failed");
      expect(failed.length).toBe(1);
      expect(failed[0].id).toBe("pi/transcriber-failed:local");
      expect(failed[0].subject).toBe("local");
      expect(failed[0].says).toContain("local");
      expect(failed[0].says).toContain("infra");
      expect(failed[0].says).toContain("connection refused");
      expect(failed[0].says).toContain("5400");
      expect(failed[0].says).toContain("7");
      expect(failed[0].fix).toContain(`imprnt-hub-${TRANSCRIBER}`);
      // Not once per person, with two people waiting on the one recognizer.
      expect(failed[0].says).not.toContain(PERSON2);

      // --- 12 to 15. the rows.
      const stale = of(found, "transcribing-stale");
      const late = stale.get("v-p1-late")!;
      expect(late).toBeDefined();
      expect(late.id).toBe("pi/transcribing-stale:v-p1-late");
      expect(late.says).toContain(PERSON);
      expect(late.says).toContain(AGENT);
      expect(late.says).toContain("200");
      expect(late.says).toContain("local");
      // The DOOR owns the step, so the door's unit is where to read.
      expect(late.fix).toContain(`imprnt-hub-${DOOR}`);
      // 13. the pair that makes the threshold real.
      expect(stale.has("v-p1-boundary")).toBe(true);
      expect(stale.has("v-p1-under")).toBe(false);
      // 14. each person's own number, one age between them.
      expect(stale.has("v-p1-sixty")).toBe(false);
      expect(stale.get("v-p2-sixty")?.says).toContain(PERSON2);
      // 15. a row whose words landed, and one already answered with a refusal.
      expect(stale.has("v-done")).toBe(false);
      expect(stale.has("v-failed")).toBe(false);
      // 16. the other machine's agent is the other machine's to report.
      expect(stale.has("v-mac")).toBe(false);
      expect(of(await run("mac"), "transcribing-stale").has("v-mac")).toBe(true);

      // --- 10. the recognizer's finding clears on a planted success, and the
      //     row leaves the check sheet as well as the returned set.
      await plantHealth(store, "local", {
        since: null,
        class: null,
        cause: null,
        attempts: 0,
        retry_at: null,
        last_ok_at: now.toISOString(),
        last_ok_recognizer: "local",
      });
      // And every row is answered, which is the whole-check control: a healthy
      // household produces none of the four kinds.
      await it.read.sql(
        `update inbound set media_state = 'done', media_done_at = now() where media_state = 'pending'`,
      );
      const healthy = await run();
      for (const kind of VOICE_KINDS) {
        expect(healthy.filter((one) => one.kind === kind)).toEqual([]);
      }
      const rows = (await it.read.sql(
        "select id, data from state_row where sheet = $1",
        [String(CHECK_SHEET)],
      )) as { id: string; data: Record<string, unknown> }[];
      expect(rows.map((row) => row.id)).not.toContain("pi/transcriber-failed:local");
      // This machine's own rows: the mac run above wrote its own, and a run on
      // one machine clears only what it wrote.
      expect(
        rows.filter(
          (row) => row.id.startsWith("pi/") && String(row.data.kind).startsWith("transcrib"),
        ),
      ).toEqual([]);
    } finally {
      await store?.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);

test(
  "RUN-13 a household dialling a cloud recognizer is handed the other lever: the same finding, with the key file named instead of a unit (SPEC §6, D-193, D-197)",
  async () => {
    const { runCheck } = await seam("src/check/run.ts");
    const keyFile = "/var/lib/imprnt-hub/secrets/a-speech-key";
    const it = await stageHub(cluster, {
      hub: { job_grace_seconds: GRACE_SECONDS },
      machines: MACHINES,
      people: PEOPLE,
      credentials: [{ id: "speech-key", kind: "api-key", file: keyFile, owner: PERSON }],
      run: [
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
        { id: RUNNER_PI, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      ],
      registry: (base) => ({
        ...base,
        voice: { recognizer: "dialled", retry_seconds: 300 },
        recognizers: {
          dialled: { provider: "deepgram", model: "a-cloud-model", credential: "speech-key", chunk_seconds: 60 },
        },
        agents: (base.agents ?? []).map((agent) =>
          agent.id === AGENT ? { ...agent, runner: RUNNER_PI } : agent,
        ),
      }),
    });
    let store: Store | null = null;
    try {
      store = await superStore(cluster, it.db);
      const now = new Date();
      await plantHealth(store, "dialled", {
        since: new Date(now.getTime() - 600_000).toISOString(),
        class: "infra",
        cause: "the key file is blank",
        attempts: 3,
        retry_at: null,
        last_ok_at: null,
        last_ok_recognizer: null,
      });
      const found = (await (runCheck as Function)({
        machine: "pi",
        registryFile: it.registryFile,
        store,
        os: null,
        kernel: null,
        credentials: fakeProber({ "speech-key": { ok: true } }),
        now,
      })) as Finding[];
      const failed = found.filter((one) => one.kind === "transcriber-failed");
      expect(failed.length).toBe(1);
      expect(failed[0].subject).toBe("dialled");
      expect(failed[0].says).toContain("the key file is blank");
      // The lever a dialled recognizer has is its key, and a household handed
      // the wrong one fixes nothing.
      expect(failed[0].fix).toContain(keyFile);
      expect(failed[0].fix).not.toContain("imprnt-hub-transcriber");
    } finally {
      await store?.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);

test(
  "RUN-13 a household that installed no recognizer hears nothing about voice from `check`, and still hears everything else (SPEC §6, D-200)",
  async () => {
    const { runCheck } = await seam("src/check/run.ts");
    const it = await stageHub(cluster, {
      machines: [{ id: "pi", os: "linux" }],
      people: [{ id: PERSON, language: "en" }],
      run: [
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
        { id: RUNNER_PI, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      ],
      registry: (base) => ({
        ...base,
        agents: (base.agents ?? []).map((agent) =>
          agent.id === AGENT ? { ...agent, runner: RUNNER_PI } : agent,
        ),
      }),
    });
    let store: Store | null = null;
    try {
      store = await superStore(cluster, it.db);
      const found = (await (runCheck as Function)({
        machine: "pi",
        registryFile: it.registryFile,
        store,
        os: null,
        kernel: null,
        credentials: fakeProber({}),
        now: new Date(),
      })) as Finding[];

      expect(found.filter((one) => one.kind.startsWith("transcrib"))).toEqual([]);
      expect(found.filter((one) => one.kind.includes("voice"))).toEqual([]);
      expect(found.filter((one) => one.subject.includes("transcrib"))).toEqual([]);
      // THE CONTROL, so a build that returned nothing at all fails here: the
      // same run still finds what it finds today.
      expect(found.length).toBeGreaterThan(0);
      expect(found.filter((one) => one.kind === "peak-missing").length).toBeGreaterThan(0);
    } finally {
      await store?.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);
