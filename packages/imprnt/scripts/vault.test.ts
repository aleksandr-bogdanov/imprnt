// Tests for `imprnt vault`. Each runs vault.ts as a real subprocess against a temp HOME so the
// registry it reads is its own, and archive/restore go through real tar — the point of these is
// that a vault survives a round trip, and a mocked tar would prove nothing about that.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
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
