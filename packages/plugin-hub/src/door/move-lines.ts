import type { MoveFamily } from "../mcp/move-status.ts";
import type { MoveStage } from "../store/moves.ts";
import { MACHINERY_LINES, safeValue, type Language } from "./lines.ts";

/**
 * Every sentence a person reads about a move of a topic chat, in both languages, in one place: where an open move stands, and what
 * is said when it is withdrawn. Pure, so the words can change without any block or stage changing, and so a test can hold every
 * family of `mcp/move-status.ts` against both languages.
 *
 * THE SAME TWO RULES AS `topic-lines.ts`. A person reads what is happening and what they can do about it, in plain words: no
 * stage names, no codes, and never an id of a move, an agent or an attempt. A machine is named by the name the owner gave it and
 * a chat by its mention where the platform has one, by its name otherwise. And every line the machinery says into a chat is marked
 * as the door's (`moveWithdrawnNotice`); a status the model relays (`moveStatusLine`) is the model's to say and carries no marker.
 *
 * WHERE A LINE IS SAID DECIDES HOW IT NAMES THE CHAT AND WHAT IT OFFERS. A chat with no name of its own is "this chat" only in a
 * line that is delivered in that very chat (`inTopic`); said anywhere else (General's, or another route's) it is the chat being
 * moved, because "this chat" would there mean the chat the person is reading. And a move gates its agent: once the turn being
 * answered has ended, the topic's own chat takes no new message, so a line said there never offers a withdrawal or an answer as
 * available in that chat. It names the General chat that was measured to be usable (`general`) as where they are available, or,
 * when there is none, says that no chat can do it now.
 *
 * ONE SENTENCE OF WHERE THE MOVE STANDS, THEN ONLY THE NEXT STEPS THAT ARE REALLY AVAILABLE. A withdrawal is offered only while the
 * move can be withdrawn and no attempt of the agent is still owned; an answer about an interruption only while the move is waiting
 * on one and no attempt is owned; a reopen only for a chat that is archived (not one being archived, being reopened or gone);
 * "bring the machine online" only while the move waits on a machine that is not connected. A family that only its own side can
 * clear says so and promises nothing: nothing here retries, and no line says it will.
 *
 * A TURN THAT IS STILL FINISHING IS NOT A TURN THAT IS UNRESOLVED. A healthy turn is being answered and ends by itself. An attempt
 * the source has lost track of (`unknown`, `stop_unknown`), or any owned attempt while the source is not connected, may never end by
 * itself: it is said as unresolved, with the one thing that restores the observation (the source machine connected and reporting),
 * and never as something that will finish, be released or be replayed. Both refuse the same actions, as the store does.
 *
 * ABOUT `continue`: it records that the owner SAW the interruption the move stopped on, and puts the move back to waiting. It is not
 * the recovery choice about the interrupted work, which stays held and is decided separately, and no line here may word it as
 * resuming, releasing or replaying anything.
 */

/** The General chat a line points at, as the facts measured it: where it is, and nothing about the person. */
export interface GeneralRef {
  platform: string;
  chat: string;
}

export interface MoveLineFacts {
  /** The family of the block on the move, or null when it has none. */
  family: MoveFamily | null;
  stage: MoveStage;
  platform: string;
  name: string;
  /** The agent's own id, so that a chat whose only name IS that id is never said by it: it is an internal identity, not a name. */
  agent?: string;
  /** The chat, only while it exists to be mentioned. */
  chat: string | null;
  /** The machine it is on, and the machine it is being moved to. */
  source: string;
  dest: string;
  destLive: boolean;
  sourceLive: boolean;
  /** A healthy turn of the agent is still being answered: it ends by itself, before anything of the move can be withdrawn or acknowledged. */
  finishing: boolean;
  /** An attempt is owned that may never end by itself (lost track of, or the source is not connected): refuses what a finishing turn refuses. */
  unresolved?: boolean;
  /** The stage is one in which the owner may still withdraw. */
  withdrawable: boolean;
  /** Where the topic's chat stands. Only an archived chat is reopened. */
  chatState?: "open" | "archiving" | "archived" | "reopening" | "gone";
  /** The line is delivered in the topic's own chat. Absent is not: the chat being moved is then named neutrally. */
  inTopic?: boolean;
  /** For a line delivered in the topic's own chat: the General that is shown usable now, or null when none is. Absent is none. */
  general?: GeneralRef | null;
}

