import { classifyPlatformError } from "./reply.ts";
import { ADOPT_PHRASES, AGENT_PHRASES, RETIRE_PHRASES } from "./lines.ts";
import { isAgentCommand } from "../harvest/slice.ts";
import { CONTROL_REFUSALS, requestControl } from "../hub/control.ts";
import { listAgents, listRunEntries, senderAllowed } from "../registry/entries.ts";
import { isAgentId, loadRegistry, readSetting, type Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import type { ChatResolution, Platform } from "./platform.ts";

/**
 * The two lifecycle verbs a person types from a phone, `adopt` and `retire`.
 *
 * The command is typed WHERE THE DOOR ALREADY LISTENS, and that is a fact about
 * both platforms rather than a preference: a Discord door reads the channels
 * the registry names it and nothing else, so a message in a chat nobody has
 * bound yet is never fetched at all, and a Telegram door drops every update
 * whose chat is not the one it serves. An adopt typed inside the new chat could
 * never arrive.
 */
export class AgentCommandRefused extends Error {
  /** One of the household's own words, which is what a person reads. */
  override readonly cause: string;
  constructor(cause: string) {
    super(`agent-command-refused: ${cause}`);
    this.name = "AgentCommandRefused";
    this.cause = cause;
  }
}

/** What a person typed, or the usage line, or not a lifecycle command at all. */
export type AgentCommand =
  | { operation: "adopt"; agent: string; ref: string }
  | { operation: "retire"; agent: string }
  | "usage"
  | null;

/**
 * PURE. It reads the phrase tables the door's own sentences are built from, so
 * the verb a person is asked to type and the verb the door takes cannot end up
 * spelled two ways.
 */
export function parseAgentCommand(text: string): AgentCommand {
  const said = String(text ?? "");
  if (!isAgentCommand(said)) return null;
  const verb = Object.values(AGENT_PHRASES)
    .find(phrase => said.slice(0, phrase.length).toLowerCase() === phrase.toLowerCase());
  if (verb === undefined) return null;
  const parts = said.slice(verb.length).trim().split(/\s+/).filter(one => one !== "");
  const [sub, agent, ref] = parts;
  if (sub === undefined || agent === undefined || agent === "") return "usage";
  const said2 = sub.toLowerCase();
  if (Object.values(ADOPT_PHRASES).some(phrase => phrase.toLowerCase() === said2)) {
    return ref === undefined || ref === "" ? "usage" : { operation: "adopt", agent, ref };
  }
  if (Object.values(RETIRE_PHRASES).some(phrase => phrase.toLowerCase() === said2)) {
    return { operation: "retire", agent };
  }
  return "usage";
}

/** A resolution, or a platform that could not be asked inside its bounds. */
export type ResolvedRef = ChatResolution | { kind: "failed"; cause: string; detail?: string };

/**
 * Resolve what a person typed through the platform's own seam, under this
 * household's delivery bounds.
 *
 * The retry is the shipped platform shape: a call that failed for a reason that
 * could pass is tried again after `door.delivery_retry_seconds`, up to
 * `door.delivery_max_attempts`, and a permanent refusal stops at once. Every
 * cause goes through `classifyPlatformError`, so a token-shaped fragment of an
 * error message never reaches a chat.
 */
export async function resolveChatRef(platform: Platform, ref: string,
  bounds: { retrySeconds: number; maxAttempts: number }): Promise<ResolvedRef> {
  if (!platform.admin) return { kind: "unsupported", cause: "unsupported on this platform" };
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await platform.admin.resolveChat(ref);
    } catch (error) {
      const failure = classifyPlatformError(error);
      if (failure.kind === "permanent" || attempt >= bounds.maxAttempts) {
        return { kind: "failed", cause: failure.cause, detail: failure.code };
      }
      await Bun.sleep(bounds.retrySeconds * 1000);
    }
  }
}

export interface AgentLifecycleRequest {
  /** The row's own id, derived from the platform message, so a replay lands nothing. */
  id: string;
  registry: Registry;
  person: string;
  door: string;
  /** The chat the command was typed in, which is where its outcome is said. */
  chat: string;
  /** The agent whose chat that is. */
  agent: string;
  sender_id: string;
  platform: Platform;
  operation: "adopt" | "retire";
  /** The agent the command is about, which an adopt may be creating. */
  target: string;
  /** What the person typed for the chat: its name in the app, or its id. */
  ref?: string;
}

/**
 * Authorize one lifecycle command and ask the control sheet for it.
 *
 * The chat is resolved HERE, at the door, because the door is the only process
 * that holds a platform at all. The hub is handed the chat id the resolution
 * produced and edits the file, which is why a hub needs no platform and no
 * token to make an agent.
 */
