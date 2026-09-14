// REC-02 and REC-04. A state sheet holds one row per id.
//
// SPEC §7: "every state sheet has exactly one row per id." L17: "One row per
// thing, keyed by the thing's id. A change is an edit to that row. A second row
// for the same id is forbidden. A thing that no longer exists has its row
// removed. A finding that was fixed disappears. Nothing says 'fixed' underneath
// it." And: "An append to a state sheet with an id that already exists is
// refused... Both attempts are ledger events."
//
// The sheet used here is the output of `check`, which L17 names as a state sheet
// with one line per current finding.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, freshDatabase, seam, type Cluster } from "./helpers/cluster.ts";

let cluster: Cluster;

const SHEET = "check";

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

type Conn = {
  unsafe(query: string): Promise<unknown>;
  close(): Promise<void>;
};

test("REC-02 every state sheet has exactly one row per id: an append on an existing id is refused, an edit replaces the row, and a removed thing leaves no line behind (SPEC §7, L17)", async () => {
  const { openStore, closeStore } = await seam("src/store/connect.ts");
  const { appendRow, putRow, removeRow, readSheet, StateSheetDuplicate } =
    await seam("src/records/statesheet.ts");
  expect(typeof appendRow).toBe("function");
  expect(typeof putRow).toBe("function");
  expect(typeof removeRow).toBe("function");
  expect(typeof readSheet).toBe("function");

  const db = await freshDatabase(cluster);
  const store = await (openStore as Function)({ url: cluster.url(db) });

  await (appendRow as Function)(store, SHEET, "vault-sync-stale", {
    text: "the vault sync has not landed for 35 hours",
  });
  expect(((await (readSheet as Function)(store, SHEET)) as unknown[]).length).toBe(1);

  let refusal: unknown;
  try {
    await (appendRow as Function)(store, SHEET, "vault-sync-stale", {
      text: "a second line for the same finding",
    });
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(StateSheetDuplicate as Function);
  expect(((await (readSheet as Function)(store, SHEET)) as unknown[]).length).toBe(1);

  // A change is an edit to that row.
  await (putRow as Function)(store, SHEET, "vault-sync-stale", {
    text: "the vault sync has not landed for 36 hours",
  });
  const edited = (await (readSheet as Function)(store, SHEET)) as {
    id: string;
    data: { text: string };
  }[];
  expect(edited.length).toBe(1);
  expect(edited[0].id).toBe("vault-sync-stale");
  expect(edited[0].data.text).toBe("the vault sync has not landed for 36 hours");

  // A finding that was fixed disappears. Nothing says "fixed" underneath it.
  await (removeRow as Function)(store, SHEET, "vault-sync-stale");
  expect(((await (readSheet as Function)(store, SHEET)) as unknown[]).length).toBe(0);

  await (closeStore as Function)(store);
});

test("REC-02 a second row for the same id is refused by the database, not only by our function (SPEC §7, L17)", async () => {
  const db = await freshDatabase(cluster);
  const owner = cluster.connect(db) as unknown as Conn;

  await owner.unsafe(
    `insert into state_row (sheet, id, data)
     values ('${SHEET}', 'dup-by-hand', '{"text":"first"}'::jsonb)`,
  );

  let message = "";
  try {
    await owner.unsafe(
      `insert into state_row (sheet, id, data)
       values ('${SHEET}', 'dup-by-hand', '{"text":"second"}'::jsonb)`,
    );
  } catch (err) {
    message = String((err as Error).message);
  }
  expect(message.length).toBeGreaterThan(0);

  const rows = (await owner.unsafe(
    `select id from state_row where sheet = '${SHEET}' and id = 'dup-by-hand'`,
  )) as unknown[];
  expect(rows.length).toBe(1);

  await owner.close();
});

test("REC-04 appending an existing id to a state sheet is refused and the attempt is a ledger event (SPEC §7, L17)", async () => {
  const { openStore, closeStore } = await seam("src/store/connect.ts");
  const { appendRow, StateSheetDuplicate } = await seam("src/records/statesheet.ts");
  const { readDiary } = await seam("src/records/diary.ts");
  expect(typeof appendRow).toBe("function");

  const db = await freshDatabase(cluster);
  const store = await (openStore as Function)({ url: cluster.url(db) });

  await (appendRow as Function)(store, SHEET, "runner-silent", { text: "quiet" });

  let refusal: unknown;
  try {
    await (appendRow as Function)(store, SHEET, "runner-silent", { text: "again" });
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(StateSheetDuplicate as Function);

  const refusals = (await (readDiary as Function)(store, {
    stream: "refusal",
  })) as { kind: string; subject: string }[];
  const match = refusals.filter(
    (e) =>
      e.kind === "refused.state_sheet_duplicate" &&
      e.subject === `${SHEET}/runner-silent`,
  );
  expect(match.length).toBe(1);

  await (closeStore as Function)(store);
});
