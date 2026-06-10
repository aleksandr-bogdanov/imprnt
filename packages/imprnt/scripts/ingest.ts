#!/usr/bin/env bun
// imprnt ingest <file|text> [--text "<bytes>"] [--stdin] [--slug S] [--vault DIR]
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
import { basename, extname, join, relative } from "node:path";
import { loadManifest, saveManifest } from "./lib/manifest.ts";
import { personResolved, flagNeedsReview } from "./lib/resolve.ts";
import { projectRoot } from "./lib/roots.ts";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

// Try each candidate IN ORDER, falling through whenever the SLUGIFIED result is unusable - the same
// rule the bytes path applies at its snapshot slug below. An OR over the RAW strings short-circuits
// on a truthy Cyrillic H1 that then slugifies to "" (losing a usable ASCII basename) or to a
// digits-only remnant ("# Налоговая декларация 2024" -> "2024"). A digits-only slug from a candidate
// that HAD letters is degenerate (the words were stripped) and falls through; a genuinely all-numeric
// candidate ("# 2024") keeps its faithful numeric slug.
function deriveSlug(candidates: string[]): string {
  for (const c of candidates) {
    const s = slugify(c);
    if (!s) continue;
    if (/^[\d-]+$/.test(s) && /\p{L}/u.test(c)) continue;
    return s;
  }
  return "";
}

// Known source file extensions a user would pass as a path. A single-line inline fact never ends in
// one of these, so this stays a safe discriminator alongside the separator check.
const PATH_EXTS = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log", ".pdf", ".rtf", ".html", ".htm", ".vtt", ".srt"]);

// True if the arg is SHAPED like a file path: a SINGLE TOKEN (no internal whitespace) that either
// contains a path separator or ends in a known file extension. The no-whitespace guard applies to
// BOTH branches: a multi-word inline fact ("Met Anna, see foo/bar", "ratio 3/4", "and/or", a URL with
// surrounding words) has spaces, so it is never mistaken for a path and is always ingested as bytes.
// A genuine mistyped path ("notes/2025.txt") is one whitespace-free token, so it is caught as missing.
function looksLikePath(arg: string): boolean {
  if (/\s/.test(arg)) return false;
  // A bare URL (`https://...`, `mailto:...`) is an inline FACT, not a path. Its scheme `//` would
  // otherwise trip the separator check below and refuse it as a missing file. Route it to bytes.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return false;
  if (arg.includes("/") || arg.includes("\\")) return true;
  if (PATH_EXTS.has(extname(arg).toLowerCase())) return true;
  return false;
}

// Conservative transcript detector. The contract says ONLY a transcript gets the deterministic event
// skeleton; any other prose is snapshotted and left for the LLM to classify. Real dialogue evidence is
// a RECURRING speaker (a label that comes back across turns), OR the minimal two-speaker exchange where
// each party spoke exactly once and that is the entire body.
//
// Two distinct labels alone is not enough, and "Speaker: line dominates" alone is not either:
//   - A document-header block (`Title:`/`Author:`/`Status:`, callouts like `Warning:`/`TODO:`) clears a
//     bare >=2 bar with a few `Word:` lines that each appear once, then paragraphs of prose.
//   - A dense GLOSSARY / term-list (every line `Term: definition`, each label appearing exactly once)
//     even makes the `Word:` lines the WHOLE body, so a turns/content ratio would clear it too - yet it
//     is no dialogue, just N single-appearance labels. That fabricated an event with [[people/apple]] /
//     [[people/banana]] participants.
// Both must route to the unclassified-source handoff instead.
//
// The discriminator is recurrence: a real conversation longer than one exchange has a speaker who comes
// back (the back-and-forth). A glossary / header never repeats a label.
//   - recurring speaker: any label appears in 2+ turns -> a back-and-forth, accept (even if short).
//   - no recurrence: accept ONLY the minimal two-speaker, two-turn exchange that IS the whole body
//     (speakers==2, turns==2, and those two turns are all the content). A 3+-distinct-labels-each-once
//     document is the glossary/header shape and is rejected. (A two-line glossary is an inherent
//     ambiguity - two `Word: def` lines look identical to a two-line exchange - and is a far rarer,
//     lower-stakes case than the dense glossary the contract cites; it falls on the accept side here.)
// contentLines = non-empty lines that are not a parsed meta/email header (the denominator for "shape").
function looksLikeTranscript(speakers: Set<string>, turnCount: number, contentLines: number, recurringSpeaker: boolean): boolean {
  if (speakers.size < 2) return false;
  if (recurringSpeaker) return true;
  return speakers.size === 2 && turnCount === 2 && contentLines === turnCount;
}

