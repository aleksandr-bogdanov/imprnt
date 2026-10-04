// Every sentence the board adds that a person or an operator reads, whole, in
// both languages.
//
// The table below is the contract, copied here so a reader of the check sees
// exactly what a person will read. Nothing is compared by substring: a sentence
// a household reads is pinned whole or it is not pinned at all.
//
// | key                 | en                                                                                             | ru |
// |---------------------|------------------------------------------------------------------------------------------------|----|
// | boardBindMissing    | {id} has no bind, and a board listens on one specific address.                                   | {id} не указывает bind, а доска слушает один конкретный адрес. |
// | boardBindWide       | {id} binds to {bind}, and a board listens on one specific address, never a wildcard.             | {id} слушает {bind}, а доска слушает один конкретный адрес, а не все сразу. |
// | boardBindNotAddress | {id} binds to {bind}, and bind is an IP address, not a name.                                     | {id} слушает {bind}, а bind - это IP-адрес, а не имя. |
// | boardPort           | {id} has port {value}, and a board's port is a whole number from 1 to 65535.                     | {id} указывает порт {value}, а порт доски - целое число от 1 до 65535. |
// | boardArtifactsPort  | {id} has artifacts_port {value}, and it is a whole number from 1 to 65535 that is not the board's own port. | {id} указывает artifacts_port {value}, а это целое число от 1 до 65535, отличное от порта самой доски. |
// | enabledNotBoolean   | {id} has enabled {value}, and whether the hub keeps it running is a true or a false.             | {id} указывает enabled {value}, а держать ли его запущенным - это true или false. |
// | artifactsNotBoolean | {id} has artifacts {value}, and whether the board serves this person's artifacts is a true or a false. | {id} указывает artifacts {value}, а показывать ли артефакты этого человека - это true или false. |
// | boardBindFailed     | board: cannot listen on {bind}:{port}: {cause}.                                                  | доска: не удаётся слушать {bind}:{port}: {cause}. |
// | cardOk              | idle                                                                                             | свободен |
// | cardWaiting         | answering {count} message(s)                                                                     | отвечает, сообщений в работе: {count} |
// | cardBroken          | {says} (the finding's own sentence)                                                              | {says} |
// | actRequested        | restart requested for {target}.                                                                  | запрошен перезапуск {target}. |
// | actRefused          | restart refused for {target}: {cause}.                                                           | перезапуск {target} отклонён: {cause}. |
// | editApplied         | {field} set to {value} for {target}.                                                             | {field} для {target} установлено в {value}. |
// | editUnavailable     | {target} cannot be changed from here: this machine has no registry writer. Edit the file.        | {target} нельзя изменить отсюда: на этой машине нет записи в реестр. Отредактируйте файл. |
// | checkRan            | check: findings: {count}, as of {at}.                                                            | проверка: замечаний: {count}, на {at}. |
// | pageMissing         | no such page.                                                                                    | такой страницы нет. |
// | unitNotStopped      | {id} is on the registry's list as stopped and the service manager is still running it.           | {id} в реестре остановлен, а менеджер служб всё ещё держит его запущенным. |
//
// The nine page strings are pinned here rather than beside the pages that post
// them: the sentences are the contract and the code that posts them is not, so
// a page is written against a fixed vocabulary rather than inventing one.
//
// NONE OF THE SEVENTEEN CARRIES THE MACHINERY MARKER. The marker names the
// door, and it belongs on a line the hub writes INTO A CHAT. A loader refusal
// goes to an operator's stderr and a page string goes into HTML, and an English
// `[door]` inside either is a label nobody asked for.
//
// Red reason: import missing. `src/door/lines.ts` carries none of the
// seventeen, and the first one read out of the module is what fails.

import { expect, test } from "bun:test";
import {
  MACHINERY_LINES,
  actRefused,
  actRequested,
  artifactsNotBoolean,
  boardBindFailed,
  boardBindMissing,
  boardBindNotAddress,
  boardArtifactsPort,
  boardBindWide,
  boardHosts,
  boardPort,
  cardBroken,
  cardHeld,
  cardOk,
  chatBusy,
  chatHealthy,
  chatPaused,
  chatRetryAt,
  chatRetrying,
  chatStuck,
  chatUnreachable,
  overviewChats,
  overviewFindings,
  cardQueued,
  cardStale,
  cardWaiting,
  turnReason,
  checkClean,
  checkRan,
  editApplied,
  editUnavailable,
  enabledNotBoolean,
  enabledOnBoard,
  enabledOnHub,
  finding,
  mediaKind,
  operation,
  pageMissing,
  recoveryDone,
  safeValue,
  status,
  unitNotStopped,
  type Language,
} from "../src/door/lines.ts";

