// Restart is the one verb, start and stop are a field in the file, and pause is
// an edit. (SPEC §6 Forbidden, L13, D-178, RUN-05)
//
// RESTART REACHES THE SAME FUNCTION FROM BOTH FRONT ENDS. The board asks
// `requestRecovery` exactly as the command line does, the widened targets are
// the pieces a person would press restart on, and the hub, a door named as a
// run target, and the board itself each refuse by the shipped name. Two
// implementations of a control verb is the Forbidden line this file exists to
// make unreachable.
//
// WHETHER THE HUB KEEPS A PIECE RUNNING IS A FIELD AND NEVER A CONTROL ROW. A
// hold written into a row would be undone by the hub's own next tick, which
// starts what the file says should be running, and a hold kept outside the file
// is a setting a page can set that the file cannot. So `enabled = false` is a
// fourth wanted state derived from the file and from nothing else.
//
// NOTHING HERE PERFORMS A MANAGER VERB. The seam below renders through the real
// renderers and records every acting call instead of making it, which is what
// lets the last assertion in each test be "and the only thing that talked to the
// service manager was the hub".
//
// Red reason: behaviour absent. `requestRecovery` refuses any target kind that
// is not `agent` or `door` and any source that is not `cli` or `chat`, and
// `wantedState` has three values derived from the schedule alone.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore, insertInbound } from "./helpers/hub-fixture.ts";
import { controlledAdapter, editAgent, observe } from "./helpers/rollout-runner.ts";
import type { RunSpec } from "./helpers/registry.ts";
import { runHub } from "../src/hub/run.ts";
import { runRunner } from "../src/runner/run.ts";
import { loadRegistry, type RunEntry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";
import { systemd } from "../src/os/systemd.ts";
import { launchd } from "../src/os/launchd.ts";
import { unitName } from "../src/os/names.ts";
import type { OsSeam, RenderContext, UnitState } from "../src/os/types.ts";

const SLOW = 120_000;
const MACHINE = process.platform === "darwin" ? "mac" : "pi";
const MACHINE_OS = process.platform === "darwin" ? "macos" : "linux";
const FLAVOUR = process.platform === "darwin" ? "launchd" : "systemd";

let cluster: Cluster;
/** Every directory this file made, taken away in `afterAll` whatever happened. */
const scratch: string[] = [];
beforeAll(async () => {
  cluster = await startCluster();
});
afterAll(async () => {
  try {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  } finally {
    await cluster?.stop();
  }
});

/**
 * The manager, recorded rather than performed.
 *
 * It renders through the REAL renderer, so a unit text asserted here is the one
 * a box would get, and every acting verb lands in `calls` with the name of what
 * asked for it. Pids are handed out in order, because "no other entry's pid
 * changed" is only an assertion when the pids are distinguishable.
 */
function recordingOs(unitDir: string, who = "hub") {
  mkdirSync(unitDir, { recursive: true });
  const renderer = FLAVOUR === "systemd" ? systemd({ unitDir }) : launchd({ unitDir });
  const calls: { operation: string; target: string; by: string }[] = [];
  const states = new Map<string, UnitState>();
  let nextPid = 40000;
  const blank = (id: string): UnitState => ({
    name: `${unitName(id)}${FLAVOUR === "systemd" ? ".service" : ""}`,
    loaded: true,
    running: false,
    pid: null,
    runs: 1,
    ran: true,
    restarts: 0,
    lastExit: null,
    since: null,
    state: "stopped",
    result: null,
  });
  const os: OsSeam = {
    flavour: FLAVOUR,
    render: renderer.render,
    async install(files) {
      for (const file of files) writeFileSync(file.path, file.text, "utf8");
      calls.push({ operation: "install", target: files[0]?.path ?? "", by: who });
      return files.map((file) => file.path);
    },
    async start(id) {
      calls.push({ operation: "start", target: id, by: who });
      states.set(id, { ...blank(id), running: true, pid: nextPid++, state: "running" });
    },
    async stop(id) {
      calls.push({ operation: "stop", target: id, by: who });
      states.set(id, blank(id));
    },
    async restart(id) {
      calls.push({ operation: "restart", target: id, by: who });
      const had = states.get(id);
      if (had) states.set(id, { ...had, running: true, pid: nextPid++, state: "running" });
    },
    async remove(id) {
      calls.push({ operation: "remove", target: id, by: who });
      states.delete(id);
    },
    async list() {
      return [...states.values()];
    },
    async show(id) {
      return states.get(id) ?? null;
    },
    async memory() {
      return { current_bytes: 4096, peak_bytes: 8192, source: "ps-rss" };
    },
    async available() {
      return { ok: true, reason: "a manager this check records and never calls" };
    },
  };
  return {
    os,
    calls,
    states,
    /** What the manager was ASKED to do, never a read. */
    acting: () => calls.filter((call) => call.operation !== "install"),
    plant(id: string, running: boolean) {
      states.set(id, running ? { ...blank(id), running: true, pid: nextPid++, state: "running" } : blank(id));
    },
    forget(id: string) {
      states.delete(id);
    },
    pidOf: (id: string) => states.get(id)?.pid ?? null,
  };
}

const DOOR: RunSpec = {
  id: "door-fake",
  kind: "door",
  machine: MACHINE,
  platform: "fake",
  person: "p1",
  token_file: "/dev/null",
  schedule: "always",
  memory_limit_mb: 192,
};
const RUNNER: RunSpec = {
  id: "runner-test",
  kind: "runner",
  machine: MACHINE,
  schedule: "always",
  memory_limit_mb: 512,
  child_memory_limit_mb: 2048,
};
const SYNC: RunSpec = {
  id: "vault-sync",
  kind: "sync",
  machine: MACHINE,
  schedule: "every 15m",
  memory_limit_mb: 128,
};
const SCHEDULED: RunSpec = {
  id: "watch-bikes",
  kind: "runner",
  machine: MACHINE,
  schedule: "every 15m",
  memory_limit_mb: 128,
  child_memory_limit_mb: 512,
};
const HUB: RunSpec = {
  id: "hub-one",
  kind: "hub",
  machine: MACHINE,
  schedule: "always",
  memory_limit_mb: 128,
};
const BOARD: RunSpec = {
  id: "board",
  kind: "board",
  machine: MACHINE,
  schedule: "always",
  memory_limit_mb: 128,
  bind: "127.0.0.1",
  port: 8794,
};

// A sync entry carries a repository list, and the file declares the repository
// and the person whose tree it sits in. The fixture renders none of the three,
// so they are appended here the way every other check that stages a sync entry
// appends them.
function withRepository(registryFile: string): void {
  const tree = mkdtempSync(join(tmpdir(), "hub-board-tree-"));
  scratch.push(tree);
  const path = join(tree, "vault-project");
  mkdirSync(path, { recursive: true });
  const text = readFileSync(registryFile, "utf8").replace(
    `id = ${JSON.stringify(SYNC.id)}\n`,
    `id = ${JSON.stringify(SYNC.id)}\nrepositories = ["p1-vault"]\n`,
  );
  writeFileSync(
    registryFile,
    `${text}\n[[repositories]]\nid = "p1-vault"\nperson = "p1"\npath = ${JSON.stringify(path)}\nremote = "origin"\nbranch = "main"\nrequired = true\n`,
    "utf8",
  );
}

async function stage(run: RunSpec[], hub: Record<string, string | number> = {}) {
  const sync = run.some((entry) => entry.kind === "sync");
  const tree = mkdtempSync(join(tmpdir(), "hub-board-person-"));
  scratch.push(tree);
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1, ...hub },
    machines: [{ id: MACHINE, os: MACHINE_OS }],
    ...(sync ? { people: [{ id: "p1", tree }] } : {}),
    run,
  });
  if (sync) withRepository(it.registryFile);
  return it;
}

