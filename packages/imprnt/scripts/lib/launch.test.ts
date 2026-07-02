import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { castFragment, pointerFragment, harnessFlags, isInside, buildLaunch, launchClaude, assembleSession, resolveLaunch, claudeBackend, geminiBackend, parseGeminiSessions, valuelessResumeIndex } from "./launch.ts";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// An empty global dir, so buildLaunch's default global injection contributes nothing unless a test
// opts in. Every buildLaunch call below passes this so the suite never reads the developer's real
// ~/.claude/imprnt/. A dedicated tmp dir per call keeps cross-test isolation.
function emptyGlobalDir(): string {
  return mkdtempSync(join(tmpdir(), "imprnt-launch-glob-"));
}

// buildLaunch reads IMPRNT_VAULT/IMPRINT_VAULT to decide whether to set the child env, and
// CLAUDE_CONFIG_DIR for the default global dir; keep the suite hermetic against the developer's shell.
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["IMPRNT_VAULT", "IMPRINT_VAULT", "CLAUDE_CONFIG_DIR", "IMPRNT_AGENT", "IMPRNT_YOLO"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Default every buildLaunch to an empty global dir, so a test that does not care about globals
  // never picks up the developer's real ~/.claude. CLAUDE_CONFIG_DIR is honored by defaultGlobalDir.
  process.env.CLAUDE_CONFIG_DIR = emptyGlobalDir();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function tmpVaultProject(): string {
  const root = mkdtempSync(join(tmpdir(), "imprnt-launch-"));
  mkdirSync(join(root, "vault"));
  return root;
}

// Stage an enabled global module under a fresh global dir and return that dir, for the global-
// injection tests. Mirrors what `imprnt global add` lands: a copy at <dir>/imprnt/<name>/agent.md
// plus a registry entry.
function globalDirWith(modules: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "imprnt-glob-"));
  const names: string[] = [];
  for (const [name, body] of Object.entries(modules)) {
    const mdir = join(dir, "imprnt", name);
    mkdirSync(mdir, { recursive: true });
    writeFileSync(join(mdir, "agent.md"), body);
    names.push(name);
  }
  writeFileSync(join(dir, "imprnt", "global.json"), JSON.stringify({ enabled: names.sort() }));
  return dir;
}

// --- castFragment: inline the enabled @imports, skip comments and dangling ones ---

test("castFragment concatenates enabled imports in order, skipping commented lines", () => {
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(root, "plugins", "_personal", "a.md"), "# A fragment\n");
  writeFileSync(join(root, "plugins", "_personal", "b.md"), "# B fragment\n");
  writeFileSync(
    join(root, "CLAUDE.local.md"),
    "# header\n@plugins/_personal/a.md\n# @plugins/_personal/disabled.md\n@plugins/_personal/b.md\n",
  );
  expect(castFragment(root)).toBe("# A fragment\n\n# B fragment");
});

test("castFragment tolerates a dangling import (skips it, keeps the rest)", () => {
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "x"), { recursive: true });
  writeFileSync(join(root, "plugins", "x", "agent.md"), "# X\n");
  writeFileSync(join(root, "CLAUDE.local.md"), "@plugins/ghost/agent.md\n@plugins/x/agent.md\n");
  expect(castFragment(root)).toBe("# X");
});

test("castFragment tolerates an import target that is a directory (warns, skips, keeps the rest)", () => {
  // existsSync is true for a directory, so the missing-import guard does not catch it - readFileSync
  // would throw EISDIR. A wired @import pointing at a *.md directory must warn and skip, never crash.
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "_personal"), { recursive: true });
  mkdirSync(join(root, "plugins", "_personal", "asdir.md"));
  writeFileSync(join(root, "plugins", "_personal", "ok.md"), "# OK\n");
  writeFileSync(
    join(root, "CLAUDE.local.md"),
    "@plugins/_personal/asdir.md\n@plugins/_personal/ok.md\n",
  );
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    expect(castFragment(root)).toBe("# OK");
  } finally {
    console.error = orig;
  }
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("asdir.md");
});

test("castFragment tolerates an unreadable import target (chmod 000 file: warns, skips, keeps the rest)", () => {
  // existsSync is true, but readFileSync throws EACCES. A wired target that exists yet cannot be read
  // must warn and skip exactly like the missing case, never abort the launch.
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "_personal"), { recursive: true });
  const locked = join(root, "plugins", "_personal", "locked.md");
  writeFileSync(locked, "# Locked\n");
  chmodSync(locked, 0o000);
  writeFileSync(join(root, "plugins", "_personal", "ok.md"), "# OK\n");
  writeFileSync(
    join(root, "CLAUDE.local.md"),
    "@plugins/_personal/locked.md\n@plugins/_personal/ok.md\n",
  );
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    expect(castFragment(root)).toBe("# OK");
  } finally {
    console.error = orig;
    // Restore perms so the temp dir is cleanable.
    chmodSync(locked, 0o600);
  }
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("locked.md");
});

test("buildLaunch still launches when a wired import is unreadable (the readable cast is inlined)", () => {
  // The whole point: an unreadable fragment degrades gracefully. buildLaunch must still emit the
  // injected flags with the readable cast present, not throw.
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "_personal"), { recursive: true });
  mkdirSync(join(root, "plugins", "_personal", "asdir.md"));
  writeFileSync(join(root, "plugins", "_personal", "ok.md"), "# Readable cast\n");
  writeFileSync(
    join(root, "CLAUDE.local.md"),
    "@plugins/_personal/asdir.md\n@plugins/_personal/ok.md\n",
  );
  const orig = console.error;
  console.error = () => {};
  try {
    const { args } = buildLaunch({ cwd: "/somewhere/else", vaultProject: root, pkgRoot });
    const fragment = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(fragment).toContain("# Readable cast");
    expect(fragment).toContain("imprnt recall");
    expect(args[args.indexOf("--add-dir") + 1]).toBe(root);
  } finally {
    console.error = orig;
  }
});