type Line = (language: Language, values?: Record<string, unknown>) => string;

/**
 * A twin of a real sentence with one deliberate defect in it. Every one of them
 * must fail the comparison, or this file is a check that a function returns a
 * string.
 */
function twins(text: string, values: string[]): string[] {
  const out = [
    // An em dash where the contract has none.
    text.includes("-") ? text.replace("-", "—") : text.includes(" ") ? text.replace(" ", " — ") : `${text}—`,
    // A semicolon where the contract has none.
    text.includes(".") ? text.replace(".", ";") : `${text};`,
    // Shouted, which is what a build that decided a label needed emphasis does
    // to a one-word card.
    text.toUpperCase(),
  ];
  // The slot never filled at all, which is what a broken interpolation looks
  // like on a page.
  for (const value of values) {
    if (value !== "" && text.includes(value)) out.push(text.replace(value, "{value}"));
  }
  return out;
}

/** One line, both languages, compared whole, with its twins refused. */
function pinned(
  line: Line,
  values: Record<string, unknown>,
  en: string,
  ru: string,
  planted: string[] = [],
): void {
  expect(line("en", values)).toBe(en);
  expect(line("ru", values)).toBe(ru);
  for (const sentence of [en, ru]) {
    for (const twin of twins(sentence, planted)) expect(twin).not.toBe(sentence);
  }
  // And no marker on either, said per line rather than once over a joined blob,
  // so a build that marked exactly one of them fails on that one.
  for (const language of ["en", "ru"] as Language[]) {
    expect(line(language, values)).not.toContain(MACHINERY_LINES.en);
    expect(line(language, values)).not.toContain(MACHINERY_LINES.ru);
  }
}

test("D-253 the seven loader and operator refusals are pinned whole in both languages", () => {
  pinned(
    boardBindMissing,
    { id: "board" },
    "board has no bind, and a board listens on one specific address.",
    "board не указывает bind, а доска слушает один конкретный адрес.",
    ["board"],
  );
  pinned(
    boardBindWide,
    { id: "board", bind: "0.0.0.0" },
    "board binds to 0.0.0.0, and a board listens on one specific address, never a wildcard.",
    "board слушает 0.0.0.0, а доска слушает один конкретный адрес, а не все сразу.",
    ["0.0.0.0"],
  );
  // The second wildcard, said as its own sentence render, because `::` is the
  // one value whose punctuation could be eaten by an interpolation that got
  // clever about colons.
  expect(boardBindWide("en", { id: "board", bind: "::" })).toBe(
    "board binds to ::, and a board listens on one specific address, never a wildcard.",
  );
  expect(boardBindWide("ru", { id: "board", bind: "::" })).toBe(
    "board слушает ::, а доска слушает один конкретный адрес, а не все сразу.",
  );
  pinned(
    boardBindNotAddress,
    { id: "board", bind: "board.example" },
    "board binds to board.example, and bind is an IP address, not a name.",
    "board слушает board.example, а bind - это IP-адрес, а не имя.",
    ["board.example"],
  );
  pinned(
    boardPort,
    { id: "board", value: "8794" },
    "board has port 8794, and a board's port is a whole number from 1 to 65535.",
    "board указывает порт 8794, а порт доски - целое число от 1 до 65535.",
    ["8794"],
  );
  pinned(
    enabledNotBoolean,
    { id: "vault-sync", value: "no" },
    "vault-sync has enabled no, and whether the hub keeps it running is a true or a false.",
    "vault-sync указывает enabled no, а держать ли его запущенным - это true или false.",
    ["no"],
  );
  pinned(
    artifactsNotBoolean,
    { id: "p1", value: "yes" },
    "p1 has artifacts yes, and whether the board serves this person's artifacts is a true or a false.",
    "p1 указывает artifacts yes, а показывать ли артефакты этого человека - это true или false.",
    ["yes"],
  );
  // The cause is a word the shipped vocabulary does not translate, so the whole
  // sentence is the template's and nothing else. The translated case is
  // asserted on its own below.
  pinned(
    boardBindFailed,
    { bind: "127.0.0.1", port: 8794, cause: "address already in use" },
    "board: cannot listen on 127.0.0.1:8794: address already in use.",
    "доска: не удаётся слушать 127.0.0.1:8794: address already in use.",
    ["127.0.0.1", "address already in use"],
  );
});

