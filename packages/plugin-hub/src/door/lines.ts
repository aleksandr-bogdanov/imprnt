/**
 * Every string a person reads, in both languages, in one place.
 *
 * One machinery marker for every line the hub writes into a chat, and it
 * names the door: L6 asks the line to say it is the door speaking, and the door
 * is the only piece of the hub a person ever meets. The marker is translated
 * with the sentence, because an English label inside Russian prose is a defect
 * under the copy rules this household already applies to its own products.
 *
 * A human reads or pastes it, so it is pinned WHOLE rather than
 * assembled from fragments, and the notices the RUNNER writes come from here
 * too, so one table is the whole vocabulary.
 */
export type Language = "en" | "ru";

/**
 * The marker, per language. It names the door, in the person's own words.
 *
 * EVERY TEMPLATE BELOW IS BUILT FROM IT. Spelling
 * the marker out again in each of the fourteen would make this constant a
 * second source of truth that could not drift into the strings it claims to
 * define, which is worse than having no constant at all.
 */
export const MACHINERY_LINES: Record<Language, string> = {
  en: "[door]",
  ru: "[дверь]",
};

function says(language: Language, sentence: string): string {
  return `${MACHINERY_LINES[language]} ${sentence}`;
}

type Stamp = "transcribed" | "acked" | "started" | "answered";

const CLOCK: Record<Language, Record<Stamp, (seconds: number) => string>> = {
  en: {
    // A voice note waiting for its own text. It belongs to this family rather
    // than to a function of its own, which is what lets `sayExpired`, the
    // expiry record and the ledger's ASCII stamp key serve a fourth clock with
    // no change at all.
    transcribed: (n) => `still transcribing your voice note. ${n} s so far.`,
    acked: (n) =>
      `still waiting: the loop has not accepted this message. ${n} s so far.`,
    started: (n) =>
      `still waiting: the agent has not started answering. ${n} s so far.`,
    answered: (n) => `still waiting: the turn has not ended. ${n} s so far.`,
  },
  ru: {
    transcribed: (n) =>
      `всё ещё расшифровываю голосовое сообщение. Прошло ${n} с.`,
    acked: (n) =>
      `всё ещё жду: агент не принял это сообщение. Прошло ${n} с.`,
    started: (n) => `всё ещё жду: агент не начал отвечать. Прошло ${n} с.`,
    answered: (n) => `всё ещё жду: ответ ещё не готов. Прошло ${n} с.`,
  },
};

/** A clock ran out, and the line says which one and how long it has been. */
export function clockLine(language: Language, stamp: string, seconds: number): string {
  return says(language, CLOCK[language][stamp as Stamp](seconds));
}

/**
 * Every reason a message can be waiting, as the runner and the store know it.
 * A closed list, and the line beside a clock line picks one of them, so a
 * person reads why and not only which step is late. What matches none of them
 * is `unknown`, which carries the raw state and is a `check` finding, so a
 * new kind of silence cannot hide behind a vague sentence.
 */
export const WAIT_REASONS = [
  "previous", "slots", "memory", "starting", "harvest", "retry", "login", "window", "off", "moving", "runner-down", "working", "unknown",
] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];

const WAIT: Record<Language, Record<WaitReason, string>> = {
  en: {
    previous: "still answering your previous message in this chat.",
    slots: "all {count} agent slots are busy: {holders}.",
    memory: "the runner's memory budget of {budget} MB is used up: {used} MB held, and this agent needs {reserve} MB.",
    starting: "starting the agent from cold, up to a minute.",
    harvest: "a background summary of the chat is going first.",
    retry: "the last attempt failed: {cause}. Next try in {seconds} s.",
    login: "the model login was refused. Someone needs to sign in again.",
    window: "the plan's usage window is used up. It resumes {date}.",
    off: "this agent is switched off on the board.",
    // Never says where the message is answered as if it were settled: a move that is withdrawn is answered on the machine the chat is on now.
    moving: "this chat is being moved to {machine}; your message is kept and answered after the move ends: on {machine} if it goes through, on {source} if it is withdrawn. Send /move to see where it stands: it shows the exact command to withdraw it.",
    "runner-down": "the runner {runner} is down, or the machine that runs this agent is offline.",
    // Said of a claim in the store, so it names what is RECORDED and never
    // claims a live process: the store cannot say the loop is still there.
    working: "the loop accepted it and no answer is recorded yet.",
    unknown: "no known reason. Raw state: {state}.",
  },
  ru: {
    previous: "ещё отвечаю на ваше предыдущее сообщение в этом чате.",
    slots: "все слоты агентов заняты ({count}): {holders}.",
    memory: "память раннера ({budget} МБ) исчерпана: занято {used} МБ, этому агенту нужно {reserve} МБ.",
    starting: "запускаю агента с нуля, это занимает до минуты.",
    harvest: "сначала идёт фоновая сводка чата.",
    retry: "последняя попытка не удалась: {cause}. Следующая через {seconds} с.",
    login: "вход в модель отклонён, нужно войти заново.",
    window: "лимит тарифа исчерпан, продолжу {date}.",
    off: "этот агент выключен на панели.",
    moving: "этот чат переносится на {machine}; сообщение сохранено и будет обработано после переноса: на {machine}, если он состоится, и на {source}, если его отозвать. Напишите /перенос, чтобы узнать, где перенос: там точная команда, чтобы отозвать его.",
    "runner-down": "раннер {runner} не работает, или машина этого агента выключена.",
    working: "сообщение принято, ответа пока не записано.",
    unknown: "причина неизвестна. Состояние: {state}.",
  },
};

/** Why the message is waiting, as the sentence itself, with no marker in front. */
export function waitReasonText(language: Language, reason: string, values: LineValues = {}): string {
  const known = (WAIT_REASONS as readonly string[]).includes(reason) ? (reason as WaitReason) : "unknown";
  return interpolate(language, WAIT[language][known], values);
}

/** Why the message is waiting, as the line under a clock line. */
export function waitReasonLine(language: Language, reason: string, values: LineValues = {}): string {
  return says(language, waitReasonText(language, reason, values));
}

/**
 * The tail of the three outage sentences is common and the opening names the
 * cause outright. ONE WHOLE SENTENCE PER CAUSE, not one template with a cause
 * slot: a slot produced "the model credential stopped working (the loop refused
 * the turn)", which puts two subjects in one sentence, and the Russian twin was
 * worse, because `доступ` and `модель` both read as the subject.
 */
const OUTAGE: Record<Language, Record<string, (n: number) => string>> = {
  en: {
    login: (n) =>
      `the model login was refused. Messages are waiting and nothing is lost. ` +
      `I try again every ${n} s and will say when it works.`,
    window: (n) =>
      `the plan's usage window is used up. Messages are waiting and nothing is lost. ` +
      `I try again every ${n} s and will say when it works.`,
    other: (n) =>
      `the loop refused the turn. Messages are waiting and nothing is lost. ` +
      `I try again every ${n} s and will say when it works.`,
  },
  ru: {
    login: (n) =>
      `вход в модель отклонён. Сообщения ждут, ничего не потеряно. ` +
      `Повторяю попытку каждые ${n} с и сообщу, когда заработает.`,
    window: (n) =>
      `лимит тарифа исчерпан. Сообщения ждут, ничего не потеряно. ` +
      `Повторяю попытку каждые ${n} с и сообщу, когда заработает.`,
    other: (n) =>
      `модель отказалась отвечать. Сообщения ждут, ничего не потеряно. ` +
      `Повторяю попытку каждые ${n} с и сообщу, когда заработает.`,
  },
};

