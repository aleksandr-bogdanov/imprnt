import { engineLabel } from "../registry/topics.ts";
import { CONFIRM_EMOJI } from "../store/confirmations.ts";
import { MACHINERY_LINES, safeValue, WORDS, type Language } from "./lines.ts";

/**
 * Every sentence a person reads about a topic chat, in both languages, in one place: the
 * preview of a chat that is about to be made, and what is said once it is, when it could not be,
 * when it is archived or reopened, and when its chat is gone.
 *
 * TWO RULES, both the household's. What a person reads says what happened and what they can
 * do about it, in plain words, and never how it was done (no state names, no operation ids, no
 * table). And every line the machinery says is marked as the door's, in the person's language.
 *
 * THE PREVIEW IS PURE, because what is hashed is what is shown: `topicPreview` is the one
 * function that turns a resolved setup into the text a person confirms, and nothing else
 * builds it. The three labels are the owner's words (Chat, Execution machine, Agent), kept
 * short, with no explanation beside them. The Russian labels are ours and are one line to
 * change (`LABELS`); they are not the owner's words and are reported as such.
 */

const LABELS: Record<Language, { chat: string; machine: string; agent: string; tools: string }> = {
  en: { chat: "Chat", machine: "Execution machine", agent: "Agent", tools: "Tools" },
  ru: { chat: "Чат", machine: "Машина выполнения", agent: "Агент", tools: "Инструменты" },
};

/** What a person confirms. The request is passed on to the new agent exactly as it appears here. */
export interface PreviewSetup {
  chat_name: string;
  machine: string;
  adapter: string;
  model: string;
  /** Only for a preset on a model key: shown beside the model so that an engine is never read as another provider's. */
  provider?: string;
  /** The request or handover, verbatim, and the very text the agent's first input will be. */
  initial_request: string;
  tool_profile?: string[];
}

export function topicPreview(language: Language, setup: PreviewSetup): string {
  const label = LABELS[language];
  const head = [
    `${label.chat}: ${setup.chat_name}`,
    `${label.machine}: ${setup.machine}`,
    `${label.agent}: ${engineLabel(setup.adapter)} (${setup.model}${setup.provider === undefined ? "" : `, ${setup.provider}`})`,
  ].join("\n");
  const tools = setup.tool_profile && setup.tool_profile.length > 0 ? `\n\n${label.tools}: ${setup.tool_profile.join(", ")}` : "";
  return `${head}\n\n${setup.initial_request}${tools}`;
}

/** The line that asks for the reaction, under the preview. It is bound by the hash with the rest. */
export function topicConfirmationAsk(language: Language): string {
  return language === "ru"
    ? `Поставьте ${CONFIRM_EMOJI}, чтобы создать чат, или напишите, что изменить.`
    : `React with ${CONFIRM_EMOJI} to create this chat, or tell me what to change.`;
}

const says = (language: Language, sentence: string): string => `${MACHINERY_LINES[language]} ${sentence}`;
const word = (language: Language, value: unknown): string => {
  const said = safeValue(value);
  return language === "ru" && Object.hasOwn(WORDS, said) ? WORDS[said] : said;
};
/** A chat by its platform mention where the platform has one, and by its name otherwise. */
const chatOf = (platform: string, name: string, chat: string | null): string =>
  platform === "discord" && chat !== null ? `<#${chat}>` : safeValue(name);

/** The one editable status line in the new chat while its machine is not running. */
export function topicWaitingLine(language: Language, machine: string): string {
  return language === "ru" ? `Ждём ${safeValue(machine)}` : `Waiting for ${safeValue(machine)}`;
}

/**
 * The same line once something showed the machine took the first message up: the status is edited in place, not posted
 * again. It is a MILESTONE and says only that: "started", never "running", because nothing follows the agent after it and
 * a line that claimed to would be wrong the moment the agent stopped.
 */
export function topicStartedLine(language: Language, machine: string): string {
  return language === "ru" ? `Запущен на ${safeValue(machine)}` : `Started on ${safeValue(machine)}`;
}