/** One key on one `[[run]]` entry, rewritten in place, the way an editor would. */
function setOnEntry(file: string, id: string, key: string, value: string | null): void {
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `id = ${JSON.stringify(id)}`);
  expect(start, `the fixture must carry an entry whose id is ${id}`).toBeGreaterThanOrEqual(0);
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== "") end++;
  const at = lines.findIndex(
    (line, i) => i > start && i < end && new RegExp(`^\\s*${key}\\s*=`).test(line),
  );
  if (value === null) {
    if (at >= 0) lines.splice(at, 1);
  } else if (at >= 0) {
    lines[at] = `${key} = ${value}`;
  } else {
    lines.splice(end, 0, `${key} = ${value}`);
  }
  writeFileSync(file, lines.join("\n"), "utf8");
}

type Recovery = (store: unknown, request: Record<string, unknown>) => Promise<Record<string, unknown>>;

test(
  "D-244 a board restart writes one control row that records both who asked and on whose behalf, and the hub applies it",
  async () => {
    const it = await stage([DOOR, RUNNER, SYNC, HUB, BOARD]);
    const store = await superStore(cluster, it.db);
    const os = recordingOs(join(it.stateDir, "units"));
    let hub: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      const { requestRecovery } = await seam("src/hub/control.ts");
      expect(typeof requestRecovery).toBe("function");
      const ask = requestRecovery as Recovery;

      hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: os.os });

      // 1. ONE row, and it says both things. `actor` is on whose behalf and
      //    `source` is which front end asked, and the board is honest that the
      //    two are the same word for it because nobody on a tailnet page is
      //    identified.
      const boardAsk = `recover-${crypto.randomUUID()}`;
      await ask(store, {
        id: boardAsk,
        registryFile: it.registryFile,
        source: "board",
        actor: "board",
        target_kind: "run",
        target_id: RUNNER.id,
      });
      const rows = (await it.read.sheet("control")).filter((row) => row.id === boardAsk);
      expect(rows).toHaveLength(1);
      expect(rows[0].data.actor).toBe("board");
      expect(rows[0].data.source).toBe("board");
      expect(rows[0].data.target_kind).toBe("run");
      expect(rows[0].data.target_id).toBe(RUNNER.id);

      // THE LEDGER'S ACTOR IS THE HUB, and it is not the same fact. The store's
      // own insert policy pins the ledger's actor column for the role the board
      // runs as, so the honest record of who pressed the button lives in the
      // row's own data and never in that column.
      const requested = (await it.read.ledger({ stream: "control", subject: boardAsk })).filter((row) =>
        /requested/.test(row.kind),
      );
      expect(requested).toHaveLength(1);
      expect(requested[0].actor).toBe("hub");
      expect(requested[0].actor).not.toBe("door");
      expect(requested[0].actor).not.toBe("board");

      // The hub applies it through the seam, exactly once, and says so.
      expect(
        await observe(async () =>
          (await it.read.sheet("control")).some((row) => row.id === boardAsk && row.data.status === "applied"),
        ),
      ).toBe(true);
      expect(os.acting().filter((call) => call.operation === "restart").map((call) => call.target)).toEqual([
        RUNNER.id,
      ]);
      const applied = (await it.read.ledger({ stream: "control" })).filter(
        (row) => row.detail.request_id === boardAsk && /applied/.test(row.kind),
      );
      expect(applied).toHaveLength(1);
      expect(applied[0].actor).toBe("hub");

      // THE FIELD IS ADDITIVE, said in the same run. A build that added
      // `source` for the board alone fails here.
      const cliAsk = `recover-${crypto.randomUUID()}`;
      await ask(store, {
        id: cliAsk,
        registryFile: it.registryFile,
        source: "cli",
        actor: "operator",
        target_kind: "run",
        target_id: SYNC.id,
      });
      const cliRow = (await it.read.sheet("control")).find((row) => row.id === cliAsk)!;
      expect(cliRow.data.source).toBe("cli");
      expect(cliRow.data.actor).toBe("operator");

      // 2. A sync entry is a legal target: a person pressing restart on a sync
      //    means run it now, which is what the manager's restart does to a
      //    scheduled service.
      expect(
        await observe(async () =>
          (await it.read.sheet("control")).some((row) => row.id === cliAsk && row.data.status === "applied"),
        ),
      ).toBe(true);
      expect(os.acting().filter((call) => call.operation === "restart").map((call) => call.target).sort()).toEqual(
        [RUNNER.id, SYNC.id].sort(),
      );

      // 2b, 3. The refusals, each by the shipped name. A door has its own
      //        target kind, so naming it as a run target is two ways to say one
      //        thing. The hub is what acts on a restart, so it is never what a
      //        restart acts on, and the board is the asker: its own unit is
      //        what would go away.
      for (const target of [DOOR.id, HUB.id, BOARD.id]) {
        await expect(
          ask(store, {
            id: crypto.randomUUID(),
            registryFile: it.registryFile,
            source: "board",
            actor: "board",
            target_kind: "run",
            target_id: target,
          }),
        ).rejects.toThrow("invalid-recovery-target");
      }
      // And a run target the file does not declare at all.
      await expect(
        ask(store, {
          id: crypto.randomUUID(),
          registryFile: it.registryFile,
          source: "board",
          actor: "board",
          target_kind: "run",
          target_id: "nothing-of-the-sort",
        }),
      ).rejects.toThrow("invalid-recovery-target");

      // 4. The two shipped targets still behave exactly as they do today, so a
      //    build that replaced the target check rather than widening it fails.
      const doorAsk = crypto.randomUUID();
      await ask(store, {
        id: doorAsk,
        registryFile: it.registryFile,
        source: "cli",
        actor: "operator",
        target_kind: "door",
        target_id: DOOR.id,
      });
      expect(
        await observe(async () =>
          (await it.read.sheet("control")).some((row) => row.id === doorAsk && row.data.status === "applied"),
        ),
      ).toBe(true);
      await expect(
        ask(store, {
          id: crypto.randomUUID(),
          registryFile: it.registryFile,
          source: "cli",
          actor: "operator",
          target_kind: "agent",
          target_id: "not-an-agent",
        }),
      ).rejects.toThrow("invalid-recovery-target");
      const agentAsk = crypto.randomUUID();
      await ask(store, {
        id: agentAsk,
        registryFile: it.registryFile,
        source: "cli",
        actor: "operator",
        target_kind: "agent",
        target_id: "p1-lair",
      });
      expect((await it.read.sheet("control")).some((row) => row.id === agentAsk)).toBe(true);

      // 6. THE PROPERTY THE CONTROL ROW BUYS. Across every ask above, the only
      //    thing that called an acting verb on the manager is the hub. No board
      //    code and no agent has a seam at all.
      expect([...new Set(os.acting().map((call) => call.by))]).toEqual(["hub"]);
      // A refused ask restarts nothing. The board is a resident entry, so the
      // hub's own reconcile starts it like any other, which is not an act
      // anybody asked for.
      expect(os.acting().filter((call) => call.operation === "restart" && call.target === BOARD.id)).toEqual([]);
      expect(os.acting().filter((call) => call.operation === "restart").map((call) => call.target).sort()).toEqual(
        [DOOR.id, RUNNER.id, SYNC.id].sort(),
      );
    } finally {
      await hub?.stop();
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "D-244 the command line reaches the same run targets the board does, and the shipped usage refusals are untouched",
  async () => {
    const it = await stage([DOOR, RUNNER, HUB, BOARD]);
    const os = recordingOs(join(it.stateDir, "units"));
    let hub: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      const { command } = await seam("src/entry/command.ts");
      expect(typeof command).toBe("function");
      const run = command as (argv: string[]) => Promise<number>;

      hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: os.os });

      // 5. The same row, from the other front end. One implementation, two
      //    front ends, which is RUN-05's Forbidden line said as an assertion.
      expect(await run(["recover", it.registryFile, `run:${RUNNER.id}`])).toBe(0);
      const rows = (await it.read.sheet("control")).filter((row) => row.data.target_kind === "run");
      expect(rows).toHaveLength(1);
      expect(rows[0].data.target_id).toBe(RUNNER.id);
      expect(rows[0].data.actor).toBe("operator");
      expect(rows[0].data.source).toBe("cli");

      // A target with no id, and a target kind nothing declares, are usage and
      // exit two. The two shipped `recover` usage checks drive `door:` and
      // `agent:` and their exit-two lists name no `run:` target at all, so the
      // widening touches neither, and this is what says so.
      expect(await run(["recover", it.registryFile, "run:"])).toBe(2);
      expect(await run(["recover", it.registryFile, "nonsense:x"])).toBe(2);
      expect(await run(["recover", it.registryFile])).toBe(2);
      expect(await run(["recover"])).toBe(2);
      expect(await run(["recover", it.registryFile, `door:${DOOR.id}`])).toBe(0);
    } finally {
      await hub?.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "a second restart asked for from the board inside the household's own interval is refused, and the command line is not bounded",
  async () => {
    // WHAT THE BOUND IS FOR. The board is the one front end a request can reach
    // without anybody being identified, so a page left open, a reload, or
    // anything on the tailnet that can post to it can ask for a restart as
    // often as it likes, and a piece restarted in a loop is a piece that is
    // never up. The operator at the terminal is a person who typed it and is
    // bounded by nothing, which is what the control below says.
    const it = await stage([DOOR, RUNNER, SYNC, HUB, BOARD], { outage_retry_seconds: 300 });
    const store = await superStore(cluster, it.db);
    const os = recordingOs(join(it.stateDir, "units"));
    let hub: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      const { requestRecovery } = await seam("src/hub/control.ts");
      const ask = requestRecovery as Recovery;
      hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: os.os });
      const restart = async (source: string, target: string) => {
        const id = `recover-${crypto.randomUUID()}`;
        await ask(store, {
          id,
          registryFile: it.registryFile,
          source,
          actor: source,
          target_kind: "run",
          target_id: target,
        });
        expect(
          await observe(async () =>
            (await it.read.sheet("control")).some((row) => row.id === id && row.data.status !== "pending"),
          ),
        ).toBe(true);
        return (await it.read.sheet("control")).find((row) => row.id === id)!.data;
      };

      for (const target of [RUNNER.id, SYNC.id]) {
        const first = await restart("board", target);
        expect(first.status, `the first ask for ${target}`).toBe("applied");
        const second = await restart("board", target);
        expect(second.status, `the second ask for ${target}`).toBe("refused");
        expect(second.cause).toBe(
          `${target} was restarted less than 300 s ago, which is this household's retry interval`,
        );
      }
      // The manager was asked once per entry, which is what the bound is worth.
      expect(os.acting().filter((call) => call.operation === "restart").map((call) => call.target).sort()).toEqual(
        [RUNNER.id, SYNC.id].sort(),
      );

      // The control, on the SAME entry inside the SAME window: the operator at
      // the terminal asks twice and both land, because a person who typed it
      // meant it.
      for (const nth of [1, 2]) {
        const said = await restart("cli", RUNNER.id);
        expect(said.status, `the operator's ask number ${nth}`).toBe("applied");
      }
      expect(
        os.acting().filter((call) => call.operation === "restart" && call.target === RUNNER.id),
        "one restart for the board's two asks and one for each of the operator's",
      ).toHaveLength(3);
    } finally {
      await hub?.stop();
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);

