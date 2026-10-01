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
 * The one exception to "never an id" is an exact command the owner is meant to copy and send: the withdrawal names its move
 * (`/move withdraw <move-id>`), because a withdrawal that did not would choose its move by what happens to be open when it arrives.
 *
 * WHERE A LINE IS SAID DECIDES HOW IT NAMES THE CHAT AND WHAT IT OFFERS. A chat with no name of its own is "this chat" only in a
 * line that is delivered in that very chat (`inTopic`); said anywhere else (General's, or another route's) it is the chat being
 * moved, because "this chat" would there mean the chat the person is reading. And a move gates its agent: once the turn being
 * answered has ended, the topic's own chat takes no new message for the model, so a line said there points at the door's own
 * commands (`/move`, `/move withdraw` with the id of the move, and `/move seen` with the attempt and revision it answers), which the door reads itself and
 * which work whether or not any agent can run. A line said anywhere else offers the same steps as things to ask the assistant.
 *
 * WHERE THE HELD MESSAGES ARE ANSWERED IS NEVER PROMISED. A message kept while the move waits is answered on the destination if the
 * move goes through and on the source if it is withdrawn, so a line before the end of the move says both and a line after it says the one.
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

/** The interruption the move stopped on, as the owner's `/move seen` has to name it: the attempt and the recovery revision it was shown at. */
export interface FailureRef {
  attempt: string;
  revision: number;
}

export interface MoveLineFacts {
  /** The move's id: said only inside the exact withdrawal command a line delivered in the topic's own chat offers, and nowhere else. */
  move: string;
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
  /** The interruption the move stands on (stage `awaiting_owner`): what a line delivered in the topic's own chat names in `/move seen`. Absent: no such command is shown. */
  failure?: FailureRef | null;
}

export type MoveAction = "withdraw" | "continue" | "reopen";

/** Whether anything of the move can be decided now: no attempt of the agent is owned. */
const heldBy = (f: Pick<MoveLineFacts, "finishing" | "unresolved">): boolean => f.finishing || f.unresolved === true;

/** What the owner can actually do about this move now: the same list the model is given beside the sentence. */
export function moveActions(f: MoveLineFacts): MoveAction[] {
  const actions: MoveAction[] = [];
  if (f.stage === "awaiting_owner" && !heldBy(f)) actions.push("continue");
  if (f.family === "archived" && f.chatState === "archived") actions.push("reopen");
  if (f.withdrawable && !heldBy(f)) actions.push("withdraw");
  return actions;
}

/**
 * The door's own commands, in the person's language. The exact text is what a line shows and what `door/move-command.ts` reads, so the two
 * cannot drift: `seen` is never shown bare, because an acknowledgement is bound to the attempt and the revision the owner was shown, and
 * `withdraw` is never shown bare, because a withdrawal is bound to the move the owner was shown (the bare words only read the status).
 */
export const MOVE_COMMANDS: Record<Language, { status: string; withdraw: string; seen: string }> = {
  en: { status: "/move", withdraw: "/move withdraw", seen: "/move seen" },
  ru: { status: "/перенос", withdraw: "/перенос отозвать", seen: "/перенос принято" },
};

/** The exact acknowledgement command for the interruption a move stands on. */
export const seenCommand = (language: Language, failure: FailureRef): string => `${MOVE_COMMANDS[language].seen} ${failure.attempt} ${failure.revision}`;

/** The exact withdrawal command for one move. */
export const withdrawCommand = (language: Language, move: string): string => `${MOVE_COMMANDS[language].withdraw} ${move}`;

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

