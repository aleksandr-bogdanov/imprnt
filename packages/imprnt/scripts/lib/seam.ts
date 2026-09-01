// The seam: the boundary between a vault and a MOUNT it carries (a shared tree checked out inside
// vault/, maintained somewhere else — the household zone two people both read and write).
//
// WHY THESE PREDICATES LIVE TOGETHER. Two commands ask the same questions about the same boundary:
// `imprnt vault move` asks them BEFORE it moves a note (what would break on the other side), and
// `imprnt check` asks them AFTER (what did break). If the two ever disagree, the tool that moves a
// note produces a note the tool that checks it condemns, and the human is caught between them. So
// the predicates are written once, here, and both callers import them.
//
// The one idea underneath all of them: a mount note must be COMPLETE INSIDE THE MOUNT. Everything it
// reaches for has to sit under the mount too, because the other person's vault holds the mount and
// nothing else of yours. A link out of the mount resolves for you and dangles for them, and they can
// do nothing about it — which is exactly the failure the mount exists to prevent.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fmList, stripCode } from "./moc.ts";
import type { FolderRoles } from "./folders.ts";

// The wikilink shape both readers use: `[[target]]`, `[[target#heading]]`, `[[target|alias]]`.
// Kept identical to check.ts's historic regex, which is now imported from here.
export const LINK = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

// A resolvable corpus: every note slug, plus a basename index for bare `[[slug]]` links.
export type Corpus = { slugs: Set<string>; byBasename: Map<string, string[]> };

export function corpusOf(notes: { slug: string }[]): Corpus {
  const slugs = new Set<string>();
  const byBasename = new Map<string, string[]>();
  for (const n of notes) {
    slugs.add(n.slug);
    const base = n.slug.includes("/") ? n.slug.slice(n.slug.lastIndexOf("/") + 1) : n.slug;
    (byBasename.get(base) ?? byBasename.set(base, []).get(base)!).push(n.slug);
  }
  return { slugs, byBasename };
}

