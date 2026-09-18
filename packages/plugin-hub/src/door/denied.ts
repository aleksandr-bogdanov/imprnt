import type { StoreLike } from "../store/connect.ts";

/**
 * D-173, D-183. A refused sender leaves one content-free row.
 *
 * The door refuses a message from a sender the allowlist does not name before
 * anything is saved, and sends no reply. Until this row existed that refusal
 * left nothing anywhere, so an allowlist that named the wrong id, or none, made
 * a person's chat look exactly like a quiet one. D-183 allows the rejection to
 * be counted without storing the message, and this is the smallest form of it:
 * which door and chat, which stable sender id, whose agent, and when the first
 * and the latest refusal happened. Never the text, the media or the display
 * name.
 *
 * A STATE SHEET, one row per door, chat and sender, edited in place. It is
 * written only on fetched work, inside the batch and before its cursor, so a
 * crash cannot advance past a refusal without the row, and a replayed batch
 * rewrites the same row rather than adding one. `check` reads it and never
 * writes it.
 */
export const SENDER_DENIED_SHEET = "sender_denied";

export interface DeniedSender {
  door: string;
  chat: string;
  sender_id: string;
  person: string;
  agent: string;
  first_at: string;
  last_at: string;
}

export async function recordDeniedSender(
  store: StoreLike,
  denied: { door: string; chat: string; sender_id: string; person: string; agent: string; at: string },
): Promise<void> {
  const data: DeniedSender = {
    door: denied.door,
    chat: denied.chat,
    sender_id: denied.sender_id,
    person: denied.person,
    agent: denied.agent,
    first_at: denied.at,
    last_at: denied.at,
  };
  await store.sql`insert into state_row (sheet, id, data)
                  values (${SENDER_DENIED_SHEET}, ${`${denied.door}/${denied.chat}/${denied.sender_id}`}, ${data})
                  on conflict (sheet, id) do update set
                    data = excluded.data || jsonb_build_object(
                      'first_at', least(state_row.data ->> 'first_at', excluded.data ->> 'first_at'),
                      'last_at', greatest(state_row.data ->> 'last_at', excluded.data ->> 'last_at')),
                    updated_at = now()`;
}
