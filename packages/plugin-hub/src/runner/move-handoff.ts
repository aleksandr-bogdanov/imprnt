import { createHash } from "node:crypto";
import type { NativeSessionPort } from "../adapters/types.ts";
import type { BundleLimits } from "../transfer/bundle.ts";
import type { StoreLike } from "../store/connect.ts";
import { MOVE_MAX_FILE_BYTES, blockMove, unblockMove, type MoveRow } from "../store/moves.ts";

/**
 * What the source's export and the destination's import of ONE conversation's native session need from whoever runs them, written as
 * an injection contract and nothing more: `move-export.ts` and `move-import.ts` call the store and the native port, and every
 * fact they cannot know themselves is a member of `HandoffWorld` or an argument, never a default.
 *
 * THE RUNNER (`run.ts`) SUPPLIES THE WORLD AND CALLS THESE: `exportSource` from the same serialized look that saw `drained` (its proof is an
 * ARGUMENT, `ProvenDrain`, from that look's own fence and quiet), `prepareDestination` and `importDestination` from the watch for a move
 * whose destination it is, and `cleanupCopies` on every read pass of the watch. After activation the hub's registry step
 * (`hub/moves.ts`) and the destination's serve (`move-serve.ts`) finish the move. The functions decide nothing about retrying, falling back
 * to a fresh session or choosing between owners: every refusal is a named block or a `waiting` answer, and the owner's withdrawal is the only
 * way out of a block.
 *
 * WHAT THE CALLER MUST SUPPLY, and what each missing piece makes the handoff do:
 * - `exclusive`: one in-process chain per conversation id, NOT re-entrant (a call from inside the callback of the same key waits for
 *   itself). Every function here that touches the session directory takes it exactly once; the ones that run inside it say so.
 * - `build`: a FRESH read of the engine build (never a cache): the version is what the adapter's tables are keyed by.
 * - `scope` (source): the proof that what leaves is exactly the native session. Absent, not about this move or not bound to the
 *   export generation standing now, the export is refused (`scope_unproven`): nothing here knows whether a conversation depends on a
 *   workspace or a repository, and this slice carries neither. A dependency the caller names and nothing here carries or verifies is a
 *   `ScopeRefusal` (`scope_unsupported`); the runner's (`move-scope.ts`) names a declared repository, vault or zone, files found in the
 *   person's own tree and a default instruction file, and never reads that the absence of a declaration means there is nothing.
 *   `materializeRepo` and a proof of a verified sync or snapshot are the workspace slice's. It is a
 *   function of the move row it is given and is called again on a fresh row at every re-check.
 * - `profile` (destination): an explicit binding of the destination's profile to this move. There is no default and no
 *   derivation: absent or not about this move, the preflight is refused (`dest_profile_unbound`). A profile that lists configuration
 *   references nothing compares (`move-profile.ts`, `unverified`) is refused by name on both sides (`dest_profile_unverified`,
 *   `profile_unverified`).
 * - `idle`: no live session and no ledger record of the agent in this incarnation. It gates every removal of a destination copy.
 */

/** The only limits a native move uses: one transcript, at most the store's own file limit. */
export const MOVE_NATIVE_LIMITS: BundleLimits = { maxFiles: 1, maxFileBytes: MOVE_MAX_FILE_BYTES, maxTotalBytes: MOVE_MAX_FILE_BYTES };

/** What one look did, and who has to move next: never a verdict on the move. `done` means nothing is owed by this side at this stage. */
export interface HandoffStep {
  state: "done" | "waiting" | "blocked";
  reason: string;
  detail?: Record<string, unknown>;
}
export const done = (reason: string, detail?: Record<string, unknown>): HandoffStep => ({ state: "done", reason, ...(detail ? { detail } : {}) });
export const waiting = (reason: string, detail?: Record<string, unknown>): HandoffStep => ({ state: "waiting", reason, ...(detail ? { detail } : {}) });
export const blocked = (reason: string, detail?: Record<string, unknown>): HandoffStep => ({ state: "blocked", reason, ...(detail ? { detail } : {}) });