test("D-244 enabled is a fourth wanted state derived from the file, and the renders follow it", async () => {
  const { wantedState } = await seam("src/os/diff.ts");
  expect(typeof wantedState).toBe("function");
  const wanted = wantedState as (entry: unknown) => string;

  // 7. Four values, and no more. A build that added a fifth is caught here.
  const it = await stage([DOOR, RUNNER, SCHEDULED, HUB, BOARD]);
  try {
    const entries = listRunEntries(loadRegistry(it.registryFile));
    const runner = entries.find((one) => one.id === RUNNER.id)!;
    const sync = entries.find((one) => one.id === SCHEDULED.id)!;
    expect(wanted(runner)).toBe("running");
    expect(wanted(sync)).toBe("scheduled");
    expect(wanted({ ...runner, schedule: "on demand" })).toBe("loaded");
    expect(wanted({ ...runner, enabled: true })).toBe("running");
    expect(wanted({ ...sync, enabled: true })).toBe("scheduled");
    expect(wanted({ ...runner, enabled: false })).toBe("stopped");
    expect(wanted({ ...sync, enabled: false })).toBe("stopped");
    expect(wanted({ ...runner, schedule: "on demand", enabled: false })).toBe("stopped");
    const seen = new Set(
      [runner, sync, { ...runner, schedule: "on demand" }, { ...runner, enabled: false }].map(wanted),
    );
    expect([...seen].sort()).toEqual(["loaded", "running", "scheduled", "stopped"]);

    // 9. THE RENDER FOLLOWS THE FILE. A reboot leaves a stopped piece down,
    //    which is what the field means, so the unit carries nothing that would
    //    bring it back.
    const unitDir = join(it.stateDir, "render-units");
    mkdirSync(unitDir, { recursive: true });
    const ctx: RenderContext = {
      machine: MACHINE,
      stateDir: it.stateDir,
      execPath: process.execPath,
      entryScript: join(it.stateDir, "never-run.ts"),
      registryFile: it.registryFile,
      restartDelaySeconds: 1,
      giveUpAfter: 5,
      giveUpWindowSeconds: 300,
    };
    const stopped = { ...runner, enabled: false } as RunEntry;

    const unit = systemd({ unitDir }).render(stopped, ctx)[0].text;
    const lines = unit.split("\n").map((line) => line.trim());
    expect(lines).not.toContain("Restart=always");
    expect(lines).not.toContain("[Install]");
    expect(lines).not.toContain("WantedBy=default.target");
    // And the control: the same entry with the field gone carries both.
    const live = systemd({ unitDir }).render(runner, ctx)[0].text.split("\n").map((line) => line.trim());
    expect(live).toContain("Restart=always");
    expect(live).toContain("[Install]");

    const plist = launchd({ unitDir }).render(stopped, ctx)[0].text;
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist.split("<key>RunAtLoad</key>")[1].trimStart().startsWith("<false/>")).toBe(true);
    expect(plist).not.toContain("<key>KeepAlive</key>");
    const livePlist = launchd({ unitDir }).render(runner, ctx)[0].text;
    expect(livePlist.split("<key>RunAtLoad</key>")[1].trimStart().startsWith("<true/>")).toBe(true);
    expect(livePlist).toContain("<key>KeepAlive</key>");
  } finally {
    await it.stop();
  }
});