test("the refusals the fence adds are pinned whole in both languages", () => {
  // A sentence a person reads is pinned here whole or it is not pinned at all,
  // beside the seventeen the phase's own table holds.
  pinned(
    boardArtifactsPort,
    { id: "board", value: "8794" },
    "board has artifacts_port 8794, and it is a whole number from 1 to 65535 that is not the board's own port.",
    "board указывает artifacts_port 8794, а это целое число от 1 до 65535, отличное от порта самой доски.",
    ["8794"],
  );
  for (const language of ["en", "ru"] as Language[]) {
    expect(boardArtifactsPort(language, { id: "board", value: "x" })).not.toContain(MACHINERY_LINES[language]);
  }
  // The sanitizer reaches this one too: a value that carried its own newline
  // into an operator's terminal would be a value that wrote its own line.
  const nasty = boardArtifactsPort("en", { id: "one\ntwo", value: "three\u0007four" });
  expect(nasty).not.toContain("\n");
  expect(nasty).not.toContain("\u0007");
});

test("the two refusals for a piece that cannot be stopped from the file are pinned whole in both languages", () => {
  pinned(
    enabledOnHub,
    { id: "hub-pi" },
    "hub-pi has enabled false, and the hub is never stopped from the file, because a stopped hub starts nothing again, itself included.",
    "hub-pi указывает enabled false, а хаб нельзя остановить из файла: остановленный хаб больше ничего не запустит, в том числе себя.",
    ["hub-pi"],
  );
  pinned(
    enabledOnBoard,
    { id: "board" },
    "board has enabled false, and a board is never stopped from the file, because a stopped board cannot offer the start that brings it back. Remove the entry to take it down.",
    "board указывает enabled false, а доску нельзя остановить из файла: остановленная доска не сможет предложить запуск, который её вернёт. Чтобы убрать её, удалите запись.",
    ["board"],
  );
});

test("D-253 the nine page strings and the one finding line are pinned whole in both languages", () => {
  // A card carries a sentence and not a word: idle says so in one, waiting
  // says how many it is answering, and broken says the finding's own words.
  pinned(cardOk, {}, "idle", "свободен");
  pinned(cardWaiting, { count: 1 }, "answering 1 message", "отвечает, сообщений в работе: 1", ["1"]);
  pinned(cardWaiting, { count: 3 }, "answering 3 messages", "отвечает, сообщений в работе: 3", ["3"]);
  pinned(
    cardBroken,
    { says: "p1-lair is retrying: task failed" },
    "p1-lair is retrying: task failed",
    "p1-lair is retrying: task failed",
    ["p1-lair is retrying: task failed"],
  );
  // The words the cards used to carry are not on any card any more.
  for (const language of ["en", "ru"] as Language[]) {
    for (const word of ["ok", "waiting", "broken", "owed", "в порядке", "ожидание", "сломано"]) {
      expect(cardOk(language)).not.toBe(word);
      expect(cardWaiting(language, { count: 2 })).not.toContain(word);
    }
  }
  pinned(
    actRequested,
    { target: "runner-pi" },
    "restart requested for runner-pi.",
    "запрошен перезапуск runner-pi.",
    ["runner-pi"],
  );
  pinned(
    actRefused,
    { target: "board", cause: "the target is the asker" },
    "restart refused for board: the target is the asker.",
    "перезапуск board отклонён: the target is the asker.",
    ["the target is the asker"],
  );
  pinned(
    editApplied,
    { field: "enabled", value: "false", target: "vault-sync" },
    "enabled set to false for vault-sync.",
    "enabled для vault-sync установлено в false.",
    ["vault-sync"],
  );
  pinned(
    editUnavailable,
    { target: "vault-sync" },
    "vault-sync cannot be changed from here: this machine has no registry writer. Edit the file.",
    "vault-sync нельзя изменить отсюда: на этой машине нет записи в реестр. Отредактируйте файл.",
    ["vault-sync"],
  );
  pinned(
    checkRan,
    { count: 3, at: "2026-09-20T10:00:00.000Z" },
    "check: findings: 3, as of 2026-09-20T10:00:00.000Z.",
    "проверка: замечаний: 3, на 2026-09-20T10:00:00.000Z.",
    ["2026-09-20T10:00:00.000Z"],
  );
  pinned(pageMissing, {}, "no such page.", "такой страницы нет.");
  pinned(
    unitNotStopped,
    { id: "vault-sync" },
    "vault-sync is on the registry's list as stopped and the service manager is still running it.",
    "vault-sync в реестре остановлен, а менеджер служб всё ещё держит его запущенным.",
    ["vault-sync"],
  );
});

