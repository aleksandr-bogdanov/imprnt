import { voiceUnreadable, type Language } from "../door/lines.ts";
import type { VoiceSettings } from "../registry/entries.ts";
import type { StoreLike } from "../store/connect.ts";
import { toPcm } from "./decode.ts";
import { voiceFailed, voiceSucceeded } from "./health.ts";
import { encodeWav, splitPoints } from "./pcm.ts";
import {
  classifyRecognizerFailure,
  DecodeRefused,
  recognize,
  type FailureClass,
} from "./recognize.ts";
import { markMediaDone, markMediaFailed, recordTranscribe } from "./records.ts";
import {
  chunkFilePath,
  joinTranscript,
  nextChunk,
  readChunkFile,
  writeChunkFile,
  type ChunkFile,
} from "./transcript.ts";

/**
 * One note, driven from its saved bytes to its words or to a named failure.
 *
 * IT DOES NOT DECIDE WHEN IT RUNS AND IT SAYS NOTHING TO ANYBODY. The door owns
 * the schedule, the chat and the projection; this owns the arithmetic. That
 * split is what lets the door keep its own promise that a message is written
 * down before the platform is told it arrived: the commit happens first and
 * this runs afterwards, in a task of its own.
 *
 * The projection is the door's call and never this module's, because the door
 * is what appends the log line and what knows whether the file write landed.
 */

/**
 * The three things a check replaces to drive every branch without a server.
 *
 * The production caller passes `REAL_SEAMS`, so there is exactly one place the
 * real converter, the real recognizer and the real clock are named.
 */
export interface VoiceStepSeams {
  toPcm: typeof toPcm;
  recognize: typeof recognize;
  now(): number;
}

export const REAL_SEAMS: VoiceStepSeams = {
  toPcm,
  recognize,
  now: () => Date.now(),
};

/** Which saved media of a row is the voice note, and where its line sits. */
export interface VoiceMediaRef {
  /** Its place in `source.media`, which is also the name the saved file carries. */
  index: number;
  /** Its own line in `source.lines`, stored at accept time. */
  line: number;
  path: string;
  sha256: string;
}

export interface TranscribeOutcome {
  state: "done" | "failed";
  /** `infra` or `content` when it failed, and null when it did not. */
  failure: FailureClass | null;
  cause: string | null;
  /** When the row is worth another try, and null when nothing will help. */
  retryAt: Date | null;
  /**
   * The moment this row's text existed, which is what the shipped clocks
   * measure from: the words for a note that came back, the sentence the person
   * reads for one that never will, and null while the row is still waiting.
   */
  doneAt: Date | null;
  chunks: number;
  audio_s: number;
  decode_ms: number;
  transcript: string;
}

interface SourceShape {
  text?: string;
  lines?: string[];
  media?: Record<string, unknown>[];
  [key: string]: unknown;
}

/**
 * The first saved voice note of a row, or null when it carries none.
 *
 * A media that failed to download is not one: its saved file is a descriptor
 * saying the download failed, and the person has already been told.
 */
export function voiceMediaOf(source: unknown): VoiceMediaRef | null {
  const media = (source as SourceShape | null)?.media;
  if (!Array.isArray(media)) return null;
  for (const [index, one] of media.entries()) {
    const it = one as Record<string, unknown>;
    if (it.kind !== "voice" || it.failed === true) continue;
    if (typeof it.path !== "string" || typeof it.sha256 !== "string") continue;
    if (typeof it.line !== "number") continue;
    return { index, line: it.line, path: it.path, sha256: it.sha256 };
  }
  return null;
}

/**
 * The words, into the text, at the line the note's own marker sits on.
 *
 * PURE, AND AT A STORED INDEX RATHER THAN A SEARCHED ONE. A search for the
 * marker inside a text a person also wrote could find a line the person typed,
 * and the door already knows the answer when it writes the row, so it stores it
 * and this reads it. Every later line moves down by one, the media that own
 * them included, so a note carrying two of them stays consistent.
 */
export function spliceTranscript(
  source: Record<string, unknown>,
  index: number,
  transcript: string,
): Record<string, unknown> {
  const it = source as SourceShape;
  const lines = [...(it.lines ?? [])];
  lines.splice(index + 1, 0, transcript);
  const media = (it.media ?? []).map((one) => {
    const at = (one as { line?: unknown }).line;
    return typeof at === "number" && at > index ? { ...one, line: at + 1 } : one;
  });
  return { ...source, lines, media, text: lines.join("\n") };
}

