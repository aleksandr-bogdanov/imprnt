import { createHash } from "node:crypto";
import type { StoreLike } from "../store/connect.ts";
import { attentionDebtOf, noteAttention, type AttentionDebt, type TopicRow } from "../store/topics.ts";
import type { Need } from "./lines.ts";

/**
 * WHAT A COUNCIL NEEDED TO SAY AND NO PLACE COULD TAKE is kept where the topics keep theirs: on the topic of the council's own
 * chat, in its `attention` map (`hub_topic_attention`), and paid by the topic catch-up (`hub_topic_attention_catchup`), which names
 * the occurrences it stands for, queues ONE keyed notice and clears exactly those in one transaction. Nothing here is a second
 * store or a second way of telling: a council has no column for it, and the topic row already is the place the person's missed
 * attention for a chat lives.
 *
 * A gap's kind says which need and which council, and tells one need's gap from another's, because the map is keyed by kind and
 * the notices of a council are keyed by what they are about (a participant set, a checkpoint, an attempt): both are digests, so
 * the kind carries no `.` or `,`, which a catch-up's own key is made with.
 */
const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

export const councilGapKind = (need: Need, council: string, key: string): string => `council-${need}-${digest(council)}-${digest(key)}`;

const KIND = /^council-([a-z_]+)-([0-9a-f]{12})-[0-9a-f]{12}$/;

/** The need and the council's digest a gap of a council was kept for, or null for a gap that is a topic's own. */
export function councilGapOf(kind: string): { need: string; council: string } | null {
  const found = KIND.exec(kind);
  return found === null ? null : { need: found[1], council: found[2] };
}

/**
 * Whether this need is already said or paid for. Said: a notice of it was queued under any of its own keys (its chat's, General's,
 * the routing issue's), at any time, so a chat that has since been archived is not told again of what it was told. Paid: a catch-up
 * was queued for exactly this gap. Neither is ever undone, so a need that stands for as long as the council does is told once.
 */
export async function told(store: StoreLike, topic: string, key: string, kind: string): Promise<boolean> {
  const [row] = await store.sql`select exists (select 1 from outbox
      where notice_key in (${key}, ${`${key}:general`}, ${`${key}:routing`})
         or (starts_with(notice_key, ${`topic:attention-catchup:${topic}:`}) and position(${`${kind}.`} in notice_key) > 0)) as said`;
  return row.said === true;
}

/**
 * What a topic is owed, with the gaps of councils that are gone left out and cleared: a council that was erased (its topic's deletion
 * does it, with the topic) or whose topic is being deleted is not told about, and nothing of it is kept. A council is looked for by
 * the chat it answers in, which is also how its gap found this topic.
 */
export async function debtOf(store: StoreLike, topic: TopicRow): Promise<AttentionDebt[]> {
  const debt = attentionDebtOf(topic);
  if (!debt.some(one => councilGapOf(one.kind) !== null)) return debt;
  const standing = new Set<string>();
  if (topic.lifecycle !== "deleting" && topic.chat !== null) {
    const rows = (await store.sql`select id from council where return_route ->> 'door' = ${topic.door} and return_route ->> 'chat' = ${topic.chat}`) as unknown as { id: string }[];
    for (const row of rows) standing.add(digest(row.id));
  }
  const kept: AttentionDebt[] = [];
  for (const one of debt) {
    const council = councilGapOf(one.kind);
    if (council === null || standing.has(council.council)) kept.push(one);
    else await noteAttention(store, topic.id, one.kind, null);
  }
  return kept;
}
