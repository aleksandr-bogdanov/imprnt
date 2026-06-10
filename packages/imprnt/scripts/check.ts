#!/usr/bin/env bun
// imprnt check [--vault DIR]
//
// The integrity "robot" — an EXPLICIT command you run, never a background hook. Deterministic, no LLM.
// Three checks + one regenerate, all pure reads over the corpus:
//   1. orphan [[links]]      — a wikilink whose target note doesn't exist
//   2. disconnected notes    — a domain/form note that links no entity at all (graph island)
//   3. untagged notes        — a note with no tags (findable by body/title only — the tag axis is empty)
//   4. uncovered snapshots   — a raw/ source no vault note points back to (the migration to-do ledger)
//   + regenerate index.md from every note's `summary` (deterministic map-of-content)
//
// check PRINTS its findings (the agent reads them) and mirrors them into vault/_needs-review.md
// inside a marker-fenced section it fully regenerates each run - stale findings drop off when fixed,
// the section disappears when clean, and lines ingest wrote outside the markers are never touched.
// `imprnt hot` surfaces that file, closing the contract's soft-fail loop. check does not block and
// never mutates notes. It writes only non-note control files: index.md (regenerated), _tags.md
// (auto-grown — any new tag a note carries is synced into the vocabulary, no human gate;
// near-duplicate tags are flagged for a conscious synonym merge, never auto-merged), and its own
// _needs-review.md section.
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, dirname } from "node:path";
import { projectRoot } from "./lib/roots.ts";
import { generateIndex, collectNotes, frontmatter, stripQuotes, stripCode } from "./lib/moc.ts";
import { loadTags, normalize, appendTags } from "./lib/tags.ts";
import { loadManifest } from "./lib/manifest.ts";

const args = process.argv.slice(2);
let vault = process.env.IMPRNT_VAULT ?? process.env.IMPRINT_VAULT ?? "./vault";
let all = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--vault") {
    const v = args[++i];
    if (v === undefined) { console.error("--vault requires a directory argument"); process.exit(1); }
    vault = v;
  }
  else if (args[i] === "--all") all = true; // also run each plugins/*/check.js (convention discovery)
}
if (!existsSync(vault)) { console.error(`no vault at ${vault} — run \`imprnt init\` first`); process.exit(1); }

// Entity folders are link TARGETS — they may legitimately have few outgoing links, so they're exempt
// from the disconnected-note check. Everything else (domains + forms) should connect to the graph.
const ENTITY_FOLDERS = new Set(["people", "orgs", "holdings"]);
// projects/ is self-describing by type (type:project mirrors the folder), like events/mistakes, so it
// carries no domain: field and is exempt from the domain-match check. It is NOT in DOMAIN_FOLDERS.
const DOMAIN_FOLDERS = new Set(["identity", "health", "finances", "work", "life"]);
const LINK = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

const notes = collectNotes(vault);
const allSlugs = new Set(notes.map((n) => n.slug));
const folderOf = new Map<string, string>(notes.map((n) => [n.slug, n.folder]));
const byBasename = new Map<string, string[]>();
for (const n of notes) {
  const base = n.slug.includes("/") ? n.slug.slice(n.slug.lastIndexOf("/") + 1) : n.slug;
  (byBasename.get(base) ?? byBasename.set(base, []).get(base)!).push(n.slug);
}

