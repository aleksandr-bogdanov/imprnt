// Test infrastructure: a STRICT reader for the property lists launchd is handed.
//
// The rendering check used to ask whether the text CONTAINED a number, and a
// renderer that emitted `321garbage`, or a plist that no parser accepts, passed
// it. launchd does not read a substring: it reads a typed tree, and a job whose
// plist it cannot parse never runs at all. So the check reads the same tree,
// through a parser that refuses anything malformed, and asserts typed values.
//
// `parsePlist` is the test's own, deliberately, and it is the one used for the
// assertions, because `plutil` exists on macOS only and the rendering check is
// pure and runs on both platforms. On a Mac `plutilJson` runs Apple's own
// parser over the same bytes and the check asserts the two agree, so the parser
// the Linux half leans on is verified by the platform that owns the format in
// every run that happens on a Mac.
//
// It covers exactly the subset a unit file can hold: dict, array, string,
// integer, real, true and false. Anything else, including `data` and `date`,
// throws by name rather than being guessed at.

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PlistValue =
  | string
  | number
  | boolean
  | PlistValue[]
  | { [key: string]: PlistValue };

interface Node {
  kind: "open" | "close" | "empty" | "text";
  name: string;
  value: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) return String.fromCodePoint(Number(body.slice(1)));
    const found = ENTITIES[body];
    if (found === undefined) throw new Error(`the plist carries an entity this reader has no rule for: &${body};`);
    return found;
  });
}

function scan(text: string): Node[] {
  // The prologue is not part of the tree, and a plist that lacks it is one
  // launchd would still read, so it is skipped rather than required.
  let rest = text
    .replace(/^﻿/, "")
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const out: Node[] = [];
  for (;;) {
    const at = rest.indexOf("<");
    if (at < 0) {
      if (rest.trim() !== "") throw new Error(`the plist carries text outside any tag: ${rest.trim().slice(0, 40)}`);
      return out;
    }
    const before = rest.slice(0, at);
    if (before.trim() !== "") out.push({ kind: "text", name: "", value: decode(before) });
    const end = rest.indexOf(">", at);
    if (end < 0) throw new Error("the plist has a tag that never closes");
    const inside = rest.slice(at + 1, end).trim();
    rest = rest.slice(end + 1);
    if (inside.startsWith("/")) {
      out.push({ kind: "close", name: inside.slice(1).trim(), value: "" });
    } else if (inside.endsWith("/")) {
      out.push({ kind: "empty", name: inside.slice(0, -1).trim().split(/\s+/)[0], value: "" });
    } else {
      out.push({ kind: "open", name: inside.split(/\s+/)[0], value: "" });
    }
  }
}

