import { createHmac } from "node:crypto";
import { LOOP_PREAMBLE } from "../adapters/instructions.ts";
import { credentialSource, effectiveLaunchConfig } from "../adapters/launch.ts";
import { boxContextFor } from "../box/index.ts";
import { listAgents } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { pendingNotesOf, readMove, type MoveRow } from "../store/moves.ts";
import { isRecord, stableText, type ConfigAnswer } from "./move-handoff.ts";

/**
 * THE EFFECTIVE LAUNCH CONFIGURATION OF A MOVE, as digests that two machines compare by equality.
 *
 * It is what `effectiveLaunchConfig` (`adapters/launch.ts`) says a launch of the agent reads on THIS machine, from this runner's own registry
 * (so each machine's placements are applied): the settings, the MCP servers and the whole appended prompt (the hub's preamble, the person's
 * instruction files with their imports expanded, the agent's fragment). It is the same code the launch runs, so what is compared is what would
 * be used, and a configuration the launch would refuse is `{ unverifiable }` with a code and never a path or a value.
 *
 * EXACT EQUALITY IS THE ONLY RULE. An MCP server's `env` and `headers` are compared with the rest of its entry: a value in them can be an
 * ordinary setting as easily as a credential, and nothing in the registry says which. The launch contracts name exactly two things a machine
 * keeps for itself, and only those are left out and reported as `excluded`: the preset's login (`credentialSource`: a login file per machine,
 * never read here) and the hub's own tool server (added by the runner at launch from its own binding; a server of that name in a person's
 * file is refused, not excluded). A configuration that differs in anything else is a `config_mismatch`, and the owner aligns the two files.
 * No ACL, no sensitivity classes and no per-key exceptions are invented here.
 *
 * WHAT THE DIGEST IS: each section is an HMAC-SHA256 of its canonical text under a key made from the move's id, so that two moves' digests
 * are not comparable with each other. The move's id is public: this is equality metadata and NOT a secrecy guarantee, and nothing here claims
 * that a digest hides a low-entropy value. No content, value, path or prompt text is ever put in a section name, a block or a note; the names
 * are the section's (`instructions`, `settings`, `mcp`, `mcp:<server>`).
 */
export const CONFIG_VERSION = 1;

/** More servers than this are not compared (the sealed manifest and the destination's facts are bounded), and name the refusal. */
export const MAX_MCP_SERVERS = 32;
const SERVER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** What a launch keeps for itself and a move does not compare: the login of the preset and the hub's own tool server. */
const EXCLUDED = ["login", "hub-tool-server"];

/** The refusal's code, from the launch's own error message and nothing else: nothing the message names (a path) leaves here. */
function unverifiableCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const errno = (error as { code?: unknown } | null)?.code;
  if (message.startsWith("invalid-settings")) return "settings_invalid";
  if (message.startsWith("invalid-mcp")) return "mcp_invalid";
  if (message.startsWith("invalid-configuration")) return "config_invalid";
  if (message.startsWith("instructions-")) return "instructions_invalid";
  if (errno === "ENOENT" || errno === "EACCES" || errno === "EPERM") return "fragment_unreadable";
  return "config_unreadable";
}

export function effectiveConfigOf(registry: Registry, agentId: string, moveId: string): ConfigAnswer {
  const agent = listAgents(registry).find(one => one.id === agentId);
  if (!agent) return { unverifiable: "agent_unknown" };
  // The triage master is launched with no settings, no server and no instructions of the person's: there is nothing to compare.
  if (agent.role === "triage") return { version: CONFIG_VERSION, sections: {}, excluded: [] };
  let launch: ReturnType<typeof effectiveLaunchConfig>;
  try {
    let credentialFile: string | undefined;
    try { credentialFile = credentialSource(registry, agent.preset).file; } catch { credentialFile = undefined; }
    launch = effectiveLaunchConfig({ registry, agent, purpose: "ordinary", box: boxContextFor(registry, agent.id), credentialFile, hubMcp: true });
  } catch (error) { return { unverifiable: unverifiableCode(error) }; }
  const servers = launch.mcp.mcpServers as Record<string, unknown>;
  const names = Object.keys(servers).sort();
  if (names.length > MAX_MCP_SERVERS) return { unverifiable: "mcp_too_many" };
  if (names.some(name => !SERVER_NAME.test(name))) return { unverifiable: "mcp_server_name" };
  const key = `imprnt-move-config:${moveId}`;
  const keyed = (value: unknown): string => createHmac("sha256", key).update(stableText(value)).digest("hex");
  const prompt = launch.prompt!;
  const sections: Record<string, string> = {
    preamble: keyed(LOOP_PREAMBLE),
    instructions: keyed(prompt.text.slice(LOOP_PREAMBLE.trimEnd().length)),
    settings: keyed(launch.settings),
    mcp: keyed({ ...launch.mcp, mcpServers: names }),
  };
  for (const name of names) sections[`mcp:${name}`] = keyed(servers[name]);
  return { version: CONFIG_VERSION, sections, excluded: [...EXCLUDED] };
}

/** The names of the sections that differ between two configurations, never a value. Empty when they are equal; one that is not a configuration differs as `config`. */
export function configDifference(mine: unknown, theirs: unknown): string[] {
  if (!isRecord(mine) || !isRecord(theirs) || !isRecord(mine.sections) || !isRecord(theirs.sections)) return ["config"];
  if (mine.version !== theirs.version) return ["version"];
  const a = mine.sections, b = theirs.sections;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(name => a[name] !== b[name]).sort();
}

/**
 * THE FIRST RESUMED LAUNCH OF A MOVED CONVERSATION: the configuration the move sealed against the one this runner would launch with now, asked
 * before a child is started while the move's note is still owed. Null when nothing is owed, or the move sealed no configuration AND its destination
 * recorded none (an older move on both sides); otherwise the refusal's words (section names only) when it differs or cannot be read, and
 * `config-unverifiable:not-sealed` when the destination recorded its configuration and the manifest sealed nothing to compare it with. There is no
 * re-preflight and no owner decision: the launch is refused until the file is what the move compared, and the input waits as any refused feed does.
 */
export async function moveConfigDrift(store: StoreLike, registry: Registry, runner: string, agent: string, conversation: string): Promise<{ move: string; answer: string } | null> {
  const owed = (await pendingNotesOf(store, agent)).filter(one => one.conversation === conversation);
  const last = owed[owed.length - 1];
  if (!last) return null;
  const move = await readMove(store, last.move);
  if (!move || move.dest_runner !== runner) return null;
  const answer = configDriftOf(registry, agent, move);
  return answer === null ? null : { move: move.id, answer };
}

/** `moveConfigDrift`'s answer for one move row: the words of the refusal, or null. */
export function configDriftOf(registry: Registry, agent: string, move: MoveRow): string | null {
  if (!isRecord(move.manifest?.config)) return isRecord(move.dest_facts?.effective) ? "config-unverifiable:not-sealed" : null;
  const now = effectiveConfigOf(registry, agent, move.id);
  if ("unverifiable" in now) return `config-unverifiable:${now.unverifiable}`;
  const differs = configDifference(move.manifest.config, now);
  return differs.length > 0 ? `config-drift:${differs.slice(0, 4).join(",")}` : null;
}
