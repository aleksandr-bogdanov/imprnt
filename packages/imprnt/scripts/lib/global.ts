// Global-scope modules: wire a universal behavior module (anti-slop, a house style) into EVERY
// imp session, regardless of directory - not just the vault project, and not just a plain `claude`.
//
// Why this is separate from lib/plugins.ts: a project plugin wires into the project's CLAUDE.local.md
// and only loads for that project (or an imp session imp inlines it into). A *global* module loads in
// every imp session, in any directory, because imp injects it via --append-system-prompt the same way
// it injects the project cast. A plain `claude` no longer loads globals by design - imprnt only ever
// affects sessions launched with `imp`, and the user's hand-maintained ~/.claude/CLAUDE.md stays
// pristine. (The OLD design owned a fenced block inside ~/.claude/CLAUDE.md; this removes that
// pollution. listGlobalModules migrates a clean legacy block forward and strips it - see migrate().)
//
// The copy lives at `<globalDir>/imprnt/<name>/`, a stable machine-local path. The enable list lives
// at `<globalDir>/imprnt/global.json` (imprnt-owned, sibling to the copies), shape:
//   { "enabled": ["anti-slop", "demo"] }
// A name is enabled iff it is in that list AND its agent.md copy exists. Same "copy, not reference"
// reversibility rule the plugin contract uses.
//
// Every function takes an explicit `globalDir` so it is sandbox-testable (tests pass a tmp dir); the
// CLI resolves it once to `$CLAUDE_CONFIG_DIR || ~/.claude`.
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The LEGACY fence. The old design owned everything between these two markers inside
// <globalDir>/CLAUDE.md. We no longer write a block; we only DETECT and STRIP a clean one on any
// global command, carrying its names into the new registry (the self-healing migration). The markers
// are HTML comments so a legacy block was invisible when CLAUDE.md rendered.
const BEGIN = "<!-- imprnt:global BEGIN (managed by imprnt - edit with `imprnt global add/rm`) -->";
const END = "<!-- imprnt:global END -->";

export type GlobalResult = { ok: boolean; changed: boolean; error?: string };

// A module name is a single path segment: letters, digits, dash, underscore. This is the copy-dir
// name and a JSON list entry, so a `/`, `..`, or absolute path would escape `<globalDir>/imprnt/`.
// Reject anything else up front - the same containment discipline as the project plugin specError.
function nameError(name: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    return `invalid module name "${name}" - use letters, digits, dash, underscore (one path segment)`;
  }
  return undefined;
}

function claudeMdPath(globalDir: string): string {
  return join(globalDir, "CLAUDE.md");
}

function copyDir(globalDir: string, name: string): string {
  return join(globalDir, "imprnt", name);
}

function registryPath(globalDir: string): string {
  return join(globalDir, "imprnt", "global.json");
}

// Detect the file's dominant line ending so a managed edit never rewrites the user's CRLF/LF wholesale.
function lineEnding(content: string): string {
  const crlf = content.split("\r\n").length - 1;
  const lf = content.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

// ---------------------------------------------------------------------------
// Legacy CLAUDE.md block: detect + strip (the migration). imprnt never WRITES a block anymore.
// ---------------------------------------------------------------------------

// The text strictly between the first BEGIN and first END markers, or null when there is no block.
function blockBody(content: string): string | null {
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return content.slice(start + BEGIN.length, end);
}

// The module names inside a legacy managed block, in file order. A name appears once. Tolerant: a
// content without a block -> []. This is what the migration carries forward into the registry.
function legacyBlockNames(content: string): string[] {
  const body = blockBody(content);
  if (body === null) return [];
  const names: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const m = raw.trim().match(/^@imprnt\/([A-Za-z0-9][A-Za-z0-9_-]*)\/agent\.md$/);
    if (m && !names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
}

// True when the legacy block holds a non-blank line that is NOT a clean `@imprnt/<name>/agent.md`
// import - i.e. a human pasted real content between the markers. The migration must NOT silently
// overwrite that; the caller refuses and asks the user to resolve it. (imprnt only ever wrote import
// lines, so in normal use this is always false.)
export function blockHasForeignContent(content: string): boolean {
  const body = blockBody(content);
  if (body === null) return false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!/^@imprnt\/[A-Za-z0-9][A-Za-z0-9_-]*\/agent\.md$/.test(line)) return true;
  }
  return false;
}

