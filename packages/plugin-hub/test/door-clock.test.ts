// MSG-10. A clock running out is a line in the chat, in the person's language,
// saying it is the door speaking.
//
// SPEC §2 and L6: "When a clock runs out, the door says so in the chat, in the
// person's language, and says it is the door speaking." SPEC §2's Forbidden
// carries "an expired clock with no chat line and no finding". The finding half
// is `check`'s stamp finding (test/check-stamps.test.ts); these three are the
// chat line half.
//
// THE THRESHOLDS ARE SECONDS HERE, on purpose. A household's are 30, 60 and 900
// (L6's defaults until measured), and a check on those numbers would take a
// quarter of an hour. They are the PERSON's own, read from the registry, which
// is what makes a one-second threshold a legal file rather than a fixture
// trick.
//
// THE TEMPLATES ARE PINNED WHOLE, with the elapsed seconds as the only free
// number: how long a door waited before it spoke is not knowable to a check to
// the millisecond, and everything else in the sentence is bound. A check that
// asserted three fragments would pass a sentence with anything between them,
// and these are sentences a household reads on a phone.
//
// WHICH CLOCK IS ARMED IS A FUNCTION OF THE ROW'S STATE (D-126's table): a row
// that is `received` is waiting for `acked` and nothing else, one that is
// `acked` is waiting for `started`, one that is `started` is waiting for
// `answered`, and `delivered` has no door clock at all because the door cannot
// post a line about not being able to post.
//
// Red reasons: import missing, `src/door/clock.ts` and `src/door/lines.ts` for
// the first two, and import missing, `src/store/turns.ts`, for the restart.

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  seam,
  startReadySubprocess,
  statementWatch,
  until,
  type Cluster,
  type ReadyProcess,
} from "./helpers/cluster.ts";
import { createScriptedAdapter } from "./helpers/scripted-adapter.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  RUNNER,
  RUNNER2,
  chatLogLines,
  outLineOnDisk,
  stageHub,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 120_000;

/** 04-CONTEXT's pinned lines, written out by the TEST and never imported. */
const CLOCK = {
  en: {
    acked: /^\[door\] still waiting: the loop has not accepted this message\. (\d+) s so far\.$/,
    started: /^\[door\] still waiting: the agent has not started answering\. (\d+) s so far\.$/,
    answered: /^\[door\] still waiting: the turn has not ended\. (\d+) s so far\.$/,
  },
  ru: {
    acked: /^\[дверь\] всё ещё жду: агент не принял это сообщение\. Прошло (\d+) с\.$/,
    started: /^\[дверь\] всё ещё жду: агент не начал отвечать\. Прошло (\d+) с\.$/,
    answered: /^\[дверь\] всё ещё жду: ответ ещё не готов\. Прошло (\d+) с\.$/,
  },
};

const ANY_CLOCK = [
  ...Object.values(CLOCK.en),
  ...Object.values(CLOCK.ru),
];

function isClockLine(text: string): boolean {
  return ANY_CLOCK.some((one) => one.test(text));
}

