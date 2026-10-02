import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { personOf, vaultRootOf } from "./instructions.ts";
import { NATIVE_DELEGATION_TOOLS, credentialSource, effectivePrompt, effectiveMcp, effectiveSettings, sessionBox, type LoopLaunchInput } from "./launch.ts";
import {
  HARVEST_PROFILE, OPENCODE_CONFIG_ENV, OPENCODE_KEY_ENV, ORDINARY_PROFILE,
  identityOf, openCodeConfig, permissionsFor, refuseRoutingOf, translateMcp,
} from "./opencode-config.ts";
import type { CredentialEntry } from "../registry/load.ts";

/**
 * Everything about starting OpenCode for a hub launch that touches a disk: the key read, the
 * version probe, the session's directories, the instruction file, and the one object
 * `Adapter.start` is handed. The rules themselves are in `opencode-config.ts`.
 *
 * LOADED ONLY BY A DYNAMIC IMPORT, like `launch.ts` is, because it reaches the registry through
 * `launch.ts` and the registry loader imports the adapter map: a static edge would be a cycle.
 *
 * A launch is ONE server for ONE conversation, in its own session directory: its home, its
 * XDG directories (so its sessions, its credentials file and its config are the conversation's
 * and nobody else's), its port, its password. Nothing global is loaded: the ambient home is
 * not the child's home, no provider key is inherited, and the engine's reading of `.claude`
 * is switched off.
 */

/**
 * The key a `model-key` credential holds, read at launch and never kept. It reaches the child as
 * one environment variable and is in no argv, no file the hub writes and no message of an error
 * this file throws. A credential of any other kind is not a model key, so a watch's bearer key
 * can never be sent to a model host and a Claude login can never be handed to this engine.
 */
export function readModelKey(entry: CredentialEntry): string {
  if (entry.kind !== "model-key" || !isAbsolute(entry.file)) throw new Error("credential-source-unsupported");
  accessSync(entry.file, constants.R_OK);
  if (!statSync(entry.file).isFile()) throw new Error("credential-source-unreadable");
  const key = readFileSync(entry.file, "utf8").trim();
  if (key === "") throw new Error("credential-source-unreadable");
  return key;
}

/** How long `--version` may take, and what the answer is kept against. */
export const OPENCODE_PROBE_TIMEOUT_MS = 10_000;
const versions = new Map<string, { stamp: string; version: string }>();

function stampOf(file: string): string {
  const real = realpathSync(file);
  const seen = statSync(real, { bigint: true });
  return [real, seen.dev, seen.ino, seen.size, seen.mtimeNs, seen.ctimeNs].join(":");
}

/**
 * The installed build's own word for its version, from `--version`, with a scrubbed environment
 * and a throwaway home. Offline: no model, no server and no login are involved. Kept per binary
 * until that file changes in any way a stat can see.
 */
