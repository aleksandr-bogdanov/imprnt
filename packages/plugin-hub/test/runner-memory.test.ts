// Check: the memory watch is on for every child. (SPEC §6, L4)
//
// L4: "the runner watches every child it spawns. On each tick it reads the
// child's memory. Over the limit from the registry, it kills the child and
// writes one ledger line", worded there as "killed the transcriber at 2.1 GB",
// so the reading AND the limit are both in the line or a human cannot read it.
// The limit lives on the runner's own `[[run]]` entry as
// `child_memory_limit_mb`, because the two machines are an 8 GB Pi and a 16 GB
// Mac and one household number is either too small for one or too big for the
// other. The kill is one ledger line on the `memory` stream and leaves
// the session to be started again on the next turn.
//
// NO UNIT MANAGER, so this runs on both platforms with no gate: the reading is
// `VmRSS` on linux and `ps -o rss=` on darwin, both through the seam, and both
// implementations exist.
//
// THE SECOND AGENT'S CHILD IS THE ONE PUT OVER THE LIMIT, and that is the whole
// design of this check. A runner that watched only the child it happened to
// start first passes every other assertion in this phase and fails this one.
//
// `test/runner-drain.test.ts` stays green: the reading is `/proc` or `ps` and
// not a table, and the ledger line is written at the moment of a kill rather
// than on a tick.
//
// Red reason: behaviour absent. The runner reads no child's memory on any tick
// today, so nothing is ever killed and the `memory` stream stays empty. (The
// plan also tags "export missing, `AdapterSession.pid`", which is a TypeScript
// interface and leaves nothing to assert at run time; the behaviour is what is
// falsifiable and it is what this binds.)

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
  childGone,
  growChild,
  residentBytes,
  scriptedReply,
  survivingHolders,
} from "./helpers/scripted-adapter.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  RUNNER,
  insertInbound,
  plantChatLine,
  stageHub,
} from "./helpers/hub-fixture.ts";

const SLOW = 240_000;
const TICK = 1;
// THE NUMBERS ARE CHOSEN SO A FIXED CONSTANT CANNOT PASS (the
// lead). The old pair was a limit of 300 with a child grown by 700, which a
// build that ignored the registry and killed at a hard-coded 512 MB passed
// while reporting the configured 300 in its ledger line. So:
//
//   the limit          150 MB, well below any constant a build might carry
//   the one over it    grown to 200 MB, over the limit and FAR BELOW 512
//   the control        grown to  80 MB, under the limit and far above zero
//
// Measured on this Mac: the holder child sits at 25.6 MB before it is told to
// hold anything, reaches 105.6 MB on `grow(80)` and 233.6 MB on `grow(200)`.
// So a build killing at 512 leaves the over-limit child alive and fails, and
// one killing at anything below the configured 150 takes the control child
// with it and fails too.
const CHILD_LIMIT_MB = 150;
const GROW_MB = 200;
const CONTROL_GROW_MB = 80;

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  try {
    // INDEPENDENT PROOF, not a cleanup path. The
    // fixture kills the children it still tracks; this asks the platform
    // whether any holder is alive anywhere, so one whose owner forgot it is
    // named here rather than living on until the box is rebooted.
    await until(
      "every memory holder left the box",
      () => survivingHolders().length === 0,
      15_000,
      () => `still holding: ${survivingHolders().join(", ")}`,
    );
  } finally {
    if (cluster) await cluster.stop();
  }
});

function alive(pid: number): boolean {
  return !childGone(pid);
}

