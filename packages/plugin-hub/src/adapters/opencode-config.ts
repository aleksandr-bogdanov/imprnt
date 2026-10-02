/**
 * What a hub launch of OpenCode is made of, as pure functions: the permission
 * rules, the inline configuration, the MCP servers in the engine's own spelling,
 * the environment, and the check that the running server really holds what was
 * asked. Nothing here touches a disk, a process or a network, so every rule can
 * be read and tested on its own. `opencode-launch.ts` is what writes and spawns.
 *
 * Every fact about the engine used below was read from the official pages of the
 * pinned release's documentation (server, config, permissions, agents, MCP, CLI),
 * and the ones that were NOT on those pages are listed in `opencode-wire.ts` and
 * in the result file as open questions, never assumed here.
 */

/** The one environment variable the provider key travels in. The config names it and never holds the key. */
export const OPENCODE_KEY_ENV = "HUB_OPENCODE_API_KEY";

/** The inline configuration, which ranks above every file the agent could write into its working directory. */
export const OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT";

/**
 * Claude-spelled builtin names, which is how an agent's `tools` list and the
 * person's configuration have always spelled them, and the OpenCode permission
 * key that gates the same capability. `Write` and `Edit` are one key there
 * (`edit` gates `write`, `edit` and `apply_patch`). A name not in this table has no
 * known permission and is refused by name rather than guessed at.
 */
export const TOOL_PERMISSIONS: Readonly<Record<string, string>> = {
  Bash: "bash", Read: "read", Write: "edit", Edit: "edit", Glob: "glob", Grep: "grep",
  WebFetch: "webfetch", WebSearch: "websearch",
};

/** What an ordinary agent that names no tools is launched with: explicit, never the engine's default. */
export const ORDINARY_PROFILE: readonly string[] = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch"];

/** What a harvest reads the tree with, and writes nothing. */
export const HARVEST_PROFILE: readonly string[] = ["Read", "Glob", "Grep"];

/** The engine's own subagents. All three are switched off by name, besides the `task` permission and the depth. */
export const BUILTIN_SUBAGENTS: readonly string[] = ["general", "explore", "scout"];

