// A restart request is acted on by the hub, and one aimed at the
// asker's own unit is refused. (SPEC §6, L11, D7)
//
// L11: a restart request is "acted on by the hub process. The agent being
// restarted never reads the request, and the agent carrying the request can
// never restart itself." Never the agent being restarted, never the
// asker's own unit. The request is a ledger row on the `restart`
// stream, the hub's refusal a `refusal` row with kind `refused.restart` naming
// both ids, and the hub's watermark is what makes a request act exactly once.
//
// `[partial]`, and why: the only writer of a request
// is the command line, where the asker has no unit, so `asked_by === target` is
// SUPPLIED by this check rather than produced by a caller. The path that makes
// the shape reachable in production is "typed in any chat" (L11), which needs
// the door or the runner to recognise a request in a human's message, and that
// is the work. What this check binds is real code either way: the hub's
// own refusal, its ledger line, and the pid that did not change.
//
// Red reason: import missing, src/hub/restart.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, seam, until, type Cluster, type ReadyProcess } from "./helpers/cluster.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { managerPid } from "./helpers/manager.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import { stageHub, startHub, superStore } from "./helpers/hub-fixture.ts";
import { writeRegistry, type RunSpec } from "./helpers/registry.ts";

const SLOW = 180_000;
const TICK = 1;

const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];
let cluster: Cluster;

beforeAll(async () => {
  if (gate.ok) foreignBefore = (await fixture.foreignWatched()).sort();
  announceGate(gate, "check 8, the restart request and its two refusals");
  cluster = await startCluster();
});

