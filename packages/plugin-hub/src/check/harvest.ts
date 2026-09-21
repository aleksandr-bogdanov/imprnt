import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { chatLogPath } from "../chatlog.ts";
import { HARVEST_SHEET, watermarkId, watermarkOf } from "../harvest/sheet.ts";
import { readSlice } from "../harvest/slice.ts";
import { deriveSlice } from "../chatlog/derive.ts";
import { readSheet } from "../records/statesheet.ts";
import { chatStateFor, historyHarvestFrom, type HarvestSettings } from "../registry/entries.ts";
import type { AgentEntry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * Criterion 1: "every watermark is younger than its last quiet period
 * plus the daily backstop, or a finding."
 *
 * One impure reader and one pure function, the shape `readStampRows` plus
 * `stampFindings` already has, so the arithmetic is readable without a store
 * and without a clock of its own.
 */
export interface ChatHarvestState {
  person: string;
  agent: string;
  /** The door that serves this chat, because the door is what writes a row. */
  door: string;
  /** The watermark's `at`, or null when nothing has been harvested. */
  watermark: string | null;
  /** The oldest line a harvest would take, or null when there is none. */
  oldest_unharvested: string | null;
  /** How many lines a harvest would take right now. */
  lines_unharvested: number;
  /** Whether this chat has a log at all. A chat nobody has used is not one. */
  log_exists: boolean;
}

/**
 * Every chat of this machine's agents, as the finding below measures it.
 *
 * ONE read of the `harvest` sheet and one bounded walk per agent over the chat
 * log, and the walk is `readSlice`'s own, so what is counted is exactly what a
 * harvest would take: the person's lines and the agent's, with the door's
 * machinery lines and the demand phrase dropped. A finding that counted a clock
 * line would report a chat as unharvested for ever, because a harvest would
 * never take that line and the watermark would never pass it.
 *
 * THE SLICE STARTS WHERE EVERY HARVEST STARTS: the later of the
 * watermark and the person's `history_harvest_after`. Imported history before
 * that bound is excluded from every harvest on purpose, so counting it would
 * keep this finding red for as long as a first slice reaches back, about a
 * chat that is working exactly as the cutover intends.
 */
export async function readHarvestState(
  store: StoreLike,
  args: { stateDir: string; agents: AgentEntry[]; now: Date; registry: unknown },
): Promise<ChatHarvestState[]> {
  const sheet = new Map(
    (await readSheet(store, HARVEST_SHEET)).map((row) => [row.id, watermarkOf(row.data)]),
  );
  const out: ChatHarvestState[] = [];
  for (const agent of args.agents) {
    const watermark = sheet.get(watermarkId(agent.person, agent.id))?.at ?? null;
    const where = { stateDir: args.stateDir, person: agent.person, agent: agent.id };
    const slice = {
      from: historyHarvestFrom(args.registry, agent.person, watermark),
      until: args.now.toISOString(),
    };
    // A chat whose door is on another machine has no directory here and never
    // will, so what says it exists is whether the store holds a line of it at
    // all. A chat nobody has used is not a chat, the same fact an absent
    // directory carries locally.
    const derived = chatStateFor(args.registry, agent.id) === "store";
    let exists = derived
      ? false
      : existsSync(dirname(chatLogPath({ ...where, at: args.now })));
    let lines: { at: string }[] = [];
    if (derived || exists) {
      try {
        lines = derived
          ? await deriveSlice(store, {
              registry: args.registry,
              person: agent.person,
              agent: agent.id,
              ...slice,
            })
          : await readSlice({ ...where, ...slice });
        if (derived) exists = lines.length > 0;
      } catch {
        // A log this walk cannot read is a log `check` cannot measure, and a
        // finding invented from a half-written line would be worse than none.
        lines = [];
      }
    }
    out.push({
      person: agent.person,
      agent: agent.id,
      door: agent.door,
      watermark,
      oldest_unharvested: lines[0]?.at ?? null,
      lines_unharvested: lines.length,
      log_exists: exists,
    });
  }
  return out;
}

/** The allowance: this person's own quiet period, plus the daily backstop. */
function allowanceSeconds(settings: HarvestSettings): number {
  return settings.quiet_minutes * 60 + 86_400;
}

/**
 * The two findings, PURE.
 *
 * `harvest-stale` measures the OLDEST unharvested line and not the newest, and
 * that is the whole of why the finding is worth having. Under a newest-line
 * rule a BUSY chat never fires at all, however long its watermark has been
 * stuck, because its newest line is minutes old every day for ever, and a busy
 * chat whose backstop is broken is exactly the failure criterion 1 names: the
 * backstop is the thing that exists for chats that never go quiet.
 *
 * A CHAT WITH NO LOG IS NEVER A FINDING, because a silent day is never a
 * finding (SPEC §2) and a chat nobody has used is the same fact. A person who
 * names no harvester gets `harvest-undeclared` and NEVER `harvest-stale`: two
 * findings saying one thing is noise, and a household can act on only one.
 */
export function harvestFindings(args: {
  chats: ChatHarvestState[];
  /** This person's harvest, or null when they name no harvester. */
  settings: (person: string) => HarvestSettings | null;
  /** The people with an agent on this machine, each once. */
  people: string[];
  machine: string;
  registryFile: string;
  now: Date;
}): Finding[] {
  const findings: Finding[] = [];
  for (const chat of args.chats) {
    const settings = args.settings(chat.person);
    if (settings === null) continue;
    if (!chat.log_exists || chat.oldest_unharvested === null) continue;
    const age = (args.now.getTime() - Date.parse(chat.oldest_unharvested)) / 1000;
    if (age <= allowanceSeconds(settings)) continue;
    const subject = `${chat.person}/${chat.agent}`;
    findings.push({
      id: findingId(args.machine, "harvest-stale", subject),
      kind: "harvest-stale",
      subject,
      machine: args.machine,
      says:
        `${chat.person}'s chat with ${chat.agent} has ${chat.lines_unharvested} line(s) ` +
        `waiting to be harvested, the oldest since ${chat.oldest_unharvested}, which is ` +
        `past this person's own ${settings.quiet_minutes} minute quiet period plus the ` +
        `daily backstop, and the watermark stands at ` +
        `${chat.watermark ?? "nothing harvested yet"}`,
      // The DOOR's unit, because the door is the only thing that writes a
      // harvest row and a household looking for why none was written starts
      // there. `check` never runs it (L13).
      fix:
        `read the journal of imprnt-hub-${chat.door}, which is the unit that writes ` +
        `the harvest row, then the harvest rows in inbound for ${chat.agent}`,
    });
  }

  for (const person of args.people) {
    if (args.settings(person) !== null) continue;
    findings.push({
      id: findingId(args.machine, "harvest-undeclared", person),
      kind: "harvest-undeclared",
      subject: person,
      machine: args.machine,
      says:
        `${person} names no harvester, so nothing turns their chats into vault ` +
        `notes: what the file does not name cannot run`,
      fix:
        `add harvester = "<a preset name>" and vault = "<the directory holding ` +
        `vault/ and raw/>" to the [[people]] entry for ${person} in ${args.registryFile}`,
    });
  }
  return findings;
}
