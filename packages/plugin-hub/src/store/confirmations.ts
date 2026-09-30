import { createHash, randomUUID } from "node:crypto";
import type { StoreLike } from "./connect.ts";
import { effectMarker, markerLine, renderEffect, roomFor, sanitizeText, splitText } from "./effects.ts";

/**
 * A frozen exact preview and the one approval it can earn, for whatever needs an
 * owner's green check before it acts: an agent-proposed council now, a topic setup
 * later. The door shows the preview, reads the reaction and approves; a caller here
 * only freezes, and later reads what became of it. There is no way to set an
 * approval from here, and none for a model to: the row moves to `approved` in the
 * door, from a reaction it read, in the same transaction as the work it authorizes.
 */

/** The reaction that approves, the owner's "green check". The one place it is named. */
export const CONFIRM_EMOJI = "✅";

export type ConfirmationState = "pending" | "approved" | "superseded" | "failed";

export interface ConfirmationRow {
  id: string;
  operation_id: string;
  operation_kind: string;
  revision: number;
  person: string;
  door: string;
  chat: string;
  owner_sender: string;
  payload: unknown;
  payload_hash: string;
  effect_keys: string[];
  state: ConfirmationState;
  cause: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  evidence: Record<string, unknown>;
  observed_at: Date | null;
  /** The revision this one was explicitly asked for in place of, or null. */
  replaces: number | null;
}

/** Keys in order and no spaces, so the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => object[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

/**
 * The payload as the store will hold it: the value JSON makes of it, read back. It is
 * taken ONCE, and what is hashed and what is persisted are both this value, so no
 * `Date`, `undefined`, `toJSON` or key order can make the two differ. What JSON cannot
 * hold faithfully is refused rather than quietly changed: a cycle, a bigint, a
 * function or symbol standing where a value should be, and a number that is not finite.
 */
export function normalizePayload(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("a frozen preview carries its payload as an object");
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(payload, (key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError(`the payload holds a number that is not finite at "${key}"`);
      if (typeof value === "bigint") throw new TypeError(`the payload holds a bigint at "${key}"`);
      return value;
    });
  } catch (error) {
    if (error instanceof TypeError && /finite|bigint/.test(error.message)) throw error;
    throw new TypeError(`the payload is not plain JSON: ${String((error as Error)?.message ?? error)}`);
  }
  if (text === undefined) throw new TypeError("the payload is not plain JSON");
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * The hash of everything an approval is bound to: the kind, the payload, the exact
 * preview text and the request line that asks for the reaction. The revision is not in
 * it, so the same content is the same hash, and a change to any of the four is a
 * different one. The payload is expected already normalized (`normalizePayload`).
 */
export function previewHash(kind: string, payload: unknown, preview: string, confirmation: string): string {
  return createHash("sha256").update(canonicalJson({ kind, payload, preview, confirmation })).digest("hex");
}

export function confirmationOf(raw: Record<string, unknown>): ConfirmationRow {
  const row = raw as unknown as ConfirmationRow;
  return { ...row, revision: Number(row.revision), replaces: row.replaces === null || row.replaces === undefined ? null : Number(row.replaces) };
}

/**
 * A freeze the store refused on purpose, with the reason it names: `conflict` (the
 * operation is approved for other content), `replace-required` (a preview that is no
 * longer pending is not made again by asking again), `stale-replacement` (the revision
 * the caller saw is not the standing one and was not replaced by this request) and
 * `replace-unexpected` (nothing there to replace).
 */
export class ConfirmationRefused extends Error {
  readonly code: "conflict" | "replace-required" | "stale-replacement" | "replace-unexpected";

  constructor(code: ConfirmationRefused["code"], message: string) {
    super(message);
    this.name = "ConfirmationRefused";
    this.code = code;
  }
}

export interface FreezeConfirmation {
  /** What the approval is for. Corrections of one operation supersede each other. */
  operationId: string;
  /** Names the hook that acts on the approval. */
  operationKind: string;
  /** The person the reacting sender must be allowed for, by the registry, when it is read. */
  person: string;
  door: string;
  chat: string;
  /** The platform id of the sender whose reaction approves, and nobody else's does. */
  ownerSender: string;
  /** What the approval acts on, frozen with the preview. Plain JSON. */
  payload: unknown;
  /** The exact preview text, already labelled. It is split into parts if it is long. */
  preview: string;
  /** The line asking for the reaction, under the preview and above the hash. It is part of what the hash binds. */
  confirmation: string;
  platform?: string;
  /**
   * ANOTHER PREVIEW, asked for on purpose: the revision the caller saw standing and
   * wants replaced. Nothing else makes a new message for a preview that failed, was
   * deleted or is stuck with a part whose delivery is unknown: freezing the same
   * content again returns that standing preview, failure included, and freezing
   * changed content over a failed one is refused. It is honoured for a failed preview,
   * or a pending one with a part that is unknown, failed or missing, once: the same
   * request repeated returns the replacement it made. The old row stays as history.
   */
  replace?: { revision: number };
}

