import { listAgents, senderAllowed } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import { appendEntry } from "../records/diary.ts";
import type { StoreLike } from "../store/connect.ts";
import { enqueueInbound, type JobSource } from "../store/inbound.ts";
import { DISPATCH_PHRASES } from "./lines.ts";
import { isDispatchCommand } from "../harvest/slice.ts";

/**
 * Every way a dispatch can be refused at the door carries ONE name, so an
 * unknown target and another person's agent are indistinguishable from the
 * outside and the refusal tells an attacker nothing about which agents exist.
 */
export class DispatchRefused extends Error {
  constructor() {
    super("dispatch-not-authorized");
    this.name = "DispatchRefused";
  }
}

/** The sha256 of the task bytes, and the ONE place that arithmetic lives. */
export function taskDigest(task: string): string {
  return new Bun.CryptoHasher("sha256").update(task).digest("hex");
}

/** A well-formed digest, which is what the runner compares against. */
export function isDigest(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * What a person typed, read by the same rule the recognizer uses.
 *
 * `null` is not a dispatch command at all. `"usage"` is the verb with a target
 * or a task missing. Otherwise the target is the first token after the verb and
 * THE TASK IS EVERYTHING AFTER IT, so a task carrying newlines or repeated
 * spaces survives byte for byte: the task is the job's whole input and a
 * reformatted one is a different task from the one that was approved. Only the
 * run of whitespace separating the target from the task is dropped, because it
 * is the separator and not part of either.
 */
export function parseDispatch(text: string): { target: string; task: string } | "usage" | null {
  const said = String(text ?? "");
  if (!isDispatchCommand(said)) return null;
  const verb = Object.values(DISPATCH_PHRASES)
    .find((phrase) => said.slice(0, phrase.length).toLowerCase() === phrase.toLowerCase());
  if (verb === undefined) return null;
  const rest = said.slice(verb.length);
  const parts = /^\s+(\S+)\s+([\s\S]*)$/.exec(rest);
  if (!parts || parts[2] === "") return "usage";
  return { target: parts[1], task: parts[2] };
}

export interface DispatchRequest {
  /** The job's own id, derived from the platform message, so a replay lands nothing. */
  id: string;
  registry: Registry;
  person: string;
  door: string;
  chat: string;
  /** The agent whose chat the command arrived in, which is the dispatcher. */
  agent: string;
  sender_id: string;
  /** The platform display name, kept for the chat line the target reads. */
  from?: string;
  target: string;
  task: string;
  at: string;
}

/**
 * Authorize the command and put the job on the queue, in the shape
 * `requestRecovery` already has.
 *
 * The job is a row on the one queue because a message or job stored outside the
 * one database is forbidden and a table of its own would be a second claim
 * path. The door writes it, the runner may not insert into that table at all,
 * and the model has no store.
 */
export async function requestDispatch(store: StoreLike, request: DispatchRequest): Promise<string> {
  const agents = listAgents(request.registry);
  const target = agents.find((one) => one.id === request.target);
  // Four refusals, one name. The target is an agent of the SAME person, which
  // is the rule the shipped recovery command reads for its own verb, and the
  // dispatcher may not dispatch to itself because a job for itself is a loop.
  if (!senderAllowed(request.registry, request.person, request.door, request.sender_id)) throw new DispatchRefused();
  if (!agents.some((one) => one.person === request.person && one.door === request.door && one.chat === request.chat)) {
    throw new DispatchRefused();
  }
  if (!target || target.person !== request.person || target.id === request.agent) throw new DispatchRefused();
  const envelope = {
    dispatcher: request.agent,
    target: target.id,
    approved: { by: request.sender_id, at: request.at, digest: taskDigest(request.task), source: "chat-command" },
    return: { agent: request.agent, door: request.door, chat: request.chat },
  };
  // An agent with a chat has a chat log for the job's own line, so the row is
  // written unprojected with the TARGET's door and chat, which is what the
  // projection sweep keys on. An agent with neither has no log to write a line
  // into, so its row is ready at the commit and the shipped work notification
  // wakes its runner there.
  const served = Boolean(target.door && target.chat);
  const source: JobSource = {
    log_id: request.id, at: request.at,
    ...(served ? { door: target.door, chat: target.chat } : {}),
    from: request.from ?? request.person, text: request.task, dispatch: envelope,
  };
  await store.sql.begin(async (sql) => {
    const inside = { ...store, sql: sql as unknown as StoreLike["sql"] };
    const written = await enqueueInbound(inside, {
      id: request.id, person: request.person, agent: target.id, body: request.task,
      kind: "job", source, log_ready: !served,
    });
    if (!written) return;
    await appendEntry(inside, {
      stream: "control", subject: request.id, kind: "dispatch.requested", actor: "door",
      detail: { by: request.sender_id, dispatcher: request.agent, target: target.id, at: request.at },
    });
  });
  return request.id;
}
