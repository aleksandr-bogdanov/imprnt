// Plugin wiring (generic, deterministic). The whole job: list plugin dirs under plugins/
// and toggle one `@import` line per plugin in CLAUDE.local.md. Core never knows a specific
// plugin name. Adding a gallery plugin is dropping a dir, never a code edit here.
//
// CLAUDE.local.md lives at the repo root next to the committed CLAUDE.md, because Claude Code
// resolves `@import` lines from there. We append/remove exactly one line and keep it idempotent.
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

const HEADER = `# Personal plugin toggles (this machine only)

> Gitignored. Claude Code auto-loads this right after CLAUDE.md, so whatever you @import here is
> wired into the agent every session. This is the on/off switch: add a line to enable a plugin,
> delete or comment it to disable. Managed by \`imprnt plugin add/rm\`, or hand-edit it.

`;

// The wiring line for a plugin spec. `<name>` resolves to plugins/<name>/agent.md;
// `<name>/<file.md>` wires that exact file. Returns the relative import target used in the line.
export function entryFor(spec: string): string {
  if (spec.includes("/")) return `plugins/${spec}`;
  return `plugins/${spec}/agent.md`;
}

// Containment guard for every user-supplied plugin spec. The commands rm/cp/wire whatever the
// spec resolves to, so `..`, `foo/..`, or an absolute path would reach OUTSIDE plugins/ (a bare
// `rm .. --purge` used to delete the whole project). Two checks, both required:
//
//  1. The resolved target must sit strictly inside <root>/plugins/ - plugins/ itself does not count.
//  2. The spec must be in canonical form (no `./` and no embedded `..`). A spec like `./_personal`
//     or `guard/../_personal` can resolve INSIDE plugins/ yet route around every literal-string
//     guard downstream: the wired @import line (`@plugins/guard/../_personal/voice.md`) becomes
//     un-removable by a natural rm, and the purge `_`-prefix protection keys on the literal string,
//     so a non-canonical spec slips past it and deletes the private cast. Comparing the spec to its
//     own relative-from-plugins canonical form rejects both `./` and embedded `..` in one check.
//
// A LONE trailing slash is tolerated, not rejected: shell dir tab-completion appends it
// (`rm anti-slop/`), it is harmless noise, and each command strips it (rmPlugin) or fails it
// cleanly later (add, via the entryExists file check). It is normalized away before the canonical
// comparison so it never trips check #2.
//
// Returns the error, undefined when safe.
export function specError(root: string, spec: string): string | undefined {
  const norm = spec.endsWith("/") ? spec.slice(0, -1) : spec;
  const base = resolve(root, "plugins");
  const target = resolve(base, norm);
  if (target === base || !target.startsWith(base + sep)) {
    return `invalid plugin spec "${spec}" - must name something inside plugins/`;
  }
  // canonical = the path you'd get walking from plugins/ to the resolved target, with forward
  // slashes (the spec format). A deviation (./, embedded ..) means the spec was non-canonical.
  const canonical = relative(base, target).split(sep).join("/");
  if (norm !== canonical) {
    return `invalid plugin spec "${spec}" - use the canonical form "${canonical}" (no ./ or ..)`;
  }
  return undefined;
}

// The basename the spec resolves to, used by guards that must key on the REAL target, not the
// literal spec string. specError already forces canonical specs, so this is the resolved leaf.
export function resolvedBasename(root: string, spec: string): string {
  return basename(resolve(root, "plugins", spec));
}

function localPath(root: string): string {
  return join(root, "CLAUDE.local.md");
}