/** Said where the setup was asked for once the agent is set up. The chat is made and its message is queued; it has not started. */
export function topicReadyNotice(language: Language, v: { platform: string; name: string; chat: string; machine: string; waiting: boolean }): string {
  const chat = chatOf(v.platform, v.name, v.chat);
  const machine = safeValue(v.machine);
  if (language === "ru") {
    return says(language, v.waiting
      ? `Чат ${chat} создан. Ждём ${machine}: сообщение будет обработано там, как только машина подхватит чат.`
      : `Чат ${chat} создан, агент запущен на ${machine}.`);
  }
  return says(language, v.waiting
    ? `The chat ${chat} is created. Waiting for ${machine}: your message will be handled there as soon as it picks the chat up.`
    : `The chat ${chat} is created and its agent started on ${machine}.`);
}

/** What could not be done and where it stopped. Nothing was deleted and nothing was made again. */
export function topicStepFailedNotice(language: Language, v: { platform: string; name: string; chat: string | null; step: "channel" | "binding"; cause: string }): string {
  const chat = chatOf(v.platform, v.name, v.chat);
  const cause = word(language, v.cause);
  // What was approved is no longer what the registry says: nothing was substituted, and a different setup is a new approval.
  const changed = v.step === "binding" && v.cause.startsWith("approved setup changed");
  if (language === "ru") {
    const step = v.step === "channel" ? "при создании канала" : "при подключении агента";
    return says(language, `Создание ${chat} остановилось ${step}: ${cause}. Ничего не удалялось и ничего не создавалось повторно.` +
      (v.chat === null ? "" : " Канал остался на месте, сообщения в нём сохранены.") +
      (changed ? " Верните одобренные настройки, и подключение завершится само; другие настройки — это новый запрос и новое одобрение." : ""));
  }
  const step = v.step === "channel" ? "creating the channel" : "connecting the agent";
  return says(language, `Creating ${chat} stopped while ${step}: ${cause}. Nothing was deleted and nothing was created again.` +
    (v.chat === null ? "" : " The channel is still there and its messages are kept.") +
    (changed ? " Put back what you approved and the connection finishes on its own; anything else is a new request and a new approval." : ""));
}

/** The owner named a channel for a chat that could not be made or found, and it cannot be used. Nothing was created. */
export function topicAdoptRefusedNotice(language: Language, v: { name: string; cause: string }): string {
  const name = safeValue(v.name);
  const cause = word(language, v.cause);
  return language === "ru"
    ? says(language, `Канал, который вы назвали для чата ${name}, использовать нельзя: ${cause}. Ничего не создавалось и ничего не удалялось; назовите другой канал или попросите создать чат заново.`)
    : says(language, `The channel you named for the chat ${name} cannot be used: ${cause}. Nothing was created and nothing was deleted; name another channel, or ask me to create the chat again.`);
}

/** The outcome of the channel request cannot be established. Nothing is created again, and nothing is guessed. */
export function topicCreationUnknownNotice(language: Language, v: { name: string }): string {
  const name = safeValue(v.name);
  return language === "ru"
    ? says(language, `Не удалось выяснить, создан ли чат ${name}. Повторно ничего не создавалось и ничего не удалялось. ` +
      "Проверьте сервер: если такой канал есть, назовите его id, а если нет, попросите создать чат заново.")
    : says(language, `I could not confirm whether the chat ${name} was created. Nothing was created again and nothing was deleted. ` +
      "Check the server: if the channel is there, tell me its id, and if it is not, ask me to create the chat again.");
}

/** The chat was made, but its request could not be stored with it, so nothing runs on it until it can. */
export function topicRefusedNotice(language: Language, v: { name: string; cause: string }): string {
  const name = safeValue(v.name);
  const cause = word(language, v.cause);
  return language === "ru"
    ? says(language, `Чат ${name} не создан: ${cause}. Ничего не было сделано.`)
    : says(language, `The chat ${name} was not created: ${cause}. Nothing was done.`);
}

export interface ArchiveNoticeFacts {
  platform: string;
  name: string;
  chat: string | null;
  /** How the running work ended: stopped, finished with its result before the stop landed, or nothing was running. */
  stop: "stopped" | "finished" | "idle";
  /** Delegated jobs the master approved that are still running. They are not stopped. */
  delegated: number;
}

