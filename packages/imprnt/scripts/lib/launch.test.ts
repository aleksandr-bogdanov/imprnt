import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { castFragment, pointerFragment, isInside, buildLaunch, launchClaude } from "./launch.ts";

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