test("the hosts refusal, the three other card states and every turn reason are pinned whole in both languages", () => {
  pinned(
    boardHosts,
    { id: "board", value: '["*.example.ts.net"]' },
    'board has hosts ["*.example.ts.net"], and hosts is a list of this machine\'s exact names: each a hostname with no port, no wildcard and no trailing dot. The bind address is always accepted.',
    'board указывает hosts ["*.example.ts.net"], а hosts - это список точных имён машины: каждое - имя хоста без порта, без * и без точки в конце. Адрес bind принимается всегда.',
    ['["*.example.ts.net"]'],
  );
  // An open message is not a turn that is running, so each state is its own
  // sentence, and "answering" stays the one sentence about running work.
  pinned(cardQueued, { count: 1 }, "1 message waiting to be picked up", "ждут, пока их возьмут, сообщений: 1", ["1"]);
  pinned(cardQueued, { count: 2 }, "2 messages waiting to be picked up", "ждут, пока их возьмут, сообщений: 2", ["2"]);
  // Said only of an original input whose hold is NOT released; a released one
  // is not current activity and has no sentence at all.
  pinned(cardHeld, { count: 1 }, "1 message held, waiting for a recovery choice", "удержано, ждёт решения о восстановлении, сообщений: 1", ["1"]);
  pinned(cardHeld, { count: 3 }, "3 messages held, waiting for a recovery choice", "удержано, ждёт решения о восстановлении, сообщений: 3", ["3"]);
  pinned(cardStale, { count: 1 }, "1 message unfinished, with nothing working on it", "не завершено, никто не работает, сообщений: 1", ["1"]);
  pinned(cardStale, { count: 2 }, "2 messages unfinished, with nothing working on them", "не завершено, никто не работает, сообщений: 2", ["2"]);
  for (const language of ["en", "ru"] as Language[]) {
    for (const line of [cardQueued, cardHeld, cardStale]) {
      expect(line(language, { count: 2 })).not.toMatch(/answering|отвечает|\bowed\b/i);
    }
  }

  const at = "2026-10-04 00:30 UTC";
  const reason = (key: string, values: Record<string, unknown>) => (language: Language) => turnReason(language, key, values);
  const pins: [string, Record<string, unknown>, string, string][] = [
    ["answering", { runner: "runner-a", at }, `runner-a is answering it, since ${at}.`, `runner-a отвечает на него с ${at}.`],
    ["hold", { at, cause: "interrupted" }, `held since ${at}: the attempt is over and did not finish.`, `удержано с ${at}: попытка завершилась, не закончив работу.`],
    ["continuing", { at }, `held since ${at}: the owner chose to continue it, and the continuation carries the work.`, `удержано с ${at}: владелец выбрал продолжить, работу несёт продолжение.`],
    ["owner-gone", { runner: "runner-a" }, "runner-a took it and is not working on it now.", "runner-a взял его и сейчас над ним не работает."],
    ["orphaned", {}, "it was started and no runner holds it now.", "работа была начата, и сейчас его не держит ни один раннер."],
    ["ownership-unknown", { runner: "runner-a" }, "it is not known whether runner-a is still running it.", "неизвестно, выполняет ли его runner-a до сих пор."],
    ["not-held", { runner: "runner-a" }, "runner-a stopped part way and no decision was asked for.", "runner-a остановился на полпути, и решения не запрашивали."],
    ["claimed", { runner: "runner-a" }, "runner-a picked it up and has not started yet.", "runner-a взял его и ещё не начал."],
    ["retry", { at }, `waiting to try again at ${at}.`, `ждёт повторной попытки в ${at}.`],
    ["unclaimed", { at }, `waiting for a runner since ${at}.`, `ждёт раннера с ${at}.`],
  ];
  for (const [key, values, en, ru] of pins) {
    const line = reason(key, values);
    expect(line("en"), key).toBe(en);
    expect(line("ru"), key).toBe(ru);
    for (const language of ["en", "ru"] as Language[]) {
      expect(line(language)).not.toContain(MACHINERY_LINES.en);
      expect(line(language)).not.toContain(MACHINERY_LINES.ru);
    }
  }
  // A reason nobody pinned is not invented: it is said as the queue.
  expect(turnReason("en", "something-new", { at })).toBe(`waiting for a runner since ${at}.`);
  // A value cannot write a second line.
  expect(turnReason("en", "claimed", { runner: "one\ntwo" })).not.toContain("\n");
});

