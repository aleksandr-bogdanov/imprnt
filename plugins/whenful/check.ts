#!/usr/bin/env bun
// imprint · whenful plugin — integrity check.
//
//   bun plugins/whenful/check.ts        exits 0 if the plugin's data is sound, non-zero if not.
//
// This is the file the core's `imprint check --all` aggregator globs (plugins/*/check.ts). The core
// reads ONLY this script's exit code and forwards its stdout verbatim — it never parses the text. So we
// print a rich, human-readable diagnosis and let the exit code carry the pass/fail. No LLM, pure reads.
//
// Two integrity questions for this plugin's OWN data (contract: "is the data sound?"):
//   1. mirror staleness  — how old is the last sync? (a mirror older than the threshold is a soft fail)
//   2. orphan links      — a links.tsv row whose note_slug points at a vault note that doesn't exist
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", ".."); // plugins/whenful -> repo root
const vault = join(root, "vault");
const LINKS = join(here, "links.tsv");
const LAST_SYNC = join(here, "mirror", ".last-sync");

const STALE_DAYS = 7; // a mirror older than this is flagged (soft fail) — render-at-read wants fresh data

// --- read links.tsv (COPIED parser per the contract — plugins don't import core code) --------------
type Link = { taskId: string; noteSlug: string; step: string };
function readLinks(): Link[] {
  if (!existsSync(LINKS)) return [];
  const out: Link[] = [];
  for (const line of readFileSync(LINKS, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const [taskId, noteSlug, step] = line.split("\t");
    if (taskId && noteSlug) out.push({ taskId: taskId.trim(), noteSlug: noteSlug.trim(), step: (step ?? "").trim() });
  }
  return out;
}

// A note_slug (folder/slug) resolves if vault/<slug>.md exists. We never search raw/ — only the vault.
function noteExists(noteSlug: string): boolean {
  const clean = noteSlug.replace(/^\.\//, "").replace(/\.md$/, "");
  if (clean.includes("/")) return existsSync(join(vault, `${clean}.md`));
  // bare slug — accept a hit in any vault folder (mirrors core check's byBasename resolution)
  if (!existsSync(vault)) return false;
  for (const folder of readdirSync(vault)) {
    const fp = join(vault, folder);
    if (statSync(fp).isDirectory() && existsSync(join(fp, `${clean}.md`))) return true;
  }
  return false;
}

const links = readLinks();
const problems: string[] = [];

console.log(`whenful check — ${links.length} link(s) in links.tsv`);

// 1. mirror staleness
if (!existsSync(LAST_SYNC)) {
  if (links.length > 0) problems.push("mirror never synced — run `bun plugins/whenful/whenful.ts sync`");
  else console.log("  ✓ no links yet, nothing to mirror");
} else {
  const stamp = readFileSync(LAST_SYNC, "utf8").trim();
  const synced = Date.parse(stamp);
  if (Number.isNaN(synced)) {
    problems.push(`mirror/.last-sync is unparseable ("${stamp}") — re-run sync`);
  } else {
    const ageDays = (Date.now() - synced) / 86_400_000;
    if (ageDays > STALE_DAYS) problems.push(`mirror is ${ageDays.toFixed(1)} days stale (>${STALE_DAYS}) — run \`bun plugins/whenful/whenful.ts sync\``);
    else console.log(`  ✓ mirror synced ${ageDays.toFixed(1)} days ago`);
  }
}

// 2. orphan links — a note_slug that doesn't exist in the vault
const orphans = links.filter((l) => !noteExists(l.noteSlug));
if (orphans.length) {
  for (const o of orphans) problems.push(`orphan link: task ${o.taskId} -> [[${o.noteSlug}]] (no such vault note)`);
} else if (links.length) {
  console.log(`  ✓ every link's note exists in the vault`);
}

// --- verdict (exit code carries pass/fail; stdout carries the human diagnosis) ---------------------
if (problems.length) {
  console.log(`\n⚠ ${problems.length} issue(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("\nsound.");
process.exit(0);
