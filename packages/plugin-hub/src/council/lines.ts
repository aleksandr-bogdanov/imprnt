import { MACHINERY_LINES, safeValue, type Language } from "../door/lines.ts";
import { CONFIRM_EMOJI } from "../store/confirmations.ts";
import { causeForOwner } from "./causes.ts";
import type { CouncilSnapshot, MemberSnapshot, MemberView, Stage } from "./snapshot.ts";

/**
 * Everything a person reads about a council, in both languages, in one place: the card that
 * is edited in place, the attention notices, the frozen preview an agent's proposal shows and the
 * line an unreachable General is said in. Pure: every sentence is a function of a snapshot the
 * store read, so the card, the notices and `inspect` cannot disagree, and a restarted door builds
 * the same card again.
 *
 * NOTHING HERE DIAGNOSES. A worker with no output is "no output observed", never "stuck" or
 * "failed"; a long-running one is "still running"; a missing one is named with the cause the
 * store recorded and only that. What the owner may do is said as a choice, and nothing
 * here says that anything will happen without their word.
 */

/** A message on the platform holds at most this much, less its marker line. The card stays well inside it. */
const CARD_LIMIT = 1700;

const STAGE: Record<Language, Record<Stage, string>> = {
  en: {
    "workers-running": "workers running",
    "waiting-machine": "waiting for the machine",
    "waiting-capacity": "waiting for room on the machine",
    "waiting-master": "waiting for the master",
    "assessing-next-round": "the master is deciding what comes next",
    "preparing-result": "the master is writing the result",
    "waiting-owner": "waiting for you",
    stopping: "stopping",
    stopped: "stopped",
    complete: "complete",
  },
  ru: {
    "workers-running": "участники работают",
    "waiting-machine": "ждём машину",
    "waiting-capacity": "ждём свободное место на машине",
    "waiting-master": "ждём мастера",
    "assessing-next-round": "мастер решает, что дальше",
    "preparing-result": "мастер пишет итог",
    "waiting-owner": "ждём вашего решения",
    stopping: "останавливаем",
    stopped: "остановлен",
    complete: "готово",
  },
};

/** How long ago, in the coarsest whole unit that is not zero, so a card does not change every tick. */
function ago(language: Language, seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return language === "ru" ? "меньше минуты" : "under a minute";
  return language === "ru" ? `${minutes} мин` : `${minutes} min`;
}

function capacity(language: Language, wait: Record<string, unknown> | null): string {
  if (wait?.kind === "memory") {
    return language === "ru"
      ? `память машины занята: ${safeValue(wait.used_mb)} из ${safeValue(wait.budget_mb)} МБ`
      : `the machine's memory is in use: ${safeValue(wait.used_mb)} of ${safeValue(wait.budget_mb)} MB`;
  }
  const held = Number(wait?.held_for_master ?? 0) > 0;
  if (wait?.conflict === true) {
    return language === "ru"
      ? `лимиты машины не оставляют места для участника рядом с мастером (всего мест: ${safeValue(wait.count)}); нужно увеличить лимит`
      : `the machine's limits leave no room for a participant beside the master (${safeValue(wait.count)} in all); the limit needs raising`;
  }
  return language === "ru"
    ? `все места на машине заняты (${safeValue(wait?.count)})${held ? ", одно оставлено для мастера" : ""}`
    : `every slot on the machine is in use (${safeValue(wait?.count)})${held ? ", one is kept free for the master" : ""}`;
}

