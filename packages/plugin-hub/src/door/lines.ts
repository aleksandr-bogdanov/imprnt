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
