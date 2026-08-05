/**
 * Dependency-free QR encoder (ISO/IEC 18004): byte mode, error correction M,
 * automatic version selection 1-10, full Reed-Solomon EC, all eight mask
 * patterns scored by the standard penalty rules, format + version info as
 * BCH-protected bit fields. Output is a module matrix plus an SVG rendering.
 *
 * Scope is deliberately the invoice use case: a paypal.me URL of well under
 * 200 bytes. Version 10-M holds 216 byte-mode characters; longer payloads
 * fail loud instead of guessing.
 *
 * Verified two ways: unit tests pin the published BCH constants and a frozen
 * module matrix, and the matrix was decoded back to the exact payload with an
 * independent decoder (macOS CIDetector) during development.
 */

export interface QrCode {
  /** Modules per side (17 + 4 * version). */
  size: number;
  /** modules[row][col] — true = dark. */
  modules: boolean[][];
  version: number;
  /** The mask pattern (0-7) that won the penalty score. */
  mask: number;
}

// --- Capacity / block structure, error correction level M only ---------------
// [ecCodewordsPerBlock, dataCodewordsPerBlock...] per version 1..10.
const M_BLOCKS: ReadonlyArray<readonly number[]> = [
  [10, 16],
  [16, 28],
  [26, 44],
  [18, 32, 32],
  [24, 43, 43],
  [16, 27, 27, 27, 27],
  [18, 31, 31, 31, 31],
  [22, 38, 38, 39, 39],
  [22, 36, 36, 36, 37, 37],
  [26, 43, 43, 43, 43, 44],
];

/** Remainder bits appended after interleaving, per version 1..10. */
const REMAINDER_BITS = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0] as const;

/** Alignment-pattern center coordinates per version 1..10. */
const ALIGNMENT_CENTERS: ReadonlyArray<readonly number[]> = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const MAX_VERSION = 10;
/** EC level M indicator bits for the format field (L=1, M=0, Q=3, H=2). */
const EC_M_BITS = 0;

// --- GF(256) arithmetic for Reed-Solomon -------------------------------------
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x >= 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** Reed-Solomon error-correction codewords for one data block. */
export function rsEcCodewords(data: readonly number[], ecCount: number): number[] {
  // Generator polynomial: product of (x - α^i) for i in 0..ecCount-1.
  let gen = [1];
  for (let i = 0; i < ecCount; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j]! ^= gfMul(gen[j]!, GF_EXP[i]!);
      next[j + 1]! ^= gen[j]!;
    }
    gen = next;
  }
  // gen is lowest-degree-first here; long division wants highest-first.
  gen.reverse();

  const rem = new Array<number>(ecCount).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0]!;
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecCount; i++) {
        rem[i]! ^= gfMul(gen[i + 1]!, factor);
      }
    }
  }
  return rem;
}

// --- BCH-protected format / version fields -----------------------------------
const G15 = 0b10100110111;
const G15_MASK = 0b101010000010010;
const G18 = 0b1111100100101;

function bchDigit(n: number): number {
  let digit = 0;
  while (n !== 0) {
    digit += 1;
    n >>>= 1;
  }
  return digit;
}

/** 15-bit format field for (ecBits, mask): 5 data bits + BCH(15,5), XOR-masked. */
export function formatInfoBits(ecBits: number, mask: number): number {
  const data = (ecBits << 3) | mask;
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) {
    d ^= G15 << (bchDigit(d) - bchDigit(G15));
  }
  return ((data << 10) | d) ^ G15_MASK;
}

/** 18-bit version field for version >= 7: 6 data bits + BCH(18,6). */
export function versionInfoBits(version: number): number {
  let d = version << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) {
    d ^= G18 << (bchDigit(d) - bchDigit(G18));
  }
  return (version << 12) | d;
}

// --- Bit buffer ---------------------------------------------------------------
class BitBuffer {
  bits: number[] = [];

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }
}

// --- Encoding ----------------------------------------------------------------
/** Smallest version 1..10 whose M-level capacity fits the byte payload. */
function pickVersion(byteLength: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const blocks = M_BLOCKS[v - 1]!;
    const dataCodewords = blocks.slice(1).reduce((s, n) => s + n, 0);
    const countBits = v <= 9 ? 8 : 16;
    const needed = 4 + countBits + 8 * byteLength;
    if (needed <= dataCodewords * 8) return v;
  }
  throw new Error(
    `qr: payload of ${byteLength} bytes exceeds version ${MAX_VERSION}-M capacity (216 bytes)`,
  );
}

