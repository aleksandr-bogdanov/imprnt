import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "cli.ts");

// One temp workspace per test. Layout mirrors `imprnt init`: a vault/ with the form folders we need
// plus a sibling raw/. We pass --vault explicitly so nothing touches the real repo vault.
function setup(): { root: string; vault: string; raw: string } {
  const root = mkdtempSync(join(tmpdir(), "imprnt-test-"));
  const vault = join(root, "vault");
  const raw = join(root, "raw");
  for (const d of ["people", "events", "orgs", "holdings", "identity", "health", "finances", "work", "life", "projects", "mistakes"]) {
    mkdirSync(join(vault, d), { recursive: true });
  }
  mkdirSync(raw, { recursive: true });
  return { root, vault, raw };
}

function run(args: string[], opts: { cwd?: string } = {}) {
  const r = Bun.spawnSync(["bun", CLI, ...args], { cwd: opts.cwd ?? here });
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
  };
}

const TRANSCRIPT_2SPK = `subject: Q3 planning
date: 2025-03-04
Alice: kicking off, here is the agenda.
Bob: sounds good, I have one concern.
Alice: go ahead.
`;

function needsReview(vault: string): string {
  const p = join(vault, "_needs-review.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

// --- happy path: a real 2-speaker transcript -> correct event skeleton ---------------------------
test("2-speaker transcript writes a correct event skeleton", () => {
  const { vault } = setup();
  const src = join(vault, "..", "t.txt");
  writeFileSync(src, TRANSCRIPT_2SPK);

  const r = run(["ingest", src, "--vault", vault]);
  expect(r.code).toBe(0);

  const notePath = join(vault, "events", "2025-03-04-q3-planning.md");
  expect(existsSync(notePath)).toBe(true);
  const note = readFileSync(notePath, "utf8");
  expect(note).toContain("type: event");
  expect(note).toContain("date: 2025-03-04");
  expect(note).toContain("status: draft-deterministic");
  expect(note).toContain("[[people/alice]]");
  expect(note).toContain("[[people/bob]]");
  // source is a wikilink into the immutable snapshot
  expect(note).toMatch(/source: "\[\[raw\/transcripts\//);
});

// --- bug 1: re-ingest a CHANGED transcript -> existing enriched note PRESERVED, new bytes get their
// OWN note under a disambiguated slug, collision flagged. (Corrected round-2 behavior: edited bytes
// at the same slug are a distinct source, so they are filed separately, not claimed as the same source
// "changing". This is more honest - it never silently strands the new version.) ------------------
test("re-ingesting a changed transcript preserves the enriched note and files the new bytes under a disambiguated slug", () => {
  const { vault } = setup();
  const src = join(vault, "..", "t.txt");
  writeFileSync(src, TRANSCRIPT_2SPK);
  expect(run(["ingest", src, "--vault", vault]).code).toBe(0);

  const notePath = join(vault, "events", "2025-03-04-q3-planning.md");
  // Simulate the LLM enrichment pass: rewrite the note with real summary/tags/body.
  const enriched = readFileSync(notePath, "utf8")
    .replace("summary:", "summary: a hard-won decision")
    .replace("status: draft-deterministic", "status: enriched")
    + "\nENRICHED-BODY-MARKER\n";
  writeFileSync(notePath, enriched);

  // Change the SOURCE but keep the same slug-driving subject/date (stable slug).
  writeFileSync(src, TRANSCRIPT_2SPK + "Bob: one more thing, different now.\n");
  const r = run(["ingest", src, "--vault", vault]);

  // Non-fatal, clear message, existing note untouched.
  expect(r.code).toBe(0);
  const after = readFileSync(notePath, "utf8");
  expect(after).toContain("ENRICHED-BODY-MARKER");
  expect(after).toContain("status: enriched");
  expect(after).toContain("a hard-won decision");
  // The new bytes are filed under a disambiguated slug (same base, -<hash8> suffix), NOT lost.
  const events = readdirSync(join(vault, "events"));
  const disambig = events.find((f) => f.startsWith("2025-03-04-q3-planning-") && f.endsWith(".md"));
  expect(disambig).toBeDefined();
  // Honest needs-review: a slug collision to reconcile, NOT a "source changed" misdiagnosis.
  expect(needsReview(vault)).toContain("slug collision");
  expect(needsReview(vault)).not.toContain("source changed for existing note");
  // Manifest hash updated to the new source bytes, and its note points at the NEW disambiguated note.
  const manifest = JSON.parse(readFileSync(join(vault, ".manifest.json"), "utf8"));
  expect(manifest[src]).toBeDefined();
  expect(manifest[src].note).toBe(join(vault, "events", disambig!));
});

// --- finding 1: two DIFFERENT transcripts, SAME date+subject -> both notes exist, manifest for the
// 2nd points at the 2nd (correct) note, collision flagged, existing note unchanged ----------------
test("two different transcripts with the same date+subject each get their own note", () => {
  const { vault } = setup();
  const srcA = join(vault, "..", "a.txt");
  const srcB = join(vault, "..", "b.txt");
  // Same subject + date, DIFFERENT participants and content.
  writeFileSync(srcA, "subject: sync\ndate: 2025-07-01\nAlice: first meeting.\nBob: yes.\n");
  writeFileSync(srcB, "subject: sync\ndate: 2025-07-01\nCarol: different meeting.\nDave: indeed.\n");

  expect(run(["ingest", srcA, "--vault", vault]).code).toBe(0);
  const noteA = join(vault, "events", "2025-07-01-sync.md");
  expect(existsSync(noteA)).toBe(true);
  const beforeA = readFileSync(noteA, "utf8");
  expect(beforeA).toContain("[[people/alice]]");

  // Second, distinct transcript collides on the slug.
  const r = run(["ingest", srcB, "--vault", vault]);
  expect(r.code).toBe(0);

  // First note unchanged (still Alice/Bob, not overwritten with Carol/Dave).
  expect(readFileSync(noteA, "utf8")).toBe(beforeA);

  // Second note exists under a disambiguated slug with the CORRECT (Carol/Dave) content.
  const events = readdirSync(join(vault, "events"));
  const disambig = events.find((f) => f.startsWith("2025-07-01-sync-") && f.endsWith(".md"));
  expect(disambig).toBeDefined();
  const noteB = readFileSync(join(vault, "events", disambig!), "utf8");
  expect(noteB).toContain("[[people/carol]]");
  expect(noteB).toContain("[[people/dave]]");
  expect(noteB).not.toContain("[[people/alice]]");

  // Manifest entry for source B points at the NEW note.
  const manifest = JSON.parse(readFileSync(join(vault, ".manifest.json"), "utf8"));
  expect(manifest[srcB].note).toBe(join(vault, "events", disambig!));
  // Collision surfaced for reconciliation.
  expect(needsReview(vault)).toContain("slug collision");
});

// --- round-3 finding: the DISAMBIGUATED no-op path must verify the FULL source_hash, not just that
// a file exists at <slug>-<hash8>. We cannot practically force a real hash8 collision, so we test the
// two reachable invariants the source_hash compare protects:
//   (a) re-ingesting the SAME second (colliding) source is a clean idempotent no-op - manifest stable,
//       the disambiguated note unchanged, no extra note created.
//   (b) a THIRD distinct source colliding on the SAME base slug gets its OWN distinct note (its own
//       hash8 suffix), not misfiled onto either prior note, with its manifest entry + source_hash
//       pointing at its own note.
// A regression where the disambiguated branch no-ops on existsSync WITHOUT comparing source_hash would
// still pass (a) by luck (same bytes -> same hash8 file -> existsSync true -> no-op), but the compare
// is what makes (a) CORRECT rather than accidental: under a real hash8 collision the un-checked branch
// would point a distinct source's manifest at the wrong note and never write its bytes. (b) exercises
// the surrounding base-slug disambiguation that the same source_hash helper drives, confirming three
// distinct same-slug sources each keep their own note + manifest row.
test("disambiguated path is idempotent for the same colliding source and gives a third distinct source its own note", () => {
  const { vault } = setup();
  const srcA = join(vault, "..", "a.txt");
  const srcB = join(vault, "..", "b.txt");
  const srcC = join(vault, "..", "c.txt");
  // Same subject + date -> same base slug. DIFFERENT bytes -> three distinct sources.
  writeFileSync(srcA, "subject: standup\ndate: 2025-09-09\nAlice: one.\nBob: two.\n");
  writeFileSync(srcB, "subject: standup\ndate: 2025-09-09\nCarol: three.\nDave: four.\n");
  writeFileSync(srcC, "subject: standup\ndate: 2025-09-09\nEve: five.\nFrank: six.\n");

  expect(run(["ingest", srcA, "--vault", vault]).code).toBe(0);
  expect(run(["ingest", srcB, "--vault", vault]).code).toBe(0); // B disambiguated onto -<hash8>

  const baseNote = join(vault, "events", "2025-09-09-standup.md");
  expect(existsSync(baseNote)).toBe(true);
  const eventsAfterB = readdirSync(join(vault, "events")).filter((f) => f.endsWith(".md")).sort();
  expect(eventsAfterB.length).toBe(2); // base + B disambiguated
  const bDisambig = eventsAfterB.find((f) => f !== "2025-09-09-standup.md")!;
  const bNoteBefore = readFileSync(join(vault, "events", bDisambig), "utf8");

  const manifestBefore = JSON.parse(readFileSync(join(vault, ".manifest.json"), "utf8"));
  const bEntryBefore = manifestBefore[srcB];
  expect(bEntryBefore.note).toBe(join(vault, "events", bDisambig));

  // (a) Re-ingest the SAME colliding source B. The delta-manifest skip catches an UNCHANGED file
  // source, so to actually exercise the disambiguated note write-path we drop B's manifest row first,
  // forcing the code back through the slug-collision branch. It must land on the SAME disambiguated
  // note (full source_hash matches) and no-op, not create a second copy or misfile.
  const manifestNoB = { ...manifestBefore };
  delete manifestNoB[srcB];
  writeFileSync(join(vault, ".manifest.json"), JSON.stringify(manifestNoB, null, 2));

  const rReB = run(["ingest", srcB, "--vault", vault]);
  expect(rReB.code).toBe(0);
  expect(rReB.out.toLowerCase()).toContain("no-op");
  // No extra note created, the disambiguated note is byte-identical, manifest re-points at the same note.
  expect(readdirSync(join(vault, "events")).filter((f) => f.endsWith(".md")).length).toBe(2);
  expect(readFileSync(join(vault, "events", bDisambig), "utf8")).toBe(bNoteBefore);
  const manifestAfterReB = JSON.parse(readFileSync(join(vault, ".manifest.json"), "utf8"));
  expect(manifestAfterReB[srcB].note).toBe(join(vault, "events", bDisambig));

  // (b) A THIRD distinct source on the same base slug gets its OWN note, not misfiled onto base or B.
  const rC = run(["ingest", srcC, "--vault", vault]);
  expect(rC.code).toBe(0);
  const eventsAfterC = readdirSync(join(vault, "events")).filter((f) => f.endsWith(".md")).sort();
  expect(eventsAfterC.length).toBe(3); // base + B + C, all distinct
  const cDisambig = eventsAfterC.find((f) => f !== "2025-09-09-standup.md" && f !== bDisambig)!;
  const cNote = readFileSync(join(vault, "events", cDisambig), "utf8");
  expect(cNote).toContain("[[people/eve]]");
  expect(cNote).toContain("[[people/frank]]");
  expect(cNote).not.toContain("[[people/carol]]");
  expect(cNote).not.toContain("[[people/alice]]");
  // C's recorded source_hash is its own, distinct from B's.
  const cHash = cNote.match(/^source_hash:\s*(\S+)$/m)![1];
  const bHash = readFileSync(join(vault, "events", bDisambig), "utf8").match(/^source_hash:\s*(\S+)$/m)![1];
  expect(cHash).not.toBe(bHash);
  // C's manifest entry points at C's own note with C's own hash, B's row untouched.
  const manifestAfterC = JSON.parse(readFileSync(join(vault, ".manifest.json"), "utf8"));
  expect(manifestAfterC[srcC].note).toBe(join(vault, "events", cDisambig));
  expect(manifestAfterC[srcC].hash).toBe(cHash);
  expect(manifestAfterC[srcB].note).toBe(join(vault, "events", bDisambig));
});

// --- finding 2: an email (From:/To:/Subject:) is NOT a transcript -> snapshot + needs-review, no
// fabricated event with [[people/from]] / [[people/to]] participants ------------------------------
test("an email is not detected as a transcript and gets no fabricated event note", () => {
  const { vault } = setup();
  const src = join(vault, "..", "mail.txt");
  writeFileSync(src, "From: a@b.com\nTo: c@d.com\nSubject: quick question\n\nCan you send me the report by Friday? Thanks.\n");
  const r = run(["ingest", src, "--vault", vault]);
  expect(r.code).toBe(0);
  // No event note fabricated.
  const events = readdirSync(join(vault, "events"));
  expect(events.length).toBe(0);
  // Snapshotted + handed to the LLM via needs-review.
  expect(needsReview(vault)).toContain("unclassified source");
  // No bogus people/from or people/to anywhere.
  expect(needsReview(vault)).not.toContain("people/from");
  expect(needsReview(vault)).not.toContain("people/to");
});

// --- round-3 finding 2: a dense glossary / term-list (every line `Term: definition`, each label
// appearing exactly ONCE) is NOT a transcript. No speaker recurs and there is no back-and-forth, so
// it must route to snapshot + unclassified handoff, not a fabricated event with [[people/apple]] /
// [[people/banana]] / [[people/cherry]] participants. A real dialogue has a recurring speaker (or is
// the minimal two-speaker, two-turn exchange); a glossary has many single-appearance labels. --------
test("a glossary where each label appears once is not detected as a transcript", () => {
  const { vault, raw } = setup();
  const src = join(vault, "..", "glossary.txt");
  writeFileSync(src, [
    "Apple: a fruit that grows on trees",
    "Banana: a long yellow fruit",
    "Cherry: a small red stone fruit",
  ].join("\n") + "\n");

  const r = run(["ingest", src, "--vault", vault]);
  expect(r.code).toBe(0);
  // No fabricated event with bogus fruit participants.
  expect(readdirSync(join(vault, "events")).length).toBe(0);
  // Snapshot + unclassified handoff fires; the snapshot files under adhoc, not transcripts.
  expect(needsReview(vault)).toContain("unclassified source");
  expect(needsReview(vault)).not.toContain("people/apple");
  expect(needsReview(vault)).not.toContain("people/banana");
  expect(needsReview(vault)).not.toContain("people/cherry");
  expect(existsSync(join(raw, "transcripts"))).toBe(false);
  expect(existsSync(join(raw, "adhoc"))).toBe(true);
});

// --- bug 2: snapshot --dest with ../ is rejected, nothing escapes raw/ ----------------------------
test("snapshot --dest with ../ is rejected and writes nothing outside raw/", () => {
  const { vault } = setup();
  const src = join(vault, "..", "x.txt");
  writeFileSync(src, "secret bytes");

  const r = run(["snapshot", src, "--dest", "../vault/people/PWNED", "--vault", vault]);
  expect(r.code).toBe(1);
  expect(r.err.toLowerCase()).toContain("escapes raw/");
  expect(existsSync(join(vault, "people", "PWNED"))).toBe(false);
  expect(existsSync(join(vault, "people", "PWNED.txt"))).toBe(false);
});

test("snapshot with a normal dest still works", () => {
  const { vault, raw } = setup();
  const src = join(vault, "..", "x.csv");
  writeFileSync(src, "a,b,c\n1,2,3\n");
  const r = run(["snapshot", src, "--dest", "tax-2025", "--vault", vault]);
  expect(r.code).toBe(0);
  expect(existsSync(join(raw, "tax-2025", "x.csv"))).toBe(true);
});

// --- bug 4: a non-transcript prose file -> no fabricated event note, snapshot + needs-review ------
test("non-transcript prose file gets no event note, just snapshot + needs-review", () => {
  const { vault } = setup();
  const src = join(vault, "..", "essay.txt");
  writeFileSync(src, "This is a paragraph of prose. It has no speakers.\nI think: this should not become a speaker.\nMore prose follows here.\n");

  const r = run(["ingest", src, "--vault", vault]);
  expect(r.code).toBe(0);
  // No event note fabricated.
  const events = readdirSync(join(vault, "events"));
  expect(events.length).toBe(0);
  // Snapshotted + handed to the LLM via needs-review.
  expect(needsReview(vault)).toContain("unclassified source");
});

// --- bug 5: a non-existent path arg errors with "no such file" -----------------------------------
test("a non-existent file path arg errors instead of being treated as text", () => {
  const { vault } = setup();
  const r = run(["ingest", "/tmp/does-not-exist-imprnt.txt", "--vault", vault]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("no such file");
  // Nothing snapshotted.
  expect(existsSync(join(vault, ".manifest.json"))).toBe(false);
});

test("a genuine inline-text fact (no path shape) still ingests as bytes", () => {
  const { vault } = setup();
  const r = run(["ingest", "Bob owes me 40 euros for lunch", "--vault", vault]);
  expect(r.code).toBe(0);
  expect(r.out.toLowerCase()).toContain("snapshot");
  expect(needsReview(vault)).toContain("unclassified source");
});

// --- [P3] cosmetic: all-non-Latin inline bytes (e.g. Cyrillic) slugify to "" once non-[a-z0-9] is
// stripped. The fallback must fire on the SLUGIFIED result being empty, not on the source text being
// falsy, so the raw snapshot is named with the "source" default rather than a leading-hyphen
// "-<hash>.md". Pre-fix the filename started with "-" because the basis was truthy Cyrillic. ---------
test("all-non-Latin inline bytes get a raw snapshot named with the source fallback, not a leading hyphen", () => {
  const { vault, raw } = setup();
  const r = run(["ingest", "Москва это город", "--vault", vault]);
  expect(r.code).toBe(0);

  // The adhoc raw snapshot exists and its filename does NOT start with a hyphen.
  const adhoc = join(raw, "adhoc");
  expect(existsSync(adhoc)).toBe(true);
  const snaps = readdirSync(adhoc).filter((f) => f.endsWith(".md"));
  expect(snaps.length).toBe(1);
  expect(snaps[0].startsWith("-")).toBe(false);
  expect(snaps[0].startsWith("source-")).toBe(true);

  // The manifest tracks the snapshot (raw points at the created file).
  const manifest = JSON.parse(readFileSync(join(vault, ".manifest.json"), "utf8"));
  const entry = Object.values(manifest).find((e: any) => e.raw && e.raw.endsWith(snaps[0])) as any;
  expect(entry).toBeDefined();
  expect(existsSync(entry.raw)).toBe(true);
});

// --- finding 3: inline text containing a slash (multi-word, has whitespace) is ingested as bytes,
// NOT refused as a missing path. A single-token slash path with no spaces still errors. ------------
test("inline text with a slash still ingests as bytes (not refused as a missing path)", () => {
  const { vault } = setup();
  const r = run(["ingest", "see foo/bar in the repo", "--vault", vault]);
  expect(r.code).toBe(0);
  expect(r.err).not.toContain("no such file");
  expect(r.out.toLowerCase()).toContain("snapshot");
  expect(needsReview(vault)).toContain("unclassified source");
});

test("a single-token mistyped slash path (no spaces) still errors", () => {
  const { vault } = setup();
  const r = run(["ingest", "nope/missing.txt", "--vault", vault]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("no such file");
});

// --- finding 4: a dangling --vault / --dest gives a clean error, not a raw TypeError --------------
test("ingest with a dangling --vault errors cleanly", () => {
  const { vault } = setup();
  const src = join(vault, "..", "t.txt");
  writeFileSync(src, TRANSCRIPT_2SPK);
  const r = run(["ingest", src, "--vault"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("--vault requires a directory argument");
  expect(r.err).not.toContain("TypeError");
});

test("snapshot with a dangling --vault errors cleanly", () => {
  const { vault } = setup();
  const src = join(vault, "..", "x.txt");
  writeFileSync(src, "bytes");
  const r = run(["snapshot", src, "--dest", "x", "--vault"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("--vault requires a directory argument");
  expect(r.err).not.toContain("TypeError");
});

test("snapshot with a dangling --dest errors cleanly", () => {
  const { vault } = setup();
  const src = join(vault, "..", "x.txt");
  writeFileSync(src, "bytes");
  const r = run(["snapshot", src, "--dest"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("--dest requires a path argument");
  expect(r.err).not.toContain("TypeError");
});

// --- bug 6: lowercase subject: is parsed into the slug/title -------------------------------------
test("lowercase subject: is parsed into slug and title", () => {
  const { vault } = setup();
  const src = join(vault, "..", "meet.txt");
  writeFileSync(src, "subject: budget review\ndate: 2025-05-01\nAlice: hi\nBob: hello\n");
  const r = run(["ingest", src, "--vault", vault]);
  expect(r.code).toBe(0);
  const notePath = join(vault, "events", "2025-05-01-budget-review.md");
  expect(existsSync(notePath)).toBe(true);
  expect(readFileSync(notePath, "utf8")).toContain("# budget review");
});

// --- bug 8: a sentence fragment ending in a colon is not a participant ----------------------------
test("a sentence fragment ending in a colon is not treated as a speaker", () => {
  const { vault } = setup();
  // Two real speakers plus a fragment line. Detector fires (2 speakers) but the fragment must not
  // appear as a participant.
  const src = join(vault, "..", "frag.txt");
  writeFileSync(src, "subject: chat\ndate: 2025-06-01\nAlice: I think: we should ship it now and iterate later.\nBob: agreed.\n");
  const r = run(["ingest", src, "--vault", vault]);
  expect(r.code).toBe(0);
  const note = readFileSync(join(vault, "events", "2025-06-01-chat.md"), "utf8");
  expect(note).not.toContain("people/i-think");
});

// --- bug 7: inline-bytes and --apply with identical bytes keep distinct manifest entries ----------
test("identical bytes from inline-ingest and --apply do not clobber each other in the manifest", () => {
  const { vault } = setup();
  // A staged note that is byte-identical to what we will also ingest as inline text.
  const shared = "---\ntype: note\ndomain: work\n---\n\n# shared bytes note\n\nbody text here\n";
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "n.md");
  writeFileSync(staged, shared);

  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);
  expect(run(["ingest", "--text", shared, "--vault", vault]).code).toBe(0);

  const manifest = JSON.parse(readFileSync(join(vault, ".manifest.json"), "utf8"));
  const keys = Object.keys(manifest);
  expect(keys.some((k) => k.startsWith("apply:sha256:"))).toBe(true);
  expect(keys.some((k) => k.startsWith("bytes:sha256:"))).toBe(true);
});

// --- CLEAN re-verify: --apply files into the type folder, then is idempotent ----------------------
test("--apply files a staged note and re-applying identical bytes is a no-op", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "alex.md");
  const content = "---\ntype: person\n---\n\n# Alex\n\nbio\n";
  writeFileSync(staged, content);

  const r1 = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r1.code).toBe(0);
  const filed = join(vault, "people", "alex.md");
  expect(existsSync(filed)).toBe(true);
  expect(existsSync(staged)).toBe(false); // staged removed on file

  // Re-stage identical bytes -> no-op, staged removed, vault note untouched.
  writeFileSync(staged, content);
  const r2 = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r2.code).toBe(0);
  expect(r2.out.toLowerCase()).toContain("no-op");
  expect(existsSync(staged)).toBe(false);
});

// --- regression: an applied note must carry a `source:` back-link to its raw/proposed snapshot, so
// `imprnt check`'s coverage scan does NOT flag that snapshot as an uncovered snapshot forever. Before
// the fix the note was filed verbatim with no source:, the manifest recorded the raw/proposed snapshot,
// and check saw a raw entry no note pointed back at -> the snapshot was listed under "uncovered
// snapshots" on every check run. After the fix the filed note carries `source: "[[raw/proposed/...]]"`
// and check reports it covered. Re-applying the same staged note stays a clean no-op. ---------------
test("--apply injects a source: back-link so check does not flag the snapshot as uncovered", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "alex.md");
  // A staged note with NO source: field (the broken path). It carries a tag so the only check signal
  // we are exercising is snapshot coverage, not the unrelated untagged check.
  const content = "---\ntype: person\ntags: [test]\n---\n\n# Alex\n\nbio\n";
  writeFileSync(staged, content);

  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);

  // The filed note carries a source: wikilink into its raw/proposed snapshot (no trailing .md).
  const filed = join(vault, "people", "alex.md");
  const note = readFileSync(filed, "utf8");
  expect(note).toMatch(/^source: "\[\[raw\/proposed\/[^\]]+\]\]"$/m);
  expect(note).not.toMatch(/\.md\]\]/); // wikilink target has no .md suffix

  // The manifest raw entry and the note's source: agree, so check reports the snapshot covered.
  const c = run(["check", "--vault", vault]);
  // The applied note's snapshot is NOT listed under uncovered snapshots.
  const snapshot = readdirSync(join(vault, "..", "raw", "proposed")).find((f) => f.endsWith(".md"))!;
  const snapBase = "raw/proposed/" + snapshot.replace(/\.md$/, "");
  expect(c.out).toContain("✓ every raw snapshot has a derived note");
  // Defensive: even if the headline copy changes, the snapshot path must not appear as uncovered.
  const uncoveredIdx = c.out.indexOf("uncovered snapshots");
  if (uncoveredIdx >= 0) expect(c.out.slice(uncoveredIdx)).not.toContain(snapBase);

  // Re-applying the same staged note is still a clean no-op (deterministic injected source:).
  writeFileSync(staged, content);
  const r2 = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r2.code).toBe(0);
  expect(r2.out.toLowerCase()).toContain("no-op");
  expect(existsSync(staged)).toBe(false);
});

