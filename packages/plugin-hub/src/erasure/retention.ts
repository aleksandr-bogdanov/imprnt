import type { Language } from "../door/lines.ts";
import { readSetting, type Registry, type RunEntry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { confirmedDeletions, recordRetention, type RetentionState } from "../store/deletions.ts";

/**
 * HISTORICAL BACKUP RETENTION: what the owner configured, what the backup destination can actually do, and what a deletion may
 * therefore say about the copies it does not erase.
 *
 * THE OWNER CHOOSES THE NUMBER, AND NOTHING HERE CHOOSES IT FOR THEM. `hub.backup_retention_days` is read from the registry and
 * is absent until the owner writes it: absent is `not_configured`, said as such in every deletion, and no day count is filled in.
 * `PROPOSED_DAYS` exists to be NAMED as a proposal in a message and in a test that it is not applied, and for nothing else.
 *
 * WHAT THE DESTINATION CAN DO IS NOT ASSUMED. The backup transport is three argv lists (dump, upload, read-back), and none of them
 * can list the copies a destination holds or remove one. Expiry therefore cannot be verified, let alone performed, through it:
 * it is reported as `retention_unverified` with that reason, and the copies stay until a person removes them or a later step gives
 * the transport an enumeration and an expiry command. A copy is never reported as expired on the word of a setting.
 */

/** The design's proposal. It is not a setting, a default or a policy. */
export const PROPOSED_DAYS = 30;

export class RetentionInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionInvalid";
  }
}

/** The days the owner configured, or null when none is. A value that is not a whole number of days from 1 to 3650 is refused by name. */
export function retentionDaysOf(registry: Registry): number | null {
  const value = readSetting(registry, "hub.backup_retention_days");
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 3650) {
    throw new RetentionInvalid("hub.backup_retention_days is a whole number of days from 1 to 3650");
  }
  return value as number;
}

/** When a copy made at `createdAt` is due to expire: counted from the copy's own creation, never from an upload or a deletion. */
export function expiryOf(createdAt: Date, days: number): Date {
  return new Date(createdAt.getTime() + days * 86_400_000);
}

export interface TransportVerdict {
  /** Whether the destination can list its copies and remove one, as a command this Hub can run. */
  supported: boolean;
  reason: string;
}

/**
 * What the declared backup destination can do about retention. The three commands a backup entry has cannot enumerate or expire a
 * copy, so no entry is supported; the verdict is a function of the entry so that a transport which can is one change here.
 */
export function transportOf(entry: Pick<RunEntry, "id"> | null): TransportVerdict {
  return {
    supported: false,
    reason: entry === null
      ? "no backup destination is declared, so no copy of it can be enumerated or expired"
      : `the backup destination ${entry.id} is driven by a dump, an upload and a read-back command, and none of them can list the copies it holds or remove one`,
  };
}

export interface RetentionAccount {
  state: RetentionState;
  days: number | null;
  until: Date | null;
  reason: string;
}

/** What is known of the historical copies of a deletion, from what the owner configured and what the transport can do. */
export function accountOf(input: { days: number | null; transport: TransportVerdict; until: Date | null }): RetentionAccount {
  if (input.days === null) {
    return { state: "not_configured", days: null, until: null, reason: "no backup retention is configured, so no expiry date applies to the earlier copies" };
  }
  if (!input.transport.supported) {
    return { state: "retention_unverified", days: input.days, until: input.until, reason: input.transport.reason };
  }
  return { state: "tracking", days: input.days, until: input.until, reason: "the destination can enumerate and expire copies" };
}

/**
 * The words that say what happens to the copies that remain, in the deletion's completion notice. It names the date only when one is
 * known, and says plainly when none is configured or the destination cannot be verified. It never says the copies are gone.
 */
export function retentionStatement(language: Language, account: Pick<RetentionAccount, "state" | "days" | "until">): string {
  const date = account.until === null ? null : account.until.toISOString().slice(0, 10);
  const ru = language === "ru";
  switch (account.state) {
    case "historical_copies_expired":
      return ru ? "Более ранние резервные копии истекли." : "The earlier backup copies have expired.";
    case "tracking":
      return date !== null
        ? (ru ? `Более ранние резервные копии истекают до ${date}.` : `Historical backups expire by ${date}.`)
        : (ru ? "Более ранние резервные копии истекут по настроенному сроку; дата ещё не известна." : "Earlier backups expire under the configured retention; the date is not known yet.");
    case "retention_unverified":
      return ru
        ? `Срок хранения резервных копий настроен (${account.days} дн.), но хранилище не позволяет проверить или выполнить истечение: более ранние копии остаются, пока их не удалят вручную.`
        : `A backup retention of ${account.days} days is configured, but the backup destination cannot verify or carry out expiry: earlier copies remain until they are removed by hand.`;
    case "retention_blocked":
      return ru ? "Более ранние резервные копии остаются: хранилище не позволяет их удалить." : "Earlier backup copies remain: the destination does not allow their removal.";
    default:
      return ru
        ? "Срок хранения резервных копий не настроен, поэтому более ранние копии остаются без даты истечения."
        : "No backup retention is configured, so earlier backup copies remain with no expiry date.";
  }
}

/**
 * Give every deletion that is waiting on the account of its historical copies the one the configuration and the transport
 * support now. A deletion with no retention stays `not_configured`; one that had a retention configured and whose destination
 * cannot verify expiry is `retention_unverified`, with the reason. Returns how many were recorded.
 */
export async function trackRetention(store: StoreLike, entry: Pick<RunEntry, "id"> | null): Promise<number> {
  const transport = transportOf(entry);
  let recorded = 0;
  for (const deletion of await confirmedDeletions(store)) {
    if (deletion.retention_days === null || deletion.retention_state !== "tracking") continue;
    const account = accountOf({ days: deletion.retention_days, transport, until: deletion.backup_retention_until });
    if (account.state === deletion.retention_state) continue;
    const answer = await recordRetention(store, deletion.id, { state: account.state, until: account.until, detail: { reason: account.reason, days: account.days } });
    if (answer === "recorded") recorded += 1;
  }
  return recorded;
}