test("castFragment resolves absolute imports as Claude Code does (not project-relative)", () => {
  const root = tmpVaultProject();
  const elsewhere = mkdtempSync(join(tmpdir(), "imprnt-abs-"));
  writeFileSync(join(elsewhere, "frag.md"), "# Absolute fragment\n");
  writeFileSync(join(root, "CLAUDE.local.md"), `@${join(elsewhere, "frag.md")}\n`);
  expect(castFragment(root)).toBe("# Absolute fragment");
});

test("castFragment with no CLAUDE.local.md is empty (fresh setup loads zero plugins)", () => {
  expect(castFragment(tmpVaultProject())).toBe("");
});

// --- pointerFragment: the shipped template, rendered with the vault project path ---

test("pointerFragment renders the real template with the project path", () => {
  const p = pointerFragment(pkgRoot, "/home/u/my-vault");
  expect(p).toContain("/home/u/my-vault");
  expect(p).toContain("imprnt recall");
  expect(p).toContain("imprnt context");
  expect(p).not.toContain("{{VAULT_PROJECT}}");
});

test("pointerFragment keeps a $$ in the project path verbatim (no $-pattern substitution)", () => {
  expect(pointerFragment(pkgRoot, "/home/u/$$dollars/my-vault")).toContain("/home/u/$$dollars/my-vault");
});

// --- isInside ---

test("isInside: same dir, subdir, sibling", () => {
  expect(isInside("/a/b", "/a/b")).toBe(true);
  expect(isInside("/a/b/c", "/a/b")).toBe(true);
  expect(isInside("/a/bc", "/a/b")).toBe(false);
  expect(isInside("/a", "/a/b")).toBe(false);
});

test("isInside compares realpaths: a project spelled through a symlink still reads as inside", () => {
  const root = tmpVaultProject();
  const link = join(mkdtempSync(join(tmpdir(), "imprnt-link-")), "proj");
  symlinkSync(root, link);
  expect(isInside(join(root, "vault"), link)).toBe(true);
  expect(isInside(link, root)).toBe(true);
  // The consequence that matters: physically inside, symlink-spelled project, nothing injected
  // (otherwise imp injects while claude also loads CLAUDE.md natively from cwd - the double cast).
  expect(buildLaunch({ cwd: join(root, "vault"), vaultProject: link, pkgRoot }).args).toEqual([]);
});

// --- buildLaunch: the exact args + env the spawn receives ---

test("outside the vault project: passthrough + --append-system-prompt + --add-dir, env points the engine at the vault", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const { args, env } = buildLaunch({ cwd: "/somewhere/else", vaultProject: root, pkgRoot, passthrough: ["-c"] });
  expect(args[0]).toBe("-c");
  expect(args[1]).toBe("--append-system-prompt");
  expect(args[2]).toContain("imprnt recall");
  expect(args[3]).toBe("--add-dir");
  expect(args[4]).toBe(root);
  // The agent's in-session `imprnt recall` must hit THIS vault, not ./vault of the coding repo.
  expect(env.IMPRNT_VAULT).toBe(join(root, "vault"));
});

test("a user-set IMPRNT_VAULT is never overridden in the child env", () => {
  process.env.IMPRNT_VAULT = "/work/team/vault";
  const root = tmpVaultProject();
  const { env } = buildLaunch({ cwd: "/somewhere/else", vaultProject: root, pkgRoot });
  expect(env.IMPRNT_VAULT).toBe("/work/team/vault");
});

test("the injected fragment is cast first, pointer last", () => {
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "x"), { recursive: true });
  writeFileSync(join(root, "plugins", "x", "agent.md"), "# My cast\n");
  writeFileSync(join(root, "CLAUDE.local.md"), "@plugins/x/agent.md\n");
  const { args } = buildLaunch({ cwd: "/somewhere/else", vaultProject: root, pkgRoot });
  const fragment = args[args.indexOf("--append-system-prompt") + 1]!;
  expect(fragment.indexOf("# My cast")).toBeGreaterThanOrEqual(0);
  expect(fragment.indexOf("# My cast")).toBeLessThan(fragment.indexOf("imprnt recall"));
});

test("a user-passed --append-system-prompt gets the fragment MERGED in, never a second flag", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const { args } = buildLaunch({
    cwd: "/somewhere/else",
    vaultProject: root,
    pkgRoot,
    passthrough: ["--append-system-prompt", "be terse"],
  });
  const occurrences = args.filter((a) => a === "--append-system-prompt").length;
  expect(occurrences).toBe(1);
  const merged = args[args.indexOf("--append-system-prompt") + 1]!;
  expect(merged).toContain("be terse");
  expect(merged).toContain("imprnt recall");
});

test("a user-passed --append-system-prompt=value (equals form) gets the fragment MERGED in too", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const { args } = buildLaunch({
    cwd: "/somewhere/else",
    vaultProject: root,
    pkgRoot,
    passthrough: ["--append-system-prompt=be terse"],
  });
  const flags = args.filter((a) => a.startsWith("--append-system-prompt"));
  expect(flags.length).toBe(1);
  expect(flags[0]).toContain("be terse");
  expect(flags[0]).toContain("imprnt recall");
});