export function probeOpenCodeVersion(bin = "opencode", timeoutMs = OPENCODE_PROBE_TIMEOUT_MS): string {
  const executable = Bun.which(bin);
  if (!executable) throw new Error("opencode-binary-missing");
  const stamp = stampOf(executable);
  const kept = versions.get(executable);
  if (kept?.stamp === stamp) return kept.version;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hub-opencode-probe-")));
  try {
    const env: Record<string, string> = { HOME: root, TMPDIR: root, XDG_CONFIG_HOME: join(root, "c"), XDG_DATA_HOME: join(root, "d"),
      XDG_STATE_HOME: join(root, "s"), XDG_CACHE_HOME: join(root, "k"), OPENCODE_DISABLE_AUTOUPDATE: "1" };
    for (const key of ["PATH", "LANG", "LC_ALL", "TZ"]) if (process.env[key]) env[key] = process.env[key]!;
    const answer = Bun.spawnSync([executable, "--version"], { env, cwd: root, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    if (answer.exitedDueToTimeout) throw new Error(`loop-probe-timeout: opencode --version timed out after ${timeoutMs / 1000} s`);
    const version = answer.stdout.toString().match(/\d+(?:\.\d+)+/)?.[0];
    if (answer.exitCode !== 0 || !version) throw new Error("opencode-binary-unusable");
    versions.set(executable, { stamp, version });
    return version;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** The directories one launch gives the engine, all inside the session directory. */
export function engineDirs(cwd: string) {
  const root = join(cwd, "opencode");
  return { home: join(cwd, "home"), scratch: join(cwd, "tmp"),
    config: join(root, "config"), data: join(root, "data"), state: join(root, "state"), cache: join(root, "cache") };
}

/**
 * Prepare the launch before any model child can start. Throws by name for everything it
 * cannot honour: a settings file with permission rules (Claude's rule language has no
 * deterministic translation, so it is refused and not approximated), a tool that has no
 * permission, an MCP server of a shape it does not know, a key that is not there.
 */
export function makeOpenCodeLaunch(input: LoopLaunchInput, bin = "opencode") {
  if (input.preset.adapter !== "opencode") throw new Error("loop-configuration-unsupported");
  if (!input.box) throw new Error("box-required");
  if (!statSync(input.box.tree).isDirectory()) throw new Error("box-tree-unavailable");
  if (!["ordinary", "harvest", "triage"].includes(input.purpose)) throw new Error("invalid-configuration");
  const credential = input.credential ?? credentialSource(input.registry, input.agent.preset);
  const key = readModelKey(credential);
  const identity = identityOf(input.preset, credential.base_url ?? null);
  const ordinary = input.purpose === "ordinary";

  const settings = effectiveSettings(input);
  const rules = settings.permissions as Record<string, unknown[]> | undefined;
  if (rules && Object.values(rules).some(list => list.length > 0)) throw new Error("opencode-permissions-unsupported");
  const { mcp, mcpFile } = effectiveMcp({ ...input, hubMcp: Boolean(input.hubMcp) });
  const servers = translateMcp(mcp.mcpServers as Record<string, unknown>);
  if (input.hubMcp) {
    servers.hub = { type: "local", command: [input.hubMcp.command, ...input.hubMcp.args], enabled: true,
      ...(Object.keys(input.hubMcp.env).length > 0 ? { environment: input.hubMcp.env } : {}) };
  }

  // THE TOOL LIST IS ALWAYS AN EXPLICIT ONE. An agent's own list is used exactly as configured; one
  // that names none gets the profile below; a hunt's master has none at all. Never the engine's default.
  const tools: readonly string[] = ordinary ? input.agent.tools ?? ORDINARY_PROFILE : input.purpose === "triage" ? [] : HARVEST_PROFILE;
  const person = personOf(input.registry, input.agent.person);
  const root = vaultRootOf(person, input.box.tree);
  const outside = input.purpose === "triage" ? [] : [...new Set([input.box.tree, root])];
  const permission = permissionsFor({ tools, servers: Object.keys(servers), outside, delegation: NATIVE_DELEGATION_TOOLS });
  const prompt = effectivePrompt({ ...input, credentialFile: credential.file });

  // The key file stays masked: it is read HERE, outside the box, and handed over as a variable. It is
  // masked even if the box context did not list it. On Linux a single-file mask is a bind over one
  // directory entry that the kernel lifts if the host renames a new file over it, so where the key
  // sits in a directory nothing the launch reads or writes is under, the directory is masked instead.
  const reads = [...(prompt?.reads ?? []), ...(mcpFile ? [mcpFile] : []), ...(input.hubMcp?.reads ?? [])];
  const writePaths = [...(input.box.writePaths ?? []), ...(input.hubMcp?.writes ?? [])];
  const needs = [input.box.tree, input.box.stateRoot ?? "", input.sessionDir, ...reads, ...writePaths].filter(path => path !== "");
  const parent = dirname(credential.file);
  const holdsNeeded = needs.some(path => path === parent || path.startsWith(`${parent}/`));
  const masked = process.platform === "linux" && !holdsNeeded && existsSync(parent) ? parent : credential.file;
  const secretPaths = [...new Set([...(input.box.secretPaths ?? []), masked])];
  input = { ...input, box: { ...input.box, writePaths, secretPaths } };
  const boxed = sessionBox(input, reads);

  const dirs = engineDirs(boxed.cwd);
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const instructions: string[] = [];
  if (prompt) {
    // Written into the session's own directory, which the box already lets the engine read.
    const file = join(boxed.cwd, "instructions.md");
    writeFileSync(file, prompt.text, { mode: 0o600 });
    instructions.push(file);
  }
  const config = openCodeConfig({ identity, permission, mcp: servers, instructions });

  // Only runtime plumbing is inherited: no ambient login, no provider key, no plugin or loader variable,
  // and none of the engine's experimental switches.
  const env: Record<string, string | undefined> = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ"]) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, {
    HOME: dirs.home, TMPDIR: dirs.scratch,
    XDG_CONFIG_HOME: dirs.config, XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state, XDG_CACHE_HOME: dirs.cache,
    [OPENCODE_CONFIG_ENV]: JSON.stringify(config),
    [OPENCODE_KEY_ENV]: key,
    OPENCODE_SERVER_PASSWORD: randomBytes(24).toString("hex"),
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_TERMINAL_TITLE: "1",
  });
  // The loop runs in a clean session directory, so `imprnt recall` and `imprnt ingest` find the person's
  // vault only by being told where it is.
  const vault = join(root, "vault");
  if (ordinary && existsSync(vault)) env.IMPRNT_VAULT = vault;

  const argv = [bin, "serve", "--hostname", "127.0.0.1", "--pure"];
  refuseRoutingOf(argv, env, config);
  return { ...boxed, argv, env, credentialId: credential.id };
}
