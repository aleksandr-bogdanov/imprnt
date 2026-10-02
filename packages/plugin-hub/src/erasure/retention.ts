import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILE, readManifest } from "../backup/manifest.ts";
import type { Language } from "../door/lines.ts";
import { CONTROL_MANIFEST_FILE } from "./manifest.ts";
import { BACKUP_PLACEHOLDERS, readSetting, type Registry, type RunEntry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { confirmedDeletions, receiptsOf, recordRetention, type DeletionRow, type RetentionState } from "../store/deletions.ts";

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
 * A deletion with no such copy found is `tracking` and says so: it is never `historical_copies_expired` from an empty listing.
 *
 * THE LEGACY MONOLITHIC ARCHIVE (the dump Git repository of the single-directory layout, on this box and as the destination's old
 * copy) is not a generation and holds every earlier dump, so it is history of EVERY deletion whatever its last manifest says. It is
 * SEALED once, when the owner's number is first configured with a generation layout: `retention-seal.json` in the staging directory
 * records the activation and an explicit `expires_at` (activation + days) and is never rewritten, so copying the archive again can
 * never refresh it; a later, shorter number shortens it and a longer one does not extend it. The box's own repository is removed at
 * that date and looked for again. The destination's old copy is moved under a generation id by the declared `seal_argv` (and then
 * ages and expires like any generation, no later than the seal's date); with no `seal_argv` it stays, and says so.
 *
 * PHYSICAL COPIES ARE ACCOUNTED, NOT ASSUMED. A removal is believed only when the destination lists the copy no longer AND the declared
 * `retained_argv` (versions, trash, replicas) no longer holds it. A destination that declares no `retained_argv`, retains entries that
 * are not copies of this job's, or still holds its old copy, is never called fully expired: its deletions stay `retention_unverified`.
 * What the Hub cannot enumerate at all (database WAL archives, file-system snapshots) is outside its inventory, and is said to be.
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

export type TransportEntry = Pick<RunEntry, "id" | "upload_argv" | "readback_argv" | "list_argv" | "expire_argv" | "retained_argv" | "seal_argv" | "destination">;

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
  constructor(readonly step: "list" | "retained" | "readback" | "expire" | "seal", detail: string) {
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

/** What a listing printed: the ids of the shape a copy gets, and every other name (counted and left alone, never removed). */
export interface Listing {
  ids: string[];
  others: string[];
}

async function listNames(t: RetentionTransport, argv: string[], step: "list" | "retained"): Promise<Listing> {
  const exec = t.exec ?? spawnExec;
  let text: string;
  try { text = new TextDecoder().decode(await exec(fill(argv, { destination: t.entry.destination ?? "" }), true)); }
  catch (error) { throw new TransportFailure(step, (error as Error).message); }
  const names = [...new Set(text.split("\n").map(line => line.trim()).filter(line => line !== ""))];
  return { ids: names.filter(name => GENERATION_ID.test(name)).sort(), others: names.filter(name => !GENERATION_ID.test(name)) };
}

/** The ids the destination lists, one per line. What is not of the shape a copy gets is counted and left alone. */
export async function listGenerationIds(t: RetentionTransport): Promise<Listing & { foreign: number }> {
  const listing = await listNames(t, t.entry.list_argv ?? [], "list");
  return { ...listing, foreign: listing.others.length };
}

/** What the destination lists, and, when it declares `retained_argv`, everything it still physically retains (null when it declares none). */
async function inventoryOf(t: RetentionTransport): Promise<{ list: Listing; held: Listing | null }> {
  const list = await listGenerationIds(t);
  return { list, held: Array.isArray(t.entry.retained_argv) ? await listNames(t, t.entry.retained_argv, "retained") : null };
}

/** The names the single-directory layout put at the top of the destination: their presence is the old monolithic copy, not a generation. */
export const LEGACY_NAMES: readonly string[] = ["dump", "files", MANIFEST_FILE, CONTROL_MANIFEST_FILE];

/** What the destination was found to retain, beyond the copies that were aged. Without it no deletion is called fully expired. */
export interface Inventory {
  /** Whether the destination declares and answered a physical inventory (`retained_argv`): its versions, trash and replicas. */
  retained: boolean;
  /** How many entries it retains that are neither a copy of this job's nor the old single-directory copy. */
  unaccounted: number;
  /** Whether it still holds the old single-directory copy at its top. */
  legacy: boolean;
}

// ---------------------------------------------------------------------------------------------
// The legacy monolithic archive: sealed once, with an expiry that nothing refreshes
// ---------------------------------------------------------------------------------------------

/** Where the seal is kept, in the staging directory beside (and never inside) the copy that is uploaded. */
export const SEAL_FILE = "retention-seal.json";
/** The id of the dump Git repository on this box (`<staging>/dump`), as an outcome and as a receipt. */
export const LOCAL_LEGACY_ID = "staging-dump";

export interface Seal {
  version: 1;
  /** When the owner's number first applied to this staging directory. */
  activated_at: string;
  days: number;
  /** The explicit expiry of the legacy archive: activation + days. Written once. */
  expires_at: string;
  /** The generation id the destination's old copy was moved under, once it was verified to be. */
  destination_copy: string | null;
  /**
   * The id CHOSEN for that move, written before the move command is run and kept until the move is verified. A crash between the command
   * and the verification leaves the old copy's identity here: the next run looks for this id and never makes another.
   */
  pending_copy?: string | null;
}

/** The seal, or null when none was made. One that cannot be read is an error and is never replaced: a replacement would refresh the expiry. */
export function readSeal(staging: string): Seal | null {
  const file = join(staging, SEAL_FILE);
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Seal>;
  if (parsed.version !== 1 || typeof parsed.activated_at !== "string" || typeof parsed.expires_at !== "string" || Number.isNaN(Date.parse(parsed.expires_at))
    || Number.isNaN(Date.parse(parsed.activated_at)) || !Number.isSafeInteger(parsed.days) || (parsed.destination_copy !== null && typeof parsed.destination_copy !== "string")
    || (parsed.pending_copy !== undefined && parsed.pending_copy !== null && !(typeof parsed.pending_copy === "string" && GENERATION_ID.test(parsed.pending_copy)))) {
    throw new Error("retention-seal-malformed: the seal of the legacy archive is not readable, and is not replaced");
  }
  return parsed as Seal;
}

/** The standing seal, or a new one made now. Never rewrites an existing one, so copying the archive again cannot refresh its expiry. */
export function registerSeal(staging: string, days: number, now: Date): Seal {
  const standing = readSeal(staging);
  if (standing !== null) return standing;
  const seal: Seal = { version: 1, activated_at: now.toISOString(), days, expires_at: expiryOf(now, days).toISOString(), destination_copy: null };
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  writeFileSync(join(staging, SEAL_FILE), `${JSON.stringify(seal, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return seal;
}

/** When the legacy archive expires: the sealed date, or sooner when the owner has since chosen fewer days. Never later. */
export function sealExpiry(seal: Seal, days: number): Date {
  return new Date(Math.min(Date.parse(seal.expires_at), expiryOf(new Date(seal.activated_at), days).getTime()));
}

/** The id the destination's old copy has, or is to have: the verified one, else the one chosen before the move was run. Null before either. */
export const legacyIdOf = (seal: Seal): string | null => seal.destination_copy ?? seal.pending_copy ?? null;

/** Replace the seal whole and atomically (a torn seal is never replaced, so it must never be torn): a temporary file, flushed, then renamed over it. */
function writeSeal(staging: string, seal: Seal): void {
  const file = join(staging, SEAL_FILE);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(seal, null, 2)}\n`, { mode: 0o600 });
  const descriptor = openSync(temporary, "r+");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, file);
}

/**
 * Move the destination's old single-directory copy under a generation id of its own, by the declared `seal_argv`, once. It then ages
 * and expires as a generation (its date is the seal's: see `enforceRetention`). A destination with no `seal_argv`, no old copy, or a
 * copy already sealed is left as it was.
 *
 * THE ID IS CHOSEN AND WRITTEN BEFORE THE MOVE. The command is external and can complete in a process that then dies, and the old copy has
 * no top-level names afterwards: if its identity were only recorded after the command, a crash between the two would lose it and the id
 * would be aged as an ordinary generation. So `pending_copy` is in the seal, flushed, before the command runs, and `destination_copy` is
 * written only when the destination lists the id and no longer shows the old names.
 *
 * A RUN THAT FINDS AN INTENT RECONCILES IT, and never chooses another id:
 *   * old names gone, id listed:     the move happened; it is recorded, and the command is not run again;
 *   * old names present, id unseen:  the move did not happen (checked, not assumed); the command is run once more with the same id;
 *   * old names present, id seen:    a partial move; nothing is replayed, and the seal says so (it stays pending for a person);
 *   * old names gone, id not listed: the old copy cannot be found anywhere; nothing is replayed or replaced, and the seal says so.
 */
export async function sealLegacyCopy(t: RetentionTransport, args: { staging: string; seal: Seal; now: Date }): Promise<Seal> {
  if (args.seal.destination_copy !== null || !Array.isArray(t.entry.seal_argv)) return args.seal;
  const showsOld = (inventory: { list: Listing; held: Listing | null }): boolean =>
    [...inventory.list.others, ...(inventory.held?.others ?? [])].some(name => LEGACY_NAMES.includes(name));
  const before = await inventoryOf(t);
  let seal = args.seal;
  let id = seal.pending_copy ?? null;
  let run = false;
  if (id === null) {
    if (!showsOld(before)) return seal;
    // An id no copy of the destination already has (a copy made in the same second is a copy of its own).
    let at = args.now;
    while (before.list.ids.includes(generationIdOf(at)) || before.held?.ids.includes(generationIdOf(at))) at = new Date(at.getTime() + 1000);
    id = generationIdOf(at);
    seal = { ...seal, pending_copy: id };
    writeSeal(args.staging, seal);
    run = true;
  } else if (showsOld(before)) {
    if (before.list.ids.includes(id) || before.held?.ids.includes(id)) {
      throw new TransportFailure("seal", `the destination shows both its old single-directory copy and the intended id ${id}: a partial move, not replayed`);
    }
    run = true;
  } else if (!before.list.ids.includes(id)) {
    throw new TransportFailure("seal", `the destination shows neither its old single-directory copy nor the intended id ${id}: it is not replaced by another id`);
  }
  let after = before;
  if (run) {
    try { await (t.exec ?? spawnExec)(fill(t.entry.seal_argv, { destination: t.entry.destination ?? "", generation: id }), false); }
    catch (error) { throw new TransportFailure("seal", (error as Error).message); }
    after = await inventoryOf(t);
  }
  if (!after.list.ids.includes(id) || showsOld(after)) {
    throw new TransportFailure("seal", "the destination does not list the sealed copy, or still shows its old single-directory copy, after the seal command");
  }
  const { pending_copy: _chosen, ...rest } = seal;
  const sealed: Seal = { ...rest, destination_copy: id };
  writeSeal(args.staging, sealed);
  return sealed;
}

/**
 * Why the legacy archive's state, on this box and at the destination, is not certain, one sentence each. Empty only when the seal was
 * made and read, the move of the destination's old copy (if any was begun) was carried through, and nothing is left in `<staging>/dump`
 * that is neither expired nor accounted for as a pending outcome. Any of them means no deletion may be called fully expired.
 */
export function legacyUncertainty(args: { staging: string; sealFailure: unknown; local: Outcome | null }): string[] {
  const reasons: string[] = [];
  if (args.sealFailure !== null) {
    const said = (args.sealFailure as { message?: unknown }).message;
    reasons.push(`the legacy archive could not be sealed, read or moved (${typeof said === "string" ? said.slice(0, 160) : "operation failed"}), so its copies are not accounted for`);
  }
  if (args.local === null && existsSync(join(args.staging, "dump"))) {
    reasons.push("this box still holds a dump directory the legacy handling did not account for");
  }
  return reasons;
}

/**
 * The dump Git repository on this box (`<staging>/dump`, the one a generation layout no longer sends), as an outcome: pending until the
 * seal's date, then removed and looked for again. Null when there is none. It is ONLY for a staging directory whose upload gives each
 * copy a place of its own: under the single-directory layout that repository is the live dump.
 */
export function expireLocalLegacy(args: { staging: string; seal: Seal; days: number; now: Date }): Outcome | null {
  const dir = join(args.staging, "dump");
  if (!existsSync(join(dir, ".git"))) return null;
  const expires = sealExpiry(args.seal, args.days);
  const base = { id: LOCAL_LEGACY_ID, expires_at: expires.toISOString(), erasure_generation: null };
  if (expires.getTime() > args.now.getTime()) return { ...base, state: "pending" };
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (error) { return { ...base, state: "retention_blocked", reason: `the legacy dump repository could not be removed: ${String((error as { code?: unknown }).code ?? "unknown error")}` }; }
  return existsSync(dir)
    ? { ...base, state: "retention_blocked", reason: "the legacy dump repository is still on this box after its removal" }
    : { ...base, state: "expired" };
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
export async function enforceRetention(t: RetentionTransport, args: {
  days: number; now: Date;
  /** The destination's old copy, moved under `id` by `sealLegacyCopy`, and the explicit date it expires on (the seal's). */
  sealed?: { id: string; expires_at: Date };
}): Promise<{ outcomes: Outcome[]; foreign: number; inventory: Inventory }> {
  const exec = t.exec ?? spawnExec;
  const first = await inventoryOf(t);
  // What the destination retains but no longer lists (a version, trash) is a copy too: it is read, aged and asked for like a listed one.
  const ids = [...new Set([...first.list.ids, ...(first.held?.ids ?? [])])].sort();
  // One at a time: a destination over the network is asked for one manifest, not for as many as it holds at once.
  const generations: Generation[] = [];
  for (const id of ids) generations.push(await readGeneration(t, id));
  const outcomes = new Map<string, Outcome>();
  const bases = new Map<string, Omit<Outcome, "state" | "reason">>();
  const due: Generation[] = [];
  for (const one of generations) {
    const explicit = args.sealed !== undefined && args.sealed.id === one.id ? args.sealed.expires_at : null;
    const own = one.readable && one.at !== null ? expiryOf(one.at, args.days) : null;
    if (own === null && explicit === null) {
      outcomes.set(one.id, { id: one.id, state: "retention_unverified", expires_at: null, erasure_generation: null,
        reason: first.list.ids.includes(one.id) ? "its manifest cannot be read, so its age is not known"
          : "the destination retains it outside its listing, and its age is not known" });
      continue;
    }
    // The sealed legacy copy holds every earlier dump: it is history of every deletion, whatever generation its last manifest names.
    const expires = new Date(Math.min(...[own, explicit].filter((date): date is Date => date !== null).map(date => date.getTime())));
    const base = { id: one.id, expires_at: expires.toISOString(), erasure_generation: explicit === null ? one.erasure_generation : null };
    bases.set(one.id, base);
    if (expires.getTime() <= args.now.getTime()) due.push(one); else outcomes.set(one.id, { ...base, state: "pending" });
  }
  const asked: string[] = [];
  for (const one of due) {
    const base = bases.get(one.id)!;
    try {
      await exec(fill(t.entry.expire_argv ?? [], { destination: t.entry.destination ?? "", generation: one.id }), false);
      asked.push(one.id);
      outcomes.set(one.id, { ...base, state: "pending" });
    } catch (error) {
      outcomes.set(one.id, { ...base, state: "retention_blocked", reason: `the expiry command failed: ${(error as Error).message.slice(0, 120)}` });
    }
  }
  let last = first;
  if (asked.length > 0) {
    // ABSENCE IS THE ANSWER: a removal the destination reported is believed only when it no longer lists the copy and, where it declares
    // an inventory of what it physically retains, no longer retains it either.
    last = await inventoryOf(t);
    for (const id of asked) {
      const standing = outcomes.get(id)!;
      const reason = last.list.ids.includes(id) ? "the destination still lists the copy after its expiry command"
        : last.held?.ids.includes(id) ? "the destination still retains the copy (a version, trash or replica) after its expiry command" : null;
      outcomes.set(id, reason === null ? { ...standing, state: "expired" } : { ...standing, state: "retention_blocked", reason });
    }
  }
  const others = [...last.list.others, ...(last.held?.others ?? [])];
  return {
    outcomes: [...outcomes.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    foreign: first.list.others.length,
    inventory: {
      retained: last.held !== null,
      unaccounted: (last.held?.others ?? []).filter(name => !LEGACY_NAMES.includes(name)).length,
      legacy: others.some(name => LEGACY_NAMES.includes(name)),
    },
  };
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
      return ru
        ? "Более ранние резервные копии, которые Hub мог перечислить, истекли и проверены; журналы WAL базы данных и снимки файловой системы Hub не отслеживает."
        : "The earlier backup copies the Hub could inventory have expired and been verified gone; database WAL archives and file-system snapshots are outside what it tracks.";
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
 * What stands between the enumerated generations being gone and ALL the historical copies being gone, one sentence each. Empty only when
 * the destination answered a physical inventory (versions, trash, replicas) that holds nothing it cannot account for and shows no old
 * single-directory copy. No inventory at all (a caller that did not look) is a gap of its own: nothing is assumed clear.
 */
export function inventoryGaps(inventory: Inventory | null | undefined): string[] {
  if (inventory === null || inventory === undefined) {
    return ["enumerated generations are tracked, but legacy dump history, destination versions and retained storage have not been inventoried and verified expired"];
  }
  const gaps: string[] = [];
  if (!inventory.retained) gaps.push("the destination declares no retained_argv, so its versions, trash and replicas are not inventoried");
  if (inventory.unaccounted > 0) gaps.push(`the destination retains ${inventory.unaccounted} entr${inventory.unaccounted === 1 ? "y" : "ies"} that ${inventory.unaccounted === 1 ? "is" : "are"} not a copy this job made`);
  if (inventory.legacy) gaps.push("the destination still holds its old single-directory copy (declare seal_argv so it is sealed and expired, or move it under a generation id)");
  return gaps;
}

/**
 * Give every confirmed deletion the account of its historical copies that the configuration and the transport support now.
 *   * no retention configured: `not_configured`, nothing expires;
 *   * a transport that cannot enumerate and expire: `retention_unverified`, with the reason, and the copies said to remain;
 *   * a transport that can (`outcomes` is what `enforceRetention` found, with the box's own legacy repository among them, and `inventory`
 *     what the destination physically retains): the copies that are this deletion's history, each as it stands. `historical_copies_expired`
 *     needs every one expired AND an inventory with no gap (`inventoryGaps`); a gap keeps `retention_unverified`, with the reasons.
 * A deletion whose copies were all verified expired stays so. Returns how many accounts were recorded.
 */
export async function trackRetention(store: StoreLike, entry: Pick<RunEntry, "id"> & Partial<TransportEntry> | null, input: {
  days: number | null; outcomes: readonly Outcome[] | null; inventory?: Inventory | null;
  /** Reasons the legacy archive or this box's own inventory is uncertain (`legacyUncertainty`): each is a gap, and no deletion is called fully expired past one. */
  uncertain?: readonly string[];
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
      let account = accountForDeletion(deletion, input.outcomes, input.days);
      if (account.detail.copies === 0) {
        // Copies shown gone on an earlier pass are not listed again, and are not forgotten: a deletion whose every recorded copy is
        // `expired` stays so, instead of flapping back to "no copy found" the run after the last one went.
        const earlier = await receiptsOf(store, deletion.id, { historical: true });
        if (earlier.length > 0 && earlier.every(one => one.state === "expired")) account = { ...account, state: "historical_copies_expired", until: null };
      }
      const gaps = [...inventoryGaps(input.inventory), ...(input.uncertain ?? [])];
      // A gap never lifts a blocked or unverified copy, and never lets enumerated generations stand for all the copies; with none, the
      // account of the copies is the account of the deletion (a copy still pending is `tracking`, with its date).
      state = gaps.length === 0 || account.state === "retention_blocked" || account.state === "retention_unverified" ? account.state : "retention_unverified";
      until = account.until; generations = account.generations;
      detail = { ...account.detail, generation_state: account.state, reason: gaps.length === 0 ? "every copy this job and the destination's inventory can show is accounted for" : gaps.join("; "),
        outside_inventory: "database WAL archives and file-system snapshots are not enumerated or expired by the Hub" };
    }
    // A verdict that says what the last one said, with no copy to account for, is not written again.
    if ((generations === undefined || state === "historical_copies_expired") && state === deletion.retention_state) continue;
    const answer = await recordRetention(store, deletion.id, { state, until, detail, ...(generations === undefined ? {} : { generations }) });
    if (answer === "recorded") recorded += 1;
  }
  return recorded;
}