test("a trailing `-- prompt` keeps imp's injected flags in flag position, before the terminator", () => {
  // claude reads everything after `--` as positional prompt text. Appending the injected flags at
  // the very end would bury them past the terminator: the fragment + project path become prompt
  // text and --add-dir is dropped. Insert before the first `--` so they stay flags.
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const { args } = buildLaunch({
    cwd: "/somewhere/else",
    vaultProject: root,
    pkgRoot,
    passthrough: ["-c", "--", "my literal prompt"],
  });
  const term = args.indexOf("--");
  const aspIdx = args.indexOf("--append-system-prompt");
  const addDirIdx = args.indexOf("--add-dir");
  // Both injected flags land before the terminator, the user's positional after it, untouched.
  expect(aspIdx).toBeGreaterThanOrEqual(0);
  expect(aspIdx).toBeLessThan(term);
  expect(addDirIdx).toBeLessThan(term);
  expect(args[addDirIdx + 1]).toBe(root);
  expect(args[args.length - 1]).toBe("my literal prompt");
});

test("with no `--` terminator the injected flags still append at the end (round-1 shape)", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const { args } = buildLaunch({ cwd: "/somewhere/else", vaultProject: root, pkgRoot, passthrough: ["-c"] });
  expect(args[0]).toBe("-c");
  expect(args[args.length - 2]).toBe("--add-dir");
  expect(args[args.length - 1]).toBe(root);
});

test("a -p VALUE that merely starts with --append-system-prompt= is NOT mistaken for the user's flag", () => {
  // The equals-form scan must not match a value in value position. A prompt value that happens to
  // start with the flag string would otherwise get the fragment glued onto the prompt text, and no
  // real --append-system-prompt flag would be emitted. The fragment must arrive as its own flag.
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const { args } = buildLaunch({
    cwd: "/somewhere/else",
    vaultProject: root,
    pkgRoot,
    passthrough: ["-p", "--append-system-prompt=literal text the user typed"],
  });
  // The user's -p value is left verbatim, the fragment is its own separate flag.
  const pIdx = args.indexOf("-p");
  expect(args[pIdx + 1]).toBe("--append-system-prompt=literal text the user typed");
  const aspIdx = args.indexOf("--append-system-prompt");
  expect(aspIdx).toBeGreaterThanOrEqual(0);
  expect(args[aspIdx + 1]).toContain("imprnt recall");
});

test("an --add-dir VALUE that starts with --append-system-prompt= is NOT mistaken for the user's flag", () => {
  // --add-dir consumes its next token as an arbitrary path. A user pointing it at a dir whose name
  // happens to start with --append-system-prompt= must not have the fragment glued onto that path -
  // that would corrupt --add-dir's value AND set merged=true, so imp emits no real
  // --append-system-prompt flag and the cast/pointer never reach claude.
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const { args } = buildLaunch({
    cwd: "/somewhere/else",
    vaultProject: root,
    pkgRoot,
    passthrough: ["--add-dir", "--append-system-prompt=mydir"],
  });
  // The user's --add-dir value is left verbatim, the fragment is its own separate flag.
  const userAddDir = args.indexOf("--add-dir");
  expect(args[userAddDir + 1]).toBe("--append-system-prompt=mydir");
  const aspIdx = args.indexOf("--append-system-prompt");
  expect(aspIdx).toBeGreaterThanOrEqual(0);
  expect(args[aspIdx + 1]).toContain("imprnt recall");
});

test("inside the vault project nothing is injected (native loading, no double cast)", () => {
  const root = tmpVaultProject();
  expect(buildLaunch({ cwd: root, vaultProject: root, pkgRoot, passthrough: ["--resume"] }).args).toEqual(["--resume"]);
  expect(buildLaunch({ cwd: join(root, "vault"), vaultProject: root, pkgRoot }).args).toEqual([]);
});

test("inside the vault project the child env still points the engine at the vault", () => {
  const root = tmpVaultProject();
  // From a SUBDIR of the project: `imprnt recall` resolves ./vault relative to cwd, so without
  // the env the advertised commands fail. The exact root gets it too - one uniform rule.
  expect(buildLaunch({ cwd: join(root, "vault"), vaultProject: root, pkgRoot }).env.IMPRNT_VAULT).toBe(join(root, "vault"));
  expect(buildLaunch({ cwd: root, vaultProject: root, pkgRoot }).env.IMPRNT_VAULT).toBe(join(root, "vault"));
  // A user-set IMPRNT_VAULT stays untouched here too, same rule as the outside path.
  process.env.IMPRNT_VAULT = "/work/team/vault";
  expect(buildLaunch({ cwd: root, vaultProject: root, pkgRoot }).env.IMPRNT_VAULT).toBe("/work/team/vault");
});

test("no vault registered: plain claude, just the passthrough", () => {
  expect(buildLaunch({ cwd: "/x", pkgRoot, passthrough: ["-c"] }).args).toEqual(["-c"]);
});

test("a phantom vault project (missing dir or plain file) warns and launches plain claude", () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    const missing = buildLaunch({ cwd: "/somewhere/else", vaultProject: "/nope/missing", pkgRoot, passthrough: ["-c"] });
    expect(missing.args).toEqual(["-c"]);
    expect(missing.env.IMPRNT_VAULT).toBeUndefined();
    const file = join(mkdtempSync(join(tmpdir(), "imprnt-phantom-")), "proj");
    writeFileSync(file, "not a dir");
    expect(buildLaunch({ cwd: "/somewhere/else", vaultProject: file, pkgRoot }).args).toEqual([]);
  } finally {
    console.error = orig;
  }
  expect(errors.length).toBe(2);
  expect(errors[0]).toContain("/nope/missing");
});

// --- global modules: imp injects them on EVERY launch (bare, outside, AND inside/lair) ---