export type MoveAction = "withdraw" | "continue" | "reopen";

/** Whether anything of the move can be decided now: no attempt of the agent is owned, and the line is not said where nothing can be asked. */
const heldBy = (f: Pick<MoveLineFacts, "finishing" | "unresolved">): boolean => f.finishing || f.unresolved === true;
const nowhereToAsk = (f: Pick<MoveLineFacts, "inTopic" | "general">): boolean => f.inTopic === true && !f.general;

/** What the owner can actually do about this move now: the same list the model is given beside the sentence. */
export function moveActions(f: MoveLineFacts): MoveAction[] {
  const actions: MoveAction[] = [];
  if (f.stage === "awaiting_owner" && !heldBy(f) && !nowhereToAsk(f)) actions.push("continue");
  if (f.family === "archived" && f.chatState === "archived") actions.push("reopen");
  if (f.withdrawable && !heldBy(f) && !nowhereToAsk(f)) actions.push("withdraw");
  return actions;
}

/** What a chat with no name of its own is called, quoted so that it reads as a name in every grammatical place a sentence puts it. */
const GENERIC_CHAT: Record<Language, { here: string; elsewhere: string }> = {
  en: { here: "“this chat”", elsewhere: "“the chat being moved”" },
  ru: { here: "«этот чат»", elsewhere: "«переносимый чат»" },
};

/**
 * A chat by its platform mention where the platform has one, and by its name otherwise. An adopted chat's display name can be the
 * agent's own id (nothing else names it), and that is an identity and not something a person reads: it, and an empty name, are said
 * as the generic label of the person's language, "this chat" only where the line is delivered in that chat and the chat being moved
 * anywhere else. A name somebody really gave the chat is said as it is.
 */
const chatOf = (language: Language, platform: string, name: string, chat: string | null, agent?: string, inTopic?: boolean): string => {
  if (platform === "discord" && chat !== null) return `<#${chat}>`;
  const said = safeValue(name);
  return said === "" || (agent !== undefined && said === safeValue(agent)) ? GENERIC_CHAT[language][inTopic === true ? "here" : "elsewhere"] : said;
};

/** The General chat as a sentence names it, in the same grammatical place in both languages: its mention where the platform has one. */
const generalName = (g: GeneralRef | null | undefined): string | null =>
  g === null || g === undefined ? null : g.platform === "discord" ? `General (<#${g.chat}>)` : "General";

interface Names { chat: string; src: string; dst: string; general: string | null }

const CHAT_STATE_EN: Record<string, string> = {
  archived: "is archived", archiving: "is being archived", reopening: "is being reopened", gone: "was deleted in Discord",
};
const CHAT_STATE_RU: Record<string, string> = {
  archived: "в архиве", archiving: "архивируется", reopening: "открывается снова", gone: "удалён в Discord",
};

const FAMILY_EN: Record<MoveFamily, (n: Names, f: MoveLineFacts) => string> = {
  owner_unknown: n => `The move of ${n.chat} to ${n.dst} cannot go on: it is not known what was running on ${n.src} before the move was asked for, so nothing can be shown to be safe to carry over.`,
  archived: (n, f) => `The move of ${n.chat} to ${n.dst} is waiting because the chat ${CHAT_STATE_EN[f.chatState ?? ""] ?? "is not open"}.`,
  source_unproven: n => `The move of ${n.chat} to ${n.dst} is on hold: ${n.src} has not shown that everything of this chat has stopped there.`,
  destination_setup: n => `The move of ${n.chat} to ${n.dst} is on hold: ${n.dst} has not shown that it is set up to run this chat's agent the same way.`,
  engine_session: n => `The move of ${n.chat} to ${n.dst} is on hold: the engine's saved conversation could not be carried safely between ${n.src} and ${n.dst}.`,
  workspace_not_carried: n => `${n.chat} was not moved to ${n.dst}: a move carries only the conversation, and this chat depends on files or a workspace that it does not carry.`,
  registry: n => `The move of ${n.chat} to ${n.dst} is on hold at the last step: the registry could not be updated to place the chat on ${n.dst}.`,
  loaded_mismatch: n => `The move of ${n.chat} to ${n.dst} is on hold at the last step: ${n.dst} loaded the chat differently from what was prepared.`,
  other: n => `The move of ${n.chat} to ${n.dst} is on hold for a reason that has no wording of its own yet.`,
};