const MEMBER: Record<Language, Record<MemberView, string>> = {
  en: {
    queued: "queued", "waiting-machine": "waiting for its machine", "waiting-capacity": "waiting for room",
    "waiting-retry": "waiting to try again", starting: "starting", running: "running", quiet: "running",
    answered: "answered", missing: "missing", cancelled: "cancelled", correcting: "stopping to take your correction",
    stopping: "stopping", stopped: "stopped", omitted: "left out by your choice",
  },
  ru: {
    queued: "в очереди", "waiting-machine": "ждёт свою машину", "waiting-capacity": "ждёт свободное место",
    "waiting-retry": "ждёт следующей попытки", starting: "запускается", running: "работает", quiet: "работает",
    answered: "ответил", missing: "нет ответа", cancelled: "отменён", correcting: "останавливается, чтобы принять правку",
    stopping: "останавливается", stopped: "остановлен", omitted: "исключён по вашему решению",
  },
};

function memberLine(language: Language, one: MemberSnapshot, options: { detail: boolean }, now: Date): string {
  const head = `• ${safeValue(one.name)}: ${MEMBER[language][one.view]}`;
  if (one.view === "waiting-machine") return `${head}${one.wait?.machine ? ` (${safeValue(one.wait.machine)})` : ""}`;
  if (one.view === "waiting-capacity") return `${head}: ${capacity(language, one.wait)}`;
  if (one.view === "missing") return `${head}: ${causeForOwner(language, one.cause)}`;
  if (one.view === "running" || one.view === "quiet") {
    if (!options.detail) return head;
    const since = one.activity_at !== null ? Math.max(0, Math.round((now.getTime() - Date.parse(one.activity_at)) / 1000)) : one.running_seconds;
    if (one.view === "quiet") {
      return language === "ru"
        ? `${head}, вывода нет уже ${ago(language, since ?? 0)}`
        : `${head}, no output observed for ${ago(language, since ?? 0)}`;
    }
    const seen = one.activity_at === null ? "" : language === "ru"
      ? `, последний вывод ${ago(language, since ?? 0)} назад${one.activity ? ` (${safeValue(one.activity).slice(0, 60)})` : ""}`
      : `, last output ${ago(language, since ?? 0)} ago${one.activity ? ` (${safeValue(one.activity).slice(0, 60)})` : ""}`;
    return `${head}${seen}`;
  }
  return head;
}

const ROUND = (language: Language, s: CouncilSnapshot): string => language === "ru"
  ? `раунд ${s.round} · вопрос v${s.question_revision}`
  : `round ${s.round} · question v${s.question_revision}`;

function counts(language: Language, s: CouncilSnapshot): string {
  return language === "ru" ? `ответили ${s.answered} из ${s.required}` : `${s.answered} of ${s.required} answered`;
}

/**
 * The card: topic, round and revision, stage, how many have answered, elapsed time, each
 * participant with what was last seen of it, and what the owner is being waited on for. A
 * waiting-owner gate and running participants are shown together, because both are true.
 */
