import { COUNCIL_SHEET, mergeBody, openSeatsOf, type CouncilRow } from "../door/council.ts";
import { appendEntry } from "../records/diary.ts";
import { putRow, removeRow } from "../records/statesheet.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * One seat has landed, or died: put its answer into the council's sheet row,
 * and when it was the last one, write the merge row for the dispatching agent.
 *
 * CALLED INSIDE THE SETTLE'S OWN TRANSACTION, on the store that carries it, so
 * the seat's report, its answered stamp, the sheet row and the merge land
 * together or not at all. The advisory lock on the council id is what makes
 * two seats settling on two runners in the same instant take turns on the
 * row: without it both read "one seat open", both write "none", and the merge
 * is written by neither or by both.
 *
 * `answer` is null for a seat that was refused or given up on. It is recorded
 * as null rather than left out, so a dead seat closes the council instead of
 * holding it open for ever, and the merge says "no answer" in its place.
 *
 * A replay meets a row that already carries this seat, or no row at all
 * because the merge already landed, and does nothing either way.
 */
export async function recordSeatAnswer(
  store: StoreLike,
  seat: { council: { id: string; seat: string }; answer: string | null },
): Promise<void> {
  const id = seat.council.id;
  await store.sql`select pg_advisory_xact_lock(hashtext(${id}))`;
  const found = (await store.sql`select data from state_row where sheet = ${COUNCIL_SHEET} and id = ${id}`) as unknown as
    { data: CouncilRow }[];
  if (found.length === 0) return;
  const row = found[0].data;
  if (Object.hasOwn(row.answered ?? {}, seat.council.seat)) return;
  const next: CouncilRow = { ...row, answered: { ...(row.answered ?? {}), [seat.council.seat]: seat.answer } };
  if (openSeatsOf(next).length > 0) {
    await putRow(store, COUNCIL_SHEET, id, next as unknown as Record<string, unknown>);
    return;
  }
  // The last seat. The merge row goes through the function the door owns,
  // because the runner holds no insert on `inbound`, and the sheet row goes
  // with it: a council whose merge has landed is not an open council.
  await store.sql`select hub_council_merge(${id}, ${row.agent}, ${row.person}, ${mergeBody(next)},
    ${{ door: row.door, chat: row.chat }}::jsonb, ${row.at}::timestamptz)`;
  await removeRow(store, COUNCIL_SHEET, id);
  await appendEntry(store, {
    stream: "control", subject: id, kind: "council.merged", actor: "runner",
    detail: {
      agent: row.agent, seats: row.seats,
      answered: row.seats.filter((one) => typeof next.answered[one] === "string"),
      silent: row.seats.filter((one) => typeof next.answered[one] !== "string"),
    },
  });
}
