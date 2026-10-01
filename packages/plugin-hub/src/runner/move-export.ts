import { NativeRefusal, type NativeSide } from "../adapters/types.ts";
import { buildBundle, contentKey, TransferError } from "../transfer/bundle.ts";
import {
  checkpointOf, exportGenerationOf, putBlob, readMove, releaseSource, type MoveCheckpoint, type MoveManifest, type MoveRow,
} from "../store/moves.ts";
import { configDifference } from "./move-config.ts";
import {
  MOVE_NATIVE_LIMITS, clearOwn, clip, done, isHex64, isRecord, jsonbBytes, raise, sameJson, sayOnce, sha256, stableText, waiting, who,
  type ConfigSections, type HandoffStep, type HandoffWorld, type ProvenDrain, type ScopeProof, type WorkspaceHold,
} from "./move-handoff.ts";
import { profileDifference, profileUnverified } from "./move-profile.ts";

/**
 * The source's half of one native handoff: a drain the store says is complete, then the transcript exported, stored under the
 * drain's export generation and sealed with `releaseSource`. The runner calls it from the same serialized look that saw `drained`
 * (`run.ts`, `driveMove`); it takes what it cannot know as arguments (`move-handoff.ts`).
 *
 * WHAT IT TRUSTS: the store's `move.drain` (this incarnation completed it, for this export generation) and the caller's `ProvenDrain`
 * (fenced and quiet). It does not look at how the drain was proved and does not call the drain.
 *
 * WHAT IT RE-ASKS, because awaits sit between the check and the act (the store re-checks its own half at `putBlob` and at release, but
 * a local session or child the store cannot see is excluded only by `quiet`, and bytes read while it was not quiet would poison the
 * generation with a `blob-conflict`): `finalLook` is the whole local question (the move row as it stands now, the drain this
 * incarnation completed for THIS generation, fenced, quiet, no other party's block, and a scope proof bound to the generation) and it
 * is asked three times: when the look begins, after the transcript was read and before it is stored, and immediately before the
 * release. Any of them failing ends the look: a drain that is not final waits (`drain-not-final`), a proof that is gone is
 * `scope_unproven`. What is sealed is the proof the LAST ask returned, never one remembered from the first.
 *
 * WHAT IT CARRIES: the native session and NOTHING ELSE. `w.scope` must prove that is all the conversation needs beyond what is verified;
 * without that proof the export is refused (`scope_unproven`) before anything is read, and the proof is kept in the sealed manifest. A dependency
 * the registry declares and nothing here carries or verifies is `scope_unsupported`, and a configuration file the agent's launch reads that
 * nothing compares (a world with no `effectiveConfig`) is `profile_unverified`: both before anything is read, both without any acknowledgement.
 * WHAT IT VERIFIES BESIDE IT, when the world can: the effective launch configuration, equal to the one the destination recorded (`config_mismatch`,
 * sealed as `manifest.config`), and the declared repositories, observed once under the sync's locks that are held until the release is committed
 * (`workspace_*`, sealed as `manifest.workspace` with the generation and the profile). The observation is sealed only while this machine's own
 * repository facts of the LAST look (plan AND roots) are the ones it observed: a placement moved to another checkout during the look ends it
 * (`workspace-moved`, nothing sealed, the hold released) and the next look observes and locks the current roots. The source's roots are never
 * compared with the destination's, whose placements legitimately differ. Nothing is changed to make either true. A conversation
 * the engine never started (`native_state` new) has no file and is sealed with an EMPTY manifest, never one blob. A conversation
 * the engine only LAUNCHED (`native_state` launched) is neither: see `stateGate`.
 *
 * WHAT IT NAMES: every refusal is a block of THIS side under a code in `EXPORT_CODES`, cleared (only those codes, only this side's)
 * right before a release attempt that got past every check, so a fixed condition releases at the next look and a drain that is not
 * final is never hidden. There is no retry, no other conversation's session and no fresh one in its place.
 *
 * THE DESTINATION'S FACTS ARE NOT IMMUTABLE while the move waits (`destReady` replaces them), so a started conversation's export is
 * bound to the facts it was read against: facts that changed during the look end it (`dest-facts-changed`, nothing sealed), and the
 * next look exports under the new ones. Facts that name no native side are the SOURCE's block, worded by what they say: a preflight
 * made before the engine started the conversation (`native_dest_facts_missing`), or one the destination recorded as refused
 * (`native_dest_refused`, with the destination's own code). The destination never writes its refusal over a block that stands (see
 * `prepareDestination`): the source is the one that restates it, in its own block, so the owner reads the real reason.
 */

