// Check: a runner silent for N hours is a finding. (SPEC §1, D5, STORE-01)
//
// D5's check line: "`check` reports a runner that has not connected for N
// hours." D-85 derives it with NO HEARTBEAT WRITE, because
// `test/runner-drain.test.ts` counts ZERO statements from the runner's backends
// in a window while it waits, and a per-tick heartbeat would break that check or
// race it. So silence is: no live backend for that runner in `pg_stat_activity`
// AND the newest `acked`, `answered`, `turn` or `memory` event for any of its
// agents older than `hub.silent_runner_hours`.
//
// BOTH HALVES ARE REQUIRED, and the two cases that must NOT be findings are
// what say so. A connected runner with nothing to do is a silent day, and SPEC
// §2 rules that a silent day is never a finding: a rule that read only the
// ledger would report a household on holiday every morning. A runner whose
// backend died a minute ago with recent work is not yet a finding either,
// because the threshold is hours.
//
// Red reason: import missing, src/check/silence.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  seam,
  startReadySubprocess,
  until,
  type Cluster,
  type ReadyProcess,
} from "./helpers/cluster.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  RUNNER2,
  hubReader,
  insertInbound,
  plantChatLine,
  stageHub,
  superStore,
} from "./helpers/hub-fixture.ts";
import type { Finding } from "./helpers/finding.ts";

const RUNNER_PI = "runner-pi";
const SILENT_HOURS = 6;
const SLOW = 150_000;

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3600 * 1000).toISOString();
}

