// HARV-04. One line back into the chat, per person, in that person's own
// language, and always when a person asked.
//
// L19 rule 4: "One line back into the chat, optional per person." It is
// on by default for the owner and off for the second person, and it is one
// `notice` outbox row per harvest, key `harvest:<row id>`, written before the
// settle, suppressed when `harvest_report` is false EXCEPT on a demand harvest,
// which always answers, because a person who typed a phrase at the machinery
// and got silence has no way to tell it worked from a hub that is broken.
//
// The real runner AND the real door, so the line is asserted where a person
// reads it: on the platform. Both are stopped in `finally`.
//
// Every string is written out HERE and never imported, the way
// test/runner-window.test.ts writes out the window lines. A
// human reads it, so it is pinned whole.
//
// THE COUNT IS NEVER GLUED TO A NOUN in either language. The LIST carries it,
// which is the catch-up line's own lesson, and it is why Russian number
// agreement never arises.
//
// Red reason: export missing, `harvestReport` and `harvestNothing` in
// `src/door/lines.ts`. The module is on disk and does not carry them.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  lockTable,
  seam,
  startCluster,
  startReadySubprocess,
  until,
  waitForBackendsGone,
  waitForLockWaiter,
  type Cluster,
  type HeldLock,
  type ReadyProcess,
} from "./helpers/cluster.ts";
import { writeGatedImprntShim } from "./helpers/imprnt-shim.ts";
import { scratchVault, slugOf, type ScratchVault } from "./helpers/scratch-vault.ts";
import { stageHarvest, type HarvestStage } from "./helpers/harvest-stage.ts";
import { announceClock, clockGate, clockSuffix } from "./helpers/clock-gate.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  RUNNER,
  chatLogFile,
  chatLogLines,
  insertInbound,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 120_000;

// THE CLOCK GATE. This check plants forty minutes back and runs a real door
// with a ten hour quiet period, so nothing fires on its own. The daily backstop
// ignores that: one line older than the last UTC midnight owes one, and a
// harvest row nobody planted would derail every notice count below. Forty
// minutes of planting plus about two minutes of running is fifty.
const GATE_13 = clockGate(50);
announceClock(GATE_13, "check 13, the line back into the chat");

// ---------------------------------------------------------------------------
// The five forms, pinned WHOLE, both languages, written out by this file.
// ---------------------------------------------------------------------------

const EN_SAVED = (notes: string) => `[door] saved. Notes: ${notes}.`;
const RU_SAVED = (notes: string) => `[дверь] сохранено. Заметки: ${notes}.`;
const EN_SAVED_WITH_CONFLICTS = (notes: string, conflicts: string) =>
  `[door] saved. Notes: ${notes}. Already there with different text, not overwritten: ${conflicts}.`;
const RU_SAVED_WITH_CONFLICTS = (notes: string, conflicts: string) =>
  `[дверь] сохранено. Заметки: ${notes}. Уже есть с другим текстом, не перезаписано: ${conflicts}.`;
const EN_CONFLICTS_ONLY = (conflicts: string) =>
  `[door] nothing saved. Already there with different text, not overwritten: ${conflicts}.`;
const RU_CONFLICTS_ONLY = (conflicts: string) =>
  `[дверь] ничего не сохранено. Уже есть с другим текстом, не перезаписано: ${conflicts}.`;
const EN_NOTHING = "[door] nothing worth keeping this time.";
const RU_NOTHING = "[дверь] в этот раз сохранять нечего.";

// ---------------------------------------------------------------------------
// The notes, real ones the real CLI files.
// ---------------------------------------------------------------------------

const FEE_TITLE = "Card fee rises in October";
const LEASE_TITLE = "Lease notice period is two months";

const FEE_SLUG = `finances/${slugOf(FEE_TITLE)}`;
const LEASE_SLUG = `life/${slugOf(LEASE_TITLE)}`;

const NOTE_FEE = `---
type: note
domain: finances
kind: reference
summary: The monthly card fee rises from nine to eleven in October.
tags: [banking, fees]
---

# ${FEE_TITLE}

The bank said the monthly card fee goes from nine to eleven in October.`;

