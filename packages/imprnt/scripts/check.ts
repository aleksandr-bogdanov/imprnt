#!/usr/bin/env bun
// imprnt check [--vault DIR]
//
// The integrity "robot" — an EXPLICIT command you run, never a background hook. Deterministic, no LLM.
// Nine checks + one regenerate, all pure reads (the corpus, plus a read-only peek at the host memory):
//   1. orphan [[links]]      — a wikilink whose target note doesn't exist
//   2. disconnected notes    — a domain/form note that links no entity at all (graph island)
//   3. untagged notes        — a note with no tags (findable by body/title only — the tag axis is empty)
//   4. uncovered snapshots   — a raw/ source no vault note points back to (the migration to-do ledger)
//   5. host auto-memory      — a non-empty Claude MEMORY.md store in ANY project (a second always-on store recall can't see)
//   6. seam-leak             — a mount note whose link resolves only through THIS vault's private folders
//   7. seam-dead-source      — a mount note pointing at this vault's private raw/ (dead across the seam)
//   8. conflict markers      — a note holding a `<<<<<<<` line git left behind
//   9. move-fork             — a `vault move` that never finished, so one note may exist twice
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
import { join, relative, basename } from "node:path";
import { homedir } from "node:os";
import { projectRoot } from "./lib/roots.ts";
import { pluginScript } from "./lib/plugins.ts";
import { generateIndex, collectNotes, frontmatter, stripQuotes } from "./lib/moc.ts";
import { loadFolders, type FolderRoles } from "./lib/folders.ts";
import { corpusOf, resolveSlugs, mountOf, innerFolder, graphLinks, isSeamLeak, deadSourceTargets, hasConflictMarkers, sourceTargets, unfinishedMoves } from "./lib/seam.ts";
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
  else if (args[i] === "--all") all = true; // also run each plugins/*/check.js or check.mjs (convention discovery)
}
if (!existsSync(vault)) { console.error(`no vault at ${vault} — run \`imprnt init\` first`); process.exit(1); }

// Folder roles come from the VAULT now, not from this file. A vault with a folder the shipped
// defaults never heard of used to get every note in it flagged forever, because `folder` is the
// first path segment: the folder was neither an entity (exempt) nor a domain (checked), so its
// notes landed in _needs-review with nothing the owner could do. Permanent noise in the one file
// that means "look here" is worse than no check. No _folders.md = the shipped defaults, which are
// byte-for-byte the sets this file used to hardcode.
const roles = loadFolders(vault);
// Entity folders are link TARGETS — they may legitimately have few outgoing links, so they're exempt
// from the disconnected-note check. Everything else (domains + forms) should connect to the graph.
const ENTITY_FOLDERS = roles.entities;
// projects/ is self-describing by type (type:project mirrors the folder), like events/mistakes, so it
// carries no domain: field and is exempt from the domain-match check. It is NOT in DOMAIN_FOLDERS.
const DOMAIN_FOLDERS = roles.domains;
// A MOUNT is a self-contained tree maintained elsewhere - a shared repo checked out inside vault/,
// an imported corpus. Its notes are complete on their own and are not part of THIS vault's entity
// graph, so demanding they link one asks them to reach across the boundary they exist to respect.
const MOUNT_FOLDERS = roles.mounts;

// A mount carries its OWN _folders.md, and check applies those roles SCOPED TO THE MOUNT: a note in
// household/finances/ is checked against the mount's declaration, not this vault's. Loaded lazily,
// once per mount.
//
// A mount that declares NOTHING is exempt from the ROLE checks only - the folder-versus-field ones,
// which need a declaration to compare against. That is the promise folders.ts was written on: an
// upgrade never hands an existing vault a finding about rules nobody wrote down. The SEAM findings
// below (seam-leak, seam-dead-source, conflict-markers) fire on every mount, declared or not: they
// read the boundary itself, which exists the moment a folder is named a mount.
const mountRoleCache = new Map<string, FolderRoles>();
function mountRoles(mount: string): FolderRoles {
  let r = mountRoleCache.get(mount);
  if (!r) { r = loadFolders(join(vault, mount)); mountRoleCache.set(mount, r); }
  return r;
}

