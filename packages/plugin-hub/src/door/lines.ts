/**
 * Every string a person reads, in both languages, in one place.
 *
 * D-128. One machinery marker for every line the hub writes into a chat, and it
 * names the door: L6 asks the line to say it is the door speaking, and the door
 * is the only piece of the hub a person ever meets. The marker is translated
 * with the sentence, because an English label inside Russian prose is a defect
 * under the copy rules this household already applies to its own products.
 *
 * D-105's rule: a human reads or pastes it, so it is pinned WHOLE rather than
 * assembled from fragments, and the notices the RUNNER writes come from here
 * too, so one table is the whole vocabulary.
 */
export type Language = "en" | "ru";

/**
 * The marker, per language. It names the door, in the person's own words.
 *
 * EVERY TEMPLATE BELOW IS BUILT FROM IT (REVIEW's note on this file). Spelling
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

type Stamp = "acked" | "started" | "answered";

const CLOCK: Record<Language, Record<Stamp, (seconds: number) => string>> = {
  en: {
    acked: (n) =>
      `still waiting: the loop has not accepted this message. ${n} s so far.`,
    started: (n) =>
      `still waiting: the agent has not started answering. ${n} s so far.`,
    answered: (n) => `still waiting: the turn has not ended. ${n} s so far.`,
  },
  ru: {
    acked: (n) =>
      `всё ещё жду: агент не принял это сообщение. Прошло ${n} с.`,
    started: (n) => `всё ещё жду: агент не начал отвечать. Прошло ${n} с.`,
    answered: (n) => `всё ещё жду: ответ ещё не готов. Прошло ${n} с.`,
  },
};

/** MSG-10. A clock ran out, and the line says which one and how long it has been. */
export function clockLine(language: Language, stamp: string, seconds: number): string {
  return says(language, CLOCK[language][stamp as Stamp](seconds));
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

/** RUN-18. One line per person when a household-wide cause stops every turn. */
export function outageNotice(
  language: Language,
  cause: string,
  retrySeconds: number,
): string {
  return says(language, (OUTAGE[language][cause] ?? OUTAGE[language].other)(retrySeconds));
}

/**
 * RUN-18. The one line when it works again.
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

/** RUN-19. The one line at the notice threshold, before anything is held. */
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
 * HARV-04, D-159. The one line back into a chat after a harvest, naming what
 * was saved.
 *
 * THREE FORMS AND NOT ONE TEMPLATE WITH TWO SLOTS, for the same reason the
 * outage sentences are three: "saved. Notes: . Already there..." with an empty
 * list is a sentence about nothing, and the Russian twin reads worse still.
 *
 * THE COUNT IS NEVER GLUED TO A NOUN in either language. The LIST carries it,
 * so `Заметки: finances/a, people/b` is correct for one note and for five and
 * Russian number agreement never arises, which is D-105's own lesson from the
 * catch-up line.
 */
export function harvestReport(
  language: Language,
  what: { notes: string[]; conflicts: string[] },
): string {
  // REVIEW S4. AN ENTRY THAT NAMES NOTHING IS NOT IN THE SENTENCE. The apply's
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
 * D-159. The answer to a harvest a person ASKED for that saved nothing.
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
 * MSG-10. What the agent is doing, edited as it goes.
 *
 * A loop that reported no action at all gets the form that says only the
 * elapsed time, which is honest rather than silent: "a turn with no tool call
 * still lands" is the case MSG-10 names.
 */
export function progressLine(
  language: Language,
  what: { lastAction?: string; actions?: number; seconds: number },
): string {
  const actions = what.actions ?? 0;
  if (actions <= 0 || !what.lastAction) {
    return says(
      language,
      language === "ru" ? `работаю: ${what.seconds} с` : `working: ${what.seconds} s`,
    );
  }
  return says(
    language,
    language === "ru"
      ? `работаю: ${what.lastAction}, вызовов инструментов: ${actions}, ${what.seconds} с`
      : `working: ${what.lastAction}, ${actions} tool calls, ${what.seconds} s`,
  );
}

/** MSG-10. The last edit before the reply is posted: "ending with the totals". */
export function progressTotals(
  language: Language,
  what: { actions?: number; seconds: number },
): string {
  const actions = what.actions ?? 0;
  if (actions <= 0) {
    return says(
      language,
      language === "ru" ? `готово. Время: ${what.seconds} с.` : `done. Time: ${what.seconds} s.`,
    );
  }
  return says(
    language,
    language === "ru"
      ? `готово. Вызовов инструментов: ${actions}, время: ${what.seconds} с.`
      : `done. Tool calls: ${actions}, time: ${what.seconds} s.`,
  );
}

/** D-183. Interpolated data cannot introduce another line or expose a credential. */
export function safeValue(value: unknown): string {
  return String(value ?? "").split(/[\r\n]/, 1)[0]
    .replace(/(?:authorization\s*:|bearer\s|(?:token|password|signature|secret)\s*[=:]).*/i, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[\u0000-\u001f\u007f]/g, "").trim();
}

const WORDS: Record<string, string> = {
  voice: "голосовое сообщение", photo: "фото", file: "файл", sticker: "стикер", video: "видео",
  install: "установка", recover: "восстановление", sync: "синхронизация", convert: "перенос",
  done: "готово", refused: "отклонено", failed: "ошибка", waiting: "ожидание",
  running: "работает", stopped: "остановлен", scheduled: "по расписанию", missing: "отсутствует", unknown: "неизвестно",
  "access denied": "доступ запрещён", "chat missing": "чат отсутствует", "login refused": "вход отклонён",
  "invalid configuration": "неверная конфигурация", "child exited": "процесс модели завершился",
  "memory limit reached": "достигнут предел памяти", "task failed": "ошибка задачи",
  "state unavailable on this machine": "данные недоступны на этой машине",
  "delivery outcome unknown": "результат доставки неизвестен", "retry limit reached": "достигнут предел повторов",
  "operation failed": "операция не выполнена",
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
    ? "использование: imprnt hub <команда> <реестр> [цель]"
    : "usage: imprnt hub <verb> <registry> [target]", values);
  return sentence;
}

export function conversionDone(language: Language, values: LineValues = {}): string {
  const sentence = interpolate(language, language === "ru"
    ? "перенос: записей добавлено {count}, уже были {skipped}."
    : "conversion: {count} records written, {skipped} already present.", values);
  return sentence;
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
    dirty: ["repository has uncommitted changes", "в репозитории есть несохранённые изменения"],
    branch: ["repository is on the wrong branch", "в репозитории выбрана другая ветка"],
    remote: ["configured remote is absent", "указанный удалённый репозиторий отсутствует"],
    fetch: ["fetch failed", "не удалось получить изменения"],
    conflict: ["rebase failed; inspect conflicts before retrying", "перебазирование не удалось; проверьте конфликты перед повтором"],
    push: ["push failed", "не удалось отправить изменения"],
  };
  return (causes[code] ?? ["operation failed", "операция не удалась"])[language === "ru" ? 1 : 0];
}

export function syncRepair(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "устраните указанную причину в {target} и повторите синхронизацию."
    : "repair the reported cause in {target} and run sync again.", values);
}