test("the first screen's chat lines and headline are pinned whole in both languages, and none says owed or OK", () => {
  const at = "14:02 UTC";
  pinned(chatHealthy, {}, "healthy, nothing waiting", "в норме, ничего не ждёт");
  pinned(chatBusy, { kind: "human", at }, `busy: answering a message since ${at}`, `занят: отвечает на сообщение с ${at}`, [at]);
  pinned(chatBusy, { kind: "report", at }, `busy: working on a job's report since ${at}`, `занят: разбирает отчёт задачи с ${at}`, [at]);
  pinned(chatStuck, { why: "runner-a took it and is not working on it now." }, "stuck: runner-a took it and is not working on it now.",
    "застрял: runner-a took it and is not working on it now.", ["runner-a took it and is not working on it now."]);
  // One state per line: the cause after the state's one colon, and when it is
  // tried again (or the door's recorded cause) on the line beneath.
  pinned(chatRetrying, { cause: "model overloaded" }, "retrying: model overloaded", "повтор: model overloaded", ["model overloaded"]);
  pinned(chatRetryAt, { at }, `trying again at ${at}.`, `следующая попытка в ${at}.`, [at]);
  pinned(chatUnreachable, {}, "stuck: the door cannot reach this chat", "застрял: чат недоступен для двери");
  pinned(chatPaused, {}, "paused: answers nothing until it is woken", "на паузе: ничего не отвечает, пока его не разбудят");
  pinned(overviewChats, { problems: 0, chats: 1 }, "The one chat is working.", "Все чаты работают: 1.");
  pinned(overviewChats, { problems: 0, chats: 6 }, "All 6 chats are working.", "Все чаты работают: 6.", ["6"]);
  pinned(overviewChats, { problems: 2, chats: 6 }, "2 of 6 chats need attention.", "Требуют внимания чатов: 2 из 6.", ["2", "6"]);
  pinned(overviewFindings, { count: 0 }, "The check sheet holds no findings.", "В листе проверки замечаний нет.");
  pinned(overviewFindings, { count: 1 }, "The check sheet holds 1 finding.", "Замечаний в листе проверки: 1.", ["1"]);
  pinned(overviewFindings, { count: 4 }, "The check sheet holds 4 findings.", "Замечаний в листе проверки: 4.", ["4"]);
  for (const language of ["en", "ru"] as Language[]) {
    for (const line of [chatHealthy(language), chatPaused(language), chatBusy(language, { at }), overviewChats(language, { problems: 0, chats: 2 })]) {
      expect(line).not.toMatch(/\bowed\b|\bOK\b/);
    }
  }
});

