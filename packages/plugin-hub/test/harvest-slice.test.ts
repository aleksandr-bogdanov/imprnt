// HARV-03. A slice is the lines between two instants that a person or an agent
// said, and nothing else.
//
// SPEC §4: the harvester is "given exactly the log slice and the vault's filing
// rules". L19's machinery point 2. L2: the chat log is the record, one dated
// file per agent, one JSON line per message.
//
// Pure over planted chat log files. No Postgres, no door, no runner. The chat
// log's shape is pinned elsewhere and this file writes the files itself from
// that shape: <state_dir>/<person>/chatlog/<agent>/<YYYY-MM-DD>.jsonl, one JSON
// object per line carrying `at`, `direction`, `from` and `text`, dated by the
// LINE's own `at` in UTC.
//
// Every time below is fixed rather than relative, so the same bytes are planted
// on every machine and at every hour of the day, and nothing here sleeps.
//
// The three machinery lines are written with the door's OWN functions, because
// what really lands in the log is what the filter has to drop. The probe
// measured the loop ignoring them once, and a model
// ignoring something once is not a rule: the filter is what makes it one.
//
// THE THIRTY DAY CAP IS A CONTRACT CHOICE AND NOT A SPEC LINE, and that is
// answered here rather than argued later.  SPEC
// section 4 grants no age exemption. The cap is `SLICE_MAX_DAYS`,
// and what it costs is stated plainly: the first harvest of a chat
// older than thirty days reaches back thirty days, and the rest of that log is
// on disk and unharvested. It is a named residue with a named alternative (a
// years-long log fed to a model in one message, which is worse) and a one-off
// catch-up a human can run. The assertion below
// binds the number the contract picked, so a build that picks another one is
// caught and the number is re-decided deliberately rather than in a check.
//
// Red reason: import missing, `src/harvest/slice.ts`.

import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { AGENT, AGENT2, DOOR, PERSON, chatLogFile } from "./helpers/hub-fixture.ts";
import { catchUpNotice, clockLine, outageNotice } from "../src/door/lines.ts";

/** The tests' own copy of one line of a slice, never imported from the build. */
interface SliceLine {
  at: string;
  direction: string;
  from: string;
  text: string;
}

const SLOW = 90_000;

/** The moment this check measures from. Fixed, so nothing depends on the hour. */
const NOW = new Date("2026-09-16T12:00:00.000Z");

/** One line, written the way the door writes one. */
function plant(
  stateDir: string,
  line: { at: string; direction: "in" | "out"; from: string; text: string },
  agent = AGENT,
): SliceLine {
  const file = chatLogFile({
    stateDir,
    person: PERSON,
    agent,
    at: new Date(line.at),
  });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
  return line;
}

const IN = (at: string, text: string) =>
  ({ at, direction: "in", from: PERSON, text }) as const;
const OUT = (at: string, text: string) =>
  ({ at, direction: "out", from: AGENT, text }) as const;
const DOOR_LINE = (at: string, text: string) =>
  ({ at, direction: "out", from: DOOR, text }) as const;

/** The pinned render, written out by the TEST: `<at> <from>: <text>`. */
function renderedBy(lines: SliceLine[]): string {
  return lines.map((line) => `${line.at} ${line.from}: ${line.text}`).join("\n");
}

