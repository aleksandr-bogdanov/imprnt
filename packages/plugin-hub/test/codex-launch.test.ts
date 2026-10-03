import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ADAPTERS } from "../src/adapters/index.ts";
import { makeCodexLaunch, probeCodexVersion } from "../src/adapters/codex-launch.ts";
import { CODEX_CONFIG, CODEX_KEY } from "../src/adapters/codex-config.ts";
import type { LoopLaunchInput } from "../src/adapters/launch.ts";
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hub-codex-launch-")); roots.push(root);
  const tree = join(root, "tree"), sessionDir = join(root, "state/p1/session");
  mkdirSync(join(tree, "vault"), { recursive: true }); writeFileSync(join(tree, "CLAUDE.md"), "shared person instructions");
  const key = "synthetic-codex-key", file = join(root, "key"); writeFileSync(file, key, { mode: 0o600 });
  const input = { registry: null, preset: { adapter: "codex", model: "explicit-model", provider: "openai", effort: "high", paid: "token" },
    credential: { id: "key", kind: "model-key", owner: "p1", file }, agent: { id: "worker", person: "p1", preset: "worker", runner: "runner" },
    sessionDir, purpose: "ordinary", box: { tree, agent: "worker", person: "p1", sessionDir, stateRoot: join(root, "state/p1"), otherTrees: [], purpose: "ordinary" },
    hubMcp: { command: process.execPath, args: ["hub-mcp.ts"], env: { HUB_SOCKET: "synthetic-socket" }, reads: [], writes: [] },
  } as LoopLaunchInput;
  return { root, tree, key, input };
}
function bytes(path: string): string { return readdirSync(path, { withFileTypes: true }).map(item => item.isDirectory() ? bytes(join(path, item.name)) : readFileSync(join(path, item.name), "utf8")).join("\n"); }
test("Codex launch uses shared boxing/instructions/Hub MCP with isolated config, explicit provider and no written key", () => {
  const f = fixture();
  const launch = makeCodexLaunch(f.input, "codex");
  expect(ADAPTERS.codex.name).toBe("codex");
  expect(launch.argv).toEqual(["codex", "app-server", "--listen", "stdio://", "--strict-config"]);
  expect(typeof launch.wrap).toBe("function");
  const config = JSON.parse(launch.env[CODEX_CONFIG]!);
  expect(Bun.TOML.parse(readFileSync(join(launch.cwd, "codex/config.toml"), "utf8"))).toEqual(config);
  expect(config).toMatchObject({ model: "explicit-model", model_provider: "openai", agents: { enabled: false }, mcp_servers: { hub: { command: process.execPath, args: ["hub-mcp.ts"], required: true } } });
  expect(config.developer_instructions).toContain("shared person instructions");
  expect(config.shell_environment_policy.include_only).not.toContain(CODEX_KEY);
  expect(launch.env[CODEX_KEY]).toBe(f.key); expect(launch.env.OPENAI_API_KEY).toBeUndefined();
  expect(bytes(launch.cwd)).not.toContain(f.key); expect(launch.argv.join(" ")).not.toContain(f.key);
  expect(launch.env.CODEX_HOME).toBe(join(launch.cwd, "codex")); expect(launch.env.IMPRNT_VAULT).toBe(join(f.tree, "vault"));
});
test("Codex refuses unsupported policy translation, credentials, purpose and missing provider endpoints", () => {
  const f = fixture();
  expect(() => makeCodexLaunch({ ...f.input, agent: { ...f.input.agent, tools: ["Read"] } })).toThrow("tool-policy-unsupported");
  expect(() => makeCodexLaunch({ ...f.input, purpose: "triage" })).toThrow("purpose-unsupported");
  expect(() => makeCodexLaunch({ ...f.input, preset: { ...f.input.preset, provider: "custom" } })).toThrow("provider-endpoint-required");
  expect(() => makeCodexLaunch({ ...f.input, credential: { ...f.input.credential!, kind: "claude-login" } })).toThrow("credential-source-unsupported");
  const file = join(f.root, "bin"); writeFileSync(file, '#!/bin/sh\nprintf "codex-cli 0.160.0\\n"\n', { mode: 0o700 });
  expect(probeCodexVersion(file)).toBe("0.160.0");
});
