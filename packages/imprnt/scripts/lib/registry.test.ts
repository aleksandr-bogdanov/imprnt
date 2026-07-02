import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configPath, readRegistry, registeredRoot, registerVault, vaultProjectRoot, isVaultProject, readDefaultModel, setDefaultModel } from "./registry.ts";

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

// A REAL imprnt vault carries BOTH files init writes (index.md AND _tags.md). A bare docs folder
// named `vault` ships index.md but essentially never _tags.md, so the marker needs both to tell a
// real vault from a docs site that happens to live under vault/. Both shipped example vaults carry
// both files too (examples/*/vault/_tags.md).
function mkVaultProject(): string {
  const root = tmpDir("imprnt-proj-");
  mkdirSync(join(root, "vault"));
  writeFileSync(join(root, "vault", "index.md"), "# index\n");
  writeFileSync(join(root, "vault", "_tags.md"), "# tags\n");
  return root;
}

// A coding repo that coincidentally carries vault/index.md (an Obsidian/VuePress docs site whose
// folder is literally named `vault`) but no _tags.md. This must NOT read as an imprnt vault.
function mkDocsVault(): string {
  const root = tmpDir("imprnt-docs-");
  mkdirSync(join(root, "vault"));
  writeFileSync(join(root, "vault", "index.md"), "# docs home\n");
  return root;
}

test("configPath honors XDG_CONFIG_HOME", () => {
  expect(configPath()).toBe(join(xdg, "imprnt", "config.json"));
});

test("readRegistry on a fresh machine is empty, not an error", () => {
  expect(readRegistry()).toEqual({ vaults: {} });
  expect(registeredRoot()).toBeUndefined();
});

// A live default must be a real vault project (liveDefault consults isVaultProject), so the dirs
// these tests register are full vault projects, not bare scratch dirs.
test("first registerVault becomes the default", () => {
  const a = mkVaultProject();
  expect(registerVault(a)).toEqual({ status: "registered", current: a });
  expect(registeredRoot()).toBe(a);
  const onDisk = JSON.parse(readFileSync(configPath(), "utf8"));
  expect(onDisk).toEqual({ default: "personal", vaults: { personal: a } });
});

test("a second different path is KEPT (reporting the kept path) unless forced", () => {
  const a = mkVaultProject();
  const b = mkVaultProject();
  registerVault(a);
  expect(registerVault(b)).toEqual({ status: "kept", current: a });
  expect(registeredRoot()).toBe(a);
  expect(registerVault(b, { force: true })).toEqual({ status: "registered", current: b });
  expect(registeredRoot()).toBe(b);
});

test("re-registering the same path is a quiet no-op", () => {
  const a = mkVaultProject();
  registerVault(a);
  expect(registerVault(a).status).toBe("already");
});

test("a registered path that no longer exists reads as unregistered, and the next init re-registers", () => {
  const scratch = mkVaultProject();
  registerVault(scratch);
  rmSync(scratch, { recursive: true });
  expect(registeredRoot()).toBeUndefined();
  const real = mkVaultProject();
  expect(registerVault(real).status).toBe("registered");
  expect(registeredRoot()).toBe(real);
});

test("a registered default that EXISTS but is no longer a vault project reads as unregistered (hollow default)", () => {
  // The dir survives on disk (a deleted vault/, or the dir replaced by an unrelated repo), so a
  // bare existsSync gate passes. But it carries no vault/index.md, so injecting a pointer at it
  // would advertise a hollow path and `imp lair` would open claude there silently. liveDefault
  // must consult isVaultProject on the read path, not just existsSync.
  const hollow = mkVaultProject();
  registerVault(hollow);
  expect(registeredRoot()).toBe(hollow);
  rmSync(join(hollow, "vault"), { recursive: true });
  // The dir itself still exists; only the vault/ marker is gone.
  expect(registeredRoot()).toBeUndefined();
});

