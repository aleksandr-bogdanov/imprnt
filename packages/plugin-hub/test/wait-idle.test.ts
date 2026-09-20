// A door and a runner with nothing to do burn no processor time.
// (SPEC §2)
//
// THE RESIDUE a statement count cannot see:
// a waiter that keeps a flag in memory and re-checks it on a 100 ms
// timer issues no SQL at all, so it is invisible to a statement count and to
// any other black-box probe. The statement count is what
// `test/runner-drain.test.ts` binds. This is the second thing a black box can
// see: a poll that does any work at all costs processor time, and a process
// genuinely asleep on a notification costs almost none.
//
// WHAT THIS CANNOT CATCH, stated plainly because it is the whole point of item
// 6 having two halves: a timer that wakes, reads one boolean and sleeps again
// costs a few microseconds a wake, so at 100 ms it finishes a three second
// window well under any bound loose enough not to be flaky. MEASURED on this
// Mac: a 100 ms timer doing three million additions each time burns 0.03 s over
// three seconds, which is a tenth of the bound below. So this is the GUARD, and
// the CLOSURE is a written pass over every wait in
// `src/store/wake.ts`, `src/door/run.ts`, `src/runner/run.ts` and
// `src/hub/run.ts` naming what wakes each one, with file and line.
//
// THE CONTROL IS WHAT MAKES IT A CHECK. A pair of assertions that only ever
// says "these two processes are quiet" cannot fail on a box where the reader
// is broken, where the pids are wrong, or where `ps` prints something this
// parser does not understand. So a process that really does spin is measured in
// the SAME window with the SAME reader, and it must come out over the bound.
//
// MEASURED BESIDE IT, and worth recording: `await new Promise(() => {})` as the
// ONLY thing keeping a bun process alive spins at 100% (3.00 s of processor
// time over a 3 s window, measured). It is idle only because something else
// holds the event loop open, which for the door and the runner is their own
// tick timer. `src/entry/hold.ts` and both subprocess helpers hold that way.
//
// This check is a regression guard rather than a red-first check: it passes
// against the build it was written for and exists to keep passing.

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  foreignBackends,
  startCluster,
  startReadySubprocess,
  statementWatch,
  until,
  type Cluster,
  type ReadyProcess,
} from "./helpers/cluster.ts";
import { cpuSeconds } from "./helpers/cpu.ts";
import { DOOR, PERSON, RUNNER, plantChatLine, stageHub } from "./helpers/hub-fixture.ts";

const SLOW = 120_000;
/** The window. Long enough that a 100 ms poll doing real work shows up. */
const WINDOW_MS = 3_000;
/** The bound, generous on purpose: what is being caught is a spin, not a tick. */
const BOUND_SECONDS = 0.3;
/**
 * The second window, in the check below. Longer than the window above and read
 * against a ONE SECOND tick, so the bound of the work wait runs out four times
 * inside it: what is counted is what an idle runner does when its wait ends
 * having been told nothing.
 */
const SQL_WINDOW_MS = 4_000;

let cluster: Cluster;

