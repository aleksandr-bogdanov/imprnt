import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { credentialSource, effectiveMcp, effectivePrompt, effectiveSettings, sessionBox, type LoopLaunchInput } from "./launch.ts";
import { personOf, vaultRootOf } from "./instructions.ts";
import { readModelKey } from "./opencode-launch.ts";

import { CODEX_CONFIG, CODEX_KEY } from "./codex-config.ts";
const versions = new Map<string, { stamp: string; version: string }>();
export function probeCodexVersion(bin = "codex", timeout = 10_000): string {
  const executable = Bun.which(bin);
  if (!executable) throw new Error("codex-binary-missing");
  const stat = statSync(executable, { bigint: true });
  const stamp = [realpathSync(executable), stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  const kept = versions.get(executable);
  if (kept?.stamp === stamp) return kept.version;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hub-codex-probe-")));
  try {
    const result = Bun.spawnSync([executable, "--version"], { cwd: root, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root }, stdout: "pipe", stderr: "pipe", timeout });
    const version = result.stdout.toString().match(/^codex-cli (\d+\.\d+\.\d+)\s*$/)?.[1];
    if (result.exitCode !== 0 || !version) throw new Error("codex-version-unavailable");
    versions.set(executable, { stamp, version });
    return version;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function toml(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (value && typeof value === "object") return `{ ${Object.entries(value).map(([key, val]) => `${JSON.stringify(key)} = ${toml(val)}`).join(", ")} }`;
  throw new Error("codex-config-unsupported");
}

/** Existing model-key credentials only. No copied OAuth login or ambient account/config. */
export function makeCodexLaunch(input: LoopLaunchInput, bin = "codex") {
  if (input.preset.adapter !== "codex" || input.purpose !== "ordinary") throw new Error("codex-purpose-unsupported");
  if (!input.box?.tree || !statSync(input.box.tree).isDirectory()) throw new Error("box-required");
  if (input.agent.tools !== undefined || Object.keys(effectiveSettings(input)).length) throw new Error("codex-tool-policy-unsupported");
  const credential = input.credential ?? credentialSource(input.registry, input.agent.preset);
  const key = readModelKey(credential);
  const provider = input.preset.provider;
  const model = input.preset.model;
  if (!/^[a-zA-Z0-9_-]+$/.test(provider) || !model.trim()) throw new Error("codex-model-required");
  const endpoint = credential.base_url ?? (provider === "openai" ? "https://api.openai.com/v1" : null);
  if (!endpoint) throw new Error("codex-provider-endpoint-required");
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) throw new Error("codex-provider-endpoint-invalid");
  const prompt = effectivePrompt({ ...input, credentialFile: credential.file });
  const { mcp, mcpFile } = effectiveMcp({ ...input, hubMcp: Boolean(input.hubMcp) });
  const servers: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(mcp.mcpServers as Record<string, unknown>)) {
    const server = raw as { command?: unknown; args?: unknown; env?: unknown; type?: unknown };
    if (!server || typeof server.command !== "string" || (server.type !== undefined && server.type !== "stdio") ||
        Object.keys(server).some(key => !["command", "args", "env", "type"].includes(key)) ||
        (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== "string"))) ||
        (server.env !== undefined && (!server.env || typeof server.env !== "object" || Array.isArray(server.env) || Object.values(server.env).some(val => typeof val !== "string")))) throw new Error("codex-mcp-unsupported");
    servers[name] = { command: server.command, args: server.args ?? [], env: server.env ?? {}, required: true };
  }
  if (input.hubMcp) servers.hub = { command: input.hubMcp.command, args: input.hubMcp.args, env: input.hubMcp.env, required: true };
  const reads = [...(prompt?.reads ?? []), ...(mcpFile ? [mcpFile] : []), ...(input.hubMcp?.reads ?? [])];
  const writes = [...(input.box.writePaths ?? []), ...(input.hubMcp?.writes ?? [])];
  const parent = dirname(credential.file);
  const needs = [input.box.tree, input.box.stateRoot ?? "", input.sessionDir, ...reads, ...writes].filter(Boolean);
  const mask = process.platform === "linux" && existsSync(parent) && !needs.some(p => p === parent || p.startsWith(parent + "/")) ? parent : credential.file;
  const boxed = sessionBox({ ...input, box: { ...input.box, writePaths: writes, secretPaths: [...(input.box.secretPaths ?? []), mask] } }, reads);
  const home = join(boxed.cwd, "home");
  const codexHome = join(boxed.cwd, "codex");
  const scratch = join(boxed.cwd, "tmp");
  for (const path of [home, codexHome, scratch]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const config = {
    model, model_provider: provider, approval_policy: "never", sandbox_mode: "danger-full-access",
    agents: { enabled: false }, web_search: "disabled",
    features: { multi_agent: false, multi_agent_v2: false, apps: false, goals: false, hooks: false, plugins: false, remote_plugin: false, shell_snapshot: false },
    allow_login_shell: false,
    memories: { generate_memories: false, use_memories: false },
    shell_environment_policy: { inherit: "none", include_only: ["PATH", "HOME", "TMPDIR", "LANG", "IMPRNT_VAULT"] },
    model_providers: { [provider]: { name: provider, base_url: endpoint, env_key: CODEX_KEY, wire_api: "responses", requires_openai_auth: false, supports_websockets: false } },
    mcp_servers: servers,
    ...(prompt ? { developer_instructions: prompt.text } : {}),
  };
  writeFileSync(join(codexHome, "config.toml"), Object.entries(config).map(([key, value]) => `${key} = ${toml(value)}\n`).join(""), { mode: 0o600 });
  const env: Record<string, string | undefined> = {};
  for (const name of ["PATH", "LANG", "LC_ALL", "TZ"]) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, { HOME: home, CODEX_HOME: codexHome, TMPDIR: scratch, [CODEX_KEY]: key, [CODEX_CONFIG]: JSON.stringify(config) });
  const vault = join(vaultRootOf(personOf(input.registry, input.agent.person), input.box.tree), "vault");
  if (existsSync(vault)) env.IMPRNT_VAULT = vault;
  return { ...boxed, argv: [bin, "app-server", "--listen", "stdio://", "--strict-config"], env, credentialId: credential.id };
}