const FAMILY_RU: Record<MoveFamily, (n: Names, f: MoveLineFacts) => string> = {
  owner_unknown: n => `Перенос ${n.chat} на ${n.dst} не может продолжаться: неизвестно, что работало на ${n.src} до запроса, поэтому нельзя убедиться, что переносить безопасно.`,
  archived: (n, f) => `Перенос ${n.chat} на ${n.dst} ждёт: чат ${CHAT_STATE_RU[f.chatState ?? ""] ?? "не открыт"}.`,
  source_unproven: n => `Перенос ${n.chat} на ${n.dst} приостановлен: от машины ${n.src} нет подтверждения, что всё, что относится к этому чату, там остановлено.`,
  destination_setup: n => `Перенос ${n.chat} на ${n.dst} приостановлен: нет подтверждения, что машина ${n.dst} настроена запускать агента этого чата так же.`,
  engine_session: n => `Перенос ${n.chat} на ${n.dst} приостановлен: сохранённый разговор движка нельзя безопасно перенести между машинами ${n.src} и ${n.dst}.`,
  workspace_not_carried: n => `${n.chat} не перенесён на ${n.dst}: перенос везёт только разговор, а этот чат зависит от файлов или рабочего пространства, которые он не переносит.`,
  registry: n => `Перенос ${n.chat} на ${n.dst} приостановлен на последнем шаге: не удалось обновить реестр, чтобы чат работал на ${n.dst}.`,
  loaded_mismatch: n => `Перенос ${n.chat} на ${n.dst} приостановлен на последнем шаге: машина ${n.dst} загрузила чат не так, как было подготовлено.`,
  other: n => `Перенос ${n.chat} на ${n.dst} приостановлен по причине, для которой пока нет отдельной формулировки.`,
};

/** Where a move with no block stands, by stage and by what is known of the machines and of the turn that is finishing. */
function stageSentence(language: Language, n: Names, f: MoveLineFacts): string {
  const ru = language === "ru";
  switch (f.stage) {
    case "waiting":
      if (f.unresolved === true) {
        return ru ? `Что ${n.chat} обрабатывал на ${n.src}, не прояснено: не видно, что это закончилось${f.sourceLive ? "" : `, а ${n.src} не подключена`}. Ничего нового там не обрабатывается, и перенос на ${n.dst} не может продолжаться, пока это не выяснится.`
          : `What ${n.chat} was answering on ${n.src} is unresolved: it has not been seen to end${f.sourceLive ? "" : `, and ${n.src} is not connected`}. Nothing new is handled there, and the move to ${n.dst} cannot go on until that is settled.`;
      }
      if (f.finishing) {
        return ru ? `Ответ, который ${n.chat} готовит сейчас, ещё не закончен: на ${n.src} ничего нового не обрабатывается, а перенос на ${n.dst} может начаться только после него.`
          : `The turn ${n.chat} is answering now is still finishing: nothing new is handled on ${n.src}, and the move to ${n.dst} can start only after it ends.`;
      }
      if (!f.destLive) {
        return ru ? `Ждём ${n.dst}: машина не подключена. ${n.chat} приостановлен, сообщения сохраняются; на другую машину ничего не переносится.`
          : `Waiting for ${n.dst}: it is not connected. ${n.chat} is held and its messages are kept; nothing moves to another machine.`;
      }
      if (!f.sourceLive) {
        return ru ? `Ждём машину ${n.src}: она не подключена, поэтому передать ${n.chat} пока нельзя. Сообщения сохраняются.`
          : `Waiting for ${n.src}: it is not connected, so ${n.chat} cannot be handed over yet. Messages are kept.`;
      }
      return ru ? `Ждём ${n.dst}, чтобы принять ${n.chat}. Чат приостановлен, сообщения сохраняются.`
        : `Waiting for ${n.dst} to take ${n.chat} over. It is held, and its messages are kept.`;
    case "awaiting_owner":
      return ru ? `Работа в ${n.chat} была прервана, пока перенос на ${n.dst} ждал, и перенос приостановлен, пока вы не увидите это.`
        : `Work in ${n.chat} was interrupted while it waited to move to ${n.dst}, and the move is paused until you have seen that.`;
    case "source_released":
      return ru ? `${n.chat} передан с машины ${n.src} и настраивается на ${n.dst}.` : `${n.chat} has been handed off by ${n.src} and is being set up on ${n.dst}.`;
    case "importing":
      return ru ? `${n.chat} настраивается на ${n.dst}.` : `${n.chat} is being set up on ${n.dst}.`;
    case "activated":
    case "registry_written":
      return ru ? `${n.chat} уже закреплён за ${n.dst} и переключается там.` : `${n.chat} is placed on ${n.dst} and is being switched over there.`;
    case "active":
      return ru ? `${n.chat} теперь работает на ${n.dst}.` : `${n.chat} now runs on ${n.dst}.`;
    case "withdrawn":
      return ru ? `Перенос ${n.chat} на ${n.dst} отозван; чат остаётся на ${n.src}.` : `The move of ${n.chat} to ${n.dst} was withdrawn; it stays on ${n.src}.`;
  }
}