/** Byte-mode data codewords: mode + count + data + terminator + padding. */
function buildDataCodewords(bytes: Uint8Array, version: number): number[] {
  const blocks = M_BLOCKS[version - 1]!;
  const dataCodewords = blocks.slice(1).reduce((s, n) => s + n, 0);
  const buf = new BitBuffer();
  buf.put(0b0100, 4); // byte mode
  buf.put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) buf.put(b, 8);
  // Terminator: up to 4 zero bits, then pad to a byte boundary.
  const capacityBits = dataCodewords * 8;
  const terminator = Math.min(4, capacityBits - buf.bits.length);
  buf.put(0, terminator);
  while (buf.bits.length % 8 !== 0) buf.bits.push(0);
  // Alternating pad codewords.
  const codewords: number[] = [];
  for (let i = 0; i < buf.bits.length; i += 8) {
    let cw = 0;
    for (let j = 0; j < 8; j++) cw = (cw << 1) | buf.bits[i + j]!;
    codewords.push(cw);
  }
  const pads = [0xec, 0x11];
  let p = 0;
  while (codewords.length < dataCodewords) {
    codewords.push(pads[p % 2]!);
    p += 1;
  }
  return codewords;
}

/** Split into RS blocks, compute EC per block, interleave data then EC. */
function buildFinalCodewords(dataCodewords: readonly number[], version: number): number[] {
  const spec = M_BLOCKS[version - 1]!;
  const ecPerBlock = spec[0]!;
  const blockSizes = spec.slice(1);

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const size of blockSizes) {
    const block = dataCodewords.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    ecBlocks.push(rsEcCodewords(block, ecPerBlock));
  }

  const out: number[] = [];
  const maxData = Math.max(...blockSizes);
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) out.push(block[i]!);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return out;
}

// --- Matrix construction ------------------------------------------------------
type Matrix = (boolean | null)[][];

function placeFinder(m: Matrix, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= m.length || cc < 0 || cc >= m.length) continue;
      const inRing =
        r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[rr]![cc] = inRing || inCore;
    }
  }
}

function placeAlignment(m: Matrix, row: number, col: number): void {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      m[row + r]![col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
    }
  }
}

/** All function patterns + reserved areas set; data modules stay null. */
function buildFunctionModules(version: number): Matrix {
  const size = 17 + 4 * version;
  const m: Matrix = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));

  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);

  // Alignment patterns BEFORE timing: centers on row/col 6 (version >= 7)
  // legitimately overlap the timing track and must win; placing timing first
  // would make the center non-null and wrongly skip the whole pattern. The
  // null check therefore only trips on genuine finder overlaps.
  const centers = ALIGNMENT_CENTERS[version - 1]!;
  for (const r of centers) {
    for (const c of centers) {
      if (m[r]![c] !== null) continue;
      placeAlignment(m, r, c);
    }
  }

  // Timing patterns (alignment modules on the track already agree with it).
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    if (m[6]![i] === null) m[6]![i] = dark;
    if (m[i]![6] === null) m[i]![6] = dark;
  }

  // Reserve the format-info areas (filled per mask later) + the dark module.
  for (let i = 0; i < 9; i++) {
    if (m[8]![i] === null) m[8]![i] = false;
    if (m[i]![8] === null) m[i]![8] = false;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8]![size - 1 - i] === null) m[8]![size - 1 - i] = false;
    if (m[size - 1 - i]![8] === null) m[size - 1 - i]![8] = false;
  }
  m[size - 8]![8] = true; // dark module

  // Version info blocks for version >= 7.
  if (version >= 7) {
    const bits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >> i) & 1) === 1;
      m[Math.floor(i / 3)]![(i % 3) + size - 11] = bit;
      m[(i % 3) + size - 11]![Math.floor(i / 3)] = bit;
    }
  }
  return m;
}

const MASK_FNS: ReadonlyArray<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Write the 15-bit format field into both reserved copies. */
function placeFormatInfo(m: Matrix, mask: number): void {
  const size = m.length;
  const bits = formatInfoBits(EC_M_BITS, mask);
  for (let i = 0; i < 15; i++) {
    const bit = ((bits >> i) & 1) === 1;
    // Copy 1: around the top-left finder.
    if (i < 6) m[i]![8] = bit;
    else if (i < 8) m[i + 1]![8] = bit;
    else m[size - 15 + i]![8] = bit;
    // Copy 2: under the top-right / beside the bottom-left finder.
    if (i < 8) m[8]![size - 1 - i] = bit;
    else if (i < 9) m[8]![15 - i - 1 + 1] = bit;
    else m[8]![15 - i - 1] = bit;
  }
  m[size - 8]![8] = true; // the dark module is never format data
}