export const EXPORT_CODES: ReadonlySet<string> = new Set([
  "scope_unproven", "scope_unsupported", "profile_unverified", "profile_mismatch", "source_profile_unbound", "native_port_missing", "native_build_unknown", "native_dest_facts_missing", "native_dest_refused", "native_export_changed",
  "native_export_rejected", "native_export_failed", "native_state_launched", "native_state_unsupported",
  // The configuration and the repositories, compared with what the destination recorded and observed at the source under the sync's lock.
  "config_mismatch", "config_unverifiable", "workspace_unsynced", "workspace_unpushed", "workspace_branch", "workspace_unavailable", "workspace_plan_mismatch",
  // The adapter's refusals that can come from reading and describing a source (the destination's own are its to raise).
  "native_build_unvalidated", "native_pair_unvalidated", "native_session_invalid", "native_transcript_missing", "native_locator_ambiguous",
  "native_locator_rule_mismatch", "native_side_state_unsupported", "native_export_mismatch",
]);

/** A destination's side, from the facts it recorded: the shape the adapter's `destination` returns, or null. */
export function nativeSideOf(value: unknown): NativeSide | null {
  if (!isRecord(value)) return null;
  const { version, os, cwd, project_dir: projectDir } = value;
  if (typeof version !== "string" || version === "" || (os !== "darwin" && os !== "linux") || typeof cwd !== "string" || cwd === "" ||
      typeof projectDir !== "string" || projectDir === "") return null;
  return { version, os, cwd, project_dir: projectDir };
}

function scopeProven(proof: ScopeProof | null, move: MoveRow, generation: number): ScopeProof | null {
  if (!proof || proof.move !== move.id || proof.conversation !== move.conversation_id || proof.agent !== move.agent || proof.generation !== generation ||
      (proof.carries !== "native-only" && proof.carries !== "native+workspace") || typeof proof.basis !== "string" || proof.basis.trim() === "" || proof.basis.length > 256) return null;
  return proof;
}

const text = (value: unknown): string | null => (typeof value === "string" ? clip(value) : null);

/**
 * The native states a started session can be carried from: the engine acknowledged a message under the id (`started`) or reported it
 * back (`verified`). `new` has no file; `launched` is the one in between and is NOT carried or replaced here: a child was started
 * under the id, so a transcript may or may not exist, and the hub's own launch treats the id as replaceable (`mintNativeSession`, a
 * fresh id at the next launch). Whether a move should carry that id, or the conversation should be given a fresh one first, or the
 * move should wait for the engine to acknowledge it, is the OWNER's choice and changes what the conversation is: this side neither
 * mints, nor seals an empty export for it, nor carries a file it cannot tell the meaning of. It is the source's named block
 * (`native_state_launched`), cleared by itself the moment the state is anything else (the owner withdraws, or the engine moves it on).
 */
const CARRIED_STATES: ReadonlySet<string> = new Set(["started", "verified"]);

function stateGate(w: HandoffWorld, id: string, checkpoint: MoveCheckpoint): Promise<HandoffStep> | null {
  const state = checkpoint.native_state;
  if (state === "new" || CARRIED_STATES.has(state)) return null;
  if (state === "launched") return raise(w, id, "native_state_launched", { native_state: state, native_session: text(checkpoint.native_session) });
  return raise(w, id, "native_state_unsupported", { native_state: text(state) });
}