/** The engine this host would run: what `capabilities()` reports now, read fresh. */
export interface EngineBuild { version: string; capabilities: Record<string, unknown> }

/**
 * The source's proof that nothing but the native session leaves with this conversation. It is an assertion of the caller's, bound
 * to the move by name so a proof for another move or conversation is refused, and to the EXPORT GENERATION it was taken for
 * (`generation`: the drain's, `exportGenerationOf(move)`), so a proof kept from an earlier drain is refused. Its `basis` is kept in
 * the sealed manifest so the owner can read what was relied on. It is not computed here and it is not a statement about workspaces in
 * general. `exportSource` asks for it again after every await that matters (see there) and seals the one it was last given.
 */
export interface ScopeProof { move: string; conversation: string; agent: string; generation: number; carries: "native-only"; basis: string }

/**
 * The caller's answer that the conversation depends on something this move does not carry (a repository's working copy, say): the export
 * is refused BEFORE anything is read, stored or released, and the owner reads `refused` (a code-like word) and `detail` (names, never contents)
 * in the source's block `scope_unsupported`. It is a named refusal and never a fallback: the move waits for the owner to withdraw it.
 */
export interface ScopeRefusal { refused: string; detail?: Record<string, unknown> }

/** The destination's profile for this move, supplied. `basis` says where the caller got it; the preflight records it and the source compares it by section. */
export interface ProfileBinding { move: string; agent: string; runner: string; machine: string; profile: Record<string, unknown>; basis: string }

/**
 * The source's own proof, taken from the same serialized observation that saw the store answer `drained`, never remembered: its
 * incarnation owns the drain (the store says so in `move.drain`), its agent is FENCED (takes no new claim and feeds nothing) and
 * QUIET (nothing owned, no child, no resident session). Whatever proves these is the drain's, which is in correction; `exportSource`
 * trusts nothing else and asks for both at the start of every look, again after the transcript was read and again immediately before the release.
 */
export interface ProvenDrain { fenced(agent: string): boolean; quiet(agent: string): boolean }

export interface HandoffWorld {
  store: StoreLike;
  runner: string;
  /** This process's incarnation: the one the store holds as current for `runner` on `machine`. */
  incarnation: string;
  machine: string;
  /** The adapter's native session port, or null for an engine that has none this hub can move. */
  port(adapter: string): NativeSessionPort | null;
  build(agent: string): Promise<EngineBuild | null>;
  /**
   * The conversation's session directory on THIS machine, as the launch would use it. Absolute and already normalized, NOT necessarily
   * a realpath: a long alias that resolves through links to a short real path is a valid answer. The string is recorded as given (twice, in
   * `verified` and `promote_intent`; it is identity and is never clipped), so its length counts against the copy's evidence budget
   * (`lifetimeBytes`); the adapter bounds the real path it resolves to, not this string. One whose import cannot fit is refused by name.
   */
  sessionDir(move: MoveRow): string;
  scope(move: MoveRow): ScopeProof | ScopeRefusal | null;
  profile(move: MoveRow): ProfileBinding | null;
  /**
   * The SOURCE's own profile of the agent, in the form `profile` binds for the destination (`move-profile.ts`). When supplied, the export asks
   * it again at every look and refuses a destination whose recorded profile is not equal (`profile_mismatch`, naming the sections, never their
   * values); null is `source_profile_unbound`. Optional only so that a caller with no registry (a test of the store half) can leave it out: the
   * runner always supplies it.
   */
  sourceProfile?(move: MoveRow): Record<string, unknown> | null;
  /**
   * DESTINATION: the default instruction files (`CLAUDE.md`, `CLAUDE.local.md` of the vault root) the agent's launch would read ON THIS
   * MACHINE, by name (`defaultInstructionsOf`, `move-scope.ts`): their presence is a fact of the machine, so it cannot be a section of the
   * machine-neutral profile the hub and the serve compare. Nothing compares their content (it is never read), so one that exists is the
   * preflight's refusal `dest_local_unverified`, and `null` (it cannot be told) is that refusal too. Optional only so that a caller with no
   * file system (a test of the store half) can leave it out: the runner always supplies it.
   */
  localInstructions?(move: MoveRow): string[] | null;
  /** Non-re-entrant, per conversation id. */
  exclusive<T>(conversation: string, fn: () => Promise<T>): Promise<T>;
  idle(agent: string): boolean;
  /** Observability only: nothing reads it back. A throw here propagates, which is how a test stands for a crash after a step. */
  say(kind: string, detail: Record<string, unknown>): Promise<void>;
}

