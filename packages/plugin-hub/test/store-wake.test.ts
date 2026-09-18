// STORE-04. The table holds the work, the notification only wakes a runner.
//
// SPEC §1: "The table holds the work. A notification only wakes a runner. On
// every connect and after every turn the runner reads its eligible rows... The
// transaction that makes work available emits the notification. No polling on a
// timer." Its Forbidden list carries "polling where a notification exists" and
// "a runner that relies on a notification alone to learn about waiting rows".
//
// Nothing here greps a source file for the word "poll". The cluster runs with
// `log_statement = 'all'` and `log_line_prefix = 'pid=%p '`, so every check can
// count what the server was ACTUALLY asked to do, by which backend, while the
// waiter waited. A waiter asleep on a notification issues NOTHING. A waiter on
// a timer issues something every tick. The count comes from the database and
// nothing client-side can fake it.
//
// The count is of STATEMENTS, not of text. The second seat broke an earlier
// text-matching version three ways: a statement split across two lines put
// `SELECT id` and `FROM inbound` on different lines and counted zero, a poll of
// a different table counted zero, and a poll of a separate signal table counted
// zero. Counting every statement from a backend that is not the test's own
// closes all three at once.
//
// THE WINDOW. A waiter is allowed a LISTEN and one read of its eligible rows
// when it starts, which is D5's own "on every connect and after every turn the
// runner reads its eligible rows". So the window opens AFTER the waiter has
// settled, and inside the window the allowance is ZERO statements of any kind.

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  freshDatabase,
  seam,
  statementWatch,
  backendPid,
  type Cluster,
} from "./helpers/cluster.ts";

let cluster: Cluster;

const AGENT = "p1-lair";

// A cluster start plus a wait window costs more than bun's 5 s default, and a
// Pi is slower than this Mac. Without this a real failure surfaces as a
// timeout, which says nothing about the behaviour.
const SLOW = 90_000;

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

type Conn = {
  unsafe(query: string): Promise<unknown>;
  close(): Promise<void>;
};

/** An eligible inbound row written straight to the table, no seam involved. */
async function insertEligible(
  sql: { unsafe(query: string): Promise<unknown> },
  id: string,
) {
  await sql.unsafe(
    `insert into inbound (id, person, agent, body)
     values ('${id}', 'p1', '${AGENT}', 'a human message')`,
  );
}

/**
 * How long the waiter gets to issue its LISTEN and its one eligible read before
 * the window opens. Anything after this is a timer.
 */
const SETTLE_MS = 700;

/** Inside the window a waiter that sleeps on a notification issues nothing. */
const STATEMENTS_ALLOWED_IN_WINDOW = 0;

async function assertSilent(
  watch: { count(): Promise<number>; lines(): Promise<string[]> },
  what: string,
) {
  const issued = await watch.count();
  if (issued > STATEMENTS_ALLOWED_IN_WINDOW) {
    throw new Error(
      `the waiter issued ${issued} statements while ${what}, which is a timer, not a wait. Statements:\n` +
        (await watch.lines()).slice(0, 8).join("\n"),
    );
  }
}

