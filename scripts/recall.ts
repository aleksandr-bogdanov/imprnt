#!/usr/bin/env bun
// knowful recall "<query>" [--vault DIR]
//
// Tiered grep over the vault. Deterministic, no MCP, no embeddings.
// Tier 1: title (# heading) + filename. Tier 2: frontmatter tags. Tier 3: body.
// Ranked title>tags>body so the agent can stop reading early.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
let vault = "./vault";
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--vault") vault = args[++i];
  else positional.push(args[i]);
}
const query = positional.join(" ").trim();
if (!query) {
  console.error('usage: knowful recall "<query>" [--vault DIR]');
  process.exit(1);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".md")) out.push(p);
  }
  return out;
}

const terms = query.toLowerCase().split(/\s+/);
const matchesAll = (hay: string) => terms.every((t) => hay.includes(t));
const matchesAny = (hay: string) => terms.some((t) => hay.includes(t));

type Hit = { path: string; score: number; where: string; snippet: string };
const hits: Hit[] = [];

let files: string[] = [];
try { files = walk(vault); } catch { console.error(`no vault at ${vault} — run \`knowful init\` first`); process.exit(1); }

for (const path of files) {
  const raw = readFileSync(path, "utf8");
  const lower = raw.toLowerCase();
  const titleLine = (raw.match(/^#\s+(.+)$/m)?.[1] ?? "").toLowerCase();
  const fm = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const tagLine = (fm.match(/tags:\s*\[(.*?)\]/i)?.[1] ?? "").toLowerCase();
  const fileName = path.toLowerCase();

  let score = 0;
  let where = "";
  if (matchesAll(titleLine) || matchesAll(fileName)) { score += 3; where = "title"; }
  if (matchesAny(tagLine)) { score += 2; where = where || "tags"; }
  if (matchesAll(lower)) { score += 1; where = where || "body"; }
  if (score === 0) continue;

  // snippet: first body line containing any term
  const bodyLines = raw.split(/\r?\n/);
  const snipLine = bodyLines.find((l) => matchesAny(l.toLowerCase()) && !l.startsWith("---")) ?? "";
  hits.push({ path: relative(vault, path), score, where, snippet: snipLine.trim().slice(0, 120) });
}

hits.sort((a, b) => b.score - a.score);
if (!hits.length) { console.log(`no matches for "${query}" in ${vault}`); process.exit(0); }

console.log(`recall "${query}" — ${hits.length} match(es), ranked:\n`);
for (const h of hits) {
  console.log(`  [${h.score}] ${h.path}  (${h.where})`);
  if (h.snippet) console.log(`        ${h.snippet}`);
}
