#!/usr/bin/env bun
// imprnt retrieval eval — measure BM25 recall on imprnt's OWN task.
//
// The pitch is "BM25 over a well-tagged vault answers the questions you actually ask." This harness
// turns that design argument into a number. For each natural-language query it runs the real `recall`
// command, reads the ranked note paths, and checks where the gold answer note lands. It reports
// Recall@1/@5/@10 and MRR per corpus and overall.
//
// This is NOT LongMemEval or LoCoMo. Those score recall over auto-logged conversation dumps (thousands
// of raw turns). imprnt's task is different: retrieval from a small set of notes a person curated,
// typed, and tagged on the way in. The query is a plain sentence, the gold is the note that answers it.
//
// Run:  bun eval/run.ts            (all corpora in eval/queries/)
//       bun eval/run.ts --k 5      (set the top-k ceiling, default 10)
//       bun eval/run.ts --show     (print per-query hits/misses)
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const RECALL = join(REPO, "packages", "imprnt", "scripts", "recall.ts");
const QUERIES_DIR = join(HERE, "queries");

const args = process.argv.slice(2);
let K = 10;
let show = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--k") K = parseInt(args[++i] ?? "10", 10);
  else if (args[i] === "--show") show = true;
}

// One query row: the question and the set of note paths that answer it (any one in top-k is a hit).
type Row = { query: string; gold: string[] };
// A scored query: the 1-based rank of the FIRST gold note in the ranked list, or 0 if none in top-k.
type Scored = Row & { rank: number; top: string };

// Run the real recall command and return the ranked note paths, best first. recall prints
// "  [12.34] people/jonas-rivera.md" lines; we pull the path from each, in order.
function rankedPaths(query: string, vault: string): string[] {
  const r = Bun.spawnSync(["bun", RECALL, query, "--vault", vault, "--limit", String(K)], {
    cwd: REPO,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = new TextDecoder().decode(r.stdout);
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s+\[\d+(?:\.\d+)?\]\s+(.+)$/);
    if (m) paths.push(m[1].trim());
  }
  return paths;
}

function loadRows(tsv: string): Row[] {
  return readFileSync(tsv, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [query, gold] = l.split("\t");
      return { query, gold: gold.split(",").map((g) => g.trim()) };
    });
}

function scoreCorpus(rows: Row[], vault: string): Scored[] {
  return rows.map((row) => {
    const ranked = rankedPaths(row.query, vault);
    let rank = 0;
    for (let i = 0; i < ranked.length; i++) {
      if (row.gold.includes(ranked[i])) { rank = i + 1; break; }
    }
    return { ...row, rank, top: ranked[0] ?? "(no hits)" };
  });
}

// Recall@k = fraction of queries whose first gold note landed at rank <= k (and within the run's K).
function recallAt(scored: Scored[], k: number): number {
  const hit = scored.filter((s) => s.rank > 0 && s.rank <= k).length;
  return hit / scored.length;
}
// MRR = mean of 1/rank over queries (0 when no gold note appeared in top-K).
function mrr(scored: Scored[]): number {
  return scored.reduce((s, q) => s + (q.rank > 0 ? 1 / q.rank : 0), 0) / scored.length;
}
const pct = (x: number) => (x * 100).toFixed(1).padStart(5) + "%";

// Discover corpora: every queries/<name>.tsv pairs with examples/<name>/vault.
const corpora = readdirSync(QUERIES_DIR)
  .filter((f) => f.endsWith(".tsv"))
  .map((f) => {
    const name = basename(f, ".tsv");
    return { name, tsv: join(QUERIES_DIR, f), vault: join(REPO, "examples", name, "vault") };
  })
  .filter((c) => existsSync(c.vault));

const all: Scored[] = [];
console.log(`\nimprnt retrieval eval  —  BM25 over curated vaults, top-K=${K}\n`);

for (const c of corpora) {
  const rows = loadRows(c.tsv);
  const scored = scoreCorpus(rows, c.vault);
  all.push(...scored);
  console.log(`${c.name}  (${rows.length} queries, ${countNotes(c.vault)} notes)`);
  console.log(`  R@1 ${pct(recallAt(scored, 1))}   R@5 ${pct(recallAt(scored, 5))}   R@10 ${pct(recallAt(scored, 10))}   MRR ${mrr(scored).toFixed(3)}`);
  if (show) {
    for (const s of scored) {
      const mark = s.rank === 1 ? "  @1" : s.rank > 0 ? ` @${s.rank}` : "MISS";
      console.log(`    [${mark}] ${s.query}`);
      if (s.rank !== 1) console.log(`           gold ${s.gold.join(" | ")}  ·  top ${s.top}`);
    }
  }
  console.log("");
}

console.log("─".repeat(56));
console.log(`overall  (${all.length} queries)`);
console.log(`  R@1 ${pct(recallAt(all, 1))}   R@5 ${pct(recallAt(all, 5))}   R@10 ${pct(recallAt(all, 10))}   MRR ${mrr(all).toFixed(3)}\n`);

// Count content notes the way recall does: every .md under the vault minus the four root control files.
function countNotes(vault: string): number {
  const CONTROL = new Set(["index.md", "hot.md", "log.md", "_tags.md"]);
  let n = 0;
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name.startsWith("_")) continue;
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".md") && !(dir === vault && CONTROL.has(e.name))) n++;
    }
  };
  walk(vault);
  return n;
}
