// RUN-15: the client cuts a voice note into chunks, one chunk is one request,
// a chunk that finished survives a dead door, and a note that gave up renders
// what it has.
//
// THE CUT IS A PORT AND THIS CHECK TREATS IT AS ONE. The recognizer that has
// been serving this household cuts inside the server, in Python, and the
// client's cut has to answer the same points for the same samples or one note
// would have two cuts. The reference arithmetic, quoted whole so a reader can
// compare it against the TypeScript without leaving this file:
//
//   CHUNK_S = 60
//   CHUNK_SLACK_S = 2
//
//   def split_points(np, samples, rate):
//       n = len(samples)
//       limit = int(CHUNK_S * rate)
//       if n <= limit:
//           return [n]
//       slack = int(CHUNK_SLACK_S * rate)
//       win = max(1, int(0.02 * rate))
//       points = []
//       start = 0
//       while n - start > limit:
//           target = start + limit - slack
//           lo, hi = target, min(start + limit, n - 1)
//           seg = np.abs(samples[lo:hi])
//           if len(seg) > win:
//               # energy per sliding window, pick the quietest spot
//               kernel = np.ones(win, dtype=np.float32)
//               energy = np.convolve(seg, kernel, mode="valid")
//               cut = lo + int(np.argmin(energy)) + win // 2
//           else:
//               cut = hi
//           points.append(cut)
//           start = cut
//       points.append(n)
//       return points
//
// Every expected point below is derived from THAT, never read off the
// TypeScript: the planted array's quiet band is one window wide and everything
// around it has a constant absolute value, so the quietest window is unique and
// its own centre is the answer.
//
// Pure over planted arrays and scratch files, plus one fake recognizer for the
// request count. No Postgres, no door, no runner, so none of the six protected
// windows is reachable from here.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { fakeRecognizer, type FakeRecognizer } from "./helpers/fake-recognizer.ts";
import { plantSamples, quietWindowSamples, readWav } from "./helpers/wav.ts";

const RATE = 16_000;
const CHUNK_SECONDS = 60;

/** The scratch directories and servers this file made, cleared after each check. */
const scratch: string[] = [];
const running: FakeRecognizer[] = [];

afterEach(async () => {
  for (const fake of running.splice(0)) await fake.stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "voice-cut-"));
  scratch.push(dir);
  return dir;
}

async function recognizerHere(): Promise<FakeRecognizer> {
  const fake = await fakeRecognizer();
  running.push(fake);
  return fake;
}

async function pcm() {
  const module = await seam("src/voice/pcm.ts");
  expect(typeof module.splitPoints, "splitPoints must be a function").toBe("function");
  expect(typeof module.encodeWav, "encodeWav must be a function").toBe("function");
  return module as unknown as {
    splitPoints(samples: Int16Array, rate: number, chunkSeconds: number): number[];
    encodeWav(samples: Int16Array, rate: number): Uint8Array;
    CHUNK_SLACK_SECONDS: number;
    QUIET_WINDOW_SECONDS: number;
    PCM_RATE: number;
  };
}

interface ChunkResult {
  n: number;
  from_s: number;
  to_s: number;
  text: string;
  decode_ms: number;
  state: string;
}
interface ChunkFile {
  recognizer: string;
  chunk_seconds: number;
  chunks: ChunkResult[];
}

async function transcript() {
  const module = await seam("src/voice/transcript.ts");
  for (const name of [
    "chunkFilePath",
    "readChunkFile",
    "writeChunkFile",
    "nextChunk",
    "joinTranscript",
    "renderPartial",
  ]) {
    expect(typeof module[name], `${name} must be a function`).toBe("function");
  }
  return module as unknown as {
    chunkFilePath(audioPath: string, index: number): string;
    readChunkFile(path: string): ChunkFile | null;
    writeChunkFile(path: string, file: ChunkFile): void;
    nextChunk(file: ChunkFile | null): number;
    joinTranscript(file: ChunkFile): string;
    renderPartial(file: ChunkFile, language: "en" | "ru"): string;
  };
}

