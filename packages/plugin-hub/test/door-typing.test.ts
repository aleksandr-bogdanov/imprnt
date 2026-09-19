// MSG-10, and SPEC §2's Forbidden line phrased as a check: "a turn open with no
// typing shown" is refused.
//
// SPEC §2 and L6: "While a turn is open the door shows typing on Telegram and
// Discord, refreshed every few seconds."
//
// THE CADENCE IS READ FROM THE PLATFORM'S OWN NUMBER and never written beside
// it as a literal. Telegram's `sendChatAction` sets the status "for 5 seconds or
// less" and Discord's typing indicator "expires after 10 seconds", both from
// their own documentation read on 2026-09-16, so `typingSeconds` is 5 and 10
// and a door that refreshes inside whichever it is never lets the status lapse.
// A check that hard-coded the number would pass a build that changed the
// platform and not the refresh.
//
// A TURN OPENS AT `acked` AND ENDS AT `answered`, and those are two different
// state sets from the set a clock is armed for (D-126's table). A build that
// read "open" as one set gets one of them wrong, so this check watches a row
// that nobody has claimed and a row that has been answered as well as one in
// the middle.
//
// Red reason: behaviour absent. `Platform.typing` is optional in
// `src/door/platform.ts` and NOTHING in `src/` has ever called it, so the fake
// records nothing and the refusal never happens.

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  seam,
  statementWatch,
  until,
  type Cluster,
} from "./helpers/cluster.ts";
import { createFakePlatform } from "./helpers/fake-platform.ts";
import { AGENT, CHAT, DOOR, PERSON, RUNNER, stageHub } from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 120_000;

