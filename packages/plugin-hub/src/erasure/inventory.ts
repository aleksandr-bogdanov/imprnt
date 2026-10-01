/**
 * THE INVENTORY OF STATE SHEETS a topic's deletion has to account for, written down once so that a sheet nobody classified is a failing
 * check and never a row that quietly survives a deletion.
 *
 * `state_row` is one table for many sheets, and what a row of a sheet is about is a fact of the code that writes it. The store's
 * `hub_erasure_owns_row` (017) is the closed list that decides which rows a deletion removes, and it is deliberately closed: a sheet it
 * does not name is never guessed at. This file says, for every sheet the source writes, whether it is a topic's (and how its key or its
 * data names the topic's agent) or is about something else (a credential, a machine, a job, the Hub's own findings). The test
 * `topic-deletion-inventory.test.ts` reads the source for every sheet name and fails on one that is in neither list, and asks the store
 * to confirm that every scoped sheet is one it removes.
 *
 * WHAT IS NOT ON EITHER LIST, BECAUSE IT IS NOT A SHEET: `inbound`, `outbox`, `media`, `ledger_event`, the conversation, execution,
 * council, move and topic tables, the platform effects and the confirmations. Those are tables of their own and `hub_erase_scope`
 * removes them by the ids a tombstone names.
 */

/** Sheets whose rows belong to a topic, and how the row says so. Every one of them is removed by a deletion. */
export const SCOPED_SHEETS: Readonly<Record<string, string>> = {
  agent_wait: "id is the agent",
  agent_health: "id is the agent",
  harvest: "id is <person>/<agent>: the watermark of how far the chat was harvested",
  door_cursor: "id is <door>/<chat>: how far the door has read the chat",
  door_health: "id is <door>/<chat>",
  move_command: "id is [<agent>, <message>]: a command receipt of the chat's own movement command",
  move_command_done: "id is [<agent>, <message>]",
  turn_progress: "id is an input of the topic",
  door_progress: "id is an input of the topic, or its data names the agent",
  control: "data.agent is the agent: an ask the owner made in the chat",
  sender_denied: "data.agent is the agent: who was refused in the chat (identifiers, no text)",
};

/** Sheets that are about something else. Nothing in them is a topic's, and a deletion leaves them alone. */
export const UNSCOPED_SHEETS: Readonly<Record<string, string>> = {
  outage: "per credential",
  window: "per credential",
  sync: "per sync entry and repository",
  registry: "per machine: the digest of its registry copy",
  registry_copy: "per machine: where its registry copy stands",
  check: "the Hub's own findings: identifiers and fixed sentences, recomputed and removed by the check itself",
  job_success: "per scheduled job entry",
  backup: "per backup entry",
  memory_peak: "per unit",
  store_measure: "per measurement of the store",
  voice_health: "per recognizer",
  cutover: "per migration batch",
  council: "the old council sheet: migration 14 moved its rows and nothing writes it any more",
};

/** A sample row of each scoped sheet, for an agent and a person: what `hub_erasure_owns_row` has to say yes to. */
export function sampleRow(sheet: string, who: { agent: string; person: string; door: string; chat: string; input: string }): { id: string; data: Record<string, unknown> } {
  switch (sheet) {
    case "agent_wait": case "agent_health": return { id: who.agent, data: {} };
    case "harvest": return { id: `${who.person}/${who.agent}`, data: {} };
    case "door_cursor": case "door_health": return { id: `${who.door}/${who.chat}`, data: {} };
    case "move_command": case "move_command_done": return { id: JSON.stringify([who.agent, "m-1"]), data: {} };
    case "turn_progress": return { id: who.input, data: {} };
    case "door_progress": return { id: who.input, data: { agent: who.agent } };
    case "control": case "sender_denied": return { id: `${sheet}-1`, data: { agent: who.agent } };
    default: throw new RangeError(`${sheet} is not a scoped sheet`);
  }
}
