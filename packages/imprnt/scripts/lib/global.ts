// Global-scope modules: wire a universal behavior module (anti-slop, a house style) into EVERY
// Claude Code session in every directory, not just imp sessions or the vault project.
//
// Why this is separate from lib/plugins.ts: a project plugin wires into the project's CLAUDE.local.md
// and only loads for that project (or an imp session imp inlines it into). A *global* module has to
// load even for a plain `claude` run in an unrelated repo, so the only place it can live is Claude
// Code's own user-level config that every session reads: `~/.claude/CLAUDE.md`. We never relocate that
// (Claude Code loads it regardless of CLAUDE_CONFIG_DIR); we own a fenced, managed BLOCK inside it and
// touch only that block, leaving the user's own global instructions untouched.
//
// The copy lives at `<globalDir>/imprnt/<name>/`, a stable machine-local path - NOT a pointer into a
// dev checkout (the hack this replaces hardcoded an absolute `@~/IdeaProjects/.../agent.md`). The
// import line is relative (`@imprnt/<name>/agent.md`), which Claude Code resolves against the config
// dir that holds CLAUDE.md. Same "copy, not reference" reversibility rule the plugin contract uses.
//
// Every function takes an explicit `globalDir` so it is sandbox-testable (tests pass a tmp dir); the
// CLI resolves it once to `$CLAUDE_CONFIG_DIR || ~/.claude`.
import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The fence. Everything between these two markers is imprnt's to manage; everything outside is the
// user's and is never rewritten. The markers are HTML comments so they are invisible when CLAUDE.md
// is rendered and never alter the instructions the model reads.
const BEGIN = "<!-- imprnt:global BEGIN (managed by imprnt - edit with `imprnt global add/rm`) -->";
const END = "<!-- imprnt:global END -->";

export type GlobalResult = { ok: boolean; changed: boolean; error?: string };

// A module name is a single path segment: letters, digits, dash, underscore. This is the copy-dir
// name and the import target, so a `/`, `..`, or absolute path would escape `<globalDir>/imprnt/`.
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

function importLine(name: string): string {
  return `@imprnt/${name}/agent.md`;
}