// --- regression: a staged note that ALREADY has its own source: is filed verbatim (source: not
// duplicated) and the manifest raw entry agrees with it, so check still reports it covered. ---------
test("--apply keeps an existing source: verbatim and still reports the snapshot covered", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "beth.md");
  const content = '---\ntype: person\ntags: [test]\nsource: "[[raw/proposed/beth-custom]]"\n---\n\n# Beth\n\nbio\n';
  writeFileSync(staged, content);

  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);

  const note = readFileSync(join(vault, "people", "beth.md"), "utf8");
  // The single, original source: line is preserved - not duplicated.
  expect((note.match(/^source:/gm) ?? []).length).toBe(1);
  expect(note).toContain('source: "[[raw/proposed/beth-custom]]"');

  const c = run(["check", "--vault", vault]);
  const uncoveredIdx = c.out.indexOf("uncovered snapshots");
  if (uncoveredIdx >= 0) expect(c.out.slice(uncoveredIdx)).not.toContain("raw/proposed/beth-custom");
});

// --- finding (CRLF): a staged note with `\r\n` frontmatter is read correctly by --apply (its type is
// parsed, it is filed, a source: is injected/kept) and check reports it covered. Pre-fix the LF-only
// frontmatter() regex returned "", so type read empty and apply refused with "no type:". ------------
test("--apply reads a CRLF staged note, files it, injects source:, and check reports it covered", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "win.md");
  // A Windows-authored note: every line ends in CRLF, including the frontmatter fences.
  const content = ["---", "type: person", "tags: [test]", "---", "", "# Win", "", "bio"].join("\r\n") + "\r\n";
  writeFileSync(staged, content);

  const r = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r.code).toBe(0);
  // Type was read (not refused), so the note filed into people/.
  expect(r.err).not.toContain("no `type:`");
  const filed = join(vault, "people", "win.md");
  expect(existsSync(filed)).toBe(true);
  const note = readFileSync(filed, "utf8");
  // A source: back-link was injected. The injected line keeps the note's CRLF style (no lone LF mixed in).
  expect(note).toMatch(/^source: "\[\[raw\/proposed\/[^\]]+\]\]"\r$/m);

  // check reports the snapshot covered (manifest raw entry and the note's source: agree).
  const c = run(["check", "--vault", vault]);
  expect(c.out).toContain("✓ every raw snapshot has a derived note");
});