const NOTE_FEE_DIFFERENT = NOTE_FEE.replace("nine to eleven", "nine to twelve");

const NOTE_LEASE = `---
type: note
domain: life
kind: reference
summary: The lease notice period is two months.
tags: [housing]
---

# ${LEASE_TITLE}

Notice has to be given two months before the renewal date.`;

function envelope(...notes: string[]): string {
  return notes.map((one) => `=== NOTE ===\n${one}\n=== END ===`).join("\n\n");
}

interface ChatLine {
  at: string;
  direction: "in" | "out";
  from: string;
  text: string;
}

function plant(
  stateDir: string,
  person: string,
  agent: string,
  line: ChatLine,
): ChatLine {
  const file = chatLogFile({ stateDir, person, agent, at: new Date(line.at) });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
  return line;
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

test.skipIf(!GATE_13.ok)(
  "HARV-04 one line goes back into the chat naming what was saved, in that person's own language, off when the setting says off, always on when a person asked, once per harvest and never twice (SPEC §4, L19, D-105, D-122, D-153, D-159)" + clockSuffix(GATE_13),
  async () => {
    const { harvestReport, harvestNothing, MACHINERY_LINES } = await seam("src/door/lines.ts");
    expect(typeof harvestReport).toBe("function");
    expect(typeof harvestNothing).toBe("function");
    const report = harvestReport as (
      language: string,
      what: { notes: string[]; conflicts: string[] },
    ) => string;
    const nothing = harvestNothing as (language: string) => string;

    // -----------------------------------------------------------------
    // THE STRINGS FIRST, PURE. All five forms, both languages, WHOLE.
    // -----------------------------------------------------------------
    // 1 and 2. notes, no conflicts.
    expect(report("en", { notes: ["finances/a", "people/b"], conflicts: [] })).toBe(
      EN_SAVED("finances/a, people/b"),
    );
    expect(report("ru", { notes: ["finances/a", "people/b"], conflicts: [] })).toBe(
      RU_SAVED("finances/a, people/b"),
    );
    // 3. notes and conflicts.
    expect(
      report("en", { notes: ["finances/a"], conflicts: ["people/b", "life/c"] }),
    ).toBe(EN_SAVED_WITH_CONFLICTS("finances/a", "people/b, life/c"));
    expect(
      report("ru", { notes: ["finances/a"], conflicts: ["people/b", "life/c"] }),
    ).toBe(RU_SAVED_WITH_CONFLICTS("finances/a", "people/b, life/c"));
    // 4. conflicts only.
    expect(report("en", { notes: [], conflicts: ["finances/a"] })).toBe(
      EN_CONFLICTS_ONLY("finances/a"),
    );
    expect(report("ru", { notes: [], conflicts: ["finances/a"] })).toBe(
      RU_CONFLICTS_ONLY("finances/a"),
    );
    // 5. the nothing line.
    expect(nothing("en")).toBe(EN_NOTHING);
    expect(nothing("ru")).toBe(RU_NOTHING);

    // NO COUNT IS GLUED TO A NOUN in either language: the same function
    // produces a correct sentence for one, two and five notes with no other
    // change, so Russian number agreement never arises.
    for (const many of [
      ["finances/a"],
      ["finances/a", "people/b"],
      ["finances/a", "people/b", "life/c", "work/d", "health/e"],
    ]) {
      expect(report("en", { notes: many, conflicts: [] })).toBe(EN_SAVED(many.join(", ")));
      expect(report("ru", { notes: many, conflicts: [] })).toBe(RU_SAVED(many.join(", ")));
      // and not one of them names a number anywhere.
      expect(/\b\d+\b/.test(report("ru", { notes: many, conflicts: [] }))).toBe(false);
    }

    // Every one of them is built from the marker the door already owns, so the
    // marker is defined once and cannot drift into the strings it defines.
    const markers = MACHINERY_LINES as Record<string, string>;
    expect(report("en", { notes: ["a/b"], conflicts: [] }).startsWith(markers.en)).toBe(true);
    expect(report("ru", { notes: ["a/b"], conflicts: [] }).startsWith(markers.ru)).toBe(true);
    expect(nothing("ru").startsWith(markers.ru)).toBe(true);

    // -----------------------------------------------------------------
    // THEN THE BEHAVIOUR. Two people, two vaults, one runner, one door.
    // -----------------------------------------------------------------
    const { runRunner } = await seam("src/runner/run.ts");
    const { runDoor } = await seam("src/door/run.ts");

    const secondTree = await mkdtemp(join(tmpdir(), "hub-harvest-tree2-"));
    let secondVault: ScratchVault | null = null;
    let stage: HarvestStage | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    let door: { stop(): Promise<void> } | null = null;
    try {
      secondVault = await scratchVault(secondTree);
      const hers = secondVault;

      stage = await stageHarvest(cluster, {
        hub: { tick_seconds: 2, outage_retry_seconds: 2 },
        harvestPeople: [
          {
            id: PERSON,
            language: "en",
            harvest_quiet_minutes: 600,
            harvest_min_messages: 99,
            harvest_report: true,
          },
          {
            id: PERSON2,
            language: "ru",
            tree: secondTree,
            harvester: "harvest",
            vault: hers.root,
            harvest_quiet_minutes: 600,
            harvest_min_messages: 99,
            harvest_report: false,
          },
        ],
        agents: [
          { id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}1`, door: DOOR, runner: RUNNER },
        ],
      });
      const it = stage.hub;
      const now = Date.now();
      // PLAIN OFFSETS, strictly ordered. The clock gate at the top of this
      // file is what keeps the stage inside one UTC day.
      const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

      for (const [person, agent] of [
        [PERSON, AGENT],
        [PERSON2, AGENT2],
      ] as [string, string][]) {
        plant(it.stateDir, person, agent, {
          at: at(40),
          direction: "in",
          from: person,
          text: "the bank raised the card fee",
        });
        plant(it.stateDir, person, agent, {
          at: at(39),
          direction: "in",
          from: person,
          text: "and the lease notice is two months",
        });
      }

      const plantRow = async (
        agent: string,
        body: { from: string | null; until: string; reason: string; lines: number },
      ): Promise<string> => {
        const id = `harvest:${agent}:${body.until}`;
        await insertInbound(cluster, it.db, {
          id,
          body: JSON.stringify(body),
          kind: "harvest",
          person: agent === AGENT ? PERSON : PERSON2,
          agent,
        });
        return id;
      };

      // TWO notes in one envelope, so a build that wrote a notice per NOTE
      // rather than per harvest fails assertion 6's count.
      it.scripted.setAnswer(() => envelope(NOTE_FEE, NOTE_LEASE));

      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      const hisRow = await plantRow(AGENT, {
        from: null,
        until: new Date(now).toISOString(),
        reason: "quiet",
        lines: 2,
      });
      const herRow = await plantRow(AGENT2, {
        from: null,
        until: new Date(now).toISOString(),
        reason: "quiet",
        lines: 2,
      });

      await until(
        "the first person's notice was posted into their chat",
        () => it.fake.posts().some((post) => post.chat === CHAT),
        90_000,
        async () =>
          `notices=${JSON.stringify(await it.read.noticeRows())} inbound=${JSON.stringify(
            await it.read.inbound(),
          )}`,
      );
      await until(
        "the second person's harvest settled too",
        async () =>
          (await it.read.ledger({ stream: "turn", subject: herRow })).length > 0,
        90_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      await Bun.sleep(1500);

      // --- 6. THE FIRST PERSON GETS ONE NOTICE, in `en`, naming the notes
      //     that really filed, with the key the row's own id builds, posted
      //     into that chat by the DOOR and written into the chat log `from`
      //     the door's entry id, which is what the next spawned session reads.
      const his = (await it.read.noticeRows()).filter((row) => row.person === PERSON);
      expect(his.length).toBe(1);
      expect(his[0].notice_key).toBe(`harvest:${hisRow}`);
      expect(his[0].kind).toBe("notice");
      expect(his[0].inbound_id).toBeNull();
      expect(his[0].body).toBe(EN_SAVED(`${FEE_SLUG}, ${LEASE_SLUG}`));
      expect(his[0].delivered_at).not.toBeNull();
      const posted = it.fake.posts().filter((post) => post.chat === CHAT);
      expect(posted.some((post) => post.text === EN_SAVED(`${FEE_SLUG}, ${LEASE_SLUG}`))).toBe(true);
      expect(
        chatLogLines(it.stateDir, PERSON, AGENT).some(
          (line) =>
            line.direction === "out" &&
            line.from === DOOR &&
            line.text === EN_SAVED(`${FEE_SLUG}, ${LEASE_SLUG}`),
        ),
      ).toBe(true);

      // --- 7. THE SECOND PERSON GETS NONE, and the setting suppresses the
      //     LINE and nothing else: her harvest still filed and her watermark
      //     still moved.
      expect((await it.read.noticeRows()).filter((row) => row.person === PERSON2)).toEqual([]);
      expect(it.fake.posts().some((post) => post.chat === `${CHAT}1`)).toBe(false);
      const herWatermark = (await it.read.harvestSheet()).find(
        (row) => row.id === `${PERSON2}/${AGENT2}`,
      );
      expect(herWatermark).toBeDefined();
      const herTurn = (await it.read.ledger({ stream: "turn", subject: herRow }))[0];
      expect(((herTurn.detail.harvest as Record<string, unknown>).notes as string[]).length).toBe(2);

      // --- 12. ONE NOTICE PER HARVEST AND NEVER TWO, bound in the two
      //     directions a check can actually reach.
      //
      //     THE PLAN ASKED FOR A REPLAY AND THE SCHEMA FORBIDS IT. The first
      //     version of this stage deleted the row's `answered` stamp so the
      //     runner would go through it again. `ledger_event` carries a
      //     `before update or delete` trigger that raises unconditionally, for
      //     every role including the superuser, because a diary entry is never
      //     changed and never deleted. And even past it, `inbound.state` is
      //     derived by an AFTER INSERT trigger, so removing a stamp would not
      //     make the row claimable again. A settled row is never re-claimed,
      //     which means the only way one harvest attempts its notice twice is a
      //     crash between `appendNotice` and `settleHarvest`, and no check can
      //     stage that without reaching into `src/`. It is stated as a residue
      //     rather than faked here.
      //
      //     (a) TWO HARVESTS OF ONE CHAT GET TWO NOTICES, with two different
      //     keys. This is the direction that actually bites: a build that keyed
      //     the notice on the person or on the agent rather than on the ROW
      //     writes the first line and then silently drops every later one, and
      //     the person simply stops hearing about their harvests.
      // The slug is COMPUTED from the title this file chose, not typed out.
      // Measured against the real CLI on 2026-09-16 (`✓ filed
      // life/boiler-service-booked-for-the-3rd`), and computed here so a
      // changed title or a changed `deriveSlug` is caught rather than followed.
      const BOILER_TITLE = "Boiler service booked for the 3rd";
      const BOILER_SLUG = `life/${slugOf(BOILER_TITLE)}`;
      const hisSecondLine = plant(it.stateDir, PERSON, AGENT, {
        at: at(20),
        direction: "in",
        from: PERSON,
        text: "and the boiler service is booked for the 3rd",
      });
      it.scripted.setAnswer(() =>
        envelope(NOTE_LEASE.replace(LEASE_TITLE, BOILER_TITLE)),
      );
      const hisSecondRow = await plantRow(AGENT, {
        from: null,
        until: new Date(now + 500).toISOString(),
        reason: "quiet",
        lines: 1,
      });
      await until(
        "the second harvest of the same chat got its own notice",
        async () =>
          (await it.read.noticeRows()).some(
            (row) => row.notice_key === `harvest:${hisSecondRow}`,
          ),
        90_000,
        async () => JSON.stringify(await it.read.noticeRows()),
      );
      const hisNotices = (await it.read.noticeRows()).filter((row) => row.person === PERSON);
      expect(hisNotices.length).toBe(2);
      expect(new Set(hisNotices.map((row) => row.notice_key)).size).toBe(2);
      expect(hisNotices[0].notice_key).toBe(`harvest:${hisRow}`);
      expect(hisNotices[1].notice_key).toBe(`harvest:${hisSecondRow}`);
      // The second line is the second harvest's whole slice, and the second
      // notice names the note it produced, so the two lines are about two
      // different harvests rather than one line written twice.
      expect(hisNotices[1].body).toBe(EN_SAVED(BOILER_SLUG));
      expect(hisNotices[1].body).not.toBe(hisNotices[0].body);
      expect(hisSecondLine.direction).toBe("in");

      //     (b) AND THE KEY IS WHAT MAKES A SECOND ONE IMPOSSIBLE. `appendNotice`
      //     is driven twice with one harvest key through the real `hub_runner`
      //     role: the first lands, the second answers false, and the table holds
      //     one row. That is the one-notice arithmetic, reused rather than rebuilt, and
      //     it is what a crash between the notice and the settle would meet.
      const { openStore, storeUrlAs } = await seam("src/store/connect.ts");
      const { appendNotice } = await seam("src/store/outbox.ts");
      const asRunner = await (openStore as Function)({
        url: (storeUrlAs as Function)(it.storeUrl, "hub_runner"),
      });
      try {
        const key = `harvest:${hisRow}`;
        const before = (await it.read.noticeRows()).filter(
          (row) => row.notice_key === key,
        ).length;
        expect(before).toBe(1);
        const again = await (appendNotice as Function)(asRunner, {
          person: PERSON,
          agent: AGENT,
          body: "[door] saved. Notes: finances/a-second-attempt.",
          noticeKey: key,
        });
        expect(again).toBe(false);
        expect(
          (await it.read.noticeRows()).filter((row) => row.notice_key === key).length,
        ).toBe(1);
      } finally {
        await asRunner.close().catch(() => {});
      }

      // --- 8. A DEMAND HARVEST ALWAYS ANSWERS, whatever the setting. Her
      //     notice appears, in `ru`, whole.
      plant(it.stateDir, PERSON2, AGENT2, {
        at: at(10),
        direction: "in",
        from: PERSON2,
        text: "and the car is booked in for Friday",
      });
      const herDemand = await plantRow(AGENT2, {
        from: null,
        until: new Date(now + 1000).toISOString(),
        reason: "demand",
        lines: 1,
      });
      it.scripted.setAnswer(() => envelope(NOTE_LEASE.replace(LEASE_TITLE, "Car booked in for Friday")));
      await until(
        "the demand harvest answered the second person in her own language",
        async () =>
          (await it.read.noticeRows()).some((row) => row.notice_key === `harvest:${herDemand}`),
        90_000,
        async () => JSON.stringify(await it.read.noticeRows()),
      );
      const demandNotice = (await it.read.noticeRows()).find(
        (row) => row.notice_key === `harvest:${herDemand}`,
      )!;
      expect(demandNotice.person).toBe(PERSON2);
      expect(demandNotice.body).toBe(RU_SAVED("life/car-booked-in-for-friday"));

      // --- 9. A DEMAND THAT SAVED NOTHING answers the nothing line.
      plant(it.stateDir, PERSON2, AGENT2, {
        at: at(5),
        direction: "in",
        from: PERSON2,
        text: "nothing much really",
      });
      it.scripted.setAnswer(() => "nothing");
      const herEmptyDemand = await plantRow(AGENT2, {
        from: null,
        until: new Date(now + 2000).toISOString(),
        reason: "demand",
        lines: 1,
      });
      await until(
        "the demand that saved nothing still answered",
        async () =>
          (await it.read.noticeRows()).some(
            (row) => row.notice_key === `harvest:${herEmptyDemand}`,
          ),
        90_000,
        async () => JSON.stringify(await it.read.noticeRows()),
      );
      expect(
        (await it.read.noticeRows()).find(
          (row) => row.notice_key === `harvest:${herEmptyDemand}`,
        )!.body,
      ).toBe(RU_NOTHING);

      // --- 10. A QUIET HARVEST THAT SAVED NOTHING ANSWERS NOTHING AT ALL, for
      //     the person whose report is ON. The report says what was saved and
      //     there is nothing to say, which is what separates it from the demand
      //     case above.
      plant(it.stateDir, PERSON, AGENT, {
        at: at(4),
        direction: "in",
        from: PERSON,
        text: "just chatter",
      });
      const hisQuietNothing = await plantRow(AGENT, {
        from: null,
        until: new Date(now + 3000).toISOString(),
        reason: "quiet",
        lines: 1,
      });
      await until(
        "the quiet nothing settled",
        async () =>
          (await it.read.ledger({ stream: "turn", subject: hisQuietNothing })).length > 0,
        90_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      expect(
        (await it.read.noticeRows()).some(
          (row) => row.notice_key === `harvest:${hisQuietNothing}`,
        ),
      ).toBe(false);

      // --- 11. THE CONFLICT FORM REACHES A PERSON, which is the second of the
      //     three places a conflict has to be visible.
      plant(it.stateDir, PERSON, AGENT, {
        at: at(3),
        direction: "in",
        from: PERSON,
        text: "and the fee is twelve after all",
      });
      it.scripted.setAnswer(() => envelope(NOTE_FEE_DIFFERENT));
      const hisConflict = await plantRow(AGENT, {
        from: null,
        until: new Date(now + 4000).toISOString(),
        reason: "quiet",
        lines: 1,
      });
      await until(
        "the conflicting harvest answered with the conflicts-only form",
        async () =>
          (await it.read.noticeRows()).some(
            (row) => row.notice_key === `harvest:${hisConflict}`,
          ),
        90_000,
        async () => JSON.stringify(await it.read.noticeRows()),
      );
      expect(
        (await it.read.noticeRows()).find(
          (row) => row.notice_key === `harvest:${hisConflict}`,
        )!.body,
      ).toBe(EN_CONFLICTS_ONLY(FEE_SLUG));

      // --- 13. ORDER. The notice's outbox id is lower than any later reply
      //     chunk for that chat, so a person reads the line and then the next
      //     answers, which is the order the catch-up notice already has.
      it.scripted.setAnswer(null);
      await insertInbound(cluster, it.db, { id: "m-after", body: "an ordinary message" });
      await until(
        "the ordinary message was answered after the notice",
        async () => (await it.read.outbox()).some((chunk) => chunk.inbound_id === "m-after"),
        90_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      const reply = (await it.read.outbox()).find((chunk) => chunk.inbound_id === "m-after")!;
      const everyNotice = await it.read.noticeRows();
      for (const one of everyNotice.filter((row) => row.person === PERSON)) {
        expect(one.id).toBeLessThan(reply.id);
      }

      // --- 12c. THE REAL REPLAY, through a runner that is killed mid-settle.
      //
      //     The previous two bindings do not
      //     exercise RUNNER replay: they drive `appendNotice` with a key the
      //     TEST chose, so a runner that picks the right key on its first
      //     attempt and a different one on its retry is not caught. And the
      //     schema forbidding a stamp DELETE does not forbid
      //     observing and killing a runner before it settles. The suite already
      //     has that staging and no production switch is needed for it.
      //
      //     The order the runner works in is what makes this reachable: stage,
      //     apply, appendNotice, settle, so the notice is written before the settle.
      //     So the gate holds the apply, a lock goes on `state_row` while it is
      //     held, the apply is released, the NOTICE lands in its own
      //     transaction, and the settle is what blocks. The runner is killed
      //     there. Nothing of the settle committed and the notice survived.
      // A runner started again under the same id redoes the row, and
      //     the key it chooses the second time is its own.
      // ---------------------------------------------------------------
      const replayGateDir = await mkdtemp(join(tmpdir(), "hub-harvest-replay-"));
      const replayGate = writeGatedImprntShim(replayGateDir);
      let replay: HarvestStage | null = null;
      let replayRunner: ReadyProcess | null = null;
      let lock: HeldLock | null = null;
      try {
        replay = await stageHarvest(cluster, {
          servers: true,
          hub: { tick_seconds: 2, outage_retry_seconds: 2 },
          harvest: { quiet_minutes: 600, min_messages: 99, report: true },
          shim: replayGate.shim,
        });
        const them = replay.hub;
        plant(them.stateDir, PERSON, AGENT, {
          at: new Date(Date.now() - 40 * 60_000).toISOString(),
          direction: "in",
          from: PERSON,
          text: "the bank raised the card fee",
        });
        them.scripted.setAnswer(() => envelope(NOTE_FEE));

        replayRunner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
          them.registryFile,
          RUNNER,
          them.adapterUrl,
          them.adapterName,
        ]);

        const replayRow = `harvest:${AGENT}:${new Date(Date.now()).toISOString()}`;
        await insertInbound(cluster, them.db, {
          id: replayRow,
          body: JSON.stringify({
            from: null,
            until: new Date(Date.now()).toISOString(),
            reason: "quiet",
            lines: 1,
          }),
          kind: "harvest",
        });

        await until(
          "the replayed row's apply reached the gate",
          () => replayGate.held() >= 1,
          90_000,
          async () => JSON.stringify(await them.read.inbound()),
        );
        // The lock goes on while the apply is held, so it lands in front of the
        // SETTLE and not in front of the watermark read that came before it.
        lock = await lockTable(cluster, them.db, "state_row");
        replayGate.open();

        await until(
          "the notice landed, in its own transaction, before the settle",
          async () =>
            (await them.read.noticeRows()).some(
              (row) => row.notice_key === `harvest:${replayRow}`,
            ),
          90_000,
          async () => JSON.stringify(await them.read.noticeRows()),
        );
        const blocked = await waitForLockWaiter(cluster, them.db, {
          role: "hub_runner",
          relation: "state_row",
          timeoutMs: 60_000,
        });

        replayRunner.proc.kill(9);
        await replayRunner.proc.exited;
        replayRunner = null;
        await lock.release();
        lock = null;
        await waitForBackendsGone(cluster, them.db, [blocked], 30_000);

        // Nothing of the settle landed, and the notice is there.
        expect(
          await them.read.ledger({ stream: "inbound", subject: replayRow, kind: "answered" }),
        ).toEqual([]);
        expect(await them.read.ledger({ stream: "turn", subject: replayRow })).toEqual([]);
        expect(await them.read.harvestSheet()).toEqual([]);
        expect(
          (await them.read.noticeRows()).filter(
            (row) => row.notice_key === `harvest:${replayRow}`,
          ).length,
        ).toBe(1);

        // THE RESTART, under the SAME runner id, which makes it a redo.
        replayRunner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
          them.registryFile,
          RUNNER,
          them.adapterUrl,
          them.adapterName,
        ]);
        await until(
          "the replayed row settled on the second attempt",
          async () =>
            (await them.read.ledger({ stream: "inbound", subject: replayRow })).some(
              (one) => one.kind === "answered",
            ),
          120_000,
          async () => JSON.stringify(await them.read.inbound()),
        );

        // EXACTLY ONE NOTICE, still. The runner chose the key both times and
        // the second attempt met its own. A build that keyed the second attempt
        // differently writes two lines into a person's chat about one harvest.
        expect(
          (await them.read.noticeRows()).filter(
            (row) => row.notice_key === `harvest:${replayRow}`,
          ).length,
        ).toBe(1);
        // And the redo really did complete, so the one notice is not the
        // artefact of a row that never came back.
        expect((await them.read.harvestSheet()).length).toBe(1);
      } finally {
        if (lock) await lock.release().catch(() => {});
        replayGate.open();
        if (replayRunner) await replayRunner.stop().catch(() => {});
        if (replay) await replay.stop();
        await rm(replayGateDir, { recursive: true, force: true }).catch(() => {});
      }

      // --- the control: a stage where nothing is harvested at all produces no
      //     notice of any kind. The second person's chat is that stage: no row
      //     of hers reported before the demand above, and no post ever reached
      //     her chat under the quiet setting.
      expect(
        (await it.read.noticeRows()).filter(
          (row) => row.person === PERSON2 && row.notice_key === `harvest:${herRow}`,
        ),
      ).toEqual([]);
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      if (stage) await stage.stop();
      if (secondVault) await secondVault.remove();
      await rm(secondTree, { recursive: true, force: true }).catch(() => {});
    }
  },
  SLOW,
);
