import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "cli.ts");

// One temp workspace per test. Layout mirrors `imprint init`: a vault/ with the form folders we need
// plus a sibling raw/. We pass --vault explicitly so nothing touches the real repo vault.
function setup(): { root: string; vault: string; raw: string } {
  const root = mkdtempSync(join(tmpdir(), "imprint-test-"));
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
  const r = run(["ingest", "/tmp/does-not-exist-imprint.txt", "--vault", vault]);
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
// `imprint check`'s coverage scan does NOT flag that snapshot as an uncovered snapshot forever. Before
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