/**
 * The step for an attempt that is unresolved: the one thing that restores the observation, said without a promise. A source that is
 * not connected is brought online; a source that is connected has to report on it again, which nothing here can make it do.
 */
function unresolvedStep(language: Language, src: string, sourceLive: boolean): string {
  return language === "ru"
    ? `${sourceLive ? `Пока ${src} снова не сообщит об этом` : `Подключите ${src}, чтобы снова можно было увидеть, что с этим стало; пока оттуда нет сведений`}, перенос нельзя ни отозвать, ни продолжить. Ничего не повторяется за вас.`
    : `${sourceLive ? `Until ${src} reports on it again` : `Bring ${src} online so that it can be observed again; until it reports on it`}, the move can neither be withdrawn nor go on. Nothing is retried for you.`;
}

/** The steps that are available now, one sentence each, and only those. */
function nextSteps(language: Language, n: Names, f: MoveLineFacts): string[] {
  const ru = language === "ru";
  const can = moveActions(f);
  const steps: string[] = [];
  // Said in the topic's own chat, which stops taking messages once the turn now being answered ends: what can be asked is asked in General.
  const gated = f.inTopic === true && f.stage !== "active" && f.stage !== "withdrawn";
  if (gated) {
    steps.push(n.general === null
      ? (ru ? "Пока перенос ждёт, этот чат не принимает новых сообщений, как только закончится ход, который идёт сейчас, и сейчас нет чата General, про который известно, что он доступен, поэтому ни узнать о переносе, ни отозвать его не из чего."
        : "While the move waits, this chat takes no new message once the turn being answered now has ended, and no General chat is shown to be usable right now, so there is no chat to check on the move or withdraw it from.")
      : (ru ? `Пока перенос ждёт, этот чат не принимает новых сообщений, как только закончится ход, который идёт сейчас, поэтому спрашивайте о переносе в ${n.general}.`
        : `While the move waits, this chat takes no new message once the turn being answered now has ended, so ask about the move in ${n.general}.`));
  }
  const there = gated && n.general !== null ? (ru ? ` в ${n.general}` : ` in ${n.general}`) : "";
  if (can.includes("continue")) {
    steps.push(ru ? `${there === "" ? "Скажите" : `В ${n.general} скажите`}, что вы это увидели, и перенос вернётся к ожиданию; прерванную работу это не продолжает, она остаётся удержанной, и вы решаете о ней отдельно.`
      : `${there === "" ? "Tell" : `In ${n.general}, tell`} me you have seen it and the move goes back to waiting; that does not continue the interrupted work, which stays held until you decide about it separately.`);
  }
  if (can.includes("reopen")) steps.push(ru ? "Откройте чат снова, чтобы перенос мог продолжиться." : "Reopen the chat to let the move go on.");
  if (f.family === null && f.stage === "waiting" && !heldBy(f) && !f.destLive) {
    steps.push(ru ? `Подключите ${n.dst}, чтобы перенос продолжился.` : `Bring ${n.dst} online to let it go on.`);
  }
  // A family only its own side can clear is said as it is: nothing is retried and nothing is promised.
  if (f.family !== null && f.family !== "owner_unknown" && f.family !== "archived" && f.stage !== "awaiting_owner") {
    steps.push(ru ? "Пока это не устранено там, перенос остаётся на паузе. Ничего не повторяется за вас." : "It stays on hold until that is sorted out there. Nothing is retried for you.");
  }
  if (can.includes("withdraw")) {
    steps.push(f.family === "owner_unknown"
      ? (ru ? `Единственный путь — отозвать перенос${there}, и ${n.chat} останется на ${n.src}.` : `The only way forward is to withdraw the move${there}, and ${n.chat} stays on ${n.src}.`)
      : (ru ? `Перенос можно отозвать${there}, и ${n.chat} останется на ${n.src}.` : `You can withdraw the move${there}, and ${n.chat} stays on ${n.src}.`));
  } else if (f.unresolved === true && (f.withdrawable || f.stage === "awaiting_owner")) {
    steps.push(unresolvedStep(language, n.src, f.sourceLive));
  } else if (f.finishing && (f.withdrawable || f.stage === "awaiting_owner")) {
    steps.push(ru ? `Отозвать перенос или ответить о прерывании можно будет, когда закончится ход, который ещё идёт${there === "" ? "" : `, и делается это${there}`}.`
      : `Withdrawing the move, or telling me you have seen an interruption, has to wait until the turn that is still finishing has ended${there === "" ? "" : `, and is then done${there}`}.`);
  } else if (!f.withdrawable && f.stage !== "active" && f.stage !== "withdrawn") {
    steps.push(ru ? "Отозвать перенос уже нельзя." : "It is past the point of withdrawal.");
  }
  return steps;
}

