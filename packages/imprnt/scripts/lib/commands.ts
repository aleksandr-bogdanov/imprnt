// Global command registrations: `imprnt <name>` reaches a module that lives OUTSIDE any vault, so a
// released package (an immutable directory holding <name>.js or <name>.mjs with its deps) answers
// from every directory without a symlink into a vault or an edit to any vault config.
//
// One JSON file of its own under the user's config dir, never config.json (the vault registry) and
// never anything under ~/.claude:
//   { "commands": { "<name>": { "dir": "/abs/canonical/dir" } } }
// The file only ever holds paths. Nothing in it is interpolated, expanded or run through a shell:
// the dispatcher spawns `node <dir>/<name>.js|.mjs` exactly as it does for plugins/<name>/.
//
// Read side (dispatch, list) and write side (link, unlink) differ on a damaged file on purpose:
// a read reports it, a write REFUSES to touch it, because rewriting a file we cannot parse would
// drop every registration in it. Unknown top-level keys and other names' entries ride through a
// write untouched. Core never names a module here: the name is whatever the operator linked.
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pluginScript } from "./plugins.ts";

export function commandsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "imprnt", "commands.json");
}

// A command name is one bare path segment: it is joined into `<dir>/<name>.js` and used as a JSON
// key, so `/`, `..`, a leading dot or an absolute path must never get through. Same alphabet the
// global behavior modules use (lib/global.ts), capped so a pasted blob is not a "name".
export function commandNameError(name: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) {
    return `invalid command name "${name}" - use letters, digits, dash, underscore (one path segment, at most 64 characters)`;
  }
  return undefined;
}