// --- finding 2: --apply of a note that supplies its OWN source: writes NO redundant raw/proposed
// snapshot, so no stranded file is left on disk. The manifest raw entry and the note's source: agree
// and check reports it covered. Pre-fix a raw/proposed/<slug>-<hash>.md was always written and then
// referenced by nothing. -------------------------------------------------------------------------
test("--apply of a note with its own source: leaves no orphaned raw/proposed snapshot", () => {
  const { vault, raw } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "carl.md");
  // The note points its source: at an existing raw artifact (the real provenance).
  const ownSource = "raw/adhoc/carl-origin";
  mkdirSync(join(raw, "adhoc"), { recursive: true });
  writeFileSync(join(raw, "adhoc", "carl-origin.md"), "origin bytes");
  const content = `---\ntype: person\ntags: [test]\nsource: "[[${ownSource}]]"\n---\n\n# Carl\n\nbio\n`;
  writeFileSync(staged, content);

  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);

  // No raw/proposed file was written at all - the note's own source is the provenance.
  const proposedRaw = join(raw, "proposed");
  const proposedFiles = existsSync(proposedRaw) ? readdirSync(proposedRaw) : [];
  expect(proposedFiles.length).toBe(0);

  // The filed note keeps its single original source: and the manifest entry agrees with it.
  const note = readFileSync(join(vault, "people", "carl.md"), "utf8");
  expect((note.match(/^source:/gm) ?? []).length).toBe(1);
  expect(note).toContain(`source: "[[${ownSource}]]"`);
  const manifest = JSON.parse(readFileSync(join(vault, ".manifest.json"), "utf8"));
  const applyKey = Object.keys(manifest).find((k) => k.startsWith("apply:sha256:"))!;
  expect(manifest[applyKey].raw).toBe(ownSource);

  // check reports it covered (no uncovered snapshot for this note).
  const c = run(["check", "--vault", vault]);
  const uncoveredIdx = c.out.indexOf("uncovered snapshots");
  if (uncoveredIdx >= 0) expect(c.out.slice(uncoveredIdx)).not.toContain(ownSource);
});

