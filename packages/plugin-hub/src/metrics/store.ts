import { POSTGRES_PEAK_ID, readPeaks } from "../hub/peak.ts";
import { percentileOf } from "./stamps.ts";
import { appendChunks } from "../store/outbox.ts";
import { enqueueInbound } from "../store/inbound.ts";
import { stamp } from "../records/stamps.ts";
import type { StoreLike } from "../store/connect.ts";

/**
 * STORE-06's three numbers, measured again.
 *
 * SPEC §1: "Measured on this Pi: 26 MB idle, about 1.3 ms per durable commit,
 * 0.6 KB of write-ahead log per message. Measure again under real traffic: WAL
 * per day, commit latency across checkpoints, the full peak beside the memory
 * workload of section 6." Those were taken once, by hand, and nothing in the
 * package could take them again.
 *
 * It MEASURES AND PRINTS AND DOES NOTHING ELSE: no sheet, no finding, no
 * setting. The household runs it, reads the numbers, and puts them in the
 * record beside phase 1's.
 */
export interface StoreNumbers {
  wal_bytes_per_message: number;
  commit_ms_p50: number;
  commit_ms_p99: number;
  peak_bytes: number | null;
  /** How the peak was arrived at, or why there is none. */
  how: string;
}

/** Commits sampled either side of the forced checkpoint. */
const SAMPLES_EACH_SIDE = 40;

async function walPosition(store: StoreLike): Promise<string> {
  const [row] = (await store.sql.unsafe(
    "select pg_current_wal_lsn()::text as lsn",
  )) as { lsn: string }[];
  return String(row.lsn);
}

async function walBetween(store: StoreLike, from: string, to: string): Promise<number> {
  const [row] = (await store.sql.unsafe(
    "select pg_wal_lsn_diff($1::pg_lsn, $2::pg_lsn)::bigint as bytes",
    [to, from],
  )) as { bytes: string | number }[];
  return Number(row.bytes);
}

/**
 * Insert and settle one message the way the hub really does, through the
 * shipped store functions rather than through hand-written SQL, so what is
 * measured is what a message costs and not what a probe costs.
 *
 * THESE ARE NOT SYNTHETIC TEST MESSAGES. They reach no door, no platform and no
 * person: MSG-11's forbidden thing is a synthetic message sent to test the
 * pipe, and these are rows written to weigh the store.
 *
 * THEIR KIND IS THEIR OWN (REVIEW S6). Left as `human` they would grow a
 * permanent `store-measure` person and agent in the household's own metrics
 * table, because `readStampMetrics` and `readStampRows` both select on
 * `kind = 'human'`. With a kind of their own they are invisible to every reader
 * that asks about a person's messages, and `sweep` below takes the rows
 * themselves away afterwards.
 */
const MEASURE_KIND = "measure";
const MEASURE_WHO = "store-measure";

async function oneMessage(store: StoreLike, nth: number, run: string): Promise<void> {
  const id = `store-measure:${run}:${nth}`;
  await enqueueInbound(store, {
    id,
    person: MEASURE_WHO,
    agent: MEASURE_WHO,
    kind: MEASURE_KIND,
    body: `a message written to weigh the store, number ${nth}`,
  });
  await stamp(store, { messageId: id, kind: "acked", actor: "runner" });
  await stamp(store, { messageId: id, kind: "started", actor: "runner" });
  await appendChunks(store, id, [`the answer to message ${nth}`]);
  await stamp(store, { messageId: id, kind: "answered", actor: "runner" });
  await stamp(store, { messageId: id, kind: "delivered", actor: "door" });
}

/**
 * Take the rows away again.
 *
 * REVIEW S6. Owner ask 3 runs this on the household's own store after a week of
 * real messages, and a tool that measured a store by permanently enlarging it
 * would be a poor tool. `outbox` first, because it references `inbound`.
 *
 * WHAT IT CANNOT TAKE AWAY is the diary: `ledger_event` is append-only by
 * trigger and by rule, and an entry is never changed and never deleted. Those
 * rows are invisible to every reader that joins `inbound`, which is all of
 * them, once the rows below are gone.
 *
 * Best effort, because the rows are the tool's own and a caller with no delete
 * on them is a caller whose store is simply a little larger afterwards. It is
 * never worth failing a measurement over.
 */
async function sweep(store: StoreLike, run: string): Promise<void> {
  const like = `store-measure:${run}:%`;
  try {
    await store.sql`delete from outbox where inbound_id like ${like}`;
    await store.sql`delete from inbound where id like ${like}`;
  } catch {
    // A caller without delete on the two tables. The rows carry a kind of their
    // own and reach no reader that asks about a person's messages.
  }
}

export async function measureStore(
  store: StoreLike,
  options: { messages: number },
): Promise<StoreNumbers> {
  const run = crypto.randomUUID().slice(0, 8);
  const from = await walPosition(store);

  for (let nth = 0; nth < options.messages; nth++) {
    await oneMessage(store, nth, run);
  }

  // The latency, sampled ACROSS a forced checkpoint rather than beside one,
  // because SPEC §1 asks for "commit latency across checkpoints" by name and a
  // checkpoint is exactly when a commit is slowest.
  const samples: number[] = [];
  const sample = async (nth: number): Promise<void> => {
    const started = performance.now();
    await store.sql`insert into state_row (sheet, id, data)
                    values ('store_measure', ${`${run}:${nth}`}, '{}'::jsonb)
                    on conflict (sheet, id)
                    do update set updated_at = now()`;
    samples.push(performance.now() - started);
  };
  for (let nth = 0; nth < SAMPLES_EACH_SIDE; nth++) await sample(nth);
  await store.sql.unsafe("checkpoint");
  for (let nth = 0; nth < SAMPLES_EACH_SIDE; nth++) {
    await sample(SAMPLES_EACH_SIDE + nth);
  }
  await store.sql`delete from state_row where sheet = 'store_measure'`;
  await sweep(store, run);

  const to = await walPosition(store);
  const written = await walBetween(store, from, to);

  const peaks = await readPeaks(store);
  const postgres = peaks.find((row) => row.id === POSTGRES_PEAK_ID) ?? null;

  const ordered = [...samples].sort((a, b) => a - b);
  return {
    // No messages, no per-message figure. Nothing is divided by zero and
    // nothing is guessed.
    wal_bytes_per_message: options.messages === 0 ? 0 : written / options.messages,
    commit_ms_p50: percentileOf(ordered, 0.5) ?? 0,
    commit_ms_p99: percentileOf(ordered, 0.99) ?? 0,
    peak_bytes: postgres === null ? null : postgres.bytes,
    how:
      postgres === null
        ? "no peak on record: the hub writes one on its tick, and nothing has run against this store yet"
        : `${postgres.how} on ${postgres.machine} at ${postgres.at}`,
  };
}

/** One block, with its units, so the number that goes into the record is copied. */
export function renderStoreNumbers(numbers: StoreNumbers): string {
  const kb = (bytes: number) => (bytes / 1024).toFixed(2);
  const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  return [
    `write-ahead log per message  ${Math.round(numbers.wal_bytes_per_message)} bytes (${kb(numbers.wal_bytes_per_message)} KB)`,
    `durable commit p50           ${numbers.commit_ms_p50.toFixed(3)} ms`,
    `durable commit p99           ${numbers.commit_ms_p99.toFixed(3)} ms`,
    numbers.peak_bytes === null
      ? `store peak                   none on record (${numbers.how})`
      : `store peak                   ${numbers.peak_bytes} bytes (${mb(numbers.peak_bytes)} MB, ${numbers.how})`,
  ].join("\n");
}
