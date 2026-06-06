#!/usr/bin/env bun
// knowful check [--vault DIR]
//
// The integrity "robot" — an EXPLICIT command you run, never a background hook. Deterministic, no LLM.
// Three checks + one regenerate, all pure reads over the corpus:
//   1. orphan [[links]]      — a wikilink whose target note doesn't exist
//   2. disconnected notes    — a domain/form note that links no entity at all (graph island)
//   3. uncovered snapshots   — a raw/ source no vault note points back to (the migration to-do ledger)
//   + regenerate index.md from every note's `summary` (deterministic map-of-content)
//
// check PRINTS its findings (the agent reads them); it does not block and does not mutate notes.
// The only file it writes is index.md.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { generateIndex, collectNotes } from "./lib/moc.ts";
import { loadManifest } from "./lib/manifest.ts";

const args = process.argv.slice(2);
let vault = "./vault";
for (let i = 0; i < args.length; i++) if (args[i] === "--vault") vault = args[++i];
if (!existsSync(vault)) { console.error(`no vault at ${vault} — run \`knowful init\` first`); process.exit(1); }

// Entity folders are link TARGETS — they may legitimately have few outgoing links, so they're exempt
// from the disconnected-note check. Everything else (domains + forms) should connect to the graph.
const ENTITY_FOLDERS = new Set(["people", "orgs", "holdings"]);
const DOMAIN_FOLDERS = new Set(["identity", "health", "finances", "work", "life", "projects"]);
const LINK = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

const notes = collectNotes(vault);
const allSlugs = new Set(notes.map((n) => n.slug));
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

// --- checks ---------------------------------------------------------------
const orphans: string[] = [];
const disconnected: string[] = [];
const domainIssues: string[] = [];
const referencedRaw = new Set<string>();

for (const n of notes) {
  const raw = readFileSync(n.path, "utf8");
  // `raw/...` links are intentional provenance into the evidence locker (the `source:` field), which
  // sits OUTSIDE the searchable vault — never count them as orphans, nor as graph links.
  const links = [...raw.matchAll(LINK)].map((m) => m[1].trim()).filter((l) => !l.startsWith("raw/"));
  for (const l of links) if (!resolves(l)) orphans.push(`  ${n.slug}  →  [[${l}]]`);
  if (!ENTITY_FOLDERS.has(n.folder) && links.length === 0) disconnected.push(`  ${n.slug}`);

  // self-describing domain: a note in a domain folder must carry `domain: <that folder>` so folder and
  // field can't drift. Entities/forms are self-described by `type` and carry no domain.
  const domain = raw.match(/^domain:\s*(.+)$/m)?.[1]?.trim() ?? "";
  if (DOMAIN_FOLDERS.has(n.folder) && domain !== n.folder) {
    domainIssues.push(`  ${n.slug}  — in ${n.folder}/ but domain: ${domain || "(missing)"}`);
  }

  // coverage: every raw path a note points back to (source: "[[raw/...]]" wikilink, or sources:[])
  const src = raw.match(/^source:\s*["']?(.+?)["']?\s*$/im)?.[1]?.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  if (src) referencedRaw.add(src.replace(/^\.\//, ""));
  const srcs = raw.match(/^sources:\s*\[(.*?)\]/im)?.[1] ?? "";
  for (const s of srcs.split(",").map((x) => x.trim().replace(/^["'\[]+|["'\]]+$/g, "")).filter(Boolean)) referencedRaw.add(s.replace(/^\.\//, ""));
}

// uncovered snapshots: raw entries in the manifest that no note references back
const manifest = loadManifest(vault);
const rawEntries = Object.values(manifest).map((e) => e.raw).filter(Boolean) as string[];
const norm = (p: string) => p.replace(/^\.\//, "").replace(/^.*\/raw\//, "raw/").replace(/\.md$/, "");
const refNorm = new Set([...referencedRaw].map(norm));
const uncovered = [...new Set(rawEntries.map(norm))].filter((r) => !refNorm.has(r)).sort();

// --- report ---------------------------------------------------------------
const cap = (xs: string[], n = 25) => xs.slice(0, n).concat(xs.length > n ? [`  … +${xs.length - n} more`] : []);

console.log(`knowful check — ${notes.length} notes in ${vault}\n`);

if (orphans.length) { console.log(`⚠ orphan links (${orphans.length}) — target note missing:`); console.log(cap(orphans).join("\n"), "\n"); }
else console.log("✓ no orphan links");

if (disconnected.length) { console.log(`⚠ disconnected notes (${disconnected.length}) — domain/form note links no entity:`); console.log(cap(disconnected).join("\n"), "\n"); }
else console.log("✓ every domain/form note links the graph");

if (domainIssues.length) { console.log(`⚠ domain mismatches (${domainIssues.length}) — folder ≠ domain: field:`); console.log(cap(domainIssues).join("\n"), "\n"); }
else console.log("✓ every domain note's folder matches its domain: field");

if (rawEntries.length) {
  if (uncovered.length) { console.log(`⚠ uncovered snapshots (${uncovered.length}/${new Set(rawEntries.map(norm)).size}) — raw source no note points back to:`); console.log(cap(uncovered).join("\n"), "\n"); }
  else console.log("✓ every raw snapshot has a derived note");
}

const { count, folders } = generateIndex(vault);
console.log(`↻ regenerated index.md — ${count} notes across ${folders} folders`);

const issues = orphans.length + disconnected.length + domainIssues.length + uncovered.length;
console.log(issues ? `\n${issues} thing(s) to look at above.` : `\nclean.`);