test(
  "STORE-01 a runner silent for N hours is a finding: no live backend AND no recent work, while a connected runner with nothing to do and a just-disconnected runner with recent work are both not findings, and against the real server TWO runners whose newest event is the SAME planted age differ only by whether their process is connected, so the connected one is no finding and the same runner disconnected is one, the finding clears when the runner comes back, and the derivation adds no heartbeat write (SPEC §1 and §2, D5, D-85)",
  async () => {
    const { silentRunners } = await seam("src/check/silence.ts");
    expect(typeof silentRunners).toBe("function");
    const { runCheck } = await seam("src/check/run.ts");
    expect(typeof runCheck).toBe("function");

    const silent = silentRunners as (args: Record<string, unknown>) => Finding[];
    const check = runCheck as (options: Record<string, unknown>) => Promise<Finding[]>;

    const it = await stageHub(cluster, {
      servers: true,
      hub: { silent_runner_hours: SILENT_HOURS },
      machines: [
        { id: "pi", os: "linux" },
        { id: "mac", os: "macos" },
      ],
      people: [
        { id: PERSON, tree: "/var/lib/imprnt-hub/p1" },
        { id: PERSON2, tree: "/var/lib/imprnt-hub/p2" },
      ],
      agents: [
        { id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}1`, door: DOOR, runner: RUNNER2 },
      ],
      run: [
        { id: DOOR, kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: RUNNER_PI, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
        { id: RUNNER2, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      ],
    });
    const text = await Bun.file(it.registryFile).text();
    await Bun.write(it.registryFile, text.replace(/runner = "runner-test"/, `runner = "${RUNNER_PI}"`));

    const store = await superStore(cluster, it.db);
    const sheet = hubReader(cluster, it.db, "check");
    let pi: ReadyProcess | null = null;
    let mac: ReadyProcess | null = null;
    try {
      const now = new Date();
      const runners = [RUNNER_PI, RUNNER2];

      // --- 1. the finding: no live backend AND nothing recent.
      const one = silent({
        runners,
        liveApplications: [RUNNER_PI],
        lastEventAt: { [RUNNER_PI]: now.toISOString(), [RUNNER2]: hoursAgo(SILENT_HOURS + 2) },
        hours: SILENT_HOURS,
        now,
        machine: "pi",
      }).filter((f) => f.kind === "runner-silent");
      expect(one.length).toBe(1);
      expect(one[0].subject).toBe(RUNNER2);
      expect(one[0].machine).toBe("pi");
      expect(one[0].id).toContain("pi/");
      expect(one[0].id).toContain(RUNNER2);
      // `says` is the line a human reads, so it names the runner and how long.
      expect(one[0].says).toContain(RUNNER2);
      expect(/\d/.test(one[0].says)).toBe(true);
      // The control inside the same call: the connected one is not a finding.
      expect(one.map((f) => f.subject)).not.toContain(RUNNER_PI);

      // --- 2. a connected runner with NO recent event at all is NOT a finding.
      //     A silent day is never a finding (SPEC §2), and a rule that read only
      //     the ledger would report a household on holiday every morning.
      expect(
        silent({
          runners,
          liveApplications: runners,
          lastEventAt: { [RUNNER_PI]: null, [RUNNER2]: null },
          hours: SILENT_HOURS,
          now,
          machine: "pi",
        }).filter((f) => f.kind === "runner-silent"),
      ).toEqual([]);

      // --- 3. no live backend but a RECENT event is not yet a finding. The
      //     threshold is hours and the backend may have died a minute ago.
      expect(
        silent({
          runners,
          liveApplications: [],
          lastEventAt: {
            [RUNNER_PI]: new Date(Date.now() - 60_000).toISOString(),
            [RUNNER2]: new Date(Date.now() - 60_000).toISOString(),
          },
          hours: SILENT_HOURS,
          now,
          machine: "pi",
        }).filter((f) => f.kind === "runner-silent"),
      ).toEqual([]);

      // --- 4. both halves true for both runners: both are findings, so the
      //     rule is not accidentally scoped to one.
      expect(
        silent({
          runners,
          liveApplications: [],
          lastEventAt: {
            [RUNNER_PI]: hoursAgo(SILENT_HOURS + 1),
            [RUNNER2]: hoursAgo(SILENT_HOURS + 9),
          },
          hours: SILENT_HOURS,
          now,
          machine: "pi",
        })
          .filter((f) => f.kind === "runner-silent")
          .map((f) => f.subject)
          .sort(),
      ).toEqual([RUNNER2, RUNNER_PI].sort());

      // --- and the same thing through `check`, against the real server's own
      //     view of its clients.
      //
      // THE PAIR THAT FORCES `runCheck` TO CONSULT THE LIVE BACKENDS, which is
      // the second seat's lead: an implementation that ignored them and read
      // only recent ledger events passed the old shape of this check, because
      // the runner that was up was also the runner with recent work. So BOTH
      // runners' agents get an event planted at the same age, older than the
      // threshold, and the ONLY difference between them is whether their
      // process is connected. Nothing in the ledger can tell them apart.
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      plantChatLine({
        stateDir: it.stateDir,
        person: PERSON2,
        agent: AGENT2,
        text: "what the second person said yesterday",
      });
      const planted = hoursAgo(SILENT_HOURS + 3);
      for (const agent of [AGENT, AGENT2]) {
        await store.sql.unsafe(
          `insert into ledger_event (stream, subject, kind, actor, at)
           values ('turn', $1, 'turn', 'runner', $2)`,
          [agent, planted],
        );
      }
      // The ledger is append-only by trigger, so the ages are written once,
      // here, and nothing in this check ever edits them. That is what makes
      // "only liveness changed" a true sentence about the two runs below.

      const backendPids = async (): Promise<number[]> =>
        (
          (await it.read.sql(
            `select pid from pg_stat_activity
              where datname = current_database()
                and backend_type = 'client backend'
                and pid <> pg_backend_pid()`,
          )) as { pid: number }[]
        ).map((r) => Number(r.pid));
      const beforeAnyRunner = new Set(await backendPids());

      pi = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER_PI,
        it.adapterUrl,
        it.adapterName,
      ]);
      await until(
        "the live runner's own backend is registered with the server",
        async () => (await backendPids()).some((pid) => !beforeAnyRunner.has(pid)),
        60_000,
        async () => `backends: ${(await backendPids()).join(", ")}`,
      );
      // THE RUNNER'S OWN pids, named here rather than inferred later, because
      // the wait for them to LEAVE (below) has to name them too.
      const piBackends = (await backendPids()).filter((pid) => !beforeAnyRunner.has(pid));
      expect(piBackends.length).toBeGreaterThan(0);

      // --- 5. CONNECTED, WITH NOTHING RECENT: not a finding. Its neighbour,
      //     with an event of the SAME age and no process, is one.
      const findings = await check({
        machine: "pi",
        registryFile: it.registryFile,
        store,
        os: null,
        kernel: null,
      });
      const quiet = findings.filter((f) => f.kind === "runner-silent");
      expect(quiet.map((f) => f.subject)).toEqual([RUNNER2]);
      expect(sheet).toBeDefined();
      expect((await sheet.rows()).some((r) => r.id === quiet[0].id)).toBe(true);

      // --- NO HEARTBEAT WRITE, asserted rather than promised. The live runner
      //     sits idle for several of its own ticks and the ledger does not
      //     grow. `test/runner-drain.test.ts` counts the same silence from the
      //     server's own log, and it is in this suite run.
      const ledgerCount = async (): Promise<number> =>
        Number(
          ((await it.read.sql("select count(*)::int as n from ledger_event")) as { n: number }[])[0]
            .n,
        );
      const eventsBefore = await ledgerCount();
      await Bun.sleep(4000);
      expect(await ledgerCount()).toBe(eventsBefore);

      // --- 6. THE OTHER HALF OF THE PAIR. The same runner, the same ledger,
      //     its process gone. Now it IS a finding, and the only thing that
      //     changed is the backend: a `runCheck` that never looked at
      //     `pg_stat_activity` cannot produce both answers.
      await pi.stop();
      pi = null;
      await until(
        "the stopped runner's backends left the server",
        // ITS OWN pids, never "every backend is one the baseline knew". This
        // file opens its own sheet connection after that baseline was taken, and
        // the pool behind `store` may open a second one, so the broader form
        // could never come true and check 19's red would arrive as a 60 s
        // timeout wearing the wrong reason.
        async () => {
          const now = new Set(await backendPids());
          return piBackends.every((pid) => !now.has(pid));
        },
        60_000,
        async () => `backends: ${(await backendPids()).join(", ")}, the runner had ${piBackends.join(", ")}`,
      );
      expect(await ledgerCount()).toBe(eventsBefore);

      const bothGone = await check({
        machine: "pi",
        registryFile: it.registryFile,
        store,
        os: null,
        kernel: null,
      });
      expect(
        bothGone
          .filter((f) => f.kind === "runner-silent")
          .map((f) => f.subject)
          .sort(),
      ).toEqual([RUNNER2, RUNNER_PI].sort());

      // --- the finding clears, and its row leaves the sheet. A finding that
      //     could only ever be raised is a report, not a rule.
      pi = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER_PI,
        it.adapterUrl,
        it.adapterName,
      ]);
      mac = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER2,
        it.adapterUrl,
        it.adapterName,
      ]);
      await insertInbound(cluster, it.db, { id: "cs-1", body: "a message for the live agent" });
      await insertInbound(cluster, it.db, {
        id: "cs-2",
        body: "a message for the runner that came back",
        person: PERSON2,
        agent: AGENT2,
      });
      await until(
        "both runners answered",
        async () =>
          (await it.read.outbox()).some((c) => c.inbound_id === "cs-1") &&
          (await it.read.outbox()).some((c) => c.inbound_id === "cs-2"),
        90_000,
        async () => JSON.stringify(await it.read.inbound()),
      );

      const cleared = await check({
        machine: "pi",
        registryFile: it.registryFile,
        store,
        os: null,
        kernel: null,
      });
      expect(cleared.filter((f) => f.kind === "runner-silent")).toEqual([]);
      expect((await sheet.rows()).some((r) => r.id === quiet[0].id)).toBe(false);
    } finally {
      if (pi) await pi.stop();
      if (mac) await mac.stop();
      await sheet.close().catch(() => {});
      await store.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);
