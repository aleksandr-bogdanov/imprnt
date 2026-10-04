// A PURE OBSERVER of the production adapters, for the live engine proofs (`live/prove-engine-runner.ts`). Importing it has no side effects.
//
// `observeAdapters` hands back the same adapters with `start` delegated unchanged: the production `prepareLaunch`, `capabilities`, `session`
// port and `activationBlock` are the very same values, the options reach the production `start` as they were given, and the session it
// returns is RETURNED ITSELF (its getters, `reportedSessionId` and `pid` among them, are the adapter's own). The only addition is listeners
// on that session, which every adapter keeps as a list, so nothing the runner sees changes.
//
// WHAT IS WRITTEN IS NORMALIZED METADATA ONLY: the session plan the runner chose, counts of progress kinds per message, the engine's
// reported session id, refusal causes, token counts, process ids and exit evidence. Never a message text, a tool's output, an argv or env
// value, a usage `raw` (it carries the answer), or a credential. A string that could carry a host path (an error message, a refusal) is cut
// to a bound and every redaction the caller names is applied first.

import { basename } from "node:path";
import type { Adapter, AdapterSession, ExitEvidence } from "../src/adapters/types.ts";

/** One line of the observation journal. `start` numbers are per process, from 1. */
export type Observed =
  | { kind: "start"; start: number; at: string; adapter: string; plan: { id: string; resume: boolean } | null; command: string | null; boxed: boolean }
  | { kind: "start_failed"; start: number; at: string; adapter: string; error: string }
  | { kind: "started"; start: number; at: string; pid: number | null; group: number | null; processes: number[] }
  | { kind: "receipt"; start: number; at: string; message: string; reported: string | null }
  | {
    kind: "turn_end"; start: number; at: string; message: string | null; reported: string | null; session_id: string | null;
    refused: { cause: string; said: string } | null; text_chars: number; actions: number; action_results: number; text_events: number;
    input_tokens: number | null; output_tokens: number | null; models: string[]; processes: number[];
  }
  | { kind: "exit"; start: number; at: string; evidence: NormalizedExit | null; error?: string }
  /** The runner process's own life, written by `prove-engine-runner-child.ts`. */
  | { kind: "runner"; at: string; event: "ready" | "stopping" | "stopped" | "stop_failed" | "start_failed"; pid: number; error?: string };

/** Exit evidence with the fields a reader judges and nothing else. */
export interface NormalizedExit {
  confirmed: boolean;
  leader: string;
  descendants: string;
  basis: string | null;
  group: number | null;
  pids: number[];
  survivors: number[];
  unknown: number[];
  partial: boolean;
  via: string;
}

const BOUND = 240;

/** A string made safe to journal: every named secret-ish substring replaced, then cut. */
export function scrub(value: unknown, redactions: readonly string[]): string {
  let text = value instanceof Error ? value.message : String(value ?? "");
  for (const one of redactions) if (one !== "") text = text.split(one).join("<redacted>");
  return text.length > BOUND ? `${text.slice(0, BOUND)}...` : text;
}

export function normalizeExit(evidence: ExitEvidence | null | undefined): NormalizedExit | null {
  if (!evidence) return null;
  return {
    confirmed: evidence.confirmed === true, leader: String(evidence.leader), descendants: String(evidence.descendants),
    basis: evidence.basis ?? null, group: typeof evidence.group === "number" ? evidence.group : null,
    pids: [...(evidence.pids ?? [])], survivors: [...(evidence.survivors ?? [])], unknown: [...(evidence.unknown ?? [])],
    partial: evidence.partial === true, via: String(evidence.via ?? ""),
  };
}

export interface ObserverHandle {
  adapters: Record<string, Adapter>;
  /** Every session started in this process, with its start number, for the exit evidence asked after the runner stopped. */
  sessions(): { start: number; session: AdapterSession }[];
  /** Ask each session's own `exitEvidence` and journal it. Bounded per session; never signals anything. */
  recordExits(boundMs: number): Promise<void>;
}

const now = () => new Date().toISOString();
const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const pidsOf = (session: AdapterSession): number[] => {
  try { return [...(session.processes?.() ?? [])]; } catch { return []; }
};

export function observeAdapters(adapters: Record<string, Adapter>, sink: (line: Observed) => void, redactions: readonly string[] = []): ObserverHandle {
  let starts = 0;
  const started: { start: number; session: AdapterSession }[] = [];
  const wrap = (adapter: Adapter): Adapter => ({
    ...adapter,
    async start(options) {
      const start = ++starts;
      sink({ kind: "start", start, at: now(), adapter: adapter.name, plan: options.session ? { id: options.session.id, resume: options.session.resume } : null,
        command: options.argv?.[0] ? basename(options.argv[0]) : null, boxed: typeof options.wrap === "function" });
      let session: AdapterSession;
      try { session = await adapter.start(options); } catch (error) {
        sink({ kind: "start_failed", start, at: now(), adapter: adapter.name, error: scrub(error, redactions) });
        throw error;
      }
      started.push({ start, session });
      let group: number | null = null;
      try { group = session.group?.() ?? null; } catch { group = null; }
      sink({ kind: "started", start, at: now(), pid: session.pid, group, processes: pidsOf(session) });
      // Counted per message: a progress event belongs to the message whose receipt came last, and one before any receipt to none.
      let current: string | null = null;
      let counts = { actions: 0, action_results: 0, text_events: 0 };
      session.onReceipt(message => {
        current = message;
        counts = { actions: 0, action_results: 0, text_events: 0 };
        sink({ kind: "receipt", start, at: now(), message, reported: session.reportedSessionId ?? null });
      });
      session.onProgress(event => {
        if (event.kind === "action") counts.actions += 1;
        else if (event.kind === "action_result") counts.action_results += 1;
        else counts.text_events += 1;
      });
      session.onTurnEnd(end => {
        sink({
          kind: "turn_end", start, at: now(), message: current, reported: session.reportedSessionId ?? null, session_id: end.session_id ?? null,
          refused: end.refused ? { cause: end.refused.cause, said: scrub(end.refused.said, redactions) } : null,
          text_chars: typeof end.text === "string" ? end.text.length : 0, ...counts,
          input_tokens: numberOrNull(end.usage?.input_tokens), output_tokens: numberOrNull(end.usage?.output_tokens),
          models: [...(end.usage?.resolved_model_ids ?? [])], processes: pidsOf(session),
        });
        current = null;
        counts = { actions: 0, action_results: 0, text_events: 0 };
      });
      return session;
    },
  });
  const wrapped: Record<string, Adapter> = {};
  for (const [name, adapter] of Object.entries(adapters)) wrapped[name] = wrap(adapter);
  return {
    adapters: wrapped,
    sessions: () => [...started],
    async recordExits(boundMs) {
      for (const { start, session } of started) {
        if (!session.exitEvidence) { sink({ kind: "exit", start, at: now(), evidence: null, error: "the session gives no exit evidence" }); continue; }
        try {
          const evidence = await Promise.race([session.exitEvidence(), Bun.sleep(boundMs).then(() => "timeout" as const)]);
          if (evidence === "timeout") sink({ kind: "exit", start, at: now(), evidence: null, error: `exit evidence did not answer within ${boundMs} ms` });
          else sink({ kind: "exit", start, at: now(), evidence: normalizeExit(evidence) });
        } catch (error) {
          sink({ kind: "exit", start, at: now(), evidence: null, error: scrub(error, redactions) });
        }
      }
    },
  };
}
