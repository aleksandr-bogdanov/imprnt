// Tests for `imprnt check`: exit-code health signal (bug 1) and entity-aware disconnected detection
// (bug 2), plus regression coverage for index.md regen and clean-vault behavior. Each test gets its
// own temp vault and runs check.ts as a real subprocess so we assert both stdout AND the exit code.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { openNeedsReview } from "./lib/resolve.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CHECK = join(here, "check.ts");
const repoRoot = join(here, "..");

// A minimal vault: the folders check/moc walk plus the control files. _tags.md carries a `## Tags`
// list so the vocabulary-sync and dup-audit paths run.
function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "imprnt-check-"));
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
  expect(out).toContain("imprnt check");
  expect(out).not.toContain("tag vocabulary in sync");
});

test("note with no frontmatter is tolerated", () => {
  const dir = makeVault();
  writeFileSync(join(dir, "people/raw.md"), "# Just a heading\n\nSee [[people/raw]].");
  const { out, code } = runCheck(dir);
  expect(out).toContain("imprnt check");
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

// --- projects/ is self-describing by type (exempt from domain-match) ------
// A type:project note lives in projects/ because its folder mirrors its type, exactly like events and
// mistakes. So it carries no domain: field and must NOT be flagged as a domain mismatch, regardless of
// whether it has no domain or a non-matching one. The entity-link (disconnected) check is separate and
// still applies, and the domain-match check still works for the real domain folders.

// The exact slugs printed under the "domain mismatches" header, stripped of the trailing reason text
// so callers can do exact-equality membership on the slug. Each flagged note is "  <slug>  — ...".
function domainMismatchSlugs(out: string): string[] {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.includes("domain mismatches"));
  if (start === -1) return [];
  const slugs: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^  (\S.*?)\s+—/);
    if (!m) break; // blank line or next section ends the list
    slugs.push(m[1].trim());
  }
  return slugs;
}