/** The documented default for `read`, kept as it is: a `.env` file is not something a tool reads. */
const READ_RULES = { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" } as const;

const named = (tool: string) => tool.split("(")[0].trim();

/**
 * The permission object, DENY BY DEFAULT: `*` first, because the last matching
 * rule wins, then exactly the keys the tool list names. An MCP server's tools are
 * registered under the server's name and a wildcard on it is how they are let in.
 * The keys that would otherwise stop and ask (`external_directory`, `doom_loop`,
 * `question`) are all answered here, because a headless session that asks waits for
 * nobody: nothing in a hub launch is left at `ask`.
 *
 * `task` is denied by name as well as by the default, which is two independent
 * statements of one rule, the way the Claude launch denies its delegation tools.
 */
export function permissionsFor(input: {
  tools: readonly string[];
  servers: readonly string[];
  outside: readonly string[];
  /** The delegation tool names the Claude launch denies (`NATIVE_DELEGATION_TOOLS`): a configuration naming one is refused. */
  delegation: readonly string[];
}): Record<string, unknown> {
  const allowed = new Set<string>();
  for (const tool of input.tools) {
    const name = named(tool);
    // A configured MCP tool is not a builtin: the person's servers are passed as they are.
    if (name === "" || name.startsWith("mcp__")) continue;
    if (input.delegation.some(one => one.toLowerCase() === name.toLowerCase()) || name.toLowerCase() === "task") {
      throw new Error("native-delegation-configured");
    }
    const key = TOOL_PERMISSIONS[name];
    if (!key) throw new Error(`tool-profile-unvalidated: ${name} has no OpenCode permission`);
    allowed.add(key);
  }
  // Listing a directory is reading it.
  if (allowed.has("read")) allowed.add("list");
  const permission: Record<string, unknown> = { "*": "deny" };
  for (const key of [...allowed].sort()) permission[key] = key === "read" ? { ...READ_RULES } : "allow";
  for (const server of input.servers) permission[`${server}_*`] = "allow";
  for (const key of ["task", "skill", "question", "lsp", "doom_loop", "todowrite"]) permission[key] = "deny";
  const outside: [string, string][] = [["*", "deny"]];
  for (const path of input.outside) outside.push([path, "allow"], [`${path}/*`, "allow"]);
  permission.external_directory = Object.fromEntries(outside);
  return permission;
}

/** A server's name is what its tools are prefixed with, so it is a plain word and not a pattern. */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

const stringRecord = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(one => typeof one === "string");

/**
 * The person's MCP servers (`mcpServers`, in the file shape the Claude launch reads)
 * in the engine's spelling: a command is a `local` server with its arguments in one
 * array, a url is a `remote` one. Any other shape is refused by name, because a
 * server quietly dropped is an agent without a tool nobody told the person about.
 */
export function translateMcp(servers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const entry = raw as Record<string, unknown> | null;
    if (!SERVER_NAME.test(name) || !entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid-mcp-configuration");
    if (typeof entry.command === "string") {
      const args = entry.args ?? [];
      if (!Array.isArray(args) || args.some(one => typeof one !== "string") || (entry.env !== undefined && !stringRecord(entry.env))) {
        throw new Error("invalid-mcp-configuration");
      }
      out[name] = { type: "local", command: [entry.command, ...(args as string[])], enabled: true,
        ...(entry.env && Object.keys(entry.env).length > 0 ? { environment: entry.env } : {}) };
    } else if (typeof entry.url === "string" && (entry.type === undefined || ["http", "sse", "remote"].includes(String(entry.type)))) {
      if (entry.headers !== undefined && !stringRecord(entry.headers)) throw new Error("invalid-mcp-configuration");
      // A server that is given its key in a header is not asked to find one through a browser.
      out[name] = { type: "remote", url: entry.url, enabled: true,
        ...(entry.headers && Object.keys(entry.headers).length > 0 ? { headers: entry.headers, oauth: false } : {}) };
    } else {
      throw new Error("invalid-mcp-configuration");
    }
  }
  return out;
}

/** The identity a session is bound to: the engine, who serves the model, which model, and where the key is sent. */
export interface OpenCodeIdentity {
  adapter: "opencode";
  provider: string;
  model: string;
  /** The endpoint a `model-key` names, or null when the engine's own endpoint for the provider is used. */
  endpoint: string | null;
}

/** A provider id and a model id are single words for the engine's `provider/model` form. */
export function identityOf(preset: { provider: string; model: string }, endpoint: string | null): OpenCodeIdentity {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(preset.provider)) throw new Error("opencode-provider-invalid");
  if (preset.model.trim() === "" || /[\s\u0000-\u001f\u007f]/.test(preset.model)) throw new Error("opencode-model-invalid");
  return { adapter: "opencode", provider: preset.provider, model: preset.model, endpoint };
}

/**
 * The inline configuration of one launch. It names the provider and the model,
 * allow-lists that provider alone, points the key at the environment variable it
 * travels in, and pins every auxiliary model (titles, summaries, compaction) to the
 * same one, because the engine's default for those is "a cheaper model if one is
 * available", and a cheaper model somewhere else is a route nobody approved.
 *
 * Subagents are off three ways: the `task` permission, a depth of zero, and each
 * built-in subagent disabled by name. Hiding an agent is not disabling it, and a
 * person may always `@`-mention one directly, so the agents themselves are disabled.
 * Plugins, LSP and formatters are not enabled (an omitted `lsp` and `formatter` stay off).
 */
