// The result crossing, reproduced, and the pool floor it sets.
//
// Phase 4 (BUILD-NOTES 7) found an outage claim reading back a row that was not
// its own, and the store went from one connection to eight on that finding with
// no reproducer. Two sessions then failed to cross two statements by hand, and
// phase 6 (BUILD-NOTES 128 and 130) met it again at four connections as a diary
// append that came back with no `seq`. This file is the reproducer, and the
// check that holds the floor the reproducer justifies.
//
// THE MECHANISM, read from Bun 1.3.14's Postgres client and then measured here.
// The client keeps one queue per connection and hands every answer to the
// oldest statement in that queue. A statement the connection has never prepared
// stays queued until nothing else is in flight. A statement the connection has
// already prepared is written at once, whatever is queued ahead of it. So on a
// busy connection the prepared statement overtakes the new one, the server
// answers in the order the statements were written, and the new statement is
// handed the other one's answer while the other one is never answered at all.
// The new statement itself is then dropped without ever reaching the server, so
// its caller believes a write that never happened, and the write that did
// happen has nobody waiting for it. Hand probes never crossed because nothing
// was in flight when their two statements were written.
//
// THREE THINGS, all on one connection: a statement in flight, a statement new to
// that connection, and a prepared statement written before the first finishes.
// The first check builds exactly that on a one-connection client, with the real
// claim and the real diary append on the real schema, beside a control where the
// claim was prepared beforehand and nothing crosses.
//
// WHAT THE POOL DOES about it. The pool only puts a second statement on a busy
// connection once every connection is busy, so a wider pool crosses at a higher
// load and crosses all the same (measured at four and at eight). What the width
// decides is what happens next. With one connection every later statement of the
// process queues behind the lost one and never answers. With more than one, the
// pool routes around the wedged connection and the store keeps answering. The
// second check holds that through the store's own `openStore`, so it fails the
// day the pool is set to one.
//
// WHAT DOES NOT HELP, measured on the way here. `prepare: false` stops the
// pipelining and then sends a jsonb parameter as the text "[object Object]", so
// every diary append fails. The client's own switch,
// BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1, does remove the crossing, but
// only from the environment a process is started with. Set from inside the
// process it changes nothing.
//
// WHEN TO RUN IT AGAIN. The first check describes this Bun. `test/bun-version.test.ts`
// pins it, and the commit that moves that pin is where this file says whether
// the crossing is still there. If the first check fails on a new Bun, the client
// no longer crosses and the pool can be sized on memory alone.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { startCluster, freshDatabase, seam, until, type Cluster } from "./helpers/cluster.ts";

let cluster: Cluster;

const SLOW = 90_000;

/** How long every connection is held busy while the burst is written. */
const HOLD_SECONDS = 1.5;

/** Longer than the hold, so a statement that is merely slow still answers. */
const ANSWER_WITHIN_MS = 4_000;

const NO_ANSWER = "no answer";

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

type Client = SQL;
type StoreLike = { sql: Client; url: string };

/** A statement's own result, or NO_ANSWER when it has none inside the bound. */
function answered<T>(pending: Promise<T>, withinMs = ANSWER_WITHIN_MS): Promise<T | typeof NO_ANSWER> {
  return Promise.race([
    pending,
    new Promise<typeof NO_ANSWER>((resolve) => setTimeout(() => resolve(NO_ANSWER), withinMs)),
  ]);
}

/** A client holding a lost statement cannot wait for it to finish, so it is closed at once. */
async function closeNow(client: Client): Promise<void> {
  await Promise.race([client.close({ timeout: 0 }).catch(() => {}), Bun.sleep(5_000)]);
}

async function backendsOf(observer: Client, application: string): Promise<{ total: number; sleeping: number }> {
  const [row] = (await observer`
    select count(*)::int as total,
           count(*) filter (where wait_event = 'PgSleep')::int as sleeping
      from pg_stat_activity
     where application_name = ${application}`) as { total: number; sleeping: number }[];
  return row;
}

/**
 * The shape that crosses. Every connection is held by a sleep, the observer
 * sees all of them asleep, and only then are the claim and one diary append
 * per connection written. It fails loudly when the connections were never all
 * busy, so a run that could not have crossed never reads as a pass.
 */
async function burst(options: {
  store: StoreLike;
  observer: Client;
  application: string;
  width: number;
  claimId: string;
}) {
  const { claimRow } = await seam("src/records/statesheet.ts");
  const { appendEntry } = await seam("src/records/diary.ts");
  const { store, observer, application, width } = options;

  const holds = Array.from({ length: width }, () =>
    answered(store.sql`select pg_sleep(${HOLD_SECONDS}::float8)::text as held`, HOLD_SECONDS * 1000 + ANSWER_WITHIN_MS),
  );
  await until(
    `all ${width} connections of ${application} asleep at once`,
    async () => (await backendsOf(observer, application)).sleeping === width,
    5_000,
    async () => `The server saw ${JSON.stringify(await backendsOf(observer, application))}, so the burst could not have met a busy pool.`,
  );

  const claim = answered(
    (claimRow as Function)(store, "outage", options.claimId, { since: "2026-09-19T00:00:00Z" }) as Promise<{
      mine: boolean;
      data: Record<string, unknown> | undefined;
    }>,
  );
  const appends = Array.from({ length: width }, (_, i) =>
    answered(
      (appendEntry as Function)(store, { stream: "probe", subject: `${options.claimId}-agent-${i}`, kind: "diary", actor: "runner" }) as Promise<number>,
    ),
  );
  const result = { claim: await claim, appends: await Promise.all(appends) };
  await Promise.all(holds);
  return result;
}