/**
 * The door's step, as much of it as this check needs, written HERE on purpose.
 *
 * The wiring into the door belongs to a later wave. What this stands in for is
 * the ordering the chunk file exists to make possible: take the first chunk
 * that is not finished, post it, write the file, and only then move on.
 */
async function runNote(options: {
  samples: Int16Array;
  rate: number;
  chunkSeconds: number;
  endpoint: string;
  filePath: string;
  recognizer: string;
}): Promise<ChunkFile> {
  const { splitPoints, encodeWav } = await pcm();
  const shelf = await transcript();
  const points = splitPoints(options.samples, options.rate, options.chunkSeconds);
  const held = shelf.readChunkFile(options.filePath);
  const file: ChunkFile = held ?? {
    recognizer: options.recognizer,
    chunk_seconds: options.chunkSeconds,
    chunks: [],
  };
  let from = 0;
  for (let n = 1; n <= points.length; n += 1) {
    const to = points[n - 1];
    if (n < shelf.nextChunk(file)) {
      from = to;
      continue;
    }
    const piece = encodeWav(options.samples.subarray(from, to), options.rate);
    const answer = await fetch(options.endpoint, {
      method: "POST",
      body: piece,
      headers: { "content-length": String(piece.byteLength) },
    });
    const said = (await answer.json()) as { text: string; decode_ms: number };
    const result: ChunkResult = {
      n,
      from_s: from / options.rate,
      to_s: to / options.rate,
      text: said.text,
      decode_ms: said.decode_ms,
      state: said.text === "" ? "empty" : "done",
    };
    file.chunks = [...file.chunks.filter((one) => one.n !== n), result].sort(
      (a, b) => a.n - b.n,
    );
    shelf.writeChunkFile(options.filePath, file);
    from = to;
  }
  return file;
}

test("RUN-15 a 150 s note cuts into three chunks at the planted quiet points", async () => {
  const { splitPoints } = await pcm();
  // Both bands sit INSIDE the two seconds before their own limit, which is the
  // only place the rule looks. A band on the limit itself would let a build
  // that ignored the slack entirely pass, and a band before the slack would
  // never be found at all.
  const samples = plantSamples({ seconds: 150, rate: RATE, quietAt: [59.0, 118.0] });
  const limit = CHUNK_SECONDS * RATE;
  const slack = 2 * RATE;

  const firstWindow = [limit - slack, limit];
  expect(59.0 * RATE, "the first band must be inside the first search window")
    .toBeGreaterThanOrEqual(firstWindow[0]);
  expect(59.0 * RATE).toBeLessThan(firstWindow[1]);

  const points = splitPoints(samples, RATE, CHUNK_SECONDS);
  expect(points, "three chunks out of a 150 s note at a 60 s limit").toHaveLength(3);
  expect(points[0], "the cut is the quiet band's own centre").toBe(59.0 * RATE);

  const secondWindow = [points[0] + limit - slack, points[0] + limit];
  expect(118.0 * RATE, "the second band must be inside the second search window")
    .toBeGreaterThanOrEqual(secondWindow[0]);
  expect(118.0 * RATE).toBeLessThan(secondWindow[1]);
  expect(points[1]).toBe(118.0 * RATE);
  expect(points[2], "the last point is the end of the audio").toBe(samples.length);
});

test("RUN-15 a note under the limit is one point at the end", async () => {
  const { splitPoints } = await pcm();
  const samples = plantSamples({ seconds: 30, rate: RATE, quietAt: [] });
  expect(splitPoints(samples, RATE, CHUNK_SECONDS)).toEqual([samples.length]);
});

test("RUN-15 chunk length zero is one request carrying the whole note", async () => {
  const { splitPoints } = await pcm();
  const samples = plantSamples({ seconds: 150, rate: RATE, quietAt: [59.0, 118.0] });
  // Zero is the big-machine switch, not a bad value: a build that read it as
  // "cut every zero seconds" would never leave the loop.
  expect(splitPoints(samples, RATE, 0)).toEqual([samples.length]);
});