beforeAll(async () => {
  cluster = await startCluster({
    settings: {
      log_statement: "'all'",
      log_line_prefix: "'pid=%p '",
      log_min_duration_statement: "-1",
    },
  });
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

// ---------------------------------------------------------------------------
// Check 16: the clock line in `en`.
// ---------------------------------------------------------------------------

test(
  "MSG-10 a clock running out is a line in the chat saying it is the door speaking: the acked, started and answered clocks each produce one line, one ledger row and one chat log line written before the post, delivered produces none, and a message answered in time produces nothing at all (SPEC §2, L6)",
  async () => {
    const { CLOCK_STREAM, clockDeadlines, recordExpiry } = await seam("src/door/clock.ts");
    expect(CLOCK_STREAM).toBe("clock");
    expect(typeof clockDeadlines).toBe("function");
    expect(typeof recordExpiry).toBe("function");
    const { clockLine } = await seam("src/door/lines.ts");
    expect(typeof clockLine).toBe("function");

    const { runDoor } = await seam("src/door/run.ts");
    const { runRunner } = await seam("src/runner/run.ts");

    const probeDir = { value: "" };
    const it = await stageHub(cluster, {
      hub: { tick_seconds: 1 },
      people: [
        {
          id: PERSON,
          language: "en",
          acked_seconds: 1,
          started_seconds: 2,
          answered_seconds: 3,
          // A door has NO delivered clock, so this one is armed by nothing and
          // a build that armed it posts a fourth line at one second.
          delivered_seconds: 1,
        },
      ],
      probe: (post) =>
        probeDir.value === "" ? null : outLineOnDisk({ stateDir: probeDir.value })(post),
    });
    probeDir.value = it.stateDir;
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;

    try {
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

      // The loop accepts nothing, produces nothing and ends nothing, so the
      // three clocks run out one after the other.
      it.scripted.holdReceipt(true);
      it.scripted.holdProgress(true);
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: "a question the loop never acknowledges" });

      // --- 1. THE CHAT. The line is whole and it names the door, so "says it
      //     is the door speaking" is a property of the sentence rather than of
      //     a convention.
      await until(
        "the acked clock ran out and the door said so",
        () => it.fake.posts().some((one) => CLOCK.en.acked.test(one.text)),
        20_000,
        () => `posts=${JSON.stringify(it.fake.posts().map((p) => p.text))}`,
      );
      const said = it.fake.posts().find((one) => CLOCK.en.acked.test(one.text))!;
      const seconds = Number(CLOCK.en.acked.exec(said.text)![1]);
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThan(10);

      const row = (await it.read.inbound())[0];

      // --- 2. THE LEDGER. One row, written as the DOOR, which is what the new
      //     policy is for.
      const expired = await it.read.ledger({ stream: "clock" });
      expect(expired.length).toBe(1);
      expect(expired[0].kind).toBe("expired");
      expect(expired[0].actor).toBe("door");
      expect(expired[0].subject).toBe(row.id);
      expect(expired[0].detail.stamp).toBe("acked");
      expect(Number(expired[0].detail.seconds)).toBeGreaterThanOrEqual(1);
      expect(expired[0].detail.person).toBe(PERSON);
      expect(expired[0].detail.agent).toBe(AGENT);

      // --- 3. THE CHAT LOG, written BEFORE the post, with the DOOR as the
      //     line's author, so a session reads exactly what the chat holds and
      //     sees it marked as machinery twice over (D-129).
      expect(said.probe).toBe(true);
      const logged = chatLogLines(it.stateDir, PERSON, AGENT).filter((line) =>
        isClockLine(line.text),
      );
      expect(logged.length).toBe(1);
      expect(logged[0].direction).toBe("out");
      expect(logged[0].from).toBe(DOOR);
      expect(logged[0].text).toBe(said.text);

      // --- 4. ONCE, not repeatedly, and the row's state is what decides which
      //     clock is armed: a `received` row waits for `acked` and for nothing
      //     else, so five more seconds produce no second line of any kind.
      await Bun.sleep(5000);
      expect(it.fake.posts().filter((one) => isClockLine(one.text)).length).toBe(1);
      expect((await it.read.ledger({ stream: "clock" })).length).toBe(1);

      // --- 5. the next clock, and the next.
      it.scripted.holdReceipt(false);
      await until(
        "the started clock ran out and the door said so",
        () => it.fake.posts().some((one) => CLOCK.en.started.test(one.text)),
        20_000,
        () => `posts=${JSON.stringify(it.fake.posts().map((p) => p.text))}`,
      );
      it.scripted.holdProgress(false);
      await until(
        "the answered clock ran out and the door said so",
        () => it.fake.posts().some((one) => CLOCK.en.answered.test(one.text)),
        20_000,
        () => `posts=${JSON.stringify(it.fake.posts().map((p) => p.text))}`,
      );
      const three = await it.read.ledger({ stream: "clock" });
      expect(three.length).toBe(3);
      expect(three.map((one) => one.detail.stamp)).toEqual([
        "acked",
        "started",
        "answered",
      ]);

      // --- 6. `delivered` gets NO line, ever. The door cannot post a line
      //     about not being able to post, so that one is a `check` finding
      //     alone (D-127).
      it.fake.holdPosts(true);
      it.scripted.holdTurnEnd(false);
      await until(
        "the reply was settled",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "answered" })).length >= 1,
        30_000,
      );
      await Bun.sleep(4000);
      expect((await it.read.ledger({ stream: "clock" })).length).toBe(3);
      // Even the attempts carry no fourth clock line, so a build that tried
      // and was refused is caught as well as one that never tried.
      expect(
        it.fake.attempts().filter((one) => isClockLine(one.text)).length,
      ).toBe(3);
      it.fake.holdPosts(false);
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }

    // --- THE CONTROL, and it is the whole check's discriminator: a message the
    //     loop answers inside every threshold produces ZERO clock lines, ZERO
    //     ledger rows and ZERO clock lines in the chat log. A door that posted
    //     on a timer regardless passes everything above and fails here.
    const quick = await stageHub(cluster, {
      hub: { tick_seconds: 1 },
      people: [
        {
          id: PERSON,
          language: "en",
          acked_seconds: 1,
          started_seconds: 2,
          answered_seconds: 3,
          delivered_seconds: 1,
        },
      ],
    });
    let door2: { stop(): Promise<void> } | null = null;
    let runner2: { stop(): Promise<void> } | null = null;
    try {
      door2 = (await (runDoor as Function)({
        door: DOOR,
        registryFile: quick.registryFile,
        platform: quick.fake.platform,
      })) as { stop(): Promise<void> };
      runner2 = (await (runRunner as Function)({
        runner: RUNNER,
        registryFile: quick.registryFile,
        adapters: { [quick.adapterName]: quick.scripted.adapter },
      })) as { stop(): Promise<void> };
      quick.fake.deliver({ text: "a question the loop answers at once" });
      await until(
        "the reply was posted",
        () => quick.fake.posts().length >= 1,
        45_000,
        async () => JSON.stringify(await quick.read.inbound()),
      );
      await Bun.sleep(5000);
      expect(quick.fake.attempts().filter((one) => isClockLine(one.text))).toEqual([]);
      expect(await quick.read.ledger({ stream: "clock" })).toEqual([]);
      expect(
        chatLogLines(quick.stateDir, PERSON, AGENT).filter((line) => isClockLine(line.text)),
      ).toEqual([]);
    } finally {
      if (runner2) await runner2.stop();
      if (door2) await door2.stop();
      await quick.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 17: the same line in the person's own language.
// ---------------------------------------------------------------------------

test(
  "MSG-10 the clock line is in the person's own language: one registry with a person in en and a person in ru produces both, in one run from one door, neither carrying the other's marker, with the ledger's own key in ASCII for both and a person who declares no language reading English (SPEC §2, L6, D-128)",
  async () => {
    const { clockLine } = await seam("src/door/lines.ts");
    expect(typeof clockLine).toBe("function");
    const { runDoor } = await seam("src/door/run.ts");
    const { runRunner } = await seam("src/runner/run.ts");

    const CHAT2 = `${CHAT}1`;
    const CHAT3 = `${CHAT}2`;
    const PERSON3 = "p3";
    const AGENT3 = "p3-lair";
    const thresholds = {
      acked_seconds: 1,
      started_seconds: 2,
      answered_seconds: 3,
      delivered_seconds: 1,
    };

    const it = await stageHub(cluster, {
      hub: { tick_seconds: 1 },
      people: [
        { id: PERSON, language: "en", ...thresholds },
        { id: PERSON2, language: "ru", ...thresholds },
        // Declares NO language at all, so it reads the default, which is bound
        // here rather than left to the loader's own check.
        { id: PERSON3, ...thresholds },
      ],
      agents: [
        { id: AGENT2, person: PERSON2, preset: "daily", chat: CHAT2, door: DOOR, runner: RUNNER2 },
        { id: AGENT3, person: PERSON3, preset: "daily", chat: CHAT3, door: DOOR, runner: RUNNER2 },
      ],
    });
    // One loop per runner, for the reason test/runner-outage.test.ts gives.
    const second = createScriptedAdapter({ name: it.adapterName });
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    let runner2: { stop(): Promise<void> } | null = null;

    try {
      it.scripted.holdReceipt(true);
      second.holdReceipt(true);

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
      runner2 = await (runRunner as Function)({
        runner: RUNNER2,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: second.adapter },
      });

      it.fake.deliver({ chat: CHAT, text: "the first person's question" });
      it.fake.deliver({ chat: CHAT2, text: "the second person's question" });
      it.fake.deliver({ chat: CHAT3, text: "the third person's question" });

      // --- 1. both languages, in ONE run, from ONE door. A build with a
      //     global language passes with one person and fails the moment a
      //     household has two.
      await until(
        "both clocks ran out and the door said so in both languages",
        () =>
          it.fake.posts().some((one) => one.chat === CHAT && CLOCK.en.acked.test(one.text)) &&
          it.fake.posts().some((one) => one.chat === CHAT2 && CLOCK.ru.acked.test(one.text)),
        25_000,
        () => `posts=${JSON.stringify(it.fake.posts().map((p) => [p.chat, p.text]))}`,
      );
      const english = it.fake.posts().find((one) => one.chat === CHAT)!;
      const russian = it.fake.posts().find((one) => one.chat === CHAT2)!;

      // --- 2. THE MARKER IS TRANSLATED. An English label inside Russian prose
      //     is the defect D-128 exists to prevent.
      expect(russian.text.includes("[door]")).toBe(false);
      expect(english.text.includes("[дверь]")).toBe(false);

      // --- 5. the default. A person who declares no language reads English.
      await until(
        "the third person's clock ran out",
        () => it.fake.posts().some((one) => one.chat === CHAT3),
        25_000,
        () => `posts=${JSON.stringify(it.fake.posts().map((p) => [p.chat, p.text]))}`,
      );
      const byDefault = it.fake.posts().find((one) => one.chat === CHAT3)!;
      expect(CLOCK.en.acked.test(byDefault.text)).toBe(true);

      // --- 3. the started and answered lines in Russian, both whole.
      second.holdProgress(true);
      second.holdTurnEnd(true);
      second.holdReceipt(false);
      await until(
        "the Russian started line landed",
        () => it.fake.posts().some((one) => one.chat === CHAT2 && CLOCK.ru.started.test(one.text)),
        25_000,
        () => `posts=${JSON.stringify(it.fake.posts().map((p) => [p.chat, p.text]))}`,
      );
      second.holdProgress(false);
      await until(
        "the Russian answered line landed",
        () => it.fake.posts().some((one) => one.chat === CHAT2 && CLOCK.ru.answered.test(one.text)),
        25_000,
        () => `posts=${JSON.stringify(it.fake.posts().map((p) => [p.chat, p.text]))}`,
      );

      // --- 4. the ledger is NOT translated, because it is a record a household
      //     queries and a translated key is a key nobody can group by. The chat
      //     log IS the person's own text, because it is a record of what they
      //     read.
      const expired = await it.read.ledger({ stream: "clock" });
      expect(expired.length).toBeGreaterThanOrEqual(3);
      for (const one of expired) {
        expect(["acked", "started", "answered"]).toContain(String(one.detail.stamp));
      }
      const russianLog = chatLogLines(it.stateDir, PERSON2, AGENT2).filter((line) =>
        isClockLine(line.text),
      );
      expect(russianLog.length).toBeGreaterThanOrEqual(1);
      expect(CLOCK.ru.acked.test(russianLog[0].text)).toBe(true);
      expect(russianLog[0].from).toBe(DOOR);
    } finally {
      if (runner) await runner.stop();
      if (runner2) await runner2.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 18: a door restarted mid-turn re-arms every clock it owed.
// ---------------------------------------------------------------------------

test(
  "MSG-10 a door restarted mid-turn re-arms every clock it owed: the deadline is measured from the message's own received_at, the restarted door speaks once and only once, a clock it had already spoken about is not repeated, and the wait is a wait rather than a tick (SPEC §2, L6, L11)",
  async () => {
    const { readOpenTurns } = await seam("src/store/turns.ts");
    expect(typeof readOpenTurns).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");

    const ANSWERED_SECONDS = 8;
    const it = await stageHub(cluster, {
      servers: true,
      hub: { tick_seconds: 30 },
      people: [
        {
          id: PERSON,
          language: "en",
          acked_seconds: 1,
          started_seconds: 60,
          answered_seconds: ANSWERED_SECONDS,
          delivered_seconds: 60,
        },
      ],
    });
    let door: ReadyProcess | null = null;
    let runner: { stop(): Promise<void> } | null = null;

    const startDoor = () =>
      startReadySubprocess("test/helpers/door-subprocess.ts", [
        it.registryFile,
        DOOR,
        it.platformUrl,
      ]);

    try {
      door = await startDoor();
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      // The turn opens and stays open, so the answered clock is the only one
      // in play.
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: "a question the loop is still thinking about" });
      await until(
        "the turn was open, with the agent answering",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "started" })).length >= 1,
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      const open = (await it.read.inbound())[0];
      const receivedAt = new Date(open.received_at as unknown as string).getTime();

      // --- 1. nothing was posted yet, so what follows is about the restart and
      //     not about a line that had already landed.
      expect(it.fake.attempts().filter((one) => isClockLine(one.text))).toEqual([]);

      // A second message nobody will claim, whose own acked clock runs out
      // BEFORE the stop, so the restarted door has one it has already spoken
      // about and one it still owes.
      await runner!.stop();
      runner = null;
      it.fake.deliver({ text: "a second question nobody claims" });
      await until(
        "the acked clock of the unclaimed message ran out",
        () => it.fake.posts().some((one) => CLOCK.en.acked.test(one.text)),
        20_000,
        () => `posts=${JSON.stringify(it.fake.posts().map((p) => p.text))}`,
      );
      const spokenBefore = (await it.read.ledger({ stream: "clock" })).length;
      expect(spokenBefore).toBe(1);

      // --- the door goes down BEFORE the answered clock runs out.
      expect(Date.now() - receivedAt).toBeLessThan(ANSWERED_SECONDS * 1000);
      await door.stop();
      door = null;

      // --- 2. the restart re-arms. The deadline is the message's OWN
      //     received_at and never the new door's start, which is the only way
      //     a door that was down through a deadline can still say anything.
      // WHEN THE PROCESS WAS ASKED TO START, not when it said it was ready
      // (the second pass's finding). A fresh timer can be armed inside
      // `runDoor` BEFORE the ready line is printed, and a bound measured from
      // readiness leaves that timer room. This is measured from the spawn.
      const startedAt = Date.now();
      door = await startDoor();
      const readyAt = Date.now();
      await Bun.sleep(2000);
      const readerPid = await it.read.pid();
      const watch = await statementWatch(cluster, [readerPid]);

      await until(
        "the restarted door said the answered clock had run out",
        () => it.fake.posts().some((one) => CLOCK.en.answered.test(one.text)),
        30_000,
        () => `posts=${JSON.stringify(it.fake.posts().map((p) => p.text))}`,
      );
      const late = it.fake.posts().find((one) => CLOCK.en.answered.test(one.text))!;
      expect(late.at - receivedAt).toBeGreaterThanOrEqual(ANSWERED_SECONDS * 1000);
      // AND NOT A FRESH FULL TIMEOUT (the second seat's finding). A door that
      // armed `answered_seconds` from its own startup rather than from the
      // message's `received_at` also lands after the original deadline, just
      // late: the person waits the clock out twice. The slack is the restart
      // itself plus a settle, and it is far under a second full timeout from
      // the moment the new door came up.
      // THE ORIGINAL DEADLINE PLUS A SLACK, and nothing more. The message's
      // own deadline is `received_at + answered_seconds`; a door that armed a
      // fresh full timeout anywhere inside its own startup lands at least
      // `startedAt + answered_seconds`, which is outside this bound because
      // the door was started well into the message's clock. The slack is the
      // restart's own settle.
      // THE SLACK IS 600 ms AND NOT 1500, and it is a measurement rather than
      // a preference (BUILD-NOTES 14). This bound and the staging guard under
      // it pull in opposite directions: the guard needs the restart to be at
      // least `slack` into the message's own clock, or a fresh full timeout
      // from startup would land INSIDE the bound and the check would stop
      // discriminating. Everything before the restart is the second message's
      // own one-second acked clock plus two process stops, and that measures
      // 1120 to 1160 ms on this Mac across four runs, so a 1500 ms guard
      // cannot be met by any build. 600 sits strictly between the door's real
      // latency on an expiry (one read, one diary row, one post: about 100 ms
      // here) and that 1120, which is what the pair needs.
      const SLACK_MS = 600;
      const deadline = receivedAt + ANSWERED_SECONDS * 1000;
      expect(startedAt).toBeGreaterThan(receivedAt + SLACK_MS);
      if (late.at > deadline + SLACK_MS) {
        throw new Error(
          `the clock line landed ${late.at - deadline} ms past the message's own deadline, and the restarted door was started ${startedAt - receivedAt} ms into that clock: a door that armed a fresh ${ANSWERED_SECONDS} s from its own startup lands ${startedAt - receivedAt} ms past that deadline, which is outside this ${SLACK_MS} ms bound, and one that read received_at does not`,
        );
      }
      void readyAt;

      // --- 3. the wait is a WAIT and not a tick. With `tick_seconds` at 30, a
      //     door polling `inbound` once a second over that window issues one
      //     statement a second and fails this bound. What is allowed is the
      //     clock's own read on its recorded deadline, and the delivery read a
      //     reply's notification would cause.
      const issued = await watch.count();
      if (issued > 2) {
        throw new Error(
          `the restarted door issued ${issued} statements while waiting out one clock, which is a tick, not a wait. Statements:\n` +
            (await watch.lines()).slice(0, 8).join("\n"),
        );
      }

      // --- 4. exactly once, between the two doors.
      const expired = await it.read.ledger({ stream: "clock" });
      expect(expired.filter((one) => one.detail.stamp === "answered").length).toBe(1);
      expect(expired.filter((one) => one.subject === open.id).length).toBe(1);

      // --- 5. a clock already spoken about before the restart is NOT spoken
      //     about again: the `clock` ledger row is what the restarted door
      //     reads to know it has already said this.
      expect(expired.filter((one) => one.detail.stamp === "acked").length).toBe(1);
      expect(it.fake.posts().filter((one) => CLOCK.en.acked.test(one.text)).length).toBe(1);

      // --- THE CONTROL: a message the restarted door sees answered in time
      //     draws no line, so it is not simply posting about everything it
      //     found on connect.
      it.scripted.holdTurnEnd(false);
      const before = it.fake.attempts().filter((one) => isClockLine(one.text)).length;
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      it.fake.deliver({ text: "a question answered while the new door watches" });
      await until(
        "the new message was answered and posted",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "answered" })).length >= 2,
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      await Bun.sleep(3000);
      expect(it.fake.attempts().filter((one) => isClockLine(one.text)).length).toBe(before);
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);