// --- CLEAN re-verify: --apply conflict refusal (different bytes -> kept, flagged, exit 1) ----------
test("--apply refuses to overwrite a note with different bytes", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "alex.md");
  writeFileSync(staged, "---\ntype: person\n---\n\n# Alex\n\nfirst\n");
  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);

  const filed = join(vault, "people", "alex.md");
  const before = readFileSync(filed, "utf8");
  // New staged note, same slug, DIFFERENT bytes.
  writeFileSync(staged, "---\ntype: person\n---\n\n# Alex\n\nSECOND DIFFERENT\n");
  const r = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r.code).toBe(1);
  expect(readFileSync(filed, "utf8")).toBe(before); // vault note untouched
  expect(existsSync(staged)).toBe(true); // staged kept
  expect(needsReview(vault)).toContain("conflicts with existing");
});

// --- CLEAN re-verify: folder routing (note + domain -> domain folder) -----------------------------
test("--apply routes a note with a domain into that domain folder", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "h.md");
  writeFileSync(staged, "---\ntype: note\ndomain: health\n---\n\n# Sleep hygiene\n\nbody\n");
  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);
  expect(existsSync(join(vault, "health", "sleep-hygiene.md"))).toBe(true);
});

// --- CLEAN re-verify: dir snapshot preserves the tree ---------------------------------------------
test("snapshot of a directory preserves the tree under raw/<dest>/", () => {
  const { vault, raw } = setup();
  const tree = join(vault, "..", "tree");
  mkdirSync(join(tree, "sub"), { recursive: true });
  writeFileSync(join(tree, "a.txt"), "a");
  writeFileSync(join(tree, "sub", "b.txt"), "b");
  const r = run(["snapshot", tree, "--dest", "mirror", "--vault", vault]);
  expect(r.code).toBe(0);
  expect(existsSync(join(raw, "mirror", "a.txt"))).toBe(true);
  expect(existsSync(join(raw, "mirror", "sub", "b.txt"))).toBe(true);
});

// --- CLEAN re-verify: empty-file rejection --------------------------------------------------------
test("an empty source is rejected", () => {
  const { vault } = setup();
  const src = join(vault, "..", "empty.txt");
  writeFileSync(src, "   \n");
  const r = run(["ingest", src, "--vault", vault]);
  expect(r.code).toBe(1);
  expect(r.err.toLowerCase()).toContain("empty source");
});

