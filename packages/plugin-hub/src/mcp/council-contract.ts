import { ToolError, exact, readRequestKey, readSourceIds, refuse } from "./reading.ts";

/**
 * `hub_council`: what the hub offers a model to run a council, and how strictly it is read.
 * Pure, like `contracts.ts`: the facade process carries no database code and no credential.
 *
 * Identity is never an argument. The person, the agent, the conversation and the turn are the
 * runner's own binding of the launch, and the schema has no field for them, for a route, for an
 * approval or for a login. Every call that changes something carries `request_key` and, unless it
 * makes a new council, the `expected_revision` it was shown; the owner's own messages are named by id
 * (`source_message_ids`), and the code checks those messages really are the owner's. It cannot check
 * that their words mean what the master says they mean, and the reply never pretends it did.
 *
 * NO ROUND COUNT, NO DEFAULT ROSTER. The master decides when another round adds nothing, and who takes
 * part is what the owner said: a roster that is not fully named is answered with the real choices.
 */

export const HUB_COUNCIL = "hub_council";

const STRING = { type: "string" } as const;
const IDS = { type: "array", items: STRING, minItems: 1, maxItems: 12 } as const;

export const COUNCIL_TOOL = {
  name: HUB_COUNCIL,
  description:
    "Run a council of the owner's workers: separate participants answer the same question independently, then you synthesize. " +
    "start: authority is {source_message_ids} (the owner asked for a council: it starts at once) or {proposal: true} (it was your own idea: " +
    "the owner sees the exact roster and approves it with a reaction). participants names each worker with its worker_ref, preset_ref and machine_ref " +
    "exactly as configured, and a brief you wrote for it. Never choose participants for the owner: leave participants out and you get the real choices back. " +
    "continue: follow_up (the owner asks the same participants more), debate_round (participants read and challenge one another; only if the owner opted into debate), " +
    "correction (the owner changed the question: name the affected participants), owner_decision (record the owner's choice about a missing participant or a checkpoint), " +
    "finalize (call it in the turn in which you write the synthesis: that turn's reply is the result). " +
    "inspect: the state, per-participant evidence and answers, paginated. stop: end the council on the owner's word. " +
    "Every change needs request_key and the expected_revision inspect showed. Never record an owner's choice on your own initiative, " +
    "and never rerun, replace or leave out a participant without it.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["start", "continue", "inspect", "stop"] },
      request_key: { type: "string", minLength: 1, maxLength: 200 },
      expected_revision: { type: "integer", minimum: 1 },
      council_id: STRING,
      authority: {
        type: "object",
        additionalProperties: false,
        properties: { source_message_ids: { type: "array", items: STRING, minItems: 1, maxItems: 10 }, proposal: { type: "boolean", enum: [true] } },
      },
      question: { type: "string", minLength: 1, maxLength: 8000 },
      context: {
        type: "array", maxItems: 20,
        items: { type: "object", additionalProperties: false, properties: { text: { type: "string", minLength: 1, maxLength: 8000 } }, required: ["text"] },
      },
      participants: {
        type: "array", maxItems: 12,
        items: {
          anyOf: [
            STRING,
            { type: "object", additionalProperties: false, properties: {
              worker_ref: STRING, preset_ref: STRING, machine_ref: STRING, brief: { type: "string", maxLength: 6000 } } },
          ],
        },
      },
      debate: { type: "boolean" },
      kind: { type: "string", enum: ["follow_up", "correction", "debate_round", "owner_decision", "finalize"] },
      source_message_ids: { type: "array", items: STRING, minItems: 1, maxItems: 10 },
      message: { type: "string", minLength: 1, maxLength: 8000 },
      briefs: {
        type: "array", maxItems: 12,
        items: { type: "object", additionalProperties: false, required: ["participant_id", "text"], properties: {
          participant_id: STRING, text: { type: "string", minLength: 1, maxLength: 6000 },
          evidence_refs: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["participant_id"],
            properties: { participant_id: STRING, round: { type: "integer", minimum: 1 } } } } } },
      },
      decision: {
        type: "object", additionalProperties: false, required: ["choice"],
        properties: {
          choice: { type: "string", enum: ["wait", "retry", "replace", "use_available", "extend"] },
          affected_ids: IDS,
          replacement_spec: { type: "object", additionalProperties: false, required: ["worker_ref", "preset_ref", "machine_ref", "brief"],
            properties: { worker_ref: STRING, preset_ref: STRING, machine_ref: STRING, brief: { type: "string", minLength: 1, maxLength: 6000 } } },
          extension_scope: { type: "object", additionalProperties: false,
            properties: { rounds: { type: "integer", minimum: 1, maximum: 100 }, minutes: { type: "integer", minimum: 1, maximum: 1440 } } },
        },
      },
      round: { type: "integer", minimum: 1 },
      participant_id: STRING,
      after_entry: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      reason: { type: "string", maxLength: 1000 },
    },
    required: ["action"],
  },
} as const;

