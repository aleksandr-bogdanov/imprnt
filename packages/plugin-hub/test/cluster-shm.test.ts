// 03b item 9. The suite does not cost this Mac a shared memory slot every time
// a run is interrupted. (SPEC §8)
//
// BUILD-NOTES B.3 and RED-RUN-2's environment note, in its own words: "The Mac
// runs out of System V shared memory before it runs out of anything else, and
// that is the one item on this list that bites mechanically rather than
// conceptually. `kern.sysv.shmmni` is 32, each throwaway cluster holds one
// segment, and a cluster killed rather than stopped leaks it, so an interrupted
// run permanently costs the box a slot. After about 30 interrupted runs every
// `initdb` in the suite fails with `could not create shared memory segment: No
// space left on device` and the suite reports a setup error that says nothing
// about the real cause." That is a check round's own tooling eating the machine
// it runs on, and it is the reason the phase 3 red run had to be started twice.
//
// THE FIX HAS TWO HALVES and this file now binds both: `test/helpers/cluster.ts`
// stops every cluster it started when the process leaves by any route, AND
// sweeps before `initdb`, on darwin, the segments this user owns that have zero
// processes attached and whose creator is dead. The second is what the first
// check here leaks a segment on purpose to see. The first was called
// uncheckable because a check cannot observe its own death, and the second
// check below is the answer to that: the process that dies is a CHILD, and this
// file is the one watching it (VERIFY-CODEX row 9).
//
// THE ORACLE IS AN ID DIFF AND NOT THE RULE UNDER TEST. The sweep decides what
// to remove by ownership, attach count and a dead creator. A check that found
// the leaked segment the same way would agree with an implementation that had
// the same bug, so this names its own segment by diffing `ipcs -m` either side
// of the cluster it started, and the `afterAll` removes only an id it watched
// appear. Nothing here ever touches a segment that was on the box before it.
//
// DARWIN ONLY: Linux clusters use POSIX shared memory for the same job and
// `kern.sysv.shmmni` has no equivalent there, so there is nothing to leak and
// nothing to sweep.
//
// Red reason: behaviour absent. `test/helpers/cluster.ts` has no sweep and no
// exit handler, so the segment the killed cluster left is still on the box
// after the next `startCluster`, with zero processes attached.