// Does the file an entry points at actually exist under the repo root? `add` checks this so it
// never wires a dangling @import (a missing plugin dir, or a <name> with no agent.md).
export function entryExists(root: string, entry: string): boolean {
  const p = join(root, entry);
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function importLine(entry: string): string {
  return `@${entry}`;
}

// Every top-level dir under plugins/ except _-prefixed ones (private, non-gallery convention)
// and any file (README.md). Dotfiles are skipped too.
export function listPluginDirs(root: string): string[] {
  const dir = join(root, "plugins");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith("_") && !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

// Unreadable counts as empty: a missing file, a directory squatting on the name (EISDIR), or a
// permission problem all read as "nothing wired" - the read side (list/isEnabled/launch) must
// never crash on a hand-managed file. The write side (add/rm) surfaces its own error instead.
function readLocal(root: string): string {
  try {
    return readFileSync(localPath(root), "utf8");
  } catch {
    return "";
  }
}

// CLAUDE.local.md is hand-editable, so a managed edit must not rewrite the user's line endings
// wholesale. Detect the file's dominant ending once and write every managed line with it.
function lineEnding(content: string): string {
  const crlf = content.split("\r\n").length - 1;
  const lf = content.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

// The live (uncommented, unfenced) @import lines of CLAUDE.local.md, trimmed, in file order.
// This is the ONE line scanner both the read side (importTargets/isEnabled) and `imp`'s inliner
// agree on. Claude Code does NOT evaluate @imports inside a ``` code fence, so a fenced line must
// be skipped here too - otherwise it would load in every outside session yet never in the lair
// (the two the launcher promises match), and `plugin list` would report a fenced plugin [on].
// A fence opens/closes on a line that starts with ``` or ~~~ (an info string like ```md is fine).
function liveImportLines(root: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const raw of readLocal(root).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.startsWith("@")) out.push(line);
  }
  return out;
}

// The @import targets currently wired in CLAUDE.local.md, in file order, without the leading
// `@`. `imp` inlines these same fragments when it launches a session outside the project
// (lib/launch.ts), so the write side (add/rm) and the read side can never disagree on what
// "enabled" means.
export function importTargets(root: string): string[] {
  return liveImportLines(root).map((l) => l.slice(1));
}

// A plugin counts as enabled if CLAUDE.local.md has a live @import line pointing anywhere inside
// plugins/<name>/. Both `add <name>` and `add <name>/<file>` land here. A commented or fenced
// line is not live, so it is not enabled.
export function isEnabled(root: string, name: string): boolean {
  const prefix = `@plugins/${name}/`;
  return liveImportLines(root).some((l) => l.startsWith(prefix));
}

// Wire a plugin in. Creates CLAUDE.local.md with a header on first add. Idempotent: a line
// already present is left alone. Refuses an uncontained spec (specError) and a dangling @import:
// if the resolved entry file does not exist under plugins/, returns an error and writes nothing.
// Returns the import target, whether it was newly added, and an optional error string for the
// caller to report. An fs failure (read-only file, a dir squatting on the name) is an error
// string too, never a throw - the cli's multi-add loop relies on that to keep going.
export function addPlugin(
  root: string,
  spec: string,
): { entry: string; added: boolean; error?: string } {
  const entry = entryFor(spec);
  const invalid = specError(root, spec);
  if (invalid) return { entry, added: false, error: invalid };
  if (!entryExists(root, entry)) {
    return {
      entry,
      added: false,
      error: `no such plugin entry: ${entry}; expected an agent.md or a <name>/<file>.md`,
    };
  }
  const line = importLine(entry);
  const p = localPath(root);
  try {
    let content = existsSync(p) ? readFileSync(p, "utf8") : HEADER;
    const already = content.split(/\r?\n/).some((l) => l.trim() === line);
    if (already) return { entry, added: false };
    const eol = lineEnding(content);
    if (!content.endsWith("\n")) content += eol;
    content += line + eol;
    writeFileSync(p, content);
    return { entry, added: true };
  } catch (e) {
    return { entry, added: false, error: `cannot update ${p}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// Unwire a plugin - the mirror of add for BOTH spec shapes. A bare name removes every
// uncommented @import line under plugins/<name>/ (the group). A `<name>/<file.md>` spec removes
// exactly the line that spec's add wired, so `rm _personal/voice.md` never takes a sibling
// fragment with it. Idempotent: no file or no match is a clean no-op. Returns how many lines
// went away. Only the managed lines change: the file's own line endings are preserved.
export function rmPlugin(root: string, spec: string): number {
  const p = localPath(root);
  if (!existsSync(p)) return 0;
  // Shell dir tab-completion appends a trailing slash (`rm anti-slop/`). Without stripping it,
  // includes("/") flips to the exact-file matcher `@plugins/anti-slop/`, which never equals the
  // wired `@plugins/anti-slop/agent.md` - a silent no-op that reports success. Treat a lone
  // trailing slash as the bare-name (group) form.
  if (spec.endsWith("/")) spec = spec.slice(0, -1);
  const gone = spec.includes("/")
    ? (l: string) => l === importLine(entryFor(spec))
    : (l: string) => l.startsWith(`@plugins/${spec}/`);
  const content = readFileSync(p, "utf8");
  const lines = content.split(/\r?\n/);
  const kept = lines.filter((l) => !gone(l.trim()));
  const removed = lines.length - kept.length;
  if (removed) writeFileSync(p, kept.join(lineEnding(content)));
  return removed;
}
