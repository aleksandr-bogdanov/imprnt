// MSG-02. The order of operations, probed by killing the door inside it.
//
// SPEC §2: "the door reads from the platform, writes the inbound row, commits,
// only then acks the platform." Its Forbidden list carries "a cursor that moves
// before the inbound commit". Its Check line: "kill the door between read and
// ack, restart, the message is answered exactly once."
//
// L1 leaves two gaps in that order and each one gets its own check. The first
// is between step 1 and step 2, where the door has the message and nothing is
// on disk. The second is between step 2 and step 3, where the row is committed
// and the platform has not been told, so it redelivers.
//
// THE STAGING. A kill has to land while the door is inside the statement the
// check is about, and a sleep before the kill is a race. So the test holds
// `lock table <t> in access exclusive mode` in an open transaction, watches
// `pg_stat_activity` for a hub_door backend blocked on a Lock on that table,
// and only when it sees that backend does it send the signal. Nothing in
// production code is switched by any of this.
//
// THE ORDER OF THE STAGING matters as much as the lock. The second seat's first
// pass took both locks before the door started, and an ACCESS EXCLUSIVE lock on
// state_row blocks a READ of that table as well as a write, so the door's own
// startup cursor read could have been the backend the waiter saw and the kill
// would have landed somewhere other than the point the check names. So the door
// starts first, the check waits until the fake platform reports a pull (the
// door has read its cursor and is asking the platform), and only then is the
// lock taken and the message delivered. The second variant waits for the
// committed inbound row as well, so the kill point is the gap between step 2
// and step 3 by observation and not by hope.
//
// Measured on a real cluster before these checks were written, because the
// whole first half rests on it: a kill -9 on the client does NOT roll back the
// statement the server is running. The server finishes the blocked statement
// when the lock is released and only then notices the closed socket. A door
// whose inbound write is ONE transaction therefore leaves nothing. A door that
// writes the row and its received stamp as two autocommitting statements leaves
// the row without the stamp, and that is what the first check catches.
//
// Red reason: import missing, src/door/run.ts.