export async function requestAgentLifecycle(store: StoreLike, request: AgentLifecycleRequest): Promise<void> {
  const { person } = request;
  // THE FILE IS READ AGAIN HERE, and the reason is measured: the door parses
  // the registry once a tick, and a lifecycle decision taken on a copy that old
  // refuses an agent that was adopted a moment ago with `access denied`, which
  // is both wrong and frightening. A command a person typed is not a tick, so
  // one read is worth it. A file caught half written falls back to the tick's
  // copy and the hub checks everything again on the apply side anyway.
  let registry = request.registry;
  try { registry = loadRegistry(request.registry.file); } catch { registry = request.registry; }
  const agents = listAgents(registry);
  if (!senderAllowed(registry, person, request.door, request.sender_id)) throw new AgentCommandRefused("access denied");
  if (!agents.some(one => one.person === person && one.door === request.door && one.chat === request.chat)) {
    throw new AgentCommandRefused("access denied");
  }
  const door = listRunEntries(registry).find(one => one.id === request.door && one.kind === "door");
  if (!door) throw new AgentCommandRefused("invalid configuration");
  // THE DOOR'S OWN PERSON is who an agent made or moved through it belongs to.
  // A door two people share would otherwise let the second person make an
  // agent under the first, which the hub refuses on apply, and the person would
  // read a refusal about configuration for what is really a question of whose
  // door this is.
  const owner = (registry.data.run as { id: string; person?: string }[]).find(one => one.id === request.door)?.person;
  if (owner !== person) throw new AgentCommandRefused("access denied");
  // AN ID THAT CAN LEAVE ITS FOLDER NEVER REACHES THE CONTROL SHEET. The loader
  // refuses one in the file, and this is the same rule asked before anything is
  // written, so a typed command cannot even propose one.
  if (!isAgentId(request.target)) throw new AgentCommandRefused("invalid configuration");
  const existing = agents.find(one => one.id === request.target);
  // ANOTHER PERSON'S AGENT IS NOT THIS PERSON'S TO TOUCH, and an agent this
  // file does not name cannot be retired at all. NOR IS AN AGENT OF ANOTHER
  // DOOR: its chat id means something only on its own door, so a Telegram
  // agent repaired from a Discord chat would be given a channel id it can never
  // answer in, and the cursor a retire removes is keyed by the agent's door.
  // The same verb typed on the agent's own door is the way to it.
  const reachable = (one: typeof existing) => one !== undefined && one.person === person && one.door === request.door;
  if (request.operation === "retire") {
    if (!reachable(existing)) throw new AgentCommandRefused("access denied");
    await ask(store, request, {});
    return;
  }
  if (existing && !reachable(existing)) throw new AgentCommandRefused("access denied");
  if (!existing) {
    // One Telegram door serves one agent in one chat, by the loader's own rule,
    // because `getUpdates` confirms updates for the whole bot. A second agent
    // there is a second bot token and a door entry, which is a hand edit.
    const platform = (registry.data.run as { id: string; platform?: string }[])
      .find(one => one.id === request.door)?.platform;
    if (platform === "telegram") throw new AgentCommandRefused("one agent per bot");
    // A new agent has to run as something, and the door's entry is where this
    // household says what that is.
    if (!door.default_preset) throw new AgentCommandRefused("invalid configuration");
  }
  const resolved = await resolveChatRef(request.platform, String(request.ref ?? ""), {
    retrySeconds: Number(readSetting(registry, "door.delivery_retry_seconds")),
    maxAttempts: Number(readSetting(registry, "door.delivery_max_attempts")),
  });
  if (resolved.kind !== "chat") throw new AgentCommandRefused(resolved.cause);
  // A chat another agent of this door already answers in would be answered
  // twice for every message, and the loader does not refuse that on a Discord
  // door, so it is refused here, before anything is asked of the hub.
  if (agents.some(one => one.id !== request.target && one.door === request.door && one.chat === resolved.chat)) {
    throw new AgentCommandRefused("invalid configuration");
  }
  await ask(store, request, { chat: resolved.chat, name: resolved.name });
}

/**
 * The control row itself, in the shape the shipped recovery verb already has.
 *
 * A refusal that verb names is this command's refusal too, and it is said to
 * the person as one: left as an error it would stop the door acknowledging the
 * batch, and the chat would get the same batch back for ever.
 */
async function ask(store: StoreLike, request: AgentLifecycleRequest, values: Record<string, unknown>): Promise<void> {
  try {
    await requestControl(store, {
      id: request.id, source: "chat", actor: request.sender_id, sender_id: request.sender_id,
      person: request.person, door: request.door, chat: request.chat, agent: request.agent,
      target_kind: "agent-lifecycle", target_id: request.target,
      operation: request.operation, arguments: values, registry: request.registry,
    });
  } catch (error) {
    if ((CONTROL_REFUSALS as readonly string[]).includes((error as Error).message)) {
      throw new AgentCommandRefused("invalid configuration");
    }
    throw error;
  }
}
