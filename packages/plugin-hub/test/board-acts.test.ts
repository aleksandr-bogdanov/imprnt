// An act is the one shipped verb or an edit to the file, recorded as asked by
// the board. (SPEC §6 Forbidden, L13, D-178, RUN-05)
//
// RESTART IS THE SHIPPED VERB WITH A NEW SOURCE. The board asks
// `requestRecovery` exactly as the command line does and the hub applies it, so
// there is one implementation with two front ends and no board code touches an
// acting verb on the service manager at all. The seam this file hands the board
// throws on every one of them, which is what makes that structural.
//
// START, STOP AND PAUSE ARE AN EDIT TO THE FILE and never a control row: the
// hub's own next tick starts whatever the file says should be running, so a
// hold kept anywhere else is undone within a tick. With no registry writer on
// this machine the page says so plainly and changes nothing, and restart still
// works beside it.
//
// NOBODY ON THE PAGE IS IDENTIFIED, so every row the board writes records
// `board` as who asked, which is the honest answer rather than a name nothing
// checked.
//
// Red reason: import missing, `src/board/run.ts`. Behind it the writer option
// and the check act are red for behaviour.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startCluster, statementWatch, until, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore, type StagedHub } from "./helpers/hub-fixture.ts";
import { freePort, plantedSeam, recordingSeam, serveBoard, treeDigest, type ServedBoard } from "./helpers/board.ts";
import type { RunSpec } from "./helpers/registry.ts";
import type { OsSeam } from "../src/os/types.ts";
import type { Store } from "../src/store/connect.ts";
import { runHub } from "../src/hub/run.ts";
import { CHECK_SHEET } from "../src/check/run.ts";
import {
  actRefused,
  actRequested,
  checkRan,
  editApplied,
  editUnavailable,
  pageMissing,
} from "../src/door/lines.ts";

const SLOW = 120_000;
const HERE = process.platform === "darwin" ? "mac" : "pi";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const FLAVOUR = process.platform === "darwin" ? "launchd" : "systemd";
const PAGES = ["/", "/people", "/findings", "/metrics"] as const;

/** What `check now` is handed, so no check here opens a real login. */
const CREDENTIALS = { open: async () => ({ ok: true }), secrets: async () => [] };

let cluster: Cluster;
const scratch: string[] = [];

beforeAll(async () => {
  cluster = await startCluster({
    settings: {
      log_statement: "'all'",
      log_line_prefix: "'pid=%p '",
      log_min_duration_statement: "-1",
    },
  });
});

afterAll(async () => {
  try {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  } finally {
    await cluster?.stop();
  }
});

function scratchDir(what: string): string {
  const dir = mkdtempSync(join(tmpdir(), what));
  scratch.push(dir);
  return dir;
}

const DOOR_ENTRY: RunSpec = {
  id: "door-fake",
  kind: "door",
  machine: HERE,
  platform: "fake",
  person: "p1",
  token_file: "/dev/null",
  schedule: "always",
  memory_limit_mb: 192,
};
const RUNNER_ENTRY: RunSpec = {
  id: "runner-test",
  kind: "runner",
  machine: HERE,
  schedule: "always",
  memory_limit_mb: 512,
  child_memory_limit_mb: 2048,
};
const HUB_ENTRY: RunSpec = {
  id: "hub-one",
  kind: "hub",
  machine: HERE,
  schedule: "always",
  memory_limit_mb: 128,
};
const SCHEDULED_ENTRY: RunSpec = {
  id: "watch-bikes",
  kind: "runner",
  machine: HERE,
  schedule: "every 15m",
  memory_limit_mb: 128,
  child_memory_limit_mb: 512,
};

/** The manager the HUB is handed: it records what it was asked and acts on it. */
function actingSeam() {
  const planted = plantedSeam(FLAVOUR);
  const calls: { verb: string; id: string }[] = [];
  const os: OsSeam = {
    ...planted.os,
    async install(files) {
      calls.push({ verb: "install", id: files[0]?.path ?? "" });
      return [];
    },
    async start(id) {
      calls.push({ verb: "start", id });
      planted.plant(id, true);
    },
    async stop(id) {
      calls.push({ verb: "stop", id });
      planted.plant(id, false);
    },
    async restart(id) {
      calls.push({ verb: "restart", id });
      planted.plant(id, true);
    },
    async remove(id) {
      calls.push({ verb: "remove", id });
      planted.forget(id);
    },
  };
  return { os, calls, plant: planted.plant, acting: () => calls.filter((call) => call.verb !== "install") };
}

