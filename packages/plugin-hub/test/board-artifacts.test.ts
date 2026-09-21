// A person's artifacts are served when that person opted in, from under the
// real path of their own directory, one file at a time. (SPEC §1, §6)
//
// ONE PERSON BY DEFAULT, OPT IN PER PERSON. The field absent means NOT served,
// so a household that adds a second person does not quietly publish their notes
// by adding them to the file. Widening what the household exposes is one
// deliberate line in the registry and nothing else.
//
// THE RULE IS THE REAL PATH. The real path of the requested file must sit under
// the real path of `<tree>/artifacts`, which refuses a `..`, a symlink pointing
// out and a path that is not a file in one rule rather than three. There is no
// listing anywhere, because a listing is enumeration.
//
// Red reason: behaviour absent for the loader, which tolerates `artifacts` as a
// key it has no rule about, and import missing for `src/board/artifacts.ts`
// behind the rest.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam, startCluster, statementWatch, until, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore, type StagedHub } from "./helpers/hub-fixture.ts";
import { freePort, plantedSeam, recordingSeam, serveBoard, setOnEntry, treeDigest, type ServedBoard } from "./helpers/board.ts";
import { writeRegistry, type PersonSpec, type RegistrySpec, type RunSpec } from "./helpers/registry.ts";
import { listPeople } from "../src/registry/entries.ts";
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts";
import type { Store } from "../src/store/connect.ts";
import { artifactsNotBoolean, pageMissing } from "../src/door/lines.ts";

const SLOW = 120_000;
const HERE = process.platform === "darwin" ? "mac" : "pi";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const FLAVOUR = process.platform === "darwin" ? "launchd" : "systemd";

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

/** What an agent has built for a person, planted the way an agent writes it. */
const PLANTED: Record<string, string> = {
  "index.html": "<!doctype html><title>a page an agent built</title>",
  "note.txt": "a note an agent wrote",
  "picture.png": "not really a png, and the type comes from the name",
  "data.bin": "bytes nothing on the web has a name for",
  ".hidden": "a dotfile nobody asked to publish",
  "sub/deep.txt": "a file one directory down",
};

function plantTree(tree: string): void {
  const root = join(tree, "artifacts");
  mkdirSync(join(root, "sub"), { recursive: true });
  for (const [path, text] of Object.entries(PLANTED)) {
    writeFileSync(join(root, path), text, "utf8");
  }
}

interface Staged {
  it: StagedHub;
  store: Store;
  board: ServedBoard;
  trees: Record<string, string>;
  outside: string;
  stop(): Promise<void>;
}

async function stage(): Promise<Staged> {
  const trees: Record<string, string> = {
    p1: scratchDir("hub-art-p1-"),
    p2: scratchDir("hub-art-p2-"),
  };
  plantTree(trees.p1);
  plantTree(trees.p2);
  // A file OUTSIDE every tree, and a symlink inside p1's artifacts pointing at
  // it, so the real-path rule is asserted against a link with a real target.
  const outside = join(scratchDir("hub-art-outside-"), "secret.txt");
  writeFileSync(outside, "a file that is not anybody's artifact", "utf8");
  symlinkSync(outside, join(trees.p1, "artifacts", "escape.txt"));

  const boardEntry: RunSpec = {
    id: "board",
    kind: "board",
    machine: HERE,
    schedule: "always",
    memory_limit_mb: 128,
    bind: "127.0.0.1",
    port: await freePort(),
    artifacts_port: await freePort(),
  };
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [{ id: HERE, os: HERE_OS }],
    people: [
      { id: "p1", tree: trees.p1, artifacts: true },
      { id: "p2", tree: trees.p2 },
      // A person whose tree is not on this machine at all.
      { id: "p3", tree: "/var/lib/imprnt-hub/p3-not-here", artifacts: true },
    ],
    run: [DOOR_ENTRY, RUNNER_ENTRY, boardEntry],
  });
  const store = await superStore(cluster, it.db);
  const board = await serveBoard({
    registryFile: it.registryFile,
    entryId: boardEntry.id,
    store,
    os: recordingSeam(plantedSeam(FLAVOUR).os).os,
  });
  return {
    it,
    store,
    board,
    trees,
    outside,
    async stop() {
      await board.stop();
      await store.close();
      await it.stop();
    },
  };
}