export function statusLine(language: Language, s: CouncilSnapshot, now: Date = new Date()): string {
  const build = (detail: boolean, cap: number): string => {
    const lines: string[] = [];
    lines.push(`${MACHINERY_LINES[language]} ${language === "ru" ? "Совет" : "Council"}: ${safeValue(s.label)}`);
    lines.push([ROUND(language, s), STAGE[language][s.stage], counts(language, s), ago(language, s.elapsed_seconds)].join(" · "));
    const shown = s.members.slice(0, cap);
    for (const one of shown) lines.push(memberLine(language, one, { detail }, now));
    if (s.members.length > shown.length) {
      lines.push(language === "ru" ? `… и ещё ${s.members.length - shown.length}` : `… and ${s.members.length - shown.length} more`);
    }
    const missing = s.members.filter(one => one.view === "missing");
    if (s.stage === "waiting-owner" && missing.length > 0) {
      lines.push(language === "ru"
        ? "Нужно ваше решение: подождать, повторить, заменить, взять имеющиеся ответы или остановить совет. Без вашего слова ничего не перезапускается."
        : "Waiting for your choice: wait, retry, replace, use the available answers or stop the council. Nothing is rerun without your word.");
    } else if (s.stage === "waiting-owner" && s.waiting?.kind === "checkpoint") {
      lines.push(language === "ru"
        ? "Ваша правка сохранена, устаревшая работа остановлена или останавливается. Исправленное задание не начнётся, пока вы не продлите контрольную отметку."
        : "Your correction is saved and the outdated work has been stopped or is stopping. The corrected work does not start until you extend the checkpoint.");
    } else if (s.stage === "waiting-owner" && s.waiting?.kind === "legacy_unmerged") {
      lines.push(language === "ru"
        ? "Все ответы получены, но прежний совет не написал итог. Итог не создаётся сам: решите, что делать."
        : "Every answer is in, but the earlier council never wrote its result. None is made on its own: say what to do.");
    }
    if (s.master === "interrupted") {
      lines.push(language === "ru" ? "Последний ход мастера по этому совету не завершился." : "The master's last turn on this council did not finish.");
    }
    // The master's turn was settled and the council still says it is writing the result: a result that was not recorded, said plainly (and by `check`).
    if (s.stage === "preparing-result" && s.master === "idle") {
      lines.push(language === "ru"
        ? "Ход мастера завершён, но итог совета не записан. Это отмечено в проверке; ничего не будет отправлено повторно."
        : "The master's turn has ended and the council's result was not recorded. `check` reports it; nothing will be sent again.");
    }
    if (s.checkpoint.reached && !["complete", "stopped"].includes(s.stage)) {
      lines.push(language === "ru"
        ? "Контрольная отметка пройдена: идущий раунд можно доработать, а новый начнётся только с вашего согласия."
        : "The checkpoint has passed: the round in progress may finish, but another round needs your OK.");
    }
    return lines.join("\n");
  };
  for (const [detail, cap] of [[true, 12], [false, 12], [false, 6], [false, 3]] as const) {
    const text = build(detail, cap);
    if (text.length <= CARD_LIMIT) return text;
  }
  return build(false, 0).slice(0, CARD_LIMIT);
}

/** The card's stage as a token that changes only when the stage does: the door edits at once on a change of it. */
export function stageKey(s: CouncilSnapshot): string {
  return `${s.stage}:${s.round}:${s.question_revision}:${s.answered}/${s.required}:${s.members.filter(one => one.view === "missing").length}`;
}

// ---- notices --------------------------------------------------------------------------------------------------

const say = (language: Language, sentence: string): string => `${MACHINERY_LINES[language]} ${sentence}`;
const names = (list: readonly MemberSnapshot[]): string => list.map(one => safeValue(one.name)).join(", ");

/** One or more participants cannot be waited for. Said once for each new condition, with each cause. */
export function missingNotice(language: Language, s: Pick<CouncilSnapshot, "label">, missing: readonly MemberSnapshot[]): string {
  const causes = missing.map(one => `${safeValue(one.name)}: ${causeForOwner(language, one.cause)}`).join("; ");
  return say(language, language === "ru"
    ? `Совет «${safeValue(s.label)}»: нет ответа от ${names(missing)}. ${causes}. Остальные участники продолжают работать. Без вашего слова ничего не перезапускается, не заменяется и не исключается. Скажите мастеру, что делать: подождать, повторить, заменить, взять имеющиеся ответы или остановить совет.`
    : `Council "${safeValue(s.label)}": no answer from ${names(missing)}. ${causes}. The other participants keep working. Nothing is rerun, replaced or left out without your word. Tell the master what to do: wait, retry, replace, use the available answers, or stop the council.`);
}

export function quietNotice(language: Language, s: Pick<CouncilSnapshot, "label">, one: MemberSnapshot, minutes: number): string {
  return say(language, language === "ru"
    ? `Совет «${safeValue(s.label)}»: от ${safeValue(one.name)} уже ${minutes} мин нет вывода. Он всё ещё работает, ничего не остановлено. Скажите «остановить», если хотите завершить совет.`
    : `Council "${safeValue(s.label)}": no output observed from ${safeValue(one.name)} for ${minutes} min. It is still running and nothing was stopped. Say stop if you want the council ended.`);
}

