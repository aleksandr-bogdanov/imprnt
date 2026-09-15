// MSG-02. The settle is one transaction, probed by killing the runner inside it.
//
// SPEC §2: "The turn ends, the runner writes every outbox chunk and settles the
// inbound row in one transaction." Its Check line: "Kill the runner between
// turn end and settle, restart, the reply appears exactly once."
//
// TWO STAGINGS, because the settle has two halves and one lock only probes the
// first. Both hold an access exclusive lock and watch pg_stat_activity for a
// hub_runner backend blocked on that relation before sending the signal, never
// a sleep.
//
//   outbox        the kill lands on the FIRST chunk insert, so nothing of the
//                 settle has been written at all.
//   ledger_event  the kill lands on the `answered` stamp, AFTER the chunks were
//                 written. A settle that is one transaction still leaves zero
//                 chunks, because the transaction dies with the process.
//
// The second is the one the second seat's two-transaction escape needs: a
// runner that commits its chunks in transaction A and settles in transaction B
// passes the outbox staging (blocked A rolls back) and fails this one, because
// A's chunk survives the kill. Its redo then either duplicates the chunk or
// hits the outbox uniqueness constraint. Either way the assertions below say
// so, and a one-transaction settle passes both.
//
// WHAT MUST BE EXACTLY ONCE, and what may honestly repeat. D-46. A redo after
// the kill re-feeds the message, so a second `acked` and a second `started`
// event are appended, and that is honest: the loop genuinely accepted the
// message twice and a diary records what happened. What the settle transaction
// owns must be exactly once, and that is the reply, the answered stamp, the
// turn record and the delivery. So `acked` is asserted at least once, which is
// a loose bound with a reason, and the four things the transaction owns are
// asserted exactly once each. The loose bound cannot be gamed by a runner that
// never redoes anything, because such a runner produces no reply at all.
//
// Red reason: import missing, src/runner/run.ts.

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
  DOOR,
  RUNNER,
  insertInbound,
  plantChatLine,
  stageHub,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 90_000;
const MESSAGE = "what happens to a reply nobody committed";

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

