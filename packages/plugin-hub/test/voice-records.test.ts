// The row's own transcription state, the recognizer's health, the transcribing
// interval, and the clock that knows a text does not exist yet.
//
// SPEC §2: "Two tables, one owner each: `inbound`, written by the door... Nobody
// else writes either." The door's step is the only writer of a message's text,
// and the five media columns are the door's own, fenced so a transcript can
// never rewrite a message somebody has already been shown. L4 asks a resident
// piece to carry a measured peak, L6 asks a clock that runs out to be a line
// and a finding, and L17 asks a thing that is gone to leave no line behind.
//
// Every refusal below is raised by Postgres on a role connection, never by a
// guard in TypeScript, because a second process opens its own connection.
//
// THIS IS THE CHECK THAT PROTECTS THE DOOR'S CLOCK WINDOW. A row with no
// `media_done_at` must produce exactly the arithmetic `test/door-clock.test.ts`
// already pins, and that is asserted here against the rows that check hands
// `clockDeadlines` itself.
//
// A cluster, no door, no runner, no cluster of agents, so none of the six
// protected windows is reachable from here.
//
// The fixtures are p1, p1-lair, pi and mac, because the repository is public.
//
// Red reason: import missing, `src/voice/health.ts` and `src/voice/records.ts`,
// with the schema and the clock red for behaviour behind it: the five columns
// do not exist and the clock knows nothing about media.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import { rolloutDatabase } from "./helpers/rollout-fixtures.ts";
import { storeReader } from "./helpers/hub-fixture.ts";
import { readOpenTurns } from "../src/store/turns.ts";
import { gapMarker } from "../src/door/lines.ts";
import { plantSamples, WAV_RATE } from "./helpers/wav.ts";

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** The seven columns the door's step owns, body and source included. */
const DOOR_COLUMNS = [
  "body",
  "source",
  "media_state",
  "media_attempts",
  "media_retry_at",
  "media_failure",
  "media_done_at",
];

async function refused(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return String((error as Error).message);
  }
  throw new Error("the database allowed a write it must refuse");
}

