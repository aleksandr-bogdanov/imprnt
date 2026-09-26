import { councilSeatsOf, listAgents, senderAllowed } from "../registry/entries.ts";
import type { Registry } from "../registry/load.ts";
import { appendEntry } from "../records/diary.ts";
import { appendRow } from "../records/statesheet.ts";
import type { StoreLike } from "../store/connect.ts";
import { enqueueInbound, type DispatchEnvelope, type JobSource } from "../store/inbound.ts";
import { COUNCIL_SHEET, councilIdOf, seatJobId, seatTask, type CouncilRow } from "./council.ts";
import { COUNCIL_PHRASES, DISPATCH_PHRASES } from "./lines.ts";
import { isCouncilCommand, isDispatchCommand } from "../harvest/slice.ts";

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

/**
 * A council command, read by the rule `parseDispatch` reads a dispatch by.
 *
 * `null` is not a council command at all. `"usage"` is the verb with no
 * question after it. Otherwise THE QUESTION IS EVERYTHING AFTER THE VERB, byte
 * for byte, less the run of whitespace that separates it from the verb: the
 * question is what every seat is asked and what the merge repeats, and a
 * reformatted one is a different question from the one that was typed.
 */
export function parseCouncil(text: string): { question: string } | "usage" | null {
  const said = String(text ?? "");
  if (!isCouncilCommand(said)) return null;
  const verb = Object.values(COUNCIL_PHRASES)
    .find((phrase) => said.slice(0, phrase.length).toLowerCase() === phrase.toLowerCase());
  if (verb === undefined) return null;
  const parts = /^\s+([\s\S]*)$/.exec(said.slice(verb.length));
  if (!parts || parts[1] === "") return "usage";
  return { question: parts[1] };
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

/**
 * Every way a council can be refused at the door carries ONE name, for the
 * reason `DispatchRefused` does: the refusal says nothing about whose chat
 * this is or how many seats the person has.
 */
export class CouncilRefused extends Error {
  constructor() {
    super("council-not-authorized");
    this.name = "CouncilRefused";
  }
}

export interface CouncilRequest {
  /**
   * The platform message's own id, as the door derives it. The council id and
   * every seat's job id are built from it, so a replay lands nothing.
   */
  base: string;
  registry: Registry;
  person: string;
  door: string;
  chat: string;
  /** The agent whose chat the command arrived in, which writes the merge. */
  agent: string;
  sender_id: string;
  from?: string;
  question: string;
  at: string;
}

/**
 * Authorize the command and put one job per seat on the queue, in the shape
 * `requestDispatch` writes one, plus the sheet row that holds the council.
 *
 * ONE TRANSACTION: every seat's row, its diary line, the sheet row and the
 * council's own diary line, or none of them. A council with half its seats
 * would merge half an answer and hold the sheet row open for ever.
 *
 * A seat has no chat, so its row is ready at the commit, the rule
 * `requestDispatch` applies to an agent with neither door nor chat, and the
 * shipped work notification wakes its runner there. Its provenance still
 * carries the council mark, so a line made from it anywhere is one the tails
 * leave out.
 */
export async function requestCouncil(store: StoreLike, request: CouncilRequest): Promise<{ id: string; seats: string[] }> {
  const agents = listAgents(request.registry);
  // Three refusals, one name: the sender, the chat, and a person with fewer
  // than two seats, who has no council to convene.
  if (!senderAllowed(request.registry, request.person, request.door, request.sender_id)) throw new CouncilRefused();
  if (!agents.some((one) => one.person === request.person && one.door === request.door && one.chat === request.chat)) {
    throw new CouncilRefused();
  }
  const seats = councilSeatsOf(request.registry, request.person).map((one) => one.id);
  if (seats.length < 2) throw new CouncilRefused();
  const id = councilIdOf(request.base);
  const task = seatTask(request.question);
  const digest = taskDigest(task);
  await store.sql.begin(async (sql) => {
    const inside = { ...store, sql: sql as unknown as StoreLike["sql"] };
    let written = false;
    for (const seat of seats) {
      const jobId = seatJobId(id, seat);
      const envelope: DispatchEnvelope = {
        dispatcher: request.agent,
        target: seat,
        approved: { by: request.sender_id, at: request.at, digest, source: "council" },
        return: { agent: request.agent, door: request.door, chat: request.chat },
        council: { id, seats, seat },
      };
      const source: JobSource = {
        log_id: jobId, at: request.at, from: request.from ?? request.person, text: task,
        dispatch: envelope, origin: "council",
      };
      const fresh = await enqueueInbound(inside, {
        id: jobId, person: request.person, agent: seat, body: task, kind: "job", source, log_ready: true,
      });
      if (!fresh) continue;
      written = true;
      await appendEntry(inside, {
        stream: "control", subject: jobId, kind: "dispatch.requested", actor: "door",
        detail: { by: request.sender_id, dispatcher: request.agent, target: seat, at: request.at, council: id },
      });
    }
    // A replay meets every row it already wrote, and the sheet row with them.
    if (!written) return;
    const row: CouncilRow = {
      person: request.person, agent: request.agent, door: request.door, chat: request.chat,
      task: request.question, seats, at: request.at, answered: {},
    };
    await appendRow(inside, COUNCIL_SHEET, id, row as unknown as Record<string, unknown>);
    await appendEntry(inside, {
      stream: "control", subject: id, kind: "council.requested", actor: "door",
      detail: { by: request.sender_id, agent: request.agent, seats, at: request.at },
    });
  });
  return { id, seats };
}
