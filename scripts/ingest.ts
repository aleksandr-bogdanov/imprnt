#!/usr/bin/env bun
// knowful ingest <file|text> [--text "<bytes>"] [--stdin] [--slug S] [--vault DIR]
//
// Input is shape-agnostic: a file path, --stdin, --text, or a bare arg that isn't a path (treated
// AS the bytes). EVERY shape gets the same provenance — raw/ snapshot, content hash, manifest,
// reingest-is-a-no-op. A transcript FILE also gets the deterministic event skeleton below; inline
// bytes / pasted prose are snapshotted only, then the LLM classifies the TYPE (see the !isFile path).
//
// Deterministic transcript -> structured note SKELETON. NO LLM CALL.
// The redrawn line: CODE does structure (snapshot, hash, speakers, date, filing, manifest,
// resolve); the LLM does ALL the meaning. So this writes frontmatter + a body whose semantic
// sections are left PENDING for the agent — the only paid step. No keyword extraction: guessing
// decisions/actions from cue words is the LLM's job, done with judgment, not regexes.
//
// SCOPE OF THE CLI vs the LLM (contract: "The one rule: deterministic-first"):
//   - This CLI handles ONLY the transcript -> `events/` skeleton path. A transcript is a dated
//     occurrence, so its TYPE is known up front: `event`. The CLI commits to that and nothing else.
//   - For a NON-transcript source (a pasted doc, a prose dump, a single fact), the note's TYPE
//     (people | orgs | projects | things | principles | notes | mistakes | events) is a SEMANTIC
//     judgment — the conscious LLM step in the Ingest skill, NOT this CLI. The CLI's only universal
//     job for every source is the `raw/` snapshot below; classification + filing is the agent's.
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, join, relative } from "node:path";
import { loadManifest, saveManifest } from "./lib/manifest.ts";
import { personResolved, flagNeedsReview } from "./lib/resolve.ts";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

// --- arg parsing -----------------------------------------------------------
// Input is shape-agnostic. Three ways to hand a source in:
//   - a path that exists            -> read the file
//   - --stdin                       -> read piped bytes (slug from --slug or the first words)
//   - --text "<bytes>" / a bare arg that ISN'T a path -> treat the arg AS the source bytes
// Inline facts and pasted prose are the highest-frequency / dominant-migration cases; they MUST
// get the same raw/ snapshot + hash + manifest + reingest-no-op guarantee as files. When the source
// is bytes (not a transcript file), we skip the transcript skeleton and let the LLM classify TYPE.
const args = process.argv.slice(2);
let vault = "./vault";
let inlineText: string | undefined;
let useStdin = false;
let slugHint = "";
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--vault") vault = args[++i];
  else if (args[i] === "--text") inlineText = args[++i];
  else if (args[i] === "--stdin") useStdin = true;
  else if (args[i] === "--slug") slugHint = args[++i];
  else positional.push(args[i]);
}

let src: string;       // a human-readable origin label (path, or "<text>" / "<stdin>")
let text: string;      // the source bytes
let isFile = false;
if (useStdin) {
  text = await Bun.stdin.text();
  src = "<stdin>";
} else if (inlineText !== undefined) {
  text = inlineText;
  src = "<text>";
} else {
  const arg = positional[0];
  if (!arg) {
    console.error('usage: knowful ingest <file|text> [--text "<bytes>"] [--stdin] [--slug S] [--vault DIR]');
    process.exit(1);
  }
  if (existsSync(arg)) { text = readFileSync(arg, "utf8"); src = arg; isFile = true; }
  else { text = arg; src = "<text>"; } // not a path -> the arg IS the source bytes (an inline fact)
}
if (!text.trim()) { console.error("empty source — nothing to ingest"); process.exit(1); }