/** The typed tree a plist holds. Throws, by name, on anything malformed. */
export function parsePlist(text: string): PlistValue {
  const nodes = scan(text);
  let at = 0;

  const peek = (): Node | null => nodes[at] ?? null;
  const take = (): Node => {
    const node = nodes[at];
    if (!node) throw new Error("the plist ended in the middle of a value");
    at += 1;
    return node;
  };
  const expectClose = (name: string): void => {
    const node = take();
    if (node.kind !== "close" || node.name !== name) {
      throw new Error(`the plist wanted </${name}> and found ${node.kind} ${node.name || node.value}`);
    }
  };
  /** The text between an open tag and its close, empty when there is none. */
  const textOf = (name: string): string => {
    const node = peek();
    if (node && node.kind === "text") {
      at += 1;
      expectClose(name);
      return node.value;
    }
    expectClose(name);
    return "";
  };

  const value = (): PlistValue => {
    const node = take();
    if (node.kind === "empty") {
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      if (node.name === "array") return [];
      if (node.name === "dict") return {};
      if (node.name === "string") return "";
      throw new Error(`the plist carries an empty <${node.name}/>, which this reader has no rule for`);
    }
    if (node.kind !== "open") {
      throw new Error(`the plist wanted a value and found ${node.kind} ${node.name || node.value}`);
    }
    switch (node.name) {
      case "true":
        expectClose("true");
        return true;
      case "false":
        expectClose("false");
        return false;
      case "string":
        return textOf("string");
      case "key":
        throw new Error("the plist has a <key> where a value belongs");
      case "integer": {
        const raw = textOf("integer").trim();
        if (!/^-?\d+$/.test(raw)) throw new Error(`<integer>${raw}</integer> is not an integer`);
        return Number(raw);
      }
      case "real": {
        const raw = textOf("real").trim();
        if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(raw)) {
          throw new Error(`<real>${raw}</real> is not a number`);
        }
        return Number(raw);
      }
      case "array": {
        const items: PlistValue[] = [];
        for (;;) {
          const next = peek();
          if (!next) throw new Error("the plist has an <array> that never closes");
          if (next.kind === "close" && next.name === "array") {
            at += 1;
            return items;
          }
          if (next.kind === "text") {
            at += 1;
            continue;
          }
          items.push(value());
        }
      }
      case "dict": {
        const map: Record<string, PlistValue> = {};
        for (;;) {
          const next = peek();
          if (!next) throw new Error("the plist has a <dict> that never closes");
          if (next.kind === "close" && next.name === "dict") {
            at += 1;
            return map;
          }
          if (next.kind === "text") {
            at += 1;
            continue;
          }
          if (next.kind !== "open" || next.name !== "key") {
            throw new Error(`the plist wanted a <key> inside a <dict> and found ${next.kind} ${next.name}`);
          }
          at += 1;
          const key = textOf("key");
          if (key in map) throw new Error(`the plist names the key ${key} twice`);
          map[key] = value();
        }
      }
      default:
        throw new Error(`the plist carries a <${node.name}>, which this reader has no rule for`);
    }
  };

  let node = take();
  while (node.kind === "text") node = take();
  if (node.kind !== "open" || node.name !== "plist") {
    throw new Error(`the plist does not open with <plist>, it opens with ${node.kind} ${node.name}`);
  }
  const tree = value();
  let closing = take();
  while (closing.kind === "text") closing = take();
  if (closing.kind !== "close" || closing.name !== "plist") {
    throw new Error("the plist does not close with </plist>");
  }
  while (at < nodes.length) {
    const trailing = take();
    if (trailing.kind !== "text") {
      throw new Error(`the plist carries ${trailing.kind} ${trailing.name} after </plist>`);
    }
  }
  return tree;
}

/** A plist as one dict, or a readable throw. */
export function parsePlistDict(text: string): Record<string, PlistValue> {
  const tree = parsePlist(text);
  if (tree === null || typeof tree !== "object" || Array.isArray(tree)) {
    throw new Error("the top of a unit plist is a dict, and this one is not");
  }
  return tree as Record<string, PlistValue>;
}

/**
 * The same tree with every dict's keys in one order.
 *
 * `plutil` hands back a dict in its own order, so a comparison of two renderings
 * of the same tree has to be about the tree and not about the order two tools
 * happened to print it in. Arrays keep their order, which is the one place order
 * is part of the value (`ProgramArguments`).
 */
export function canonical(value: PlistValue | null): PlistValue | null {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => canonical(item) as PlistValue);
  const out: Record<string, PlistValue> = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]) as PlistValue;
  return out;
}

/**
 * The same bytes through Apple's own parser, on a Mac. Null everywhere else.
 *
 * `plutil -convert json -o - -- <file>` refuses a malformed plist with a
 * non-zero status, so this is both an oracle for the reader above and a real
 * check that launchd could have read the file at all.
 */
export async function plutilJson(text: string): Promise<PlistValue | null> {
  if (process.platform !== "darwin") return null;
  const file = join(tmpdir(), `hub-plist-${crypto.randomUUID().slice(0, 8)}.plist`);
  await Bun.write(file, text);
  try {
    const done = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", "--", file], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((done.exitCode ?? 1) !== 0) {
      throw new Error(
        `plutil refused the rendered plist: ${(done.stderr?.toString() ?? "").trim()}`,
      );
    }
    return JSON.parse(done.stdout?.toString() ?? "null") as PlistValue;
  } finally {
    rmSync(file, { force: true });
  }
}