// Rebuild CLAUDE.md's content with the legacy block REMOVED, the user's content outside the fence
// preserved (only the seam whitespace at the block boundary is normalized to a single blank line).
// Keeps a blank line between two user paragraphs that surrounded the block (never fuses them). Pure
// string->string so it is trivially testable. `eol` is the file's detected line ending.
function withoutBlock(content: string, eol: string): string {
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  const hasBlock = start !== -1 && end !== -1 && end >= start;
  if (!hasBlock) return content;

  const before = content.slice(0, start);
  const after = content.slice(end + END.length);
  // Strip the seam's newline run (CR included, so a CRLF file never gains a stray `\r`), then re-add
  // deterministic separators. This is what keeps the user's text intact while controlling the spacing.
  const head = before.replace(/(\r?\n)+$/, "");
  const tail = after.replace(/^(\r?\n)+/, "");
  // Keep ONE blank line between the surrounding paragraphs when both exist, so two user paragraphs
  // that bracketed the block stay two paragraphs (never fuse into one).
  if (head && tail) return head + eol + eol + tail + eol;
  const survivor = head || tail;
  return survivor ? survivor + eol : "";
}

// The migration step, run on EVERY global command (add/rm/list) so existing installs self-heal:
// if a legacy imprnt-managed block still exists in <globalDir>/CLAUDE.md, carry its module names into
// the registry and strip the block cleanly. Refuses (and leaves the file untouched, returns an error)
// only when a human pasted real content into the block - exactly the old safety. Returns:
//   - migrated names (empty when there was no block, nothing to do)
//   - an error string when the block has foreign content (caller surfaces it, touches nothing else)
// Never throws on a bad/unreadable file: a read failure is treated as "no block".
function migrate(globalDir: string): { names: string[]; error?: string } {
  const p = claudeMdPath(globalDir);
  if (!existsSync(p)) return { names: [] };
  let content: string;
  try {
    content = readFileSync(p, "utf8");
  } catch {
    return { names: [] }; // unreadable file -> nothing to migrate
  }
  if (blockBody(content) === null) return { names: [] }; // no legacy block
  if (blockHasForeignContent(content)) {
    return {
      names: [],
      error: `the legacy imprnt:global block in ${p} has hand-edited lines - resolve them by hand first (imprnt no longer manages CLAUDE.md; delete the block once you have moved its content)`,
    };
  }
  const names = legacyBlockNames(content);
  // Strip the clean block, preserving the user's surrounding content byte-for-byte.
  const next = withoutBlock(content, lineEnding(content));
  try {
    writeFileSync(p, next);
  } catch {
    // Could not rewrite CLAUDE.md (read-only): still report the names so the registry catches up; the
    // block stays but the registry now owns the truth and injection works regardless.
  }
  return { names };
}

// ---------------------------------------------------------------------------
// The registry: <globalDir>/imprnt/global.json = { enabled: string[] }
// ---------------------------------------------------------------------------

// Read the enabled-names list from the registry. Tolerant: a missing/corrupt file or a non-array
// `enabled` reads as []. Non-string and invalid-name entries are dropped (a hand edit, a partial
// write), so no caller ever feeds garbage downstream. Returns a sorted, deduped list.
function readEnabled(globalDir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(registryPath(globalDir), "utf8"));
    const list = Array.isArray(raw?.enabled) ? raw.enabled : [];
    const names = new Set<string>();
    for (const v of list) if (typeof v === "string" && !nameError(v)) names.add(v);
    return [...names].sort();
  } catch {
    return [];
  }
}

function writeEnabled(globalDir: string, names: string[]): void {
  const sorted = [...new Set(names)].sort();
  const p = registryPath(globalDir);
  mkdirSync(join(globalDir, "imprnt"), { recursive: true });
  writeFileSync(p, JSON.stringify({ enabled: sorted }, null, 2) + "\n");
}

// The enabled module names: registry entries, migrating a legacy CLAUDE.md block forward first so an
// existing install self-heals. A migration error (a human-edited block) does NOT block the read - it
// returns the registry as-is (the block is left for the user to resolve), so list/inject keep working.
export function listGlobalModules(globalDir: string): string[] {
  const m = migrate(globalDir);
  const fromRegistry = readEnabled(globalDir);
  if (m.error || m.names.length === 0) return fromRegistry;
  // Fold migrated names into the registry and persist, so the next read needs no migration.
  const merged = [...new Set([...fromRegistry, ...m.names])].sort();
  try {
    writeEnabled(globalDir, merged);
  } catch {
    /* unwritable registry: still return the merged view for this run */
  }
  return merged;
}