afterAll(async () => {
  try {
    await fixture.removeAll();
  } finally {
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

test.skipIf(!gate.ok)(
  `RUN-10 a restart request is acted on by the hub and its two shapes are refused: the targeted unit's pid changes and the OTHER unit wears ONE pid for the whole check, a request whose asker is its own target leaves that pid alone and writes a refusal naming both ids, a request aimed at the hub's own entry is refused the same way, and the number of pid changes equals the number of ledger lines, which is ONE (SPEC §6, L11, D7, D-80)${gateSuffix(gate)}`,
  async () => {
    const { RESTART_STREAM, requestRestart, readRequests, refuseRestart } = await seam(
      "src/hub/restart.ts",
    );
    expect(typeof requestRestart).toBe("function");
    expect(typeof readRequests).toBe("function");
    expect(typeof refuseRestart).toBe("function");
    expect(RESTART_STREAM).toBe("restart");

    const machine = thisMachine();
    const a = fixture.entryId("unit-a");
    const b = fixture.entryId("unit-b");
    // The hub's OWN entry. It is `on demand` deliberately: what this check is
    // about is the refusal, and a registry that had the hub install a second hub
    // process on this box would be testing something else entirely.
    const hubEntry = fixture.entryId("hub-self");

    const it = await stageHub(cluster, {
      hub: { tick_seconds: TICK, restart_delay_seconds: 1, give_up_after: 5, give_up_window_seconds: 300 },
      machines: [machine],
      run: [],
    });
    const run: RunSpec[] = [
      { id: a, kind: "runner", machine: machine.id, schedule: "always", memory_limit_mb: 64, child_memory_limit_mb: 64 },
      { id: b, kind: "runner", machine: machine.id, schedule: "always", memory_limit_mb: 64, child_memory_limit_mb: 64 },
      { id: hubEntry, kind: "hub", machine: machine.id, schedule: "on demand", memory_limit_mb: 64 },
    ];
    writeRegistry(it.stateDir, {
      hub: {
        store_url: it.storeUrl,
        state_dir: it.stateDir,
        tick_seconds: TICK,
        restart_delay_seconds: 1,
        give_up_after: 5,
        give_up_window_seconds: 300,
      },
      machines: [machine],
      run,
    });

    const store = await superStore(cluster, it.db);
    let hub: ReadyProcess | null = null;

    // The pid read from the MANAGER's own record rather than from the hub, so
    // "this pid did not change" is a fact about a process.
    const pidOf = async (id: string): Promise<number> => managerPid(`imprnt-hub-${id}`) ?? 0;

    // EVERY pid either unit ever had, sampled through the whole check.
    // "exactly once" was asserted only through a count
    // of ledger lines, so a hub that restarted A over and over while writing
    // one deduplicated event passed. A restart IS a new pid, so the set of pids
    // each unit wore is the independent count, and it is compared against the
    // ledger's at the end.
    const wore: Record<string, Set<number>> = { [a]: new Set(), [b]: new Set() };
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        for (const id of [a, b]) {
          const pid = managerPid(`imprnt-hub-${id}`);
          if (pid && pid > 0) wore[id].add(pid);
        }
        await Bun.sleep(250);
      }
    })();

    try {
      hub = await startHub(it.registryFile, machine.id, fixture.unitDir());
      const hubPid = hub.pid;

      await until(
        "the hub installed and started both units",
        async () => (await pidOf(a)) > 0 && (await pidOf(b)) > 0,
        90_000,
        async () => (await fixture.listWatched()).join(", "),
      );
      const aBefore = await pidOf(a);
      const bBefore = await pidOf(b);
      const restarted = async (subject: string) =>
        (await it.read.ledger({ stream: "machine", kind: "unit.restarted" })).filter(
          (e) => e.subject === subject,
        );
      const refusals = async () =>
        (await it.read.ledger({ stream: "refusal", kind: "refused.restart" })).map((e) => e.detail);

      // --- THE CONTROL FIRST. A refusal check with no control is a check on a
      //     system that refuses everything.
      await (requestRestart as Function)(store, {
        target: a,
        askedBy: b,
        why: "the first one stopped answering",
      });
      await until(
        "the targeted unit was restarted",
        async () => (await pidOf(a)) > 0 && (await pidOf(a)) !== aBefore,
        60_000,
        async () => `a=${await pidOf(a)} was ${aBefore}`,
      );
      expect((await restarted(a)).length).toBe(1);
      expect((await restarted(a))[0].actor).toBe("hub");
      // The unchanged pid of B is what makes this "restart the one that was
      // asked for" rather than "restart something".
      expect(await pidOf(b)).toBe(bBefore);

      // --- REFUSAL ONE: the asker's own unit.
      await (requestRestart as Function)(store, {
        target: b,
        askedBy: b,
        why: "restart me",
      });
      await until(
        "the hub wrote a refusal",
        async () => (await refusals()).length >= 1,
        60_000,
        async () => JSON.stringify(await it.read.ledger({ stream: "refusal" })),
      );
      await Bun.sleep(TICK * 3000);
      expect(await pidOf(b)).toBe(bBefore);
      expect(await restarted(b)).toEqual([]);
      const first = (await refusals())[0] as Record<string, unknown>;
      // A refusal that says only that something went wrong is the silence L14's
      // loud-refusal rule exists to replace, so the detail is asserted BY KEY.
      expect(first.target).toBe(b);
      expect(first.asked_by).toBe(b);
      expect(typeof first.reason === "string" ? first.reason : first.why).toBeTruthy();

      // --- REFUSAL TWO: the hub's own entry. The hub never restarts the thing
      //     doing the restarting (D7's one hub per machine).
      await (requestRestart as Function)(store, {
        target: hubEntry,
        askedBy: a,
        why: "restart the hub",
      });
      await until(
        "the hub wrote a second refusal",
        async () => (await refusals()).length >= 2,
        60_000,
        async () => JSON.stringify(await refusals()),
      );
      await Bun.sleep(TICK * 3000);
      expect(hub.pid).toBe(hubPid);
      expect(await restarted(hubEntry)).toEqual([]);
      const second = (await refusals())[1] as Record<string, unknown>;
      expect(second.target).toBe(hubEntry);
      expect(second.asked_by).toBe(a);

      // --- THE WATERMARK. Several more ticks, and A was restarted exactly ONCE
      //     in total. A hub that re-read the whole `restart` stream every tick
      //     would restart A forever, which the household would experience as an
      //     agent that never answers.
      await Bun.sleep(TICK * 6000);
      expect((await restarted(a)).length).toBe(1);
      expect((await refusals()).length).toBe(2);

      // THE PIDS AND THE LEDGER LINES ARE THE SAME NUMBER. A had exactly two
      // pids in its life, which is exactly one restart, and the ledger says
      // one. A hub that bounced it every tick while writing one event has more
      // pids than lines and fails here rather than passing a count.
      sampling = false;
      await sampler;
      expect(wore[a].size - 1).toBe((await restarted(a)).length);
      expect(wore[a].size).toBe(2);
      expect([...wore[a]]).toContain(aBefore);
      // And B, which nobody legitimately asked to restart, wore ONE pid for the
      // whole check: not "the same at the end", the same throughout.
      expect([...wore[b]]).toEqual([bBefore]);
      expect(await pidOf(b)).toBe(bBefore);

      // And the requests are readable after a watermark, which is the mechanism
      // that makes "exactly once" possible at all.
      const requests = (await (readRequests as Function)(store, { after: 0 })) as unknown[];
      expect(requests.length).toBe(3);
      const laterOnly = (await (readRequests as Function)(store, {
        after: Number.MAX_SAFE_INTEGER,
      })) as unknown[];
      expect(laterOnly).toEqual([]);

      // `refuseRestart` is the hub's own verb and is exported so a caller can
      // see the shape it writes.
      expect(typeof refuseRestart).toBe("function");
    } finally {
      sampling = false;
      await sampler.catch(() => {});
      if (hub) await hub.stop();
      await store.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);
