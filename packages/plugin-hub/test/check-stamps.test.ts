// MSG-08. Every human row older than a threshold with the next stamp missing is
// a finding, and it clears when the stamp lands.
//
// SPEC §2 and L6's check line: "every human row older than a threshold with the
// next stamp missing is a finding, and it clears when the stamp lands", with
// "a silent day is never a finding" beside it. The thresholds are the PERSON's
// own (MSG-08), so one age gives two answers for two people.
//
// Everything here is planted: rows with chosen `received_at` values and stamps
// with chosen `at` values, no door and no runner, the way
// `test/check-silence.test.ts` plants its ages. `runCheck` takes a `now`, so
// every age is arithmetic and nothing sleeps.
//
// THE FOUR GAPS ARE NOT MEASURED FROM ONE PLACE. Three are measured from
// `received_at` and the fourth, `answered` to `delivered`, is measured from the
// answered event's own time (D-130's table), so the fourth row below carries a
// `received_at` a long way back: a build measuring it from `received_at`
// reports the wrong number and fails on the seconds in `says`.
//
// The registry declares no credentials, so `credential-undeclared` stands
// against its plan preset once the build round lands (04-CONTEXT's residues say
// so). Every assertion here filters to `stamp-missing`, which is also how the
// shipped `test/check-sheet.test.ts` stays self-consistent.
//
// Red reason: import missing, `src/check/stamps.ts`.

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
  insertInbound,
  stageHub,
  superStore,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
import { writeRegistry } from "./helpers/registry.ts";

let cluster: Cluster;

const SLOW = 90_000;
const RUNNER_PI = "runner-pi";

/** The two machines this household declares, so `runEntriesFor` filters. */
const MACHINES = [
  { id: "pi", os: "linux" },
  { id: "mac", os: "macos" },
];

/** Two people whose thresholds differ in every field. */
const PEOPLE = [
  {
    id: PERSON,
    language: "en",
    acked_seconds: 30,
    started_seconds: 60,
    answered_seconds: 900,
    delivered_seconds: 60,
  },
  {
    id: PERSON2,
    language: "en",
    acked_seconds: 5,
    started_seconds: 10,
    answered_seconds: 20,
    delivered_seconds: 5,
  },
];

