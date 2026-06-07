#!/usr/bin/env bun
// imprint check [--vault DIR]
//
// The integrity "robot" — an EXPLICIT command you run, never a background hook. Deterministic, no LLM.
// Three checks + one regenerate, all pure reads over the corpus:
//   1. orphan [[links]]      — a wikilink whose target note doesn't exist
//   2. disconnected notes    — a domain/form note that links no entity at all (graph island)
//   3. untagged notes        — a note with no tags (findable by body/title only — the tag axis is empty)
//   4. uncovered snapshots   — a raw/ source no vault note points back to (the migration to-do ledger)
//   + regenerate index.md from every note's `summary` (deterministic map-of-content)
//
// check PRINTS its findings (the agent reads them); it does not block and never mutates notes.
// It writes two non-note control files: index.md (regenerated) and _tags.md (auto-grown — any new
// tag a note carries is synced into the vocabulary, no human gate; near-duplicate tags are flagged
// for a conscious synonym merge, never auto-merged).
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateIndex, collectNotes } from "./lib/moc.ts";
import { loadTags, normalize, appendTags } from "./lib/tags.ts";
import { loadManifest } from "./lib/manifest.ts";

const args = process.argv.slice(2);
let vault = process.env.IMPRINT_VAULT ?? "./vault";
let all = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--vault") {
    const v = args[++i];
    if (v === undefined) { console.error("--vault requires a directory argument"); process.exit(1); }
    vault = v;
  }
  else if (args[i] === "--all") all = true; // also run each plugins/*/check.ts (convention discovery)
}
if (!existsSync(vault)) { console.error(`no vault at ${vault} — run \`imprint init\` first`); process.exit(1); }

// Entity folders are link TARGETS — they may legitimately have few outgoing links, so they're exempt
// from the disconnected-note check. Everything else (domains + forms) should connect to the graph.
const ENTITY_FOLDERS = new Set(["people", "orgs", "holdings"]);
const DOMAIN_FOLDERS = new Set(["identity", "health", "finances", "work", "life", "projects"]);
const LINK = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

const notes = collectNotes(vault);
const allSlugs = new Set(notes.map((n) => n.slug));
const folderOf = new Map<string, string>(notes.map((n) => [n.slug, n.folder]));
const byBasename = new Map<string, string[]>();
for (const n of notes) {
  const base = n.slug.includes("/") ? n.slug.slice(n.slug.lastIndexOf("/") + 1) : n.slug;
  (byBasename.get(base) ?? byBasename.set(base, []).get(base)!).push(n.slug);
}

