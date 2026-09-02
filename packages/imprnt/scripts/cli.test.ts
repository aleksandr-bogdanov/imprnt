import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, realpathSync, chmodSync, rmSync, symlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// cli.ts resolves the repo root from import.meta.url and edits CLAUDE.local.md there. To exercise
// the real binary without ever touching the real CLAUDE.local.md, we copy the scripts/ tree plus a
// fake plugins/ into a throwaway root and run the copied cli.ts. Each test wires that copy.
const realRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// The shipped contract (packages/imprnt/CLAUDE.md) is a gitignored shipdocs artifact, present on a
// dev machine only after a publish-prep run and NEVER on a fresh CI checkout. Tests that fake a
// package root copy the committed SOURCE of that artifact instead - the repo-root CLAUDE.md that
// shipdocs itself copies in.
const contractSrc = join(realRoot, "..", "..", "CLAUDE.md");

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "imprnt-cli-"));
  // The CLI only imports from scripts/ for the paths we test (plugin + vaultArg). Copy scripts/.
  cpSync(join(realRoot, "scripts"), join(root, "scripts"), { recursive: true });
  // Fake plugins gallery: a real entry, plus a malformed dir with no agent.md.
  mkdirSync(join(root, "plugins", "anti-slop"), { recursive: true });
  writeFileSync(join(root, "plugins", "anti-slop", "agent.md"), "x");
  mkdirSync(join(root, "plugins", "character"), { recursive: true });
  writeFileSync(join(root, "plugins", "character", "scribe.md"), "x");
  mkdirSync(join(root, "plugins", "demo"), { recursive: true });
  writeFileSync(join(root, "plugins", "demo", "demo.ts"), "x");
  return root;
}

type Run = { code: number; stdout: string; stderr: string };

// One spawn helper for both bins. EVERY child is sandboxed: XDG_CONFIG_HOME points into the tmp
// root (init writes the registry there, never into the developer's real ~/.config/imprnt) and
// the IMPRNT_* env overrides are blanked so the developer's shell can't steer resolution. A
// blanked (set-but-empty) var must read as UNSET in every consumer - roots.ts and registry.ts
// read truthiness, and cli.ts vaultArg uses || for the same reason (it once used ?? and treated
// "" as a real vault path, which this comment wrongly documented as "reads as unset"). Piped
// stdio also means the child sees NO TTY, which is itself under test for bare imp.
async function run(entry: string, root: string, args: string[], env: Record<string, string> = {}, cwd: string = root): Promise<Run> {
  const proc = Bun.spawn([process.execPath, join(root, "scripts", entry), ...args], {
    cwd,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "xdg"),
      // Sandbox the global-config dir into the tmp repo so `imprnt global` (and anything else that
      // reads it) can NEVER touch the developer's real ~/.claude. Every test inherits this.
      CLAUDE_CONFIG_DIR: join(root, "claude-config"),
      IMPRNT_ROOT: "",
      IMPRINT_ROOT: "",
      IMPRNT_VAULT: "",
      IMPRINT_VAULT: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

const runCli = (root: string, args: string[], env: Record<string, string> = {}, cwd?: string) => run("cli.ts", root, args, env, cwd);
const runImp = (root: string, args: string[], env: Record<string, string> = {}, cwd?: string) => run("imp.ts", root, args, env, cwd);

function readLocal(root: string): string {
  const p = join(root, "CLAUDE.local.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

let bunOk = true;
beforeAll(() => {
  bunOk = Bun.which("bun") !== null;
});

// --- bug 2: dangling --vault ---

test("hot with a dangling --vault exits 1 with a clean usage error (no stack trace)", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["hot", "--vault"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--vault <dir>");
  expect(r.stderr).not.toContain("TypeError");
  expect(r.stderr).not.toMatch(/at .*cli\.ts/);
});

// --- bug 1 + bug 3: multi-spec add end to end ---

test("plugin add a b wires BOTH (bug 1)", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "add", "character/scribe.md", "anti-slop"]);
  expect(r.code).toBe(0);
  const local = readLocal(root);
  expect(local).toContain("@plugins/character/scribe.md");
  expect(local).toContain("@plugins/anti-slop/agent.md");
});

// Build a synthetic plugin package source dir (the `--from` target): files[] keeps it to the
// shipped tree, so this exercises the exact npm-pack path a published plugin would.
function mkPluginSrc(root: string, name: string, withAgent = true): string {
  const dir = join(root, `src-${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `imprnt-plugin-${name}`, version: "0.0.1", files: withAgent ? ["agent.md", "check.js"] : ["check.js"] }));
  if (withAgent) writeFileSync(join(dir, "agent.md"), `# ${name}\n`);
  writeFileSync(join(dir, "check.js"), "console.log(1);\n");
  return dir;
}

test("plugin add <name> --from <dir> fetches, copies into plugins/, and wires it", async () => {
  const root = tmpRepo();
  const src = mkPluginSrc(root, "demo");
  const r = await runCli(root, ["plugin", "add", "demo", "--from", src]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("installed demo");
  expect(existsSync(join(root, "plugins", "demo", "agent.md"))).toBe(true);
  expect(existsSync(join(root, "plugins", "demo", "check.js"))).toBe(true);
  expect(readLocal(root)).toContain("@plugins/demo/agent.md");
});

test("plugin add with a missing --from errors, exits 1, wires nothing", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "add", "ghost", "--from", join(root, "nope")]);
  expect(r.code).toBe(1);
  expect(r.stderr).toMatch(/not found/);
  expect(readLocal(root)).not.toContain("@plugins/ghost");
});