test(
  "D-244 the hub stops a running unit whose entry the file disabled, starts it again when the field goes, and touches nothing else",
  async () => {
    const it = await stage([DOOR, RUNNER, HUB]);
    const os = recordingOs(join(it.stateDir, "units"));
    let hub: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: os.os });
      // The hub's own reconcile starts every resident, which is the state this
      // assertion needs before it can watch one go away.
      expect(
        await observe(() => [DOOR.id, RUNNER.id, HUB.id].every((id) => os.states.get(id)?.running === true)),
      ).toBe(true);
      const before = new Map([DOOR.id, RUNNER.id, HUB.id].map((id) => [id, os.pidOf(id)]));

      // 8. The file says stop, so the hub stops it, within one tick.
      setOnEntry(it.registryFile, RUNNER.id, "enabled", "false");
      expect(await observe(() => os.acting().some((call) => call.operation === "stop"))).toBe(true);
      expect(os.acting().filter((call) => call.operation === "stop").map((call) => call.target)).toEqual([
        RUNNER.id,
      ]);
      const stopped = (await it.read.ledger({ stream: "machine", kind: "unit.stopped" })).filter(
        (row) => row.subject === RUNNER.id,
      );
      expect(stopped).toHaveLength(1);
      expect(stopped[0].detail.entry).toBe(RUNNER.id);

      // AND NOTHING ELSE MOVED, entry by entry. The shipped promise is that a
      // tick never stops a piece that is still declared and enabled, and this
      // edit must not cost it.
      for (const id of [DOOR.id, HUB.id]) expect(os.pidOf(id)).toBe(before.get(id)!);
      expect(os.acting().filter((call) => call.operation === "stop" && call.target !== RUNNER.id)).toEqual([]);
      expect(os.acting().filter((call) => call.operation === "remove")).toEqual([]);

      // It stays stopped: a tick that saw it down again would stop it twice.
      await Bun.sleep(2500);
      expect(os.acting().filter((call) => call.operation === "stop")).toHaveLength(1);
      expect(os.states.get(RUNNER.id)?.running).toBe(false);

      // And the field goes, and it comes back.
      setOnEntry(it.registryFile, RUNNER.id, "enabled", null);
      expect(await observe(() => os.states.get(RUNNER.id)?.running === true)).toBe(true);
      expect(os.acting().filter((call) => call.operation === "start" && call.target === RUNNER.id).length).toBeGreaterThan(1);
      for (const id of [DOOR.id, HUB.id]) expect(os.pidOf(id)).toBe(before.get(id)!);
    } finally {
      await hub?.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "D-244 with nothing disabled and nothing asked for, several ticks record no acting verb at all",
  async () => {
    // The control on the whole file. A build that stopped something on every
    // tick passes the assertion above and fails this one.
    const it = await stage([DOOR, RUNNER, HUB]);
    const os = recordingOs(join(it.stateDir, "units"));
    let hub: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: os.os });
      expect(
        await observe(() => [DOOR.id, RUNNER.id, HUB.id].every((id) => os.states.get(id)?.running === true)),
      ).toBe(true);
      const settled = os.acting().length;
      const pids = new Map([DOOR.id, RUNNER.id, HUB.id].map((id) => [id, os.pidOf(id)]));
      await Bun.sleep(4000);
      expect(os.acting().length).toBe(settled);
      expect(os.acting().filter((call) => ["stop", "restart", "remove"].includes(call.operation))).toEqual([]);
      for (const [id, pid] of pids) expect(os.pidOf(id)).toBe(pid);
      expect(await it.read.sheet("control")).toEqual([]);
    } finally {
      await hub?.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "D-244 a stopped entry reads stopped and never missing, is reported unit-not-stopped while the manager runs it, and is never asked for a peak",
  async () => {
    const it = await stage([DOOR, RUNNER, HUB]);
    const store = await superStore(cluster, it.db);
    const os = recordingOs(join(it.stateDir, "units"));
    try {
      const { readStatus } = await seam("src/hub/status.ts");
      const { runCheck, CHECK_SHEET } = await seam("src/check/run.ts");
      const { residentIds } = await seam("src/hub/peak.ts");
      const { stopCommand } = await seam("src/os/diff.ts");
      const status = readStatus as (o: Record<string, unknown>) => Promise<
        { id: string; wanted: string; seen: string; pid: number | null }[]
      >;
      const check = runCheck as (o: Record<string, unknown>) => Promise<
        { kind: string; subject: string; says: string; fix: string }[]
      >;
      const credentials = { open: async () => ({ ok: true }), secrets: async () => [] };
      const ask = async () =>
        await check({
          machine: MACHINE,
          registryFile: it.registryFile,
          store,
          os: os.os,
          kernel: null,
          credentials,
          now: new Date(),
        });

      setOnEntry(it.registryFile, RUNNER.id, "enabled", "false");

      // 10. The manager LISTS it and is not running it, which is the ordinary
      //     state of a piece the household asked to be down.
      os.plant(RUNNER.id, false);
      os.plant(DOOR.id, true);
      let rows = await status({ registryFile: it.registryFile, machine: MACHINE, os: os.os });
      expect(rows.find((row) => row.id === RUNNER.id)).toMatchObject({ wanted: "stopped", seen: "stopped" });

      // AND WITH NO RECORD AT ALL it still reads stopped. `missing` is a
      // finding-shaped word, and a piece the household asked to be down is not
      // missing.
      os.forget(RUNNER.id);
      rows = await status({ registryFile: it.registryFile, machine: MACHINE, os: os.os });
      expect(rows.find((row) => row.id === RUNNER.id)).toMatchObject({ wanted: "stopped", seen: "stopped" });
      // The control on that branch: a RUNNING entry the manager has no record
      // of is still missing.
      os.forget(HUB.id);
      expect(rows.find((row) => row.id === HUB.id)).toMatchObject({ wanted: "running", seen: "missing" });

      // 11. And with no unit at all there is no finding of either kind: a piece
      //     that is down and has no unit is the state the file asked for.
      let findings = await ask();
      expect(findings.filter((one) => one.subject === RUNNER.id && one.kind === "unit-not-stopped")).toEqual([]);
      expect(findings.filter((one) => one.subject === RUNNER.id && one.kind === "unit-missing")).toEqual([]);

      // The finding itself: stopped on the list, running in the manager.
      os.plant(RUNNER.id, true);
      findings = await ask();
      const said = findings.filter((one) => one.kind === "unit-not-stopped");
      expect(said).toHaveLength(1);
      expect(said[0].subject).toBe(RUNNER.id);
      expect(said[0].says).toBe(
        `${RUNNER.id} is on the registry's list as stopped and the service manager is still running it.`,
      );
      expect(said[0].fix).toBe(
        (stopCommand as (flavour: string, unit: string) => string)(
          os.os.flavour,
          os.states.get(RUNNER.id)!.name,
        ),
      );
      // NOT ALSO MISSING. The two would contradict each other on one entry.
      expect(findings.filter((one) => one.subject === RUNNER.id && one.kind === "unit-missing")).toEqual([]);
      // And nothing here ran the fix.
      expect(os.acting()).toEqual([]);

      // Cleared off the SHEET, which is how a fixed finding is proved: the
      // returned array is what this run found, the sheet is what stands.
      const rowsOf = async () =>
        (await it.read.sheet(String(CHECK_SHEET))).map((row) => String(row.id));
      expect(await rowsOf()).toContain(`${MACHINE}/unit-not-stopped:${RUNNER.id}`);
      os.plant(RUNNER.id, false);
      findings = await ask();
      expect(findings.filter((one) => one.kind === "unit-not-stopped")).toEqual([]);
      expect(await rowsOf()).not.toContain(`${MACHINE}/unit-not-stopped:${RUNNER.id}`);

      // 12. A stopped entry is never asked for a peak, so `peak-missing` never
      //     becomes permanent for a piece nobody wants running.
      const resident = (residentIds as (r: unknown, m: string) => string[])(
        loadRegistry(it.registryFile),
        MACHINE,
      );
      expect(resident).not.toContain(RUNNER.id);
      expect(resident).toContain(DOOR.id);
      expect(resident).toContain(HUB.id);
      expect(findings.filter((one) => one.kind === "peak-missing" && one.subject === RUNNER.id)).toEqual([]);

      // AND ITS EXISTING PEAK ROW IS KEPT. The peak never falls, and a piece
      // that has been down for a week has still used what it used.
      await store.sql`insert into state_row (sheet,id,data) values ('memory_peak',${RUNNER.id},${{
        bytes: 123456,
        at: new Date().toISOString(),
        how: "sampled",
        machine: MACHINE,
        pid: null,
      }}) on conflict (sheet,id) do update set data = excluded.data`;
      await ask();
      const peaks = (await it.read.sheet("memory_peak")).filter((row) => row.id === RUNNER.id);
      expect(peaks).toHaveLength(1);
      expect(peaks[0].data.bytes).toBe(123456);
    } finally {
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);

test("D-244 a household that disables its hub is refused by the file itself, before anything is installed", async () => {
  // The refusal is the LOADER's, which is earlier and wider than the shipped
  // installer one this case used to meet: nothing that reads the file gets
  // past it, so a household cannot disable the thing that would start
  // everything again, its own hub included. The installer's own
  // one-resident-hub rule is untouched and still answers a file that declares
  // no resident hub at all.
  const it = await stage([DOOR, RUNNER, HUB]);
  const os = recordingOs(join(it.stateDir, "units"));
  try {
    const { runInstall } = await seam("src/install/run.ts");
    const install = runInstall as (o: Record<string, unknown>) => Promise<unknown>;
    setOnEntry(it.registryFile, HUB.id, "enabled", "false");
    await expect(
      install({ registryFile: it.registryFile, stage: "services", target: HUB.id, os: os.os }),
    ).rejects.toThrow(
      `${HUB.id} has enabled false, and the hub is never stopped from the file, because a stopped hub starts nothing again, itself included.`,
    );
    expect(os.acting()).toEqual([]);
    setOnEntry(it.registryFile, HUB.id, "enabled", null);

    // The shipped installer rule, still where it was: a hub that is not a
    // resident is not the one resident hub a machine installs against.
    setOnEntry(it.registryFile, HUB.id, "schedule", '"on demand"');
    await expect(
      install({ registryFile: it.registryFile, stage: "services", target: HUB.id, os: os.os }),
    ).rejects.toThrow("one-resident-hub-required");
    expect(os.acting()).toEqual([]);

    // The control on the same path: with the file back as it was it installs.
    setOnEntry(it.registryFile, HUB.id, "schedule", '"always"');
    await install({ registryFile: it.registryFile, stage: "services", target: HUB.id, os: os.os });
    expect(os.acting().filter((call) => call.operation === "start").length).toBeGreaterThan(0);
  } finally {
    await it.stop();
  }
});

test(
  "D-244 pause on an agent is the shipped sleeping field, which restarts no process and asks the manager nothing",
  async () => {
    // The board offers pause on agents and stop on entries, never both on one
    // thing, and neither is a control row. This is that sentence in miniature.
    const it = await stage([DOOR, RUNNER, HUB]);
    const os = recordingOs(join(it.stateDir, "units"));
    const edge = controlledAdapter(it.adapterName);
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
    let hub: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: os.os });
      expect(await observe(() => os.states.get(RUNNER.id)?.running === true)).toBe(true);
      const pids = new Map([DOOR.id, RUNNER.id, HUB.id].map((id) => [id, os.pidOf(id)]));
      const settled = os.acting().length;

      runner = await runRunner({
        registryFile: it.registryFile,
        runner: RUNNER.id,
        adapters: { [it.adapterName]: edge.adapter },
      });
      await insertInbound(cluster, it.db, { id: "awake", body: "before the pause" });
      expect(await observe(async () => (await it.read.outbox()).some((row) => row.inbound_id === "awake"))).toBe(
        true,
      );

      editAgent(it.registryFile, "p1-lair", { sleeping: true });
      await Bun.sleep(1500);
      await insertInbound(cluster, it.db, { id: "asleep", body: "while paused" });
      await Bun.sleep(2000);
      expect((await it.read.inbound()).find((row) => row.id === "asleep")!.claimed_by).toBeNull();
      expect((await it.read.outbox()).some((row) => row.inbound_id === "asleep")).toBe(false);

      // NOTHING WAS RESTARTED FOR IT. Pause is an edit and never a verb.
      expect(os.acting().length).toBe(settled);
      expect(os.acting().filter((call) => ["stop", "restart", "remove"].includes(call.operation))).toEqual([]);
      for (const [id, pid] of pids) expect(os.pidOf(id)).toBe(pid);
      expect(await it.read.sheet("control")).toEqual([]);

      // And it wakes on the next registry tick, with no process restarted.
      editAgent(it.registryFile, "p1-lair", { sleeping: false });
      expect(
        await observe(async () => (await it.read.outbox()).some((row) => row.inbound_id === "asleep"), 8000),
      ).toBe(true);
      expect(os.acting().filter((call) => ["stop", "restart", "remove"].includes(call.operation))).toEqual([]);
      for (const [id, pid] of pids) expect(os.pidOf(id)).toBe(pid);
    } finally {
      await hub?.stop();
      await runner?.stop();
      await edge.stop();
      await it.stop();
    }
  },
  SLOW,
);

