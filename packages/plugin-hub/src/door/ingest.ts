import { appendChatLineOnce, type BadRecord } from "../chatlog.ts";
import { recordOperationFailure } from "../diagnostics.ts";
import { requestRecovery } from "../hub/control.ts";
import { projectInbound } from "../chatlog/project.ts";
import { encodeHarvestBody } from "../harvest/row.ts";
import { readWatermark } from "../harvest/sheet.ts";
import { isDemand, isRecoveryCommand, readSlice } from "../harvest/slice.ts";
import { languageOf, senderAllowed } from "../registry/entries.ts";
import { readSetting, type AgentEntry, type Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { enqueueInbound, inboundId } from "../store/inbound.ts";
import { writeCursor } from "./cursor.ts";
import { recordDeniedSender } from "./denied.ts";
import { controlUsage, recoveryAccepted, recoveryRefused, emptyMessageLine, mediaFailed, mediaKind, voicePending } from "./lines.ts";
import { saveMedia, type SavedMedia } from "./media.ts";
import type { Platform, PlatformPull } from "./platform.ts";

/** Accepted work, its files and its projection precede the fetched boundary. */
export async function acceptBatch(options: {
  store: StoreLike; registry: Registry; stateDir: string; door: string;
  agent: AgentEntry; platform: Platform; batch: PlatformPull; cursor: string | null;
  received?(id: string): void;
  /** The door skips a bad complete chat log record and reports it. */
  skipBad?(bad: BadRecord): void | Promise<void>;
}): Promise<string | null> {
  const { store, registry, stateDir, door, agent, platform, batch } = options;
  const skipBad = { skipBad: options.skipBad };
  const language = languageOf(registry, agent.person);
  for (const message of batch.messages) {
    if (message.chat !== agent.chat || !message.sender_id) continue;
    if (!senderAllowed(registry, agent.person, door, message.sender_id)) {
      // Refused with no reply and nothing saved, and counted without
      // its content, so an allowlist that names the wrong id is visible.
      await recordDeniedSender(store, { door, chat: message.chat, sender_id: message.sender_id,
        person: agent.person, agent: agent.id, at: message.at });
      continue;
    }
    const sender = message.sender_id;
    if (isRecoveryCommand(message.text)) {
      const id = `recover:${inboundId(platform.name, message.chat, message.platform_message_id)}`;
      await appendChatLineOnce({ stateDir, person: agent.person, agent: agent.id }, {
        id, at: message.at, direction: "in", from: agent.person, text: message.text,
      }, skipBad);
      const target = message.text.trim().split(/\s+/);
      let text = controlUsage(language);
      if (target.length === 2) {
        try {
          await requestRecovery(store, { id, registry, source: "chat", actor: sender, sender_id: sender,
            person: agent.person, door, chat: agent.chat, agent: agent.id, target_kind: "agent", target_id: target[1] });
          text = recoveryAccepted(language, { target: target[1] });
        } catch (error) {
          if (!["invalid-recovery-target", "recovery-not-authorized"].includes((error as Error).message)) throw error;
          text = recoveryRefused(language, { target: target[1], cause: "access denied" });
        }
      }
      await appendChatLineOnce({ stateDir, person: agent.person, agent: agent.id }, {
        id: id + ":notice", at: message.at, direction: "out", from: door, text,
      }, skipBad);
      try { await platform.post({ chat: agent.chat, text }); }
      catch (error) { await recordOperationFailure(store, { operation: "post", target: `${door}/${agent.chat}`, error, actor: "door" }); }
      continue;
    }
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
      const slice = await readSlice({ ...context, from, until, ...skipBad });
      body = encodeHarvestBody({ from, until, reason: "demand", lines: slice.length, said: message.text });
    }
    const source = { log_id: id, at: message.at, door, chat: message.chat, sender_id: sender, from: message.from,
      text: demand ? message.text : text, ...(saved.length ? { media: saved } : {}) };
    const fresh = await store.sql.begin(async sql => enqueueInbound({ ...store, sql: sql as unknown as StoreLike["sql"] }, {
      id, person: agent.person, agent: agent.id, body, kind: demand ? "harvest" : "human",
      source, log_ready: false,
    }));
    await projectInbound(store, { stateDir, inboundId: id, ...skipBad,
      ...(fresh ? { accepted: { person: agent.person, agent: agent.id, source } } : {}) });
    if (fresh && !demand) options.received?.(id);
  }
  if (batch.cursor !== null && batch.cursor !== options.cursor) {
    await writeCursor(store, door, agent.chat, batch.cursor);
  }
  return batch.cursor ?? options.cursor;
}
