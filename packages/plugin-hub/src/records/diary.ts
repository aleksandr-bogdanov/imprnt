import type { StoreLike } from "../store/connect.ts";
import { recordRefusal } from "./refusal.ts";

export class DiaryImmutable extends Error {
  readonly seq: number;

  constructor(seq: number, reason: string) {
    super(
      `ledger_event ${seq} is a diary entry: it is never changed and never deleted. ` +
        `Append a new entry that says so instead. ${reason}`,
    );
    this.name = "DiaryImmutable";
    this.seq = seq;
  }
}

export interface DiaryEntry {
  seq: number;
  at: Date;
  stream: string;
  subject: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
}

export interface NewEntry {
  stream: string;
  subject: string;
  kind: string;
  actor: string;
  detail?: Record<string, unknown>;
}

const COLUMNS = ["stream", "subject", "kind", "actor", "detail", "at"];

export async function appendEntry(store: StoreLike, entry: NewEntry): Promise<number> {
  const rows = (await store.sql`
    insert into ledger_event (stream, subject, kind, actor, detail)
    values (${entry.stream}, ${entry.subject}, ${entry.kind}, ${entry.actor},
            ${entry.detail ?? {}})
    returning seq`) as { seq: string }[];
  return Number(rows[0].seq);
}

export async function readDiary(
  store: StoreLike,
  filter: { stream?: string; subject?: string } = {},
): Promise<DiaryEntry[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of [
    ["stream", filter.stream],
    ["subject", filter.subject],
  ] as [string, string | undefined][]) {
    if (value === undefined) continue;
    values.push(value);
    where.push(`${column} = $${values.length}`);
  }
  const rows = (await store.sql.unsafe(
    `select seq, at, stream, subject, kind, actor, detail from ledger_event
     ${where.length ? `where ${where.join(" and ")}` : ""}
     order by seq`,
    values,
  )) as Record<string, unknown>[];
  return rows.map((row) => ({ ...row, seq: Number(row.seq) })) as DiaryEntry[];
}

/** Always refuses, and the attempt is itself an entry. */
export async function editEntry(
  store: StoreLike,
  seq: number,
  patch: Record<string, unknown>,
): Promise<never> {
  const columns = Object.keys(patch).filter((key) => COLUMNS.includes(key));
  let reason = "The entry was not touched.";
  if (columns.length > 0) {
    const set = columns.map((column, i) => `${column} = $${i + 2}`).join(", ");
    try {
      await store.sql.unsafe(
        `update ledger_event set ${set} where seq = $1`,
        [seq, ...columns.map((column) => patch[column])],
      );
      reason = "The database allowed the update, which is a broken guard.";
    } catch (error) {
      reason = String((error as Error).message);
    }
  }
  await recordRefusal(store, "refused.diary_edit", String(seq), {
    attempted: columns,
    reason,
  });
  throw new DiaryImmutable(seq, reason);
}