/**
 * Where an open move stands, in the person's language: one sentence, then the next steps that are available. A block's family says
 * why it waits; with no block, the stage and what is known of the machines and of the turn that is finishing say it. An interruption
 * the move stopped on is what is said first at that stage, whatever else is noted on it.
 */
export function moveStatusLine(language: Language, f: MoveLineFacts): string {
  const names: Names = { chat: chatOf(language, f.platform, f.name, f.chat, f.agent, f.inTopic), src: safeValue(f.source), dst: safeValue(f.dest), general: generalName(f.general) };
  const table = language === "ru" ? FAMILY_RU : FAMILY_EN;
  const lead = f.family !== null && f.stage !== "awaiting_owner" ? table[f.family](names, f) : stageSentence(language, names, f);
  return [lead, ...nextSteps(language, names, f)].join(" ");
}

/** Why there is no General that a move can be followed and withdrawn from, as MEASURED: the reason, and the one detail its words need. */
export type GeneralReason = "no_general" | "general_is_the_topic" | "owner_not_in_general" | "general_binding_changed" | "general_not_open"
  | "general_moving" | "general_gated" | "general_asleep" | "general_runner_offline" | "general_door_off" | "general_door_offline";
export type GeneralState = "archived" | "archiving" | "reopening" | "gone" | "not_set_up" | "closed";
export interface RecoveryCause {
  reason: GeneralReason;
  /** Why General's chat is not open. */
  state?: GeneralState;
  /** The machine General's runner or door is on, for one that is not connected. */
  machine?: string;
}

/** Why a request about a move was refused, in the person's words. Each says that nothing was done and offers only what is really open. */
export type MoveRefusalKind = "turn_finishing" | "turn_unresolved" | "too_late" | "recovery_route" | "other_destination";

export interface RefusalFacts {
  platform: string;
  name: string;
  agent?: string;
  chat: string | null;
  source: string;
  dest: string;
  requested?: string;
  /** The source machine is connected (absent is connected). */
  sourceLive?: boolean;
  /** Said in the topic's own chat, and the General that is shown usable there, as in `MoveLineFacts`. */
  inTopic?: boolean;
  general?: GeneralRef | null;
  /** Why no General can follow the move (`recovery_route`). */
  cause?: RecoveryCause;
}

/**
 * The cause of `recovery_route` and what is really next, in one place, for the owner and (in English) for the model. It names the real
 * reason and the real next step, and never one that cannot be done: a deleted chat is not reopened, an archived one cannot be reopened
 * from another chat, and a chat that is only being archived or reopened is waited for. It is a limit of the current version, never an
 * owner restriction, and says so.
 */