interface Names { chat: string; src: string; dst: string }

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
  config_differs: n => `The move of ${n.chat} to ${n.dst} is on hold: the agent's configuration is not shown to be the same on ${n.src} and ${n.dst}.`,
  source_workspace: n => `The move of ${n.chat} to ${n.dst} is on hold: ${n.src} has not shown that this chat's repositories are clean, on their declared branch and pushed.`,
  destination_workspace: n => `The move of ${n.chat} to ${n.dst} is on hold: ${n.dst} has not shown that this chat's repositories are clean and at exactly the handed-off commit.`,
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
  config_differs: n => `Перенос ${n.chat} на ${n.dst} приостановлен: нет подтверждения, что настройки агента одинаковы на ${n.src} и ${n.dst}.`,
  source_workspace: n => `Перенос ${n.chat} на ${n.dst} приостановлен: машина ${n.src} не подтвердила, что репозитории этого чата чистые, на нужной ветке и отправлены.`,
  destination_workspace: n => `Перенос ${n.chat} на ${n.dst} приостановлен: машина ${n.dst} не подтвердила, что репозитории этого чата чистые и ровно на переданном коммите.`,
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

/**
 * What a family needs from the owner, said as a step, for the families whose cause is in the person's own files and settings. Every one of
 * them says what has to be true and where, never that anything is done for the owner: nothing is changed, discarded, retried or replayed.
 */
const FAMILY_ACTION: Record<Language, Partial<Record<MoveFamily, (n: Names) => string>>> = {
  en: {
    source_workspace: n => `On ${n.src}, each declared repository has to be clean, on its declared branch and pushed: resolve or save the changes, push them, and let the sync finish. Nothing in the repositories is changed or retried for you.`,
    destination_workspace: n => `On ${n.dst}, each declared repository has to be clean and at exactly the handed-off commit: resolve any local changes there and let its sync catch up. Nothing is changed or retried for you.`,
    config_differs: n => `Make the agent's settings, tool servers and instructions the same on ${n.src} and ${n.dst} (the engine login and the hub's own server are not compared); no values are shown here. Nothing is changed or retried for you.`,
    workspace_not_carried: () => "Declare the repositories it uses, with sync enabled on both machines; files in the person's tree that are outside a declared repository are not carried. Nothing is changed or retried for you.",
  },
  ru: {
    source_workspace: n => `На ${n.src} каждый объявленный репозиторий должен быть чистым, на своей ветке и отправленным: разберитесь с изменениями или сохраните их, отправьте и дождитесь конца синхронизации. Ничего в репозиториях не меняется и не повторяется за вас.`,
    destination_workspace: n => `На ${n.dst} каждый объявленный репозиторий должен быть чистым и ровно на переданном коммите: разберитесь там с локальными изменениями и дождитесь, пока синхронизация догонит. За вас ничего не меняется и не повторяется.`,
    config_differs: n => `Сделайте настройки агента, серверы инструментов и инструкции одинаковыми на ${n.src} и ${n.dst} (вход в движок и собственный сервер хаба не сравниваются); значения здесь не показываются. За вас ничего не меняется и не повторяется.`,
    workspace_not_carried: () => "Объявите репозитории, которые он использует, с включённой синхронизацией на обеих машинах; файлы в дереве человека вне объявленного репозитория не переносятся. За вас ничего не меняется и не повторяется.",
  },
};