/** Zig-zag data placement over the null modules, applying the mask inline. */
function placeData(functionModules: Matrix, codewords: readonly number[], mask: number): boolean[][] {
  const size = functionModules.length;
  const m: Matrix = functionModules.map((row) => [...row]);
  placeFormatInfo(m, mask);
  const maskFn = MASK_FNS[mask]!;

  let byteIndex = 0;
  let bitIndex = 7;
  let row = size - 1;
  let inc = -1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1; // the timing column is skipped entirely
    while (true) {
      for (let c = 0; c < 2; c++) {
        if (m[row]![col - c] !== null) continue;
        let dark = false;
        if (byteIndex < codewords.length) {
          dark = ((codewords[byteIndex]! >>> bitIndex) & 1) === 1;
        }
        if (maskFn(row, col - c)) dark = !dark;
        m[row]![col - c] = dark;
        bitIndex -= 1;
        if (bitIndex === -1) {
          byteIndex += 1;
          bitIndex = 7;
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
  return m as boolean[][];
}

// --- Mask penalty scoring (ISO 18004 rules N1-N4) -----------------------------
function penaltyScore(m: readonly boolean[][]): number {
  const size = m.length;
  let score = 0;

  // N1: runs of >= 5 same-colored modules in a row / column.
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      let prev = axis === 0 ? m[i]![0]! : m[0]![i]!;
      for (let j = 1; j < size; j++) {
        const cur = axis === 0 ? m[i]![j]! : m[j]![i]!;
        if (cur === prev) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
          prev = cur;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // N2: 2x2 blocks of one color.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r]![c]!;
      if (v === m[r]![c + 1]! && v === m[r + 1]![c]! && v === m[r + 1]![c + 1]!) score += 3;
    }
  }

  // N3: the 1:1:3:1:1 finder-like pattern with 4 light modules on either side.
  const pattern1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pattern2 = [false, false, false, false, true, false, true, true, true, false, true];
  const matches = (get: (k: number) => boolean, start: number, pat: boolean[]): boolean => {
    for (let k = 0; k < pat.length; k++) {
      if (get(start + k) !== pat[k]) return false;
    }
    return true;
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      const inRow = (k: number): boolean => m[i]![k]!;
      const inCol = (k: number): boolean => m[k]![i]!;
      if (matches(inRow, j, pattern1) || matches(inRow, j, pattern2)) score += 40;
      if (matches(inCol, j, pattern1) || matches(inCol, j, pattern2)) score += 40;
    }
  }

  // N4: dark-module proportion deviation from 50%, in 5% steps.
  let dark = 0;
  for (const rowArr of m) for (const v of rowArr) if (v) dark += 1;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

// --- Public API ---------------------------------------------------------------
/** Encode text (UTF-8, byte mode, EC level M) into a QR module matrix. */
export function encodeQr(text: string): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const dataCodewords = buildDataCodewords(bytes, version);
  const finalCodewords = buildFinalCodewords(dataCodewords, version);
  // Remainder bits are implicit zeros: placeData pads null modules with 0 bits.
  void REMAINDER_BITS;

  const functionModules = buildFunctionModules(version);
  let best: boolean[][] | null = null;
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = placeData(functionModules, finalCodewords, mask);
    const score = penaltyScore(candidate);
    if (score < bestScore) {
      best = candidate;
      bestMask = mask;
      bestScore = score;
    }
  }
  return { size: best!.length, modules: best!, version, mask: bestMask };
}

/**
 * Render as a self-contained SVG element, one path covering every dark module,
 * with the standard 4-module quiet zone. Scales to any CSS size.
 */
export function qrToSvg(qr: QrCode, cssSize: string): string {
  const quiet = 4;
  const view = qr.size + quiet * 2;
  const parts: string[] = [];
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r]![c]!) parts.push(`M${c + quiet} ${r + quiet}h1v1h-1z`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${view} ${view}" ` +
    `width="${cssSize}" height="${cssSize}" shape-rendering="crispEdges">` +
    `<rect width="${view}" height="${view}" fill="#ffffff"/>` +
    `<path d="${parts.join("")}" fill="#000000"/></svg>`
  );
}

/** Compact string form of the matrix for test fixtures: rows of '#' and '.'. */
export function matrixToString(qr: QrCode): string {
  return qr.modules.map((row) => row.map((v) => (v ? "#" : ".")).join("")).join("\n");
}