export function recoveryReasonLine(language: Language, c: RecoveryCause): string {
  const ru = language === "ru";
  const machine = c.machine === undefined ? undefined : safeValue(c.machine);
  switch (c.reason) {
    case "no_general":
      return ru ? "Чат General не задан, а текущая версия может узнать о переносе и отозвать его только из такого чата. Задайте его в реестре и попросите снова."
        : "No General chat is configured, and the current version can only check on a move or withdraw it from one. Name one in the registry, then ask again.";
    case "general_is_the_topic":
      return ru ? "Это ваш чат General, а текущая версия может узнать о переносе и отозвать его только из другого чата. Сейчас с этим ничего не сделать."
        : "This is your General chat, and the current version can only check on a move or withdraw it from another chat. There is nothing to do about it now.";
    case "owner_not_in_general":
      return ru ? "У этого человека не настроен отправитель на двери вашего чата General, а о переносе спрашивают и отзывают его там. Настройте отправителя этого человека для двери General в реестре и попросите снова."
        : "This person has no sender configured on the door of your General chat, and a move is checked on and withdrawn there. Configure this person's sender for General's door in the registry, then ask again.";
    case "general_binding_changed":
      return ru ? "Реестр больше не закрепляет ваш General как обычный чат, а о переносе спрашивают и отзывают его там. Исправьте эту запись в реестре и попросите снова."
        : "The registry no longer binds your General as an ordinary chat of its own, and a move is checked on and withdrawn there. Correct that entry in the registry, then ask again.";
    case "general_not_open":
      switch (c.state) {
        case "archived":
          return ru ? "Ваш чат General в архиве, поэтому о переносе там не спросить и не отозвать его. Попросить о переносе можно будет, когда чат снова откроют; из другого чата попросить об этом через меня нельзя."
            : "Your General chat is archived, so a move cannot be checked on or withdrawn there. A move can be asked for once it is open again; reopening it cannot be asked for through me from another chat.";
        case "archiving":
          return ru ? "Ваш чат General архивируется, поэтому о переносе там не спросить и не отозвать его. Попросите снова, когда он будет открыт."
            : "Your General chat is being archived, so a move cannot be checked on or withdrawn there. Ask again once it is open.";
        case "reopening":
          return ru ? "Ваш чат General открывается снова. Попросите снова, когда это закончится." : "Your General chat is being reopened. Ask again once that is done.";
        case "gone":
          return ru ? "Ваш чат General удалён в Discord и не открывается снова. Реестр должен называть существующий чат General; после этого можно просить снова."
            : "Your General chat was deleted in Discord and cannot be reopened. The registry has to name a General chat that exists; then you can ask again.";
        case "not_set_up":
          return ru ? "Ваш чат General ещё не настроен. Попросите снова, когда он будет готов." : "Your General chat is not set up yet. Ask again once it is.";
        default:
          return ru ? "Ваш чат General сейчас не открыт. Попросите снова, когда он будет открыт." : "Your General chat is not open right now. Ask again once it is.";
      }
    case "general_moving":
      return ru ? "Ваш чат General сам переносится, а о переносе спрашивают и отзывают его там. Попросите снова, когда тот перенос закончится или будет отозван."
        : "Your General chat is itself being moved, and a move is checked on and withdrawn there. Ask again once that move has finished or been withdrawn.";
    case "general_gated":
      return ru ? "Агент вашего чата General удержан, пока идёт другое действие, и сейчас не отвечает. Попросите снова, когда оно закончится."
        : "Your General chat's agent is held while something else is under way, and takes no turn now. Ask again once that is over.";
    case "general_runner_offline":
      return ru ? `Машина, на которой работает ваш чат General${machine === undefined ? "" : ` (${machine})`}, не подключена, поэтому там некому ответить о переносе. Подключите её и попросите снова.`
        : `The machine your General chat runs on${machine === undefined ? "" : ` (${machine})`} is not connected, so nothing there can answer about a move. Bring it online and ask again.`;
    case "general_asleep":
      return ru ? "Агент вашего чата General спит, поэтому не ответит там о переносе. Разбудите его и попросите снова."
        : "Your General chat's agent is asleep, so it would not answer about a move there. Wake it, then ask again.";
    case "general_door_off":
      return ru ? `Дверь вашего чата General${machine === undefined ? "" : ` (на ${machine})`} выключена в реестре, поэтому сообщения из того чата не дойдут и о переносе там не спросить. Включите её и попросите снова.`
        : `The door of your General chat${machine === undefined ? "" : ` (on ${machine})`} is switched off in the registry, so messages in that chat do not reach anything and a move cannot be checked on there. Enable it, then ask again.`;
    case "general_door_offline":
      return ru ? `Дверь вашего чата General${machine === undefined ? "" : ` (на ${machine})`} не подключена, поэтому сообщения из того чата не дойдут и о переносе там не спросить. Подключите её и попросите снова.`
        : `The door of your General chat${machine === undefined ? "" : ` (on ${machine})`} is not connected, so messages in that chat do not reach anything and a move cannot be checked on there. Bring it online and ask again.`;
  }
}

