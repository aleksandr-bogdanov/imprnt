// REC-01 and REC-04. A diary is in time order and never changes.
//
// SPEC §7: "Every diary is in time order and no entry was modified after the one
// following it." L17: "Every entry has a time and is added at the end. An entry
// is never changed and never deleted. A mistake is corrected by a new entry that
// says so." And: "Enforced in code... An edit to a diary entry is refused...
// Both attempts are ledger events."

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, freshDatabase, seam, type Cluster } from "./helpers/cluster.ts";

let cluster: Cluster;

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

async function refused(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return String((err as Error).message);
  }
  throw new Error("the database allowed a change to a diary entry");
}

test("REC-01 every diary is in time order and no entry was modified after the one following it: three appended entries read back in order, and neither our function nor raw SQL can change one (SPEC §7, L17)", async () => {
  const { openStore, closeStore } = await seam("src/store/connect.ts");
  const { appendEntry, editEntry, readDiary, DiaryImmutable } = await seam(
    "src/records/diary.ts",
  );
  expect(typeof appendEntry).toBe("function");
  expect(typeof editEntry).toBe("function");
  expect(typeof readDiary).toBe("function");

  const db = await freshDatabase(cluster);
  const store = await (openStore as Function)({ url: cluster.url(db) });

  const seqs: number[] = [];
  for (const kind of ["received", "acked", "started"]) {
    seqs.push(
      (await (appendEntry as Function)(store, {
        stream: "inbound",
        subject: "m-diary",
        kind,
        actor: kind === "received" ? "door" : "runner",
        detail: {},
      })) as number,
    );
    await Bun.sleep(5);
  }

  const before = (await (readDiary as Function)(store, {
    subject: "m-diary",
  })) as { seq: number; at: string; kind: string }[];

  expect(before.length).toBe(3);
  expect(before.map((e) => e.seq)).toEqual(seqs);
  for (let i = 1; i < before.length; i++) {
    expect(before[i].seq).toBeGreaterThan(before[i - 1].seq);
    expect(new Date(before[i].at).getTime()).toBeGreaterThanOrEqual(
      new Date(before[i - 1].at).getTime(),
    );
  }

  // Three attacks on the middle entry, the one with an entry after it.
  const target = before[1].seq;

  let refusal: unknown;
  try {
    await (editEntry as Function)(store, target, { kind: "answered" });
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(DiaryImmutable as Function);

  // The refusal survived the transaction it refused, and it names what was
  // attacked. Found by kind and subject, never by counting rows.
  const refusals = (await (readDiary as Function)(store, {
    stream: "refusal",
  })) as { kind: string; subject: string }[];
  expect(
    refusals.filter(
      (e) => e.kind === "refused.diary_edit" && e.subject === String(target),
    ).length,
  ).toBe(1);

  const owner = cluster.connect(db) as unknown as Conn;
  await refused(() =>
    owner.unsafe(`update ledger_event set kind = 'answered' where seq = ${target}`),
  );
  await refused(() => owner.unsafe(`delete from ledger_event where seq = ${target}`));
  await owner.close();

  // The property itself, not only the refusals: nothing moved.
  const after = (await (readDiary as Function)(store, {
    subject: "m-diary",
  })) as { seq: number; at: string; kind: string }[];
  expect(after.map((e) => [e.seq, e.kind, e.at])).toEqual(
    before.map((e) => [e.seq, e.kind, e.at]),
  );

  await (closeStore as Function)(store);
});