test(
  "RUN-12 the memory watch is on for every child and the limit it reads is the registry's: the SECOND agent's child is put over the configured limit but well under any constant a build might carry, and is killed with exactly one ledger line naming the child, a reading in bytes inside a band and the limit, while the first agent's child holds real memory just UNDER the limit and is untouched by pid and still answers, the runner process itself never restarted, the killed agent answers its next message from a NEW session, and the agent that stayed under the limit is never the subject of a memory event at all (SPEC §6, L4, D-81, D-83)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const it = await stageHub(cluster, {
      servers: true,
      adapter: { child: true },
      hub: { tick_seconds: TICK },
      people: [
        { id: PERSON, tree: "/var/lib/imprnt-hub/p1" },
        { id: PERSON2, tree: "/var/lib/imprnt-hub/p2" },
      ],
      agents: [
        { id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}1`, door: DOOR, runner: RUNNER },
      ],
      run: [
        {
          id: DOOR,
          kind: "door",
          platform: "fake",
          person: PERSON,
          token_file: "/dev/null",
          schedule: "always",
          memory_limit_mb: 192,
        },
        {
          id: RUNNER,
          kind: "runner",
          schedule: "always",
          memory_limit_mb: 512,
          // The CHILD's limit, which is not the runner's own.
          child_memory_limit_mb: CHILD_LIMIT_MB,
        },
      ],
    });

    let runner: ReadyProcess | null = null;
    try {
      // The tail turn's message id IS the agent id, so a planted line makes each
      // session self-identifying and the check can map an agent to its child
      // across the process boundary.
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      plantChatLine({
        stateDir: it.stateDir,
        person: PERSON2,
        agent: AGENT2,
        text: "what the second person said yesterday",
      });

      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER,
        it.adapterUrl,
        it.adapterName,
        "child",
      ]);
      const runnerPid = runner.pid;

      // One message on each, so both sessions are live and both children known.
      await insertInbound(cluster, it.db, { id: "mw-1", body: "a first message" });
      await insertInbound(cluster, it.db, {
        id: "mw-2",
        body: "a second message",
        person: PERSON2,
        agent: AGENT2,
      });
      await until(
        "both agents answered",
        async () => (await it.read.outbox()).length >= 2,
        90_000,
        async () => JSON.stringify(await it.read.inbound()),
      );

      const firstChild = it.adapterServer!.childFor(AGENT);
      const secondChild = it.adapterServer!.childFor(AGENT2);
      expect(firstChild).not.toBeNull();
      expect(secondChild).not.toBeNull();
      expect(firstChild).not.toBe(secondChild);
      expect(alive(firstChild!)).toBe(true);
      expect(alive(secondChild!)).toBe(true);
      expect(residentBytes(secondChild!)).toBeLessThan(CHILD_LIMIT_MB * 1024 * 1024);

      // --- THE CONTROL CHILD IS PUT JUST UNDER THE LIMIT, not left at its
      //     floor. A build whose threshold is a constant BELOW the configured
      //     one kills this child too, and an empty `memory` stream for it is
      //     the only thing that says the number came from the registry.
      growChild(firstChild!, CONTROL_GROW_MB);
      await until(
        "the first agent's child is holding real memory and is still under the limit",
        () => {
          const held = residentBytes(firstChild!);
          return held > CONTROL_GROW_MB * 0.8 * 1024 * 1024 && held < CHILD_LIMIT_MB * 1024 * 1024;
        },
        60_000,
        () => `${residentBytes(firstChild!)} bytes against a limit of ${CHILD_LIMIT_MB} MB`,
      );

      // --- put the SECOND agent's child over the limit.
      growChild(secondChild!, GROW_MB);
      await until(
        "the second agent's child really holds more than the limit",
        () => residentBytes(secondChild!) > CHILD_LIMIT_MB * 1024 * 1024,
        60_000,
        () => `${residentBytes(secondChild!)} bytes against a limit of ${CHILD_LIMIT_MB} MB`,
      );

      await until(
        "the runner killed the child that was over its limit",
        () => childGone(secondChild!),
        60_000,
        () =>
          `child ${secondChild} still holds ${residentBytes(secondChild!)} bytes and the memory stream is empty`,
      );

      // --- exactly ONE ledger line, and it is readable by a human.
      const killed = await it.read.ledger({ stream: "memory", kind: "killed.child" });
      expect(killed.length).toBe(1);
      expect(killed[0].actor).toBe("runner");
      expect(killed[0].subject).toBe(AGENT2);
      const detail = killed[0].detail as Record<string, unknown>;
      expect(detail.agent).toBe(AGENT2);
      expect(Number(detail.pid)).toBe(secondChild!);
      expect(Number(detail.reading_bytes)).toBeGreaterThan(CHILD_LIMIT_MB * 1024 * 1024);
      // AND A BAND, not merely "over the limit". The reading is the size that
      // process really was, so it sits between the limit it broke and half as
      // much again as what it was told to hold. A line carrying a constant the
      // build invented, or a kilobyte count read as bytes, is outside it.
      expect(Number(detail.reading_bytes)).toBeLessThan(1.5 * GROW_MB * 1024 * 1024);
      expect(Number(detail.limit_mb)).toBe(CHILD_LIMIT_MB);
      expect(detail.runner).toBe(RUNNER);

      // --- IT DIES ALONE. The other agent's child is the same process, still
      //     holding the memory it was told to hold, and it still answers, which
      //     a pid on its own would not prove.
      expect(it.adapterServer!.childFor(AGENT)).toBe(firstChild);
      expect(alive(firstChild!)).toBe(true);
      expect(residentBytes(firstChild!)).toBeGreaterThan(CONTROL_GROW_MB * 0.8 * 1024 * 1024);
      expect(residentBytes(firstChild!)).toBeLessThan(CHILD_LIMIT_MB * 1024 * 1024);
      const stillHere = "a message for the agent that stayed under the limit";
      await insertInbound(cluster, it.db, { id: "mw-3", body: stillHere });
      await until(
        "the untouched agent answered",
        async () => (await it.read.outbox()).some((c) => c.inbound_id === "mw-3"),
        60_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      expect((await it.read.outbox()).find((c) => c.inbound_id === "mw-3")!.body).toBe(
        scriptedReply(stillHere),
      );
      expect(it.adapterServer!.childFor(AGENT)).toBe(firstChild);

      // --- and the RUNNER never restarted. That is what separates a memory
      //     watch from a crash.
      expect(runner.pid).toBe(runnerPid);
      expect(runner.proc.exitCode).toBeNull();
      expect(alive(runnerPid)).toBe(true);

      // --- the restart half. A killed child is a session that has to be
      //     started again on the next turn, and the runner did not restart to do
      //     it. The child that answers is a DIFFERENT process.
      const startsBefore = it.scripted.starts().length;
      const back = "a message for the agent whose child was killed";
      await insertInbound(cluster, it.db, {
        id: "mw-4",
        body: back,
        person: PERSON2,
        agent: AGENT2,
      });
      await until(
        "the agent whose child was killed answered again",
        async () => (await it.read.outbox()).some((c) => c.inbound_id === "mw-4"),
        90_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      expect((await it.read.outbox()).find((c) => c.inbound_id === "mw-4")!.body).toBe(
        scriptedReply(back),
      );
      expect(it.scripted.starts().length).toBeGreaterThan(startsBefore);
      const pidsForSecond = it.adapterServer!.childPids(AGENT2);
      expect(pidsForSecond.length).toBeGreaterThanOrEqual(2);
      expect(pidsForSecond[pidsForSecond.length - 1]).not.toBe(secondChild);
      expect(runner.pid).toBe(runnerPid);

      // --- THE CONTROL, over the whole check: the agent that stayed under the
      //     limit was never the subject of a memory event, so a runner that
      //     kills everything fails.
      const everyKill = await it.read.ledger({ stream: "memory" });
      expect(everyKill.map((e) => e.subject)).toEqual([AGENT2]);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);
