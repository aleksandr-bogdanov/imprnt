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
   * The process id of the child this loop is, when the hub has one to watch.
   *
   * D-82. A handle property like `close`, never a sixth verb: RUN-12 needs the
   * pid of every child the runner spawned, and D11's five verbs are what the
   * loop DOES, not what the handle IS. Null means this loop has no local child
   * for this hub to watch (a hosted loop), and the memory watch skips it.
   */
  readonly pid: number | null;
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
    /**
     * 03b item 1. The runner's boxing hook, applied to whatever argv this loop
     * would otherwise spawn. The adapter spawns `wrap(argv)` when it is given
     * one and `argv` when it is not.
     *
     * The adapter stays loop-specific and BOX-AGNOSTIC: it imports nothing from
     * `src/box/`, names no tool, and knows nothing about what the wrapping does.
     * That is what keeps "which box" a question the runner answers from the
     * registry and not one every new loop has to answer again.
     */
    wrap?: (argv: string[]) => string[];
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