type Doc = Record<string, unknown>;
type Loaded = { ok: true; doc: Doc; commands: Record<string, unknown> } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// A missing file is an empty registry. Anything else that keeps us from a well-formed object (an
// unreadable file, a directory on the name, bad JSON, `commands` that is not an object) is an error.
function load(): Loaded {
  const p = commandsPath();
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { ok: true, doc: {}, commands: {} };
    return { ok: false, error: `cannot read ${p}: ${e instanceof Error ? e.message : String(e)}` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `${p} is not valid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!isPlainObject(doc)) return { ok: false, error: `${p} must hold a JSON object` };
  if (doc.commands !== undefined && !isPlainObject(doc.commands)) return { ok: false, error: `${p}: "commands" must be an object` };
  return { ok: true, doc, commands: (doc.commands as Record<string, unknown> | undefined) ?? {} };
}

// The stored directory of one entry, or undefined when the entry is not the shape we write.
function entryDir(entry: unknown): string | undefined {
  if (!isPlainObject(entry)) return undefined;
  return typeof entry.dir === "string" && isAbsolute(entry.dir) ? entry.dir : undefined;
}

// The entry script a registered directory must hold, or why it does not. The SAME check runs at
// link time and at every dispatch, so a target that disappeared after linking is caught the same way.
export function commandEntry(dir: string, name: string): { path: string; shadowed?: string } | { error: string } {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return { error: `directory ${dir} does not exist` };
  }
  if (!st.isDirectory()) return { error: `${dir} is not a directory` };
  const script = pluginScript(dir, name);
  if (!script) return { error: `${dir} has no ${name}.js or ${name}.mjs` };
  try {
    if (!statSync(script.path).isFile()) return { error: `${script.path} is not a regular file` };
  } catch {
    return { error: `${script.path} cannot be read` };
  }
  return script;
}

export type Lookup =
  | { kind: "none" }
  | { kind: "unreadable"; error: string }
  | { kind: "broken"; dir?: string; error: string }
  | { kind: "ok"; dir: string; path: string; shadowed?: string };

// Dispatch-side lookup. A name that is not a safe segment is never looked up at all, and Object.hasOwn
// keeps `toString`/`__proto__` from resolving through the prototype chain.
export function lookupCommand(name: string): Lookup {
  if (commandNameError(name)) return { kind: "none" };
  const l = load();
  if (!l.ok) return { kind: "unreadable", error: l.error };
  if (!Object.hasOwn(l.commands, name)) return { kind: "none" };
  const dir = entryDir(l.commands[name]);
  if (!dir) return { kind: "broken", error: `its entry in ${commandsPath()} is not {"dir": "<absolute path>"}` };
  const e = commandEntry(dir, name);
  if ("error" in e) return { kind: "broken", dir, error: e.error };
  return { kind: "ok", dir, ...e };
}

export type Listed = { name: string; dir?: string; error?: string };

export function listCommands(): { ok: true; commands: Listed[] } | { ok: false; error: string } {
  const l = load();
  if (!l.ok) return l;
  const out: Listed[] = [];
  for (const name of Object.keys(l.commands).sort()) {
    const dir = entryDir(l.commands[name]);
    if (commandNameError(name)) out.push({ name, dir, error: "not a valid command name, never dispatched" });
    else if (!dir) out.push({ name, error: `entry is not {"dir": "<absolute path>"}` });
    else {
      const e = commandEntry(dir, name);
      out.push("error" in e ? { name, dir, error: e.error } : { name, dir });
    }
  }
  return { ok: true, commands: out };
}

// Replace the file in one rename, so a reader sees the old registry or the new one and never half a
// write. A symlinked commands.json (a dotfiles checkout) is written at its real location, keeping
// the link. The temp file sits beside the target so the rename never crosses a filesystem.
function save(doc: Doc): void {
  const p = commandsPath();
  let target = p;
  try {
    target = realpathSync(p);
  } catch {
    /* not there yet */
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export type LinkResult =
  | { ok: true; status: "linked" | "already" | "replaced"; dir: string; path: string; previous?: string }
  | { ok: false; error: string; previous?: string };

// Register `name` -> the canonical absolute form of `from`. Nothing is copied or built: the operator
// links a released directory that already holds its entry and its dependencies. Re-linking the same
// directory is a no-op; pointing an existing name somewhere else needs `force`, and the old target is
// returned either way so the caller can print the rollback.
export function linkCommand(name: string, from: string, opts: { force?: boolean } = {}): LinkResult {
  const bad = commandNameError(name);
  if (bad) return { ok: false, error: bad };
  let dir: string;
  try {
    dir = realpathSync(from);
  } catch {
    return { ok: false, error: `--from path not found: ${from}` };
  }
  const entry = commandEntry(dir, name);
  if ("error" in entry) return { ok: false, error: entry.error };
  const l = load();
  if (!l.ok) return { ok: false, error: `refusing to modify the command registry: ${l.error} - fix or move it aside by hand` };
  const had = Object.hasOwn(l.commands, name);
  const previous = had ? (entryDir(l.commands[name]) ?? JSON.stringify(l.commands[name])) : undefined;
  if (had && previous === dir) return { ok: true, status: "already", dir, path: entry.path };
  if (had && !opts.force) {
    return { ok: false, previous, error: `already linked to ${previous} - pass --force to replace it` };
  }
  try {
    save({ ...l.doc, commands: { ...l.commands, [name]: { dir } } });
  } catch (e) {
    return { ok: false, previous, error: `cannot write ${commandsPath()}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, status: had ? "replaced" : "linked", dir, path: entry.path, previous };
}

// Drop the registration only. The directory it pointed at is never touched: it is a released
// package the operator owns, and it is the rollback target for a later relink.
export function unlinkCommand(name: string): { ok: true; removed: boolean; previous?: string } | { ok: false; error: string } {
  const bad = commandNameError(name);
  if (bad) return { ok: false, error: bad };
  const l = load();
  if (!l.ok) return { ok: false, error: `refusing to modify the command registry: ${l.error} - fix or move it aside by hand` };
  if (!Object.hasOwn(l.commands, name)) return { ok: true, removed: false };
  const previous = entryDir(l.commands[name]) ?? JSON.stringify(l.commands[name]);
  const commands = { ...l.commands };
  delete commands[name];
  try {
    save({ ...l.doc, commands });
  } catch (e) {
    return { ok: false, error: `cannot write ${commandsPath()}: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, removed: true, previous };
}
