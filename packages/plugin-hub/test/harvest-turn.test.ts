// HARV-01, HARV-04 and criterion 2. Three checks about the turn a harvest is.
//
// Check 9: a fresh session under the harvester's own preset in the person's
// vault, fed exactly one message, never the tail, with the agent's own session
// untouched. SPEC §4's Forbidden: "a harvester that sees chat context." L19
// rule 3: "a fresh session, no chat context, given exactly the log slice and the
// vault's filing rules." L2: the tail a spawned session is fed, which a
// harvester is NOT.
//
// Check 12: `nothing` is a real answer, an unreadable reply is not, and an
// empty slice costs no turn at all. SPEC §4's Forbidden: "a slice harvested
// twice."
//
// Check 14: every harvest turn carries the HARVESTER's preset id, and its
// tokens when there was a loop to report them. ROADMAP criterion 2, L18.
//
// THE LOOP IS SCRIPTED AND THE FILING IS REAL. Every note text below is a real
// note the real `imprnt ingest --apply` can file or refuse, written out here so
// a reader sees exactly what the machinery was given, and the vault it files
// into was scaffolded by the real `imprnt init`. Nothing here asserts anything
// about the model's judgment: which facts it kept, which slug it chose and
// whether `nothing` was the right answer vary between two runs of one slice
// (05-BRIEF) and the only place a real model appears at all is
// `live/harvest-turn.test.ts`.
//
// Red reasons. Check 9's tag is import missing `src/harvest/prompt.ts` plus
// behaviour absent, and what it OBSERVES is the behaviour, deliberately: the
// stage runs first so the fixture five checks lean on is exercised this round,
// and the shipped runner feeds the harvest row's JSON body to the chat agent's
// own session, so `starts()` holds one record instead of two. Check 12 is
// import missing, `src/harvest/parse.ts`. Check 14's tag is export missing
// `TurnRecord.harvest`, which is a TypeScript type and vanishes at run time
// (the same class as phase 4's checks 7, 9 and 14), so what it OBSERVES is
// behaviour absent: the criterion's own query comes back carrying the AGENT's
// preset id.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { seam, startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { expectedPresetId } from "./helpers/preset-oracle.ts";
import {
  plantLine,
  stageHarvest,
  type ChatLine,
  type HarvestStage,
} from "./helpers/harvest-stage.ts";
import {
  AGENT,
  DOOR,
  PERSON,
  RUNNER,
  insertInbound,
} from "./helpers/hub-fixture.ts";
import { TAIL_PREAMBLE } from "../src/chatlog.ts";
import { scriptedReply } from "./helpers/scripted-adapter.ts";

let cluster: Cluster;

const SLOW = 120_000;

/**
 * THE PROMPT, PINNED WHOLE, copied out of 05-CONTEXT.md by machine rather than
 * retyped. D-105's rule is that a string a reader depends on is pinned whole,
 * and here the reader is a model. `{LANGUAGE}` is its one slot.
 *
 * Every line of it closes a defect the probe measured (05-BRIEF): invented
 * entity slugs, invented frontmatter fields, a fabricated `source:` that
 * `--apply` keeps verbatim and records as the manifest's raw entry, and a
 * Russian slice filed as English notes.
 */
const PINNED_PROMPT = `You are the harvester. You read one slice of a chat and file what is worth keeping into the vault this session is running in, through the filing rules its CLAUDE.md carries.

Answer with NOTES ONLY, in this envelope:

=== NOTE ===
<one complete note: frontmatter between --- lines, then an H1 title, then the body>
=== END ===

One block per note, repeated for each note. Nothing outside the blocks.

The rules:
- Answer the single word nothing when the slice holds nothing worth keeping. That is a real answer, not a failure.
- Write every note in {LANGUAGE}: the title, the summary and the body.
- Mark your own conclusions {inferred}. Anything straight from the slice carries no marker.
- Never write a source: line. The filing machinery injects the real one, and an invented one is provenance pointing at nothing.
- Link a person only through a people note that already exists, by the slug that note really has. Read people/ to find it. Never invent a slug and never name anyone the slice does not name.
- Carry only the fields the filing rules define for that type. An invented field is noise the vault keeps for ever.
- You MAY read this vault with Read, Glob and Grep, to find a note to link and to avoid filing something the vault already holds. You cannot write to it: your text is the answer, and code does the filing.
- Do not run any command that writes, sends, fetches or installs anything.

The slice follows, one line per message, oldest first, as <time> <who>: <what>.`;

/** The prompt for one language, as the test computes it. */
function promptFor(language: "en" | "ru"): string {
  return PINNED_PROMPT.replace("{LANGUAGE}", language === "ru" ? "Russian" : "English");
}

/** The pinned render: `<at> <from>: <text>`, oldest first, no trailing newline. */
function renderLines(lines: { at: string; from: string; text: string }[]): string {
  return lines.map((line) => `${line.at} ${line.from}: ${line.text}`).join("\n");
}