export interface Frozen {
  id: string;
  revision: number;
  state: ConfirmationState;
  hash: string;
  /** False when the same content was already frozen and this call made nothing. */
  created: boolean;
}

/**
 * Freeze a preview for an owner to confirm. One transaction supersedes the operation's
 * pending revision, if any, and wants the new parts, so nothing of the new preview is
 * posted before the old one can no longer be approved. The last part is the
 * confirmation message: the request for the reaction and the full hash of what was
 * shown (design §7).
 *
 * WHAT ASKING AGAIN DOES. The same complete binding returns the standing preview in
 * whatever state it is, a failure included, and makes nothing. An approved operation
 * returns its approval for that binding only, and refuses any other with
 * `ConfirmationRefused("conflict")`. A pending preview asked for with changed content
 * is corrected as ever. A failed preview is never made again by asking, changed or not
 * (`replace-required`): another preview is `replace`, on purpose.
 */
export async function freezeConfirmation(store: StoreLike, freeze: FreezeConfirmation): Promise<Frozen> {
  for (const [name, value] of Object.entries({ operationId: freeze.operationId, operationKind: freeze.operationKind,
    person: freeze.person, door: freeze.door, chat: freeze.chat, ownerSender: freeze.ownerSender })) {
    if (typeof value !== "string" || value === "") throw new TypeError(`a frozen preview needs ${name}`);
  }
  if (freeze.replace !== undefined && !(Number.isInteger(freeze.replace.revision) && freeze.replace.revision >= 1)) {
    throw new TypeError("a replacement names the revision it replaces");
  }
  // Once: this value is what is hashed and what is stored.
  const payload = normalizePayload(freeze.payload);
  const preview = sanitizeText(freeze.preview);
  const ask = sanitizeText(freeze.confirmation);
  if (preview === "" || ask === "") throw new TypeError("a frozen preview needs its text and its request for a reaction");
  const hash = previewHash(freeze.operationKind, payload, preview, ask);
  const id = randomUUID();
  const platform = freeze.platform ?? "discord";
  // Keys sort in the order the parts appear, so the ledger sends them in that order.
  const at = (n: number) => `confirmation:${id}:${String(n).padStart(3, "0")}`;

  // The confirmation message is last and carries the whole hash. Its own room is
  // what is left after its marker and the hash line, and a request that would not
  // fit is refused, because a cut request is not the one the owner was given.
  const last = `${ask}\n\`sha256:${hash}\``;
  const pieces = splitText(preview, roomFor(at(1), platform));
  if (pieces.length > 998) throw new RangeError("a preview of that many parts is not a preview");
  const keys = pieces.map((_, index) => at(index + 1));
  keys.push(at(pieces.length + 1));
  const parts = pieces.map((piece, index) => ({ key: keys[index], ...renderEffect(keys[index], piece, platform) }));
  parts.push({ key: keys[keys.length - 1], ...renderEffect(keys[keys.length - 1], last, platform) });

  let stood: Record<string, unknown>;
  try {
    [stood] = await store.sql`select hub_confirmation_freeze(${id}, ${freeze.operationId}, ${freeze.operationKind},
      ${freeze.person}, ${freeze.door}, ${freeze.chat}, ${freeze.ownerSender}, ${payload}::jsonb, ${hash},
      ${{ parts }}::jsonb, ${freeze.replace?.revision ?? null}::integer) as id`;
  } catch (error) {
    const said = /confirmation-(conflict|replace-required|stale-replacement|replace-unexpected)/.exec(String((error as Error)?.message ?? ""));
    if (said) throw new ConfirmationRefused(said[1] as ConfirmationRefused["code"], String((error as Error).message));
    throw error;
  }
  const row = await readConfirmation(store, String(stood.id));
  if (!row) throw new Error("a frozen preview is not there to read");
  return { id: row.id, revision: row.revision, state: row.state, hash: row.payload_hash, created: row.id === id };
}

const COLUMNS = `id, operation_id, operation_kind, revision, person, door, chat, owner_sender, payload, payload_hash,
  effect_keys, state, cause, approved_by, approved_at, evidence, observed_at, replaces`;

export async function readConfirmation(store: StoreLike, id: string): Promise<ConfirmationRow | null> {
  const [row] = await store.sql.unsafe(`select ${COLUMNS} from confirmation where id = $1`, [id]);
  return row ? confirmationOf(row) : null;
}

/** Every revision of one operation, oldest first, so a caller sees which one stands. */
export async function readOperation(store: StoreLike, operationId: string): Promise<ConfirmationRow[]> {
  const rows = await store.sql.unsafe(`select ${COLUMNS} from confirmation where operation_id = $1 order by revision`, [operationId]);
  return rows.map((row: Record<string, unknown>) => confirmationOf(row));
}

/** The columns the door selects its pending previews with. */
export const CONFIRMATION_COLUMNS = COLUMNS;

// Re-exported so a consumer that builds its own preview text can hold to the marker.
export { effectMarker, markerLine };
