import type { DeletionPreview, ReceiptClass, ReceiptSummary } from "../store/deletions.ts";
import { CONFIRM_EMOJI } from "../store/confirmations.ts";
import { MACHINERY_LINES, safeValue, type Language } from "./lines.ts";

/**
 * Every sentence a person reads about deleting a topic chat, in both languages, in one place: the preview that is confirmed, what
 * is said when the active history is gone, when it is waiting for a machine, and when part of it cannot be erased.
 *
 * WHAT THE WORDS PROMISE, AND WHAT THEY DO NOT. They say what was removed from the places the Hub keeps and could show gone, and
 * they say what remains: notes already saved in the vault, and earlier backup copies, which are not rewritten. A copy that could
 * not be erased, or whose machine has not answered, is named; nothing says "everything is deleted". The Russian wording is ours and
 * is reported as such.
 *
 * THE PREVIEW IS PURE: what is hashed is what is shown, so `deletionPreview` is the one function that turns the frozen scope into
 * the text a person confirms, and nothing else builds it.
 */

const says = (language: Language, sentence: string): string => `${MACHINERY_LINES[language]} ${sentence}`;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The numbers a preview shows, in the owner's words. A zero is left out, so what is listed is what exists. */
function inventoryLines(language: Language, inventory: Record<string, number>): string[] {
  const n = (key: string): number => Number(inventory[key] ?? 0);
  const ru = language === "ru";
  const items: [number, string][] = ru
    ? [
      [n("inbound"), `сообщений и заданий: ${n("inbound")}`],
      [n("conversation_entries"), `записей разговоров: ${n("conversation_entries")}`],
      [n("councils"), `советов: ${n("councils")}`],
      [n("jobs"), `поручений: ${n("jobs")}`],
      [n("media_files"), `вложений: ${n("media_files")} (${n("media_bytes")} байт)`],
      [n("ledger_events"), `записей журнала: ${n("ledger_events")}`],
      [n("state_rows"), `служебных записей: ${n("state_rows")}`],
      [n("moves"), `переносов: ${n("moves")}`],
      [n("messages_elsewhere"), `сообщений Hub вне этого чата: ${n("messages_elsewhere")}`],
    ]
    : [
      [n("inbound"), plural(n("inbound"), "message or job", "messages and jobs")],
      [n("conversation_entries"), plural(n("conversation_entries"), "conversation entry", "conversation entries")],
      [n("councils"), plural(n("councils"), "council", "councils")],
      [n("jobs"), plural(n("jobs"), "delegated job", "delegated jobs")],
      [n("media_files"), `${plural(n("media_files"), "attachment", "attachments")} (${n("media_bytes")} bytes)`],
      [n("ledger_events"), plural(n("ledger_events"), "diary entry", "diary entries")],
      [n("state_rows"), plural(n("state_rows"), "status record", "status records")],
      [n("moves"), plural(n("moves"), "machine move", "machine moves")],
      [n("messages_elsewhere"), `${plural(n("messages_elsewhere"), "Hub message", "Hub messages")} outside this chat`],
    ];
  return items.filter(([count]) => count > 0).map(([, text]) => text);
}

/** What the owner is shown and confirms: the chat, the scope, what stays, and what the earlier backups do. */
export function deletionPreview(language: Language, facts: { name: string; preview: DeletionPreview }): string {
  const ru = language === "ru";
  const days = facts.preview.retention.configured_days;
  const lines = inventoryLines(language, facts.preview.inventory);
  const machines = facts.preview.machines.length === 0 ? (ru ? "нет" : "none") : facts.preview.machines.join(", ");
  const backups = days === null
    ? (ru ? "Более ранние резервные копии не переписываются; срок их хранения не настроен, поэтому даты истечения нет."
          : "Earlier backup copies are not rewritten. No backup retention is configured, so they have no expiry date.")
    : (ru ? `Более ранние резервные копии не переписываются; настроенный срок хранения: ${days} дн. от создания копии, и хранилище может не позволять проверить истечение.`
          : `Earlier backup copies are not rewritten. The configured retention is ${days} days from each copy's creation, and the backup destination may not be able to verify expiry.`);
  const head = ru ? `Удалить чат ${safeValue(facts.name)}, его агента и активную историю` : `Delete the chat ${safeValue(facts.name)}, its agent and its active history`;
  const removes = ru ? "Будет удалено:" : "This removes:";
  const where = ru ? `Машины с копиями: ${machines}` : `Machines holding copies: ${machines}`;
  const stops = ru
    ? "Работа агента и его поручений будет остановлена; агента не запускают, чтобы он дал ещё один ответ. Идентификаторы больше никогда не используются."
    : "The agent's work and its delegated work are stopped, and the agent is not run to produce another answer. These identifiers are never used again.";
  const keeps = ru ? "Остаётся: заметки, уже сохранённые в хранилище знаний, и файлы проектов вне этого чата." : "Kept: notes already saved in the vault, and project files outside this chat.";
  return [head, "", removes, ...(lines.length === 0 ? [ru ? "- ничего, кроме самого агента и чата" : "- nothing but the agent and the chat itself"] : lines.map(line => `- ${line}`)),
    "", where, "", stops, keeps, backups].join("\n");
}

