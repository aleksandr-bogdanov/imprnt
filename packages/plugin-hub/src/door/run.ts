import { appendChatLine } from "../chatlog.ts";
import { stamp } from "../records/stamps.ts";
import { agentsFor } from "../registry/entries.ts";
import { loadRegistry, readSetting, type AgentEntry } from "../registry/load.ts";
import { openStore, storeUrlAs, type Store } from "../store/connect.ts";
import { enqueueInbound, inboundId } from "../store/inbound.ts";
import { markDelivered, readPendingChunks } from "../store/outbox.ts";
import { openOutboxWaiter } from "../store/wake.ts";
import { readCursor, writeCursor } from "./cursor.ts";
import type { Platform } from "./platform.ts";

export interface DoorHandle {
  door: string;
  stop(): Promise<void>;
}

/**
 * One agent this door is serving right now.
 *
 * D-104. The door reconciles its agent set on the tick exactly as the runner
 * does, because RUN-09's Forbidden line is "a process that reads its
 * configuration only at startup" and it does not say "the runner": an agent
 * added to the file whose door never pulls its chat is an agent nobody can
 * reach, so the routine operation "add an agent" is not done until the door has
 * noticed too. The reconcile is one file parse per tick and issues no SQL, so
 * the door's outbox wait still issues nothing at all.
 */
interface Served {
  leaving: boolean;
  /** Resolves when this agent alone is asked to leave. */
  left: Promise<"stopped">;
  release(): void;
  done: Promise<void>;
}

/**
 * The door: everything a person says is written down before the platform is
 * told it arrived, and everything the loop answered is posted only after the
 * transaction that settled it committed.
 *
 * Inbound is the order L1 fixes: read the platform, commit the row and its
 * received stamp together, then move the cursor. A kill in either gap loses
 * nothing and duplicates nothing, because the id is the platform's own and a
 * redelivery meets the row it already wrote.
 *
 * Outbound waits on the notification the settling transaction emits. Between
 * one wake and the next it issues no statement at all.
 */
