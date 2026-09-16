// MSG-08 and RUN-19. The thresholds are one table in the registry, per person,
// and the window thresholds are settings on the preset rather than numbers in
// code.
//
// SPEC §2: "Thresholds are one table in the registry, per person, not per
// agent." Its defaults until measured: acked within 30 s, started within 60 s,
// answered within 15 min, delivered within 60 s of answered. SPEC §6's
// Forbidden carries "a window threshold in code", "a setting nothing in
// production reads" and "a quiet default on a bad value". L10 rule 4: "An agent
// on a per-token key has no window."
//
// Pure. No Postgres and no operating system: the registry is a file and the
// loader is a file loader.
//
// "Names the line" is the behaviour, so every refusal here binds the KEY and
// the LINE and never merely that something threw. The shipped loader already
// throws for other reasons, and a check that only caught a throw could not tell
// a correct refusal from an accidental one. Every bad file below is valid in
// every OTHER respect, for the same reason.
//
// THE CONVENTION FOR AN ABSENT KEY, which the shipped loader already uses: a
// key that is not in the file has no line of its own, so the refusal names the
// line of the table it should have been under. That is what a missing
// `memory_limit_mb` already names (`run[n]`'s own id line) and what a missing
// preset setting already names (the `[presets.<name>]` header).
//
// Red reason for both: behaviour absent. `loadRegistry` parses `[[people]]` for
// `id` and `tree` and looks at nothing else, and it tolerates every window key
// on every preset, so all of the bad files below load with no complaint.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts";
/** The pinned formula, computed by the test rather than read from the build. */
import { expectedPresetId } from "./helpers/preset-oracle.ts";

let dir: string;

function write(lines: string[]): string {
  dir ??= mkdtempSync(join(tmpdir(), "hub-thresholds-"));
  const file = join(dir, `registry-${crypto.randomUUID().slice(0, 8)}.toml`);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/** One-based line of the nth line whose text is exactly this. */
function lineOf(lines: string[], text: string, nth = 1): number {
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === text && ++seen === nth) return i + 1;
  }
  throw new Error(`the fixture has no ${nth} occurrence of ${JSON.stringify(text)}`);
}

/** Replace the nth occurrence of a line. */
function replace(lines: string[], text: string, withText: string, nth = 1): string[] {
  const out = [...lines];
  out[lineOf(lines, text, nth) - 1] = withText;
  return out;
}

/** Drop the nth occurrence of a line, keeping every other line's number. */
function drop(lines: string[], text: string, nth = 1): string[] {
  return replace(lines, text, "# this line was removed by the check", nth);
}

function refusalOf(file: string): RegistryRefused {
  try {
    loadRegistry(file);
  } catch (error) {
    return error as RegistryRefused;
  }
  throw new Error(`${file} loaded, and it should have been refused`);
}

// ---------------------------------------------------------------------------
// Check 1: the person thresholds and the language.
// ---------------------------------------------------------------------------

/**
 * Two people whose every threshold DIFFERS, so a build that reads one person's
 * row for everybody fails, and none of the eight numbers is a default, so a
 * build that answers with the defaults fails too.
 */
function peopleLines(): string[] {
  return [
    "# the hub's registry",
    "",
    "[hub]",
    "tick_seconds = 5",
    "",
    "[[people]]",
    'id = "p1"',
    'tree = "/var/lib/imprnt-hub/p1"',
    'language = "en"',
    "acked_seconds = 31",
    "started_seconds = 61",
    "answered_seconds = 901",
    "delivered_seconds = 61",
    "",
    "[[people]]",
    'id = "p2"',
    'tree = "/var/lib/imprnt-hub/p2"',
    'language = "ru"',
    "acked_seconds = 7",
    "started_seconds = 11",
    "answered_seconds = 21",
    "delivered_seconds = 9",
  ];
}

