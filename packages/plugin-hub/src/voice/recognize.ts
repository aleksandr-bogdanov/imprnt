import { readFileSync } from "node:fs";

/**
 * The one seam a chunk is recognized through, and the vocabulary of everything
 * that can go wrong behind it.
 *
 * A recognizer is either a process beside the door on loopback or somebody
 * else's service on the other side of a wire, and NOTHING ABOVE THIS FUNCTION
 * KNOWS WHICH. The caller assembles a request out of what the household's one
 * recognizer table says, calls this, and reads three keys back. The branch on
 * the provider happens once, here, so the door, the chunking and the transcript
 * are all written as if there were one recognizer.
 *
 * The request is a closed set of keys and a key outside it is refused, because
 * this is the boundary a chunk's audio crosses to reach a machine that is not
 * this one. What may cross is the audio and the person's language. A field
 * nobody declared would be a way for a name, a path or something somebody typed
 * to cross with it.
 */

/** The two classes a caller branches on, and there is never a third. */
export const FAILURE_CLASSES = ["infra", "content"] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * Every named cause, and the class it is.
 *
 * THE ONE PLACE A CAUSE BECOMES A CLASS. The classes mean different things to a
 * person: `infra` is "nothing is lost, it will be tried again", and `content` is
 * "this note will never become text, please type it". A cause filed under the
 * wrong one is either a note that waits for ever or a note that gives up at
 * once, so the table is written out rather than derived from a message.
 */
const CAUSE_CLASS: Record<string, FailureClass> = {
  // The recognizer, the runtime or the key is not there, or the wait ran out.
  "recognizer-unreachable": "infra",
  "recognizer-status": "infra",
  "recognizer-unparseable": "infra",
  "chunk-deadline": "infra",
  "credential-blank": "infra",
  "credential-unreadable": "infra",
  "ffmpeg-missing": "infra",
  "runtime-missing": "infra",
  // The audio itself will never become words.
  "audio-empty": "content",
  "media-unreadable": "content",
  "media-damaged": "content",
};

/** A refusal that carries its named cause and the class that cause is. */
export class DecodeRefused extends Error {
  readonly failureClass: FailureClass;
  readonly named: string;

  constructor(named: string, says: string) {
    super(`${named}: ${says}`);
    this.name = "DecodeRefused";
    this.named = named;
    this.failureClass = classifyRecognizerFailure(named);
  }
}

/**
 * The class of one failure, from the refusal itself or from its named cause.
 *
 * Anything that is not a failure this household has a name for is refused rather
 * than filed under a class by default: a success has no class, and a cause
 * nobody wrote down here would be given whichever branch the default happened to
 * be, silently.
 */
export function classifyRecognizerFailure(failure: unknown): FailureClass {
  const named =
    typeof failure === "string"
      ? failure
      : failure instanceof DecodeRefused
        ? failure.named
        : null;
  if (named === null || CAUSE_CLASS[named] === undefined) {
    throw new Error(`not-a-failure: ${typeof failure === "string" ? failure : typeof failure}`);
  }
  return CAUSE_CLASS[named];
}

/** What one chunk's recognition is asked for. Seven keys, and no eighth. */
export interface RecognizeRequest {
  /** `sherpa-onnx` or `deepgram`, from the household's recognizer table. */
  provider: string;
  /** The whole URL the chunk is posted to, path and all. */
  endpoint: string;
  model: string;
  chunk: Uint8Array;
  /** The person's own language, as a hint. Never anything they said. */
  language: string;
  deadlineMs: number;
  /** The file holding a dialled provider's key, and null for a local one. */
  credentialFile: string | null;
}

/** What comes back, whatever answered. */
export interface RecognizeAnswer {
  text: string;
  audio_s: number;
  decode_ms: number;
}

const REQUEST_KEYS = [
  "provider",
  "endpoint",
  "model",
  "chunk",
  "language",
  "deadlineMs",
  "credentialFile",
] as const;

