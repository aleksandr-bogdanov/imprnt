// The recognizer's reference server is in the package, every knob is an
// argument, and it reads no environment variable.
//
// The household's own recognizer has been a loopback server whose every knob was
// an environment variable, which is the one shape the spec forbids outright. It
// is copied here with the knobs turned into arguments and its own chunking taken
// out, because the client cuts. This check drives the COPY, as a child on a
// kernel-picked port with the stub backend, which is how it can run on a box
// with no model and no virtual environment at all.
//
// No Postgres, no door, no runner, so none of the six protected windows is
// reachable from here. The child is killed after every check, and the port it
// bound is read off its own first stderr line, which is what that line is for.

import { afterEach, expect, test } from "bun:test";
import net from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubPath } from "./helpers/cluster.ts";

const SERVER = hubPath("tools/transcribe-server.py");

/** The interpreter, or the reason every spawn here is skipped. */
const PYTHON = Bun.which("python3");
const PYTHON_SUFFIX = PYTHON ? "" : " [skipped: python3 is not on PATH]";

/** The converter, which one startup guard here is only reachable without. */
const FFMPEG = Bun.which("ffmpeg");

/** What the stub backend answers for any body. Fixed, so it is assertable. */
const FAKE_TEXT = "the quick brown fox jumps over the lazy dog";
const FAKE_NAME = "fake-stub";
const MAX_BODY = 25 * 1024 * 1024;

interface Child {
  port: number;
  stderr(): string;
  stop(): void;
}

const children: Child[] = [];
const scratch: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "voice-server-"));
  scratch.push(dir);
  return dir;
}

/** Every environment key the copied server must not read. */
function noisyEnvironment(runtime: string, path: string): Record<string, string> {
  return {
    PATH: path,
    TRANSCRIBE_PORT: "1",
    TRANSCRIBE_IDLE_S: "999",
    TRANSCRIBE_EXIT_ON_IDLE: "1",
    TRANSCRIBE_FAKE: "1",
    TRANSCRIBE_READ_TIMEOUT_S: "1",
    IMPRNT_VOICE_RUNTIME: runtime,
  };
}

async function start(
  args: string[],
  env?: Record<string, string>,
): Promise<Child> {
  const proc = Bun.spawn([PYTHON as string, SERVER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? { PATH: process.env.PATH ?? "" },
  });
  let said = "";
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let port = 0;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const next = await reader.read();
    if (next.done) break;
    said += decoder.decode(next.value, { stream: true });
    const found = said.match(/listening on ([\d.]+):(\d+)/);
    if (found) {
      port = Number(found[2]);
      break;
    }
  }
  // Keep draining, or a chatty child fills its pipe and stops serving.
  void (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        said += decoder.decode(next.value, { stream: true });
      }
    } catch {
      /* the pipe closes when the child is killed */
    }
  })();
  const child: Child = {
    port,
    stderr: () => said,
    stop: () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
  children.push(child);
  if (!port) throw new Error(`the server never printed a port: ${said}`);
  return child;
}

/** Spawn and WAIT for the exit, for the cases that must refuse to start. */
async function refuses(
  args: string[],
  env?: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([PYTHON as string, SERVER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? { PATH: process.env.PATH ?? "" },
  });
  const [code, stderr, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { code, stderr: stderr + stdout };
}

/**
 * One request over a raw socket, so the head can be malformed on purpose.
 *
 * `fetch` always declares a length or a chunked encoding and always connects
 * from the default address, and the missing length, the oversized length and the
 * peer that is not loopback are exactly those three things.
 */
function rawRequest(options: {
  port: number;
  head: string[];
  body?: Uint8Array;
  localAddress?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: options.port,
      ...(options.localAddress ? { localAddress: options.localAddress } : {}),
    });
    const parts: Buffer[] = [];
    socket.setTimeout(15_000, () => {
      socket.destroy();
      reject(new Error("raw request timed out"));
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(`${options.head.join("\r\n")}\r\n\r\n`);
      if (options.body) socket.write(options.body);
    });
    socket.on("data", (part: Buffer) => parts.push(part));
    socket.on("close", () => {
      const whole = Buffer.concat(parts).toString("utf8");
      const status = Number(whole.match(/^HTTP\/1\.\d (\d{3})/)?.[1] ?? 0);
      const body = whole.split("\r\n\r\n").slice(1).join("\r\n\r\n");
      resolve({ status, body });
    });
  });
}