test("D-253 no operator or page sentence carries the machinery marker, and a marked line still does", () => {
  const every: [Line, Record<string, unknown>][] = [
    [boardBindMissing, { id: "board" }],
    [boardBindWide, { id: "board", bind: "::" }],
    [boardBindNotAddress, { id: "board", bind: "board.example" }],
    [boardPort, { id: "board", value: "0" }],
    [enabledNotBoolean, { id: "board", value: "no" }],
    [artifactsNotBoolean, { id: "p1", value: "no" }],
    [boardBindFailed, { bind: "127.0.0.1", port: 8794, cause: "denied" }],
    [cardOk, {}],
    [cardWaiting, { count: 2 }],
    [cardBroken, { says: "a finding's own words" }],
    [actRequested, { target: "runner-pi" }],
    [actRefused, { target: "runner-pi", cause: "denied" }],
    [editApplied, { field: "enabled", value: "false", target: "runner-pi" }],
    [editUnavailable, { target: "runner-pi" }],
    [checkRan, { count: 0, at: "2026-09-20T10:00:00.000Z" }],
    [pageMissing, {}],
    [unitNotStopped, { id: "runner-pi" }],
  ];
  expect(every).toHaveLength(17);
  for (const [line, values] of every) {
    for (const language of ["en", "ru"] as Language[]) {
      expect(line(language, values)).not.toContain(MACHINERY_LINES.en);
      expect(line(language, values)).not.toContain(MACHINERY_LINES.ru);
    }
  }
  // The other way round, without which this asserts nothing: a line the hub
  // writes into a chat still carries the marker in that person's own words.
  expect(recoveryDone("en", { target: "p1-lair" })).toContain(MACHINERY_LINES.en);
  expect(recoveryDone("ru", { target: "p1-lair" })).toContain(MACHINERY_LINES.ru);
});

test("D-253 a planted newline and control character do not survive interpolation, and an angle bracket is the page's to escape", () => {
  const nasty = "one\ntwo\u0007<script>";
  const taken = [
    boardBindWide("en", { id: "board", bind: nasty }),
    boardBindNotAddress("en", { id: nasty, bind: "board.example" }),
    boardPort("en", { id: "board", value: nasty }),
    enabledNotBoolean("en", { id: "board", value: nasty }),
    artifactsNotBoolean("en", { id: nasty, value: "no" }),
    boardBindFailed("en", { bind: nasty, port: 1, cause: nasty }),
    actRequested("en", { target: nasty }),
    actRefused("en", { target: nasty, cause: nasty }),
    editApplied("en", { field: nasty, value: nasty, target: nasty }),
    editUnavailable("en", { target: nasty }),
    checkRan("en", { count: 1, at: nasty }),
    unitNotStopped("en", { id: nasty }),
  ];
  for (const sentence of taken) {
    // A value that carried a newline into a stderr line would be a value that
    // wrote its own line, and a control character is the same trick by another
    // route. Both are the shipped sanitizer's job and it does them.
    expect(sentence).not.toContain("\n");
    expect(sentence).not.toContain("\r");
    expect(sentence).not.toContain("\u0007");
    expect(sentence).not.toContain("two");
  }
  // The angle bracket is NOT this module's to remove. A refusal is a line on an
  // operator's terminal, where `&lt;` is noise, and the page that renders any of
  // these into HTML passes every value it interpolates through its own escape
  // helper. Escaping twice in two places is how one of them ends up doing
  // neither.
  expect(safeValue("<script>")).toBe("<script>");
  expect(actRequested("en", { target: "<script>" })).toBe("restart requested for <script>.");
});

test("D-253 each numeric line reads the same at zero, at one and at a large value", () => {
  expect(checkRan("en", { count: 0, at: "now" })).toBe("check: findings: 0, as of now.");
  expect(checkRan("en", { count: 1, at: "now" })).toBe("check: findings: 1, as of now.");
  expect(checkRan("en", { count: 1048576, at: "now" })).toBe("check: findings: 1048576, as of now.");
  expect(checkRan("ru", { count: 0, at: "now" })).toBe("проверка: замечаний: 0, на now.");
  expect(checkRan("ru", { count: 1, at: "now" })).toBe("проверка: замечаний: 1, на now.");
  expect(checkRan("ru", { count: 1048576, at: "now" })).toBe("проверка: замечаний: 1048576, на now.");

  for (const value of [0, 1, 65536]) {
    expect(boardPort("en", { id: "board", value })).toBe(
      `board has port ${value}, and a board's port is a whole number from 1 to 65535.`,
    );
    expect(boardPort("ru", { id: "board", value })).toBe(
      `board указывает порт ${value}, а порт доски - целое число от 1 до 65535.`,
    );
  }
  for (const port of [0, 1, 65536]) {
    expect(boardBindFailed("en", { bind: "127.0.0.1", port, cause: "denied" })).toBe(
      `board: cannot listen on 127.0.0.1:${port}: denied.`,
    );
    expect(boardBindFailed("ru", { bind: "127.0.0.1", port, cause: "denied" })).toBe(
      `доска: не удаётся слушать 127.0.0.1:${port}: denied.`,
    );
  }
});