// --- happy: incremental skip on unchanged source (CLEAN behavior re-verify) -----------------------
test("re-ingesting an unchanged transcript is a no-op", () => {
  const { vault } = setup();
  const src = join(vault, "..", "t.txt");
  writeFileSync(src, TRANSCRIPT_2SPK);
  expect(run(["ingest", src, "--vault", vault]).code).toBe(0);
  const r = run(["ingest", src, "--vault", vault]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("unchanged");
});

// --- [P0] raw/ is immutable: re-snapshotting a CHANGED source must never overwrite the existing
// snapshot. The new bytes get a content-address-disambiguated name; the old file keeps its bytes. ---
test("re-snapshotting a changed source writes the new bytes under a disambiguated name", () => {
  const { vault, raw } = setup();
  const src = join(vault, "..", "x.csv");
  writeFileSync(src, "a,b\n1,2\n");
  expect(run(["snapshot", src, "--dest", "tax", "--vault", vault]).code).toBe(0);

  writeFileSync(src, "a,b\n9,9\n"); // the source changed under the same name
  const r = run(["snapshot", src, "--dest", "tax", "--vault", vault]);
  expect(r.code).toBe(0);
  // The original snapshot is untouched - vault notes' source: links still point at the old bytes.
  expect(readFileSync(join(raw, "tax", "x.csv"), "utf8")).toBe("a,b\n1,2\n");
  // The new bytes live under <stem>-<hash8><ext>, and the run said so.
  const files = readdirSync(join(raw, "tax")).sort();
  expect(files.length).toBe(2);
  const disambig = files.find((f) => f !== "x.csv")!;
  expect(disambig).toMatch(/^x-[0-9a-f]{8}\.csv$/);
  expect(readFileSync(join(raw, "tax", disambig), "utf8")).toBe("a,b\n9,9\n");
  expect(r.out).toContain(disambig);
  // Both snapshots keep their own manifest rows.
  const manifest = JSON.parse(readFileSync(join(vault, ".manifest.json"), "utf8"));
  expect(manifest[join("raw", "tax", "x.csv")]).toBeDefined();
  expect(manifest[join("raw", "tax", disambig)]).toBeDefined();
});

// --- [P0] basename collision: two different sources sharing a basename into one dest must keep BOTH
// files. Pre-fix the second copy destroyed the first silently ("1 copied, 0 unchanged"). -----------
test("two sources sharing a basename into one dest keep both files", () => {
  const { vault, raw } = setup();
  const a = join(vault, "..", "a");
  const b = join(vault, "..", "b");
  mkdirSync(a);
  mkdirSync(b);
  writeFileSync(join(a, "report.txt"), "first report");
  writeFileSync(join(b, "report.txt"), "second report");

  expect(run(["snapshot", join(a, "report.txt"), "--dest", "docs", "--vault", vault]).code).toBe(0);
  const r = run(["snapshot", join(b, "report.txt"), "--dest", "docs", "--vault", vault]);
  expect(r.code).toBe(0);
  expect(readFileSync(join(raw, "docs", "report.txt"), "utf8")).toBe("first report");
  const disambig = readdirSync(join(raw, "docs")).find((f) => f !== "report.txt")!;
  expect(disambig).toBeDefined();
  expect(readFileSync(join(raw, "docs", disambig), "utf8")).toBe("second report");
});

// --- [P0] identical bytes remain a skip (snapshot idempotency) ------------------------------------
test("re-snapshotting identical bytes is a skip, not a copy", () => {
  const { vault, raw } = setup();
  const src = join(vault, "..", "x.csv");
  writeFileSync(src, "a,b\n1,2\n");
  expect(run(["snapshot", src, "--dest", "tax", "--vault", vault]).code).toBe(0);
  const r = run(["snapshot", src, "--dest", "tax", "--vault", vault]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("0 copied, 1 unchanged");
  expect(readdirSync(join(raw, "tax")).length).toBe(1);
});

// --- [P0] migration care: a manifest row with a wrong (legacy) hash over bytes that ARE already on
// disk is refreshed in place - no duplicate snapshot, counted unchanged. ---------------------------
test("a stale manifest hash over identical disk bytes refreshes the row instead of duplicating", () => {
  const { vault, raw } = setup();
  const src = join(vault, "..", "x.csv");
  writeFileSync(src, "a,b\n1,2\n");
  expect(run(["snapshot", src, "--dest", "tax", "--vault", vault]).code).toBe(0);

  // Simulate a legacy manifest whose hash was computed wrong (the old lossy-decode bug).
  const mp = join(vault, ".manifest.json");
  const m = JSON.parse(readFileSync(mp, "utf8"));
  const key = Object.keys(m).find((k) => k.endsWith("x.csv"))!;
  const realHash = m[key].hash;
  m[key].hash = "0000000000000000";
  writeFileSync(mp, JSON.stringify(m, null, 2));

  const r = run(["snapshot", src, "--dest", "tax", "--vault", vault]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("0 copied, 1 unchanged");
  expect(readdirSync(join(raw, "tax")).length).toBe(1); // no duplicate written
  const after = JSON.parse(readFileSync(mp, "utf8"));
  expect(after[key].hash).toBe(realHash); // row refreshed to the true byte hash
});

// --- [P2] a dangling symlink anywhere in the tree must not abort the bulk snapshot ----------------
test("a dangling symlink in the tree is skipped, not a crash", () => {
  const { vault, raw } = setup();
  const tree = join(vault, "..", "tree");
  mkdirSync(join(tree, "sub"), { recursive: true });
  writeFileSync(join(tree, "a.txt"), "a");
  writeFileSync(join(tree, "sub", "b.txt"), "b");
  symlinkSync(join(tree, "missing.txt"), join(tree, "dead.txt")); // points at nothing

  const r = run(["snapshot", tree, "--dest", "mirror", "--vault", vault]);
  expect(r.code).toBe(0);
  expect(existsSync(join(raw, "mirror", "a.txt"))).toBe(true);
  expect(existsSync(join(raw, "mirror", "sub", "b.txt"))).toBe(true);
  expect(r.out.toLowerCase()).toContain("symlink");
});

// --- [P2] a directory-symlink cycle must not recurse forever (or to ENAMETOOLONG) ----------------
test("a directory-symlink cycle is skipped, not followed", () => {
  const { vault, raw } = setup();
  const tree = join(vault, "..", "tree");
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, "a.txt"), "a");
  symlinkSync(".", join(tree, "loop")); // tree/loop -> tree itself

  const r = run(["snapshot", tree, "--dest", "mirror", "--vault", vault]);
  expect(r.code).toBe(0);
  expect(existsSync(join(raw, "mirror", "a.txt"))).toBe(true);
  expect(existsSync(join(raw, "mirror", "loop"))).toBe(false);
});

// --- [P1] a prose markdown file with YAML frontmatter (date:, tags: - the dominant migration input)
// is NOT a transcript: no fabricated 0-participant event, snapshot + unclassified handoff instead. --
test("a prose markdown file with YAML frontmatter is not fabricated into an event", () => {
  const { vault, raw } = setup();
  const src = join(vault, "..", "note.md");
  writeFileSync(src, "---\ndate: 2025-01-15\ntags: [tax]\n---\n\nA prose paragraph about deductions. No dialogue here at all.\n");

  const r = run(["ingest", src, "--vault", vault]);
  expect(r.code).toBe(0);
  // No bogus `# 1:1 -` event with zero participants.
  expect(readdirSync(join(vault, "events")).length).toBe(0);
  // The unclassified-source handoff fires, and the snapshot files under adhoc, not transcripts.
  expect(needsReview(vault)).toContain("unclassified source");
  expect(existsSync(join(raw, "transcripts"))).toBe(false);
  expect(existsSync(join(raw, "adhoc"))).toBe(true);
});

// --- [P2] a staged note with a prototype-named type (`toString`) must get the clean "maps to no
// vault folder" error, not an ERR_INVALID_ARG_TYPE crash that aborts the whole --apply-all batch and
// strands a raw snapshot outside the manifest. ------------------------------------------------------
test("--apply-all reports a prototype-named type cleanly and still files the rest", () => {
  const { root, vault, raw } = setup();
  const proposed = join(root, "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  // bad.md sorts before good.md, so pre-fix the crash aborted the batch before good filed.
  writeFileSync(join(proposed, "bad.md"), "---\ntype: toString\n---\n\n# Bad Note\n\nbody\n");
  writeFileSync(join(proposed, "good.md"), "---\ntype: person\ntags: [test]\n---\n\n# Goodman\n\nbio\n");

  const r = run(["ingest", "--apply-all", "--vault", vault], { cwd: root });
  expect(r.code).toBe(1); // the bad note is still an error overall
  expect(r.err).toContain("maps to no vault folder");
  expect(r.err + r.out).not.toContain("ERR_INVALID_ARG_TYPE");
  // The valid staged note was still filed, the bad one kept for inspection.
  expect(existsSync(join(vault, "people", "goodman.md"))).toBe(true);
  expect(existsSync(join(proposed, "bad.md"))).toBe(true);
  // No stranded raw/proposed snapshot for the bad note - validation precedes any write.
  const proposedRaw = join(raw, "proposed");
  const snaps = existsSync(proposedRaw) ? readdirSync(proposedRaw) : [];
  expect(snaps.length).toBe(1); // only goodman's snapshot
  expect(r.out).toContain("1 filed");
});

// --- [P2] a CORRUPT manifest must be FATAL TO THE WHOLE --apply-all batch, never a per-file error.
// Pre-fix, applyStaged called loadManifest per note. On a corrupt manifest loadManifest renames the
// file aside (.corrupt-N) and THROWS. The first staged note hit that throw, the per-file catch
// swallowed it, and EVERY subsequent note then loadManifest'd again, found NO manifest (just renamed
// away), got {}, filed normally, and saveManifest wrote a fresh manifest holding only the
// post-corruption notes - dropping all prior provenance from the active .manifest.json (it survived
// only in the .corrupt-N backup). The fix detects the corrupt/unloadable manifest UP FRONT, before
// any note is filed, and aborts the batch cleanly with the loadManifest "backed up ... retry" message
// and a non-zero exit, filing nothing. ------------------------------------------------------------
test("--apply-all aborts cleanly on a corrupt manifest, filing nothing and preserving prior provenance", () => {
  const { root, vault } = setup();
  const proposed = join(root, "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  // Two valid staged notes that WOULD file fine against a sound manifest.
  writeFileSync(join(proposed, "one.md"), "---\ntype: person\ntags: [test]\n---\n\n# Personone\n\nbio\n");
  writeFileSync(join(proposed, "two.md"), "---\ntype: person\ntags: [test]\n---\n\n# Persontwo\n\nbio\n");

  // Seed a manifest carrying REAL prior provenance, then corrupt it on disk.
  const manifestFile = join(vault, ".manifest.json");
  const priorRow = { "raw/transcripts/2025-01-01-old-source.txt": { hash: "deadbeef", note: join(vault, "events", "old.md"), ingested: "2025-01-01" } };
  writeFileSync(manifestFile, JSON.stringify(priorRow, null, 2));
  writeFileSync(manifestFile, "{ this is not valid json");

  const r = run(["ingest", "--apply-all", "--vault", vault], { cwd: root });
  // Fatal: non-zero exit, the loadManifest corrupt message, nothing filed.
  expect(r.code).not.toBe(0);
  expect((r.err + r.out).toLowerCase()).toContain("corrupt");
  expect((r.err + r.out).toLowerCase()).toContain("retry");
  expect(r.out).not.toContain("filed person"); // no note was filed
  expect(existsSync(join(vault, "people", "personone.md"))).toBe(false);
  expect(existsSync(join(vault, "people", "persontwo.md"))).toBe(false);
  // Both staged notes are left in place (nothing consumed them).
  expect(existsSync(join(proposed, "one.md"))).toBe(true);
  expect(existsSync(join(proposed, "two.md"))).toBe(true);

  // The corrupt bytes were preserved in a sidecar and the prior provenance is recoverable from it.
  const sidecars = readdirSync(vault).filter((f) => f.startsWith(".manifest.json.corrupt-"));
  expect(sidecars.length).toBe(1);

  // The active .manifest.json was NOT replaced with a fresh post-corruption-only manifest. Either it
  // does not exist (renamed aside, none written back) or, if recreated, it still carries the prior row.
  // The failure being guarded against is a manifest that holds ONLY the just-filed notes and lost the
  // old provenance - so we assert no fresh apply-only manifest exists.
  if (existsSync(manifestFile)) {
    const after = JSON.parse(readFileSync(manifestFile, "utf8"));
    const keys = Object.keys(after);
    // No apply:sha256 rows were written (nothing filed), and prior provenance is intact.
    expect(keys.some((k) => k.startsWith("apply:sha256:"))).toBe(false);
    expect(after["raw/transcripts/2025-01-01-old-source.txt"]).toBeDefined();
  }
});

// --- [P2] a corrupt MANIFEST aborts the batch (above), but a malformed NOTE must still NOT abort it -
// the per-file isolation for bad notes is preserved. This pins both halves of the fix at once: a sound
// manifest + one bad note + one good note files the good note and reports the bad one per-file. -------
test("--apply-all keeps per-file isolation for a bad NOTE when the manifest is sound", () => {
  const { root, vault } = setup();
  const proposed = join(root, "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  // bad.md sorts before good.md; a sound (absent) manifest means the corrupt-abort path is NOT taken.
  writeFileSync(join(proposed, "bad.md"), "---\ntype: toString\n---\n\n# Bad Note\n\nbody\n");
  writeFileSync(join(proposed, "good.md"), "---\ntype: person\ntags: [test]\n---\n\n# Goodperson\n\nbio\n");

  const r = run(["ingest", "--apply-all", "--vault", vault], { cwd: root });
  expect(r.code).toBe(1); // the bad note still makes the batch non-zero overall
  expect(r.err).toContain("maps to no vault folder");
  // The good note filed despite the bad one - per-file isolation intact.
  expect(existsSync(join(vault, "people", "goodperson.md"))).toBe(true);
  expect(r.out).toContain("1 filed");
});

// --- [P2] identical staged bytes applied under two different filenames: the raw path must be decided
// BEFORE source: injection (so the second note links the snapshot that exists), and the two filings
// must keep distinct manifest rows (pre-fix the shared apply:sha256:<hash> key lost the first). -----
test("identical staged bytes under two filenames keep distinct manifest rows and resolving source: links", () => {
  const { vault, raw } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  // No slug:, no H1 -> the slug comes from the staged basename, so identical bytes file twice.
  const shared = "---\ntype: person\ntags: [test]\n---\n\nbio without a heading\n";
  const s1 = join(proposed, "n1.md");
  const s2 = join(proposed, "n2.md");
  writeFileSync(s1, shared);
  expect(run(["ingest", "--apply", s1, "--vault", vault]).code).toBe(0);
  writeFileSync(s2, shared);
  expect(run(["ingest", "--apply", s2, "--vault", vault]).code).toBe(0);

  // Both notes filed, and each note's source: resolves to a snapshot that EXISTS on disk.
  for (const slug of ["n1", "n2"]) {
    const note = readFileSync(join(vault, "people", `${slug}.md`), "utf8");
    const target = note.match(/^source: "\[\[(raw\/[^\]]+)\]\]"$/m)?.[1];
    expect(target).toBeDefined();
    expect(existsSync(join(raw, "..", `${target}.md`))).toBe(true);
  }
  // Two distinct apply rows - the first filing's provenance is not clobbered by the second.
  const manifest = JSON.parse(readFileSync(join(vault, ".manifest.json"), "utf8"));
  const applyRows = Object.entries(manifest).filter(([k]) => k.startsWith("apply:sha256:"));
  expect(applyRows.length).toBe(2);
  const notes = applyRows.map(([, e]) => (e as { note: string }).note).sort();
  expect(notes[0]).toContain("n1.md");
  expect(notes[1]).toContain("n2.md");
});

// --- [P2] --apply slug derivation falls through on the SLUGIFIED result, mirroring the bytes path:
// a Cyrillic H1 must not short-circuit the chain into "" or a digits-only remnant. ------------------
test("a Cyrillic H1 with a numeric remnant falls back to the staged basename for the slug", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "nalog.md");
  writeFileSync(staged, "---\ntype: note\ndomain: finances\ntags: [test]\n---\n\n# Налоговая декларация 2024\n\nдетали\n");
  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);
  // Filed under the ASCII basename, not the degenerate digits-only remnant of the Cyrillic title.
  expect(existsSync(join(vault, "finances", "nalog.md"))).toBe(true);
  expect(existsSync(join(vault, "finances", "2024.md"))).toBe(false);
});

test("a pure-Cyrillic H1 falls back to the staged basename instead of erroring", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "zametka.md");
  writeFileSync(staged, "---\ntype: note\ndomain: finances\ntags: [test]\n---\n\n# Налоговая декларация\n\nдетали\n");
  const r = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r.code).toBe(0);
  expect(r.err).not.toContain("can't derive a slug");
  expect(existsSync(join(vault, "finances", "zametka.md"))).toBe(true);
});

