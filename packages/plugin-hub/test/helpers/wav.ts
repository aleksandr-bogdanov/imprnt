// Test infrastructure: audio whose cut points are knowable by hand, and a wav
// file the real tools read.
//
// THE PLANTED ARRAY IS THE EVIDENCE the cut check rests on. The client's cut is
// a port of the reference server's own arithmetic, and the only way to assert a
// port against the RULE rather than against another implementation of the rule
// is to hand both the same samples and know, from the plant alone, where the
// quietest window is.
//
// So the waveform outside a quiet band has a CONSTANT absolute value. Every
// sliding window of it carries exactly the same energy, and a band of silence
// exactly one window wide is then the unique minimum: the cut lands on that
// band's centre and nowhere else. A random or a shaped waveform would make the
// expected point depend on the seed or on the tone, which is a check that
// passes for the wrong reason.

import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";

/** The rate everything here is measured at, the one the recognizer wants. */
export const WAV_RATE = 16_000;

/** The absolute value of every sample outside a quiet band. */
const LOUD = 8_000;

/** The window the cut is searched with, in seconds. The reference server's own. */
const QUIET_WINDOW_SECONDS = 0.02;

export interface PlantOptions {
  seconds: number;
  rate: number;
  /**
   * The instants, in seconds, to silence a band of one window around.
   *
   * A band is centred so that the cut arithmetic (`window start + half a
   * window`) lands on the instant itself, which is what makes an expected cut
   * point one multiplication rather than a derivation.
   */
  quietAt: number[];
}

/** How wide a quiet band is, in samples, at this rate. */
export function quietWindowSamples(rate: number): number {
  return Math.max(1, Math.round(QUIET_WINDOW_SECONDS * rate));
}

/**
 * Where a band planted at this instant begins, in samples.
 *
 * The cut is `window start + floor(window / 2)`, so a band beginning half a
 * window before the instant puts the cut on the instant.
 */
export function quietBandStart(atSeconds: number, rate: number): number {
  const win = quietWindowSamples(rate);
  return Math.round(atSeconds * rate) - Math.floor(win / 2);
}

export function plantSamples(options: PlantOptions): Int16Array {
  const { seconds, rate, quietAt } = options;
  const length = Math.round(seconds * rate);
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error("plant-length");
  const win = quietWindowSamples(rate);
  const samples = new Int16Array(length);
  // Alternating sign, constant magnitude: audible as a square wave and, more to
  // the point, flat under a windowed absolute-value sum.
  for (let i = 0; i < length; i += 1) samples[i] = i % 2 === 0 ? LOUD : -LOUD;
  for (const at of quietAt) {
    const start = quietBandStart(at, rate);
    if (start < 0 || start + win > length) throw new Error(`plant-band-outside: ${at}`);
    samples.fill(0, start, start + win);
  }
  return samples;
}

function header(sampleCount: number, rate: number): Uint8Array {
  const dataBytes = sampleCount * 2;
  const out = new Uint8Array(44);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // uncompressed PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return out;
}

/** A canonical mono 16-bit wav: the 44-byte header and the samples, nothing else. */
export function writeWav(path: string, samples: Int16Array, rate: number): void {
  const bytes = new Uint8Array(44 + samples.length * 2);
  bytes.set(header(samples.length, rate), 0);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i += 1) view.setInt16(44 + i * 2, samples[i], true);
  const fd = openSync(path, "w", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read a wav back, ASSERTING the header rather than trusting it.
 *
 * A reader that assumed the same layout its own writer used would agree with a
 * wrong header and prove nothing, so every field a real decoder reads is
 * checked here by name.
 *
 * It WALKS the chunk list rather than reading fixed offsets, because a real
 * encoder writes chunks this one does not: ffmpeg puts a `LIST` of metadata
 * between `fmt ` and `data`, so a reader pinned to offset 36 would reject the
 * very file this helper exists to prove is readable.
 */
export function readWav(path: string): { samples: Int16Array; rate: number } {
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.length < 44) throw new Error("wav-short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (text(0, 4) !== "RIFF") throw new Error("wav-no-riff");
  if (view.getUint32(4, true) !== bytes.length - 8) throw new Error("wav-riff-length");
  if (text(8, 4) !== "WAVE") throw new Error("wav-no-wave");
  let rate = 0;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = text(at, 4);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      if (size < 16) throw new Error("wav-fmt-size");
      if (view.getUint16(body, true) !== 1) throw new Error("wav-not-pcm");
      if (view.getUint16(body + 2, true) !== 1) throw new Error("wav-not-mono");
      if (view.getUint16(body + 14, true) !== 16) throw new Error("wav-not-16-bit");
      rate = view.getUint32(body + 4, true);
      if (view.getUint32(body + 8, true) !== rate * 2) throw new Error("wav-byte-rate");
      if (view.getUint16(body + 12, true) !== 2) throw new Error("wav-block-align");
    }
    if (id === "data") {
      if (rate === 0) throw new Error("wav-data-before-fmt");
      if (body + size > bytes.length) throw new Error("wav-data-length");
      const samples = new Int16Array(Math.floor(size / 2));
      for (let i = 0; i < samples.length; i += 1) {
        samples[i] = view.getInt16(body + i * 2, true);
      }
      return { samples, rate };
    }
    // Chunks are word aligned, so an odd size carries one pad byte.
    at = body + size + (size % 2);
  }
  throw new Error("wav-no-data");
}