const notes = collectNotes(vault);
// Resolution is against the collected EXACT-CASE slug set only, no existsSync fallback. existsSync
// is case-insensitive on APFS, so a case-wrong [[People/Anna]] would pass here yet fail the
// entity-link check (contradictory diagnostics), and Linux would disagree with macOS. Evidence links
// (raw/, and a mount's own _raw/) are filtered out before this runs, so the "never an orphan"
// contract for a snapshot link is untouched. The corpus + resolver live in lib/seam.ts because
// `vault move` asks the SAME questions before a note crosses that check asks after.
const corpus = corpusOf(notes);
const folderOf = new Map<string, string>(notes.map((n) => [n.slug, n.folder]));
const resolves = (target: string): boolean => resolveSlugs(target, corpus).length > 0;

// The folder(s) a link target resolves to. A slug link maps to its one note's folder; a bare slug
// can match several folders, so we return every folder that holds a note of that basename. A target
// that exists on disk but isn't a collected note (e.g. a deep path) yields no folder. Deterministic.
function targetFolders(target: string): string[] {
  return resolveSlugs(target, corpus).map((s) => folderOf.get(s)).filter((f): f is string => !!f);
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
// The seam findings. Both are about a MOUNT note, and both are reported HERE, in the vault doing the
// checking - the reader's side. That is deliberate on two counts: the reader is the one who can act
// (the link resolves in their private tree, so only they can see what it points at), and _needs-review.md
// sits in the private vault, never in the shared tree, so naming a private slug in a finding never
// writes that slug where the other person can read it.
const seamLeaks: string[] = [];
const seamDeadSources: string[] = [];
const conflicted: string[] = [];
const moveForks: string[] = [];
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
  const links = graphLinks(raw, MOUNT_FOLDERS);
  for (const l of links) if (!resolves(l)) {
    orphans.push(`  ${n.slug}  →  [[${l}]]`);
    review.push(`- [ ] orphan link [[${l}]] — from [[${n.slug}]], target note missing`);
  }
  // A domain/form note is disconnected unless at least ONE of its wikilinks resolves to an entity
  // note (people/orgs/holdings). A link to another domain/form note, or to raw/..., does not count.
  // Entity folders are exempt — an entity need not link an entity. Mounts are exempt for a
  // different reason: the tree is complete on its own and its graph lives on the other side.
  if (!ENTITY_FOLDERS.has(n.folder) && !MOUNT_FOLDERS.has(n.folder) && !links.some(linksEntity)) {
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

  // --- the seam: a note living inside a MOUNT -------------------------------------------------
  // Everything below asks one question in three ways: is this note complete INSIDE the mount? It has
  // to be, because the other person's vault holds the mount and nothing else of yours.
  const mount = mountOf(n.slug, MOUNT_FOLDERS);
  if (mount) {
    const mr = mountRoles(mount);
    const inner = innerFolder(n.slug, mount);
    // Mount-scoped domain match: the same folder-vs-field invariant this vault applies to its own
    // life-areas, applied INSIDE the mount against the mount's own declaration. This is a ROLE check,
    // so it runs only when the mount declares roles — there is nothing to violate in a set nobody
    // wrote down, and an upgrade must not invent one. The three seam findings below are a different
    // kind and run either way.
    if (mr.declared && mr.domains.has(inner) && domain !== inner) {
      domainIssues.push(`  ${n.slug}  — in ${mount}/${inner}/ but domain: ${domain || "(missing)"}`);
      review.push(`- [ ] domain mismatch [[${n.slug}]] — in ${mount}/${inner}/ but domain: ${domain || "(missing)"} (${mount}/_folders.md declares ${inner} a domain)`);
    }
    // seam-leak: the link works HERE and dangles for everyone else who has this mount. ONE finding per
    // (note, target): a note that names the same entity three times is one defect with one fix, and
    // reporting it three times makes _needs-review.md read like three separate broken links.
    for (const l of new Set(links)) if (isSeamLeak(l, mount, corpus)) {
      seamLeaks.push(`  ${n.slug}  →  [[${l}]]`);
      review.push(`- [ ] seam-leak [[${n.slug}]] → [[${l}]] — resolves only in this vault, so the note is broken for everyone else reading ${mount}/; re-point it at a ${mount}/ note or drop the link`);
    }
    // seam-dead-source: the snapshot sits in YOUR private raw/, so the link is dead the moment
    // anyone else opens the note. The mount has its own locker for exactly this.
    for (const t of deadSourceTargets(fm)) {
      seamDeadSources.push(`  ${n.slug}  —  source: [[${t}]]`);
      review.push(`- [ ] seam-dead-source [[${n.slug}]] — source: "[[${t}]]" points into this vault's private raw/, dead across the seam; move the evidence to ${mount}/_raw/ or record the provenance in prose`);
    }
  }

  // conflict markers: git abandoned a rebase mid-note and left both versions in the file. Nothing
  // downstream reads a note like this correctly, so it is worth its own line rather than a mention.
  if (hasConflictMarkers(raw)) {
    conflicted.push(`  ${n.slug}`);
    review.push(`- [ ] conflict markers in [[${n.slug}]] — an unresolved \`<<<<<<<\` merge conflict is sitting in the note`);
  }

  // coverage: every raw path a note points back to, singular `source:` and the `sources:` list alike,
  // read through seam.ts's sourceTargets. That is the SAME parse `seam-dead-source` and `vault move`
  // use, so a note whose provenance one of them can see is never invisible to the other - a second
  // regex here is how the coverage ledger and the seam checks drift into disagreeing about the same
  // field. It covers both list forms (inline `sources: [a, b]` and the block form Obsidian's
  // properties UI writes), unwraps the [[...]], and drops a `./` prefix or `.md` suffix, which is what
  // the coverage comparison below normalizes to anyway.
  for (const t of sourceTargets(fm)) referencedRaw.add(t);
}

// --- move-fork: a seam crossing that never finished -------------------------
// `imprnt vault move` writes the destination, records the move as in progress in log.md, deletes the
// source, then finalises the record. A crash in that window leaves the note in TWO places - the exact
// fork the seam exists to prevent - and the only thing that can say so afterwards is the marker the
// move left behind. So check reads it back. log.md is a control file, never a note, so this is its own
// small read rather than part of the corpus loop.
//
// Keyed on the MARKER, never on a name collision: `household/people/sam` sitting beside a private
// `people/sam` is the twin the move's own refusal asks the operator to create ("file the entity inside
// the mount first, a stub is enough"), so flagging a shared basename would condemn the encouraged case
// forever.
const logPath = join(vault, "log.md");
if (existsSync(logPath)) {
  for (const mv of unfinishedMoves(readFileSync(logPath, "utf8"))) {
    const both = existsSync(join(vault, `${mv.from}.md`)) && existsSync(join(vault, `${mv.to}.md`));
    const hint = both
      ? `both copies are on disk — read the two, keep [[${mv.to}]], delete ${mv.from}.md`
      : `the source is already gone, so the move finished — clear the marker line from log.md`;
    moveForks.push(`  ${mv.from}  →  ${mv.to}${both ? "  (both on disk)" : ""}`);
    review.push(`- [ ] move-fork [[${mv.from}]] → [[${mv.to}]] — a \`vault move\` never finished; ${hint}`);
  }
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
  // digit at the length-1 boundary (a numbered child like phase/phase1, fy202/fy2025). Numbered siblings
  // (q1/q2, fy2025/fy2026, phase-1/phase-2) are intentional, not typos, so they are skipped. A LETTER
  // edit (finance/finances adds 's', identty/identity swaps a letter) is NOT digit-only and still flags.
  // `short`/`long` are by length.
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

// --- host auto-memory guard -------------------------------------------------
// imprnt's rule (the vault contract's "Memory: the vault is the only store"): the vault is the ONLY
// knowledge store. Claude Code's per-project auto-memory (its MEMORY.md + memory/*.md) is a second
// always-on store recall can't search, so a fact parked there is invisible and silently misleads the
// next session. We SWEEP EVERY project's store, not just this vault's — a leak from ANY session,
// including a plain `claude` run in another repo (the kind that caused this), is caught here, not only
// a leak from an imp session in this vault. Strictly READ-ONLY: we only readdir, never write, so the
// sweep respects imprnt's promise to never touch ~/.claude. The roots are Claude Code's own layout,
// <configDir>/projects/*/memory (configDir = $CLAUDE_CONFIG_DIR || ~/.claude). A MEMORY.md that is
// only the bare "# Memory index" header counts as empty; one carrying facts is flagged (see below).
// IMPRNT_HOST_MEMORY_DIR overrides to a SINGLE dir (a test, or another host).
function hostMemoryStores(): string[] {
  const override = process.env.IMPRNT_HOST_MEMORY_DIR;
  if (override) return [override];
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const projectsDir = join(configDir, "projects");
  if (!existsSync(projectsDir)) return [];
  let entries: string[];
  try { entries = readdirSync(projectsDir); } catch { return []; }
  return entries
    .map((p) => join(projectsDir, p, "memory"))
    .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } })
    .sort();
}
const memoryStores = hostMemoryStores();
// MEMORY.md is exempt only while it is the bare auto-created index: Claude Code also writes short
// facts STRAIGHT into MEMORY.md (the most common auto-memory write), and those are exactly the
// invisible-knowledge leak this sweep exists to catch. Anything beyond the "# Memory index" header
// and blank lines counts as content. Unreadable (or absent) reads as bare - the sweep is read-only
// and best-effort over state imprnt does not own.
//
// PINNED ASSUMPTION: the sweep is deliberately NON-recursive. Claude Code writes auto-memory as a
// FLAT dir - MEMORY.md plus sibling memory/*.md topic files, never nested subdirectories - so one
// readdirSync per store sees everything. If the host ever nests memory dirs, the readdirSync below
// must become a walk, or a nested note slips past the sweep unseen.
function memoryIndexHasContent(dir: string): boolean {
  try {
    return readFileSync(join(dir, "MEMORY.md"), "utf8")
      .split(/\r?\n/)
      .some((l) => l.trim() !== "" && l.trim() !== "# Memory index");
  } catch {
    return false;
  }
}
// One entry per store that still holds a stray note (an .md other than the bare MEMORY.md index).
const strayStores = memoryStores
  .map((dir) => {
    // Per-store tolerance: one unreadable memory dir (perms broken by a root-run session, an
    // IMPRNT_HOST_MEMORY_DIR pointing at a plain file) degrades to a warned skip, never an uncaught
    // throw that would abort the index.md regen and needs-review sync below - the same treatment
    // the statSync filter above and the --all plugin glob already get.
    let files: string[] = [];
    try {
      if (existsSync(dir)) files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").sort();
    } catch (e) {
      console.error(`⚠ host auto-memory sweep: could not read ${dir} (${e instanceof Error ? e.message : String(e)}) - skipping it`);
    }
    if (memoryIndexHasContent(dir)) files.push("MEMORY.md (has content)");
    return { dir, files };
  })
  .filter((s) => s.files.length > 0);
