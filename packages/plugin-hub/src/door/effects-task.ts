import type { Store } from "../store/connect.ts";
import { pollConfirmations, readPending, type ApprovalHooks, type ConfirmContext, type PollSchedule } from "./confirm.ts";
import { readEffectWork, runEffectWork, type EffectsGate } from "./effects.ts";
import { finding, safeValue } from "./lines.ts";
import type { Platform } from "./platform.ts";

/**
 * The door's ONE task for platform messages and frozen previews: a task of the door,
 * not of an agent, so it costs one loop however many agents the door serves and no
 * connection of its own. It is woken by the notification the store already sends
 * the door for rows it did not write, and it arms a timer only for a moment something
 * is actually waiting for: a rate limit, a look for a message that may have landed,
 * a preview waiting for a reaction, and the work a look that just found a message has
 * let go (newer content, the later parts of a preview), once. With nothing to do it
 * issues no statement at all, which the checks that count a door's statements depend on.
 *
 * Its connect reads take turns through the door's connect gate with every agent's,
 * for the reason written at that gate, and the door is ready once they are read. What
 * they found is done after that, so a door with a slow platform is not slow to start.
 */
export interface EffectsTask {
  /** Something may be waiting: a row committed, or the listener came back. */
  wake(): void;
  /** Resolves once the connect reads are made. It never rejects. */
  ready: Promise<void>;
  stop(): Promise<void>;
}

export function startEffects(options: {
  store: Store;
  platform: Platform;
  door: string;
  hooks: ApprovalHooks;
  registry: () => unknown;
  /** The two delivery settings, read every pass so a changed knob lands without a restart. */
  settings: () => { retrySeconds: number; maxAttempts: number };
  /** The door's tick, which is how often a pending preview is read again. */
  tickMs: number;
  /** Takes the door's connect turn. */
  gate: <T>(read: () => Promise<T>) => Promise<T>;
}): EffectsTask {
  let stopping = false;
  let poke: (() => void) | null = null;
  let poked = false;
  const wake = (): void => {
    const waiting = poke;
    poke = null;
    if (waiting) waiting();
    else poked = true;
  };
  /** Until something wakes it or `ms` passes; forever when there is no `ms`. */
  const rest = (ms: number | null): Promise<void> => new Promise<void>((resolve) => {
    if (poked) { poked = false; resolve(); return; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    poke = () => { if (timer !== null) clearTimeout(timer); resolve(); };
    if (ms !== null) timer = setTimeout(() => { poke = null; resolve(); }, Math.max(1, ms));
  });

  const gate: EffectsGate = { notBefore: 0 };
  // When each pending preview is next due. A wake for anything else (another effect,
  // the listener coming back) runs a pass, and a pass leaves a preview alone until then:
  // its reads are paced by the tick and by the rate limits the platform seam knows of,
  // not by how often something else wakes the task.
  const schedule: PollSchedule = new Map();
  const context = (): ConfirmContext => ({
    store: options.store, platform: options.platform, door: options.door,
    ...options.settings(), stop: () => stopping,
    registry: options.registry, hooks: options.hooks, pollMs: options.tickMs,
  });

  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });

  const soonest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));
  let failing = false;
  // What refused is said once per run of failures, on stderr, because the store that
  // refused the read may refuse a diary row too.
  const report = (error: unknown): void => {
    if (!failing) {
      process.stderr.write(finding("en", { code: "effects:pass-failed", target: options.door,
        cause: safeValue((error as Error)?.message ?? error) }) + "\n");
    }
    failing = true;
  };
  const pass = async (first: boolean): Promise<number | null> => {
    const ctx = context();
    const work = await readEffectWork(ctx, { startup: first });
    const at = await runEffectWork(ctx, gate, work);
    return soonest(at, await pollConfirmations(ctx, gate, await readPending(ctx), schedule));
  };

  const done = (async () => {
    let next: number | null = null;
    // The connect reads, in the door's turn. Nothing is sent from inside the turn.
    let start: { ctx: ConfirmContext; work: Awaited<ReturnType<typeof readEffectWork>>; pending: Awaited<ReturnType<typeof readPending>> } | null = null;
    try {
      start = await options.gate(async () => {
        const ctx = context();
        return { ctx, work: await readEffectWork(ctx, { startup: true }), pending: await readPending(ctx) };
      });
    } catch {
      // A store that would not answer at connect is one the other tasks are failing
      // on too. The first pass below asks again at the tick.
      next = Date.now() + options.tickMs;
    } finally {
      release();
    }
    try {
      if (start) {
        const at = await runEffectWork(start.ctx, gate, start.work);
        next = soonest(at, await pollConfirmations(start.ctx, gate, start.pending, schedule));
      }
    } catch (error) {
      next = Date.now() + options.tickMs;
      report(error);
    }
    // A start whose connect reads failed has not yet looked again at what was unknown.
    let looking = start === null;
    while (!stopping) {
      await rest(next === null ? null : next - Date.now());
      if (stopping) break;
      try {
        next = await pass(looking);
        looking = false;
        failing = false;
      } catch (error) {
        next = Date.now() + options.tickMs;
        report(error);
      }
    }
  })();

  return {
    wake,
    ready,
    async stop() {
      stopping = true;
      wake();
      await done;
    },
  };
}
