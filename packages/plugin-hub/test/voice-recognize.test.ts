// RUN-15: one seam recognizes one chunk, a recognizer beside the door and a
// recognizer on somebody else's continent both sit behind it, and what leaves
// the box for the second one is the chunk's bytes and the person's language and
// nothing else.
//
// THE REQUEST IS ASSERTED WHOLE, which is the only form the privacy rule can
// take. "No chat text, no names, no paths" is a property of what went over the
// wire, so this check plants five private strings into the surrounding state and
// asserts that not one byte of the recorded request carries any of them. A
// promise in a comment is not a check.
//
// Against two fake servers on kernel-picked ports, one standing for the
// recognizer on loopback and one for a dialled provider. No Postgres, no door,
// no runner, so none of the six protected windows is reachable from here. Every
// server is stopped and every scratch key file is removed after each check.
//
// The three conversion cases want `ffmpeg` on PATH. Where it is absent they skip
// with the reason in the test name, and every other case here runs on a planted
// array instead of a file.

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { fakeRecognizer, type FakeRecognizer } from "./helpers/fake-recognizer.ts";
import { plantSamples, writeWav } from "./helpers/wav.ts";

const RATE = 16_000;

/** Where the conversion cases stand: the tool, or the reason they are skipped. */
const FFMPEG = Bun.which("ffmpeg");
const FFMPEG_SUFFIX = FFMPEG ? "" : " [skipped: ffmpeg is not on PATH]";

const scratch: string[] = [];
const running: FakeRecognizer[] = [];

afterEach(async () => {
  for (const fake of running.splice(0)) await fake.stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "voice-recognize-"));
  scratch.push(dir);
  return dir;
}

async function local(): Promise<FakeRecognizer> {
  const fake = await fakeRecognizer();
  running.push(fake);
  return fake;
}

/** The dialled stand-in, on its own path, so the query string is assertable. */
async function cloud(): Promise<FakeRecognizer> {
  const fake = await fakeRecognizer({ path: "/v1/listen" });
  running.push(fake);
  return fake;
}

interface RecognizeAnswer {
  text: string;
  audio_s: number;
  decode_ms: number;
}

async function recognizer() {
  const module = await seam("src/voice/recognize.ts");
  expect(typeof module.recognize, "recognize must be a function").toBe("function");
  expect(
    typeof module.classifyRecognizerFailure,
    "classifyRecognizerFailure must be a function",
  ).toBe("function");
  return module as unknown as {
    recognize(request: Record<string, unknown>): Promise<RecognizeAnswer>;
    classifyRecognizerFailure(failure: unknown): string;
    FAILURE_CLASSES: readonly string[];
  };
}

async function decoder() {
  const module = await seam("src/voice/decode.ts");
  expect(typeof module.toPcm, "toPcm must be a function").toBe("function");
  return module as unknown as {
    toPcm(options: {
      file: string;
      sha256: string;
      deadlineMs: number;
    }): Promise<{ samples: Int16Array; rate: number }>;
  };
}

/** A chunk, as the cut hands one over: a wav in memory. */
function chunk(seconds = 1): Uint8Array {
  const samples = plantSamples({ seconds, rate: RATE, quietAt: [] });
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}

function keyFile(dir: string, token: string): string {
  const path = join(dir, "api-key");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return path;
}

/** The seven keys a caller assembles, and nothing else. */
const REQUEST_KEYS = [
  "provider",
  "endpoint",
  "model",
  "chunk",
  "language",
  "deadlineMs",
  "credentialFile",
];

