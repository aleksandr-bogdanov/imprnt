import { readFileSync } from "node:fs";
import { DecodeRefused } from "./recognize.ts";
import { PCM_RATE } from "./pcm.ts";

/**
 * The saved note turned into the samples the cut works on, under a deadline that
 * ends its own child.
 *
 * A voice note arrives in whatever the platform encodes: the converter is the one
 * thing here that reads all of them, and it is rented. What is ours is the
 * ordering: the saved bytes are checked against the receipt the download wrote
 * BEFORE anything reads them, and the child gets a deadline, because a converter
 * that wedges would otherwise hold a note for as long as the box is up.
 *
 * `DecodeRefused` is re-exported here because this is where a conversion refuses,
 * and it is DEFINED beside the seam so one table decides what class every named
 * cause is.
 */
export { DecodeRefused } from "./recognize.ts";

export interface PcmResult {
  samples: Int16Array;
  rate: number;
}

function digest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function toPcm(options: {
  file: string;
  /** The receipt's digest. The bytes are refused unless they still match it. */
  sha256: string;
  deadlineMs: number;
}): Promise<PcmResult> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(options.file));
  } catch (error) {
    throw new DecodeRefused("media-unreadable", (error as Error).message);
  }
  // First, before the converter is even spawned. A note whose bytes no longer
  // match what was downloaded will never be the right words, so it is content
  // and the person is told rather than made to wait through retries.
  if (digest(bytes) !== options.sha256) {
    throw new DecodeRefused("media-damaged", `${options.file} does not match its receipt`);
  }
  const ffmpeg = Bun.which("ffmpeg");
  if (!ffmpeg) {
    throw new DecodeRefused("ffmpeg-missing", "the converter is not on PATH");
  }

  const child = Bun.spawn(
    [
      ffmpeg,
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      options.file,
      "-ar",
      String(PCM_RATE),
      "-ac",
      "1",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  // The kill is only read where the child ended badly: a conversion that
  // finished in the same instant the deadline fired has done the work, and
  // throwing its samples away would cost the note a whole retry for nothing.
  let killed = false;
  const deadline = setTimeout(() => {
    killed = true;
    try {
      child.kill("SIGKILL");
    } catch {
      /* it ended on its own in the same instant */
    }
  }, options.deadlineMs);
  let raw: ArrayBuffer;
  let said: string;
  let code: number;
  try {
    // The child's own end is awaited, so nothing here returns while a converter
    // is still running: a refusal means the process is gone.
    [raw, said, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
  } finally {
    clearTimeout(deadline);
  }
  if (code !== 0) {
    if (killed) {
      throw new DecodeRefused(
        "chunk-deadline",
        `the converter was killed after ${options.deadlineMs} ms`,
      );
    }
    // The converter's own words name the real problem, a truncated upload or a
    // codec it does not know, and they carry no transcript.
    const why = said.replace(/\n/g, " ").trim().slice(0, 300);
    throw new DecodeRefused("media-unreadable", why || `the converter exited ${code}`);
  }
  if (raw.byteLength < 2) {
    throw new DecodeRefused("audio-empty", "the audio decoded to nothing");
  }
  // An odd trailing byte cannot be half a sample, so it is dropped rather than
  // read as one.
  const samples = new Int16Array(raw, 0, Math.floor(raw.byteLength / 2));
  return { samples, rate: PCM_RATE };
}