// Detect the file's dominant line ending so a managed edit never rewrites the user's CRLF/LF wholesale.
function lineEnding(content: string): string {
  const crlf = content.split("\r\n").length - 1;
  const lf = content.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

// The wired module names inside the managed block, in file order. Reads the import lines between the
// fence markers; a name appears once. Tolerant: no file / no block / a half-written block -> [].
export function listGlobalModules(globalDir: string): string[] {
  const p = claudeMdPath(globalDir);
  let content: string;
  try {
    content = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  if (start === -1 || end === -1 || end < start) return [];
  const block = content.slice(start + BEGIN.length, end);
  const names: string[] = [];
  for (const raw of block.split(/\r?\n/)) {
    const m = raw.trim().match(/^@imprnt\/([A-Za-z0-9][A-Za-z0-9_-]*)\/agent\.md$/);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// The text strictly between the first BEGIN and first END markers, or null when there is no block.
function blockBody(content: string): string | null {
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return content.slice(start + BEGIN.length, end);
}

// True when the managed block holds a non-blank line that is NOT a clean `@imprnt/<name>/agent.md`
// import - i.e. a human pasted real content between the markers. imprnt must NOT silently overwrite
// that; the caller refuses and asks the user to resolve it. (imprnt only ever writes import lines, so
// in normal use this is always false.)
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

// Rebuild CLAUDE.md's content with the managed block holding exactly `names` (sorted, one import per
// line). The user's content outside the fence is preserved (only the seam whitespace at the block
// boundary is normalized to a single blank line). An empty `names` removes the block entirely (no
// orphan markers) and keeps a blank line between the two user paragraphs that surrounded it. Pure
// string->string so it is trivially testable. `eol` is the file's detected line ending.
function withBlock(content: string, names: string[], eol: string): string {
  const sorted = [...new Set(names)].sort();
  const start = content.indexOf(BEGIN);
  const end = content.indexOf(END);
  const hasBlock = start !== -1 && end !== -1 && end >= start;

  const before = hasBlock ? content.slice(0, start) : content;
  const after = hasBlock ? content.slice(end + END.length) : "";
  // Strip the seam's newline run (CR included, so a CRLF file never gains a stray `\r`), then re-add
  // deterministic separators. This is what keeps the user's text intact while controlling the spacing.
  const head = before.replace(/(\r?\n)+$/, "");
  const tail = after.replace(/^(\r?\n)+/, "");

  if (sorted.length === 0) {
    // Removing the block: keep ONE blank line between the surrounding paragraphs when both exist, so
    // two user paragraphs that bracketed the block stay two paragraphs (never fuse into one).
    if (head && tail) return head + eol + eol + tail + eol;
    const survivor = head || tail;
    return survivor ? survivor + eol : "";
  }

  const body = sorted.map(importLine).join(eol);
  const block = `${BEGIN}${eol}${body}${eol}${END}`;
  // Reassemble head . block . tail, each separated by exactly one blank line when its neighbor exists.
  return [head, block, tail].filter((p) => p.length > 0).join(eol + eol) + eol;
}

// Wire a global behavior module: copy its shipped files to <globalDir>/imprnt/<name>/ and add its
// import line to the managed block in <globalDir>/CLAUDE.md. Idempotent. `srcDir` must contain an
// agent.md (a behavior module's fragment). Returns what happened or an error string (never throws on a
// bad input - the CLI reports it).
export function addGlobalModule(globalDir: string, name: string, srcDir: string): GlobalResult {
  const bad = nameError(name);
  if (bad) return { ok: false, changed: false, error: bad };
  if (!existsSync(join(srcDir, "agent.md"))) {
    return { ok: false, changed: false, error: `${srcDir} has no agent.md - a global module needs a behavior fragment` };
  }
  // Refuse BEFORE any copy if a human hand-edited content into the managed block - overwriting it would
  // be silent data loss. imprnt owns only the @imprnt/... import lines between its markers.
  const p0 = claudeMdPath(globalDir);
  if (existsSync(p0)) {
    try {
      if (blockHasForeignContent(readFileSync(p0, "utf8"))) {
        return { ok: false, changed: false, error: `the imprnt:global block in ${p0} has hand-edited lines - resolve them by hand first (imprnt manages only @imprnt/... import lines there)` };
      }
    } catch {
      /* unreadable file is handled by the write below */
    }
  }
  try {
    const dest = copyDir(globalDir, name);
    rmSync(dest, { recursive: true, force: true }); // a refresh is a clean copy, never an overlay of old+new
    mkdirSync(dest, { recursive: true });
    // Mirror the project-plugin copy: take the shipped tree, drop the npm manifest.
    cpSync(srcDir, dest, { recursive: true, force: true, filter: (s) => !s.endsWith("package.json") });

    const p = claudeMdPath(globalDir);
    const content = existsSync(p) ? readFileSync(p, "utf8") : "";
    const eol = content ? lineEnding(content) : "\n";
    const names = listGlobalModules(globalDir);
    const already = names.includes(name);
    const next = withBlock(content, already ? names : [...names, name], eol);
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(p, next);
    return { ok: true, changed: !already };
  } catch (e) {
    return { ok: false, changed: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Unwire a global module: remove its import line from the managed block. With `purge`, also delete the
// copied dir. Idempotent: a module that was not wired is a clean no-op (changed:false). Never touches
// the user's content outside the fence.
export function rmGlobalModule(globalDir: string, name: string, opts: { purge?: boolean } = {}): GlobalResult {
  const bad = nameError(name);
  if (bad) return { ok: false, changed: false, error: bad };
  try {
    const p = claudeMdPath(globalDir);
    let changed = false;
    if (existsSync(p)) {
      const content = readFileSync(p, "utf8");
      // Same guard as add: never rewrite a block a human pasted real content into.
      if (blockHasForeignContent(content)) {
        return { ok: false, changed: false, error: `the imprnt:global block in ${p} has hand-edited lines - resolve them by hand first` };
      }
      const names = listGlobalModules(globalDir);
      if (names.includes(name)) {
        const next = withBlock(content, names.filter((n) => n !== name), lineEnding(content));
        writeFileSync(p, next);
        changed = true;
      }
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

// On-disk copied module dirs under <globalDir>/imprnt/, for `global list` to show a wired-vs-orphaned
// view (a dir present but not in the block, or wired but the dir is gone). Tolerant of a missing dir.
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
