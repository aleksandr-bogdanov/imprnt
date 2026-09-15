import { adapterFor } from "../adapters/index.ts";
import type { Adapter, AdapterSession, TurnEnd } from "../adapters/types.ts";
import { readTail } from "../chatlog.ts";
import { appendEntry } from "../records/diary.ts";
import { stamp } from "../records/stamps.ts";
import { agentsFor } from "../registry/entries.ts";
import { loadRegistry, readSetting, type AgentEntry, type Registry } from "../registry/load.ts";
import { getPreset, presetId, priceFor, type Preset } from "../registry/presets.ts";
import { openStore, storeUrlAs, type Store } from "../store/connect.ts";
import { waitForWork } from "../store/wake.ts";
import { claimNext } from "./claim.ts";
import { settleTurn, type TurnRecord } from "./settle.ts";

export interface RunnerHandle {
  runner: string;
  stop(): Promise<void>;
}

/** The turn that is open right now. One message per turn, never two. */
interface OpenTurn {
  id: string;
  tail: boolean;
  acked: boolean;
  started: boolean;
  finish(end: TurnEnd): void;
}

function setting(registry: Registry, key: string): number {
  return Number(readSetting(registry, key));
}

/**
 * The runner: it claims a message, feeds it to a loop through the five-verb
 * seam, stamps what the loop reports, and settles the reply in one transaction.
 *
 * It is handed its adapters rather than importing them, so it can drive a loop
 * registered under a name no build could have enumerated, and it branches on
 * nothing but that map.
 */
export async function runRunner(options: {
  runner: string;
  registryFile: string;
  adapters: Record<string, Adapter>;
}): Promise<RunnerHandle> {
  const first = loadRegistry(options.registryFile);
  const stateDir = String(readSetting(first, "hub.state_dir"));
  // Connecting is the read that surfaces the rows that waited while this runner
  // was down. The notifications they emitted are long gone, so nothing asks.
  const store: Store = await openStore({
    url: storeUrlAs(String(readSetting(first, "hub.store_url")), "hub_runner"),
  });

  let stopping = false;
  let release: () => void = () => {};
  const stopped = new Promise<"stopped">((resolve) => {
    release = () => resolve("stopped");
  });

  const runAgent = async (agent: AgentEntry): Promise<void> => {
    let session: AdapterSession | null = null;
    let running = "";
    let turn: OpenTurn | null = null;

    // The stamps of a turn land in the order the loop reported them. The verbs
    // fire back to back and the writes are asynchronous, so without this chain
    // `started` can reach the diary before `acked` did.
    let writes = Promise.resolve();
    let writeFailed: Error | null = null;
    const write = (what: () => Promise<void>) => {
      writes = writes.then(what).catch((error: Error) => {
        writeFailed ??= error;
      });
    };

    const oneTurn = async (
      message: { id: string; text: string },
      about: { preset: Preset; tail: boolean; registry: Registry },
    ): Promise<void> => {
      let finish: (end: TurnEnd) => void = () => {};
      const ended = new Promise<TurnEnd>((resolve) => {
        finish = resolve;
      });
      turn = { id: message.id, tail: about.tail, acked: false, started: false, finish };
      await session!.feed(message);
      const end = await Promise.race([ended, stopped]);
      turn = null;
      if (end === "stopped") return;

      await writes;
      if (writeFailed) throw writeFailed;

      const record: TurnRecord = {
        agent: agent.id,
        runner: options.runner,
        preset: agent.preset,
        preset_id: presetId(about.preset),
        preset_settings: { ...about.preset },
        input_tokens: end.usage.input_tokens,
        cached_input_tokens: end.usage.cached_input_tokens,
        output_tokens: end.usage.output_tokens,
        price: priceFor(about.registry, {
          model: about.preset.model,
          at: new Date(),
          paid: about.preset.paid,
          usage: end.usage,
        }),
        plan_usage: end.usage.plan_usage,
        raw_usage: end.usage.raw,
        session_id: end.session_id,
        lacks: [...session!.lacks],
        tail: about.tail,
      };

      // The tail's own answer is not a reply to anybody, so it is recorded and
      // dropped. Only a turn fed from an inbound row reaches the outbox.
      if (about.tail) {
        await appendEntry(store, {
          stream: "turn",
          subject: agent.id,
          kind: "turn",
          actor: "runner",
          detail: record as unknown as Record<string, unknown>,
        });
        return;
      }
      await settleTurn(store, {
        inboundId: message.id,
        chunks: [end.text],
        turn: record,
      });
    };

    const spawn = async (preset: Preset, registry: Registry): Promise<void> => {
      const adapter = adapterFor(options.adapters, preset.adapter);
      if (session) await session.close();
      session = await adapter.start({ preset, sessionId: null });
      running = presetId(preset);

      session.onReceipt((messageId) => {
        const open = turn;
        if (!open || open.tail || open.acked || messageId !== open.id) return;
        open.acked = true;
        write(() => stamp(store, { messageId: open.id, kind: "acked", actor: "runner" }));
      });
      session.onProgress(() => {
        const open = turn;
        if (!open || open.tail || open.started) return;
        open.started = true;
        write(() => stamp(store, { messageId: open.id, kind: "started", actor: "runner" }));
      });
      session.onTurnEnd((end) => turn?.finish(end));

      // A spawned session has no memory of what was said, so the tail of the
      // log is the first thing it is fed and a human message is never the first.
      const tail = await readTail({
        stateDir,
        person: agent.person,
        agent: agent.id,
        now: new Date(),
        hours: setting(registry, "hub.tail_hours"),
        tokens: setting(registry, "hub.tail_tokens"),
      });
      if (tail !== "") await oneTurn({ id: agent.id, text: tail }, { preset, tail: true, registry });
    };

    try {
      await spawn(getPreset(first, agent.preset), first);
      while (!stopping) {
        // Before each turn, because a preset or a rate is a registry edit and
        // the agent picks it up on its next turn without anything restarting.
        const registry = loadRegistry(options.registryFile);
        const row = await claimNext(store, {
          runner: options.runner,
          agent: agent.id,
          leaseMs: setting(registry, "hub.claim_lease_seconds") * 1000,
        });
        if (!row) {
          await Promise.race([
            waitForWork(store, {
              agent: agent.id,
              timeoutMs: setting(registry, "hub.tick_seconds") * 1000,
            }).catch(() => "timeout" as const),
            stopped,
          ]);
          continue;
        }
        const preset = getPreset(registry, agent.preset);
        // A session carries the preset it was started with, so a changed one is
        // a new child. The runner process itself never restarts.
        if (presetId(preset) !== running) await spawn(preset, registry);
        await oneTurn({ id: row.id, text: row.body }, { preset, tail: false, registry });
      }
    } catch (error) {
      if (stopping) return;
      // Loud, never a silent wait: a household that hears nothing all day has no
      // way to tell a quiet agent from a broken one.
      await appendEntry(store, {
        stream: "refusal",
        subject: agent.id,
        kind: "refused.turn",
        actor: "runner",
        detail: {
          adapter: (error as { adapter?: string }).adapter ?? null,
          agent: agent.id,
          error: `${(error as Error).name}: ${(error as Error).message}`,
        },
      });
    } finally {
      if (session) await session.close().catch(() => {});
    }
  };

  const loops = agentsFor(first, { runner: options.runner }).map((agent) => runAgent(agent));

  return {
    runner: options.runner,
    async stop() {
      stopping = true;
      release();
      await Promise.allSettled(loops);
      await store.close();
    },
  };
}