test("a genuinely all-numeric H1 keeps its faithful numeric slug", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "year.md");
  writeFileSync(staged, "---\ntype: note\ndomain: finances\ntags: [test]\n---\n\n# 2024\n\nyear summary\n");
  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);
  expect(existsSync(join(vault, "finances", "2024.md"))).toBe(true);
});

// --- [P2] binary provenance: the recorded hash must be the sha256 of the BYTES (a lossy utf8 decode
// hashes to something matching neither the source nor the snapshot), and the copy byte-faithful. ----
test("a binary source's manifest hash matches its bytes and the snapshot is byte-faithful", () => {
  const { vault } = setup();
  const src = join(vault, "..", "img.png");
  // Invalid UTF-8 on purpose (0xff 0xfe and a bare 0x80) - a lossy decode mangles these bytes.
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0x81]);
  writeFileSync(src, bytes);

  const r = run(["ingest", src, "--vault", vault]);
  expect(r.code).toBe(0);
  const manifest = JSON.parse(readFileSync(join(vault, ".manifest.json"), "utf8"));
  const expected = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  expect(manifest[src].hash).toBe(expected);
  // The snapshot copy is byte-identical to the source.
  expect(Buffer.compare(readFileSync(manifest[src].raw), bytes)).toBe(0);
});

