// MSG-10. A progress line is posted once when the agent starts, edited as the
// work goes, and edited once more to the totals before the reply is posted.
//
// SPEC §2 and L6: "While the agent works, a progress line in the chat says what
// it is doing and is updated as it goes ('reading the vault, 3 tool calls,
// 40 s'), ending with the totals." Its Check line: "A turn with no tool call
// still lands."
//
// THE TEMPLATES ARE PINNED WHOLE, with the elapsed seconds as the only free
// number, because how long a turn took is not knowable to a check. Everything
// else in the sentence is bound, which is what stops a build passing a line
// with anything between the fragments.
//
// THE THROTTLE IS TIME AND NOT ACTION (D-124). A per-action rule makes the
// store's write rate, the notification rate and the platform's edit rate a
// function of how many tools a turn calls, and a turn can call two hundred.
// Both platforms rate-limit edits. So the observable is that the door made
// FEWER edits than the loop reported actions, with `hub.tick_seconds` at one
// second and the actions fired inside it.
//
// Red reason: import missing, `src/runner/progress.ts`, and export missing,
// `Platform.edit` and `post`'s id.

import { stageHub } from "./helpers/authorized-registry.ts";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import {
  AGENT,
  CHAT,
  DOOR,
  PERSON,
  RUNNER,
  chatLogLines,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 120_000;

/** 04-CONTEXT's pinned templates, written out by the TEST and never imported. */
const WORKING_WITH_ACTIONS = /^\[door\] working: (.+), (\d+) tool calls, (\d+) s$/;
const WORKING_NO_ACTIONS = /^\[door\] working: (\d+) s$/;
const TOTALS_WITH_ACTIONS = /^\[door\] done\. Tool calls: (\d+), time: (\d+) s\.$/;
const TOTALS_NO_ACTIONS = /^\[door\] done\. Time: (\d+) s\.$/;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

test(
  "MSG-10 a progress line is posted once, edited as the work goes and edited to the totals before the reply: the edits carry the first post's own id, they are fewer than the actions the loop reported, a turn with no tool call still gets a line, and none of it reaches the chat log (SPEC §2, L6, L17, D-129)",
  async () => {
    // The module the counter lives in, read first, so this check is red on the
    // missing seam and never inside a reader.
    const { TURN_PROGRESS_SHEET, writeProgress, readProgress, clearProgress } =
      await seam("src/runner/progress.ts");
    expect(TURN_PROGRESS_SHEET).toBe("turn_progress");
    expect(typeof writeProgress).toBe("function");
    expect(typeof readProgress).toBe("function");
    expect(typeof clearProgress).toBe("function");

    const { runDoor } = await seam("src/door/run.ts");
    const { runRunner } = await seam("src/runner/run.ts");

    // One second is the hub's own cadence here, so the throttle is visible
    // inside a short check and no second setting exists to be the same number.
    const it = await stageHub(cluster, { language: "en", hub: { tick_seconds: 1 } });
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;

    try {
      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      // The runner comes up BEFORE any message, so its session's tail is empty
      // and the gate below holds the human message's turn rather than a tail
      // turn nobody is waiting on.
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: "read the vault and tell me what changed" });
      await until(
        "the agent started answering",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "started" })).length >= 1,
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      await until(
        "the door posted the progress line",
        () => it.fake.posts().filter((one) => one.chat === CHAT).length >= 1,
        20_000,
        () => `posts=${JSON.stringify(it.fake.posts())}`,
      );

      // --- 2. it says what is happening. The first post is one of the two
      //     pinned forms, whole.
      const first = it.fake.posts().filter((one) => one.chat === CHAT)[0];
      expect(
        WORKING_WITH_ACTIONS.test(first.text) || WORKING_NO_ACTIONS.test(first.text),
      ).toBe(true);
      expect(first.id).not.toBeNull();

      // Three actions, fired inside one throttle window, then more over the
      // next two. A per-action build writes one line per action and fails the
      // count below.
      // TWENTY ACTIONS IN TWO SECONDS, and every write to the sheet COUNTED by
      // the database itself (the second pass's finding: a sampler misses
      // writes between samples and a date string merges two inside one
      // second, so a write per action fitted the allowance). A check owns the
      // throwaway cluster it built, so it installs a counting trigger of its
      // own on `state_row` and reads the count back. Nothing of the hub's is
      // touched: the trigger and its table are the check's, dropped with the
      // database.
      await it.read.sql(
        `create table if not exists check_progress_writes (
           at timestamptz not null default clock_timestamp(),
           data jsonb not null
         )`,
      );
      // SECURITY DEFINER, and the reason is a platform fact rather than a
      // preference (BUILD-NOTES 13). A PL/pgSQL trigger function runs as the
      // INVOKING role, and the role that writes this sheet is `hub_runner`,
      // which holds no grant on a table this check created as the superuser.
      // Without it every `putRow` on `turn_progress` is refused with
      // "permission denied for table check_progress_writes", the runner writes
      // no progress at all, and the check fails against a correct build. The
      // search path is pinned the way `src/schema.sql`'s own definer function
      // pins it.
      await it.read.sql(
        `create or replace function check_count_progress_writes() returns trigger
         language plpgsql security definer set search_path = public as $$
         begin
           insert into check_progress_writes (data) values (new.data);
           return null;
         end $$`,
      );
      await it.read.sql(
        `create or replace trigger check_progress_writes_counter
           after insert or update on state_row
           for each row when (new.sheet = 'turn_progress')
           execute function check_count_progress_writes()`,
      );
      const countWrites = async (): Promise<number> => {
        const [row] = (await it.read.sql(
          "select count(*)::int as n from check_progress_writes",
        )) as Record<string, number>[];
        return Number(row.n);
      };
      const writesBefore = await countWrites();

      const actions = [
        "read", "grep", "write", "read", "edit",
        "read", "grep", "write", "read", "edit",
        "read", "grep", "write", "read", "edit",
        "read", "grep", "write", "read", "edit",
      ];
      const sampleFrom = Date.now();
      for (const name of actions) {
        it.scripted.sendProgress({ kind: "action", text: name });
        await Bun.sleep(100);
      }
      const sampled = Date.now() - sampleFrom;
      await until(
        "the door edited the line as the work went",
        () => it.fake.edits().filter((one) => one.chat === CHAT).length >= 1,
        20_000,
        () => `edits=${JSON.stringify(it.fake.edits())}`,
      );
      await Bun.sleep(1500);

      // --- 1. ONE post, and every later update is an edit of it. A door that
      //     posts a new line per update floods the chat, which is the failure
      //     MSG-10's "updated as it goes" is written against.
      const postsBefore = it.fake.posts().filter((one) => one.chat === CHAT);
      expect(postsBefore.length).toBe(1);
      const edits = it.fake.edits().filter((one) => one.chat === CHAT);
      expect(edits.length).toBeGreaterThanOrEqual(1);
      for (const edit of edits) expect(edit.id).toBe(String(first.id));

      // The counts a person watches only ever go up. A line that goes
      // backwards is worse than no line.
      const counted = edits
        .map((edit) => WORKING_WITH_ACTIONS.exec(edit.text))
        .filter((found): found is RegExpExecArray => found !== null);
      expect(counted.length).toBeGreaterThanOrEqual(1);
      expect(actions).toContain(counted[counted.length - 1][1]);
      for (let nth = 1; nth < counted.length; nth++) {
        expect(Number(counted[nth][2])).toBeGreaterThanOrEqual(Number(counted[nth - 1][2]));
        expect(Number(counted[nth][3])).toBeGreaterThanOrEqual(Number(counted[nth - 1][3]));
      }

      // --- 4. the throttle is TIME. With five actions fired over about two
      //     ticks, the door made fewer edits than the loop made actions, and
      //     the SHEET itself was written no more often than the hub's own
      //     cadence allows. One write per action would be five over this
      //     window and fails the bound; `hub.tick_seconds` is 1 here, so the
      //     allowance is one write per second plus one for the edge.
      expect(edits.length).toBeLessThan(actions.length);
      const written = (await countWrites()) - writesBefore;
      const allowed = Math.ceil(sampled / 1000) + 2;
      if (written > allowed) {
        throw new Error(
          `the turn_progress sheet was written ${written} times while the loop reported ${actions.length} actions over ${sampled} ms, and hub.tick_seconds is 1: the allowance is ${allowed}, so this is a write per action rather than a write per tick`,
        );
      }
      // And it really was written, so a build that never wrote the sheet at
      // all does not pass the bound by writing nothing.
      expect(written).toBeGreaterThan(0);

      // The sheet is there while the turn is open, carrying the person the
      // door was woken by.
      const open = await it.read.sheet("turn_progress");
      expect(open.length).toBe(1);
      expect(open[0].data.person).toBe(PERSON);
      expect(open[0].data.agent).toBe(AGENT);
      expect(Number(open[0].data.actions)).toBeGreaterThanOrEqual(1);

      // --- 3. the totals, BEFORE the reply. That ordering is L6's "ending
      //     with the totals", and a build that edits after the reply fails it.
      it.scripted.holdTurnEnd(false);
      await until(
        "the reply was posted",
        () => it.fake.posts().filter((one) => one.chat === CHAT).length >= 2,
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      await Bun.sleep(1000);

      const reply = it.fake.posts().filter((one) => one.chat === CHAT)[1];
      const beforeReply = it.fake
        .edits()
        .filter((one) => one.chat === CHAT && one.at <= reply.at);
      const last = beforeReply[beforeReply.length - 1];
      const totals = TOTALS_WITH_ACTIONS.exec(last.text);
      expect(totals).not.toBeNull();
      expect(Number(totals![1])).toBe(actions.length);
      expect(last.at).toBeLessThanOrEqual(reply.at);
      // THE TOTALS EDIT IS AN EDIT OF THE SAME MESSAGE (the second seat's
      // finding). A door that edited the line as it went and then sent the
      // totals to some other message id would leave the progress line frozen
      // mid-work and put the totals somewhere the person is not looking, and
      // every assertion above would still hold.
      expect(last.id).toBe(String(first.id));

      // --- 6. the sheet is gone at the settle. A thing that is gone leaves no
      //     line behind (L17).
      expect(await it.read.sheet("turn_progress")).toEqual([]);

      // --- 5. a loop that reported NO action still gets a line, which is
      //     MSG-10's "a turn with no tool call still lands" as a sentence a
      //     person reads. Both forms are asserted whole.
      const before = it.fake.posts().filter((one) => one.chat === CHAT).length;
      it.scripted.holdTurnEnd(true);
      it.fake.deliver({ text: "a question that needs no tool at all" });
      await until(
        "the second progress line was posted",
        () => it.fake.posts().filter((one) => one.chat === CHAT).length >= before + 1,
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      const plain = it.fake.posts().filter((one) => one.chat === CHAT)[before];
      expect(WORKING_NO_ACTIONS.test(plain.text)).toBe(true);
      it.scripted.holdTurnEnd(false);
      await until(
        "the second reply was posted",
        () => it.fake.posts().filter((one) => one.chat === CHAT).length >= before + 2,
        45_000,
      );
      await Bun.sleep(1000);
      const secondReply = it.fake.posts().filter((one) => one.chat === CHAT)[before + 1];
      const plainEdits = it.fake
        .edits()
        .filter((one) => one.chat === CHAT && one.id === String(plain.id) && one.at <= secondReply.at);
      expect(TOTALS_NO_ACTIONS.test(plainEdits[plainEdits.length - 1].text)).toBe(true);
      expect(plainEdits[plainEdits.length - 1].id).toBe(String(plain.id));

      // --- 7. THE CHAT LOG. A progress line is one platform message the door
      //     overwrites as it goes, so a line per edit would flood the tail with
      //     the same sentence at six different second counts, and one line at
      //     the totals would put "3 tool calls, 40 s" in front of the next
      //     session about its own previous turn (D-129).
      const log = chatLogLines(it.stateDir, PERSON, AGENT);
      expect(log.length).toBe(4);
      expect(log.map((line) => line.direction)).toEqual(["in", "out", "in", "out"]);
      for (const line of log) {
        expect(WORKING_WITH_ACTIONS.test(line.text)).toBe(false);
        expect(WORKING_NO_ACTIONS.test(line.text)).toBe(false);
        expect(TOTALS_WITH_ACTIONS.test(line.text)).toBe(false);
        expect(TOTALS_NO_ACTIONS.test(line.text)).toBe(false);
      }
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }

    // --- THE CONTROL: a turn that never opens produces no post and no edit.
    //     Without it a build that posted a line on every tick passes the
    //     assertions above.
    const idle = await stageHub(cluster, { language: "en", hub: { tick_seconds: 1 } });
    let quiet: { stop(): Promise<void> } | null = null;
    try {
      quiet = (await (runDoor as Function)({
        door: DOOR,
        registryFile: idle.registryFile,
        platform: idle.fake.platform,
      })) as { stop(): Promise<void> };
      idle.fake.deliver({ text: "a message no runner will ever claim" });
      await until(
        "the door wrote the row down",
        async () => (await idle.read.inbound()).length >= 1,
        30_000,
      );
      await Bun.sleep(4000);
      expect(idle.fake.posts()).toEqual([]);
      expect(idle.fake.edits()).toEqual([]);
      expect(await idle.read.sheet("turn_progress")).toEqual([]);
    } finally {
      if (quiet) await quiet.stop();
      await idle.stop();
    }
  },
  SLOW,
);
