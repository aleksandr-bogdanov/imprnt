import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configPath, readRegistry, registeredRoot, registerVault, vaultProjectRoot, isVaultProject } from "./registry.ts";

// Every test sandboxes the config under a throwaway XDG_CONFIG_HOME so the suite never touches
// (or depends on) the developer's real ~/.config/imprnt. Env is restored after each test.
let xdg: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["XDG_CONFIG_HOME", "IMPRNT_ROOT", "IMPRINT_ROOT", "IMPRNT_VAULT", "IMPRINT_VAULT"];

beforeEach(() => {
  xdg = mkdtempSync(join(tmpdir(), "imprnt-xdg-"));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.XDG_CONFIG_HOME = xdg;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// Registered paths must actually exist on disk (liveDefault checks), so tests register real dirs.
function tmpDir(prefix = "imprnt-reg-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function mkVaultProject(): string {
  const root = tmpDir("imprnt-proj-");
  mkdirSync(join(root, "vault"));
  writeFileSync(join(root, "vault", "index.md"), "# index\n");
  return root;
}

test("configPath honors XDG_CONFIG_HOME", () => {
  expect(configPath()).toBe(join(xdg, "imprnt", "config.json"));
});

test("readRegistry on a fresh machine is empty, not an error", () => {
  expect(readRegistry()).toEqual({ vaults: {} });
  expect(registeredRoot()).toBeUndefined();
});

test("first registerVault becomes the default", () => {
  const a = tmpDir();
  expect(registerVault(a)).toEqual({ status: "registered", current: a });
  expect(registeredRoot()).toBe(a);
  const onDisk = JSON.parse(readFileSync(configPath(), "utf8"));
  expect(onDisk).toEqual({ default: "personal", vaults: { personal: a } });
});

test("a second different path is KEPT (reporting the kept path) unless forced", () => {
  const a = tmpDir();
  const b = tmpDir();
  registerVault(a);
  expect(registerVault(b)).toEqual({ status: "kept", current: a });
  expect(registeredRoot()).toBe(a);
  expect(registerVault(b, { force: true })).toEqual({ status: "registered", current: b });
  expect(registeredRoot()).toBe(b);
});

test("re-registering the same path is a quiet no-op", () => {
  const a = tmpDir();
  registerVault(a);
  expect(registerVault(a).status).toBe("already");
});

test("a registered path that no longer exists reads as unregistered, and the next init re-registers", () => {
  const scratch = tmpDir();
  registerVault(scratch);
  rmSync(scratch, { recursive: true });
  expect(registeredRoot()).toBeUndefined();
  const real = tmpDir();
  expect(registerVault(real).status).toBe("registered");
  expect(registeredRoot()).toBe(real);
});

test("corrupt config reads as empty and is overwritten by the next register", () => {
  mkdirSync(join(xdg, "imprnt"), { recursive: true });
  writeFileSync(configPath(), "{not json");
  expect(readRegistry()).toEqual({ vaults: {} });
  const a = tmpDir();
  expect(registerVault(a).status).toBe("registered");
  expect(registeredRoot()).toBe(a);
});

test("non-string vault values are dropped instead of flowing into path code", () => {
  mkdirSync(join(xdg, "imprnt"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ default: "personal", vaults: { personal: 123 } }));
  expect(readRegistry()).toEqual({ default: "personal", vaults: {} });
  expect(registeredRoot()).toBeUndefined();
});

// --- the vault-project marker ---

test("isVaultProject requires a vault/ DIRECTORY with the generated index.md", () => {
  const real = mkVaultProject();
  expect(isVaultProject(real)).toBe(true);

  const fileVault = tmpDir();
  writeFileSync(join(fileVault, "vault"), "ansible-vault payload");
  expect(isVaultProject(fileVault)).toBe(false);

  const bareDir = tmpDir();
  mkdirSync(join(bareDir, "vault"));
  expect(isVaultProject(bareDir)).toBe(false);
});

// --- vaultProjectRoot resolve order: IMPRNT_ROOT > IMPRNT_VAULT parent > walk-up > registry ---

test("IMPRNT_ROOT beats everything", () => {
  registerVault(tmpDir());
  process.env.IMPRNT_ROOT = "/tmp/override";
  expect(vaultProjectRoot("/anywhere")).toBe("/tmp/override");
});

test("IMPRNT_VAULT resolves to its parent dir, beating walk-up and registry", () => {
  registerVault(tmpDir());
  process.env.IMPRNT_VAULT = "/work/team/vault";
  expect(vaultProjectRoot("/anywhere")).toBe("/work/team");
});

test("standing inside a vault project beats the registered default", () => {
  registerVault(tmpDir());
  const proj = mkVaultProject();
  const deep = join(proj, "a", "b");
  mkdirSync(deep, { recursive: true });
  expect(vaultProjectRoot(deep)).toBe(proj);
});

test("an unrelated vault/ dir (no index.md) does NOT hijack resolution from the registry", () => {
  const registered = tmpDir();
  registerVault(registered);
  const hashicorp = tmpDir();
  mkdirSync(join(hashicorp, "vault"));
  expect(vaultProjectRoot(hashicorp)).toBe(registered);
});

test("a plain dir falls back to the registry; nothing anywhere is undefined", () => {
  const plain = tmpDir();
  expect(vaultProjectRoot(plain)).toBeUndefined();
  const registered = tmpDir();
  registerVault(registered);
  expect(vaultProjectRoot(plain)).toBe(registered);
});

test("a CLAUDE.local.md alone does NOT mark a vault project (coding repos carry those)", () => {
  const registered = tmpDir();
  registerVault(registered);
  const repo = tmpDir();
  writeFileSync(join(repo, "CLAUDE.local.md"), "# repo-local\n");
  expect(vaultProjectRoot(repo)).toBe(registered);
});