test(
  "RUN-13 a row carrying a voice note has five door-owned columns of its own, the door may write them only while the row is not projected, and the runner's grants are exactly what they were (SPEC §2, L4)",
  async () => {
    const { markMediaPending, markMediaDone, markMediaFailed, readMediaState } = await seam(
      "src/voice/records.ts",
    );
    expect(typeof markMediaPending).toBe("function");
    expect(typeof markMediaDone).toBe("function");
    expect(typeof markMediaFailed).toBe("function");
    expect(typeof readMediaState).toBe("function");

    const f = await rolloutDatabase(cluster);
    const door = f.store("hub_door");
    const runner = f.store("hub_runner");

    // --- 1. the five columns, read out of the CATALOG rather than inferred
    //     from an insert that happened to work.
    const columns = (await f.sql`
      select column_name, data_type, is_nullable, column_default
        from information_schema.columns
       where table_name = 'inbound' and column_name like 'media%'
       order by column_name`) as unknown as {
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }[];
    expect(columns.map((one) => one.column_name)).toEqual([
      "media_attempts",
      "media_done_at",
      "media_failure",
      "media_retry_at",
      "media_state",
    ]);
    const typeOf = new Map(columns.map((one) => [one.column_name, one]));
    expect(typeOf.get("media_state")!.data_type).toBe("text");
    expect(typeOf.get("media_state")!.is_nullable).toBe("YES");
    expect(typeOf.get("media_state")!.column_default).toBeNull();
    expect(typeOf.get("media_attempts")!.data_type).toBe("integer");
    expect(typeOf.get("media_attempts")!.is_nullable).toBe("NO");
    expect(String(typeOf.get("media_attempts")!.column_default)).toContain("0");
    expect(typeOf.get("media_retry_at")!.data_type).toBe("timestamp with time zone");
    expect(typeOf.get("media_failure")!.data_type).toBe("jsonb");
    expect(typeOf.get("media_done_at")!.data_type).toBe("timestamp with time zone");

    // A row inserted with none of them, which is what every shipped insert is.
    const read = storeReader(cluster, f.database);
    try {
      const [untouched] = await read.inbound();
      expect(untouched.media_state).toBeNull();
      expect(untouched.media_attempts).toBe(0);
      expect(untouched.media_retry_at).toBeNull();
      expect(untouched.media_failure).toBeNull();
      expect(untouched.media_done_at).toBeNull();
    } finally {
      await read.close();
    }

    // The two constraints, on the same row, through the owner's own connection.
    await door.sql`insert into inbound (id, person, agent, body, log_ready)
                   values ('m-voice', 'p1', 'p1-lair', '(voice /scratch/a.ogg)', false)`;
    await refused(() =>
      door.sql`update inbound set media_state = 'invented' where id = 'm-voice'`.execute(),
    );
    await refused(() =>
      door.sql`update inbound set media_attempts = -1 where id = 'm-voice'`.execute(),
    );

    // --- 2. the door may write all five, and only while the row is not
    //     projected. That fence is the whole point: a transcript can never
    //     rewrite a message somebody has already been shown.
    await (markMediaPending as Function)(door, {
      id: "m-voice",
      retryAt: new Date(Date.now() + 60_000),
    });
    let state = await (readMediaState as Function)(door, "m-voice");
    expect(state.state).toBe("pending");
    expect(state.done_at).toBeNull();

    await (markMediaDone as Function)(door, {
      id: "m-voice",
      body: "(voice /scratch/a.ogg)\nthe synthetic transcript",
      source: { media: [{ kind: "voice", recognizer: "local" }] },
    });
    state = await (readMediaState as Function)(door, "m-voice");
    expect(state.state).toBe("done");
    expect(state.done_at).not.toBeNull();
    const [written] = (await f.sql`select body, source, media_state, media_done_at
                                   from inbound where id = 'm-voice'`) as unknown as {
      body: string;
      source: Record<string, unknown>;
      media_state: string;
      media_done_at: Date | null;
    }[];
    expect(written.body).toContain("the synthetic transcript");
    expect(written.source).toEqual({ media: [{ kind: "voice", recognizer: "local" }] });

    // Now the row is shown to the person, and the same write is refused by the
    // DATABASE and not by the code.
    await door.sql`update inbound set log_ready = true where id = 'm-voice'`;
    const stopped = await refused(() =>
      (markMediaDone as Function)(door, {
        id: "m-voice",
        body: "a second transcript nobody asked for",
        source: { media: [] },
      }),
    );
    expect(stopped.length).toBeGreaterThan(0);
    // Column by column, so the fence is not passing on one of them alone.
    for (const column of DOOR_COLUMNS) {
      const value =
        column === "media_state"
          ? "'failed'"
          : column === "media_attempts"
            ? "9"
            : column === "media_failure"
              ? `'{"class":"infra"}'::jsonb`
              : column === "body" || column === "source"
                ? column === "body"
                  ? "'forged'"
                  : `'{"sender_id":"p2"}'::jsonb`
                : "now()";
      await refused(() =>
        door.sql.unsafe(
          `update inbound set ${column} = ${value} where id = 'm-voice'`,
        ),
      );
    }
    // The control: the same seven land on a row that is NOT projected.
    await door.sql`insert into inbound (id, person, agent, body, log_ready)
                   values ('m-open', 'p1', 'p1-lair', '(voice /scratch/b.ogg)', false)`;
    for (const column of DOOR_COLUMNS) {
      const value =
        column === "media_state"
          ? "'pending'"
          : column === "media_attempts"
            ? "1"
            : column === "media_failure"
              ? `'{"class":"infra"}'::jsonb`
              : column === "body"
                ? "'a transcript'"
                : column === "source"
                  ? `'{"door":"door-fake"}'::jsonb`
                  : "now()";
      await door.sql.unsafe(`update inbound set ${column} = ${value} where id = 'm-open'`);
    }

    // The two ways a failure ends, on a row that is still the door's. An infra
    // failure leaves the row WAITING with a retry and touches neither the text
    // nor the provenance, and a content failure is over at once and carries the
    // text the person will read.
    await door.sql`insert into inbound (id, person, agent, body, source, log_ready)
                   values ('m-late', 'p1', 'p1-lair', '(voice /scratch/e.ogg)',
                           '{"door":"door-fake"}'::jsonb, false)`;
    const soon = new Date(Date.now() + 300_000);
    await (markMediaFailed as Function)(door, {
      id: "m-late",
      state: "pending",
      failure: { class: "infra", cause: "connection refused" },
      retryAt: soon,
    });
    let late = await (readMediaState as Function)(door, "m-late");
    expect(late.state).toBe("pending");
    expect(late.attempts).toBe(1);
    expect(late.failure).toEqual({ class: "infra", cause: "connection refused" });
    expect(late.retry_at).not.toBeNull();
    let [kept] = (await f.sql`select body, source from inbound where id = 'm-late'`) as unknown as {
      body: string;
      source: Record<string, unknown>;
    }[];
    expect(kept.body).toBe("(voice /scratch/e.ogg)");
    expect(kept.source).toEqual({ door: "door-fake" });

    await (markMediaFailed as Function)(door, {
      id: "m-late",
      state: "failed",
      failure: { class: "content", cause: "the audio decodes to nothing" },
      retryAt: null,
      body: "(voice /scratch/e.ogg)\n[door] I could not make out the voice note",
      source: { door: "door-fake", media: [{ kind: "voice" }] },
    });
    late = await (readMediaState as Function)(door, "m-late");
    expect(late.state).toBe("failed");
    expect(late.attempts).toBe(2);
    expect(late.retry_at).toBeNull();
    [kept] = (await f.sql`select body, source from inbound where id = 'm-late'`) as unknown as {
      body: string;
      source: Record<string, unknown>;
    }[];
    expect(kept.body).toContain("could not make out");
    expect(kept.source).toEqual({ door: "door-fake", media: [{ kind: "voice" }] });

    // --- 3. the runner is refused on every one of the seven, one at a time,
    //     because SPEC §2 has one writer of a message's text and it is not the
    //     runner. Its three shipped columns still succeed, which is the control
    //     that says the grant was widened and not replaced.
    for (const column of DOOR_COLUMNS) {
      const value =
        column === "media_state"
          ? "'done'"
          : column === "media_attempts"
            ? "4"
            : column === "media_failure"
              ? `'{"class":"content"}'::jsonb`
              : column === "body"
                ? "'the runner rewrote the message'"
                : column === "source"
                  ? `'{"sender_id":"p2"}'::jsonb`
                  : "now()";
      await refused(() =>
        runner.sql.unsafe(`update inbound set ${column} = ${value} where id = 'm-open'`),
      );
    }
    await runner.sql`update inbound set claimed_by = 'runner-test' where id = 'm-open'`;
    await runner.sql`update inbound set claim_deadline = now() where id = 'm-open'`;
    await runner.sql`update inbound set retry_at = now() where id = 'm-open'`;
    const [claimed] = (await f.sql`select claimed_by from inbound where id = 'm-open'`) as unknown as {
      claimed_by: string | null;
    }[];
    expect(claimed.claimed_by).toBe("runner-test");
  },
);

