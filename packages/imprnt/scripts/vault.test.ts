// Tests for `imprnt vault`. Each runs vault.ts as a real subprocess against a temp HOME so the
// registry it reads is its own, and archive/restore go through real tar — the point of these is
// that a vault survives a round trip, and a mocked tar would prove nothing about that.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const VAULT = join(here, "vault.ts");

function makeProject(notes = 2): string {
  const dir = mkdtempSync(join(tmpdir(), "imprnt-vaultcmd-"));
  const project = join(dir, "myvault");
  for (const f of ["people", "orgs", "holdings", "identity", "health", "finances", "work", "life", "projects", "events", "mistakes"])
    mkdirSync(join(project, "vault", f), { recursive: true });
  mkdirSync(join(project, "raw"), { recursive: true });
  writeFileSync(join(project, "vault", "_tags.md"), "---\ntype: tags\n---\n\n# tags\n\n## Tags\nx\n\n## Synonyms\n");
  // isVaultProject requires BOTH control files; index.md alone is what a docs corpus has.
  writeFileSync(join(project, "vault", "index.md"), "# Index\n");
  for (let i = 0; i < notes; i++)
    writeFileSync(join(project, "vault", "life", `n${i}.md`), `---\ndomain: life\ntags: [x]\n---\n\n# Note ${i}\n`);
  return project;
}

function withHome(project?: string): { home: string; env: Record<string, string> } {
  const home = mkdtempSync(join(tmpdir(), "imprnt-home-"));
  const cfgDir = join(home, "imprnt");
  mkdirSync(cfgDir, { recursive: true });
  if (project) writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ default: "personal", vaults: { personal: project } }));
  // XDG_CONFIG_HOME is what configPath() honours, so the test never touches the real registry.
  return { home, env: { ...process.env, XDG_CONFIG_HOME: home } as Record<string, string> };
}

const run = (args: string[], env: Record<string, string>) =>
  Bun.spawnSync(["bun", VAULT, ...args], { env, stdout: "pipe", stderr: "pipe" });
const txt = (r: { stdout: Buffer; stderr: Buffer }) => `${r.stdout.toString()}${r.stderr.toString()}`;

test("list names the vault, its note count and the default marker", () => {
  const p = makeProject(3);
  const { env } = withHome(p);
  const out = txt(run(["list"], env));
  expect(out).toContain("personal");
  expect(out).toContain("3 notes");
  expect(out).toContain("*");
});

test("list flags a registered path whose vault is gone", () => {
  // The pointer outliving the thing is the failure worth naming: every read through it answers
  // from nowhere while the config still looks healthy.
  const p = makeProject();
  const { env } = withHome(p);
  rmSync(join(p, "vault"), { recursive: true, force: true });
  expect(txt(run(["list"], env))).toContain("MISSING");
});

test("list says what to do when nothing is registered", () => {
  const { env } = withHome();
  expect(txt(run(["list"], env))).toContain("imprnt init");
});

test("archive writes a verified tarball and reports the note count", () => {
  const p = makeProject(4);
  const { env, home } = withHome(p);
  const out = txt(run(["archive", "--out", home], env));
  expect(out).toContain("4 notes");
  expect(out).toContain("verified");
  expect(readdirSync(home).some((f) => f.endsWith(".tar.gz"))).toBe(true);
});

test("archive carries UNCOMMITTED work, because that is the whole point", () => {
  // A git bundle would hold only what was committed, and the notes somebody wrote this afternoon
  // are exactly the ones nobody has committed yet.
  const p = makeProject(1);
  writeFileSync(join(p, "vault", "life", "scratch.md"), "# never committed\n");
  const { env, home } = withHome(p);
  run(["archive", "--out", home], env);
  const arc = join(home, readdirSync(home).find((f) => f.endsWith(".tar.gz"))!);
  const listing = Bun.spawnSync(["tar", "tzf", arc]).stdout.toString();
  expect(listing).toContain("scratch.md");
});