test("plugin add a package with no agent.md errors, wires nothing", async () => {
  const root = tmpRepo();
  const src = mkPluginSrc(root, "bad", false);
  const r = await runCli(root, ["plugin", "add", "bad", "--from", src]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no agent.md");
  expect(readLocal(root)).not.toContain("@plugins/bad");
});

test("multi-spec add: bad spec skipped with error, good one wired, overall exit 1", async () => {
  const root = tmpRepo();
  // anti-slop pre-exists locally (installPlugin skips the fetch, then wires). The `missing/nope.md`
  // is a local wire-only spec with no such file -> errors. Mixed success + failure, exit 1.
  const r = await runCli(root, ["plugin", "add", "anti-slop", "missing/nope.md"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain("wired @plugins/anti-slop/agent.md");
  expect(r.stderr).toContain("no such plugin entry");
  const local = readLocal(root);
  expect(local).toContain("@plugins/anti-slop/agent.md");
  expect(local).not.toContain("@plugins/missing");
});

test("plugin add _personal/<file.md> wires the documented personalization path (exit 0)", async () => {
  const root = tmpRepo();
  // The documented "make it yours" flow: drop a private file under plugins/_personal/ and wire it.
  // listPluginDirs hides _personal from the gallery, but add must still wire it. This end-to-end
  // test would FAIL if the cli/add path ever excluded _-prefixed specs - exit would be 1 and no
  // @plugins/_personal line would land in CLAUDE.local.md.
  mkdirSync(join(root, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(root, "plugins", "_personal", "voice.md"), "x");
  const r = await runCli(root, ["plugin", "add", "_personal/voice.md"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("wired @plugins/_personal/voice.md");
  expect(readLocal(root)).toContain("@plugins/_personal/voice.md");
  // The gallery listing still does not surface _personal as a toggleable plugin.
  const list = await runCli(root, ["plugin", "list"]);
  expect(list.stdout).not.toContain("_personal");
});

test("plugin commands target the registered vault when run outside any project", async () => {
  // The pain this fixes: `imprnt plugin add` used to require cwd to BE the vault project. Now, run
  // from a bare unrelated dir, it falls back to the registered default vault (like imp does).
  const root = tmpRepo();
  const vaultProj = join(root, "registered-vault");
  mkVault(vaultProj);
  registerDefault(root, vaultProj);
  mkdirSync(join(vaultProj, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(vaultProj, "plugins", "_personal", "voice.md"), "x");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const r = await runCli(root, ["plugin", "add", "_personal/voice.md"], {}, elsewhere);
  expect(r.code).toBe(0);
  expect(r.stderr).toContain("targeting vault project");
  // wired into the REGISTERED vault, not the bare cwd
  expect(readFileSync(join(vaultProj, "CLAUDE.local.md"), "utf8")).toContain("@plugins/_personal/voice.md");
  expect(existsSync(join(elsewhere, "CLAUDE.local.md"))).toBe(false);
});

test("a project you are standing in beats the registered default for plugin commands", async () => {
  // cwd-precedence: managing a project you are inside must still win over the global default.
  const root = tmpRepo();
  const registered = join(root, "registered-vault");
  mkVault(registered);
  registerDefault(root, registered);
  mkVault(root); // root is now itself a real vault project
  mkdirSync(join(root, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(root, "plugins", "_personal", "x.md"), "x");
  const r = await runCli(root, ["plugin", "add", "_personal/x.md"], {}, root);
  expect(r.code).toBe(0);
  expect(readLocal(root)).toContain("@plugins/_personal/x.md"); // wired into the cwd project
  expect(existsSync(join(registered, "CLAUDE.local.md"))).toBe(false); // not the registered default
});

test("plugin add a a (duplicate spec in one call) is idempotent: a single line", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "add", "anti-slop", "anti-slop"]);
  expect(r.code).toBe(0);
  const lines = readLocal(root)
    .split("\n")
    .filter((l) => l.trim() === "@plugins/anti-slop/agent.md");
  expect(lines.length).toBe(1);
});

test("plugin rm accepts multiple specs", async () => {
  const root = tmpRepo();
  await runCli(root, ["plugin", "add", "anti-slop", "character/scribe.md"]);
  const r = await runCli(root, ["plugin", "rm", "anti-slop", "character"]);
  expect(r.code).toBe(0);
  const local = readLocal(root);
  expect(local).not.toContain("@plugins/anti-slop/agent.md");
  expect(local).not.toContain("@plugins/character/scribe.md");
});

test("unknown plugin subcommand exits 1", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "bogus"]);
  expect(r.code).toBe(1);
});

test("unknown top-level subcommand exits 1", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["nonsense"]);
  expect(r.code).toBe(1);
});

// --- the imp entry layer (imp bin, lair, context, init registration) ---

test("bare imp without a TTY prints help and exits 0 (never spawns claude)", async () => {
  const root = tmpRepo();
  const r = await runImp(root, []);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("imp lair");
  expect(r.stdout).toContain("the front door");
});