// --- [P2] fmList must take the WHOLE wikilink list: a lazy match stops at the first ]] and silently
// drops every participant after the first. ----------------------------------------------------------
test("--apply resolves every participant in a wikilink list, not just the first", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "sync.md");
  writeFileSync(staged, '---\ntype: event\ndate: 2025-01-01\nparticipants: ["[[people/carol]]", "[[people/dave]]"]\ntags: [test]\n---\n\n# Sync with the team\n\nnotes\n');
  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);
  const review = needsReview(vault);
  expect(review).toContain("people/carol");
  expect(review).toContain("people/dave"); // pre-fix dave was silently skipped
});

// --- round-3 finding 3: a SCALAR participants value (`participants: "[[people/ghost]]"`, not a `[..]`
// list) must still be resolved inline, the same way the transcript path flags an unknown speaker.
// Pre-fix only the list form went through fmList, so a scalar participants yielded [] and the missing
// person was never flagged inline at apply (check caught it later, an inconsistency). -----------------
test("--apply resolves a SCALAR participants wikilink and flags an unresolved person inline", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "solo.md");
  // A single participant given as a scalar string, not a [..] list.
  writeFileSync(staged, '---\ntype: event\ndate: 2025-02-02\nparticipants: "[[people/ghost]]"\ntags: [test]\n---\n\n# Solo sync\n\nnotes\n');
  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);
  // The unresolved person is flagged inline at apply, not left for check.
  expect(needsReview(vault)).toContain("people/ghost");
});

// --- [P3] a directory where a file is expected, and a read-only raw/, both error cleanly -----------
test("ingesting a directory errors cleanly", () => {
  const { vault } = setup();
  const dir = join(vault, "..", "somedir");
  mkdirSync(dir);
  const r = run(["ingest", dir, "--vault", vault]);
  expect(r.code).toBe(1);
  expect(r.err.toLowerCase()).toContain("directory");
  expect(r.err).not.toContain("EISDIR"); // no raw stack
});

test("a read-only raw/ gives a clean one-line error, not a stack", () => {
  const { vault, raw } = setup();
  chmodSync(raw, 0o555);
  try {
    const r = run(["ingest", "a small fact to file", "--vault", vault]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot write snapshot");
  } finally {
    chmodSync(raw, 0o755);
  }
});

// --- round-2 finding 1: a document-header block (Title:/Author:/Status:, or callouts like
// Warning:/Remember:/TODO:) over plain prose clears the >=2-distinct-speaker bar but is NOT a
// transcript - each "speaker" label appears once at the top, the body is paragraphs. It must route to
// snapshot + unclassified handoff, not a fabricated event with [[people/title]] / [[people/author]]. -
test("a Title:/Author:/Status: header over prose is not detected as a transcript", () => {
  const { vault, raw } = setup();
  const src = join(vault, "..", "doc.md");
  writeFileSync(src, [
    "Title: Quarterly strategy memo",
    "Author: Jordan Lee",
    "Status: Draft",
    "",
    "This document lays out the plan for the next quarter. It is plain prose, no dialogue.",
    "We will revisit the budget after the review and adjust headcount accordingly.",
    "There is more text here to make the prose the dominant body of the file.",
  ].join("\n") + "\n");

  const r = run(["ingest", src, "--vault", vault]);
  expect(r.code).toBe(0);
  // No fabricated event with bogus people from the header labels.
  expect(readdirSync(join(vault, "events")).length).toBe(0);
  // Snapshot + unclassified handoff fires; the snapshot files under adhoc, not transcripts.
  expect(needsReview(vault)).toContain("unclassified source");
  expect(needsReview(vault)).not.toContain("people/title");
  expect(needsReview(vault)).not.toContain("people/author");
  expect(existsSync(join(raw, "transcripts"))).toBe(false);
  expect(existsSync(join(raw, "adhoc"))).toBe(true);
});

// --- round-2 finding 2: the unchanged-source fast-skip must verify the note AND snapshot still exist.
// Deleting the filed event note and re-ingesting must re-file it, not no-op naming a note that is gone.
test("re-ingesting after the event note was deleted re-files it instead of a silent no-op", () => {
  const { vault } = setup();
  const src = join(vault, "..", "t.txt");
  writeFileSync(src, TRANSCRIPT_2SPK);
  expect(run(["ingest", src, "--vault", vault]).code).toBe(0);

  const notePath = join(vault, "events", "2025-03-04-q3-planning.md");
  expect(existsSync(notePath)).toBe(true);
  rmSync(notePath); // the note is gone, but the manifest still records its hash

  const r = run(["ingest", src, "--vault", vault]);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain("unchanged"); // must NOT take the trust-the-hash fast-skip
  expect(existsSync(notePath)).toBe(true);  // the note is re-created
});

// --- round-2 finding 3: a UTF-8 BOM before the `---` fence must not defeat frontmatter detection. A
// PowerShell Out-File / Notepad-authored staged note with a leading BOM + valid frontmatter applies. -
test("--apply strips a leading UTF-8 BOM so a BOM+CRLF staged note is filed, not refused as no type", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "bom.md");
  // A BOM (﻿) then CRLF frontmatter, the Notepad/PowerShell default.
  const content = "﻿" + ["---", "type: person", "tags: [test]", "---", "", "# Bom Person", "", "bio"].join("\r\n") + "\r\n";
  writeFileSync(staged, content);

  const r = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r.code).toBe(0);
  expect(r.err).not.toContain("no `type:`");
  expect(existsSync(join(vault, "people", "bom-person.md"))).toBe(true);
});

// --- round-2 finding 5: a bare URL inline fact must route to inline-text ingest, not be refused as a
// missing file because the scheme `//` trips the path-separator check. -----------------------------
test("a bare URL ingests as inline text, not refused as a missing path", () => {
  const { vault } = setup();
  const r = run(["ingest", "https://example.com/some/path", "--vault", vault]);
  expect(r.code).toBe(0);
  expect(r.err).not.toContain("no such file");
  expect(r.out.toLowerCase()).toContain("snapshot");
  expect(needsReview(vault)).toContain("unclassified source");
});

// --- round-2 finding 6: ingest's DOMAIN_FOLDERS must NOT include "projects" (a form folder, self-
// describing by type:project, no domain:). A staged `type:note domain:projects` must be rejected, not
// filed into projects/ where check's domain audit then exempts it (a silent contract leak). ----------
test("--apply rejects type:note domain:projects instead of filing into the form folder", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "leak.md");
  writeFileSync(staged, "---\ntype: note\ndomain: projects\ntags: [test]\n---\n\n# Leaky note\n\nbody\n");
  const r = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("maps to no vault folder");
  // It was NOT filed into projects/.
  expect(existsSync(join(vault, "projects", "leaky-note.md"))).toBe(false);
});

// --- round-2 finding 6 (companion): a real type:project note still files into projects/ via
// TYPE_FOLDER (not DOMAIN_FOLDERS). Removing "projects" from the domain set must not break this. -----
test("--apply still files a real type:project note into projects/", () => {
  const { vault } = setup();
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, "proj.md");
  writeFileSync(staged, "---\ntype: project\nstatus: active\ntags: [test]\n---\n\n# Ship the thing\n\nbody\n");
  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);
  expect(existsSync(join(vault, "projects", "ship-the-thing.md"))).toBe(true);
});

