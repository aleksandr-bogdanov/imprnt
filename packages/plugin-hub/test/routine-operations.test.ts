// Check: the routine-operations smoke shows no process id changed and every
// operation took effect. (SPEC §6, L11)
//
// L11: "anything done from the chat or the command line as part of daily use
// takes effect without restarting any process." Its Forbidden lines: "a routine
// operation waiting on a restart" and "a process that reads its configuration
// only at startup."
//
// TWO CHECKS, DELIBERATELY SPLIT (D-88). The first half needs no operating
// system at all, so a box with no user manager, including a CI runner, still
// proves it. A single gated smoke would take the whole criterion down with it.
//
// WHAT THIS SMOKE DOES NOT RUN, named here rather than smuggled in. RUN-09 also
// lists editing an allowlist, adding, editing or pausing a watch, renaming or
// deleting a channel, and sleeping or waking an agent. Phase 3 has none of them:
// the ACL is D6 and is deferred past v3.0, watches are phase 6, channels are
// phase 4 and 6, and no sleep-or-wake concept exists yet.
//
// THE MESSAGES GO THROUGH THE PLATFORM (D-104, the second seat's lead). A row
// inserted into the store behind the door's back asks only whether the RUNNER
// noticed the registry edit, and a door that reads its agent set once at start
// passes that. A human typing to a newly added agent is typing into a chat
// somebody has to be pulling, so the message enters the way a human's does and
// the whole path has to have noticed: the door pulls the new chat, writes the
// row, and the runner answers it.
//
// Red reasons: check 9 behaviour absent, `src/runner/run.ts` reads
// `agentsFor(first, { runner })` ONCE at start and `src/door/run.ts` reads
// `agentsFor(registry, { door })` ONCE at start, so an agent added to the file
// is neither pulled nor served without a restart. Check 10 import missing,
// `src/hub/run.ts`.

import { writeRegistry, stageHub } from "./helpers/authorized-registry.ts";
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
import { scriptedReply } from "./helpers/scripted-adapter.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { expectedPresetId } from "./helpers/preset-oracle.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { livePid, managerState, pidAlive } from "./helpers/manager.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
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
  startHub,
} from "./helpers/hub-fixture.ts";
import {
  type AgentSpec,
  type PersonSpec,
  type RegistrySpec,
  type RunSpec,
} from "./helpers/registry.ts";

const SLOW = 240_000;
const TICK = 1;

const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];
let cluster: Cluster;