test("engine subcommands work identically under the imp bin", async () => {
  const root = tmpRepo();
  const r = await runImp(root, ["plugin", "list"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("plugins:");
});

test("imp lair with no vault project anywhere exits 1 with the init hint", async () => {
  const root = tmpRepo();
  const r = await runImp(root, ["lair"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("imprnt init");
});

// A dir only counts as a vault project when vault/ holds BOTH generated control files, index.md AND
// _tags.md (the hardened walk-up marker - index.md alone is also a docs site named vault), so the
// fixtures scaffold both, matching init output.
function mkVault(root: string): void {
  mkdirSync(join(root, "vault"), { recursive: true });
  writeFileSync(join(root, "vault", "index.md"), "# index\n");
  writeFileSync(join(root, "vault", "_tags.md"), "# tags\n");
}

// Register `dir` as the default vault in the sandbox's XDG config (join(root, "xdg")), the same
// path the run() helper points XDG_CONFIG_HOME at. Lets a test stage the registered-default READ
// path without running init.
function registerDefault(root: string, dir: string): void {
  const cfg = join(root, "xdg", "imprnt", "config.json");
  mkdirSync(dirname(cfg), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ default: "personal", vaults: { personal: dir } }) + "\n");
}

// A fake `claude` on PATH that dumps its argv (one ARG[i]= line each) and IMPRNT_VAULT, so a test
// can assert the exact spawn the imp launcher built. Returns a PATH value to pass to runImp.
function fakeClaudePath(root: string): string {
  const bin = join(root, "fakebin");
  mkdirSync(bin, { recursive: true });
  const claude = join(bin, "claude");
  writeFileSync(
    claude,
    "#!/bin/sh\nprintf 'IMPRNT_VAULT=%s\\n' \"$IMPRNT_VAULT\"\ni=0\nfor a in \"$@\"; do printf 'ARG[%d]=%s\\n' \"$i\" \"$a\"; i=$((i+1)); done\n",
  );
  chmodSync(claude, 0o755);
  return `${bin}:${process.env.PATH ?? ""}`;
}

test("imp lair with a vault but no claude on PATH exits 1 with the install hint", async () => {
  const root = tmpRepo();
  mkVault(root);
  const r = await runImp(root, ["lair"], { PATH: "" });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("`claude` not found");
});

test("imp with leading claude flags tries to launch even without a TTY (piped -p is legitimate)", async () => {
  const root = tmpRepo();
  mkVault(root);
  const r = await runImp(root, ["-p", "hello"], { PATH: "" });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("`claude` not found");
  expect(r.stdout).not.toContain("the front door"); // not the help text
});

test("imp lair against a HOLLOW registered default errors not-found (no live default)", async () => {
  // The registered default dir survives but its vault/ is gone (deleted, or the dir replaced by
  // an unrelated repo). A bare existsSync gate would still resolve it and `imp lair` would open
  // claude in the hollow dir silently. liveDefault consults isVaultProject, so the default reads
  // as unregistered and lair gives the same init hint as a fresh machine.
  const reg = tmpRepo();
  mkVault(reg);
  const here = tmpRepo();
  registerDefault(here, reg);
  rmSync(join(reg, "vault"), { recursive: true });
  const r = await runImp(here, ["lair"], { PATH: fakeClaudePath(here) }, here);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("imprnt init");
  // The fake claude never ran, so its dump is absent.
  expect(r.stdout).not.toContain("IMPRNT_VAULT=");
});

test("imp lair's child env carries IMPRNT_VAULT so in-session cd keeps the engine working", async () => {
  // imp lair routes through the same childEnv as the exact-root launch, so the agent's in-session
  // `imprnt recall` resolves the real vault even after a cd inside the session.
  const reg = tmpRepo();
  mkVault(reg);
  const here = tmpRepo();
  registerDefault(here, reg);
  const r = await runImp(here, ["lair"], { PATH: fakeClaudePath(here) }, here);
  expect(r.code).toBe(0);
  // The registry stores the path verbatim, so childEnv joins vault/ onto exactly that.
  expect(r.stdout).toContain(`IMPRNT_VAULT=${join(reg, "vault")}`);
});

test("imprnt context prints the vault contract; without one it exits 1", async () => {
  const root = tmpRepo();
  mkVault(root);
  writeFileSync(join(root, "CLAUDE.md"), "# the contract\n");
  const hit = await runImp(root, ["context"]);
  expect(hit.code).toBe(0);
  expect(hit.stdout).toBe("# the contract\n");

  const bare = tmpRepo();
  const miss = await runImp(bare, ["context"]);
  expect(miss.code).toBe(1);
  expect(miss.stderr).toContain("imprnt init");
});

test("init registers the project as the default vault; a second init keeps it unless --register", async () => {
  const a = tmpRepo();
  cpSync(join(realRoot, "templates"), join(a, "templates"), { recursive: true });
  const xdg = join(a, "xdg");
  const first = await runImp(a, ["init"], { XDG_CONFIG_HOME: xdg });
  expect(first.code).toBe(0);
  expect(first.stdout).toContain("registered as imp's default vault project");
  // The child registers its process.cwd(), which resolves symlinks (macOS /var -> /private/var),
  // so compare against the realpath of the tmp dirs.
  const config = JSON.parse(readFileSync(join(xdg, "imprnt", "config.json"), "utf8"));
  expect(config.vaults.personal).toBe(realpathSync(a));

  const b = tmpRepo();
  cpSync(join(realRoot, "templates"), join(b, "templates"), { recursive: true });
  const second = await runImp(b, ["init"], { XDG_CONFIG_HOME: xdg });
  expect(second.stdout).toContain("kept the existing default vault project");
  expect(JSON.parse(readFileSync(join(xdg, "imprnt", "config.json"), "utf8")).vaults.personal).toBe(realpathSync(a));

  const forced = await runImp(b, ["init", "--register"], { XDG_CONFIG_HOME: xdg });
  expect(forced.stdout).toContain("registered as imp's default vault project");
  expect(JSON.parse(readFileSync(join(xdg, "imprnt", "config.json"), "utf8")).vaults.personal).toBe(realpathSync(b));
});

test("agent rejects a prototype-chain name (toString) instead of persisting it", async () => {
  // `"toString" in backends` is true via Object.prototype, so the old gate persisted the name and
  // every later imp crashed resolving it. Object.hasOwn keeps inherited keys out of the valid set.
  const root = tmpRepo();
  const r = await runCli(root, ["agent", "toString"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('unknown agent "toString"');
  // Nothing was written: the sandboxed registry never came into existence.
  expect(existsSync(join(root, "xdg", "imprnt", "config.json"))).toBe(false);
});

test("init with an unwritable config dir still scaffolds the vault, warns it could not register, exits 0", async () => {
  // The scaffold is the irreversible work and it succeeds: vault/ + control files land, and the
  // vault is fully usable via ./vault or IMPRNT_VAULT even unregistered. Only the convenience
  // registry write fails (config dir owner-stripped). It must print ONE clean line (no EACCES
  // stack) and NOT abort the successful scaffold, so the user is left with a working vault.
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  const xdg = join(root, "xdg");
  mkdirSync(xdg, { recursive: true });
  chmodSync(xdg, 0o555); // read+execute, no write: mkdir of <xdg>/imprnt fails with EACCES
  const r = await runImp(root, ["init"], { XDG_CONFIG_HOME: xdg });
  chmodSync(xdg, 0o755); // restore so the tmp tree cleans up
  // Scaffold succeeded -> exit 0, and the vault really is on disk.
  expect(r.code).toBe(0);
  expect(existsSync(join(root, "vault", "index.md"))).toBe(true);
  expect(existsSync(join(root, "vault", "people"))).toBe(true);
  expect(r.stdout).toContain("initialized vault at ./vault");
  // The registration failure is one clean warning line, not a raw stack. The fs error code may
  // appear inside that single line (it's useful context); what must NOT appear is a stack trace.
  expect(r.stderr).toContain("could not register");
  expect(r.stderr).not.toMatch(/\n\s+at /);
  expect(r.stderr.trim().split("\n").length).toBe(1); // exactly one line, no trace, no second error
  // And nothing claims it registered.
  expect(r.stdout).not.toContain("registered as imp's default vault project");
});

// --- spec containment end to end (the P0: a spec must never reach outside plugins/) ---

test("plugin rm .. --purge is rejected and deletes nothing", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "rm", "..", "--purge"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("invalid plugin spec");
  // The sandbox project survives intact.
  expect(existsSync(join(root, "scripts", "cli.ts"))).toBe(true);
  expect(existsSync(join(root, "plugins", "anti-slop", "agent.md"))).toBe(true);
});

test("plugin rm foo/.. --purge is rejected and plugins/ survives", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "rm", "foo/..", "--purge"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("invalid plugin spec");
  expect(existsSync(join(root, "plugins", "anti-slop", "agent.md"))).toBe(true);
});

test("plugin add of an escaping wire-only spec is rejected, nothing wired", async () => {
  const root = tmpRepo();
  writeFileSync(join(root, "secret.md"), "x");
  const r = await runCli(root, ["plugin", "add", "../secret.md"]);
  expect(r.code).toBe(1);
  expect(readLocal(root)).not.toContain("secret.md");
});

// --- dangling --from ---

test("plugin add with a dangling --from is a usage error (never a silent registry fetch)", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "add", "demo", "--from"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--from <dir>");
});

// --from feeds ONE local dir, so it names exactly one plugin. With two names the single dir would
// otherwise be copied into BOTH plugins/ (the second gets the wrong content, reported as success),
// and a typo'd extra token would install + wire the typo with real content (--from short-circuits
// the registry fetch, so even a 404-worthy name "succeeds"). Reject before installing anything.
test("plugin add with --from and more than one name errors, installs nothing, wires nothing", async () => {
  const root = tmpRepo();
  const src = mkPluginSrc(root, "demo");
  const r = await runCli(root, ["plugin", "add", "anti-slop", "character", "--from", src]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--from installs one local plugin");
  // The names are echoed so a typo'd extra token is visible.
  expect(r.stderr).toContain("anti-slop");
  expect(r.stderr).toContain("character");
  // Nothing was copied into the second name's dir, and nothing was wired for either.
  expect(existsSync(join(root, "plugins", "character", "agent.md"))).toBe(false);
  expect(readLocal(root)).not.toContain("@plugins/anti-slop/agent.md");
  expect(readLocal(root)).not.toContain("@plugins/character");
});

// The typo case from the same bug: `add anti-slop anti-slpo --from <dir>` must be refused, not
// silently install the typo with the real dir's content.
test("plugin add with --from and a typo'd extra name is refused, not silently installed", async () => {
  const root = tmpRepo();
  const src = mkPluginSrc(root, "demo");
  const r = await runCli(root, ["plugin", "add", "anti-slop", "anti-slpo", "--from", src]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--from installs one local plugin");
  expect(existsSync(join(root, "plugins", "anti-slpo"))).toBe(false);
  expect(readLocal(root)).not.toContain("@plugins/anti-slpo");
});

// The registry path (no --from) fetches each plugin's own package by convention, so multiple names
// stay valid there. This guards that the --from multi-name reject does not also block registry
// multi-name. The names below pre-exist locally so installPlugin skips the (offline) fetch and the
// test stays hermetic - what it asserts is that multi-name without --from is NOT a usage error.
test("plugin add of multiple names WITHOUT --from is not refused (registry path stays multi-name)", async () => {
  const root = tmpRepo();
  // Both dirs ship an agent.md in tmpRepo()'s fixture except character (scribe.md). Add anti-slop
  // (has agent.md) plus a wire-only file spec, both local, so no network is touched.
  const r = await runCli(root, ["plugin", "add", "anti-slop", "character/scribe.md"]);
  expect(r.code).toBe(0);
  expect(r.stderr).not.toContain("--from installs one local plugin");
  const local = readLocal(root);
  expect(local).toContain("@plugins/anti-slop/agent.md");
  expect(local).toContain("@plugins/character/scribe.md");
});

// --- rm/add symmetry for file specs ---

test("plugin rm <name>/<file.md> unwires exactly what add wired, leaving siblings", async () => {
  const root = tmpRepo();
  mkdirSync(join(root, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(root, "plugins", "_personal", "voice.md"), "x");
  writeFileSync(join(root, "plugins", "_personal", "taylor.md"), "x");
  await runCli(root, ["plugin", "add", "_personal/voice.md", "_personal/taylor.md"]);
  const r = await runCli(root, ["plugin", "rm", "_personal/voice.md"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("unwired _personal/voice.md");
  const local = readLocal(root);
  expect(local).not.toContain("@plugins/_personal/voice.md");
  expect(local).toContain("@plugins/_personal/taylor.md");
});

// --- fs-error states: clean one-line errors, per-name loop continuation ---

test("add with a read-only CLAUDE.local.md reports each name cleanly and keeps going", async () => {
  const root = tmpRepo();
  const p = join(root, "CLAUDE.local.md");
  writeFileSync(p, "# header\n");
  chmodSync(p, 0o444);
  const r = await runCli(root, ["plugin", "add", "anti-slop", "character/scribe.md"]);
  chmodSync(p, 0o644);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("anti-slop:");
  // The loop reached the second name instead of aborting on the first failure.
  expect(r.stderr).toContain("character/scribe.md:");
  expect(r.stderr).not.toMatch(/\n\s+at /); // a message, not a stack trace
});

test("wire failure after a copy reports the half-state (installed but not wired)", async () => {
  const root = tmpRepo();
  const src = mkPluginSrc(root, "demo");
  const p = join(root, "CLAUDE.local.md");
  writeFileSync(p, "# header\n");
  chmodSync(p, 0o444);
  const r = await runCli(root, ["plugin", "add", "demo", "--from", src]);
  chmodSync(p, 0o644);
  expect(r.code).toBe(1);
  expect(existsSync(join(root, "plugins", "demo", "agent.md"))).toBe(true);
  expect(r.stderr).toContain("not wired");
});

test("a directory named CLAUDE.local.md gives clean errors (list works, add reports)", async () => {
  const root = tmpRepo();
  mkdirSync(join(root, "CLAUDE.local.md"));
  const list = await runCli(root, ["plugin", "list"]);
  expect(list.code).toBe(0);
  expect(list.stdout).toContain("plugins:");
  const add = await runCli(root, ["plugin", "add", "anti-slop"]);
  expect(add.code).toBe(1);
  expect(add.stderr).toContain("anti-slop:");
  expect(add.stderr).not.toMatch(/\n\s+at /);
});

test("init where a plain FILE named vault exists errors cleanly (no EEXIST stack)", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "vault"), "not a directory");
  const r = await runCli(root, ["init"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("vault");
  expect(r.stderr).not.toMatch(/\n\s+at /);
});

// --- set-but-empty IMPRNT_VAULT must read as unset, like every other consumer of the var ---

test("hot with IMPRNT_VAULT set but empty falls back to ./vault", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["hot"], { IMPRNT_VAULT: "" });
  expect(r.code).toBe(1);
  // vaultArg must fall through to ./vault, never treat "" as a real path.
  expect(r.stderr).toContain(join("vault", "hot.md"));
});

// --- init refuses to nest inside an existing vault project ---

test("init from a subdirectory of an existing vault project refuses and names the root", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  mkVault(root);
  const sub = join(root, "notes", "deep");
  mkdirSync(sub, { recursive: true });
  const r = await runCli(root, ["init"], {}, sub);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain(realpathSync(root));
  // Nothing was scaffolded into the subdirectory.
  expect(existsSync(join(sub, "vault"))).toBe(false);
});

// --- init <path>: scaffold a DIFFERENT location than cwd ---

test("init <explicit-path> (non-interactive) scaffolds, registers, and contracts THAT path, not cwd", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  cpSync(contractSrc, join(root, "CLAUDE.md"), { recursive: true });
  const xdg = join(root, "xdg");
  // A fresh target OUTSIDE cwd (a sibling tmp path). It does not exist yet - init must create it.
  const target = join(root, "elsewhere", "myvault");
  const r = await runCli(root, ["init", target], { XDG_CONFIG_HOME: xdg });
  expect(r.code).toBe(0);
  // The vault lands at the target, not at cwd.
  expect(existsSync(join(target, "vault", "index.md"))).toBe(true);
  expect(existsSync(join(target, "vault", "people"))).toBe(true);
  expect(existsSync(join(target, "raw"))).toBe(true);
  expect(existsSync(join(target, "CLAUDE.md"))).toBe(true);
  // cwd was left untouched - no stray vault/ scaffolded where the command ran.
  expect(existsSync(join(root, "vault"))).toBe(false);
  // The report states the actual location (absolute target/vault), not "./vault".
  expect(r.stdout).toContain(`initialized vault at ${join(target, "vault")}`);
  expect(r.stdout).not.toContain("initialized vault at ./vault");
  // The registry records the TARGET, not cwd.
  const config = JSON.parse(readFileSync(join(xdg, "imprnt", "config.json"), "utf8"));
  expect(config.vaults.personal).toBe(target);
});

// The privacy promise made real: the contract + site say the vault is owner-only (`chmod 700`), so
// init must lock the project ROOT to 0700 (its traversal bit makes the whole tree owner-only). Without
// this the scaffold lands at the umask default (0755, world-readable). POSIX-only assertion.
test("init locks the vault project root to owner-only (0700)", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  cpSync(contractSrc, join(root, "CLAUDE.md"), { recursive: true });
  const target = join(root, "elsewhere", "myvault");
  const r = await runCli(root, ["init", target], { XDG_CONFIG_HOME: join(root, "xdg") });
  expect(r.code).toBe(0);
  // Low 9 permission bits === 0o700: rwx for owner, nothing for group/other.
  expect(statSync(target).mode & 0o777).toBe(0o700);
});