test("RUN-15 the slack is a bound: a quiet spot inside it wins, one outside it is not used", async () => {
  const { splitPoints } = await pcm();
  const limit = CHUNK_SECONDS * RATE;
  const win = quietWindowSamples(RATE);

  const inside = plantSamples({ seconds: 150, rate: RATE, quietAt: [59.99, 118.0] });
  expect(splitPoints(inside, RATE, CHUNK_SECONDS)[0], "a band at 59.99 s is inside the slack")
    .toBe(59.99 * RATE);

  const outside = plantSamples({ seconds: 150, rate: RATE, quietAt: [50.0] });
  const first = splitPoints(outside, RATE, CHUNK_SECONDS)[0];
  expect(first, "a band at 50 s is before the search window and is never reached")
    .not.toBe(50.0 * RATE);
  // Every window inside the slack carries the same energy, so the quietest is
  // the FIRST one, which is where the reference picks too.
  expect(first).toBe(limit - 2 * RATE + Math.floor(win / 2));
});

test("RUN-15 a cut never lands at zero and never past the end", async () => {
  const { splitPoints } = await pcm();
  const limit = CHUNK_SECONDS * RATE;
  // One sample under the limit and one over it are the off-by-one pair, and
  // they are where a port breaks.
  for (const length of [limit - 1, limit, limit + 1, 150 * RATE]) {
    const samples = plantSamples({ seconds: length / RATE, rate: RATE, quietAt: [] });
    const points = splitPoints(samples, RATE, CHUNK_SECONDS);
    expect(points.length, `${length} samples must cut into at least one piece`)
      .toBeGreaterThanOrEqual(1);
    expect(points[points.length - 1], `${length} samples must end at the end`).toBe(length);
    for (const point of points) {
      expect(point, `${length} samples: no cut at zero`).toBeGreaterThan(0);
      expect(point, `${length} samples: no cut past the end`).toBeLessThanOrEqual(length);
    }
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i], `${length} samples: the points rise`).toBeGreaterThan(points[i - 1]);
    }
  }
});

test("RUN-15 the three constants are the reference server's own", async () => {
  const module = await pcm();
  expect(module.CHUNK_SLACK_SECONDS).toBe(2);
  expect(module.QUIET_WINDOW_SECONDS).toBe(0.02);
  expect(module.PCM_RATE).toBe(16_000);
});

test("RUN-15 each chunk is a wav a real reader accepts, sized exactly", async () => {
  const { splitPoints, encodeWav } = await pcm();
  const dir = scratchDir();
  const samples = plantSamples({ seconds: 150, rate: RATE, quietAt: [59.0, 118.0] });
  const points = splitPoints(samples, RATE, CHUNK_SECONDS);
  let from = 0;
  for (const [index, to] of points.entries()) {
    const piece = samples.subarray(from, to);
    const wav = encodeWav(piece, RATE);
    // The request's own size is what the recognizer's body cap is measured
    // against, so it is asserted exactly and not approximately.
    expect(wav.byteLength, `chunk ${index + 1} is a header plus its samples`)
      .toBe(44 + piece.length * 2);
    const path = join(dir, `chunk-${index}.wav`);
    writeFileSync(path, wav);
    const back = readWav(path);
    expect(back.rate).toBe(RATE);
    expect(back.samples.length).toBe(piece.length);
    expect(back.samples[0]).toBe(piece[0]);
    expect(back.samples[piece.length - 1]).toBe(piece[piece.length - 1]);
    from = to;
  }
});