// --- delta manifest (incremental — skip unchanged sources) -----------------
// File sources key on their path; bytes sources (inline/stdin) have no path, so key on the content
// hash itself — reingesting identical bytes stays a no-op either way.
const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
const manifestKey = isFile ? src : `sha256:${hash}`;
const manifest = loadManifest(vault);
if (manifest[manifestKey]?.hash === hash) {
  console.log(`unchanged (hash ${hash}) — skipping ${src}. note: ${manifest[manifestKey].note}`);
  process.exit(0);
}

// --- parse: speakers + date + subject (deterministic, STRUCTURE only) ------
const fname = basename(src);
const dateMatch = fname.match(/(\d{4}-\d{2}-\d{2})/) || text.match(/^\s*date:\s*(\d{4}-\d{2}-\d{2})/im);
const date = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);

const lines = text.split(/\r?\n/);
const SPEAKER = /^([A-Z][A-Za-z .'-]{1,40}):\s*(.*)$/;
const META_KEYS = new Set(["date", "subject", "topic", "note", "notes", "attendees", "participants"]);
const speakers = new Set<string>();
let subject = "";
let turnCount = 0;
for (const line of lines) {
  const m = line.match(SPEAKER);
  if (!m) continue;
  const key = m[1].trim().toLowerCase();
  if (META_KEYS.has(key)) {
    if (key === "subject" || key === "topic") subject = m[2].trim();
    continue;
  }
  speakers.add(m[1].trim());
  turnCount++;
}

// --- snapshot the source into raw/ (verbatim, immutable) -------------------
// Universal first move for EVERY source (file OR inline bytes): write the bytes into raw/ so any
// claim stays traceable to its origin and a schema change is just a `reingest` over raw/. The name
// is content-addressed (`<date>-<slug>-<hash>`), so identical bytes never collide and distinct bytes
// never clobber — no disambiguation dance needed. Reuse an existing snapshot of these exact bytes.
const slugBasis = slugHint || subject || [...speakers].join("-") || (isFile ? basename(src, extname(src)) : text.slice(0, 60));
const subjectSlug = slugify(slugBasis || "source");
const noteSlug = `${date}-${subjectSlug}`;
// raw/ is keyed by source: a transcript file is a dated dump -> raw/transcripts/; loose bytes -> raw/adhoc/.
const rawDir = join(vault, "..", "raw", isFile ? "transcripts" : "adhoc");

const priorSnapshot = Object.values(manifest).find((e) => e.hash === hash && e.raw && existsSync(e.raw))?.raw;
let rawPath: string;
if (priorSnapshot) {
  rawPath = priorSnapshot;
} else {
  mkdirSync(rawDir, { recursive: true });
  const ext = isFile ? extname(src) || ".txt" : ".md";
  const rawName = isFile ? `${date}-${subjectSlug}-${hash}${ext}` : `${subjectSlug}-${hash}${ext}`;
  rawPath = join(rawDir, rawName);
  if (!existsSync(rawPath)) {
    if (isFile) copyFileSync(src, rawPath);
    else writeFileSync(rawPath, text);
  }
}

// --- bytes source: snapshot only, no skeleton (LLM classifies TYPE) --------
// An inline fact or a pasted prose dump has no known type, so the CLI does NOT guess it: it records
// the raw/ snapshot in the manifest and hands off to the conscious LLM step, which picks one of the 8
// types and creates the note. This is the same handoff the Ingest workflow already does for any
// non-transcript source — we just give it the same provenance (snapshot + hash + manifest + no-op).
if (!isFile) {
  manifest[manifestKey] = { hash, note: "", ingested: new Date().toISOString(), raw: rawPath };
  saveManifest(vault, manifest);
  // Coverage ledger: a snapshotted-but-unclassified source has no note yet. If the LLM classify
  // step is interrupted/batched/forgotten, this surfaces in `hot` so the half-migrated source isn't
  // silently stranded in raw/. The LLM clears this line when it creates the note in Ingest Step 2 —
  // same lifecycle as the unresolved-person flags.
  flagNeedsReview(vault, `- [ ] unclassified source \`${rawPath}\` — snapshotted, needs TYPE + note`);
  console.log(`snapshotted ${src}`);
  console.log(`  snapshot -> ${rawPath}${priorSnapshot ? "  (reused — identical bytes already snapshotted)" : "  (immutable)"}`);
  console.log(`  no skeleton written — this is bytes, not a transcript. next (the one LLM step):`);
  console.log(`  read ${rawPath}, then file it: an entity -> people/ orgs/ holdings/; a held position ->`);
  console.log(`  identity/; else by domain (health/ finances/ work/ life/). Write type + summary + tags`);
  console.log(`  (from vault/_tags.md) + kind, and link >=1 existing entity. Then \`knowful check\`.`);
  process.exit(0);
}

// --- render note SKELETON (frontmatter + pending body) ---------------------
const title = subject || `1:1 — ${[...speakers].join(", ")}`;
const people = [...speakers].map((s) => `"[[people/${slugify(s)}]]"`);
// source is a wikilink into the immutable snapshot (clickable in Obsidian; never searched by recall).
const rawRel = "raw/" + relative(join(vault, "..", "raw"), rawPath).split("\\").join("/").replace(/\.md$/, "");

const fm = [
  "---",
  "type: event",
  `date: ${date}`,
  `participants: [${people.join(", ")}]`,
  "summary:                      # LLM writes one line — `knowful check` reads it to build index.md",
  "tags: []                      # LLM fills from the approved vocabulary (vault/_tags.md)",
  "project:                      # LLM links the project this event touched",
  `source: "[[${rawRel}]]"`,
  `source_hash: ${hash}`,
  "status: draft-deterministic   # -> 'enriched' after the LLM semantic pass",
  `ingested: ${new Date().toISOString()}`,
  "---",
].join("\n");

const PENDING = "<!-- semantic-clean: pending — the agent fills this. The only paid LLM step. -->";
const body = `# ${title}

> ${turnCount} turns · ${speakers.size} participants · parsed deterministically. No LLM was used to produce this skeleton.

## Summary
${PENDING}

## Decisions
${PENDING}

## Action items
${PENDING}

## Open questions
${PENDING}

## Participants
${[...speakers].map((s) => `- [[people/${slugify(s)}]]`).join("\n") || "_none detected_"}

## Source
Snapshot: \`${rawPath}\` (sha256:${hash}), copied verbatim from \`${src}\`. Immutable — do not edit; re-ingest instead.
`;

const note = `${fm}\n\n${body}`;
const dir = join(vault, "events");
mkdirSync(dir, { recursive: true });
const notePath = join(dir, `${noteSlug}.md`);
writeFileSync(notePath, note);

manifest[manifestKey] = { hash, note: notePath, ingested: new Date().toISOString(), raw: rawPath };
saveManifest(vault, manifest);

// --- resolve participants (deterministic): flag unknown people to needs-review ---
const unresolved = [...speakers].filter((name) => !personResolved(vault, slugify(name), name));
for (const name of unresolved) {
  flagNeedsReview(vault, `- [ ] unresolved person \`${name}\` — from [[events/${noteSlug}]] (${date})`);
}

console.log(`ingested ${src}`);
console.log(`  snapshot -> ${rawPath}${priorSnapshot ? "  (reused — identical bytes already snapshotted)" : "  (immutable)"}`);
console.log(`  note     -> ${notePath}  (${speakers.size} participants, ${turnCount} turns)`);
if (unresolved.length) console.log(`  ⚠ ${unresolved.length} unresolved participant(s) -> needs-review: ${unresolved.join(", ")}`);
console.log(`  deterministic skeleton only. next (the one LLM step): the agent fills`);
console.log(`  summary + Summary/Decisions/Actions/Questions, assigns tags from vault/_tags.md,`);
console.log(`  and links people + projects (resolving the flagged participants). Then \`knowful check\`.`);