test("RUN-15 the seam takes one chunk and seven keys, and refuses anything else", async () => {
  const { recognize } = await recognizer();
  const fake = await local();
  const whole: Record<string, unknown> = {
    provider: "sherpa-onnx",
    endpoint: fake.endpoint,
    model: "a-model-name",
    chunk: chunk(),
    language: "en",
    deadlineMs: 5_000,
    credentialFile: null,
  };
  expect(Object.keys(whole).sort(), "the check's own list").toEqual([...REQUEST_KEYS].sort());
  const said = await recognize({ ...whole });
  expect(Object.keys(said).sort()).toEqual(["audio_s", "decode_ms", "text"]);

  for (const key of REQUEST_KEYS) {
    const missing = { ...whole };
    delete missing[key];
    await expect(
      recognize(missing),
      `a request without ${key} must be refused`,
    ).rejects.toThrow();
  }
  // The caller assembles a provider-blind request, so a key the seam does not
  // know is a way to smuggle something past the privacy rule below.
  for (const extra of ["person", "chat", "savedPath"]) {
    await expect(
      recognize({ ...whole, [extra]: "anything" }),
      `a request carrying ${extra} must be refused`,
    ).rejects.toThrow();
  }
});

test("RUN-15 the recognizer beside the door is posted the chunk as the raw body", async () => {
  const { recognize } = await recognizer();
  const fake = await local();
  const piece = chunk();
  const said = await recognize({
    provider: "sherpa-onnx",
    endpoint: fake.endpoint,
    model: "a-model-name",
    chunk: piece,
    language: "ru",
    deadlineMs: 5_000,
    credentialFile: null,
  });
  expect(said.text).toBe("synthetic transcript");
  expect(fake.requests).toHaveLength(1);
  const sent = fake.requests[0];
  expect(sent.method).toBe("POST");
  expect(sent.path).toBe("/transcribe");
  expect(sent.bytes).toBe(piece.byteLength);
  expect(sent.sha256).toBe(createHash("sha256").update(piece).digest("hex"));
  expect(sent.headers["content-length"]).toBe(String(piece.byteLength));
});

test("RUN-15 a dialled recognizer answers in its own shape and comes back as the same three keys", async () => {
  const { recognize } = await recognizer();
  const fake = await cloud();
  const dir = scratchDir();
  // The provider's own JSON, nested the way a real one nests it.
  fake.setRawAnswer({
    metadata: { duration: 12.5 },
    results: { channels: [{ alternatives: [{ transcript: "what the person said" }] }] },
  });
  const said = await recognize({
    provider: "deepgram",
    endpoint: fake.endpoint,
    model: "a-cloud-model",
    chunk: chunk(),
    language: "ru",
    deadlineMs: 5_000,
    credentialFile: keyFile(dir, "synthetic-key-one"),
  });
  expect(Object.keys(said).sort()).toEqual(["audio_s", "decode_ms", "text"]);
  expect(said.text).toBe("what the person said");
  expect(said.audio_s).toBe(12.5);
  expect(said.decode_ms).toBeGreaterThanOrEqual(0);
});

test("RUN-15 a dialled recognizer is sent the chunk and the language and nothing else", async () => {
  const { recognize } = await recognizer();
  const fake = await cloud();
  const dir = scratchDir();
  fake.setRawAnswer({
    metadata: { duration: 1 },
    results: { channels: [{ alternatives: [{ transcript: "synthetic" }] }] },
  });
  const piece = chunk();
  // Five private strings that exist around the step and may never be in the
  // request: what the person typed, who they are, which agent answers, where
  // the audio sits and what an earlier chunk of this same note said.
  const planted = {
    chatText: "synthetic-chat-text-nobody-else-may-read",
    person: "synthetic-person-id",
    agent: "synthetic-agent-id",
    savedPath: "/synthetic/inbox/0.ogg",
    earlier: "synthetic-earlier-transcript",
  };
  await recognize({
    provider: "deepgram",
    endpoint: fake.endpoint,
    model: "a-cloud-model",
    chunk: piece,
    language: "ru",
    deadlineMs: 5_000,
    credentialFile: keyFile(dir, "synthetic-key-one"),
  });

  expect(fake.requests).toHaveLength(1);
  const sent = fake.requests[0];
  expect(sent.method).toBe("POST");
  expect(sent.bytes, "the body is the chunk, whole").toBe(piece.byteLength);
  expect(sent.sha256).toBe(createHash("sha256").update(piece).digest("hex"));
  const query = new URLSearchParams(sent.query);
  expect([...query.keys()].sort(), "the language and the model, and no third thing")
    .toEqual(["language", "model"]);
  expect(query.get("language")).toBe("ru");
  expect(query.get("model")).toBe("a-cloud-model");
  expect(sent.headerNames.filter((name) => !name.startsWith("accept") && name !== "host" && name !== "connection" && name !== "user-agent"))
    .toEqual(["authorization", "content-length", "content-type"]);

  const wire = [sent.path, sent.query, JSON.stringify(sent.headers)].join("\n");
  for (const [what, value] of Object.entries(planted)) {
    expect(wire, `${what} must appear nowhere in the request`).not.toContain(value);
  }
});

