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

// --- bug 1: re-ingest a CHANGED transcript -> existing enriched note PRESERVED --------------------
test("re-ingesting a changed transcript does not overwrite an enriched note", () => {
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

  // Non-fatal, clear message, note untouched.
  expect(r.code).toBe(0);
  const after = readFileSync(notePath, "utf8");
  expect(after).toContain("ENRICHED-BODY-MARKER");
  expect(after).toContain("status: enriched");
  expect(after).toContain("a hard-won decision");
  // Provenance + needs-review surfaced.
  expect(needsReview(vault)).toContain("source changed for existing note");
  // Manifest hash updated to the new source bytes.
  const manifest = JSON.parse(readFileSync(join(vault, ".manifest.json"), "utf8"));
  expect(manifest[src]).toBeDefined();
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
