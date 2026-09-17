import { projectInbound } from "../chatlog/project.ts";
import { encodeHarvestBody } from "../harvest/row.ts";
import { readWatermark } from "../harvest/sheet.ts";
import { isDemand, readSlice } from "../harvest/slice.ts";
import { languageOf, senderAllowed } from "../registry/entries.ts";
import { readSetting, type AgentEntry, type Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { enqueueInbound, inboundId } from "../store/inbound.ts";
import { writeCursor } from "./cursor.ts";
import { emptyMessageLine, mediaFailed, mediaKind, voicePending } from "./lines.ts";
import { saveMedia, type SavedMedia } from "./media.ts";
import type { Platform, PlatformPull } from "./platform.ts";

/** Accepted work, its files and its projection precede the fetched boundary. */
export async function acceptBatch(options: {
  store: StoreLike; registry: Registry; stateDir: string; door: string;
  agent: AgentEntry; platform: Platform; batch: PlatformPull; cursor: string | null;
  received?(id: string): void;
}): Promise<string | null> {
  const { store, registry, stateDir, door, agent, platform, batch } = options;
  const language = languageOf(registry, agent.person);
  for (const message of batch.messages) {
    if (message.chat !== agent.chat || !message.sender_id || !senderAllowed(registry, agent.person, door, message.sender_id)) continue;
    const sender = message.sender_id;
    const demand = isDemand(message.text);
    const id = (demand ? "harvest-demand:" : "") + inboundId(platform.name, message.chat, message.platform_message_id);
    const lines: string[] = [];
    const saved: (SavedMedia & { notices: string[] })[] = [];
    for (const [index, media] of (message.media ?? []).entries()) {
      const file = await saveMedia({ stateDir, person: agent.person, inboundId: id, index, media,
        maxBytes: Number(readSetting(registry, "door.media_max_bytes")), platform });
      const notices: string[] = [];
      if (media.kind === "voice") notices.push(voicePending(language));
      if (file.failed) notices.push(mediaFailed(language, { kind: media.kind }));
      saved.push({ ...file, notices });
      lines.push(`(${mediaKind(language, file.failed ? "file" : media.kind)} ${file.path})`);
      if (file.failed) lines.push(mediaFailed(language, { kind: media.kind }));
      if (media.caption) lines.push(media.caption);
    }
    if (message.text) lines.push(message.text);
    const text = lines.join("\n") || emptyMessageLine(language);
    let body = text;
    if (demand) {
      const context = { stateDir, person: agent.person, agent: agent.id };
      const watermark = await readWatermark(store, context);
      const from = watermark?.at ?? null;
      const until = message.at;
      const slice = await readSlice({ ...context, from, until });
      body = encodeHarvestBody({ from, until, reason: "demand", lines: slice.length, said: message.text });
    }
    const source = { log_id: id, at: message.at, door, chat: message.chat, sender_id: sender,
      text: demand ? message.text : text, ...(saved.length ? { media: saved } : {}) };
    const fresh = await store.sql.begin(async sql => enqueueInbound({ ...store, sql: sql as unknown as StoreLike["sql"] }, {
      id, person: agent.person, agent: agent.id, body, kind: demand ? "harvest" : "human",
      source, log_ready: false,
    }));
    await projectInbound(store, { stateDir, inboundId: id,
      ...(fresh ? { accepted: { person: agent.person, agent: agent.id, source } } : {}) });
    if (fresh && !demand) options.received?.(id);
  }
  if (batch.cursor !== null && batch.cursor !== options.cursor) {
    await writeCursor(store, door, agent.chat, batch.cursor);
  }
  return batch.cursor ?? options.cursor;
}