interface Writes {
  table: string;
  id: string;
  key: string;
  value: boolean;
  file: string;
}

interface Staged {
  it: StagedHub;
  store: Store;
  board: ServedBoard;
  seam: ReturnType<typeof plantedSeam>;
  recorder: ReturnType<typeof recordingSeam>;
  writes: Writes[];
  boardEntry: RunSpec;
  stop(): Promise<void>;
}

async function stage(options: { writer?: "yes" | "no" | "throws" } = {}): Promise<Staged> {
  const tree = scratchDir("hub-acts-tree-");
  const boardEntry: RunSpec = {
    id: "board",
    kind: "board",
    machine: HERE,
    schedule: "always",
    memory_limit_mb: 128,
    bind: "127.0.0.1",
    port: await freePort(),
  };
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [{ id: HERE, os: HERE_OS }],
    people: [{ id: "p1", tree }],
    run: [DOOR_ENTRY, RUNNER_ENTRY, HUB_ENTRY, SCHEDULED_ENTRY, boardEntry],
  });
  const store = await superStore(cluster, it.db);
  const seam = plantedSeam(FLAVOUR);
  const recorder = recordingSeam(seam.os);
  const writes: Writes[] = [];
  const writer = options.writer ?? "yes";
  const board = await serveBoard({
    registryFile: it.registryFile,
    entryId: boardEntry.id,
    store,
    os: recorder.os,
    check: { credentials: CREDENTIALS, kernel: null },
    writeRegistryKey:
      writer === "no"
        ? undefined
        : async (change: Writes) => {
            writes.push(change);
            if (writer === "throws") throw new Error("the candidate file would not load");
          },
  });
  return {
    it,
    store,
    board,
    seam,
    recorder,
    writes,
    boardEntry,
    async stop() {
      await board.stop();
      await store.close();
      await it.stop();
    },
  };
}

/** Post an act and follow the redirect the board answers with. */
async function press(
  board: ServedBoard,
  path: string,
  form: Record<string, string> = {},
): Promise<{ status: number; location: string; landed: string }> {
  const answer = await board.post(path, form);
  const location = answer.headers.get("location") ?? "";
  if (answer.status !== 303) {
    return { status: answer.status, location, landed: await answer.text() };
  }
  const landed = await board.get(location);
  return { status: answer.status, location, landed: await landed.text() };
}

async function controlRows(it: StagedHub) {
  return await it.read.sheet("control");
}

