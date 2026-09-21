// Every sentence dispatch and agent lifecycle put in front of a person, pinned
// WHOLE in both languages, plus the closed vocabulary they translate through
// and the two command phrases a person types.
//
// Pure. No Postgres, no door, no runner, no platform. Nothing here can reach a
// protected window, because nothing here opens a store or starts a process.
//
// The table below is the contract, both columns, so a reader of this check sees
// exactly what a person will read:
//
// | Key | en | ru |
// |---|---|---|
// | dispatchAccepted | [door] dispatched to {agent}. I will say when the report is back. | [дверь] задача передана {agent}. Сообщу, когда придёт отчёт. |
// | dispatchRefused | [door] dispatch to {agent} refused: {cause}. | [дверь] передача {agent} отклонена: {cause}. |
// | dispatchUsage | [door] use /dispatch followed by an agent ID and the task. | [дверь] напишите /передать, идентификатор агента и задачу. |
// | jobRefused | [door] the job for {agent} was refused: {cause}. Nothing was run. | [дверь] задача для {agent} отклонена: {cause}. Ничего не выполнено. |
// | agentAccepted | [door] {operation} requested for {agent}. | [дверь] запрошено: {operation} для {agent}. |
// | agentAdopted | [door] {agent} now answers in this chat. | [дверь] {agent} теперь отвечает в этом чате. |
// | agentBound | [door] {agent} now answers in {name}. | [дверь] {agent} теперь отвечает в чате {name}. |
// | agentRetired | [door] {agent} is retired. Its history is kept. | [дверь] {agent} отключён. История сохранена. |
// | agentRefused | [door] {operation} for {agent} refused: {cause}. | [дверь] {operation} для {agent} отклонено: {cause}. |
// | agentUsage | [door] use /agent adopt followed by an agent ID and the chat's name or ID, or /agent retire followed by an agent ID. | [дверь] напишите /агент принять, идентификатор агента и название или номер чата, либо /агент отключить и идентификатор агента. |
//
// THE CONTROL IS WHAT MAKES THIS A CHECK. Asserting that a function returns a
// string proves nothing, so every one of the twenty is also compared against a
// deliberately wrong twin held here: the same sentence carrying an em dash, a
// semicolon, the other language's marker, or a slot nobody replaced. Each twin
// is built from the TABLE's own literal and never from what the function
// returned, because a twin derived from the output can only ever agree with it,
// and every one of those comparisons must fail.
//
// NONE OF THE TEN INTERPOLATES A COUNT, so the Russian number agreement that
// the catch-up line is written around does not arise here. The slots are
// rendered at an empty string, at 1, at 0 and at a large number all the same,
// and the whole sentence is compared each time, because a slot the caller
// forgot reads as a bug a person sees.
//
// Red reason: the ten sentences, the eleven words and the two recognizers do
// not exist. `seam()` loads the shipped modules, so the first failure is a
// `typeof` assertion answering "undefined", and the closed list and the slice
// are red for behaviour behind it.

import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { AGENT, DOOR, PERSON, chatLogFile } from "./helpers/hub-fixture.ts";

type Language = "en" | "ru";
type Render = (language: string, values: Record<string, unknown>) => string;

const EN_MARKER = "[door]";
const RU_MARKER = "[дверь]";

/** The ten sentences, key then English then Russian, exactly as pinned. */
const TABLE: [string, string, string][] = [
  ["dispatchAccepted",
    "[door] dispatched to {agent}. I will say when the report is back.",
    "[дверь] задача передана {agent}. Сообщу, когда придёт отчёт."],
  ["dispatchRefused",
    "[door] dispatch to {agent} refused: {cause}.",
    "[дверь] передача {agent} отклонена: {cause}."],
  ["dispatchUsage",
    "[door] use /dispatch followed by an agent ID and the task.",
    "[дверь] напишите /передать, идентификатор агента и задачу."],
  ["jobRefused",
    "[door] the job for {agent} was refused: {cause}. Nothing was run.",
    "[дверь] задача для {agent} отклонена: {cause}. Ничего не выполнено."],
  ["agentAccepted",
    "[door] {operation} requested for {agent}.",
    "[дверь] запрошено: {operation} для {agent}."],
  ["agentAdopted",
    "[door] {agent} now answers in this chat.",
    "[дверь] {agent} теперь отвечает в этом чате."],
  ["agentBound",
    "[door] {agent} now answers in {name}.",
    "[дверь] {agent} теперь отвечает в чате {name}."],
  ["agentRetired",
    "[door] {agent} is retired. Its history is kept.",
    "[дверь] {agent} отключён. История сохранена."],
  ["agentRefused",
    "[door] {operation} for {agent} refused: {cause}.",
    "[дверь] {operation} для {agent} отклонено: {cause}."],
  ["agentUsage",
    "[door] use /agent adopt followed by an agent ID and the chat's name or ID, or /agent retire followed by an agent ID.",
    "[дверь] напишите /агент принять, идентификатор агента и название или номер чата, либо /агент отключить и идентификатор агента."],
];

