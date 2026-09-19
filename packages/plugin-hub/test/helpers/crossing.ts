// The burst that crosses two statements on one Bun connection, shared by
// `test/store-crossing.test.ts` and the child it starts without the switch
// (`crossing-child.ts`). The mechanism and what each check proves are in the
// test file's header. This file only builds the shape.

import { SQL } from "bun";
import { seam, until } from "./cluster.ts";

/** How long every connection is held busy while the burst is written. */
export const HOLD_SECONDS = 1.5;

/**
 * How long a statement is given to answer before it counts as never answered.
 *
 * A crossing is a WRONG answer plus a statement that is never answered at all,
 * and a slow answer is neither. On the Linux box a write now and then answers
 * seconds late, with the switch on and with it off alike (measured there: up to
 * about 9 s past the hold in one round of 20 or 30, either way). A 4 s bound
 * read that as a missing answer in both directions: it failed the checks that
 * expect every answer to be right, and it failed the child that must cross,
 * whose wrong answer rides on the late one. So every statement here gets 30 s,
 * and only the one that is really lost waits all of it.
 */
export const ANSWER_WITHIN_MS = 30_000;

export const NO_ANSWER = "no answer";

export type StoreLike = { sql: SQL; url: string };

export type ClaimAnswer = { mine: boolean; data: Record<string, unknown> | undefined };

export type BurstResult = {
  claim: ClaimAnswer | typeof NO_ANSWER;
  appends: (number | typeof NO_ANSWER)[];
};

/** A statement's own result, or NO_ANSWER when it has none inside the bound. */
export function answered<T>(pending: Promise<T>, withinMs = ANSWER_WITHIN_MS): Promise<T | typeof NO_ANSWER> {
  // A statement that lost its answer is rejected later, when its client is
  // closed. That is expected once the bound has run out, so it is not reported
  // as an error between tests. A rejection inside the bound still wins the race.
  pending.catch(() => {});
  return Promise.race([
    pending,
    new Promise<typeof NO_ANSWER>((resolve) => setTimeout(() => resolve(NO_ANSWER), withinMs)),
  ]);
}

/** A client holding a lost statement cannot wait for it to finish, so it is closed at once. */
export async function closeNow(client: SQL): Promise<void> {
  await Promise.race([client.close({ timeout: 0 }).catch(() => {}), Bun.sleep(5_000)]);
}

export async function backendsOf(observer: SQL, application: string): Promise<{ total: number; sleeping: number }> {
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
export async function burst(options: {
  store: StoreLike;
  observer: SQL;
  application: string;
  width: number;
  claimId: string;
}): Promise<BurstResult> {
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
    (claimRow as Function)(store, "outage", options.claimId, { since: sinceOf(options.claimId) }) as Promise<ClaimAnswer>,
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

/** The `since` a burst's claim writes, so its own row is told apart from any other. */
export function sinceOf(claimId: string): string {
  return `2026-09-19T00:00:00Z/${claimId}`;
}

/** One diary append per connection, twice, so the append is prepared on each. */
export async function warmAppend(store: StoreLike, width: number): Promise<void> {
  const { appendEntry } = await seam("src/records/diary.ts");
  for (let round = 0; round < 2; round++) {
    await Promise.all(
      Array.from({ length: width }, () =>
        (appendEntry as Function)(store, { stream: "probe", subject: "warm", kind: "warm", actor: "runner" }),
      ),
    );
  }
}

/**
 * One burst on a fresh one-connection client, so the claim is new to that
 * connection. With `prepared`, the claim runs once on the connection first,
 * which is the control that never crosses whatever the switch says.
 */
export async function burstOnOneConnection(options: {
  storeUrl: string;
  url: string;
  observer: SQL;
  application: string;
  claimId: string;
  prepared?: boolean;
}): Promise<BurstResult> {
  const sql = new SQL(options.storeUrl, { max: 1 });
  const store = { sql, url: options.url };
  try {
    await warmAppend(store, 1);
    if (options.prepared) {
      const { claimRow } = await seam("src/records/statesheet.ts");
      await (claimRow as Function)(store, "outage", `${options.claimId}-warm`, { since: "earlier" });
    }
    return await burst({ store, observer: options.observer, application: options.application, width: 1, claimId: options.claimId });
  } finally {
    await closeNow(sql);
  }
}