test(
  "pressing restart writes the one shipped row, the hub applies it, and the board calls no manager verb",
  async () => {
    const staged = await stage();
    const hub = actingSeam();
    let running: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      const { board, it, recorder } = staged;
      running = await runHub({ registryFile: it.registryFile, machine: HERE, os: hub.os });

      const pressed = await press(board, "/act/restart", { target: RUNNER_ENTRY.id });
      expect(pressed.status).toBe(303);
      expect(pressed.location.startsWith("/")).toBe(true);
      // The sentence the page lands on, compared whole.
      expect(pressed.landed).toContain(actRequested("en", { target: RUNNER_ENTRY.id }));

      const rows = await controlRows(it);
      expect(rows).toHaveLength(1);
      expect(rows[0].data.actor).toBe("board");
      expect(rows[0].data.source).toBe("board");
      expect(rows[0].data.target_kind).toBe("run");
      expect(rows[0].data.target_id).toBe(RUNNER_ENTRY.id);
      // Honest about what is known: nobody is identified, so no row claims one.
      expect(rows[0].data.operator).toBeUndefined();
      expect(rows[0].data.chat).toBeUndefined();

      const requested = (await it.read.ledger({ stream: "control", subject: String(rows[0].id) })).filter((row) =>
        /requested/.test(row.kind),
      );
      expect(requested).toHaveLength(1);

      // The hub applies it, through its own seam and no other.
      await until(
        "the hub applied the board's restart",
        async () => (await controlRows(it)).some((row) => row.data.status === "applied"),
        30_000,
        async () => JSON.stringify(await controlRows(it)),
      );
      expect(hub.acting().filter((call) => call.verb === "restart").map((call) => call.id)).toEqual([RUNNER_ENTRY.id]);

      // And the board itself asked the manager nothing at all: the seam it
      // holds throws on every acting verb.
      expect(recorder.calls.filter((call) => ["install", "remove", "start", "stop", "restart"].includes(call.verb))).toEqual(
        [],
      );

      // The outcome is shown from the sheet rather than from the page's memory.
      const shown = await (await board.get("/")).text();
      expect(shown).toContain("applied");
    } finally {
      await running?.stop();
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "the two targets the verb refuses are refused on the page by name, and a GET never acts",
  async () => {
    const staged = await stage();
    try {
      const { board, it } = staged;
      for (const target of [HUB_ENTRY.id, staged.boardEntry.id]) {
        const pressed = await press(board, "/act/restart", { target });
        expect(pressed.status).toBe(303);
        expect(pressed.landed).toContain(actRefused("en", { target, cause: "invalid-recovery-target" }));
      }
      expect(await controlRows(it)).toEqual([]);

      // A link somebody pastes into a chat cannot restart anything.
      for (const path of ["/act/restart", "/act/enabled", "/act/sleeping", "/act/check"]) {
        const answer = await board.get(`${path}?target=${RUNNER_ENTRY.id}`);
        expect(answer.status, `GET ${path}`).toBe(404);
        expect((await answer.text()).trim()).toBe(pageMissing("en"));
      }
      expect(await controlRows(it)).toEqual([]);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "with a writer, stop and pause are one edit to the file and never a control row",
  async () => {
    const staged = await stage({ writer: "yes" });
    try {
      const { board, it, writes } = staged;

      const stopped = await press(board, "/act/enabled", { target: SCHEDULED_ENTRY.id, value: "false" });
      expect(stopped.status).toBe(303);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        table: "run",
        id: SCHEDULED_ENTRY.id,
        key: "enabled",
        value: false,
        file: it.registryFile,
      });
      expect(stopped.landed).toContain(
        editApplied("en", { field: "enabled", value: "false", target: SCHEDULED_ENTRY.id }),
      );
      // NO CONTROL ROW. The hub's reconcile would start the unit again on its
      // next tick, and a hold kept anywhere but the file is a setting the page
      // can set that the file cannot.
      expect(await controlRows(it)).toEqual([]);

      const paused = await press(board, "/act/sleeping", { target: "p1-lair", value: "true" });
      expect(paused.status).toBe(303);
      expect(writes).toHaveLength(2);
      expect(writes[1]).toMatchObject({ table: "agents", id: "p1-lair", key: "sleeping", value: true });
      expect(await controlRows(it)).toEqual([]);

      // The board offers pause on agents and stop on entries, never both on one
      // thing, because on a run entry the two are the same edit.
      const people = await (await board.get("/people")).text();
      const agentRow = new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*p1-lair(?:(?!</tr>)[\\s\\S])*</tr>`).exec(people)?.[0] ?? "";
      expect(agentRow, "the agent should have a row").not.toBe("");
      expect(agentRow).toContain("/act/sleeping");
      expect(agentRow).not.toContain("/act/enabled");

      const machines = await (await board.get("/")).text();
      const entryRow = new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*${SCHEDULED_ENTRY.id}(?:(?!</tr>)[\\s\\S])*</tr>`).exec(machines)?.[0] ?? "";
      expect(entryRow, "the entry should have a row").not.toBe("");
      expect(entryRow).toContain("/act/enabled");
      expect(entryRow).not.toContain("/act/sleeping");
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "with no writer the page says so and changes nothing, and restart still works in the same run",
  async () => {
    const staged = await stage({ writer: "no" });
    const hub = actingSeam();
    let running: Awaited<ReturnType<typeof runHub>> | undefined;
    try {
      const { board, it } = staged;
      running = await runHub({ registryFile: it.registryFile, machine: HERE, os: hub.os });
      const before = treeDigest(dirname(it.registryFile));

      const stopped = await press(board, "/act/enabled", { target: SCHEDULED_ENTRY.id, value: "false" });
      expect(stopped.landed).toContain(editUnavailable("en", { target: SCHEDULED_ENTRY.id }));
      const paused = await press(board, "/act/sleeping", { target: "p1-lair", value: "true" });
      expect(paused.landed).toContain(editUnavailable("en", { target: "p1-lair" }));
      expect(treeDigest(dirname(it.registryFile))).toEqual(before);

      // And the deferral costs the verb that does not need a writer nothing.
      const pressed = await press(board, "/act/restart", { target: RUNNER_ENTRY.id });
      expect(pressed.landed).toContain(actRequested("en", { target: RUNNER_ENTRY.id }));
      expect(await controlRows(it)).toHaveLength(1);
    } finally {
      await running?.stop();
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "a writer that refuses leaves the file exactly as it was",
  async () => {
    const staged = await stage({ writer: "throws" });
    try {
      const { board, it } = staged;
      const before = readFileSync(it.registryFile, "utf8");
      const pressed = await press(board, "/act/enabled", { target: SCHEDULED_ENTRY.id, value: "false" });
      const said = [
        actRefused("en", { target: SCHEDULED_ENTRY.id, cause: "the candidate file would not load" }),
        editUnavailable("en", { target: SCHEDULED_ENTRY.id }),
      ];
      expect(
        said.some((sentence) => pressed.landed.includes(sentence)),
        `the page said neither pinned sentence:\n${pressed.landed.slice(0, 600)}`,
      ).toBe(true);
      expect(readFileSync(it.registryFile, "utf8")).toBe(before);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "check now runs the real check and is the only page action that does",
  async () => {
    const staged = await stage();
    try {
      const { board, it } = staged;
      const sheet = async () => (await it.read.sheet(CHECK_SHEET)).filter((row) => row.id.startsWith(`${HERE}/`));
      expect(await sheet()).toEqual([]);

      const watch = await statementWatch(cluster, [await it.read.pid()]);
      const pressed = await press(board, "/act/check", {});
      expect(pressed.status).toBe(303);
      const wrote = await watch.lines();
      expect(wrote.some((line) => /insert into state_row/i.test(line))).toBe(true);

      const rows = await sheet();
      expect(rows.length).toBeGreaterThan(0);
      // The sentence carries the count that stands and when it ran, compared
      // whole against the sheet's own row count for this machine.
      const count = String(rows.length);
      const at = /check: findings: \d+, as of ([^.]+)\./.exec(pressed.landed)?.[1] ?? "";
      expect(at, `the page said no instant:\n${pressed.landed.slice(0, 600)}`).not.toBe("");
      expect(pressed.landed).toContain(checkRan("en", { count, at }));

      // A plain view of the same page runs none of it.
      const quiet = await statementWatch(cluster, [await it.read.pid()]);
      await board.get("/findings");
      const said = await quiet.lines();
      expect(said.some((line) => /insert into|update |delete from/i.test(line))).toBe(false);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "a sweep of every page with nothing pressed writes no row, calls no writer and moves no sheet",
  async () => {
    // The control on the whole file. A build that acted on a view passes
    // everything above and fails here.
    const staged = await stage();
    try {
      const { board, it, writes } = staged;
      await it.read.sql(
        `insert into state_row (sheet, id, data) values ('check', $1, '{}'::jsonb)`,
        [`${HERE}/planted:one`],
      );
      const before = (await it.read.sheet(CHECK_SHEET)).map((row) => String(row.id));
      const watch = await statementWatch(cluster, [await it.read.pid()]);
      for (const path of PAGES) expect((await board.get(path)).status).toBe(200);
      const said = await watch.lines();
      expect(
        said.filter((line) => /insert into|update |delete from/i.test(line)),
        "a page view wrote something",
      ).toEqual([]);
      expect(writes).toEqual([]);
      expect((await it.read.sheet(CHECK_SHEET)).map((row) => String(row.id))).toEqual(before);
      expect(await controlRows(it)).toEqual([]);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);