export function overrunNotice(language: Language, s: Pick<CouncilSnapshot, "label">, one: MemberSnapshot, minutes: number): string {
  return say(language, language === "ru"
    ? `Совет «${safeValue(s.label)}»: ${safeValue(one.name)} работает над текущей попыткой уже ${minutes} мин. Он продолжает работу, ничего не остановлено и не перезапущено. Скажите «остановить», если хотите завершить совет.`
    : `Council "${safeValue(s.label)}": ${safeValue(one.name)} has been on its current attempt for ${minutes} min. It is still running and nothing was stopped or rerun. Say stop if you want the council ended.`);
}

export function checkpointNotice(language: Language, s: Pick<CouncilSnapshot, "label">, minutes: number): string {
  return say(language, language === "ru"
    ? `Совет «${safeValue(s.label)}»: прошла контрольная отметка (${minutes} мин). Идущий раунд можно доработать, но новый начнётся только с вашего согласия. Скажите, насколько продолжить: ещё один интервал или несколько раундов.`
    : `Council "${safeValue(s.label)}": the ${minutes}-minute checkpoint has passed. The round in progress may finish, but another round waits for your OK. Say how far to go: another interval, or a number of further rounds.`);
}

/** A correction is saved and waiting: its outdated work was stopped, and the corrected work starts only when the owner extends. */
export function correctionWaitingNotice(language: Language, s: Pick<CouncilSnapshot, "label">, names: string, minutes: number): string {
  return say(language, language === "ru"
    ? `Совет «${safeValue(s.label)}»: ваша правка сохранена, а устаревшая работа (${safeValue(names)}) остановлена или останавливается. Контрольная отметка (${minutes} мин) уже пройдена, поэтому исправленное задание начнётся только после вашего продления. Скажите, насколько продолжить: ещё один интервал или несколько раундов.`
    : `Council "${safeValue(s.label)}": your correction is saved and the outdated work (${safeValue(names)}) was stopped or is stopping. The ${minutes}-minute checkpoint has already passed, so the corrected work starts only after you extend it. Say how far to go: another interval, or a number of further rounds.`);
}

export function masterInterruptedNotice(language: Language, s: Pick<CouncilSnapshot, "label">): string {
  return say(language, language === "ru"
    ? `Совет «${safeValue(s.label)}»: последний ход мастера по этому совету не завершился, и совет ждёт мастера. Попросите его продолжить.`
    : `Council "${safeValue(s.label)}": the master's last turn on this council did not finish, and the council is waiting for the master. Ask it to carry on.`);
}

export function legacyUnmergedNotice(language: Language, s: Pick<CouncilSnapshot, "label">): string {
  return say(language, language === "ru"
    ? `Прежний совет «${safeValue(s.label)}» получил все ответы, но итог так и не был написан. Итог не создаётся сам: решите, что делать.`
    : `The earlier council "${safeValue(s.label)}" has every answer and never wrote its result. None is made on its own: say what to do.`);
}

export type Need = "members_missing" | "checkpoint" | "master_interrupted" | "stale_answers" | "legacy_unmerged" | "status_undelivered" | "quiet" | "overrun";

const NEED: Record<Language, Record<Need, string>> = {
  en: {
    members_missing: "a participant did not answer",
    checkpoint: "the checkpoint needs your decision",
    master_interrupted: "the master's turn on it did not finish",
    stale_answers: "an answer is for an earlier version of the question",
    legacy_unmerged: "an earlier council has every answer and no result",
    status_undelivered: "its status message cannot be shown in its chat",
    quiet: "a participant showed no output for a while",
    overrun: "a participant has been on one attempt for a long time",
  },
  ru: {
    members_missing: "участник не ответил",
    checkpoint: "нужно ваше решение на контрольной отметке",
    master_interrupted: "ход мастера по нему не завершился",
    stale_answers: "ответ относится к прежней версии вопроса",
    legacy_unmerged: "у прежнего совета есть все ответы, но нет итога",
    status_undelivered: "его сообщение о ходе работы нельзя показать в его чате",
    quiet: "от участника долго нет вывода",
    overrun: "участник слишком долго работает над одной попыткой",
  },
};

