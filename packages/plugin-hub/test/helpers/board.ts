// Test infrastructure: the real board served in process, with every manager
// call caught and every file it writes visible.
//
// Four pieces, and two of them are the evidence the board checks rest on. The
// RECORDING SEAM is what proves no acting verb was called: the five reading
// verbs pass through to the seam it wraps and the five acting ones record and
// then THROW, so a board that called one fails the check that fetched the page
// instead of quietly succeeding. The TREE DIGEST is what proves nothing was
// written: the same directory digested before and after a sweep, which works
// the same on both platforms and needs no `lsof`.
//
// `render` is passed through and not recorded. It is pure arithmetic over an
// entry and it reaches no manager, so recording it would put a name in the log
// that says nothing about what the board asked the operating system to do.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadRegistry, type RunEntry } from "../../src/registry/load.ts";
import { listRunEntries } from "../../src/registry/entries.ts";
import type { MemoryReading, OsSeam, UnitState } from "../../src/os/types.ts";
import { unitName } from "../../src/os/names.ts";
import type { StoreLike } from "../../src/store/connect.ts";
import { hubPath } from "./cluster.ts";

/**
 * A port nothing holds, taken the way the cluster helper takes one.
 *
 * A staged registry cannot carry `port = 0`, because the loader refuses it, so
 * this is how a check gets a real port that two review seats will not share.
 */
export async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

/** One key on one `[[run]]` entry, rewritten in place, the way an editor would. */
export function setOnEntry(file: string, id: string, key: string, value: string | null): void {
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `id = ${JSON.stringify(id)}`);
  if (start < 0) throw new Error(`${file} carries no [[run]] entry whose id is ${id}`);
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== "") end++;
  const at = lines.findIndex(
    (line, i) => i > start && i < end && new RegExp(`^\\s*${key}\\s*=`).test(line),
  );
  if (value === null) {
    if (at >= 0) lines.splice(at, 1);
  } else if (at >= 0) {
    lines[at] = `${key} = ${value}`;
  } else {
    lines.splice(end, 0, `${key} = ${value}`);
  }
  writeFileSync(file, lines.join("\n"), "utf8");
}

export interface ServedBoard {
  url: string;
  port: number;
  /** A GET that never follows a redirect, so a check can assert the redirect. */
  get(path: string, init?: RequestInit): Promise<Response>;
  /** A form post, urlencoded, redirect not followed. */
  post(path: string, form?: Record<string, string>): Promise<Response>;
  stop(): Promise<void>;
}

export interface ServeBoardOptions {
  registryFile: string;
  entryId: string;
  store: StoreLike;
  os: OsSeam;
  writeRegistryKey?: unknown;
  /** What `check now` runs with, so a check never opens a real credential. */
  check?: unknown;
  now?: () => Date;
}

/**
 * The REAL `runBoard`, in this process, against the staged registry.
 *
 * A port read and then bound is a race two review seats can lose, so a bind
 * that is refused takes a fresh port, rewrites the registry and retries ONCE,
 * and says so rather than hanging if the second one is taken too.
 */
export async function serveBoard(options: ServeBoardOptions): Promise<ServedBoard> {
  const { runBoard } = (await import(hubPath("src/board/run.ts"))) as {
    runBoard: (o: Record<string, unknown>) => Promise<{ url: string; port: number; stop(): Promise<void> }>;
  };
  const entryOf = (): RunEntry => {
    const found = listRunEntries(loadRegistry(options.registryFile)).find(
      (one) => one.id === options.entryId,
    );
    if (!found) throw new Error(`${options.registryFile} carries no [[run]] entry ${options.entryId}`);
    return found;
  };
  const start = async () =>
    await runBoard({
      entry: entryOf(),
      registryFile: options.registryFile,
      store: options.store,
      os: options.os,
      writeRegistryKey: options.writeRegistryKey,
      check: options.check,
      now: options.now,
    });

  let handle: Awaited<ReturnType<typeof start>>;
  try {
    handle = await start();
  } catch (error) {
    if (!/EADDRINUSE|address already in use/i.test(String((error as Error).message))) throw error;
    setOnEntry(options.registryFile, options.entryId, "port", String(await freePort()));
    handle = await start();
  }

  const at = (path: string) => `${handle.url.replace(/\/$/, "")}${path}`;
  return {
    url: handle.url,
    port: handle.port,
    get: (path, init) => fetch(at(path), { redirect: "manual", ...(init ?? {}) }),
    post: (path, form = {}) =>
      fetch(at(path), {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      }),
    stop: () => handle.stop(),
  };
}

