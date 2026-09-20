/**
 * The cut, and the wav a chunk is posted as.
 *
 * WHY THE CLIENT CUTS. A long note decoded as one stream is what took a whole
 * box down: the encoder's attention grows faster than the audio, a five minute
 * note grew past 2.8 GB, and the hardware watchdog reset the machine three
 * times in one day. Sixty seconds of audio is a bounded, known footprint. The
 * cut happens HERE, in the client, because a server that cut internally could
 * never hand back the pieces it had already finished, and a note that survives
 * a crash is the whole reason the pieces are written down one at a time.
 *
 * The arithmetic below is a PORT, kept line for line, because the recognizer
 * that has been serving this household cuts the same samples with the same rule
 * in Python and two different cuts of one note would be two different
 * transcripts. The original, quoted so the two can be compared by eye:
 *
 *   def split_points(np, samples, rate):
 *       n = len(samples)
 *       limit = int(CHUNK_S * rate)
 *       if n <= limit:
 *           return [n]
 *       slack = int(CHUNK_SLACK_S * rate)
 *       win = max(1, int(0.02 * rate))
 *       points = []
 *       start = 0
 *       while n - start > limit:
 *           target = start + limit - slack
 *           lo, hi = target, min(start + limit, n - 1)
 *           seg = np.abs(samples[lo:hi])
 *           if len(seg) > win:
 *               kernel = np.ones(win, dtype=np.float32)
 *               energy = np.convolve(seg, kernel, mode="valid")
 *               cut = lo + int(np.argmin(energy)) + win // 2
 *           else:
 *               cut = hi
 *           points.append(cut)
 *           start = cut
 *       points.append(n)
 *       return points
 *
 * The one thing that reads differently and answers the same: the original works
 * on samples already scaled into floats, and this works on the signed integers
 * as they arrive. A sliding sum of absolute values differs between the two only
 * by a constant factor, so the quietest window is the same window, and integer
 * sums of this size are exact where a float sum is merely close.
 */

/** The rate every chunk is decoded at, and the rate the conversion produces. */
export const PCM_RATE = 16_000;

/** How far before a chunk's limit the quietest spot is looked for, seconds. */
export const CHUNK_SLACK_SECONDS = 2;

/** The window the quietest spot is measured over, seconds. */
export const QUIET_WINDOW_SECONDS = 0.02;

/**
 * Where each chunk ENDS, in samples, the last point being the end of the audio.
 *
 * `chunkSeconds` zero means the note goes out in one piece, which is the switch
 * a household with memory to spare sets. It answers before any arithmetic runs,
 * because a build that read zero as "cut every zero seconds" would never leave
 * the loop.
 */
export function splitPoints(
  samples: Int16Array,
  rate: number,
  chunkSeconds: number,
): number[] {
  const n = samples.length;
  if (chunkSeconds <= 0) return [n];
  const limit = Math.trunc(chunkSeconds * rate);
  if (limit <= 0 || n <= limit) return [n];
  const slack = Math.trunc(CHUNK_SLACK_SECONDS * rate);
  const win = Math.max(1, Math.trunc(QUIET_WINDOW_SECONDS * rate));
  const points: number[] = [];
  let start = 0;
  while (n - start > limit) {
    // The search never begins at or before the previous cut. A chunk shorter
    // than the slack has no room to look in, and without this the cut could
    // land where the last one did and the loop would never end.
    const lo = Math.max(start + 1, start + limit - slack);
    const hi = Math.min(start + limit, n - 1);
    let cut = hi;
    if (hi - lo > win) {
      // One rolling sum rather than a sum per window, and the FIRST minimum
      // wins, which is what the original's argmin answers on a tie.
      let sum = 0;
      for (let i = lo; i < lo + win; i += 1) sum += Math.abs(samples[i]);
      let quietest = sum;
      let at = 0;
      for (let j = 1; j <= hi - lo - win; j += 1) {
        sum += Math.abs(samples[lo + j + win - 1]) - Math.abs(samples[lo + j - 1]);
        if (sum < quietest) {
          quietest = sum;
          at = j;
        }
      }
      cut = lo + at + Math.floor(win / 2);
    }
    points.push(cut);
    start = cut;
  }
  points.push(n);
  return points;
}

/**
 * One chunk as a canonical mono 16-bit wav: a 44-byte header and the samples.
 *
 * The recognizer reads anything its converter reads, and a wav is what costs it
 * nothing: the bytes are already the samples it wants, so the request carries no
 * decode of its own on either side.
 */
export function encodeWav(samples: Int16Array, rate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
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
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, samples[i], true);
  }
  return out;
}