/**
 * A manager that carries a SERVICE and a TIMER for one entry, keyed by unit
 * name, because that is the shape the question below is about.
 *
 * The other seam in this file keys its states by entry id and can hold one unit
 * per entry, so a timer armed beside an inactive service cannot be planted in
 * it at all. It renders through the real systemd renderer on both platforms,
 * because a timer is a systemd unit and what a launchd box does with a cadence
 * is a key inside the one plist.
 */
function timerOs(unitDir: string) {
  mkdirSync(unitDir, { recursive: true });
  const renderer = systemd({ unitDir });
  const calls: { operation: string; target: string }[] = [];
  const states = new Map<string, UnitState>();
  const blank = (name: string): UnitState => ({
    name,
    loaded: true,
    running: false,
    pid: null,
    runs: null,
    ran: true,
    restarts: 0,
    lastExit: null,
    since: null,
    // The manager's own words for a unit that is loaded and doing nothing.
    state: "inactive",
    result: null,
  });
  const os: OsSeam = {
    flavour: "systemd",
    render: renderer.render,
    async install(files) {
      for (const file of files) writeFileSync(file.path, file.text, "utf8");
      calls.push({ operation: "install", target: files[0]?.path ?? "" });
      return files.map((file) => file.path);
    },
    async start(id) {
      calls.push({ operation: "start", target: id });
      states.set(`${unitName(id)}.service`, { ...blank(`${unitName(id)}.service`), running: true, pid: 4242, state: "active" });
    },
    async stop(id) {
      // What `systemctl --user stop` does to the pair, in the order the seam
      // asks for it: the timer first, then the service.
      calls.push({ operation: "stop", target: id });
      for (const name of [`${unitName(id)}.timer`, `${unitName(id)}.service`]) {
        if (states.has(name)) states.set(name, blank(name));
      }
    },
    async restart(id) {
      calls.push({ operation: "restart", target: id });
    },
    async remove(id) {
      calls.push({ operation: "remove", target: id });
      states.delete(`${unitName(id)}.service`);
      states.delete(`${unitName(id)}.timer`);
    },
    async list() {
      return [...states.values()];
    },
    async unitFiles() {
      return [];
    },
    async show(id) {
      return states.get(`${unitName(id)}.service`) ?? null;
    },
    async memory() {
      return { current_bytes: 4096, peak_bytes: 8192, source: "ps-rss" };
    },
    async available() {
      return { ok: true, reason: "a manager this check records and never calls" };
    },
  };
  return {
    os,
    calls,
    states,
    acting: () => calls.filter((call) => call.operation !== "install"),
    /** A timer the manager has ARMED: active, waiting for its next run. */
    armTimer(id: string) {
      const name = `${unitName(id)}.timer`;
      states.set(name, { ...blank(name), state: "active" });
    },
    plantService(id: string, running: boolean) {
      const name = `${unitName(id)}.service`;
      states.set(name, running ? { ...blank(name), running: true, pid: 4243, state: "active" } : blank(name));
    },
    stateOf: (name: string) => states.get(name)?.state ?? null,
  };
}