export interface SeamCall {
  verb: string;
  argument: string;
}

/**
 * A seam that writes down every call and refuses to act.
 *
 * The five acting verbs record and throw, so "the board called no manager verb"
 * is an assertion a build cannot pass by accident: a board that called one
 * fails the page that called it, with the verb named.
 */
export function recordingSeam(inner: OsSeam): { os: OsSeam; calls: SeamCall[]; verbs(): string[] } {
  const calls: SeamCall[] = [];
  const read = <T>(verb: string, argument: string, answer: () => T): T => {
    calls.push({ verb, argument });
    return answer();
  };
  const refuse = (verb: string, argument: string): never => {
    calls.push({ verb, argument });
    throw new Error(`the board asked the service manager to ${verb} ${argument}`);
  };
  const os: OsSeam = {
    flavour: inner.flavour,
    render: (entry, ctx) => inner.render(entry, ctx),
    install: async (files) => refuse("install", files[0]?.path ?? ""),
    remove: async (id) => refuse("remove", id),
    start: async (id) => refuse("start", id),
    stop: async (id) => refuse("stop", id),
    restart: async (id) => refuse("restart", id),
    list: async () => read("list", "", () => inner.list()),
    unitFiles: async () => read("unitFiles", "", () => inner.unitFiles?.() ?? Promise.resolve([])),
    show: async (id) => read("show", id, () => inner.show(id)),
    memory: async (pid) => read("memory", String(pid), () => inner.memory(pid)),
    available: async () => read("available", "", () => inner.available()),
  };
  return { os, calls, verbs: () => [...new Set(calls.map((call) => call.verb))].sort() };
}

/**
 * A manager whose answers a check plants: the reading verbs and nothing else.
 *
 * It is the thing `recordingSeam` wraps, so what a page read is a fact the
 * check wrote down rather than whatever this box happens to be running.
 */
export function plantedSeam(flavour: "systemd" | "launchd" = "systemd") {
  const states = new Map<string, UnitState>();
  let nextPid = 51_000;
  const named = (id: string) => `${unitName(id)}${flavour === "systemd" ? ".service" : ""}`;
  const blank = (id: string): UnitState => ({
    name: named(id),
    loaded: true,
    running: false,
    pid: null,
    runs: 1,
    ran: true,
    restarts: 0,
    lastExit: null,
    since: null,
    state: flavour === "systemd" ? "inactive" : "not running",
    result: null,
  });
  const os: OsSeam = {
    flavour,
    render: () => [],
    install: async () => [],
    remove: async () => {},
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    async list() {
      return [...states.values()];
    },
    async unitFiles() {
      return [];
    },
    async show(id) {
      return states.get(id) ?? null;
    },
    async memory(): Promise<MemoryReading> {
      return { current_bytes: 4096, peak_bytes: 8192, source: "ps-rss" };
    },
    async available() {
      return { ok: true, reason: "a manager a check planted and nothing calls" };
    },
  };
  return {
    os,
    plant(id: string, running: boolean) {
      states.set(id, running ? { ...blank(id), running: true, pid: nextPid++, state: flavour === "systemd" ? "active" : "running" } : blank(id));
    },
    forget: (id: string) => states.delete(id),
    nameOf: named,
  };
}

export interface DigestedFile {
  path: string;
  size: number;
  sha256: string;
}

/**
 * Every file under a directory, by path, size and content.
 *
 * It is how "the board opened no file for writing" is observed on both
 * platforms without `lsof`: the digest before a page sweep and the digest after
 * must be identical, and a file that was added, removed or edited shows up as a
 * difference in the list.
 */
export function treeDigest(dir: string): DigestedFile[] {
  const out: DigestedFile[] = [];
  const walk = (at: string) => {
    let found: { name: string; isDirectory(): boolean }[];
    try {
      found = readdirSync(at, { withFileTypes: true });
    } catch {
      // A directory that is not there yet digests as nothing, which is the
      // honest answer for a state directory nothing has written to.
      return;
    }
    for (const one of found) {
      const full = join(at, one.name);
      if (one.isDirectory()) {
        walk(full);
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(readFileSync(full));
      } catch {
        continue;
      }
      out.push({
        path: relative(dir, full),
        size: statSync(full).size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