/** The line that asks for the reaction, under the preview. It is bound by the hash with the rest. */
export function deletionConfirmationAsk(language: Language): string {
  return language === "ru"
    ? `Поставьте ${CONFIRM_EMOJI}, чтобы удалить чат, агента и активную историю, или напишите, что изменить.`
    : `React with ${CONFIRM_EMOJI} to delete this chat, its agent and its active history, or tell me what to change.`;
}

const PLACE: Record<ReceiptClass, { en: string; ru: string }> = {
  postgres_active: { en: "the hub's records", ru: "записи хаба" },
  registry_binding: { en: "the agent's registry entry", ru: "запись агента в реестре" },
  chatlog: { en: "the chat log", ru: "журнал чата" },
  inbox_media: { en: "attachments", ru: "вложения" },
  engine_state: { en: "the agent's session files", ru: "файлы сессий агента" },
  move_copy: { en: "a copy kept by a machine move", ru: "копия, оставшаяся от переноса" },
  harvest_stage: { en: "notes staged for the vault", ru: "заметки, подготовленные для хранилища" },
  platform_chat: { en: "the chat on the platform", ru: "чат на платформе" },
  platform_message: { en: "a message outside the chat", ru: "сообщение вне чата" },
  backup_generation: { en: "an earlier backup copy", ru: "более ранняя резервная копия" },
};

/** A receipt in words: what, and where. */
export function placeOf(language: Language, receipt: Pick<ReceiptSummary, "class" | "machine">): string {
  const what = PLACE[receipt.class][language === "ru" ? "ru" : "en"];
  return receipt.machine === "" ? what : `${what} (${safeValue(receipt.machine)})`;
}

function listOf(language: Language, receipts: readonly Pick<ReceiptSummary, "class" | "machine">[]): string {
  return [...new Set(receipts.map(one => placeOf(language, one)))].join("; ");
}

/** The active history is deleted. It says what remains, and never that the earlier backups are gone. */
export function deletionDoneNotice(language: Language, v: { name: string; retention: string; unsupported: readonly Pick<ReceiptSummary, "class" | "machine">[] }): string {
  const name = safeValue(v.name);
  const left = v.unsupported.length === 0 ? "" : (language === "ru" ? ` Не удалось удалить: ${listOf(language, v.unsupported)}.` : ` Not erased: ${listOf(language, v.unsupported)}.`);
  return language === "ru"
    ? says(language, `Чат ${name}, его агент и активная история удалены. Заметки в хранилище знаний остались.${left} ${v.retention}`)
    : says(language, `The chat ${name}, its agent and its active history are deleted. Notes saved in the vault remain.${left} ${v.retention}`);
}

/** Some machine that holds an active copy has not reported it erased. It is waited for, and nothing says it is done. */
export function deletionWaitingNotice(language: Language, v: { name: string; waiting: readonly Pick<ReceiptSummary, "class" | "machine">[] }): string {
  const name = safeValue(v.name);
  return language === "ru"
    ? says(language, `Удаление чата ${name} сделано не везде: ждём подтверждения от ${listOf(language, v.waiting)}. Пока оно не получено, удаление не считается завершённым.`)
    : says(language, `Deleting the chat ${name} is not finished: still waiting to hear that ${listOf(language, v.waiting)} was erased. It is not complete until then.`);
}

/** A copy cannot be erased by this Hub. It is named, and the deletion is not called complete. */
export function deletionBlockedNotice(language: Language, v: { name: string; refused: readonly Pick<ReceiptSummary, "class" | "machine" | "state">[] }): string {
  const name = safeValue(v.name);
  const unsupported = v.refused.filter(one => one.state === "unsupported");
  const refused = v.refused.filter(one => one.state !== "unsupported");
  const parts: string[] = [];
  if (unsupported.length > 0) parts.push(language === "ru" ? `платформа не поддерживает удаление: ${listOf(language, unsupported)}` : `the platform does not support deleting it: ${listOf(language, unsupported)}`);
  if (refused.length > 0) parts.push(language === "ru" ? `не удалось удалить: ${listOf(language, refused)}` : `could not be erased: ${listOf(language, refused)}`);
  return language === "ru"
    ? says(language, `Активная история чата ${name} удалена из того, что Hub может стереть, но не всё: ${parts.join("; ")}. Удаление не считается завершённым.`)
    : says(language, `The active history of the chat ${name} is deleted from what the Hub can erase, but not all of it: ${parts.join("; ")}. The deletion is not complete.`);
}
