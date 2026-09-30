import { createHash } from "node:crypto";
import type { StoreLike } from "./connect.ts";

/**
 * The typed way to ask for a chat message and to read what became of it. A council
 * status line, a preview part and whatever comes after them ask here, and the door
 * (`door/effects.ts`) is the one process that sends. Nothing here talks to a platform.
 *
 * WHICH PATHS USE THIS LEDGER TODAY: the frozen previews of `confirmations.ts`, and the
 * status card of an ordinary turn (`door/run.ts`, one key per input). Ordinary replies keep
 * their outbox. The `door_progress` sheet is no longer the card's identity: it is only the
 * door's note that a card's last content is still owed, and the reason the card showed.
 */
export type EffectState = "not_sent" | "in_flight" | "confirmed" | "unknown" | "failed" | "missing";

/**
 * Where the newest edit of a created message stands. `idle` is the only state an edit
 * is claimed from. `in_flight` is a request whose outcome is not recorded, and
 * `unknown` one whose looks found nothing: it may still land, so nothing newer is sent
 * over it and the row does not claim the newest content is on the platform.
 */
export type EditState = "idle" | "in_flight" | "unknown";

export interface EffectRow {
  key: string;
  door: string;
  chat: string;
  owner_ref: string;
  frozen: boolean;
  marker: string;
  nonce: string;
  state: EffectState;
  platform_id: string | null;
  wanted_revision: number;
  wanted_content: string;
  applied_revision: number;
  /** The hash of the content of `applied_revision`, as the door last put it on the platform. */
  applied_hash: string | null;
  attempt_id: string | null;
  attempt_revision: number | null;
  attempt_hash: string | null;
  attempts: number;
  reconcile_attempts: number;
  edit_state: EditState;
  edit_attempt_id: string | null;
  edit_revision: number | null;
  edit_hash: string | null;
  edit_attempts: number;
  in_flight_at: Date | null;
  retry_at: Date | null;
  evidence: Record<string, unknown>;
  failure: (Record<string, unknown> & { permanent?: boolean; revision?: number }) | null;
}

/**
 * How many characters one message may hold, per platform. The number is the
 * platform's own documented limit, and it is counted in UTF-16 units, which can only
 * be stricter than the platform's own count.
 */
export function messageLimit(platform = "discord"): number {
  return platform === "telegram" ? 4000 : 2000;
}

export class EffectTooLong extends Error {
  readonly limit: number;
  readonly length: number;

  constructor(length: number, limit: number) {
    super(`a message of ${length} characters does not fit the ${limit} the platform allows, with its marker`);
    this.name = "EffectTooLong";
    this.limit = limit;
    this.length = length;
  }
}

/**
 * The text as the platform will keep it. It strips "invalid unicode characters or
 * characters which cause unexpected message formatting" from content, so what is
 * compared later is what survives that: control characters other than a newline or
 * a tab are gone, a surrogate half that pairs with nothing is gone, line endings are
 * `\n`, and no whitespace leads or trails.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .trim();
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * What identifies a message read back with the one that was sent: a hash of its
 * trimmed content. Exact, apart from the whitespace a platform is free to trim.
 */
export function contentHash(content: string): string {
  return sha(content.trim());
}

/**
 * The opaque identifier a message carries so it can be found again after a lost
 * answer. It is a hash of the effect key and names nothing: no person, chat, agent
 * or text. It is visible in the message, on purpose. It lives in the message's own
 * content, because content is the one field the platform keeps and returns; nothing
 * here relies on it keeping metadata, an embed or an invisible character.
 */
export function effectMarker(key: string): string {
  return `hub:${sha(`hub-effect:${key}`).slice(0, 16)}`;
}

/** The line the marker rides on. Code formatting keeps it small and unformatted. */
export function markerLine(marker: string): string {
  return `\`${marker}\``;
}

/**
 * The exact content that will be sent for `text`: the text, sanitized, and the
 * marker line under it. It refuses what would not fit rather than cutting it, because
 * a cut message no longer matches what was asked for.
 */
export function renderEffect(key: string, text: string, platform = "discord"): { content: string; marker: string } {
  const marker = effectMarker(key);
  const body = sanitizeText(text);
  if (body === "") throw new TypeError("a message with no text");
  const content = `${body}\n${markerLine(marker)}`;
  const limit = messageLimit(platform);
  if (content.length > limit) throw new EffectTooLong(content.length, limit);
  return { content, marker };
}