/**
 * A request with the path EXACTLY as written, over a socket of its own.
 *
 * `fetch` folds a `..` away before the request leaves, and what is being
 * asserted is what the board does when one arrives, which a proxy or a client
 * that does not normalise will send.
 */
async function rawGet(port: number, path: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let said = "";
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        },
        data(_socket, chunk) {
          said += new TextDecoder().decode(chunk);
        },
        close() {
          resolve(said);
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}

test(
  "the opted-in person's files are served with their bytes and their type, and everything else is the one 404",
  async () => {
    const staged = await stage();
    try {
      const { board, trees, outside } = staged;
      const types: Record<string, string> = {
        "index.html": "text/html",
        "note.txt": "text/plain",
        "picture.png": "image/png",
        "sub/deep.txt": "text/plain",
        "data.bin": "application/octet-stream",
      };
      for (const [path, type] of Object.entries(types)) {
        const answer = await board.artifact(`/artifacts/p1/${path}`);
        expect(answer.status, `/artifacts/p1/${path}`).toBe(200);
        expect(await answer.text()).toBe(PLANTED[path]);
        expect(answer.headers.get("content-type") ?? "").toContain(type);
      }

      // The person who did not opt in, with the file proved present on disk in
      // the same check, so nobody can read the 404 as a missing file.
      expect(readFileSync(join(trees.p2, "artifacts", "index.html"), "utf8")).toBe(PLANTED["index.html"]);
      const refused = await board.artifact("/artifacts/p2/index.html");
      expect(refused.status).toBe(404);
      expect((await refused.text()).trim()).toBe(pageMissing("en"));

      // A person the file does not declare, and one whose tree is not here.
      for (const who of ["p9", "p3"]) {
        const answer = await board.artifact(`/artifacts/${who}/index.html`);
        expect(answer.status, `/artifacts/${who}/index.html`).toBe(404);
      }

      // The five refused shapes, one at a time. The symlink has a real target
      // and the target is readable from this check, which is what makes its
      // refusal about the rule rather than about a broken link.
      expect(readFileSync(outside, "utf8")).toContain("not anybody's artifact");
      for (const path of [
        "/artifacts/p1/%2e%2e%2f%2e%2e%2fsecret.txt",
        "/artifacts/p1/escape.txt",
        "/artifacts/p1/",
        "/artifacts/p1/sub",
        "/artifacts/p1/.hidden",
      ]) {
        const answer = await board.get(path);
        expect(answer.status, `${path} should be refused`).toBe(404);
        const text = await answer.text();
        expect(text.trim()).toBe(pageMissing("en"));
        // NO LISTING ANYWHERE, so a directory path says nothing about what is
        // inside it.
        for (const name of ["index.html", "note.txt", "deep.txt"]) expect(text).not.toContain(name);
      }

      // And a `..` exactly as a client that does not normalise would send it.
      const raw = await rawGet(staged.board.artifactsPort!, "/artifacts/p1/../../secret.txt");
      expect(raw.split("\r\n")[0]).toContain("404");
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "artifacts are served from an origin of their own, and neither origin answers for the other",
  async () => {
    // AN AGENT WRITES WHAT IS SERVED HERE. A page an agent wrote, opened from a
    // link in a chat, would be the board's own origin if the two shared one
    // port: its script could read every page and its form could press every
    // button, with the browser saying, truthfully, that the press came from the
    // board's own origin. A port of its own is a different origin, so the
    // browser refuses it all, and the acts are behind a port that serves no
    // agent's bytes at all.
    const staged = await stage();
    try {
      const { board } = staged;
      expect(board.artifactsPort, "the board must serve artifacts on a port of its own").not.toBeNull();
      expect(board.artifactsPort).not.toBe(board.port);

      const served = await board.artifact("/artifacts/p1/index.html");
      expect(served.status).toBe(200);
      expect(await served.text()).toBe(PLANTED["index.html"]);

      // The page's own origin serves no artifact at all.
      const wrong = await board.get("/artifacts/p1/index.html");
      expect(wrong.status, "the acts origin must not serve an agent's bytes").toBe(404);
      expect((await wrong.text()).trim()).toBe(pageMissing("en"));

      // And the artifacts origin carries no page and takes no act.
      for (const path of ["/", "/people", "/findings", "/metrics"]) {
        const page = await board.artifact(path);
        expect(page.status, `${path} on the artifacts origin`).toBe(404);
        expect((await page.text()).trim()).toBe(pageMissing("en"));
      }
      const pressed = await fetch(`${board.artifactsUrl}/act/restart`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "target=runner-test",
      });
      expect(pressed.status, "an act on the artifacts origin").toBe(404);
      expect(await staged.it.read.sheet("control")).toEqual([]);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "the route reads the filesystem and the registry, writes nothing and asks the store nothing",
  async () => {
    const staged = await stage();
    try {
      const { board, it, trees } = staged;
      const before = { p1: treeDigest(trees.p1), p2: treeDigest(trees.p2) };
      const watch = await statementWatch(cluster, [await it.read.pid()]);
      for (const path of [
        "/artifacts/p1/index.html",
        "/artifacts/p1/sub/deep.txt",
        "/artifacts/p2/index.html",
        "/artifacts/p1/.hidden",
        "/artifacts/p1/escape.txt",
        "/artifacts/p9/index.html",
      ]) {
        await board.get(path);
      }
      expect(await watch.lines()).toEqual([]);
      expect(treeDigest(trees.p1)).toEqual(before.p1);
      expect(treeDigest(trees.p2)).toEqual(before.p2);

      // A file an agent writes NOW is served now. The agent writes into its own
      // tree, which its box already lets it write, so there is no publish verb
      // and nothing the hub has to hold.
      writeFileSync(join(trees.p1, "artifacts", "fresh.txt"), "written while the board was up", "utf8");
      const answer = await board.artifact("/artifacts/p1/fresh.txt");
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe("written while the board was up");
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "moving the opt-in from one person to the other flips every answer",
  async () => {
    // The control on the whole file: a build that served every tree passes the
    // first assertion and fails this one.
    const staged = await stage();
    try {
      const { board, it } = staged;
      expect((await board.artifact("/artifacts/p1/index.html")).status).toBe(200);
      expect((await board.artifact("/artifacts/p2/index.html")).status).toBe(404);

      setOnEntry(it.registryFile, "p1", "artifacts", null);
      setOnEntry(it.registryFile, "p2", "artifacts", "true");

      expect((await board.artifact("/artifacts/p1/index.html")).status).toBe(404);
      expect((await board.artifact("/artifacts/p2/index.html")).status).toBe(200);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

/**
 * A board over two opted-in people whose trees a check lays out itself, so a
 * check can plant a link where the stage above plants a directory.
 */
async function stagePeople(trees: { p1: string; p2: string }): Promise<{ get(path: string): Promise<Response>; stop(): Promise<void> }> {
  const boardEntry: RunSpec = {
    id: "board",
    kind: "board",
    machine: HERE,
    schedule: "always",
    memory_limit_mb: 128,
    bind: "127.0.0.1",
    port: await freePort(),
    artifacts_port: await freePort(),
  };
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    machines: [{ id: HERE, os: HERE_OS }],
    people: [
      { id: "p1", tree: trees.p1, artifacts: true },
      { id: "p2", tree: trees.p2, artifacts: true },
    ],
    run: [DOOR_ENTRY, RUNNER_ENTRY, boardEntry],
  });
  const store = await superStore(cluster, it.db);
  const board = await serveBoard({
    registryFile: it.registryFile,
    entryId: boardEntry.id,
    store,
    os: recordingSeam(plantedSeam(FLAVOUR).os).os,
  });
  return {
    get: (path) => board.artifact(path),
    async stop() {
      await board.stop();
      await store.close();
      await it.stop();
    },
  };
}

test(
  "an artifacts directory that is itself a link is refused, wherever it points",
  async () => {
    // An agent can write its own tree, so it can replace its own artifacts
    // directory with a link to anything the board can read: the other
    // person's chat log, the state directory, a secret. What is planted here
    // is a secret outside every tree and a p1 whose `artifacts` IS a link to
    // the directory holding it.
    const secretDir = scratchDir("hub-art-secret-");
    const secret = "the other person's chat log, which nobody published";
    writeFileSync(join(secretDir, "log.txt"), secret, "utf8");
    const trees = { p1: scratchDir("hub-art-linked-p1-"), p2: scratchDir("hub-art-linked-p2-") };
    symlinkSync(secretDir, join(trees.p1, "artifacts"));
    // The control on the same path shape: p2's `artifacts` is a real directory
    // holding a file of the same name, and it is served.
    mkdirSync(join(trees.p2, "artifacts"), { recursive: true });
    writeFileSync(join(trees.p2, "artifacts", "log.txt"), "an artifact the second person published", "utf8");
    const staged = await stagePeople(trees);
    try {
      // The link is live and its target readable from this check, so the
      // refusal below is about the rule and never about a broken link.
      expect(readFileSync(join(trees.p1, "artifacts", "log.txt"), "utf8")).toBe(secret);

      const refused = await staged.get("/artifacts/p1/log.txt");
      const text = await refused.text();
      expect(refused.status, "a linked artifacts directory must not be served").toBe(404);
      expect(text).not.toContain(secret);
      expect(text.trim()).toBe(pageMissing("en"));

      const served = await staged.get("/artifacts/p2/log.txt");
      expect(served.status).toBe(200);
      expect(await served.text()).toBe("an artifact the second person published");
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

/** What the route hands back: an open file, or a path for a server to open. */
type Opened = { handle?: { readFile(encoding: "utf8"): Promise<string>; close(): Promise<void> }; path?: string };

test("a directory swapped for a link between the decision and the open never lets an outside file through", async () => {
  // THE PATH IS DECIDED AND THEN OPENED, and a directory inside the tree can
  // be swapped for a link between the two, because the agent writes that tree.
  // Racing that for real is a matter of microseconds and luck, so the swap is
  // landed exactly there, through the one hook the route takes for it, and what
  // comes back is judged by its bytes.
  const { serveArtifact } = await seam("src/board/artifacts.ts");
  const serve = serveArtifact as (args: Record<string, unknown>) => Promise<Opened | null> | Opened | null;
  const outside = scratchDir("hub-art-swap-outside-");
  const secret = "outside bytes that no artifact route may ever serve";
  writeFileSync(join(outside, "page.txt"), secret, "utf8");
  const tree = scratchDir("hub-art-swap-p1-");
  const box = join(tree, "artifacts", "box");
  mkdirSync(box, { recursive: true });
  writeFileSync(join(box, "page.txt"), "inside bytes", "utf8");
  const registry = loadRegistry(
    writeRegistry(scratchDir("hub-art-swap-registry-"), {
      hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: "/var/lib/imprnt-hub" },
      machines: [{ id: "pi", os: "linux" }],
      people: [{ id: "p1", tree, artifacts: true }],
      presets: { daily: { adapter: "scripted", model: "m", provider: "p", effort: "medium", paid: "plan" } },
      agents: [{ id: "p1-lair", person: "p1", preset: "daily", chat: "0000000000", door: "door-fake", runner: "runner-pi" }],
      run: [
        { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      ],
    }),
  );
  /**
   * The bytes a caller would send for what the route handed back: the open
   * file itself, or, for a route that hands back a path, whatever that path
   * opens to when the server gets round to it.
   */
  const bytesOf = async (found: Opened): Promise<string> => {
    if (found.handle) {
      try {
        return await found.handle.readFile("utf8");
      } finally {
        await found.handle.close();
      }
    }
    return readFileSync(String(found.path), "utf8");
  };

  // The control on the same call: with nothing swapped the in-tree file comes
  // back, so a null below is the rule and not a route that serves nothing.
  const plain = await serve({ registry, person: "p1", path: "box/page.txt" });
  expect(plain, "the in-tree file must be served when nothing moves").not.toBeNull();
  expect(await bytesOf(plain!)).toBe("inside bytes");

  // The swap, landed between the decision and the open.
  const swapped = await serve({
    registry,
    person: "p1",
    path: "box/page.txt",
    beforeOpen() {
      renameSync(box, `${box}-held`);
      symlinkSync(outside, box);
    },
  });
  const said = swapped === null ? null : await bytesOf(swapped);
  expect(said, "the outside file's bytes came back").not.toBe(secret);
  expect(swapped, "a path that led outside by the time it was opened must be refused").toBeNull();
});

test(
  "serving an artifact holds no descriptor once the response is over, read whole or abandoned",
  async () => {
    // The file is served from the descriptor that was checked, so each request
    // opens one. Two hundred requests read whole and twenty abandoned after the
    // headers must leave the process holding what it held before, give or take
    // the client's own pooled connections.
    const staged = await stage();
    try {
      const open = () => readdirSync("/dev/fd").length;
      const warm = await staged.board.artifact("/artifacts/p1/index.html");
      await warm.text();
      const before = open();
      for (let i = 0; i < 200; i++) {
        const answer = await staged.board.artifact("/artifacts/p1/index.html");
        expect(await answer.text()).toBe(PLANTED["index.html"]);
      }
      for (let i = 0; i < 20; i++) {
        const answer = await staged.board.artifact("/artifacts/p1/note.txt");
        await answer.body?.cancel();
      }
      await until("the abandoned bodies let go of their descriptors", async () => open() - before < 20, 10_000,
        async () => `descriptors held: ${open() - before} more than before`);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test("the loader refuses an artifacts that is not a boolean, by key and by line", () => {
  const spec = (people: PersonSpec[]): RegistrySpec => ({
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: "/var/lib/imprnt-hub" },
    machines: [{ id: "pi", os: "linux" }],
    people,
    presets: { daily: { adapter: "scripted", model: "m", provider: "p", effort: "medium", paid: "plan" } },
    agents: [{ id: "p1-lair", person: "p1", preset: "daily", chat: "0000000000", door: "door-fake", runner: "runner-pi" }],
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
    ],
  });
  const write = (people: PersonSpec[]) => {
    const file = writeRegistry(scratchDir("hub-art-registry-"), spec(people));
    return { file, text: readFileSync(file, "utf8") };
  };

  const { file, text } = write([
    { id: "p1", tree: "/var/lib/imprnt-hub/p1", artifacts: "yes" as unknown as boolean },
    { id: "p2", tree: "/var/lib/imprnt-hub/p2" },
  ]);
  let caught: unknown;
  try {
    loadRegistry(file);
  } catch (error) {
    caught = error;
  }
  expect(caught, "the loader must refuse this file").toBeInstanceOf(RegistryRefused);
  const error = caught as RegistryRefused;
  expect(error.key).toBe("people[0].artifacts");
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /^\s*artifacts\s*=/.test(line)) + 1;
  expect(error.line).toBe(at);
  expect(error.reason).toBe(artifactsNotBoolean("en", { id: "p1", value: "yes" }));

  // The controls: both booleans load, and a person who says nothing about it
  // carries no such key at all, which is the shape a shipped check binds.
  for (const artifacts of [true, false]) {
    const one = write([{ id: "p1", tree: "/var/lib/imprnt-hub/p1", artifacts }, { id: "p2", tree: "/var/lib/imprnt-hub/p2" }]);
    const person = listPeople(loadRegistry(one.file)).find((row) => row.id === "p1")!;
    expect((person as { artifacts?: boolean }).artifacts).toBe(artifacts);
  }
  const silent = write([{ id: "p1", tree: "/var/lib/imprnt-hub/p1" }, { id: "p2", tree: "/var/lib/imprnt-hub/p2" }]);
  const rows = listPeople(loadRegistry(silent.file));
  expect(Object.hasOwn(rows.find((row) => row.id === "p1")!, "artifacts")).toBe(false);
  expect(rows.find((row) => row.id === "p1")).toEqual({ id: "p1", tree: "/var/lib/imprnt-hub/p1" });
});

test("artifactsFor answers the directory for a person who opted in and null for everyone else", async () => {
  const { artifactsFor } = await seam("src/registry/entries.ts");
  expect(typeof artifactsFor, "artifactsFor must be a function").toBe("function");
  const asked = artifactsFor as (registry: unknown, person: string) => string | null;
  const file = writeRegistry(scratchDir("hub-art-registry-"), {
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: "/var/lib/imprnt-hub" },
    machines: [{ id: "pi", os: "linux" }],
    people: [
      { id: "p1", tree: "/var/lib/imprnt-hub/p1", artifacts: true },
      { id: "p2", tree: "/var/lib/imprnt-hub/p2" },
      { id: "p3", tree: "/var/lib/imprnt-hub/p3", artifacts: false },
    ],
    presets: { daily: { adapter: "scripted", model: "m", provider: "p", effort: "medium", paid: "plan" } },
    agents: [{ id: "p1-lair", person: "p1", preset: "daily", chat: "0000000000", door: "door-fake", runner: "runner-pi" }],
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
    ],
  });
  const registry = loadRegistry(file);
  expect(asked(registry, "p1")).toBe("/var/lib/imprnt-hub/p1/artifacts");
  expect(asked(registry, "p2")).toBeNull();
  expect(asked(registry, "p3")).toBeNull();
  expect(asked(registry, "p9")).toBeNull();
});