export async function runDoor(options: {
  door: string;
  registryFile: string;
  platform: Platform;
}): Promise<DoorHandle> {
  const registry = loadRegistry(options.registryFile);
  const stateDir = String(readSetting(registry, "hub.state_dir"));
  const timeoutMs = Number(readSetting(registry, "hub.tick_seconds")) * 1000;
  const store: Store = await openStore({
    url: storeUrlAs(String(readSetting(registry, "hub.store_url")), "hub_door"),
  });

  let stopping = false;
  let release: () => void = () => {};
  const stopped = new Promise<"stopped">((resolve) => {
    release = () => resolve("stopped");
  });

  const read = async (agent: AgentEntry, own: Served): Promise<void> => {
    let cursor = await readCursor(store, options.door, agent.chat);
    while (!stopping && !own.leaving) {
      const pulled = await Promise.race([
        options.platform
          .pull({ chat: agent.chat, cursor, timeoutMs })
          .catch(() => null),
        stopped,
        own.left,
      ]);
      // An agent that left the file is a chat this door no longer pulls, so
      // anything said in it after that is never read and never written down.
      if (pulled === "stopped" || stopping || own.leaving) return;
      if (pulled === null) {
        // The platform is unreachable. Nothing announces its return, so this is
        // the one wait on a clock, and it touches no table.
        await Promise.race([Bun.sleep(timeoutMs), stopped, own.left]);
        continue;
      }

      for (const message of pulled.messages) {
        const id = inboundId(
          options.platform.name,
          message.chat,
          message.platform_message_id,
        );
        const fresh = await store.sql.begin(async (tx) =>
          enqueueInbound(
            { ...store, sql: tx as unknown as Store["sql"] },
            { id, person: agent.person, agent: agent.id, body: message.text },
          ),
        );
        // Only a row this pull created gets a line. A redelivery that wrote
        // nothing would otherwise put a second message in the diary that
        // nobody sent.
        if (fresh) {
          await appendChatLine(
            { stateDir, person: agent.person, agent: agent.id },
            {
              at: message.at,
              direction: "in",
              from: agent.person,
              text: message.text,
            },
          );
        }
      }

      if (pulled.messages.length > 0 && pulled.cursor !== null) {
        cursor = pulled.cursor;
        await writeCursor(store, options.door, agent.chat, cursor);
      }
    }
  };

  const post = async (agent: AgentEntry, own: Served): Promise<void> => {
    // Which chunks already have their line on disk, so a post the platform
    // refused is tried again with no second line: the chat log is a diary and
    // not a record of attempts. A delivered chunk leaves the set, which is what
    // keeps it the size of what is in flight.
    const logged = new Set<number>();
    let owed = false;

    const deliver = async (): Promise<void> => {
      const pending = await readPendingChunks(store, { agent: agent.id });
      const refused = new Set<string>();
      const posted = new Set<string>();
      for (const chunk of pending) {
        if (stopping || own.leaving) return;
        if (refused.has(chunk.inbound_id)) continue;
        if (!logged.has(chunk.id)) {
          await appendChatLine(
            { stateDir, person: chunk.person, agent: chunk.agent },
            {
              at: new Date().toISOString(),
              direction: "out",
              from: chunk.agent,
              text: chunk.body,
            },
          );
          logged.add(chunk.id);
        }
        try {
          await options.platform.post({ chat: agent.chat, text: chunk.body });
        } catch {
          // The rest of this reply waits with it, so a person never reads the
          // second half of an answer before the first.
          refused.add(chunk.inbound_id);
          continue;
        }
        await markDelivered(store, chunk.id);
        logged.delete(chunk.id);
        posted.add(chunk.inbound_id);
      }
      for (const id of posted) {
        if (!refused.has(id)) {
          await stamp(store, { messageId: id, kind: "delivered", actor: "door" });
        }
      }
      owed = refused.size > 0;
    };

    // The LISTEN is opened before the first read and held across every wait,
    // so a settle that commits between a read and the wait after it is
    // announced to a listener that already exists. Opened after the read, it
    // would miss exactly that commit, and this door never re-reads on a bare
    // timeout to recover from one.
    const waiter = await openOutboxWaiter(store, { person: agent.person });
    try {
      // Once on connect, because a reply settled while this door was down is on
      // disk with nothing left to announce it.
      await deliver();
      while (!stopping && !own.leaving) {
        const why = await Promise.race([
          waiter.wait(timeoutMs).catch(() => "timeout" as const),
          stopped,
          own.left,
        ]);
        if (why === "stopped" || stopping || own.leaving) return;
        // The notification is what says there is something to post. The bound
        // running out says nothing, and reading the table on it would be the
        // timer the store exists to avoid. A refused post is the one thing owed
        // to the clock, because nothing will announce the platform's return.
        if (why === "notified" || owed) await deliver();
      }
    } finally {
      await waiter.close();
    }
  };

  const served = new Map<string, Served>();

  const serve = (agent: AgentEntry): void => {
    let release: () => void = () => {};
    const left = new Promise<"stopped">((resolve) => {
      release = () => resolve("stopped");
    });
    const it: Served = { leaving: false, left, release, done: Promise.resolve() };
    served.set(agent.id, it);
    it.done = Promise.allSettled([read(agent, it), post(agent, it)]).then(() => {});
  };

  const drop = async (id: string): Promise<void> => {
    const it = served.get(id);
    if (!it) return;
    served.delete(id);
    it.leaving = true;
    it.release();
    await it.done.catch(() => {});
  };

  for (const agent of agentsFor(registry, { door: options.door })) serve(agent);

  const supervise = (async () => {
    while (!stopping) {
      await Promise.race([Bun.sleep(timeoutMs), stopped]);
      if (stopping) break;
      let fresh: unknown;
      try {
        fresh = loadRegistry(options.registryFile);
      } catch {
        continue;
      }
      try {
        const wanted = agentsFor(fresh, { door: options.door });
        for (const agent of wanted) if (!served.has(agent.id)) serve(agent);
        for (const id of [...served.keys()]) {
          if (!wanted.some((agent) => agent.id === id)) await drop(id);
        }
      } catch {
        // A tick that could not finish is a tick. The next one runs.
      }
    }
  })();

  return {
    door: options.door,
    async stop() {
      stopping = true;
      release();
      await supervise;
      await Promise.allSettled([...served.values()].map((it) => it.done));
      await store.close();
    },
  };
}