test(
  "STORE-04 polling where a notification exists is absent: the waiter is already waiting when the row lands with the notification suppressed, and it neither wakes nor reads the table while it waits (SPEC §1 Forbidden, D5)",
  async () => {
    const { openStore, closeStore } = await seam("src/store/connect.ts");
    const { waitForWork, readEligible } = await seam("src/store/wake.ts");
    expect(typeof waitForWork).toBe("function");
    expect(typeof readEligible).toBe("function");

    const db = await freshDatabase(cluster);
    const store = await (openStore as Function)({ url: cluster.url(db) });

    // Disabling a trigger needs table ownership, so this runs on the superuser
    // connection rather than a role connection.
    const owner = cluster.connect(db) as unknown as Conn;
    const ownerPid = await backendPid(owner);
    await owner.unsafe("alter table inbound disable trigger inbound_notify_work");

    // The waiter starts FIRST and the row lands while it is waiting, so the row
    // is new to any implementation, including one that snapshotted the ids it
    // had already seen. That is what kills the poll-for-new-ids escape.
    const started = Date.now();
    const waiting = (waitForWork as Function)(store, {
      agent: AGENT,
      timeoutMs: 6000,
    });

    // The window opens after the waiter has had time to LISTEN and read its
    // eligible rows once. Everything counted after this is a timer.
    await Bun.sleep(SETTLE_MS);
    const watch = await statementWatch(cluster, [ownerPid]);

    await insertEligible(owner, "m-suppressed");
    await Bun.sleep(3000);

    // The decisive one, and it is counted BEFORE the bound expires, so the
    // waiter's own wind-down cannot be mistaken for a poll.
    await assertSilent(watch, "an eligible row sat on disk with the notification suppressed");

    const reason = await waiting;
    const waited = Date.now() - started;

    expect(reason).toBe("timeout");
    expect(waited).toBeGreaterThanOrEqual(5800);

    // And the row really was eligible, so the check cannot pass because the
    // waiter had nothing to find.
    const eligible = (await (readEligible as Function)(store, {
      agent: AGENT,
    })) as { id: string }[];
    expect(eligible.map((r) => r.id)).toContain("m-suppressed");

    await owner.unsafe("alter table inbound enable trigger inbound_notify_work");
    await owner.close();
    await (closeStore as Function)(store);
  },
  SLOW,
);

test(
  "STORE-04 the control: with the notification in place a waiting runner wakes inside one second, which no timer slow enough to pass the read count could do (SPEC §1, D5)",
  async () => {
    const { openStore, closeStore } = await seam("src/store/connect.ts");
    const { waitForWork } = await seam("src/store/wake.ts");
    expect(typeof waitForWork).toBe("function");

    const db = await freshDatabase(cluster);
    const store = await (openStore as Function)({ url: cluster.url(db) });

    const producer = cluster.connect(db) as unknown as Conn;

    const waiting = (waitForWork as Function)(store, {
      agent: AGENT,
      timeoutMs: 8000,
    });
    await Bun.sleep(200);
    const inserted = Date.now();
    await insertEligible(producer, "m-notified");

    const reason = await waiting;
    const latency = Date.now() - inserted;

    expect(reason).toBe("notified");

    // Paired with the read count above, this closes the gap from both sides: a
    // timer fast enough to wake within a second reads the table far more than
    // twice in four seconds, and a timer slow enough to read it twice cannot
    // wake within a second.
    expect(latency).toBeLessThan(1000);

    await producer.close();
    await (closeStore as Function)(store);
  },
  SLOW,
);

test(
  "STORE-04 the notification comes from the transaction that makes the row available: the row exists uncommitted while the waiter waits and reads nothing, and the commit is what wakes it (ROADMAP phase 1 criterion 9, rule at SPEC §1, D5)",
  async () => {
    const { openStore, closeStore } = await seam("src/store/connect.ts");
    const { waitForWork } = await seam("src/store/wake.ts");
    expect(typeof waitForWork).toBe("function");

    const db = await freshDatabase(cluster);
    const store = await (openStore as Function)({ url: cluster.url(db) });

    const producer = cluster.connect(db) as unknown as {
      reserve(): Promise<{
        unsafe(query: string): Promise<unknown>;
        release(): void | Promise<void>;
      }>;
      close(): Promise<void>;
    };
    const held = await producer.reserve();
    try {
      const heldPid = await backendPid(held);

      let settled: string | null = null;
      const waiting = (waitForWork as Function)(store, {
        agent: AGENT,
        timeoutMs: 20000,
      }).then((reason: string) => {
        settled = reason;
        return reason;
      });

      // The window opens after the waiter has settled, as above.
      await Bun.sleep(SETTLE_MS);
      const watch = await statementWatch(cluster, [heldPid]);

      await held.unsafe("begin");
      await insertEligible(held, "m-uncommitted");
      await Bun.sleep(2500);

      // Nothing has woken, and nothing has been looking.
      expect(settled).toBeNull();
      await assertSilent(watch, "the insert was uncommitted");

      const committed = Date.now();
      await held.unsafe("commit");
      const reason = await waiting;
      const latency = Date.now() - committed;

      expect(reason).toBe("notified");
      // The commit is what woke it, not a tick that happened to land after it.
      expect(latency).toBeLessThan(1000);

    } finally {
      await held.release();
      await producer.close();
      await (closeStore as Function)(store);
    }
  },
  SLOW,
);