/** 04-CONTEXT's pinned refusal, written out by the TEST and never imported. */
function cannotType(door: string): string {
  return (
    `${door} serves a platform that cannot show typing, and a turn open with no typing ` +
    `shown is forbidden. A platform carries typing() and typingSeconds.`
  );
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

test(
  "MSG-10 a turn open with no typing shown is refused: typing is shown from the moment the loop accepts a message and refreshed inside the platform's own lifetime, none is shown before a turn opens or after it ends, and a door handed a platform that cannot type refuses at start (SPEC §2 Forbidden, L6)",
  async () => {
    const { runDoor } = await seam("src/door/run.ts");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runDoor).toBe("function");

    // A SHORT typing lifetime, declared by the platform itself, so the cadence
    // windows below are seconds rather than most of a minute. Every bound is
    // read off `platform.typingSeconds`, so the number here changes how long
    // the check takes and never what it asserts.
    const it = await stageHub(cluster, {
      language: "en",
      hub: { tick_seconds: 2 },
      platform: { typingSeconds: 2 },
    });
    await Bun.write(it.registryFile, (await Bun.file(it.registryFile).text())
      .replaceAll("[[people]]", '[[people]]\nallowed_senders = { "door-fake" = ["fixture-sender"] }'));
    const seconds = it.fake.platform.typingSeconds;
    expect(seconds).toBeGreaterThan(0);
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;

    try {
      // --- half two's harder side, taken FIRST because it needs no runner: a
      //     row nobody has claimed is a turn that has not opened. Typing here
      //     would show a person somebody working on a message the loop has not
      //     accepted.
      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      it.fake.deliver({ text: "a message with no runner running at all" });
      await until(
        "the door wrote the row down",
        async () => (await it.read.inbound()).length >= 1,
        30_000,
      );
      // The row is visible before the door has finished accepting it: after
      // the commit it still marks the chat log line written (`log_ready`) and
      // then moves its read cursor in the `door_cursor` sheet. Those two writes
      // are the delivery this setup made, not a timer, and on a slow runner the
      // cursor write landed inside the window (CI, PR 31). So the window opens
      // only once both are observed.
      await until(
        "the door finished accepting the message: its line is marked written and its cursor has moved",
        async () =>
          (await it.read.sql("select count(*)::int as n from inbound where log_ready"))[0].n === 1 &&
          (await it.read.sheet("door_cursor")).some((row) => row.id === `${DOOR}/${CHAT}`),
        30_000,
      );
      // The statement window belongs HERE, with the door up and no runner:
      // the runner's own tick re-read (03b row 6, deliberately kept) would
      // otherwise be counted against the door. What is bound is that the door
      // issues nothing while no turn is open and that its typing timer, when
      // it has one, is memory and not a query.
      const readerPid = await it.read.pid();
      const watch = await statementWatch(cluster, [readerPid]);
      await Bun.sleep(seconds * 3 * 1000);
      const issued = await watch.count();
      if (issued > 0) {
        throw new Error(
          `the door issued ${issued} statements with no turn open, which is a timer, not a wait. Statements:\n` +
            (await watch.lines()).slice(0, 8).join("\n"),
        );
      }
      expect((await it.read.inbound())[0].state).toBe("received");
      expect(it.fake.typings().filter((one) => one.chat === CHAT)).toEqual([]);

      // --- the runner comes up and that message goes the whole way, which is
      //     what gives the next two halves a row that has been ANSWERED to
      //     watch, and an idle door to watch beside it.
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      // THE REPLY, not "a post" (the second pass's finding). A compliant door
      // posts a progress line while the turn is open, so a post count reaches
      // one before the answer exists and this wait would end in the middle of
      // the turn it is supposed to be past. The `delivered` stamp is the door
      // saying the person has the answer.
      await until(
        "the first message went the whole way",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "delivered" })).length >= 1,
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      const firstAnsweredAt = new Date(
        (await it.read.ledger({ stream: "inbound", kind: "answered" }))[0]
          .at as unknown as string,
      ).getTime();
      const beforeIdle = it.fake.typings().length;

      // --- half two, the idle control, which is what makes half one mean
      //     anything: with nothing in flight the door types NOTHING. It also
      //     covers the other side of D-126's table: a row that has been
      //     ANSWERED is out of the open set and the typing stops with it.
      const idleFrom = Date.now();
      await Bun.sleep(seconds * 2 * 1000);
      expect(
        it.fake.typings().filter((one) => one.chat === CHAT && one.at >= idleFrom),
      ).toEqual([]);
      expect(
        it.fake
          .typings()
          .slice(beforeIdle)
          .filter((one) => one.at > firstAnsweredAt + seconds * 2 * 1000),
      ).toEqual([]);

      // --- half one, the cadence while a turn is open. The gate goes on only
      //     now, because a loop's session is fed the tail of its own chat log
      //     before any human message and a gate set earlier would hold THAT
      //     turn open and the runner would never reach this one.
      it.scripted.holdTurnEnd(true);
      const cadenceFrom = Date.now();
      const openTyping = () =>
        it.fake.typings().filter((one) => one.chat === CHAT && one.at >= cadenceFrom);
      it.fake.deliver({ text: "a message the loop takes its time over" });
      await until(
        "the loop accepted the second message, which is where its turn opens",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "acked" })).length >= 2,
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      const acks = await it.read.ledger({ stream: "inbound", kind: "acked" });
      const ackedAt = new Date(acks[acks.length - 1].at as unknown as string).getTime();

      await until(
        "the door showed typing at least three times while the turn was open",
        () => openTyping().length >= 3,
        seconds * 4 * 1000,
        () => `typings=${JSON.stringify(it.fake.typings())}`,
      );

      // AND IT KEEPS GOING (the second seat's finding). Three calls in a burst
      // at the start of a turn satisfy a count and a pairwise bound and then
      // leave the person watching a dead chat for the rest of a long turn, so
      // the turn is held open for twice the platform's lifetime after the
      // third call and the refreshes have to keep arriving.
      const afterThree = openTyping().length;
      const watchedFrom = Date.now();
      await Bun.sleep(seconds * 2 * 1000 + 500);
      const kept = openTyping().filter((one) => one.at > watchedFrom);
      if (kept.length < 2) {
        throw new Error(
          `the door showed typing ${kept.length} times over ${seconds * 2} s while the turn was still open, so the status lapses and the person sees a dead chat. typings=${JSON.stringify(openTyping())}`,
        );
      }
      expect(openTyping().length).toBeGreaterThan(afterThree);

      const shown = openTyping();
      // One call at the start is not enough: the status lapses after
      // `typingSeconds` and the person sees a dead chat while a loop works.
      expect(shown.length).toBeGreaterThanOrEqual(3);
      // The first one lands within the platform's own lifetime of the moment
      // the loop accepted the message, so the person sees typing from the
      // start of the turn rather than a refresh period later.
      expect(shown[0].at - ackedAt).toBeLessThan(seconds * 1000);
      for (let nth = 1; nth < shown.length; nth++) {
        // STRICTLY INSIDE the platform's own lifetime, not at it. Telegram
        // sets the status "for 5 seconds or less" and Discord's "expires after
        // 10 seconds", so a refresh landing exactly on the boundary is a
        // status that has already lapsed when it arrives. The bound is the
        // PLATFORM's own number, read off the object.
        expect(shown[nth].at - shown[nth - 1].at).toBeLessThan(seconds * 1000);
      }

      // --- and typing STOPS. A door that types forever is as wrong as one
      //     that never does.
      it.scripted.holdTurnEnd(false);
      await until(
        "the second reply was delivered",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "delivered" })).length >= 2,
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      // The REPLY's own post, found by its text, so a progress line posted
      // beside it is not mistaken for it.
      const posted = it.fake
        .posts()
        .filter((one) => one.chat === CHAT && one.text.includes("reply to"));
      expect(posted.length).toBeGreaterThanOrEqual(2);
      const postedAt = posted[posted.length - 1].at;
      const answers = await it.read.ledger({ stream: "inbound", kind: "answered" });
      const answeredAt = new Date(
        answers[answers.length - 1].at as unknown as string,
      ).getTime();
      await Bun.sleep(seconds * 3 * 1000);
      const after = openTyping();
      // Nothing after the answer, give or take one refresh already in flight.
      expect(after.filter((one) => one.at > postedAt + seconds * 2 * 1000)).toEqual([]);
      expect(after.filter((one) => one.at > answeredAt + seconds * 2 * 1000)).toEqual([]);

      // --- half two's LAST side, added under the separate review (S4, and
      //     BUILD-NOTES 29): a row at `acked` that NOBODY HOLDS draws no
      //     typing. D-121a leaves a refused row at `acked` and releases it onto
      //     its `retry_at`, so the state alone cannot tell a turn that is
      //     running from one that is waiting out an outage, and a door that
      //     typed for the second shows a person somebody working on a message
      //     while the notice beside it says the messages are waiting.
      //
      //     The runner is stopped first, so nothing can claim the row and make
      //     the typing honest.
      await runner!.stop();
      runner = null;
      const heldFrom = Date.now();
      await it.read.sql(
        `insert into inbound (id, person, agent, body)
         values ('t-unclaimed', $1, $2, 'a message a refused turn left waiting')`,
        [PERSON, AGENT],
      );
      await it.read.sql(
        `insert into ledger_event (stream, subject, kind, actor)
         values ('inbound', 't-unclaimed', 'received', 'door')`,
      );
      await it.read.sql(
        `insert into ledger_event (stream, subject, kind, actor)
         values ('inbound', 't-unclaimed', 'acked', 'runner')`,
      );
      await until(
        "the door heard that the row had been acknowledged",
        async () =>
          (await it.read.inbound()).some(
            (row) => row.id === "t-unclaimed" && row.state === "acked",
          ),
        20_000,
      );
      const unclaimed = (await it.read.inbound()).find((row) => row.id === "t-unclaimed")!;
      expect(unclaimed.claimed_by).toBeNull();
      await Bun.sleep(seconds * 3 * 1000);
      expect(
        it.fake.typings().filter((one) => one.chat === CHAT && one.at >= heldFrom),
      ).toEqual([]);
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }

    // --- half three, the refusal, and its control. It lives in `runDoor` by
    //     name, because every check drives `runDoor` directly and a refusal in
    //     the entry point would be a promise rather than a behaviour.
    const second = await stageHub(cluster, { language: "en" });
    try {
      const silent = createFakePlatform({ name: "fake", noTyping: true });
      expect("typing" in silent.platform).toBe(false);
      let refused = "";
      let started: { stop(): Promise<void> } | null = null;
      try {
        started = (await (runDoor as Function)({
          door: DOOR,
          registryFile: second.registryFile,
          platform: silent.platform,
        })) as { stop(): Promise<void> };
      } catch (error) {
        refused = String((error as Error).message);
      }
      if (started) await started.stop();
      expect(refused).toBe(cannotType(DOOR));
      // Nothing was started: the door refused before it read a chat.
      expect(silent.pulls()).toEqual([]);

      // The control: the same call with an ordinary platform resolves and
      // hands back a handle, so what is refused is the missing verb and not
      // the door.
      const fine = (await (runDoor as Function)({
        door: DOOR,
        registryFile: second.registryFile,
        platform: second.fake.platform,
      })) as { door: string; stop(): Promise<void> };
      expect(fine.door).toBe(DOOR);
      await fine.stop();
    } finally {
      await second.stop();
    }
  },
  SLOW,
);