test("archive takes a path as well as a registry name", () => {
  const p = makeProject(2);
  const { env, home } = withHome();
  expect(txt(run(["archive", p, "--out", home], env))).toContain("2 notes");
});

test("archive refuses a directory that is not a vault", () => {
  const dir = mkdtempSync(join(tmpdir(), "imprnt-notavault-"));
  const { env } = withHome();
  const r = run(["archive", dir], env);
  expect(r.exitCode).toBe(1);
  expect(txt(r)).toContain("not a vault project");
});

test("a vault survives archive then restore, notes intact", () => {
  const p = makeProject(5);
  const { env, home } = withHome(p);
  run(["archive", "--out", home], env);
  const arc = join(home, readdirSync(home).find((f) => f.endsWith(".tar.gz"))!);
  const dest = join(mkdtempSync(join(tmpdir(), "imprnt-restore-")), "here");
  const out = txt(run(["restore", arc, dest], env));
  expect(out).toContain("5 notes");
  expect(existsSync(join(dest, "myvault", "vault", "life", "n0.md"))).toBe(true);
});

test("restore refuses a non-empty directory", () => {
  // The moment somebody reaches for restore is the moment they can least afford to overwrite the
  // copy they still have.
  const p = makeProject();
  const { env, home } = withHome(p);
  run(["archive", "--out", home], env);
  const arc = join(home, readdirSync(home).find((f) => f.endsWith(".tar.gz"))!);
  const dest = mkdtempSync(join(tmpdir(), "imprnt-occupied-"));
  writeFileSync(join(dest, "something.txt"), "mine");
  const r = run(["restore", arc, dest], env);
  expect(r.exitCode).toBe(1);
  expect(txt(r)).toContain("not empty");
});

test("there is no delete subcommand, and help says why", () => {
  const { env } = withHome();
  const r = run(["delete"], env);
  expect(r.exitCode).toBe(1);
  const out = txt(r);
  expect(out).toContain("no `vault delete`");
  expect(out).toContain("human act");
});

test("bare vault prints help and exits 0", () => {
  const { env } = withHome();
  const r = run([], env);
  expect(r.exitCode).toBe(0);
  expect(txt(r)).toContain("imprnt vault");
});

// --- imprnt vault move: the seam crossing --------------------------------------------------------
// Sharing a note is MOVING it (1Password's rule): into the mount, out of the private vault, new ID,
// every link rewritten, no stub. These run vault.ts as a subprocess against a temp vault with a
// declared mount, so what they assert is what a person would see on their own disk.

// A vault carrying a `shared/` mount that declares its own roles, plus one private note to move.
function makeSeamVault(opts: { mountRoles?: string | null; twins?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "imprnt-seam-"));
  const vault = join(dir, "vault");
  for (const f of ["people", "orgs", "holdings", "identity", "health", "finances", "work", "life", "projects", "events", "mistakes"])
    mkdirSync(join(vault, f), { recursive: true });
  for (const f of ["finances", "people", "orgs"]) mkdirSync(join(vault, "shared", f), { recursive: true });
  mkdirSync(join(dir, "raw"), { recursive: true });
  writeFileSync(join(vault, "_tags.md"), "---\ntype: tags\n---\n\n# tags\n\n## Tags\nrent\n\n## Synonyms\n");
  writeFileSync(join(vault, "index.md"), "# Index\n");
  writeFileSync(join(vault, "_folders.md"), "## Mounts\nshared\n");
  const mountRoles = opts.mountRoles === undefined ? "## Entities\npeople, orgs\n\n## Domains\nfinances, life\n" : opts.mountRoles;
  if (mountRoles !== null) writeFileSync(join(vault, "shared", "_folders.md"), mountRoles);
  writeFileSync(join(vault, "people", "sam.md"), "---\ntype: person\ntags: [rent]\n---\n\n# Sam\n");
  writeFileSync(join(vault, "orgs", "acme.md"), "---\ntype: org\ntags: [rent]\n---\n\n# Acme\n");
  if (opts.twins !== false) {
    writeFileSync(join(vault, "shared", "people", "sam.md"), "---\ntype: person\ntags: [rent]\n---\n\n# Sam\n");
    writeFileSync(join(vault, "shared", "orgs", "acme.md"), "---\ntype: org\ntags: [rent]\n---\n\n# Acme\n");
  }
  writeFileSync(join(vault, "finances", "rent.md"),
    "---\ntype: note\nkind: reference\ndomain: finances\ntags: [rent]\nsummary: \"the flat\"\n---\n\n# Rent\n\nSigned with [[people/sam]] at [[orgs/acme]].\n");
  writeFileSync(join(vault, "work", "notes.md"),
    "---\ntype: note\nkind: reference\ndomain: work\ntags: [rent]\n---\n\n# Notes\n\nsee [[finances/rent]] and [[finances/rent|the flat]]\n");
  return vault;
}