/** One line per person when a household-wide cause stops every turn. */
export function outageNotice(
  language: Language,
  cause: string,
  retrySeconds: number,
): string {
  return says(language, (OUTAGE[language][cause] ?? OUTAGE[language].other)(retrySeconds));
}

/**
 * The one line when it works again.
 *
 * The Russian is written this way on purpose: a `{count}` glued to a noun needs
 * number agreement, and `Сообщений в очереди: 5` is correct for every count.
 */
export function catchUpNotice(language: Language, count: number): string {
  return says(
    language,
    language === "ru"
      ? `снова работает. Сообщений в очереди: ${count}.`
      : `it works again. Messages waiting: ${count}.`,
  );
}

/**
 * The recognizer is not answering, once per episode per person.
 *
 * It is the shipped outage shape: the cause named outright, then the tail that
 * says nothing is lost and names the interval, so a person who reads it knows
 * their note is still there and roughly when to expect it.
 */
export function transcriberDown(language: Language, retrySeconds: number): string {
  return says(
    language,
    language === "ru"
      ? `расшифровка не отвечает. Голосовое сообщение ждёт, ничего не потеряно. ` +
          `Повторяю попытку каждые ${retrySeconds} с и сообщу, когда заработает.`
      : `the transcriber is not answering. Your voice note is waiting and nothing is lost. ` +
          `I try again every ${retrySeconds} s and will say when it works.`,
  );
}

/**
 * The one line when it works again.
 *
 * The Russian is written so the count is never glued to a noun: number
 * agreement then never arises, which is the lesson the catch-up line taught.
 */
export function transcriberBack(language: Language, count: number): string {
  return says(
    language,
    language === "ru"
      ? `расшифровка снова работает. Голосовых в очереди: ${count}.`
      : `transcription works again. Voice notes waiting: ${count}.`,
  );
}

/** The audio decoded to nothing. The person is told, and the agent answers. */
export function voiceUnreadable(language: Language): string {
  return says(
    language,
    language === "ru"
      ? `голосовое сообщение не разобрать: похоже, там тишина. Напишите текстом.`
      : `I could not make out the voice note: it sounds like silence or no words. Please type it.`,
  );
}

/** The note waited out its whole window. It is kept, and the person is told. */
export function voiceGaveUp(language: Language, hours: number): string {
  return says(
    language,
    language === "ru"
      ? `не удалось расшифровать голосовое сообщение за ${hours} ч. Оно сохранено. Напишите текстом.`
      : `I could not transcribe your voice note after ${hours} h. It is saved. Please type it.`,
  );
}

/**
 * A stretch of a voice note that never got its text, in the place it belongs.
 *
 * THE ONE LINE HERE WITH NO MACHINERY MARKER, and the reason is where it sits:
 * inside the text slot of the message, which is the person's own words. A
 * marker in the middle of a sentence somebody dictated would read as the door
 * having said it.
 */
export function gapMarker(language: Language, seconds: number): string {
  return language === "ru"
    ? `[... ${seconds} с не расшифровано]`
    : `[... ${seconds} s not transcribed]`;
}

/** The one line at the notice threshold, before anything is held. */
export function windowNotice(language: Language, percent: number): string {
  return says(
    language,
    language === "ru"
      ? `лимит тарифа израсходован на ${percent}%. ` +
          `Фоновая работа приостановлена, сообщения по-прежнему идут первыми.`
      : `the plan window is ${percent}% used. ` +
          `Proactive work is paused and your messages still go first.`,
  );
}

/**
 * The one line back into a chat after a harvest, naming what
 * was saved.
 *
 * THREE FORMS AND NOT ONE TEMPLATE WITH TWO SLOTS, for the same reason the
 * outage sentences are three: "saved. Notes: . Already there..." with an empty
 * list is a sentence about nothing, and the Russian twin reads worse still.
 *
 * THE COUNT IS NEVER GLUED TO A NOUN in either language. The LIST carries it,
 * so `Заметки: finances/a, people/b` is correct for one note and for five and
 * Russian number agreement never arises, the same lesson the catch-up line
 * taught.
 */
export function harvestReport(
  language: Language,
  what: { notes: string[]; conflicts: string[] },
): string {
  // AN ENTRY THAT NAMES NOTHING IS NOT IN THE SENTENCE. The apply's
  // classifier answers `note: ""` whenever a marker line carries no path at its
  // own skip index, and one of those joined into the list renders
  // `[door] saved. Notes: .`, which is the sentence about nothing these three
  // forms exist to make unreachable. The caller drops them too, so this is the
  // fence rather than the rule.
  const kept = what.notes.filter((one) => one !== "");
  const clashed = what.conflicts.filter((one) => one !== "");
  // Nothing named on either side is a report about nothing, and the honest
  // answer to that is the line that says so.
  if (kept.length === 0 && clashed.length === 0) return harvestNothing(language);
  const notes = kept.join(", ");
  const conflicts = clashed.join(", ");
  if (clashed.length === 0) {
    return says(
      language,
      language === "ru" ? `сохранено. Заметки: ${notes}.` : `saved. Notes: ${notes}.`,
    );
  }
  if (kept.length === 0) {
    return says(
      language,
      language === "ru"
        ? `ничего не сохранено. Уже есть с другим текстом, не перезаписано: ${conflicts}.`
        : `nothing saved. Already there with different text, not overwritten: ${conflicts}.`,
    );
  }
  return says(
    language,
    language === "ru"
      ? `сохранено. Заметки: ${notes}. Уже есть с другим текстом, не перезаписано: ${conflicts}.`
      : `saved. Notes: ${notes}. Already there with different text, not overwritten: ${conflicts}.`,
  );
}

/**
 * The answer to a harvest a person ASKED for that saved nothing.
 *
 * It is sent on a demand and never on a quiet harvest: the report says what was
 * saved, and a person who typed a phrase at the machinery and got silence has
 * no way to tell it worked from a hub that is broken.
 */
export function harvestNothing(language: Language): string {
  return says(
    language,
    language === "ru"
      ? "в этот раз сохранять нечего."
      : "nothing worth keeping this time.",
  );
}

/**
 * A wait a person reads: `<1m`, `12m`, `1h 05m`. Never raw seconds past a
 * minute, and never a false precision under it.
 */
export function humanDuration(language: Language, seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  if (whole < 60) return language === "ru" ? "<1 мин" : "<1m";
  const minutes = Math.floor(whole / 60);
  if (minutes < 60) return language === "ru" ? `${minutes} мин` : `${minutes}m`;
  const rest = String(minutes % 60).padStart(2, "0");
  return language === "ru" ? `${Math.floor(minutes / 60)} ч ${rest} мин` : `${Math.floor(minutes / 60)}h ${rest}m`;
}

/**
 * Where one message stands, as the ONE card the door keeps for it.
 *
 * A state is what the door can show from evidence it holds, and no state says a
 * process is alive: `working` is a turn the store shows as accepted and claimed,
 * and the age of the last thing the loop was SEEN doing sits beside it.
 *
 *   queued      waiting for the loop to accept it
 *   accepted    the loop has it and has produced nothing yet
 *   working     the loop has started answering and the turn is not over
 *   idle        an open turn nothing is running: it waits to be picked up again
 *   held        an attempt was cut short and its input is the owner's to decide
 *   continuing  the owner chose to continue and it has not started yet
 *   finished    an answer is recorded (it says nothing about delivery)
 *   ended       the turn left the open set and no answer is recorded
 */
