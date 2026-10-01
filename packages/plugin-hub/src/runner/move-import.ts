import { lstatSync } from "node:fs";
import { NativeRefusal, type NativeImport, type NativeSessionPort, type NativeSide } from "../adapters/types.ts";
import { buildBundle, TransferError, type Bundle } from "../transfer/bundle.ts";
import { errnoOf, type StageReceipt } from "../transfer/workspace.ts";
import {
  MoveBlobsGone, activateMove, advanceImport, beginImport, checkpointOf, copiesAtLocation, copiesDueForCleanup, copiesOf, copyRemoved, destReady, failImport,
  readBlobs, readMove, type DestFacts, type MoveBlob, type MoveCopyRow, type MoveRow,
} from "../store/moves.ts";
import { nativeSideOf } from "./move-export.ts";
import {
  COPY_EVIDENCE_LIMIT, FAILURE_DETAIL_LIMIT, MOVE_NATIVE_LIMITS, blocked, clearOwn, clip, done, failureRecord, fitsLifetime, isHex64, isRecord, jsonbBytes,
  lifetimeBytes, raise, removalReport, sameJson, sayOnce, waiting, who,
  type HandoffStep, type HandoffWorld, type ProfileBinding, type Removal,
} from "./move-handoff.ts";

/**
 * The destination's half of one native handoff: preflight (`prepareDestination`), the exclusive import and activation
 * (`importDestination`) and the removal of copies the store owes a cleanup (`cleanupCopies`). Nothing is wired to call any of them
 * (see `move-handoff.ts`). It never serves, never composes a relocation note and never touches the registry.
 *
 * EVERY WRITE TO A SESSION DIRECTORY IS UNDER `w.exclusive(conversation)`, TAKEN ONCE. `importDestination` and `cleanupCopies` take it
 * themselves and are called from outside it; what they need to do inside it is done by `...Locked` functions that demand the `Held`
 * token only `underLock` makes, so an import that has to remove an earlier copy of the same location (`cleanup-pending`) calls the
 * locked cleanup directly and never asks the same key again (the lock is not re-entrant).
 *
 * WHAT IS A PROOF OF "NOTHING WRITTEN" and what is not. The store's copy evidence is the only memory that survives a crash, so the
 * order of the import is fixed and every removal decision reads it, never the answer of a single call:
 * - no file can exist in the launch directory before `promote_intent` is committed (the step is taken first, after the directory was
 *   seen absent); a copy whose evidence has no `promote_intent` has therefore written nothing, whatever failed;
 * - from `promote_intent` on, a failure cannot show that nothing was ever written: an earlier call, in a process that died, may have
 *   staged a complete directory, and the adapter's `NativeRefusal` of this call (a collision with it, say) says nothing about that.
 *   The failure is recorded `written: "unknown"` with what the directory looks like now, and removal then needs the receipt (the
 *   stage `promoted` recorded, discarded by receipt) or the directory's observed absence. A directory that is there with no receipt is
 *   LEFT, the copy stays `cleanup_due` and the location stays `cleanup-pending`: recovering such a stage is an operator's, not done here;
 * - `written` in a failure's detail is for the owner to read. Nothing here decides anything from it;
 * - A STAGE THIS CALL MADE IS NOT LOST TO A FAILURE AFTER IT. Its receipt (whole, never clipped) goes into the failure's evidence when
 *   the store's limits, computed as the store measures them, allow it, and the cleanup then discards by it; when they do not, the
 *   failure says `receipt_unrecorded` and the copy keeps the gate above. A withdrawal that lands before anything could record it
 *   makes the same call remove the stage by the receipt it holds, through `cleanupLocked`, so every guard is asked again;
 * - A REMOVAL IS NEVER DECIDED FROM THE PATH THE RULE GIVES NOW ALONE: it is compared with what the import recorded (the path
 *   `promote_intent` names, the receipt's real path, the destination's facts) and any difference leaves the copy (`session-dir-changed`);
 * - a started conversation's sealed export is imported only when its sealed pair, the build now, the recorded facts and the adapter's
 *   answer for this directory are one and the same side. A `launched` one is not imported (its named gate is the source's);
 * - THE COPY'S EVIDENCE HAS ONE LIFETIME BUDGET (`lifetimeBytes`): the column is bounded as a whole, and the last thing merged into it is the
 *   removal's own record. Nothing is committed (`verified`, `promote_intent`), and no stage is made, unless the evidence left still has room
 *   for the whole rest of the copy's life: the `promoted` evidence or the heaviest failure that carries the stage's receipt, and then the
 *   `removed` record with the `by` the store adds. An import that cannot is refused BEFORE anything is staged, by a small named failure
 *   (`native_evidence_budget`). A removal is likewise refused before its physical discard when its own report could not be committed
 *   (`evidence-budget`, left and named: a copy that was recorded before this budget existed is never discarded and then failed to be reported).
 *   Paths in the evidence are never clipped to make anything fit: the session directory the launch would use is recorded as given (a long
 *   alias that resolves to a short real path weighs what it weighs; the adapter bounds the real path, not this string).
 */

/** The block codes this side sets at preflight and clears itself. */
export const PREFLIGHT_CODES: ReadonlySet<string> = new Set([
  "dest_profile_unbound", "dest_build_unknown", "dest_facts_invalid", "native_port_missing", "native_destination_invalid",
  "native_build_unvalidated", "native_locator_unsupported_path",
]);

declare const heldBrand: unique symbol;
/** Proof that the conversation's lock is held by the caller. Only `underLock` makes one. */
interface Held { readonly [heldBrand]: true; readonly conversation: string }
const underLock = <T>(w: HandoffWorld, conversation: string, fn: (held: Held) => Promise<T>): Promise<T> => w.exclusive(conversation, () => fn({ conversation } as Held));