test(
  "RUN-13 the media step is one ordered migration, applied once, and nothing that was already projected is reopened (SPEC §2, L4)",
  async () => {
    const mod = await seam("src/store/migrate.ts");
    const migrate = mod.migrate as (store: unknown) => Promise<void>;
    const f = await rolloutDatabase(cluster, true);
    await migrate(f.store());
    const versions = (await f.sql`select version from schema_version order by version`) as unknown as {
      version: number;
    }[];
    expect(versions.map((one) => Number(one.version))).toEqual([1, 2, 3, 4, 5, 6]);
    await migrate(f.store());
    const again = (await f.sql`select version from schema_version order by version`) as unknown as {
      version: number;
    }[];
    expect(again.map((one) => Number(one.version))).toEqual([1, 2, 3, 4, 5, 6]);

    // A row that predates the columns keeps what it had, so nothing that was
    // already shown to somebody is reopened by the upgrade.
    const [old] = (await f.sql`select media_state, media_attempts, media_done_at, log_ready, body
                               from inbound where id = 'old-input'`) as unknown as {
      media_state: string | null;
      media_attempts: number;
      media_done_at: Date | null;
      log_ready: boolean;
      body: string;
    }[];
    expect(old.media_state).toBeNull();
    expect(old.media_attempts).toBe(0);
    expect(old.media_done_at).toBeNull();
    expect(old.log_ready).toBe(true);
    expect(old.body).toBe("synthetic history");
  },
);