test("MSG-08 the thresholds are one table per person and a bad one refuses the file by name and by line: four bad numbers and a language this hub does not speak, with a file that sets none of them still loading on the defaults (SPEC §2, L6, L14)", async () => {
  const base = peopleLines();

  // --- 1. a threshold of zero. A clock that runs out at once is a clock
  //     nobody set, and the quiet default is what RUN-08 forbids.
  {
    const lines = replace(base, "acked_seconds = 31", "acked_seconds = 0");
    const refusal = refusalOf(write(lines));
    expect(refusal).toBeInstanceOf(RegistryRefused);
    expect(refusal.key).toContain("people[0]");
    expect(refusal.key).toContain("acked_seconds");
    expect(refusal.line).toBe(lineOf(lines, "acked_seconds = 0"));
    expect(String(refusal.message)).toContain(String(refusal.line));
  }

  // --- 2. a threshold that is a word.
  {
    const lines = replace(base, "started_seconds = 61", 'started_seconds = "soon"');
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toContain("people[0]");
    expect(refusal.key).toContain("started_seconds");
    expect(refusal.line).toBe(lineOf(lines, 'started_seconds = "soon"'));
    expect(refusal.reason).toContain("started_seconds");
  }

  // --- 3. a negative threshold.
  {
    const lines = replace(base, "answered_seconds = 901", "answered_seconds = -1");
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toContain("people[0]");
    expect(refusal.key).toContain("answered_seconds");
    expect(refusal.line).toBe(lineOf(lines, "answered_seconds = -1"));
  }

  // --- 4. a threshold that is not a whole number. Half a second is a number a
  //     household would read as accepted and a clock cannot be armed on.
  {
    const lines = replace(base, "delivered_seconds = 61", "delivered_seconds = 1.5");
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toContain("people[0]");
    expect(refusal.key).toContain("delivered_seconds");
    expect(refusal.line).toBe(lineOf(lines, "delivered_seconds = 1.5"));
  }

  // --- 5. a language this household does not speak. The refusal says which
  //     two it has, because a person reading it has to know what to write.
  {
    const lines = replace(base, 'language = "ru"', 'language = "de"');
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toContain("people[1]");
    expect(refusal.key).toContain("language");
    expect(refusal.line).toBe(lineOf(lines, 'language = "de"'));
    expect(refusal.reason).toContain("en");
    expect(refusal.reason).toContain("ru");
  }

  // --- control (a): the good file loads, and every field comes back PER
  //     PERSON. The two differ in all five, so a build that read the first
  //     person's row for everybody fails here rather than in a chat.
  const { thresholdsFor, languageOf } = await seam("src/registry/entries.ts");
  expect(typeof thresholdsFor).toBe("function");
  expect(typeof languageOf).toBe("function");

  const good = loadRegistry(write(base));
  expect((thresholdsFor as Function)(good, "p1")).toEqual({
    acked_seconds: 31,
    started_seconds: 61,
    answered_seconds: 901,
    delivered_seconds: 61,
  });
  expect((thresholdsFor as Function)(good, "p2")).toEqual({
    acked_seconds: 7,
    started_seconds: 11,
    answered_seconds: 21,
    delivered_seconds: 9,
  });
  expect((languageOf as Function)(good, "p1")).toBe("en");
  expect((languageOf as Function)(good, "p2")).toBe("ru");

  // --- control (b): THE TOLERANCE, and it is what keeps every shipped check
  //     green. A file whose people carry `id` and `tree` alone still loads,
  //     the accessors answer with the defaults, and `listPeople`'s rows gain
  //     NO keys: `test/registry-machines.test.ts` asserts that exact shape
  //     today, and a build that always spreads five more onto the entry breaks
  //     it. The five fields are optional, and this is where that is bound.
  const { listPeople } = await seam("src/registry/entries.ts");
  const { STAMP_THRESHOLD_DEFAULTS, DEFAULT_LANGUAGE } = await seam(
    "src/registry/load.ts",
  );
  const bare = loadRegistry(
    write([
      "[hub]",
      "tick_seconds = 5",
      "",
      "[[people]]",
      'id = "p1"',
      'tree = "/var/lib/imprnt-hub/p1"',
    ]),
  );
  expect((listPeople as Function)(bare)).toEqual([
    { id: "p1", tree: "/var/lib/imprnt-hub/p1" },
  ]);
  expect((thresholdsFor as Function)(bare, "p1")).toEqual(
    STAMP_THRESHOLD_DEFAULTS as Record<string, number>,
  );
  expect((languageOf as Function)(bare, "p1")).toBe(DEFAULT_LANGUAGE);

  // --- control (c): an unrelated extra key on a person still loads, so what
  //     is refused is a bad threshold and not novelty. That is the narrowing
  //     control every shipped refusal check carries.
  {
    const lines = [...base];
    lines.splice(lineOf(base, 'language = "en"'), 0, 'nickname = "the first"');
    expect(loadRegistry(write(lines))).toBeDefined();
  }

  // --- control (d): the defaults are L6's own four numbers, asserted as an
  //     object, so a build that renumbers one is caught here rather than in a
  //     chat six months later.
  expect(STAMP_THRESHOLD_DEFAULTS).toEqual({
    acked_seconds: 30,
    started_seconds: 60,
    answered_seconds: 900,
    delivered_seconds: 60,
  });
  expect(DEFAULT_LANGUAGE).toBe("en");
});