export interface RosterItem { worker_ref?: string; preset_ref?: string; machine_ref?: string; brief?: string }
export interface BriefItem { participant_id: string; text: string; evidence_refs?: { participant_id: string; round?: number }[] }
export type Decision =
  | { choice: "wait" | "retry" | "use_available"; affected_ids: string[] }
  | { choice: "replace"; affected_ids: string[]; replacement_spec: { worker_ref: string; preset_ref: string; machine_ref: string; brief: string } }
  | { choice: "extend"; extension_scope: { rounds: number } | { minutes: number } };

export interface StartRequest {
  action: "start"; request_key: string;
  /** The owner's messages that asked for it. Absent for a proposal. */
  source_message_ids?: string[];
  proposal: boolean;
  question: string; context: { text: string }[]; participants?: RosterItem[]; debate: boolean;
}
export type ContinueKind = "follow_up" | "correction" | "debate_round" | "owner_decision" | "finalize";
export interface ContinueRequest {
  action: "continue"; request_key: string; council_id: string; expected_revision: number; kind: ContinueKind;
  source_message_ids?: string[]; participants?: string[]; message?: string; briefs?: BriefItem[]; decision?: Decision;
}
export interface InspectRequest { action: "inspect"; council_id: string; round?: number; participant_id?: string; after_entry?: number; limit?: number }
export interface StopRequest { action: "stop"; request_key: string; council_id: string; expected_revision: number; source_message_ids: string[]; reason?: string }
export type HubCouncilRequest = StartRequest | ContinueRequest | InspectRequest | StopRequest;

const text = (value: unknown, where: string, max: number): string => {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) refuse(`${where} is text of 1 to ${max} characters`);
  return value as string;
};
const revision = (value: unknown, where: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) refuse(`${where} is the revision inspect showed, a whole number from 1`);
  return value as number;
};
const strings = (value: unknown, where: string, max: number): string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > max || value.some(one => typeof one !== "string" || one === "")) {
    refuse(`${where} is a list of 1 to ${max} ids`);
  }
  return [...new Set(value as string[])];
};

function readRoster(value: unknown): RosterItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 12) refuse("participants is a list of at most 12");
  return (value as unknown[]).map((one, at) => {
    const item = exact(one, ["worker_ref", "preset_ref", "machine_ref", "brief"], `participants[${at}]`);
    for (const key of Object.keys(item)) if (typeof item[key] !== "string") refuse(`participants[${at}].${key} is text`);
    return item as RosterItem;
  });
}

function readBriefs(value: unknown): BriefItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) refuse("briefs is a list of 1 to 12");
  return (value as unknown[]).map((one, at) => {
    const item = exact(one, ["participant_id", "text", "evidence_refs"], `briefs[${at}]`);
    if (typeof item.participant_id !== "string" || item.participant_id === "") refuse(`briefs[${at}] needs participant_id`);
    const out: BriefItem = { participant_id: item.participant_id, text: text(item.text, `briefs[${at}].text`, 6000) };
    if (item.evidence_refs !== undefined) {
      if (!Array.isArray(item.evidence_refs) || item.evidence_refs.length > 12) refuse(`briefs[${at}].evidence_refs is a list of at most 12`);
      out.evidence_refs = (item.evidence_refs as unknown[]).map((ref, n) => {
        const one2 = exact(ref, ["participant_id", "round"], `briefs[${at}].evidence_refs[${n}]`);
        if (typeof one2.participant_id !== "string" || one2.participant_id === "") refuse(`briefs[${at}].evidence_refs[${n}] needs participant_id`);
        if (one2.round !== undefined && (!Number.isSafeInteger(one2.round) || (one2.round as number) < 1)) refuse(`briefs[${at}].evidence_refs[${n}].round is a round number`);
        return { participant_id: one2.participant_id as string, ...(one2.round !== undefined ? { round: one2.round as number } : {}) };
      });
    }
    return out;
  });
}

