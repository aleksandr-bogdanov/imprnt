import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { gapMarker, type Language } from "../door/lines.ts";

/**
 * What has been transcribed of one note so far, as a file beside the audio.
 *
 * THIS FILE IS WHY A DEAD DOOR COSTS NOTHING. Each chunk is written down the
 * moment it comes back, so a door killed in the middle of a five minute note
 * starts again at the first chunk that is not finished rather than paying for
 * every chunk a second time. It sits in the directory the download already made,
 * which is owner-only and inside the tree the box already fences.
 */

/** One chunk's own result. */
export interface ChunkResult {
  /** The chunk's number, counting from one. */
  n: number;
  from_s: number;
  to_s: number;
  text: string;
  decode_ms: number;
  /**
   * `done`, `empty` when it held no words, `failed`, or `waiting` when the
   * step has filed the stretch and has not asked for it yet.
   */
  state: string;
}

export interface ChunkFile {
  recognizer: string;
  chunk_seconds: number;
  chunks: ChunkResult[];
}

/**
 * A chunk that will never be asked for again.
 *
 * `empty` is finished: the recognizer heard the audio and there were no words in
 * it, which is an answer. Asking again would be asking the same question, and
 * marking it as a gap in the transcript would tell the person something was
 * missed when nothing was.
 */
function finished(state: string): boolean {
  return state === "done" || state === "empty";
}

/** Beside the audio, named after the same index the saved file carries. */
export function chunkFilePath(audioPath: string, index: number): string {
  return join(dirname(audioPath), `${index}.transcript.json`);
}

/**
 * What is on disk, or null when nothing has run yet.
 *
 * A file that cannot be read is refused LOUDLY rather than treated as nothing,
 * because "nothing has run yet" starts the note over and a damaged file would
 * make that silent.
 */
export function readChunkFile(path: string): ChunkFile | null {
  if (!existsSync(path)) return null;
  const held = JSON.parse(readFileSync(path, "utf8")) as ChunkFile;
  if (
    held === null ||
    typeof held !== "object" ||
    typeof held.recognizer !== "string" ||
    typeof held.chunk_seconds !== "number" ||
    !Array.isArray(held.chunks)
  ) {
    throw new Error(`chunk-file-damaged: ${path}`);
  }
  return held;
}

/** After every chunk, and whole: a half written file is a resume that restarts. */
export function writeChunkFile(path: string, file: ChunkFile): void {
  const content = `${JSON.stringify(file, null, 2)}\n`;
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temporary, path);
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** The first chunk that still needs asking for, counting from one. */
export function nextChunk(file: ChunkFile | null): number {
  if (file === null) return 1;
  const done = new Set(
    file.chunks.filter((one) => finished(one.state)).map((one) => one.n),
  );
  let n = 1;
  while (done.has(n)) n += 1;
  return n;
}

function inOrder(file: ChunkFile): ChunkResult[] {
  return [...file.chunks].sort((a, b) => a.n - b.n);
}

/** The words, in order, one space between the pieces that hold any. */
export function joinTranscript(file: ChunkFile): string {
  return inOrder(file)
    .filter((one) => finished(one.state) && one.text !== "")
    .map((one) => one.text)
    .join(" ");
}

/**
 * The words with a marker where a stretch never got its own, for the one moment
 * a note gives up.
 *
 * NOTHING CALLS THIS WHILE THE RETRIES RUN. A partial transcript reaching a
 * person who is still being told their note is coming would read as the answer.
 * The marker's POSITION is the point: a gap belongs where the silence was, not
 * appended at the end where it says nothing about which part was lost.
 *
 * The step files an entry for every chunk of a note before it asks for any of
 * them, so a stretch that never came back is marked wherever it sits. A hole
 * between two entries, or before the first, is marked too: a file written
 * before that was true still renders what it can rather than dropping it.
 */
export function renderPartial(file: ChunkFile, language: Language): string {
  const parts: string[] = [];
  let reached = 0;
  const gap = (seconds: number) => {
    if (seconds > 0) parts.push(gapMarker(language, Math.round(seconds)));
  };
  for (const chunk of inOrder(file)) {
    gap(chunk.from_s - reached);
    if (finished(chunk.state)) {
      if (chunk.text !== "") parts.push(chunk.text);
    } else {
      gap(chunk.to_s - chunk.from_s);
    }
    reached = Math.max(reached, chunk.to_s);
  }
  return parts.join(" ");
}