test("RUN-15 three chunks are three requests, of exactly the three chunk sizes", async () => {
  const { splitPoints, encodeWav } = await pcm();
  const shelf = await transcript();
  const dir = scratchDir();
  const fake = await recognizerHere();
  const samples = plantSamples({ seconds: 150, rate: RATE, quietAt: [59.0, 118.0] });
  const points = splitPoints(samples, RATE, CHUNK_SECONDS);

  const sizes: number[] = [];
  let from = 0;
  for (const to of points) {
    sizes.push(encodeWav(samples.subarray(from, to), RATE).byteLength);
    from = to;
  }

  const audio = join(dir, "0.ogg");
  const file = shelf.chunkFilePath(audio, 0);
  await runNote({
    samples,
    rate: RATE,
    chunkSeconds: CHUNK_SECONDS,
    endpoint: fake.endpoint,
    filePath: file,
    recognizer: "local",
  });

  // The fake's own log is the assertion, never a counter the code kept.
  expect(fake.requests, "one chunk is one request").toHaveLength(3);
  expect(fake.requests.map((one) => one.bytes)).toEqual(sizes);
});

test("RUN-15 the chunk file lands beside the audio and grows after every chunk", async () => {
  const shelf = await transcript();
  const dir = scratchDir();
  const fake = await recognizerHere();
  const audio = join(dir, "0.ogg");
  // The shape is pinned by the check and not read off the build.
  expect(shelf.chunkFilePath(audio, 0)).toBe(join(dir, "0.transcript.json"));
  expect(shelf.chunkFilePath(join(dir, "2.oga"), 2)).toBe(join(dir, "2.transcript.json"));

  const file = shelf.chunkFilePath(audio, 0);
  expect(shelf.readChunkFile(file), "nothing has run yet").toBeNull();

  const samples = plantSamples({ seconds: 150, rate: RATE, quietAt: [59.0, 118.0] });
  await runNote({
    samples,
    rate: RATE,
    chunkSeconds: CHUNK_SECONDS,
    endpoint: fake.endpoint,
    filePath: file,
    recognizer: "local",
  });

  const held = shelf.readChunkFile(file);
  expect(held).not.toBeNull();
  expect(Object.keys(held as object).sort()).toEqual(["chunk_seconds", "chunks", "recognizer"]);
  expect(held!.recognizer).toBe("local");
  expect(held!.chunk_seconds).toBe(CHUNK_SECONDS);
  expect(held!.chunks).toHaveLength(3);
  for (const chunk of held!.chunks) {
    expect(Object.keys(chunk).sort()).toEqual([
      "decode_ms",
      "from_s",
      "n",
      "state",
      "text",
      "to_s",
    ]);
    expect(chunk.state).toBe("done");
  }
  expect(held!.chunks.map((one) => [one.from_s, one.to_s])).toEqual([
    [0, 59],
    [59, 118],
    [118, 150],
  ]);
});

test("RUN-15 the chunk file is on disk after chunk one, before chunk two is asked for", async () => {
  const { splitPoints, encodeWav } = await pcm();
  const shelf = await transcript();
  const dir = scratchDir();
  const fake = await recognizerHere();
  const audio = join(dir, "0.ogg");
  const file = shelf.chunkFilePath(audio, 0);
  const samples = plantSamples({ seconds: 150, rate: RATE, quietAt: [59.0, 118.0] });
  const points = splitPoints(samples, RATE, CHUNK_SECONDS);

  // One chunk at a time, by hand, so the file can be read between them. A run
  // that wrote everything at the end would show nothing here after chunk one.
  let from = 0;
  const held: ChunkFile = { recognizer: "local", chunk_seconds: CHUNK_SECONDS, chunks: [] };
  for (const [index, to] of points.entries()) {
    const piece = encodeWav(samples.subarray(from, to), RATE);
    const answer = await fetch(fake.endpoint, {
      method: "POST",
      body: piece,
      headers: { "content-length": String(piece.byteLength) },
    });
    const said = (await answer.json()) as { text: string; decode_ms: number };
    held.chunks.push({
      n: index + 1,
      from_s: from / RATE,
      to_s: to / RATE,
      text: said.text,
      decode_ms: said.decode_ms,
      state: "done",
    });
    shelf.writeChunkFile(file, held);
    expect(shelf.readChunkFile(file)!.chunks, `after chunk ${index + 1}`)
      .toHaveLength(index + 1);
    from = to;
  }
});