export const who = (w: HandoffWorld) => ({ runner: w.runner, incarnation: w.incarnation });

/**
 * THE STORE'S WORD, NOW, that this process is still the runner's current incarnation. Asked under the conversation's lock right before anything
 * physical happens to its session directory (a stage written by an import, a stage discarded by a cleanup), exactly as the launch asks it under the
 * same lock (`run.ts`, `spawn`): a process that was replaced while it waited for the lock writes and removes nothing. The store checks the
 * same thing at every step it records, but a physical act happens between two steps.
 */
export async function isCurrent(w: HandoffWorld): Promise<boolean> {
  const [row] = (await w.store.sql`select incarnation from runner_incarnation where runner = ${w.runner}`) as unknown as { incarnation: string }[];
  return row !== undefined && row.incarnation === w.incarnation;
}

/** Say a thing once per world, so a look that repeats on every notification does not repeat itself in the log. */
const said = new WeakMap<HandoffWorld, Set<string>>();
export async function sayOnce(w: HandoffWorld, key: string, kind: string, detail: Record<string, unknown>): Promise<void> {
  const seen = said.get(w) ?? new Set<string>();
  said.set(w, seen);
  if (seen.has(key)) return;
  seen.add(key);
  await w.say(kind, detail);
}

/**
 * A path or a message that goes into a store block or evidence (2 KiB bounded), cut so one long name cannot make the write invalid. DIAGNOSTICS
 * ONLY: nothing that decides what a removal may touch (a session directory, a receipt, a digest) is ever passed through here. `to` is a budget
 * in the bytes the text weighs as jsonb prints it (an escaped control character is six, a multibyte character its UTF-8 bytes), and the cut is
 * made between whole code points, never inside a surrogate pair (jsonb refuses the lone half a UTF-16 cut leaves: the write would throw instead
 * of recording the name). A text that fits is returned as it is.
 */
export function clip(text: string | undefined, to = 240): string | null {
  if (text === undefined) return null;
  const weigh = (part: string) => Buffer.byteLength(JSON.stringify(part)) - 2;
  if (weigh(text) <= to) return text;
  let kept = "";
  let used = 0;
  for (const point of text) {
    used += weigh(point);
    if (used > to) break;
    kept += point;
  }
  return `${kept}...`;
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isHex64 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/**
 * The size in bytes of `value` as the store's limits measure it: `octet_length(value::jsonb::text)`, which prints `": "` after a key and
 * `", "` between members (a byte more per member than `JSON.stringify`) and counts a character by its UTF-8 bytes. Exact for what a
 * handoff writes (strings, integers, booleans, null, objects, arrays); the store's column and routine limits are all stated this way.
 */
export function jsonbBytes(value: unknown): number {
  if (Array.isArray(value)) return 2 + value.reduce<number>((sum, one) => sum + jsonbBytes(one), 0) + 2 * Math.max(0, value.length - 1);
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, one]) => one !== undefined);
    return 2 + entries.reduce((sum, [key, one]) => sum + Buffer.byteLength(JSON.stringify(key)) + 2 + jsonbBytes(one), 0) + 2 * Math.max(0, entries.length - 1);
  }
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}

/** What a failure report may weigh (`hub_move_import_failed`: its detail) and what a copy's evidence may weigh in all (`move_copy.evidence`). */
export const FAILURE_DETAIL_LIMIT = 2048;
export const COPY_EVIDENCE_LIMIT = 8192;