// --- round-2 finding 6 (companion): --apply on a path that is a DIRECTORY gives a clean one-line
// error, not a raw EISDIR stack (the round-1 EISDIR fix covered only the main ingest path). ----------
test("--apply on a directory errors cleanly, not a raw EISDIR stack", () => {
  const { vault } = setup();
  const dir = join(vault, "..", "stageddir");
  mkdirSync(dir);
  const r = run(["ingest", "--apply", dir, "--vault", vault]);
  expect(r.code).toBe(1);
  expect(r.err.toLowerCase()).toContain("directory");
  expect(r.err).not.toContain("EISDIR");
});

// --- the declared folder roles: ingest and check read the SAME set ---------------------------------
// The contract always promised "domains are user-defined". While the set was frozen in ingest.ts, a
// vault that declared `clients` a domain had check accept a note there and --apply refuse to file one:
// one set disagreeing with itself. Both sides now read vault/_folders.md through lib/folders.ts.

function stage(vault: string, name: string, content: string): string {
  const proposed = join(vault, "..", "plugins", "p", "proposed");
  mkdirSync(proposed, { recursive: true });
  const staged = join(proposed, name);
  writeFileSync(staged, content);
  return staged;
}

test("--apply files into a domain the VAULT declares, which the shipped set never heard of", () => {
  const { vault } = setup();
  mkdirSync(join(vault, "clients"), { recursive: true });
  writeFileSync(join(vault, "_folders.md"), "## Domains\nidentity, health, finances, work, life, clients\n");
  const staged = stage(vault, "acme.md", "---\ntype: note\nkind: reference\ndomain: clients\ntags: [x]\n---\n\n# Acme\n\nbody\n");
  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);
  expect(existsSync(join(vault, "clients", "acme.md"))).toBe(true);
});

test("--apply still refuses a domain nobody declared, and names the set it read", () => {
  const { vault } = setup();
  writeFileSync(join(vault, "_folders.md"), "## Domains\nidentity, health\n");
  const staged = stage(vault, "acme.md", "---\ntype: note\ndomain: work\ntags: [x]\n---\n\n# Acme\n\nbody\n");
  const r = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("maps to no vault folder");
  expect(r.err).toContain("identity health");
  expect(existsSync(join(vault, "work", "acme.md"))).toBe(false);
});

test("a vault with no _folders.md files exactly as it always did", () => {
  const { vault } = setup();
  const staged = stage(vault, "tax.md", "---\ntype: note\nkind: reference\ndomain: finances\ntags: [x]\n---\n\n# Tax\n\nbody\n");
  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);
  expect(existsSync(join(vault, "finances", "tax.md"))).toBe(true);
  const staged2 = stage(vault, "acme.md", "---\ntype: note\ndomain: clients\ntags: [x]\n---\n\n# Acme\n\nbody\n");
  expect(run(["ingest", "--apply", staged2, "--vault", vault]).code).toBe(1);
});

// --- filing INTO a mount --------------------------------------------------------------------------
// `mount:` prefixes the ordinary filing decision rather than replacing it, so `type: person` lands in
// the mount's own people/ for free and the note keeps the `domain:` the mount's roles want to see.

function withMount(vault: string, roles: string | null = "## Entities\npeople, orgs\n\n## Domains\nfinances, life\n"): void {
  for (const f of ["finances", "people"]) mkdirSync(join(vault, "shared", f), { recursive: true });
  writeFileSync(join(vault, "_folders.md"), "## Mounts\nshared\n");
  if (roles !== null) writeFileSync(join(vault, "shared", "_folders.md"), roles);
}

test("--apply files a staged note into <mount>/<folder> under the mount's own roles", () => {
  const { vault } = setup();
  withMount(vault);
  const staged = stage(vault, "rent.md", "---\ntype: note\nkind: reference\nmount: shared\ndomain: finances\ntags: [rent]\n---\n\n# Rent\n\nbody\n");
  const r = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r.code).toBe(0);
  const filed = join(vault, "shared", "finances", "rent.md");
  expect(existsSync(filed)).toBe(true);
  // No source: into this vault's private raw/ - that link is dead across the seam, and check would
  // flag the note ingest just filed. The filed bytes are the staged bytes.
  const text = readFileSync(filed, "utf8");
  expect(text).not.toContain("source:");
  expect(text).toContain("domain: finances");
  expect(r.out).toContain("no snapshot");
  expect(existsSync(join(vault, "..", "raw", "proposed"))).toBe(false);
});

test("a mount note files by TYPE too, into the mount's own entity folder", () => {
  const { vault } = setup();
  withMount(vault);
  const staged = stage(vault, "sam.md", "---\ntype: person\nmount: shared\ntags: [x]\n---\n\n# Sam\n\nbio\n");
  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);
  expect(existsSync(join(vault, "shared", "people", "sam.md"))).toBe(true);
});

test("--apply refuses a domain the MOUNT does not declare, even when the vault does", () => {
  const { vault } = setup();
  withMount(vault, "## Domains\nlife\n");
  const staged = stage(vault, "rent.md", "---\ntype: note\nmount: shared\ndomain: finances\ntags: [rent]\n---\n\n# Rent\n\nbody\n");
  const r = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("maps to no vault folder under the `shared` mount");
  expect(existsSync(join(vault, "shared", "finances", "rent.md"))).toBe(false);
});

test("--apply refuses a mount nobody declared", () => {
  const { vault } = setup();
  const staged = stage(vault, "rent.md", "---\ntype: note\nmount: shared\ndomain: finances\ntags: [rent]\n---\n\n# Rent\n\nbody\n");
  const r = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("is not declared");
});

test("--apply refuses a declared mount that is not checked out - it would make a plain dir where a repo goes", () => {
  const { vault } = setup();
  writeFileSync(join(vault, "_folders.md"), "## Mounts\nshared\n");
  const staged = stage(vault, "rent.md", "---\ntype: note\nmount: shared\ndomain: finances\ntags: [rent]\n---\n\n# Rent\n\nbody\n");
  const r = run(["ingest", "--apply", staged, "--vault", vault]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("not checked out");
  expect(existsSync(join(vault, "shared"))).toBe(false);
});

test("the filed note carries no `mount:` - the routing key is spent once the path says where it went", () => {
  // The same hygiene `vault move` applies when it drops `domain:` at this boundary. A key the
  // frontmatter contract never defined, baked into the SHARED tree, leaves the other person guessing
  // whether it still means anything.
  const { vault } = setup();
  withMount(vault);
  const staged = stage(vault, "rent.md", "---\ntype: note\nkind: reference\nmount: shared\ndomain: finances\ntags: [rent]\n---\n\n# Rent\n\nbody\n");
  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);
  const text = readFileSync(join(vault, "shared", "finances", "rent.md"), "utf8");
  expect(text).not.toContain("mount:");
  expect(text).toContain("domain: finances");
  expect(text).toContain("# Rent");
});

test("re-applying the same mount note is still a clean no-op after the mount: key is stripped", () => {
  // The strip happens BEFORE the idempotency hash, so the second apply compares the bytes actually on
  // disk. Getting that order wrong turns every re-apply into a reported contradiction.
  const { vault } = setup();
  withMount(vault);
  const body = "---\ntype: note\nkind: reference\nmount: shared\ndomain: finances\ntags: [rent]\n---\n\n# Rent\n\nbody\n";
  expect(run(["ingest", "--apply", stage(vault, "rent.md", body), "--vault", vault]).code).toBe(0);
  const again = run(["ingest", "--apply", stage(vault, "rent.md", body), "--vault", vault]);
  expect(again.code).toBe(0);
  expect(again.out).toContain("no-op");
});

test("a mount note that brings its own _raw/ source keeps it verbatim", () => {
  const { vault } = setup();
  withMount(vault);
  const staged = stage(vault, "rent.md", "---\ntype: note\nmount: shared\ndomain: finances\ntags: [rent]\nsource: \"[[shared/_raw/lease/scan]]\"\n---\n\n# Rent\n\nbody\n");
  expect(run(["ingest", "--apply", staged, "--vault", vault]).code).toBe(0);
  const text = readFileSync(join(vault, "shared", "finances", "rent.md"), "utf8");
  expect(text).toContain("source: \"[[shared/_raw/lease/scan]]\"");
  expect(text.match(/^source:/gm)?.length).toBe(1);
});