beforeAll(async () => {
  announceGate(gate, "check 10, the unit-level routine operations");
  cluster = await startCluster();
  if (gate.ok) foreignBefore = (await fixture.foreignWatched()).sort();
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

test(
  "RUN-09 the routine operations that need no operating system take effect with no process restarted: a person added, an agent added whose message arrives THROUGH THE PLATFORM and is answered, an agent removed whose chat is no longer pulled while another agent answers in the same window, and a model changed so the next turn record carries the new preset id, with the door's and the runner's pids read from the OS again at the end (SPEC §6, L11, D-87, D-88, D-104)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");

    const it = await stageHub(cluster, {
      servers: true,
      hub: { tick_seconds: TICK },
      people: [{ id: PERSON, tree: "/var/lib/imprnt-hub/p1" }],
    });

    const preset = {
      adapter: it.adapterName,
      model: "a-model-name",
      provider: "a-provider",
      effort: "medium",
      paid: "plan",
    };
    const rewrite = (over: {
      people?: PersonSpec[];
      agents?: AgentSpec[];
      model?: string;
    }): string => {
      const spec: RegistrySpec = {
        hub: { store_url: it.storeUrl, state_dir: it.stateDir, tick_seconds: TICK },
        people: over.people ?? [{ id: PERSON, tree: "/var/lib/imprnt-hub/p1" }],
        presets: { daily: { ...preset, model: over.model ?? preset.model } },
        agents: over.agents ?? [
          { id: AGENT, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: RUNNER },
        ],
      };
      return writeRegistry(it.stateDir, spec);
    };
    expect(rewrite({})).toBe(it.registryFile);

    let door: ReadyProcess | null = null;
    let runner: ReadyProcess | null = null;
    try {
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      plantChatLine({
        stateDir: it.stateDir,
        person: PERSON2,
        agent: AGENT2,
        text: "what the second person said yesterday",
      });

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
      const doorPid = door.pid;
      const runnerPid = runner.pid;

      // --- 1. ADD A PERSON. A registry file edit and nothing else. It has
      //     taken effect when the file still loads and the agent added next may
      //     name the new person, which is what operation 2 proves.
      const people: PersonSpec[] = [
        { id: PERSON, tree: "/var/lib/imprnt-hub/p1" },
        { id: PERSON2, tree: "/var/lib/imprnt-hub/p2" },
      ];
      rewrite({ people });
      expect(loadRegistry(it.registryFile)).toBeDefined();
      expect(door.pid).toBe(doorPid);
      expect(runner.pid).toBe(runnerPid);

      // --- 2. ADD AN AGENT, on the same runner and the same door. THIS is the
      //     assertion that is red today, and it is red for BOTH processes:
      //     `src/runner/run.ts` reads `agentsFor(first, { runner })` once at
      //     start and `src/door/run.ts` reads `agentsFor(registry, { door })`
      //     once at start, so a new agent is neither pulled nor served without
      //     a restart, and RUN-09 forbids that.
      //
      //     THE MESSAGE COMES IN THROUGH THE PLATFORM, which is the second
      //     seat's lead and D-104's reason. Inserting it into the store behind
      //     the door's back asks only the runner to have noticed; a human
      //     typing to a new agent reaches a chat the door has to be pulling.
      //     So the whole path is exercised: the door notices the new agent,
      //     pulls its chat, writes the row, and the runner answers it.
      const both: AgentSpec[] = [
        { id: AGENT, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: RUNNER },
        { id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}1`, door: DOOR, runner: RUNNER },
      ];
      rewrite({ people, agents: both });
      const hello = "a message for the agent that was just added";
      it.fake.deliver({ chat: `${CHAT}1`, from: PERSON2, text: hello });
      await until(
        "the agent added to the file was pulled by the door and served by the runner, with nothing restarted",
        async () => (await it.read.outbox()).some((c) => c.body === scriptedReply(hello)),
        25_000,
        async () =>
          `inbound: ${JSON.stringify(await it.read.inbound())} pulls: ${it.fake.pulls().length}`,
      );
      // The row the door wrote names the new agent and the new person, so a
      // door that pulled the chat onto the OLD agent fails here.
      const added = (await it.read.inbound()).find((r) => r.body === hello)!;
      expect(added).toBeDefined();
      expect(added.agent).toBe(AGENT2);
      expect(added.person).toBe(PERSON2);
      expect(runner.pid).toBe(runnerPid);
      expect(door.pid).toBe(doorPid);
      expect(pidAlive(runnerPid)).toBe(true);

      // And the person the new agent names is readable off the file, which is
      // the other half of operation 1 having taken effect.
      const { listPeople } = await seam("src/registry/entries.ts");
      expect(typeof listPeople).toBe("function");
      expect(
        ((listPeople as Function)(loadRegistry(it.registryFile)) as { id: string }[]).map(
          (p) => p.id,
        ),
      ).toEqual([PERSON, PERSON2]);

      // --- 3. REMOVE AN AGENT. Its messages are left alone, and in the SAME
      //     window another agent answers, so a runner that froze completely
      //     cannot pass.
      rewrite({
        people,
        agents: [
          { id: AGENT, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: RUNNER },
        ],
      });
      await Bun.sleep(TICK * 3000);
      await insertInbound(cluster, it.db, {
        id: "ro-removed",
        body: "a message for the agent that left the file",
        person: PERSON2,
        agent: AGENT2,
      });
      // AND THROUGH THE PLATFORM, which is the other half of the same rule: a
      // chat whose agent left the file is a chat the door no longer pulls, so
      // no row is ever written for it. There is no refusal event to assert
      // here, and inventing one would be a check introducing a seam the
      // contract lacks: the door pulls the chats its agents name, so an
      // unlisted chat is never read and there is nothing to refuse.
      const gone = "a platform message for the agent that left the file";
      it.fake.deliver({ chat: `${CHAT}1`, from: PERSON2, text: gone });
      const live = "a message for the agent that is still listed";
      await insertInbound(cluster, it.db, { id: "ro-live", body: live });
      await until(
        "the agent still in the file answered",
        async () => (await it.read.outbox()).some((c) => c.inbound_id === "ro-live"),
        60_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      const parked = (await it.read.inbound()).find((r) => r.id === "ro-removed")!;
      expect(parked.state).toBe("received");
      expect(parked.claimed_by).toBeNull();
      expect((await it.read.outbox()).some((c) => c.inbound_id === "ro-removed")).toBe(false);
      // The platform-delivered one never became a row at all, in a window where
      // the listed agent's message went the whole way. A door that kept pulling
      // the removed agent's chat fails here.
      expect((await it.read.inbound()).some((r) => r.body === gone)).toBe(false);
      expect((await it.read.outbox()).some((c) => c.body === scriptedReply(gone))).toBe(false);
      expect(runner.pid).toBe(runnerPid);
      expect(door.pid).toBe(doorPid);

      // --- 4. CHANGE A MODEL. The next turn record carries the new preset id,
      //     computed by the TEST from the pinned formula rather than read from
      //     the code under test, and the adapter was asked to start a new
      //     session (D-73: a preset change restarts the CHILD, never the
      //     process).
      const startsBefore = it.scripted.starts().length;
      rewrite({ people, model: "a-different-model-name" });
      const after = "a message that lands on the new model";
      await insertInbound(cluster, it.db, { id: "ro-model", body: after });
      await until(
        "the message on the new model was answered",
        async () => (await it.read.outbox()).some((c) => c.inbound_id === "ro-model"),
        60_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      const turn = (await it.read.ledger({ stream: "turn" })).find(
        (t) => t.subject === "ro-model",
      )!;
      expect(turn).toBeDefined();
      expect(turn.detail.preset_id).toBe(
        expectedPresetId({ ...preset, model: "a-different-model-name" }),
      );
      expect(it.scripted.starts().length).toBeGreaterThan(startsBefore);
      expect(runner.pid).toBe(runnerPid);

      // --- and the final assertion over all four, read from the operating
      //     system again rather than from a variable set at the start.
      expect(pidAlive(doorPid)).toBe(true);
      expect(pidAlive(runnerPid)).toBe(true);
      expect(door.proc.exitCode).toBeNull();
      expect(runner.proc.exitCode).toBeNull();
    } finally {
      if (door) await door.stop();
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

test.skipIf(!gate.ok)(
  `RUN-09 the routine operations that need the operating system take effect with no process restarted: a run entry added to the file becomes a unit with a LIVE PID in the manager's own record that the hub says it installed, removing it stops that process and deletes its file, and the hub's, the door's and the runner's pids are unchanged throughout (SPEC §6, L11, D7)${gateSuffix(gate)}`,
  async () => {
    const { runHub } = await seam("src/hub/run.ts");
    expect(typeof runHub).toBe("function");

    const machine = thisMachine();
    const it = await stageHub(cluster, {
      servers: true,
      hub: { tick_seconds: TICK, restart_delay_seconds: 1, give_up_after: 5, give_up_window_seconds: 300 },
      machines: [machine],
      people: [{ id: PERSON, tree: "/var/lib/imprnt-hub/p1" }],
    });

    const baseRun: RunSpec[] = [
      {
        id: DOOR,
        kind: "door",
        machine: machine.id,
        platform: "fake",
        person: PERSON,
        token_file: "/dev/null",
        schedule: "on demand",
        memory_limit_mb: 192,
      },
      {
        id: RUNNER,
        kind: "runner",
        machine: machine.id,
        schedule: "on demand",
        memory_limit_mb: 512,
        child_memory_limit_mb: 512,
      },
    ];
    // The door and the runner this check watches are the SUBPROCESSES it starts
    // itself, so their entries are `on demand`: a hub that also started units
    // for them would be running two doors and the check would be about that.
    const rewrite = (run: RunSpec[]) =>
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
        people: [{ id: PERSON, tree: "/var/lib/imprnt-hub/p1" }],
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
          { id: AGENT, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: RUNNER },
        ],
        run,
      });
    expect(rewrite(baseRun)).toBe(it.registryFile);

    // THE BASE ENTRIES ARE REGISTERED WITH THE FIXTURE, which is the second
    // seat's finding B: they carry fixed ids rather than fixture ones, so the
    // units a hub loads for them were outside `removeAll`'s list and a run that
    // left them behind left them on the box. Registering the names costs
    // nothing when nothing was created and removes them when something was.
    fixture.track(`imprnt-hub-${DOOR}`);
    fixture.track(`imprnt-hub-${RUNNER}`);

    let hub: ReadyProcess | null = null;
    let door: ReadyProcess | null = null;
    let runner: ReadyProcess | null = null;
    try {
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      hub = await startHub(it.registryFile, machine.id, fixture.unitDir());
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
      const pids = { hub: hub.pid, door: door.pid, runner: runner.pid };

      // --- 1. ADD A [[run]] ENTRY, through the file.
      const added = fixture.entryId("added");
      rewrite([
        ...baseRun,
        {
          id: added,
          kind: "runner",
          machine: machine.id,
          schedule: "always",
          memory_limit_mb: 64,
          child_memory_limit_mb: 64,
        },
      ]);
      // A LIVE PID, from the manager's own record, not a label in a list. The
      // second seat's lead: "the label is there and the ledger says started" is
      // satisfied by a hub that loaded the unit and never started it.
      await until(
        "the added entry is a unit with a live pid of its own",
        async () =>
          (await fixture.listWatched()).some((n) => n.startsWith(`imprnt-hub-${added}`)) &&
          livePid(`imprnt-hub-${added}`) !== null,
        90_000,
        async () =>
          `${(await fixture.listWatched()).join(", ")} | ${JSON.stringify(managerState(`imprnt-hub-${added}`))}`,
      );
      const addedPid = livePid(`imprnt-hub-${added}`)!;
      expect(pidAlive(addedPid)).toBe(true);
      await until(
        "the hub said it installed and started it",
        async () => {
          const events = await it.read.ledger({ stream: "machine" });
          return (
            events.some((e) => e.subject === added && e.kind === "unit.installed") &&
            events.some((e) => e.subject === added && e.kind === "unit.started")
          );
        },
        60_000,
        async () => JSON.stringify(await it.read.ledger({ stream: "machine" })),
      );
      for (const pid of Object.values(pids)) expect(pidAlive(pid)).toBe(true);
      expect(hub.pid).toBe(pids.hub);
      expect(door.pid).toBe(pids.door);
      expect(runner.pid).toBe(pids.runner);

      // --- 2. REMOVE IT.
      rewrite(baseRun);
      // THE WAIT IS ON THE HUB'S OWN LINE AND WAS ON THE MANAGER'S LIST
      // (BUILD-NOTES 18). The hub stops a stale unit and only then removes it
      // (`src/hub/run.ts`), so by the time `remove` runs the service is already
      // inactive; `remove` then DISABLES it, which drops the last reference and
      // makes an already-inactive unit collectable, and the delete of the files
      // is the step after that. Between those two the unit can leave
      // `list-units` while its file is still on disk, and a wait on the listing
      // therefore lets the three assertions below run in the middle of the
      // removal rather than after it. `unit.removed` is written after
      // `os.remove` has returned, which is the event these assertions mean, and
      // the stage above already reads this ledger for `unit.installed` and
      // `unit.started`. Nothing below is weakened: the file and the pid are
      // still read from the operating system, after the wait instead of during
      // it.
      await until(
        "the hub said it removed the entry's unit",
        async () =>
          (await it.read.ledger({ stream: "machine" })).some(
            (e) => e.subject === added && e.kind === "unit.removed",
          ),
        90_000,
        async () =>
          `${JSON.stringify(await it.read.ledger({ stream: "machine" }))} | ${(
            await fixture.listWatched()
          ).join(", ")}`,
      );
      expect(
        (await fixture.listWatched()).some((n) => n.startsWith(`imprnt-hub-${added}`)),
      ).toBe(false);
      expect(readdirSync(fixture.unitDir()).some((f) => f.startsWith(`imprnt-hub-${added}`))).toBe(
        false,
      );
      // The process it started is gone with it, which is what "stopped" means.
      expect(pidAlive(addedPid)).toBe(false);

      // --- and all three pids, read from the operating system again.
      expect(pidAlive(pids.hub)).toBe(true);
      expect(pidAlive(pids.door)).toBe(true);
      expect(pidAlive(pids.runner)).toBe(true);
      expect(hub.proc.exitCode).toBeNull();
      expect(door.proc.exitCode).toBeNull();
      expect(runner.proc.exitCode).toBeNull();
    } finally {
      if (hub) await hub.stop();
      if (door) await door.stop();
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);