export type CardState = "queued" | "accepted" | "working" | "idle" | "held" | "continuing" | "finished" | "ended";

export interface StatusCard {
  state: CardState;
  /** Seconds since the door began counting this wait. */
  elapsed: number;
  /** Seconds since the loop was last SEEN doing anything, or null when it never was. */
  quiet: number | null;
  actions: number;
  /** The last tool the loop was seen to start. Its name only, never its arguments. */
  tool: string;
  /** What the last observed event was: `text`, `action`, `action_result`, or empty. */
  event: string;
  /** Why the message waits, when a clock that ran out found a reason. No marker. */
  why: string | null;
  /** The cause of the hold on the input, when there is one. */
  hold: string | null;
  /** Whether this platform renders `||spoilers||`. */
  spoilers: boolean;
}

const CARD_STATE: Record<Language, Record<CardState, string>> = {
  en: {
    queued: "still waiting: the loop has not accepted this message",
    accepted: "still waiting: the agent has not started answering",
    working: "in progress",
    idle: "not running right now",
    held: "interrupted, input held",
    continuing: "continuation authorized",
    finished: "finished",
    ended: "no longer active",
  },
  ru: {
    queued: "всё ещё жду: агент не принял это сообщение",
    accepted: "всё ещё жду: агент не начал отвечать",
    working: "в работе",
    idle: "сейчас не выполняется",
    held: "прервано, ввод удержан",
    continuing: "продолжение разрешено",
    finished: "завершено",
    ended: "больше не активно",
  },
};

const CARD_NOTE: Record<Language, { held: string; continuing: string; idle: string; ended: string }> = {
  en: {
    held: "Nothing runs again until you decide: see the recovery notice.",
    continuing: "you chose to continue; it starts when it can.",
    idle: "waiting to be picked up again.",
    ended: "the outcome is not confirmed here.",
  },
  ru: {
    held: "Ничего не запустится снова, пока вы не решите: см. сообщение о восстановлении.",
    continuing: "вы выбрали продолжить; начнётся, как только сможет.",
    idle: "ждёт, когда его возьмут снова.",
    ended: "итог здесь не подтверждён.",
  },
};

const CARD_EVENT: Record<Language, Record<string, string>> = {
  en: { text: "text", action: "tool start", action_result: "tool result" },
  ru: { text: "текст", action: "запуск инструмента", action_result: "результат инструмента" },
};