/** What `copyRemoved` is told a removal was: the stage discarded by its receipt, the directory observed absent, or nothing ever written. */
export type Removal = "stage" | "absent" | "nothing-written";

/** The report cleanup gives `copyRemoved` for a copy. The only builder of it: the budget below weighs this very object, so the two cannot drift. */
export const removalReport = (staging: string, removed: Removal, stageGeneration: string | null, incarnation: string) => ({
  staging, removed, stage_generation: stageGeneration, proof: { activated: false, placed_here: false, live_child: false, other_claims: 0, incarnation },
});

/** The `failure` record `hub_move_import_failed` merges into a copy's evidence (`by` is the incarnation that reports). */
export const failureRecord = (code: string, detail: Record<string, unknown>, incarnation: string) => ({ failure: { code, detail, by: incarnation } });

/** The store's receipt of a stage names its generation as 32 hex characters (`randomBytes(16)`): what a receipt that does not exist yet is given. */
const STAGE_GENERATION_WIDTH = "0".repeat(32);

/** Where a copy's evidence ends, for `lifetimeBytes`: its staging identity, who reports, and the removal (by default the heaviest word, a receipt's width). */
export interface LifetimeEnd { staging: string; incarnation: string; removed?: Removal; generation?: string | null }

/**
 * THE ONE LIFETIME BUDGET of a copy's evidence. `move_copy.evidence` is checked as a whole (8 KiB, `jsonb::text`) every time a routine merges
 * into it, and the last merge of a copy's life is `copyRemoved`'s `removed` record (the report plus the `by` the store adds). So a step is
 * only safe to commit when the evidence it leaves, merged as the store merges (`||`: a later key replaces), STILL HAS ROOM for what can
 * follow it, up to and including that removal: otherwise the copy could be failed or discarded and then never be reported removed, its location
 * occupied for good. `later` lists, in order, what is still to be merged (a `promote_intent` and then either `promoted` or a failure).
 */
export function lifetimeBytes(evidence: Record<string, unknown>, later: Record<string, unknown>[], end: LifetimeEnd): number {
  const merged: Record<string, unknown> = Object.assign({}, evidence, ...later);
  const report = removalReport(end.staging, end.removed ?? "nothing-written", end.generation === undefined ? STAGE_GENERATION_WIDTH : end.generation, end.incarnation);
  return jsonbBytes({ ...merged, removed: { ...report, by: end.incarnation } });
}
export const fitsLifetime = (evidence: Record<string, unknown>, later: Record<string, unknown>[], end: LifetimeEnd): boolean =>
  lifetimeBytes(evidence, later, end) <= COPY_EVIDENCE_LIMIT;

/** Structural equality of two JSON values, key order ignored (a jsonb read does not keep the order a write had). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((one, at) => sameJson(one, b[at]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
  }
  return false;
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Put THIS side's own name on the stage and say so. The store never replaces another party's block (`occupied`): then nothing is
 * set and the answer is a wait that names it. Every other answer that is not a block is the stage moving on and is a wait too.
 */
export async function raise(w: HandoffWorld, id: string, code: string, detail: Record<string, unknown>): Promise<HandoffStep> {
  const answer = await blockMove(w.store, id, who(w), code, detail);
  if (answer === "blocked" || answer === "replay") return blocked(code, detail);
  if (answer === "occupied") {
    await sayOnce(w, `occupied:${id}:${code}`, "move.block-occupied", { move: id, code, ...detail });
    return waiting("block-occupied", { code });
  }
  return waiting(answer, { code });
}

/** Clear the block this side set, but only when it is one of `codes` (its own export or preflight codes): never another party's, never the drain's. */
export async function clearOwn(w: HandoffWorld, move: MoveRow, side: "source" | "dest", codes: ReadonlySet<string>): Promise<void> {
  if (move.block && move.block.by === side && codes.has(move.block.code)) await unblockMove(w.store, move.id, who(w), move.block.code);
}
