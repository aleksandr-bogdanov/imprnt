#!/usr/bin/env bun
// imprint ingest <file|text> [--text "<bytes>"] [--stdin] [--slug S] [--vault DIR]
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
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, saveManifest } from "./lib/manifest.ts";
import { personResolved, flagNeedsReview } from "./lib/resolve.ts";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

// Known source file extensions a user would pass as a path. A single-line inline fact never ends in
// one of these, so this stays a safe discriminator alongside the separator check.
const PATH_EXTS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log", ".pdf", ".rtf", ".html", ".htm", ".vtt", ".srt"]);

// True if the arg is SHAPED like a file path: it contains a path separator, or it is a single token
// (no whitespace) ending in a known file extension. An inline fact ("call Bob tomorrow") matches
// neither, so it is still treated as bytes; a mistyped "notes/2025.txt" is caught as a missing file.
function looksLikePath(arg: string): boolean {
  if (arg.includes("/") || arg.includes("\\")) return true;
  if (!/\s/.test(arg) && PATH_EXTS.has(extname(arg).toLowerCase())) return true;
  return false;
}

// Conservative transcript detector. The contract says ONLY a transcript gets the deterministic event
// skeleton; any other prose is snapshotted and left for the LLM to classify. We fire only when the
// shape is unambiguous: at least two DISTINCT speaker labels, or an explicit meta header
// (subject:/date:/topic:/attendees:/participants:). A single stray "Word:" line never qualifies.
function looksLikeTranscript(speakers: Set<string>, hasMetaHeader: boolean): boolean {
  return speakers.size >= 2 || hasMetaHeader;
}