/** Text that came from outside a card cannot open or close a spoiler, or run past its line. */
function inCard(value: string, limit = 160): string {
  const flat = safeValue(value).replaceAll("||", "| |");
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** A tool's NAME and nothing around it: arguments, paths and output never get this far. */
function toolName(value: string): string {
  return value.replace(/[^\w.:-]/g, "").slice(0, 40);
}

/** The technical detail: what the loop was last seen to do, in one short line. */
function cardDetail(language: Language, card: StatusCard): string | null {
  const ru = language === "ru";
  const parts: string[] = [];
  const tool = toolName(card.tool);
  if (card.actions > 0) {
    parts.push(ru ? `последний замеченный инструмент: ${tool || "?"}` : `last observed tool: ${tool || "unnamed"}`);
    parts.push(ru ? `вызовов: ${card.actions}` : `tool calls: ${card.actions}`);
  } else if (card.event !== "") {
    parts.push(ru ? "вызовов инструментов не замечено" : "no tool calls observed");
  }
  const event = CARD_EVENT[language][card.event];
  if (event) parts.push(ru ? `последнее событие: ${event}` : `last event: ${event}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * The card: at most TWO short lines, edited in place as the wait goes on.
 *
 * The first line is the state, the time since the door began counting, and how
 * long ago the loop was last SEEN doing anything. The second carries the reason
 * a wait has, in the open, and the technical detail after it, which is a Discord
 * spoiler where the platform renders one and plain text where it does not. A
 * spoiler hides text and does not fold the line, which is why there are two lines
 * at most. An elapsed wait is never called a failure here: it is a state and a
 * time, and what it is waiting for.
 *
 * These are the two lines of TEXT. The message-effect ledger appends its own small
 * visible marker line to what it sends (`store/effects.ts`), which is how a message
 * is found again after a lost answer, so the chat shows that line under these two.
 */
export function statusCard(language: Language, card: StatusCard): string {
  const ru = language === "ru";
  const first = [CARD_STATE[language][card.state], humanDuration(language, card.elapsed)];
  if (card.state === "accepted" || card.state === "working") {
    first.push(card.quiet === null
      ? (ru ? "активности пока не замечено" : "no activity observed yet")
      : (ru ? `последняя активность ${humanDuration(language, card.quiet)} назад` : `last activity ${humanDuration(language, card.quiet)} ago`));
  } else if ((card.state === "idle" || card.state === "held" || card.state === "continuing") && card.quiet !== null) {
    first.push(ru ? `последняя активность ${humanDuration(language, card.quiet)} назад` : `last activity ${humanDuration(language, card.quiet)} ago`);
  } else if (card.state === "finished" && card.actions > 0) {
    first.push(ru ? `вызовов инструментов: ${card.actions}` : `tool calls: ${card.actions}`);
  }
  const lines = [says(language, first.join(" · "))];

  const note = card.state === "held"
    ? `${inCard(HOLD_CAUSE[language][String(card.hold)] ?? String(card.hold ?? ""), 100)}. ${CARD_NOTE[language].held}`
    : card.state === "continuing" || card.state === "idle" || card.state === "ended"
      ? CARD_NOTE[language][card.state]
      : card.why !== null ? inCard(card.why) : null;
  const detail = card.state === "finished" || card.state === "queued" ? null : cardDetail(language, card);
  const second = [
    ...(note === null || note === "" ? [] : [note]),
    ...(detail === null ? [] : [card.spoilers ? `||${detail}||` : detail]),
  ];
  if (second.length > 0) lines.push(second.join(" · "));
  return lines.join("\n");
}

/** Interpolated data cannot introduce another line or expose a credential. */
export function safeValue(value: unknown): string {
  return String(value ?? "").split(/[\r\n]/, 1)[0]
    .replace(/(?:authorization\s*:|bearer\s|(?:token|password|signature|secret)\s*[=:]).*/i, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

/**
 * The closed list: every operation label and every named cause a sentence may
 * carry, and its Russian. A cause is translated HERE and never spelled again
 * inside a sentence, because a second spelling could not drift into the string
 * it claims to define. It is exported so a check can hold the whole key set
 * against it and a word nobody decided on fails there.
 *
 * A finding code is deliberately absent from it. An operator greps a code, so
 * it stays ASCII machine vocabulary in every language.
 */
export const WORDS: Record<string, string> = {
  voice: "голосовое сообщение", photo: "фото", file: "файл", sticker: "стикер", video: "видео",
  install: "установка", recover: "восстановление", sync: "синхронизация", convert: "перенос",
  dispatch: "передача", adopt: "принятие", retire: "отключение", backup: "копирование",
  done: "готово", refused: "отклонено", failed: "ошибка", waiting: "ожидание",
  running: "работает", stopped: "остановлен", scheduled: "по расписанию", missing: "отсутствует", unknown: "неизвестно",
  "access denied": "доступ запрещён", "chat missing": "чат отсутствует", "login refused": "вход отклонён",
  "invalid configuration": "неверная конфигурация", "child exited": "процесс модели завершился",
  "memory limit reached": "достигнут предел памяти", "task failed": "ошибка задачи",
  "state unavailable on this machine": "данные недоступны на этой машине",
  "delivery outcome unknown": "результат доставки неизвестен", "retry limit reached": "достигнут предел повторов",
  "operation failed": "операция не выполнена",
  "command altered": "команда изменена", "not approved": "не подтверждено", "configuration changed": "настройка изменилась",
  "same device": "то же устройство", "copy does not match": "копия не совпадает",
  "unsupported on this platform": "на этой платформе недоступно",
  "chat name ambiguous": "название чата неоднозначно", "one agent per bot": "один агент на бота",
};

type LineValues = Record<string, unknown>;
function interpolate(language: Language, template: string, values: LineValues): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = safeValue(values[key]);
    return language === "ru" && ["kind", "cause", "operation", "result", "wanted", "seen"].includes(key) && Object.hasOwn(WORDS, value)
      ? WORDS[value] : value;
  });
}

export function voicePending(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "голосовые сообщения пока не расшифровываются, напишите текстом."
    : "voice notes are not transcribed yet, please type it.", values);
  return says(language, sentence);
}

export function mediaFailed(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "не удалось сохранить {kind}. Отправьте ещё раз."
    : "I could not save {kind}. Please send it again.", values);
  return says(language, sentence);
}

export function emptyAnswer(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "агент вернул пустой ответ. Попробуйте ещё раз."
    : "the agent returned an empty answer. Please try again.", values);
  return says(language, sentence);
}

export function deliveryFailed(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "не удалось доставить ответ в {chat}: {cause}. Нужно восстановление."
    : "I could not deliver the answer in {chat}: {cause}. Recovery is needed.", values);
  return says(language, sentence);
}

export function deliveryUncertain(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "доставка в {chat} не подтверждена: {cause}. Проверьте чат перед повтором."
    : "delivery in {chat} is unconfirmed: {cause}. Check the chat before retrying.", values);
  return says(language, sentence);
}

export function chatUnreadable(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "не могу прочитать {chat}: {cause}. Повторю через {seconds} с."
    : "I cannot read {chat}: {cause}. I will retry in {seconds} s.", values);
  return says(language, sentence);
}

export function chatRestored(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "чат {chat} снова доступен для чтения."
    : "I can read {chat} again.", values);
  return says(language, sentence);
}

export function agentRetry(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "агент {agent} остановился: {cause}. Повторю через {seconds} с."
    : "{agent} stopped: {cause}. I will retry in {seconds} s.", values);
  return says(language, sentence);
}

/**
 * An attempt reached the engine and did not finish, and its input is held. The
 * one line that tells a person what is known, what is not, and the exact
 * command that decides it. The revision is in the command because a choice made
 * about older knowledge is void.
 */
const HOLD_CAUSE: Record<Language, Record<string, string>> = {
  en: {
    interrupted: "the attempt is over and did not finish",
    "ownership-unknown": "it is not known whether the attempt is still running, so nothing else will start",
    stopped: "the attempt was stopped on request",
  },
  ru: {
    interrupted: "попытка завершилась, не закончив работу",
    "ownership-unknown": "неизвестно, работает ли попытка до сих пор, поэтому ничего другого не запускается",
    stopped: "попытка остановлена по запросу",
  },
};

export function holdNotice(language: Language, values: LineValues = {}): string {
  const verb = language === "ru" ? "/восстановить" : "/recover";
  const cause = HOLD_CAUSE[language][String(values.cause)] ?? String(values.cause);
  const sentence = interpolate(language, language === "ru"
    ? "{agent}: работа прервана, её входные данные удержаны: {why}. {effects} Ничего не будет запущено повторно, пока вы не решите. "
      + `Напишите ${verb} {agent} {attempt} {revision} continue, чтобы продолжить, или ${verb} {agent} {attempt} {revision} keep-held, чтобы оставить как есть. После подтверждённого завершения процесса fresh-context явно сбрасывает нативный контекст для новых сообщений; незавершённая работа не продолжается.`
    : "{agent}: a piece of work was interrupted and its input is held: {why}. {effects} Nothing will be run again until you choose. "
      + `Reply ${verb} {agent} {attempt} {revision} continue to continue it, or ${verb} {agent} {attempt} {revision} keep-held to leave it as it is. After confirmed process exit, fresh-context explicitly discards native context so fresh messages can run; it never continues unfinished work.`,
    { ...values, why: cause });
  return says(language, sentence);
}

/**
 * Why a held conversation cannot take a turn, per cause, in the words every door
 * surface uses (the notice, and the answer to a choice made while it is so).
 */
const CONTEXT_WHY: Record<Language, Record<string, string>> = {
  en: {
    "safe-resume-unvalidated": "this engine build has not been shown to resume an interrupted session without replaying unfinished work",
    "no-native-session-recorded": "no engine session was recorded for the interrupted attempt",
    "native-state-uncertain": "the engine never acknowledged this conversation's session, so it cannot be trusted to resume",
  },
  ru: {
    "safe-resume-unvalidated": "для этой сборки движка не подтверждено, что прерванная сессия возобновляется без повтора незавершённой работы",
    "no-native-session-recorded": "для прерванной попытки не записана сессия движка",
    "native-state-uncertain": "движок так и не подтвердил сессию этого разговора, поэтому возобновлять её нельзя",
  },
};

/**
 * The conversation of a held attempt cannot take ANY turn until its native context
 * can be resumed: a new message and an owner's continuation alike wait, and nothing
 * is rebuilt in its place. Said once per attempt, revision and cause, and it tells
 * the owner that a choice is still recorded meanwhile.
 */
export function contextNotice(language: Language, values: LineValues = {}): string {
  const verb = language === "ru" ? "/восстановить" : "/recover";
  const why = CONTEXT_WHY[language][String(values.cause)] ?? String(values.cause);
  const sentence = interpolate(language, language === "ru"
    ? "{agent}: разговор ждёт нативный контекст ({why}). Пока его нет, ни новое сообщение, ни продолжение прерванной работы {attempt} не запускаются, и контекст не пересобирается. "
      + `Ваше решение (${verb} {agent} {attempt} {revision} continue или keep-held) записывается и не теряется: продолжение начнётся само, когда контекст станет доступен. Либо выберите fresh-context после подтверждённого завершения процесса: нативный контекст сбрасывается, незавершённая работа не продолжается.`
    : "{agent}: the conversation is waiting for native context ({why}). Until it is available neither a new message nor a continuation of {attempt} starts, and nothing is rebuilt in its place. "
      + `Your choice (${verb} {agent} {attempt} {revision} continue or keep-held) is still recorded and is not lost: an authorized continuation starts by itself once the context is available. Or choose fresh-context explicitly after confirmed process exit: native context is discarded, and unfinished work is not continued.`,
    { ...values, why });
  return says(language, sentence);
}

/**
 * What a choice made while the native context is not usable is waiting for, said
 * in the answer to it. `context` is the runner's measurement: absent or `pending`
 * is "pending verification" and never "ready".
 */
function contextClause(language: Language, context: unknown, cause: unknown): string {
  if (context === "unavailable") return CONTEXT_WHY[language][String(cause)] ?? String(cause);
  return language === "ru" ? "доступность контекста ещё проверяется" : "availability of the context is pending verification";
}

/** What became of a recovery choice, said in the chat it was typed in. */
export function holdChoiceLine(language: Language, values: LineValues = {}): string {
  let outcome = String(values.outcome);
  const waiting = (outcome === "continuing" || outcome === "continue_pending") && values.context !== "ready";
  if (waiting) outcome = `${outcome}:context`;
  const en: Record<string, string> = {
    fresh_context: "recorded: native context was reset after confirmed exit. Fresh messages can run; unfinished work and any queued continuation stay excluded. Nothing was undone.",
    "move-pending": "not applied: this conversation has an open move or a pending relocation note. Complete or withdraw the open move; a pending note requires a validated native resume and receipt before fresh context is available. Nothing changed.",
    "ownership-unresolved": "not applied: fresh context requires confirmed process exit and no other active execution. Nothing changed.",
    keep_held: "recorded: {attempt} stays held and nothing is authorized.",
    continue_pending: "recorded: {attempt} will continue once the old attempt is shown to be over. Nothing new starts until then.",
    "continue_pending:context": "recorded: {attempt} will continue once the old attempt is shown to be over and the native context is available ({clause}). Nothing new starts until then.",
    continuing: "recorded: a continuation of {attempt} is queued behind the current turn.",
    "continuing:context": "recorded: a continuation of {attempt} is authorized and waiting for native context ({clause}). No executor has started, and nothing is rebuilt in its place.",
    "stale-revision": "not applied: what is known about {attempt} changed since that notice. Use the latest one.",
    "unknown-attempt": "not applied: no held attempt {attempt} for {agent}.",
    closed: "not applied: {attempt} is already being continued or is closed.",
    "invalid-choice": "not applied: the choice is continue, keep-held or fresh-context.",
  };
  const ru: Record<string, string> = {
    fresh_context: "записано: после подтверждённого завершения процесса создан новый контекст. Новые сообщения разрешены; незавершённая работа и её продолжение не повторяются. Изменения не отменены.",
    "move-pending": "не применено: перенос разговора не завершён или уведомление о переносе ещё не получено. Завершите или отмените открытый перенос; для получения уведомления нужно подтверждённое безопасное продолжение контекста. Ничего не изменено.",
    "ownership-unresolved": "не применено: нужны подтверждённое завершение процесса и отсутствие другой активной попытки. Ничего не изменено.",
    keep_held: "записано: {attempt} остаётся удержанной, ничего не разрешено.",
    continue_pending: "записано: {attempt} продолжится, когда будет подтверждено, что прежняя попытка закончилась. До тех пор ничего нового не запускается.",
    "continue_pending:context": "записано: {attempt} продолжится, когда будет подтверждено, что прежняя попытка закончилась, и нативный контекст станет доступен ({clause}). До тех пор ничего нового не запускается.",
    continuing: "записано: продолжение {attempt} поставлено в очередь после текущего хода.",
    "continuing:context": "записано: продолжение {attempt} разрешено и ждёт нативный контекст ({clause}). Ничего не запущено, и контекст не пересобирается.",
    "stale-revision": "не применено: с того сообщения о {attempt} что-то изменилось. Используйте последнее.",
    "unknown-attempt": "не применено: у {agent} нет удержанной попытки {attempt}.",
    closed: "не применено: {attempt} уже продолжается или закрыта.",
    "invalid-choice": "не применено: выбор — continue, keep-held или fresh-context.",
  };
  const table = language === "ru" ? ru : en;
  return says(language, interpolate(language, table[outcome] ?? table["unknown-attempt"],
    { ...values, clause: contextClause(language, values.context, values.cause) }));
}

export function holdUsage(language: Language, values: LineValues = {}): string {
  const verb = language === "ru" ? "/восстановить" : "/recover";
  const sentence = interpolate(language, language === "ru"
    ? `${verb} {agent} — перезапуск; ${verb} {agent} {attempt} {revision} continue|keep-held|fresh-context — решение по прерванной работе.`
    : `${verb} {agent} restarts it; ${verb} {agent} {attempt} {revision} continue|keep-held|fresh-context decides an interrupted piece of work.`, values);
  return says(language, sentence);
}

export function recoveryAccepted(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "запрошено восстановление {target}."
    : "recovery requested for {target}.", values);
  return says(language, sentence);
}

export function recoveryDone(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "восстановление {target} завершено."
    : "recovery completed for {target}.", values);
  return says(language, sentence);
}

export function recoveryRefused(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "восстановление {target} отклонено: {cause}."
    : "recovery refused for {target}: {cause}.", values);
  return says(language, sentence);
}

export function controlUsage(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "напишите /восстановить и идентификатор агента."
    : "use /recover followed by an agent ID.", values);
  return says(language, sentence);
}

/**
 * The two commands a person types, and the two sub-verbs the agent command
 * takes, each pinned whole in both languages.
 *
 * The recognizer that routes a message away from the agent, the usage line that
 * tells a person what to type, and the parser that reads the arguments all read
 * these, so a verb cannot end up spelled one way in the door and another way in
 * the sentence asking for it.
 */
export const DISPATCH_PHRASES: Record<Language, string> = { en: "/dispatch", ru: "/передать" };
/** One question to every council seat of the person, answered once in this chat. */
export const COUNCIL_PHRASES: Record<Language, string> = { en: "/council", ru: "/совет" };
export const AGENT_PHRASES: Record<Language, string> = { en: "/agent", ru: "/агент" };
export const ADOPT_PHRASES: Record<Language, string> = { en: "adopt", ru: "принять" };
export const RETIRE_PHRASES: Record<Language, string> = { en: "retire", ru: "отключить" };

/** The job is on the other agent's queue, and the report comes back here. */
export function dispatchAccepted(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "задача передана {agent}. Сообщу, когда придёт отчёт."
    : "dispatched to {agent}. I will say when the report is back.", values);
  return says(language, sentence);
}

/** The command was understood and refused, so nothing was queued. */
export function dispatchRefused(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "передача {agent} отклонена: {cause}."
    : "dispatch to {agent} refused: {cause}.", values);
  return says(language, sentence);
}

export function dispatchUsage(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? `напишите ${DISPATCH_PHRASES.ru}, идентификатор агента и задачу.`
    : `use ${DISPATCH_PHRASES.en} followed by an agent ID and the task.`, values);
  return says(language, sentence);
}

/** How much of the question the acknowledgement repeats, so a long one stays one line. */
export const COUNCIL_QUESTION_CAP = 120;

/**
 * The seats are on their way and one answer comes back here. The question is
 * repeated so a person with two councils running can tell which one this is,
 * and it is capped because the whole of a pasted page is not an acknowledgement.
 */
export function councilRequested(language: Language, values: { count: number; question: string }): string {
  const question = values.question.length > COUNCIL_QUESTION_CAP
    ? values.question.slice(0, COUNCIL_QUESTION_CAP) + "..."
    : values.question;
  const sentence = interpolate(language, language === "ru"
    ? "совет из {count} начат по вопросу: {question}"
    : "council of {count} started on: {question}", { count: values.count, question });
  return says(language, sentence);
}

/** The command was understood and refused, so nothing was queued. */
export function councilRefused(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "совет отклонён: {cause}."
    : "council refused: {cause}.", values);
  return says(language, sentence);
}

/**
 * What to type, and what a council is made of. A person whose file names fewer
 * than two seats reads this line too, because the thing they are missing is a
 * registry entry and not a permission.
 */
export function councilUsage(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? `напишите ${COUNCIL_PHRASES.ru} и вопрос. Совету нужны минимум два ваших агента с role = "council".`
    : `use ${COUNCIL_PHRASES.en} followed by a question. A council needs at least two of your agents with role = "council".`, values);
  return says(language, sentence);
}

/**
 * The council has run past the grace and is said ONCE, for the council and
 * never per seat: the seats are jobs nobody sees, and the one thing the person
 * is waiting on is the merged answer.
 */
export function councilLate(language: Language, values: { answered: number; seats: number; seconds: number }): string {
  const sentence = interpolate(language, language === "ru"
    ? "всё ещё жду совет: ответили {answered} из {seats}. Прошло {seconds} с."
    : "still waiting on the council: {answered} of {seats} seats have answered. {seconds} s so far.", values);
  return says(language, sentence);
}

/**
 * The job was queued and then refused before it ran, which is a different
 * sentence from a command refused at the door: the person already read that the
 * task was on its way, so this one says plainly that nothing was run.
 */
export function jobRefused(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "задача для {agent} отклонена: {cause}. Ничего не выполнено."
    : "the job for {agent} was refused: {cause}. Nothing was run.", values);
  return says(language, sentence);
}

/** An agent lifecycle request was accepted and is on its way to the applier. */
export function agentAccepted(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "запрошено: {operation} для {agent}."
    : "{operation} requested for {agent}.", values);
  return says(language, sentence);
}

/**
 * One binding, two sentences, because the two sides of it read differently.
 * `agentAdopted` is posted in the ADOPTED chat, where "this chat" is the thing
 * a person can see, and `agentBound` in the chat the command was typed in,
 * where the new chat has to be named. Landing in the adopted chat is also the
 * proof the binding took, which is why it is not one line posted twice.
 */
export function agentAdopted(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "{agent} теперь отвечает в этом чате."
    : "{agent} now answers in this chat.", values);
  return says(language, sentence);
}

export function agentBound(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "{agent} теперь отвечает в чате {name}."
    : "{agent} now answers in {name}.", values);
  return says(language, sentence);
}

/** Retiring drops the entry and keeps the history, and the line says so. */
export function agentRetired(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "{agent} отключён. История сохранена."
    : "{agent} is retired. Its history is kept.", values);
  return says(language, sentence);
}

export function agentRefused(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "{operation} для {agent} отклонено: {cause}."
    : "{operation} for {agent} refused: {cause}.", values);
  return says(language, sentence);
}

export function agentUsage(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? `напишите ${AGENT_PHRASES.ru} ${ADOPT_PHRASES.ru}, идентификатор агента и название или номер чата, ` +
        `либо ${AGENT_PHRASES.ru} ${RETIRE_PHRASES.ru} и идентификатор агента.`
    : `use ${AGENT_PHRASES.en} ${ADOPT_PHRASES.en} followed by an agent ID and the chat's name or ID, ` +
        `or ${AGENT_PHRASES.en} ${RETIRE_PHRASES.en} followed by an agent ID.`, values);
  return says(language, sentence);
}

export function operation(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "{operation}: {target}: {result}."
    : "{operation}: {target}: {result}.", values);
  return sentence;
}

