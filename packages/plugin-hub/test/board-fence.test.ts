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
// authentication rule does, asserted below.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore, type StagedHub } from "./helpers/hub-fixture.ts";
import { BOARD_AUTH, BOARD_READER_AUTH, BOARD_OTHER_AUTH, freePort, plantedSeam, recordingSeam, serveBoard, type ServedBoard } from "./helpers/board.ts";
import { isLocalAddress } from "../src/net/address.ts";
import { networkInterfaces } from "node:os";
import type { RunSpec } from "./helpers/registry.ts";
import type { Store } from "../src/store/connect.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";
import { boardAuthPath } from "../src/board/auth.ts";
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

async function stage(peer?: unknown): Promise<Staged> {
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
    people: [{ id: "p1", tree: scratchDir("hub-fence-tree-") }, { id: "p2", tree: scratchDir("hub-fence-other-") }],
    agents: [{ id: "p2-lair", person: "p2", preset: "daily", runner: RUNNER_ENTRY.id }],
    run: [DOOR_ENTRY, RUNNER_ENTRY, boardEntry],
  });
  const store = await superStore(cluster, it.db);
  const board = await serveBoard({
    registryFile: it.registryFile,
    entryId: boardEntry.id,
    store,
    os: recordingSeam(plantedSeam(FLAVOUR).os).os,
    peer,
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
      ...Object.entries({ authorization: BOARD_AUTH, ...headers }).map(([name, value]) => `${name}: ${value}`),
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
      for (const path of ["/", "/people", "/chats", "/usage", "/findings", "/metrics"]) {
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

test("authenticated owner access works locally; unauthenticated local, remote and unknown peers cannot read or act", async () => {
  for (const peer of ["production", () => "192.0.2.10", () => null]) {
    const s = await stage(peer)
    try {
      for (const path of ["/", "/chats", "/chats/p1/p1-lair"]) {
        expect((await s.board.get(path, { headers: { authorization: "" } })).status).toBe(401)
        expect((await s.board.get(path)).status).toBe(200)
      }
      const denied = await raw(s.board.port, "POST", "/act/restart", { host: `127.0.0.1:${s.board.port}`, authorization: "" }, `target=${RUNNER_ENTRY.id}`)
      expect(denied.status).toBe(401)
      expect(await s.it.read.sheet("control")).toEqual([])
      expect((await s.board.post("/act/restart", { target: RUNNER_ENTRY.id })).status).toBe(303)
      expect((await s.it.read.sheet("control"))[0].data.actor).toBe("board:test-owner")
    } finally { await s.stop() }
  }
}, SLOW)

test("a reader cannot act or inspect operator pages, and all accounts are confined to their own chat files", async () => {
  const s = await stage()
  try {
    const own = await s.board.get("/chats", { headers: { authorization: BOARD_READER_AUTH } })
    expect(own.status).toBe(200)
    expect(await own.text()).not.toContain('href="/people"')
    expect((await s.board.get("/people", { headers: { authorization: BOARD_READER_AUTH } })).status).toBe(404)
    for (const auth of [BOARD_AUTH, BOARD_READER_AUTH]) {
      expect((await s.board.get("/chats/p2/p2-lair", { headers: { authorization: auth } })).status).toBe(404)
    }
    for (const path of ["/act/restart", "/act/check", "/act/sleeping", "/act/enabled"]) {
      expect((await raw(s.board.port, "POST", path, { host: `127.0.0.1:${s.board.port}`, authorization: BOARD_READER_AUTH }, `target=${RUNNER_ENTRY.id}`)).status).toBe(404)
    }
    expect(await s.it.read.sheet("control")).toEqual([])
    expect((await s.board.get("/chats/p2/p2-lair", { headers: { authorization: BOARD_OTHER_AUTH } })).status).toBe(200)
    expect((await s.board.get("/chats/p1/p1-lair", { headers: { authorization: BOARD_OTHER_AUTH } })).status).toBe(404)
    expect((await s.board.post("/act/sleeping", { target: "p2-lair", value: "true" })).status).toBe(404)
  } finally { await s.stop() }
}, SLOW)

test("every address this machine holds is this machine, and an address it does not hold is not", () => {
  // The rule reads the machine's own interfaces rather than loopback alone,
  // because an agent on this box reaches the board at the board's own bind
  // address and the kernel hands it that address as its source.
  const mine = Object.values(networkInterfaces())
    .flatMap((one) => one ?? [])
    .map((one) => one.address);
  expect(mine.length, "this machine holds no address at all").toBeGreaterThan(0);
  for (const address of mine) expect(isLocalAddress(address), address).toBe(true);
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    expect(isLocalAddress(address), address).toBe(true);
  }
  // Documentation addresses, which no box on any network this household has
  // holds, so naming a real one here would read as a rule.
  for (const address of ["192.0.2.10", "198.51.100.7", "2001:db8::9"]) {
    expect(isLocalAddress(address), address).toBe(false);
  }
});

test(
  "a page that fails tells a reader nothing about this box",
  async () => {
    // A READER ON THE TAILNET IS NOT AN OPERATOR. Bun's own error page carries
    // the message and the stack of whatever threw, with the absolute paths of
    // this machine in it, and it is what a server hands out unless it is told
    // otherwise. What a reader gets is the status and nothing else, and the
    // cause goes where the operator reads it.
    const staged = await stage();
    try {
      const { board, it } = staged;
      // A page whose reader throws: the registry becomes a file nothing can
      // load, which is what every page here starts by doing.
      const before = readFileSync(it.registryFile, "utf8");
      writeFileSync(it.registryFile, "this is not a registry at all\n[[run\n", "utf8");
      const answer = await board.get("/");
      expect(answer.status).toBe(500);
      const said = await answer.text();
      expect(said, "a reader was handed something to read").toBe("");
      expect(said).not.toContain("registry.toml");
      writeFileSync(it.registryFile, before, "utf8");
      expect((await board.get("/")).status, "the page is served again once the file loads").toBe(200);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);


test("credential revocation is immediate; insecure or missing files fail closed without exposing secrets", async () => {
  const s = await stage()
  try {
    const registry = loadRegistry(s.it.registryFile)
    const file = boardAuthPath(registry, listRunEntries(registry).find(entry => entry.id === "board")!)!
    const original = readFileSync(file, "utf8")
    const demoted = JSON.parse(original)
    demoted.accounts[0].role = "reader"
    writeFileSync(file, JSON.stringify(demoted))
    expect((await s.board.get("/")).status).toBe(303)
    expect((await s.board.post("/act/restart", { target: "runner-test" })).status).toBe(404)
    const changed = JSON.parse(original)
    changed.accounts = changed.accounts.filter((account: { id: string }) => account.id !== "test-owner")
    writeFileSync(file, JSON.stringify(changed))
    expect((await s.board.get("/")).status).toBe(401)
    expect((await s.board.get("/chats", { headers: { authorization: BOARD_READER_AUTH } })).status).toBe(200)
    writeFileSync(file, original)
    expect((await s.board.get("/")).status).toBe(200)
    chmodSync(file, 0o644)
    expect((await s.board.get("/")).status).toBe(503)
    chmodSync(file, 0o600)
    writeFileSync(file, "malformed-secret-file-body")
    const invalid = await s.board.get("/")
    expect(invalid.status).toBe(503)
    expect(await invalid.text()).not.toContain("malformed-secret-file-body")
    rmSync(file)
    expect((await s.board.get("/")).status).toBe(503)
  } finally { await s.stop() }
}, SLOW)

test("credentials are accepted only in Authorization and authenticated pages cannot be cached or embedded cross-origin", async () => {
  const s = await stage()
  try {
    const host = `127.0.0.1:${s.board.port}`
    for (const headers of [{ authorization: "" }, { authorization: `Basic ${Buffer.from(`test-owner:${"d".repeat(64)}`).toString("base64")}` }, { authorization: "Bearer wrong" }, { authorization: "", cookie: `authorization=${BOARD_AUTH}` },
      { authorization: "", "x-forwarded-for": "127.0.0.1", "x-user": "test-owner" }] as Record<string, string>[]) {
      expect((await raw(s.board.port, "GET", "/chats?token=ignored&user=test-owner", { host, ...headers })).status).toBe(401)
    }
    expect((await raw(s.board.port, "GET", "/chats", { host, "sec-fetch-site": "same-site" })).status).toBe(404)
    const allowed = await raw(s.board.port, "GET", "/chats", { host, "sec-fetch-site": "none" })
    expect(allowed.status).toBe(200)
    expect(allowed.headers["cache-control"]).toBe("no-store")
    expect(allowed.headers.vary).toBe("Authorization")
    expect(allowed.headers["referrer-policy"]).toBe("no-referrer")
    expect(text(allowed)).not.toContain(BOARD_AUTH)
  } finally { await s.stop() }
}, SLOW)