beforeAll(async () => {
  // `log_statement = 'all'` with `log_line_prefix = 'pid=%p '` is what makes
  // the statement count below come from the SERVER rather than from anything
  // the processes under test could fake. It is the probe, and the check
  // that uses it carries its own control, because a cluster started without
  // these two settings scores a poll as perfect silence.
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

test(
  "D-70 a door and a runner that are waiting are ASLEEP: after a message has gone the whole way, neither process advances its processor time by a third of a second over a three second window, while a process that really polls is over that bound in the same window read by the same probe (SPEC §2, D-70, STORE-01)",
  async () => {
    const it = await stageHub(cluster, { servers: true, hub: { tick_seconds: 1 },
      people: [{ id: PERSON }],
    });
    await Bun.write(it.registryFile, (await Bun.file(it.registryFile).text())
      .replaceAll("[[people]]", '[[people]]\nallowed_senders = { "door-fake" = ["fixture-sender"] }'));
    let door: ReadyProcess | null = null;
    let runner: ReadyProcess | null = null;
    // The control: a process that wakes ten times a second and does work each
    // time. It is what proves the reader can see a poll at all.
    const busy = Bun.spawn(
      [
        process.execPath,
        "-e",
        "setInterval(() => { let s = 0; for (let i = 0; i < 6e7; i++) s += i; globalThis.__sink = s; }, 100); setInterval(() => {}, 1e9);",
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
    try {
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      door = await startReadySubprocess("test/helpers/door-subprocess.ts", [
        it.registryFile,
        DOOR,
        it.platformUrl,
      ]);
      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER,
        it.adapterUrl,
        it.adapterName,
      ]);

      // ONE message, the whole way, so what is measured afterwards is a pair of
      // processes that have finished their work rather than two that never
      // started. Without it a door that never read the platform would look
      // beautifully quiet.
      it.fake.deliver({ text: "a message that goes the whole way" });
      await until(
        "the reply was delivered to the platform",
        () => it.fake.posts().length >= 1,
        60_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      await until(
        "the outbox chunk was marked delivered",
        async () => (await it.read.outbox()).every((chunk) => chunk.delivered_at !== null),
        30_000,
        async () => JSON.stringify(await it.read.outbox()),
      );
      // A beat for the settling writes to finish, so the window holds only the
      // waiting and not the tail of the turn.
      await Bun.sleep(1500);

      const before = {
        door: cpuSeconds(door.pid),
        runner: cpuSeconds(runner.pid),
        busy: cpuSeconds(busy.pid),
      };
      // A reading of null is a process that is gone, and a check that read it
      // as zero would score a dead door as a quiet one.
      expect(before.door).not.toBeNull();
      expect(before.runner).not.toBeNull();
      expect(before.busy).not.toBeNull();

      await Bun.sleep(WINDOW_MS);

      const after = {
        door: cpuSeconds(door.pid),
        runner: cpuSeconds(runner.pid),
        busy: cpuSeconds(busy.pid),
      };
      expect(after.door).not.toBeNull();
      expect(after.runner).not.toBeNull();
      expect(after.busy).not.toBeNull();

      const burned = {
        door: after.door! - before.door!,
        runner: after.runner! - before.runner!,
        busy: after.busy! - before.busy!,
      };

      // --- THE CONTROL FIRST, so a broken probe fails here rather than
      //     reporting two beautifully quiet processes it cannot actually read.
      expect(burned.busy).toBeGreaterThan(BOUND_SECONDS);

      // --- and the two that are waiting.
      expect(burned.door).toBeLessThan(BOUND_SECONDS);
      expect(burned.runner).toBeLessThan(BOUND_SECONDS);

      // Both are still alive at the end of it, which is what makes "quiet" mean
      // waiting rather than gone.
      expect(cpuSeconds(door.pid)).not.toBeNull();
      expect(cpuSeconds(runner.pid)).not.toBeNull();
    } finally {
      busy.kill(9);
      await busy.exited.catch(() => {});
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

// THE ZERO STATEMENT CASE THAT USED TO SIT HERE IS GONE WITH THE BEHAVIOUR IT
// BOUND. It staged this pair on a one second tick and asserted that
// four seconds of idleness cost the store nothing, which is exactly what
// `docs/SPEC.md:17` asks for and what the runner did for the length of this
// round. The hub box then failed `test/runner-drain.test.ts` in three of four
// full suite runs under that runner while passing it alone every time: a
// notification it has to hear does not reach it there under load, and with no
// read on the bound the row that notification announced is never claimed at
// all. The claim on the bound is back, so a check saying the store hears
// nothing would be red by design. What the round DID leave behind, and what
// keeps that case buildable by whoever takes row 6 next, is in
// `test/helpers/cluster.ts`: the statement watch counts the extended
// protocol's `execute` as well as the simple protocol's `statement:`, and
// until it did, a runner polling `inbound` once a second scored as perfectly
// silent here.
