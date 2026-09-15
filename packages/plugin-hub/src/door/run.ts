import { appendChatLine } from "../chatlog.ts";
import { stamp } from "../records/stamps.ts";
import { agentsFor } from "../registry/entries.ts";
import { loadRegistry, readSetting, type AgentEntry } from "../registry/load.ts";
import { openStore, storeUrlAs, type Store } from "../store/connect.ts";
import { enqueueInbound, inboundId } from "../store/inbound.ts";
import { markDelivered, readPendingChunks } from "../store/outbox.ts";
import { waitForOutbox } from "../store/wake.ts";
import { readCursor, writeCursor } from "./cursor.ts";
import type { Platform } from "./platform.ts";

export interface DoorHandle {
  door: string;
  stop(): Promise<void>;
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

  const read = async (agent: AgentEntry): Promise<void> => {
    let cursor = await readCursor(store, options.door, agent.chat);
    while (!stopping) {
      const pulled = await Promise.race([
        options.platform
          .pull({ chat: agent.chat, cursor, timeoutMs })
          .catch(() => null),
        stopped,
      ]);
      if (pulled === "stopped" || stopping) return;
      if (pulled === null) {
        // The platform is unreachable. Nothing announces its return, so this is
        // the one wait on a clock, and it touches no table.
        await Promise.race([Bun.sleep(timeoutMs), stopped]);
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

  const post = async (agent: AgentEntry): Promise<void> => {
    // Which chunks already have their line on disk. A post the platform refused
    // is tried again, and the line is written once, because the chat log is a
    // diary and not a record of attempts.
    const logged = new Set<number>();
    let owed = false;

    const deliver = async (): Promise<void> => {
      const pending = await readPendingChunks(store, { agent: agent.id });
      const refused = new Set<string>();
      const posted = new Set<string>();
      for (const chunk of pending) {
        if (stopping) return;
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
        posted.add(chunk.inbound_id);
      }
      for (const id of posted) {
        if (!refused.has(id)) {
          await stamp(store, { messageId: id, kind: "delivered", actor: "door" });
        }
      }
      owed = refused.size > 0;
    };

    // Once on connect, because a reply settled while this door was down is on
    // disk with nothing left to announce it.
    await deliver();
    while (!stopping) {
      const why = await Promise.race([
        waitForOutbox(store, { person: agent.person, timeoutMs }).catch(
          () => "timeout" as const,
        ),
        stopped,
      ]);
      if (why === "stopped" || stopping) return;
      // The notification is what says there is something to post. The bound
      // running out says nothing, and reading the table on it would be the
      // timer the store exists to avoid. A refused post is the one thing owed
      // to the clock, because nothing will announce the platform's return.
      if (why === "notified" || owed) await deliver();
    }
  };

  const loops = agentsFor(registry, { door: options.door }).flatMap((agent) => [
    read(agent),
    post(agent),
  ]);

  return {
    door: options.door,
    async stop() {
      stopping = true;
      release();
      await Promise.allSettled(loops);
      await store.close();
    },
  };
}