test("globals inject on the OUTSIDE launch, after the cast and pointer", () => {
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "x"), { recursive: true });
  writeFileSync(join(root, "plugins", "x", "agent.md"), "# My cast\n");
  writeFileSync(join(root, "CLAUDE.local.md"), "@plugins/x/agent.md\n");
  const globalDir = globalDirWith({ "anti-slop": "# GLOBAL anti-slop\n" });
  const { args } = buildLaunch({ cwd: "/somewhere/else", vaultProject: root, pkgRoot, globalDir });
  const fragment = args[args.indexOf("--append-system-prompt") + 1]!;
  expect(fragment).toContain("# My cast");
  expect(fragment).toContain("imprnt recall"); // pointer
  expect(fragment).toContain("# GLOBAL anti-slop");
  // Order: cast, then pointer, then globals.
  expect(fragment.indexOf("# My cast")).toBeLessThan(fragment.indexOf("imprnt recall"));
  expect(fragment.indexOf("imprnt recall")).toBeLessThan(fragment.indexOf("# GLOBAL anti-slop"));
});

test("globals inject INSIDE the vault project / lair (no project cast there, but globals still ride)", () => {
  const root = tmpVaultProject();
  const globalDir = globalDirWith({ "anti-slop": "# GLOBAL anti-slop\n" });
  // Inside the project: claude loads CLAUDE.md + CLAUDE.local.md natively, so no project cast is
  // injected - but globals live in <globalDir>/imprnt/, which claude never loads, so imp injects them.
  const { args } = buildLaunch({ cwd: root, vaultProject: root, pkgRoot, passthrough: ["-c"], globalDir });
  const aspIdx = args.indexOf("--append-system-prompt");
  expect(aspIdx).toBeGreaterThanOrEqual(0);
  const fragment = args[aspIdx + 1]!;
  expect(fragment).toBe("# GLOBAL anti-slop"); // ONLY the global, no cast, no pointer
  expect(fragment).not.toContain("imprnt recall");
  expect(args).toContain("-c"); // passthrough preserved
  expect(args).not.toContain("--add-dir"); // inside: no --add-dir
});

test("inside with NO globals injects nothing (the original native-loading shape is preserved)", () => {
  const root = tmpVaultProject();
  const globalDir = mkdtempSync(join(tmpdir(), "imprnt-glob-empty-")); // no imprnt/ at all
  expect(buildLaunch({ cwd: root, vaultProject: root, pkgRoot, passthrough: ["--resume"], globalDir }).args).toEqual(["--resume"]);
  expect(buildLaunch({ cwd: join(root, "vault"), vaultProject: root, pkgRoot, globalDir }).args).toEqual([]);
});

test("globals inject on the NO-VAULT launch (plain claude + globals, no pointer, no --add-dir)", () => {
  const globalDir = globalDirWith({ "anti-slop": "# GLOBAL anti-slop\n" });
  const { args } = buildLaunch({ cwd: "/x", pkgRoot, passthrough: ["-c"], globalDir });
  const aspIdx = args.indexOf("--append-system-prompt");
  expect(aspIdx).toBeGreaterThanOrEqual(0);
  expect(args[aspIdx + 1]).toBe("# GLOBAL anti-slop");
  expect(args).not.toContain("--add-dir");
  expect(args[0]).toBe("-c");
});

test("no vault and no globals: plain claude, just the passthrough (unchanged)", () => {
  const globalDir = mkdtempSync(join(tmpdir(), "imprnt-glob-none-"));
  expect(buildLaunch({ cwd: "/x", pkgRoot, passthrough: ["-c"], globalDir }).args).toEqual(["-c"]);
});

test("a plugin enabled BOTH project-locally and globally injects ONCE (deduped)", () => {
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "anti-slop"), { recursive: true });
  writeFileSync(join(root, "plugins", "anti-slop", "agent.md"), "# PROJECT anti-slop\n");
  writeFileSync(join(root, "CLAUDE.local.md"), "@plugins/anti-slop/agent.md\n");
  const globalDir = globalDirWith({ "anti-slop": "# GLOBAL anti-slop\n", "house-style": "# GLOBAL house style\n" });
  const { args } = buildLaunch({ cwd: "/somewhere/else", vaultProject: root, pkgRoot, globalDir });
  const fragment = args[args.indexOf("--append-system-prompt") + 1]!;
  // The project copy is what loads (via the project cast); the global anti-slop is SKIPPED.
  expect(fragment).toContain("# PROJECT anti-slop");
  expect(fragment).not.toContain("# GLOBAL anti-slop");
  // The other global (not enabled project-locally) still injects.
  expect(fragment).toContain("# GLOBAL house style");
});

test("globals merge into a user-passed --append-system-prompt on the no-vault path (one flag)", () => {
  const globalDir = globalDirWith({ "anti-slop": "# GLOBAL anti-slop\n" });
  const { args } = buildLaunch({ cwd: "/x", pkgRoot, passthrough: ["--append-system-prompt", "be terse"], globalDir });
  const occurrences = args.filter((a) => a === "--append-system-prompt").length;
  expect(occurrences).toBe(1);
  const merged = args[args.indexOf("--append-system-prompt") + 1]!;
  expect(merged).toContain("be terse");
  expect(merged).toContain("# GLOBAL anti-slop");
});

// --- launchClaude: the cwd guard (no spawn happens when the guard fires) ---

test("launchClaude refuses a missing or plain-FILE cwd with the re-run-init message, never blaming claude", () => {
  const file = join(mkdtempSync(join(tmpdir(), "imprnt-cwdfile-")), "proj");
  writeFileSync(file, "not a dir");
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    expect(launchClaude(file, ["--version"])).toBe(1);
    expect(launchClaude(join(file, "..", "definitely-missing"), ["--version"])).toBe(1);
  } finally {
    console.error = orig;
  }
  expect(errors.length).toBe(2);
  for (const e of errors) {
    expect(e).toContain("re-run");
    expect(e).not.toContain("failed to launch");
  }
});

// --- harnessFlags: --plugin-dir per native plugin + one merged --settings from fragments ---

