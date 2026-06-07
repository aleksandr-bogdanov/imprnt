// Tests for `imprint check`: exit-code health signal (bug 1) and entity-aware disconnected detection
// (bug 2), plus regression coverage for index.md regen and clean-vault behavior. Each test gets its
// own temp vault and runs check.ts as a real subprocess so we assert both stdout AND the exit code.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CHECK = join(here, "check.ts");

// A minimal vault: the folders check/moc walk plus the control files. _tags.md carries a `## Tags`
// list so the vocabulary-sync and dup-audit paths run.
function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "imprint-check-"));
  const folders = [
    "people", "orgs", "holdings",
    "identity", "health", "finances", "work", "life", "projects",
    "events", "mistakes",
  ];
  for (const f of folders) mkdirSync(join(dir, f), { recursive: true });
  mkdirSync(join(dir, "..", "raw"), { recursive: true });
  writeFileSync(join(dir, "_tags.md"), "---\ntype: tags\n---\n\n# tags\n\n## Tags\nidentity\n\n## Synonyms\n");
  return dir;
}

function note(dir: string, rel: string, fm: string, body: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `---\n${fm}\n---\n\n${body}\n`);
}

function runCheck(dir: string, extra: string[] = []): { code: number; out: string } {
  const proc = Bun.spawnSync(["bun", CHECK, "--vault", dir, ...extra]);
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
}

// The exact slugs printed under the "disconnected notes" header. check.ts prints each flagged note as
// its own two-space-indented line, then a blank line ends the section. We collect those lines and strip
// the indent so callers can do exact-equality membership checks (no substring or prefix false-matches).
function disconnectedList(out: string): string[] {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.includes("disconnected notes"));
  if (start === -1) return [];
  const slugs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^  (\S.*)$/);
    if (!m) break; // blank line or next section ends the list
    slugs.push(m[1].trim());
  }
  return slugs;
}

// --- bug 1: exit code reflects health -------------------------------------

test("clean vault exits 0", () => {
  const dir = makeVault();
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nSaw [[people/anna]].");
  const { code, out } = runCheck(dir);
  expect(out).toContain("clean.");
  expect(code).toBe(0);
});

test("vault with an orphan link exits non-zero", () => {
  const dir = makeVault();
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nLinks [[people/anna]] and [[people/ghost]].");
  const { code, out } = runCheck(dir);
  expect(out).toContain("orphan links");
  expect(code).not.toBe(0);
});

test("vault with an untagged note exits non-zero", () => {
  const dir = makeVault();
  note(dir, "people/anna.md", "type: person\ntags: []", "# Anna");
  const { code, out } = runCheck(dir);
  expect(out).toContain("untagged notes");
  expect(code).not.toBe(0);
});

test("vault with duplicate tags exits non-zero", () => {
  const dir = makeVault();
  // identity (seeded in _tags.md) ~ identty (edit-distance 1) and a prefix-dup pair.
  note(dir, "people/anna.md", "type: person\ntags: [identty, family]", "# Anna\n\nSees [[people/anna]].");
  const { code, out } = runCheck(dir);
  expect(out).toContain("candidate duplicate tags");
  expect(code).not.toBe(0);
});

// --- bug 2: entity-aware disconnected detection ---------------------------