test("re-init reports a real mode change and stays quiet when the root is already 0700", async () => {
  // Re-init used to re-chmod the project root silently while printing "left untouched" — honest
  // output names the tighten when the bits actually change, and only then.
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  cpSync(contractSrc, join(root, "CLAUDE.md"), { recursive: true });
  const xdg = join(root, "xdg");
  const target = join(root, "revault");
  await runCli(root, ["init", target], { XDG_CONFIG_HOME: xdg });
  // Already 0700: the re-init must not claim a tighten that didn't happen.
  const quiet = await runCli(root, ["init", target], { XDG_CONFIG_HOME: xdg });
  expect(quiet.code).toBe(0);
  expect(quiet.stdout).toContain("left untouched");
  expect(quiet.stdout).not.toContain("chmod 700");
  // The mode drifted (a cp restore, a umask accident): the re-init tightens AND says so.
  chmodSync(target, 0o755);
  const honest = await runCli(root, ["init", target], { XDG_CONFIG_HOME: xdg });
  expect(honest.code).toBe(0);
  expect(honest.stdout).toContain("chmod 700");
  expect(statSync(target).mode & 0o777).toBe(0o700);
});

test("init <path> with --register before the path still reads the path as the positional", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  cpSync(contractSrc, join(root, "CLAUDE.md"), { recursive: true });
  const xdg = join(root, "xdg");
  const target = join(root, "twovault");
  // --register sits BEFORE the path: the positional parse skips flags and still finds the path.
  const r = await runCli(root, ["init", "--register", target], { XDG_CONFIG_HOME: xdg });
  expect(r.code).toBe(0);
  expect(existsSync(join(target, "vault", "index.md"))).toBe(true);
  expect(JSON.parse(readFileSync(join(xdg, "imprnt", "config.json"), "utf8")).vaults.personal).toBe(target);
});