import { test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hubPath, startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { removeSegment, segmentById, segmentIds } from "./helpers/shm.ts";

const SLOW = 150_000;
const darwin = process.platform === "darwin";

/** Only ids this file WATCHED APPEAR. Never anything that was here before. */
const mine = new Set<number>();
const clusters: Cluster[] = [];

afterAll(async () => {
  for (const one of clusters) await one.stop().catch(() => {});
  // If the code under test did not sweep, this file does, so the box is left
  // exactly as it was found whether the check passed or failed.
  for (const id of mine) {
    const still = segmentById(id);
    if (still && still.attached === 0) removeSegment(id);
  }
  const left = [...mine].filter((id) => segmentById(id) !== null);
  if (left.length > 0) {
    throw new Error(`this file left shared memory segments on the box: ${left.join(", ")}`);
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.skipIf(!darwin)(
  `SPEC §8 a killed cluster's shared memory does not accumulate: the segment a cluster held is still on the box with nobody attached after its postmaster is killed with -9, and starting the next cluster clears it, so a suite that is interrupted thirty times does not exhaust kern.sysv.shmmni${
    darwin ? "" : " [skipped: System V shared memory is exhausted by Postgres on darwin only]"
  }`,
  async () => {
    const before = new Set(segmentIds());

    // --- one cluster, and the segment it took.
    const leaky = await startCluster();
    clusters.push(leaky);
    const after = segmentIds().filter((id) => !before.has(id));
    expect(after.length).toBe(1);
    const segment = after[0];
    mine.add(segment);
    expect(segmentById(segment)!.attached).toBeGreaterThan(0);

    // --- killed, not stopped, which is what an interrupted run does to it.
    const postmaster = Number(
      readFileSync(join(leaky.dataDir, "postmaster.pid"), "utf8").split("\n")[0].trim(),
    );
    expect(postmaster).toBeGreaterThan(0);
    process.kill(postmaster, 9);
    await until("the postmaster really went away", () => !alive(postmaster), 20_000);

    // --- THE LEAK ITSELF. Nobody is attached and the segment is still there,
    //     which is the state that costs the box a slot forever.
    await until(
      "the killed cluster's segment has nobody attached",
      () => {
        const one = segmentById(segment);
        return one !== null && one.attached === 0;
      },
      20_000,
      () => `segment ${segment} has ${segmentById(segment)?.attached ?? "no row"}`,
    );

    // --- and the next cluster clears it on its way up. This is the assertion
    //     that is red today.
    const next = await startCluster();
    clusters.push(next);
    for (const id of segmentIds().filter((id) => !before.has(id) && id !== segment)) mine.add(id);
    // Phrased so the FAILURE prints a segment id and an attach count and never
    // the row itself: `ipcs` names the owning account, the repository is
    // public, and a red run's output is a file.
    const swept = segmentById(segment);
    expect(swept === null ? "gone" : `still there with ${swept.attached} attached`).toBe("gone");

    // --- THE CONTROL beside it: the cluster that is actually running keeps
    //     ITS segment. A sweep that took every segment on the box would break
    //     the run it is part of, and this is what says it did not.
    const live = segmentIds().filter((id) => !before.has(id));
    expect(live.length).toBeGreaterThanOrEqual(1);
    expect(live.every((id) => segmentById(id)!.attached > 0)).toBe(true);
    // And nothing that was on the box before this check began was touched.
    for (const id of before) expect(segmentById(id)).not.toBeNull();
  },
  SLOW,
);
test.skipIf(!darwin)(
  `SPEC §8 a run that is interrupted really ends, and takes its cluster's shared memory with it: a child that started a cluster and was sent SIGINT is gone within ten seconds, its postmaster with it, and the segment that cluster held is not left on the box with nobody attached${
    darwin ? "" : " [skipped: System V shared memory is exhausted by Postgres on darwin only]"
  }`,
  async () => {
    // WHAT THIS IS FOR (VERIFY-CODEX row 9). The check above kills the
    // POSTMASTER, which is not the process that owns the cleanup handlers, so
    // reinstating the signal-handler defect REVIEW.md D1 found (re-raise with
    // the listener still attached, which re-enters the handler and burns
    // processor time forever) would pass it untouched. The process that has to
    // be signalled is the one holding the handlers, and here it is a child.
    //
    // Measured when that defect was live, `bun -e`, a process of this exact
    // shape: still alive 5000 ms after its SIGINT with 5.45 s of processor time
    // burned. With the listener removed before the re-raise, 28 ms.
    const before = new Set(segmentIds());

    const child = Bun.spawn(
      [process.execPath, "run", hubPath("test/helpers/cluster-subprocess.ts")],
      { cwd: hubPath("."), stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    let root: string | null = null;
    try {
      // Its one ready line, so what is signalled below is a process whose
      // cluster is really up rather than one still running `initdb`.
      const said = await Promise.race([
        (async () => {
          const reader = child.stdout.getReader();
          const decoder = new TextDecoder();
          let seen = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (value) seen += decoder.decode(value, { stream: true });
            const line = seen.split("\n").find((one) => one.trim().startsWith("{"));
            if (line) return JSON.parse(line) as { pid: number; dataDir: string };
            if (done) throw new Error("the child ended before it said it was up");
          }
        })(),
        Bun.sleep(120_000).then(() => {
          throw new Error("the child never said it was up");
        }),
      ]);
      root = dirname(said.dataDir);

      const grew = segmentIds().filter((id) => !before.has(id));
      expect(grew.length).toBe(1);
      const segment = grew[0];
      mine.add(segment);
      expect(segmentById(segment)!.attached).toBeGreaterThan(0);

      const postmaster = Number(
        readFileSync(join(said.dataDir, "postmaster.pid"), "utf8").split("\n")[0].trim(),
      );
      expect(postmaster).toBeGreaterThan(0);
      expect(alive(postmaster)).toBe(true);

      // --- THE INTERRUPT, the way a person's own does it.
      const sent = Date.now();
      child.kill(2);
      const left = await Promise.race([
        child.exited.then(() => "left" as const),
        Bun.sleep(10_000).then(() => "still here" as const),
      ]);
      if (left !== "left") {
        // A hung child is this file's to take off the box whatever the verdict.
        child.kill(9);
        await child.exited.catch(() => {});
      }
      expect(`${left} after ${Date.now() - sent < 10_000 ? "under" : "over"} ten seconds`).toBe(
        "left after under ten seconds",
      );

      // --- ITS CLUSTER WENT WITH IT. The handler's whole job.
      await until(
        "the child's postmaster went away with it",
        () => !alive(postmaster),
        10_000,
        () => `the postmaster is still running`,
      );

      // --- AND NOTHING WAS LEFT ON THE BOX. Phrased so a failure prints an id
      //     and an attach count and never the `ipcs` row, which names the
      //     owning account and this repository is public.
      await until(
        "the segment the child's cluster held is gone",
        () => segmentById(segment) === null,
        10_000,
        () => `segment ${segment} has ${segmentById(segment)?.attached ?? "no row"} attached`,
      );
      const stranded = segmentIds().filter(
        (id) => !before.has(id) && (segmentById(id)?.attached ?? 1) === 0,
      );
      expect(stranded).toEqual([]);
      // And nothing that was on the box before this check began was touched.
      for (const id of before) expect(segmentById(id)).not.toBeNull();
    } finally {
      child.kill(9);
      await child.exited.catch(() => {});
      // The child stops its cluster and leaves its scratch directory, because
      // an `exit` handler may not await. This file is what takes it off.
      if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  },
  SLOW,
);