/** Which requirement each sentence belongs to, the way shipped titles read. */
const REQUIREMENT: Record<string, string> = {
  dispatchAccepted: "ROLL-19", dispatchRefused: "ROLL-19", dispatchUsage: "ROLL-19",
  jobRefused: "ROLL-19", agentAccepted: "ROLL-28", agentAdopted: "ROLL-28",
  agentBound: "ROLL-28", agentRetired: "ROLL-28", agentRefused: "ROLL-28",
  agentUsage: "ROLL-28",
};

/** The keys the door translates a value under. Everything else is data. */
const TRANSLATED = ["kind", "cause", "operation", "result", "wanted", "seen"];

/**
 * The check's OWN translation table, written out rather than imported, so a
 * build that changed the closed list cannot make this check agree with it.
 */
const RU_WORD: Record<string, string> = {
  "access denied": "доступ запрещён",
  "chat missing": "чат отсутствует",
  "command altered": "команда изменена",
  "not approved": "не подтверждено",
  "same device": "то же устройство",
  "copy does not match": "копия не совпадает",
  "unsupported on this platform": "на этой платформе недоступно",
  "chat name ambiguous": "название чата неоднозначно",
  "one agent per bot": "один агент на бота",
  dispatch: "передача",
  adopt: "принятие",
  retire: "отключение",
  backup: "копирование",
  install: "установка",
  done: "готово",
};

/** The values every sentence is rendered with, unless a case says otherwise. */
const VALUES: Record<string, unknown> = {
  agent: "p1-research",
  cause: "access denied",
  operation: "adopt",
  name: "synthetic chat name",
};

/** The check's own interpolation, which is the rule stated rather than reused. */
function fill(template: string, language: Language, values: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const raw = String(values[key] ?? "");
    return language === "ru" && TRANSLATED.includes(key) && RU_WORD[raw] !== undefined
      ? RU_WORD[raw]
      : raw;
  });
}

/**
 * The deliberately wrong twins, each built from the pinned literal. A twin that
 * equals the pinned sentence would assert nothing, so every one is checked to
 * have really changed before the render is compared against it.
 */
function twinsOf(expected: string, language: Language, template: string): [string, string][] {
  const mine = language === "en" ? EN_MARKER : RU_MARKER;
  const other = language === "en" ? RU_MARKER : EN_MARKER;
  const twins: [string, string][] = [
    ["an em dash where a full stop belongs", expected.replace(/\.(?=\s|$)/, " \u2014")],
    ["a semicolon where a full stop belongs", expected.replace(/\.(?=\s|$)/, ";")],
    ["the other language's marker", expected.replace(mine, other)],
  ];
  if (/\{\w+\}/.test(template)) twins.push(["a slot nobody replaced", template]);
  return twins;
}

