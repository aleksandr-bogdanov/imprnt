// The door's outbound half.
//
// SPEC §2: "Only then the door posts, marking each chunk delivered after the
// platform accepted it." Its Forbidden list carries "a send before the settle
// commit". SPEC §1 carries "The table holds the work. A notification only wakes
// a runner... No polling on a timer", and its Forbidden list "polling where a
// notification exists". The door's wait on the outbox obeys the same rule, and
// the probe is the: the cluster runs with log_statement = 'all' and
// log_line_prefix = 'pid=%p ', so a check counts what the server was ACTUALLY
// asked to do, by which backend, while the door waited.
//
// The first check binds L1 step 6's "only then" to the SETTLE rather than to
// the chunk insert. A first attempt at this committed a chunk for an
// unsettled row and then required the door to post it, which is the opposite of
// the rule: that chunk is exactly what the door must hold.
//
// These four run the door IN PROCESS with an in-memory platform. Only a kill
// needs a separate process, and a subprocess makes every other failure harder
// to read.
//
// THE RESIDUE, stated so it is not rediscovered: a
// waiter that keeps a flag in memory and re-checks it on a 100 ms timer issues
// no SQL at all, so it is invisible to a statement count and to any other
// black-box probe. Closing it needs to read the implementation, which is the
// build review and the mutation postscript D8 already schedules. No check
// written today can catch it.
//
// Red reasons: export missing, storeUrlAs in src/store/connect.ts, for the role
// check. Import missing, src/door/run.ts, for the other three. Schema missing,
// the outbox_notify_out trigger, for the wake check.

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  seam,
  statementWatch,
  untilIssued,
  backendPid,
  foreignBackends,
  until,
  type Cluster,
} from "./helpers/cluster.ts";
import { AGENT, CHAT, DOOR, PERSON, stageHub } from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 90_000;

/** The door's allowance to LISTEN and read its pending chunks once. */
const SETTLE_MS = 700;

/** Inside the window a door asleep on the notification issues nothing. */
const STATEMENTS_ALLOWED_IN_WINDOW = 0;

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
  unsafe(query: string, values?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
};

/** One throwaway database, one registry naming it, one in-process platform. */
function stage() {
  return stageHub(cluster, { preset: { adapter: "scripted" } });
}

/** A committed inbound row, written by the door role, with no runner involved. */
async function committedInbound(db: string, id: string, body: string) {
  const door = cluster.connectAs("hub_door", db) as unknown as Conn;
  await door.unsafe(
    `insert into inbound (id, person, agent, body)
     values ('${id}', '${PERSON}', '${AGENT}', '${body}')`,
  );
  await door.unsafe(
    `insert into ledger_event (stream, subject, kind, actor)
     values ('inbound', '${id}', 'received', 'door')`,
  );
  await door.close();
}

test(
  "MSG-02 a send before the settle commit is refused: a chunk committed while its inbound row is still started is not posted, and the settling transaction that carries the answered stamp is what makes the door post it (SPEC §2 Forbidden, L1 step 6)",
  async () => {
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");
    // The shipped stamp writer, so the answered event is written the way
    // production writes it rather than by hand.
    const { stamp } = await seam("src/records/stamps.ts");
    expect(typeof stamp).toBe("function");

    const it = await stage();
    let handle: { stop(): Promise<void> } | null = null;
    const runner = cluster.connect(it.db) as unknown as {
      reserve(): Promise<{
        unsafe(query: string): Promise<unknown>;
        release(): void | Promise<void>;
      }>;
      close(): Promise<void>;
    };
    let held: {
      unsafe(query: string): Promise<unknown>;
      release(): void | Promise<void>;
    } | null = null;

    try {
      // A message the runner has taken up and has NOT settled: received by the
      // door, acked and started by the runner. That is the only state in which
      // an unsettled chunk can exist at all.
      await committedInbound(it.db, "m-settle", "a human message");
      const asRunner = cluster.connectAs("hub_runner", it.db) as unknown as Conn;
      for (const kind of ["acked", "started"]) {
        await asRunner.unsafe(
          `insert into ledger_event (stream, subject, kind, actor)
           values ('inbound', 'm-settle', '${kind}', 'runner')`,
        );
      }
      await asRunner.close();
      expect((await it.read.inbound())[0].state).toBe("started");

      handle = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      await Bun.sleep(SETTLE_MS);

      // THE LOAD. A chunk on disk whose row is not settled is exactly what L1
      // step 6's "only then" forbids the door from posting. The insert fires
      // outbox_notify_out, so the door was told about it: a door that never
      // woke is not an available excuse for the silence below.
      held = await runner.reserve();
      await held.unsafe("set role hub_runner");
      await held.unsafe("begin");
      await held.unsafe(
        `insert into outbox (inbound_id, seq_in_reply, body)
         values ('m-settle', 1, 'the chunk the runner has not settled')`,
      );
      await held.unsafe("commit");

      await Bun.sleep(2500);
      expect(it.fake.attempts().length).toBe(0);
      expect(it.fake.posts().length).toBe(0);
      expect((await it.read.outbox())[0].delivered_at).toBeNull();

      // The settle. One transaction carrying the rest of the reply AND the
      // answered stamp, which is what L1 step 5 rules and what the door's wake
      // is emitted by.
      //
      // REFINEMENT, and the reason for it: the answered stamp alone emits no
      // notification, because the pinned trigger is AFTER INSERT on `outbox`.
      // A door woken only by a settle commit therefore could not post at the
      // moment a lone stamp landed, so the settling transaction carries both,
      // which is the shape production has anyway.
      const settled = Date.now();
      await held.unsafe("begin");
      await held.unsafe(
        `insert into outbox (inbound_id, seq_in_reply, body)
         values ('m-settle', 2, 'the rest of the settled reply')`,
      );
      await held.unsafe(
        `insert into ledger_event (stream, subject, kind, actor)
         values ('inbound', 'm-settle', 'answered', 'runner')`,
      );
      await held.unsafe("commit");

      await until(
        "the door posted the settled reply",
        () => it.fake.posts().length >= 2,
        10_000,
        async () => JSON.stringify(await it.read.outbox()),
      );
      expect(Date.now() - settled).toBeLessThan(1000);

      // Both chunks, in order. The first one is the proof the door was HOLDING
      // it rather than having lost it, and its arrival only now is the proof
      // the settle is what released it.
      expect(it.fake.posts().length).toBe(2);
      expect(it.fake.posts().map((p) => p.text)).toEqual([
        "the chunk the runner has not settled",
        "the rest of the settled reply",
      ]);
      expect(it.fake.posts()[0].chat).toBe(CHAT);
    } finally {
      if (held) await held.release();
      await runner.close();
      if (handle) await handle.stop();
      await it.read.close();
    }
  },
  SLOW,
);

