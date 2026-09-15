import type { Preset } from "../registry/presets.ts";

/**
 * The seam. A loop does exactly five things and the rest of the hub knows
 * nothing else about it: feed a message, report the receipt, stream text,
 * report the end of turn with usage, resume or start a session.
 *
 * No loop code lives in this file and nothing in it names a loop.
 */
export interface AdapterProgress {
  kind: "text" | "action";
  text: string;
}

/** What the loop said it used. A count it did not report is null, never zero. */
export interface AdapterUsage {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  plan_usage: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}

export interface TurnEnd {
  text: string;
  session_id: string | null;
  usage: AdapterUsage;
}

export interface AdapterSession {
  readonly sessionId: string | null;
  /**
   * The verbs this loop does not have. An adapter that lacks "stream" emits one
   * progress event carrying the whole text just before the end of turn, so the
   * runner behaves the same for every loop and branches on none of them.
   */
  readonly lacks: readonly string[];
  feed(message: { id: string; text: string }): Promise<void>;
  onReceipt(handler: (messageId: string) => void): void;
  onProgress(handler: (event: AdapterProgress) => void): void;
  onTurnEnd(handler: (end: TurnEnd) => void): void;
  /** Not a sixth verb: the handle's stop, the same as a door's or a runner's. */
  close(): Promise<void>;
}

export interface Adapter {
  readonly name: string;
  start(options: {
    preset: Preset;
    sessionId: string | null;
    cwd?: string;
  }): Promise<AdapterSession>;
}

/** A preset naming a loop nobody registered. Loud, never a silent wait. */
export class AdapterMissing extends Error {
  readonly adapter: string;

  constructor(adapter: string, known: string[]) {
    super(
      `${adapter} is not a loop this hub has. The adapters are ${known.join(", ") || "none"}. ` +
        `A preset names one of them.`,
    );
    this.name = "AdapterMissing";
    this.adapter = adapter;
  }
}