// --- frontmatter helpers (deterministic — STRUCTURE only, no LLM) ----------
function frontmatter(raw: string): string {
  return raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
}
function fmScalar(fm: string, key: string): string {
  return (fm.match(new RegExp(`^${key}:\\s*(.+)$`, "im"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
}
function fmList(fm: string, key: string): string[] {
  const line = fm.match(new RegExp(`^${key}:\\s*\\[(.*?)\\]`, "im"))?.[1] ?? "";
  return line.split(",").map((s) => s.trim().replace(/^["'\[]+|["'\]]+$/g, "")).filter(Boolean);
}
// A wikilink target -> its bare slug ("[[people/alex]]" -> "people/alex", "alex" -> "alex").
function linkSlug(s: string): string {
  return s.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/#.*$/, "").replace(/\|.*$/, "").replace(/\.md$/, "").trim();
}

// type -> vault folder. The folder is mechanical ONCE the type/domain are decided (the LLM already
// decided them when it enriched the staged note); we never re-classify here. Entities + forms file
// into a folder named for their type; a topical note (`principle`/`note`) files into its `domain:`.
const TYPE_FOLDER: Record<string, string> = {
  person: "people", org: "orgs", holding: "holdings",
  project: "projects", event: "events", mistake: "mistakes",
};
const DOMAIN_FOLDERS = new Set(["identity", "health", "finances", "work", "life", "projects"]);

function targetFolder(type: string, domain: string): string | null {
  if (TYPE_FOLDER[type]) return TYPE_FOLDER[type];
  if (type === "principle" || type === "note") {
    return DOMAIN_FOLDERS.has(domain) ? domain : null; // a domain note MUST name a valid domain
  }
  return null;
}

// --- imprint ingest --apply <file> / --apply-all ---------------------------
// The SECOND (and last) core↔plugin contact, the partner of `check --all`. A plugin proposes a note
// by dropping a PRE-ENRICHED markdown file (real `type`/`domain`/`summary`/`tags` + body) into its
// own `plugins/<name>/proposed/`; `--apply` files it into the vault. This is the propose-then-approve
// escape hatch made concrete — code does the mechanical filing, the LLM already did the meaning.
// Discovery is by convention (plugins/*/proposed/*.md), uniform, no per-plugin branch.
function applyStaged(staged: string, vault: string): "filed" | "noop" | "conflict" | "error" {
  if (!existsSync(staged)) { console.error(`no such staged note: ${staged}`); return "error"; }
  const text = readFileSync(staged, "utf8");
  const fm = frontmatter(text);
  const type = fmScalar(fm, "type");
  const domain = fmScalar(fm, "domain");
  if (!type) { console.error(`  ✗ ${staged}: no \`type:\` in frontmatter — can't file a note with no type`); return "error"; }

  const folder = targetFolder(type, domain);
  if (!folder) {
    console.error(`  ✗ ${staged}: type \`${type}\`${domain ? ` / domain \`${domain}\`` : ""} maps to no vault folder`);
    console.error(`     entities: person|org|holding · forms: event|mistake · project · a principle/note needs a valid domain:`);
    return "error";
  }

  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  const slug = slugify(fmScalar(fm, "slug") || title || basename(staged, ".md"));
  if (!slug) { console.error(`  ✗ ${staged}: can't derive a slug (no H1 title, no slug:)`); return "error"; }

  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const noteRel = `${folder}/${slug}`;
  const notePath = join(vault, `${noteRel}.md`);

  // Idempotency + contradiction discipline. Same path + identical bytes -> no-op (re-applying is free).
  // Same path + DIFFERENT bytes -> we do NOT silently overwrite; we flag it for the contradiction
  // workflow (`> superseded by`), exactly as a hand-edit conflict would be handled.
  if (existsSync(notePath)) {
    const existingHash = createHash("sha256").update(readFileSync(notePath, "utf8")).digest("hex").slice(0, 16);
    if (existingHash === hash) {
      console.log(`  = ${noteRel} already filed, identical content (hash ${hash}) — no-op`);
      // The staged copy is redundant once the vault note matches it byte-for-byte; clear it.
      rmSync(staged);
      return "noop";
    }
    console.error(`  ! ${noteRel} exists with DIFFERENT content — not overwriting (contradiction discipline)`);
    flagNeedsReview(vault, `- [ ] proposed note conflicts with existing [[${noteRel}]] — staged at \`${staged}\` (hash ${hash} vs ${existingHash}); reconcile or stamp \`> superseded by\``);
    return "conflict";
  }

  // Snapshot the staged note into raw/ for provenance, reusing the same content-addressed scheme as the
  // bytes path: identical bytes never collide, distinct bytes never clobber, reuse an existing snapshot.
  const manifest = loadManifest(vault);
  // Namespace the apply key by kind so an applied note never shares a manifest slot with an
  // inline-bytes ingest of byte-identical content (`bytes:sha256:...`); identical bytes from two
  // different source kinds must keep distinct provenance rows.
  const manifestKey = `apply:sha256:${hash}`;
  const priorSnapshot = Object.values(manifest).find((e) => e.hash === hash && e.raw && existsSync(e.raw))?.raw;
  const rawDir = join(vault, "..", "raw", "proposed");
  let rawPath: string;
  if (priorSnapshot) {
    rawPath = priorSnapshot;
  } else {
    mkdirSync(rawDir, { recursive: true });
    rawPath = join(rawDir, `${slug}-${hash}.md`);
    if (!existsSync(rawPath)) writeFileSync(rawPath, text);
  }

  // File the note (mechanical — type/domain already decided), record provenance in the manifest.
  mkdirSync(join(vault, folder), { recursive: true });
  writeFileSync(notePath, text);
  manifest[manifestKey] = { hash, note: notePath, ingested: new Date().toISOString(), raw: rawPath };
  saveManifest(vault, manifest);

  // Resolve participants/links the same way the transcript path does: an unresolved person -> needs-review.
  // We only auto-resolve PEOPLE (the resolver's domain); other wikilink targets are checked by `imprint check`.
  const participants = fmList(fm, "participants").map(linkSlug);
  const owner = linkSlug(fmScalar(fm, "owner"));
  const peopleLinks = [...participants, ...(owner ? [owner] : [])]
    .filter((l) => l.startsWith("people/"))
    .map((l) => l.slice("people/".length));
  let unresolved = 0;
  for (const personSlug of new Set(peopleLinks)) {
    if (!personResolved(vault, personSlug, personSlug.replace(/-/g, " "))) {
      unresolved++;
      flagNeedsReview(vault, `- [ ] unresolved person \`people/${personSlug}\` — from [[${noteRel}]] (applied from \`${staged}\`)`);
    }
  }

  // Filed cleanly -> the staged copy has served its purpose; delete it from plugins/*/proposed/.
  rmSync(staged);

  console.log(`  ✓ filed ${noteRel}  (type: ${type}${domain ? `, domain: ${domain}` : ""})`);
  console.log(`     snapshot -> ${rawPath}${priorSnapshot ? "  (reused — identical bytes already snapshotted)" : ""}`);
  console.log(`     staged copy removed: ${staged}`);
  if (unresolved) console.log(`     ⚠ ${unresolved} unresolved person link(s) -> needs-review`);
  return "filed";
}

// Dispatch the apply modes before the shape-agnostic ingest path. `--apply <file>` files one staged
// note; `--apply-all` globs plugins/*/proposed/*.md (convention discovery) and files each uniformly.
{
  const a = process.argv.slice(2);
  let applyVault = process.env.IMPRINT_VAULT ?? "./vault";
  for (let i = 0; i < a.length; i++) if (a[i] === "--vault") applyVault = a[++i];

  if (a.includes("--apply-all")) {
    if (!existsSync(applyVault)) { console.error(`no vault at ${applyVault} — run \`imprint init\` first`); process.exit(1); }
    const here = dirname(fileURLToPath(import.meta.url));
    const pluginsDir = join(here, "..", "plugins");
    const staged: string[] = [];
    if (existsSync(pluginsDir)) {
      for (const entry of readdirSync(pluginsDir)) {
        const proposed = join(pluginsDir, entry, "proposed");
        if (!existsSync(proposed) || !statSync(proposed).isDirectory()) continue;
        for (const f of readdirSync(proposed)) if (f.endsWith(".md")) staged.push(join(proposed, f));
      }
    }
    staged.sort();
    console.log(`ingest --apply-all — ${staged.length} staged note(s) across plugins/*/proposed/`);
    let filed = 0, noop = 0, conflict = 0, error = 0;
    for (const s of staged) {
      const r = applyStaged(s, applyVault);
      if (r === "filed") filed++; else if (r === "noop") noop++; else if (r === "conflict") conflict++; else error++;
    }
    console.log(`\n${filed} filed, ${noop} no-op, ${conflict} conflict, ${error} error.`);
    process.exit(conflict + error ? 1 : 0);
  }

  const applyIdx = a.indexOf("--apply");
  if (applyIdx >= 0) {
    const file = a[applyIdx + 1];
    if (!file || file.startsWith("--")) { console.error("usage: imprint ingest --apply <file> [--vault DIR]"); process.exit(1); }
    if (!existsSync(applyVault)) { console.error(`no vault at ${applyVault} — run \`imprint init\` first`); process.exit(1); }
    console.log(`ingest --apply ${file}`);
    const r = applyStaged(file, applyVault);
    process.exit(r === "conflict" || r === "error" ? 1 : 0);
  }
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
let vault = process.env.IMPRINT_VAULT ?? "./vault";
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
    console.error('usage: imprint ingest <file|text> [--text "<bytes>"] [--stdin] [--slug S] [--vault DIR]');
    process.exit(1);
  }
  if (existsSync(arg)) { text = readFileSync(arg, "utf8"); src = arg; isFile = true; }
  else if (looksLikePath(arg)) {
    // The arg is shaped like a file path (has a separator or a known extension) but does not exist.
    // Treating it as inline text would silently snapshot the literal path string as content, hiding a
    // typo. Error instead. A genuine inline dump has no path-like shape and still falls through below.
    console.error(`no such file: ${arg}`);
    process.exit(1);
  }
  else { text = arg; src = "<text>"; } // not a path -> the arg IS the source bytes (an inline fact)
}
if (!text.trim()) { console.error("empty source — nothing to ingest"); process.exit(1); }

// --- delta manifest (incremental — skip unchanged sources) -----------------
// File sources key on their path; bytes sources (inline/stdin) have no path, so key on the content
// hash itself — reingesting identical bytes stays a no-op either way. The bytes key is NAMESPACED
// (`bytes:sha256:...`) so it can never collide with an `--apply` entry of identical bytes
// (`apply:sha256:...`), which would otherwise clobber the other's provenance under a shared key.
const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
const manifestKey = isFile ? src : `bytes:sha256:${hash}`;
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
// A meta line is `key: value` where key is one of the conventional header keys, matched
// case-INSENSITIVELY so lowercase `subject:`/`date:`/`topic:` are parsed too (not just capitalized
// forms). Meta keys are checked BEFORE the speaker pattern so a header is never counted as a speaker.
const META_KEYS = new Set(["date", "subject", "topic", "note", "notes", "attendees", "participants"]);
const META = /^([A-Za-z][A-Za-z]*):\s*(.*)$/;
// A speaker label is a SHORT capitalized name (1 to 3 words, letters/spaces/.'-) followed by a colon.
// Keeping it short and word-bounded stops a sentence fragment that happens to contain a colon
// ("I think: ...", "Note: long prose ...") from being mistaken for a speaker turn.
const SPEAKER = /^([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}):\s+\S.*$/;
const speakers = new Set<string>();
let subject = "";
let turnCount = 0;
let hasMetaHeader = false;
for (const line of lines) {
  const meta = line.match(META);
  if (meta && META_KEYS.has(meta[1].trim().toLowerCase())) {
    hasMetaHeader = true;
    const key = meta[1].trim().toLowerCase();
    if ((key === "subject" || key === "topic") && !subject) subject = meta[2].trim();
    continue;
  }
  const m = line.match(SPEAKER);
  if (!m) continue;
  speakers.add(m[1].trim());
  turnCount++;
}
const isTranscript = isFile && looksLikeTranscript(speakers, hasMetaHeader);

// --- snapshot the source into raw/ (verbatim, immutable) -------------------
// Universal first move for EVERY source (file OR inline bytes): write the bytes into raw/ so any
// claim stays traceable to its origin and a schema change is just a `reingest` over raw/. The name
// is content-addressed (`<date>-<slug>-<hash>`), so identical bytes never collide and distinct bytes
// never clobber — no disambiguation dance needed. Reuse an existing snapshot of these exact bytes.
const slugBasis = slugHint || subject || [...speakers].join("-") || (isFile ? basename(src, extname(src)) : text.slice(0, 60));
const subjectSlug = slugify(slugBasis || "source");
const noteSlug = `${date}-${subjectSlug}`;
// raw/ is keyed by source: a transcript file is a dated dump -> raw/transcripts/; a non-transcript
// file or loose bytes is unclassified -> raw/adhoc/ (it still gets the full snapshot + provenance).
const rawDir = join(vault, "..", "raw", isTranscript ? "transcripts" : "adhoc");

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

// --- non-transcript source: snapshot only, no skeleton (LLM classifies TYPE) --------
// An inline fact, a pasted prose dump, OR a non-transcript prose FILE has no known type, so the CLI
// does NOT guess it: it records the raw/ snapshot in the manifest and hands off to the conscious LLM
// step, which picks one of the 8 types and creates the note. Only a CONFIDENT transcript gets the
// deterministic event skeleton below; everything else just gets provenance + a needs-review handoff,
// so a plain prose file is never forced into a bogus `# 1:1 -` event with empty participants.
if (!isTranscript) {
  manifest[manifestKey] = { hash, note: "", ingested: new Date().toISOString(), raw: rawPath };
  saveManifest(vault, manifest);
  // Coverage ledger: a snapshotted-but-unclassified source has no note yet. If the LLM classify
  // step is interrupted/batched/forgotten, this surfaces in `hot` so the half-migrated source isn't
  // silently stranded in raw/. The LLM clears this line when it creates the note in Ingest Step 2 —
  // same lifecycle as the unresolved-person flags.
  flagNeedsReview(vault, `- [ ] unclassified source \`${rawPath}\` — snapshotted, needs TYPE + note`);
  console.log(`snapshotted ${src}`);
  console.log(`  snapshot -> ${rawPath}${priorSnapshot ? "  (reused — identical bytes already snapshotted)" : "  (immutable)"}`);
  console.log(`  no skeleton written — not a confident transcript. next (the one LLM step):`);
  console.log(`  read ${rawPath}, then file it: an entity -> people/ orgs/ holdings/; a held position ->`);
  console.log(`  identity/; else by domain (health/ finances/ work/ life/). Write type + summary + tags`);
  console.log(`  (from vault/_tags.md) + kind, and link >=1 existing entity. Then \`imprint check\`.`);
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
  "summary:                      # LLM writes one line — `imprint check` reads it to build index.md",
  "tags: []                      # LLM fills the best-fit tag (vault/_tags.md); coin a new one if none fits, check syncs it",
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

// Re-ingest discipline (contradiction handling, mirroring `--apply`): if a note ALREADY exists at this
// slug, NEVER clobber it with the empty deterministic skeleton. The existing note may carry the LLM's
// enrichment (summary, tags, links, decisions) which the skeleton would destroy. We still refresh the
// snapshot + manifest (the source bytes are new provenance) and surface a needs-review line so the
// changed source is reconciled by hand, exactly as a conflicting `--apply` would be.
if (existsSync(notePath)) {
  manifest[manifestKey] = { hash, note: notePath, ingested: new Date().toISOString(), raw: rawPath };
  saveManifest(vault, manifest);
  flagNeedsReview(vault, `- [ ] source changed for existing note [[events/${noteSlug}]] — new snapshot \`${rawPath}\` (hash ${hash}); reconcile the enriched note against the updated transcript (existing note NOT overwritten)`);
  console.log(`! ${src}: event note already exists -> not overwriting (contradiction discipline)`);
  console.log(`  note kept   -> ${notePath}  (any LLM enrichment preserved)`);
  console.log(`  snapshot -> ${rawPath}${priorSnapshot ? "  (reused — identical bytes already snapshotted)" : "  (immutable)"}`);
  console.log(`  ⚠ source changed -> needs-review: reconcile the note against the new snapshot.`);
  process.exit(0);
}

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
console.log(`  and links people + projects (resolving the flagged participants). Then \`imprint check\`.`);
