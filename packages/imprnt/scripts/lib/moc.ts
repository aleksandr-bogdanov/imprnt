// Map-of-content generator: build vault/index.md deterministically from every note's frontmatter
// `summary` (+ tags). Pure code, no LLM — a map-of-content is just a structured read over the corpus,
// exactly the kind of thing the READ side does for free. Grouped by folder (the human browse axis),
// entity → domain → form order. Falls back to the H1 title when `summary` is absent, so it never
// breaks on a note that predates the field.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export type NoteMeta = {
  path: string;
  folder: string; // top-level vault folder (people, health, ...) — the browse drawer
  slug: string; // folder/name, the linkable ID
  title: string; // H1
  summary: string; // frontmatter summary, else title
  type: string;
  tags: string[];
};

// Control files are anchored to the vault ROOT only - a real note filed at a nested path like
// work/index.md shares the basename of a control file but is genuine knowledge, so it must be collected
// and listed. We exclude a file only when its path relative to the vault root has no directory component
// and equals one of these basenames (depth 0). Mirrors the same anchoring in recall.ts so they agree.
const CONTROL = new Set(["index.md", "hot.md", "log.md", "_tags.md"]);
// Folder display order: entities, then domains, then forms, then anything user-defined.
const FOLDER_ORDER = [
  "people", "orgs", "holdings",
  "identity", "health", "finances", "work", "life", "projects",
  "events", "mistakes",
];

// Exported so check.ts can constrain its own field reads (domain:/source:) to the frontmatter block
// instead of the whole body - a body line quoting the schema must never satisfy a check.
export function frontmatter(raw: string): string {
  // Accept CRLF (`\r\n`) fences so Windows-authored notes parse frontmatter. Without `\r?` the closing
  // `---\r` line never matches and summary/tags fall through, dropping them from index.md. Mirrors recall.ts.
  return raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
}
// Unwrap quotes only when they wrap the WHOLE value symmetrically. Stripping each end independently
// corrupts a value that merely ends (or starts) in a quoted phrase: `..."the boss"` -> `..."the boss`.
function stripQuotes(v: string): string {
  const m = v.match(/^(["'])([\s\S]*)\1$/);
  return m ? m[2] : v;
}
function fmScalar(fm: string, key: string): string {
  // `.trim()` also drops a trailing `\r` left on a per-line value when the note uses CRLF endings.
  return stripQuotes((fm.match(new RegExp(`^${key}:\\s*(.+)$`, "im"))?.[1] ?? "").trim());
}
// Both plain-YAML list forms: inline `key: [a, b]` and the block form (what Obsidian's properties UI
// writes) - a bare `key:` followed by consecutive `- item` lines. Small deterministic parser, no YAML
// dep. Keep these semantics in sync with recall.ts so the two readers agree on the same note.
function fmList(fm: string, key: string): string[] {
  const lines = fm.split(/\r?\n/);
  const keyRe = new RegExp(`^${key}:\\s*(.*)$`, "i");
  for (const [i, line] of lines.entries()) {
    const m = line.match(keyRe);
    if (!m) continue;
    const rest = m[1].trim();
    if (rest.startsWith("[")) {
      const inner = rest.match(/^\[(.*)\]/)?.[1] ?? "";
      return inner.split(",").map((s) => stripQuotes(s.trim())).filter(Boolean);
    }
    if (rest !== "") return []; // a plain scalar is not a list
    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^\s*-\s+(.+?)\s*$/);
      if (!item) break; // the next key (or anything non-item) ends the block
      const v = stripQuotes(item[1]);
      if (v) items.push(v);
    }
    return items;
  }
  return [];
}

function walk(vault: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue; // dotfiles + _tags/_needs-review
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(vault, p));
    else if (entry.endsWith(".md")) {
      // A control basename counts only at the vault root - relative path with no directory separator.
      const rel = relative(vault, p);
      if (!rel.includes("/") && !rel.includes("\\") && CONTROL.has(rel)) continue;
      out.push(p);
    }
  }
  return out;
}

export function collectNotes(vault: string): NoteMeta[] {
  const notes: NoteMeta[] = [];
  for (const path of walk(vault, vault)) {
    const raw = readFileSync(path, "utf8");
    const fm = frontmatter(raw);
    const rel = relative(vault, path).split("\\").join("/");
    const folder = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : ".";
    const slug = rel.replace(/\.md$/, "");
    const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? slug;
    const summary = fmScalar(fm, "summary") || title;
    notes.push({ path, folder, slug, title, summary, type: fmScalar(fm, "type"), tags: fmList(fm, "tags") });
  }
  return notes;
}

function folderRank(f: string): number {
  const i = FOLDER_ORDER.indexOf(f);
  return i < 0 ? FOLDER_ORDER.length : i;
}

// Build index.md and write it. Returns counts for the caller to report.
export function generateIndex(vault: string): { count: number; folders: number } {
  const notes = collectNotes(vault);
  const byFolder = new Map<string, NoteMeta[]>();
  for (const n of notes) {
    if (!byFolder.has(n.folder)) byFolder.set(n.folder, []);
    byFolder.get(n.folder)!.push(n);
  }
  const folders = [...byFolder.keys()].sort((a, b) => folderRank(a) - folderRank(b) || a.localeCompare(b));

  const lines: string[] = [
    "---",
    "type: index",
    "---",
    "",
    "# Index",
    "",
    `> Generated by \`imprnt check\` — do not edit by hand. ${notes.length} notes across ${folders.length} folders.`,
    "",
  ];
  for (const f of folders) {
    const items = byFolder.get(f)!.sort((a, b) => a.slug.localeCompare(b.slug));
    lines.push(`## ${f}/  (${items.length})`, "");
    for (const n of items) {
      const tags = n.tags.length ? `  \`${n.tags.join("` `")}\`` : "";
      lines.push(`- [[${n.slug}]] — ${n.summary}${tags}`);
    }
    lines.push("");
  }
  writeFileSync(join(vault, "index.md"), lines.join("\n") + "\n");
  return { count: notes.length, folders: folders.length };
}