export function finding(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "{code}: {target}: {cause}."
    : "{code}: {target}: {cause}.", values);
  return sentence;
}

export function status(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "{id}: ожидается {wanted}, наблюдается {seen}, pid {pid}."
    : "{id}: wanted {wanted}, seen {seen}, pid {pid}.", values);
  return sentence;
}

export function checkClean(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "проверка: замечаний нет."
    : "check: no findings.", values);
  return sentence;
}

export function cliUsage(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "использование: imprnt hub <команда> <реестр> [цель] [машина]"
    : "usage: imprnt hub <verb> <registry> [target] [machine]", values);
  return sentence;
}

/**
 * What `imprnt hub registry` says about this machine's copy of the registry. The verdict is translated HERE, in a map of its own, because the
 * closed list above is pinned and a verdict is a state of one command and not a word any other sentence carries.
 */
const REGISTRY_VERDICT: Record<Language, Record<string, string>> = {
  en: {
    current: "current: this copy is the one the store machine published",
    behind: "behind: this is an earlier published version, and the hub here replaces it on its next tick",
    diverged: "diverged: this copy is not a version the store machine published, and nothing was changed",
    waiting: "waiting: the store machine has not published bytes this copy can be replaced with",
    "no-publication": "waiting: the store machine has published nothing yet",
    authority: "this is the store machine, and its file is the one that is published",
    single: "one route to the store, so there is no other copy to compare",
    replaced: "replaced with the published registry",
    "refused-store-machine": "refused: the store machine's own file is never replaced from a copy",
    "refused-single-route": "refused: this file has one route to the store and no copy to replace",
    "refused-digest": "refused: the file is not the one with the digest given, so nothing was changed",
    "refused-not-diverged": "refused: only a diverged copy is replaced this way, and this one is not",
    "refused-unverifiable": "refused: the published bytes cannot be checked against what the store machine published",
    "refused-load": "refused: the published registry does not load on this machine",
    "refused-owner": "refused: the new file cannot be given the old file's owner",
    "refused-authority": "refused: the published registry names another store machine",
    "refused-backup": "refused: the bytes being replaced could not be kept, so nothing was replaced",
    "refused-busy": "refused: the file changed or is being edited, or the publication moved on, so nothing was replaced",
    "refused-failed": "refused: the replacement failed and nothing was replaced",
  },
  ru: {
    current: "актуален: эта копия опубликована машиной хранилища",
    behind: "отстаёт: это более ранняя опубликованная версия, хаб на этой машине заменит её на следующем такте",
    diverged: "расходится: эта копия не является версией, опубликованной машиной хранилища, ничего не изменено",
    waiting: "ожидание: машина хранилища не опубликовала байты, которыми можно заменить эту копию",
    "no-publication": "ожидание: машина хранилища пока ничего не опубликовала",
    authority: "это машина хранилища, её файл и есть опубликованный",
    single: "один маршрут к хранилищу, сравнивать не с чем",
    replaced: "заменён опубликованным реестром",
    "refused-store-machine": "отклонено: файл самой машины хранилища не заменяют копией",
    "refused-single-route": "отклонено: в этом файле один маршрут к хранилищу, заменять нечего",
    "refused-digest": "отклонено: файл не совпадает с указанным хешем, ничего не изменено",
    "refused-not-diverged": "отклонено: так заменяют только расходящуюся копию, а эта не расходится",
    "refused-unverifiable": "отклонено: опубликованные байты нельзя сверить с тем, что опубликовала машина хранилища",
    "refused-load": "отклонено: опубликованный реестр не загружается на этой машине",
    "refused-owner": "отклонено: новому файлу нельзя передать владельца старого",
    "refused-authority": "отклонено: опубликованный реестр называет другую машину хранилища",
    "refused-backup": "отклонено: заменяемые байты сохранить не удалось, ничего не заменено",
    "refused-busy": "отклонено: файл изменился или редактируется, либо публикация сменилась, ничего не заменено",
    "refused-failed": "отклонено: замена не удалась, ничего не заменено",
  },
};