/** What to do about a refusal that waits for a turn: asked again where it can be asked, or said that there is nowhere to ask. */
function askAgain(language: Language, v: RefusalFacts, ended: string): string {
  const ru = language === "ru";
  const g = generalName(v.general);
  if (v.inTopic === true && g === null) {
    return ru ? "сейчас нет чата General, про который известно, что он доступен, поэтому снова попросить не получится."
      : "no General chat is shown to be usable right now, so there is nowhere to ask again.";
  }
  const where = v.inTopic === true ? (ru ? ` в ${g}` : ` in ${g}`) : "";
  return ru ? `когда ${ended}, попросите снова${where}.` : `ask again${where} once ${ended}.`;
}

export function moveRefusalLine(language: Language, kind: MoveRefusalKind, v: RefusalFacts): string {
  const chat = chatOf(language, v.platform, v.name, v.chat, v.agent, v.inTopic);
  const src = safeValue(v.source);
  const dst = safeValue(v.dest);
  const asked = safeValue(v.requested ?? v.dest);
  const ru = language === "ru";
  switch (kind) {
    case "turn_finishing":
      return ru ? `Не сейчас: на ${src} ещё идёт ход ${chat}. Ничего не записано и не повторяется; ${askAgain(language, v, "он закончится")}`
        : `Not right now: a turn of ${chat} on ${src} is still finishing. Nothing was recorded and nothing is retried; ${askAgain(language, v, "it has ended")}`;
    case "turn_unresolved":
      return ru ? `Не сейчас: что ${chat} обрабатывал на ${src}, не прояснено, поэтому это сделать нельзя. Ничего не записано и не повторяется. ${unresolvedStep(language, src, v.sourceLive !== false)}`
        : `Not right now: what ${chat} was running on ${src} is unresolved, so this cannot be done. Nothing was recorded and nothing is retried. ${unresolvedStep(language, src, v.sourceLive !== false)}`;
    case "too_late":
      return ru ? `Отозвать уже нельзя: перенос ${chat} на ${dst} прошёл точку, после которой его отзывают, и завершается там.`
        : `It cannot be withdrawn any more: the move of ${chat} to ${dst} is past the point of withdrawal and is finishing there.`;
    case "recovery_route":
      if (v.cause !== undefined) {
        return ru ? `Переносить ${chat} пока не получится. ${recoveryReasonLine(language, v.cause)} Это ограничение текущей версии, а не ваше решение; ничего не начато.`
          : `${chat} cannot be moved yet. ${recoveryReasonLine(language, v.cause)} This is a limit of the current version and not a decision of yours; nothing was started.`;
      }
      return ru ? `Переносить ${chat} пока не получится: сейчас нет проверенного отдельного чата General, из которого можно было бы посмотреть перенос и отозвать его. Это ограничение текущей версии, а не ваше решение; ничего не начато.`
        : `${chat} cannot be moved yet: there is no General chat that is shown to be usable and independent, from which the move could be checked on and withdrawn. This is a limit of the current version and not a decision of yours; nothing was started.`;
    case "other_destination":
      // `dest` is where the open move goes and `requested` where the new request asked for: the open one is never changed on its own.
      return ru ? `${chat} уже переносится на ${dst}, а не на ${asked}, и перенос сам по себе не меняется. Ничего не изменено.`
        : `${chat} is already being moved to ${dst}, not to ${asked}, and a move is never changed on its own. Nothing was changed.`;
  }
}

/** The owner's withdrawal landed, said once in the chat they did not ask in. Marked as the door's. `inTopic`: that chat is the topic's own. */
export function moveWithdrawnNotice(language: Language, v: { platform: string; name: string; agent?: string; chat: string | null; source: string; dest: string; inTopic?: boolean }): string {
  const chat = chatOf(language, v.platform, v.name, v.chat, v.agent, v.inTopic);
  const src = safeValue(v.source);
  const dst = safeValue(v.dest);
  return `${MACHINERY_LINES[language]} ` + (language === "ru"
    ? `Перенос ${chat} на ${dst} отозван. Чат остаётся на ${src}, история сохранена, сообщения, которые ждали, будут обработаны там. Прерванная работа, если она есть, по-прежнему ждёт вашего решения.`
    : `The move of ${chat} to ${dst} was withdrawn. It stays on ${src}, its history is kept, and messages that waited are handled there. Interrupted work, if there is any, still waits for your choice.`);
}