// Normalize a link target to the slug form the corpus holds: no `./`, no `.md`, trimmed.
export function cleanTarget(target: string): string {
  return target.trim().replace(/^\.\//, "").replace(/\.md$/, "");
}

// Every note slug a link target resolves to. A path-form target resolves to at most one note; a bare
// slug can match several folders, so it resolves to all of them. Resolution is against the collected
// EXACT-CASE slug set only — no existsSync fallback, which is case-insensitive on APFS and would make
// macOS and Linux disagree about the same vault.
export function resolveSlugs(target: string, c: Corpus): string[] {
  const t = cleanTarget(target);
  if (!t) return [];
  if (t.includes("/")) return c.slugs.has(t) ? [t] : [];
  return c.byBasename.get(t) ?? [];
}

// The mount a slug lives under, if any. `folder` is the first path segment, exactly as check reads it.
export function mountOf(slug: string, mounts: Iterable<string>): string | undefined {
  const folder = slug.includes("/") ? slug.slice(0, slug.indexOf("/")) : slug;
  for (const m of mounts) if (m === folder) return m;
  return undefined;
}

// The folder a mount note browses in, INSIDE the mount: `household/finances/rent` -> `finances`. This
// is the mount-scoped twin of check's `folder`, and it is what a mount's own _folders.md declares
// roles for. Returns "" for a note sitting loose at the mount root.
export function innerFolder(slug: string, mount: string): string {
  const rest = slug.slice(mount.length + 1);
  return rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : "";
}

// An EVIDENCE link points into an immutable snapshot locker, which is outside the searchable corpus by
// construction — so it is never an orphan and never a graph edge. Two lockers exist: the vault's own
// top-level `raw/`, and a mount's `_raw/` (underscore-prefixed, so the walk skips it the same way it
// skips `_tags.md`). The mount needs its own because a link into the PARENT's raw/ is dead for anyone
// else reading the mount, which is what `seam-dead-source` flags.
export function isEvidenceTarget(target: string, mounts: Iterable<string>): boolean {
  const t = cleanTarget(target);
  if (t.startsWith("raw/")) return true;
  for (const m of mounts) if (t.startsWith(`${m}/_raw/`)) return true;
  return false;
}

// ONE definition of where a wikilink can live, obeyed by both readers of the same links. `check`
// decides what a link IS (matchesOutsideCode, below) and `vault move` decides what a link BECOMES
// (replaceOutsideCode). They used to be written separately, and the mover rewrote a literal
// `[[old/path]]` sitting inside a fenced example the checker had already ruled out as an edge — a
// documented snippet silently edited by a command nobody aimed at it, and the two tools holding
// different opinions about one note, which is the failure this file exists to prevent.
//
// stripCode stays in moc.ts: it is the layout-preserving primitive (code blanked to spaces, every
// newline kept) and moc's own H1 fallback reads it, so pulling it in here would make moc import seam
// and seam import moc. What lives here is the LINK-level rule built on top of it.
//
// The mask test is exact for a pattern whose first and last characters are punctuation: stripCode
// replaces code with spaces at the SAME offsets, and `[` / `]` are never spaces, so a match whose
// first or last character differs between the raw text and its mask reaches into code. BOTH ends are
// tested: the start rules out a link written inside a fence, and the end rules out one that opens in
// prose and closes inside a fence (an unterminated fence below a stray `[[`), which the start test
// alone would let through as a bogus edge. What sits BETWEEN the ends is not required to match, which
// is what keeps an alias carrying an inline-code span (`` [[x|the `y` thing]] ``) a real link.
//
// Matching itself runs over the RAW text, never the masked copy, so that alias still yields its true
// groups instead of the blanked ones.
export function matchesOutsideCode(raw: string, re: RegExp): RegExpMatchArray[] {
  const masked = stripCode(raw);
  const clear = (i: number) => masked[i] === raw[i];
  return [...raw.matchAll(re)].filter((m) => m.index !== undefined && clear(m.index) && clear(m.index + m[0].length - 1));
}

// Replace every match of `re` that sits outside code, and count them. `re` must carry the `g` flag.
export function replaceOutsideCode(
  raw: string,
  re: RegExp,
  replace: (m: RegExpMatchArray) => string,
): { text: string; count: number } {
  const hits = matchesOutsideCode(raw, re);
  let out = "";
  let last = 0;
  for (const m of hits) {
    out += raw.slice(last, m.index!) + replace(m);
    last = m.index! + m[0].length;
  }
  return { text: out + raw.slice(last), count: hits.length };
}

// Every wikilink in a note that is a real graph edge: outside code (a `[[ -f x ]]` Bash test or a
// documented example in a fence is not a link) and evidence links removed. The scan covers the WHOLE
// note including frontmatter, so `owner:`/`participants[]` wikilinks count as edges — they are the
// ownership edges the contract asks for.
export function graphLinks(raw: string, mounts: Iterable<string>): string[] {
  return matchesOutsideCode(raw, LINK)
    .map((m) => m[1].trim())
    .filter((l) => !isEvidenceTarget(l, mounts));
}

// SEAM LEAK: a link from a mount note that resolves only through the READING vault's own folders.
// It works here and dangles for everyone else who has the mount, so the note is broken on the other
// side. An unresolvable link is NOT a leak — it is already an orphan, and reporting it twice would
// make the same defect look like two.
export function isSeamLeak(target: string, mount: string, c: Corpus): boolean {
  const hits = resolveSlugs(target, c);
  if (!hits.length) return false;
  return !hits.some((s) => s === mount || s.startsWith(`${mount}/`));
}

// Does this link have a MOUNT-LOCAL answer? Either it already points inside the mount, or the mount
// holds a note at the same relative path (`[[people/sam]]` with `household/people/sam.md` present).
// This is what `vault move` requires of an entity link before it will let a note cross.
export function hasMountTwin(target: string, mount: string, c: Corpus): boolean {
  const t = cleanTarget(target);
  if (!t) return false;
  if (resolveSlugs(t, c).some((s) => s.startsWith(`${mount}/`))) return true;
  return resolveSlugs(`${mount}/${t}`, c).length > 0;
}

// The `source:` / `sources:` targets a note declares, unwrapped from their wikilinks. Read from the
// FRONTMATTER block only — a body line quoting the schema is prose, not provenance.
export function sourceTargets(fm: string): string[] {
  const out: string[] = [];
  const one = fm.match(/^source:\s*["']?(.+?)["']?\s*$/im)?.[1]?.trim();
  if (one) out.push(one);
  out.push(...fmList(fm, "sources"));
  return out.map((s) => cleanTarget(s.replace(/^\[\[/, "").replace(/\]\]$/, "")));
}

// DEAD SOURCE: a mount note pointing at the parent vault's `raw/`. The snapshot sits in one person's
// private tree, so the link is dead the moment anyone else opens the note. The fix is the mount's own
// `_raw/` locker, or provenance written as prose in the body.
export function deadSourceTargets(fm: string): string[] {
  return sourceTargets(fm).filter((t) => t.startsWith("raw/"));
}

// A note carrying an unresolved merge conflict. Scanned over the RAW text on purpose, not the
// code-stripped text: `<<<<<<<` at column 0 means git left the file in two minds, and a fence around
// it does not make it less broken. A note that merely documents conflict markers is the rare false
// positive, and it is obvious on sight — where a real conflict hiding inside a fence is not.
export function hasConflictMarkers(raw: string): boolean {
  return raw.split(/\r?\n/).some((l) => l.startsWith("<<<<<<<"));
}

// Is this mount actually checked out here? A mount declared in _folders.md but absent on disk is the
// normal state of a fresh clone, and writing into it would create a plain directory where a separate
// git repo belongs.
export function mountPresent(vault: string, mount: string): boolean {
  return existsSync(join(vault, mount));
}

// May a note land in this folder INSIDE the mount? The mount's own _folders.md is the authority, and
// a mount that declares nothing has nothing to violate, so it takes any folder the shipped defaults
// would produce. Both writers ask this — `vault move` about its destination, `ingest --apply` about
// the folder the note's type/domain maps to — and they must agree, or one command files a note the
// other would refuse.
export function mountAcceptsFolder(folder: string, mr: FolderRoles): boolean {
  if (!mr.declared) return true;
  return mr.entities.has(folder) || mr.domains.has(folder) || mr.forms.has(folder);
}

// The roster line a refusal prints: what the mount DID declare, so the fix is visible without opening
// the file. Written once so both refusals read the same on the day someone hits them.
export function mountFolderRoster(mount: string, mr: FolderRoles): string {
  const set = (s: Set<string>) => [...s].join(" ") || "(none)";
  return `${mount}/ entities: ${set(mr.entities)} · domains: ${set(mr.domains)} · forms: ${set(mr.forms)}`;
}

// Set or DROP a key in the leading frontmatter block, leaving every other byte alone. Both writers on
// this boundary need it, for the same reason: a key that meant something on this side means nothing on
// the other. `vault move` drops `domain:` (it names the SOURCE vault's life-area) and sets the
// destination's own; `ingest --apply` drops `mount:` (a routing instruction, spent the moment the note
// is filed) so the shared tree never carries a key the schema never defined.
export function setFrontmatterKey(text: string, key: string, value: string | null): string {
  const drop = new RegExp(`^${key}:`);
  return text.replace(/^(---\r?\n)([\s\S]*?)(\r?\n---)/, (_all, open: string, body: string, close: string) => {
    const nl = close.startsWith("\r\n") ? "\r\n" : "\n";
    const lines = body.split(/\r?\n/).filter((l) => !drop.test(l));
    if (value !== null) lines.push(`${key}: ${value}`);
    return open + lines.join(nl) + close;
  });
}

// --- the crash window a move opens ------------------------------------------------------------
// A move is a write, a delete and a link rewrite. Between the write and the delete the note exists
// TWICE, and the fork is exactly what the seam exists to prevent — so the move writes this marker
// into log.md before it deletes anything, and replaces it with the finished line at the end. A crash
// in the window therefore leaves a trace, and `check` reads it back as `move-fork`.
//
// The trace is the MARKER and not a name collision on purpose. A `household/people/sam` note beside a
// private `people/sam` is the state `hasMountTwin` looks for and the move's own refusal text asks the
// operator to create ("file the entity inside the mount first, a stub is enough"), so treating a
// shared basename as a fork would flag the encouraged case forever.
export const MOVE_IN_PROGRESS = "{move-in-progress}";

export function moveInProgressLine(day: string, from: string, to: string, mount: string): string {
  return `- ${day} moving [[${from}]] → [[${to}]] — sharing into ${mount}/ ${MOVE_IN_PROGRESS}`;
}

export function moveDoneLine(day: string, from: string, to: string, mount: string): string {
  return `- ${day} moved [[${from}]] → [[${to}]] — shared into ${mount}/`;
}

// The unfinished moves a log.md records: one entry per marker line still sitting there.
export function unfinishedMoves(log: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (!line.includes(MOVE_IN_PROGRESS)) continue;
    const m = line.match(/\[\[([^\]]+)\]\]\s*→\s*\[\[([^\]]+)\]\]/);
    if (m) out.push({ from: m[1]!.trim(), to: m[2]!.trim() });
  }
  return out;
}
