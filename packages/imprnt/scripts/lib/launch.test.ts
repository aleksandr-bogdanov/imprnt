import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { castFragment, pointerFragment, harnessFlags, isInside, buildLaunch, launchClaude } from "./launch.ts";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// buildLaunch reads IMPRNT_VAULT/IMPRINT_VAULT to decide whether to set the child env; keep the
// suite hermetic against the developer's shell.
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["IMPRNT_VAULT", "IMPRINT_VAULT"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
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