export function openCodeConfig(input: {
  identity: OpenCodeIdentity;
  permission: Record<string, unknown>;
  mcp: Record<string, unknown>;
  instructions: string[];
}): Record<string, unknown> {
  const { identity } = input;
  const model = `${identity.provider}/${identity.model}`;
  return {
    $schema: "https://opencode.ai/config.json",
    model,
    small_model: model,
    enabled_providers: [identity.provider],
    provider: { [identity.provider]: { options: { apiKey: `{env:${OPENCODE_KEY_ENV}}`, ...(identity.endpoint ? { baseURL: identity.endpoint } : {}) } } },
    default_agent: "build",
    permission: input.permission,
    tools: { task: false },
    subagent_depth: 0,
    agent: {
      build: { mode: "primary", permission: { task: "deny" } },
      ...Object.fromEntries(BUILTIN_SUBAGENTS.map(name => [name, { disable: true }])),
    },
    mcp: input.mcp,
    plugin: [],
    instructions: input.instructions,
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    server: { hostname: "127.0.0.1", mdns: false },
  };
}

/** Whether any KEY of a configuration, at any depth, matches. Values are the person's and are never read for this. */
function keyed(value: unknown, pattern: RegExp): boolean {
  if (Array.isArray(value)) return value.some(one => keyed(one, pattern));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, inner]) => pattern.test(key) || keyed(inner, pattern));
}

/** A fallback or advisor route is not something a hub launch may carry, so one appearing is refused, not dropped. */
export function refuseRoutingOf(argv: string[], env: Record<string, string | undefined>, config: unknown): void {
  if (argv.some(arg => /^--(fallback|advisor)/i.test(arg)) || Object.keys(env).some(key => /fallback|advisor/i.test(key)) ||
      keyed(config, /fallback|advisor/i)) {
    throw new Error("fallback-route-refused");
  }
}

/**
 * The permission decision for one key, the way a reader of the object sees it: a
 * shorthand string, an object's `*` rule, or the object's own default.
 */
function decisionOf(permission: unknown, key: string): unknown {
  if (typeof permission === "string") return permission;
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return undefined;
  const value = (permission as Record<string, unknown>)[key];
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return (value as Record<string, unknown>)["*"];
  return (permission as Record<string, unknown>)["*"];
}

/**
 * Whether the server that is running holds what the launch asked for, read back from
 * its own `GET /config`. NULL is "it does", and anything else is the first thing that
 * is not, by name. This is the check that the restrictions are real on the pinned
 * release: a build that merges, renames or ignores a key shows up here as a refusal,
 * and the session is never started on a configuration nobody read back.
 *
 * What it does NOT establish: that a tool the permissions deny cannot be reached some
 * other way (a shell can still call a model API), and that the response's shape is
 * the one this reads. A shape it cannot read is refused, not waved through.
 */
export function effectiveRefusal(expected: Record<string, unknown>, effective: unknown): string | null {
  if (!effective || typeof effective !== "object" || Array.isArray(effective)) return "config-unreadable";
  const got = effective as Record<string, unknown>;
  const want = expected.permission as Record<string, unknown>;
  const same = (a: unknown, b: unknown) => Bun.deepEquals(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
  if (!got.permission || typeof got.permission !== "object" || Array.isArray(got.permission)) return "config-permission-unreadable";
  for (const [key, value] of Object.entries(want)) {
    if (typeof value === "string" ? decisionOf(got.permission, key) !== value : !same((got.permission as Record<string, unknown>)[key], value)) {
      return `config-permission-differs: ${key}`;
    }
  }
  for (const key of ["model", "small_model", "enabled_providers", "default_agent", "subagent_depth", "share"]) {
    if (!same(got[key], expected[key])) return `config-differs: ${key}`;
  }
  if (Array.isArray(got.plugin) ? got.plugin.length > 0 : got.plugin !== undefined && got.plugin !== null) return "config-differs: plugin";
  const servers = (value: unknown) => Object.keys((value as Record<string, unknown>) ?? {}).sort();
  if (!same(servers(got.mcp), servers(expected.mcp))) return "config-differs: mcp";
  const agents = (got.agent ?? {}) as Record<string, { disable?: unknown } | undefined>;
  for (const name of BUILTIN_SUBAGENTS) if (agents[name]?.disable !== true) return `config-differs: agent.${name}`;
  return null;
}