/** The room the text of one message has once its marker line is on it. */
export function roomFor(key: string, platform = "discord"): number {
  return messageLimit(platform) - markerLine(effectMarker(key)).length - 1;
}

/**
 * Cut `text` into pieces of at most `size`, at a line break where one falls in the
 * back half of the piece, and never between the halves of a surrogate pair.
 */
export function splitText(text: string, size: number): string[] {
  if (size < 1) throw new RangeError("a piece holds at least one character");
  const body = sanitizeText(text);
  const pieces: string[] = [];
  let start = 0;
  while (start < body.length) {
    let end = Math.min(start + size, body.length);
    if (end < body.length) {
      const cut = body.lastIndexOf("\n", end - 1);
      if (cut > start + size / 2) end = cut + 1;
      else if (/[\uD800-\uDBFF]/.test(body[end - 1]) && /[\uDC00-\uDFFF]/.test(body[end])) end -= 1;
      // A piece too small to hold a whole pair still holds one, so the split ends.
      if (end <= start) end = Math.min(start + 2, body.length);
    }
    const piece = body.slice(start, end).trim();
    if (piece !== "") pieces.push(piece);
    start = end;
  }
  return pieces;
}

const COLUMNS = `key, door, chat, owner_ref, frozen, marker, nonce, state, platform_id, wanted_revision, wanted_content,
  applied_revision, applied_hash, attempt_id, attempt_revision, attempt_hash, attempts, reconcile_attempts,
  edit_state, edit_attempt_id, edit_revision, edit_hash, edit_attempts, in_flight_at, retry_at, evidence, failure`;

/** A row of `platform_effect` with its numbers as numbers. */
export function effectOf(raw: Record<string, unknown>): EffectRow {
  const row = raw as unknown as EffectRow;
  return {
    ...row,
    wanted_revision: Number(row.wanted_revision),
    applied_revision: Number(row.applied_revision),
    attempt_revision: row.attempt_revision === null ? null : Number(row.attempt_revision),
    attempts: Number(row.attempts),
    reconcile_attempts: Number(row.reconcile_attempts),
    edit_revision: row.edit_revision === null ? null : Number(row.edit_revision),
    edit_attempts: Number(row.edit_attempts),
  };
}

/**
 * Whether the message is known to show the newest content asked for: created, no edit
 * request outstanding that could still land, and the applied revision the wanted one.
 * The only answer that may be called "up to date". An `unknown` or `in_flight` edit,
 * or a create that is not confirmed, is not it, however old the request is.
 */
export function isSettled(row: Pick<EffectRow, "state" | "edit_state" | "applied_revision" | "wanted_revision">): boolean {
  return row.state === "confirmed" && row.edit_state === "idle" && row.applied_revision === row.wanted_revision;
}

export interface WantEffect {
  key: string;
  door: string;
  chat: string;
  /** What the message belongs to: a council, an operation. Immutable once wanted. */
  owner: string;
  text: string;
  platform?: string;
}

/**
 * Ask for a message, or for new content of one already asked for. Persisted before
 * anything is sent, in the caller's own transaction when `store` is one. Asking twice
 * with the same text is one revision. What became of it is read back with
 * `readEffect`: `missing`, `failed` and `unknown` are the platform's or the door's
 * findings and nothing here turns them back into a send.
 */
export async function wantEffect(store: StoreLike, want: WantEffect): Promise<{ revision: number; state: EffectState }> {
  const { content, marker } = renderEffect(want.key, want.text, want.platform);
  const [asked] = await store.sql`select hub_effect_want(${want.key}, ${want.door}, ${want.chat}, ${want.owner},
    ${content}, ${marker}) as revision`;
  const [seen] = await store.sql`select state from platform_effect where key = ${want.key}`;
  return { revision: Number(asked.revision), state: seen.state as EffectState };
}

export async function readEffect(store: StoreLike, key: string): Promise<EffectRow | null> {
  const [row] = await store.sql.unsafe(`select ${COLUMNS} from platform_effect where key = $1`, [key]);
  return row ? effectOf(row) : null;
}

/** In the order asked, and only the ones that exist. A preview has a handful, so one read each. */
export async function readEffects(store: StoreLike, keys: string[]): Promise<EffectRow[]> {
  const found: EffectRow[] = [];
  for (const key of keys) {
    const row = await readEffect(store, key);
    if (row) found.push(row);
  }
  return found;
}

/** The columns `readEffect` reads, for a door that selects its own due rows. */
export const EFFECT_COLUMNS = COLUMNS;