// Resolution is against the collected EXACT-CASE slug set only, no existsSync fallback. existsSync
// is case-insensitive on APFS, so a case-wrong [[People/Anna]] would pass here yet fail the
// entity-link check (contradictory diagnostics), and Linux would disagree with macOS. raw/ links are
// filtered out before this runs, so the "[[raw/...]] is never an orphan" contract is untouched.
function resolves(target: string): boolean {
  const t = target.trim().replace(/^\.\//, "").replace(/\.md$/, "");
  if (!t) return false;
  if (t.includes("/")) return allSlugs.has(t);
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
// `- [ ]` lines mirrored into _needs-review.md's check-owned section (same style ingest writes).
const review: string[] = [];
const referencedRaw = new Set<string>();

// Load the tag vocabulary once for the per-note untagged check below. loadTags returns an empty vocab
// when _tags.md is absent (the dedup/sync block later re-checks existence before it touches the file).
const tagVocab = loadTags(vault);
// A note is TAGGED only if at least one tag survives to a real searchable token, the same bar the tag
// sync uses: normalize() canonicalizes through the synonym map, and a usable token must carry a letter
// or digit. A tag of only hyphens/spaces/punctuation (`tags: ["-"]`, `tags: ["  "]`) kebabs to nothing,
// so it never syncs to _tags.md and recall can't find it - counting it as "tagged" let a search-invisible
// note pass the untagged check. Matching the kebab oracle exactly (verified against appendTags), without
// reimplementing kebab: normalize yields the canonical token, then we require a \p{L}/\p{N} in it.
const hasRealTag = (tags: string[]): boolean =>
  tags.some((t) => /[\p{L}\p{N}]/u.test(normalize(tagVocab, t)));

for (const n of notes) {
  const raw = readFileSync(n.path, "utf8");
  // Field reads (domain:/source:/sources:) are constrained to the FRONTMATTER block - a body line
  // quoting the schema (`domain: health` in prose) must never satisfy a check or claim coverage.
  const fm = frontmatter(raw);
  // Scan for wikilinks over the CODE-STRIPPED body so a `[[...]]` inside a fenced block or an inline
  // `code` span is not counted as a link. A developer's howto carries Bash test syntax (`[[ -f x ]]`)
  // or a documented `[[people/...]]` example in a fence - neither is a graph edge, so neither should be
  // an orphan nor satisfy the entity-link/disconnected check. stripCode preserves layout, so genuine
  // links OUTSIDE code are matched exactly as before. The same `links` array feeds BOTH the orphan scan
  // and the disconnected/entity-link check, keeping the two consistent.
  // `raw/...` links are intentional provenance into the evidence locker (the `source:` field), which
  // sits OUTSIDE the searchable vault — never count them as orphans, nor as graph links.
  const links = [...stripCode(raw).matchAll(LINK)].map((m) => m[1].trim()).filter((l) => !l.startsWith("raw/"));
  for (const l of links) if (!resolves(l)) {
    orphans.push(`  ${n.slug}  →  [[${l}]]`);
    review.push(`- [ ] orphan link [[${l}]] — from [[${n.slug}]], target note missing`);
  }
  // A domain/form note is disconnected unless at least ONE of its wikilinks resolves to an entity
  // note (people/orgs/holdings). A link to another domain/form note, or to raw/..., does not count.
  // Entity folders are exempt — an entity need not link an entity.
  if (!ENTITY_FOLDERS.has(n.folder) && !links.some(linksEntity)) {
    disconnected.push(`  ${n.slug}`);
    review.push(`- [ ] disconnected note [[${n.slug}]] — links no entity`);
  }

  // untagged: every note carries ≥1 REAL tag (the topic/search axis). An empty `tags: []` is the exact
  // symptom that motivated the auto-growing vocabulary — coining is now free, so there's no excuse for
  // a blank. A note tagged only with values that normalize to nothing (`tags: ["-"]`) is the same blank
  // in disguise: search-invisible, nothing syncs to _tags.md. Flag both (non-blocking) so neither can
  // silently ship findable-by-body-only again.
  if (!hasRealTag(n.tags)) {
    untagged.push(`  ${n.slug}`);
    review.push(`- [ ] untagged note [[${n.slug}]] — empty tags, findable by body/title only`);
  }

  // self-describing domain: a note in a domain folder must carry `domain: <that folder>` so folder and
  // field can't drift. Entities/forms are self-described by `type` and carry no domain. Read from the
  // frontmatter block (fm) only, and normalize the value the way the contract writes it: the same
  // double-quoting it mandates for source: (`domain: "health"`) and an optional trailing YAML comment
  // (`domain: health  # life-area`) are LEGAL and must compare equal to the folder, not flag a false
  // mismatch. We strip a trailing inline comment first (only when the value is unquoted - a `#` inside
  // quotes is data, not a comment), then unwrap the quotes via moc.ts's stripQuotes (same unwrap moc
  // applies to summary/type, so check and the index agree on the field's value).
  const domainRaw = (fm.match(/^domain:\s*(.+)$/m)?.[1] ?? "").trim();
  const domain = stripQuotes(/^["']/.test(domainRaw) ? domainRaw : domainRaw.replace(/\s+#.*$/, "").trim());
  if (DOMAIN_FOLDERS.has(n.folder) && domain !== n.folder) {
    domainIssues.push(`  ${n.slug}  — in ${n.folder}/ but domain: ${domain || "(missing)"}`);
    review.push(`- [ ] domain mismatch [[${n.slug}]] — in ${n.folder}/ but domain: ${domain || "(missing)"}`);
  }

  // coverage: every raw path a note points back to (source: "[[raw/...]]" wikilink, or sources:[])
  const src = fm.match(/^source:\s*["']?(.+?)["']?\s*$/im)?.[1]?.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
  if (src) referencedRaw.add(src.replace(/^\.\//, ""));
  // Greedy capture to the LAST bracket so wikilink entries (sources: ["[[raw/a]]", "[[raw/b]]"])
  // are not truncated at the first inner "]". Inline list form only (one line, no newline in the value).
  const srcs = fm.match(/^sources:\s*\[(.*)\]/im)?.[1] ?? "";
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
  // For a pair already known to be at edit-distance 1 (the `near` gate), true when the SINGLE edit is a
  // digit: a substitution where both differing chars are digits (gpt-4/gpt-5), or an insert/delete of a
  // digit (no current case, kept for completeness). Numbered siblings (q1/q2, fy2025/fy2026, phase-1/
  // phase-2) are intentional, not typos, so they are skipped. A LETTER edit (finance/finances adds 's',
  // identty/identity swaps a letter) is NOT digit-only and still flags. `short`/`long` are by length.
  const DIGIT = /[0-9]/;
  const digitOnlyEdit = (short: string, long: string): boolean => {
    if (short.length === long.length) {
      // Substitution: exactly one position differs (guaranteed by lev === 1 at equal length).
      const k = [...short].findIndex((c, i) => c !== long[i]);
      return k >= 0 && DIGIT.test(short[k]) && DIGIT.test(long[k]);
    }
    // Insert/delete: the extra char in `long` sits at the first divergence (or at the tail). It is the
    // single edit, so the pair is digit-only iff that inserted/deleted char is a digit.
    let k = 0;
    while (k < short.length && short[k] === long[k]) k++;
    return DIGIT.test(long[k]);
  };
  const tagArr = [...new Set([...vocab.approved, ...addedTags])].sort();
  // The audit flags two relations and BOTH need the two tags' lengths to be close:
  //   prefixDup: one is a >=4-char prefix of the other, gap <= 3  -> abs(lenA - lenB) <= 3
  //   near:      edit-distance 1, abs(lenA - lenB) <= 1            -> abs(lenA - lenB) <= 1
  // So a pair with abs(lenA - lenB) > 3 can NEVER be flagged. The old loop still ran normalize() + a
  // fresh-allocating Levenshtein DP on EVERY pair before learning that (O(n^2) with an expensive body;
  // measured ~3.5s at 1000 tags, ~52s at 5000). We bucket tags by length and, for each tag, only test
  // the tags in length buckets within 3, so the costly checks touch only viable pairs. The flagged SET
  // and its (i < j over sorted tagArr) order are identical to the old loop - only dead pairs are skipped.
  const byLen = new Map<number, number[]>();
  for (let i = 0; i < tagArr.length; i++) (byLen.get(tagArr[i].length) ?? byLen.set(tagArr[i].length, []).get(tagArr[i].length)!).push(i);
  for (let i = 0; i < tagArr.length; i++) {
    const a = tagArr[i];
    // Candidate partners j > i drawn only from length buckets [len(a) - 3 .. len(a) + 3], merged back
    // into ascending j order so the emitted pairs match the old i < j iteration exactly.
    const cand: number[] = [];
    for (let L = a.length - 3; L <= a.length + 3; L++) {
      const bucket = byLen.get(L);
      if (!bucket) continue;
      for (const j of bucket) if (j > i) cand.push(j);
    }
    cand.sort((x, y) => x - y);
    for (const j of cand) {
      const b = tagArr[j];
      // A pair the user already merged exactly as the message instructs (a synonym entry in either
      // direction, or both mapping to the same canonical) is resolved - re-flagging it forever would
      // make the audit a permanent exit-1. Still flag-only for the rest: never auto-merge.
      if (normalize(vocab, a) === normalize(vocab, b)) continue;
      const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a;
      const prefixDup = short.length >= 4 && long.startsWith(short) && long.length - short.length <= 3;
      // near requires the shorter tag be >= 4 chars: short tags (q1, v1, ios, is) collide at
      // edit-distance 1 by coincidence, almost never as typos of each other. And a pair whose single
      // edit is a digit (gpt-4/gpt-5, fy2025/fy2026, phase-1/phase-2) is a numbered sibling, not a
      // typo, so it is skipped too. shoe/shoes (4/5) and finance/finances (7/8) still flag.
      const near = short.length >= 4 && Math.abs(a.length - b.length) <= 1 && lev(a, b) <= 1 && !digitOnlyEdit(short, long);
      if (prefixDup || near) dupPairs.push(`  ${a} ~ ${b}`);
    }
  }
}

// uncovered snapshots: raw entries in the manifest that no note references back
const manifest = loadManifest(vault);
const rawEntries = Object.values(manifest).map((e) => e.raw).filter(Boolean) as string[];
const norm = (p: string) => p.replace(/^\.\//, "").replace(/^.*\/raw\//, "raw/").replace(/\.md$/, "");
const refNorm = new Set([...referencedRaw].map(norm));
const uncovered = [...new Set(rawEntries.map(norm))].filter((r) => !refNorm.has(r)).sort();
for (const r of uncovered) review.push(`- [ ] unclassified snapshot \`${r}\` — no vault note points back`);

// --- needs-review routing ---------------------------------------------------
// The contract's soft-fail net (CLAUDE.md, "The ingest pass" step 4): check's findings land in the
// same vault/_needs-review.md ingest appends to, so `imprnt hot` surfaces them. check OWNS the one
// marker-fenced section below and fully REGENERATES it each run: stale findings disappear when fixed,
// the whole section is removed when clean, and anything outside the markers (ingest's lines) is never
// touched. Byte-idempotent: two consecutive runs leave the file identical.
const REVIEW_BEGIN = "<!-- imprnt-check:begin (regenerated by `imprnt check` - do not edit between the markers) -->";
const REVIEW_END = "<!-- imprnt-check:end -->";

function syncNeedsReview(lines: string[]): "written" | "cleared" | "none" {
  const p = join(vault, "_needs-review.md");
  const exists = existsSync(p);
  if (!exists && lines.length === 0) return "none"; // clean + absent: never create the file
  // Absent but dirty: create with the same header flagNeedsReview (lib/resolve.ts) writes.
  const prev = exists ? readFileSync(p, "utf8") : "---\ntype: needs-review\n---\n\n# Needs review\n\n";
  // Pair the markers by POSITION: the END must come AFTER the BEGIN. A bare indexOf(END) over the whole
  // file matches the wrong end - an END string quoted in prose ABOVE the section makes e < b, so the old
  // code fell to the append branch and grew an UNBOUNDED run of duplicate sections every run. We search
  // for END only PAST the begin marker, so a quote anywhere before the section can never mispair.
  const b = prev.indexOf(REVIEW_BEGIN);
  const e = b !== -1 ? prev.indexOf(REVIEW_END, b + REVIEW_BEGIN.length) : -1;
  const section = `${REVIEW_BEGIN}\n${lines.join("\n")}\n${REVIEW_END}\n`;
  let next: string;
  if (b !== -1) {
    // `before` (everything above the begin marker) is always preserved verbatim - ingest/user lines and
    // any prose live there in order. The fresh section (if any) replaces the old one in place.
    const before = prev.slice(0, b);
    let after: string;
    if (e !== -1) {
      // Well-formed begin..end. Drop the content strictly between (check's stale findings); keep the tail
      // below END. The newline the previous write left after END belongs to the section, so strip it -
      // the new section brings its own.
      after = prev.slice(e + REVIEW_END.length).replace(/^\n/, "");
    } else {
      // Orphan begin: the user hand-deleted the END, and ingest's appendFileSync (it always appends at
      // EOF) may have dropped a soft-fail line BELOW the orphaned begin - the only record ingest failed.
      // We cannot tell that ingest line from a stale finding by shape, so we never eat it: everything
      // below the orphaned begin LINE is preserved as outside content, and only the dead begin marker is
      // removed. The fresh section is rewritten above it, so the next run sees a well-formed pair and is
      // byte-idempotent. We never append a second begin, so the duplicate-section trap can't form.
      after = prev.slice(b + REVIEW_BEGIN.length).replace(/^\n/, "");
    }
    next = before + (lines.length ? section : "") + after;
  } else {
    if (lines.length === 0) return "none";
    next = (prev.endsWith("\n") ? prev : prev + "\n") + section;
  }
  if (next !== prev || !exists) writeFileSync(p, next);
  return lines.length ? "written" : "cleared";
}

// --- report ---------------------------------------------------------------
const cap = (xs: string[], n = 25) => xs.slice(0, n).concat(xs.length > n ? [`  … +${xs.length - n} more`] : []);

console.log(`imprnt check — ${notes.length} notes in ${vault}\n`);

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

const synced = syncNeedsReview(review);
if (synced === "written") console.log(`↻ ${review.length} finding(s) → _needs-review.md (run \`imprnt hot\` to see them)`);
else if (synced === "cleared") console.log("↻ cleared resolved findings from _needs-review.md");

const issues = orphans.length + disconnected.length + domainIssues.length + untagged.length + uncovered.length + dupPairs.length;
console.log(issues ? `\n${issues} thing(s) to look at above.` : `\nclean.`);
// check still PRINTS everything and never blocks or mutates a note — only the exit CODE reflects health,
// so `imprnt check` is usable in CI and `&&` chains. Core issues alone make the process exit non-zero.
// With --all the final exit is the max of core issues and any plugin failure (computed below).

// --- plugin aggregation (--all only) --------------------------------------
// The ONE core↔plugin contact for integrity (the other is `ingest --apply`). Both discover by
// convention, never by import, never by naming a plugin. The FENCE that keeps this from becoming a
// "plugin API": core may provide read-only AGGREGATION here, never write/orchestration. Concretely we
// glob plugins/*/check.js, run each as its own `node` subprocess, READ THE EXIT CODE ONLY (0 = sound,
// non-zero = issue), and forward the plugin's stdout/stderr VERBATIM — we never parse what it prints.
// Core `check` exits non-zero when it has issues (bug-1 fix); --all exits non-zero when the core has
// issues OR any plugin failed (the max of both).
if (all) {
  // Glob the user's PROJECT plugins/, where `plugin add` copies installed plugins (not the package).
  const pluginsDir = join(projectRoot(), "plugins");
  const checks: string[] = [];
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir)) {
      // Tolerate per-entry: a broken symlink (or any unstat-able entry) must not kill the whole
      // aggregation - skip the dead entry and run the remaining plugin checks.
      let isDir = false;
      try { isDir = statSync(join(pluginsDir, entry)).isDirectory(); } catch { continue; }
      const p = join(pluginsDir, entry, "check.js");
      if (isDir && existsSync(p)) checks.push(p);
    }
  }
  checks.sort();

  console.log(`\n— plugins (${checks.length}) —`);
  if (checks.length === 0) console.log("  (no plugins/*/check.js found)");

  let failed = 0;
  for (const checkPath of checks) {
    const name = relative(pluginsDir, dirname(checkPath)).split("\\").join("/");
    // Run the plugin's built check.js with node, stdio inherited so its output streams through
    // verbatim. We read ONLY the exit code (process.execPath = the node binary running us).
    const proc = spawnSync(process.execPath, [checkPath], { stdio: "inherit" });
    const code = proc.status ?? 1;
    const ok = code === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? "✓" : "✗"} plugins/${name}/check.js → exit ${code}`);
  }

  if (failed) console.log(`\n${failed} plugin check(s) failed.`);
  else if (checks.length) console.log(`\nall plugin checks passed.`);

  if (failed || issues) process.exit(1);
} else if (issues) {
  process.exit(1);
}