const strayCount = strayStores.reduce((n, s) => n + s.files.length, 0);
// One needs-review line PER store, so each clears independently as that store is emptied.
for (const s of strayStores) review.push(`- [ ] host auto-memory not empty — ${s.files.length} note(s) in ${s.dir}; migrate knowledge → vault notes, behavior → a CLAUDE.local.md fragment, then empty it`);

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

console.log(`imprnt check — ${notes.length} notes in ${vault}`);
// Say when a vault has overridden the folder roles. A silent override is a check whose rules you
// cannot see from its output, and the first question about any surprising result is "which rules
// did it actually run".
if (roles.declared) {
  const parts = [`entities: ${[...ENTITY_FOLDERS].join(" ") || "(none)"}`, `domains: ${[...DOMAIN_FOLDERS].join(" ") || "(none)"}`];
  if (MOUNT_FOLDERS.size) parts.push(`mounts: ${[...MOUNT_FOLDERS].join(" ")}`);
  console.log(`folder roles from _folders.md — ${parts.join(", ")}`);
  // A mount that declares its own roles is checked by THOSE, scoped to the mount. Same reason as
  // above: the first question about a surprising finding is which rules produced it.
  for (const m of MOUNT_FOLDERS) {
    const mr = mountRoles(m);
    if (mr.declared) console.log(`  ${m}/_folders.md — entities: ${[...mr.entities].join(" ") || "(none)"}, domains: ${[...mr.domains].join(" ") || "(none)"}`);
  }
}
console.log("");