// ---------------------------------------------------------------------------
// The twenty strings, whole.
// ---------------------------------------------------------------------------
for (const [key, en, ru] of TABLE) {
  for (const [language, template] of [["en", en], ["ru", ru]] as [Language, string][]) {
    test(`${REQUIREMENT[key]} ${key} is the whole ${language} sentence, carries its own marker and no other, and fails every wrong twin`, async () => {
      const mod = await seam("src/door/lines.ts");
      expect(typeof mod[key], `missing sentence ${key}`).toBe("function");
      expect(typeof mod.MACHINERY_LINES, "missing the marker table").toBe("object");
      const markers = mod.MACHINERY_LINES as Record<Language, string>;
      const render = mod[key] as Render;

      const expected = fill(template, language, VALUES);
      expect(render(language, VALUES)).toBe(expected);

      // The marker comes from the one table, never spelled a second time here.
      expect(render(language, VALUES).startsWith(markers[language])).toBe(true);
      const other = language === "en" ? markers.ru : markers.en;
      expect(render(language, VALUES)).not.toContain(other);

      // No slot survives into what a person reads.
      expect(render(language, VALUES)).not.toContain("{");

      for (const [why, twin] of twinsOf(expected, language, template)) {
        expect(twin, `the twin carrying ${why} must really differ`).not.toBe(expected);
        expect(render(language, VALUES), `a sentence with ${why} must not pass`).not.toBe(twin);
      }
    });

    test(`${REQUIREMENT[key]} ${key} renders every ${language} slot at an empty string, at 1, at 0 and at a large number`, async () => {
      const mod = await seam("src/door/lines.ts");
      expect(typeof mod[key], `missing sentence ${key}`).toBe("function");
      const render = mod[key] as Render;
      for (const one of ["", "1", "0", "4294967296"]) {
        const values = Object.fromEntries(Object.keys(VALUES).map((name) => [name, one]));
        expect(render(language, values)).toBe(fill(template, language, values));
        expect(render(language, values)).not.toContain("{");
      }
    });
  }

  test(`${REQUIREMENT[key]} ${key} leaves no English inside its Russian sentence`, async () => {
    const mod = await seam("src/door/lines.ts");
    expect(typeof mod[key], `missing sentence ${key}`).toBe("function");
    const render = mod[key] as Render;
    // Every value is Russian too, so any Latin letter left is the sentence's own.
    const russian = { agent: "агент-один", cause: "не подтверждено", operation: "принятие", name: "домашний чат" };
    expect(render("ru", russian)).not.toMatch(/[A-Za-z]/);
  });
}

// ---------------------------------------------------------------------------
// The closed list: the seven causes, the four labels, and the list being closed.
// ---------------------------------------------------------------------------
const SHIPPED_WORDS = [
  "voice", "photo", "file", "sticker", "video",
  "install", "recover", "sync", "convert",
  "done", "refused", "failed", "waiting",
  "running", "stopped", "scheduled", "missing", "unknown",
  "access denied", "chat missing", "login refused", "invalid configuration",
  "child exited", "memory limit reached", "task failed",
  "state unavailable on this machine", "delivery outcome unknown",
  "retry limit reached", "operation failed",
];

const NEW_CAUSES: [string, string][] = [
  ["command altered", "команда изменена"],
  ["not approved", "не подтверждено"],
  ["same device", "то же устройство"],
  ["copy does not match", "копия не совпадает"],
  ["unsupported on this platform", "на этой платформе недоступно"],
  ["chat name ambiguous", "название чата неоднозначно"],
  ["one agent per bot", "один агент на бота"],
];

const NEW_LABELS: [string, string][] = [
  ["dispatch", "передача"],
  ["adopt", "принятие"],
  ["retire", "отключение"],
  ["backup", "копирование"],
];

for (const [cause, russian] of NEW_CAUSES) {
  test(`ROLL-19 ROLL-32 the cause ${cause} is translated inside the refusal sentence and nowhere else`, async () => {
    const mod = await seam("src/door/lines.ts");
    expect(typeof mod.dispatchRefused, "missing sentence dispatchRefused").toBe("function");
    const render = mod.dispatchRefused as Render;
    expect(render("en", { agent: "p1-research", cause })).toBe(`[door] dispatch to p1-research refused: ${cause}.`);
    expect(render("ru", { agent: "p1-research", cause })).toBe(`[дверь] передача p1-research отклонена: ${russian}.`);
  });
}

for (const [label, russian] of NEW_LABELS) {
  test(`ROLL-19 ROLL-28 ROLL-32 the operation label ${label} is translated in the chat line and in the operator line`, async () => {
    const mod = await seam("src/door/lines.ts");
    expect(typeof mod.agentAccepted, "missing sentence agentAccepted").toBe("function");
    expect(typeof mod.operation, "missing template operation").toBe("function");
    const accepted = mod.agentAccepted as Render;
    const operation = mod.operation as Render;
    expect(accepted("en", { operation: label, agent: "p1-research" })).toBe(`[door] ${label} requested for p1-research.`);
    expect(accepted("ru", { operation: label, agent: "p1-research" })).toBe(`[дверь] запрошено: ${russian} для p1-research.`);
    expect(operation("en", { operation: label, target: "p1-research", result: "done" })).toBe(`${label}: p1-research: done.`);
    expect(operation("ru", { operation: label, target: "p1-research", result: "done" })).toBe(`${russian}: p1-research: готово.`);
  });
}