test("init ~/<sub> expands the tilde to HOME (throwaway home, never the real one)", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  cpSync(contractSrc, join(root, "CLAUDE.md"), { recursive: true });
  const xdg = join(root, "xdg");
  // Point HOME at a throwaway dir so the ~ expansion can never touch the developer's real home.
  const fakeHome = join(root, "home");
  mkdirSync(fakeHome, { recursive: true });
  const r = await runCli(root, ["init", "~/imprnt"], { XDG_CONFIG_HOME: xdg, HOME: fakeHome });
  expect(r.code).toBe(0);
  // ~ resolved to the throwaway HOME, so the vault is under fakeHome/imprnt, not literal ~.
  const expected = join(fakeHome, "imprnt");
  expect(existsSync(join(expected, "vault", "index.md"))).toBe(true);
  expect(existsSync(join(root, "~"))).toBe(false); // no literal "~" dir leaked into cwd
  expect(r.stdout).toContain(`initialized vault at ${join(expected, "vault")}`);
  expect(JSON.parse(readFileSync(join(xdg, "imprnt", "config.json"), "utf8")).vaults.personal).toBe(expected);
});

// Regression: non-interactive init with NO arg still uses cwd (the script/CI/test path). This is
// what the spawn helper exercises (piped stdio -> no TTY), and what every existing init test above
// relies on. Asserted here once explicitly so a future change to the prompt branch can't quietly
// break the cwd fallback.
test("init with NO arg and no TTY still scaffolds in cwd and registers cwd (regression)", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  cpSync(contractSrc, join(root, "CLAUDE.md"), { recursive: true });
  const xdg = join(root, "xdg");
  const r = await runCli(root, ["init"], { XDG_CONFIG_HOME: xdg });
  expect(r.code).toBe(0);
  expect(existsSync(join(root, "vault", "index.md"))).toBe(true);
  expect(r.stdout).toContain("initialized vault at ./vault");
  // cwd resolves symlinks (macOS /var -> /private/var), so compare against the realpath.
  expect(JSON.parse(readFileSync(join(xdg, "imprnt", "config.json"), "utf8")).vaults.personal).toBe(realpathSync(root));
});