/** The steps that are available now, one sentence each, and only those. */
function nextSteps(language: Language, n: Names, f: MoveLineFacts): string[] {
  const ru = language === "ru";
  const can = moveActions(f);
  const steps: string[] = [];
  const cmd = MOVE_COMMANDS[language];
  // Said in the topic's own chat the owner reads the door's own commands; said anywhere else they are asked of the assistant.
  const inTopic = f.inTopic === true;
  const open = f.stage !== "active" && f.stage !== "withdrawn";
  if (inTopic && open) {
    // Messages kept while the move waits are answered after it ends, on the machine it ends on: the destination is promised only once the move is past withdrawal.
    const where = f.withdrawable
      ? (ru ? `на ${n.dst}, если перенос состоится, и на ${n.src}, если его отозвать` : `on ${n.dst} if it goes through, on ${n.src} if it is withdrawn`)
      : (ru ? `на ${n.dst}` : `on ${n.dst}`);
    steps.push(ru ? `Пока перенос ждёт, сообщения здесь сохраняются и обрабатываются после его окончания: ${where}. Напишите ${cmd.status} здесь, чтобы узнать, где перенос.`
      : `While the move waits, messages here are kept and answered after it ends: ${where}. Send ${cmd.status} here to see where it stands.`);
  }
  if (can.includes("continue")) {
    const exact = inTopic && f.failure ? seenCommand(language, f.failure) : null;
    if (!inTopic) {
      steps.push(ru ? "Скажите, что вы это увидели, и перенос вернётся к ожиданию; прерванную работу это не продолжает, она остаётся удержанной, и вы решаете о ней отдельно."
        : "Tell me you have seen it and the move goes back to waiting; that does not continue the interrupted work, which stays held until you decide about it separately.");
    } else if (exact !== null) {
      steps.push(ru ? `Напишите ${exact} здесь, и перенос вернётся к ожиданию; прерванную работу это не продолжает, она остаётся удержанной, и вы решаете о ней отдельно.`
        : `Send ${exact} here and the move goes back to waiting; that does not continue the interrupted work, which stays held until you decide about it separately.`);
    }
  }
  if (can.includes("reopen")) steps.push(ru ? "Откройте чат снова, чтобы перенос мог продолжиться." : "Reopen the chat to let the move go on.");
  if (f.family === null && f.stage === "waiting" && !heldBy(f) && !f.destLive) {
    steps.push(ru ? `Подключите ${n.dst}, чтобы перенос продолжился.` : `Bring ${n.dst} online to let it go on.`);
  }
  // A family only its own side can clear is said as it is: nothing is retried and nothing is promised. The ones that are about the person's
  // own files and settings say what has to be true instead.
  if (f.family !== null && f.family !== "owner_unknown" && f.family !== "archived" && f.stage !== "awaiting_owner") {
    const action = FAMILY_ACTION[language][f.family];
    steps.push(action !== undefined ? action(n)
      : ru ? "Пока это не устранено там, перенос остаётся на паузе. Ничего не повторяется за вас." : "It stays on hold until that is sorted out there. Nothing is retried for you.");
  }
  const exactWithdraw = withdrawCommand(language, f.move);
  const withdrawHere = inTopic ? (ru ? `, отправив ${exactWithdraw} здесь` : `, by sending ${exactWithdraw} here`) : "";
  if (can.includes("withdraw")) {
    steps.push(f.family === "owner_unknown"
      ? (ru ? `Единственный путь — отозвать перенос${withdrawHere}, и ${n.chat} останется на ${n.src}.` : `The only way forward is to withdraw the move${withdrawHere}, and ${n.chat} stays on ${n.src}.`)
      : (ru ? `Перенос можно отозвать${withdrawHere}, и ${n.chat} останется на ${n.src}.` : `You can withdraw the move${withdrawHere}, and ${n.chat} stays on ${n.src}.`));
  } else if (f.unresolved === true && (f.withdrawable || f.stage === "awaiting_owner")) {
    steps.push(unresolvedStep(language, n.src, f.sourceLive));
  } else if (f.finishing && (f.withdrawable || f.stage === "awaiting_owner")) {
    steps.push(ru ? `Отозвать перенос или ответить о прерывании можно будет, когда закончится ход, который ещё идёт${inTopic ? `; команду нужно отправить здесь ещё раз` : ""}.`
      : `Withdrawing the move, or answering an interruption, has to wait until the turn that is still finishing has ended${inTopic ? `; the command is then sent here again` : ""}.`);
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
  const names: Names = { chat: chatOf(language, f.platform, f.name, f.chat, f.agent, f.inTopic), src: safeValue(f.source), dst: safeValue(f.dest) };
  const table = language === "ru" ? FAMILY_RU : FAMILY_EN;
  const lead = f.family !== null && f.stage !== "awaiting_owner" ? table[f.family](names, f) : stageSentence(language, names, f);
  return [lead, ...nextSteps(language, names, f)].join(" ");
}

/** Why a request about a move was refused, in the person's words. Each says that nothing was done and offers only what is really open. */
export type MoveRefusalKind = "turn_finishing" | "turn_unresolved" | "too_late" | "other_destination";

export interface RefusalFacts {
  /** The move's id: said only inside the exact withdrawal command a refusal in the topic's own chat tells the owner to send again. */
  move: string;
  platform: string;
  name: string;
  agent?: string;
  chat: string | null;
  source: string;
  dest: string;
  requested?: string;
  /** The source machine is connected (absent is connected). */
  sourceLive?: boolean;
  /** Said in the topic's own chat, where the exact command is sent again (`retry`, the withdrawal's by default). */
  inTopic?: boolean;
  retry?: string;
}

/** What to do about a refusal that waits for a turn: asked again where it can be asked. In the topic's own chat the exact command is sent again. */
function askAgain(language: Language, v: RefusalFacts, ended: string): string {
  const ru = language === "ru";
  const command = v.retry ?? withdrawCommand(language, v.move);
  if (v.inTopic === true) return ru ? `когда ${ended}, отправьте ${command} здесь ещё раз.` : `send ${command} here again once ${ended}.`;
  return ru ? `когда ${ended}, попросите снова.` : `ask again once ${ended}.`;
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
    case "other_destination":
      // `dest` is where the open move goes and `requested` where the new request asked for: the open one is never changed on its own.
      return ru ? `${chat} уже переносится на ${dst}, а не на ${asked}, и перенос сам по себе не меняется. Ничего не изменено.`
        : `${chat} is already being moved to ${dst}, not to ${asked}, and a move is never changed on its own. Nothing was changed.`;
  }
}

