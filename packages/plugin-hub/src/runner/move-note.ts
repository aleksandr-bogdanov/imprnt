import type { NativeImport, NativeSide } from "../adapters/types.ts";
import type { StoreLike } from "../store/connect.ts";
import { MoveNoteRefused } from "../store/conversations.ts";
import { copiesOf, pendingNotesOf, readMove, type MoveNotice, type MoveRow } from "../store/moves.ts";
import { nativeSideOf } from "./move-export.ts";
import { isRecord, sha256 } from "./move-handoff.ts";

/**
 * THE RELOCATION NOTE: what the model is told, once, with the first real input after its conversation moved.
 *
 * It is a PURE FUNCTION OF THE MOVE ROW (its machines and runners, the native session, the directory the source's transcript names and the
 * one the destination's facts record), because the store keeps only its sha256 (`serveMove` is handed the digest, `noteDelivered` is handed
 * the body and the store compares them): the body a later feed composes must hash to the digest declared at serve, byte for byte, across
 * restarts and across machines. A change of this text therefore changes the digest of every note still owed, and a feed composed from a
 * newer template refuses to carry an older note (`digest-mismatch`, below) instead of writing down words the move never declared: bump
 * `NOTE_VERSION` and keep the old template when this changes while a move can be owed. Version 1 was corrected in place once, before any
 * move had been served: an earlier wording of its last paragraph promised that the vault and the zone arrive by the hub's own sync, which
 * nothing awaits, bounds or verifies. No body of that wording is kept in the repository (the store holds a digest, and no test or fixture
 * carries one) and no shipped build has served a move, so there is no template to preserve; from the first served move on, a change of any
 * word needs a new version.
 *
 * It says what changed (machine, directory), what did NOT (the same conversation and native session, nothing started fresh), that the
 * transcript's own absolute paths were not rewritten, and what the move did not carry (everything but the transcript). It is not an
 * instruction and says so. It is wire text only: never the conversation's own input, never part of an attempt's digest; the store records it
 * in the conversation (a `recovery` entry, once, `move-note:<move>`) when it acknowledges delivery.
 */
export const NOTE_VERSION = 1;

const pathOf = (side: NativeSide | null): string | null => (side ? side.cwd : null);

export function relocationNote(move: MoveRow): string {
  const carried = move.manifest?.native_export;
  const was = pathOf(nativeSideOf(isRecord(carried) ? carried.from : null));
  const now = pathOf(nativeSideOf(move.dest_facts?.native));
  const lines = [
    `[hub] RELOCATION NOTE ${NOTE_VERSION}, begin. The hub moved this conversation from machine ${move.source_machine} (runner ${move.source_runner}) to machine ${move.dest_machine} (runner ${move.dest_runner}).`,
    `It is the same conversation in the same native session (${move.native_session}); nothing was started fresh and nothing was replayed.`,
  ];
  if (was !== null && now !== null) {
    lines.push(
      `Your working directory changed from ${was} to ${now}. Absolute paths earlier in this conversation's transcript name the old machine and directory: they were NOT rewritten, ` +
      `so do not assume a file at an old absolute path exists here, and use the paths you are given now.`,
    );
  } else {
    lines.push("The engine had not started this conversation before it moved, so there is no earlier transcript and no old directory.");
  }
  lines.push(
    "Only the session's transcript moved. The hub did not carry, sync or verify anything else of the old machine (no vault or shared-zone file, no repository working copy, no other file of its tree), so do not assume that anything filed or edited there is available here.",
    "[hub] RELOCATION NOTE, end. This is not a request: take it into account and answer the message that follows.",
  );
  return lines.join("\n");
}

/** The digest `serveMove` declares for a move's note: the sha256 of the body's UTF-8 bytes, as the store computes it. */
export const noteDigestOf = (move: MoveRow): string => sha256(relocationNote(move));

/** The owner's notice that the move went through, in the person's language; sent through the outbox, once, under the move's own key. */
export function moveNotice(move: MoveRow, language: "en" | "ru"): MoveNotice | null {
  const body = language === "ru"
    ? `${move.agent} теперь работает на машине ${move.dest_machine}. Разговор продолжается там, в той же сессии.`
    : `${move.agent} now runs on ${move.dest_machine}. The conversation continues there, in the same session.`;
  return { body, person: move.person, agent: move.agent, route: move.route };
}

/** One owed note as a feed carries it: the move, the digest it declared and the body composed now (which hashes to that digest). */
export interface CarriedNote { move: string; digest: string; body: string }

/**
 * THE NOTES THE NEXT FEED OF THIS CONVERSATION MUST CARRY, oldest first, or none. The store owns what is owed (`pendingNotesOf`: a note
 * stays owed until `noteDelivered`, which only evidence of a received attempt makes); this only composes the bodies. A conversation other
 * than the one the notes are owed to (a job's) carries none. A body that does not hash to its declared digest is `MoveNoteRefused` (the
 * feed is rolled back by the existing machinery: `handBack`): no other text is ever fed as a move's explanation.
 */
export async function notesOwedTo(store: StoreLike, agent: string, conversation: string): Promise<CarriedNote[]> {
  const owed = await pendingNotesOf(store, agent);
  if (owed.length === 0 || owed.some(one => one.conversation !== conversation)) return [];
  const carried: CarriedNote[] = [];
  for (const note of owed) {
    const move = await readMove(store, note.move);
    if (!move) throw new MoveNoteRefused(note.move, "move-missing");
    const body = relocationNote(move);
    if (sha256(body) !== note.digest) throw new MoveNoteRefused(note.move, "digest-mismatch");
    carried.push({ move: note.move, digest: note.digest, body });
  }
  return carried;
}

/** What goes ahead of the input on the wire: every body, oldest first, then the input follows after a blank line. */
export const noteBlock = (notes: CarriedNote[]): string => notes.map(one => one.body).join("\n\n");

/**
 * The import a destination made, from what its copy recorded when it promoted (the same fields `importSession` returned), for the one check
 * that follows the first real resumed turn. Null for a conversation the engine had not started (nothing was imported) and for a move whose
 * copy does not carry a complete record (the check is then not made, and the caller says so: it is never guessed).
 */
export async function importedBy(store: StoreLike, move: MoveRow): Promise<NativeImport | null> {
  if (move.snapshot?.native_state === "new") return null;
  const copy = (await copiesOf(store, move.id)).find(one => one.kind === "dest_import" && one.generation === move.import_generation && one.machine === move.dest_machine);
  const promoted = copy?.evidence.promoted;
  if (!isRecord(promoted) || !isRecord(promoted.to) || !isRecord(promoted.transcript) || !isRecord(promoted.receipt) ||
      typeof promoted.bundle_digest !== "string" || typeof promoted.native_manifest_digest !== "string") return null;
  return {
    native_manifest_digest: promoted.native_manifest_digest, to: promoted.to as unknown as NativeSide, bundle_digest: promoted.bundle_digest,
    transcript: promoted.transcript as unknown as NativeImport["transcript"], receipt: promoted.receipt as unknown as NativeImport["receipt"], reused: promoted.reused === true,
  };
}
