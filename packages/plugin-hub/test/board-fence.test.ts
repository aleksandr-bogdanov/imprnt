// Who may reach the board, and from where. (SPEC §1, RUN-05)
//
// THE BOARD LISTENS ON ONE ADDRESS, and that is not the whole fence. A browser
// on a device that can reach the address will also carry requests that some
// other page wrote: a form another website posts, a website that rebinds its
// own name to the board's address and then reads what comes back, a page one
// frame deep inside somebody else's. None of those is a person pressing a
// button on the board. So a request is served only when it names the board's
// own address and port as its host, an act is taken only when the browser says
// it came from the board's own page, and no page of the board can be framed.
//
// A request that carries neither `Origin` nor `Sec-Fetch-Site` is not a
// browser's, and those headers are not what stops it: the peer rule does,
// asserted in its own test below.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore, type StagedHub } from "./helpers/hub-fixture.ts";
import { freePort, plantedSeam, recordingSeam, serveBoard, type ServedBoard } from "./helpers/board.ts";
import type { RunSpec } from "./helpers/registry.ts";
import type { Store } from "../src/store/connect.ts";
import { pageMissing } from "../src/door/lines.ts";

const SLOW = 120_000;
const HERE = process.platform === "darwin" ? "mac" : "pi";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const FLAVOUR = process.platform === "darwin" ? "launchd" : "systemd";

let cluster: Cluster;
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

interface Staged {
  it: StagedHub;
  store: Store;
  board: ServedBoard;
  stop(): Promise<void>;
}

async function stage(): Promise<Staged> {
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
    people: [{ id: "p1", tree: scratchDir("hub-fence-tree-") }],
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
    async stop() {
      await board.stop();
      await store.close();
      await it.stop();
    },
  };
}

interface RawAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * One request with exactly the headers given, over a socket of its own.
 *
 * `fetch` decides some headers for itself, `Host` among them, and what is
 * asserted here is what the board does with the headers a browser or another
 * page really sends.
 */
async function raw(
  port: number,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  body = "",
): Promise<RawAnswer> {
  const said = await new Promise<string>((resolve, reject) => {
    let text = "";
    const lines = [
      `${method} ${path} HTTP/1.1`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      ...(method === "POST"
        ? ["content-type: application/x-www-form-urlencoded", `content-length: ${Buffer.byteLength(body)}`]
        : []),
      "connection: close",
      "",
      body,
    ];
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(lines.join("\r\n"));
        },
        data(_socket, chunk) {
          text += new TextDecoder().decode(chunk);
        },
        close() {
          resolve(text);
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
  const cut = said.indexOf("\r\n\r\n");
  const head = said.slice(0, cut).split("\r\n");
  const out: Record<string, string> = {};
  for (const line of head.slice(1)) {
    const colon = line.indexOf(":");
    out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(head[0].split(" ")[1]), headers: out, body: said.slice(cut + 4) };
}

/** The body, with chunked framing taken off when the board used it. */
function text(answer: RawAnswer): string {
  if ((answer.headers["transfer-encoding"] ?? "") !== "chunked") return answer.body;
  let out = "";
  let rest = answer.body;
  for (;;) {
    const cut = rest.indexOf("\r\n");
    const size = parseInt(rest.slice(0, cut), 16);
    if (!(size > 0)) return out;
    out += rest.slice(cut + 2, cut + 2 + size);
    rest = rest.slice(cut + 2 + size + 2);
  }
}

test(
  "a request that names any host but the board's own address and port is the one 404",
  async () => {
    const staged = await stage();
    try {
      const port = staged.board.port;
      // A website that rebound its own name to the board's address sends its
      // own name here, and one that points at another port sends that port.
      for (const host of [`board.example:${port}`, "board.example", `127.0.0.1:${port + 1}`, "127.0.0.1"]) {
        const answer = await raw(port, "GET", "/", { host });
        expect(answer.status, `Host: ${host}`).toBe(404);
        expect(text(answer).trim()).toBe(pageMissing("en"));
      }
      // The control on the same socket shape: the board's own host is served.
      const own = await raw(port, "GET", "/", { host: `127.0.0.1:${port}` });
      expect(own.status).toBe(200);
      expect(text(own)).toContain("<h1>machines</h1>");
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "an act another page posted is refused and writes nothing, and the board's own page acts",
  async () => {
    const staged = await stage();
    try {
      const port = staged.board.port;
      const host = `127.0.0.1:${port}`;
      const form = `target=${RUNNER_ENTRY.id}`;
      const refused: Record<string, string>[] = [
        { origin: "http://board.example" },
        // A sandboxed frame, a data: page and a file on disk all say this.
        { origin: "null" },
        { "sec-fetch-site": "cross-site" },
        // Another port on the same address is the same SITE and a different
        // origin, so `same-site` is not the board's own page either.
        { "sec-fetch-site": "same-site", origin: `http://127.0.0.1:${port + 1}` },
        { "sec-fetch-site": "same-site" },
        { origin: `https://${host}` },
      ];
      for (const headers of refused) {
        const answer = await raw(port, "POST", "/act/restart", { host, ...headers }, form);
        expect(answer.status, JSON.stringify(headers)).toBe(404);
        expect(text(answer).trim()).toBe(pageMissing("en"));
      }
      expect(await staged.it.read.sheet("control"), "a refused act wrote a row").toEqual([]);

      // The control: the headers the board's own form sends when a person
      // presses the button, on the same path with the same form.
      const pressed = await raw(
        port,
        "POST",
        "/act/restart",
        { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" },
        form,
      );
      expect(pressed.status).toBe(303);
      const rows = await staged.it.read.sheet("control");
      expect(rows).toHaveLength(1);
      expect(rows[0].data.target_id).toBe(RUNNER_ENTRY.id);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "no page of the board can be framed by another page",
  async () => {
    // A page one frame deep inside somebody else's is a page whose buttons a
    // person can be tricked into pressing, and the press would carry the
    // board's own origin.
    const staged = await stage();
    try {
      for (const path of ["/", "/people", "/findings", "/metrics"]) {
        const answer = await staged.board.get(path);
        expect(answer.status, path).toBe(200);
        expect(answer.headers.get("x-frame-options"), path).toBe("DENY");
        expect(answer.headers.get("content-security-policy") ?? "", path).toContain("frame-ancestors 'none'");
      }
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);