test(
  "a stopped entry whose timer the manager still has armed is stopped by the hub within a tick",
  async () => {
    // AN ARMED TIMER IS NOT A RUNNING SERVICE. A scheduled entry between runs
    // has an inactive service and a timer the manager reports as active and
    // waiting, so a pass that looked only at the service saw nothing to stop
    // and left the timer to fire on its own cadence for as long as the box
    // stayed up, while the file, the status and the board all said stopped.
    const it = await stage([DOOR, RUNNER, SCHEDULED, HUB]);
    const os = timerOs(join(it.stateDir, "timer-units"));
    let hub: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      os.armTimer(SCHEDULED.id);
      os.plantService(SCHEDULED.id, false);
      setOnEntry(it.registryFile, SCHEDULED.id, "enabled", "false");

      hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: os.os });
      expect(
        await observe(() => os.acting().some((call) => call.operation === "stop" && call.target === SCHEDULED.id)),
        "the hub never stopped the entry whose timer was armed",
      ).toBe(true);
      expect(os.stateOf(`${unitName(SCHEDULED.id)}.timer`)).toBe("inactive");

      // And it is stopped ONCE: a tick that read a disarmed timer as something
      // to stop would stop it on every tick for ever.
      await Bun.sleep(2500);
      expect(os.acting().filter((call) => call.operation === "stop")).toHaveLength(1);
      // Nothing else was touched.
      expect(os.acting().filter((call) => call.operation === "stop" && call.target !== SCHEDULED.id)).toEqual([]);
      expect(os.acting().filter((call) => call.operation === "remove")).toEqual([]);
    } finally {
      await hub?.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "check reports a stopped entry whose timer is armed, and names the timer in the fix",
  async () => {
    const it = await stage([DOOR, RUNNER, SCHEDULED, HUB]);
    const store = await superStore(cluster, it.db);
    const os = timerOs(join(it.stateDir, "timer-units"));
    try {
      const { runCheck } = await seam("src/check/run.ts");
      const { stopCommand } = await seam("src/os/diff.ts");
      const stop = stopCommand as (flavour: string, unit: string) => string;
      const check = runCheck as (o: Record<string, unknown>) => Promise<
        { kind: string; subject: string; says: string; fix: string }[]
      >;
      const ask = async () =>
        await check({
          machine: MACHINE,
          registryFile: it.registryFile,
          store,
          os: os.os,
          kernel: null,
          credentials: { open: async () => ({ ok: true }), secrets: async () => [] },
          now: new Date(),
        });

      setOnEntry(it.registryFile, SCHEDULED.id, "enabled", "false");

      // The control first: the service is loaded, the timer is not armed, and
      // that is the state the household asked for, so there is no finding.
      os.plantService(SCHEDULED.id, false);
      expect((await ask()).filter((one) => one.kind === "unit-not-stopped")).toEqual([]);

      os.armTimer(SCHEDULED.id);
      const said = (await ask()).filter((one) => one.kind === "unit-not-stopped");
      expect(said, "an armed timer on a stopped entry is the finding this is").toHaveLength(1);
      expect(said[0].subject).toBe(SCHEDULED.id);
      // THE FIX MUST NAME THE TIMER. Stopping the service alone leaves the
      // timer armed to start it again on its own cadence, so a fix that named
      // the service would be a command that does not fix it.
      expect(said[0].fix).toBe(stop("systemd", `${unitName(SCHEDULED.id)}.timer`));
      // And nothing here ran it.
      expect(os.acting()).toEqual([]);

      // With the service running beside the armed timer, both are named, and
      // the shipped case of a running service alone still names the service.
      os.plantService(SCHEDULED.id, true);
      const both = (await ask()).filter((one) => one.kind === "unit-not-stopped");
      expect(both).toHaveLength(1);
      expect(both[0].fix).toBe(
        stop("systemd", `${unitName(SCHEDULED.id)}.timer ${unitName(SCHEDULED.id)}.service`),
      );
      os.states.delete(`${unitName(SCHEDULED.id)}.timer`);
      const service = (await ask()).filter((one) => one.kind === "unit-not-stopped");
      expect(service).toHaveLength(1);
      expect(service[0].fix).toBe(stop("systemd", `${unitName(SCHEDULED.id)}.service`));
    } finally {
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "a control row written straight into the store is applied only when its source may reach its target",
  async () => {
    // THE FENCE HOLDS ON BOTH SIDES. `requestRecovery` is the front door and it
    // refuses a door asking for a runner, but the roles a door and a runner
    // hold may insert a control row into the store without going through it.
    // The hub is what performs the restart, so it asks the same question from
    // its own side before it acts.
    const it = await stage([DOOR, RUNNER, SYNC, HUB, BOARD]);
    const store = await superStore(cluster, it.db);
    const os = recordingOs(join(it.stateDir, "units"));
    let hub: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: os.os });
      /** A row as a role with insert rights would write it, notify and all. */
      const plant = async (data: Record<string, unknown>) => {
        const id = `planted-${crypto.randomUUID()}`;
        const row = {
          id,
          actor: "door",
          person: null,
          requested_at: new Date().toISOString(),
          status: "pending",
          cause: null,
          ...data,
        };
        await store.sql`insert into state_row (sheet,id,data) values ('control',${id},${row})`;
        await store.sql`select pg_notify('hub_control',${id})`;
        return id;
      };
      const settled = async (id: string) => {
        expect(
          await observe(async () =>
            (await it.read.sheet("control")).some((one) => one.id === id && one.data.status !== "pending"),
          ),
          `the row ${id} was never settled`,
        ).toBe(true);
        return (await it.read.sheet("control")).find((one) => one.id === id)!.data;
      };

      for (const [what, data] of [
        ["a door asking for a runner", { source: "door", target_kind: "run", target_id: RUNNER.id }],
        ["a door asking for a sync", { source: "door", target_kind: "run", target_id: SYNC.id }],
        ["a door asking for a door", { source: "door", target_kind: "door", target_id: DOOR.id }],
        ["a chat asking for a runner", { source: "chat", target_kind: "run", target_id: RUNNER.id }],
        ["a row with no source at all", { target_kind: "run", target_id: RUNNER.id }],
      ] as [string, Record<string, unknown>][]) {
        const said = await settled(await plant(data));
        expect(said.status, what).toBe("refused");
        expect(said.cause, what).toBe("recovery-not-authorized");
      }
      // The hub's own reconcile starts this machine's residents, which nobody
      // asked for, so what is asserted is that no RESTART was performed.
      expect(
        os.acting().filter((call) => call.operation === "restart"),
        "a refused row reached the service manager",
      ).toEqual([]);

      // The controls, planted the same way: the operator and the board reach
      // what they are allowed to reach, and the manager is asked for each.
      for (const source of ["cli", "board"]) {
        const target = source === "cli" ? RUNNER.id : SYNC.id;
        const said = await settled(await plant({ source, target_kind: "run", target_id: target }));
        expect(said.status, `${source} asking for ${target}`).toBe("applied");
      }
      const applied = await settled(await plant({ source: "cli", target_kind: "door", target_id: DOOR.id }));
      expect(applied.status, "the operator asking for a door").toBe("applied");
      expect(os.acting().filter((call) => call.operation === "restart").map((call) => call.target).sort()).toEqual(
        [DOOR.id, RUNNER.id, SYNC.id].sort(),
      );
    } finally {
      await hub?.stop();
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "a restart of an entry the file stopped is refused by name, and the hub refuses one planted for it",
  async () => {
    // RESTARTING A STOPPED PIECE STARTS IT. `restart` on a service the manager
    // is not running starts it, so a board that offered restart beside stop
    // could bring a piece back up for as long as it takes the hub to notice and
    // stop it again, and the household that asked for it to be down would watch
    // it run. The field is the answer to "should this be up", so a restart of
    // something it says is down is refused where it is asked for.
    const it = await stage([DOOR, RUNNER, SCHEDULED, HUB, BOARD]);
    const store = await superStore(cluster, it.db);
    const os = recordingOs(join(it.stateDir, "units"));
    let hub: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      const { requestRecovery } = await seam("src/hub/control.ts");
      const ask = requestRecovery as Recovery;
      hub = await runHub({ registryFile: it.registryFile, machine: MACHINE, os: os.os });

      setOnEntry(it.registryFile, SCHEDULED.id, "enabled", "false");
      setOnEntry(it.registryFile, DOOR.id, "enabled", "false");
      for (const [kind, target] of [["run", SCHEDULED.id], ["door", DOOR.id]] as const) {
        await expect(
          ask(store, {
            id: crypto.randomUUID(),
            registryFile: it.registryFile,
            source: "board",
            actor: "board",
            target_kind: kind,
            target_id: target,
          }),
          `${target} is on the list as stopped`,
        ).rejects.toThrow("recovery-target-stopped");
      }
      expect(await it.read.sheet("control"), "a refused ask wrote a row").toEqual([]);

      // And a row planted straight into the store for a stopped entry is
      // refused by the hub, which is the side that would have performed it.
      const planted = `planted-${crypto.randomUUID()}`;
      await store.sql`insert into state_row (sheet,id,data) values ('control',${planted},${{
        id: planted,
        actor: "operator",
        source: "cli",
        person: null,
        target_kind: "run",
        target_id: SCHEDULED.id,
        requested_at: new Date().toISOString(),
        status: "pending",
        cause: null,
      }})`;
      await store.sql`select pg_notify('hub_control',${planted})`;
      expect(
        await observe(async () =>
          (await it.read.sheet("control")).some((row) => row.id === planted && row.data.status !== "pending"),
        ),
      ).toBe(true);
      const said = (await it.read.sheet("control")).find((row) => row.id === planted)!.data;
      expect(said.status).toBe("refused");
      expect(said.cause).toBe("recovery-target-stopped");
      expect(os.acting().filter((call) => call.operation === "restart")).toEqual([]);

      // The control: with the field gone the same ask lands and is applied.
      setOnEntry(it.registryFile, SCHEDULED.id, "enabled", null);
      const allowed = crypto.randomUUID();
      await ask(store, {
        id: allowed,
        registryFile: it.registryFile,
        source: "board",
        actor: "board",
        target_kind: "run",
        target_id: SCHEDULED.id,
      });
      expect(
        await observe(async () =>
          (await it.read.sheet("control")).some((row) => row.id === allowed && row.data.status === "applied"),
        ),
      ).toBe(true);
      expect(os.acting().filter((call) => call.operation === "restart").map((call) => call.target)).toEqual([
        SCHEDULED.id,
      ]);
    } finally {
      await hub?.stop();
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);