if (orphans.length) { console.log(`⚠ orphan links (${orphans.length}) — target note missing:`); console.log(cap(orphans).join("\n"), "\n"); }
else console.log("✓ no orphan links");

if (disconnected.length) { console.log(`⚠ disconnected notes (${disconnected.length}) — domain/form note links no entity:`); console.log(cap(disconnected).join("\n"), "\n"); }
else console.log("✓ every domain/form note links the graph");

if (domainIssues.length) { console.log(`⚠ domain mismatches (${domainIssues.length}) — folder ≠ domain: field:`); console.log(cap(domainIssues).join("\n"), "\n"); }
else console.log("✓ every domain note's folder matches its domain: field");

if (untagged.length) { console.log(`⚠ untagged notes (${untagged.length}) — no tags, findable by body/title only:`); console.log(cap(untagged).join("\n"), "\n"); }
else console.log("✓ every note carries at least one tag");

// The seam sections print only when a mount exists — a vault with no mount should not be told about a
// boundary it does not have.
if (MOUNT_FOLDERS.size) {
  if (seamLeaks.length) { console.log(`⚠ seam-leak (${seamLeaks.length}) — a mount note's link resolves only in THIS vault:`); console.log(cap(seamLeaks).join("\n"), "\n"); }
  else console.log("✓ no seam leaks — every mount note's links resolve inside its mount");
  if (seamDeadSources.length) { console.log(`⚠ seam-dead-source (${seamDeadSources.length}) — a mount note points at this vault's private raw/:`); console.log(cap(seamDeadSources).join("\n"), "\n"); }
}