test(
  "RUN-13 the recognizer's health is one row per recognizer name, written on transitions and never on a healthy note after a healthy note, and the transcribing interval is its own diary record (SPEC §2, L6, L17)",
  async () => {
    const { VOICE_HEALTH_SHEET, readVoiceHealth, voiceFailed, voiceSucceeded } =
      await seam("src/voice/health.ts");
    expect(VOICE_HEALTH_SHEET).toBe("voice_health");
    expect(typeof readVoiceHealth).toBe("function");
    expect(typeof voiceFailed).toBe("function");
    expect(typeof voiceSucceeded).toBe("function");
    const { MEDIA_STREAM, MEDIA_KINDS, recordTranscribe } = await seam(
      "src/voice/records.ts",
    );
    expect(MEDIA_STREAM).toBe("media");
    expect(typeof recordTranscribe).toBe("function");

    const f = await rolloutDatabase(cluster);
    const door = f.store("hub_door");
    const hub = f.store("hub_hub");

    // --- the control, first: nothing has failed, so there is no row at all. No
    //     row means nothing has ever failed, which is a different fact from a
    //     failure that cleared, and a build that opened a row at startup fails
    //     here.
    expect([...(await (readVoiceHealth as Function)(hub)).keys()]).toEqual([]);
    expect(
      (await f.sql`select count(*)::int as n from state_row where sheet = 'voice_health'`)[0].n,
    ).toBe(0);
    expect(
      (await f.sql`select count(*)::int as n from ledger_event where stream = 'media'`)[0].n,
    ).toBe(0);

    // --- 5. one row per recognizer NAME, and a second failure of the same
    //     episode EDITS it: `since` survives and `attempts` rises.
    const firstRetry = new Date(Date.now() + 300_000);
    await (voiceFailed as Function)(door, {
      recognizer: "local",
      class: "infra",
      cause: "connection refused",
      retry_at: firstRetry,
    });
    const opened = (await f.sql`select id, data, updated_at from state_row
                                where sheet = 'voice_health'`) as unknown as {
      id: string;
      data: Record<string, unknown>;
      updated_at: Date;
    }[];
    expect(opened.map((one) => one.id)).toEqual(["local"]);
    expect(Object.keys(opened[0].data).sort()).toEqual([
      "attempts",
      "cause",
      "class",
      "last_ok_at",
      "last_ok_recognizer",
      "retry_at",
      "since",
    ]);
    expect(opened[0].data.class).toBe("infra");
    expect(opened[0].data.cause).toBe("connection refused");
    expect(opened[0].data.attempts).toBe(1);
    const since = opened[0].data.since;
    expect(typeof since).toBe("string");

    await (voiceFailed as Function)(door, {
      recognizer: "local",
      class: "infra",
      cause: "connection refused",
      retry_at: new Date(Date.now() + 600_000),
    });
    const second = (await f.sql`select id, data from state_row
                                where sheet = 'voice_health'`) as unknown as {
      id: string;
      data: Record<string, unknown>;
    }[];
    expect(second).toHaveLength(1);
    expect(second[0].data.since).toBe(since);
    expect(second[0].data.attempts).toBe(2);

    // --- the success clears `since` and records what worked.
    await (voiceSucceeded as Function)(door, "local");
    const healthy = (await f.sql`select data, updated_at from state_row
                                 where sheet = 'voice_health'`) as unknown as {
      data: Record<string, unknown>;
      updated_at: Date;
    }[];
    expect(healthy[0].data.since).toBeNull();
    expect(healthy[0].data.last_ok_recognizer).toBe("local");
    expect(typeof healthy[0].data.last_ok_at).toBe("string");
    expect(Object.keys(healthy[0].data).sort()).toEqual([
      "attempts",
      "cause",
      "class",
      "last_ok_at",
      "last_ok_recognizer",
      "retry_at",
      "since",
    ]);

    // --- 6. written on TRANSITIONS: a healthy note after a healthy note
    //     touches nothing, asserted off the sheet's own `updated_at`.
    const stamp = healthy[0].updated_at;
    await Bun.sleep(20);
    await (voiceSucceeded as Function)(door, "local");
    const twice = (await f.sql`select updated_at from state_row
                               where sheet = 'voice_health'`) as unknown as {
      updated_at: Date;
    }[];
    expect(new Date(twice[0].updated_at).getTime()).toBe(new Date(stamp).getTime());

    // --- 7. the hub's role reads the same sheet the door's role wrote, because
    //     `check` runs as the hub and the step runs as the door. A build that
    //     reached for a new table fails here.
    const seen = (await (readVoiceHealth as Function)(hub)) as Map<string, Record<string, unknown>>;
    expect([...seen.keys()]).toEqual(["local"]);
    expect(seen.get("local")!.since).toBeNull();

    // A second recognizer is a second row, never a second column on the first.
    await (voiceFailed as Function)(door, {
      recognizer: "cloud",
      class: "infra",
      cause: "the key file is blank",
      retry_at: firstRetry,
    });
    const both = (await (readVoiceHealth as Function)(hub)) as Map<string, unknown>;
    expect([...both.keys()].sort()).toEqual(["cloud", "local"]);

    // --- 8. the diary stream and its three kinds, asserted as an array so a
    //     renamed kind is caught here.
    expect(MEDIA_KINDS).toEqual([
      "transcribe.started",
      "transcribe.done",
      "transcribe.failed",
    ]);

    // --- 9. the door's role may insert it. Without a policy of its own this is
    //     a permission error and not a missing function.
    await door.sql`insert into inbound (id, person, agent, body, log_ready)
                   values ('m-diary', 'p1', 'p1-lair', '(voice /scratch/c.ogg)', false)`;
    await (recordTranscribe as Function)(door, {
      id: "m-diary",
      kind: "transcribe.done",
      recognizer: "local",
      chunks: 3,
      audio_s: 150,
      decode_ms: 4200,
      attempts: 1,
      class: null,
      cause: null,
    });
    const entries = (await f.sql`select stream, subject, kind, actor, detail
                                 from ledger_event where stream = 'media' order by seq`) as unknown as {
      stream: string;
      subject: string;
      kind: string;
      actor: string;
      detail: Record<string, unknown>;
    }[];
    expect(entries).toHaveLength(1);
    expect(entries[0].subject).toBe("m-diary");
    expect(entries[0].kind).toBe("transcribe.done");
    expect(entries[0].actor).toBe("door");
    expect(Object.keys(entries[0].detail).sort()).toEqual([
      "attempts",
      "audio_s",
      "cause",
      "chunks",
      "class",
      "decode_ms",
      "recognizer",
    ]);
    expect(entries[0].detail.chunks).toBe(3);
    expect(entries[0].detail.recognizer).toBe("local");
  },
);