// ---------------------------------------------------------------------------
// Check 2: the window thresholds on the preset, and the preset id unchanged.
// ---------------------------------------------------------------------------

/**
 * One plan preset carrying the three window thresholds, and one key preset
 * carrying none, which is the pair the whole of L10 rule 4 is about.
 */
function presetLines(): string[] {
  return [
    "# the hub's registry",
    "",
    "[hub]",
    "tick_seconds = 5",
    "",
    "[presets.daily]",
    'adapter = "an-adapter"',
    'model = "a-model-name"',
    'provider = "a-provider"',
    'effort = "medium"',
    'paid = "plan"',
    "window_pause_at = 85",
    "window_notice_at = 95",
    "window_hold_at = 100",
    "",
    "[presets.metered]",
    'adapter = "an-adapter"',
    'model = "a-model-name"',
    'provider = "a-provider"',
    'effort = "medium"',
    'paid = "key"',
  ];
}

test("RUN-19 a window threshold in code is absent: a plan preset carries all three or the file is refused, a key preset carrying one is refused by name, and the preset id is the same sixteen characters it was (SPEC §6 Forbidden, L10 rule 4, L18)", async () => {
  const base = presetLines();
  const header = lineOf(base, "[presets.daily]");

  // --- half one, the file carries them or nothing runs.

  // Each of the three missing on a plan preset, asserted one at a time. A
  // check that dropped all three together would pass a loader that only asked
  // about the first one it looked at.
  for (const field of ["window_pause_at", "window_notice_at", "window_hold_at"]) {
    const line = base.find((one) => one.startsWith(`${field} `))!;
    const refusal = refusalOf(write(drop(base, line)));
    expect(refusal).toBeInstanceOf(RegistryRefused);
    expect(refusal.key).toBe(`presets.daily.${field}`);
    // An absent key has no line of its own, so the refusal names the table it
    // belongs to, which is the convention the shipped loader already uses for
    // a missing preset setting.
    expect(refusal.line).toBe(header);
    expect(String(refusal.message)).toContain(String(header));
  }

  // Each of the three present on a KEY preset, asserted one at a time. "A
  // setting nothing in production reads" is forbidden, and an agent on a
  // per-token key has no window at all.
  //
  // THE VALUE IS NOT THE PLAN PRESET'S (the second seat's finding). With `85`
  // on both, `lineOf` found the plan preset's line first and a refusal that
  // correctly named the key preset's own line would have failed. The numbers
  // here are in range and in order, so the only rule that can refuse them is
  // the one this half is about.
  for (const [field, value] of [
    ["window_pause_at", 42],
    ["window_notice_at", 43],
    ["window_hold_at", 44],
  ] as [string, number][]) {
    const line = `${field} = ${value}`;
    const lines = [...base, line];
    // The fixture's own guard: one occurrence, so the oracle cannot pick the
    // wrong one however the file grows.
    expect(lines.filter((one) => one === line).length).toBe(1);
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toBe(`presets.metered.${field}`);
    expect(refusal.line).toBe(lineOf(lines, line));
    expect(refusal.reason).toContain("key");
  }

  // `paid` is a closed set of two, and the refusal says which two.
  {
    const lines = replace(base, 'paid = "key"', 'paid = "subscription"');
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toBe("presets.metered.paid");
    expect(refusal.line).toBe(lineOf(lines, 'paid = "subscription"'));
    expect(refusal.reason).toContain("plan");
    expect(refusal.reason).toContain("key");
  }

  // The range, both ends. Percent is 1 to 100 and nothing else.
  for (const [was, now] of [
    ["window_pause_at = 85", "window_pause_at = 0"],
    ["window_hold_at = 100", "window_hold_at = 101"],
    ["window_notice_at = 95", 'window_notice_at = "most of it"'],
  ] as [string, string][]) {
    const lines = replace(base, was, now);
    // One occurrence, so the line the refusal names can only be this one.
    expect(lines.filter((one) => one === now).length).toBe(1);
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toBe(`presets.daily.${now.split(" ")[0]}`);
    expect(refusal.line).toBe(lineOf(lines, now));
  }

  // The ORDER. A file that says hold at 50 and pause at 90 would pause nothing
  // and hold everything with no complaint, which is the quiet default RUN-08
  // forbids.
  {
    const lines = replace(
      replace(base, "window_pause_at = 85", "window_pause_at = 90"),
      "window_hold_at = 100",
      "window_hold_at = 50",
    );
    const refusal = refusalOf(write(lines));
    expect(refusal.key).toContain("presets.daily.window_");
    expect(refusal.reason).toContain("90");
  }

  // --- the control. Without it this is a check on a loader that refuses
  //     everything, and that proves nothing.
  const { windowThresholds, credentialOfPreset } = await seam(
    "src/registry/presets.ts",
  );
  expect(typeof windowThresholds).toBe("function");
  expect(typeof credentialOfPreset).toBe("function");

  const registry = loadRegistry(write(base));
  expect((windowThresholds as Function)(registry, "daily")).toEqual({
    pause_at: 85,
    notice_at: 95,
    hold_at: 100,
  });
  // A key preset has no window, which is L10 rule 4 as a value rather than as
  // a sentence.
  expect((windowThresholds as Function)(registry, "metered")).toBeNull();

  // --- half two, and it is the reason this check lives in this file: the
  //     window fields are not part of the preset id, and `PresetEntry` did not
  //     grow. `src/runner/run.ts` writes `preset_settings: { ...preset }` into
  //     every turn record and `test/turn-record.test.ts` asserts that object
  //     equals the fixture's five keys, so a grown entry changes the meaning of
  //     every turn record in the world even with the hash untouched.
  const { getPreset, presetId, PRESET_FIELDS } = await seam(
    "src/registry/presets.ts",
  );
  const preset = (getPreset as Function)(registry, "daily") as Record<string, string>;
  const five = {
    adapter: "an-adapter",
    effort: "medium",
    model: "a-model-name",
    paid: "plan",
    provider: "a-provider",
  };
  expect((presetId as Function)(preset)).toBe(expectedPresetId(five));

  // The same five settings in a file that carries NO window field at all give
  // the same sixteen characters. That is what makes "the window fields are not
  // part of the id" a behaviour rather than a promise.
  const elsewhere = loadRegistry(
    write([
      "[hub]",
      "tick_seconds = 5",
      "",
      "[presets.daily]",
      'adapter = "an-adapter"',
      'model = "a-model-name"',
      'provider = "a-provider"',
      'effort = "medium"',
      'paid = "key"',
    ]),
  );
  const other = (getPreset as Function)(elsewhere, "daily") as Record<string, string>;
  expect((presetId as Function)({ ...other, paid: "plan" })).toBe(
    (presetId as Function)(preset),
  );

  expect([...(PRESET_FIELDS as string[])].sort()).toEqual([
    "adapter",
    "effort",
    "model",
    "paid",
    "provider",
  ]);
  // The one a build fails by growing PresetEntry.
  expect(Object.keys(preset).sort()).toEqual([
    "adapter",
    "effort",
    "model",
    "paid",
    "provider",
  ]);
});