if (conflicted.length) { console.log(`⚠ conflict markers (${conflicted.length}) — an unresolved \`<<<<<<<\` merge conflict is in the note:`); console.log(cap(conflicted).join("\n"), "\n"); }

if (moveForks.length) { console.log(`⚠ move-fork (${moveForks.length}) — a \`vault move\` never finished, so one note may exist twice:`); console.log(cap(moveForks).join("\n"), "\n"); }

if (hasTagsFile) {
  if (addedTags.length) console.log(`↑ synced ${addedTags.length} new tag(s) into _tags.md: ${addedTags.join(", ")}`);
  else console.log("✓ tag vocabulary in sync");
  if (dupPairs.length) { console.log(`⚠ candidate duplicate tags (${dupPairs.length}) — add a synonym in _tags.md to merge:`); console.log(cap(dupPairs).join("\n"), "\n"); }
}

if (rawEntries.length) {
  if (uncovered.length) { console.log(`⚠ uncovered snapshots (${uncovered.length}/${new Set(rawEntries.map(norm)).size}) — raw source no note points back to:`); console.log(cap(uncovered).join("\n"), "\n"); }
  else console.log("✓ every raw snapshot has a derived note");
}

if (strayCount) {
  console.log(`⚠ host auto-memory not empty (${strayCount} in ${strayStores.length} project store(s)) — a second store recall can't see:`);
  for (const s of strayStores) { console.log(`  ${s.dir}`); console.log(cap(s.files.map((f) => "    " + f)).join("\n")); }
  console.log("  migrate knowledge → vault notes, behavior → a CLAUDE.local.md fragment, then empty each.\n");
}
else console.log(`✓ host auto-memory empty (vault is the only store) — swept ${memoryStores.length} project store(s)`);