function dirState(path: string): "absent" | "present" | "unreadable" {
  try { lstatSync(path); return "present"; } catch (error) { return errnoOf(error) === "ENOENT" ? "absent" : "unreadable"; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------------------------------------------------

function profileBound(bound: ProfileBinding | null, move: MoveRow, w: HandoffWorld): bound is ProfileBinding {
  return bound !== null && bound.move === move.id && bound.agent === move.agent && bound.runner === move.dest_runner && bound.runner === w.runner &&
    bound.machine === move.dest_machine && bound.machine === w.machine && isRecord(bound.profile) && Object.keys(bound.profile).length > 0 &&
    typeof bound.basis === "string" && bound.basis.trim() !== "";
}

/**
 * A refusal of where a started session would go. It is this side's BLOCK and `destReady` is NOT called, so the source can never
 * release on facts that no longer hold. But another party's block is never replaced (`raise` answers `block-occupied`), and the
 * facts the move holds may be the ones this refusal supersedes (a preflight made while the conversation was still `new`, or an
 * earlier path that was accepted): the owner would then read the other party's reason and the facts would stay what they were. So the
 * refusal is also recorded IN THE FACTS (`native: null`, `native_refusal: { code, path }`, which makes the source's next look block
 * under ITS OWN `native_dest_refused` and name this code). No block of anyone's is touched; and the next preflight that is accepted
 * replaces the facts again, so the source releases.
 */
async function refuseNative(w: HandoffWorld, id: string, code: string, detail: Record<string, unknown>, facts: Pick<DestFacts, "profile" | "capabilities" | "profile_basis">): Promise<HandoffStep> {
  const step = await raise(w, id, code, detail);
  if (step.reason !== "block-occupied") return step;
  const answer = await destReady(w.store, id, who(w), { ...facts, native: null, native_refusal: { code, path: typeof detail.path === "string" ? detail.path : null } });
  if (answer === "ready") await w.say("move.dest-refusal-recorded", { move: id, code });
  return waiting("block-occupied", { code, recorded: answer === "ready" || answer === "replay" });
}

/**
 * The destination's preflight for a move in `waiting`: the supplied profile binding, a fresh read of the engine build, and (for a
 * conversation the engine has started, and for one it only launched: the source decides what that means, see `move-export.ts`) the
 * adapter's own answer for where the session would go. A path the adapter refuses is this side's BLOCK and `destReady` is NOT called,
 * so the source can never release (`releaseSource` refuses under a block, and a source that finds another party's block exports
 * nothing); where a block of another party stands, see `refuseNative`. Safe to repeat; the facts are replaced only when they changed,
 * and they are NOT final until the release: a conversation the engine started after an earlier preflight needs a new one, which the
 * source's `native_dest_facts_missing` asks for.
 */
export async function prepareDestination(w: HandoffWorld, id: string): Promise<HandoffStep> {
  const move = await readMove(w.store, id);
  if (!move) return waiting("unknown-move");
  if (move.stage !== "waiting") return done(`stage:${move.stage}`);
  if (move.dest_runner !== w.runner || move.dest_machine !== w.machine) return waiting("not-destination");

  const bound = w.profile(move);
  if (!profileBound(bound, move, w)) return raise(w, id, "dest_profile_unbound", { reason: bound ? "mismatch" : "missing" });
  const build = await w.build(move.agent);
  if (!build) return raise(w, id, "dest_build_unknown", {});
  const checkpoint = await checkpointOf(w.store, move.conversation_id);
  if (!checkpoint) return waiting("conversation-missing");

  // A conversation the engine never started carries no file, so no path is asked about: its first launch here is a fresh one.
  let native: NativeSide | null = null;
  const facts = { profile: bound.profile, capabilities: build.capabilities, profile_basis: bound.basis };
  if (checkpoint.native_state !== "new") {
    const port = w.port(move.adapter);
    if (!port) return refuseNative(w, id, "native_port_missing", { adapter: move.adapter }, facts);
    try { native = port.destination({ sessionDir: w.sessionDir(move), version: build.version }); } catch (error) {
      if (error instanceof NativeRefusal) return refuseNative(w, id, error.code, { path: clip(error.path) }, facts);
      if (error instanceof TransferError) return refuseNative(w, id, "native_destination_invalid", { code: error.code, path: clip(error.path) }, facts);
      throw error;
    }
  }

  await clearOwn(w, move, "dest", PREFLIGHT_CODES);
  const answer = await destReady(w.store, id, who(w), { ...facts, native });
  switch (answer) {
    case "ready":
      await w.say("move.dest-ready", { move: id, native: native !== null });
      return done("ready");
    case "replay":
      return done("ready");
    case "facts-invalid":
      return raise(w, id, "dest_facts_invalid", {});
    default:
      return waiting(answer);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Import and activation
// ---------------------------------------------------------------------------------------------------------------------

interface NativePlan { port: NativeSessionPort; bundle: Bundle; blob: MoveBlob; carried: unknown; digest: string; version: string; sessionDir: string; expected: NativeSide }
interface Plan {
  /** The evidence `verified` carries, and what a retry must find on the copy again, key for key. */
  verified: Record<string, unknown>;
  /** Absent for a conversation the engine never started: no file, no import. */
  native?: NativePlan;
  /** The heaviest the evidence of the rest of this copy's life can be, worked out before anything is staged (see `overBudget`). */
  ceiling: { promoted: Record<string, unknown>; receipt: StageReceipt | null };
}
type Planned = { kind: "plan"; plan: Plan } | { kind: "fail"; code: string; detail: Record<string, unknown> } | { kind: "wait"; step: HandoffStep };

const failure = (code: string, detail: Record<string, unknown> = {}): Planned => ({ kind: "fail", code, detail });

/** The reasons `native_import_unverified` gives (`importNative`'s checks and the evidence's own): the longest is what a budget reserves. */
const UNVERIFIED = ["native-digest", "receipt-operation", "receipt-destination", "destination-side", "transcript", "bundle-digest", "evidence-size", "evidence-invalid"] as const;
const LONGEST_WHY = UNVERIFIED.reduce((longest, one) => (one.length > longest.length ? one : longest), "");

/** The widest a receipt's numbers can print: a `dev` or `ino` of 64 bits, and the library's counters as the widest safe integer. */
const U64 = 2 ** 64;
const WIDE_COUNT = Number.MAX_SAFE_INTEGER;

/**
 * What a started import's stage and `promoted` evidence can weigh, worked out BEFORE a byte is staged from what is already known: the real
 * destination path, the operation, the digests, the sealed transcript (its destination path replaces the source's folder name with the
 * destination's) and a receipt whose library-made fields are written at their widest. An upper bound, not a prediction: the exact figures are
 * checked again once the stage exists (`importLocked`, `failWith`), and the receipt itself is never altered to fit.
 */
function startedCeiling(copy: MoveCopyRow, native: NativePlan, folder: unknown): Plan["ceiling"] {
  const { blob, expected: side, bundle } = native;
  const receipt: StageReceipt = {
    destination: side.cwd, manifestDigest: bundle.manifest.digest, planDigest: "0".repeat(64), operation: copy.staging_id, generation: "0".repeat(32),
    root: { dev: U64, ino: U64 }, createdRoot: false, files: WIDE_COUNT, dirs: WIDE_COUNT, markerBytes: WIDE_COUNT,
  };
  const at = typeof folder === "string" && folder !== "" && blob.path.includes(`/${folder}/`)
    ? blob.path.replace(`/${folder}/`, () => `/${side.project_dir}/`)
    : "x".repeat(Buffer.byteLength(blob.path) + Buffer.byteLength(side.project_dir));
  return {
    receipt,
    promoted: {
      receipt, bundle_digest: bundle.manifest.digest, to: side, transcript: { path: at, sha256: blob.sha256, size: blob.size, mode: blob.mode }, reused: false,
      native_manifest_digest: native.digest,
    },
  };
}

/** What `promote_intent` records for a plan: the directory the launch would use, as given, or the empty marker. */
const intentOf = (plan: Plan): Record<string, unknown> => (plan.native ? { session_dir: plan.native.sessionDir, absent: true } : { empty: true });

/**
 * THE LIFETIME BUDGET BEFORE STAGING (see the header): the number of bytes the copy's evidence would weigh at the end of its life, in the worst
 * of its two courses, `evidence` being what the copy holds once the step about to be committed is (for `verified`, the evidence it records) and
 * `intent` the `promote_intent` record still to come (null once it is on the copy). One course is `promoted` evidence at its ceiling and the
 * other the heaviest failure that carries the stage's receipt, each followed by the `removed` record. Null when it fits.
 */
function overBudget(w: HandoffWorld, copy: MoveCopyRow, evidence: Record<string, unknown>, plan: Plan, intent: Record<string, unknown> | null): number | null {
  const first = intent ? [{ promote_intent: intent }] : [];
  const detail = { why: LONGEST_WHY, ...(plan.ceiling.receipt ? { dir: "unreadable" } : {}), written: "unknown", ...(plan.ceiling.receipt ? { receipt: plan.ceiling.receipt } : {}) };
  const end = { staging: copy.staging_id, incarnation: w.incarnation };
  const bytes = Math.max(
    lifetimeBytes(evidence, [...first, { promoted: plan.ceiling.promoted }], end),
    lifetimeBytes(evidence, [...first, failureRecord("native_import_unverified", detail, w.incarnation)], end),
  );
  return bytes > COPY_EVIDENCE_LIMIT ? bytes : null;
}

/**
 * Everything the destination can check about the import IN MEMORY, from the store's sealed manifest and the stored bytes, before a
 * byte goes anywhere. Run again at every step that still has work to do (verified, promote_intent), so a resumed import is verified
 * against what the copy recorded, not trusted for having got that far.
 */
async function planOf(w: HandoffWorld, move: MoveRow, copy: MoveCopyRow): Promise<Planned> {
  const { manifest, snapshot } = move;
  if (!manifest || !snapshot) return failure("native_manifest_missing");
  // The generation the store sealed is the only one: a manifest that names another is not this export.
  if (manifest.export_generation !== move.export_generation) return failure("native_export_mismatch", { why: "generation" });
  let blobs: MoveBlob[];
  try { blobs = await readBlobs(w.store, move); } catch (error) {
    if (error instanceof MoveBlobsGone) return failure("native_blobs_gone", { why: clip(error.message) });
    throw error;
  }
  const base = { manifest_digest: manifest.digest, generation: copy.generation, staging: copy.staging_id, files: manifest.files.length, bytes: manifest.bytes };

  // The zero-blob case is decided BEFORE anything asserts one blob: a conversation the engine never started carries nothing.
  if (snapshot.native_state === "new") {
    if (blobs.length !== 0 || manifest.files.length !== 0 || manifest.bytes !== 0 || manifest.digest !== buildBundle([], MOVE_NATIVE_LIMITS).manifest.digest) {
      return failure("native_export_mismatch", { why: "new-conversation-not-empty" });
    }
    return { kind: "plan", plan: { verified: { ...base, bundle_digest: manifest.digest }, ceiling: { receipt: null, promoted: { empty: true, bundle_digest: manifest.digest } } } };
  }
  // A `launched` conversation is not sealed by the source (its named gate, `native_state_launched`), so a manifest of one is not this
  // slice's: it is never imported as a started session and never as an empty one, and nothing is minted in its place.
  if (snapshot.native_state === "launched") return failure("native_state_launched", { native_state: snapshot.native_state });

  const blob = blobs.length === 1 ? blobs[0] : undefined;
  if (!blob || blob.kind !== "native" || manifest.files.length !== 1) return failure("native_export_mismatch", { why: "blob-count", blobs: blobs.length });
  let bundle: Bundle;
  try { bundle = buildBundle([{ path: blob.path, class: "native", mode: blob.mode, bytes: blob.bytes }], MOVE_NATIVE_LIMITS); } catch (error) {
    if (error instanceof TransferError) return failure("native_export_mismatch", { why: "bundle", code: error.code });
    throw error;
  }
  if (bundle.manifest.digest !== manifest.digest) return failure("native_export_mismatch", { why: "bundle-digest" });

  // The store's sealed record is the authority for which native export this is. The adapter checks the carried manifest against this
  // very digest when it imports (before it writes anything), and refuses one that is not the manifest it was taken over.
  const native = manifest.native;
  const carried = manifest.native_export;
  const file = isRecord(carried) && Array.isArray(carried.files) && carried.files.length === 1 ? carried.files[0] : undefined;
  if (!native || native.native_session !== snapshot.native_session || !isHex64(native.native_manifest_digest) || !isRecord(carried) ||
      carried.native_session !== native.native_session || !isRecord(file) || file.path !== blob.path || file.sha256 !== blob.sha256 ||
      file.size !== blob.size || file.mode !== blob.mode) return failure("native_export_mismatch", { why: "native-identity" });

  const port = w.port(move.adapter);
  if (!port) return { kind: "wait", step: waiting("native-port-missing") };
  const build = await w.build(move.agent);
  if (!build) return { kind: "wait", step: waiting("build-unreadable") };
  const expected = nativeSideOf(move.dest_facts?.native);
  if (!expected) return failure("native_dest_facts_missing");
  if (build.version !== expected.version) return failure("native_build_changed", { recorded: expected.version, now: build.version });
  const sessionDir = w.sessionDir(move);
  let side: NativeSide;
  try { side = port.destination({ sessionDir, version: build.version }); } catch (error) {
    if (error instanceof NativeRefusal) return failure(error.code, { path: clip(error.path) });
    if (error instanceof TransferError) return failure("native_destination_invalid", { code: error.code, path: clip(error.path) });
    throw error;
  }
  if (!sameJson(side, expected)) return failure("native_destination_changed", { recorded: clip(expected.cwd), now: clip(side.cwd) });
  // The sealed pair names the destination the source CHECKED. The destination's facts can be replaced until the release and the release
  // does not bind them to the manifest, so the pair is compared here with the side this import will really run on (`side` is the
  // adapter's answer, equal to the recorded facts and to the build just read): a manifest that checked another pair is refused before
  // anything is written, even though `importSession` gates the real pair again.
  const pair = `${side.os}:${side.version}`;
  const sealedTo = manifest.portability?.to;
  if (sealedTo !== pair) return failure("native_export_mismatch", { why: "portability-destination", sealed: typeof sealedTo === "string" ? clip(sealedTo) : null, bound: pair });

  const verified = { ...base, native, bundle_digest: bundle.manifest.digest, version: build.version, session_dir: sessionDir };
  // Exact retry: a copy that already recorded its verification must be verified again to the same words.
  if (copy.state === "verified" || copy.state === "promote_intent") {
    for (const [key, value] of Object.entries(verified)) if (!sameJson(copy.evidence[key], value)) return failure("native_retry_mismatch", { key });
  }
  const started: NativePlan = { port, bundle, blob, carried, digest: native.native_manifest_digest, version: build.version, sessionDir, expected };
  return { kind: "plan", plan: { verified, native: started, ceiling: startedCeiling(copy, started, isRecord(carried.from) ? carried.from.project_dir : undefined) } };
}

/**
 * The import failed: the copy is owed its cleanup and the move waits under this side's block (no retry; the owner withdraws). WHAT
 * IS CLAIMED about writing comes from the copy's evidence as read now: `false` only while no `promote_intent` was ever committed.
 */
async function failWith(
  w: HandoffWorld, held: Held, id: string, copy: MoveCopyRow, code: string, detail: Record<string, unknown>, staged: StageReceipt | null = null,
): Promise<HandoffStep> {
  const written = Object.hasOwn(copy.evidence, "promote_intent") ? "unknown" : false;
  const base = { ...detail, written };
  // THE RECEIPT OF A STAGE THIS CALL MADE (or reused) is the one thing that lets a later cleanup remove exactly it. It goes into the
  // failure whole or not at all: never clipped (the destination and every identity field decide what a discard may touch), and only
  // if the store will take it, by the limits the store states and measures as `jsonb::text`: the report's detail (2 KiB) and the
  // copy's evidence as a whole once the failure is merged into what it already holds AND the removal's record can still follow
  // (8 KiB, `fitsLifetime`). One that is not of this copy's own operation is not carried. A receipt that does not fit leaves the explicit
  // gate: the copy is due, nothing can show which stage is ours, and a directory that is there is left (`cleanup-receipt-missing`, with
  // `receipt_unrecorded` said). The receipt-free report is measured the same way, whole: when not even that can be recorded (evidence
  // that was already full when this budget did not exist) the failure is not written at all and the refusal is this side's small named
  // block instead, so the store is never asked for a merge its column would refuse.
  const carried = staged !== null && staged.operation === copy.staging_id ? staged : null;
  const fits = (one: Record<string, unknown>, receipt: StageReceipt | null) => jsonbBytes(one) <= FAILURE_DETAIL_LIMIT &&
    fitsLifetime(copy.evidence, [failureRecord(code, one, w.incarnation)], { staging: copy.staging_id, incarnation: w.incarnation, generation: receipt?.generation ?? null });
  const options: { detail: Record<string, unknown>; receipt: StageReceipt | null }[] = carried
    ? [{ detail: { ...base, receipt: carried }, receipt: carried }, { detail: { ...base, receipt_unrecorded: true }, receipt: null }]
    : [{ detail: base, receipt: null }];
  const chosen = options.find(one => fits(one.detail, one.receipt));
  if (!chosen) {
    const step = await raise(w, id, "native_evidence_budget", { code, written, ...(carried ? { receipt_unrecorded: true } : {}) });
    // A withdrawal that has already landed: the stage this call made is removed by the receipt in hand, or left, like any other.
    return step.reason === "terminal" && carried ? waiting("terminal", { code, cleanup: await cleanWithdrawn(w, held, copy, carried) }) : step;
  }
  const recorded = chosen.detail;
  const answer = await failImport(w.store, id, who(w), copy.generation, code, recorded);
  if (answer === "terminal" && carried) {
    // A withdrawal won the race: the failure cannot be recorded, so nothing durable names the stage that is on the disk. It is removed
    // by the receipt this call holds, through the one cleanup every removal goes through (every guard asked again, under the lock this
    // call holds), or it is left for the explicit gate above. The report is the step's, never a claim that nothing was written.
    return waiting(answer, { code, cleanup: await cleanWithdrawn(w, held, copy, carried) });
  }
  if (answer !== "failed") return waiting(answer, { code });
  const { receipt: _kept, ...said } = recorded;
  await w.say("move.import-failed", { move: id, generation: copy.generation, code, ...said, receipt_recorded: "receipt" in recorded });
  return blocked(code, recorded);
}

/** The copy a withdrawal made due, removed now by the receipt in memory: `cleanupLocked`'s own answer, as a word. */
async function cleanWithdrawn(w: HandoffWorld, held: Held, copy: MoveCopyRow, staged: StageReceipt): Promise<string> {
  const now = (await copiesOf(w.store, copy.move_id)).find(one => one.kind === copy.kind && one.generation === copy.generation && one.machine === copy.machine);
  if (!now) return "copy-missing";
  const cleaned = await cleanupLocked(w, held, now, staged);
  return `${cleaned.outcome}:${cleaned.reason}`;
}

const stepOf = (w: HandoffWorld, id: string, generation: number, step: string) => w.say("move.import-step", { move: id, generation, step });

/**
 * One look at one move from the destination's runner: begin or resume this machine's import, take it as far as it goes, and activate.
 * Every step is committed in the store before the next one starts, and a crash anywhere resumes from the copy's own state. A look that
 * cannot go on (a block, an archived topic, a snapshot that changed) returns `waiting` and changes nothing; one that must give up
 * records the failure and returns `blocked`.
 */
export async function importDestination(w: HandoffWorld, id: string): Promise<HandoffStep> {
  const first = await readMove(w.store, id);
  if (!first) return waiting("unknown-move");
  if (first.dest_runner !== w.runner || first.dest_machine !== w.machine) return waiting("not-destination");
  return underLock(w, first.conversation_id, held => importLocked(w, held, id));
}

async function importLocked(w: HandoffWorld, held: Held, id: string): Promise<HandoffStep> {
  const move = await readMove(w.store, id);
  if (!move) return waiting("unknown-move");
  if (move.stage === "activated" || move.stage === "registry_written" || move.stage === "active") return done(`stage:${move.stage}`);
  if (move.stage !== "source_released" && move.stage !== "importing") return waiting(`stage:${move.stage}`);

  let begun = await beginImport(w.store, id, who(w));
  if (begun.answer === "cleanup-pending") {
    // An earlier copy of this very location is owed its removal. This call holds the conversation's lock already: it cleans up under it.
    await cleanupLocation(w, held);
    begun = await beginImport(w.store, id, who(w));
  }
  if (begun.answer !== "intent" && begun.answer !== "resumed") {
    if (begun.answer === "copy-occupied") await sayOnce(w, `occupied:${id}`, "move.copy-occupied", { move: id, occupant: begun.occupant ?? null });
    return waiting(begun.answer, begun.occupant ? { occupant: begun.occupant } : undefined);
  }
  const generation = begun.generation!;
  if (begun.answer === "intent") await stepOf(w, id, generation, "intent");

  const copyNow = async () => (await copiesOf(w.store, id)).find(one => one.kind === "dest_import" && one.generation === generation && one.machine === w.machine) ?? null;
  let copy = await copyNow();
  if (!copy || copy.state === "cleanup_due" || copy.state === "removed") return waiting("copy-missing");

  const fail = (at: MoveCopyRow, code: string, detail: Record<string, unknown>, staged: StageReceipt | null = null) => failWith(w, held, id, at, code, detail, staged);

  if (copy.state === "intent") {
    const planned = await planOf(w, move, copy);
    if (planned.kind === "wait") return planned.step;
    if (planned.kind === "fail") return fail(copy, planned.code, planned.detail);
    // The lifetime budget, before `verified` is committed: an import whose evidence cannot hold the rest of its life is refused here, by a
    // small failure the copy (still empty) can always record, and nothing of it ever reaches a disk.
    const over = overBudget(w, copy, planned.plan.verified, planned.plan, intentOf(planned.plan));
    if (over !== null) return fail(copy, "native_evidence_budget", { why: "lifecycle", bytes: over, limit: COPY_EVIDENCE_LIMIT });
    const answer = await advanceImport(w.store, id, who(w), generation, "verified", planned.plan.verified);
    if (answer === "verification-mismatch") return fail(copy, "native_verification_rejected", {});
    if (answer !== "verified" && answer !== "replay") return waiting(answer, { step: "verified" });
    await stepOf(w, id, generation, "verified");
    copy = await copyNow();
    if (!copy) return waiting("copy-missing");
  }

  if (copy.state === "verified") {
    const planned = await planOf(w, move, copy);
    if (planned.kind === "wait") return planned.step;
    if (planned.kind === "fail") return fail(copy, planned.code, planned.detail);
    if (planned.plan.native) {
      // Nothing of this import exists yet (no `promote_intent`), so a directory here is somebody else's: refused, written: false.
      const dir = dirState(planned.plan.native.sessionDir);
      if (dir !== "absent") return fail(copy, "native_dest_session_collision", { dir });
    }
    // The lifetime budget again, on what the copy really holds, before `promote_intent` is committed (the step after which a stage may exist).
    const intent = intentOf(planned.plan);
    const over = overBudget(w, copy, copy.evidence, planned.plan, intent);
    if (over !== null) return fail(copy, "native_evidence_budget", { why: "lifecycle", bytes: over, limit: COPY_EVIDENCE_LIMIT });
    const answer = await advanceImport(w.store, id, who(w), generation, "promote_intent", intent);
    if (answer !== "promote_intent" && answer !== "replay") return waiting(answer, { step: "promote_intent" });
    await stepOf(w, id, generation, "promote_intent");
    copy = await copyNow();
    if (!copy) return waiting("copy-missing");
  }

  if (copy.state === "promote_intent") {
    const planned = await planOf(w, move, copy);
    if (planned.kind === "wait") return planned.step;
    if (planned.kind === "fail") return fail(copy, planned.code, planned.detail);
    // The lifetime budget a third time, immediately before the stage is made: a copy that resumes here (a crash after `promote_intent`, or one
    // recorded by an earlier version) is held to it too, and refused before anything is written.
    const over = overBudget(w, copy, copy.evidence, planned.plan, null);
    if (over !== null) return fail(copy, "native_evidence_budget", { why: "lifecycle", bytes: over, limit: COPY_EVIDENCE_LIMIT });
    const imported = planned.plan.native ? await importNative(w, held, id, copy, planned.plan.native) : { evidence: planned.plan.ceiling.promoted, receipt: null };
    if (!("evidence" in imported)) return imported;
    // From here a stage exists and `imported.receipt` is the only thing that names it: every way out below that is not the step
    // being taken carries it (see `failWith`), or removes it by it.
    // The copy's evidence may weigh 8 KiB in all, what `verified` and `promote_intent` recorded included AND the removal's record that
    // will have to follow: the evidence must fit WITH them (the exact figures now, the receipt's own generation included).
    if (!fitsLifetime(copy.evidence, [{ promoted: imported.evidence }], { staging: copy.staging_id, incarnation: w.incarnation, generation: imported.receipt?.generation ?? null })) {
      return fail(copy, "native_import_unverified", { why: "evidence-size" }, imported.receipt);
    }
    await stepOf(w, id, generation, "imported");
    const answer = await advanceImport(w.store, id, who(w), generation, "promoted", imported.evidence);
    if (answer === "evidence-invalid") return fail(copy, "native_import_unverified", { why: "evidence-invalid" }, imported.receipt);
    // A withdrawal that landed after `promote_intent`: the copy is owed its removal and the evidence cannot be recorded any more. The
    // stage on the disk is removed now by the receipt in hand, under this lock and every guard of any other removal, or left.
    if (answer === "terminal" && imported.receipt) return waiting(answer, { step: "promoted", cleanup: await cleanWithdrawn(w, held, copy, imported.receipt) });
    // Anything else that is not a step taken: the files stay staged, and the next look reuses the complete stage by its operation.
    if (answer !== "promoted" && answer !== "replay") return waiting(answer, { step: "promoted" });
    await stepOf(w, id, generation, "promoted");
    copy = await copyNow();
    if (!copy) return waiting("copy-missing");
  }

  if (copy.state !== "promoted") return waiting(`copy:${copy.state}`);
  return activate(w, move, copy);
}

/** The adapter's import, then the checks that what it reports is what was asked. Returns the evidence `promoted` records, or the failure. */
async function importNative(w: HandoffWorld, held: Held, id: string, copy: MoveCopyRow, plan: NativePlan): Promise<{ evidence: Record<string, unknown>; receipt: StageReceipt } | HandoffStep> {
  let imported: NativeImport;
  try {
    imported = plan.port.importSession({
      manifest: plan.carried, digest: plan.digest, bundle: plan.bundle, sessionDir: plan.sessionDir, version: plan.version, operation: copy.staging_id,
      limits: MOVE_NATIVE_LIMITS,
    });
  } catch (error) {
    // A refusal of THIS call proves nothing about an earlier one (see the header): `failWith` reads the copy, and the directory is looked at.
    const dir = dirState(plan.sessionDir);
    // No receipt: the adapter threw before it could name a stage, and a stage an earlier call made stays unnamed (never "nothing written").
    if (error instanceof NativeRefusal) return failWith(w, held, id, copy, error.code, { path: clip(error.path), dir });
    if (error instanceof TransferError) {
      return failWith(w, held, id, copy, error.code === "stage-ambiguous" ? "native_stage_ambiguous" : "native_import_failed", { code: error.code, path: clip(error.path), dir });
    }
    throw error;
  }
  const problem: (typeof UNVERIFIED)[number] | null = imported.native_manifest_digest !== plan.digest ? "native-digest"
    : imported.receipt.operation !== copy.staging_id ? "receipt-operation"
    : imported.receipt.destination !== imported.to.cwd ? "receipt-destination"
    : !sameJson(imported.to, plan.expected) ? "destination-side"
    : imported.transcript.sha256 !== plan.blob.sha256 || imported.transcript.size !== plan.blob.size || imported.transcript.mode !== plan.blob.mode ? "transcript"
    : !isHex64(imported.bundle_digest) || imported.receipt.manifestDigest !== imported.bundle_digest ? "bundle-digest"
    : null;
  // The stage exists whatever the check found: its receipt rides the failure (`failWith` carries only one of this copy's own operation).
  if (problem) return failWith(w, held, id, copy, "native_import_unverified", { why: problem, dir: dirState(plan.sessionDir) }, imported.receipt);
  return {
    evidence: {
      receipt: imported.receipt, bundle_digest: imported.bundle_digest, to: imported.to, transcript: imported.transcript, reused: imported.reused,
      native_manifest_digest: imported.native_manifest_digest,
    },
    receipt: imported.receipt,
  };
}

/** Activate from what the COPY stored, so that a replay after a crash is jsonb-equal to the first call by construction. */
async function activate(w: HandoffWorld, move: MoveRow, copy: MoveCopyRow): Promise<HandoffStep> {
  const stored = copy.evidence.promoted;
  const started = move.snapshot?.native_state !== "new";
  const sound = isRecord(stored) && isHex64(stored.bundle_digest) && (started ? isRecord(stored.to) && isRecord(stored.transcript) && isRecord(stored.receipt) : stored.empty === true);
  if (!sound || !isRecord(stored)) return raise(w, move.id, "native_activation_unverifiable", { why: "promoted-evidence" });
  const verification = {
    generation: copy.generation, staging: copy.staging_id, manifest_digest: move.manifest!.digest, dest_runner: move.dest_runner, dest_machine: move.dest_machine,
    ...(started ? { native: move.manifest!.native } : {}),
    imported: started ? { bundle_digest: stored.bundle_digest, to: stored.to, transcript: stored.transcript } : { empty: true, bundle_digest: stored.bundle_digest },
  };
  const answer = await activateMove(w.store, move.id, who(w), copy.generation, verification);
  switch (answer) {
    case "activated":
      await w.say("move.activated", { move: move.id, generation: copy.generation });
      return done("activated");
    case "replay":
      return done("activated");
    case "verification-mismatch":
      // The verification was built from the store's own record: a mismatch is a defect, said where the owner reads it.
      return raise(w, move.id, "native_activation_rejected", { answer });
    case "snapshot-changed":
      await sayOnce(w, `snapshot-changed:${move.id}`, "move.snapshot-changed", { move: move.id });
      return waiting(answer);
    default:
      return waiting(answer);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------------------------------------------------

type Cleaned = { outcome: "removed" | "left"; reason: string };

/**
 * Remove, one conversation at a time under its lock, the destination copies the store owes this runner a removal of, and report
 * each with `copyRemoved` only when the evidence below allows it. A copy that cannot be removed is LEFT (`cleanup_due` stays, the
 * location stays `cleanup-pending`) and said once. A retained source copy is never touched. Errors that are not refusals are
 * collected and the first is thrown after every copy had its look.
 */
export async function cleanupCopies(w: HandoffWorld): Promise<void> {
  let failed: { error: unknown } | null = null;
  for (const due of await copiesDueForCleanup(w.store, w.runner)) {
    try { await underLock(w, due.conversation_id, held => cleanupLocked(w, held, due)); } catch (error) { failed ??= { error }; }
  }
  if (failed) throw failed.error;
}

/** The copies due at the location `held` covers, cleaned without asking the lock again. */
async function cleanupLocation(w: HandoffWorld, held: Held): Promise<void> {
  const here = (await copiesDueForCleanup(w.store, w.runner)).filter(one => one.conversation_id === held.conversation && one.machine === w.machine);
  for (const one of here) await cleanupLocked(w, held, one);
}

const LIVE_ELSEWHERE = new Set(["removed", "superseded", "cleanup_due"]);

/**
 * EVERY guard a removal of a destination copy needs, in one place, asked from the store and the host as they stand NOW: it was never
 * activated, the conversation is not placed here, nothing runs here, and nothing else claims the location. The only caller of any
 * removal is `cleanupLocked`, so a removal that follows a withdrawal immediately (the import that lost the race to it) is asked the
 * same questions as one a later pass makes, never `idle` alone. Null when none stands in the way. The caller holds the lock.
 */
async function removalBlocker(w: HandoffWorld, move: MoveRow, copy: MoveCopyRow): Promise<{ reason: string; detail?: Record<string, unknown> } | null> {
  if (move.activated_at !== null) return { reason: "activated" };
  const [placed] = (await w.store.sql`select machine from conversation where id = ${copy.conversation_id}`) as unknown as { machine: string | null }[];
  if (!placed || (placed.machine ?? move.source_machine) === w.machine) return { reason: "placed-here" };
  if (!w.idle(move.agent)) return { reason: "live-child" };
  const claims = (await copiesAtLocation(w.store, { conversation: copy.conversation_id, machine: copy.machine }))
    .filter(one => !(one.move_id === copy.move_id && one.kind === copy.kind && one.generation === copy.generation) && !LIVE_ELSEWHERE.has(one.state));
  if (claims.length > 0) return { reason: "other-claim", detail: { claims: claims.length } };
  return null;
}

/** The stage receipt the store holds for a copy: the one `promoted` recorded, else the one a failure carried (`failWith`). Never a guess. */
function recordedReceipt(copy: MoveCopyRow): StageReceipt | null {
  const promoted = copy.evidence.promoted;
  if (isRecord(promoted) && isRecord(promoted.receipt)) return promoted.receipt as unknown as StageReceipt;
  const failure = copy.evidence.failure;
  const carried = isRecord(failure) && isRecord(failure.detail) ? failure.detail.receipt : undefined;
  return isRecord(carried) ? (carried as unknown as StageReceipt) : null;
}

/**
 * WHERE THE STAGE IS, as the import recorded it, against where the session directory rule puts this conversation NOW. A removal frees
 * the location (conversation, machine), and a copy is "absent" only if its own directory is: a rule that changed since the import (a
 * different hub home, say) makes the new path look absent while the stage stays at the old one. So nothing is concluded from the new
 * path alone: the path `promote_intent` recorded, the real path the receipt names and the real path the destination's facts recorded
 * must each be what the rule gives now (the real path is the port's own answer for the current directory, so a link that moved counts
 * too), or the copy is left. Returns the paths that must all be absent for an "absent" removal, or the reason the copy is left.
 */
function stageLocation(w: HandoffWorld, move: MoveRow, copy: MoveCopyRow, receipt: StageReceipt | null): { paths: string[] } | { drift: Record<string, unknown> } {
  const current = w.sessionDir(move);
  const intent = copy.evidence.promote_intent;
  const recorded = isRecord(intent) && typeof intent.session_dir === "string" ? intent.session_dir : null;
  // Asked only when something was recorded (a receipt, or a `promote_intent` that names a file): one that names no path proves nothing here.
  if (recorded === null && receipt === null) return { drift: { now: clip(current), of: "unrecorded" } };
  if (recorded !== null && recorded !== current) return { drift: { recorded: clip(recorded), now: clip(current), of: "promote_intent" } };

  const port = w.port(move.adapter);
  const version = copy.evidence.version;
  let real: string | null = null;
  if (port && typeof version === "string") {
    try { real = port.destination({ sessionDir: current, version }).cwd; } catch { real = null; }
  }
  if (real === null) return { drift: { now: clip(current), of: "unresolvable" } };
  const facts = nativeSideOf(move.dest_facts?.native);
  if (receipt !== null && receipt.destination !== real) return { drift: { recorded: clip(String(receipt.destination)), now: clip(real), of: "receipt" } };
  if (facts && facts.cwd !== real) return { drift: { recorded: clip(facts.cwd), now: clip(real), of: "dest_facts" } };
  return { paths: [...new Set([current, real])] };
}

async function cleanupLocked(w: HandoffWorld, held: Held, due: MoveCopyRow, carried: StageReceipt | null = null): Promise<Cleaned> {
  if (due.conversation_id !== held.conversation) throw new Error(`cleanup-lock-mismatch: ${due.conversation_id} under ${held.conversation}`);
  const key = `${due.move_id}:${due.generation}`;
  const left = async (reason: string, detail: Record<string, unknown> = {}): Promise<Cleaned> => {
    await sayOnce(w, `cleanup-left:${key}:${reason}`, "move.cleanup-left", { move: due.move_id, kind: due.kind, generation: due.generation, reason, ...detail });
    return { outcome: "left", reason };
  };
  // What the store says NOW, under the lock: the copy may have been reported removed, or replaced, since the list was read.
  const copy = (await copiesOf(w.store, due.move_id)).find(one => one.kind === due.kind && one.generation === due.generation && one.machine === due.machine);
  if (!copy || copy.state !== "cleanup_due") return { outcome: "left", reason: "not-due" };
  if (copy.kind !== "dest_import") return left("retained-source-copy");
  const move = await readMove(w.store, copy.move_id);
  if (!move || move.dest_runner !== w.runner || copy.machine !== w.machine || copy.machine !== move.dest_machine) return left("not-owner");

  const blocker = await removalBlocker(w, move, copy);
  if (blocker) return left(blocker.reason, blocker.detail);

  // The store's receipt first; the one a caller holds in memory (an import that lost a race to the withdrawal) only when the store has none.
  const receipt = recordedReceipt(copy) ?? carried;
  const intent = copy.evidence.promote_intent;

  // THE REMOVAL'S OWN RECORD MUST BE ABLE TO COMMIT, and it is asked BEFORE anything physical: the report is the last merge into the copy's
  // evidence (the column is bounded as a whole), so a copy whose evidence has no room for it, once discarded, could never be reported
  // removed and every later pass would repeat the discard and the refused report. The word is the heaviest this branch can end with. Such a
  // copy (recorded before the lifetime budget existed) is left, named, and its directory is not touched.
  const expected: Removal = receipt || (isRecord(intent) && intent.empty !== true) ? "absent" : "nothing-written";
  const weight = lifetimeBytes(copy.evidence, [], { staging: copy.staging_id, incarnation: w.incarnation, removed: expected, generation: receipt?.generation ?? null });
  if (weight > COPY_EVIDENCE_LIMIT) return left("evidence-budget", { bytes: weight, limit: COPY_EVIDENCE_LIMIT });

  let removed: Removal;
  if (receipt) {
    // Ownership: the receipt is of THIS copy's own staging operation, and names a path.
    if (receipt.operation !== copy.staging_id || typeof receipt.destination !== "string") return left("receipt-foreign");
    const port = w.port(move.adapter);
    if (!port) return left("native-port-missing");
    const where = stageLocation(w, move, copy, receipt);
    if ("drift" in where) return left("session-dir-changed", where.drift);
    try { port.discardImport(receipt); removed = "stage"; } catch (error) {
      if (!(error instanceof TransferError)) throw error;
      // A receipt that no longer describes the directory is a removal only if there is no directory, at ANY path the stage was recorded
      // at; a changed file, an entry that is not the stage's and anything else the library refuses leaves everything it did not remove,
      // and nothing is reported.
      if (error.code === "stage-stale" && where.paths.every(path => dirState(path) === "absent")) removed = "absent";
      else return left("discard-refused", { code: error.code, path: clip(error.path) });
    }
  } else if (!isRecord(intent) || intent.empty === true) {
    // No `promote_intent` was ever committed (or the import carries no file): nothing of this copy can be on the disk.
    removed = "nothing-written";
  } else {
    // A `promote_intent` with no receipt: a stage may be there that nothing can show this copy made. Absent is the only proof, and only
    // of the path the import recorded, which must still be the one the rule gives.
    const where = stageLocation(w, move, copy, null);
    if ("drift" in where) return left("session-dir-changed", where.drift);
    const state = where.paths.map(dirState);
    if (!state.every(one => one === "absent")) {
      const failure = copy.evidence.failure;
      const unrecorded = isRecord(failure) && isRecord(failure.detail) && failure.detail.receipt_unrecorded === true;
      return left("cleanup-receipt-missing", { dir: state.find(one => one !== "absent"), path: clip(where.paths[0]), ...(unrecorded ? { receipt_unrecorded: true } : {}) });
    }
    removed = "absent";
  }

  const answer = await copyRemoved(w.store, copy.move_id, who(w), copy.generation,
    removalReport(copy.staging_id, removed, receipt?.generation ?? null, w.incarnation), "dest_import");
  if (answer !== "removed" && answer !== "replay") return left(`store-${answer}`);
  await w.say("move.cleanup-removed", { move: copy.move_id, generation: copy.generation, removed });
  return { outcome: "removed", reason: removed };
}
