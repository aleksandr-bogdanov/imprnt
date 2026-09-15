// Check: a worker spawned from chat is a child of its runner with no service
// file. (SPEC §6, D7, RUN-03)
//
// D7's second kind of process: "a worker or a model child is a child of its
// runner, with no unit." A non-model worker does not exist yet, so what binds
// the rule today is the model child, which is the other half of the same
// ruling. The first phase with a worker proper re-runs these assertions against
// it and they need no new shape.
//
// THE WHOLE CHECK IS GATED, WHICH DEVIATES FROM 03-03 TASK 3 AND IS DELIBERATE.
// The plan wants the parentage half ungated, so a closed gate narrows the check
// rather than removing it. In THIS round that would be a test that cannot fail:
// the parentage half passes against shipped code (the child's parent is the
// runner because the adapter client spawns it there), and only the no-unit half
// is red. An ungated half would therefore report a PASS on every box whose gate
// is shut, including CI, which is the silent pass this phase forbids. A visible
// skip with its reason in the name is the honest answer until `src/os/index.ts`
// exists, and the build round can split this file in two once it does.
//
// Red reason: import missing, `src/os/index.ts`, which is what the no-unit half
// reads. (The plan tags "export missing, `AdapterSession.pid`"; that is a
// TypeScript interface and leaves nothing to assert at run time, so the
// falsifiable half is the unit snapshot. Recorded in RED-RUN-1.md.)

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdirSync } from "node:fs";
import {
  startCluster,
  seam,
  startReadySubprocess,
  until,
  type Cluster,
  type ReadyProcess,
} from "./helpers/cluster.ts";
import { childGone, survivingHolders } from "./helpers/scripted-adapter.ts";
import { osGate, gateSuffix, announceGate } from "./helpers/os-gate.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import { AGENT, insertInbound, plantChatLine, stageHub, RUNNER } from "./helpers/hub-fixture.ts";

const SLOW = 180_000;

const gate = osGate();
const fixture: UnitFixture = unitFixture();
let cluster: Cluster;

let foreignBefore: string[] = [];

beforeAll(async () => {
  announceGate(gate, "check 12, a model child with no service file");
  cluster = await startCluster();
  if (gate.ok) foreignBefore = (await fixture.foreignWatched()).sort();
});

afterAll(async () => {
  try {
    // This check creates no unit at all: the point is that none appears. The
    // fixture is still asked, so a future edit that plants one cannot leak it.
    await fixture.removeAll();
    // And no holder child outlived the file, asked of the platform rather than
    // of the fixture's own list (the second seat's finding about cleanup being
    // a path rather than a proof).
    await until(
      "every model child left the box",
      () => survivingHolders().length === 0,
      15_000,
      () => `still holding: ${survivingHolders().join(", ")}`,
    );
  } finally {
    // THE CENSUS, which the second seat found missing from this file. A check
    // whose whole subject is that NO unit appears is the last one that should
    // be unable to say whether one did.
    if (gate.ok) {
      const after = (await fixture.listWatched()).sort();
      if (JSON.stringify(after) !== JSON.stringify(foreignBefore)) {
        throw new Error(
          `this file disturbed the box: watch-prefix units were\n${foreignBefore.join(", ")}\nand are now\n${after.join(", ")}`,
        );
      }
    }
    if (cluster) await cluster.stop();
  }
});

function ppidOf(pid: number): number {
  const out = Bun.spawnSync(
    process.platform === "linux"
      ? ["sh", "-c", `awk '{print $4}' /proc/${pid}/stat`]
      : ["ps", "-o", "ppid=", "-p", String(pid)],
    { stdout: "pipe", stderr: "pipe" },
  );
  return Number((out.stdout?.toString() ?? "").trim());
}

test.skipIf(!gate.ok)(
  `RUN-03 a model child is a child of its runner and no service file appears for it: its parent pid read from the platform's own truth is the runner's, it is not the runner itself, and between a snapshot taken before the session opened and one taken after, no unit under the watch prefix and no file in the manager's own directory names the agent or the child (SPEC §6, D7)${gateSuffix(gate)}`,
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const it = await stageHub(cluster, { servers: true, adapter: { child: true } });
    let runner: ReadyProcess | null = null;
    try {
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });

      // The snapshots are taken BEFORE the runner exists, so a unit that was
      // already there cannot make the assertion pass or fail by accident.
      const unitsBefore = (await fixture.listWatched()).sort();
      const filesBefore = readdirSync(fixture.unitDir()).sort();

      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER,
        it.adapterUrl,
        it.adapterName,
        "child",
      ]);
      await insertInbound(cluster, it.db, { id: "rc-1", body: "a message that opens a session" });
      await until(
        "the agent answered, so a session is live",
        async () => (await it.read.outbox()).length >= 1,
        90_000,
        async () => JSON.stringify(await it.read.inbound()),
      );

      // --- THE PARENTAGE HALF. It passes against shipped code today (residue),
      //     so it is here as the guard criterion 4 names, never as the red.
      const child = it.adapterServer!.childFor(AGENT);
      expect(child).not.toBeNull();
      expect(childGone(child!)).toBe(false);
      // Not the runner itself: a build that reported the runner's own pid as the
      // session's would make every memory assertion in this phase meaningless.
      expect(child).not.toBe(runner.pid);
      // Read from the platform, never from the adapter.
      expect(ppidOf(child!)).toBe(runner.pid);

      // --- THE NO-UNIT HALF.
      const { thisOs } = await seam("src/os/index.ts");
      expect(typeof thisOs).toBe("function");
      const os = (thisOs as Function)({ unitDir: fixture.unitDir() }) as {
        list(): Promise<Record<string, unknown>[]>;
      };

      const listed = (await os.list()).map((u) => String(u.name)).sort();
      const appeared = listed.filter((n) => !unitsBefore.includes(n));
      // "No service file" is the criterion's own phrase, so the directory is
      // read as well as the manager.
      const filesAppeared = readdirSync(fixture.unitDir())
        .sort()
        .filter((f) => !filesBefore.includes(f));

      expect(appeared).toEqual([]);
      expect(filesAppeared).toEqual([]);
      for (const name of [...listed, ...readdirSync(fixture.unitDir())]) {
        expect(name).not.toContain(AGENT);
        expect(name).not.toContain(String(child));
        expect(name).not.toContain(String(runner.pid));
      }
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);
