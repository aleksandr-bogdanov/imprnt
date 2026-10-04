// Who may reach the board, and from where. (SPEC §1, RUN-05)
//
// THE TAILNET IS THE BOUNDARY, by the owner's ruling, and nobody signs in. The
// board listens on one address, and that is not the whole fence: a browser on a
// device that can reach the address will also carry requests that some other
// page wrote: a form another website posts, a website that rebinds its own name
// to the board's address and then reads what comes back, a page one frame deep
// inside somebody else's. None of those is a person pressing a button on the
// board. So a request is served only when it names the board's own address, or
// one of the exact names its entry lists, and its port as its host, an act is
// taken only when the browser says it came from the board's own page, and no
// page of the board can be framed.
//
// A request that carries neither `Origin` nor `Sec-Fetch-Site` is not a
// browser's, and those headers are not what stops it: the peer rule does. An
// act whose peer is this machine is refused, because every agent box on it
// shares its network, and the peer is the socket's, never a header.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubPath, startCluster, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore, type StagedHub } from "./helpers/hub-fixture.ts";
import { freePort, plantedSeam, recordingSeam, serveBoard, type ServedBoard } from "./helpers/board.ts";
import { isLocalAddress } from "../src/net/address.ts";
import { networkInterfaces } from "node:os";
import type { RunSpec } from "./helpers/registry.ts";
import type { Store } from "../src/store/connect.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { secretsDirOf } from "../src/store/secrets.ts";
import { pageMissing } from "../src/door/lines.ts";

const SLOW = 120_000;
const HERE = process.platform === "darwin" ? "mac" : "pi";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const FLAVOUR = process.platform === "darwin" ? "launchd" : "systemd";

/** Generic names, the shape a tailnet gives a machine: short, and full. */
const SHORT = "hub-device";
const FULL = "hub-device.example.ts.net";

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