/** A tagged choice: exactly the fields its tag takes, and no other, so two choices are never sent at once. */
function readDecision(value: unknown): Decision {
  const top = exact(value, ["choice", "affected_ids", "replacement_spec", "extension_scope"], "decision");
  const choice = top.choice;
  if (choice === "wait" || choice === "retry" || choice === "use_available") {
    exact(top, ["choice", "affected_ids"], `decision ${choice}`);
    return { choice, affected_ids: strings(top.affected_ids, "decision.affected_ids", 12) };
  }
  if (choice === "replace") {
    exact(top, ["choice", "affected_ids", "replacement_spec"], "decision replace");
    const spec = exact(top.replacement_spec, ["worker_ref", "preset_ref", "machine_ref", "brief"], "replacement_spec");
    for (const key of ["worker_ref", "preset_ref", "machine_ref"] as const) if (typeof spec[key] !== "string" || spec[key] === "") refuse(`replacement_spec needs ${key}`);
    const affected = strings(top.affected_ids, "decision.affected_ids", 1);
    return { choice, affected_ids: affected, replacement_spec: { worker_ref: spec.worker_ref as string, preset_ref: spec.preset_ref as string,
      machine_ref: spec.machine_ref as string, brief: text(spec.brief, "replacement_spec.brief", 6000) } };
  }
  if (choice === "extend") {
    exact(top, ["choice", "extension_scope"], "decision extend");
    const scope = exact(top.extension_scope, ["rounds", "minutes"], "extension_scope");
    const kinds = Object.keys(scope);
    if (kinds.length !== 1) refuse("extension_scope is either rounds or minutes, and one of them");
    const n = scope[kinds[0]];
    if (!Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > (kinds[0] === "rounds" ? 100 : 1440)) refuse(`extension_scope.${kinds[0]} is a whole number of ${kinds[0]}, above zero`);
    return { choice, extension_scope: kinds[0] === "rounds" ? { rounds: n as number } : { minutes: n as number } };
  }
  return refuse("decision.choice is wait, retry, replace, use_available or extend");
}

interface ActionReader<R extends HubCouncilRequest> { keys: readonly string[]; read(top: Record<string, unknown>): R }