export function archiveDoneNotice(language: Language, v: ArchiveNoticeFacts): string {
  const chat = chatOf(v.platform, v.name, v.chat);
  if (language === "ru") {
    const stop = v.stop === "stopped" ? "Агент остановлен" : v.stop === "finished" ? "Агент уже закончил свой ответ" : "Агент не работал";
    return says(language, `${chat} в архиве. ${stop}, чат доступен только для чтения. История сохранена, чат можно вернуть в любой момент.` +
      (v.delegated > 0 ? ` Уже запущенные поручения (${v.delegated}) продолжают работать, их результаты дождутся, пока вы не откроете чат.` : ""));
  }
  const stop = v.stop === "stopped" ? "The agent is stopped" : v.stop === "finished" ? "The agent had already finished its answer" : "The agent was not working";
  return says(language, `${chat} is archived. ${stop} and the chat is read only. Its history is kept, and you can reopen it any time.` +
    (v.delegated > 0 ? ` ${v.delegated} delegated job${v.delegated === 1 ? "" : "s"} you already approved keep running, and the result${v.delegated === 1 ? "" : "s"} will wait until you reopen the chat.` : ""));
}

/** Archiving has not finished, and what it is waiting for. Said once for each reason. */
export function archivePendingNotice(language: Language, v: { platform: string; name: string; chat: string | null; reason: "stop_unknown" | "channel_failed" | "channel_unreadable" }): string {
  const chat = chatOf(v.platform, v.name, v.chat);
  if (language === "ru") {
    const reason = v.reason === "stop_unknown" ? "не удалось убедиться, что процесс агента остановился"
      : v.reason === "channel_failed" ? "Discord не позволил переместить или закрыть канал" : "не удалось прочитать состояние канала";
    return says(language, `Архивация ${chat} не завершена: ${reason}. Пока это не выяснено, чат остаётся как есть, а агент новых задач не берёт.`);
  }
  const reason = v.reason === "stop_unknown" ? "the agent's process is not shown to have stopped"
    : v.reason === "channel_failed" ? "Discord did not let the channel be moved or locked" : "the channel could not be read";
  return says(language, `Archiving ${chat} has not finished: ${reason}. Until it is sorted out the chat stays as it is and the agent takes no new work.`);
}

export interface ReopenNoticeFacts {
  platform: string;
  name: string;
  chat: string | null;
  /** What was found changed by somebody else after the archive, and so was left as it is. */
  left: string[];
  /** Interrupted inputs still waiting for the owner's choice. */
  held: number;
}

export function reopenDoneNotice(language: Language, v: ReopenNoticeFacts): string {
  const chat = chatOf(v.platform, v.name, v.chat);
  const left = v.left.map(one => safeValue(one)).join(", ");
  if (language === "ru") {
    return says(language, `${chat} снова открыт. Сообщения, которые ждали, будут обработаны.` +
      (v.left.length > 0 ? ` Я не менял то, что изменили после архивации: ${left}.` : "") +
      (v.held > 0 ? ` Прерванная работа ждёт вашего решения: сама она не продолжится.` : ""));
  }
  return says(language, `${chat} is open again. Messages that waited will be handled now.` +
    (v.left.length > 0 ? ` I left as it is what was changed after it was archived: ${left}.` : "") +
    (v.held > 0 ? ` Interrupted work is waiting for your choice, and it will not continue on its own.` : ""));
}

/** The chat is gone from Discord. Nothing is erased: erasing is a separate request that the owner confirms. */
export function channelMissingNotice(language: Language, v: { name: string }): string {
  const name = safeValue(v.name);
  return language === "ru"
    ? says(language, `Чат ${name} удалён в Discord. Агент и его история остались здесь, ничего не стёрто, а новых задач агент не берёт. ` +
      "Чтобы удалить агента и историю, попросите об этом здесь и подтвердите: до подтверждения ничего не стирается.")
    : says(language, `The chat ${name} was deleted in Discord. Its agent and history are still here and nothing was erased, and the agent takes no new work. ` +
      "To delete them, ask for it here and confirm: nothing is erased before you confirm.");
}

/** Delegated results that arrived for an archived chat's agent. They are kept, and wait for a reopen. */
export function archivedResultsNotice(language: Language, v: { name: string; count: number }): string {
  const name = safeValue(v.name);
  return language === "ru"
    ? says(language, `Для архивного чата ${name} пришли результаты поручений: ${v.count}. Они сохранены, агент прочтёт их, когда вы откроете чат.`)
    : says(language, `${v.count} result${v.count === 1 ? "" : "s"} arrived for ${name}, which is archived. ${v.count === 1 ? "It is" : "They are"} kept, and the agent will read ${v.count === 1 ? "it" : "them"} if you reopen the chat.`);
}

/** Where a topic stands now, in the words a catch-up says it in. */
export type CatchupState = "open" | "archiving" | "archived" | "reopening" | "gone" | "setting_up";