test("D-253 the shipped vocabulary, the zero case and the shipped unavailable line are unchanged", () => {
  // The vocabulary is module-private, so it is asserted through the functions
  // that read it rather than by exporting it to make it checkable: a constant
  // exported for a check to look at is a constant a build can satisfy without
  // any sentence changing. `interpolate` translates `kind`, `cause`,
  // `operation`, `result`, `wanted` and `seen`, so every entry is reachable
  // through one of these four.
  const wantedSeen: [string, string][] = [
    ["running", "работает"],
    ["stopped", "остановлен"],
    ["scheduled", "по расписанию"],
    ["missing", "отсутствует"],
    ["unknown", "неизвестно"],
  ];
  for (const [en, ru] of wantedSeen) {
    expect(status("ru", { id: "x", wanted: en, seen: en, pid: 1 })).toBe(
      `x: ожидается ${ru}, наблюдается ${ru}, pid 1.`,
    );
    expect(status("en", { id: "x", wanted: en, seen: en, pid: 1 })).toBe(
      `x: wanted ${en}, seen ${en}, pid 1.`,
    );
  }
  // The stopped status needs no entry of its own in this module: it is the
  // shipped vocabulary's own word. `pid` is not one of the translated keys, and
  // it is not meant to be: it carries a number or the word this line was
  // handed.
  expect(status("ru", { id: "board", wanted: "stopped", seen: "stopped", pid: 4242 })).toBe(
    "board: ожидается остановлен, наблюдается остановлен, pid 4242.",
  );

  const operations: [string, string][] = [
    ["install", "установка"],
    ["recover", "восстановление"],
    ["sync", "синхронизация"],
    ["convert", "перенос"],
  ];
  const results: [string, string][] = [
    ["done", "готово"],
    ["refused", "отклонено"],
    ["failed", "ошибка"],
    ["waiting", "ожидание"],
  ];
  for (const [en, ru] of operations) {
    expect(operation("ru", { operation: en, target: "t", result: "done" })).toBe(`${ru}: t: готово.`);
  }
  for (const [en, ru] of results) {
    expect(operation("ru", { operation: "install", target: "t", result: en })).toBe(`установка: t: ${ru}.`);
  }

  const causes: [string, string][] = [
    ["access denied", "доступ запрещён"],
    ["chat missing", "чат отсутствует"],
    ["login refused", "вход отклонён"],
    ["invalid configuration", "неверная конфигурация"],
    ["child exited", "процесс модели завершился"],
    ["memory limit reached", "достигнут предел памяти"],
    ["task failed", "ошибка задачи"],
    ["state unavailable on this machine", "данные недоступны на этой машине"],
    ["delivery outcome unknown", "результат доставки неизвестен"],
    ["retry limit reached", "достигнут предел повторов"],
    ["operation failed", "операция не выполнена"],
  ];
  for (const [en, ru] of causes) {
    expect(finding("ru", { code: "c", target: "t", cause: en })).toBe(`c: t: ${ru}.`);
    expect(finding("en", { code: "c", target: "t", cause: en })).toBe(`c: t: ${en}.`);
  }

  const kinds: [string, string][] = [
    ["voice", "голосовое сообщение"],
    ["photo", "фото"],
    ["file", "файл"],
    ["sticker", "стикер"],
    ["video", "видео"],
  ];
  for (const [en, ru] of kinds) {
    expect(mediaKind("ru", en)).toBe(ru);
    expect(mediaKind("en", en)).toBe(en);
  }

  // The zero case, unchanged, because `checkRan` sits beside it and a build
  // that folded the two into one template would move this one.
  expect(checkClean("en")).toBe("check: no findings.");
  expect(checkClean("ru")).toBe("проверка: замечаний нет.");
  // `agent-state-unavailable` is a thrown name in the runner's own preflight
  // and not a sentence this module carries, so the check that drives that
  // preflight is what pins it. What this module owns is the reader's half of
  // the same fact, asserted above.
});