/** The refusal of an adapter or the transfer library as this side's block, or a rethrow of anything else (a bug is not a refusal). */
async function refuse(w: HandoffWorld, id: string, error: unknown): Promise<HandoffStep> {
  if (error instanceof NativeRefusal) {
    const detail = { path: clip(error.path), ...(EXPORT_CODES.has(error.code) ? {} : { code: error.code }) };
    return raise(w, id, EXPORT_CODES.has(error.code) ? error.code : "native_export_failed", detail);
  }
  if (error instanceof TransferError) return raise(w, id, "native_export_failed", { code: error.code, path: clip(error.path) });
  throw error;
}

/** What was read, WITHOUT the scope proof (the last ask's is sealed with it), and the destination side it was read against (null: nothing native). */
interface Exported { manifest: MoveManifest; blob: { path: string; mode: number; bytes: Uint8Array } | null; to: NativeSide | null }

/** The source's block for destination facts that name no native side, worded by what they say (see the header). */
function destinationUnusable(w: HandoffWorld, move: MoveRow, checkpoint: MoveCheckpoint): Promise<HandoffStep> {
  const facts = move.dest_facts;
  const refusal = facts && isRecord(facts.native_refusal) ? facts.native_refusal : null;
  if (refusal) return raise(w, move.id, "native_dest_refused", { code: text(refusal.code), path: text(refusal.path) });
  return raise(w, move.id, "native_dest_facts_missing", {
    native_state: text(checkpoint.native_state), recorded: facts && facts.native === null ? "no-native-side" : "invalid",
    why: "the destination's preflight does not name where a started session would go; it must run its preflight again",
  });
}

async function exportNative(w: HandoffWorld, move: MoveRow, checkpoint: MoveCheckpoint, generation: number): Promise<Exported | HandoffStep> {
  if (checkpoint.native_state === "new") {
    // The engine never started this conversation: there is no file, so there is no blob to count. The digest is the empty bundle's.
    return { manifest: { digest: buildBundle([], MOVE_NATIVE_LIMITS).manifest.digest, files: [], bytes: 0, export_generation: generation }, blob: null, to: null };
  }
  const port = w.port(move.adapter);
  if (!port) return raise(w, move.id, "native_port_missing", { adapter: move.adapter });
  const build = await w.build(move.agent);
  if (!build) return raise(w, move.id, "native_build_unknown", {});
  const to = nativeSideOf(move.dest_facts?.native);
  if (!to) return destinationUnusable(w, move, checkpoint);

  const exp = port.exportSession({ sessionDir: w.sessionDir(move), nativeSession: checkpoint.native_session, version: build.version, limits: MOVE_NATIVE_LIMITS });
  const file = exp.manifest.files.length === 1 ? exp.manifest.files[0] : undefined;
  const entry = exp.bundle.manifest.entries.length === 1 ? exp.bundle.manifest.entries[0] : undefined;
  const bytes = file ? exp.bundle.contents.get(contentKey("native", file.path)) : undefined;
  if (!file || !entry || entry.kind !== "file" || entry.class !== "native" || entry.path !== file.path || entry.sha256 !== file.sha256 || entry.size !== file.size ||
      entry.mode !== file.mode || !bytes || bytes.byteLength !== file.size || exp.manifest.native_session !== checkpoint.native_session ||
      exp.manifest.from.version !== build.version || !isHex64(exp.digest)) throw new NativeRefusal("native_export_mismatch", file?.path);
  // The destination rebuilds this bundle from the stored bytes: the digest it will compare with is this one, worked out here too.
  const rebuilt = buildBundle([{ path: file.path, class: "native", mode: file.mode, bytes }], MOVE_NATIVE_LIMITS);
  if (rebuilt.manifest.digest !== exp.bundle.manifest.digest) throw new NativeRefusal("native_export_mismatch", file.path);

  const portability = port.portability({ from: { os: exp.manifest.from.os, version: exp.manifest.from.version }, to: { os: to.os, version: to.version } });
  return {
    manifest: {
      digest: rebuilt.manifest.digest,
      files: [{ kind: "native", path: file.path, sha256: file.sha256, size: file.size, mode: file.mode }],
      bytes: file.size,
      native: { native_session: checkpoint.native_session, native_manifest_digest: exp.digest },
      portability,
      native_export: exp.manifest,
      export_generation: generation,
    },
    blob: { path: file.path, mode: file.mode, bytes },
    to,
  };
}

