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
 * What the agent is doing, edited as it goes.
 *
 * A loop that reported no action at all gets the form that says only the
 * elapsed time, which is honest rather than silent: "a turn with no tool call
 * still lands" is the case this covers.
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

/** The last edit before the reply is posted: "ending with the totals". */
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

/** Interpolated data cannot introduce another line or expose a credential. */
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
    dirty: ["repository has uncommitted changes", "в репозитории есть несохранённые изменения"],
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
 * The one word on a card. It is `check`'s answer and never the page's opinion:
 * the question a card asks is whether the `check` sheet holds a finding whose
 * subject is this thing.
 */
export function cardOk(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru" ? "в порядке" : "ok", values);
}

export function cardWaiting(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru" ? "ожидание" : "waiting", values);
}

export function cardBroken(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru" ? "сломано" : "broken", values);
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

/** The one finding this phase adds: stopped on the list, running in the manager. */
export function unitNotStopped(language: Language, values: LineValues = {}): string {
  return interpolate(language, language === "ru"
    ? "{id} в реестре остановлен, а менеджер служб всё ещё держит его запущенным."
    : "{id} is on the registry's list as stopped and the service manager is still running it.", values);
}
