import { describe, expect, test } from "bun:test";
import {
  encodeQr,
  formatInfoBits,
  matrixToString,
  qrToSvg,
  rsEcCodewords,
  versionInfoBits,
} from "./qr.ts";

// All payloads SYNTHETIC. The frozen fixture below was verified by rendering
// the matrix and decoding it with an independent decoder (macOS CIDetector):
// the decoded string matched the payload byte for byte. Same for versions
// 1 through 10 (structural sweep during development).

describe("BCH-protected fields", () => {
  test("format info matches the published constants", () => {
    // ISO 18004 table: EC M mask 0 = 101010000010010, EC L mask 0 = 111011111000100.
    expect(formatInfoBits(0, 0)).toBe(0b101010000010010);
    expect(formatInfoBits(1, 0)).toBe(0b111011111000100);
  });

  test("version info matches the published constant for version 7", () => {
    expect(versionInfoBits(7)).toBe(0b000111110010010100);
  });
});

describe("rsEcCodewords", () => {
  test("the published HELLO WORLD 1-M worked example", () => {
    // Data codewords for "HELLO WORLD" (alphanumeric, v1-M) from the standard
    // worked example; its 10 EC codewords are published alongside.
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsEcCodewords(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });
});

describe("encodeQr", () => {
  test("version selection: short payload v1, paypal link v3, long payload v10", () => {
    expect(encodeQr("KOPEIKA").version).toBe(1);
    expect(encodeQr("https://paypal.me/greta/250eur").version).toBe(3);
    expect(encodeQr("A".repeat(195)).version).toBe(10);
  });

  test("payload beyond version 10-M capacity fails loud", () => {
    expect(() => encodeQr("A".repeat(217))).toThrow(/exceeds version 10-M capacity/);
  });

  test("finder patterns sit in all three corners", () => {
    const qr = encodeQr("KOPEIKA");
    const finderAt = (r0: number, c0: number): boolean => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6;
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          if (qr.modules[r0 + r]![c0 + c]! !== (ring || core)) return false;
        }
      }
      return true;
    };
    expect(qr.size).toBe(21);
    expect(finderAt(0, 0)).toBe(true);
    expect(finderAt(0, qr.size - 7)).toBe(true);
    expect(finderAt(qr.size - 7, 0)).toBe(true);
  });

  test("timing patterns alternate, dark module is set", () => {
    const qr = encodeQr("KOPEIKA");
    for (let i = 8; i < qr.size - 8; i++) {
      expect(qr.modules[6]![i]!).toBe(i % 2 === 0);
      expect(qr.modules[i]![6]!).toBe(i % 2 === 0);
    }
    expect(qr.modules[qr.size - 8]![8]!).toBe(true);
  });

  test("format info in the matrix decodes to EC M + the chosen mask", () => {
    const qr = encodeQr("https://paypal.me/greta/250eur");
    // Read the second copy: bits 0-7 right-to-left along row 8 under the
    // top-right finder, bits 8-14 top-to-bottom in column 8 beside the
    // bottom-left finder.
    let bits = 0;
    for (let i = 0; i < 15; i++) {
      const bit = i < 8 ? qr.modules[8]![qr.size - 1 - i]! : qr.modules[qr.size - 15 + i]![8]!;
      if (bit) bits |= 1 << i;
    }
    expect(bits).toBe(formatInfoBits(0, qr.mask));
  });

  test("alignment pattern centered on the timing row survives (the v7+ regression)", () => {
    // Version 7 has an alignment center at (6, 22): its 5x5 pattern must exist
    // there, not be skipped because the timing pattern claimed the center first.
    const qr = encodeQr("A".repeat(110));
    expect(qr.version).toBe(7);
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        expect(qr.modules[6 + r]![22 + c]!).toBe(Math.max(Math.abs(r), Math.abs(c)) !== 1);
      }
    }
  });

  test("the frozen hand-verified matrix for the paypal link", () => {
    // Decoded back to exactly "https://paypal.me/greta/250eur" by CIDetector.
    const qr = encodeQr("https://paypal.me/greta/250eur");
    expect(qr.version).toBe(3);
    expect(qr.mask).toBe(1);
    expect(matrixToString(qr)).toBe(
      [
        "#######.##..#..####...#######",
        "#.....#...#####.#.....#.....#",
        "#.###.#.##....####.#..#.###.#",
        "#.###.#...##..#..#..#.#.###.#",
        "#.###.#..#######..#...#.###.#",
        "#.....#.#.#....#.##.#.#.....#",
        "#######.#.#.#.#.#.#.#.#######",
        "...........#..###.#.#........",
        "#.#...##..#.###...###..#..#.#",
        "#.##.#.#...####...###.##...##",
        "...##.#.##.....#..#########.#",
        ".#..#..###.###.....#.#...#...",
        "###.####.#.###.##.##..#.....#",
        ".##.#..#..#.#...#.###.##...##",
        "###.###.#.#..##.##.#....#...#",
        ".#.#...#.#..#.###.###...#....",
        "...#..#...##.##...#####.....#",
        ".#.###.#.#..###...###.##..###",
        "##.#####.......#.###....##..#",
        "...#......#.##.....##.#......",
        "###.###.###..#.##...######.#.",
        "........#..##...#...#...###.#",
        "#######.#..####.##..#.#.#...#",
        "#.....#..##...###.#.#...#...#",
        "#.###.#..#..###.#..#######...",
        "#.###.#....####...##.#..####.",
        "#.###.#.###.##.###..##..#..##",
        "#.....#...####.#..#.###..#...",
        "#######.#.#.##.#....#.###...#",
      ].join("\n"),
    );
  });
});

describe("qrToSvg", () => {
  test("one dark path, a quiet zone, and a matching viewBox", () => {
    const qr = encodeQr("KOPEIKA");
    const svg = qrToSvg(qr, "22mm");
    expect(svg).toContain('viewBox="0 0 29 29"'); // 21 + 2 * 4 quiet modules
    expect(svg).toContain('width="22mm"');
    expect(svg).toContain('fill="#000000"');
    // The first dark module of the top-left finder sits inside the quiet zone offset.
    expect(svg).toContain("M4 4h1v1h-1z");
  });
});