/** What a need is, in a clause: the words a catch-up uses for a council need that nobody could be told when it arose. */
export function needWords(language: Language, need: string): string | null {
  const known: Record<string, string> = NEED[language];
  return Object.hasOwn(known, need) ? known[need] : null;
}

/** The line in General: which council needs the owner, why, and where to go. */
export function generalNotice(language: Language, s: Pick<CouncilSnapshot, "label">, need: Need, link: string | null): string {
  return say(language, language === "ru"
    ? `Совету «${safeValue(s.label)}» нужен ваш ответ: ${NEED.ru[need]}.${link ? ` ${link}` : ""}`
    : `Council "${safeValue(s.label)}" needs you: ${NEED.en[need]}.${link ? ` ${link}` : ""}`);
}

/** Said in the council's own chat when there is no General to say it in: named, and not sent anywhere else. */
export function routingIssue(language: Language, s: Pick<CouncilSnapshot, "label">, need: Need): string {
  return say(language, language === "ru"
    ? `Совету «${safeValue(s.label)}» нужен ваш ответ (${NEED.ru[need]}), но для вас не настроен чат General, поэтому сказать об этом можно только здесь. Укажите чат General в реестре, и такие уведомления будут приходить в одно место.`
    : `Council "${safeValue(s.label)}" needs you (${NEED.en[need]}), but no General chat is configured for you, so this can only be said here. Set a General chat in the registry and such notices will come to one place.`);
}

// ---- the frozen preview of a council an agent proposes -----------------------------------------------------------

export interface ProposalView {
  question: string;
  context: readonly { text: string }[];
  debate: boolean;
  participants: readonly { worker_ref: string; preset_ref: string; machine: string; model: string; brief: string }[];
  proposer: { kind: "master" | "worker"; agent: string };
}

/** What the owner is shown to approve: exactly who takes part, on what, with what brief. Every field is what will be used. */
export function proposalPreview(language: Language, view: ProposalView): { preview: string; confirmation: string } {
  const ru = language === "ru";
  const lines = [
    ru ? `Предлагается совет${view.proposer.kind === "worker" ? ` (предложил рабочий агент ${safeValue(view.proposer.agent)})` : ""}` : `A council is proposed${view.proposer.kind === "worker" ? ` (proposed by the worker ${safeValue(view.proposer.agent)})` : ""}`,
    "", `${ru ? "Вопрос" : "Question"}: ${view.question}`,
    ...(view.context.length > 0 ? ["", ru ? "Контекст:" : "Context:", ...view.context.map((one, at) => `${at + 1}. ${one.text}`)] : []),
    "", ru ? "Участники:" : "Participants:",
    ...view.participants.flatMap((one, at) => [
      `${at + 1}. ${ru ? "Агент" : "Worker"}: ${one.worker_ref} · ${ru ? "Модель" : "Model"}: ${one.model} (${one.preset_ref}) · ${ru ? "Машина" : "Machine"}: ${one.machine}`,
      `   ${ru ? "Задание" : "Brief"}: ${one.brief}`,
    ]),
    "", `${ru ? "Дебаты" : "Debate"}: ${view.debate ? (ru ? "да, по вашему согласию" : "yes, as you agree here") : (ru ? "нет" : "no")}`,
  ];
  return {
    preview: lines.join("\n"),
    confirmation: ru ? `Поставьте ${CONFIRM_EMOJI}, чтобы запустить этот совет. Иначе он не начнётся.` : `React with ${CONFIRM_EMOJI} to start this council. Otherwise it does not start.`,
  };
}
