import { appendChatLineOnce, type BadRecord } from "../chatlog.ts";
import { recordOperationFailure } from "../diagnostics.ts";
import { requestRecovery } from "../hub/control.ts";
import { projectInbound } from "../chatlog/project.ts";
import { encodeHarvestBody } from "../harvest/row.ts";
import { readWatermark } from "../harvest/sheet.ts";
import { isDemand, isRecoveryCommand, readSlice } from "../harvest/slice.ts";
import { languageOf, senderAllowed, voiceFor } from "../registry/entries.ts";
import { readSetting, type ChatAgent, type Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { enqueueInbound, inboundId } from "../store/inbound.ts";
import { markMediaPending } from "../voice/records.ts";
import { writeCursor } from "./cursor.ts";
import { recordDeniedSender } from "./denied.ts";
import { requestDispatch, parseDispatch } from "./dispatch.ts";
import { controlUsage, dispatchAccepted, dispatchRefused, dispatchUsage, recoveryAccepted, recoveryRefused, emptyMessageLine, mediaFailed, mediaKind, voicePending } from "./lines.ts";
import { saveMedia, type SavedMedia } from "./media.ts";
import type { Platform, PlatformPull } from "./platform.ts";

/** One row the door wrote down that is waiting for a voice note's own words. */
export interface PendingVoiceRow {
  id: string;
  person: string;
  agent: string;
  source: Record<string, unknown>;
  receivedAt: Date;
}

/** Accepted work, its files and its projection precede the fetched boundary. */
export async function acceptBatch(options: {
  store: StoreLike; registry: Registry; stateDir: string; door: string;
  agent: ChatAgent; platform: Platform; batch: PlatformPull; cursor: string | null;
  received?(id: string, mediaState: string | null): void;
  /** A row the transcription step now owes its words, handed over with no query. */
  pending?(row: PendingVoiceRow): void;
  /** The door skips a bad complete chat log record and reports it. */
  skipBad?(bad: BadRecord): void | Promise<void>;
}): Promise<string | null> {
  const { store, registry, stateDir, door, agent, platform, batch } = options;
  const skipBad = { skipBad: options.skipBad };
  const language = languageOf(registry, agent.person);
  // Null means this household names no recognizer, which is the file it starts
  // with: nothing under `[voice]` is read and a voice note keeps today's path.
  const voice = voiceFor(registry);
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
    const asked = parseDispatch(message.text);
    if (asked !== null) {
      const base = inboundId(platform.name, message.chat, message.platform_message_id);
      const id = `dispatch:${base}`;
      await appendChatLineOnce({ stateDir, person: agent.person, agent: agent.id }, {
        id, at: message.at, direction: "in", from: agent.person, text: message.text,
      }, skipBad);
      let text = dispatchUsage(language);
      if (asked !== "usage") {
        try {
          await requestDispatch(store, { id: `job:${base}`, registry, person: agent.person,
            door, chat: agent.chat, agent: agent.id, sender_id: sender, from: message.from,
            target: asked.target, task: asked.task, at: message.at });
          text = dispatchAccepted(language, { agent: asked.target });
        } catch (error) {
          if ((error as Error).name !== "DispatchRefused") throw error;
          text = dispatchRefused(language, { agent: asked.target, cause: "access denied" });
        }
      }
      // POSTED ONLY WHEN THE LINE IS NEW. The row, the diary entry and both
      // chat lines are already idempotent by the platform message id, so a
      // platform that redelivers a batch would otherwise say the same sentence
      // twice about a job it created once.
      const fresh = await appendChatLineOnce({ stateDir, person: agent.person, agent: agent.id }, {
        id: id + ":notice", at: message.at, direction: "out", from: door, text,
      }, skipBad);
      if (fresh) {
        try { await platform.post({ chat: agent.chat, text }); }
        catch (error) { await recordOperationFailure(store, { operation: "post", target: `${door}/${agent.chat}`, error, actor: "door" }); }
      }
      continue;
    }
    const demand = isDemand(message.text);
    const id = (demand ? "harvest-demand:" : "") + inboundId(platform.name, message.chat, message.platform_message_id);
    const lines: string[] = [];
    const saved: (SavedMedia & { notices: string[]; line?: number })[] = [];
    /** Whether this row is waiting for words the step has yet to fetch. */
    let transcribing = false;
    for (const [index, media] of (message.media ?? []).entries()) {
      const file = await saveMedia({ stateDir, person: agent.person, inboundId: id, index, media,
        maxBytes: Number(readSetting(registry, "door.media_max_bytes")), platform });
      const notices: string[] = [];
      // A household that transcribes must not be told its notes are not
      // transcribed, and a note whose download failed is answered by the
      // failure line rather than by a promise nothing will keep.
      if (media.kind === "voice" && voice === null) notices.push(voicePending(language));
      if (file.failed) notices.push(mediaFailed(language, { kind: media.kind }));
      // Its own line, kept so the transcript can be put back exactly where the
      // marker is. Searching for the marker later could find a line the person
      // typed, and the door knows the answer here.
      saved.push({ ...file, notices, ...(voice === null ? {} : { line: lines.length }) });
      lines.push(`(${mediaKind(language, file.failed ? "file" : media.kind)} ${file.path})`);
      if (file.failed) lines.push(mediaFailed(language, { kind: media.kind }));
      if (media.caption) lines.push(media.caption);
      if (voice !== null && media.kind === "voice" && !file.failed) transcribing = true;
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
      text: demand ? message.text : text, ...(saved.length ? { media: saved } : {}),
      ...(transcribing ? { lines } : {}) };
    const fresh = await store.sql.begin(async sql => {
      const inside = { ...store, sql: sql as unknown as StoreLike["sql"] };
      const written = await enqueueInbound(inside, {
        id, person: agent.person, agent: agent.id, body, kind: demand ? "harvest" : "human",
        source, log_ready: false,
      });
      // One transaction, so a row is never committed without the state that
      // says somebody still owes it its words.
      if (written && transcribing) await markMediaPending(inside, { id });
      return written;
    });
    // A ROW WAITING FOR ITS TEXT IS NOT PROJECTED. Projecting it would put a
    // line with no words into the chat log and make it claimable, and the
    // person would be answered about a note nobody has heard. The door's
    // transcription step projects it the moment the words exist.
    if (!transcribing) {
      await projectInbound(store, { stateDir, inboundId: id, ...skipBad,
        ...(fresh ? { accepted: { person: agent.person, agent: agent.id, source } } : {}) });
    }
    if (fresh && !demand) {
      // Typing is shown from the COMMIT, and a row waiting for its words arms a
      // clock of its own, so the door hears about it either way and the state
      // travels with it.
      options.received?.(id, transcribing ? "pending" : null);
      // The counterpart, and the whole of how the step learns its row: the door
      // has it in hand, so nothing is queried. `received_at` is the door's own
      // clock at the commit, which is the instant the column carries.
      if (transcribing) options.pending?.({ id, person: agent.person, agent: agent.id, source, receivedAt: new Date() });
    }
  }
  if (batch.cursor !== null && batch.cursor !== options.cursor) {
    await writeCursor(store, door, agent.chat, batch.cursor);
  }
  return batch.cursor ?? options.cursor;
}