test(
  "STORE-04 polling where a notification exists is absent in the door's outbox wait: its backend issues no statement of any kind while it waits, and with the outbox_notify_out trigger disabled a committed chunk is not posted at all (SPEC §1 Forbidden, D5)",
  async () => {
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");

    const it = await stage();
    let handle: { stop(): Promise<void> } | null = null;

    // Every connection the test will use is opened BEFORE the window, so
    // nothing of the test's own can be counted inside it.
    const owner = cluster.connect(it.db) as unknown as Conn;
    const ownerPid = await backendPid(owner);
    const readerPid = await it.read.pid();
    const runner = cluster.connectAs("hub_runner", it.db) as unknown as Conn;
    const runnerPid = await backendPid(runner);

    try {
      await committedInbound(it.db, "m-wake", "a human message");
      const settle = await statementWatch(cluster, [ownerPid, readerPid, runnerPid]);
      handle = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });

      // The window opens after the door has had time to LISTEN and read its
      // pending chunks once, which is D5's own allowance. Everything counted
      // after this is a timer.
      // The door is handed back ready once its read, clock and harvest tasks
      // have landed their connect reads, and its post task's LISTEN and first
      // read of pending replies can still be on their way. That read is the
      // last statement of its start, so the window waits to see it.
      await untilIssued(settle, "the door's post task read its pending replies once", /from outbox o\b/, { after: /listen hub_outbox/ });
      await Bun.sleep(SETTLE_MS);
      const watch = await statementWatch(cluster, [
        ownerPid,
        readerPid,
        runnerPid,
      ]);
      await Bun.sleep(3000);

      const issued = await watch.count();
      if (issued > STATEMENTS_ALLOWED_IN_WINDOW) {
        throw new Error(
          `the door issued ${issued} statements while waiting for a reply to post, which is a timer, not a wait. Statements:\n` +
            (await watch.lines()).slice(0, 8).join("\n"),
        );
      }

      // The suppressed half. The trigger is disabled BY NAME, so the schema
      // object is bound and cannot be renamed away.
      await owner.unsafe(
        "alter table outbox disable trigger outbox_notify_out",
      );
      await runner.unsafe(
        `insert into outbox (inbound_id, seq_in_reply, body)
         values ('m-wake', 1, 'the chunk nothing announced')`,
      );
      await Bun.sleep(3000);
      expect(it.fake.posts().length).toBe(0);

      // The control. Without it a door that never reads the outbox at all
      // passes the half above, and that is not the rule.
      await owner.unsafe("alter table outbox enable trigger outbox_notify_out");
      const committed = Date.now();
      await runner.unsafe(
        `insert into outbox (inbound_id, seq_in_reply, body)
         values ('m-wake', 2, 'the chunk the trigger announced')`,
      );
      await until(
        "the door posted the announced chunk",
        () => it.fake.posts().some((p) => p.text.includes("the trigger announced")),
        10_000,
      );
      expect(Date.now() - committed).toBeLessThan(1000);
    } finally {
      await owner
        .unsafe("alter table outbox enable trigger outbox_notify_out")
        .catch(() => {});
      await owner.close();
      await runner.close();
      if (handle) await handle.stop();
      await it.read.close();
    }
  },
  SLOW,
);