export function registryCopy(language: Language, values: LineValues = {}): string {
  const verdict = REGISTRY_VERDICT[language][String(values.verdict)] ?? String(values.verdict);
  const sentence = interpolate(language, language === "ru"
    ? "реестр: {machine}: {verdict}. локальный {local}, опубликованный {published}."
    : "registry: {machine}: {verdict}. local {local}, published {published}.", { ...values, verdict });
  const kept = safeValue(values.backup);
  if (kept === "") return sentence;
  return `${sentence} ${language === "ru" ? `Прежние байты сохранены как ${kept}.` : `The previous bytes are kept as ${kept}.`}`;
}

export function installPlan(language: Language, values: LineValues): string {
  return interpolate(language, language === "ru"
    ? "установка: пробный запуск для {registry}; изменений нет.\nустановка: стандартная команда {install}; файл pid {pid}, служба {unit}."
    : "install: dry run for {registry}; no changes.\ninstall: the standard install is {install}; pid file {pid}, unit {unit}.", values);
}

export function installServicePlan(language: Language, values: LineValues): string {
  return interpolate(language, values.service
    ? language === "ru"
      ? "установка: {service}; эта команда не выполняется, если postgres уже отвечает."
      : "install: {service}; would not run that service command when postgres already answers."
    : language === "ru"
      ? "установка: отдельная служба не запускается; apt-get создаёт и запускает {unit}."
      : "install: would start no service of its own; apt-get creates and starts {unit}.", values);
}