test(
  "RUN-13 while a row waits for its transcript the only armed clock is the transcribed one, the three shipped clocks are measured from the moment the text existed, and time to ack excludes the interval (SPEC §2, L6)",
  async () => {
    const { clockDeadlines } = await seam("src/door/clock.ts");
    expect(typeof clockDeadlines).toBe("function");
    const { TRANSCRIBED_DEFAULT_SECONDS } = await seam("src/registry/load.ts");
    const { readStampMetrics, STAMP_METRICS } = await seam("src/metrics/stamps.ts");

    const thresholds = {
      acked_seconds: 30,
      started_seconds: 60,
      answered_seconds: 900,
      delivered_seconds: 60,
    };
    const receivedAt = new Date("2026-09-20T12:00:00.000Z");
    const doneAt = new Date("2026-09-20T12:01:00.000Z");
    const deadlines = clockDeadlines as Function;

    // --- 10. while the transcript is pending the ONLY armed clock is the
    //     transcribed one, and NOT `acked`: the loop has not accepted a message
    //     whose text does not exist yet, so "the loop has not accepted this
    //     message" would be a false sentence.
    const waiting = deadlines(
      { state: "received", received_at: receivedAt, media_state: "pending", media_done_at: null },
      thresholds,
      90,
    );
    expect(waiting).toEqual([{ stamp: "transcribed", at: receivedAt.getTime() + 90_000 }]);
    expect(waiting.some((one: { stamp: string }) => one.stamp === "acked")).toBe(false);
    // The default is the contract's own number when a person names none.
    expect(
      deadlines(
        { state: "received", received_at: receivedAt, media_state: "pending", media_done_at: null },
        thresholds,
      ),
    ).toEqual([
      { stamp: "transcribed", at: receivedAt.getTime() + (TRANSCRIBED_DEFAULT_SECONDS as number) * 1000 },
    ]);

    // --- 11. once the transcript exists the three shipped clocks are measured
    //     from the moment it existed.
    for (const [state, stamp, seconds] of [
      ["received", "acked", thresholds.acked_seconds],
      ["acked", "started", thresholds.started_seconds],
      ["started", "answered", thresholds.answered_seconds],
    ] as [string, string, number][]) {
      expect(
        deadlines(
          { state, received_at: receivedAt, media_state: "done", media_done_at: doneAt },
          thresholds,
        ),
      ).toEqual([{ stamp, at: doneAt.getTime() + seconds * 1000 }]);
    }

    // --- 11's control, and the one that keeps three shipped clock checks
    //     green: a row with NO media is byte for byte what it is today,
    //     asserted against the exact rows `test/door-clock.test.ts` hands this
    //     function and the arithmetic it already pins.
    for (const [state, stamp, seconds] of [
      ["received", "acked", thresholds.acked_seconds],
      ["acked", "started", thresholds.started_seconds],
      ["started", "answered", thresholds.answered_seconds],
    ] as [string, string, number][]) {
      expect(deadlines({ state, received_at: receivedAt }, thresholds)).toEqual([
        { stamp, at: receivedAt.getTime() + seconds * 1000 },
      ]);
      expect(
        deadlines(
          { state, received_at: receivedAt, media_state: null, media_done_at: null },
          thresholds,
        ),
      ).toEqual([{ stamp, at: receivedAt.getTime() + seconds * 1000 }]);
    }
    expect(deadlines({ state: "answered", received_at: receivedAt }, thresholds)).toEqual([]);
    expect(deadlines({ state: "delivered", received_at: receivedAt }, thresholds)).toEqual([]);

    // --- 12. the read carries what the clock needs, so the new clock costs the
    //     door no second statement, and the shipped rank 0 filter is untouched.
    const f = await rolloutDatabase(cluster);
    const door = f.store("hub_door");
    await door.sql`insert into inbound (id, person, agent, body, kind, media_state)
                   values ('m-clock', 'p1', 'p1-lair', '(voice /scratch/d.ogg)', 'human', 'pending')`;
    await door.sql`insert into inbound (id, person, agent, body, kind)
                   values ('harvest:m-1', 'p1', 'p1-lair', 'a slice', 'harvest')`;
    const open = await readOpenTurns(f.store(), { agent: "p1-lair" });
    expect(open.map((row) => row.id).sort()).toEqual(["m-clock", "old-input"]);
    const voice = open.find((row) => row.id === "m-clock")!;
    expect(voice.media_state).toBe("pending");
    expect(voice.media_done_at).toBeNull();
    const plain = open.find((row) => row.id === "old-input")!;
    expect(plain.media_state).toBeNull();
    expect(plain.media_done_at).toBeNull();

    // --- 13. time to ack for a voice row excludes the transcribing interval,
    //     because a loop cannot accept text that does not exist. The contract
    //     names one metric and names no other, so the other four are asserted
    //     untouched on both rows.
    const g = await rolloutDatabase(cluster);
    const at = (offsetMs: number) =>
      new Date(receivedAt.getTime() + offsetMs).toISOString();
    await g.sql`delete from outbox`;
    await g.sql`delete from inbound`;
    // One row per person, so each scope holds one measurement and the two
    // answers are read side by side rather than as one median.
    for (const [id, who, mediaDone] of [
      ["m-spoken", "p1", at(50_000)],
      ["m-typed", "p2", null],
    ] as [string, string, string | null][]) {
      await g.sql`insert into inbound (id, person, agent, body, kind, received_at, media_done_at)
                  values (${id}, ${who}, ${`${who}-lair`}, 'a message', 'human',
                          ${receivedAt.toISOString()}::timestamptz,
                          ${mediaDone}::timestamptz)`;
      await g.sql`insert into ledger_event (stream, subject, kind, actor, at)
                  values ('inbound', ${id}, 'received', 'door', ${receivedAt.toISOString()}::timestamptz)`;
      await g.sql`insert into ledger_event (stream, subject, kind, actor, at)
                  values ('inbound', ${id}, 'acked', 'runner', ${at(60_000)}::timestamptz)`;
      await g.sql`insert into ledger_event (stream, subject, kind, actor, at)
                  values ('inbound', ${id}, 'started', 'runner', ${at(70_000)}::timestamptz)`;
      await g.sql`insert into ledger_event (stream, subject, kind, actor, at)
                  values ('inbound', ${id}, 'answered', 'runner', ${at(80_000)}::timestamptz)`;
      await g.sql`insert into ledger_event (stream, subject, kind, actor, at)
                  values ('inbound', ${id}, 'delivered', 'door', ${at(90_000)}::timestamptz)`;
    }
    const rows = (await (readStampMetrics as Function)(g.store(), {
      now: new Date(receivedAt.getTime() + 120_000),
    })) as { scope: string; id: string; window: string; measures: Record<string, { p50_ms: number | null; count: number }> }[];
    const spoken = rows.find((row) => row.scope === "person" && row.id === "p1" && row.window === "today")!;
    const typed = rows.find((row) => row.scope === "person" && row.id === "p2" && row.window === "today")!;
    // The voice row waited fifty of its sixty seconds for its own text.
    expect(spoken.measures["time-to-ack"].count).toBe(1);
    expect(spoken.measures["time-to-ack"].p50_ms).toBe(10_000);
    expect(typed.measures["time-to-ack"].count).toBe(1);
    expect(typed.measures["time-to-ack"].p50_ms).toBe(60_000);
    // The other four never saw the interval, on either row.
    for (const measured of [spoken, typed]) {
      expect(measured.measures["time-to-start"].p50_ms).toBe(70_000);
      expect(measured.measures["ack-to-start"].p50_ms).toBe(10_000);
      expect(measured.measures["answered-to-delivered"].p50_ms).toBe(10_000);
      expect(measured.measures["time-to-delivered"].p50_ms).toBe(90_000);
    }
    expect((STAMP_METRICS as { id: string }[]).map((one) => one.id)).toEqual([
      "time-to-ack",
      "time-to-start",
      "ack-to-start",
      "answered-to-delivered",
      "time-to-delivered",
    ]);
  },
);