const moveEnv = { ...process.env } as Record<string, string>;

test("move files the note into the mount, rewrites every link, and leaves no stub", () => {
  const vault = makeSeamVault();
  const r = run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(0);
  expect(existsSync(join(vault, "shared", "finances", "rent.md"))).toBe(true);
  // No stub: a stub is the second copy the seam exists to prevent.
  expect(existsSync(join(vault, "finances", "rent.md"))).toBe(false);
  // Both link forms in the other note now point at the new ID, alias tail preserved.
  const notes = readFileSync(join(vault, "work", "notes.md"), "utf8");
  expect(notes).toContain("[[shared/finances/rent]]");
  expect(notes).toContain("[[shared/finances/rent|the flat]]");
  expect(notes).not.toContain("[[finances/rent");
  expect(txt(r)).toContain("who sees it now");
});

test("a link crossing INTO the mount is rewritten too, which is what makes the mount self-contained", () => {
  const vault = makeSeamVault();
  mkdirSync(join(vault, "shared", "life"), { recursive: true });
  writeFileSync(join(vault, "shared", "life", "flat.md"),
    "---\ntype: note\ndomain: life\ntags: [rent]\n---\n\n# Flat\n\nthe lease is [[finances/rent]]\n");
  expect(run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv).exitCode).toBe(0);
  // Before the move that link left the mount (a seam-leak); after it, it resolves inside the mount.
  expect(readFileSync(join(vault, "shared", "life", "flat.md"), "utf8")).toContain("[[shared/finances/rent]]");
});

test("move names the mount as who sees the note now, and lists what only a human can decide", () => {
  const vault = makeSeamVault();
  const out = txt(run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv));
  expect(out).toContain("shared/");
  expect(out).toContain("only a human can decide");
  expect(out).toContain("the language");
  // The entity links have mount-local twins, so they are printed to re-point, never rewritten for you:
  // [[people/sam]] and [[shared/people/sam]] are different notes with different content.
  expect(out).toContain("re-point it at [[shared/people/sam]]");
  expect(readFileSync(join(vault, "shared", "finances", "rent.md"), "utf8")).toContain("[[people/sam]]");
});

test("move appends one log.md line on the mover's side", () => {
  const vault = makeSeamVault();
  run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv);
  const log = readFileSync(join(vault, "log.md"), "utf8");
  expect(log).toContain("moved [[finances/rent]] → [[shared/finances/rent]]");
  expect(log).toContain("shared into shared/");
});

test("move sets domain: to the destination folder when the mount declares it a domain", () => {
  // The old value named the SOURCE vault's life-area, which means nothing across the seam. The new one
  // is decided by where the note lands, so setting it is filing, not judgment - and it is what the
  // mount's own roles then require of the note.
  const vault = makeSeamVault();
  run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv);
  const moved = readFileSync(join(vault, "shared", "finances", "rent.md"), "utf8");
  expect(moved).toContain("domain: finances");
  expect(moved.match(/^domain:/gm)?.length).toBe(1);
});

