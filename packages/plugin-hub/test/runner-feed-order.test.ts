// Feed order, and the fence that keeps rank from drifting from kind.
//
// SPEC §2: "Feed order: rank 0 is anything a human is waiting on (a human's
// message, a report on a job that answers a human's message), rank 1 is
// proactive work (watcher triage, rooms, harvest). Oldest first within a rank."
// Its Forbidden list carries "a report on a human's message fed after a later
// human message". Its Check line: "A report on a human's message is fed before
// any human message that arrived after it."
//
// TWO DIFFERENT KINDS OF RULE, and the second check's name says which is which.
// The ORDERING is SPEC §2's own feed order line. The column being unwritable is
// NOT in the spec: a GENERATED ALWAYS column is inferred so the rank and the
// kind cannot drift apart, with a plain column plus a trigger as the allowed
// fallback. So the check states the rule it rests on rather than
// claiming a spec line for it, and its refusal matcher accepts either shape.
// Nothing else writes a report row yet, so the check inserts one as the
// superuser.
//
// Red reasons: schema missing, inbound.kind and inbound.rank. Import missing,
// src/runner/run.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
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
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** A moment `seconds` before now, as an ISO string the insert can carry. */
function ago(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

test(
  "MSG-05 a report on a human's message is fed before any human message that arrived after it, and proactive work waits behind both: only rank then received_at then id gives the order the loop was fed (SPEC §2, L1)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");
    const { TAIL_PREAMBLE } = await seam("src/chatlog.ts");
    expect(typeof TAIL_PREAMBLE).toBe("string");

    const it = await stageHub(cluster);
    let runner: { stop(): Promise<void> } | null = null;

    try {
      // L2's tail is fed first on every spawn, so the order asserted below is
      // the order AFTER it, and the tail's own place is asserted too.
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });

      // Four rows land while the runner is down. The fixture separates rank
      // from time, from insertion order and from id order on purpose:
      //
      //   rank then time then id   H1, R, H2, T   <- the rule
      //   time alone               T, H1, R, H2
      //   insertion order alone    T, H2, R, H1
      //   id order alone           H1, H2, R, T   (a-, b-, c-, d- below)
      //
      // so a build ordering by any one of the other three lands somewhere else.
      await insertInbound(cluster, it.db, {
        id: "d-triage",
        body: "a watcher wants a verdict",
        kind: "triage",
        receivedAt: ago(400),
        as: "superuser",
      });
      await insertInbound(cluster, it.db, {
        id: "b-human-late",
        body: "the second thing the person said",
        kind: "human",
        receivedAt: ago(100),
      });
      await insertInbound(cluster, it.db, {
        id: "c-report",
        body: "the job that answers the first thing finished",
        kind: "report",
        receivedAt: ago(200),
        as: "superuser",
      });
      await insertInbound(cluster, it.db, {
        id: "a-human-early",
        body: "the first thing the person said",
        kind: "human",
        receivedAt: ago(300),
      });

      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      await until(
        "all four rows were answered",
        async () => (await it.read.outbox()).length >= 4,
        60_000,
        async () =>
          `fed=${JSON.stringify(it.scripted.fed().map((f) => f.text))} outbox=${
            (await it.read.outbox()).length
          }`,
      );
      await Bun.sleep(1500);

      const fed = it.scripted.fed();
      expect(fed[0].text.startsWith(TAIL_PREAMBLE as string)).toBe(true);
      expect(fed.slice(1).map((f) => f.text)).toEqual([
        "the first thing the person said",
        "the job that answers the first thing finished",
        "the second thing the person said",
        "a watcher wants a verdict",
      ]);

      // And nothing was reordered by being dropped.
      const chunks = await it.read.outbox();
      expect(chunks.length).toBe(4);
      expect(new Set(chunks.map((c) => c.inbound_id)).size).toBe(4);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-05 rank cannot disagree with kind and proactive work never overtakes a human: a rank 0 row that arrived later still goes first (SPEC §2 feed order, L1), and the rank a writer could set by hand is refused (02-CONTEXT D-41, an inferred seam rule rather than a spec line)",
  async () => {
    // The tagged red reason is schema missing, so the schema is probed before
    // any seam import and nothing else can fire first.
    const it = await stageHub(cluster);

    try {
      // A row with no kind named, which is every early insert. The default
      // keeps it valid and the generated rank follows from it, so the first
      // read below is the one that names the absent column.
      await insertInbound(cluster, it.db, {
        id: "m-plain",
        body: "the person said something",
      });
      const plain = await it.read.sql(
        "select rank from inbound where id = 'm-plain'",
      );
      expect(plain.length).toBe(1);
      expect(Number(plain[0].rank)).toBe(0);
      const plainKind = await it.read.sql(
        "select kind from inbound where id = 'm-plain'",
      );
      expect(plainKind[0].kind).toBe("human");

      await insertInbound(cluster, it.db, {
        id: "m-rank",
        body: "a watcher wants a verdict",
        kind: "triage",
        as: "superuser",
      });

      // The generated column carries the rank the kind implies.
      const before = await it.read.sql(
        "select kind, rank from inbound where id = 'm-rank'",
      );
      expect(before.length).toBe(1);
      expect(before[0].kind).toBe("triage");
      expect(Number(before[0].rank)).toBe(1);

      // Refused by POSTGRES, not by our code, because the column is generated.
      let refusal = "";
      try {
        await it.read.sql("update inbound set rank = 0 where id = 'm-rank'");
      } catch (err) {
        refusal = String((err as Error).message);
      }
      expect(refusal).not.toBe("");
      expect(refusal).toMatch(/can only be updated to DEFAULT|generated/i);

      // Two facts that cannot disagree, because there is only one. Changing the
      // kind moves the rank with no second write.
      await it.read.sql("update inbound set kind = 'human' where id = 'm-rank'");
      const after = await it.read.sql(
        "select kind, rank from inbound where id = 'm-rank'",
      );
      expect(after[0].kind).toBe("human");
      expect(Number(after[0].rank)).toBe(0);

      // The half that catches an implementation which orders by time and passed
      // the fixture above through luck: a rank 0 row that arrived LATER than a
      // waiting rank 1 row still goes first.
      const { runRunner } = await seam("src/runner/run.ts");
      expect(typeof runRunner).toBe("function");

      // Its own handle, stopped by this half's own finally, so this half can
      // never leave a runner behind.
      const second = await stageHub(cluster);
      let laterRunner: { stop(): Promise<void> } | null = null;
      try {
        plantChatLine({
          stateDir: second.stateDir,
          text: "what was said yesterday",
        });
        // THE RANK 1 KIND HERE IS `room` AND WAS `harvest`.
        // SPEC §2's rank 1 is "watcher triage, rooms, harvest", so any of the
        // three is the proactive row this half needs, and what it needs of it
        // is that the runner feeds it to the agent's own session AFTER the
        // human row. `harvest` has a meaning of its own: a row of
        // that kind is served by a session of the harvester's, is fed a slice
        // rather than its own body, and reaches no chat at all. Nothing
        // about the ORDER this half asserts turns on that, and `room` is the
        // rank 1 kind nothing has claimed.
        await insertInbound(cluster, second.db, {
          id: "m-room",
          body: "yesterday is worth filing",
          kind: "room",
          receivedAt: ago(5),
          as: "superuser",
        });
        await insertInbound(cluster, second.db, {
          id: "m-human",
          body: "the person said something just now",
          kind: "human",
          receivedAt: ago(0),
        });

        laterRunner = await (runRunner as Function)({
          runner: RUNNER,
          registryFile: second.registryFile,
          adapters: { [second.adapterName]: second.scripted.adapter },
        });
        await until(
          "both rows were answered",
          async () => (await second.read.outbox()).length >= 2,
          60_000,
        );
        // Index 0 is the spawn's tail, so the human row is the first HUMAN
        // thing fed and the harvest row waits behind it.
        const order = second.scripted.fed().slice(1).map((f) => f.text);
        expect(order[0]).toBe("the person said something just now");
        expect(order[1]).toBe("yesterday is worth filing");
      } finally {
        if (laterRunner) await laterRunner.stop();
        await second.stop();
      }

      // The fixtures are a public repository's fixtures.
      expect(PERSON).toBe("p1");
      expect(AGENT).toBe("p1-lair");
    } finally {
      await it.stop();
    }
  },
  SLOW,
);