test(
  "HARV-03 a slice is the lines between two instants whose sender is the person or the agent, the door's own lines and the demand phrase are never in it, and a chat the hub has never harvested reaches back thirty days and no further (SPEC §4, L19, L2, D-145, D-146)",
  async () => {
    const {
      readSlice,
      newestLine,
      renderSlice,
      isDemand,
      DEMAND_PHRASES,
      SLICE_MAX_DAYS,
      NEWEST_MAX_DAYS,
    } = await seam("src/harvest/slice.ts");
    expect(typeof readSlice).toBe("function");
    expect(typeof newestLine).toBe("function");
    expect(typeof renderSlice).toBe("function");
    expect(typeof isDemand).toBe("function");

    const slice = readSlice as (args: {
      stateDir: string;
      person: string;
      agent: string;
      from: string | null;
      until: string;
      skipBad?(bad: { file: string; line: number }): void;
    }) => Promise<SliceLine[]>;
    const newest = newestLine as (args: {
      stateDir: string;
      person: string;
      agent: string;
      now: Date;
    }) => Promise<SliceLine | null>;
    const render = renderSlice as (lines: SliceLine[]) => string;
    const demand = isDemand as (text: string) => boolean;

    const stateDir = await mkdtemp(join(tmpdir(), "hub-harvest-slice-"));
    try {
      // ---------------------------------------------------------------
      // The plant. Four dated files: forty days back, a week back,
      // yesterday and today, in a deliberate order.
      // ---------------------------------------------------------------
      const ancient = plant(stateDir, IN("2026-08-07T12:00:00.000Z", "forty days ago"));
      const weekBack = plant(stateDir, IN("2026-09-09T09:00:00.000Z", "the week before"));

      const in1 = plant(stateDir, IN("2026-09-15T10:00:00.000Z", "the dentist moved it to Thursday"));
      const out1 = plant(stateDir, OUT("2026-09-15T10:01:00.000Z", "noted, Thursday it is"));
      const clock = plant(
        stateDir,
        DOOR_LINE("2026-09-15T10:02:00.000Z", clockLine("en", "acked", 45)),
      );
      const mention = plant(
        stateDir,
        IN("2026-09-15T10:03:00.000Z", "can you harvest this later?"),
      );
      const outage = plant(
        stateDir,
        DOOR_LINE("2026-09-15T10:04:00.000Z", outageNotice("en", "login", 300)),
      );

      const in2 = plant(stateDir, IN("2026-09-16T09:00:00.000Z", "I cancelled the gym membership"));
      const out2 = plant(stateDir, OUT("2026-09-16T09:01:00.000Z", "cancelled, and the last charge was August"));
      const catchUp = plant(
        stateDir,
        DOOR_LINE("2026-09-16T09:02:00.000Z", catchUpNotice("en", 3)),
      );
      plant(stateDir, IN("2026-09-16T09:03:00.000Z", "harvest this"));
      plant(stateDir, IN("2026-09-16T09:04:00.000Z", "сохрани важное"));
      const in3 = plant(stateDir, IN("2026-09-16T09:05:00.000Z", "the wifi password is on the router"));
      // THE NEWEST PERSON-OR-AGENT LINE IS THE AGENT'S, deliberately. The
      // THE FINDING: with a person line newest, an implementation
      // that answered "the newest PERSON line" and one that answered "the
      // newest person-or-agent line" give the same answer, so the assertion
      // below would not tell them apart. A quiet clock re-armed only by what a
      // person says would harvest a chat the agent is still talking in.
      const out3 = plant(
        stateDir,
        OUT("2026-09-16T09:05:30.000Z", "it is taped under the router, second shelf"),
      );
      // A machinery line AFTER everything else, which is what assertion 9 is
      // about: a door line must not reset a quiet clock.
      const lastDoorLine = plant(
        stateDir,
        DOOR_LINE("2026-09-16T09:06:00.000Z", clockLine("en", "answered", 90)),
      );

      const where = { stateDir, person: PERSON, agent: AGENT };

      // ---------------------------------------------------------------
      // 1. The bounds. Strictly after `from`, at or before `until`, oldest
      //    first. The EXCLUSIVE lower bound is asserted with a line whose `at`
      //    equals `from`: it is absent, which is what stops a slice being
      //    harvested twice at its own edge.
      // ---------------------------------------------------------------
      const bounded = await slice({
        ...where,
        from: in1.at,
        until: out2.at,
      });
      expect(bounded.map((line) => line.text)).toEqual([
        out1.text,
        mention.text,
        in2.text,
        out2.text,
      ]);
      expect(bounded.some((line) => line.at === in1.at)).toBe(false);
      // The upper bound is INCLUSIVE, which the last element above already
      // says and this makes explicit.
      expect(bounded[bounded.length - 1].at).toBe(out2.at);

      // ---------------------------------------------------------------
      // 2. The machinery filter, however wide the bounds.
      // ---------------------------------------------------------------
      const everything = await slice({
        ...where,
        from: "2026-01-01T00:00:00.000Z",
        until: "2026-12-31T00:00:00.000Z",
      });
      for (const line of [clock, outage, catchUp, lastDoorLine]) {
        expect(everything.some((one) => one.text === line.text)).toBe(false);
      }
      expect(everything.some((one) => one.from === DOOR)).toBe(false);

      // ---------------------------------------------------------------
      // 3. The demand filter, and the discriminator that makes it exact: a
      //    message that merely MENTIONS the phrase is a message.
      // ---------------------------------------------------------------
      expect(everything.some((one) => one.text === "harvest this")).toBe(false);
      expect(everything.some((one) => one.text === "сохрани важное")).toBe(false);
      expect(everything.some((one) => one.text === mention.text)).toBe(true);

      // ---------------------------------------------------------------
      // 4. Both directions are kept, because a harvest reads the conversation
      //    and not one half of it.
      // ---------------------------------------------------------------
      expect(bounded.some((one) => one.direction === "in" && one.from === PERSON)).toBe(true);
      expect(bounded.some((one) => one.direction === "out" && one.from === AGENT)).toBe(true);

      // ---------------------------------------------------------------
      // 5. `isDemand` is pure and EXACT: trimmed and lowercased, never a
      //    prefix and never a substring.
      // ---------------------------------------------------------------
      expect(demand("harvest this")).toBe(true);
      expect(demand("Harvest This")).toBe(true);
      expect(demand("  harvest this  ")).toBe(true);
      expect(demand("сохрани важное")).toBe(true);
      expect(demand("СОХРАНИ ВАЖНОЕ")).toBe(true);
      expect(demand("can you harvest this later?")).toBe(false);
      expect(demand("harvest")).toBe(false);
      expect(demand("harvest this one")).toBe(false);
      expect(demand("")).toBe(false);

      // ---------------------------------------------------------------
      // 6. The phrases, as an object, whole, so a build that changed one is
      //    caught here rather than by a person whose phrase stopped working.
      // ---------------------------------------------------------------
      expect(DEMAND_PHRASES).toEqual({ en: "harvest this", ru: "сохрани важное" });

      // ---------------------------------------------------------------
      // 7. `renderSlice` is the pinned render, compared WHOLE against a string
      //    the test built: it is what the model is fed, and check 9 asserts
      //    the fed bytes exactly.
      // ---------------------------------------------------------------
      expect(render(bounded)).toBe(renderedBy(bounded));
      expect(render(bounded)).toBe(
        [
          `${out1.at} ${AGENT}: ${out1.text}`,
          `${mention.at} ${PERSON}: ${mention.text}`,
          `${in2.at} ${PERSON}: ${in2.text}`,
          `${out2.at} ${AGENT}: ${out2.text}`,
        ].join("\n"),
      );
      expect(render(bounded).endsWith("\n")).toBe(false);
      expect(render(bounded).startsWith(out1.at)).toBe(true);
      expect(render([])).toBe("");

      // ---------------------------------------------------------------
      // 8. The cap. A chat the hub has never harvested reaches back
      //    SLICE_MAX_DAYS and no further, which is a residue stated
      //    rather than hidden: the rest of that log is on disk and unharvested.
      // ---------------------------------------------------------------
      expect(SLICE_MAX_DAYS).toBe(30);
      expect(NEWEST_MAX_DAYS).toBe(7);
      const capped = await slice({ ...where, from: null, until: out3.at });
      expect(capped.some((one) => one.text === weekBack.text)).toBe(true);
      expect(capped.some((one) => one.text === ancient.text)).toBe(false);

      // ---------------------------------------------------------------
      // 9. `newestLine` is the newest PERSON-OR-AGENT line and not the newest
      //    line, which is assertion 2 seen from the quiet clock's end.
      // ---------------------------------------------------------------
      const seen = await newest({ ...where, now: NOW });
      expect(seen?.at).toBe(out3.at);
      expect(seen?.text).toBe(out3.text);
      expect(seen?.from).toBe(AGENT);
      // And it is NOT the newest person line, which is the discriminator: an
      // implementation reading only what the person said answers `in3` here.
      expect(seen?.at).not.toBe(in3.at);
      // A log with nothing inside NEWEST_MAX_DAYS answers null.
      plant(stateDir, IN("2026-08-07T12:00:00.000Z", "only an ancient line"), AGENT2);
      expect(
        await newest({ stateDir, person: PERSON, agent: AGENT2, now: NOW }),
      ).toBeNull();
      // And a chat with no log at all answers null rather than throwing.
      expect(
        await newest({ stateDir, person: PERSON, agent: "no-such-agent", now: NOW }),
      ).toBeNull();

      // ---------------------------------------------------------------
      // The control: bounds that hold only door lines come back EMPTY rather
      // than throwing, and bounds that hold nothing at all come back empty
      // too. A build whose filter dropped everything passes assertion 2 and
      // fails assertions 1 and 4.
      // ---------------------------------------------------------------
      expect(
        (await slice({ ...where, from: "2026-09-16T09:01:30.000Z", until: "2026-09-16T09:02:30.000Z" }))
          .length,
      ).toBe(0);
      expect(
        (await slice({ ...where, from: "2026-07-01T00:00:00.000Z", until: "2026-07-02T00:00:00.000Z" }))
          .length,
      ).toBe(0);
      expect(
        (await slice({ stateDir, person: PERSON, agent: "no-such-agent", from: null, until: in3.at }))
          .length,
      ).toBe(0);

      // ---------------------------------------------------------------
      // 10. A HALF-WRITTEN LAST LINE is tolerated in silence, and a damaged
      //     record anywhere else costs only itself: it is stepped over, named
      //     by its file and line, and the rest of the slice is read. Refusing
      //     the whole walk jammed the chat, because a demand is read while the
      //     door accepts the batch that carries it. It goes last, because both
      //     halves damage the log.
      // ---------------------------------------------------------------
      const newestFile = chatLogFile({
        stateDir,
        person: PERSON,
        agent: AGENT,
        at: new Date(in3.at),
      });
      appendFileSync(newestFile, '{"at":"2026-09-16T09:07:00.000Z","direction":"in","fr', "utf8");
      const tolerated = await slice({ ...where, from: in1.at, until: "2026-09-16T23:00:00.000Z" });
      expect(tolerated.some((one) => one.text === in3.text)).toBe(true);

      const olderFile = chatLogFile({
        stateDir,
        person: PERSON,
        agent: AGENT,
        at: new Date(in1.at),
      });
      const older = readFileSync(olderFile, "utf8").split("\n");
      const kept = await slice({ ...where, from: in1.at, until: "2026-09-16T23:00:00.000Z" });
      older.splice(1, 0, "{this is not JSON at all");
      writeFileSync(olderFile, older.join("\n"), "utf8");
      const named: { file: string; line: number }[] = [];
      const survived = await slice({
        ...where,
        from: in1.at,
        until: "2026-09-16T23:00:00.000Z",
        skipBad: (bad) => { named.push(bad); },
      });
      expect(named).toEqual([{ file: olderFile, line: 2 }]);
      expect(survived.map((one) => one.text)).toEqual(kept.map((one) => one.text));
    } finally {
      await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  },
  SLOW,
);