// ---------------------------------------------------------------------------
// add / rm
// ---------------------------------------------------------------------------

// Wire a global behavior module: copy its shipped files to <globalDir>/imprnt/<name>/ and add its
// name to the registry. Idempotent. `srcDir` must contain an agent.md (a behavior module's fragment).
// Returns what happened or an error string (never throws on a bad input - the CLI reports it).
export function addGlobalModule(globalDir: string, name: string, srcDir: string): GlobalResult {
  const bad = nameError(name);
  if (bad) return { ok: false, changed: false, error: bad };
  if (!existsSync(join(srcDir, "agent.md"))) {
    return { ok: false, changed: false, error: `${srcDir} has no agent.md - a global module needs a behavior fragment` };
  }
  // Migrate a legacy block forward first; refuse BEFORE any copy if a human hand-edited content into
  // it (resolving that is a human call, never a silent overwrite).
  const m = migrate(globalDir);
  if (m.error) return { ok: false, changed: false, error: m.error };
  try {
    const dest = copyDir(globalDir, name);
    rmSync(dest, { recursive: true, force: true }); // a refresh is a clean copy, never an overlay of old+new
    mkdirSync(dest, { recursive: true });
    // Mirror the project-plugin copy: take the shipped tree, drop the npm manifest.
    cpSync(srcDir, dest, { recursive: true, force: true, filter: (s) => !s.endsWith("package.json") });

    const current = [...new Set([...readEnabled(globalDir), ...m.names])];
    const already = current.includes(name);
    writeEnabled(globalDir, already ? current : [...current, name]);
    return { ok: true, changed: !already };
  } catch (e) {
    return { ok: false, changed: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Unwire a global module: drop its name from the registry. With `purge`, also delete the copied dir.
// Idempotent: a module that was not enabled is a clean no-op (changed:false). Migrates a legacy block
// forward first (and refuses on a human-edited one, same as add).
export function rmGlobalModule(globalDir: string, name: string, opts: { purge?: boolean } = {}): GlobalResult {
  const bad = nameError(name);
  if (bad) return { ok: false, changed: false, error: bad };
  const m = migrate(globalDir);
  if (m.error) return { ok: false, changed: false, error: m.error };
  try {
    let changed = false;
    const current = [...new Set([...readEnabled(globalDir), ...m.names])];
    if (current.includes(name)) {
      writeEnabled(globalDir, current.filter((n) => n !== name));
      changed = true;
    } else if (m.names.length) {
      // The migration brought names in but `name` is not among them - still persist the migrated set
      // so the legacy block does not re-migrate next run.
      writeEnabled(globalDir, current);
    }
    if (opts.purge) {
      const dest = copyDir(globalDir, name);
      if (existsSync(dest)) {
        rmSync(dest, { recursive: true, force: true });
        changed = true;
      }
    }
    return { ok: true, changed };
  } catch (e) {
    return { ok: false, changed: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// On-disk copied module dirs under <globalDir>/imprnt/, for `global list` to show an enabled-vs-
// orphaned view (a dir present but not enabled, or enabled but the dir is gone). The registry file
// itself (global.json) is not a dir, so it is naturally excluded. Tolerant of a missing dir.
export function installedGlobalDirs(globalDir: string): string[] {
  const base = join(globalDir, "imprnt");
  try {
    return readdirSync(base)
      .filter((n) => {
        try {
          return statSync(join(base, n)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

// The concatenated agent.md fragments of every ENABLED global module, in sorted order, for imp to
// append to its --append-system-prompt cast on EVERY session. `skip` names a set of modules already
// injected by another path (the project cast), so a plugin enabled both project-locally AND globally
// is not double-injected. A module enabled in the registry whose agent.md copy is missing is skipped
// (the copy is the truth; an orphan enable contributes nothing). Pure read, no LLM, no network.
export function globalFragment(globalDir: string, skip: Set<string> = new Set()): string {
  const parts: string[] = [];
  for (const name of listGlobalModules(globalDir)) {
    if (skip.has(name)) continue;
    const p = join(copyDir(globalDir, name), "agent.md");
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, "utf8").trim();
      if (text) parts.push(text);
    } catch {
      /* unreadable copy: skip, never crash the launch */
    }
  }
  return parts.join("\n\n");
}