test("domain note linking only another domain note is disconnected", () => {
  const dir = makeVault();
  note(dir, "health/a.md", "domain: health\ntags: [health]", "# A\n\nSee [[health/b]].");
  note(dir, "health/b.md", "domain: health\ntags: [health]", "# B\n\nSee [[people/anna]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { code, out } = runCheck(dir);
  expect(out).toContain("disconnected notes");
  // a/ links only a domain note -> flagged on its own line; b/ links an entity -> not flagged.
  const dis = disconnectedList(out);
  expect(dis).toContain("health/a");
  expect(dis).not.toContain("health/b");
  expect(code).not.toBe(0);
});

test("domain note linking an entity is NOT disconnected", () => {
  const dir = makeVault();
  note(dir, "health/a.md", "domain: health\ntags: [health]", "# A\n\nSee [[people/anna]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { out } = runCheck(dir);
  expect(out).toContain("every domain/form note links the graph");
});

test("domain note linking only raw/ is disconnected", () => {
  const dir = makeVault();
  note(dir, "health/a.md", "domain: health\ntags: [health]", "# A\n\nSource [[raw/scan.md]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna\n\nLink [[people/anna]].");
  const { out } = runCheck(dir);
  expect(out).toContain("disconnected notes");
  expect(disconnectedList(out)).toContain("health/a");
});

test("entity note linking nothing is NOT disconnected", () => {
  const dir = makeVault();
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { out } = runCheck(dir);
  // anna is in an entity folder and links nothing, yet must not be flagged.
  expect(disconnectedList(out)).not.toContain("people/anna");
});

test("bare-slug link to an entity counts as connected", () => {
  const dir = makeVault();
  note(dir, "health/a.md", "domain: health\ntags: [health]", "# A\n\nSee [[anna]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { out } = runCheck(dir);
  expect(out).toContain("every domain/form note links the graph");
});

// --- index.md regen --------------------------------------------------------

test("index.md uses summary when present, falls back to H1 otherwise", () => {
  const dir = makeVault();
  note(dir, "people/anna.md", "type: person\ntags: [family]\nsummary: Partner and co-parent", "# Anna Real Title");
  note(dir, "people/bob.md", "type: person\ntags: [family]", "# Bob Heading Only");
  runCheck(dir);
  const idx = readFileSync(join(dir, "index.md"), "utf8");
  expect(idx).toContain("Partner and co-parent");
  expect(idx).not.toContain("Anna Real Title");
  expect(idx).toContain("Bob Heading Only");
});

// --- tolerances ------------------------------------------------------------

test("missing _tags.md is tolerated", () => {
  const dir = makeVault();
  // remove the tags file
  Bun.spawnSync(["rm", join(dir, "_tags.md")]);
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { out } = runCheck(dir);
  expect(out).toContain("imprint check");
  expect(out).not.toContain("tag vocabulary in sync");
});

test("note with no frontmatter is tolerated", () => {
  const dir = makeVault();
  writeFileSync(join(dir, "people/raw.md"), "# Just a heading\n\nSee [[people/raw]].");
  const { out, code } = runCheck(dir);
  expect(out).toContain("imprint check");
  // no frontmatter -> no tags -> flagged untagged -> non-zero, but must not crash.
  expect(out).toContain("untagged notes");
  expect(code).not.toBe(0);
});

test("empty vault does not crash and regenerates index", () => {
  const dir = makeVault();
  const { out } = runCheck(dir);
  expect(out).toContain("regenerated index.md");
  expect(existsSync(join(dir, "index.md"))).toBe(true);
});

// A freshly scaffolded / empty vault has zero notes and therefore zero issues. It MUST exit 0 - a
// regression that made the empty case exit 1 would greet every new user with a failure on first run.
test("empty vault exits 0", () => {
  const dir = makeVault();
  const { code, out } = runCheck(dir);
  expect(out).toContain("clean.");
  expect(code).toBe(0);
});

// --- per-issue exit-code coverage -----------------------------------------
// Each issue type must drive a non-zero exit (the CI health signal). orphan / untagged / duplicate-tag
// are asserted above. disconnected is asserted in its own section. domain-mismatch is the last gap.

test("vault with a domain mismatch exits non-zero", () => {
  const dir = makeVault();
  // note sits in health/ but declares domain: work -> folder != domain field.
  note(dir, "health/a.md", "domain: work\ntags: [health]", "# A\n\nSee [[people/anna]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { code, out } = runCheck(dir);
  expect(out).toContain("domain mismatches");
  expect(code).not.toBe(0);
});

// --- --all aggregation exit code ------------------------------------------
// --all globs the REPO plugins dir via import.meta.url, so a temp vault cannot inject fake plugins.
// We test the fully reachable path: core issues alone must make --all exit non-zero, regardless of
// whether the repo's own plugin checks pass. The failing-plugin path (a plugin exit != 0 increments
// `failed` and forces a non-zero exit) is covered by inspection - that code predates round-1 and was
// already exiting non-zero before the aggregation change.

test("--all with a dirty core exits non-zero even if repo plugins pass", () => {
  const dir = makeVault();
  // an orphan link is a core issue. --all must surface it as a non-zero exit no matter the plugins.
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nLinks [[people/anna]] and [[people/ghost]].");
  const { code, out } = runCheck(dir, ["--all"]);
  expect(out).toContain("orphan links");
  expect(out).toContain("— plugins");
  expect(code).not.toBe(0);
});

test("--all with a clean core and passing repo plugins exits 0", () => {
  const dir = makeVault();
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nSaw [[people/anna]].");
  const { code, out } = runCheck(dir, ["--all"]);
  expect(out).toContain("clean.");
  expect(out).toContain("— plugins");
  // exit 0 only holds when every repo plugin check also passes. If a repo plugin is intentionally
  // failing this assertion documents that - relax it then, the core-clean path itself is sound.
  expect(code).toBe(0);
});