const { count, folders } = generateIndex(vault);
console.log(`↻ regenerated index.md — ${count} notes across ${folders} folders`);

const synced = syncNeedsReview(review);
if (synced === "written") console.log(`↻ ${review.length} finding(s) → _needs-review.md (run \`imprnt hot\` to see them)`);
else if (synced === "cleared") console.log("↻ cleared resolved findings from _needs-review.md");

const issues = orphans.length + disconnected.length + domainIssues.length + untagged.length + uncovered.length + dupPairs.length + strayCount
  + seamLeaks.length + seamDeadSources.length + conflicted.length + moveForks.length;
console.log(issues ? `\n${issues} thing(s) to look at above.` : `\nclean.`);
// check still PRINTS everything and never blocks or mutates a note — only the exit CODE reflects health,
// so `imprnt check` is usable in CI and `&&` chains. Core issues alone make the process exit non-zero.
// With --all the final exit is the max of core issues and any plugin failure (computed below).

// --- plugin aggregation (--all only) --------------------------------------
// The ONE core↔plugin contact for integrity (the other is `ingest --apply`). Both discover by
// convention, never by import, never by naming a plugin. The FENCE that keeps this from becoming a
// "plugin API": core may provide read-only AGGREGATION here, never write/orchestration. Concretely we
// glob plugins/*/check.js (or check.mjs), run each as its own `node` subprocess, READ THE EXIT CODE ONLY (0 = sound,
// non-zero = issue), and forward the plugin's stdout/stderr VERBATIM — we never parse what it prints.
// Core `check` exits non-zero when it has issues (bug-1 fix); --all exits non-zero when the core has
// issues OR any plugin failed (the max of both).
if (all) {
  // Glob the user's PROJECT plugins/, where `plugin add` copies installed plugins (not the package).
  const pluginsDir = join(projectRoot(), "plugins");
  const checks: { path: string; shadowed?: string }[] = [];
  if (existsSync(pluginsDir)) {
    for (const entry of readdirSync(pluginsDir)) {
      // Tolerate per-entry: a broken symlink (or any unstat-able entry) must not kill the whole
      // aggregation - skip the dead entry and run the remaining plugin checks.
      let isDir = false;
      try { isDir = statSync(join(pluginsDir, entry)).isDirectory(); } catch { continue; }
      if (!isDir) continue;
      // check.js, or check.mjs for a plugin shipping ESM. A dir with both runs the .js and says so.
      const script = pluginScript(join(pluginsDir, entry), "check");
      if (script) checks.push(script);
    }
  }
  checks.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  console.log(`\n— plugins (${checks.length}) —`);
  if (checks.length === 0) console.log("  (no plugins/*/check.js or check.mjs found)");

  let failed = 0;
  for (const { path: checkPath, shadowed } of checks) {
    const rel = relative(pluginsDir, checkPath).split("\\").join("/");
    if (shadowed) console.log(`  plugins/${rel} wins over ${basename(shadowed)} (both present)`);
    // Run the plugin's built check script with node, stdio inherited so its output streams through
    // verbatim. We read ONLY the exit code (process.execPath = the node binary running us).
    const proc = spawnSync(process.execPath, [checkPath], { stdio: "inherit" });
    const code = proc.status ?? 1;
    const ok = code === 0;
    if (!ok) failed++;
    console.log(`  ${ok ? "✓" : "✗"} plugins/${rel} → exit ${code}`);
  }

  if (failed) console.log(`\n${failed} plugin check(s) failed.`);
  else if (checks.length) console.log(`\nall plugin checks passed.`);

  if (failed || issues) process.exit(1);
} else if (issues) {
  process.exit(1);
}
