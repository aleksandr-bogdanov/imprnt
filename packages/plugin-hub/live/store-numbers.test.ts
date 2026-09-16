// LIVE. STORE-06: the store's three numbers, measured again by a tool the
// household runs.
//
// SPEC §1: "Measured on this Pi: 26 MB idle, about 1.3 ms per durable commit,
// 0.6 KB of write-ahead log per message. Measure again under real traffic: WAL
// per day, commit latency across checkpoints, the full peak beside the memory
// workload of section 6." Those numbers were taken once, by hand, in phase 1's
// exploration, and nothing in the package could take them again.
//
// IT IS LIVE BECAUSE IT NEEDS REAL TIME AND A REAL CHECKPOINT, not because it
// needs a login. It needs NO model login and NO platform token, so a household
// can run it with no credential at all, and it takes long enough that putting
// it in `bun test` would tax every run of the suite for a number nobody reads
// daily.
//
// ITS INSERTS ARE NOT A SYNTHETIC TEST MESSAGE. They reach no door, no
// platform and no person, and MSG-11's forbidden thing is a synthetic message
// sent to test the pipe. Said here because a reader will ask.
//
// Run it with `bun test --timeout 600000 ./live/store-numbers.test.ts`.
// `bun run test:live` runs the two Claude Code files beside it, and those DO
// need a login.
//
// Red reason: import missing, `src/metrics/store.ts`.

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  freshDatabase,
  seam,
  type Cluster,
} from "../test/helpers/cluster.ts";
import { openStore, closeStore, type Store } from "../src/store/connect.ts";

let cluster: Cluster;

/** Long, because a forced checkpoint on a cold cluster is not instant. */
const SLOW = 300_000;

/** Enough messages that one commit's noise does not carry the figure. */
const MESSAGES = 60;