/**
 * A source address a server on this box really SEES as something other than
 * 127.0.0.1, or null.
 *
 * Binding the source is not enough to know: some kernels rewrite a loopback
 * source back to 127.0.0.1, so a peer check can never be driven there at all.
 * The probe therefore asks its own server what arrived rather than asking
 * whether the bind succeeded.
 */
async function secondAddress(): Promise<string | null> {
  let seen: string | null = null;
  const server = net.createServer((socket) => {
    seen = socket.remoteAddress ?? null;
    socket.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  try {
    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection(
        { host: "127.0.0.1", port, localAddress: "127.0.0.2" },
        () => {
          client.end();
        },
      );
      client.on("error", reject);
      client.on("close", () => resolve());
    });
    // The server's callback may land a tick after the client's close.
    for (let waited = 0; seen === null && waited < 20; waited += 1) await Bun.sleep(25);
    return seen === "127.0.0.2" ? "127.0.0.2" : null;
  } catch {
    return null;
  } finally {
    server.close();
  }
}

/** A wav the server converts nothing about, because the stub reads no audio. */
function body(bytes = 2_048): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i += 1) out[i] = (i * 31) % 253;
  return out;
}

function walk(root: string, skip = new Set([".git", "node_modules"])): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      found.push(path);
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return found;
}

test(`the reference server answers the three keys and nothing else${PYTHON_SUFFIX}`, async () => {
  if (!PYTHON) return;
  const child = await start(["--port", "0", "--fake", "--idle-s", "0"]);
  const chunk = body();
  const answer = await fetch(`http://127.0.0.1:${child.port}/transcribe`, {
    method: "POST",
    body: chunk,
  });
  expect(answer.status).toBe(200);
  const said = (await answer.json()) as Record<string, unknown>;
  expect(Object.keys(said).sort()).toEqual(["audio_s", "decode_ms", "text"]);
  expect(said.text, "the stub's own fixed sentence").toBe(FAKE_TEXT);
  expect(said.audio_s as number).toBeGreaterThan(0);
  expect(said.decode_ms as number).toBeGreaterThan(0);
});

test(`a request with no declared length is refused, and one over the cap too${PYTHON_SUFFIX}`, async () => {
  if (!PYTHON) return;
  const child = await start(["--port", "0", "--fake", "--idle-s", "0"]);

  const noLength = await rawRequest({
    port: child.port,
    head: [
      "POST /transcribe HTTP/1.1",
      `Host: 127.0.0.1:${child.port}`,
      "Connection: close",
    ],
  });
  expect(noLength.status, "a declared length is required").toBe(411);

  const tooBig = await rawRequest({
    port: child.port,
    head: [
      "POST /transcribe HTTP/1.1",
      `Host: 127.0.0.1:${child.port}`,
      `Content-Length: ${MAX_BODY + 1}`,
      "Connection: close",
    ],
  });
  expect(tooBig.status, "the cap is enforced on the declared length").toBe(413);
  expect(tooBig.body, "and the sentence names the cap").toContain(String(MAX_BODY));
});

test(`any path but the two is not found, on both verbs${PYTHON_SUFFIX}`, async () => {
  if (!PYTHON) return;
  const child = await start(["--port", "0", "--fake", "--idle-s", "0"]);
  for (const path of ["/", "/transcribe/extra", "/metrics"]) {
    const got = await fetch(`http://127.0.0.1:${child.port}${path}`);
    expect(got.status, `GET ${path}`).toBe(404);
    const posted = await fetch(`http://127.0.0.1:${child.port}${path}`, {
      method: "POST",
      body: body(16),
    });
    expect(posted.status, `POST ${path}`).toBe(404);
  }
});