test("project note with a mismatched domain: is NOT flagged as a domain mismatch", () => {
  const dir = makeVault();
  // a project note declaring domain: work would, pre-fix, be flagged folder(projects) != domain(work).
  note(dir, "projects/x.md", "type: project\ndomain: work\ntags: [work]", "# X\n\nFor [[people/anna]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { out } = runCheck(dir);
  expect(domainMismatchSlugs(out)).not.toContain("projects/x");
});

test("project note with NO domain: is NOT flagged as a domain mismatch", () => {
  const dir = makeVault();
  note(dir, "projects/x.md", "type: project\ntags: [work]", "# X\n\nFor [[people/anna]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { out } = runCheck(dir);
  expect(domainMismatchSlugs(out)).not.toContain("projects/x");
});

test("project note linking no entity is STILL flagged disconnected (exemption is domain-only)", () => {
  const dir = makeVault();
  // links nothing in people/orgs/holdings -> must remain a disconnected graph island.
  note(dir, "projects/x.md", "type: project\ntags: [work]", "# X\n\nNo entity links here.");
  const { code, out } = runCheck(dir);
  expect(out).toContain("disconnected notes");
  expect(disconnectedList(out)).toContain("projects/x");
  expect(code).not.toBe(0);
});

test("a real domain folder note with a mismatched domain: is STILL flagged", () => {
  const dir = makeVault();
  // the domain-match check must keep working for the real domain folders after exempting projects/.
  note(dir, "health/x.md", "domain: work\ntags: [health]", "# X\n\nSee [[people/anna]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { code, out } = runCheck(dir);
  expect(out).toContain("domain mismatches");
  expect(domainMismatchSlugs(out)).toContain("health/x");
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

// --- uncovered snapshots (manifest coverage) ------------------------------
// The earlier tests never write a .manifest.json, so rawEntries is empty and the coverage check is a
// no-op (it prints nothing and contributes 0 to the issues sum). These tests put real raw entries in
// the manifest so the check actually runs: an entry no note points back to is an uncovered snapshot
// (reported + counted in the exit code), and one a note references via source:/sources: is covered.

// The manifest shape is Record<sourceKey, ManifestEntry> with ManifestEntry carrying a `raw` field
// (vault-relative raw path, the snapshot form, or an absolute path from ingest - check.ts normalizes
// both to `raw/...`). `note` is the derived note path. We mirror exactly what snapshot/ingest write.
function writeManifest(dir: string, m: Record<string, { hash: string; note: string; ingested: string; raw?: string; src?: string }>): void {
  writeFileSync(join(dir, ".manifest.json"), JSON.stringify(m, null, 2) + "\n");
}

// The lines printed under the "uncovered snapshots" header, for exact membership. Unlike the
// disconnected list, uncovered items are printed WITHOUT a leading indent (they are normalized raw
// paths joined straight onto the console.log), so we collect every non-blank line up to the blank
// terminator and trim it.
function uncoveredList(out: string): string[] {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.includes("uncovered snapshots"));
  if (start === -1) return [];
  const items: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === "") break; // blank line ends the section
    items.push(t);
  }
  return items;
}

test("a manifest raw entry no note points back to is an uncovered snapshot and exits non-zero", () => {
  const dir = makeVault();
  // a clean, fully-connected, tagged note - the ONLY issue is the orphaned raw entry below.
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nSaw [[people/anna]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  // a raw snapshot that NO note references back via source:/sources:.
  writeManifest(dir, {
    "raw/scan/result.md": { hash: "abc", note: "", ingested: "2026-01-01T00:00:00Z", raw: "raw/scan/result.md", src: "/some/source" },
  });
  const { code, out } = runCheck(dir);
  expect(out).toContain("uncovered snapshots");
  expect(uncoveredList(out)).toContain("raw/scan/result");
  // the uncovered count feeds the issues sum, so the process must exit non-zero. A regression that
  // dropped uncovered.length from that sum would still print the warning but exit 0 - this catches it.
  expect(code).not.toBe(0);
});

test("a manifest raw entry a note references via source: is covered (not reported)", () => {
  const dir = makeVault();
  // the note points back at the raw snapshot through source: "[[raw/...]]" (the scalar wikilink form).
  note(
    dir,
    "health/checkup.md",
    "domain: health\ntags: [health]\nsource: \"[[raw/scan/result]]\"",
    "# Checkup\n\nSaw [[people/anna]]."
  );
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  writeManifest(dir, {
    "raw/scan/result.md": { hash: "abc", note: "health/checkup.md", ingested: "2026-01-01T00:00:00Z", raw: "raw/scan/result.md" },
  });
  const { code, out } = runCheck(dir);
  // the single raw entry is covered, so the affirmative line shows and nothing is flagged.
  expect(out).toContain("every raw snapshot has a derived note");
  expect(out).not.toContain("uncovered snapshots");
  expect(uncoveredList(out)).not.toContain("raw/scan/result");
  expect(out).toContain("clean.");
  expect(code).toBe(0);
});

// --- source: / sources: back-reference parsing ----------------------------
// Both forms feed the same referencedRaw set that the coverage check subtracts from the manifest's raw
// entries. The scalar source: accepts a [[raw/...]] wikilink; the sources: [] list form is greedy to the
// last bracket so [[...]] wikilink entries survive too. We assert each form marks its entry covered,
// mixed with an uncovered control.

test("source: '[[raw/foo/bar]]' marks that raw entry covered", () => {
  const dir = makeVault();
  note(
    dir,
    "work/report.md",
    "domain: work\ntags: [work]\nsource: \"[[raw/foo/bar]]\"",
    "# Report\n\nSee [[people/anna]]."
  );
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  // two raw entries: foo/bar is referenced, foo/other is not -> exactly one uncovered.
  writeManifest(dir, {
    "raw/foo/bar.md": { hash: "h1", note: "work/report.md", ingested: "2026-01-01T00:00:00Z", raw: "raw/foo/bar.md" },
    "raw/foo/other.md": { hash: "h2", note: "", ingested: "2026-01-01T00:00:00Z", raw: "raw/foo/other.md" },
  });
  const { code, out } = runCheck(dir);
  expect(out).toContain("uncovered snapshots");
  expect(uncoveredList(out)).not.toContain("raw/foo/bar"); // covered by source:
  expect(uncoveredList(out)).toContain("raw/foo/other"); // the unreferenced control
  expect(code).not.toBe(0);
});

test("sources: ['raw/a', 'raw/b'] list form marks both entries covered", () => {
  const dir = makeVault();
  // The list parser splits on commas and strips quotes/brackets; plain string entries are what it
  // reads cleanly (a [[...]] wikilink inside the list would be truncated at the first ]). Both a and b
  // are covered, so a vault whose only raw entries are a and b is fully covered and exits 0.
  note(
    dir,
    "work/report.md",
    "domain: work\ntags: [work]\nsources: [\"raw/a\", \"raw/b\"]",
    "# Report\n\nSee [[people/anna]]."
  );
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  writeManifest(dir, {
    "raw/a.md": { hash: "h1", note: "work/report.md", ingested: "2026-01-01T00:00:00Z", raw: "raw/a.md" },
    "raw/b.md": { hash: "h2", note: "work/report.md", ingested: "2026-01-01T00:00:00Z", raw: "raw/b.md" },
  });
  const { code, out } = runCheck(dir);
  expect(out).toContain("every raw snapshot has a derived note");
  expect(out).not.toContain("uncovered snapshots");
  expect(out).toContain("clean.");
  expect(code).toBe(0);
});

test("sources: list of [[raw/...]] wikilinks marks every entry covered (not just the first)", () => {
  const dir = makeVault();
  // Greedy capture to the last bracket: a wikilink list must not truncate at the first inner "]".
  note(
    dir,
    "work/report.md",
    "domain: work\ntags: [work]\nsources: [\"[[raw/a]]\", \"[[raw/b]]\"]",
    "# Report\n\nSee [[people/anna]]."
  );
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  writeManifest(dir, {
    "raw/a.md": { hash: "h1", note: "work/report.md", ingested: "2026-01-01T00:00:00Z", raw: "raw/a.md" },
    "raw/b.md": { hash: "h2", note: "work/report.md", ingested: "2026-01-01T00:00:00Z", raw: "raw/b.md" },
  });
  const { code, out } = runCheck(dir);
  // Pre-fix, raw/b was reported uncovered because the non-greedy regex stopped inside [[raw/a]].
  expect(uncoveredList(out)).not.toContain("raw/a");
  expect(uncoveredList(out)).not.toContain("raw/b");
  expect(out).toContain("every raw snapshot has a derived note");
  expect(code).toBe(0);
});

// --- --all plugin aggregation against an injected stub plugin --------------
// --all globs projectRoot()/plugins/. To inject stubs deterministically we copy a minimal but
// functional repo (scripts + templates + manifests, node_modules symlinked) into a temp dir, drop
// our own plugins/<x>/check.ts, and run THAT copy's check.ts with IMPRINT_ROOT pointed at the copy so
// projectRoot() resolves there (not the real repo we're running from). The copy lets us control
// exactly which plugin checks exist, so the failing-plugin aggregation path is exercised directly.

// Copy the smallest repo that lets <copy>/scripts/check.ts run and glob <copy>/plugins. We omit the
// real plugins/ entirely and recreate it with only our stubs, so aggregation is fully deterministic.
function makeRepoCopy(): string {
  const copy = mkdtempSync(join(tmpdir(), "imprnt-repo-"));
  cpSync(join(repoRoot, "scripts"), join(copy, "scripts"), { recursive: true });
  cpSync(join(repoRoot, "templates"), join(copy, "templates"), { recursive: true });
  cpSync(join(repoRoot, "package.json"), join(copy, "package.json"));
  cpSync(join(repoRoot, "tsconfig.json"), join(copy, "tsconfig.json"));
  // Symlink the hoisted monorepo-root node_modules so `bun` resolves @types/bun etc. (workspaces
  // hoist deps to the repo root, two levels above packages/imprnt).
  symlinkSync(join(repoRoot, "..", "..", "node_modules"), join(copy, "node_modules"));
  mkdirSync(join(copy, "plugins"), { recursive: true });
  return copy;
}

// Drop a plugins/<name>/check.js (plain JS, the built artifact the aggregator globs + runs with
// process.execPath) that prints `msg` to stdout and exits with `exitCode`.
function stubPlugin(copy: string, name: string, msg: string, exitCode: number): void {
  const d = join(copy, "plugins", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "check.js"), `console.log(${JSON.stringify(msg)});\nprocess.exit(${exitCode});\n`);
}

// A clean temp vault (NOT the real repo vault) for the copied repo's core check to run against.
function makeCleanVault(): string {
  const dir = makeVault();
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nSaw [[people/anna]].");
  return dir;
}

test("--all surfaces a failing plugin: aggregate exit non-zero and plugin stdout forwarded", () => {
  const copy = makeRepoCopy();
  try {
    stubPlugin(copy, "boom", "PLUGIN_BOOM_OUTPUT", 1);
    const vault = makeCleanVault();
    const proc = Bun.spawnSync(["bun", join(copy, "scripts", "cli.ts"), "check", "--all", "--vault", vault], {
      env: { ...process.env, IMPRNT_ROOT: copy },
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    // core is clean, but the plugin exited 1 -> aggregate must be non-zero (the failed-plugin path).
    expect(out).toContain("clean."); // core had no issues
    expect(proc.exitCode).not.toBe(0);
    // stdout is forwarded verbatim (stdio inherited), and the per-plugin status line is printed.
    expect(out).toContain("PLUGIN_BOOM_OUTPUT");
    expect(out).toContain("plugins/boom/check.js → exit 1");
    expect(out).toContain("1 plugin check(s) failed.");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("--all with only a passing plugin and a clean core exits 0", () => {
  const copy = makeRepoCopy();
  try {
    stubPlugin(copy, "ok", "PLUGIN_OK_OUTPUT", 0);
    const vault = makeCleanVault();
    const proc = Bun.spawnSync(["bun", join(copy, "scripts", "cli.ts"), "check", "--all", "--vault", vault], {
      env: { ...process.env, IMPRNT_ROOT: copy },
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).toContain("clean.");
    expect(out).toContain("PLUGIN_OK_OUTPUT");
    expect(out).toContain("plugins/ok/check.js → exit 0");
    expect(out).toContain("all plugin checks passed.");
    expect(proc.exitCode).toBe(0);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

// "dead" sorts before "ok", so the broken entry is hit FIRST - pre-fix statSync threw ENOENT there
// and killed the whole aggregation before any plugin check ran.
test("--all tolerates a broken symlink under plugins/ and still runs the remaining checks", () => {
  const copy = makeRepoCopy();
  try {
    stubPlugin(copy, "ok", "PLUGIN_OK_OUTPUT", 0);
    symlinkSync(join(copy, "plugins", "no-such-target"), join(copy, "plugins", "dead"));
    const vault = makeCleanVault();
    const proc = Bun.spawnSync(["bun", join(copy, "scripts", "cli.ts"), "check", "--all", "--vault", vault], {
      env: { ...process.env, IMPRNT_ROOT: copy },
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(out).toContain("PLUGIN_OK_OUTPUT");
    expect(out).toContain("plugins/ok/check.js → exit 0");
    expect(out).toContain("all plugin checks passed.");
    expect(proc.exitCode).toBe(0);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

// --- dup-tag audit vs. synonym map ------------------------------------------
// A near-duplicate pair the user already merged exactly as the message instructs (a synonym entry in
// _tags.md) must stop being flagged - pre-fix it re-flagged forever, exit 1 permanently. The audit
// stays flag-only: an UNmerged pair is still flagged (covered by "vault with duplicate tags" above).

test("a dup pair already joined by a synonym entry is not re-flagged", () => {
  const dir = makeVault();
  writeFileSync(
    join(dir, "_tags.md"),
    "---\ntype: tags\n---\n\n# tags\n\n## Tags\nfinance, finances\n\n## Synonyms\nfinance -> finances\n"
  );
  note(dir, "people/anna.md", "type: person\ntags: [finances]", "# Anna");
  const { code, out } = runCheck(dir);
  expect(out).not.toContain("candidate duplicate tags");
  expect(out).toContain("clean.");
  expect(code).toBe(0);
});

// --- case-exact link resolution ---------------------------------------------
// Pre-fix the orphan check fell through to existsSync, which is case-insensitive on APFS: a
// case-wrong [[People/Anna]] passed the orphan check yet failed the entity-link check - two
// contradictory diagnostics from one link, and Linux disagreed with macOS. Both checks must resolve
// against the same exact-case slug set.

test("a case-wrong link is an orphan on every platform, agreeing with the entity-link check", () => {
  const dir = makeVault();
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nSaw [[People/Anna]].");
  const { code, out } = runCheck(dir);
  expect(out).toContain("orphan links");
  expect(out).toContain("[[People/Anna]]");
  // the entity-link check already failed this link - the orphan check must agree
  expect(disconnectedList(out)).toContain("health/checkup");
  expect(code).not.toBe(0);
});

// --- domain:/source: read from frontmatter only ------------------------------
// Pre-fix both fields were matched against the WHOLE file body, so a body line quoting the schema
// (`domain: health`) satisfied the domain check or marked a snapshot covered.

test("a body line quoting `domain:` does not satisfy the domain check", () => {
  const dir = makeVault();
  // frontmatter carries NO domain: - the body line must not mask the missing field.
  note(dir, "health/a.md", "type: note\ntags: [health]", "# A\n\nThe schema says a domain note carries\ndomain: health\nin frontmatter. See [[people/anna]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { code, out } = runCheck(dir);
  expect(out).toContain("domain mismatches");
  expect(domainMismatchSlugs(out)).toContain("health/a");
  expect(out).toContain("domain: (missing)");
  expect(code).not.toBe(0);
});

test("a body line quoting `source:` does not mark a snapshot covered", () => {
  const dir = makeVault();
  note(dir, "health/a.md", "domain: health\ntags: [health]", '# A\n\nNotes carry provenance like\nsource: "[[raw/scan/result]]"\nbut this one has none. See [[people/anna]].');
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  writeManifest(dir, {
    "raw/scan/result.md": { hash: "abc", note: "", ingested: "2026-01-01T00:00:00Z", raw: "raw/scan/result.md" },
  });
  const { code, out } = runCheck(dir);
  expect(out).toContain("uncovered snapshots");
  expect(uncoveredList(out)).toContain("raw/scan/result");
  expect(code).not.toBe(0);
});

// --- needs-review routing (the contract's soft-fail net) ----------------------
// CLAUDE.md "The ingest pass" step 4: check flags its findings into needs-review, surfaced atop
// hot.md. check OWNS a marker-fenced section of vault/_needs-review.md which it fully regenerates
// each run: stale findings disappear when fixed, the section is removed when clean, and lines ingest
// wrote outside the markers are never touched. Two consecutive runs leave the file byte-identical.

const CHECK_BEGIN = "<!-- imprnt-check:begin";
const CHECK_END = "<!-- imprnt-check:end -->";

test("check routes findings into _needs-review.md, idempotently, and clears them when fixed", () => {
  const dir = makeVault();
  // a pre-existing ingest line OUTSIDE the check section must survive every rewrite
  const ingestLine = "- [ ] unresolved person `people/bob` — from [[events/x]] (2026-01-01)";
  writeFileSync(join(dir, "_needs-review.md"), `---\ntype: needs-review\n---\n\n# Needs review\n\n${ingestLine}\n`);
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nLinks [[people/anna]] and [[people/ghost]].");

  runCheck(dir);
  const first = readFileSync(join(dir, "_needs-review.md"), "utf8");
  expect(first).toContain(CHECK_BEGIN);
  expect(first).toContain(CHECK_END);
  expect(first).toContain("- [ ] orphan link [[people/ghost]]");
  expect(first).toContain(ingestLine);
  // every finding line uses the `- [ ]` style `imprnt hot` surfaces via openNeedsReview
  expect(openNeedsReview(dir).some((l) => l.includes("orphan link [[people/ghost]]"))).toBe(true);

  // idempotent: a second run leaves the file byte-identical
  runCheck(dir);
  expect(readFileSync(join(dir, "_needs-review.md"), "utf8")).toBe(first);

  // fix the orphan -> the stale finding disappears and the whole section is removed
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nSaw [[people/anna]].");
  runCheck(dir);
  const cleared = readFileSync(join(dir, "_needs-review.md"), "utf8");
  expect(cleared).not.toContain(CHECK_BEGIN);
  expect(cleared).not.toContain("people/ghost");
  expect(cleared).toContain(ingestLine);
  // clearing is idempotent too: a clean re-run leaves the file byte-identical
  runCheck(dir);
  expect(readFileSync(join(dir, "_needs-review.md"), "utf8")).toBe(cleared);
});

test("check creates _needs-review.md when findings exist and the file is absent", () => {
  const dir = makeVault();
  note(dir, "people/anna.md", "type: person\ntags: []", "# Anna"); // untagged
  runCheck(dir);
  const txt = readFileSync(join(dir, "_needs-review.md"), "utf8");
  expect(txt).toContain(CHECK_BEGIN);
  expect(txt).toContain("- [ ] untagged note [[people/anna]]");
  expect(openNeedsReview(dir).some((l) => l.includes("untagged note [[people/anna]]"))).toBe(true);
});

test("a clean vault with no _needs-review.md does not create one", () => {
  const dir = makeVault();
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nSaw [[people/anna]].");
  const { code } = runCheck(dir);
  expect(code).toBe(0);
  expect(existsSync(join(dir, "_needs-review.md"))).toBe(false);
});

test("every finding category lands in the check section with its own line style", () => {
  const dir = makeVault();
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  // orphan + disconnected + untagged in one note, domain mismatch in another, plus an uncovered snapshot
  note(dir, "health/a.md", "domain: health\ntags: []", "# A\n\nSee [[people/ghost]].");
  note(dir, "health/b.md", "domain: work\ntags: [health]", "# B\n\nSee [[people/anna]].");
  writeManifest(dir, {
    "raw/scan/result.md": { hash: "abc", note: "", ingested: "2026-01-01T00:00:00Z", raw: "raw/scan/result.md" },
  });
  runCheck(dir);
  const txt = readFileSync(join(dir, "_needs-review.md"), "utf8");
  expect(txt).toContain("- [ ] orphan link [[people/ghost]] — from [[health/a]], target note missing");
  expect(txt).toContain("- [ ] disconnected note [[health/a]] — links no entity");
  expect(txt).toContain("- [ ] untagged note [[health/a]] — empty tags, findable by body/title only");
  expect(txt).toContain("- [ ] domain mismatch [[health/b]] — in health/ but domain: work");
  expect(txt).toContain("- [ ] unclassified snapshot `raw/scan/result` — no vault note points back");
});

// --- needs-review: unpaired / corrupt markers (finding 1) ---------------------
// _needs-review.md is a human tick-list. A user may delete the END marker (leaving an unbalanced
// begin), or quote the end-marker string in prose ABOVE the section (so a naive indexOf finds the
// end BEFORE the begin). Both cases must NOT (a) eat ingest lines trapped between the markers, nor
// (b) append an unbounded run of duplicate sections. The fix locates END only AFTER begin, and a
// begin-without-a-following-end means "replace from begin to end of file" (the rest is stale/corrupt),
// never an append. Lines OUTSIDE the markers (ingest's, the user's) survive in order, byte-idempotent.

// The exact markers check.ts writes. Kept here so a corrupt fixture is built with the REAL begin line
// (a near-miss prefix would not reproduce the indexOf pairing bug the fix targets).
const REVIEW_BEGIN =
  "<!-- imprnt-check:begin (regenerated by `imprnt check` - do not edit between the markers) -->";
const REVIEW_END = "<!-- imprnt-check:end -->";

// Count non-overlapping occurrences of the begin marker - the duplicate-section symptom.
function countSections(txt: string): number {
  return txt.split(REVIEW_BEGIN).length - 1;
}

test("an ingest line trapped after a user-deleted END marker survives the next check run", () => {
  const dir = makeVault();
  // The user hand-deleted the END marker, leaving a begin with NO following end. Then ingest's
  // appendFileSync (it always appends at EOF) dropped its soft-fail line BELOW the orphaned begin - the
  // ONLY record that ingest failed. Pre-fix, e = indexOf(END) = -1 fell to the append branch and grew a
  // SECOND section; a later run then sliced begin..firstEnd and ate this line. It must survive.
  const ingestLine = "- [ ] unresolved person `people/zed` — from [[events/y]] (2026-02-02)";
  writeFileSync(
    join(dir, "_needs-review.md"),
    `---\ntype: needs-review\n---\n\n# Needs review\n\n${REVIEW_BEGIN}\n- [ ] stale finding from a prior run\n${ingestLine}\n`
  );
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nLinks [[people/anna]] and [[people/ghost]].");

  runCheck(dir);
  const first = readFileSync(join(dir, "_needs-review.md"), "utf8");
  // the ingest line must NOT be eaten. In a corrupt orphan-begin recovery, a `- [ ]` line below the dead
  // begin is indistinguishable from an ingest append by shape, so check preserves it rather than risk
  // destroying the only record ingest failed (the stale finding is preserved for the same reason).
  expect(first).toContain(ingestLine);
  // exactly ONE section, not a second appended one (the unbounded-growth trap never forms)
  expect(countSections(first)).toBe(1);
  // the fresh finding is written into the one well-formed section
  expect(first).toContain("- [ ] orphan link [[people/ghost]]");

  // byte-idempotent: the orphan begin is healed to a proper begin..end pair, so a second run is identical
  runCheck(dir);
  expect(readFileSync(join(dir, "_needs-review.md"), "utf8")).toBe(first);
});

test("an END marker quoted in prose ABOVE the section does not spawn duplicate sections", () => {
  const dir = makeVault();
  // A prose line quotes the end-marker string BEFORE the real section, so indexOf(END) < indexOf(BEGIN).
  // The pre-fix code saw e < b, fell to the append branch, and grew a fresh duplicate section every run.
  const quoted = `The end marker looks like ${REVIEW_END} in the docs.`;
  writeFileSync(
    join(dir, "_needs-review.md"),
    `---\ntype: needs-review\n---\n\n# Needs review\n\n${quoted}\n\n${REVIEW_BEGIN}\n- [ ] stale finding\n${REVIEW_END}\n`
  );
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nLinks [[people/anna]] and [[people/ghost]].");

  runCheck(dir);
  const first = readFileSync(join(dir, "_needs-review.md"), "utf8");
  // the prose line survives, and there is still exactly ONE real section (the quote is not a marker pair)
  expect(first).toContain(quoted);
  expect(countSections(first)).toBe(1);
  expect(first).toContain("- [ ] orphan link [[people/ghost]]");
  expect(first).not.toContain("- [ ] stale finding");

  // run again and again - the section count must stay 1 (no unbounded growth) and be byte-idempotent
  runCheck(dir);
  const second = readFileSync(join(dir, "_needs-review.md"), "utf8");
  expect(second).toBe(first);
  expect(countSections(second)).toBe(1);
});

// --- vault walk tolerates a dangling symlink (finding 2) ----------------------
// A dangling symlink inside vault/ (a moved/deleted target) must not crash check before it reports or
// regenerates index.md. recall.ts already tolerates this and round 1 added it to the plugins/ walk;
// the vault walk in moc.ts/collectNotes is the remaining gap. check must exit cleanly and still run.

test("a dangling symlink under vault/ does not crash check", () => {
  const dir = makeVault();
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  note(dir, "health/checkup.md", "domain: health\ntags: [health]", "# Checkup\n\nSaw [[people/anna]].");
  // a symlink whose target does not exist - statSync on it throws ENOENT.
  symlinkSync(join(dir, "health", "no-such-note.md"), join(dir, "health", "dangling.md"));
  const { code, out } = runCheck(dir);
  // the run completes: it reports AND regenerates the index rather than dying on the dead link.
  expect(out).toContain("imprnt check");
  expect(out).toContain("regenerated index.md");
  expect(existsSync(join(dir, "index.md"))).toBe(true);
  // the two real notes are clean, so the exit is 0 (the dead link is skipped, not flagged).
  expect(code).toBe(0);
});

// --- domain: read tolerates the contract's quote/comment forms (finding 3) ----
// The contract mandates quoting for source: ("[[raw/...]]"), and a user may quote domain: the same way
// or trail a comment. Reading domain: with a raw regex that keeps the quotes/comment turned a LEGAL
// `domain: "health"` into a FALSE mismatch (a permanent needs-review line + exit 1). The read must use
// fmScalar (quote-stripping, frontmatter-scoped) so the value compares equal to the folder name.

test("domain: \"health\" (quoted, contract style) in health/ is NOT a mismatch", () => {
  const dir = makeVault();
  note(dir, "health/a.md", 'domain: "health"\ntags: [health]', "# A\n\nSee [[people/anna]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { code, out } = runCheck(dir);
  expect(domainMismatchSlugs(out)).not.toContain("health/a");
  expect(out).toContain("every domain note's folder matches its domain: field");
  expect(code).toBe(0);
});

test("domain: health with a trailing comment in health/ is NOT a mismatch", () => {
  const dir = makeVault();
  note(dir, "health/a.md", "domain: health  # life-area\ntags: [health]", "# A\n\nSee [[people/anna]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { out } = runCheck(dir);
  expect(domainMismatchSlugs(out)).not.toContain("health/a");
  expect(out).toContain("every domain note's folder matches its domain: field");
});

test("a genuine domain mismatch is STILL flagged after the quote/comment-tolerant read", () => {
  const dir = makeVault();
  // health/ folder but domain: work -> a real mismatch, even quoted, must remain flagged.
  note(dir, "health/a.md", 'domain: "work"\ntags: [health]', "# A\n\nSee [[people/anna]].");
  note(dir, "people/anna.md", "type: person\ntags: [family]", "# Anna");
  const { code, out } = runCheck(dir);
  expect(out).toContain("domain mismatches");
  expect(domainMismatchSlugs(out)).toContain("health/a");
  expect(code).not.toBe(0);
});

// --- dup-tag audit vs. a CHAINED synonym merge (finding 4, test-only) ----------
// normalize() resolves to a fixed point (the tags.ts owner's parallel fix). A chained merge
// (shoe -> shoes, shoes -> footwear) means normalize(shoe) === normalize(shoes) === footwear, so the
// audit's same-canonical skip must NOT re-flag shoe ~ shoes. Pre-fixed-point, the single-hop skip
// resolved shoe -> shoes but shoes -> footwear, so shoe and shoes differed and the pair re-flagged
// forever (a permanent exit 1). This passes once the parallel normalize() fixed-point change lands.

test("a chained synonym merge (shoe->shoes->footwear) does not re-flag shoe~shoes", () => {
  const dir = makeVault();
  writeFileSync(
    join(dir, "_tags.md"),
    "---\ntype: tags\n---\n\n# tags\n\n## Tags\nshoe, shoes, footwear\n\n## Synonyms\nshoe -> shoes\nshoes -> footwear\n"
  );
  note(dir, "people/anna.md", "type: person\ntags: [footwear]", "# Anna");
  const { code, out } = runCheck(dir);
  // both shoe and shoes resolve (transitively) to footwear, so the pair is already merged - no flag.
  expect(out).not.toContain("candidate duplicate tags");
  expect(out).toContain("clean.");
  expect(code).toBe(0);
});