/** Hosts a plain request may go to, because nothing leaves the machine. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function checkKeys(request: RecognizeRequest): void {
  const keys = Object.keys(request);
  for (const name of REQUEST_KEYS) {
    if (!keys.includes(name)) throw new Error(`recognize-request-missing: ${name}`);
  }
  for (const key of keys) {
    if (!(REQUEST_KEYS as readonly string[]).includes(key)) {
      throw new Error(`recognize-request-unknown: ${key}`);
    }
  }
  if (!(request.chunk instanceof Uint8Array) || request.chunk.byteLength === 0) {
    throw new Error("recognize-request-missing: chunk");
  }
  if (typeof request.deadlineMs !== "number" || request.deadlineMs <= 0) {
    throw new Error("recognize-request-missing: deadlineMs");
  }
  for (const name of ["provider", "endpoint", "model", "language"] as const) {
    if (typeof request[name] !== "string" || request[name] === "") {
      throw new Error(`recognize-request-missing: ${name}`);
    }
  }
}

async function post(
  url: string,
  request: RecognizeRequest,
  headers: Record<string, string>,
): Promise<{ body: unknown; decode_ms: number }> {
  const began = Date.now();
  let answer: Response;
  try {
    answer = await fetch(url, {
      method: "POST",
      body: request.chunk,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(request.chunk.byteLength),
        ...headers,
      },
      signal: AbortSignal.timeout(request.deadlineMs),
    });
  } catch (error) {
    const says = (error as Error).message;
    // The chunk is abandoned rather than waited out, so a wedged recognizer
    // holds no note. Which of the two happened is the caller's business only
    // through the class, and both are infra.
    if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") {
      throw new DecodeRefused("chunk-deadline", `no answer inside ${request.deadlineMs} ms`);
    }
    throw new DecodeRefused("recognizer-unreachable", says);
  }
  if (!answer.ok) {
    throw new DecodeRefused("recognizer-status", `answered ${answer.status}`);
  }
  let body: unknown;
  try {
    body = await answer.json();
  } catch (error) {
    throw new DecodeRefused("recognizer-unparseable", (error as Error).message);
  }
  return { body, decode_ms: Date.now() - began };
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The recognizer beside the door: the chunk as the raw body, its own answer. */
async function beside(request: RecognizeRequest): Promise<RecognizeAnswer> {
  const { body, decode_ms } = await post(request.endpoint, request, {});
  const said = body as Record<string, unknown> | null;
  if (said === null || typeof said !== "object" || typeof said.text !== "string") {
    throw new DecodeRefused("recognizer-unparseable", "the answer carries no text");
  }
  return {
    text: said.text,
    audio_s: number(said.audio_s),
    decode_ms: number(said.decode_ms) || decode_ms,
  };
}

/**
 * A dialled recognizer: the key read now, the audio and the language, and the
 * provider's own answer mapped onto the three keys.
 */
async function dialled(request: RecognizeRequest): Promise<RecognizeAnswer> {
  if (request.credentialFile === null) {
    throw new DecodeRefused("credential-unreadable", "this recognizer names no key file");
  }
  // READ AT THE MOMENT OF USE. A key held from startup is a key that outlives
  // its own rotation, and a key in the environment is a key every child of this
  // process can read.
  let key: string;
  try {
    key = readFileSync(request.credentialFile, "utf8").trim();
  } catch (error) {
    throw new DecodeRefused("credential-unreadable", (error as Error).message);
  }
  if (key === "") {
    throw new DecodeRefused("credential-blank", `${request.credentialFile} holds nothing`);
  }
  const url = new URL(request.endpoint);
  if (url.protocol !== "https:" && !LOOPBACK.has(url.hostname)) {
    throw new DecodeRefused(
      "recognizer-unreachable",
      `${url.host} is not this machine, so it is reached over TLS (https) or not at all`,
    );
  }
  // The audio and the language hint, and the model so the provider knows which
  // of its own to run. Nothing else: no names, no paths, nothing anybody typed.
  url.searchParams.set("language", request.language);
  url.searchParams.set("model", request.model);
  const { body, decode_ms } = await post(url.toString(), request, {
    authorization: `Token ${key}`,
  });
  const said = body as {
    metadata?: { duration?: unknown };
    results?: { channels?: { alternatives?: { transcript?: unknown }[] }[] };
  } | null;
  const transcript = said?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string") {
    throw new DecodeRefused("recognizer-unparseable", "the answer carries no transcript");
  }
  return {
    text: transcript,
    audio_s: number(said?.metadata?.duration),
    decode_ms,
  };
}

/** One chunk, one request, whatever is behind it. */
export async function recognize(request: RecognizeRequest): Promise<RecognizeAnswer> {
  checkKeys(request);
  // The only branch on the provider anywhere.
  if (request.provider === "sherpa-onnx") return await beside(request);
  if (request.provider === "deepgram") return await dialled(request);
  throw new Error(`recognize-provider-unknown: ${request.provider}`);
}