test("ROLL-19 ROLL-27 ROLL-28 ROLL-32 the closed list is exactly the shipped words plus the eleven decided here", async () => {
  const mod = await seam("src/door/lines.ts");
  expect(typeof mod.WORDS, "the closed list is not readable").toBe("object");
  const words = mod.WORDS as Record<string, string>;
  const wanted = [...SHIPPED_WORDS, ...NEW_CAUSES.map(([en]) => en), ...NEW_LABELS.map(([en]) => en)];
  expect(wanted).toHaveLength(40);
  expect(Object.keys(words).sort()).toEqual(wanted.sort());
});

test("ROLL-19 a cause nobody decided on is interpolated verbatim in both languages rather than refused", async () => {
  const mod = await seam("src/door/lines.ts");
  expect(typeof mod.dispatchRefused, "missing sentence dispatchRefused").toBe("function");
  const render = mod.dispatchRefused as Render;
  const cause = "synthetic-unlisted-cause";
  expect(render("en", { agent: "p1-research", cause })).toBe(`[door] dispatch to p1-research refused: ${cause}.`);
  expect(render("ru", { agent: "p1-research", cause })).toBe(`[дверь] передача p1-research отклонена: ${cause}.`);
});

test("ROLL-28 an unresolved chat name reuses the shipped chat missing cause and coins no twelfth word", async () => {
  const mod = await seam("src/door/lines.ts");
  expect(typeof mod.agentRefused, "missing sentence agentRefused").toBe("function");
  const render = mod.agentRefused as Render;
  const values = { operation: "adopt", agent: "p1-research", cause: "chat missing" };
  expect(render("en", values)).toBe("[door] adopt for p1-research refused: chat missing.");
  expect(render("ru", values)).toBe("[дверь] принятие для p1-research отклонено: чат отсутствует.");
});

// ---------------------------------------------------------------------------
// The finding codes and the operator lines.
// ---------------------------------------------------------------------------
const CODES = ["job-stale", "zone-undeclared", "zone-missing", "zone-remote-mismatch", "zone-unmounted", "backup-failed"];

for (const code of CODES) {
  test(`ROLL-19 ROLL-27 ROLL-32 the finding code ${code} stays machine vocabulary in both languages`, async () => {
    const mod = await seam("src/door/lines.ts");
    expect(typeof mod.finding, "missing template finding").toBe("function");
    expect(typeof mod.WORDS, "the closed list is not readable").toBe("object");
    const render = mod.finding as Render;
    const words = mod.WORDS as Record<string, string>;
    expect(render("en", { code, target: "p1-research", cause: "task failed" })).toBe(`${code}: p1-research: task failed.`);
    expect(render("ru", { code, target: "p1-research", cause: "task failed" })).toBe(`${code}: p1-research: ошибка задачи.`);
    // A code an operator greps for must never be translated, so it is not a word.
    expect(Object.hasOwn(words, code), `${code} must not be in the closed list`).toBe(false);
  });
}

for (const name of ["operation", "finding", "status", "checkClean", "cliUsage"]) {
  test(`ROLL-04 ROLL-29 the operator line ${name} carries no chat marker in either language`, async () => {
    const mod = await seam("src/door/lines.ts");
    expect(typeof mod[name], `missing template ${name}`).toBe("function");
    const render = mod[name] as Render;
    const values = {
      operation: "backup", target: "backup-hourly", result: "failed",
      code: "backup-failed", cause: "copy does not match",
      id: "runner-pi", wanted: "running", seen: "stopped", pid: 123,
    };
    for (const language of ["en", "ru"] as Language[]) {
      expect(render(language, values)).not.toContain(EN_MARKER);
      expect(render(language, values)).not.toContain(RU_MARKER);
    }
  });
}