/**
 * The move went through: said once, in the chat the move was asked in, by the destination's serve. Marked as the door's, and the chat is
 * named by its mention or its name and never by the agent's own id. "This chat" only where the notice lands in the topic's own chat.
 */
export function moveActiveNotice(language: Language, v: { platform: string; name: string; agent?: string; chat: string | null; source?: string; dest: string; inTopic?: boolean }): string {
  const chat = chatOf(language, v.platform, v.name, v.chat, v.agent, v.inTopic);
  const dst = safeValue(v.dest);
  return `${MACHINERY_LINES[language]} ` + (language === "ru"
    ? `${chat} теперь работает на ${dst}. Тот же разговор и та же история; сообщения, которые ждали, будут обработаны там.`
    : `${chat} now runs on ${dst}. Same conversation and history; messages that waited are answered there.`);
}

/**
 * The words of the door's own `/move` command that are not a standing: nothing is moving, the command was spelled wrong, or what it names
 * is not what the move stands on now. Each says that nothing was changed and what to send to see the truth, and none offers what is not open.
 */
export type MoveDoorKind = "none" | "usage" | "older_message" | "other_move" | "before_interruption" | "message_conflict" | "other_interruption" | "nothing_to_acknowledge";

export function moveDoorRefusalLine(language: Language, kind: MoveDoorKind): string {
  const ru = language === "ru";
  const cmd = MOVE_COMMANDS[language];
  const words = (() => {
    switch (kind) {
      case "none":
        return ru ? "В этом чате сейчас ничего не переносится." : "Nothing is being moved in this chat.";
      case "usage":
        return ru ? `${cmd.status} показывает, где перенос этого чата; ${cmd.withdraw} <id-переноса> отзывает именно этот перенос, пока чат не закреплён за другой машиной; ${cmd.seen} <попытка> <ревизия> отвечает на прерывание: берите точные команды из ответа на ${cmd.status}.`
          : `${cmd.status} shows where the move of this chat stands; ${cmd.withdraw} <move-id> withdraws that very move before the chat is placed on the other machine; ${cmd.seen} <attempt> <revision> answers an interruption: take the exact commands from the reply to ${cmd.status}.`;
      case "other_move":
        return ru ? `Этот перенос не относится к этому чату, поэтому ничего не изменено. Отправьте ${cmd.status}: там точная команда для текущего переноса.`
          : `That is not a move of this chat, so nothing was changed. Send ${cmd.status}: it shows the exact command for the move that is open.`;
      case "older_message":
        return ru ? `Это сообщение старше переноса, к которому оно относилось бы, или его время не удалось прочитать, поэтому ничего не изменено. Отправьте ${cmd.status}, чтобы увидеть, где перенос.`
          : `This message is older than the move it would act on, or its time cannot be read, so nothing was changed. Send ${cmd.status} to see where the move stands.`;
      case "before_interruption":
        return ru ? `Это сообщение отправлено раньше, чем вам показали прерывание, которое оно называет, поэтому оно не может на него отвечать, и ничего не записано. Отправьте ${cmd.status}: там точная команда; отправьте её новым сообщением.`
          : `This message was sent before the interruption it names was shown, so it cannot answer it, and nothing was recorded. Send ${cmd.status}: it shows the exact command; send that as a new message.`;
      case "message_conflict":
        return ru ? `Это сообщение уже было принято как другая команда, поэтому ничего не изменено. Отправьте ${cmd.status}, чтобы увидеть, где перенос.`
          : `This message was already taken as a different command, so nothing was changed. Send ${cmd.status} to see where the move stands.`;
      case "other_interruption":
        return ru ? `Перенос сейчас стоит не на этом прерывании, поэтому ничего не записано. Отправьте ${cmd.status}: там точная команда для текущего.`
          : `The move does not stand on that interruption now, so nothing was recorded. Send ${cmd.status}: it shows the exact command for the one it stands on.`;
      case "nothing_to_acknowledge":
        return ru ? "Перенос сейчас не ждёт ответа на прерывание, поэтому подтверждать нечего." : "The move is not waiting on an interruption, so there is nothing to acknowledge.";
    }
  })();
  return `${MACHINERY_LINES[language]} ${words}`;
}