test(
  "MSG-02 a chunk is marked delivered after the platform accepted it: a refusing platform leaves delivered_at null and writes no delivered stamp, and the attempt still happened (SPEC §2, L1 step 6)",
  async () => {
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");

    const it = await stage();
    await Bun.write(it.registryFile, (await Bun.file(it.registryFile).text()) + "\n[door]\ndelivery_retry_seconds = 1\n");
    let handle: { stop(): Promise<void> } | null = null;
    const runner = cluster.connectAs("hub_runner", it.db) as unknown as Conn;

    try {
      await committedInbound(it.db, "m-deliver", "a human message");
      it.fake.holdPosts(true);

      handle = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      await Bun.sleep(SETTLE_MS);

      await runner.unsafe(
        `insert into outbox (inbound_id, seq_in_reply, body)
         values ('m-deliver', 1, 'the reply the platform will refuse')`,
      );

      // The refusing half is the load. Without it a door that marks a chunk
      // delivered the moment it hands it over passes every other check in the
      // phase, and the failure behind this rule is a channel that reported
      // success at every layer while swallowing messages.
      await until(
        "the door tried to post the chunk",
        () => it.fake.attempts().length >= 1,
        10_000,
      );
      await Bun.sleep(2000);

      const pending = await it.read.outbox();
      expect(pending.length).toBe(1);
      expect(pending[0].delivered_at).toBeNull();
      expect(
        await it.read.ledger({ stream: "inbound", kind: "delivered" }),
      ).toEqual([]);
      expect(it.fake.posts().length).toBe(0);

      // Now the platform accepts, and the two facts land together.
      it.fake.holdPosts(false);
      await until(
        "the chunk was marked delivered",
        async () => (await it.read.outbox())[0].delivered_at !== null,
        15_000,
      );
      await Bun.sleep(1000);

      expect(it.fake.posts().length).toBe(1);
      expect(it.fake.posts()[0].text).toBe(
        "the reply the platform will refuse",
      );
      const stamps = await it.read.ledger({
        stream: "inbound",
        kind: "delivered",
      });
      expect(stamps.length).toBe(1);
      expect(stamps[0].actor).toBe("door");
      expect(stamps[0].subject).toBe("m-deliver");
    } finally {
      await runner.close();
      if (handle) await handle.stop();
      await it.read.close();
    }
  },
  SLOW,
);

test(
  "MSG-01 the door's process is the door role: the registry carries a store url with no user, every backend the door opened reports hub_door, and that role cannot write a reply (SPEC §2, L1, and 02-CONTEXT D-36)",
  async () => {
    // The tagged red reason. src/store/connect.ts is shipped and imports
    // cleanly, so this is an export that is not there yet, and it is asserted
    // before anything else so nothing else can fire first.
    const { storeUrlAs } = await seam("src/store/connect.ts");
    expect(typeof storeUrlAs).toBe("function");
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");

    const it = await stage();
    let handle: { stop(): Promise<void> } | null = null;

    try {
      // The registry carries the location and no user, so a typo cannot
      // hand the door the runner's role and bypass the whole fence.
      expect(it.storeUrl).not.toContain("@");
      const registry = await Bun.file(it.registryFile).text();
      expect(registry).toContain(it.storeUrl);
      expect(registry).not.toContain("hub_door@");
      expect(registry).not.toContain("hub_runner@");

      // The pure string function that supplies the role.
      const asDoor = (storeUrlAs as Function)(it.storeUrl, "hub_door") as string;
      expect(new URL(asDoor).username).toBe("hub_door");
      expect(new URL(asDoor).pathname).toBe(new URL(it.storeUrl).pathname);
      expect(new URL(asDoor).port).toBe(new URL(it.storeUrl).port);

      const readerPid = await it.read.pid();
      handle = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      await Bun.sleep(SETTLE_MS);

      // Every backend that is not the test's own, not just one, so a door that
      // opens a second connection as somebody else fails here.
      const theirs = await foreignBackends(cluster, it.db, [readerPid]);
      expect(theirs.length).toBeGreaterThan(0);
      for (const backend of theirs) {
        expect(backend.usename).toBe("hub_door");
      }

      // The negative half: the fence, proved against a real process
      // rather than a bare connection. The door cannot write a reply even if
      // its own code asked it to.
      await committedInbound(it.db, "m-role", "a human message");
      const door = cluster.connectAs("hub_door", it.db) as unknown as Conn;
      let refusal = "";
      try {
        await door.unsafe(
          `insert into outbox (inbound_id, seq_in_reply, body)
           values ('m-role', 1, 'the door wrote a reply')`,
        );
      } catch (err) {
        refusal = String((err as Error).message);
      }
      await door.close();
      expect(refusal).not.toBe("");
      expect(refusal).toMatch(
        /permission denied|row-level security|insufficient privilege|42501/i,
      );
    } finally {
      if (handle) await handle.stop();
      await it.read.close();
    }
  },
  SLOW,
);
