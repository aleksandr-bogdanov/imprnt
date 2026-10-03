import { lstatSync, mkdirSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { NativeRefusal } from "../adapters/types.ts";
import { TransferError } from "../transfer/bundle.ts";
import { captureWorkspace, errnoOf } from "../transfer/workspace.ts";
import { copiesAtLocation, copyRemoved, readMove, returnableCopy, type MoveCopyRow, type MoveRow } from "../store/moves.ts";
import { MOVE_NATIVE_LIMITS, isCurrent, isRecord, raise, sameJson, waiting, who, type HandoffStep, type HandoffWorld } from "./move-handoff.ts";

interface Identity { dev: number; ino: number }
interface ArchiveIntent { session_dir: string; archive_dir: string; root: Identity; archive_root: Identity; native_digest: string; version: string }
function directory(path: string): Identity | null {
  try {
    const st = lstatSync(path);
    if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(path) !== path) throw new NativeRefusal("native_dest_session_collision");
    return { dev: st.dev, ino: st.ino };
  } catch (error) { if (errnoOf(error) === "ENOENT") return null; throw error; }
}

/** Caller holds the conversation's exclusive lock. Archive only a sealed older
 * source incarnation of this location. No deletion and no merge: the next import
 * gets an absent directory. Journal inode/path identities before the rename, so
 * a crash on either side of it can be distinguished from a conflicting tree. */
export async function reconcileReturn(w: HandoffWorld, move: MoveRow): Promise<HandoffStep | null> {
  const occupants = (await copiesAtLocation(w.store, { conversation: move.conversation_id, machine: w.machine }))
    .filter(cp => cp.state !== "removed" && cp.state !== "superseded");
  if (occupants.length !== 1 || !await returnableCopy(w.store, occupants[0], w.runner)) return waiting("copy-occupied");
  const copy = occupants[0];
  const old = await readMove(w.store, copy.move_id);
  if (!old || !await isCurrent(w) || !w.idle(move.agent)) return waiting("return-not-idle");
  try { return await archive(w, move, old, copy); }
  catch (error) {
    if (error instanceof NativeRefusal || error instanceof TransferError) {
      return raise(w, move.id, "native_retained_copy_conflict", { reason: error.code, copy: copy.move_id });
    }
    throw error;
  }
}

async function archive(w: HandoffWorld, move: MoveRow, old: MoveRow, copy: MoveCopyRow): Promise<HandoffStep | null> {
  const port = w.port(move.adapter);
  if (!port) return raise(w, move.id, "native_port_missing", { adapter: move.adapter });
  const sealed = old.manifest?.native_export;
  if (!isRecord(sealed) || !isRecord(sealed.from) || !Array.isArray(sealed.files) || sealed.files.length !== 1) return waiting("copy-unsealed");
  const expected = sealed.files[0];
  if (!isRecord(expected) || typeof expected.path !== "string") return waiting("copy-unsealed");
  const digest = old.manifest!.native!.native_manifest_digest;
  const path = w.sessionDir(move);
  if (path !== sealed.from.cwd) throw new NativeRefusal("native_dest_session_collision");
  let intent = copy.evidence.archive_intent as ArchiveIntent | undefined;
  if (!intent) {
    const build = await w.build(move.agent);
    if (!build) return waiting("build-unreadable");
    const root = directory(path);
    if (!root) throw new NativeRefusal("native_transcript_missing");
    const exported = port.exportSession({ sessionDir: path, nativeSession: copy.native_session, version: build.version, limits: MOVE_NATIVE_LIMITS });
    if (exported.digest !== digest || !sameJson(exported.manifest, sealed)) throw new NativeRefusal("native_export_mismatch");
    // A private, unpredictable sibling container; nothing is ever renamed over
    // an existing destination. An interrupted pre-journal allocation is empty.
    const archiveDir = `${path}-retained-${crypto.randomUUID()}`;
    mkdirSync(archiveDir, { mode: 0o700 });
    intent = { session_dir: path, archive_dir: archiveDir, root, archive_root: directory(archiveDir)!, native_digest: digest, version: build.version };
    const answer = await journal(w, move, copy, intent);
    if (answer !== "recorded" && answer !== "replay") { rmdirSync(archiveDir); return waiting(answer); }
    await w.say("move.return-archive-intent", { move: move.id, copy: copy.move_id });
  }
  // Re-read all store fences on retries, before touching the directory. A stale
  // incarnation, newer placement or a withdrawn move can never finish this step.
  const answer = await journal(w, move, copy, intent);
  if (answer !== "recorded" && answer !== "replay") return waiting(answer);
  if (!w.idle(move.agent) || !await isCurrent(w)) return waiting("return-not-idle");
  if (intent.session_dir !== path || intent.native_digest !== digest || dirname(intent.archive_dir) !== dirname(path)
      || !intent.archive_dir.startsWith(`${path}-retained-`) || !sameJson(directory(intent.archive_dir), intent.archive_root)) {
    throw new NativeRefusal("native_dest_session_collision");
  }
  const target = join(intent.archive_dir, "session");
  const source = directory(path);
  const archived = directory(target);
  if (archived) {
    if (source !== null || !sameJson(archived, intent.root)) throw new NativeRefusal("native_dest_session_collision");
  } else {
    if (!sameJson(source, intent.root)) throw new NativeRefusal("native_dest_session_collision");
    const exported = port.exportSession({ sessionDir: path, nativeSession: copy.native_session, version: intent.version, limits: MOVE_NATIVE_LIMITS });
    if (exported.digest !== digest || !sameJson(exported.manifest, sealed)) throw new NativeRefusal("native_export_mismatch");
    // Synchronous with the final identity check, under the runner's exclusive
    // lock, into our private empty container. Unknown preexisting trees refuse.
    if (!sameJson(directory(path), intent.root) || directory(target) !== null) throw new NativeRefusal("native_dest_session_collision");
    renameSync(path, target);
    await w.say("move.return-archived", { move: move.id, copy: copy.move_id });
  }
  // A crash-retry checks the transcript without reinterpreting the old locator
  // against the archive's new cwd. The retained tree is never launched there.
  const captured = captureWorkspace({ root: target, paths: [expected.path], class: "native", limits: MOVE_NATIVE_LIMITS });
  const file = captured.bundle.manifest.entries[0];
  if (!file || file.kind !== "file" || file.sha256 !== expected.sha256 || file.size !== expected.size || file.mode !== expected.mode) {
    throw new NativeRefusal("native_export_mismatch");
  }
  const removed = await copyRemoved(w.store, copy.move_id, who(w), copy.generation,
    { staging: copy.staging_id, removed: "archived", archive: intent, retained: true }, "source_session_retained");
  if (removed !== "removed" && removed !== "replay") return waiting(removed);
  await w.say("move.return-reconciled", { move: move.id, copy: copy.move_id, retained: true });
  return null;
}

async function journal(w: HandoffWorld, move: MoveRow, copy: MoveCopyRow, intent: ArchiveIntent): Promise<string> {
  const [row] = await w.store.sql`select hub_move_copy_archive_intent(${move.id}, ${w.runner}, ${w.incarnation},
    ${copy.move_id}, ${copy.generation}::integer, ${intent}::jsonb) as answer`;
  return String(row.answer);
}