test("RUN-15 a resume starts at the first chunk that is not done and asks for it once", async () => {
  const shelf = await transcript();
  const dir = scratchDir();
  const samples = plantSamples({ seconds: 150, rate: RATE, quietAt: [59.0, 118.0] });
  const audio = join(dir, "0.ogg");
  const file = shelf.chunkFilePath(audio, 0);

  const done = (n: number, from: number, to: number): ChunkResult => ({
    n,
    from_s: from,
    to_s: to,
    text: `piece ${n}`,
    decode_ms: 5,
    state: "done",
  });

  // Chunks one and two done, three never attempted.
  shelf.writeChunkFile(file, {
    recognizer: "local",
    chunk_seconds: CHUNK_SECONDS,
    chunks: [done(1, 0, 59), done(2, 59, 118)],
  });
  expect(shelf.nextChunk(shelf.readChunkFile(file))).toBe(3);
  const afterCrash = await recognizerHere();
  await runNote({
    samples,
    rate: RATE,
    chunkSeconds: CHUNK_SECONDS,
    endpoint: afterCrash.endpoint,
    filePath: file,
    recognizer: "local",
  });
  expect(afterCrash.requests, "only the chunk that was missing").toHaveLength(1);

  // Chunk two failed, so the resume goes back to it and not to the start.
  const failed = { ...done(2, 59, 118), text: "", state: "failed" };
  shelf.writeChunkFile(file, {
    recognizer: "local",
    chunk_seconds: CHUNK_SECONDS,
    chunks: [done(1, 0, 59), failed, done(3, 118, 150)],
  });
  expect(shelf.nextChunk(shelf.readChunkFile(file))).toBe(2);

  // A piece the recognizer heard no words in is an ANSWER, so a resume walks
  // past it. Asking again would ask the same question of the same silence, for
  // as long as the note is alive.
  shelf.writeChunkFile(file, {
    recognizer: "local",
    chunk_seconds: CHUNK_SECONDS,
    chunks: [done(1, 0, 59), { ...done(2, 59, 118), text: "", state: "empty" }],
  });
  expect(shelf.nextChunk(shelf.readChunkFile(file)), "silence is not retried").toBe(3);

  expect(shelf.nextChunk(null), "nothing on disk starts at the first chunk").toBe(1);
});

test("RUN-15 an empty answer is an empty piece and the note goes on", async () => {
  const { splitPoints, encodeWav } = await pcm();
  const shelf = await transcript();
  const dir = scratchDir();
  const fake = await recognizerHere();
  const audio = join(dir, "0.ogg");
  const file = shelf.chunkFilePath(audio, 0);
  const samples = plantSamples({ seconds: 150, rate: RATE, quietAt: [59.0, 118.0] });
  const points = splitPoints(samples, RATE, CHUNK_SECONDS);

  const held: ChunkFile = { recognizer: "local", chunk_seconds: CHUNK_SECONDS, chunks: [] };
  let from = 0;
  for (const [index, to] of points.entries()) {
    if (index === 1) fake.setAnswer({ text: "" });
    else fake.setAnswer({ text: `piece ${index + 1}` });
    const piece = encodeWav(samples.subarray(from, to), RATE);
    const answer = await fetch(fake.endpoint, {
      method: "POST",
      body: piece,
      headers: { "content-length": String(piece.byteLength) },
    });
    const said = (await answer.json()) as { text: string; decode_ms: number };
    held.chunks.push({
      n: index + 1,
      from_s: from / RATE,
      to_s: to / RATE,
      text: said.text,
      decode_ms: said.decode_ms,
      state: said.text === "" ? "empty" : "done",
    });
    shelf.writeChunkFile(file, held);
    from = to;
  }

  expect(fake.requests, "an empty piece does not end the note").toHaveLength(3);
  const back = shelf.readChunkFile(file)!;
  expect(back.chunks.map((one) => one.state)).toEqual(["done", "empty", "done"]);
  expect(shelf.joinTranscript(back), "the non-empty pieces, one space between them")
    .toBe("piece 1 piece 3");
  // And no marker for it: the recognizer heard that stretch and there were no
  // words in it, so telling the person it was not transcribed would be false.
  expect(shelf.renderPartial(back, "en")).toBe(shelf.joinTranscript(back));
  expect(shelf.renderPartial(back, "en")).not.toContain("[...");
});