/** The whole message a harvester is fed, computed by the TEST. */
function messageFor(
  language: "en" | "ru",
  lines: { at: string; from: string; text: string }[],
): string {
  return `${promptFor(language)}\n\n${renderLines(lines)}`;
}

/** A well-formed note the real CLI files, written out so a reader sees it. */
function envelope(...notes: string[]): string {
  return notes.map((one) => `=== NOTE ===\n${one}\n=== END ===`).join("\n\n");
}

const NOTE_FEE = `---
type: note
domain: finances
kind: reference
summary: The monthly card fee rises from nine to eleven in October.
tags: [banking, fees]
---

# Card fee rises in October

The bank said the monthly card fee goes from nine to eleven in October.`;

const NOTE_LEASE = `---
type: note
domain: life
kind: reference
summary: The lease notice period is two months.
tags: [housing]
---

# Lease notice period is two months

Notice has to be given two months before the renewal date.`;

/** A harvest row, planted as the DOOR role, exactly as `enqueueInbound` writes one. */
async function plantHarvestRow(
  stage: HarvestStage,
  body: { from: string | null; until: string; reason: string; lines: number; said?: string },
): Promise<string> {
  const id = `harvest:${AGENT}:${body.until}`;
  await insertInbound(cluster, stage.hub.db, {
    id,
    body: JSON.stringify(body),
    kind: "harvest",
  });
  return id;
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

// ---------------------------------------------------------------------------
// Check 9.
// ---------------------------------------------------------------------------

test(
  "HARV-01 and HARV-04 a harvest turn is a FRESH session under the harvester's own preset in the person's vault root, fed exactly one message that is the pinned prompt plus the rendered slice, never the tail, and the agent's resident session is not touched (SPEC §4, L19, L2, D-148, D-150, D-155)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");

    // NO DOOR IS STARTED, and that is the fix rather than a gate. This check
    // asserts nothing a door does: its person's `harvest_report` is false, so
    // no notice is owed and nothing has to be posted. A door running here would
    // be a fourth task reading this chat's log, and the daily backstop ignores
    // the minimum, so on a run in the first minutes of a UTC day it would
    // enqueue a harvest row nobody planted and the session and feed counts
    // below would be counting someone else's work. Removing the door removes
    // the exposure outright, which is better than skipping the check for an
    // hour a day.
    const stage = await stageHarvest(cluster, {
      hub: { tick_seconds: 2 },
      harvest: { quiet_minutes: 600, min_messages: 99, report: false },
    });
    const it = stage.hub;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      // The slice: three person lines, one agent line, and a DOOR line the
      // filter has to drop.
      const now = Date.now();
      const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
      const slice = [
        plantLine(stage, { at: at(30), direction: "in", from: PERSON, text: "the bank raised the card fee" }),
        plantLine(stage, { at: at(29), direction: "out", from: AGENT, text: "from nine to eleven, in October" }),
        plantLine(stage, { at: at(28), direction: "in", from: PERSON, text: "and the lease notice is two months" }),
        plantLine(stage, { at: at(27), direction: "in", from: PERSON, text: "remind me before March" }),
      ];
      const doorLine = plantLine(stage, {
        at: at(26),
        direction: "out",
        from: DOOR,
        text: "[door] still waiting: the loop has not accepted this message. 45 s so far.",
      });

      it.scripted.setAnswer(() => envelope(NOTE_FEE));

      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      // The agent's own session comes up first, and it is the one the harvest
      // must not disturb.
      await until(
        "the runner opened the agent's own session",
        () => it.scripted.starts().length >= 1,
        30_000,
        () => JSON.stringify(it.scripted.starts()),
      );
      // AND WAS FED ITS TAIL, before anything counts what came after. `spawn`
      // records the start, registers its handlers, reads the tail and only then
      // feeds it, so a wait on the START alone can land inside that gap and
      // capture `fedBefore` at zero with the tail feed still in flight. The
      // harvest assertions below would then see two entries and fail for a
      // fixture's reason rather than the runner's, which is the exact shape
      // this round's rules forbid. The tail is non-empty here, because five
      // lines are planted above and `hub.tail_hours` is a day.
      await until(
        "the agent's own session was fed the tail of its chat log",
        () => it.scripted.fed().some((one) => one.id === AGENT),
        30_000,
        () => JSON.stringify(it.scripted.fed()),
      );
      const agentStart = it.scripted.starts()[0];
      const fedBefore = it.scripted.fed().length;

      const rowId = await plantHarvestRow(stage, {
        from: null,
        until: new Date(now).toISOString(),
        reason: "quiet",
        lines: slice.length,
      });

      await until(
        "the harvest row reached answered",
        async () =>
          (await it.read.ledger({ stream: "inbound", subject: rowId })).some(
            (one) => one.kind === "answered",
          ),
        60_000,
        async () =>
          `inbound=${JSON.stringify(await it.read.inbound())} ledger=${JSON.stringify(
            await it.read.ledger({ subject: rowId }),
          )} starts=${JSON.stringify(it.scripted.starts())}`,
      );
      await Bun.sleep(1500);

      const starts = it.scripted.starts();

      // --- 1. A SECOND SESSION WAS STARTED. A build that reused the agent's
      //     session leaves one record here.
      expect(starts.length).toBe(2);
      const harvester = starts[1];

      // --- 12. THE HARVEST ROW'S REPLY REACHED NO CHAT. That is the failure
      //     the shipped runner produces: `oneTurn` branches on nothing but
      //     `tail`, so it posts the envelope into the person's chat.
      const outbox = await it.read.sql(
        "select id, inbound_id, kind, body from outbox order by id",
      );
      expect(outbox.some((row) => row.inbound_id === rowId)).toBe(false);

      // --- 2. `sessionId: null`, which is what makes it fresh. A resumed
      //     session is chat context by definition, and chat context is what
      //     SPEC §4's Forbidden line names.
      expect(harvester.sessionId).toBeNull();

      // --- 3. its preset is the HARVESTER's five settings, field by field
      //     against the file's own `[presets.harvest]`, and its derived id is
      //     the harvester's and NOT the agent's, both from the oracle.
      expect(harvester.preset).toEqual(stage.harvesterPreset as never);
      expect(expectedPresetId(harvester.preset as unknown as Record<string, string>)).toBe(
        expectedPresetId(stage.harvesterPreset),
      );
      expect(expectedPresetId(stage.harvesterPreset)).not.toBe(
        expectedPresetId(stage.agentPreset),
      );

      // --- 4. its cwd is the person's VAULT ROOT, exactly, computed by the
      //     test from the registry's own value. That is what makes the loop
      //     load the vault contract as its CLAUDE.md, which is L19's "given the
      //     vault's filing rules" delivered by the vault rather than by a
      //     prompt that restates them.
      expect(harvester.cwd).toBe(stage.vault.root);
      expect(existsSync(join(stage.vault.root, "CLAUDE.md"))).toBe(true);

      // --- 5. IT WAS WRAPPED, so the harvester runs in the agent's own box.
      //     Gated the way every box assertion in this suite is.
      if (process.platform === "darwin" || process.platform === "linux") {
        expect(harvester.wrapped).toBe(true);
      } else {
        expect(`skipped: no box on ${process.platform}`).toBeTruthy();
      }

      // --- 6. EXACTLY ONE MESSAGE was fed to it, and its bytes are the pinned
      //     message, compared WHOLE against one the test built from its own
      //     copy of the prompt and its own render of the four lines it planted.
      const fedAfter = it.scripted.fed().slice(fedBefore);
      expect(fedAfter.length).toBe(1);
      expect(fedAfter[0].text).toBe(messageFor("en", slice));

      // --- 6b. AND IT WENT INTO THE SECOND SESSION, not into the resident
      //     one. The second seat's finding: a count of feeds and a count of
      //     starts cannot tell a runner that opens an unused fresh harvester
      //     and feeds the slice into the AGENT's session from one that does it
      //     properly, because both produce two starts and one feed. The
      //     session the message really landed in is what tells them apart.
      expect(fedAfter[0].session).toBe(2);
      // And the resident session, which is the first start, was fed its tail
      // and nothing since.
      const intoAgent = it.scripted.fed().filter((one) => one.session === 1);
      expect(intoAgent.length).toBe(1);
      expect(intoAgent[0].id).toBe(AGENT);

      // --- 7. THE DOOR LINE IS NOT IN IT. Check 5 binds the filter, and this
      //     binds that the filter is on the path the model is really fed.
      expect(fedAfter[0].text).not.toContain(DOOR);
      expect(fedAfter[0].text).not.toContain(doorLine.text);
      expect(fedAfter[0].text).not.toContain("[door]");

      // --- 8. `TAIL_PREAMBLE` is not in the fed text, and the harvester's
      //     session was never fed a tail at all: `spawn` feeds a tail under the
      //     AGENT's id, and no such feed happened after the agent's own.
      expect(fedAfter[0].text).not.toContain(TAIL_PREAMBLE);
      expect(fedAfter.some((one) => one.id === AGENT)).toBe(false);
      expect(fedAfter[0].id).toBe(rowId);

      // --- 9. THE AGENT'S OWN SESSION IS UNTOUCHED, which is what D-148's
      //     placement is about: the harvest branch goes ABOVE the
      //     `presetId(preset) !== startedWith || own.killed` line, and a build
      //     that put it below respawns the resident session on every harvest
      //     and pays the tail's tokens again every quiet period.
      expect(starts[0]).toEqual(agentStart);
      expect(starts.length).toBe(2);

      // --- 11. NO `acked` AND NO `started` STAMP were written for the harvest
      //     row (D-155). Its ledger holds a `received` line from the door and
      //     an `answered` line from the runner and nothing between them.
      const stamps = await it.read.ledger({ stream: "inbound", subject: rowId });
      expect(stamps.map((one) => one.kind)).toEqual(["received", "answered"]);

      // -------------------------------------------------------------
      // 10. THE HARVESTER'S SESSION WAS CLOSED when the turn ended, so nothing
      //     of it survives to the next harvest. A closed scripted session
      //     hears nothing more, so a second harvest opens a THIRD start rather
      //     than reusing the second.
      // -------------------------------------------------------------
      //
      //     A NEW LINE IS PLANTED FIRST, and that is not decoration. The first
      //     harvest moved the watermark to the last line of its own slice, so a
      //     second row over the same lines would find an EMPTY slice, and D-149
      //     rules that an empty slice opens NO session at all. Demanding a
      //     third start over a slice with nothing in it would be demanding that
      //     a correct build break the contract. So there is something new to
      //     harvest, and only then is a third session owed.
      const afterFirst = plantLine(stage, {
        at: new Date(now + 500).toISOString(),
        direction: "in",
        from: PERSON,
        text: "one more thing worth keeping",
      });
      const secondRow = await plantHarvestRow(stage, {
        from: null,
        until: new Date(now + 1000).toISOString(),
        reason: "quiet",
        lines: 1,
      });
      await until(
        "the second harvest row reached answered",
        async () =>
          (await it.read.ledger({ stream: "inbound", subject: secondRow })).some(
            (one) => one.kind === "answered",
          ),
        60_000,
        async () => JSON.stringify(it.scripted.starts()),
      );
      expect(it.scripted.starts().length).toBe(3);
      expect(it.scripted.starts()[2].sessionId).toBeNull();
      // AND THE FIRST HARVESTER SESSION WAS REALLY CLOSED, which counting
      // starts cannot say: a runner that leaks each session and opens another
      // produces exactly this count. `close` is a verb the fixture implements,
      // so the call itself is recorded. Session 2 is closed and the resident
      // session 1 is NOT, because the agent's own session stays up between
      // turns and that is the whole of D-148's placement.
      expect(it.scripted.closes()).toContain(2);
      expect(it.scripted.closes()).not.toContain(1);
      // The second harvest was fed into the THIRD session, over the one line
      // the first harvest did not cover, which is what says the closed session
      // was not reused and the new slice is the new slice.
      const secondFeed = it.scripted.fed().filter((one) => one.session === 3);
      expect(secondFeed.length).toBe(1);
      expect(secondFeed[0].text).toBe(messageFor("en", [afterFirst]));
      // ONE CLOSE PER HARVEST SESSION, and the agent's own still open. Two
      // harvests, two closed sessions, and the resident one untouched.
      expect(it.scripted.closes().sort()).toEqual([2, 3]);

      // -------------------------------------------------------------
      // THE CONTROL, without which this is a check on a runner that does
      // nothing: a HUMAN row in the same stage is answered normally, through
      // the AGENT's own session, with one outbox chunk and no second session
      // started for it. A build that routed every row to a fresh harvester
      // session passes assertions 1 to 12 and fails this.
      // -------------------------------------------------------------
      const startsBefore = it.scripted.starts().length;
      it.scripted.setAnswer(null);
      await insertInbound(cluster, it.db, { id: "m-human", body: "an ordinary message" });
      await until(
        "the human row was answered into the outbox",
        async () =>
          (await it.read.outbox()).some((chunk) => chunk.inbound_id === "m-human"),
        60_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      const reply = (await it.read.outbox()).filter((chunk) => chunk.inbound_id === "m-human");
      expect(reply.length).toBe(1);
      expect(reply[0].body).toBe(scriptedReply("an ordinary message"));
      expect(it.scripted.starts().length).toBe(startsBefore);
      const humanStamps = await it.read.ledger({ stream: "inbound", subject: "m-human" });
      expect(humanStamps.map((one) => one.kind)).toContain("acked");
      expect(humanStamps.map((one) => one.kind)).toContain("started");
      expect(humanStamps.map((one) => one.kind)).toContain("answered");

      // -------------------------------------------------------------
      // The prompt itself, from the build, against this file's own copy. The
      // two must never drift, because what the build sends is what the model
      // reads and what this file asserts is what a human reviewed.
      // -------------------------------------------------------------
      const { HARVEST_PROMPT, LANGUAGE_NAMES, harvestPrompt, harvestMessage } = await seam(
        "src/harvest/prompt.ts",
      );
      expect(typeof harvestPrompt).toBe("function");
      expect(typeof harvestMessage).toBe("function");
      expect(HARVEST_PROMPT).toBe(PINNED_PROMPT);
      expect(LANGUAGE_NAMES).toEqual({ en: "English", ru: "Russian" });
      expect((harvestPrompt as Function)("en")).toBe(promptFor("en"));
      expect((harvestPrompt as Function)("ru")).toBe(promptFor("ru"));
      expect((harvestPrompt as Function)("ru")).toContain("Write every note in Russian");
      expect((harvestMessage as Function)({ language: "en", lines: slice })).toBe(
        messageFor("en", slice),
      );
    } finally {
      if (runner) await runner.stop();
      await stage.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 12.
// ---------------------------------------------------------------------------

test(
  "HARV-04 nothing is a real answer that moves the watermark, an unreadable reply refuses the turn, an empty slice costs no model turn at all, and a slice harvested twice is impossible by construction (SPEC §4, L19, D-149, D-151, D-153)",
  async () => {
    const { NOTE_OPEN, NOTE_CLOSE, SAID_CAP, parseHarvestReply } = await seam(
      "src/harvest/parse.ts",
    );
    expect(typeof parseHarvestReply).toBe("function");
    const parse = parseHarvestReply as (text: string) => { kind: string; notes?: string[]; said?: string };

    // -----------------------------------------------------------------
    // THE PARSER, PURE, FIRST. No store, no runner.
    // -----------------------------------------------------------------

    // 1. `nothing`, trimmed and case-insensitive. L19 rule 3's own words: it is
    //    a real answer, not a failure.
    for (const said of ["nothing", "Nothing", "  NOTHING  ", "nothing\n"]) {
      expect(parse(said)).toEqual({ kind: "nothing" });
    }

    // 3. the two markers, asserted as strings, because they are what the
    //    prompt tells the model to write and the two must never drift apart.
    expect(NOTE_OPEN).toBe("=== NOTE ===");
    expect(NOTE_CLOSE).toBe("=== END ===");
    expect(SAID_CAP).toBe(2000);
    expect(PINNED_PROMPT).toContain(NOTE_OPEN as string);
    expect(PINNED_PROMPT).toContain(NOTE_CLOSE as string);

    // 2. two well-formed blocks, both trimmed, in the reply's own order, with
    //    the prose before, between and after them DISCARDED, which is what a
    //    model that says "here are the notes:" produces.
    const two = parse(
      `here are the notes:\n\n=== NOTE ===\n${NOTE_FEE}\n=== END ===\n\nand one more:\n\n=== NOTE ===\n${NOTE_LEASE}\n=== END ===\n\nthat is all.`,
    );
    expect(two.kind).toBe("notes");
    expect(two.notes).toEqual([NOTE_FEE, NOTE_LEASE]);

    // 4. UNREADABLE, four ways, one at a time and never as a group.
    for (const [what, said] of [
      ["an open with no close", `=== NOTE ===\n${NOTE_FEE}`],
      ["a close with no open", `${NOTE_FEE}\n=== END ===`],
      ["an empty block", "=== NOTE ===\n   \n=== END ==="],
      ["no marker at all", "I had a look and here is what I think about all of it."],
    ] as [string, string][]) {
      const answer = parse(said);
      expect(`${what}: ${answer.kind}`).toBe(`${what}: unreadable`);
      expect(answer.said).toBe(said);
    }
    // and `said` is CAPPED, because it lands in a ledger detail and a whole
    // essay there is a row nobody reads.
    const essay = "x".repeat(5000);
    const capped = parse(essay);
    expect(capped.kind).toBe("unreadable");
    expect(capped.said!.length).toBe(2000);

    // 5. the control: a sentence that MEANS nothing is not the answer
    //    `nothing`. A build matching a substring passes assertion 1 and fails
    //    here.
    expect(parse("nothing worth keeping here, sorry").kind).toBe("unreadable");
    expect(parse("nothing at all").kind).toBe("unreadable");

    // -----------------------------------------------------------------
    // THEN THE THREE BEHAVIOURS, through the real runner.
    // -----------------------------------------------------------------
    const { runRunner } = await seam("src/runner/run.ts");
    const { stageDirFor } = await seam("src/harvest/apply.ts");
    const stagedAt = stageDirFor as (s: string, p: string, r: string) => string;
    const { HARVEST_SHEET } = await seam("src/harvest/sheet.ts");

    const stage = await stageHarvest(cluster, {
      hub: { tick_seconds: 2 },
      harvest: { quiet_minutes: 600, min_messages: 99, report: true },
    });
    const it = stage.hub;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      const now = Date.now();
      const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
      const slice = [
        plantLine(stage, { at: at(30), direction: "in", from: PERSON, text: "the bank raised the card fee" }),
        plantLine(stage, { at: at(29), direction: "in", from: PERSON, text: "and the lease notice is two months" }),
      ];
      const lastLine = slice[slice.length - 1];

      const watermark = async () =>
        (await it.read.harvestSheet()).find((row) => row.id === `${PERSON}/${AGENT}`) ?? null;

      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      const answered = async (id: string) =>
        (await it.read.ledger({ stream: "inbound", subject: id })).some(
          (one) => one.kind === "answered",
        );

      // --- 6. `nothing` SETTLES AND MOVES THE WATERMARK. The slice was read
      //     and judged and the filing that was owed was none. A watermark that
      //     stood still would feed the same slice to the model every quiet
      //     period for ever.
      it.scripted.setAnswer(() => "nothing");
      const nothingRow = await plantHarvestRow(stage, {
        from: null,
        until: new Date(now).toISOString(),
        reason: "quiet",
        lines: slice.length,
      });
      await until(
        "the nothing row was answered",
        () => answered(nothingRow),
        60_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      const afterNothing = await watermark();
      expect(afterNothing).not.toBeNull();
      expect((afterNothing!.data as Record<string, unknown>).at).toBe(lastLine.at);
      expect((afterNothing!.data as Record<string, unknown>).notes).toBe(0);
      // Nothing was staged and no apply was run at all.
      expect(existsSync(stagedAt(it.stateDir, PERSON, nothingRow))).toBe(false);
      // And no notice: the report says what was SAVED, and a quiet harvest
      // that saved nothing says nothing unless a person asked (check 13's
      // demand case).
      expect((await it.read.noticeRows()).length).toBe(0);
      const nothingRecord = (
        await it.read.ledger({ stream: "turn", subject: nothingRow })
      )[0];
      expect(
        ((nothingRecord.detail.harvest as Record<string, unknown>).notes as unknown[]).length,
      ).toBe(0);
      expect((nothingRecord.detail.harvest as Record<string, unknown>).lines).toBeGreaterThan(0);

      // --- 7. AN UNREADABLE REPLY REFUSES. The row goes back on its retry,
      //     one `refused.harvest` line carries the reply in `said` capped at
      //     2000, and the watermark does not move.
      const beforeRefusal = (await watermark())!.data;
      it.scripted.setAnswer(() => "I had a look and here is what I think about all of it.");
      plantLine(stage, { at: at(20), direction: "in", from: PERSON, text: "one more thing worth keeping" });
      const badRow = await plantHarvestRow(stage, {
        from: lastLine.at,
        until: new Date(now + 1000).toISOString(),
        reason: "quiet",
        lines: 1,
      });
      await until(
        "the unreadable reply refused the row",
        async () =>
          (await it.read.ledger({ stream: "refusal", subject: badRow })).length > 0,
        60_000,
        async () => JSON.stringify(await it.read.ledger({ subject: badRow })),
      );
      const refusal = (await it.read.ledger({ stream: "refusal", subject: badRow }))[0];
      expect(refusal.kind).toBe("refused.harvest");
      expect(String(refusal.detail.said)).toContain("I had a look");
      expect(String(refusal.detail.said).length).toBeLessThanOrEqual(2000);
      const heldRow = (await it.read.inbound()).find((row) => row.id === badRow)!;
      expect(heldRow.claimed_by).toBeNull();
      expect(heldRow.state).not.toBe("answered");
      expect((await watermark())!.data).toEqual(beforeRefusal);
      expect(existsSync(stagedAt(it.stateDir, PERSON, badRow))).toBe(false);

      // PARK THE REFUSED ROW, so nothing below is racing its retry. The second
      // seat's finding: `hub.outage_retry_seconds` is two in this stage, so
      // that row comes back every two seconds, and once the scripted answer
      // changes below it would succeed, move the watermark and change the very
      // slice the next stages are about. Its own assertions are all made by
      // now, so pushing its retry out of the check's lifetime costs nothing and
      // makes every stage after it deterministic.
      await it.read.sql(
        "update inbound set retry_at = now() + interval '1 hour' where id = $1",
        [badRow],
      );

      // --- 8. AN EMPTY SLICE COSTS NO MODEL TURN. A row whose bounds hold no
      //     line at all opens no session, feeds no message, and still writes
      //     its `turn` ledger line, or criterion 2's query is vacuously true
      //     for the case it exists to cover.
      it.scripted.setAnswer(() => "nothing");
      const startsBefore = it.scripted.starts().length;
      const fedBefore = it.scripted.fed().length;
      //     THE WINDOW ITSELF IS EMPTY, and that is the fixture correction the
      //     second seat found. The runner recomputes the slice from the SHEET's
      //     watermark and never from the row's own `from` (D-149), so a row
      //     whose `from` sits in the future changes nothing: the slice is still
      //     everything after the stored watermark, and there IS an unharvested
      //     line, so a correct build would open a session and this assertion
      //     would fail for the fixture's reason.
      //
      //     What is really empty is a row whose `until` is at or before the
      //     watermark, because the slice is `(watermark, until]` and that
      //     interval is empty however many lines are on disk. It is also the
      //     real case D-149 names: a quiet row overtaken by a row that already
      //     harvested past it.
      const storedAt = String(((await watermark())!.data as Record<string, unknown>).at);
      const emptyRow = await plantHarvestRow(stage, {
        from: null,
        until: storedAt,
        reason: "quiet",
        lines: 0,
      });
      await until(
        "the empty row was answered",
        () => answered(emptyRow),
        60_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      expect(it.scripted.starts().length).toBe(startsBefore);
      expect(it.scripted.fed().length).toBe(fedBefore);
      const emptyRecord = (await it.read.ledger({ stream: "turn", subject: emptyRow }))[0];
      expect(emptyRecord).toBeDefined();
      expect((emptyRecord.detail.harvest as Record<string, unknown>).lines).toBe(0);
      expect(emptyRecord.detail.input_tokens).toBeNull();
      expect(emptyRecord.detail.session_id).toBeNull();
      expect(emptyRecord.detail.preset_id).toBe(expectedPresetId(stage.harvesterPreset));

      // --- 9. TWICE IS IMPOSSIBLE, and this is where it is bound. Two harvest
      //     rows for one chat whose bounds OVERLAP: the first files, and the
      //     second computes its slice AFTER the first advanced the watermark,
      //     finds it empty, and opens no session. One agent has one runner and
      //     one open turn, so two rows run one after the other.
      //
      //     THE PAIR IS QUIET THEN BACKSTOP, not two quiet rows, and that is
      //     the second seat's real point about this stage. A runner that
      //     recomputes a QUIET row's slice from the sheet but trusts a BACKSTOP
      //     row's own declared bounds passes a two-quiet-row arrangement and
      //     still harvests one span twice the moment a real backstop carries
      //     stale overlapping bounds. The backstop below declares `from: null`
      //     and a wide `until`, which is exactly what a backstop written before
      //     the quiet row settled would carry.
      it.scripted.setAnswer(() => envelope(NOTE_FEE));
      plantLine(stage, { at: at(10), direction: "in", from: PERSON, text: "and the card fee is eleven now" });
      const overlapUntil = new Date(now + 30_000).toISOString();
      const feedBefore = it.scripted.fed().length;
      const firstOverlap = await plantHarvestRow(stage, {
        from: null,
        until: overlapUntil,
        reason: "quiet",
        lines: 5,
      });
      const secondOverlap = await plantHarvestRow(stage, {
        from: null,
        until: new Date(now + 31_000).toISOString(),
        reason: "backstop",
        lines: 5,
      });
      await until(
        "both overlapping rows were answered",
        async () => (await answered(firstOverlap)) && (await answered(secondOverlap)),
        90_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      // Exactly ONE harvest message was fed across the two rows.
      expect(it.scripted.fed().length - feedBefore).toBe(1);
      const secondRecord = (
        await it.read.ledger({ stream: "turn", subject: secondOverlap })
      )[0];
      expect((secondRecord.detail.harvest as Record<string, unknown>).lines).toBe(0);
      // The BACKSTOP row's own body still says five, and its record says zero,
      // which is the whole point: the row is what the door believed and the
      // sheet is what is true, for every trigger and not only for the quiet
      // one.
      expect(
        (JSON.parse(
          String(
            ((await it.read.inbound()).find((one) => one.id === secondOverlap)!).body,
          ),
        ) as Record<string, unknown>).lines,
      ).toBe(5);

      // --- the control for 6 and 8 together: a well-formed envelope in this
      //     same stage DOES stage, DOES apply and DOES move the watermark with
      //     `notes` above zero, so a build that never staged anything passes 6,
      //     7 and 8 and fails this.
      const rows = await it.read.sheet(HARVEST_SHEET as string);
      const landed = rows.find((row) => row.id === `${PERSON}/${AGENT}`)!;
      expect(Number(landed.data.notes)).toBeGreaterThan(0);
      expect(existsSync(join(stage.vault.vaultDir, "finances"))).toBe(true);
    } finally {
      if (runner) await runner.stop();
      await stage.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 14.
// ---------------------------------------------------------------------------

test(
  "criterion 2 every harvest turn carries the HARVESTER's preset id unconditionally and its three token counts when there was a loop to report them, asked as the criterion's own query (SPEC §4, L19, L18, D-157)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");

    const stage = await stageHarvest(cluster, {
      hub: { tick_seconds: 2 },
      harvest: { quiet_minutes: 600, min_messages: 99, report: false },
    });
    const it = stage.hub;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      const now = Date.now();
      const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
      const slice = [
        plantLine(stage, { at: at(30), direction: "in", from: PERSON, text: "the bank raised the card fee" }),
        plantLine(stage, { at: at(29), direction: "in", from: PERSON, text: "and the lease notice is two months" }),
      ];

      // The criterion's own query, written out here exactly as 05-CONTEXT pins
      // it, so a later board asks it the same way.
      const CRITERION_QUERY = `select e.detail from ledger_event e
    join inbound i on i.id = e.subject
   where e.stream = 'turn' and i.kind = 'harvest'`;

      // The control, asserted BEFORE anything runs: against a store where no
      // harvest has run the query returns zero rows, so a build whose query
      // matched every turn line would fail on the count.
      expect((await it.read.sql(CRITERION_QUERY)).length).toBe(0);

      it.scripted.setUsage({
        input_tokens: 4321,
        cached_input_tokens: 1200,
        output_tokens: 777,
        plan_usage: { some: "reading" },
        raw: { input_tokens: 4321, output_tokens: 777 },
      });
      it.scripted.setAnswer(() => envelope(NOTE_FEE));

      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      // One row over a slice WITH lines, and one over an EMPTY slice, which is
      // D-149's overtaken row.
      const withLines = await plantHarvestRow(stage, {
        from: null,
        until: new Date(now).toISOString(),
        reason: "quiet",
        lines: slice.length,
      });
      const empty = await plantHarvestRow(stage, {
        from: new Date(now + 10_000).toISOString(),
        until: new Date(now + 20_000).toISOString(),
        reason: "backstop",
        lines: 0,
      });
      // And one HUMAN row in the same stage, for assertion 7.
      await insertInbound(cluster, it.db, { id: "m-human", body: "an ordinary message" });

      await until(
        "both harvest rows and the human row were answered",
        async () => {
          const ledger = await it.read.ledger({ stream: "turn" });
          return ledger.length >= 3;
        },
        90_000,
        async () =>
          `inbound=${JSON.stringify(await it.read.inbound())} turns=${JSON.stringify(
            await it.read.ledger({ stream: "turn" }),
          )}`,
      );
      await Bun.sleep(1000);

      // --- 1. the query returns TWO rows. The empty-slice turn wrote its own
      //     `turn` line too, or the query is vacuously true for the case it
      //     exists to cover.
      const found = (await it.read.sql(CRITERION_QUERY)) as {
        detail: Record<string, unknown>;
      }[];
      expect(found.length).toBe(2);

      const harvesterId = expectedPresetId(stage.harvesterPreset);
      const agentId = expectedPresetId(stage.agentPreset);
      expect(harvesterId).not.toBe(agentId);

      for (const row of found) {
        const detail = row.detail;
        // --- 2. a non-empty `preset_id`, the HARVESTER's, computed by the
        //     oracle outside the code under test, and NOT the agent's.
        expect(detail.preset_id).toBe(harvesterId);
        expect(detail.preset_id).not.toBe(agentId);
        // --- 3. `preset` is the harvester preset's NAME, and
        //     `preset_settings` is exactly its five keys.
        expect(detail.preset).toBe("harvest");
        expect(Object.keys(detail.preset_settings as Record<string, string>).sort()).toEqual([
          "adapter",
          "effort",
          "model",
          "paid",
          "provider",
        ]);
        expect(detail.preset_settings).toEqual(stage.harvesterPreset as never);
        // --- 6. `tail` is false on both, so `check`'s `newestWork` counts a
        //     harvest turn as work and a runner that only harvests is not
        //     reported silent.
        expect(detail.tail).toBe(false);
        // --- 5. the `harvest` object, as a key set, with each value checked
        //     below.
        expect(Object.keys(detail.harvest as Record<string, unknown>).sort()).toEqual([
          "conflicts",
          "from",
          "lines",
          "notes",
          "reason",
          "staged",
          "until",
        ]);
      }

      const { stageDirFor } = await seam("src/harvest/apply.ts");
      const stagedAt = stageDirFor as (s: string, p: string, r: string) => string;

      const byLines = new Map(
        found.map((row) => [
          Number((row.detail.harvest as Record<string, unknown>).lines),
          row.detail,
        ]),
      );
      const ran = [...byLines.entries()].find(([lines]) => lines > 0)![1];
      const none = byLines.get(0)!;

      // --- 4. TOKENS, CONDITIONALLY. Numbers when the slice had lines, null
      //     when it did not: null is what the loop did not report, which is
      //     the rule `AdapterUsage` already states, and zero would be a claim.
      expect(ran.input_tokens).toBe(4321);
      expect(ran.cached_input_tokens).toBe(1200);
      expect(ran.output_tokens).toBe(777);
      expect(ran.session_id).not.toBeNull();
      expect(none.input_tokens).toBeNull();
      expect(none.cached_input_tokens).toBeNull();
      expect(none.output_tokens).toBeNull();
      expect(none.session_id).toBeNull();
      expect(none.plan_usage).toBeNull();
      expect(none.raw_usage).toEqual({});

      // --- 5, each value. `until` and `reason` are the row's own, `notes`
      //     holds the folder/slug that filed, `conflicts` is empty here, and
      //     `staged` is the directory the test computed from `stageDirFor`.
      const ranHarvest = ran.harvest as Record<string, unknown>;
      expect(ranHarvest.until).toBe(new Date(now).toISOString());
      expect(ranHarvest.reason).toBe("quiet");
      expect((ranHarvest.notes as string[]).length).toBeGreaterThan(0);
      expect(ranHarvest.conflicts).toEqual([]);
      expect(ranHarvest.staged).toBe(stagedAt(it.stateDir, PERSON, withLines));
      const noneHarvest = none.harvest as Record<string, unknown>;
      expect(noneHarvest.reason).toBe("backstop");
      expect(noneHarvest.notes).toEqual([]);
      expect(noneHarvest.staged).toBe(stagedAt(it.stateDir, PERSON, empty));

      // --- 7. A NON-HARVEST TURN'S RECORD IS UNCHANGED: the human row writes
      //     a `turn` line with NO `harvest` key at all. `TurnRecord.harvest` is
      //     optional and spread only on a harvest turn, which is what keeps
      //     test/turn-record.test.ts and test/chatlog.test.ts green.
      const human = (await it.read.ledger({ stream: "turn", subject: "m-human" }))[0];
      expect(human).toBeDefined();
      expect("harvest" in human.detail).toBe(false);
      expect(human.detail.preset_id).toBe(agentId);
    } finally {
      if (runner) await runner.stop();
      await stage.stop();
    }
  },
  SLOW,
);