test(
  "RUN-15 a chunk that fails in the middle of a note leaves every later stretch on file, so the give-up render can say how much was lost (SPEC §2)",
  async () => {
    const { transcribeRow } = await seam("src/voice/step.ts");
    expect(typeof transcribeRow).toBe("function");
    const { chunkFilePath, readChunkFile, renderPartial } = await seam(
      "src/voice/transcript.ts",
    );
    const { DecodeRefused } = await seam("src/voice/recognize.ts");

    const f = await rolloutDatabase(cluster);
    const door = f.store("hub_door");
    const dir = mkdtempSync(join(tmpdir(), "voice-middle-"));
    try {
      const audio = join(dir, "0.ogg");
      // The saved bytes are never read here: the converter is a seam, so what
      // this drives is the ARITHMETIC and what it leaves beside the audio.
      const source = {
        door: "door-fake",
        lines: ["(voice " + audio + ")"],
        media: [{ kind: "voice", path: audio, sha256: "a".repeat(64), line: 0 }],
      };
      await door.sql`insert into inbound (id, person, agent, body, source, log_ready)
                     values ('m-middle', 'p1', 'p1-lair', ${"(voice " + audio + ")"},
                             ${source}::jsonb, false)`;
      await door.sql`update inbound set media_state = 'pending' where id = 'm-middle'`;

      const rate = WAV_RATE;
      const samples = plantSamples({ seconds: 150, rate, quietAt: [59.0, 118.0] });
      // The SECOND of three, which is the shape the shipped give-up check
      // cannot see: it plants the last one, and a note that stops at the last
      // chunk is the only note whose missing stretch is already on file.
      let asked = 0;
      const outcome = (await (transcribeRow as Function)(door, {
        row: { id: "m-middle", source },
        voice: {
          recognizer: "local", provider: "sherpa-onnx", model: "a-recognizer-model",
          runtime: dir, credential: null, chunk_seconds: 60,
          retry_seconds: 300, give_up_hours: 24, chunk_deadline_seconds: 120,
        },
        endpoint: "http://127.0.0.1:1/transcribe",
        credentialFile: null,
        language: "en",
        seams: {
          toPcm: async () => ({ samples, rate }),
          recognize: async () => {
            asked += 1;
            if (asked === 1) return { text: "synthetic piece one", audio_s: 59, decode_ms: 1 };
            throw new (DecodeRefused as new (named: string, says: string) => Error)(
              "recognizer-status", "the recognizer answered 503",
            );
          },
          now: () => Date.now(),
        },
      })) as { state: string; failure: string | null };
      expect(outcome.state).toBe("failed");
      expect(outcome.failure, "the recognizer having a bad day is never the note's fault")
        .toBe("infra");
      expect(asked, "it stopped at the chunk that failed").toBe(2);

      const held = (readChunkFile as Function)((chunkFilePath as Function)(audio, 0)) as {
        chunks: { n: number; from_s: number; to_s: number; state: string }[];
      };
      // EVERY CHUNK, not only the ones that were asked for. A stretch with no
      // entry at all is a stretch nothing on file can measure, and the person
      // would never be told it was lost.
      expect([...held.chunks].map((one) => one.n).sort(), "all three stretches are on file")
        .toEqual([1, 2, 3]);
      const third = held.chunks.find((one) => one.n === 3)!;
      expect(third.from_s).toBe(118);
      expect(third.to_s).toBe(150);
      expect(["done", "empty"], "and the one nobody asked for is not finished")
        .not.toContain(third.state);

      // What the person would read if this note ran out its window now: the
      // piece that came back, then a marker for each stretch that did not, in
      // the place it was.
      expect((renderPartial as Function)(held, "en")).toBe(
        [
          "synthetic piece one",
          gapMarker("en", 59),
          gapMarker("en", 32),
        ].join(" "),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
