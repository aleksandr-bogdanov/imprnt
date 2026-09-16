// RUN-18, MSG-10 and L17, on the three things the store grows in phase 4: the
// row a notice is, the channel that says a turn opened, and the primitive two
// runners race on.
//
// SPEC §6 and L10 rule 3: "Identical failures across agents are one notice per
// person naming the cause, sent once." SPEC §2's Forbidden carries "a second
// writer on a table" and "a message or job stored outside the one database",
// which is what makes a notice an outbox row rather than a table of its own.
// SPEC §1: "The table holds the work. A notification only wakes a runner... No
// polling on a timer." L17: a diary or a state sheet, never both.
//
// EVERY ONE OF THE THREE ASSERTS THE CATALOG FIRST, by name, before it
// exercises anything. Against the shipped schema the objects are simply not
// there, and a check that reached for a reader first would die inside a fixture
// instead: a red reason that is a helper crash is not the red reason the plan
// claims. So each half names the column, the constraint, the trigger or the
// grant it is about, and only then drives it.
//
// Red reasons: schema missing for checks 4 and 5 (`outbox` cannot hold a row
// without a message, and there is no `hub_turn`), and schema missing plus
// export missing for check 6 (the runner holds `select on state_row` only, and
// `claimRow` does not exist).

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  seam,
  statementWatch,
  until,
  type Cluster,
} from "./helpers/cluster.ts";
import {
  AGENT,
  AGENT2,
  PERSON,
  PERSON2,
  insertInbound,
  stageHub,
  superStore,
  type StoreReader,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 90_000;

/** The notice's `since`, fixed by the test so the key is the test's own. */
const SINCE = "2026-09-16T00:00:00.000Z";
const CREDENTIAL = "household-claude";

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

/** Every column of a table, by name, with what the catalog says about it. */
async function columnsOf(
  read: StoreReader,
  table: string,
): Promise<Map<string, { nullable: boolean; type: string; fallback: string | null }>> {
  const rows = await read.sql(
    `select column_name, is_nullable, data_type, column_default
       from information_schema.columns where table_name = $1`,
    [table],
  );
  return new Map(
    rows.map((row) => [
      String(row.column_name),
      {
        nullable: String(row.is_nullable) === "YES",
        type: String(row.data_type),
        fallback: row.column_default === null ? null : String(row.column_default),
      },
    ]),
  );
}

/** Every constraint on a table, by name. */
async function constraintsOf(read: StoreReader, table: string): Promise<string[]> {
  const rows = await read.sql(
    `select conname from pg_constraint where conrelid = $1::regclass order by conname`,
    [table],
  );
  return rows.map((row) => String(row.conname));
}

/** Every trigger on a table, by name, the manager's own record of it. */
async function triggersOf(read: StoreReader, table: string): Promise<string[]> {
  const rows = await read.sql(
    `select tgname from pg_trigger
      where tgrelid = $1::regclass and not tgisinternal order by tgname`,
    [table],
  );
  return rows.map((row) => String(row.tgname));
}

async function backendOf(store: { sql: { unsafe(q: string): Promise<unknown> } }): Promise<number> {
  const rows = (await store.sql.unsafe("select pg_backend_pid() as pid")) as {
    pid: number;
  }[];
  return Number(rows[0].pid);
}

// ---------------------------------------------------------------------------
// Check 4: a notice is a row with no message on it.
// ---------------------------------------------------------------------------

test(
  "RUN-18 a notice is an outbox row with no message on it and two of them with one key are one row: the constraint holds both ways, a sibling runner's second write lands nothing, and the door reads a notice beside a reply (SPEC §6, L10 rule 3, L1 step 6)",
  async () => {
    const it = await stageHub(cluster);
    const opened: { close(): Promise<void> }[] = [];
    try {
      // --- the catalog, by name, before anything is driven.
      const outbox = await columnsOf(it.read, "outbox");
      expect([...outbox.keys()].sort()).toContain("kind");
      expect([...outbox.keys()].sort()).toContain("person");
      expect([...outbox.keys()].sort()).toContain("agent");
      expect([...outbox.keys()].sort()).toContain("notice_key");
      // A reply still defaults to `reply`, which is what keeps every shipped
      // insert (`insert into outbox (inbound_id, seq_in_reply, body)`) legal.
      expect(outbox.get("kind")?.nullable).toBe(false);
      expect(String(outbox.get("kind")?.fallback)).toContain("reply");
      // A notice has no message, so the reference becomes optional.
      expect(outbox.get("inbound_id")?.nullable).toBe(true);
      expect(await constraintsOf(it.read, "outbox")).toContain("outbox_kind_is_whole");

      // THE UNIQUENESS IS THE DATABASE'S (the second pass's finding on row 4).
      // Thirty concurrent pairs raise the odds of an interleaving and cannot
      // force one: a check-then-insert `appendNotice` survives any schedule
      // that happens to serialise each pair, and the race below would then
      // prove nothing. So the INDEX is asserted by name from the catalog, and
      // a build with no database uniqueness fails here whatever the scheduler
      // does that day.
      const unique = (await it.read.sql(
        `select conname, contype from pg_constraint
          where conrelid = 'outbox'::regclass and contype in ('u', 'p')
          union all
         select indexname as conname, 'i' as contype from pg_indexes
          where tablename = 'outbox' and indexdef ilike '%unique%'`,
      )) as Record<string, unknown>[];
      const covering = (await it.read.sql(
        `select i.relname as name, ix.indisunique as unique_index
           from pg_index ix
           join pg_class i on i.oid = ix.indexrelid
           join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = any(ix.indkey)
          where ix.indrelid = 'outbox'::regclass
            and a.attname = 'notice_key'
            and ix.indisunique
            and ix.indnatts = 1`,
      )) as Record<string, unknown>[];
      if (covering.length === 0) {
        throw new Error(
          `outbox has no UNIQUE index on notice_key alone, so nothing but a read stands between two runners and two notices. What it has: ${JSON.stringify(unique)}`,
        );
      }

      const { openStore, closeStore, storeUrlAs } = await seam("src/store/connect.ts");
      const { appendChunks, appendNotice, readPendingChunks } = await seam(
        "src/store/outbox.ts",
      );
      const { stamp } = await seam("src/records/stamps.ts");
      expect(typeof appendNotice).toBe("function");

      const asRunner = (storeUrlAs as Function)(it.storeUrl, "hub_runner") as string;
      const runner = await (openStore as Function)({ url: asRunner });
      opened.push(runner);

      // --- 1. the row. A reply the ordinary way, then a notice.
      await insertInbound(cluster, it.db, { id: "m-notice", body: "a human message" });
      await (appendChunks as Function)(runner, "m-notice", ["the answer"]);
      const landed = await (appendNotice as Function)(runner, {
        person: PERSON,
        agent: AGENT,
        body: "[door] the model login was refused.",
        noticeKey: `outage:${CREDENTIAL}:${SINCE}:${PERSON}`,
      });
      expect(landed).toBe(true);

      const notices = await it.read.noticeRows();
      expect(notices.length).toBe(1);
      expect(notices[0].kind).toBe("notice");
      expect(notices[0].inbound_id).toBeNull();
      expect(notices[0].person).toBe(PERSON);
      expect(notices[0].agent).toBe(AGENT);
      expect(notices[0].notice_key).toBe(`outage:${CREDENTIAL}:${SINCE}:${PERSON}`);

      const replies = (await it.read.sql(
        "select id, kind, inbound_id, notice_key from outbox where kind = 'reply' order by id",
      )) as Record<string, unknown>[];
      expect(replies.length).toBe(1);
      expect(replies[0].inbound_id).toBe("m-notice");
      expect(replies[0].notice_key).toBeNull();

      // --- 2. the constraint, BOTH ways, each by the constraint's own name. A
      //     notice carrying a message and a reply carrying none are the two
      //     halves of one rule, and a build that wrote only one of them leaves
      //     the other hole open.
      const refusals: string[] = [];
      for (const bad of [
        `insert into outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key)
         values ('notice', 'm-notice', 1, 'a notice about a message', '${PERSON}', '${AGENT}', 'k-bad-1')`,
        `insert into outbox (kind, inbound_id, seq_in_reply, body)
         values ('reply', null, 1, 'a reply to nobody')`,
      ]) {
        try {
          await it.read.sql(bad);
          refusals.push("");
        } catch (error) {
          refusals.push(String((error as Error).message));
        }
      }
      for (const said of refusals) expect(said).toContain("outbox_kind_is_whole");

      // --- 3. the arithmetic. The same key never lands twice, however many
      //     runners write it. This is the whole of D-122: v2's own finding was
      //     that one notice per outage is a unique key and not a flag.
      expect(
        await (appendNotice as Function)(runner, {
          person: PERSON,
          agent: AGENT,
          body: "[door] the model login was refused.",
          noticeKey: `outage:${CREDENTIAL}:${SINCE}:${PERSON}`,
        }),
      ).toBe(false);
      expect((await it.read.noticeRows()).length).toBe(1);

      // A SIBLING RUNNER, on its own connection, which is the case v2's
      // UNIQUE(reply_key, seq) was for.
      const sibling = await (openStore as Function)({ url: asRunner });
      opened.push(sibling);
      expect(
        await (appendNotice as Function)(sibling, {
          person: PERSON,
          agent: AGENT,
          body: "[door] the model login was refused.",
          noticeKey: `outage:${CREDENTIAL}:${SINCE}:${PERSON}`,
        }),
      ).toBe(false);
      expect((await it.read.noticeRows()).length).toBe(1);

      // The second person, one credential, one `since`: exactly two notices.
      expect(
        await (appendNotice as Function)(sibling, {
          person: PERSON2,
          agent: AGENT2,
          body: "[door] the model login was refused.",
          noticeKey: `outage:${CREDENTIAL}:${SINCE}:${PERSON2}`,
        }),
      ).toBe(true);
      const both = await it.read.noticeRows();
      expect(both.length).toBe(2);
      expect(both.map((row) => row.person).sort()).toEqual([PERSON, PERSON2]);

      // --- 4. the reader. A notice reaches the door beside a reply, and it
      //     survives the acked/started suppression that a reply does not: that
      //     clause is L1 step 6 about half a reply, and a notice is not half of
      //     anything. This pair is what a left join done wrong fails.
      const before = (await (readPendingChunks as Function)(runner, {
        agent: AGENT,
      })) as { id: number; kind: string; inbound_id: string | null; body: string }[];
      expect(before.map((row) => row.kind)).toEqual(["reply", "notice"]);
      expect(before.map((row) => row.id)).toEqual([...before.map((row) => row.id)].sort((a, b) => a - b));

      await (stamp as Function)(runner, {
        messageId: "m-notice",
        kind: "acked",
        actor: "runner",
      });
      const during = (await (readPendingChunks as Function)(runner, {
        agent: AGENT,
      })) as { kind: string; inbound_id: string | null }[];
      expect(during.map((row) => row.kind)).toEqual(["notice"]);
      expect(during[0].inbound_id).toBeNull();

      // --- 5. the notification. The payload is the PERSON, read off the outbox
      //     row, because there is no inbound row to read it off.
      const { listenForWork } = await seam("src/store/listen.ts");
      const heard: string[] = [];
      const listener = await (listenForWork as Function)({
        // The cluster's own superuser url. A LISTEN needs no table privilege,
        // and the store url the registry carries names NO user by rule (D-36),
        // so a role has to come from somewhere: this is the test's own.
        url: cluster.url(it.db),
        channel: "hub_outbox",
        onNotify: (payload: string) => heard.push(payload),
      });
      try {
        await (appendNotice as Function)(runner, {
          person: PERSON2,
          agent: AGENT2,
          body: "[door] it works again.",
          noticeKey: `outage-over:${CREDENTIAL}:${SINCE}:${PERSON2}`,
        });
        await until("the notice was announced", () => heard.length >= 1, 10_000);
        expect(heard).toContain(PERSON2);
      } finally {
        await listener.close();
      }

      // AND THE SAME KEY FROM TWO CONNECTIONS AT ONCE (the second seat's
      // finding). A check-then-insert `appendNotice` passes every sequential
      // call above and still writes two rows when two runners reach the outage
      // in the same instant, which is the case D-122 says the UNIQUE index is
      // for. Run thirty times, because one race that happens to serialise
      // proves nothing.
      for (let nth = 0; nth < 30; nth++) {
        const key = `outage:${CREDENTIAL}:${SINCE}:race-${nth}`;
        const landed = (await Promise.all([
          (appendNotice as Function)(runner, {
            person: PERSON,
            agent: AGENT,
            body: "[door] the model login was refused.",
            noticeKey: key,
          }),
          (appendNotice as Function)(sibling, {
            person: PERSON,
            agent: AGENT,
            body: "[door] the model login was refused.",
            noticeKey: key,
          }),
        ])) as boolean[];
        expect(landed.filter(Boolean).length).toBe(1);
        const here = (await it.read.sql(
          "select count(*)::int as n from outbox where notice_key = $1",
          [key],
        )) as Record<string, number>[];
        expect(Number(here[0].n)).toBe(1);
      }
      // Thirty keys, thirty rows, however the two writers interleaved.
      const raced = (await it.read.noticeRows()).filter((row) =>
        String(row.notice_key).includes(":race-"),
      );
      expect(raced.length).toBe(30);

      await (closeStore as Function)(runner);
      await (closeStore as Function)(sibling);
      opened.length = 0;
    } finally {
      for (const one of opened) await one.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 5: a turn opening wakes the door, and so does a progress write.
// ---------------------------------------------------------------------------

test(
  "MSG-10 a turn opening wakes the door on one channel and a progress write does too: the three stamps that open and end a turn and the turn_progress sheet wake it, the door's own two stamps and another person's do not, and an idle waiter issues no statement (SPEC §2, L6, SPEC §1)",
  async () => {
    const it = await stageHub(cluster);
    const opened: { close(): Promise<void> }[] = [];
    let waiter: { wait(ms: number): Promise<string>; close(): Promise<void> } | null = null;
    try {
      // --- the catalog. The channel is named by a trigger, so the trigger is
      //     what a check can see: `hub_derive_inbound_state` gains the notify
      //     and `state_row` gains one of its own.
      expect(await triggersOf(it.read, "state_row")).toContain("state_row_notify_turn");

      const { openStore, closeStore, storeUrlAs } = await seam("src/store/connect.ts");
      const { openTurnWaiter, TURN_CHANNEL } = await seam("src/store/wake.ts");
      expect(typeof openTurnWaiter).toBe("function");
      expect(TURN_CHANNEL).toBe("hub_turn");

      const { stamp } = await seam("src/records/stamps.ts");
      const { putRow } = await seam("src/records/statesheet.ts");

      const runner = await (openStore as Function)({
        url: (storeUrlAs as Function)(it.storeUrl, "hub_runner"),
      });
      opened.push(runner);
      const door = await (openStore as Function)({
        url: (storeUrlAs as Function)(it.storeUrl, "hub_door"),
      });
      opened.push(door);
      // The sheet is written here as the SUPERUSER, so this check is about the
      // trigger and not about the runner's grant, which check 6 binds.
      const owner = await superStore(cluster, it.db);
      opened.push(owner);

      await insertInbound(cluster, it.db, { id: "m-turn", body: "a human message" });
      await insertInbound(cluster, it.db, {
        id: "m-other",
        body: "the second person's message",
        person: PERSON2,
        agent: AGENT2,
      });

      waiter = await (openTurnWaiter as Function)(runner, { person: PERSON });

      // --- the four sources, one at a time.
      for (const kind of ["acked", "started", "answered"]) {
        await (stamp as Function)(runner, {
          messageId: "m-turn",
          kind,
          actor: "runner",
        });
        expect(await waiter!.wait(10_000)).toBe("notified");
      }
      const progress = (actions: number) =>
        (putRow as Function)(owner, "turn_progress", "m-turn", {
          person: PERSON,
          agent: AGENT,
          actions,
          last_action: "read",
          started_at: SINCE,
        });
      await progress(3);
      expect(await waiter!.wait(10_000)).toBe("notified");

      // AND AGAIN ON THE EDIT (the second seat's finding). The sheet is one row
      // per message, written over and over while the turn is open, so a
      // trigger that fires on INSERT alone wakes the door once and never
      // again: the person would see "3 tool calls" for the rest of the turn.
      // 04-CONTEXT pins the trigger as after insert OR UPDATE for this reason.
      await progress(4);
      expect(await waiter!.wait(10_000)).toBe("notified");
      await progress(5);
      expect(await waiter!.wait(10_000)).toBe("notified");

      // --- control (a): the door's own two stamps say nothing on this
      //     channel. `received` is the door's own write and `delivered` is the
      //     end, and a channel that fires on all five is a channel that says
      //     nothing.
      await (stamp as Function)(door, {
        messageId: "m-other",
        kind: "received",
        actor: "door",
      });
      await (stamp as Function)(door, {
        messageId: "m-turn",
        kind: "delivered",
        actor: "door",
      });
      expect(await waiter!.wait(1500)).toBe("timeout");

      // --- control (b): a stamp for ANOTHER person's message does not reach
      //     this waiter, so the payload really is the person and the waiter
      //     really filters on it.
      await (stamp as Function)(runner, {
        messageId: "m-other",
        kind: "acked",
        actor: "runner",
      });
      expect(await waiter!.wait(1500)).toBe("timeout");

      // --- control (c): a row on ANOTHER sheet does not wake it. The door
      //     writes `door_cursor` on every message it reads, and a trigger with
      //     no filter would have the door read the table once per message for
      //     nothing.
      await (putRow as Function)(owner, "door_cursor", "some-cursor-id", {
        person: PERSON,
        cursor: "7",
      });
      expect(await waiter!.wait(1500)).toBe("timeout");

      // --- the window guard, asserted here so a later plan does not have to.
      //     The waiter inherits `openWaiter`, and this is the assertion that
      //     says the inheritance is real: asleep, it asks the server nothing.
      const mine = [
        await it.read.pid(),
        await backendOf(runner as never),
        await backendOf(door as never),
        await backendOf(owner as never),
      ];
      const watch = await statementWatch(cluster, mine);
      expect(await waiter!.wait(2000)).toBe("timeout");
      const issued = await watch.count();
      if (issued > 0) {
        throw new Error(
          `the turn waiter issued ${issued} statements while asleep, which is a timer, not a wait. Statements:\n` +
            (await watch.lines()).slice(0, 8).join("\n"),
        );
      }

      await waiter!.close();
      waiter = null;
      for (const one of opened) await (closeStore as Function)(one);
      opened.length = 0;
    } finally {
      if (waiter) await waiter.close().catch(() => {});
      for (const one of opened) await one.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 6: two writers racing for one state sheet row.
// ---------------------------------------------------------------------------

test(
  "L17 two writers racing for one state sheet row make one row and the loser is handed the winner's data, and the runner may write a sheet at all: the race is run concurrently and repeatedly and writes no refusal (SPEC §7, L17, L10 rule 3)",
  async () => {
    const it = await stageHub(cluster);
    const opened: { close(): Promise<void> }[] = [];
    try {
      // --- the grant, by name, before anything is driven. Today the runner
      //     holds `select on state_row` and nothing else, so this is the
      //     schema half and it is red first.
      const grants = (await it.read.sql(
        `select has_table_privilege('hub_runner', 'state_row', 'insert') as i,
                has_table_privilege('hub_runner', 'state_row', 'update') as u,
                has_table_privilege('hub_runner', 'state_row', 'delete') as d,
                has_table_privilege('hub_runner', 'state_row', 'select') as s`,
      )) as Record<string, boolean>[];
      expect(grants[0]).toEqual({ i: true, u: true, d: true, s: true });

      const { openStore, closeStore, storeUrlAs } = await seam("src/store/connect.ts");
      const { claimRow, appendRow, putRow, removeRow, readSheet, StateSheetDuplicate } =
        await seam("src/records/statesheet.ts");
      expect(typeof claimRow).toBe("function");

      const asRunner = (storeUrlAs as Function)(it.storeUrl, "hub_runner") as string;
      const first = await (openStore as Function)({ url: asRunner });
      const second = await (openStore as Function)({ url: asRunner });
      opened.push(first, second);

      // --- 1. the runner really may write one, which is the other half of the
      //     grant above: a privilege the catalog reports and a write that is
      //     refused would be a schema that says one thing and does another.
      await (putRow as Function)(first, "outage", "c-grant", { cause: "login" });
      expect(((await (readSheet as Function)(first, "outage")) as unknown[]).length).toBe(1);
      await (removeRow as Function)(first, "outage", "c-grant");
      expect(((await (readSheet as Function)(first, "outage")) as unknown[]).length).toBe(0);

      const refusalsBefore = Number(
        (
          (await it.read.sql(
            "select count(*)::int as n from ledger_event where stream = 'refusal'",
          )) as Record<string, number>[]
        )[0].n,
      );

      // --- 2. the race, in sequence first, so the LOSER's answer is readable.
      const mine = { since: "2026-09-16T01:00:00.000Z", cause: "login", reported_by: "runner-pi" };
      const theirs = { since: "2026-09-16T02:00:00.000Z", cause: "login", reported_by: "runner-mac" };
      const won = (await (claimRow as Function)(first, "outage", "c1", mine)) as {
        mine: boolean;
        data: Record<string, unknown>;
      };
      const lost = (await (claimRow as Function)(second, "outage", "c1", theirs)) as {
        mine: boolean;
        data: Record<string, unknown>;
      };
      expect(won.mine).toBe(true);
      expect(lost.mine).toBe(false);
      // THE WHOLE OF D-122. The notice key is built from `since`, so a loser
      // that kept its own would write a second notice per person, which is the
      // exact rule RUN-18 exists to enforce.
      expect(lost.data.since).toBe(mine.since);
      expect(lost.data.reported_by).toBe("runner-pi");
      const rows = (await (readSheet as Function)(first, "outage")) as {
        id: string;
        data: Record<string, unknown>;
      }[];
      expect(rows.length).toBe(1);
      expect(rows[0].data.since).toBe(mine.since);

      // --- 3. the race, run for real. Sequential alone cannot fail against a
      //     check-then-act build, which is the defect 3b's two-hubs check found
      //     wearing its other face.
      for (let nth = 0; nth < 30; nth++) {
        const id = `c-race-${nth}`;
        const [a, b] = (await Promise.all([
          (claimRow as Function)(first, "outage", id, { ...mine, nth }),
          (claimRow as Function)(second, "outage", id, { ...theirs, nth }),
        ])) as { mine: boolean; data: Record<string, unknown> }[];
        expect([a.mine, b.mine].filter(Boolean).length).toBe(1);
        // Both are handed the SAME row, whichever of them made it.
        expect(a.data.since).toBe(b.data.since as string);
        const here = (await it.read.sql(
          "select count(*)::int as n from state_row where sheet = 'outage' and id = $1",
          [id],
        )) as Record<string, number>[];
        expect(Number(here[0].n)).toBe(1);
      }

      // --- 4. no refusal is written. `appendRow` writes one on a duplicate
      //     through a connection opened as the CALLER's own role, and from
      //     `hub_runner` that insert is itself refused by
      //     `ledger_event_hub_writes`, so a build that reached for `appendRow`
      //     fails with a permission error rather than with a losing claim. Two
      //     runners racing is an EXPECTED race, and a refusal per race is noise
      //     in the one diary a household reads.
      const refusalsAfter = Number(
        (
          (await it.read.sql(
            "select count(*)::int as n from ledger_event where stream = 'refusal'",
          )) as Record<string, number>[]
        )[0].n,
      );
      expect(refusalsAfter).toBe(refusalsBefore);

      // --- 5. the control. `claimRow` is an ADDITION: `appendRow` still
      //     behaves exactly as it does today. It is driven as the superuser
      //     here because its own refusal path writes as actor `hub`, which is
      //     the thing point 4 is about.
      const owner = await superStore(cluster, it.db);
      opened.push(owner);
      await (appendRow as Function)(owner, "outage", "c-append", { cause: "other" });
      let duplicate: unknown;
      try {
        await (appendRow as Function)(owner, "outage", "c-append", { cause: "other" });
      } catch (error) {
        duplicate = error;
      }
      expect(duplicate).toBeInstanceOf(StateSheetDuplicate as Function);

      for (const one of opened) await (closeStore as Function)(one);
      opened.length = 0;
    } finally {
      for (const one of opened) await one.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);