test("move DROPS domain: when the mount declares no roles of its own", () => {
  const vault = makeSeamVault({ mountRoles: null });
  const r = run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(0);
  expect(readFileSync(join(vault, "shared", "finances", "rent.md"), "utf8")).not.toContain("domain:");
  expect(txt(r)).toContain("domain: dropped");
});

test("move REFUSES a note whose source: points into this vault's private raw/", () => {
  const vault = makeSeamVault();
  const note = join(vault, "finances", "rent.md");
  writeFileSync(note, readFileSync(note, "utf8").replace("summary:", "source: \"[[raw/lease/scan]]\"\nsummary:"));
  const r = run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(1);
  expect(txt(r)).toContain("dead across the seam");
  // Nothing moved.
  expect(existsSync(note)).toBe(true);
  expect(existsSync(join(vault, "shared", "finances", "rent.md"))).toBe(false);
});

test("--force does NOT override a dead source:, because there is no version of leaving it that works", () => {
  const vault = makeSeamVault();
  const note = join(vault, "finances", "rent.md");
  writeFileSync(note, readFileSync(note, "utf8").replace("summary:", "source: \"[[raw/lease/scan]]\"\nsummary:"));
  const r = run(["move", "finances/rent", "shared/finances", "--force", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(1);
  expect(existsSync(note)).toBe(true);
});

test("move REFUSES when an entity link has no answer inside the mount", () => {
  const vault = makeSeamVault({ twins: false });
  const r = run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(1);
  expect(txt(r)).toContain("resolve only in this vault");
  expect(txt(r)).toContain("[[people/sam]]");
  expect(existsSync(join(vault, "finances", "rent.md"))).toBe(true);
  expect(existsSync(join(vault, "shared", "finances", "rent.md"))).toBe(false);
  // The refusal is total: no link anywhere was touched either.
  expect(readFileSync(join(vault, "work", "notes.md"), "utf8")).toContain("[[finances/rent]]");
});

test("--force moves anyway, leaves the links, and says check will report them as seam-leak", () => {
  const vault = makeSeamVault({ twins: false });
  const r = run(["move", "finances/rent", "shared/finances", "--force", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(0);
  const moved = readFileSync(join(vault, "shared", "finances", "rent.md"), "utf8");
  expect(moved).toContain("[[people/sam]]"); // left as it was, never silently re-pointed
  expect(txt(r)).toContain("seam-leak");
});

test("--force parses in any position, so it can never eat a positional argument", () => {
  const vault = makeSeamVault({ twins: false });
  const r = run(["move", "--force", "finances/rent", "shared/finances", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(0);
  expect(existsSync(join(vault, "shared", "finances", "rent.md"))).toBe(true);
});

test("a [[link]] inside a code fence is documentation, and the move leaves it byte-identical", () => {
  // check reads links through seam.ts's fence rule, so a fenced example was never an edge. Before the
  // mover shared that rule it rewrote them anyway: a documented snippet edited by a command nobody
  // aimed at it, and the checker's link set disagreeing with the mover's.
  const vault = makeSeamVault();
  const doc = join(vault, "work", "howto.md");
  const fenced = "```md\nsource: \"[[finances/rent]]\"\nsee [[finances/rent|the flat]]\n```";
  writeFileSync(doc, `---\ntype: note\nkind: howto\ndomain: work\ntags: [rent]\n---\n\n# Howto\n\nthe live one is [[finances/rent]].\n\n${fenced}\n\nand an inline \`[[finances/rent]]\` example.\n`);
  const r = run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(0);
  const after = readFileSync(doc, "utf8");
  expect(after).toContain("the live one is [[shared/finances/rent]].");
  expect(after).toContain(fenced);
  expect(after).toContain("an inline `[[finances/rent]]` example");
  // Three real links across two notes (two in work/notes.md, one here); the fenced pair and the inline
  // span are not counted, because they were never links.
  expect(txt(r)).toContain("3 link(s) rewritten across 2 note(s)");
});

test("a finished move leaves the log line finalised, with no in-progress marker behind it", () => {
  const vault = makeSeamVault();
  expect(run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv).exitCode).toBe(0);
  const log = readFileSync(join(vault, "log.md"), "utf8");
  expect(log).toContain("moved [[finances/rent]] → [[shared/finances/rent]]");
  expect(log).not.toContain("{move-in-progress}");
  expect(log).not.toContain("moving [[finances/rent]]");
});

test("an existing log.md keeps its history, and the move's line is finalised in place below it", () => {
  // Every other move test starts from a vault with no log.md, so only the create branch runs. This is
  // the append-to-existing one: the prior lines must survive verbatim, and the marker must be replaced
  // rather than left beside a second finished line.
  const vault = makeSeamVault();
  const prior = "---\ntype: log\ntags: [\"log\"]\n---\n\n# Log\n\n- 2026-08-30 filed [[work/notes]] — the older entry\n";
  writeFileSync(join(vault, "log.md"), prior);
  expect(run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv).exitCode).toBe(0);
  const log = readFileSync(join(vault, "log.md"), "utf8");
  expect(log.startsWith(prior)).toBe(true);
  expect(log).toContain("moved [[finances/rent]] → [[shared/finances/rent]]");
  expect(log).not.toContain("{move-in-progress}");
  expect(log.match(/moved \[\[finances\/rent\]\]/g)?.length).toBe(1);
});

test("a move that dies before the delete leaves a trace: the log records it in progress", () => {
  // The crash window is real, so it is tested for real. Making finances/ read-only makes the rmSync
  // that removes the source fail, which is exactly a crash between the destination write and the
  // delete: two copies of one fact on disk. What must survive is the log line - `imprnt check` reads
  // it back as move-fork, and without it the fork is silent.
  if (process.getuid?.() === 0) return; // root ignores the mode bits, so the window can't be forced
  const vault = makeSeamVault();
  chmodSync(join(vault, "finances"), 0o500);
  try {
    const r = run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv);
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(vault, "shared", "finances", "rent.md"))).toBe(true);
    expect(existsSync(join(vault, "finances", "rent.md"))).toBe(true); // the fork
    const log = readFileSync(join(vault, "log.md"), "utf8");
    expect(log).toContain("{move-in-progress}");
    expect(log).toContain("moving [[finances/rent]] → [[shared/finances/rent]]");
  } finally {
    chmodSync(join(vault, "finances"), 0o700);
  }
});

test("move refuses a destination that is not a declared mount", () => {
  const vault = makeSeamVault();
  const r = run(["move", "finances/rent", "life/bills", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(1);
  expect(txt(r)).toContain("is not a mount");
  expect(existsSync(join(vault, "finances", "rent.md"))).toBe(true);
});

test("move refuses a folder the mount's own _folders.md does not declare", () => {
  const vault = makeSeamVault();
  const r = run(["move", "finances/rent", "shared/health", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(1);
  expect(txt(r)).toContain("is not a folder shared/ declares");
});

test("move refuses a note that already lives in the mount", () => {
  const vault = makeSeamVault();
  run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv);
  const r = run(["move", "shared/finances/rent", "shared/life", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(1);
  expect(txt(r)).toContain("already");
});

test("move never overwrites a note already sitting at the destination", () => {
  const vault = makeSeamVault();
  writeFileSync(join(vault, "shared", "finances", "rent.md"), "---\ntype: note\ntags: [rent]\n---\n\n# Their rent note\n");
  const r = run(["move", "finances/rent", "shared/finances", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(1);
  expect(readFileSync(join(vault, "shared", "finances", "rent.md"), "utf8")).toContain("Their rent note");
  expect(existsSync(join(vault, "finances", "rent.md"))).toBe(true);
});

test("move says so when the note does not exist, and there is no copy verb", () => {
  const vault = makeSeamVault();
  expect(run(["move", "finances/ghost", "shared/finances", "--vault", vault], moveEnv).exitCode).toBe(1);
  const r = run(["copy", "finances/rent", "shared/finances", "--vault", vault], moveEnv);
  expect(r.exitCode).toBe(1);
  expect(txt(r)).toContain("imprnt vault");
});