// A project with two enabled plugins: `hooky` is a native Claude Code plugin (manifest only),
// `liner` carries only a settings fragment. Used by the harnessFlags rows below.
function tmpHarnessProject(): string {
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "hooky", ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, "plugins", "hooky", ".claude-plugin", "plugin.json"), '{"name":"hooky"}');
  writeFileSync(join(root, "plugins", "hooky", "agent.md"), "# hooky\n");
  mkdirSync(join(root, "plugins", "liner"), { recursive: true });
  writeFileSync(join(root, "plugins", "liner", "agent.md"), "# liner\n");
  writeFileSync(
    join(root, "plugins", "liner", "imp-settings.json"),
    '{"statusLine":{"type":"command","command":"node \\"${PLUGIN_DIR}/line.js\\""}}',
  );
  writeFileSync(join(root, "CLAUDE.local.md"), "@plugins/hooky/agent.md\n@plugins/liner/agent.md\n");
  return root;
}

test("harnessFlags emits --plugin-dir for a manifest plugin and --settings for a fragment plugin", () => {
  const root = tmpHarnessProject();
  const flags = harnessFlags(root);
  expect(flags.slice(0, 2)).toEqual(["--plugin-dir", join(root, "plugins", "hooky")]);
  expect(flags[2]).toBe("--settings");
  const settings = JSON.parse(flags[3]!);
  // ${PLUGIN_DIR} resolves to the plugin's own absolute dir, post-parse (a path can't corrupt JSON).
  expect(settings.statusLine.command).toBe(`node "${join(root, "plugins", "liner")}/line.js"`);
});

test("harnessFlags reads only ENABLED plugins and is empty when nothing harness-shaped is wired", () => {
  const root = tmpHarnessProject();
  // Disable hooky (comment), leave liner: no --plugin-dir, still the --settings.
  writeFileSync(join(root, "CLAUDE.local.md"), "# @plugins/hooky/agent.md\n@plugins/liner/agent.md\n");
  expect(harnessFlags(root)).not.toContain("--plugin-dir");
  // A cast-only project (fragments, no manifest, no imp-settings.json) emits nothing at all.
  writeFileSync(join(root, "CLAUDE.local.md"), "@plugins/hooky/agent.md\n");
  rmSync(join(root, "plugins", "hooky", ".claude-plugin"), { recursive: true });
  expect(harnessFlags(root)).toEqual([]);
});

test("harnessFlags merges fragments in wire order (later plugin wins on a key conflict)", () => {
  const root = tmpHarnessProject();
  mkdirSync(join(root, "plugins", "verbs"), { recursive: true });
  writeFileSync(join(root, "plugins", "verbs", "agent.md"), "# verbs\n");
  writeFileSync(
    join(root, "plugins", "verbs", "imp-settings.json"),
    '{"statusLine":{"padding":1},"spinnerVerbs":{"mode":"append","verbs":["Imprnting"]}}',
  );
  writeFileSync(
    join(root, "CLAUDE.local.md"),
    "@plugins/liner/agent.md\n@plugins/verbs/agent.md\n",
  );
  const flags = harnessFlags(root);
  const settings = JSON.parse(flags[flags.indexOf("--settings") + 1]!);
  // Objects merge recursively: liner's command survives, verbs' padding lands beside it.
  expect(settings.statusLine.command).toContain("line.js");
  expect(settings.statusLine.padding).toBe(1);
  expect(settings.spinnerVerbs.verbs).toEqual(["Imprnting"]);
});

test("harnessFlags tolerates a malformed fragment (warns, skips, keeps the rest)", () => {
  const root = tmpHarnessProject();
  writeFileSync(join(root, "plugins", "liner", "imp-settings.json"), "{not json");
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    // The manifest plugin still rides; the broken fragment contributes nothing.
    expect(harnessFlags(root)).toEqual(["--plugin-dir", join(root, "plugins", "hooky")]);
  } finally {
    console.error = orig;
  }
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("liner/imp-settings.json");
});

test("buildLaunch carries harness flags on EVERY launch, inside the project included, prepended outside", () => {
  const root = tmpHarnessProject();
  // Inside (the lair / a subdir): no cast injection, but the harness flags still ride.
  const inside = buildLaunch({ cwd: root, vaultProject: root, pkgRoot, passthrough: ["-c"] });
  expect(inside.args.slice(0, 2)).toEqual(["--plugin-dir", join(root, "plugins", "hooky")]);
  expect(inside.args[inside.args.length - 1]).toBe("-c");
  expect(inside.args).not.toContain("--append-system-prompt");
  // Outside: harness flags come FIRST, so a user-passed --settings (later) wins last-occurrence
  // resolution; the cast injection follows as before.
  const outside = buildLaunch({ cwd: "/somewhere/else", vaultProject: root, pkgRoot, passthrough: ["--settings", "{}"] });
  expect(outside.args.indexOf("--settings")).toBe(2); // ours, right after the --plugin-dir pair
  expect(outside.args.lastIndexOf("--settings")).toBeGreaterThan(outside.args.indexOf("--settings"));
  expect(outside.args).toContain("--append-system-prompt");
});

// --- resolveLaunch: which agent, whether to skip prompts, and stripping imp's own flags ---

test("resolveLaunch: --gemini / --claude flag wins and is stripped from the passthrough", () => {
  const g = resolveLaunch(["-c", "--gemini", "--resume"]);
  expect(g.backend.name).toBe("gemini");
  expect(g.passthrough).toEqual(["-c", "--resume"]);
  const c = resolveLaunch(["--claude", "-c"]);
  expect(c.backend.name).toBe("claude");
  expect(c.passthrough).toEqual(["-c"]);
});

