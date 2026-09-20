// Test infrastructure: a recognizer on loopback that keeps a record of exactly
// what it was handed.
//
// It answers the same contract the local provider's reference server does:
// `POST /transcribe` takes the chunk's bytes as the raw body, requires a
// `Content-Length` and answers `{ text, audio_s, decode_ms }`; `GET /health`
// answers `{ ok: true }`.
//
// THE REQUEST LOG IS THE POINT. A cloud recognizer is allowed the chunk's
// audio and the person's language hint and nothing else, and that is only
// assertable against a log that kept everything it was sent: the method, the
// path, the query string, the header NAMES, the body's length and the body's
// digest. The bodies themselves are never kept, so a check that plants a
// codeword cannot pass by reading it back out of the fixture.
//
// Every check that starts one stops it in `finally`.

import { createHash } from "node:crypto";

/** What the server was handed, one entry per request, in arrival order. */
export interface RecordedRequest {
  method: string;
  path: string;
  /** The query string with its leading `?`, or the empty string. */
  query: string;
  /** Lower-cased header names, sorted, so an assertion is order-free. */
  headerNames: string[];
  /** Every header, lower-cased, for the few a check needs the value of. */
  headers: Record<string, string>;
  bytes: number;
  sha256: string;
}

/** What `/transcribe` answers. The three keys the contract names. */
export interface RecognizerAnswer {
  text: string;
  audio_s: number;
  decode_ms: number;
}

export interface FakeRecognizer {
  port: number;
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  url: string;
  /** The full URL a client posts a chunk to, path included. */
  endpoint: string;
  requests: RecordedRequest[];
  setAnswer(answer: Partial<RecognizerAnswer>): void;
  /**
   * Answer this JSON body instead of the three keys.
   *
   * A cloud recognizer answers in its own shape, and the seam is what maps that
   * shape onto the three keys. A fake that could only answer the three would
   * leave the mapping unasserted.
   */
  setRawAnswer(body: unknown): void;
  setDelayMs(ms: number): void;
  setStatus(status: number): void;
  /** The next request fails once, and everything after it answers normally. */
  setRefuseOnce(): void;
  /**
   * Every request from the nth on fails, counting from one.
   *
   * A note cut into pieces is asked for in one pass with nothing between the
   * requests, so a check that wants the FIRST piece to land and the rest to
   * stop has no moment to flip a status in. This is that, decided in advance.
   */
  setRefuseFrom(nth: number): void;
  stop(): Promise<void>;
}

export interface FakeRecognizerOptions {
  /** The path a chunk is posted to. A cloud provider has its own. */
  path?: string;
}

const NO_CONTENT_LENGTH = 411;

export async function fakeRecognizer(
  options: FakeRecognizerOptions = {},
): Promise<FakeRecognizer> {
  const chunkPath = options.path ?? "/transcribe";
  const requests: RecordedRequest[] = [];
  let answer: RecognizerAnswer = { text: "synthetic transcript", audio_s: 1, decode_ms: 1 };
  let raw: unknown = undefined;
  let delayMs = 0;
  let status = 200;
  let refuseOnce = false;
  let refuseFrom: number | null = null;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;
      const body = new Uint8Array(await request.arrayBuffer());
      requests.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        headerNames: Object.keys(headers).sort(),
        headers,
        bytes: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
      });

      if (url.pathname === "/health" && request.method === "GET") {
        return Response.json({ ok: true });
      }
      if (url.pathname !== chunkPath || request.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      // The reference server reads the body by its declared length, so a
      // request that declares none is refused before anything is decoded.
      if (headers["content-length"] === undefined) {
        return new Response("length required", { status: NO_CONTENT_LENGTH });
      }
      if (refuseOnce) {
        refuseOnce = false;
        return new Response("synthetic one-off failure", { status: 503 });
      }
      // Counted over the chunk requests this fake has taken, the one already
      // recorded above included, so the nth request is the nth refusal.
      if (refuseFrom !== null && requests.filter((one) => one.path === chunkPath).length >= refuseFrom) {
        return new Response("synthetic failure", { status: 503 });
      }
      if (delayMs > 0) await Bun.sleep(delayMs);
      if (status !== 200) return new Response("synthetic failure", { status });
      return Response.json(raw === undefined ? answer : raw);
    },
  });

  const port = Number(server.port);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    endpoint: `http://127.0.0.1:${port}${chunkPath}`,
    requests,
    setAnswer(next) {
      answer = { ...answer, ...next };
    },
    setRawAnswer(body) {
      raw = body;
    },
    setDelayMs(ms) {
      delayMs = ms;
    },
    setStatus(next) {
      status = next;
    },
    setRefuseOnce() {
      refuseOnce = true;
    },
    setRefuseFrom(nth) {
      refuseFrom = nth;
    },
    async stop() {
      await server.stop(true);
    },
  };
}