test(`a peer that is not loopback is refused${PYTHON_SUFFIX}`, async () => {
  if (!PYTHON) return;
  // The reason for a skip goes on stderr rather than into the test name, because
  // whether this box can be driven at all is only knowable from a socket, and a
  // name is built before any test body runs.
  const source = await secondAddress();
  if (!source) {
    process.stderr.write(
      "[voice-server] SKIPPED the peer check: this box shows every loopback peer as 127.0.0.1, " +
        "so a peer that is not loopback cannot be driven here\n",
    );
    return;
  }
  const child = await start(["--port", "0", "--fake", "--idle-s", "0"]);
  const got = await rawRequest({
    port: child.port,
    localAddress: source,
    head: [
      "GET /health HTTP/1.1",
      `Host: 127.0.0.1:${child.port}`,
      "Connection: close",
    ],
  });
  expect(got.status, `a request from ${source} is not from 127.0.0.1`).toBe(403);
});

test(`the read budget is the flag's, on the socket as well as on the deadline${PYTHON_SUFFIX}`, async () => {
  if (!PYTHON) return;
  // The budget feeds TWO places, the accepted socket's own timeout and the
  // per-request deadline, and a flag that reached only one of them would leave
  // the other on five minutes with nothing to show it. A peer that declares a
  // body and never sends it is what asks both.
  const child = await start([
    "--port",
    "0",
    "--fake",
    "--idle-s",
    "0",
    "--read-timeout-s",
    "1",
  ]);
  const began = Date.now();
  const stalled = await rawRequest({
    port: child.port,
    head: [
      "POST /transcribe HTTP/1.1",
      `Host: 127.0.0.1:${child.port}`,
      "Content-Length: 5000",
      "Connection: close",
    ],
  });
  const took = Date.now() - began;
  expect(took, `dropped after ${took} ms, and the default would be five minutes`)
    .toBeLessThan(20_000);
  expect(stalled.status, "the peer is dropped rather than answered").toBe(0);
  const health = await fetch(`http://127.0.0.1:${child.port}/health`);
  expect(health.status, "and the one request thread is free again").toBe(200);
});

test(`health answers while nothing is loaded and never moves the idle clock${PYTHON_SUFFIX}`, async () => {
  if (!PYTHON) return;
  const child = await start(["--port", "0", "--fake", "--idle-s", "0"]);
  const read = async () =>
    (await (await fetch(`http://127.0.0.1:${child.port}/health`)).json()) as Record<
      string,
      unknown
    >;
  const first = await read();
  expect(first.ok, "answering is what ok means, loaded is its own field").toBe(true);
  expect(first.loaded, "lazy by default, so nothing is in yet").toBe(false);
  await Bun.sleep(400);
  const second = await read();
  expect(second.ok).toBe(true);
  // A probe that reset the clock would pin the model warm for ever, which is
  // the opposite of what the idle window is for.
  expect(second.idle_s as number).toBeGreaterThanOrEqual(first.idle_s as number);
});

test(`every knob is an argument and the environment loses${PYTHON_SUFFIX}`, async () => {
  if (!PYTHON) return;
  const dir = scratchDir();
  const path = process.env.PATH ?? "";
  const child = await start(
    ["--port", "0", "--fake", "--idle-s", "0"],
    noisyEnvironment(dir, path),
  );
  expect(child.port, "the kernel picked the port, not the environment").not.toBe(1);
  const answer = await fetch(`http://127.0.0.1:${child.port}/transcribe`, {
    method: "POST",
    body: body(),
  });
  expect(((await answer.json()) as { text: string }).text, "the stub backend ran").toBe(
    FAKE_TEXT,
  );
  const health = (await (
    await fetch(`http://127.0.0.1:${child.port}/health`)
  ).json()) as Record<string, unknown>;
  expect(health.idle_limit_s, "the window came from the flag, not from 999").toBe(0);
  expect(child.stderr()).toContain("idle reclaim disabled");

  // The same environment with the flags ABSENT must not turn into behaviour: the
  // runtime directory is required and the one in the environment is not read, so
  // the refusal names the flag.
  const refused = await refuses([], noisyEnvironment(dir, path));
  expect(refused.code, "no flags is no configuration").not.toBe(0);
  expect(refused.stderr, "and the operator is told which flag to pass").toContain("--runtime");
});