/** The cause of a refusal, however it was thrown. */
function named(error: unknown): string {
  const it = error as { named?: unknown; message?: unknown };
  return typeof it?.named === "string" ? it.named : String(it?.message ?? error);
}

function classOf(error: unknown): FailureClass {
  try {
    return classifyRecognizerFailure(error);
  } catch {
    // A failure nobody wrote a class for is the recognizer or the box having a
    // bad day rather than a note that will never become words, so it waits.
    return "infra";
  }
}

export async function transcribeRow(
  store: StoreLike,
  options: {
    row: { id: string; source: Record<string, unknown> };
    voice: VoiceSettings;
    /** The whole URL a chunk is posted to, path and all. */
    endpoint: string;
    /** The file a dialled recognizer reads its key from, null for a local one. */
    credentialFile: string | null;
    language: Language;
    /** What the row has already spent, for the diary line. */
    attempts?: number;
    seams?: VoiceStepSeams;
  },
): Promise<TranscribeOutcome> {
  const seams = options.seams ?? REAL_SEAMS;
  const { voice, row } = options;
  const recognizer = voice.recognizer;
  const attempts = options.attempts ?? 0;
  const note = voiceMediaOf(row.source);
  if (note === null) throw new Error(`voice-media-missing: ${row.id}`);
  const chunkPath = chunkFilePath(note.path, note.index);
  const deadlineMs = voice.chunk_deadline_seconds * 1000;

  await recordTranscribe(store, {
    id: row.id, kind: "transcribe.started", recognizer,
    chunks: null, audio_s: null, decode_ms: null, attempts,
  });

  /** One ending, so every branch leaves the same shape behind. */
  const failed = async (error: unknown, partial: { chunks: number; audio_s: number; decode_ms: number }): Promise<TranscribeOutcome> => {
    const failure = classOf(error);
    const cause = named(error);
    const retryAt = failure === "infra"
      ? new Date(seams.now() + voice.retry_seconds * 1000)
      : null;
    // The sentence a content failure writes IS this row's text, so the row ends
    // with the same stamp a success gets and the shipped clocks count from it.
    const endedAt = failure === "content" ? new Date(seams.now()) : null;
    if (failure === "content") {
      // Over at once, with the sentence in the slot the words would have had,
      // so the caption and anything typed stay where the person put them.
      const source = spliceTranscript(row.source, note.line, voiceUnreadable(options.language));
      await markMediaFailed(store, {
        id: row.id, state: "failed", failure: { class: failure, cause }, retryAt: null,
        body: String((source as SourceShape).text ?? ""), source, at: endedAt!,
      });
    } else {
      // The row stays PENDING: nothing about the note is wrong, so it waits.
      await markMediaFailed(store, {
        id: row.id, state: "pending", failure: { class: failure, cause }, retryAt,
      });
      // The recognizer's own health is about the recognizer. A note whose audio
      // will never become words says nothing about whether it is working.
      await voiceFailed(store, { recognizer, class: failure, cause, retry_at: retryAt });
    }
    await recordTranscribe(store, {
      id: row.id, kind: "transcribe.failed", recognizer,
      chunks: partial.chunks, audio_s: partial.audio_s, decode_ms: partial.decode_ms,
      attempts: attempts + 1, class: failure, cause,
    });
    return { state: "failed", failure, cause, retryAt, doneAt: endedAt, transcript: "", ...partial };
  };

  let samples: Int16Array;
  let rate: number;
  try {
    // The saved bytes are checked against their receipt before anything reads
    // them, and the converter runs under its own deadline.
    ({ samples, rate } = await seams.toPcm({ file: note.path, sha256: note.sha256, deadlineMs }));
  } catch (error) {
    return await failed(error, { chunks: 0, audio_s: 0, decode_ms: 0 });
  }

  const points = splitPoints(samples, rate, voice.chunk_seconds);
  let file: ChunkFile;
  try {
    file = readChunkFile(chunkPath) ?? { recognizer, chunk_seconds: voice.chunk_seconds, chunks: [] };
  } catch (error) {
    return await failed(error, { chunks: points.length, audio_s: samples.length / rate, decode_ms: 0 });
  }
  // A note whose chunk length changed under it starts again rather than joining
  // pieces cut two different ways, which would be two different transcripts.
  if (file.recognizer !== recognizer || file.chunk_seconds !== voice.chunk_seconds) {
    file = { recognizer, chunk_seconds: voice.chunk_seconds, chunks: [] };
  }

  // EVERY CHUNK GETS ITS ENTRY, including the ones nobody has asked for yet.
  // The boundaries are known here and nowhere later, and a stretch with no
  // entry at all is one nothing on file can measure: if this note runs out its
  // window, the give-up render can only mark what the file describes, so a
  // chunk that was never reached would be lost without a word. They are carried
  // by the writes below rather than written on their own, so the file still
  // appears at the moment the first chunk is answered.
  const known = new Set(file.chunks.map((one) => one.n));
  for (let n = 1; n <= points.length; n += 1) {
    if (known.has(n)) continue;
    file.chunks.push({
      n, from_s: (n === 1 ? 0 : points[n - 2]) / rate, to_s: points[n - 1] / rate,
      text: "", decode_ms: 0, state: "waiting",
    });
  }

  const audioSeconds = samples.length / rate;
  let spent = 0;
  for (let n = nextChunk(file); n <= points.length; n = nextChunk(file)) {
    const from = n === 1 ? 0 : points[n - 2];
    const to = points[n - 1];
    const chunk = encodeWav(samples.subarray(from, to), rate);
    let answer;
    try {
      answer = await seams.recognize({
        provider: voice.provider, endpoint: options.endpoint, model: voice.model,
        chunk, language: options.language, deadlineMs,
        credentialFile: options.credentialFile,
      });
    } catch (error) {
      // Every piece that finished stays on disk, so the next try starts where
      // this one stopped rather than paying for all of them again. The piece
      // that did not is written down as failed, and the pieces after it keep
      // the entries made above, which is what puts a gap marker in the RIGHT
      // PLACE for each of them if the note eventually gives up.
      file.chunks = [...file.chunks.filter((one) => one.n !== n), {
        n, from_s: from / rate, to_s: to / rate, text: "", decode_ms: 0, state: "failed",
      }];
      try { writeChunkFile(chunkPath, file); } catch { /* the failure below is the answer */ }
      return await failed(error, { chunks: points.length, audio_s: audioSeconds, decode_ms: spent });
    }
    spent += answer.decode_ms;
    const text = answer.text.trim();
    file.chunks = [...file.chunks.filter((one) => one.n !== n), {
      n, from_s: from / rate, to_s: to / rate, text,
      decode_ms: answer.decode_ms,
      // A piece the recognizer heard no words in is an ANSWER. Asking again
      // would ask the same question, and the note goes on.
      state: text === "" ? "empty" : "done",
    }];
    // Written before the next chunk starts, so this step's own crash costs the
    // chunk it was on and nothing before it.
    writeChunkFile(chunkPath, file);
  }

  const transcript = joinTranscript(file);
  if (transcript === "") {
    // Every piece answered and none of them held words. Waiting will not change
    // that, so the person is asked to type it.
    return await failed(
      new DecodeRefused("audio-empty", "every piece came back and none of them held words"),
      { chunks: points.length, audio_s: audioSeconds, decode_ms: spent },
    );
  }

  const source = spliceTranscript(row.source, note.line, transcript) as SourceShape;
  source.media = (source.media ?? []).map((one, at) => at === note.index ? {
    ...one,
    transcript_path: chunkPath,
    recognizer,
    audio_s: audioSeconds,
    decode_ms: spent,
    chunks: points.length,
  } : one);
  const doneAt = new Date(seams.now());
  await markMediaDone(store, {
    id: row.id, body: String(source.text ?? ""),
    source: source as Record<string, unknown>, at: doneAt,
  });
  await recordTranscribe(store, {
    id: row.id, kind: "transcribe.done", recognizer,
    chunks: points.length, audio_s: audioSeconds, decode_ms: spent, attempts,
  });
  await voiceSucceeded(store, recognizer);
  return {
    state: "done", failure: null, cause: null, retryAt: null, doneAt,
    chunks: points.length, audio_s: audioSeconds, decode_ms: spent, transcript,
  };
}