/**
 * `config` is this machine's configuration as the look compared it (null where the world compares none); `source` is this machine's own
 * repository facts as the look read them (plan and roots; null where the world has none or the person declares none).
 */
interface Final { move: MoveRow; generation: number; scope: ScopeProof; config: ConfigSections | null; source: { plan: string; roots: string } | null }

/**
 * THE LOCAL QUESTION, asked on a FRESH row every time (never on one read before an await): is this move still waiting at this source,
 * with this incarnation's complete drain for the generation (`expected`, once one is known: a drain completed again since is another
 * generation and ends the look), the agent fenced and quiet, no other party's block, and a scope proof bound to that generation? Its
 * answers are the look's own: a drain that is not final is cleared of this side's block and waits; a missing proof is this side's
 * block; anything else that stands is named and nothing goes on.
 */
async function finalLook(w: HandoffWorld, drain: ProvenDrain, id: string, expected: number | null): Promise<Final | HandoffStep> {
  const move = await readMove(w.store, id);
  if (!move) return waiting("unknown-move");
  if (move.stage !== "waiting") return done(`stage:${move.stage}`);
  if (move.source_runner !== w.runner) return waiting("not-source");

  const generation = exportGenerationOf(move);
  const final = generation !== null && (expected === null || generation === expected) && move.drain !== null && move.drain.incarnation === w.incarnation &&
    move.drain.export_generation === generation && drain.fenced(move.agent) && drain.quiet(move.agent);
  if (!final || generation === null) {
    await clearOwn(w, move, "source", EXPORT_CODES);
    return waiting("drain-not-final");
  }
  // Another party's block (or the drain's own) stands: nothing is read, stored or sealed under it.
  if (move.block && !(move.block.by === "source" && EXPORT_CODES.has(move.block.code))) return waiting("blocked", { by: move.block.by, code: move.block.code });

  const supplied = w.scope(move);
  // A dependency this move does not carry is named and refused HERE, before anything is read, stored or released (see `ScopeRefusal`).
  if (supplied && "refused" in supplied) {
    const detail = supplied.detail !== undefined && jsonbBytes(supplied.detail) <= 1500 ? supplied.detail : {};
    return raise(w, id, "scope_unsupported", { reason: clip(supplied.refused), ...detail });
  }
  const scope = scopeProven(supplied, move, generation);
  if (!scope) return raise(w, id, "scope_unproven", { reason: supplied ? "mismatch" : "missing" });
  if (w.sourceProfile) {
    const mine = w.sourceProfile(move);
    // THE CONTENT OF THE FILES THE LAUNCH READS is compared by `w.effectiveConfig` where the world has one (below). Where it has none nothing
    // compares it (see `move-profile.ts`), so a profile that holds such a reference is a refusal HERE, whatever the destination has or has not
    // recorded: named by reference (never a path or a value), before anything is read, stored or released.
    const unverified = mine ? profileUnverified(mine) : [];
    if (unverified.length > 0 && !w.effectiveConfig) return raise(w, id, "profile_unverified", { references: unverified });
    // THE PROFILE THE DESTINATION RECORDED must be the one this agent runs under here: compared by section, never by value. Asked only once
    // the destination has recorded one (`dest_ready_at`): until then the move waits for it, as it always did.
    if (move.dest_facts !== null) {
      if (!mine) return raise(w, id, "source_profile_unbound", {});
      const differs = profileDifference(mine, move.dest_facts.profile);
      if (differs.length > 0) return raise(w, id, "profile_mismatch", { sections: differs.slice(0, 16) });
    }
  }
  // THE EFFECTIVE LAUNCH CONFIGURATION, exactly: what a launch of the agent reads here (read now, as a launch reads it) against what the
  // destination recorded for itself. A configuration that cannot be read is named and refused whatever the destination recorded; one that
  // differs is `config_mismatch` naming sections, never values. What the sealed manifest records is the one this last look compared.
  let config: ConfigSections | null = null;
  if (w.effectiveConfig) {
    const mine = w.effectiveConfig(move);
    if (mine === null || "unverifiable" in mine) return raise(w, id, "config_unverifiable", { reason: mine === null ? "registry" : mine.unverifiable });
    config = mine;
    if (move.dest_facts !== null) {
      const differs = configDifference(mine, move.dest_facts.effective);
      if (differs.length > 0) return raise(w, id, "config_mismatch", { sections: differs.slice(0, 16) });
    }
  }
  // THE REPOSITORIES BOTH MACHINES MEAN: the destination's recorded plan (ids, branches, nesting) is the source's. Whether they hold the
  // commits is observed later, under the sync's lock; this only refuses two registries that do not agree on what is being verified.
  // The source's own facts of this look are kept: the release binds the observation to them (`exportHeld`). Its roots are never compared with the destination's.
  let source: Final["source"] = null;
  if (w.workspaceFacts && move.dest_facts !== null) {
    const mine = w.workspaceFacts(move);
    if (mine !== null && "refused" in mine) return raise(w, id, "workspace_unavailable", { why: clip(mine.refused), ...(mine.detail ?? {}) });
    const theirs = move.dest_facts.workspace;
    const theirPlan = isRecord(theirs) && typeof theirs.plan === "string" ? theirs.plan : null;
    if ((mine?.plan ?? null) !== theirPlan) return raise(w, id, "workspace_plan_mismatch", { why: mine === null ? "source-declares-none" : theirPlan === null ? "destination-declares-none" : "plans-differ" });
    if (mine) source = { plan: mine.plan, roots: mine.roots };
  }
  return { move, generation, scope, config, source };
}