test("resolveLaunch: agent precedence is flag > IMPRNT_AGENT > config > built-in claude", () => {
  // beforeEach cleared IMPRNT_AGENT / IMPRNT_YOLO, so the suite is hermetic against the dev shell.
  expect(resolveLaunch([]).backend.name).toBe("claude"); // built-in default
  expect(resolveLaunch([], { agent: "gemini" }).backend.name).toBe("gemini"); // config default
  process.env.IMPRNT_AGENT = "gemini";
  expect(resolveLaunch([]).backend.name).toBe("gemini"); // env over absent config
  expect(resolveLaunch([], { agent: "claude" }).backend.name).toBe("gemini"); // env over config
  expect(resolveLaunch(["--claude"]).backend.name).toBe("claude"); // flag over env
});

test("resolveLaunch: an unknown agent falls back to claude with a warning, never a crash", () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    expect(resolveLaunch([], { agent: "grok" }).backend.name).toBe("claude");
  } finally {
    console.error = orig;
  }
  expect(errors.length).toBe(1);
  expect(errors[0]).toContain("grok");
});

test("resolveLaunch: --yolo / --safe sets skipPermissions and is stripped from the passthrough", () => {
  const y = resolveLaunch(["-c", "--yolo"]);
  expect(y.skipPermissions).toBe(true);
  expect(y.passthrough).toEqual(["-c"]);
  const s = resolveLaunch(["--safe", "-c"], { yolo: true }); // flag overrides a config default of on
  expect(s.skipPermissions).toBe(false);
  expect(s.passthrough).toEqual(["-c"]);
});

test("resolveLaunch: skip precedence is flag > IMPRNT_YOLO > config > off (shipped safe)", () => {
  expect(resolveLaunch([]).skipPermissions).toBe(false); // built-in default: prompts on
  expect(resolveLaunch([], { yolo: true }).skipPermissions).toBe(true); // config default
  process.env.IMPRNT_YOLO = "0";
  expect(resolveLaunch([], { yolo: true }).skipPermissions).toBe(false); // env "0" over config-on
  process.env.IMPRNT_YOLO = "1";
  expect(resolveLaunch([], { yolo: false }).skipPermissions).toBe(true); // env "1" over config-off
  expect(resolveLaunch(["--safe"], { yolo: true }).skipPermissions).toBe(false); // flag over env
});

// --- geminiBackend: the full fragment rides a generated GEMINI.md, never the user's cwd ---

test("geminiBackend writes the full fragment to a temp GEMINI.md and adds it (plus the vault) via --include-directories (outside)", () => {
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "x"), { recursive: true });
  writeFileSync(join(root, "plugins", "x", "agent.md"), "# My cast\n");
  writeFileSync(join(root, "CLAUDE.local.md"), "@plugins/x/agent.md\n");
  const spec = assembleSession({ cwd: "/somewhere/else", vaultProject: root, pkgRoot });
  const args = geminiBackend.renderArgs(spec);
  const inclIdx = args.indexOf("--include-directories");
  expect(inclIdx).toBeGreaterThanOrEqual(0);
  const dirs = args[inclIdx + 1]!.split(",");
  // The vault rides as a workspace dir; the FIRST dir is the throwaway context dir.
  expect(dirs).toContain(root);
  const gm = readFileSync(join(dirs[0]!, "GEMINI.md"), "utf8");
  expect(gm).toContain("# My cast"); // the cast
  expect(gm).toContain("imprnt recall"); // the pointer
});

test("geminiBackend inside the vault STILL injects cast+pointer (gemini loads nothing natively) and adds no vault dir", () => {
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "x"), { recursive: true });
  writeFileSync(join(root, "plugins", "x", "agent.md"), "# My cast\n");
  writeFileSync(join(root, "CLAUDE.local.md"), "@plugins/x/agent.md\n");
  const spec = assembleSession({ cwd: root, vaultProject: root, pkgRoot });
  const args = geminiBackend.renderArgs(spec);
  const dirs = args[args.indexOf("--include-directories") + 1]!.split(",");
  expect(dirs).not.toContain(root); // inside: cwd already is the vault, no extra --include
  const gm = readFileSync(join(dirs[0]!, "GEMINI.md"), "utf8");
  expect(gm).toContain("# My cast"); // unlike claude inside, gemini DOES get the cast + pointer
  expect(gm).toContain("imprnt recall");
});

test("geminiBackend with no vault and no globals just passes through (no --include-directories)", () => {
  const globalDir = mkdtempSync(join(tmpdir(), "imprnt-glob-none-"));
  const spec = assembleSession({ cwd: "/x", pkgRoot, passthrough: ["-r", "latest"], globalDir });
  expect(geminiBackend.renderArgs(spec)).toEqual(["-r", "latest"]);
});

// --- skip-permissions: each backend maps the neutral flag to its own, never doubled ---

test("claudeBackend injects --dangerously-skip-permissions when skipPermissions is set, once, off by default", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const on = claudeBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, skipPermissions: true }));
  expect(on.filter((a) => a === "--dangerously-skip-permissions").length).toBe(1);
  const off = claudeBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, skipPermissions: false }));
  expect(off).not.toContain("--dangerously-skip-permissions");
  // Not doubled when the user already passed it.
  const dup = claudeBackend.renderArgs(
    assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, skipPermissions: true, passthrough: ["--dangerously-skip-permissions"] }),
  );
  expect(dup.filter((a) => a === "--dangerously-skip-permissions").length).toBe(1);
});

test("geminiBackend injects --yolo + --skip-trust when skipPermissions is set, off by default, not doubled on -y", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const on = geminiBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, skipPermissions: true }));
  expect(on).toContain("--yolo");
  expect(on).toContain("--skip-trust");
  const off = geminiBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, skipPermissions: false }));
  expect(off).not.toContain("--yolo");
  expect(off).not.toContain("--skip-trust");
  // gemini's short form -y already passed: no duplicate --yolo.
  const dup = geminiBackend.renderArgs(
    assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, skipPermissions: true, passthrough: ["-y"] }),
  );
  expect(dup).not.toContain("--yolo");
});

// --- gemini model: alias expansion + the configured default, with the user's -m winning ---

