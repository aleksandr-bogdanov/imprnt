import { isIP } from "node:net";

/**
 * IP addresses as the sixteen bytes they name, so two spellings of one address
 * compare equal.
 *
 * An address has many spellings: `::1` and `0:0:0:0:0:0:0:1`, `2001:DB8::1`
 * and `2001:db8::1`, `127.0.0.1` and `::ffff:127.0.0.1`. A rule written against
 * one spelling is a rule the next spelling walks past, so every comparison here
 * is made on the bytes. An IPv4 address is carried as its IPv4-mapped IPv6
 * form, which is how a dual-stack socket reports an IPv4 peer anyway.
 */

/** The address's bytes, or null for anything that is not an IP literal. */
export function addressBytes(text: string): Uint8Array | null {
  let bare = String(text).trim();
  if (bare.startsWith("[") && bare.endsWith("]")) bare = bare.slice(1, -1);
  // A zone names an interface, never a different address.
  const zone = bare.indexOf("%");
  if (zone >= 0 && bare.includes(":")) bare = bare.slice(0, zone);
  const kind = isIP(bare);
  if (kind === 4) return mapped(bare);
  if (kind !== 6) return null;

  let tail: number[] = [];
  let head = bare;
  // An IPv4 address written in the last thirty-two bits.
  const dotted = bare.lastIndexOf(":");
  if (bare.slice(dotted + 1).includes(".")) {
    const four = mapped(bare.slice(dotted + 1));
    if (four === null) return null;
    tail = [(four[12] << 8) | four[13], (four[14] << 8) | four[15]];
    head = bare.slice(0, dotted + 1);
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const groups = (part: string) => (part === "" ? [] : part.split(":").map((one) => parseInt(one, 16)));
  const [left, right] = head.includes("::") ? head.split("::") : [head, null];
  const front = groups(left);
  const back = right === null ? [] : groups(right);
  const missing = 8 - front.length - back.length - tail.length;
  if (missing < 0 || (right === null && missing !== 0)) return null;
  const words = [...front, ...new Array(missing).fill(0), ...back, ...tail];
  const out = new Uint8Array(16);
  words.forEach((word, i) => {
    out[i * 2] = (word >> 8) & 0xff;
    out[i * 2 + 1] = word & 0xff;
  });
  return out;
}

function mapped(dotted: string): Uint8Array | null {
  if (isIP(dotted) !== 4) return null;
  const out = new Uint8Array(16);
  out[10] = 0xff;
  out[11] = 0xff;
  dotted.split(".").forEach((one, i) => {
    out[12 + i] = Number(one);
  });
  return out;
}

/** Whether two texts name the same address. Anything that is not one names nothing. */
export function sameAddress(a: string, b: string): boolean {
  const left = addressBytes(a);
  const right = addressBytes(b);
  return left !== null && right !== null && left.every((byte, i) => byte === right[i]);
}

/** `::1`, and every IPv4 address in 127/8 however it is spelled. */
export function isLoopback(text: string): boolean {
  const bytes = addressBytes(text);
  if (bytes === null) return false;
  const v4 = bytes.slice(0, 10).every((one) => one === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (v4) return bytes[12] === 127;
  return bytes.slice(0, 15).every((one) => one === 0) && bytes[15] === 1;
}