test(
  "MSG-02 kill the runner between the turn end and the settle, restart, the reply appears exactly once: the blocked settle leaves no chunk, no answered stamp and no turn record, and the claim still standing is what tells the restart the row is its own to redo (SPEC §2, L1)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");
    const { settleTurn } = await seam("src/runner/settle.ts");
    expect(typeof settleTurn).toBe("function");
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");

    const it = await stageHub(cluster, { servers: true });
    let runner: ReadyProcess | null = null;
    let door: { stop(): Promise<void> } | null = null;
    let lock: { pid: number; release(): Promise<void> } | null = null;

    try {
      // The message is on disk before the runner exists, so nothing about the
      // door's own timing is in the way of the staging.
      await insertInbound(cluster, it.db, { id: "m-settle-kill", body: MESSAGE });

      // L2's tail is fed first on every spawn, so the held gate catches the
      // priming turn first. That one is released by hand, and the SECOND turn
      // the gate holds is the message's.
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      it.scripted.holdTurnEnd(true);

      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER,
        it.adapterUrl,
        it.adapterName,
      ]);

      await until(
        "the tail of the log was fed first",
        () => it.scripted.fed().length >= 1,
        45_000,
        () => JSON.stringify(it.scripted.fed().map((f) => f.text)),
      );
      expect(it.scripted.fed()[0].text).not.toBe(MESSAGE);
      it.scripted.endTurn();

      await until(
        "the loop was fed the message",
        () => it.scripted.fed().some((f) => f.text === MESSAGE),
        45_000,
        () => JSON.stringify(it.scripted.fed().map((f) => f.text)),
      );
      await until(
        "the row was claimed by this runner",
        async () => (await it.read.inbound())[0].claimed_by === RUNNER,
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );

      // L1 step 5 cannot land while this is held.
      lock = await lockTable(cluster, it.db, "outbox");
      it.scripted.endTurn();

      const blocked = await waitForLockWaiter(cluster, it.db, {
        role: "hub_runner",
        relation: "outbox",
        timeoutMs: 30_000,
      });
      runner.proc.kill(9);
      await runner.proc.exited;

      await lock.release();
      lock = null;
      await waitForBackendsGone(cluster, it.db, [blocked], 30_000);

      // The settle left nothing, and the claim is still standing. The turn
      // query is scoped to this message's own subject, because each spawn's
      // priming turn is a turn record too and it is not what is under test.
      expect(await it.read.outbox()).toEqual([]);
      expect(await it.read.ledger({ stream: "inbound", kind: "answered" })).toEqual(
        [],
      );
      expect(
        (await it.read.ledger({ stream: "turn" })).filter(
          (t) => t.subject === "m-settle-kill",
        ),
      ).toEqual([]);
      const afterKill = await it.read.inbound();
      expect(afterKill.length).toBe(1);
      expect(afterKill[0].claimed_by).toBe(RUNNER);

      // The restart, under the SAME runner id. D-43: a runner treats rows
      // claimed by its own id as its own to redo, because it was not running
      // them, so no lease has to expire and no test-only switch is needed.
      it.scripted.holdTurnEnd(false);
      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER,
        it.adapterUrl,
        it.adapterName,
      ]);
      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });

      await until(
        "the reply was posted after the restart",
        () => it.fake.posts().length >= 1,
        60_000,
        async () =>
          `outbox=${JSON.stringify(await it.read.outbox())} ledger=${JSON.stringify(
            await it.read.ledger({ stream: "inbound" }),
          )}`,
      );
      await Bun.sleep(2000);

      // The four things the settle transaction owns, exactly once each.
      const chunks = await it.read.outbox();
      expect(chunks.length).toBe(1);
      expect(chunks[0].body).toBe(scriptedReply(MESSAGE));
      expect(
        (await it.read.ledger({ stream: "inbound", kind: "answered" })).length,
      ).toBe(1);
      expect(
        (await it.read.ledger({ stream: "turn" })).filter(
          (t) => t.subject === "m-settle-kill",
        ).length,
      ).toBe(1);
      // And the restart spawned a session of its own, so its priming turn is
      // recorded too rather than hidden.
      expect(
        (await it.read.ledger({ stream: "turn" })).filter(
          (t) => t.subject === AGENT,
        ).length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        (await it.read.ledger({ stream: "inbound", kind: "delivered" })).length,
      ).toBe(1);
      expect(it.fake.posts().length).toBe(1);
      expect(it.fake.posts()[0].text).toBe(scriptedReply(MESSAGE));

      // The honest repeat, with its reason above. At least one, because the
      // loop accepted the message before the kill and again on the redo.
      const acked = await it.read.ledger({ stream: "inbound", kind: "acked" });
      expect(acked.length).toBeGreaterThanOrEqual(1);

      // And the claim was cleared by the settle, so the row is nobody's now.
      const settled = await it.read.inbound();
      expect(settled[0].claimed_by).toBeNull();
    } finally {
      if (lock) await lock.release();
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-02 kill the runner between the turn end and the settle, restart, the reply appears exactly once: killed on the answered stamp AFTER the chunks were written, a one-transaction settle still leaves zero chunks and the redo leaves exactly one (SPEC §2, L1)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");
    const { settleTurn } = await seam("src/runner/settle.ts");
    expect(typeof settleTurn).toBe("function");
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");

    const it = await stageHub(cluster, { servers: true });
    let runner: ReadyProcess | null = null;
    let door: { stop(): Promise<void> } | null = null;
    let lock: { pid: number; release(): Promise<void> } | null = null;

    try {
      await insertInbound(cluster, it.db, { id: "m-ledger-kill", body: MESSAGE });
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      it.scripted.holdTurnEnd(true);

      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER,
        it.adapterUrl,
        it.adapterName,
      ]);

      // The priming turn first, released by hand.
      await until(
        "the tail of the log was fed first",
        () => it.scripted.fed().length >= 1,
        45_000,
        () => JSON.stringify(it.scripted.fed().map((f) => f.text)),
      );
      it.scripted.endTurn();

      // The message's turn, up to and including its started stamp. The lock
      // goes on only after that, because an access exclusive lock on
      // ledger_event would otherwise block the acked and started stamps and
      // the kill would land somewhere other than the settle.
      await until(
        "the loop was fed the message",
        () => it.scripted.fed().some((f) => f.text === MESSAGE),
        45_000,
      );
      await until(
        "the message turn reached its first progress",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "started" })).length >=
          1,
        45_000,
        async () => JSON.stringify(await it.read.ledger({ stream: "inbound" })),
      );

      lock = await lockTable(cluster, it.db, "ledger_event");
      it.scripted.endTurn();

      const blocked = await waitForLockWaiter(cluster, it.db, {
        role: "hub_runner",
        relation: "ledger_event",
        timeoutMs: 30_000,
      });
      runner.proc.kill(9);
      await runner.proc.exited;

      await lock.release();
      lock = null;
      await waitForBackendsGone(cluster, it.db, [blocked], 30_000);

      // THE LOAD. The chunks were written before the blocked statement, so a
      // settle split into two transactions has already committed them and
      // fails here. One transaction leaves nothing.
      expect(await it.read.outbox()).toEqual([]);
      expect(await it.read.ledger({ stream: "inbound", kind: "answered" })).toEqual(
        [],
      );
      expect(
        (await it.read.ledger({ stream: "turn" })).filter(
          (t) => t.subject === "m-ledger-kill",
        ),
      ).toEqual([]);
      const afterKill = await it.read.inbound();
      expect(afterKill.length).toBe(1);
      expect(afterKill[0].claimed_by).toBe(RUNNER);

      // The redo, under the same runner id.
      it.scripted.holdTurnEnd(false);
      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER,
        it.adapterUrl,
        it.adapterName,
      ]);
      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });

      await until(
        "the reply was posted after the restart",
        () => it.fake.posts().length >= 1,
        60_000,
        async () =>
          `outbox=${JSON.stringify(await it.read.outbox())} ledger=${JSON.stringify(
            await it.read.ledger({ stream: "inbound" }),
          )}`,
      );
      await Bun.sleep(2000);

      // Exactly one chunk set, so a build that kept the chunk from the first
      // transaction and wrote another on the redo is caught by the count as
      // well as by the zero above.
      const chunks = await it.read.outbox();
      expect(chunks.length).toBe(1);
      expect(chunks[0].inbound_id).toBe("m-ledger-kill");
      expect(chunks[0].seq_in_reply).toBe(1);
      expect(chunks[0].body).toBe(scriptedReply(MESSAGE));
      expect(
        (await it.read.ledger({ stream: "inbound", kind: "answered" })).length,
      ).toBe(1);
      expect(
        (await it.read.ledger({ stream: "turn" })).filter(
          (t) => t.subject === "m-ledger-kill",
        ).length,
      ).toBe(1);
      expect(
        (await it.read.ledger({ stream: "inbound", kind: "delivered" })).length,
      ).toBe(1);
      expect(it.fake.posts().length).toBe(1);
      expect(it.fake.posts()[0].text).toBe(scriptedReply(MESSAGE));
      expect((await it.read.inbound())[0].claimed_by).toBeNull();
    } finally {
      if (lock) await lock.release();
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);