test("geminiBackend injects the configured default model, expanding an alias", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const args = geminiBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, model: "pro" }));
  const mIdx = args.indexOf("-m");
  expect(mIdx).toBeGreaterThanOrEqual(0);
  expect(args[mIdx + 1]).toBe("gemini-3.1-pro-preview"); // alias expanded
});

test("geminiBackend passes a full model id through unchanged and never injects when none is configured", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const full = geminiBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, model: "gemini-2.5-pro" }));
  expect(full[full.indexOf("-m") + 1]).toBe("gemini-2.5-pro");
  const none = geminiBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot }));
  expect(none).not.toContain("-m"); // no configured model -> let gemini use its own default
});

test("geminiBackend: a user-passed -m wins over the configured default, and its alias is expanded", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const args = geminiBackend.renderArgs(
    assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, model: "pro", passthrough: ["-m", "flash"] }),
  );
  // Exactly one -m, and it is the user's choice (flash), alias-expanded, not the configured pro.
  expect(args.filter((a) => a === "-m").length).toBe(1);
  expect(args[args.indexOf("-m") + 1]).toBe("gemini-3.5-flash");
});

// --- gemini context gotchas: @ in the cast is escaped, a bare -r resumes latest ---

test("geminiBackend escapes every @ in the generated GEMINI.md (a literal @handle is not import-processed)", () => {
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "x"), { recursive: true });
  writeFileSync(join(root, "plugins", "x", "agent.md"), "calibration ref: @aemilius211 (RU-lit)\n");
  writeFileSync(join(root, "CLAUDE.local.md"), "@plugins/x/agent.md\n");
  const args = geminiBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot }));
  const dir = args[args.indexOf("--include-directories") + 1]!.split(",")[0]!;
  const gm = readFileSync(join(dir, "GEMINI.md"), "utf8");
  expect(gm).toContain("\\@aemilius211"); // the handle is escaped
  expect(gm).not.toMatch(/(^|[^\\])@/); // no un-escaped @ remains anywhere
});

test("geminiBackend turns a value-less -r / --resume into 'latest', leaves an explicit value alone", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const mk = (passthrough: string[]) => geminiBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, passthrough }));
  expect(mk(["-r"])[mk(["-r"]).indexOf("-r") + 1]).toBe("latest");
  expect(mk(["--resume"])[mk(["--resume"]).indexOf("--resume") + 1]).toBe("latest");
  // -r followed by another flag has no value, so latest is inserted between them
  const withFlag = mk(["-r", "--foo"]);
  expect(withFlag[withFlag.indexOf("-r") + 1]).toBe("latest");
  // an explicit value is untouched, and no stray "latest" is added
  const explicit = mk(["-r", "3"]);
  expect(explicit[explicit.indexOf("-r") + 1]).toBe("3");
  expect(explicit.filter((a) => a === "latest").length).toBe(0);
});

// --- parseGeminiSessions: the clean source for imp's own resume picker ---

test("parseGeminiSessions parses the --list-sessions rows by real prompt name, skipping the header", () => {
  const out = parseGeminiSessions(
    [
      "Available sessions for this project (3):",
      "  1. how do you know I want you to write (2 minutes ago) [b6965347-c6a8-4fb0-b537-0336022e27c5]",
      "  2. help me draft the tax letter (1 hour ago) [1ba8e3f5-d7de-4e97-8841-30f6eaee6f44]",
      "  3. arena-fps map review (3 hours ago) [02855dba-c42b-4946-bc1b-28fb88efe6ac]",
      "",
    ].join("\n"),
  );
  expect(out.length).toBe(3);
  expect(out[0]).toEqual({ index: 1, name: "how do you know I want you to write", age: "2 minutes ago", id: "b6965347-c6a8-4fb0-b537-0336022e27c5" });
  expect(out[2]!.name).toBe("arena-fps map review");
  expect(out[2]!.id).toBe("02855dba-c42b-4946-bc1b-28fb88efe6ac");
});

test("parseGeminiSessions returns [] for empty or session-less output", () => {
  expect(parseGeminiSessions("")).toEqual([]);
  expect(parseGeminiSessions("No sessions found for this project.")).toEqual([]);
});

// --- review-pass fixes: model equals-form, the -- terminator, IMPRNT_YOLO off-spellings, resume hook ---

test("geminiBackend expands an alias in the --model=value equals form and does not double-inject the default", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const args = geminiBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, model: "flash", passthrough: ["--model=pro"] }));
  expect(args).toContain("--model=gemini-3.1-pro-preview"); // the user's equals-form alias, expanded in place
  expect(args.filter((a) => a === "-m").length).toBe(0); // the configured default is NOT also injected
  expect(args).not.toContain("gemini-3.5-flash");
});

test("geminiBackend leaves a bare -m (no value) alone and suppresses the configured default", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const args = geminiBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, model: "pro", passthrough: ["-m"] }));
  expect(args.filter((a) => a === "-m").length).toBe(1); // the user's -m stays for gemini to reject
  expect(args).not.toContain("gemini-3.1-pro-preview"); // and the default is NOT injected
});

test("resolveLaunch does not consume a selection flag after a -- terminator (it is literal prompt text)", () => {
  const r = resolveLaunch(["--", "explain", "the", "--yolo", "flag"]);
  expect(r.skipPermissions).toBe(false); // --yolo after -- must NOT flip skip-permissions
  expect(r.passthrough).toEqual(["--", "explain", "the", "--yolo", "flag"]); // tail passed through verbatim
  const r2 = resolveLaunch(["--yolo", "--", "--safe"]);
  expect(r2.skipPermissions).toBe(true); // leading --yolo (before --) IS consumed
  expect(r2.passthrough).toEqual(["--", "--safe"]); // --safe after -- is preserved, not consumed
});