interface StoreNumbers {
  wal_bytes_per_message: number;
  commit_ms_p50: number;
  commit_ms_p99: number;
  peak_bytes: number | null;
  how: string;
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

test(
  "STORE-06 the store's three numbers can be measured again by a tool the household runs: write-ahead log per message, commit latency across a forced checkpoint, and the peak on record, with zero messages reporting zero as its own control (SPEC §1, D5)",
  async () => {
    const { measureStore, renderStoreNumbers } = await seam("src/metrics/store.ts");
    expect(typeof measureStore).toBe("function");
    expect(typeof renderStoreNumbers).toBe("function");

    const database = await freshDatabase(cluster);
    let store: Store | null = null;
    try {
      store = await openStore({ url: cluster.url(database) });

      // --- THE CONTROL, and it comes FIRST so a broken reader fails before
      //     the real measurement rather than after it. A tool that returns a
      //     constant, or one that reads a counter that never moves, fails this
      //     pair: zero messages is zero write-ahead log per message, and the
      //     run below is above zero.
      const none = (await (measureStore as Function)(store, { messages: 0 })) as StoreNumbers;
      expect(none.wal_bytes_per_message).toBe(0);

      // A CHECKPOINT REALLY HAPPENED, read from the server's own counter either
      // side of the measurement, and a server that publishes NEITHER counter
      // FAILS rather than skipping (the second pass's finding: a skip let the
      // exact no-measurement implementation through). The view was renamed in
      // PostgreSQL 17, so both names are tried and one of them has to answer.
      const checkpoints = async (): Promise<number> => {
        const tried: string[] = [];
        for (const view of ["pg_stat_checkpointer", "pg_stat_bgwriter"]) {
          try {
            const [row] = (await store!.sql.unsafe(
              `select coalesce(num_requested, 0) + coalesce(num_timed, 0) as n from ${view}`,
            )) as { n: number | string }[];
            return Number(row.n);
          } catch (error) {
            tried.push(`${view}: ${(error as Error).message.split("\n")[0]}`);
          }
        }
        throw new Error(
          `this server publishes no checkpoint counter, so nothing here can say a checkpoint happened: ${tried.join("; ")}`,
        );
      };
      const checkpointsBefore = await checkpoints();

      // THE WRITE-AHEAD LOG, MEASURED INDEPENDENTLY either side of the tool's
      // own run, with the server's own `pg_wal_lsn_diff`. The tool's per
      // message figure times the messages it was asked for has to agree with
      // it inside a fifth, so a constant, a total reported as a per-message
      // figure and a counter that never moves all fail.
      const lsn = async (): Promise<string> => {
        const [row] = (await store!.sql.unsafe(
          "select pg_current_wal_lsn()::text as lsn",
        )) as { lsn: string }[];
        return String(row.lsn);
      };
      const walBefore = await lsn();

      const numbers = (await (measureStore as Function)(store, {
        messages: MESSAGES,
      })) as StoreNumbers;

      const walAfter = await lsn();
      const [delta] = (await store.sql.unsafe(
        "select pg_wal_lsn_diff($1::pg_lsn, $2::pg_lsn)::bigint as bytes",
        [walAfter, walBefore],
      )) as { bytes: string | number }[];
      const measuredBytes = Number(delta.bytes);
      expect(measuredBytes).toBeGreaterThan(0);
      const claimed = numbers.wal_bytes_per_message * MESSAGES;
      const agreement = claimed / measuredBytes;
      if (!(agreement > 0.8 && agreement < 1.2)) {
        throw new Error(
          `the tool reports ${numbers.wal_bytes_per_message} write-ahead log bytes per message, which is ${claimed} for ${MESSAGES} messages, and the server's own pg_wal_lsn_diff across the same call is ${measuredBytes}`,
        );
      }

      expect(await checkpoints()).toBeGreaterThan(checkpointsBefore);

      // Every reading is a finite number above zero. The VALUES are for the
      // record beside phase 1's and are not asserted against them: a Mac's
      // disk is not the hub box's, and pinning one box's number would make
      // this check a thing the other box fails.
      expect(Number.isFinite(numbers.wal_bytes_per_message)).toBe(true);
      expect(numbers.wal_bytes_per_message).toBeGreaterThan(0);
      expect(Number.isFinite(numbers.commit_ms_p50)).toBe(true);
      expect(numbers.commit_ms_p50).toBeGreaterThan(0);
      expect(Number.isFinite(numbers.commit_ms_p99)).toBe(true);
      expect(numbers.commit_ms_p99).toBeGreaterThan(0);
      expect(numbers.commit_ms_p99).toBeGreaterThanOrEqual(numbers.commit_ms_p50);
      // AND BOTH ARE A REAL COMMIT'S TIME. Phase 1 measured about 1.3 ms per
      // durable commit on the hub box, and a durable commit on any box the hub
      // runs on is milliseconds: a number above a second is not a commit
      // latency, and a constant of 1 that every reading shares is caught by the
      // write-ahead log agreement above rather than here.
      expect(numbers.commit_ms_p50).toBeLessThan(1000);
      expect(numbers.commit_ms_p99).toBeLessThan(1000);

      // The peak is the hub's to record on its tick, and a fresh throwaway
      // cluster has never had a hub run against it, so a missing row is SAID
      // rather than failed. The number the handoff wants is the one from the
      // box the hub lives on, after a week.
      expect(numbers.peak_bytes === null || numbers.peak_bytes > 0).toBe(true);
      expect(String(numbers.how).length).toBeGreaterThan(0);

      // --- THE WRITE-AHEAD LOG GROWS WITH THE MESSAGES (the second seat's
      //     finding: a tool returning zero for none and one for any number
      //     passed every assertion above). Ten times the messages writes about
      //     ten times the log, so the TOTAL has to grow while the PER MESSAGE
      //     figure stays in the same band. A constant fails the first and a
      //     counter that never moves fails both.
      const tenfold = (await (measureStore as Function)(store, {
        messages: MESSAGES * 10,
      })) as StoreNumbers;
      expect(Number.isFinite(tenfold.wal_bytes_per_message)).toBe(true);
      expect(tenfold.wal_bytes_per_message).toBeGreaterThan(0);
      const ratio = tenfold.wal_bytes_per_message / numbers.wal_bytes_per_message;
      if (!(ratio > 0.25 && ratio < 4)) {
        throw new Error(
          `${MESSAGES} messages reported ${numbers.wal_bytes_per_message} write-ahead log bytes each and ${MESSAGES * 10} reported ${tenfold.wal_bytes_per_message}: a figure that is not per message does not stay in a band across a tenfold change`,
        );
      }
      // And the latency is a real distribution rather than one number twice.
      expect(tenfold.commit_ms_p99).toBeGreaterThanOrEqual(tenfold.commit_ms_p50);

      // --- one table, with its units, so the number that goes into the record
      //     is COPIED and never reconstructed.
      const table = String((renderStoreNumbers as Function)(numbers));
      expect(table.length).toBeGreaterThan(0);
      process.stdout.write(
        `\n[store-numbers] measured on ${process.platform}, ${MESSAGES} messages\n` +
          `${table}\n` +
          `[store-numbers] phase 1's own, from the hub box: 26 MB idle, ` +
          `about 1.3 ms per durable commit, 0.6 KB of write-ahead log per message\n`,
      );
    } finally {
      if (store) await closeStore(store);
    }
  },
  SLOW,
);