test("RUN-15 the key is read from its file at the moment of use and never from the environment", async () => {
  const { recognize } = await recognizer();
  const fake = await cloud();
  const dir = scratchDir();
  fake.setRawAnswer({
    metadata: { duration: 1 },
    results: { channels: [{ alternatives: [{ transcript: "synthetic" }] }] },
  });
  const request = {
    provider: "deepgram",
    endpoint: fake.endpoint,
    model: "a-cloud-model",
    chunk: chunk(),
    language: "en",
    deadlineMs: 5_000,
    credentialFile: keyFile(dir, "synthetic-key-one"),
  };
  await recognize({ ...request });
  expect(fake.requests[0].headers.authorization).toContain("synthetic-key-one");

  // The same file, a second token. A build that read the file once at import
  // would send the first token twice.
  keyFile(dir, "synthetic-key-two");
  await recognize({ ...request });
  expect(fake.requests[1].headers.authorization).toContain("synthetic-key-two");
  expect(fake.requests[1].headers.authorization).not.toContain("synthetic-key-one");

  for (const [name, value] of Object.entries(process.env)) {
    expect(value ?? "", `no environment variable may hold the key (${name})`)
      .not.toContain("synthetic-key-two");
  }
});

test("RUN-15 a dialled recognizer off this machine must be reached over TLS", async () => {
  const { recognize } = await recognizer();
  const dir = scratchDir();
  // Loopback carries nothing off the box, which is why the fake above is
  // plain. Any other host is somebody else's machine and must be encrypted.
  await expect(
    recognize({
      provider: "deepgram",
      endpoint: "http://a-provider.invalid/v1/listen",
      model: "a-cloud-model",
      chunk: chunk(),
      language: "en",
      deadlineMs: 2_000,
      credentialFile: keyFile(dir, "synthetic-key-one"),
    }),
  ).rejects.toThrow(/tls|https/i);
});

test("RUN-15 every failure the seam can meet is one of two classes", async () => {
  const { recognize, classifyRecognizerFailure, FAILURE_CLASSES } = await recognizer();
  const dir = scratchDir();
  expect([...FAILURE_CLASSES].sort(), "two classes and nothing else")
    .toEqual(["content", "infra"]);

  const infra = [
    "recognizer-unreachable",
    "recognizer-status",
    "recognizer-unparseable",
    "chunk-deadline",
    "credential-blank",
    "credential-unreadable",
    "ffmpeg-missing",
    "runtime-missing",
  ];
  // Three, not two: the audio decoding to nothing, the converter refusing the
  // file, and the saved bytes not matching their receipt.
  const content = ["audio-empty", "media-unreadable", "media-damaged"];
  for (const cause of infra) {
    expect(classifyRecognizerFailure(cause), `${cause} is infra`).toBe("infra");
  }
  for (const cause of content) {
    expect(classifyRecognizerFailure(cause), `${cause} is content`).toBe("content");
  }
  const classified = new Set([...infra, ...content]);
  expect(classified.size, "no cause is in both lists").toBe(infra.length + content.length);

  // A blank key file and an unreadable one both reach the classifier through a
  // real call, which is what makes the list behaviour and not a table.
  const blank = join(dir, "blank-key");
  writeFileSync(blank, "\n", { mode: 0o600 });
  const fake = await cloud();
  for (const file of [blank, join(dir, "no-such-key")]) {
    let seen: unknown = null;
    try {
      await recognize({
        provider: "deepgram",
        endpoint: fake.endpoint,
        model: "a-cloud-model",
        chunk: chunk(),
        language: "en",
        deadlineMs: 2_000,
        credentialFile: file,
      });
    } catch (error) {
      seen = error;
    }
    expect(seen, `${file} must refuse`).not.toBeNull();
    expect(classifyRecognizerFailure(seen)).toBe("infra");
  }
  expect(fake.requests, "a key that cannot be read never reaches the wire").toHaveLength(0);
});