const ACTIONS: { [A in HubCouncilRequest["action"]]: ActionReader<Extract<HubCouncilRequest, { action: A }>> } = {
  start: {
    keys: ["request_key", "authority", "question", "context", "participants", "debate"],
    read(top) {
      const key = readRequestKey(top, "start");
      const authority = exact(top.authority, ["source_message_ids", "proposal"], "authority");
      const owner = authority.source_message_ids !== undefined;
      if (owner === (authority.proposal !== undefined)) refuse("authority is either {source_message_ids}, the owner's own words asking for a council, or {proposal: true}, and one of them");
      if (authority.proposal !== undefined && authority.proposal !== true) refuse("authority.proposal is true");
      const sources = owner ? readSourceIds(authority, "start", "the messages in which the owner asked for a council") : undefined;
      const context = top.context === undefined ? [] : (() => {
        if (!Array.isArray(top.context) || top.context.length > 20) refuse("context is a list of at most 20");
        return (top.context as unknown[]).map((one, at) => ({ text: text(exact(one, ["text"], `context[${at}]`).text, `context[${at}].text`, 8000) }));
      })();
      if (top.debate !== undefined && typeof top.debate !== "boolean") refuse("debate is true or false");
      return { action: "start", request_key: key, ...(sources ? { source_message_ids: sources } : {}), proposal: !owner,
        question: text(top.question, "question", 8000), context, ...(top.participants !== undefined ? { participants: readRoster(top.participants) } : {}),
        debate: top.debate === true };
    },
  },
  continue: {
    keys: ["request_key", "council_id", "expected_revision", "kind", "source_message_ids", "participants", "message", "briefs", "decision"],
    read(top) {
      const key = readRequestKey(top, "continue");
      const kind = top.kind;
      if (kind !== "follow_up" && kind !== "correction" && kind !== "debate_round" && kind !== "owner_decision" && kind !== "finalize") {
        refuse("kind is follow_up, correction, debate_round, owner_decision or finalize");
      }
      const out: ContinueRequest = { action: "continue", request_key: key, council_id: text(top.council_id, "council_id", 200),
        expected_revision: revision(top.expected_revision, "expected_revision"), kind };
      const has = (name: string) => top[name] !== undefined;
      const only = (allowed: readonly string[]) => {
        const extra = ["source_message_ids", "participants", "message", "briefs", "decision"].filter(name => has(name) && !allowed.includes(name));
        if (extra.length > 0) refuse(`${kind} does not take: ${extra.join(", ")}`);
      };
      if (has("source_message_ids")) out.source_message_ids = readSourceIds(top, kind, "the owner's messages that are the evidence");
      if (has("message")) out.message = text(top.message, "message", 8000);
      if (kind === "finalize") { only(["message"]); return out; }
      if (kind === "owner_decision") {
        only(["source_message_ids", "decision", "message"]);
        if (!has("source_message_ids")) refuse("owner_decision needs source_message_ids: the messages in which the owner chose");
        if (!has("decision")) refuse("owner_decision needs a decision");
        out.decision = readDecision(top.decision);
        return out;
      }
      only(["source_message_ids", "participants", "message", "briefs"]);
      if (!has("participants")) refuse(`${kind} needs participants: the participant ids it is for`);
      out.participants = strings(top.participants, "participants", 12);
      if (!has("briefs")) refuse(`${kind} needs briefs: what each of those participants is told`);
      out.briefs = readBriefs(top.briefs);
      if ((kind === "follow_up" || kind === "correction") && !has("source_message_ids")) refuse(`${kind} needs source_message_ids: the owner's own message asking for it`);
      return out;
    },
  },
  inspect: {
    keys: ["council_id", "round", "participant_id", "after_entry", "limit"],
    read(top) {
      const out: InspectRequest = { action: "inspect", council_id: text(top.council_id, "council_id", 200) };
      if (top.round !== undefined) out.round = revision(top.round, "round");
      if (top.participant_id !== undefined) out.participant_id = text(top.participant_id, "participant_id", 200);
      if (top.after_entry !== undefined) {
        if (!Number.isSafeInteger(top.after_entry) || (top.after_entry as number) < 0) refuse("after_entry is an entry number from 0");
        out.after_entry = top.after_entry as number;
      }
      if (top.limit !== undefined) {
        if (!Number.isSafeInteger(top.limit) || (top.limit as number) < 1 || (top.limit as number) > 100) refuse("limit is from 1 to 100");
        out.limit = top.limit as number;
      }
      return out;
    },
  },
  stop: {
    keys: ["request_key", "council_id", "expected_revision", "source_message_ids", "reason"],
    read(top) {
      const key = readRequestKey(top, "stop");
      const out: StopRequest = { action: "stop", request_key: key, council_id: text(top.council_id, "council_id", 200),
        expected_revision: revision(top.expected_revision, "expected_revision"),
        source_message_ids: readSourceIds(top, "stop", "the messages in which the owner asked to stop") };
      if (top.reason !== undefined) out.reason = text(top.reason, "reason", 1000);
      return out;
    },
  },
};

/** Read the arguments of a `hub_council` call, refusing anything the schema does not name. */
export function readCouncilRequest(args: unknown): HubCouncilRequest {
  const every = new Set(Object.values(ACTIONS).flatMap(one => one.keys));
  const top = exact(args, ["action", ...every], "arguments");
  const action = Object.hasOwn(ACTIONS, String(top.action)) ? (top.action as HubCouncilRequest["action"]) : null;
  if (action === null) throw new ToolError("unsupported_action", `hub_council has no action ${JSON.stringify(top.action)}`);
  exact(top, ["action", ...ACTIONS[action].keys], action);
  return ACTIONS[action].read(top);
}