function resolves(target: string): boolean {
  const t = target.trim().replace(/^\.\//, "").replace(/\.md$/, "");
  if (!t) return false;
  if (t.includes("/")) return allSlugs.has(t) || existsSync(join(vault, `${t}.md`));
  return byBasename.has(t); // bare slug — resolvable if any folder holds it
}

// The folder(s) a link target resolves to. A slug link maps to its one note's folder; a bare slug
// can match several folders, so we return every folder that holds a note of that basename. A target
// that exists on disk but isn't a collected note (e.g. a deep path) yields no folder. Deterministic.
function targetFolders(target: string): string[] {
  const t = target.trim().replace(/^\.\//, "").replace(/\.md$/, "");
  if (!t) return [];
  if (t.includes("/")) { const f = folderOf.get(t); return f ? [f] : []; }
  return (byBasename.get(t) ?? []).map((s) => folderOf.get(s)).filter((f): f is string => !!f);
}

// True if a link target resolves to a note in an entity folder (people/orgs/holdings).
function linksEntity(target: string): boolean {
  return targetFolders(target).some((f) => ENTITY_FOLDERS.has(f));
}

// --- checks ---------------------------------------------------------------
const orphans: string[] = [];
const disconnected: string[] = [];
const domainIssues: string[] = [];
const untagged: string[] = [];
const referencedRaw = new Set<string>();

for (const n of notes) {
  const raw = readFileSync(n.path, "utf8");
  // `raw/...` links are intentional provenance into the evidence locker (the `source:` field), which
  // sits OUTSIDE the searchable vault — never count them as orphans, nor as graph links.
  const links = [...raw.matchAll(LINK)].map((m) => m[1].trim()).filter((l) => !l.startsWith("raw/"));
  for (const l of links) if (!resolves(l)) orphans.push(`  ${n.slug}  →  [[${l}]]`);
  // A domain/form note is disconnected unless at least ONE of its wikilinks resolves to an entity
  // note (people/orgs/holdings). A link to another domain/form note, or to raw/..., does not count.
  // Entity folders are exempt — an entity need not link an entity.
  if (!ENTITY_FOLDERS.has(n.folder) && !links.some(linksEntity)) disconnected.push(`  ${n.slug}`);

  // untagged: every note carries ≥1 tag (the topic/search axis). An empty `tags: []` is the exact
  // symptom that motivated the auto-growing vocabulary — coining is now free, so there's no excuse for
  // a blank. Flag it (non-blocking) so it can never silently ship findable-by-body-only again.
  if (n.tags.length === 0) untagged.push(`  ${n.slug}`);

  // self-describing domain: a note in a domain folder must carry `domain: <that folder>` so folder and
  // field can't drift. Entities/forms are self-described by `type` and carry no domain.
  const domain = raw.match(/^domain:\s*(.+)$/m)?.[1]?.trim() ?? "";
  if (DOMAIN_FOLDERS.has(n.folder) && domain !== n.folder) {
    domainIssues.push(`  ${n.slug}  — in ${n.folder}/ but domain: ${domain || "(missing)"}`);
  }

  // coverage: every raw path a note points back to (source: "[[raw/...]]" wikilink, or sources:[])
  const src = raw.match(/^source:\s*["']?(.+?)["']?\s*$/im)?.[1]?.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  if (src) referencedRaw.add(src.replace(/^\.\//, ""));
  // Greedy capture to the LAST bracket so wikilink entries (sources: ["[[raw/a]]", "[[raw/b]]"])
  // are not truncated at the first inner "]". Inline list form only (one line, no newline in the value).
  const srcs = raw.match(/^sources:\s*\[(.*)\]/im)?.[1] ?? "";
  for (const s of srcs.split(",").map((x) => x.trim().replace(/^["'\[]+|["'\]]+$/g, "")).filter(Boolean)) referencedRaw.add(s.replace(/^\.\//, ""));
}

// --- tag vocabulary sync + dedup audit ------------------------------------
// Auto-grow: collect every tag the notes carry (normalized through the synonym map), append any that
// the vocabulary doesn't already know. No human approval — a tag is a string the note already holds.
// Then a non-blocking audit flags near-duplicate tags (prefix / edit-distance-1) so they can be merged
// into a synonym consciously. We never auto-merge — picking the canonical is judgment, not arithmetic.
const hasTagsFile = existsSync(join(vault, "_tags.md"));
let addedTags: string[] = [];
const dupPairs: string[] = [];
if (hasTagsFile) {
  const vocab = loadTags(vault);
  const usedCanon = new Set<string>();
  for (const n of notes) for (const t of n.tags) { const c = normalize(vocab, t); if (c) usedCanon.add(c); }
  const newTags = [...usedCanon].filter((c) => !vocab.approved.has(c)).sort();
  addedTags = appendTags(vault, newTags);

  const lev = (a: string, b: string): number => {
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  const tagArr = [...new Set([...vocab.approved, ...addedTags])].sort();
  for (let i = 0; i < tagArr.length; i++) for (let j = i + 1; j < tagArr.length; j++) {
    const a = tagArr[i], b = tagArr[j];
    const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a;
    const prefixDup = short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3;
    const near = Math.abs(a.length - b.length) <= 1 && lev(a, b) <= 1;
    if (prefixDup || near) dupPairs.push(`  ${a} ~ ${b}`);
  }
}

// uncovered snapshots: raw entries in the manifest that no note references back
const manifest = loadManifest(vault);
const rawEntries = Object.values(manifest).map((e) => e.raw).filter(Boolean) as string[];
const norm = (p: string) => p.replace(/^\.\//, "").replace(/^.*\/raw\//, "raw/").replace(/\.md$/, "");
const refNorm = new Set([...referencedRaw].map(norm));
const uncovered = [...new Set(rawEntries.map(norm))].filter((r) => !refNorm.has(r)).sort();

// --- report ---------------------------------------------------------------
const cap = (xs: string[], n = 25) => xs.slice(0, n).concat(xs.length > n ? [`  … +${xs.length - n} more`] : []);

console.log(`imprint check — ${notes.length} notes in ${vault}\n`);

if (orphans.length) { console.log(`⚠ orphan links (${orphans.length}) — target note missing:`); console.log(cap(orphans).join("\n"), "\n"); }
else console.log("✓ no orphan links");

if (disconnected.length) { console.log(`⚠ disconnected notes (${disconnected.length}) — domain/form note links no entity:`); console.log(cap(disconnected).join("\n"), "\n"); }
else console.log("✓ every domain/form note links the graph");

if (domainIssues.length) { console.log(`⚠ domain mismatches (${domainIssues.length}) — folder ≠ domain: field:`); console.log(cap(domainIssues).join("\n"), "\n"); }
else console.log("✓ every domain note's folder matches its domain: field");

if (untagged.length) { console.log(`⚠ untagged notes (${untagged.length}) — no tags, findable by body/title only:`); console.log(cap(untagged).join("\n"), "\n"); }
else console.log("✓ every note carries at least one tag");

if (hasTagsFile) {
  if (addedTags.length) console.log(`↑ synced ${addedTags.length} new tag(s) into _tags.md: ${addedTags.join(", ")}`);
  else console.log("✓ tag vocabulary in sync");
  if (dupPairs.length) { console.log(`⚠ candidate duplicate tags (${dupPairs.length}) — add a synonym in _tags.md to merge:`); console.log(cap(dupPairs).join("\n"), "\n"); }
}

if (rawEntries.length) {
  if (uncovered.length) { console.log(`⚠ uncovered snapshots (${uncovered.length}/${new Set(rawEntries.map(norm)).size}) — raw source no note points back to:`); console.log(cap(uncovered).join("\n"), "\n"); }
  else console.log("✓ every raw snapshot has a derived note");
}

const { count, folders } = generateIndex(vault);
console.log(`↻ regenerated index.md — ${count} notes across ${folders} folders`);

const issues = orphans.length + disconnected.length + domainIssues.length + untagged.length + uncovered.length + dupPairs.length;
console.log(issues ? `\n${issues} thing(s) to look at above.` : `\nclean.`);
// check still PRINTS everything and never blocks or mutates a note — only the exit CODE reflects health,
// so `imprint check` is usable in CI and `&&` chains. Core issues alone make the process exit non-zero.
// With --all the final exit is the max of core issues and any plugin failure (computed below).

// --- plugin aggregation (--all only) --------------------------------------
// The ONE core↔plugin contact for integrity (the other is `ingest --apply`). Both discover by
// convention, never by import, never by naming a plugin. The FENCE that keeps this from becoming a
// "plugin API": core may provide read-only AGGREGATION here, never write/orchestration. Concretely we
// glob plugins/*/check.ts, run each as its own `bun` subprocess, READ THE EXIT CODE ONLY (0 = sound,
// non-zero = issue), and forward the plugin's stdout/stderr VERBATIM — we never parse what it prints.
// Core `check` exits non-zero when it has issues (bug-1 fix); --all exits non-zero when the core has
// issues OR any plugin failed (the max of both).
if (all) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pluginsDir = join(here, "..", "plugins");
  const checks: string[] = [];
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir)) {
      const p = join(pluginsDir, entry, "check.ts");
      if (statSync(join(pluginsDir, entry)).isDirectory() && existsSync(p)) checks.push(p);
    }
  }
  checks.sort();

  console.log(`\n— plugins (${checks.length}) —`);
  if (checks.length === 0) console.log("  (no plugins/*/check.ts found)");

  let failed = 0;
  for (const checkPath of checks) {
    const name = relative(pluginsDir, dirname(checkPath)).split("\\").join("/");
    // Inherit stdio: the plugin's stdout/stderr stream straight through, untouched. We read only `.exitCode`.
    const proc = Bun.spawnSync(["bun", checkPath], { stdout: "inherit", stderr: "inherit" });
    const ok = proc.exitCode === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? "✓" : "✗"} plugins/${name}/check.ts → exit ${proc.exitCode}`);
  }

  if (failed) console.log(`\n${failed} plugin check(s) failed.`);
  else if (checks.length) console.log(`\nall plugin checks passed.`);

  if (failed || issues) process.exit(1);
} else if (issues) {
  process.exit(1);
}