test(
  "STORE-04 a runner that connects reads its eligible rows without a notification: the connect path itself surfaces them, nothing asks (ROADMAP phase 1 criterion 9, rule at SPEC §1, D5)",
  async () => {
    const { openStore, closeStore } = await seam("src/store/connect.ts");
    const { enqueueInbound } = await seam("src/store/inbound.ts");
    const { connectRunner } = await seam("src/store/runner.ts");
    expect(typeof connectRunner).toBe("function");
    expect(typeof enqueueInbound).toBe("function");

    const db = await freshDatabase(cluster);

    // The row arrives while nobody is listening, which is a runner that was off.
    const doorStore = await (openStore as Function)({ url: cluster.url(db) });
    await (enqueueInbound as Function)(doorStore, {
      id: "m-waiting",
      person: "p1",
      agent: AGENT,
      body: "sent while the runner was down",
    });
    await (closeStore as Function)(doorStore);

    // The runner comes back. It asks for nothing. Connecting is what surfaces
    // the waiting rows, which is D5's "on every connect the runner reads its
    // eligible rows". A build where the read only happens when somebody calls
    // it has nothing to hand back here.
    const connected = (await (connectRunner as Function)({
      url: cluster.url(db),
      agent: AGENT,
    })) as { store: unknown; eligible: { id: string }[] };

    expect(Array.isArray(connected.eligible)).toBe(true);
    expect(connected.eligible.map((r) => r.id)).toContain("m-waiting");

    // And it is this runner's row, not everybody's.
    const other = (await (connectRunner as Function)({
      url: cluster.url(db),
      agent: "p2-lair",
    })) as { store: unknown; eligible: { id: string }[] };
    expect(other.eligible.map((r) => r.id)).not.toContain("m-waiting");

    await (closeStore as Function)(connected.store);
    await (closeStore as Function)(other.store);
  },
  SLOW,
);

test(
  "STORE-04 a runner wakes itself on a recorded retry deadline, and sleeps to it rather than polling for it (SPEC §1, D5)",
  async () => {
    const { openStore, closeStore } = await seam("src/store/connect.ts");
    const { waitForWork, readEligible } = await seam("src/store/wake.ts");
    expect(typeof waitForWork).toBe("function");

    const db = await freshDatabase(cluster);
    const store = await (openStore as Function)({ url: cluster.url(db) });

    // Trigger disabled, so nothing can notify. The only thing that may wake the
    // waiter is the deadline recorded on the row, which D5 allows in the same
    // breath that it forbids polling: "it wakes itself when a recorded retry or
    // claim deadline passes".
    const owner = cluster.connect(db) as unknown as Conn;
    const ownerPid = await backendPid(owner);
    await owner.unsafe("alter table inbound disable trigger inbound_notify_work");

    // The stopwatch starts BEFORE the insert, so a slow insert eats into the
    // deadline rather than into the lower bound.
    const started = Date.now();
    await owner.unsafe(
      `insert into inbound (id, person, agent, body, state, retry_at)
       values ('m-retry', 'p1', '${AGENT}', 'a message being retried',
               'received', now() + interval '3000 milliseconds')`,
    );

    const waiting = (waitForWork as Function)(store, {
      agent: AGENT,
      timeoutMs: 20000,
    });

    // Window: after the waiter has read the nearest deadline once, and closed
    // well before that deadline arrives, so the wake itself is not counted.
    await Bun.sleep(SETTLE_MS);
    const watch = await statementWatch(cluster, [ownerPid]);
    await Bun.sleep(1500);
    await assertSilent(watch, "sleeping to a recorded deadline");

    const reason = await waiting;
    const waited = Date.now() - started;

    // Woken by the deadline, not by the bound running out.
    expect(reason).toBe("deadline");
    expect(waited).toBeGreaterThanOrEqual(2500);
    expect(waited).toBeLessThan(9000);

    // And the row is eligible once the deadline has passed, so the wake was not
    // a wake about nothing.
    const eligible = (await (readEligible as Function)(store, {
      agent: AGENT,
    })) as { id: string }[];
    expect(eligible.map((r) => r.id)).toContain("m-retry");

    await owner.unsafe("alter table inbound enable trigger inbound_notify_work");
    await owner.close();
    await (closeStore as Function)(store);
  },
  SLOW,
);