test("an unwritable config dir reports an error status instead of throwing", () => {
  // init carefully wraps every vault mkdir in a clean try/catch, but the registry write used to be
  // unguarded: an unwritable XDG_CONFIG_HOME let it throw a raw EACCES after the vault was fully
  // scaffolded. registerVault now catches the fs failure and returns it as data, so the caller can
  // print one clean line and keep the successful scaffold. The default is NOT recorded on failure.
  const a = mkVaultProject();
  chmodSync(xdg, 0o555); // strip write from the config base: mkdir of <xdg>/imprnt fails with EACCES
  try {
    const r = registerVault(a);
    expect(r.status).toBe("error");
    expect(r.error).toBeTruthy();
  } finally {
    chmodSync(xdg, 0o755);
  }
  // Nothing was registered: the read path still reports a fresh machine.
  expect(registeredRoot()).toBeUndefined();
});

test("corrupt config reads as empty and is overwritten by the next register", () => {
  mkdirSync(join(xdg, "imprnt"), { recursive: true });
  writeFileSync(configPath(), "{not json");
  expect(readRegistry()).toEqual({ vaults: {} });
  const a = mkVaultProject();
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

test("isVaultProject requires a vault/ DIRECTORY with BOTH index.md and _tags.md", () => {
  const real = mkVaultProject();
  expect(isVaultProject(real)).toBe(true);

  const fileVault = tmpDir();
  writeFileSync(join(fileVault, "vault"), "ansible-vault payload");
  expect(isVaultProject(fileVault)).toBe(false);

  const bareDir = tmpDir();
  mkdirSync(join(bareDir, "vault"));
  expect(isVaultProject(bareDir)).toBe(false);

  // index.md alone is a docs site named vault, not an imprnt vault. init always writes _tags.md
  // alongside index.md, so requiring both rejects the docs case while still matching init output.
  expect(isVaultProject(mkDocsVault())).toBe(false);
});

test("a docs folder named vault (index.md but no _tags.md) does NOT shadow a registered real vault", () => {
  // P3: a coding repo with vault/index.md (an Obsidian/VuePress docs site) used to win the walk-up
  // before the registry was consulted, so imp injected nothing and IMPRNT_VAULT pointed recall/check
  // at the docs corpus while the real registered vault stayed unreachable. The two-file marker fixes
  // it: the docs vault/ is not a vault project, so resolution falls through to the registered default.
  const registered = mkVaultProject();
  registerVault(registered);
  const docsRepo = mkDocsVault();
  const deep = join(docsRepo, "src", "pages");
  mkdirSync(deep, { recursive: true });
  expect(isVaultProject(docsRepo)).toBe(false);
  expect(vaultProjectRoot(docsRepo)).toBe(registered);
  expect(vaultProjectRoot(deep)).toBe(registered);
});

// --- vaultProjectRoot resolve order: IMPRNT_ROOT > IMPRNT_VAULT parent > walk-up > registry ---

test("IMPRNT_ROOT beats everything", () => {
  // Register a REAL vault project so the registry leg is live: registeredRoot() returns it. The
  // claim "beats everything" is only exercised when there is a registered default to beat - a bare
  // scratch dir fails isVaultProject and would make this prove env beats nothing.
  const registered = mkVaultProject();
  registerVault(registered);
  expect(registeredRoot()).toBe(registered);
  process.env.IMPRNT_ROOT = "/tmp/override";
  expect(vaultProjectRoot("/anywhere")).toBe("/tmp/override");
});

test("a relative IMPRNT_ROOT is resolved against the launch cwd to an absolute path", () => {
  // A relative root returned raw flows into the pointer prose and IMPRNT_VAULT, both of which
  // break the moment the session cd's elsewhere. Resolve it once at launch so it stays absolute.
  process.env.IMPRNT_ROOT = "relativedir";
  const got = vaultProjectRoot("/launch/cwd");
  expect(got).toBe("/launch/cwd/relativedir");
});

test("IMPRNT_VAULT resolves to its parent dir, beating walk-up and registry", () => {
  // A live registered default makes the registry leg real, so "beating ... registry" is exercised.
  const registered = mkVaultProject();
  registerVault(registered);
  expect(registeredRoot()).toBe(registered);
  process.env.IMPRNT_VAULT = "/work/team/vault";
  expect(vaultProjectRoot("/anywhere")).toBe("/work/team");
});

test("standing inside a vault project beats the registered default", () => {
  // Register a DIFFERENT real vault so the registry default is live. Standing inside `proj` must
  // still win over it - with a bare scratch dir the registry leg was dead and this proved nothing.
  const registered = mkVaultProject();
  registerVault(registered);
  expect(registeredRoot()).toBe(registered);
  const proj = mkVaultProject();
  const deep = join(proj, "a", "b");
  mkdirSync(deep, { recursive: true });
  expect(vaultProjectRoot(deep)).toBe(proj);
});

test("an unrelated vault/ dir (no index.md) does NOT hijack resolution from the registry", () => {
  const registered = mkVaultProject();
  registerVault(registered);
  const hashicorp = tmpDir();
  mkdirSync(join(hashicorp, "vault"));
  expect(vaultProjectRoot(hashicorp)).toBe(registered);
});

test("a plain dir falls back to the registry; nothing anywhere is undefined", () => {
  const plain = tmpDir();
  expect(vaultProjectRoot(plain)).toBeUndefined();
  const registered = mkVaultProject();
  registerVault(registered);
  expect(vaultProjectRoot(plain)).toBe(registered);
});

test("a CLAUDE.local.md alone does NOT mark a vault project (coding repos carry those)", () => {
  const registered = mkVaultProject();
  registerVault(registered);
  const repo = tmpDir();
  writeFileSync(join(repo, "CLAUDE.local.md"), "# repo-local\n");
  expect(vaultProjectRoot(repo)).toBe(registered);
});

// --- the per-backend default model (the `imprnt model` knob) ---
// One unscoped string let a gemini alias like `pro` ride into a one-off `imp --claude` session
// (claude takes the value literally and rejects it), so the knob is stored per backend.

test("readDefaultModel is scoped per backend - one backend's model never leaks into the other", () => {
  setDefaultModel("pro", "gemini");
  setDefaultModel("opus", "claude");
  expect(readDefaultModel("gemini")).toBe("pro");
  expect(readDefaultModel("claude")).toBe("opus");
  setDefaultModel("", "gemini"); // clear gemini's only
  expect(readDefaultModel("gemini")).toBeUndefined();
  expect(readDefaultModel("claude")).toBe("opus");
});

test("a legacy unscoped defaultModel string applies ONLY to the machine's stored default agent", () => {
  // The pre-scoping config shape: one string, set on a gemini-pinned machine. It must keep working
  // for gemini launches and must NOT poison a per-session `imp --claude`.
  mkdirSync(join(xdg, "imprnt"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ vaults: {}, defaultAgent: "gemini", defaultModel: "pro" }));
  expect(readDefaultModel("gemini")).toBe("pro");
  expect(readDefaultModel("claude")).toBeUndefined();
  // No stored agent: the legacy string belonged to the built-in claude default.
  writeFileSync(configPath(), JSON.stringify({ vaults: {}, defaultModel: "opus" }));
  expect(readDefaultModel("claude")).toBe("opus");
  expect(readDefaultModel("gemini")).toBeUndefined();
});

test("setDefaultModel migrates a legacy string into the scoped map instead of dropping it", () => {
  mkdirSync(join(xdg, "imprnt"), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ vaults: {}, defaultAgent: "gemini", defaultModel: "pro" }));
  setDefaultModel("opus", "claude"); // a write for the OTHER backend
  expect(readDefaultModel("gemini")).toBe("pro"); // gemini's inherited default survives, scoped now
  expect(readDefaultModel("claude")).toBe("opus");
  expect(readRegistry().defaultModel).toBeUndefined(); // the unscoped field is gone from disk
  expect(readRegistry().defaultModels).toEqual({ gemini: "pro", claude: "opus" });
});