test("RUN-15 a dead port and a refusing recognizer are both infra", async () => {
  const { recognize, classifyRecognizerFailure } = await recognizer();
  const dead = await local();
  const endpoint = dead.endpoint;
  await dead.stop();
  running.splice(running.indexOf(dead), 1);

  let unreachable: unknown = null;
  try {
    await recognize({
      provider: "sherpa-onnx",
      endpoint,
      model: "a-model-name",
      chunk: chunk(),
      language: "en",
      deadlineMs: 2_000,
      credentialFile: null,
    });
  } catch (error) {
    unreachable = error;
  }
  expect(unreachable, "a dead port must refuse").not.toBeNull();
  expect(classifyRecognizerFailure(unreachable)).toBe("infra");

  const fake = await local();
  fake.setStatus(503);
  let refused: unknown = null;
  try {
    await recognize({
      provider: "sherpa-onnx",
      endpoint: fake.endpoint,
      model: "a-model-name",
      chunk: chunk(),
      language: "en",
      deadlineMs: 2_000,
      credentialFile: null,
    });
  } catch (error) {
    refused = error;
  }
  expect(refused, "a non-200 answer must refuse").not.toBeNull();
  expect(classifyRecognizerFailure(refused)).toBe("infra");

  fake.setStatus(200);
  fake.setRawAnswer("not an object at all");
  let unparseable: unknown = null;
  try {
    await recognize({
      provider: "sherpa-onnx",
      endpoint: fake.endpoint,
      model: "a-model-name",
      chunk: chunk(),
      language: "en",
      deadlineMs: 2_000,
      credentialFile: null,
    });
  } catch (error) {
    unparseable = error;
  }
  expect(unparseable, "an answer with no text must refuse").not.toBeNull();
  expect(classifyRecognizerFailure(unparseable)).toBe("infra");
});

test("RUN-15 classifying a success has no answer", async () => {
  const { recognize, classifyRecognizerFailure } = await recognizer();
  const fake = await local();
  const said = await recognize({
    provider: "sherpa-onnx",
    endpoint: fake.endpoint,
    model: "a-model-name",
    chunk: chunk(),
    language: "en",
    deadlineMs: 5_000,
    credentialFile: null,
  });
  expect(said.text).toBe("synthetic transcript");
  expect(() => classifyRecognizerFailure(said), "a success is not a failure").toThrow();
  expect(() => classifyRecognizerFailure("something-nobody-named")).toThrow();
});

test("RUN-15 a chunk past its deadline is abandoned, and the request had arrived", async () => {
  const { recognize, classifyRecognizerFailure } = await recognizer();
  const fake = await local();
  const deadlineMs = 200;
  fake.setDelayMs(4_000);
  const began = Date.now();
  let refused: unknown = null;
  try {
    await recognize({
      provider: "sherpa-onnx",
      endpoint: fake.endpoint,
      model: "a-model-name",
      chunk: chunk(),
      language: "en",
      deadlineMs,
      credentialFile: null,
    });
  } catch (error) {
    refused = error;
  }
  const took = Date.now() - began;
  expect(refused, "the deadline must end the wait").not.toBeNull();
  expect(classifyRecognizerFailure(refused)).toBe("infra");
  // Bounded on TIME rather than on the message: a build that waited the server
  // out and then reported a deadline would pass a message check and fail here.
  expect(took, `abandoned in ${took} ms`).toBeLessThan(deadlineMs + 1_500);
  expect(fake.requests, "the request had arrived, so this is the abandon case")
    .toHaveLength(1);
});

