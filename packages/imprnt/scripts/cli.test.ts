import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, realpathSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// cli.ts resolves the repo root from import.meta.url and edits CLAUDE.local.md there. To exercise
// the real binary without ever touching the real CLAUDE.local.md, we copy the scripts/ tree plus a
// fake plugins/ into a throwaway root and run the copied cli.ts. Each test wires that copy.
const realRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "imprnt-cli-"));
  // The CLI only imports from scripts/ for the paths we test (plugin + vaultArg). Copy scripts/.
  cpSync(join(realRoot, "scripts"), join(root, "scripts"), { recursive: true });
  // Fake plugins gallery: a real entry, plus a guard-style dir with no agent.md.
  mkdirSync(join(root, "plugins", "anti-slop"), { recursive: true });
  writeFileSync(join(root, "plugins", "anti-slop", "agent.md"), "x");
  mkdirSync(join(root, "plugins", "character"), { recursive: true });
  writeFileSync(join(root, "plugins", "character", "scribe.md"), "x");
  mkdirSync(join(root, "plugins", "guard"), { recursive: true });
  writeFileSync(join(root, "plugins", "guard", "guard.ts"), "x");
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

// A dir only counts as a vault project when vault/ holds the generated index.md (the hardened
// walk-up marker), so the fixtures scaffold both.
function mkVault(root: string): void {
  mkdirSync(join(root, "vault"), { recursive: true });
  writeFileSync(join(root, "vault", "index.md"), "# index\n");
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