test("resolveLaunch: IMPRNT_YOLO off-spellings (0/false/off/no, any case) read as off", () => {
  for (const v of ["0", "false", "off", "no", "OFF", "No", ""]) {
    process.env.IMPRNT_YOLO = v;
    expect(resolveLaunch([], { yolo: true }).skipPermissions).toBe(false);
  }
  process.env.IMPRNT_YOLO = "1";
  expect(resolveLaunch([], { yolo: false }).skipPermissions).toBe(true);
});

test("valuelessResumeIndex finds a value-less -r/--resume, else -1", () => {
  expect(valuelessResumeIndex(["-c", "-r"])).toBe(1); // last token
  expect(valuelessResumeIndex(["-r", "--foo"])).toBe(0); // followed by a flag
  expect(valuelessResumeIndex(["--resume"])).toBe(0);
  expect(valuelessResumeIndex(["-r", "3"])).toBe(-1); // has a value
  expect(valuelessResumeIndex(["--resume=5"])).toBe(-1); // equals form carries its value
  expect(valuelessResumeIndex(["-c"])).toBe(-1); // no -r at all
});

test("geminiBackend.resolveResume is a no-op without an interactive TTY, and for an explicit -r value", async () => {
  // the test process is not a TTY, so the picker is skipped and gemini is never spawned.
  expect(await geminiBackend.resolveResume!(["-r"], "/x")).toEqual(["-r"]);
  expect(await geminiBackend.resolveResume!(["-r", "3"], "/x")).toEqual(["-r", "3"]);
  expect(await geminiBackend.resolveResume!(["-c"], "/x")).toEqual(["-c"]);
  expect(claudeBackend.resolveResume).toBeUndefined(); // claude has no resume hook (uses its own picker)
});

// --- round 2: claude --model, terminator-aware scans, single exit handler ---

test("claudeBackend renders --model from a configured default (literal), only when the user passed none", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const on = claudeBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, model: "opus" }));
  expect(on[on.indexOf("--model") + 1]).toBe("opus"); // literal - no gemini alias map on claude
  const user = claudeBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, model: "opus", passthrough: ["--model", "sonnet"] }));
  expect(user.filter((a) => a === "--model").length).toBe(1); // the user's --model wins
  expect(user).not.toContain("opus");
  const none = claudeBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot }));
  expect(none).not.toContain("--model"); // no configured model -> byte-identical to before the feature
});

test("valuelessResumeIndex respects the -- terminator (a -r after -- is prompt text)", () => {
  expect(valuelessResumeIndex(["--", "-r"])).toBe(-1); // -r after -- is not a resume flag
  expect(valuelessResumeIndex(["-r", "--", "x"])).toBe(0); // -r before -- (value-less) still found
  expect(valuelessResumeIndex(["-r", "3", "--", "x"])).toBe(-1); // explicit value before --
});

test("geminiBackend does not expand a -m that appears after a -- terminator (literal prompt text)", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const args = geminiBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, passthrough: ["--", "tell me about", "-m", "flash"] }));
  expect(args).not.toContain("gemini-3.5-flash"); // the post-`--` -m flash is NOT expanded
  expect(args).toContain("flash"); // it survives verbatim as prompt text
});

test("geminiBackend registers at most one exit handler across repeated renders", () => {
  const root = tmpVaultProject();
  mkdirSync(join(root, "plugins", "x"), { recursive: true });
  writeFileSync(join(root, "plugins", "x", "agent.md"), "# cast\n");
  writeFileSync(join(root, "CLAUDE.local.md"), "@plugins/x/agent.md\n");
  const before = process.listenerCount("exit");
  for (let i = 0; i < 4; i++) geminiBackend.renderArgs(assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot }));
  expect(process.listenerCount("exit") - before).toBeLessThanOrEqual(1);
});

// --- round 3: the already-passed dedup scans respect the -- terminator too ---
// resolveLaunch, the gemini model scan, and valuelessResumeIndex already stop at `--`; the four
// dedup scans (claude --dangerously-skip-permissions/--model, gemini --yolo/-y/--skip-trust) must
// as well, or a flag-looking word in an unquoted prompt silently suppresses a configured default.

test("claudeBackend still injects --model and --dangerously-skip-permissions when the words appear only after -- (prompt text)", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const prompt = ["--", "fix", "the", "--model", "help", "and", "--dangerously-skip-permissions", "docs"];
  const args = claudeBackend.renderArgs(
    assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, skipPermissions: true, model: "opus", passthrough: [...prompt] }),
  );
  const term = args.indexOf("--");
  expect(args.slice(0, term)).toContain("--dangerously-skip-permissions"); // still injected, before the terminator
  const mIdx = args.indexOf("--model");
  expect(mIdx).toBeGreaterThanOrEqual(0);
  expect(mIdx).toBeLessThan(term); // the injected flag, not the prompt token
  expect(args[mIdx + 1]).toBe("opus");
  expect(args.slice(term)).toEqual(prompt); // the prompt tail rides through verbatim
});

test("geminiBackend still injects --yolo AND --skip-trust when those words appear only after -- (no half-yolo session)", () => {
  const root = tmpVaultProject();
  writeFileSync(join(root, "CLAUDE.local.md"), "");
  const prompt = ["--", "explain", "what", "the", "--yolo", "flag", "and", "--skip-trust", "and", "-y", "do"];
  const args = geminiBackend.renderArgs(
    assembleSession({ cwd: "/elsewhere", vaultProject: root, pkgRoot, skipPermissions: true, passthrough: [...prompt] }),
  );
  const term = args.indexOf("--");
  expect(args.slice(0, term)).toContain("--yolo");
  expect(args.slice(0, term)).toContain("--skip-trust");
  expect(args.slice(term)).toEqual(prompt); // the prompt tail rides through verbatim
});