test(
  "STORE-04 a waiter that could not open its LISTEN sends its caller to the table anyway: with the channel unreachable, a wait answers notified on its bound rather than timeout, because a caller told nothing by a waiter nobody can talk to would sleep through every row committed for it (SPEC §1, D5, D-70)",
  async () => {
    const { openStore, closeStore } = await seam("src/store/connect.ts");
    const { openWorkWaiter } = await seam("src/store/wake.ts");
    expect(typeof openWorkWaiter).toBe("function");

    const db = await freshDatabase(cluster);
    const store = (await (openStore as Function)({ url: cluster.url(db) })) as {
      url: string;
      sql: unknown;
    };

    // WHY THIS EXISTS. 03b row 6 stopped the runner claiming on a bare timeout,
    // which is what SPEC §1 asks for, and that turned a waiter with no listener
    // from "slow" into "deaf forever": the bound was the only thing that could
    // ever end its wait, and the caller was being told the bound meant nothing
    // happened. MEASURED on this Mac with `listenForWork` made to throw:
    // `test/runner-drain.test.ts` waited out its full minute for a message the
    // door had committed in the first second. On the hub box it showed up as
    // that same file failing in a full suite run and passing alone, which is
    // what a load-dependent lost listener looks like from the outside.
    //
    // The store is REAL and only its channel is unreachable, which is the
    // shape of the failure: the work connection is fine, the second connection
    // the LISTEN needs is what the server refused.
    const deaf = { url: "postgres://127.0.0.1:1/nothing", sql: store.sql };
    const waiter = (await (openWorkWaiter as Function)(deaf, { agent: AGENT })) as {
      wait(ms: number): Promise<string>;
      close(): Promise<void>;
    };
    try {
      const started = Date.now();
      const first = await waiter.wait(1500);
      const waited = Date.now() - started;
      // It waited its bound rather than returning at once: a waiter that spun
      // would be a poll wearing this answer.
      expect(waited).toBeGreaterThanOrEqual(1200);
      // And the answer is the one that means LOOK. `timeout` here is the answer
      // that loses work.
      expect(first).toBe("notified");
      // Still true on the next one, because nothing has come back.
      expect(await waiter.wait(1200)).toBe("notified");
    } finally {
      await waiter.close();
    }

    // THE CONTROL, and it is what stops this passing on a waiter that answers
    // `notified` to everything: the same call against the REAL store, with
    // nothing to be told about, comes back `timeout`.
    const healthy = (await (openWorkWaiter as Function)(store, { agent: AGENT })) as {
      wait(ms: number): Promise<string>;
      close(): Promise<void>;
    };
    try {
      expect(await healthy.wait(1500)).toBe("timeout");
    } finally {
      await healthy.close();
    }

    await (closeStore as Function)(store);
  },
  SLOW,
);