/** A zone checkout the provisioning stage would not touch, and what is there. */
export function installZoneRefused(language: Language, values: { id: string; path: string; cause: string; found: string }): string {
  return interpolate(language, language === "ru"
    ? "\u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0430: {id} \u0432 {path} \u043e\u0441\u0442\u0430\u0432\u043b\u0435\u043d \u043a\u0430\u043a \u0435\u0441\u0442\u044c ({cause}): {found}."
    : "install: {id} at {path} was left as it is ({cause}): {found}.", values);
}

export function installDatabaseReady(language: Language): string {
  return language === "ru"
    ? "установка: схема postgres готова; существующие настройки хранилища не изменены."
    : "install: postgres schema ready; existing store settings unchanged.";
}

/** Roles that had no password, or one their file no longer matched, now have one. */
export function installPasswordsSet(language: Language, values: { roles: string; dir: string; had: "none" | "other" }): string {
  return interpolate(language, values.had === "none"
    ? language === "ru"
      ? "установка: у {roles} не было пароля. Теперь он есть, каждый в своём файле в {dir}."
      : "install: {roles} had no password. Each has one now, in its own file in {dir}."
    : language === "ru"
      ? "установка: пароль {roles} не совпадал с файлом в {dir}. Пароль заменён, файл тоже."
      : "install: {roles} did not match the password file in {dir}. Each has a new password and a new file.", values);
}

/** A pg_hba.conf rule that lets a hub role in with no password at all. */
export function installTrustRemains(language: Language, values: { lines: string }): string {
  return interpolate(language, language === "ru"
    ? "установка: pg_hba.conf пускает роли хаба без пароля, строки {lines}. Замените trust на scram-sha-256 и перечитайте конфигурацию кластера."
    : "install: pg_hba.conf lets the hub roles in without a password on line {lines}. Change trust to scram-sha-256 there and reload the cluster.", values);
}

/**
 * A pg_hba.conf rule that lets a role in over the unix socket on the strength of
 * the operating system account alone. Its repair is a different one from a trust
 * line's, so it is a line of its own rather than a wider trust warning.
 */
export function installSocketRemains(language: Language, values: { lines: string }): string {
  return interpolate(language, language === "ru"
    ? "установка: pg_hba.conf пускает через сокет по учётной записи системы, без пароля, строки {lines}. Замените peer или ident на scram-sha-256 и перечитайте конфигурацию кластера."
    : "install: pg_hba.conf lets a role in over the socket on the operating system account alone, with no password, on line {lines}. Change peer or ident to scram-sha-256 there and reload the cluster.", values);
}

/**
 * A role carrying the name of the account the hub runs as, while a socket rule
 * above admits it. Any process of that account is then that role with no secret
 * at all, which is what the passwords exist to stop.
 */
export function installAccountRole(language: Language, values: { role: string }): string {
  return interpolate(language, language === "ru"
    ? "установка: в кластере есть роль {role} с именем учётной записи, под которой работает хаб, и строка выше пускает её через сокет без пароля. Удалите роль или уберите ту строку."
    : "install: the cluster has a role named {role}, the account the hub runs as, and a socket rule above lets it in with no password. Drop the role or take that rule out.", values);
}

export function conversionDone(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "перенос: записей добавлено {count}, уже были {skipped}."
    : "conversion: {count} records written, {skipped} already present.", values);
  return sentence;
}

/** What each one-off migration command takes, whole per command and language. */
export type MigrationScript = "convert-v2-chatlog" | "convert-v2-registry" | "handoff-v2" | "harvest-v2";

const MIGRATION_USAGE: Record<Language, Record<MigrationScript, string>> = {
  en: {
    "convert-v2-chatlog": "usage: bun run scripts/convert-v2-chatlog.ts <manifest>, one absolute path to the private version 1 chat log manifest.",
    "convert-v2-registry": "usage: bun run scripts/convert-v2-registry.ts <manifest>, one absolute path to the private version 1 registry manifest.",
    "handoff-v2": "usage: bun run scripts/handoff-v2.ts <manifest>, one absolute path to the private version 1 work manifest that names registry.",
    "harvest-v2": "usage: bun run scripts/harvest-v2.ts <manifest>, one absolute path to a private version 1 manifest naming registry, person, from and until.",
  },
  ru: {
    "convert-v2-chatlog": "использование: bun run scripts/convert-v2-chatlog.ts <манифест>, один абсолютный путь к закрытому манифесту журналов чатов версии 1.",
    "convert-v2-registry": "использование: bun run scripts/convert-v2-registry.ts <манифест>, один абсолютный путь к закрытому манифесту реестра версии 1.",
    "handoff-v2": "использование: bun run scripts/handoff-v2.ts <манифест>, один абсолютный путь к закрытому манифесту работы версии 1 с полем registry.",
    "harvest-v2": "использование: bun run scripts/harvest-v2.ts <манифест>, один абсолютный путь к закрытому манифесту версии 1 с полями registry, person, from и until.",
  },
};

export function migrationUsage(language: Language, script: MigrationScript): string {
  return MIGRATION_USAGE[language][script];
}

export function harvestDone(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "сохранение: {person}: завершено по {until}."
    : "harvest: {person}: complete through {until}.", values);
  return sentence;
}

export function mediaKind(language: Language, kind: string): string {
  return language === "ru" ? WORDS[kind] : kind;
}

export function emptyMessageLine(language: Language): string {
  return language === "ru" ? "(пустое сообщение)" : "(empty message)";
}

