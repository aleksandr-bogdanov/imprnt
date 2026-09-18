// MSG-10 and D-172. A clock line is written into the chat log once, even when
// the door that wrote it died before its diary line landed.
//
// sayExpired writes the chat log line FIRST and the `clock` diary row second,
// and a restarted door knows what it has already said only from that diary row.
// A door killed between the two leaves the line in the log and no row in the
// diary, so the next door says the clock again. The chat log is the record a
// spawned session is fed from (L2), and D-172 is what keeps a replay out of it:
// every canonical line carries an id and the log skips an id it already holds.
//
// The crash state is built from what the door itself wrote rather than from a
// planted line: a first door says the clock, stops, and its diary row is then
// removed, which is exactly what a kill between the two writes leaves behind.
// The control is a second message whose clock runs out for the first time
// under the restarted door, and whose line must still be written.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { AGENT, DOOR, PERSON, chatLogLines, insertInbound, stageHub } from "./helpers/hub-fixture.ts";
import { runDoor } from "../src/door/run.ts";

let cluster: Cluster;

const SLOW = 120_000;

/** The acked clock's pinned sentence, written out by the TEST. */
const ACKED = /^\[door\] still waiting: the loop has not accepted this message\. (\d+) s so far\.$/;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

test(
  "D-172 a clock line the door wrote before it died is not written into the chat log a second time by the door that replaces it, and a clock line for a different message is still written",
  async () => {
    const it = await stageHub(cluster, {
      hub: { tick_seconds: 30 },
      people: [
        {
          id: PERSON,
          language: "en",
          acked_seconds: 1,
          started_seconds: 600,
          answered_seconds: 600,
          delivered_seconds: 600,
        },
      ],
    });
    const past = new Date(Date.now() - 60_000).toISOString();
    const clockLines = (subject?: string) =>
      chatLogLines(it.stateDir, PERSON, AGENT).filter(
        (line) => line.from === DOOR && ACKED.test(line.text) &&
          (subject === undefined || (line as { id?: string }).id?.includes(subject) || false),
      );
    let door: { stop(): Promise<void> } | null = null;

    try {
      // No runner, so the row stays `received` and its acked clock, measured
      // from a received_at a minute ago, is due the moment a door reads it.
      await insertInbound(cluster, it.db, { id: "clock-replayed", body: "a message nobody claims", receivedAt: past });
      door = await (runDoor as Function)({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform });
      await until(
        "the first door said the acked clock had run out",
        async () => (await it.read.ledger({ stream: "clock", subject: "clock-replayed" })).length === 1 &&
          clockLines().length === 1,
        20_000,
        async () => `log=${JSON.stringify(chatLogLines(it.stateDir, PERSON, AGENT))}`,
      );
      await door!.stop();
      door = null;
      expect(clockLines().length).toBe(1);

      // The crash state: the line is in the chat log and the diary row is not.
      // The diary refuses a delete by trigger, so the fixture steps past it as
      // the superuser, which no role the hub runs as can do.
      const sql = cluster.connect(it.db) as unknown as {
        unsafe(query: string, values?: unknown[]): Promise<unknown>;
        close(): Promise<void>;
      };
      try {
        await sql.unsafe("begin");
        await sql.unsafe("alter table ledger_event disable trigger ledger_event_append_only");
        await sql.unsafe("delete from ledger_event where stream = 'clock' and subject = $1", ["clock-replayed"]);
        await sql.unsafe("alter table ledger_event enable trigger ledger_event_append_only");
        await sql.unsafe("commit");
      } finally {
        await sql.close();
      }
      expect(await it.read.ledger({ stream: "clock" })).toEqual([]);

      // The control: a second message whose acked clock is also already due.
      await insertInbound(cluster, it.db, { id: "clock-fresh", body: "another message nobody claims", receivedAt: past });

      // The replacement door owes both clocks again and says both: the diary
      // row for each is the proof it did, so the chat log is read after both.
      door = await (runDoor as Function)({ door: DOOR, registryFile: it.registryFile, platform: it.fake.platform });
      await until(
        "the replacement door said both clocks",
        async () => (await it.read.ledger({ stream: "clock" })).length === 2,
        20_000,
        async () => JSON.stringify(await it.read.ledger({ stream: "clock" })),
      );

      // TWO lines in all: one for the replayed clock and one for the control.
      // A door that appends without an id writes the replayed one twice.
      const lines = clockLines();
      expect(lines.length, `log=${JSON.stringify(lines)}`).toBe(2);
      // Every clock line is a canonical record and carries its id, and the id
      // is what tells the two messages apart.
      for (const line of lines) {
        expect(typeof (line as { id?: string }).id).toBe("string");
        expect((line as { id?: string }).id).not.toBe("");
      }
      expect(clockLines("clock-replayed").length).toBe(1);
      expect(clockLines("clock-fresh").length).toBe(1);
    } finally {
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);
