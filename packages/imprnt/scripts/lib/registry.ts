// Vault-project registry — how `imp` and `imprnt context` find the vault from ANY directory.
// One JSON file under the user's config dir: {"default": "personal", "vaults": {"personal": "/abs"}}.
// v1 only ever fills one entry; the map shape exists so a second vault (a team vault in a work
// repo) is a config entry later, never an architecture change. Multi-vault switching is NOT built.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Registry = { default?: string; vaults: Record<string, string> };

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "imprnt", "config.json");
}

// Missing or corrupt config reads as empty — the registry is a convenience cache, never a thing
// that can block a command. Non-string path values are dropped too (a hand edit, a partial
// write), so no caller ever feeds a non-path into fs. The next registerVault overwrites whatever
// was broken.
export function readRegistry(): Registry {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    const vaults: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw?.vaults ?? {})) if (typeof v === "string") vaults[k] = v;
    return { default: typeof raw?.default === "string" ? raw.default : undefined, vaults };
  } catch {
    return { vaults: {} };
  }
}

// The default entry of an already-read registry. A registered path that is no longer a live vault
// project reads as "nothing registered": resolution falls through cleanly and the next `imprnt
// init` re-registers, so neither a deleted scratch dir nor a HOLLOW default (the dir survives but
// its vault/ is gone, or it was replaced by an unrelated repo) can hold the default hostage. The
// existsSync gate alone passed a hollow dir, so the read path advertised a pointer at a vault that
// no longer exists and `imp lair` opened claude there silently - consult isVaultProject instead.
function liveDefault(reg: Registry): string | undefined {
  const name = reg.default ?? Object.keys(reg.vaults)[0];
  const path = name ? reg.vaults[name] : undefined;
  return path && isVaultProject(path) ? path : undefined;
}

export function registeredRoot(): string | undefined {
  return liveDefault(readRegistry());
}

// Register `path` as a vault project. The first registration becomes the default. An existing
// DIFFERENT default is kept unless force — the caller prints what happened, nothing changes
// silently. Returns the status plus the path that holds the default AFTER the call, so init can
// report the truth without re-reading the file.
export function registerVault(
  path: string,
  opts: { name?: string; force?: boolean } = {},
): { status: "registered" | "already" | "kept" | "error"; current: string; error?: string } {
  const reg = readRegistry();
  const current = liveDefault(reg);
  if (current === path) return { status: "already", current: path };
  if (current && !opts.force) return { status: "kept", current };
  const name = opts.name ?? "personal";
  reg.vaults[name] = path;
  reg.default = name;
  const p = configPath();
  // The registry is a convenience cache, never a thing that can block a command. An unwritable
  // config dir (EACCES on a locked-down ~/.config) used to throw a raw stack AFTER init had fully
  // scaffolded the vault, leaving it usable but un-init'd-looking. Catch it and return the failure
  // as data so the caller prints one clean line and keeps the scaffold. Nothing was recorded.
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(reg, null, 2) + "\n");
  } catch (e) {
    return { status: "error", current: path, error: e instanceof Error ? e.message : String(e) };
  }
  return { status: "registered", current: path };
}

// What marks a dir as a vault PROJECT for the walk-up: a vault/ DIRECTORY holding the generated
// index.md. The name `vault` alone is far too common (a HashiCorp config dir, an ansible-vault
// file) and existsSync would match plain files too — either would hijack resolution and make imp
// silently skip injection. init always scaffolds vault/index.md, so requiring it matches exactly
// the projects init produced. CLAUDE.local.md is deliberately NOT a marker: any Claude Code repo
// can carry one (lib/roots.ts projectRoot differs here on purpose — see its comment).
export function isVaultProject(dir: string): boolean {
  const vault = join(dir, "vault");
  try {
    return statSync(vault).isDirectory() && existsSync(join(vault, "index.md"));
  } catch {
    return false;
  }
}

// Resolve "the vault project" when running from anywhere. Order:
//   1. IMPRNT_ROOT — the explicit project override, wins everywhere (scripting, weird setups).
//   2. IMPRNT_VAULT's parent — the engine's own vault override. Honoring it here keeps `context`
//      and `imp` on the SAME vault the engine commands (recall/check/hot) read, so one session
//      can never print one vault's contract while searching another's corpus.
//   3. Walk-up from `start` for a real vault project — standing inside one (yours, or a team's
//      in a work repo) beats the global default, so local context always wins.
//   4. The registry default — the `imp`-from-a-coding-repo case.
// Returns undefined on a fresh machine with no init yet.
export function vaultProjectRoot(start: string = process.cwd()): string | undefined {
  const rootEnv = process.env.IMPRNT_ROOT ?? process.env.IMPRINT_ROOT;
  // resolve() once against the launch cwd: an absolute IMPRNT_ROOT passes through unchanged, a
  // relative one becomes absolute here so the pointer prose and IMPRNT_VAULT it flows into don't
  // break after an in-session cd. The imp-lair-with-IMPRNT_ROOT hard-error behavior is unchanged.
  if (rootEnv) return resolve(start, rootEnv);
  const vaultEnv = process.env.IMPRNT_VAULT ?? process.env.IMPRINT_VAULT;
  if (vaultEnv) return dirname(resolve(start, vaultEnv));
  let dir = start;
  for (;;) {
    if (isVaultProject(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return registeredRoot();
}