test("RUN-15 the give-up render puts the gap where the missing chunk was", async () => {
  const shelf = await transcript();
  const file: ChunkFile = {
    recognizer: "local",
    chunk_seconds: CHUNK_SECONDS,
    chunks: [
      { n: 1, from_s: 0, to_s: 59, text: "first piece", decode_ms: 5, state: "done" },
      { n: 3, from_s: 118, to_s: 150, text: "third piece", decode_ms: 5, state: "done" },
    ],
  };
  // The missing chunk's own length, computed here from the two that are
  // present, because the file carries no entry for a chunk that never ran.
  const missing = 118 - 59;
  expect(shelf.renderPartial(file, "en"))
    .toBe(`first piece [... ${missing} s not transcribed] third piece`);
  expect(shelf.renderPartial(file, "ru"))
    .toBe(`first piece [... ${missing} с не расшифровано] third piece`);

  // A chunk that is present and failed is the same gap, from its own bounds.
  const withFailure: ChunkFile = {
    recognizer: "local",
    chunk_seconds: CHUNK_SECONDS,
    chunks: [
      { n: 1, from_s: 0, to_s: 59, text: "first piece", decode_ms: 5, state: "done" },
      { n: 2, from_s: 59, to_s: 118, text: "", decode_ms: 0, state: "failed" },
      { n: 3, from_s: 118, to_s: 150, text: "third piece", decode_ms: 5, state: "done" },
    ],
  };
  expect(shelf.renderPartial(withFailure, "en"))
    .toBe(`first piece [... ${missing} s not transcribed] third piece`);
});

test("RUN-15 a note with every chunk done renders with no gap anywhere", async () => {
  const shelf = await transcript();
  const file: ChunkFile = {
    recognizer: "local",
    chunk_seconds: CHUNK_SECONDS,
    chunks: [
      { n: 1, from_s: 0, to_s: 59, text: "first piece", decode_ms: 5, state: "done" },
      { n: 2, from_s: 59, to_s: 118, text: "second piece", decode_ms: 5, state: "done" },
      { n: 3, from_s: 118, to_s: 150, text: "third piece", decode_ms: 5, state: "done" },
    ],
  };
  const whole = "first piece second piece third piece";
  expect(shelf.joinTranscript(file)).toBe(whole);
  for (const language of ["en", "ru"] as const) {
    expect(shelf.renderPartial(file, language), "no gap when nothing is missing").toBe(whole);
    expect(shelf.renderPartial(file, language)).not.toContain("[...");
  }
});

test("RUN-15 nothing partial is rendered while the retries are still running", async () => {
  const shelf = await transcript();
  const dir = scratchDir();
  const fake = await recognizerHere();
  const audio = join(dir, "0.ogg");
  const file = shelf.chunkFilePath(audio, 0);
  const samples = plantSamples({ seconds: 150, rate: RATE, quietAt: [59.0, 118.0] });

  // A partial transcript must not reach the person before the note gives up, so
  // the render is a pure read of the chunk file that the run never calls: the
  // file on disk after a full run is identical whether or not it is rendered.
  await runNote({
    samples,
    rate: RATE,
    chunkSeconds: CHUNK_SECONDS,
    endpoint: fake.endpoint,
    filePath: file,
    recognizer: "local",
  });
  const before = Bun.file(file).text();
  const held = shelf.readChunkFile(file)!;
  shelf.renderPartial(held, "en");
  shelf.renderPartial(held, "ru");
  expect(await Bun.file(file).text(), "rendering writes nothing").toBe(await before);
  expect(shelf.renderPartial(held, "en"), "and is the same answer every time")
    .toBe(shelf.renderPartial(held, "en"));
});