async function stage(peer?: unknown, hosts?: string[]): Promise<Staged> {
  const boardEntry: RunSpec = {
    id: "board",
    kind: "board",
    machine: HERE,
    schedule: "always",
    memory_limit_mb: 128,
    bind: "127.0.0.1",
    port: await freePort(),
    ...(hosts === undefined ? {} : { hosts }),
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
      for (const host of [`board.example:${port}`, "board.example", `127.0.0.1:${port + 1}`, "127.0.0.1", `${SHORT}:${port}`]) {
        const answer = await raw(port, "GET", "/", { host });
        expect(answer.status, `Host: ${host}`).toBe(404);
        expect(text(answer).trim()).toBe(pageMissing("en"));
      }
      // The control on the same socket shape: the board's own host is served.
      const own = await raw(port, "GET", "/", { host: `127.0.0.1:${port}` });
      expect(own.status).toBe(200);
      expect(text(own)).toContain("<title>status</title>");
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "a name the entry lists opens the board exactly, on its own port only, and every other name is still refused",
  async () => {
    const staged = await stage(undefined, [SHORT, FULL]);
    try {
      const port = staged.board.port;
      // The address keeps working beside the names.
      for (const host of [`127.0.0.1:${port}`, `${SHORT}:${port}`, `${FULL}:${port}`, `HUB-Device:${port}`, `${FULL.toUpperCase()}:${port}`]) {
        const answer = await raw(port, "GET", "/", { host });
        expect(answer.status, `Host: ${host}`).toBe(200);
        expect(text(answer)).toContain("<title>status</title>");
      }
      // Nothing near a listed name is that name: no suffix, no prefix, no
      // trailing dot, no other port, no other machine, nothing resolved.
      for (const host of [
        `${SHORT}:${port + 1}`,
        SHORT,
        `${FULL}.:${port}`,
        `evil.${FULL}:${port}`,
        `${SHORT}.evil.example:${port}`,
        `other-device.example.ts.net:${port}`,
        `example.ts.net:${port}`,
        `${SHORT}x:${port}`,
      ]) {
        const answer = await raw(port, "GET", "/", { host });
        expect(answer.status, `Host: ${host}`).toBe(404);
        expect(text(answer).trim()).toBe(pageMissing("en"));
      }

      // An act from the board's own page opened by name carries that name as
      // its Origin, and it is the board's own; another site is refused all the
      // same under the listed Host.
      const host = `${FULL}:${port}`;
      const form = `target=${RUNNER_ENTRY.id}`;
      for (const headers of [
        { origin: `http://${SHORT}:${port}`, "sec-fetch-site": "cross-site" },
        { origin: `http://evil.${FULL}:${port}` },
        { origin: `http://${FULL}:${port + 1}` },
        { "sec-fetch-site": "same-site" },
      ] as Record<string, string>[]) {
        const refused = await raw(port, "POST", "/act/restart", { host, ...headers }, form);
        expect(refused.status, JSON.stringify(headers)).toBe(404);
      }
      expect(await staged.it.read.sheet("control"), "a refused act wrote a row").toEqual([]);
      const pressed = await raw(port, "POST", "/act/restart", { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" }, form);
      expect(pressed.status).toBe(303);
      expect(await staged.it.read.sheet("control")).toHaveLength(1);
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
        // A typed address or a bookmark is a read, never a press.
        { "sec-fetch-site": "none" },
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

test(
  "nobody signs in: every peer reads every status page, and only another device reads a chat or has an act taken",
  async () => {
    // "production" is the server's own reader, which answers this machine for
    // a check in this runtime; null is a peer nothing could place.
    for (const [peer, acts] of [["production", false], [() => null, false], [() => "192.0.2.10", true]] as [unknown, boolean][]) {
      const s = await stage(peer);
      try {
        const host = `127.0.0.1:${s.board.port}`;
        for (const path of ["/", "/people", "/usage", "/findings", "/metrics"]) {
          const answer = await s.board.get(path);
          expect(answer.status, `${path} for ${String(peer)}`).toBe(200);
          expect(answer.headers.get("www-authenticate"), path).toBeNull();
          // A credential somebody still sends is a header nothing reads.
          expect((await s.board.get(path, { headers: { authorization: "Basic dGVzdDp0ZXN0" } })).status).toBe(200);
        }
        // What people said: an agent on this machine is boxed away from every
        // other person's chatlog, and the board does not hand it back.
        for (const path of ["/chats", "/chats/p1/p1-lair", "/chats/p2/p2-lair"]) {
          const answer = await s.board.get(path);
          expect(answer.status, `${path} for ${String(peer)}`).toBe(acts ? 200 : 404);
          expect(answer.headers.get("www-authenticate"), path).toBeNull();
          if (!acts) expect((await answer.text()).trim(), path).toBe(pageMissing("en"));
        }
        const pressed = await raw(s.board.port, "POST", "/act/restart",
          { host, origin: `http://${host}`, "sec-fetch-site": "same-origin" }, `target=${RUNNER_ENTRY.id}`);
        expect(pressed.status, `a press from ${String(peer)}`).toBe(acts ? 303 : 404);
        const rows = await s.it.read.sheet("control");
        if (acts) {
          expect(rows).toHaveLength(1);
          expect(rows[0].data.actor).toBe("board");
        } else {
          expect(rows, "a press from this machine wrote a row").toEqual([]);
          for (const path of ["/act/restart", "/act/check", "/act/sleeping", "/act/enabled"]) {
            expect((await s.board.post(path, { target: RUNNER_ENTRY.id })).status, path).toBe(404);
          }
          expect(await s.it.read.sheet("control")).toEqual([]);
        }
      } finally { await s.stop() }
    }
  },
  SLOW,
);

test(
  "the peer is the socket's: a forwarded header from this machine claiming another device is refused",
  async () => {
    const s = await stage("production");
    try {
      const host = `127.0.0.1:${s.board.port}`;
      for (const claim of [
        { "x-forwarded-for": "192.0.2.10" },
        { forwarded: "for=192.0.2.10" },
        { "x-real-ip": "192.0.2.10" },
        { "x-forwarded-for": "192.0.2.10", forwarded: "for=192.0.2.10;proto=http", "x-real-ip": "192.0.2.10" },
      ] as Record<string, string>[]) {
        const answer = await raw(s.board.port, "POST", "/act/restart",
          { host, origin: `http://${host}`, "sec-fetch-site": "same-origin", ...claim }, `target=${RUNNER_ENTRY.id}`);
        expect(answer.status, JSON.stringify(claim)).toBe(404);
      }
      expect(await s.it.read.sheet("control")).toEqual([]);
      // A read from this machine is a read, and it is served.
      expect((await raw(s.board.port, "GET", "/", { host })).status).toBe(200);
    } finally { await s.stop() }
  },
  SLOW,
);

test(
  "every household chat is visible and every agent's pause is offered, with nothing filtered per person",
  async () => {
    const s = await stage();
    try {
      const list = await (await s.board.get("/chats")).text();
      expect(list).toContain('href="/chats/p1/p1-lair"');
      // p2's agent takes jobs and has no chat: it is listed by name, not
      // hidden, and is not a link to a chat that cannot exist.
      expect(list).toContain('<span class="name">p2-lair</span><span class="who">worker</span>');
      // The nav is the whole board for everyone.
      for (const path of ["/", "/people", "/chats", "/usage", "/findings", "/metrics"]) {
        expect(list).toContain(path === "/chats" ? "<strong>chats</strong>" : `href="${path}"`);
      }
      const people = await (await s.board.get("/people")).text();
      for (const agent of ["p1-lair", "p2-lair"]) {
        expect(people, `${agent} has no pause`).toMatch(new RegExp(`name="target" value="${agent}"`));
      }
      // Another person's agent is pressed like any other: with no writer this
      // board says so, and it is an answer rather than a refusal.
      expect((await s.board.post("/act/sleeping", { target: "p2-lair", value: "true" })).status).toBe(303);
    } finally { await s.stop() }
  },
  SLOW,
);

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
  // An address nothing could place is refused, which is the safe reading.
  expect(isLocalAddress(null)).toBe(true);
  expect(isLocalAddress("")).toBe(true);
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

test(
  "a board verifier an earlier build left in the secrets directory is never read, and nothing imports the retired gate",
  async () => {
    const s = await stage();
    try {
      // Malformed and readable by anyone: the retired gate answered this file
      // with 503 on every page. The board now never opens it, so it changes
      // nothing, and it is left exactly where it is.
      const dir = secretsDirOf(loadRegistry(s.it.registryFile))!;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, "board-board-auth.json");
      writeFileSync(file, "malformed-verifier-body", { mode: 0o644 });
      for (const path of ["/", "/chats", "/people"]) {
        const answer = await s.board.get(path);
        expect(answer.status, path).toBe(200);
        expect(await answer.text()).not.toContain("malformed-verifier-body");
      }
      expect(readFileSync(file, "utf8")).toBe("malformed-verifier-body");
    } finally { await s.stop() }

    // Structurally: no module of the hub imports the retired account module.
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((one) =>
      one.isDirectory() ? walk(join(dir, one.name)) : one.name.endsWith(".ts") ? [join(dir, one.name)] : []);
    const board = hubPath("src/board");
    for (const file of walk(hubPath("src"))) {
      if (file === join(board, "auth.ts")) continue;
      const source = readFileSync(file, "utf8");
      expect(source, `${file} imports the retired board account module`).not.toMatch(/from\s+["'][^"']*board\/auth(\.ts)?["']/);
      if (file.startsWith(`${board}/`)) {
        expect(source, `${file} imports the retired board account module`).not.toMatch(/from\s+["']\.\/auth(\.ts)?["']/);
      }
    }
  },
  SLOW,
);

test(
  "headers are a browser fence and never identity: a read from a typed address is served, cached nowhere, and leaks no referrer",
  async () => {
    const s = await stage();
    try {
      const host = `127.0.0.1:${s.board.port}`;
      expect((await raw(s.board.port, "GET", "/chats", { host, "sec-fetch-site": "same-site" })).status).toBe(404);
      expect((await raw(s.board.port, "GET", "/chats", { host, "sec-fetch-site": "cross-site" })).status).toBe(404);
      const allowed = await raw(s.board.port, "GET", "/chats", { host, "sec-fetch-site": "none" });
      expect(allowed.status).toBe(200);
      expect(allowed.headers["cache-control"]).toBe("no-store");
      expect(allowed.headers["referrer-policy"]).toBe("no-referrer");
      expect(allowed.headers["x-content-type-options"]).toBe("nosniff");
      expect(allowed.headers["www-authenticate"]).toBeUndefined();
      expect(allowed.headers.vary ?? "").not.toMatch(/authorization/i);
    } finally { await s.stop() }
  },
  SLOW,
);