/** What became of the owner's `/move seen`: it records only that they saw the interruption, and never resumes, releases or replays anything. */
export function moveSeenLine(language: Language, kind: "waiting" | "replay" | "awaiting_owner" | "superseded", standing: string): string {
  const ru = language === "ru";
  // `superseded`: these words were already answered, and the move has since stopped on another interruption, which the standing shows. Nothing was recorded now.
  if (kind === "superseded") {
    return `${MACHINERY_LINES[language]} ` + (ru
      ? `Это прерывание уже было подтверждено, а перенос теперь стоит на другом; сейчас ничего не записано. ${standing}`
      : `That interruption was already acknowledged, and the move now stands on another one; nothing was recorded now. ${standing}`);
  }
  const lead = kind === "awaiting_owner"
    ? (ru ? "Записано, но теперь стоит другое прерывание, и перенос снова на паузе." : "Recorded, but another interruption now stands and the move is paused again.")
    : (ru ? `${kind === "replay" ? "Это прерывание уже было подтверждено." : "Записано."} Перенос вернулся к ожиданию.` : `${kind === "replay" ? "That interruption was already acknowledged." : "Recorded."} The move is back to waiting.`);
  const rest = ru ? "Это лишь отметка, что вы увидели прерывание: прерванная работа не возобновлялась, не снималась с удержания и не повторялась, о ней вы решаете отдельно."
    : "This recorded only that you saw the interruption: the interrupted work was not resumed, released or replayed, and you decide about it separately.";
  return `${MACHINERY_LINES[language]} ${lead} ${rest} ${standing}`;
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