export function syncCause(language: Language, code: string): string {
  const causes: Record<string, [string, string]> = {
    path: ["repository path is missing or invalid", "путь репозитория отсутствует или неверен"],
    person: ["repository is outside the person's tree", "репозиторий вне дерева человека"],
    locked: ["repository is already being synchronized", "репозиторий уже синхронизируется"],
    config: ["repository config names a program, which the sync will not run: declare an ssh command in the registry entry, or keep such keys in the account's own config", "в настройках репозитория указана программа, синхронизация её не запустит: укажите команду ssh в реестре или держите такие ключи в настройках учётной записи"],
    commit: ["committing the uncommitted changes failed", "не удалось сохранить несохранённые изменения"],
    changed: ["repository branch or revision differs from the expected sync state", "ветка или версия репозитория не совпадает с ожидаемым состоянием синхронизации"],
    operation: ["an unfinished Git operation or unresolved conflict needs attention", "незавершённая операция Git или конфликт требуют внимания"],
    branch: ["repository is on the wrong branch", "в репозитории выбрана другая ветка"],
    remote: ["configured remote is absent", "указанный удалённый репозиторий отсутствует"],
    fetch: ["fetch failed", "не удалось получить изменения"],
    conflict: ["rebase failed; inspect conflicts before retrying", "перебазирование не удалось; проверьте конфликты перед повтором"],
    push: ["push failed", "не удалось отправить изменения"],
  };
  return (causes[code] ?? ["operation failed", "операция не удалась"])[language === "ru" ? 1 : 0];
}

/**
 * What to do about a batch the door fetched and could not accept. It is a
 * refusal on this side, the store or the chat log, and the door replays the
 * same batch every tick, so restarting it changes nothing.
 */
export function acceptRepair(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "устраните указанную причину в {target}: дверь повторяет ту же партию каждый тик, перезапуск не поможет."
    : "repair the reported cause for {target}: the door replays the same batch every tick, and restarting it changes nothing.", values);
}

/**
 * What a person reads after thirty minutes of failed sync: the repository,
 * current condition, what may remain local, and how to preserve pending work.
 */
export function syncStuck(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "синхронизация {target} не проходит уже {minutes} мин. Сейчас: {cause}. Новые заметки могут оставаться только на этой машине. Остановите другие процессы, меняющие этот репозиторий, сохраните незавершённую работу и проверьте состояние Git перед повтором. Не сбрасывайте изменения и не удаляйте сохранённую работу."
    : "syncing {target} has been failing for {minutes} minutes. Current condition: {cause}. New notes may remain only on this machine. Stop other writers, preserve pending work, and inspect Git state before retrying. Do not reset changes or discard saved work.", values);
  return says(language, sentence);
}

export function syncRepair(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "устраните указанную причину в {target} и повторите синхронизацию."
    : "repair the reported cause in {target} and run sync again.", values);
}

/**
 * The board's own sentences, and the loader refusals that go with its entry.
 *
 * THEY CARRY NO MACHINERY MARKER, which is the opposite of every family above.
 * The marker names the door, and it belongs on a line the hub writes INTO A
 * CHAT. These go to an operator's stderr and into the board's HTML, where an
 * English `[door]` is a label nobody asked for. So they are written beside the
 * marked families rather than through `says`.
 *
 * A page renders in English, because no person's language applies to a reader
 * the hub has not identified. The Russian column is here anyway, so a language
 * toggle later costs no new sentence and no second place for one to drift.
 */
export function boardBindMissing(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{id} не указывает bind, а доска слушает один конкретный адрес."
    : "{id} has no bind, and a board listens on one specific address.", values);
}

export function boardBindWide(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{id} слушает {bind}, а доска слушает один конкретный адрес, а не все сразу."
    : "{id} binds to {bind}, and a board listens on one specific address, never a wildcard.", values);
}

export function boardBindNotAddress(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{id} слушает {bind}, а bind - это IP-адрес, а не имя."
    : "{id} binds to {bind}, and bind is an IP address, not a name.", values);
}

export function boardPort(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{id} указывает порт {value}, а порт доски - целое число от 1 до 65535."
    : "{id} has port {value}, and a board's port is a whole number from 1 to 65535.", values);
}

export function enabledNotBoolean(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{id} указывает enabled {value}, а держать ли его запущенным - это true или false."
    : "{id} has enabled {value}, and whether the hub keeps it running is a true or a false.", values);
}

/**
 * The two kinds a household may not hold down from the file.
 *
 * Each says why in the sentence, because a refusal a person cannot act on is a
 * wall. Taking either down is removing its entry.
 */
export function enabledOnHub(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{id} указывает enabled false, а хаб нельзя остановить из файла: остановленный хаб больше ничего не запустит, в том числе себя."
    : "{id} has enabled false, and the hub is never stopped from the file, because a stopped hub starts nothing again, itself included.", values);
}

export function enabledOnBoard(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{id} указывает enabled false, а доску нельзя остановить из файла: остановленная доска не сможет предложить запуск, который её вернёт. Чтобы убрать её, удалите запись."
    : "{id} has enabled false, and a board is never stopped from the file, because a stopped board cannot offer the start that brings it back. Remove the entry to take it down.", values);
}

/** The second port a board serves artifacts on, which is their own origin. */
export function boardArtifactsPort(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{id} указывает artifacts_port {value}, а это целое число от 1 до 65535, отличное от порта самой доски."
    : "{id} has artifacts_port {value}, and it is a whole number from 1 to 65535 that is not the board's own port.", values);
}

export function artifactsNotBoolean(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{id} указывает artifacts {value}, а показывать ли артефакты этого человека - это true или false."
    : "{id} has artifacts {value}, and whether the board serves this person's artifacts is a true or a false.", values);
}

/** The address this machine does not hold, said on stderr as the process exits. */
export function boardBindFailed(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "доска: не удаётся слушать {bind}:{port}: {cause}."
    : "board: cannot listen on {bind}:{port}: {cause}.", values);
}

/**
 * The sentence on a card. It is `check`'s answer and never the page's opinion:
 * the question a card asks is whether the `check` sheet holds a finding whose
 * subject is this thing, and a broken card says that finding's own words.
 *
 * A SENTENCE AND NOT A WORD. "ok", "waiting" and "broken" told a person that
 * something was the matter and not what, so the broken card carries the
 * finding's `says`, the waiting card the count it is answering, and the idle
 * card the one word that needs no more. The Russian count is never glued to a
 * noun, which is the lesson the catch-up line taught.
 */
export function cardOk(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru" ? "свободен" : "idle", values);
}

export function cardWaiting(language: Language, values: LineValues = {}): string {
  const count = Number(values.count ?? 0);
  return interpolate(language, language === "ru"
    ? "отвечает, сообщений в работе: {count}"
    : `answering {count} ${count === 1 ? "message" : "messages"}`, values);
}

export function cardBroken(language: Language, values: LineValues = {}): string {
  return interpolate(language, "{says}", values);
}

export function actRequested(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "запрошен перезапуск {target}."
    : "restart requested for {target}.", values);
}

export function actRefused(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "перезапуск {target} отклонён: {cause}."
    : "restart refused for {target}: {cause}.", values);
}

export function editApplied(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{field} для {target} установлено в {value}."
    : "{field} set to {value} for {target}.", values);
}

/** A machine with no registry writer says so and names the file to edit. */
export function editUnavailable(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{target} нельзя изменить отсюда: на этой машине нет записи в реестр. Отредактируйте файл."
    : "{target} cannot be changed from here: this machine has no registry writer. Edit the file.", values);
}

export function checkRan(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "проверка: замечаний: {count}, на {at}."
    : "check: findings: {count}, as of {at}.", values);
}

export function pageMissing(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru" ? "такой страницы нет." : "no such page.", values);
}

/** The finding that mirrors unit-missing: stopped on the list, up in the manager. */
export function unitNotStopped(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{id} в реестре остановлен, а менеджер служб всё ещё держит его запущенным."
    : "{id} is on the registry's list as stopped and the service manager is still running it.", values);
}
