// STORE-04, proved for the first time against a real runner.
//
// SPEC §1: "The table holds the work. A notification only wakes a runner. On
// every connect and after every turn the runner reads its eligible rows." Its
// Forbidden list carries "a runner that relies on a notification alone to learn
// about waiting rows". Its Check line: "A reconnecting runner drains waiting
// rows with no new arrival."
//
// The requirement predates the runner, so this is
// the first check that can put a runner behind it. The rows are enqueued before
// the runner PROCESS exists, not merely before it connects, so every
// notification they emitted was gone before anything could hear it.
//
// The second check here is the runner's half of the same rule's other clause:
// while it waits, it issues nothing. The cluster runs with log_statement = 'all'
// and log_line_prefix = 'pid=%p ', so the count comes from the server and
// nothing client-side can fake it, the way the store checks count the waiter's own
// backend and the way test/door-outbox.test.ts counts the door's.
//
// Red reason: import missing, src/runner/run.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  seam,
  statementWatch,
  untilIssued,
  backendPid,
  until,
  type Cluster,
} from "./helpers/cluster.ts";
import { scriptedReply } from "./helpers/scripted-adapter.ts";
import {
  AGENT,
  PERSON,
  RUNNER,
  insertInbound,
  plantChatLine,
  stageHub,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

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

function ago(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

test(
  "STORE-04 a reconnecting runner drains waiting rows with no new arrival: three rows enqueued before the runner existed are all answered, and the ledger holds no received event after it started (SPEC §1, D5)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");
    const { connectRunner } = await seam("src/store/runner.ts");
    expect(typeof connectRunner).toBe("function");
    const { TAIL_PREAMBLE } = await seam("src/chatlog.ts");
    expect(typeof TAIL_PREAMBLE).toBe("string");

    const it = await stageHub(cluster);
    let runner: { stop(): Promise<void> } | null = null;

    try {
      // L2's tail is fed first on every spawn, so what the drain fed is the
      // tail and then the three waiting rows. Asserting that here puts "before
      // any human message" under this check as well as under chatlog.test.ts.
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });

      const bodies = [
        "the first thing that waited",
        "the second thing that waited",
        "the third thing that waited",
      ];
      await insertInbound(cluster, it.db, {
        id: "w1",
        body: bodies[0],
        receivedAt: ago(30),
      });
      await insertInbound(cluster, it.db, {
        id: "w2",
        body: bodies[1],
        receivedAt: ago(20),
      });
      await insertInbound(cluster, it.db, {
        id: "w3",
        body: bodies[2],
        receivedAt: ago(10),
      });

      // The high water mark of the diary at the moment the runner came up.
      // Sequence rather than time: a timestamp truncated to the millisecond can
      // tie with the row that follows it, and a tie would make a correct run
      // look like an arrival after the start.
      const [{ seq: seqAtStart }] = (await it.read.sql(
        "select coalesce(max(seq), 0) as seq from ledger_event",
      )) as { seq: string }[];

      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      await until(
        "all three waiting rows were answered",
        async () => (await it.read.outbox()).length >= 3,
        60_000,
        async () =>
          `fed=${JSON.stringify(it.scripted.fed().map((f) => f.text))} outbox=${
            (await it.read.outbox()).length
          }`,
      );
      await Bun.sleep(1500);

      const chunks = await it.read.outbox();
      expect(chunks.length).toBe(3);
      expect(new Set(chunks.map((c) => c.inbound_id))).toEqual(
        new Set(["w1", "w2", "w3"]),
      );
      for (const chunk of chunks) {
        const row = (await it.read.inbound()).find((r) => r.id === chunk.inbound_id)!;
        expect(chunk.body).toBe(scriptedReply(row.body));
      }

      // The assertion that makes this more than an end to end smoke. No new
      // arrival could have supplied the wake, so a runner that only ever acts
      // on a notification answers zero here, and a check that merely counted
      // three replies would pass on a runner that was lucky.
      const arrivals = await it.read.ledger({
        stream: "inbound",
        kind: "received",
      });
      expect(arrivals.length).toBe(3);
      for (const arrival of arrivals) {
        expect(arrival.seq).toBeLessThanOrEqual(Number(seqAtStart));
      }

      // And a drain that shuffles is caught, which costs nothing here.
      const fed = it.scripted.fed();
      expect(fed[0].text.startsWith(TAIL_PREAMBLE as string)).toBe(true);
      expect(fed.slice(1).map((f) => f.text)).toEqual(bodies);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

/** The runner's allowance to LISTEN and read its eligible rows once. */
const SETTLE_MS = 700;

/** Inside the window a runner asleep on the notification issues nothing. */
const STATEMENTS_ALLOWED_IN_WINDOW = 0;

type Conn = {
  unsafe(query: string, values?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
};

test(
  "STORE-04 and MSG-02 polling where a notification exists is absent in the runner's wait for work: with the inbound notification suppressed an eligible row sits on disk and the runner's backends issue no statement of any kind, and with it back in place the waiting row is picked up inside a second (SPEC §1 Forbidden and §2, D5, ROADMAP phase 2 criterion 7)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    // tick_seconds is long here on purpose: the window has to sit inside ONE
    // wait rather than span a re-read the registry itself schedules. What is
    // under test is the wait, not the tick.
    const it = await stageHub(cluster, { registry: (base) => ({
      ...base,
      hub: { ...(base.hub ?? {}), tick_seconds: 30 },
    }) });
    let runner: { stop(): Promise<void> } | null = null;

    // Every connection the test uses is opened BEFORE the window, and its pid
    // is known, so nothing of the test's own can be counted inside it. An
    // insert on a connection opened during the window would be counted as the
    // runner's, which is why the rows below go in on this one.
    const owner = cluster.connect(it.db) as unknown as Conn;
    const ownerPid = await backendPid(owner);
    const door = cluster.connectAs("hub_door", it.db) as unknown as Conn;
    const doorPid = await backendPid(door);
    const readerPid = await it.read.pid();

    const asDoor = async (id: string, body: string) => {
      await door.unsafe(
        `insert into inbound (id, person, agent, body)
         values ('${id}', '${PERSON}', '${AGENT}', '${body}')`,
      );
      await door.unsafe(
        `insert into ledger_event (stream, subject, kind, actor)
         values ('inbound', '${id}', 'received', 'door')`,
      );
    };

    try {
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      // One message answered, so the runner is settled and idle rather than
      // still coming up. A window opened over a starting runner would be
      // counting its connect, which D5 allows.
      // Everything the runner says to the server from here, so the window can
      // open after the last of what this message sets off.
      const settle = await statementWatch(cluster, [ownerPid, doorPid, readerPid]);
      await asDoor("w-first", "the message that settles the runner");
      await until(
        "the first message was settled",
        async () => (await it.read.outbox()).length >= 1,
        60_000,
        // WHAT A FAILURE HERE HAS TO SAY, because this one only happens on the
        // slower box inside a full suite run and the first two times it did,
        // the message said only what the loop had been fed, which cannot tell
        // "the row never arrived" from "the runner heard nothing" from "the
        // runner fell over and wrote down why". All three are in the store.
        async () =>
          `fed=${JSON.stringify(it.scripted.fed().map((f) => f.text))} ` +
          `inbound=${JSON.stringify(await it.read.inbound())} ` +
          `refusals=${JSON.stringify(await it.read.ledger({ stream: "refusal" }))} ` +
          `runner=${JSON.stringify(await it.read.ledger({ stream: "runner" }))}`,
      );

      // The reply is visible at the settle's commit, and the runner is not
      // idle yet: it goes on to read the window and the next row, and then the
      // nearest recorded deadline, which is the last thing it asks before it
      // sleeps. The window waits to see that read.
      await untilIssued(settle, "the runner read its next deadline after the settle, the last statement before it sleeps", /ceil\(extract\(epoch/, { after: /insert into outbox/ });

      // Nothing can announce the next row. The trigger is disabled BY NAME, so
      // the schema object is bound and cannot be renamed away.
      await owner.unsafe(
        "alter table inbound disable trigger inbound_notify_work",
      );

      await Bun.sleep(SETTLE_MS);
      const watch = await statementWatch(cluster, [
        ownerPid,
        doorPid,
        readerPid,
      ]);

      await asDoor("w-silent", "the row nothing announced");
      await Bun.sleep(3000);

      const issued = await watch.count();
      if (issued > STATEMENTS_ALLOWED_IN_WINDOW) {
        throw new Error(
          `the runner issued ${issued} statements while waiting for work, which is a timer, not a wait. Statements:\n` +
            (await watch.lines()).slice(0, 8).join("\n"),
        );
      }

      // And the row really was there to be found, so the silence is a waiting
      // runner and not an empty table.
      const waiting = (await it.read.inbound()).find((r) => r.id === "w-silent")!;
      expect(waiting).toBeDefined();
      expect(waiting.claimed_by).toBeNull();
      expect(waiting.state).toBe("received");
      expect((await it.read.outbox()).length).toBe(1);

      // The control. Without it a runner that never reads the table at all
      // passes the half above, and that is not the rule. The notification the
      // next commit emits is what makes the runner act, and the row it had been
      // ignoring moves with it.
      await owner.unsafe(
        "alter table inbound enable trigger inbound_notify_work",
      );
      const committed = Date.now();
      await asDoor("w-notified", "the row the trigger announced");

      await until(
        "the runner took up the row it had been ignoring",
        async () => {
          const row = (await it.read.inbound()).find((r) => r.id === "w-silent");
          return !!row && (row.claimed_by !== null || row.state !== "received");
        },
        10_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      expect(Date.now() - committed).toBeLessThan(1000);
    } finally {
      await owner
        .unsafe("alter table inbound enable trigger inbound_notify_work")
        .catch(() => {});
      await owner.close();
      await door.close();
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);