/**
 * One look at one move whose drain the store calls complete, from the source's runner. Safe to repeat: a look that cannot finish
 * leaves the store as the drain left it (or as a stale generation made it), and the next one exports afresh under the generation
 * then standing (a blob stored under it is a replay). It does not take `exclusive`: the source's session directory is read-only here
 * and the drain's own quiet proof, asked again at `finalLook`, is what protects the read.
 */
export async function exportSource(w: HandoffWorld, drain: ProvenDrain, id: string): Promise<HandoffStep> {
  const first = await finalLook(w, drain, id, null);
  if ("state" in first) return first;
  const { move, generation } = first;

  const checkpoint = await checkpointOf(w.store, move.conversation_id);
  if (!checkpoint) return waiting("conversation-missing");
  // A destination that has recorded nothing (offline, not yet started, an old runner) is WAITED for, whatever else is true of the conversation:
  // no gate of the engine's state is raised against a move that cannot go on anyway, and nothing falls back.
  if (move.dest_ready_at === null) return waiting("dest-not-ready");
  const gated = stateGate(w, id, checkpoint);
  if (gated) return gated;

  // THE REPOSITORIES ARE OBSERVED ONCE, here: after the drain is final and before anything is read or stored, under the sync's locks, which are
  // HELD until the release below is committed (or this look gave up), so that no sync commits, rebases or pushes between what was observed and
  // what is sealed. A repository that is not as a move needs is a named block; nothing is changed to make it so.
  let hold: WorkspaceHold | null = null;
  let workspace: Record<string, unknown> | null = null;
  try {
    if (first.scope.carries === "native+workspace") {
      if (!w.sourceWorkspace) return raise(w, id, "workspace_unavailable", { why: "no-verifier" });
      const seen = await w.sourceWorkspace(move);
      if (!seen.ok) return raise(w, id, seen.code, seen.detail);
      hold = seen.hold;
      // The profile it is sealed with is not known yet: it is the one the LAST look reads (`exportHeld`), never the first's.
      workspace = { ...seen.sealed, generation };
    }
    return await exportHeld(w, drain, id, { move, checkpoint, generation, workspace });
  } finally { await hold?.release().catch(() => {}); }
}

