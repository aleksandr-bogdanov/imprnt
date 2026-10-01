import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILE, readManifest } from "../backup/manifest.ts";
import type { Language } from "../door/lines.ts";
import { BACKUP_PLACEHOLDERS, readSetting, type Registry, type RunEntry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { confirmedDeletions, recordRetention, type DeletionRow, type RetentionState } from "../store/deletions.ts";

/**
 * HISTORICAL BACKUP RETENTION: what the owner configured, what the backup destination can actually do, and what a deletion may
 * therefore say about the copies it does not erase.
 *
 * THE OWNER CHOOSES THE NUMBER, AND NOTHING HERE CHOOSES IT FOR THEM. `hub.backup_retention_days` is read from the registry and
 * is absent until the owner writes it: absent is `not_configured`, said as such in every deletion, nothing is ever expired, and no day
 * count is filled in. `PROPOSED_DAYS` exists to be NAMED as a proposal in a message and in a test that it is not applied, and for
 * nothing else.
 *
 * WHAT THE DESTINATION CAN DO IS NOT ASSUMED, IT IS DECLARED. The backup transport is argv lists with placeholders and no provider
 * named here. Dump, upload and read-back cannot enumerate or remove a copy, so a destination that declares nothing more is
 * `retention_unverified`: its earlier copies remain until a person removes them, and nothing says otherwise. A destination that
 * declares `list_argv` and `expire_argv`, and whose upload gives each copy a place of its own (`{generation}`), is a destination
 * whose generations this Hub can enumerate, age and expire:
 *
 *   1. LIST   `list_argv` prints the id of every copy it holds. An id that is not of the shape a copy gets is not one of ours and is
 *             never touched.
 *   2. AGE    each copy's own `manifest.json` is read back through the declared read-back (`{generation}` and `manifest.json`), and its
 *             `at` is the copy's creation. Age is counted from there, never from an upload, a listing or a deletion. A copy whose
 *             manifest cannot be read has no age and is `retention_unverified`, never expired.
 *   3. EXPIRE a copy older than the configured days is removed whole by `expire_argv`, one id at a time. There is no exemption for the
 *             newest or the last good copy: a failed fresh backup is reported, and is no reason to keep old history silently.
 *   4. VERIFY the destination is listed again, and a copy is `expired` only when it is no longer there. A refused or failed removal is
 *             `retention_blocked`, with the reason.
 *
 * WHICH DELETION A COPY IS HISTORY OF is the manifest's own record of the erasure generation it was assembled under: a copy made under
 * an earlier generation than the deletion's (or one that predates generations) can hold what was deleted; a copy made after cannot
 * (a backup is held while a confirmed deletion's rows or files are still to go). Only those are counted against a deletion.
 * A deletion with no such copy found is `tracking` and says so: it is never `historical_copies_expired` from an empty listing, and
 * the legacy single-directory copy a destination already holds is not a generation, so it is never enumerated here.
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

// ---------------------------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------------------------

/** A copy's id: the UTC second it was assembled. The only shape the Hub makes, and so the only shape it will ever expire. */
export const GENERATION_ID = /^\d{8}T\d{6}Z$/;

export const generationIdOf = (at: Date): string => at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

type Placeholder = (typeof BACKUP_PLACEHOLDERS)[number] extends `{${infer Name}}` ? Name : never;

/**
 * The placeholders filled into each argument in ONE pass, so a value that happens to contain a placeholder's spelling is never filled
 * in again, and every argument stays one argument.
 */
export function fill(argv: string[], values: Partial<Record<Placeholder, string>>): string[] {
  const known = new Set<string>(BACKUP_PLACEHOLDERS);
  return argv.map((arg) => arg.replace(/\{[A-Za-z_]+\}/g, (token) =>
    known.has(token) ? values[token.slice(1, -1) as Placeholder] ?? token : token));
}

export interface TransportVerdict {
  /** Whether the destination can list its copies and remove one, as commands this Hub can run, for copies it can tell apart. */
  supported: boolean;
  reason: string;
}

export type TransportEntry = Pick<RunEntry, "id" | "upload_argv" | "readback_argv" | "list_argv" | "expire_argv" | "destination">;

/**
 * What the declared backup destination can do about retention. It is supported exactly when the entry declares both commands and its
 * upload gives every copy a place of its own; anything less is unsupported, with the reason a person reads.
 */
export function transportOf(entry: Pick<RunEntry, "id"> & Partial<TransportEntry> | null): TransportVerdict {
  if (entry === null) return { supported: false, reason: "no backup destination is declared, so no copy of it can be enumerated or expired" };
  const listed = Array.isArray(entry.list_argv) && Array.isArray(entry.expire_argv);
  if (!listed) {
    return { supported: false,
      reason: `the backup destination ${entry.id} is driven by a dump, an upload and a read-back command, and none of them can list the copies it holds or remove one` };
  }
  if (!(entry.upload_argv ?? []).some(arg => arg.includes("{generation}"))) {
    return { supported: false, reason: `the backup destination ${entry.id} declares list_argv and expire_argv, but its upload does not give each copy a place of its own ({generation})` };
  }
  return { supported: true, reason: "the destination can enumerate and expire its copies" };
}

export interface Generation {
  id: string;
  /** The copy's creation, from its own manifest; null when that could not be read. */
  at: Date | null;
  /** The erasure generation it was assembled under; null for a copy that predates them, or whose manifest could not be read. */
  erasure_generation: number | null;
  readable: boolean;
}

export type GenerationState = "pending" | "expired" | "retention_unverified" | "retention_blocked";

export interface Outcome {
  id: string;
  state: GenerationState;
  /** When the copy is due, from its own creation; null when its age is not known. */
  expires_at: string | null;
  erasure_generation: number | null;
  reason?: string;
}

/** How commands are run, so that a check can stand a destination of its own in for a real one. Output is read only when asked. */
export type Exec = (argv: string[], keep: boolean) => Promise<Uint8Array>;

/** A command of the transport that did not do what was asked, by the closed word of the step and never the command's own output. */
export class TransportFailure extends Error {
  constructor(readonly step: "list" | "readback" | "expire", detail: string) {
    super(`retention-${step}: ${detail}`);
    this.name = "TransportFailure";
  }
}

/** One command, as argv, with its diagnostics discarded (a copy tool's own words can carry a destination with a login in it). */
export const spawnExec: Exec = async (argv, keep) => {
  let child;
  try { child = Bun.spawn(argv, { env: process.env, stdin: "ignore", stdout: keep ? "pipe" : "ignore", stderr: "ignore" }); }
  catch { throw new Error(`${argv[0]} could not be started`); }
  const [out, status] = await Promise.all([
    keep ? new Response(child.stdout as ReadableStream).arrayBuffer().then((buffer) => new Uint8Array(buffer)) : Promise.resolve(new Uint8Array()),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`${argv[0]} exited ${status}`);
  return out;
};

export interface RetentionTransport {
  entry: Pick<TransportEntry, "id"> & Partial<TransportEntry>;
  /** A scratch directory the read-back may write into (inside the staging directory). */
  scratch: string;
  exec?: Exec;
}

/** The ids the destination lists, one per line. What is not of the shape a copy gets is counted and left alone. */
export async function listGenerationIds(t: RetentionTransport): Promise<{ ids: string[]; foreign: number }> {
  const exec = t.exec ?? spawnExec;
  let text: string;
  try { text = new TextDecoder().decode(await exec(fill(t.entry.list_argv ?? [], { destination: t.entry.destination ?? "" }), true)); }
  catch (error) { throw new TransportFailure("list", (error as Error).message); }
  const names = text.split("\n").map(line => line.trim()).filter(line => line !== "");
  return { ids: [...new Set(names.filter(name => GENERATION_ID.test(name)))].sort(), foreign: names.filter(name => !GENERATION_ID.test(name)).length };
}

/** One copy's own manifest, read back from the destination through the declared read-back. A copy that cannot be read has no age. */
export async function readGeneration(t: RetentionTransport, id: string): Promise<Generation> {
  const exec = t.exec ?? spawnExec;
  const argv = t.entry.readback_argv ?? [];
  const intoFile = argv.some(arg => arg.includes("{out}"));
  const out = join(t.scratch, `generation-${id}`);
  try {
    mkdirSync(t.scratch, { recursive: true });
    const said = await exec(fill(argv, { destination: t.entry.destination ?? "", path: MANIFEST_FILE, out, generation: id }), !intoFile);
    const manifest = readManifest(new TextDecoder().decode(intoFile ? readFileSync(out) : said));
    const at = new Date(manifest.at);
    if (Number.isNaN(at.getTime())) throw new Error("no creation time");
    return { id, at, erasure_generation: typeof manifest.erasure_generation === "number" ? manifest.erasure_generation : null, readable: true };
  } catch {
    return { id, at: null, erasure_generation: null, readable: false };
  } finally {
    rmSync(out, { force: true });
  }
}

/**
 * Enumerate, age and expire. Only generations the destination LISTED, whose own manifest said when they were made, and that are older
 * than `days` by that creation time, are asked to be removed, one at a time; each is then looked for again. `now` is the clock the age
 * is counted against; a copy dated in the future is not old.
 */
export async function enforceRetention(t: RetentionTransport, args: { days: number; now: Date }): Promise<{ outcomes: Outcome[]; foreign: number }> {
  const exec = t.exec ?? spawnExec;
  const first = await listGenerationIds(t);
  // One at a time: a destination over the network is asked for one manifest, not for as many as it holds at once.
  const generations: Generation[] = [];
  for (const id of first.ids) generations.push(await readGeneration(t, id));
  const outcomes = new Map<string, Outcome>();
  const due: Generation[] = [];
  for (const one of generations) {
    if (!one.readable || one.at === null) {
      outcomes.set(one.id, { id: one.id, state: "retention_unverified", expires_at: null, erasure_generation: null, reason: "its manifest cannot be read, so its age is not known" });
      continue;
    }
    const expires = expiryOf(one.at, args.days);
    const base = { id: one.id, expires_at: expires.toISOString(), erasure_generation: one.erasure_generation };
    if (expires.getTime() <= args.now.getTime()) due.push(one); else outcomes.set(one.id, { ...base, state: "pending" });
  }
  const asked: string[] = [];
  for (const one of due) {
    const base = { id: one.id, expires_at: expiryOf(one.at!, args.days).toISOString(), erasure_generation: one.erasure_generation };
    try {
      await exec(fill(t.entry.expire_argv ?? [], { destination: t.entry.destination ?? "", generation: one.id }), false);
      asked.push(one.id);
      outcomes.set(one.id, { ...base, state: "pending" });
    } catch (error) {
      outcomes.set(one.id, { ...base, state: "retention_blocked", reason: `the expiry command failed: ${(error as Error).message.slice(0, 120)}` });
    }
  }
  if (asked.length > 0) {
    // ABSENCE IS THE ANSWER: a removal the destination reported is believed only when it no longer lists the copy.
    const after = await listGenerationIds(t);
    for (const id of asked) {
      const standing = outcomes.get(id)!;
      outcomes.set(id, after.ids.includes(id)
        ? { ...standing, state: "retention_blocked", reason: "the destination still lists the copy after its expiry command" }
        : { ...standing, state: "expired" });
    }
  }
  return { outcomes: [...outcomes.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), foreign: first.foreign };
}

// ---------------------------------------------------------------------------------------------
// What a deletion says of its historical copies
// ---------------------------------------------------------------------------------------------

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
 * The copies of the destination that are history of one deletion: assembled under an erasure generation earlier than the deletion's, or
 * before generations existed, or whose manifest could not be read (their age and generation are unknown, so they cannot be shown clear
 * of it). A copy assembled at or after the deletion's generation was made after its rows and files were gone.
 */
export function historyOf(deletion: Pick<DeletionRow, "deletion_generation">, outcomes: readonly Outcome[]): Outcome[] {
  const generation = deletion.deletion_generation;
  return outcomes.filter(one => {
    if (one.expires_at === null) return true;
    if (one.erasure_generation === null) return true;
    return generation !== null && one.erasure_generation < generation;
  });
}

/** One deletion's account, from the copies the destination holds. Pure. */
export function accountForDeletion(deletion: Pick<DeletionRow, "deletion_generation" | "retention_state">, outcomes: readonly Outcome[], days: number): {
  state: RetentionState; until: Date | null; generations: { id: string; state: GenerationState; expires_at: string | null }[]; detail: Record<string, unknown>;
} {
  const history = historyOf(deletion, outcomes);
  const generations = history.map(one => ({ id: one.id, state: one.state, expires_at: one.expires_at }));
  const dates = history.filter(one => one.state !== "expired" && one.expires_at !== null).map(one => Date.parse(one.expires_at!));
  const until = dates.length === 0 ? null : new Date(Math.max(...dates));
  const count = (state: GenerationState): number => history.filter(one => one.state === state).length;
  const detail = { days, copies: history.length, expired: count("expired"), pending: count("pending"), unverified: count("retention_unverified"), blocked: count("retention_blocked") };
  if (history.length === 0) return { state: "tracking", until: null, generations, detail: { ...detail, note: "no earlier copy was found at the destination: nothing is shown to have expired" } };
  if (count("retention_blocked") > 0) return { state: "retention_blocked", until, generations, detail };
  if (count("retention_unverified") > 0) return { state: "retention_unverified", until, generations, detail };
  if (count("expired") === history.length) return { state: "historical_copies_expired", until: null, generations, detail };
  return { state: "tracking", until, generations, detail };
}

/**
 * Give every confirmed deletion the account of its historical copies that the configuration and the transport support now.
 *   * no retention configured: `not_configured`, nothing expires;
 *   * a transport that cannot enumerate and expire: `retention_unverified`, with the reason, and the copies said to remain;
 *   * a transport that can (`outcomes` is what `enforceRetention` found): the copies that are this deletion's history, each as it stands.
 * A deletion whose copies were all verified expired stays so. Returns how many accounts were recorded.
 */
export async function trackRetention(store: StoreLike, entry: Pick<RunEntry, "id"> & Partial<TransportEntry> | null, input: {
  days: number | null; outcomes: readonly Outcome[] | null;
}): Promise<number> {
  const transport = transportOf(entry);
  let recorded = 0;
  for (const deletion of await confirmedDeletions(store)) {
    // Reassess on each pass: newly discovered historical storage can invalidate an earlier account.
    let state: RetentionState;
    let until: Date | null = null;
    let detail: Record<string, unknown>;
    let generations: { id: string; state: GenerationState; expires_at: string | null }[] | undefined;
    if (input.days === null) {
      // The owner configured nothing: nothing is counted, whatever a deletion froze when it was asked for.
      if (deletion.retention_state === "not_configured") continue;
      state = "not_configured"; detail = { reason: "no backup retention is configured" };
    } else if (!transport.supported || input.outcomes === null) {
      const account = accountOf({ days: input.days, transport, until: deletion.backup_retention_until });
      state = account.state; until = account.until; detail = { reason: account.reason, days: input.days };
    } else {
      const account = accountForDeletion(deletion, input.outcomes, input.days);
      state = account.state === "retention_blocked" ? "retention_blocked" : "retention_unverified"; until = account.until; generations = account.generations;
      detail = { ...account.detail, generation_state: account.state, reason: "enumerated generations are tracked, but legacy dump history, destination versions and retained storage have not been inventoried and verified expired" };
    }
    // A verdict that says what the last one said, with no copy to account for, is not written again.
    if (generations === undefined && state === deletion.retention_state) continue;
    const answer = await recordRetention(store, deletion.id, { state, until, detail, ...(generations === undefined ? {} : { generations }) });
    if (answer === "recorded") recorded += 1;
  }
  return recorded;
}
