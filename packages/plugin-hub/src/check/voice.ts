import { readVoiceHealth, type VoiceHealthRow } from "../voice/health.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * What `check` knows about transcribing, read once and reasoned about after.
 *
 * The shape is the stamp reader's: ONE impure reader and two pure functions, so
 * the arithmetic below is readable without a store and every age is the `now`
 * the caller handed in.
 *
 * NOTHING HERE OPENS THE RECOGNIZER'S PORT, and that is a rule and not an
 * omission. The reference server does not answer its health path while a decode
 * is running, and under socket activation reading it starts the service being
 * probed, so a read could delay a person's note or bring a gigabyte of model
 * into memory on a busy box. What is read instead is what the door wrote down.
 */
export interface VoiceCheckState {
  /** One entry per recognizer NAME this store has heard from. */
  health: { recognizer: string; row: VoiceHealthRow }[];
  /** Every row of this machine's agents still waiting for its own words. */
  transcribing: {
    id: string;
    person: string;
    agent: string;
    received_at: string;
  }[];
}

export async function readVoiceState(
  store: StoreLike,
  where: { agents: string[] },
): Promise<VoiceCheckState> {
  const health = [...(await readVoiceHealth(store))].map(([recognizer, row]) => ({
    recognizer,
    row,
  }));
  const mine = new Set(where.agents);
  // Only the rows the step still owes an answer for. A `failed` row has had its
  // sentence said to the person already and a `done` row has its words.
  const rows = (await store.sql`
    select id, person, agent, received_at
      from inbound
     where media_state = 'pending'
     order by received_at, id`) as unknown as {
    id: string;
    person: string;
    agent: string;
    received_at: Date | string;
  }[];
  return {
    health,
    transcribing: rows
      .filter((row) => mine.has(row.agent))
      .map((row) => ({
        id: row.id,
        person: row.person,
        agent: row.agent,
        received_at: new Date(row.received_at).toISOString(),
      })),
  };
}

/**
 * The recognizer has been failing, one finding per recognizer NAME.
 *
 * Per name and never per person, because the recognizer is one per household
 * and what has failed is the recognizer: two people waiting on one dead port is
 * one thing wrong, and saying it twice would make a household of five read five
 * lines about one process.
 *
 * The FIX is the only part that differs by provider, and it is the part that
 * matters: a household handed the wrong lever fixes nothing. One that runs the
 * recognizer here is pointed at its unit's journal, one that dials a provider
 * is pointed at the key file it reads at the moment of use.
 *
 * It clears when the episode's `since` is null, so a failure that fixed itself
 * stops being reported without anybody sweeping it.
 */
export function voiceFindings(args: {
  state: VoiceCheckState;
  /** The household's recognizer, or null when it names none. */
  recognizer: { name: string; provider: string } | null;
  /** This machine's transcriber entry id, for a recognizer that runs here. */
  transcriberEntry: string | null;
  /** The file a dialled recognizer reads its key from. */
  credentialFile: string | null;
  machine: string;
  now: Date;
}): Finding[] {
  if (args.recognizer === null) return [];
  const out: Finding[] = [];
  for (const { recognizer, row } of args.state.health) {
    if (row.since === null) continue;
    const seconds = Math.round((args.now.getTime() - Date.parse(row.since)) / 1000);
    const local = args.recognizer.provider === "sherpa-onnx";
    out.push({
      id: findingId(args.machine, "transcriber-failed", recognizer),
      kind: "transcriber-failed",
      subject: recognizer,
      machine: args.machine,
      says:
        `the recognizer ${recognizer} has not worked for ${seconds} s after ${row.attempts} ` +
        `attempts: ${row.class ?? "unknown"}, ${row.cause ?? "no cause recorded"}, and every ` +
        `voice note is waiting for it`,
      fix:
        local && args.transcriberEntry !== null
          ? `read the journal of imprnt-hub-${args.transcriberEntry}, which is the unit that runs ${recognizer}`
          : args.credentialFile !== null
            ? `open ${args.credentialFile}, which is the key ${recognizer} is dialled with, and check it is the current one`
            : `read the registry's [recognizers.${recognizer}] table, because nothing here names what ${recognizer} runs on`,
    });
  }
  return out;
}

/**
 * A row that has been waiting for its words longer than the person waits.
 *
 * The threshold is that person's OWN `transcribed_seconds` plus the household's
 * job grace, the way every other stamp finding is that person's own, and the
 * finding clears the moment the words land because a row with its text is no
 * longer pending.
 *
 * The FIX names the DOOR, because the door owns the transcription step. The
 * runner never sees such a row: it is not claimable until its words exist.
 */
export function transcribingFindings(args: {
  state: VoiceCheckState;
  /** How long this person waits for a voice note's own text, seconds. */
  patience: (person: string) => number;
  graceSeconds: number;
  /** The door entry that owns this agent's messages. */
  doorOf: (agent: string) => string;
  /** The household's recognizer name, for the sentence. */
  recognizer: string | null;
  machine: string;
  now: Date;
}): Finding[] {
  if (args.recognizer === null) return [];
  const out: Finding[] = [];
  for (const row of args.state.transcribing) {
    const allowed = args.patience(row.person) + args.graceSeconds;
    const seconds = Math.round((args.now.getTime() - Date.parse(row.received_at)) / 1000);
    if (seconds < allowed) continue;
    out.push({
      id: findingId(args.machine, "transcribing-stale", row.id),
      kind: "transcribing-stale",
      subject: row.id,
      machine: args.machine,
      says:
        `${row.person} sent ${row.agent} a voice note ${seconds} s ago and ${args.recognizer} ` +
        `has still not said what is in it, and ${row.person} waits ${allowed} s for that`,
      fix:
        `read the journal of imprnt-hub-${args.doorOf(row.agent)}, which is the unit that ` +
        `owns the transcription step for this row`,
    });
  }
  return out;
}