interface Finding {
  id: string;
  kind: string;
  subject: string;
  machine: string;
  says: string;
  fix: string;
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** A stamp at a chosen moment, written through the superuser reader. */
async function plantStamp(
  it: StagedHub,
  messageId: string,
  kind: string,
  at: Date,
): Promise<void> {
  const actor = kind === "received" || kind === "delivered" ? "door" : "runner";
  await it.read.sql(
    `insert into ledger_event (at, stream, subject, kind, actor)
     values ($1, 'inbound', $2, $3, $4)`,
    [at.toISOString(), messageId, kind, actor],
  );
}

function stamps(findings: Finding[]): Finding[] {
  return findings.filter((one) => one.kind === "stamp-missing");
}

test(
  "MSG-08 a human row past its person's own threshold with the next stamp missing is a finding that clears when the stamp lands: the four gaps, one age with two answers for two people, a silent day with none, and one machine reporting it (SPEC §2, L6)",
  async () => {
    const { stampFindings, readStampRows } = await seam("src/check/stamps.ts");
    expect(typeof stampFindings).toBe("function");
    expect(typeof readStampRows).toBe("function");
    const { runCheck, CHECK_SHEET } = await seam("src/check/run.ts");

    const it = await stageHub(cluster, {
      machines: MACHINES,
      people: PEOPLE,
      agents: [
        { id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}1`, door: DOOR, runner: RUNNER_PI },
      ],
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
        {
          id: RUNNER_PI,
          kind: "runner",
          machine: "pi",
          schedule: "always",
          memory_limit_mb: 512,
          child_memory_limit_mb: 512,
        },
      ],
      registry: (base) => ({
        ...base,
        agents: (base.agents ?? []).map((agent) =>
          agent.id === AGENT ? { ...agent, runner: RUNNER_PI } : agent,
        ),
      }),
    });

    try {
      const now = new Date();
      const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
      const store = await superStore(cluster, it.db);
      const prober = fakeProber({});

      // --- the four gaps, one row each.
      await insertInbound(cluster, it.db, {
        id: "s-acked",
        body: "waiting to be accepted",
        receivedAt: ago(40).toISOString(),
      });
      await insertInbound(cluster, it.db, {
        id: "s-started",
        body: "accepted and not begun",
        receivedAt: ago(90).toISOString(),
      });
      await plantStamp(it, "s-started", "acked", ago(80));
      await insertInbound(cluster, it.db, {
        id: "s-answered",
        body: "begun and not finished",
        receivedAt: ago(1000).toISOString(),
      });
      await plantStamp(it, "s-answered", "acked", ago(990));
      await plantStamp(it, "s-answered", "started", ago(980));
      await insertInbound(cluster, it.db, {
        id: "s-delivered",
        body: "answered and not delivered",
        // A LONG way back, so a build measuring this gap from received_at
        // reports 5000 rather than 90 and fails on the seconds it says.
        receivedAt: ago(5000).toISOString(),
      });
      await plantStamp(it, "s-delivered", "acked", ago(4990));
      await plantStamp(it, "s-delivered", "started", ago(4980));
      await plantStamp(it, "s-delivered", "answered", ago(90));

      // --- the controls, each closing a different hole.
      await insertInbound(cluster, it.db, {
        id: "s-fresh",
        body: "inside its own threshold",
        receivedAt: ago(10).toISOString(),
      });
      await insertInbound(cluster, it.db, {
        id: "s-other-person",
        body: "the same age, a different person",
        person: PERSON2,
        agent: AGENT2,
        receivedAt: ago(10).toISOString(),
      });
      await insertInbound(cluster, it.db, {
        id: "s-done",
        body: "all the way through, long ago",
        receivedAt: ago(9000).toISOString(),
      });
      for (const [kind, seconds] of [
        ["acked", 8990],
        ["started", 8980],
        ["answered", 8970],
        ["delivered", 8960],
      ] as [string, number][]) {
        await plantStamp(it, "s-done", kind, ago(seconds));
      }
      await insertInbound(cluster, it.db, {
        id: "s-proactive",
        body: "proactive work nobody is waiting on",
        kind: "triage",
        receivedAt: ago(9000).toISOString(),
      });

      const found = stamps(
        (await (runCheck as Function)({
          machine: "pi",
          registryFile: it.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: prober,
          now,
        })) as Finding[],
      );
      const bySubject = new Map(found.map((one) => [one.subject, one]));

      // 1. received, waiting for acked, measured from received_at.
      const acked = bySubject.get("s-acked")!;
      expect(acked).toBeDefined();
      expect(acked.id).toBe("pi/stamp-missing:s-acked");
      expect(acked.machine).toBe("pi");
      expect(acked.says).toContain(PERSON);
      expect(acked.says).toContain(AGENT);
      expect(acked.says).toContain("acked");
      expect(acked.says).toContain("40");
      expect(acked.fix).toContain(RUNNER_PI);

      // 2 and 3: the two middle gaps, each measured from received_at and not
      // from the stamp before it.
      expect(bySubject.get("s-started")?.says).toContain("started");
      expect(bySubject.get("s-started")?.says).toContain("90");
      expect(bySubject.get("s-answered")?.says).toContain("answered");
      expect(bySubject.get("s-answered")?.says).toContain("1000");

      // 4. THE ONE MEASURED FROM THE ANSWERED STAMP. Ninety seconds, not five
      //    thousand.
      const delivered = bySubject.get("s-delivered")!;
      expect(delivered).toBeDefined();
      expect(delivered.says).toContain("delivered");
      expect(delivered.says).toContain("90");
      expect(delivered.says).not.toContain("5000");

      // (a) inside the threshold, and (b) the SAME age for the person whose
      // own threshold is five seconds. One age, two people, two answers.
      expect(bySubject.has("s-fresh")).toBe(false);
      expect(bySubject.get("s-other-person")?.says).toContain(PERSON2);
      // (c) there is no sixth stamp, and (d) the five stamps are a human
      // message's.
      expect(bySubject.has("s-done")).toBe(false);
      expect(bySubject.has("s-proactive")).toBe(false);
      expect(found.length).toBe(5);

      // --- the outage case, stated as an assertion because a reader will ask.
      //     A row held by an outage IS reported here: L10's Forbidden line is
      //     about what reaches a PERSON in a chat, and a `check` that went
      //     quiet during an outage is the silence this phase is named after.
      await it.read.sql(
        "update inbound set retry_at = now() + interval '5 minutes' where id = 's-acked'",
      );
      await it.read.sql(
        `insert into state_row (sheet, id, data)
         values ('outage', 'household-claude', '{"cause":"login"}'::jsonb)
         on conflict (sheet, id) do nothing`,
      );
      const held = stamps(
        (await (runCheck as Function)({
          machine: "pi",
          registryFile: it.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: prober,
          now,
        })) as Finding[],
      );
      expect(held.some((one) => one.subject === "s-acked")).toBe(true);

      // --- THE CLEAR, which is half the criterion. The stamp lands and the
      //     finding is gone from the returned list AND from the sheet, with no
      //     "fixed" line left underneath it (L17).
      await plantStamp(it, "s-acked", "acked", now);
      const after = stamps(
        (await (runCheck as Function)({
          machine: "pi",
          registryFile: it.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: prober,
          now,
        })) as Finding[],
      );
      expect(after.some((one) => one.subject === "s-acked")).toBe(false);
      const sheet = await it.read.sheet(String(CHECK_SHEET));
      expect(sheet.some((row) => row.id === "pi/stamp-missing:s-acked")).toBe(false);
      // The others are still standing, so the sweep took one row and not the
      // set.
      expect(sheet.some((row) => row.id === "pi/stamp-missing:s-answered")).toBe(true);

      // --- THE MACHINE. The finding's machine is the machine of the agent's
      //     RUNNER entry, so two machines running `check` do not both report
      //     one row. The same file with that entry moved is the control.
      const moved = writeRegistry(it.stateDir, {
        hub: { store_url: it.storeUrl, state_dir: it.stateDir, tick_seconds: 5 },
        machines: MACHINES,
        people: PEOPLE,
        presets: {
          daily: {
            adapter: it.adapterName,
            model: "a-model-name",
            provider: "a-provider",
            effort: "medium",
            paid: "plan",
          },
        },
        agents: [
          { id: AGENT, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: RUNNER_PI },
          { id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}1`, door: DOOR, runner: RUNNER_PI },
        ],
        run: [
          {
            id: DOOR,
            kind: "door",
            machine: "mac",
            platform: "fake",
            person: PERSON,
            token_file: "/dev/null",
            schedule: "always",
            memory_limit_mb: 192,
          },
          {
            id: RUNNER_PI,
            kind: "runner",
            machine: "mac",
            schedule: "always",
            memory_limit_mb: 512,
            child_memory_limit_mb: 512,
          },
        ],
      });
      const onPi = stamps(
        (await (runCheck as Function)({
          machine: "pi",
          registryFile: moved,
          store,
          os: null,
          kernel: null,
          credentials: prober,
          now,
        })) as Finding[],
      );
      expect(onPi).toEqual([]);
      const onMac = stamps(
        (await (runCheck as Function)({
          machine: "mac",
          registryFile: moved,
          store,
          os: null,
          kernel: null,
          credentials: prober,
          now,
        })) as Finding[],
      );
      expect(onMac.length).toBeGreaterThanOrEqual(4);
      for (const one of onMac) expect(one.machine).toBe("mac");

      await store.close();
    } finally {
      await it.stop();
    }

    // --- A SILENT DAY IS NEVER A FINDING, asserted rather than assumed: a
    //     store with no rows at all produces no stamp finding.
    const empty = await stageHub(cluster, {
      machines: MACHINES,
      people: PEOPLE,
      run: [
        {
          id: RUNNER_PI,
          kind: "runner",
          machine: "pi",
          schedule: "always",
          memory_limit_mb: 512,
          child_memory_limit_mb: 512,
        },
      ],
      registry: (base) => ({
        ...base,
        agents: (base.agents ?? []).map((agent) => ({ ...agent, runner: RUNNER_PI })),
      }),
    });
    try {
      const store = await superStore(cluster, empty.db);
      const quiet = stamps(
        (await (runCheck as Function)({
          machine: "pi",
          registryFile: empty.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: fakeProber({}),
          now: new Date(),
        })) as Finding[],
      );
      expect(quiet).toEqual([]);
      await store.close();
    } finally {
      await empty.stop();
    }
  },
  SLOW,
);