test("ROLL-27 the zone install stage prints through the shipped operation line under the install label", async () => {
  const mod = await seam("src/door/lines.ts");
  expect(typeof mod.operation, "missing template operation").toBe("function");
  expect(typeof mod.WORDS, "the closed list is not readable").toBe("object");
  const render = mod.operation as Render;
  const words = mod.WORDS as Record<string, string>;
  expect(render("en", { operation: "install", target: "zone", result: "done" })).toBe("install: zone: done.");
  expect(render("ru", { operation: "install", target: "zone", result: "done" })).toBe("установка: zone: готово.");
  // The stage's own name is a target, so no label is coined for it.
  expect(Object.hasOwn(words, "zone"), "the stage name must not be a word").toBe(false);
});

// ---------------------------------------------------------------------------
// The two commands a person types.
// ---------------------------------------------------------------------------
test("ROLL-19 ROLL-28 the command phrases are pinned as data, so the recognizer, the usage line and the parser read one spelling", async () => {
  const mod = await seam("src/door/lines.ts");
  for (const name of ["DISPATCH_PHRASES", "AGENT_PHRASES", "ADOPT_PHRASES", "RETIRE_PHRASES"]) {
    expect(typeof mod[name], `missing phrase pair ${name}`).toBe("object");
  }
  expect(mod.DISPATCH_PHRASES).toEqual({ en: "/dispatch", ru: "/передать" });
  expect(mod.AGENT_PHRASES).toEqual({ en: "/agent", ru: "/агент" });
  expect(mod.ADOPT_PHRASES).toEqual({ en: "adopt", ru: "принять" });
  expect(mod.RETIRE_PHRASES).toEqual({ en: "retire", ru: "отключить" });

  // The sentence a person reads names the phrase they are asked to type.
  const phrases = mod.DISPATCH_PHRASES as Record<Language, string>;
  const agent = mod.AGENT_PHRASES as Record<Language, string>;
  const adopt = mod.ADOPT_PHRASES as Record<Language, string>;
  const retire = mod.RETIRE_PHRASES as Record<Language, string>;
  const dispatchUsage = mod.dispatchUsage as (language: string) => string;
  const agentUsage = mod.agentUsage as (language: string) => string;
  for (const language of ["en", "ru"] as Language[]) {
    expect(dispatchUsage(language)).toContain(phrases[language]);
    expect(agentUsage(language)).toContain(`${agent[language]} ${adopt[language]}`);
    expect(agentUsage(language)).toContain(`${agent[language]} ${retire[language]}`);
  }
});

const DISPATCH_CASES: [string, boolean][] = [
  ["/dispatch p1-research do the thing", true],
  ["/DISPATCH x", true],
  ["/передать p1-research задача", true],
  ["/ПЕРЕДАТЬ p1-research задача", true],
  ["/dispatch", true],
  ["he said /dispatch to me", false],
  ["/dispatcher x", false],
  ["/dispatchx", false],
  ["x /dispatch", false],
  ["", false],
  [" /dispatch p1-research", false],
];

for (const [text, matches] of DISPATCH_CASES) {
  test(`ROLL-19 a dispatch command is the verb at the very start: ${JSON.stringify(text)} is ${matches ? "a command" : "a message"}`, async () => {
    const mod = await seam("src/harvest/slice.ts");
    expect(typeof mod.isDispatchCommand, "missing recognizer isDispatchCommand").toBe("function");
    const is = mod.isDispatchCommand as (text: string) => boolean;
    expect(is(text)).toBe(matches);
  });
}

const AGENT_CASES: [string, boolean][] = [
  ["/agent adopt p1-new research", true],
  ["/AGENT retire p1-new", true],
  ["/агент принять p1-new research", true],
  ["/АГЕНТ отключить p1-new", true],
  ["/agent", true],
  ["he said /agent to me", false],
  ["/agentx", false],
  ["/agents", false],
  ["x /agent", false],
  ["", false],
  [" /agent adopt p1-new", false],
];

for (const [text, matches] of AGENT_CASES) {
  test(`ROLL-28 an agent command is the verb at the very start: ${JSON.stringify(text)} is ${matches ? "a command" : "a message"}`, async () => {
    const mod = await seam("src/harvest/slice.ts");
    expect(typeof mod.isAgentCommand, "missing recognizer isAgentCommand").toBe("function");
    const is = mod.isAgentCommand as (text: string) => boolean;
    expect(is(text)).toBe(matches);
  });
}