async function exportHeld(w: HandoffWorld, drain: ProvenDrain, id: string, at: { move: MoveRow; checkpoint: MoveCheckpoint; generation: number; workspace: Record<string, unknown> | null }): Promise<HandoffStep> {
  const { move, checkpoint, generation, workspace } = at;
  let exported: Exported | HandoffStep;
  try { exported = await exportNative(w, move, checkpoint, generation); } catch (error) { return refuse(w, id, error); }
  if ("state" in exported) return exported;

  // After the read, before the bytes are stored: were they read while the agent was not quiet, they would poison the generation.
  const read = await finalLook(w, drain, id, generation);
  if ("state" in read) return read;
  if (exported.blob) {
    const put = await putBlob(w.store, id, who(w), generation, { kind: "native", ...exported.blob });
    // `drain-stale` and `stale-export`: a newer drain stands, and what was read belongs to the old one. Nothing is reused.
    if (put === "blob-conflict") return raise(w, id, "native_export_changed", { path: clip(exported.blob.path) });
    if (put !== "stored" && put !== "replay") return waiting(put, { owed: "store" });
  }

  // This side's own block is cleared first, so that the ask right before the release sees the move as the release will.
  await clearOwn(w, read.move, "source", EXPORT_CODES);
  const last = await finalLook(w, drain, id, generation);
  if ("state" in last) return last;
  if (exported.to) {
    // The facts the file was read against must still be the ones that stand: the manifest names the pair that was checked.
    const now = nativeSideOf(last.move.dest_facts?.native);
    if (!now || !sameJson(now, exported.to)) return waiting("dest-facts-changed");
  }
  // The proof of the last look, and the repositories and configuration it compared: the manifest records what was observed, never what was remembered.
  // A manifest never says it carries the repositories without having observed them, nor seals an observation its proof no longer names.
  if (!workspace !== (last.scope.carries !== "native+workspace")) return raise(w, id, "scope_unproven", { reason: "workspace-proof-changed" });
  // The observation is sealed with the profile of the facts the LAST look read, and only while the plan it observed is still the one the destination
  // recorded in them: facts that moved to another plan during the look end it (nothing sealed), and the next look observes again.
  let sealedWorkspace: Record<string, unknown> | null = null;
  if (workspace) {
    const theirs = last.move.dest_facts?.workspace;
    if (!isRecord(theirs) || theirs.plan !== workspace.plan) return waiting("dest-facts-changed");
    // And only while the checkouts it observed (and locked) are the ones the source's own registry names now: a placement moved to another
    // checkout during the look leaves the move unreleased, the hold goes with the look, and the next look observes and locks the current roots.
    if (!last.source || last.source.plan !== workspace.plan || last.source.roots !== workspace.roots) return waiting("workspace-moved");
    sealedWorkspace = { ...workspace, profile: sha256(stableText(last.move.dest_facts?.profile)) };
  }
  const manifest: MoveManifest = {
    ...exported.manifest, scope: { carries: last.scope.carries, basis: last.scope.basis },
    ...(sealedWorkspace ? { workspace: sealedWorkspace } : {}), ...(last.config ? { config: last.config } : {}),
  };
  const answer = await releaseSource(w.store, id, who(w), generation, checkpoint, manifest);
  switch (answer) {
    case "released":
      await w.say("move.released", { move: id, generation, digest: manifest.digest, files: manifest.files.length });
      return done("released");
    case "replay":
      return done("released");
    case "manifest-invalid": case "manifest-mismatch": case "native-evidence-missing":
      // The manifest was built from exactly the blobs just stored, so a refusal here is a defect in this module, not a state of the world.
      return raise(w, id, "native_export_rejected", { answer });
    case "checkpoint-mismatch": case "source-copy-unresolved":
      await sayOnce(w, `${answer}:${id}:${generation}`, `move.${answer}`, { move: id, generation });
      return waiting(answer, { owed: "store" });
    default:
      return waiting(answer, { owed: "store" });
  }
}