test("no file in this package reads a TRANSCRIBE_ environment variable", () => {
  // A SCAN and not a behaviour, deliberately: the check above is the behaviour,
  // and this is the fence over the whole tree, because the forbidden thing is a
  // knob reappearing anywhere rather than in one file.
  const offenders: string[] = [];
  for (const root of ["src", "tools", "test"]) {
    for (const path of walk(hubPath(root))) {
      if (statSync(path).isDirectory()) continue;
      if (!/\.(ts|py|mjs|js|sql|toml)$/.test(path)) continue;
      const lines = readFileSync(path, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        const reads = /os\.environ|process\.env|Bun\.env|getenv/.test(line);
        if (reads && line.includes("TRANSCRIBE_")) {
          offenders.push(`${path}:${index + 1}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
});

test(`the model is an argument, and health never claims one that is not loaded${PYTHON_SUFFIX}`, async () => {
  if (!PYTHON) return;
  const child = await start([
    "--port",
    "0",
    "--fake",
    "--idle-s",
    "0",
    "--model",
    "a-model-name",
  ]);
  await fetch(`http://127.0.0.1:${child.port}/transcribe`, { method: "POST", body: body() });
  const health = (await (
    await fetch(`http://127.0.0.1:${child.port}/health`)
  ).json()) as Record<string, unknown>;
  expect(health.model, "what the argv asked for").toBe("a-model-name");
  expect(health.loaded, "and something really is in").toBe(true);
  expect(health.loaded_model, "what is actually resident").toBe(FAKE_NAME);
});

test(`the server refuses to start when the converter is missing${PYTHON_SUFFIX}`, async () => {
  if (!PYTHON) return;
  const dir = scratchDir();
  // Checked at startup rather than met per request: without the converter the
  // health endpoint would answer while every decode failed.
  const noFfmpeg = await refuses(
    ["--port", "0", "--runtime", dir, "--model", "a-model-name", "--idle-s", "0"],
    { PATH: join(dir, "nothing-here") },
  );
  expect(noFfmpeg.code).not.toBe(0);
  expect(noFfmpeg.stderr, "the converter is named").toMatch(/ffmpeg/);
});

test(`the server refuses to start when the weights are missing${PYTHON_SUFFIX}${
  FFMPEG ? "" : " [skipped: ffmpeg is not on PATH, so the converter guard answers first]"
}`, async () => {
  if (!PYTHON || !FFMPEG) return;
  const dir = scratchDir();
  // The weights guard runs at startup under --warm, which is what the resident
  // unit renders, so this is the deployed shape refusing rather than the first
  // voice note of the day failing. It is reachable only where the converter is
  // present, because that guard is checked first and would answer instead.
  const noModel = await refuses([
    "--port", "0", "--runtime", dir, "--model", "a-model-name", "--warm", "--idle-s", "0",
  ]);
  expect(noModel.code).not.toBe(0);
  expect(noModel.stderr, "the missing file is named").toMatch(/model/);
});

test(`the model the argv names is the directory the weights are read from${PYTHON_SUFFIX}${
  FFMPEG ? "" : " [skipped: ffmpeg is not on PATH, so the converter guard answers first]"
}`, async () => {
  if (!PYTHON || !FFMPEG) return;
  const dir = scratchDir();
  // A runtime holding a COMPLETE set of weights under a fixed name, and nothing
  // under the name the registry chose. A server that reads a fixed directory
  // walks past this and dies later on the library instead, which makes --model
  // a setting nothing reads and a smaller model on a smaller box unreachable.
  mkdirSync(join(dir, "model"), { recursive: true });
  for (const name of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]) {
    writeFileSync(join(dir, "model", name), "");
  }
  const wrongModel = await refuses([
    "--port", "0", "--runtime", dir, "--model", "a-model-name", "--warm", "--idle-s", "0",
  ]);
  expect(wrongModel.code).not.toBe(0);
  expect(wrongModel.stderr, "the directory an operator can fix is the one the argv named")
    .toContain(join(dir, "a-model-name"));

  // And a household that names none is told which flag to pass, rather than
  // being served out of whatever directory happened to be there.
  const noName = await refuses(["--port", "0", "--runtime", dir, "--warm", "--idle-s", "0"]);
  expect(noName.code).not.toBe(0);
  expect(noName.stderr).toContain("--model");
});

test("the reference server reads no environment variable at all", () => {
  // The scan above is the fence over the tree for one prefix. THIS ONE IS
  // ABSOLUTE and it is about this file: every knob is an argument, so an
  // environment read of any name is a behaviour an operator reading the unit
  // cannot see. Socket activation was the last one, and it also asked this
  // process to be started and stopped by something the hub does not render.
  const source = readFileSync(SERVER, "utf8");
  const reads: string[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (/os\.environ|os\.getenv|\bgetenv\(/.test(line)) reads.push(`${SERVER}:${index + 1}`);
  }
  expect(reads, "nothing here reads the environment").toEqual([]);
  for (const gone of ["LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES", "exit-on-idle", "exit_on_idle"]) {
    expect(source.includes(gone), `${gone} is not a thing this server knows about`).toBe(false);
  }
});

test("what the copy does not carry is not in the package", () => {
  const files = walk(hubPath("."));
  const names = new Set(files.map((path) => path.split("/").pop() as string));
  for (const gone of ["transcribe.sh", "ping.mjs", "ping.ogg"]) {
    expect(names.has(gone), `${gone} belongs to the client that is ours now`).toBe(false);
  }
  expect(
    files.filter((path) => path.endsWith(".socket")),
    "nothing renders a socket unit",
  ).toEqual([]);

  // Exactly one place builds a recognizer. A second would be the in-process
  // fallback, which loads the whole model inside the caller at the one moment
  // the box has no memory to spare.
  const source = readFileSync(SERVER, "utf8");
  expect(source.match(/def load_backend/g) ?? [], "one builder").toHaveLength(1);
  expect(source.match(/from_transducer/g) ?? [], "built in one place").toHaveLength(1);
  // The chunking is the client's, so the server has none.
  expect(source).not.toContain("split_points");
  expect(source).not.toContain("CHUNK_SLACK_S");
  expect(source).not.toContain("env_flag");
  // The model name lives in the registry and in no code anywhere.
  expect(source.toLowerCase()).not.toContain("parakeet");
});

test("the package ships code and never weights", () => {
  for (const path of walk(hubPath("."))) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      const name = path.split("/").pop();
      expect(name === "model" || name === "venv", `${path} is where the weights are not`).toBe(
        false,
      );
      continue;
    }
    if (path.includes("/tools/")) {
      expect(stat.size, `${path} is code, so it is small`).toBeLessThan(1_048_576);
    }
  }
});

test(`a spawn with the stub really answers${PYTHON_SUFFIX}`, async () => {
  if (!PYTHON) return;
  // The control: a build whose server exited at once would pass every refusal
  // above and fail here.
  const dir = scratchDir();
  writeFileSync(join(dir, "unused"), "");
  const child = await start(["--port", "0", "--fake", "--idle-s", "0"]);
  const answer = await fetch(`http://127.0.0.1:${child.port}/transcribe`, {
    method: "POST",
    body: body(64),
  });
  expect(answer.status).toBe(200);
  expect(((await answer.json()) as { text: string }).text).toBe(FAKE_TEXT);
});
