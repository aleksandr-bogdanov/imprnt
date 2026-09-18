import { SENDER_DENIED_SHEET, type DeniedSender } from "../door/denied.ts";
import { finding as findingLine } from "../door/lines.ts";
import { readSheet } from "../records/statesheet.ts";
import { listAgents, personOf, senderAllowed } from "../registry/entries.ts";
import type { AgentEntry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * D-173, D-183. The two ways an agent goes silent at the door, which no inbound
 * row can show because a refused message never becomes one.
 *
 * One impure reader and pure functions, the shape `readHarvestState` and
 * `harvestFindings` already have.
 */

/**
 * How long a refusal stays reported after the last refused message.
 *
 * A finding that could only ever be raised is a report, not a rule, and the
 * fix for a stranger who is not meant to be answered is to leave them off the
 * list, which changes nothing a reader could see. So a refused sender is
 * reported while they keep writing and for a week after, which is long enough
 * for a household that runs `check` weekly to see it once.
 */
export const DENIED_REPORT_DAYS = 7;

/** Every refused sender the doors have recorded. */
export async function readDeniedSenders(store: StoreLike): Promise<DeniedSender[]> {
  return (await readSheet(store, SENDER_DENIED_SHEET)).map((row) => row.data as unknown as DeniedSender);
}

/**
 * A sender refused on one of THIS machine's doors, who is still off the list
 * and wrote inside the window. Pure.
 *
 * Measured against the file as it is NOW, so listing the sender is the fix and
 * the finding clears on the next run with nothing written anywhere. A refusal
 * for an agent the file no longer carries has nobody to fix it for.
 */
export function deniedSenderFindings(args: {
  denied: DeniedSender[];
  registry: unknown;
  /** The door entries this machine runs. */
  doors: Set<string>;
  machine: string;
  registryFile: string;
  now: Date;
}): Finding[] {
  const out: Finding[] = [];
  const agents = listAgents(args.registry);
  for (const row of args.denied) {
    if (!args.doors.has(row.door)) continue;
    const agent = agents.find((one) => one.id === row.agent);
    if (!agent) continue;
    if (senderAllowed(args.registry, agent.person, row.door, row.sender_id)) continue;
    if (args.now.getTime() - Date.parse(row.last_at) > DENIED_REPORT_DAYS * 86_400_000) continue;
    const target = `${row.door}/${row.chat}/${row.sender_id}`;
    out.push({
      id: findingId(args.machine, "sender-denied", target),
      kind: "sender-denied",
      subject: target,
      machine: args.machine,
      says: findingLine("en", { code: "sender-denied", target, cause: "access denied" }),
      fix:
        `if ${agent.id} should answer ${row.sender_id}, add "${row.sender_id}" to ` +
        `allowed_senders = { ${row.door} = [...] } on the [[people]] entry for ${agent.person} ` +
        `in ${args.registryFile}. A sender left off the list stops being reported ` +
        `${DENIED_REPORT_DAYS} days after their last refused message`,
    });
  }
  return out;
}

/**
 * An agent whose person lists no sender for its door answers nobody, because
 * a missing or empty allowlist refuses everyone (D-171). Pure.
 */
export function allowlistFindings(args: {
  agents: AgentEntry[];
  registry: unknown;
  machine: string;
  registryFile: string;
}): Finding[] {
  const out: Finding[] = [];
  for (const agent of args.agents) {
    const senders = personOf(args.registry, agent.id)?.allowed_senders;
    const listed = senders && Object.hasOwn(senders, agent.door) ? senders[agent.door] : [];
    if (listed.length > 0) continue;
    out.push({
      id: findingId(args.machine, "allowlist-empty", agent.id),
      kind: "allowlist-empty",
      subject: agent.id,
      machine: args.machine,
      says: findingLine("en", { code: "allowlist-empty", target: agent.id, cause: "access denied" }),
      fix:
        `list who ${agent.id} may answer as allowed_senders = { ${agent.door} = ["<stable sender id>"] } ` +
        `on the [[people]] entry for ${agent.person} in ${args.registryFile}. Until then every ` +
        `message on ${agent.door} is refused and nobody is answered`,
    });
  }
  return out;
}