import { stageHub } from "./helpers/authorized-registry.ts";
import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  seam,
  lockTable,
  waitForLockWaiter,
  waitForBackendsGone,
  startReadySubprocess,
  until,
  type Cluster,
  type ReadyProcess,
} from "./helpers/cluster.ts";
import { scriptedReply } from "./helpers/scripted-adapter.ts";
import {
  AGENT,
  CHAT,
  DOOR,
  PERSON,
  RUNNER,
  chatLogLines,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

// A cluster start, two child processes and a real turn cost more than bun's
// 5 s default, and a Pi is slower than this Mac. Without this a real failure
// would surface as a timeout, which says nothing about the behaviour.
const SLOW = 90_000;

const MESSAGE = "what is the claim lease set to";

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/**
 * One throwaway database, one fake platform, one scripted loop, one registry,
 * with the platform and the loop behind http because a kill needs its own
 * process. The adapter name is generated at run time, so no build can have
 * branched on it.
 */
function stage() {
  return stageHub(cluster, { servers: true });
}

test(
  "MSG-02 kill the door between read and ack, restart, the message is answered exactly once: killed before the inbound commit it leaves no row, no received stamp and no cursor (SPEC §2, L1)",
  async () => {
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");
    const { CURSOR_SHEET } = await seam("src/door/cursor.ts");
    expect(typeof CURSOR_SHEET).toBe("string");

    const it = await stage();
    const read = it.read;
    let door: ReadyProcess | null = null;
    let runner: ReadyProcess | null = null;
    let lock: { pid: number; release(): Promise<void> } | null = null;

    try {
      // The door comes up FIRST and reads its cursor, with nothing locked.
      door = await startReadySubprocess("test/helpers/door-subprocess.ts", [
        it.registryFile,
        DOOR,
        it.platformUrl,
      ]);
      await until(
        "the door read the platform",
        () => it.fake.pulls().length >= 1,
        30_000,
      );
      const pullsBeforeTheKill = it.fake.pulls().length;
      // A door that never read the platform cannot be killed between the read
      // and the ack, so the staging says so rather than assuming it.
      expect(pullsBeforeTheKill).toBeGreaterThanOrEqual(1);

      // L1 step 2. Only now can the door's write be blocked, and only the
      // write: the cursor read already happened.
      lock = await lockTable(cluster, it.db, "inbound");
      it.fake.deliver({ text: MESSAGE });

      // Deterministic, never a sleep: the signal is sent only once the door's
      // own backend is blocked on that table.
      const blocked = await waitForLockWaiter(cluster, it.db, {
        role: "hub_door",
        relation: "inbound",
        timeoutMs: 30_000,
      });
      // It got there by reading the platform again, which is the read half of
      // "between read and ack".
      expect(it.fake.pulls().length).toBeGreaterThan(pullsBeforeTheKill);
      door.proc.kill(9);
      await door.proc.exited;

      await lock.release();
      lock = null;
      await waitForBackendsGone(cluster, it.db, [blocked], 30_000);

      // Nothing was left behind. Three things, because a door that committed
      // the row without its stamp, or moved its cursor first, fails here.
      expect(await read.inbound()).toEqual([]);
      expect(await read.ledger({ stream: "inbound", kind: "received" })).toEqual(
        [],
      );
      expect(await read.sheet(CURSOR_SHEET as string)).toEqual([]);

      // The restart. The platform still holds the message, because the cursor
      // never moved, and this half is what stops the check passing on a door
      // that does nothing forever.
      const pullsBeforeTheRestart = it.fake.pulls().length;
      door = await startReadySubprocess("test/helpers/door-subprocess.ts", [
        it.registryFile,
        DOOR,
        it.platformUrl,
      ]);
      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER,
        it.adapterUrl,
        it.adapterName,
      ]);

      await until(
        "the restarted door posted the reply",
        () => it.fake.posts().length >= 1,
        45_000,
        async () =>
          `inbound=${JSON.stringify(await read.inbound())} outbox=${JSON.stringify(await read.outbox())}`,
      );
      // A moment for a second post to arrive, so "exactly one" is a real count
      // rather than a snapshot taken before the duplicate would have landed.
      await Bun.sleep(1500);

      expect((await read.inbound()).length).toBe(1);
      expect(
        (await read.ledger({ stream: "inbound", kind: "received" })).length,
      ).toBe(1);
      expect((await read.outbox()).length).toBe(1);
      expect(it.fake.posts().length).toBe(1);

      // The reply is the loop's own deterministic answer, so an empty or
      // invented one fails.
      expect(it.fake.posts()[0].text).toBe(scriptedReply(MESSAGE));

      const log = chatLogLines(it.stateDir, PERSON, AGENT);
      expect(log.filter((l) => l.direction === "out").length).toBe(1);

      // The restarted door read the platform again and the redelivery is what
      // it answered, so the one reply is not a leftover of the killed run.
      expect(it.fake.pulls().length).toBeGreaterThan(pullsBeforeTheRestart);
      expect(
        it.fake
          .pulls()
          .slice(pullsBeforeTheRestart)
          .some((p) => p.returned >= 1),
      ).toBe(true);
    } finally {
      if (lock) await lock.release();
      if (door) await door.stop();
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-02 kill the door between read and ack, restart, the message is answered exactly once: killed after the commit and before the cursor moved, the redelivery is absorbed and one received stamp and one inbound chat line stand (SPEC §2, L1)",
  async () => {
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");
    const { CURSOR_SHEET, cursorId } = await seam("src/door/cursor.ts");
    expect(typeof cursorId).toBe("function");

    const it = await stage();
    const read = it.read;
    let door: ReadyProcess | null = null;
    let runner: ReadyProcess | null = null;
    let lock: { pid: number; release(): Promise<void> } | null = null;

    try {
      // The door comes up FIRST and reads its cursor, with nothing locked, so
      // the lock below can only block the cursor WRITE.
      door = await startReadySubprocess("test/helpers/door-subprocess.ts", [
        it.registryFile,
        DOOR,
        it.platformUrl,
      ]);
      await until(
        "the door read the platform",
        () => it.fake.pulls().length >= 1,
        30_000,
      );
      const pullsBeforeTheKill = it.fake.pulls().length;
      expect(pullsBeforeTheKill).toBeGreaterThanOrEqual(1);

      // L1's gap between step 2 and step 3: the row commits, and the cursor is
      // a state sheet row the door cannot write while this lock is held.
      lock = await lockTable(cluster, it.db, "state_row");
      const delivered = it.fake.deliver({ text: MESSAGE });

      // The kill point is observed on BOTH sides, not just one: the inbound
      // row is committed, and a hub_door backend is blocked on the cursor.
      await until(
        "the inbound row committed",
        async () => (await read.inbound()).length === 1,
        30_000,
        async () => JSON.stringify(await read.inbound()),
      );
      const blocked = await waitForLockWaiter(cluster, it.db, {
        role: "hub_door",
        relation: "state_row",
        timeoutMs: 30_000,
      });
      expect(it.fake.pulls().length).toBeGreaterThan(pullsBeforeTheKill);
      door.proc.kill(9);
      await door.proc.exited;

      await lock.release();
      lock = null;
      await waitForBackendsGone(cluster, it.db, [blocked], 30_000);

      // The committed half survived, and the platform was never told.
      expect((await read.inbound()).length).toBe(1);
      expect(
        (await read.ledger({ stream: "inbound", kind: "received" })).length,
      ).toBe(1);
      expect(await read.sheet(CURSOR_SHEET as string)).toEqual([]);

      // A real redelivery: the platform hands the same platform message id out
      // again, because nothing moved its cursor.
      it.fake.redeliverFrom(null);
      const pullsBeforeTheRestart = it.fake.pulls().length;

      door = await startReadySubprocess("test/helpers/door-subprocess.ts", [
        it.registryFile,
        DOOR,
        it.platformUrl,
      ]);
      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER,
        it.adapterUrl,
        it.adapterName,
      ]);

      await until(
        "the restarted door posted the reply",
        () => it.fake.posts().length >= 1,
        45_000,
        async () =>
          `inbound=${JSON.stringify(await read.inbound())} outbox=${JSON.stringify(await read.outbox())}`,
      );
      await until(
        "the door wrote its cursor after the inbound commit",
        async () => (await read.sheet(CURSOR_SHEET as string)).length === 1,
        30_000,
      );
      await Bun.sleep(1500);

      // The idempotent insert absorbed the redelivery.
      const rows = await read.inbound();
      expect(rows.length).toBe(1);
      expect(rows[0].id).toContain(delivered.platform_message_id);
      expect(
        (await read.ledger({ stream: "inbound", kind: "received" })).length,
      ).toBe(1);
      expect((await read.outbox()).length).toBe(1);
      expect(it.fake.posts().length).toBe(1);
      expect(it.fake.posts()[0].text).toBe(scriptedReply(MESSAGE));

      // The cursor is now where the platform left it, keyed by door and chat.
      const cursor = await read.sheet(CURSOR_SHEET as string);
      expect(cursor.length).toBe(1);
      expect(cursor[0].id).toBe((cursorId as Function)(DOOR, CHAT));

      // The one that catches the naive redelivery handler. The chat log is a
      // diary, so a door that re-logs every message it pulls has written down a
      // second message that never happened.
      const log = chatLogLines(it.stateDir, PERSON, AGENT);
      expect(log.filter((l) => l.direction === "in").length).toBe(1);
      expect(log.filter((l) => l.direction === "in")[0].text).toBe(MESSAGE);

      // The redelivery is real: the restarted door pulled again and the
      // platform handed it the same message, and that is what was absorbed.
      const redeliveries = it.fake.pulls().slice(pullsBeforeTheRestart);
      expect(redeliveries.length).toBeGreaterThan(0);
      expect(redeliveries.some((p) => p.returned >= 1)).toBe(true);
    } finally {
      if (lock) await lock.release();
      if (door) await door.stop();
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);