// ---------------------------------------------------------------------------
// A command is not a message: the harvest slice drops both.
// ---------------------------------------------------------------------------
const ORDINARY = "the dentist moved it to Thursday";
const AFTERWARDS = "and the tyres are booked for Friday";
const MENTION = "I told him to /dispatch it himself";

function plant(stateDir: string, at: string, text: string, from = PERSON): void {
  const file = chatLogFile({ stateDir, person: PERSON, agent: AGENT, at: new Date(at) });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ at, direction: from === PERSON ? "in" : "out", from, text }) + "\n", "utf8");
}

test("ROLL-19 ROLL-28 a harvest slice drops every command a person typed at the machinery and keeps every message", async () => {
  const mod = await seam("src/harvest/slice.ts");
  expect(typeof mod.readSlice, "missing readSlice").toBe("function");
  const read = mod.readSlice as (args: {
    stateDir: string; person: string; agent: string; from: string | null; until: string;
  }) => Promise<{ from: string; text: string }[]>;

  const commanded = await mkdtemp(join(tmpdir(), "hub-dispatch-slice-"));
  const ordinary = await mkdtemp(join(tmpdir(), "hub-dispatch-slice-control-"));
  try {
    const day = "2026-09-16T09:0";
    // The five lines, in the order a person would produce them.
    plant(commanded, `${day}0:00.000Z`, ORDINARY);
    plant(commanded, `${day}1:00.000Z`, "/dispatch p1-research draft the reply");
    plant(commanded, `${day}2:00.000Z`, "/agent adopt p1-new research");
    plant(commanded, `${day}3:00.000Z`, "/recover p1-lair");
    plant(commanded, `${day}4:00.000Z`, "harvest this");

    const where = { person: PERSON, agent: AGENT, from: null, until: `${day}5:00.000Z` };
    const slice = await read({ ...where, stateDir: commanded });
    expect(slice.map((line) => line.text), "only the message survives").toEqual([ORDINARY]);

    // THE CONTROL. The same five lines with the two commands written as
    // ordinary sentences, so a slice that dropped everything fails here.
    plant(ordinary, `${day}0:00.000Z`, ORDINARY);
    plant(ordinary, `${day}1:00.000Z`, "I want p1-research to draft the reply");
    plant(ordinary, `${day}2:00.000Z`, "and a new chat for it would help");
    plant(ordinary, `${day}3:00.000Z`, "/recover p1-lair");
    plant(ordinary, `${day}4:00.000Z`, "harvest this");
    const control = await read({ ...where, stateDir: ordinary });
    expect(control.map((line) => line.text), "control: ordinary sentences all survive").toEqual([
      ORDINARY,
      "I want p1-research to draft the reply",
      "and a new chat for it would help",
    ]);
  } finally {
    await rm(commanded, { recursive: true, force: true });
    await rm(ordinary, { recursive: true, force: true });
  }
});

test("ROLL-19 a person who writes the word inside a sentence is sending a message, and the slice keeps it", async () => {
  const mod = await seam("src/harvest/slice.ts");
  expect(typeof mod.readSlice, "missing readSlice").toBe("function");
  expect(typeof mod.isDispatchCommand, "missing recognizer isDispatchCommand").toBe("function");
  const read = mod.readSlice as (args: {
    stateDir: string; person: string; agent: string; from: string | null; until: string;
  }) => Promise<{ from: string; text: string }[]>;
  const is = mod.isDispatchCommand as (text: string) => boolean;

  const stateDir = await mkdtemp(join(tmpdir(), "hub-dispatch-mention-"));
  try {
    const day = "2026-09-16T10:0";
    plant(stateDir, `${day}0:00.000Z`, MENTION);
    plant(stateDir, `${day}1:00.000Z`, AFTERWARDS, AGENT);
    // A door line, which the shipped speaker filter drops on its own.
    plant(stateDir, `${day}2:00.000Z`, `${EN_MARKER} dispatched to p1-research.`, DOOR);
    expect(is(MENTION), "a mention is never a command").toBe(false);
    const slice = await read({ stateDir, person: PERSON, agent: AGENT, from: null, until: `${day}3:00.000Z` });
    expect(slice.map((line) => line.text)).toEqual([MENTION, AFTERWARDS]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