// The nest-refusal must also fire for an explicit TARGET inside an existing vault project, not just
// for cwd. init <path-inside-a-vault> would scaffold a second vault in the real one's corpus.
test("init <path> pointing INTO an existing vault project refuses and names the root", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  mkVault(root);
  // Run from an unrelated dir but TARGET a deep subdir of the real vault project.
  const target = join(root, "notes", "deep");
  const r = await runCli(root, ["init", target]);
  expect(r.code).toBe(1);
  // An explicit path is resolved but NOT realpath'd (matching resolvePath), so the refusal names
  // the enclosing root as the un-symlink-resolved `root`, not its realpath.
  expect(r.stderr).toContain(`inside the vault project at ${root}`);
  expect(existsSync(join(target, "vault"))).toBe(false);
});

// --- init refuses a control-file SLOT occupied by a non-regular node (no silent broken vault) ---

// A directory squatting on a control-file name (e.g. `vault/index.md` is a dir) used to pass the
// existsSync skip: cpSync was skipped, the file was omitted from the summary, and init exited 0 over a
// vault that check/recall/index-generation would then choke on. It must be a hard, named error.
test("init where a control file name is occupied by a DIRECTORY errors cleanly, never reports success", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  mkdirSync(join(root, "vault", "index.md"), { recursive: true }); // a DIRECTORY named index.md
  const r = await runCli(root, ["init"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("index.md");
  expect(r.stderr).toContain("directory");
  // It must NOT have claimed to scaffold/top-up, and index.md must still be the directory we made.
  expect(r.stdout).not.toContain("added missing control file");
  expect(r.stdout).not.toContain("initialized vault");
  expect(statSync(join(root, "vault", "index.md")).isDirectory()).toBe(true);
});

// A DANGLING symlink on a control-file name: cpSync would write the template THROUGH the link, creating
// a file at an arbitrary target path. init must refuse instead of silently creating that file.
test("init refuses a DANGLING symlink on a control-file name (never writes through it)", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  mkdirSync(join(root, "vault"), { recursive: true });
  const escapee = join(root, "escaped-journal.md"); // the link target, deliberately absent
  symlinkSync(escapee, join(root, "vault", "log.md")); // vault/log.md -> (nonexistent) escaped-journal.md
  const r = await runCli(root, ["init"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("log.md");
  expect(r.stderr).toContain("symlink");
  // The write-through never happened: the link target was not created.
  expect(existsSync(escapee)).toBe(false);
});

// A resolving symlink (points at a real file) is a user's own copy — init leaves it untouched and
// scaffolds the rest, staying idempotent rather than refusing.
test("init leaves a RESOLVING symlinked control file untouched and scaffolds the rest", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  mkdirSync(join(root, "vault"), { recursive: true });
  const real = join(root, "my-tags.md");
  writeFileSync(real, "# my own tags\n");
  symlinkSync(real, join(root, "vault", "_tags.md")); // resolves to a real file
  const r = await runCli(root, ["init"]);
  expect(r.code).toBe(0);
  // The user's file behind the link is untouched, and the other control files were created.
  expect(readFileSync(real, "utf8")).toContain("my own tags");
  expect(existsSync(join(root, "vault", "index.md"))).toBe(true);
});

// A symlink that RESOLVES but points at a DIRECTORY is as broken as a bare directory in the slot — and
// it resolves, so an existsSync-only guard would wave it through as "keep" and exit 0 over a vault that
// `check` then crashes on (EISDIR writing index.md). It must be refused like any other blocked slot.
test("init refuses a symlink-to-DIRECTORY on a control-file name (not silently kept)", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  mkdirSync(join(root, "vault"), { recursive: true });
  mkdirSync(join(root, "some-dir"), { recursive: true });
  symlinkSync(join(root, "some-dir"), join(root, "vault", "index.md")); // resolves, but to a directory
  const r = await runCli(root, ["init"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("index.md");
  expect(r.stdout).not.toContain("initialized vault");
});

// A target reached THROUGH a symlink whose real location is inside an existing vault must still be
// refused — a lexical-only walk-up would miss it and scaffold a second vault in the real one's tree.
test("init <path> through a symlink into an existing vault is refused (physical walk-up)", async () => {
  const root = tmpRepo();
  cpSync(join(realRoot, "templates"), join(root, "templates"), { recursive: true });
  // A real vault project at root/realvault, with a real subdir notes/ inside it.
  const realvault = join(root, "realvault");
  mkdirSync(join(realvault, "vault"), { recursive: true });
  writeFileSync(join(realvault, "vault", "index.md"), "# index\n");
  writeFileSync(join(realvault, "vault", "_tags.md"), "# tags\n");
  mkdirSync(join(realvault, "notes"), { recursive: true });
  // A symlink OUTSIDE the vault that points into it. Lexically root/linkroot/deep has no vault ancestor;
  // physically it is realvault/notes/deep, inside the vault.
  symlinkSync(join(realvault, "notes"), join(root, "linkroot"));
  const target = join(root, "linkroot", "deep");
  const r = await runCli(root, ["init", target]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("refusing to init");
  expect(r.stderr).toContain(realpathSync(realvault));
  // Nothing scaffolded into the real vault through the link.
  expect(existsSync(join(realvault, "notes", "deep", "vault"))).toBe(false);
});

// --- imprnt global: enable a behavior module imp injects into every imp session ---
// CLAUDE_CONFIG_DIR is sandboxed to <root>/claude-config by the run() helper, so these never touch
// the developer's real ~/.claude. The new design records the enable in <config>/imprnt/global.json
// and NEVER writes the user's CLAUDE.md.

test("global add --from records the module in the registry, copies it, and list shows it [on] - CLAUDE.md untouched", async () => {
  const root = tmpRepo(); // ships plugins/anti-slop/agent.md
  const add = await runCli(root, ["global", "add", "anti-slop", "--from", join(root, "plugins", "anti-slop")]);
  expect(add.code).toBe(0);
  expect(add.stdout).toContain("enabled anti-slop globally");
  expect(add.stdout).toContain("every imp session");

  // The enable lives in the imprnt-owned registry, NOT the user's CLAUDE.md.
  const reg = join(root, "claude-config", "imprnt", "global.json");
  expect(existsSync(reg)).toBe(true);
  expect(JSON.parse(readFileSync(reg, "utf8"))).toEqual({ enabled: ["anti-slop"] });
  expect(existsSync(join(root, "claude-config", "CLAUDE.md"))).toBe(false); // never created
  expect(existsSync(join(root, "claude-config", "imprnt", "anti-slop", "agent.md"))).toBe(true);

  const list = await runCli(root, ["global", "list"]);
  expect(list.stdout).toContain("[on]  anti-slop");
});

test("global add (bare name) promotes an installed project plugin to global scope", async () => {
  const root = tmpRepo();
  const add = await runCli(root, ["global", "add", "anti-slop"]); // no --from: promote plugins/anti-slop/
  expect(add.code).toBe(0);
  expect(existsSync(join(root, "claude-config", "imprnt", "anti-slop", "agent.md"))).toBe(true);
  expect(JSON.parse(readFileSync(join(root, "claude-config", "imprnt", "global.json"), "utf8"))).toEqual({ enabled: ["anti-slop"] });
});

test("global rm --purge drops the registry entry and the copy; the user's CLAUDE.md is never touched", async () => {
  const root = tmpRepo();
  // A user-authored global CLAUDE.md must survive every global command byte-for-byte.
  mkdirSync(join(root, "claude-config"), { recursive: true });
  const user = "# my global rules\n\nalways be terse.\n";
  writeFileSync(join(root, "claude-config", "CLAUDE.md"), user);
  await runCli(root, ["global", "add", "anti-slop", "--from", join(root, "plugins", "anti-slop")]);
  expect(readFileSync(join(root, "claude-config", "CLAUDE.md"), "utf8")).toBe(user); // add left it alone

  const rm = await runCli(root, ["global", "rm", "anti-slop", "--purge"]);
  expect(rm.code).toBe(0);
  expect(rm.stdout).toContain("disabled anti-slop globally");
  expect(readFileSync(join(root, "claude-config", "CLAUDE.md"), "utf8")).toBe(user); // still untouched
  expect(JSON.parse(readFileSync(join(root, "claude-config", "imprnt", "global.json"), "utf8"))).toEqual({ enabled: [] });
  expect(existsSync(join(root, "claude-config", "imprnt", "anti-slop"))).toBe(false); // purged
});

test("global migrates a legacy CLAUDE.md managed block into the registry and strips it (self-heal)", async () => {
  const root = tmpRepo();
  mkdirSync(join(root, "claude-config", "imprnt", "anti-slop"), { recursive: true });
  writeFileSync(join(root, "claude-config", "imprnt", "anti-slop", "agent.md"), "# anti-slop\n");
  // Simulate the OLD design's leftover: a copy on disk + a clean managed block in CLAUDE.md.
  const BEGIN = "<!-- imprnt:global BEGIN (managed by imprnt - edit with `imprnt global add/rm`) -->";
  const END = "<!-- imprnt:global END -->";
  writeFileSync(
    join(root, "claude-config", "CLAUDE.md"),
    `# my rules\n\nbe terse.\n\n${BEGIN}\n@imprnt/anti-slop/agent.md\n${END}\n`,
  );
  const list = await runCli(root, ["global", "list"]);
  expect(list.code).toBe(0);
  expect(list.stdout).toContain("[on]  anti-slop");
  const md = readFileSync(join(root, "claude-config", "CLAUDE.md"), "utf8");
  expect(md).not.toContain("imprnt:global"); // block stripped
  expect(md).toContain("be terse."); // user content preserved
  expect(JSON.parse(readFileSync(join(root, "claude-config", "imprnt", "global.json"), "utf8"))).toEqual({ enabled: ["anti-slop"] });
});

test("global add with a bad name exits 1 and writes nothing", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["global", "add", "../evil", "--from", join(root, "plugins", "anti-slop")]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("invalid module name");
  expect(existsSync(join(root, "claude-config", "CLAUDE.md"))).toBe(false);
  expect(existsSync(join(root, "claude-config", "imprnt", "global.json"))).toBe(false);
});

// --- module dispatch: `imprnt <module> <args>` runs plugins/<module>/<module>.js or .mjs ---
// The dispatcher discovers by filename, the same convention check --all uses. IMPRNT_ROOT pins
// pluginRoot() to the tmp repo, so the fake gallery is the only plugins/ the child can see. The
// stub echoes its args and exits with a chosen code, which is how we see stdio inherited and the
// exit code passed through untouched.
function stubModule(root: string, name: string, file: string, exitCode: number): void {
  const dir = join(root, "plugins", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `console.log("MODULE_" + ${JSON.stringify(file)} + " " + process.argv.slice(2).join(" "));\nprocess.exit(${exitCode});\n`);
}

test("imprnt <module> runs plugins/<module>/<module>.js with the args and passes the exit code through", async () => {
  const root = tmpRepo();
  stubModule(root, "cjsmod", "cjsmod.js", 3);
  const r = await runCli(root, ["cjsmod", "status", "--flag"], { IMPRNT_ROOT: root });
  expect(r.stdout).toContain("MODULE_cjsmod.js status --flag");
  expect(r.code).toBe(3);
});

test("imprnt <module> runs plugins/<module>/<module>.mjs when the plugin ships ESM", async () => {
  const root = tmpRepo();
  stubModule(root, "esmmod", "esmmod.mjs", 0);
  const r = await runCli(root, ["esmmod", "status"], { IMPRNT_ROOT: root });
  expect(r.stdout).toContain("MODULE_esmmod.mjs status");
  expect(r.stdout).not.toContain("engine (same subcommands under"); // the usage text never printed
  expect(r.code).toBe(0);
});

test("imprnt <module> with both .js and .mjs runs the .js once and says so on stderr", async () => {
  const root = tmpRepo();
  stubModule(root, "bothmod", "bothmod.js", 0);
  stubModule(root, "bothmod", "bothmod.mjs", 1);
  const r = await runCli(root, ["bothmod", "go"], { IMPRNT_ROOT: root });
  expect(r.stdout).toContain("MODULE_bothmod.js go");
  expect(r.stdout).not.toContain("MODULE_bothmod.mjs");
  expect(r.stderr).toContain("plugins/bothmod/bothmod.js wins over bothmod.mjs (both present)");
  expect(r.code).toBe(0);
});

test("imprnt <module> with neither .js nor .mjs falls through to the usage text and exits 1", async () => {
  const root = tmpRepo(); // plugins/demo carries only demo.ts, never a built script
  const r = await runCli(root, ["demo", "status"], { IMPRNT_ROOT: root });
  expect(r.stdout).not.toContain("MODULE_");
  expect(r.stdout).toContain("engine (same subcommands under");
  expect(r.code).toBe(1);
});

// --- the docs state the same rule the code runs ---
// Every line in the two contract files that names a plugin script by convention (plugins/*/check.js,
// <module>.js, <verb>.js) must also name .mjs, or the doc drifts back to the .js-only rule the
// dispatcher and check --all no longer enforce. The README is hard-wrapped, so the clause may sit on
// the continuation line. Lines naming a specific plugin's own built check.js are not conventions and
// are left alone.
test("CLAUDE.md and plugins/README.md name .mjs wherever they state the .js convention", () => {
  const repoRoot = join(realRoot, "..", "..");
  const convention = /plugins\/\*\/check\.js|<module>\.js|<verb>\.js/;
  for (const rel of ["CLAUDE.md", join("plugins", "README.md")]) {
    const lines = readFileSync(join(repoRoot, rel), "utf8").split("\n");
    const stale = lines
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l], i) => convention.test(l) && !(l + "\n" + (lines[i + 1] ?? "")).includes(".mjs"));
    expect(stale.map(([n, l]) => `${rel}:${n}: ${l.trim()}`)).toEqual([]);
  }
});
