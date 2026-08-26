// Freshness check for the competitor dossiers. Diffs each dossier's claimed
// numbers (watched.tsv) against the GitHub API and flags what needs a human
// re-check. Report-only: it never edits a dossier, it names the stale ones.
// Exit 1 when anything is flagged, 0 when quiet. No dependencies, node >= 20.
//
//   node site/docs/competitors/freshness.mjs
//
// Flags per repo: archived, renamed, stars drifted > 25%, a release newer than
// the dossier's check date, no push for 90 days (the Reor-class dormancy sign).
// Plus one search for NEW entrants: big ai-assistant repos created in the last
// 180 days that no dossier covers - the query that would have caught OpenClaw
// and Hermes months before a human did.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HEADERS = { "User-Agent": "imprnt-freshness", Accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) HEADERS.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const rows = readFileSync(join(HERE, "watched.tsv"), "utf8")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map((l) => {
    const [file, repo, stars, release, checked] = l.split("\t").map((s) => s.trim());
    return { file, repo, stars: Number(stars), release, checked };
  });

const api = async (path) => {
  const res = await fetch(`https://api.github.com${path}`, { headers: HEADERS });
  if (res.status === 404) return null;
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    console.error(
      "GitHub API rate limit exhausted. Set GITHUB_TOKEN (CI provides it; locally: GITHUB_TOKEN=$(gh auth token)).",
    );
    process.exit(2);
  }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};

let flags = 0;
const flag = (msg) => {
  flags++;
  console.log(`  FLAG ${msg}`);
};

for (const r of rows) {
  if (r.repo === "-") {
    console.log(`${r.file}: skipped (not a GitHub repo)`);
    continue;
  }
  const meta = await api(`/repos/${r.repo}`);
  if (!meta) {
    flag(`${r.file}: ${r.repo} returned 404 - deleted, private, or renamed without a redirect`);
    continue;
  }
  const latest = await api(`/repos/${r.repo}/releases/latest`);
  const stars = meta.stargazers_count;
  const pushedDays = Math.floor((Date.now() - Date.parse(meta.pushed_at)) / 86400000);
  console.log(
    `${r.file}: ${meta.full_name} stars ${stars} (claimed ${r.stars}), ` +
      `latest ${latest ? `${latest.tag_name} ${latest.published_at.slice(0, 10)}` : "no releases"} ` +
      `(claimed ${r.release}), pushed ${pushedDays}d ago`,
  );
  if (meta.archived) flag(`${r.file}: ${r.repo} is ARCHIVED`);
  if (meta.full_name.toLowerCase() !== r.repo.toLowerCase())
    flag(`${r.file}: renamed ${r.repo} -> ${meta.full_name}`);
  if (r.stars && Math.abs(stars - r.stars) / r.stars > 0.25)
    flag(`${r.file}: stars drifted ${r.stars} -> ${stars} (> 25%)`);
  if (latest && latest.published_at.slice(0, 10) > r.checked)
    flag(`${r.file}: release ${latest.tag_name} (${latest.published_at.slice(0, 10)}) is newer than the ${r.checked} check`);
  if (pushedDays > 90) flag(`${r.file}: no push for ${pushedDays} days - dormancy check`);
}

// New entrants: the discovery approximation. One query, deliberately crude.
const since = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
const known = new Set(rows.map((r) => r.repo.toLowerCase()));
const search = await api(
  `/search/repositories?q=${encodeURIComponent(`topic:ai-assistant stars:>20000 created:>${since}`)}&per_page=20`,
);
for (const hit of search?.items ?? []) {
  if (!known.has(hit.full_name.toLowerCase()))
    flag(`NEW ENTRANT: ${hit.full_name} (${hit.stargazers_count} stars, created ${hit.created_at.slice(0, 10)}) - "${(hit.description ?? "").slice(0, 80)}"`);
}

console.log(flags ? `\n${flags} flag(s) - the named dossiers need a human re-check.` : "\nquiet - dossiers match reality.");
process.exit(flags ? 1 : 0);