export interface CatchupFacts {
  platform: string;
  name: string;
  /** The chat, only while it still exists to be mentioned. */
  chat: string | null;
  /** The kinds of notice that could not be told, as they were recorded. */
  kinds: string[];
  /** What a council in this chat needed to say, in clauses (`needWords`), when it could not be said. */
  councils?: string[];
  /** Where the topic stands NOW: the matter may have been settled since. */
  state: CatchupState;
}

const MISSED_EN: Record<string, string> = {
  ready: "it was set up",
  missing: "its chat was reported deleted in Discord",
  "archive-done": "it was archived",
  "reopen-done": "it was reopened",
  "archive-pending": "its archiving was waiting on Discord or on its agent to stop",
  "reopen-pending": "its reopening was waiting on Discord",
  results: "results arrived for it while it was archived",
  "create-failed": "creating it stopped",
  "create-unknown": "I could not confirm whether its channel was created",
  "adopt-refused": "the channel you named for it could not be used",
  "bind-failed": "connecting its agent stopped",
};
const MISSED_RU: Record<string, string> = {
  ready: "он был настроен",
  missing: "его чат был удалён в Discord",
  "archive-done": "он был архивирован",
  "reopen-done": "он был открыт снова",
  "archive-pending": "архивация ждала Discord или остановки агента",
  "reopen-pending": "повторное открытие ждало Discord",
  results: "пришли результаты, пока он был в архиве",
  "create-failed": "создание остановилось",
  "create-unknown": "не удалось выяснить, создан ли канал",
  "adopt-refused": "канал, который вы назвали, использовать было нельзя",
  "bind-failed": "подключение агента остановилось",
};
const NOW_EN: Record<CatchupState, string> = {
  open: "it is open",
  archiving: "it is being archived, and the agent takes no new work",
  archived: "it is archived: read only, its history is kept, and you can reopen it any time",
  reopening: "it is being reopened",
  gone: "its chat is deleted in Discord; its agent and history are kept, nothing was erased, and the agent takes no new work",
  setting_up: "it is still being set up",
};
const NOW_RU: Record<CatchupState, string> = {
  open: "он открыт",
  archiving: "он архивируется, новых задач агент не берёт",
  archived: "он в архиве: только чтение, история сохранена, его можно вернуть в любой момент",
  reopening: "он открывается снова",
  gone: "его чат удалён в Discord; агент и история остались, ничего не стёрто, новых задач агент не берёт",
  setting_up: "он ещё настраивается",
};

/**
 * What could not be told earlier, told now, once. It names WHAT was missed and where the chat STANDS NOW, and it is honest
 * about being a summary that is only queued: it says nothing of the original notice having reached anyone, and asks nothing
 * that was settled since (a chat that was deleted and repaired is not asked about again).
 */
export function attentionCatchupNotice(language: Language, v: CatchupFacts): string {
  const chat = chatOf(v.platform, v.name, v.chat);
  const known = language === "ru" ? MISSED_RU : MISSED_EN;
  const councils = [...new Set(v.councils ?? [])];
  const said = language === "ru" ? "совету в нём был нужен ваш ответ" : "a council in it needed you";
  const what = [
    ...v.kinds.map(kind => (Object.hasOwn(known, kind) ? known[kind] : safeValue(kind))),
    ...(councils.length > 0 ? [`${said} (${councils.map(one => safeValue(one)).join("; ")})`] : []),
  ].join("; ");
  const now = (language === "ru" ? NOW_RU : NOW_EN)[v.state];
  return language === "ru"
    ? says(language, `О ${chat} раньше не удалось вам сообщить: ${what}. Это краткая сводка пропущенного, а не само исходное сообщение; она поставлена в очередь сейчас. Сейчас: ${now}.`)
    : says(language, `I could not tell you earlier about ${chat}: ${what}. This is a summary of what was missed, not the original message, and it is queued now. Right now ${now}.`);
}

/** The archive or reopen cannot be said where it was asked, and there is no General to say it in. Kept on the operation and in check. */
export function generalMissingNotice(language: Language, v: { name: string }): string {
  const name = safeValue(v.name);
  return language === "ru"
    ? says(language, `Про чат ${name} нужно ваше внимание, но General не настроен, и сказать больше некуда.`)
    : says(language, `${name} needs your attention, but no General is configured to say it in.`);
}