// --- frontmatter helpers (deterministic — STRUCTURE only, no LLM) ----------
// Accept CRLF (`\r\n`) fences so Windows-authored notes parse frontmatter, mirroring recall.ts. Without
// `\r?` the closing `---\r` line never matches, frontmatter() returns "", and a valid CRLF staged note
// is wrongly refused with "no type:". The two readers must agree on the same fence shape.
function frontmatter(raw: string): string {
  return raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
}
function fmScalar(fm: string, key: string): string {
  return (fm.match(new RegExp(`^${key}:\\s*(.+)$`, "im"))?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
}
function fmList(fm: string, key: string): string[] {
  // Greedy capture to the LAST `]` on the line (mirrors check.ts): wikilink entries each contain
  // `]]`, so a lazy match would stop inside the first one and silently drop every later item
  // (participants ["[[people/carol]]", "[[people/dave]]"] resolved only carol).
  const line = fm.match(new RegExp(`^${key}:\\s*\\[(.*)\\]`, "im"))?.[1] ?? "";
  return line.split(",").map((s) => s.trim().replace(/^["'\[]+|["'\]]+$/g, "")).filter(Boolean);
}
// A wikilink target -> its bare slug ("[[people/alex]]" -> "people/alex", "alex" -> "alex").
function linkSlug(s: string): string {
  return s.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/#.*$/, "").replace(/\|.*$/, "").replace(/\.md$/, "").trim();
}

// Insert one `source:` line into the leading `--- ... ---` frontmatter block, right before the closing
// fence, leaving every other byte of the note untouched (surgical - no reformat). Deterministic: same
// note + same target always yields the same bytes, so the apply no-op compare below still holds.
// Accept CRLF (`\r?\n`) fences so a Windows-authored note parses and the inserted `source:` line reuses
// the note's OWN newline style (captured as `$2`), never mixing LF into a CRLF block and breaking YAML.
function injectSource(text: string, target: string): string {
  return text.replace(/^(---\r?\n[\s\S]*?)(\r?\n)(---)/, `$1$2source: "[[${target}]]"$2$3`);
}

// type -> vault folder. The folder is mechanical ONCE the type/domain are decided (the LLM already
// decided them when it enriched the staged note); we never re-classify here. Entities + forms file
// into a folder named for their type; a topical note (`principle`/`note`) files into its `domain:`.
const TYPE_FOLDER: Record<string, string> = {
  person: "people", org: "orgs", holding: "holdings",
  project: "projects", event: "events", mistake: "mistakes",
};
// projects/ is a FORM folder, self-describing by `type: project` (it files via TYPE_FOLDER, not here),
// so it carries NO `domain:` and is exempt from the domain-match check. It must NOT be a valid domain:
// a `type: note, domain: projects` would otherwise file into the form folder where check's domain audit
// then exempts it - a silent contract leak. Must agree with check.ts's DOMAIN_FOLDERS (the twin set).
const DOMAIN_FOLDERS = new Set(["identity", "health", "finances", "work", "life"]);

function targetFolder(type: string, domain: string): string | null {
  // Own-property lookup only: a type like `toString` must not resolve through the prototype chain
  // into a function and crash filing downstream - an unknown type maps to no folder, cleanly.
  if (Object.hasOwn(TYPE_FOLDER, type)) return TYPE_FOLDER[type];
  if (type === "principle" || type === "note") {
    return DOMAIN_FOLDERS.has(domain) ? domain : null; // a domain note MUST name a valid domain
  }
  return null;
}

// --- imprnt ingest --apply <file> / --apply-all ---------------------------
// The SECOND (and last) core↔plugin contact, the partner of `check --all`. A plugin proposes a note
// by dropping a PRE-ENRICHED markdown file (real `type`/`domain`/`summary`/`tags` + body) into its
// own `plugins/<name>/proposed/`; `--apply` files it into the vault. This is the propose-then-approve
// escape hatch made concrete — code does the mechanical filing, the LLM already did the meaning.
// Discovery is by convention (plugins/*/proposed/*.md), uniform, no per-plugin branch.
function applyStaged(staged: string, vault: string): "filed" | "noop" | "conflict" | "error" {
  if (!existsSync(staged)) { console.error(`no such staged note: ${staged}`); return "error"; }
  // A clean refusal, not a raw EISDIR stack from readFileSync below: --apply takes ONE staged note.
  if (statSync(staged).isDirectory()) { console.error(`  ✗ ${staged}: is a directory - --apply takes a single staged note file`); return "error"; }
  // Strip a single leading UTF-8 BOM (﻿) before any parsing. A PowerShell Out-File / Notepad
  // -authored note begins with one, which would otherwise sit before `---`, defeat frontmatter(), and
  // make a valid note refuse with a misleading "no type:". The hash + filed bytes use the stripped
  // text so the note never carries the BOM forward.
  const text = readFileSync(staged, "utf8").replace(/^﻿/, "");
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
  const slug = deriveSlug([fmScalar(fm, "slug"), title, basename(staged, ".md")]);
  if (!slug) { console.error(`  ✗ ${staged}: can't derive a slug - slug:, the H1 title, and the filename all slugify to nothing`); return "error"; }

  // The snapshot hash is over the ORIGINAL staged bytes (the verbatim provenance copy).
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const noteRel = `${folder}/${slug}`;
  const notePath = join(vault, `${noteRel}.md`);

  // The filed note must carry a `source:` wikilink back at the snapshot the apply records, or
  // `imprnt check`'s coverage scan flags that manifest raw entry as an uncovered snapshot forever
  // (no note points back at it). If the plugin already supplied its own `source:`, we keep the note's
  // content verbatim and DON'T duplicate it; in that case we make the manifest raw entry agree with the
  // note's existing source: instead of the fresh snapshot, so the entry and the note still point at the
  // same raw path and check reports it covered. If there is no source:, we inject one pointing at the
  // raw/proposed snapshot. Either way: exactly one raw entry, exactly one note source:, and they agree.
  //
  // The provenance target is decided BEFORE the injection: identical bytes may already have a
  // snapshot under a DIFFERENT slug (the same staged content applied from another filename), and the
  // injected link must point at the snapshot that actually exists, never at a fresh name the reuse
  // branch then declines to write.
  const stagedSource = fmScalar(fm, "source");
  const manifest = loadManifest(vault);
  const priorSnapshot = Object.values(manifest).find((e) => e.hash === hash && e.raw && existsSync(e.raw))?.raw;
  const rawDir = join(vault, "..", "raw", "proposed");
  // Only the no-source case writes (or reuses) a raw/proposed snapshot - that snapshot is the
  // provenance we inject a source: at. When the staged note already carries its OWN source:, that
  // source IS the provenance, so writing a raw/proposed file here would strand it on disk: nothing
  // (no manifest entry, no note source:) would reference it. In the stagedSource case we record the
  // note's own source as the manifest raw entry and write no snapshot at all.
  let rawPath = "";         // the physical snapshot path, "" in the own-source branch
  let rawEntry: string;     // the manifest raw entry, kept in agreement with the filed note's source:
  let sourceTarget: string; // the wikilink target the injected source: points at (no .md suffix)
  if (stagedSource) {
    rawEntry = linkSlug(stagedSource);
    sourceTarget = rawEntry;
  } else if (priorSnapshot) {
    rawPath = priorSnapshot;
    rawEntry = rawPath;
    sourceTarget = "raw/" + relative(join(vault, "..", "raw"), rawPath).split("\\").join("/").replace(/\.md$/, "");
  } else {
    rawPath = join(rawDir, `${slug}-${hash}.md`);
    rawEntry = rawPath;
    sourceTarget = `raw/proposed/${slug}-${hash}`;
  }
  const finalText = stagedSource ? text : injectSource(text, sourceTarget);
  // Idempotency keys on what we actually FILE (the note may now carry an injected source:), so a
  // re-apply of the same staged note still hashes to the same filed bytes and stays a clean no-op.
  const fileHash = createHash("sha256").update(finalText).digest("hex").slice(0, 16);

  // Idempotency + contradiction discipline. Same path + identical filed bytes -> no-op (re-applying is
  // free). Same path + DIFFERENT bytes -> we do NOT silently overwrite; we flag it for the contradiction
  // workflow (`> superseded by`), exactly as a hand-edit conflict would be handled.
  if (existsSync(notePath)) {
    const existingHash = createHash("sha256").update(readFileSync(notePath, "utf8")).digest("hex").slice(0, 16);
    if (existingHash === fileHash) {
      console.log(`  = ${noteRel} already filed, identical content (hash ${fileHash}) — no-op`);
      // The staged copy is redundant once the vault note matches it byte-for-byte; clear it.
      rmSync(staged);
      return "noop";
    }
    console.error(`  ! ${noteRel} exists with DIFFERENT content — not overwriting (contradiction discipline)`);
    flagNeedsReview(vault, `- [ ] proposed note conflicts with existing [[${noteRel}]] — staged at \`${staged}\` (hash ${fileHash} vs ${existingHash}); reconcile or stamp \`> superseded by\``);
    return "conflict";
  }

  // Snapshot the staged note into raw/ for provenance, reusing the same content-addressed scheme as
  // the bytes path: identical bytes never collide, distinct bytes never clobber, reuse an existing
  // snapshot. The key is namespaced by kind (never shares a slot with a `bytes:sha256:...` ingest of
  // byte-identical content) AND by the filed note: identical bytes applied under two different
  // filenames are two filings sharing one snapshot, and a bare `apply:sha256:<hash>` key would let
  // the second filing silently overwrite the first one's provenance row.
  const manifestKey = `apply:sha256:${hash}:${noteRel}`;
  if (!stagedSource && !priorSnapshot) {
    mkdirSync(rawDir, { recursive: true });
    // Snapshot the ORIGINAL staged bytes verbatim - the injected source: lives only in the filed note.
    if (!existsSync(rawPath)) writeFileSync(rawPath, text);
  }
  // Record provenance BEFORE filing the note (atomic-ish ordering): if the note write fails, the
  // manifest still tracks the snapshot, instead of stranding a raw file nothing references.
  manifest[manifestKey] = { hash, note: notePath, ingested: new Date().toISOString(), raw: rawEntry };
  saveManifest(vault, manifest);

  // File the note (mechanical — type/domain already decided).
  mkdirSync(join(vault, folder), { recursive: true });
  writeFileSync(notePath, finalText);

  // Resolve participants/links the same way the transcript path does: an unresolved person -> needs-review.
  // We only auto-resolve PEOPLE (the resolver's domain); other wikilink targets are checked by `imprnt check`.
  // participants may be a LIST (`["[[people/a]]", "[[people/b]]"]`) or a SCALAR (`"[[people/ghost]]"`).
  // fmList only captures the bracketed-list form, so a scalar would yield [] and the missing person would
  // never be flagged inline at apply (check catches it later, an inconsistency). Fall back to the scalar.
  const participantsList = fmList(fm, "participants");
  const participantsScalar = participantsList.length ? "" : fmScalar(fm, "participants");
  const participants = (participantsScalar ? [participantsScalar] : participantsList).map(linkSlug);
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
  // No raw/proposed snapshot is written when the note brought its own source: - report that source as the
  // provenance instead, so the line never prints an undefined path.
  if (stagedSource) console.log(`     source -> ${rawEntry}  (note's own source: kept - no redundant snapshot)`);
  else console.log(`     snapshot -> ${rawPath}${priorSnapshot ? "  (reused — identical bytes already snapshotted)" : ""}`);
  console.log(`     staged copy removed: ${staged}`);
  if (unresolved) console.log(`     ⚠ ${unresolved} unresolved person link(s) -> needs-review`);
  return "filed";
}

// Dispatch the apply modes before the shape-agnostic ingest path. `--apply <file>` files one staged
// note; `--apply-all` globs plugins/*/proposed/*.md (convention discovery) and files each uniformly.
{
  const a = process.argv.slice(2);
  let applyVault = process.env.IMPRNT_VAULT ?? process.env.IMPRINT_VAULT ?? "./vault";
  for (let i = 0; i < a.length; i++) if (a[i] === "--vault") {
    const v = a[++i];
    if (v === undefined) { console.error("--vault requires a directory argument"); process.exit(1); }
    applyVault = v;
  }

  if (a.includes("--apply-all")) {
    if (!existsSync(applyVault)) { console.error(`no vault at ${applyVault} — run \`imprnt init\` first`); process.exit(1); }
    // Glob the user's PROJECT plugins/, where `plugin add` copies installed plugins (not the package).
    const pluginsDir = join(projectRoot(), "plugins");
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
      // One bad staged note must not abort the batch: report it per-file, keep filing the rest,
      // and let the summary line + non-zero exit carry the failure.
      let r: ReturnType<typeof applyStaged>;
      try { r = applyStaged(s, applyVault); }
      catch (e) { console.error(`  ✗ ${s}: ${e instanceof Error ? e.message : String(e)}`); r = "error"; }
      if (r === "filed") filed++; else if (r === "noop") noop++; else if (r === "conflict") conflict++; else error++;
    }
    console.log(`\n${filed} filed, ${noop} no-op, ${conflict} conflict, ${error} error.`);
    process.exit(conflict + error ? 1 : 0);
  }

  const applyIdx = a.indexOf("--apply");
  if (applyIdx >= 0) {
    const file = a[applyIdx + 1];
    if (!file || file.startsWith("--")) { console.error("usage: imprnt ingest --apply <file> [--vault DIR]"); process.exit(1); }
    if (!existsSync(applyVault)) { console.error(`no vault at ${applyVault} — run \`imprnt init\` first`); process.exit(1); }
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
let vault = process.env.IMPRNT_VAULT ?? process.env.IMPRINT_VAULT ?? "./vault";
let inlineText: string | undefined;
let useStdin = false;
let slugHint = "";
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--vault") {
    const v = args[++i];
    if (v === undefined) { console.error("--vault requires a directory argument"); process.exit(1); }
    vault = v;
  }
  else if (args[i] === "--text") inlineText = args[++i];
  else if (args[i] === "--stdin") useStdin = true;
  else if (args[i] === "--slug") slugHint = args[++i];
  else positional.push(args[i]);
}

let src: string;       // a human-readable origin label (path, or "<text>" / "<stdin>")
let text: string;      // the source decoded for PARSING (speakers, date, subject)
let srcBytes: Buffer;  // the source BYTES - hashing must be byte-faithful: a lossy utf8 decode of a
                       // binary (PNG/PDF) hashes to something matching neither source nor snapshot,
                       // so provenance could never be verified. For valid UTF-8 text the byte hash
                       // is identical to the old string hash, so existing manifests stay stable.
let isFile = false;
if (useStdin) {
  srcBytes = readFileSync(0); // read all of stdin (fd 0) to EOF, sync — no Bun, no await
  text = srcBytes.toString("utf8");
  src = "<stdin>";
} else if (inlineText !== undefined) {
  text = inlineText;
  srcBytes = Buffer.from(text, "utf8");
  src = "<text>";
} else {
  const arg = positional[0];
  if (!arg) {
    console.error('usage: imprnt ingest <file|text> [--text "<bytes>"] [--stdin] [--slug S] [--vault DIR]');
    process.exit(1);
  }
  if (existsSync(arg)) {
    if (statSync(arg).isDirectory()) {
      // A clean refusal, not a raw EISDIR stack: ingest takes ONE file, snapshot mirrors trees.
      console.error(`${arg} is a directory - ingest takes a single file; mirror a tree with \`imprnt snapshot ${arg} --dest <name>\``);
      process.exit(1);
    }
    srcBytes = readFileSync(arg);
    text = srcBytes.toString("utf8");
    src = arg;
    isFile = true;
  }
  else if (looksLikePath(arg)) {
    // The arg is shaped like a file path (has a separator or a known extension) but does not exist.
    // Treating it as inline text would silently snapshot the literal path string as content, hiding a
    // typo. Error instead. A genuine inline dump has no path-like shape and still falls through below.
    console.error(`no such file: ${arg}`);
    process.exit(1);
  }
  else { text = arg; srcBytes = Buffer.from(text, "utf8"); src = "<text>"; } // not a path -> the arg IS the source bytes (an inline fact)
}
if (!text.trim()) { console.error("empty source — nothing to ingest"); process.exit(1); }

// --- delta manifest (incremental — skip unchanged sources) -----------------
// File sources key on their path; bytes sources (inline/stdin) have no path, so key on the content
// hash itself — reingesting identical bytes stays a no-op either way. The bytes key is NAMESPACED
// (`bytes:sha256:...`) so it can never collide with an `--apply` entry of identical bytes
// (`apply:sha256:...`), which would otherwise clobber the other's provenance under a shared key.
const hash = createHash("sha256").update(srcBytes).digest("hex").slice(0, 16);
const manifestKey = isFile ? src : `bytes:sha256:${hash}`;
const manifest = loadManifest(vault);
// The fast-skip trusts the manifest hash, but only if the artifacts it names are still on disk: the
// derived note (when one was filed - an unclassified source records an empty note) AND the raw
// snapshot. If either was deleted, skipping would name a vanished note and never re-create it (and an
// unclassified source whose snapshot is gone has unrecoverable provenance). So fall through to
// re-snapshot/re-file instead. Mirrors snapshot.ts's `&& existsSync(rawPath)` guard.
const prior = manifest[manifestKey];
if (prior?.hash === hash && (!prior.note || existsSync(prior.note)) && (!prior.raw || existsSync(prior.raw))) {
  console.log(`unchanged (hash ${hash}) — skipping ${src}. note: ${prior.note}`);
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
// Email header keys. `From:`/`To:`/`Cc:` etc. otherwise match the speaker pattern, so a plain email
// (From: a@b.com / To: c@d.com) would be miscounted as a 2-speaker transcript and fabricated into a
// bogus event with participants [[people/from]] / [[people/to]]. We exclude these from speaker
// detection (case-insensitive) so an email is not a transcript and falls to snapshot + needs-review.
const EMAIL_HEADER_KEYS = new Set(["from", "to", "cc", "bcc", "reply-to", "sent"]);
const EMAIL_HEADER = /^([A-Za-z][A-Za-z-]*):\s/;
// A speaker label is a SHORT capitalized name (1 to 3 words, letters/spaces/.'-) followed by a colon.
// Keeping it short and word-bounded stops a sentence fragment that happens to contain a colon
// ("I think: ...", "Note: long prose ...") from being mistaken for a speaker turn.
const SPEAKER = /^([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}):\s+\S.*$/;
const speakers = new Set<string>();
const turnsBySpeaker = new Map<string, number>(); // per-speaker turn count -> "did a speaker recur"
let subject = "";
let turnCount = 0;
let contentLines = 0; // non-empty lines that are NOT a parsed meta/email header (the "shape" denominator)
for (const line of lines) {
  const meta = line.match(META);
  if (meta && META_KEYS.has(meta[1].trim().toLowerCase())) {
    // A meta line is parsed (subject -> title) and skipped so a header is never counted as a
    // speaker, but its mere presence is NOT transcript evidence - see looksLikeTranscript above.
    const key = meta[1].trim().toLowerCase();
    if ((key === "subject" || key === "topic") && !subject) subject = meta[2].trim();
    continue;
  }
  // Skip email header lines (From:/To:/Cc:/...) before the speaker check so an email is never read as
  // a 2-speaker transcript. The `From`/`To` keys are not meta keys, so without this they would slip
  // through to SPEAKER below and fabricate [[people/from]] / [[people/to]] participants.
  const eh = line.match(EMAIL_HEADER);
  if (eh && EMAIL_HEADER_KEYS.has(eh[1].toLowerCase())) continue;
  // From here the line is body content (not a meta/email header). A blank line is structure, not
  // content, so it is excluded from the denominator the shape test divides by.
  if (line.trim()) contentLines++;
  const m = line.match(SPEAKER);
  if (!m) continue;
  const who = m[1].trim();
  speakers.add(who);
  turnsBySpeaker.set(who, (turnsBySpeaker.get(who) ?? 0) + 1);
  turnCount++;
}
const recurringSpeaker = [...turnsBySpeaker.values()].some((n) => n >= 2);
const isTranscript = isFile && looksLikeTranscript(speakers, turnCount, contentLines, recurringSpeaker);

// --- snapshot the source into raw/ (verbatim, immutable) -------------------
// Universal first move for EVERY source (file OR inline bytes): write the bytes into raw/ so any
// claim stays traceable to its origin and a schema change is just a `reingest` over raw/. The name
// is content-addressed (`<date>-<slug>-<hash>`), so identical bytes never collide and distinct bytes
// never clobber — no disambiguation dance needed. Reuse an existing snapshot of these exact bytes.
const slugBasis = slugHint || subject || [...speakers].join("-") || (isFile ? basename(src, extname(src)) : text.slice(0, 60));
// Fall back on the SLUGIFIED result being empty, not on slugBasis being falsy. All-non-Latin text
// (e.g. Cyrillic) is truthy yet slugifies to "" once non-[a-z0-9] is stripped, so a basis-level OR
// would short-circuit on the truthy source and leave a leading-hyphen name. Compute, then default.
const subjectSlug = slugify(slugBasis) || "source";
const noteSlug = `${date}-${subjectSlug}`;
// raw/ is keyed by source: a transcript file is a dated dump -> raw/transcripts/; a non-transcript
// file or loose bytes is unclassified -> raw/adhoc/ (it still gets the full snapshot + provenance).
const rawDir = join(vault, "..", "raw", isTranscript ? "transcripts" : "adhoc");

const priorSnapshot = Object.values(manifest).find((e) => e.hash === hash && e.raw && existsSync(e.raw))?.raw;
let rawPath: string;
if (priorSnapshot) {
  rawPath = priorSnapshot;
} else {
  const ext = isFile ? extname(src) || ".txt" : ".md";
  const rawName = isFile ? `${date}-${subjectSlug}-${hash}${ext}` : `${subjectSlug}-${hash}${ext}`;
  rawPath = join(rawDir, rawName);
  // A failed snapshot write (a read-only raw/, disk trouble) is a clean one-line abort, not a stack.
  try {
    mkdirSync(rawDir, { recursive: true });
    if (!existsSync(rawPath)) {
      if (isFile) copyFileSync(src, rawPath); // byte-faithful for every kind, including binaries
      else writeFileSync(rawPath, text);
    }
  } catch (e) {
    console.error(`cannot write snapshot ${rawPath}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
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
  console.log(`  (from vault/_tags.md) + kind, and link >=1 existing entity. Then \`imprnt check\`.`);
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
  "summary:                      # LLM writes one line — `imprnt check` reads it to build index.md",
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

// The effective slug/path. These start at the date+subject slug and only change if that slug already
// holds a DIFFERENT source, in which case we disambiguate (below) so the new source gets its own note.
let effectiveSlug = noteSlug;
let notePath = join(dir, `${noteSlug}.md`);

// Re-ingest + collision discipline. If a note ALREADY exists at this slug, two distinct things can be
// true and they need DIFFERENT handling, so we compare the NEW source bytes against the source the
// existing note was built from (its recorded `source_hash:`):
//   - hashes MATCH   -> same source, identical bytes. This rarely reaches here (the manifest skip
//     above catches an unchanged source), so treat it as a benign no-op and just refresh provenance.
//   - hashes DIFFER  -> the slug is a COLLISION: a different source maps to the same date+subject
//     slug (two different meetings titled the same on the same day, OR the same source re-ingested
//     with edited bytes). Either way the existing note may carry LLM enrichment we must NOT destroy,
//     AND the new source is a distinct transcript that must NOT be lost. So we file the NEW source
//     under a DISAMBIGUATED slug (`<slug>-<first 8 of hash>`), point the new source's manifest entry
//     at the NEW note, and surface a slug-collision needs-review line. No overwrite, no "source
//     changed" misdiagnosis - the new source is its own note, the existing note is untouched.
if (existsSync(notePath)) {
  const existingFm = frontmatter(readFileSync(notePath, "utf8"));
  const existingSourceHash = fmScalar(existingFm, "source_hash");
  if (existingSourceHash && existingSourceHash === hash) {
    // Same source bytes already filed at this slug. Refresh provenance and leave the note alone.
    manifest[manifestKey] = { hash, note: notePath, ingested: new Date().toISOString(), raw: rawPath };
    saveManifest(vault, manifest);
    console.log(`= ${src}: event note already filed from identical bytes (hash ${hash}) — no-op`);
    console.log(`  note kept   -> ${notePath}`);
    process.exit(0);
  }
  // Differing (or unreadable) source_hash -> a genuine slug collision. Disambiguate the new note.
  effectiveSlug = `${noteSlug}-${hash.slice(0, 8)}`;
  notePath = join(dir, `${effectiveSlug}.md`);
  flagNeedsReview(vault, `- [ ] slug collision: existing [[events/${noteSlug}]] vs new [[events/${effectiveSlug}]] (hash ${hash}); two different sources mapped to the same date+subject slug — reconcile`);
  console.log(`! ${src}: slug \`events/${noteSlug}\` already holds a different source -> filing new note under \`events/${effectiveSlug}\``);
  console.log(`  existing note kept untouched -> ${join(dir, `${noteSlug}.md`)}`);
  // The disambiguated slug uses only the first 8 hex of the source hash (32 bits), but source_hash
  // and the manifest carry the full hash. So if the disambiguated note already exists we must NOT
  // assume it is these exact bytes: read its recorded source_hash and compare the FULL hash, exactly
  // as the base-slug branch above does.
  //   - full hashes MATCH   -> genuine no-op, these exact bytes were already filed here (idempotent
  //     re-ingest). Refresh provenance and leave the note alone.
  //   - full hashes DIFFER  -> an astronomically rare hash8 collision between two DISTINCT sources.
  //     The second source still needs its OWN note, so step to the next numbered slot (-2, -3, ...)
  //     and check again. Never no-op onto or overwrite the other source's note.
  let counter = 1;
  while (existsSync(notePath)) {
    const existingDisambigHash = fmScalar(frontmatter(readFileSync(notePath, "utf8")), "source_hash");
    if (existingDisambigHash === hash) {
      manifest[manifestKey] = { hash, note: notePath, ingested: new Date().toISOString(), raw: rawPath };
      saveManifest(vault, manifest);
      console.log(`  disambiguated note already exists from identical bytes -> ${notePath}  (no-op)`);
      process.exit(0);
    }
    // A distinct source already holds this disambiguated slug (hash8 collision) -> next numbered slot.
    counter++;
    effectiveSlug = `${noteSlug}-${hash.slice(0, 8)}-${counter}`;
    notePath = join(dir, `${effectiveSlug}.md`);
    console.log(`  hash8 collision with a distinct source -> trying \`events/${effectiveSlug}\` instead`);
  }
}

writeFileSync(notePath, note);

manifest[manifestKey] = { hash, note: notePath, ingested: new Date().toISOString(), raw: rawPath };
saveManifest(vault, manifest);

// --- resolve participants (deterministic): flag unknown people to needs-review ---
const unresolved = [...speakers].filter((name) => !personResolved(vault, slugify(name), name));
for (const name of unresolved) {
  flagNeedsReview(vault, `- [ ] unresolved person \`${name}\` — from [[events/${effectiveSlug}]] (${date})`);
}

console.log(`ingested ${src}`);
console.log(`  snapshot -> ${rawPath}${priorSnapshot ? "  (reused — identical bytes already snapshotted)" : "  (immutable)"}`);
console.log(`  note     -> ${notePath}  (${speakers.size} participants, ${turnCount} turns)`);
if (unresolved.length) console.log(`  ⚠ ${unresolved.length} unresolved participant(s) -> needs-review: ${unresolved.join(", ")}`);
console.log(`  deterministic skeleton only. next (the one LLM step): the agent fills`);
console.log(`  summary + Summary/Decisions/Actions/Questions, assigns tags from vault/_tags.md,`);
console.log(`  and links people + projects (resolving the flagged participants). Then \`imprnt check\`.`);