/** One diary append per connection, twice, so the append is prepared on each. */
async function warmAppend(store: StoreLike, width: number) {
  const { appendEntry } = await seam("src/records/diary.ts");
  for (let round = 0; round < 2; round++) {
    await Promise.all(
      Array.from({ length: width }, () =>
        (appendEntry as Function)(store, { stream: "probe", subject: "warm", kind: "warm", actor: "runner" }),
      ),
    );
  }
}

test(
  "the crossing, reproduced: on one Bun connection a claim new to that connection, written while a statement is in flight, is handed a row with no columns and the diary append written after it is never answered, and the same burst with the claim prepared beforehand answers both correctly",
  async () => {
    const { storeUrlAs } = await seam("src/store/connect.ts");
    const db = await freshDatabase(cluster);
    const observer = cluster.connect(db);

    // The control first. The claim ran once on this connection, so the burst
    // writes three prepared statements in order and each gets its own answer.
    {
      const application = "crossing-control";
      const sql = new SQL((storeUrlAs as Function)(cluster.url(db), cluster.superuser, application), { max: 1 });
      const store = { sql, url: cluster.url(db) };
      try {
        const { claimRow } = await seam("src/records/statesheet.ts");
        await warmAppend(store, 1);
        await (claimRow as Function)(store, "outage", "control-warm", { since: "earlier" });
        const got = await burst({ store, observer, application, width: 1, claimId: "control" });
        expect(got.claim, "the control's claim").not.toBe(NO_ANSWER);
        expect((got.claim as { data: unknown }).data, "the control's claim reads back its own row").toEqual({
          since: "2026-09-19T00:00:00Z",
        });
        expect(typeof got.appends[0], "the control's diary append answers with its seq").toBe("number");
      } finally {
        await closeNow(sql);
      }
    }

    // The crossing. Identical, except the claim is new to this connection.
    {
      const application = "crossing-one";
      const sql = new SQL((storeUrlAs as Function)(cluster.url(db), cluster.superuser, application), { max: 1 });
      const store = { sql, url: cluster.url(db) };
      try {
        await warmAppend(store, 1);
        const got = await burst({ store, observer, application, width: 1, claimId: "crossed" });
        const described =
          `claim answered ${JSON.stringify(got.claim)}, append answered ${JSON.stringify(got.appends)}. ` +
          `If both are right, this Bun no longer crosses and connect.ts's pool can be sized on memory alone.`;
        expect(got.claim, described).not.toBe(NO_ANSWER);
        // BUILD-NOTES 7's symptom: `claimed.data.since` read as undefined. The
        // claim is told it won, with the append's answer read against its own
        // columns, which it has none of yet.
        expect((got.claim as { mine: boolean; data: unknown }).mine, described).toBe(true);
        expect((got.claim as { data: unknown }).data, described).toBeUndefined();
        expect(got.appends[0], described).toBe(NO_ANSWER);
        // And the server agrees about who really ran. The claim was never
        // written to it at all, and the append's row is on disk although its
        // caller never heard back.
        const claimed = (await observer`select data from state_row where sheet = 'outage' and id = 'crossed'`) as unknown[];
        expect(claimed, "the claim that was told it won never reached the server").toEqual([]);
        const appended = (await observer`select count(*)::int as n from ledger_event where subject = 'crossed-agent-0' and kind = 'diary'`) as {
          n: number;
        }[];
        expect(appended[0].n, "the append nobody answered is on disk").toBe(1);
      } finally {
        await closeNow(sql);
      }
    }
  },
  SLOW,
);

test(
  "a store keeps answering after a crossing: through openStore's own pool, every connection held busy, a burst of a new claim and one diary append per connection, and then every later claim and append answers with its own row, which a pool of one cannot do",
  async () => {
    const { openStore, storeUrlAs } = await seam("src/store/connect.ts");
    const { claimRow } = await seam("src/records/statesheet.ts");
    const { appendEntry } = await seam("src/records/diary.ts");
    const db = await freshDatabase(cluster);
    const observer = cluster.connect(db);
    const application = "crossing-store";

    const store = (await (openStore as Function)({
      url: (storeUrlAs as Function)(cluster.url(db), cluster.superuser, application),
    })) as StoreLike;
    try {
      // The pool's width as the server sees it, once it has stopped growing.
      let width = 0;
      let steady = 0;
      await until(
        "the store's connections to settle",
        async () => {
          const now = (await backendsOf(observer, application)).total;
          steady = now > 0 && now === width ? steady + 1 : 0;
          width = now;
          return steady >= 3;
        },
        5_000,
      );

      await warmAppend(store, width);
      const got = await burst({ store, observer, application, width, claimId: "burst" });

      // Whether the burst itself crossed depends on which connection the new
      // claim met. What must hold either way is that the store still answers.
      const later: unknown[] = [];
      for (let round = 0; round < 3; round++) {
        const claim = await answered(
          (claimRow as Function)(store, "outage", `after-${round}`, { since: `round-${round}` }) as Promise<{
            data: unknown;
          }>,
        );
        later.push(claim === NO_ANSWER ? NO_ANSWER : claim.data);
        later.push(
          await answered(
            (appendEntry as Function)(store, { stream: "probe", subject: "after", kind: "diary", actor: "runner" }) as Promise<number>,
          ),
        );
      }
      const described =
        `With ${width} connection(s), the burst answered ${JSON.stringify(got)} and the statements after it ` +
        `answered ${JSON.stringify(later)}. A store whose only connection is wedged answers nothing after a crossing.`;
      for (let round = 0; round < 3; round++) {
        expect(later[round * 2], described).toEqual({ since: `round-${round}` });
        expect(typeof later[round * 2 + 1], described).toBe("number");
      }
    } finally {
      await closeNow(store.sql);
    }
  },
  SLOW,
);