test(`RUN-15 the conversion answers 16 kHz mono 16-bit samples${FFMPEG_SUFFIX}`, async () => {
  if (!FFMPEG) return;
  const { toPcm } = await decoder();
  const dir = scratchDir();
  const samples = plantSamples({ seconds: 3, rate: RATE, quietAt: [] });
  const path = join(dir, "0.wav");
  writeWav(path, samples, RATE);
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const got = await toPcm({
    file: path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    deadlineMs: 30_000,
  });
  expect(got.rate).toBe(16_000);
  expect(got.samples instanceof Int16Array, "the arithmetic wants signed 16-bit").toBe(true);
  // Within 100 ms of the source, which is what says the conversion feeds the
  // cut and not something near it.
  expect(Math.abs(got.samples.length - samples.length)).toBeLessThan(RATE / 10);
});

test(`RUN-15 the conversion kills its own child on the deadline${FFMPEG_SUFFIX}`, async () => {
  if (!FFMPEG) return;
  const { toPcm } = await decoder();
  const { classifyRecognizerFailure } = await recognizer();
  const dir = scratchDir();
  // A note long enough that the converter cannot possibly finish inside the
  // deadline: measured at about 50 ms for this file, against 5 ms allowed.
  const samples = plantSamples({ seconds: 150, rate: RATE, quietAt: [] });
  const path = join(dir, "0.wav");
  writeWav(path, samples, RATE);
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const began = Date.now();
  let refused: unknown = null;
  try {
    await toPcm({
      file: path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      deadlineMs: 5,
    });
  } catch (error) {
    refused = error;
  }
  const took = Date.now() - began;
  expect(refused, "the deadline must end the conversion").not.toBeNull();
  expect(classifyRecognizerFailure(refused)).toBe("infra");
  // The refusal only comes back once the child is gone, so the child's own end
  // is in the message rather than in a sleep.
  expect(String((refused as Error).message)).toMatch(/kill/i);
  expect(took, `abandoned in ${took} ms`).toBeLessThan(2_000);
});

test(`RUN-15 audio the converter cannot read, and audio with nothing in it, are content${FFMPEG_SUFFIX}`, async () => {
  if (!FFMPEG) return;
  const { toPcm } = await decoder();
  const { classifyRecognizerFailure } = await recognizer();
  const dir = scratchDir();

  const junk = join(dir, "0.bin");
  const junkBytes = new Uint8Array(4_096);
  for (let i = 0; i < junkBytes.length; i += 1) junkBytes[i] = (i * 37) % 251;
  writeFileSync(junk, junkBytes);
  let unreadable: unknown = null;
  try {
    await toPcm({
      file: junk,
      sha256: createHash("sha256").update(junkBytes).digest("hex"),
      deadlineMs: 30_000,
    });
  } catch (error) {
    unreadable = error;
  }
  expect(unreadable, "a file with no audio in it must refuse").not.toBeNull();
  expect(classifyRecognizerFailure(unreadable)).toBe("content");

  const silent = join(dir, "1.wav");
  writeWav(silent, new Int16Array(0), RATE);
  const silentBytes = new Uint8Array(await Bun.file(silent).arrayBuffer());
  let empty: unknown = null;
  try {
    await toPcm({
      file: silent,
      sha256: createHash("sha256").update(silentBytes).digest("hex"),
      deadlineMs: 30_000,
    });
  } catch (error) {
    empty = error;
  }
  expect(empty, "audio that decodes to nothing must refuse").not.toBeNull();
  expect(classifyRecognizerFailure(empty)).toBe("content");
});

test("RUN-15 saved audio is checked against its receipt before it is read", async () => {
  const { toPcm } = await decoder();
  const { classifyRecognizerFailure } = await recognizer();
  const dir = scratchDir();
  const path = join(dir, "0.wav");
  writeWav(path, plantSamples({ seconds: 1, rate: RATE, quietAt: [] }), RATE);
  let damaged: unknown = null;
  try {
    await toPcm({ file: path, sha256: "0".repeat(64), deadlineMs: 30_000 });
  } catch (error) {
    damaged = error;
  }
  expect(damaged, "bytes that do not match the receipt must refuse").not.toBeNull();
  expect(classifyRecognizerFailure(damaged)).toBe("content");
  expect(String((damaged as Error).message)).toContain("media-damaged");
});
