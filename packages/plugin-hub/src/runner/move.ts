import { createHash, randomUUID } from "node:crypto";
import type { AdapterSession, ExitEvidence } from "../adapters/types.ts";
import { safeValue } from "../door/lines.ts";
import { bootMoved, groupPresence, presence } from "../os/tree.ts";
import type { Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { MoveGated, MoveNoteRefused, provenUnfedEnd } from "../store/conversations.ts";
import { listenForWork, type Listener } from "../store/listen.ts";
import {
  blockMove, checkpointOf, movesOfRunner, readMove, recordDrainDone, recordDrainIntent, sealDrainIntents, unblockMove,
  type DrainExit, type DrainIntent, type DrainIntentAnswer, type MoveRow,
} from "../store/moves.ts";
import { endAttempt, type Here } from "./execution.ts";

/**
 * The runner's end of a topic move, as the SOURCE of it: from the owner's request until the store says the drain is over. It
 * exports the movement itself to nobody (no export, release, import or serve is here), and it never decides whether a move may
 * go on: the store does, from what this file asserts, and every assertion below says what it rests on.
 *
 * WHAT A REQUEST DOES TO THIS RUNNER. The request commits a gate on the agent (`claim_gate`, cause `move`) and a notification.
 * From the commit the store refuses a new attempt and the first feed of an unfed one; the turn that was already fed finishes.
 * This file answers with a LOCAL FENCE per agent, placed synchronously from the read of the move (`watchMoves`) and before
 * anything is awaited: no child is started for a fenced agent (`SpawnFenced`, thrown at the first line of `spawn`), no row is
 * claimed for it, and a child that is idle is not closed by the idle timer: the drain closes it, AFTER its intent is durable.
 * The fence outlives the drain on purpose: it is lifted by a withdrawal, and by nothing else except the authoritative
 * placement saying the conversation is on this machine again (a later move back), never by the move merely leaving the list of
 * open ones (`movesOfRunner` leaves terminal rows out, and a move that went through is exactly the one the source must not serve).
 *
 * WHAT THE DRAIN IS. The drain is run INSIDE the agent's own loop when it has one (a job the loop takes at the top of its
 * iteration, `runner/run.ts`), so it is sequential with the loop's spawn, claim, feed and idle close and cannot race them; with
 * no loop it is run here, where nothing can start a child because the fence is placed. It persists an INTENT (`recordDrainIntent`)
 * naming the actual child (its leader, process group, processes, conversation, native session and the placement it served, in
 * the boot this incarnation registered) BEFORE the child is closed, closes it, and sends the evidence the store accepts:
 *   `process-group`  the very group the intent named, shown empty (by the adapter at the close, or by a fresh look at the process
 *                    table of this machine in this boot), with the leader and every recorded process gone;
 *   `boot`           the machine booted again since an item of a predecessor was recorded;
 *   `no-child`       this incarnation holds no child of the agent, every one it started is shown gone, and its spawns are fenced.
 * A signal is never sent to a process this runner does not hold (a recorded pid is not proof of which process it is now), an
 * empty list proves nothing, a close that resolved proves nothing, and a handle that is gone from memory proves nothing: what an
 * incarnation owes is kept per child (`createLedger`), through idle closes, replacements, errors and shutdown.
 *
 * WHAT IS NOT PROOF is a block, never a guess: `drain_unproven` names the reason (`survivors`, `no-process-group`,
 * `predecessor-alive`, `predecessor-no-intent`, ...), the gate stays, and nothing is signalled. Only that one code, written by this
 * side, is ever cleared here, and only when its reason is gone; another party's block is never replaced or cleared.
 *
 * THE INTENTS OF AN INCARNATION ARE EVIDENCE ONLY AS A COMPLETE SET. Every intent is written `set: "open"`, which makes the store keep a
 * `seal` item for the incarnation until `sealDrainIntents` says the intents it wrote are every child it owes an account of. The set
 * is made complete in TWO STAGES (`settleSet`). BEFORE anything is closed or asserted the PRE-CLOSE intent of every child of the agent
 * that is not shown gone is recorded (the ones closed earlier without proof first, the open one last): that is what lets a close
 * begin, and it is not a seal, because a child that is open or closing is not yet known in full (the close observes it once more and
 * the adapter's exit evidence reports processes of its own). AFTER the close the FINAL known union of every child is made durable (an
 * additive final intent of its own, only where the immutable pre-close one does not cover it) and only then is the set SEALED. A look
 * that cannot complete it (an intent refused, the limit, a final document too large, a boot that cannot be read, a spawn in flight)
 * submits no evidence, whatever else it could have shown, and never certifies; a close is not held up by it, so a stop or a shutdown
 * can close but not certify. An incarnation that died with a set it never sealed (before the close, after it and before the final
 * write, or between the final write and the seal) is a predecessor whose children nobody can account for, so a successor in the same
 * boot blocks (`predecessor-intents-incomplete`) until a reboot or a withdrawal.
 */

export const BLOCK = "drain_unproven";

/** A spawn for an agent this runner is fenced from: thrown before anything is started or reserved. */
export class SpawnFenced extends Error {
  constructor(readonly agent: string, readonly move: string | null) {
    super(`spawn-fenced: ${agent}`);
    this.name = "SpawnFenced";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------------------------------------------------

export interface Fence {
  agent: string;
  /** The move that gates the agent, or null for a placement that is elsewhere without a move this runner knows. */
  move: string | null;
  /**
   * `move`    a move of which this runner is the source and that has not ended, or has been withdrawn and is not yet seen to be.
   * `placed`  the conversation is placed on another machine (a move that went through, or a refusal by the store): lifted only by
   *           the placement being here again at a LATER generation.
   */
  kind: "move" | "placed";
  stage: string;
  /** The placement generation this fence gave way to: only a later one lifts it. */
  after: number | null;
}

export function createFences() {
  const held = new Map<string, Fence>();
  return {
    has: (agent: string): boolean => held.has(agent),
    get: (agent: string): Fence | undefined => held.get(agent),
    set(fence: Fence): void { held.set(fence.agent, fence); },
    lift: (agent: string): boolean => held.delete(agent),
    all: (): Fence[] => [...held.values()],
  };
}
export type Fences = ReturnType<typeof createFences>;

// ---------------------------------------------------------------------------------------------------------------------
// The children this incarnation owes an account of
// ---------------------------------------------------------------------------------------------------------------------

export interface ChildRecord {
  readonly id: string;
  readonly agent: string;
  /** `starting`: an adapter start is in flight; `open`: held by a loop; `closing`: a close is in flight; `closed`: closed, proven or not. */
  phase: "starting" | "open" | "closing" | "closed";
  /** The adapter's handle, while this process holds it. */
  session: AdapterSession | null;
  conversation: string | null;
  nativeSession: string | null;
  placement: number | null;
  leader: number | null;
  group: number | null;
  /** The union of every process ever seen under the child. */
  pids: number[];
  partial: boolean;
  /** Shown gone: the adapter confirmed it on the process-group basis at the close, or a fresh look of this machine's process table did. */
  gone: boolean;
  /** Why a closed child is not shown gone, in words. */
  unproven: string | null;
  exit: ExitEvidence | null;
  /** The adapter was asked to start a child and gave no handle: nothing can ever show whether one exists. */
  lost: boolean;
  /** The intent document of this child for each move that asked for one (by move id), frozen so that a retry sends it exactly as it was. */
  docs: Map<string, DrainIntent>;
  /** The moves it was persisted for (before the close: the PRE-CLOSE intent). */
  intents: Set<string>;
  /**
   * The FINAL intent document of this child for each move whose pre-close document no longer covers what is known of it after the close
   * (`finalIntentOf`), frozen like `docs` so that a retry sends it exactly as it was.
   */
  finals: Map<string, DrainIntent>;
  /** The moves for which this child's final intent is durable (a child whose pre-close document covers it has none, and needs none). */
  finalized: Set<string>;
}

/**
 * EVERY CHILD OF THIS INCARNATION THAT MAY STILL EXIST, per agent, and what is known of each. A record is made before the adapter
 * is asked to start (so a request that arrives meanwhile finds it) and kept until the child is SHOWN gone and nothing is owed for
 * it: a handle that went out of memory, a `close()` that resolved and a session pointer that is null prove nothing, so a record
 * that was closed without proof stays, with what was known of the child, until a fresh look proves it gone.
 */
export function createLedger() {
  const byAgent = new Map<string, ChildRecord[]>();
  const drop = (rec: ChildRecord): void => {
    const rest = (byAgent.get(rec.agent) ?? []).filter(one => one !== rec);
    if (rest.length === 0) byAgent.delete(rec.agent); else byAgent.set(rec.agent, rest);
  };
  const ledger = {
    /** Before the adapter is asked: the child it may start is already owed an account of. */
    starting(agent: string, about: { conversation?: string | null; nativeSession?: string | null; placement?: number | null } = {}): ChildRecord {
      const rec: ChildRecord = { id: randomUUID(), agent, phase: "starting", session: null, conversation: about.conversation ?? null,
        nativeSession: about.nativeSession ?? null, placement: about.placement ?? null, leader: null, group: null, pids: [], partial: false,
        gone: false, unproven: null, exit: null, lost: false, docs: new Map(), intents: new Set(), finals: new Map(), finalized: new Set() };
      byAgent.set(agent, [...(byAgent.get(agent) ?? []), rec]);
      return rec;
    },
    /** The adapter was never called (something refused first): no child can exist. */
    abandon(rec: ChildRecord): void { rec.phase = "closed"; rec.gone = true; drop(rec); },
    /** The adapter answered with a handle. */
    started(rec: ChildRecord, session: AdapterSession): void {
      rec.session = session;
      rec.phase = "open";
      rec.leader = session.pid ?? null;
      ledger.observe(rec);
    },
    /** The adapter was called and threw: a process may have been made and nothing here can say. It stays owed. */
    lost(rec: ChildRecord): void {
      rec.phase = "closed";
      rec.lost = true;
      rec.unproven = "the adapter was asked to start a child and gave no handle, so nothing shows whether a process was made";
    },
    /** What the handle says of the child now (a read of the process table: call it at a boundary, not on a timer). */
    observe(rec: ChildRecord): void {
      const session = rec.session;
      if (!session) return;
      try {
        if (typeof session.pid === "number" && session.pid > 0) rec.leader = session.pid;
        const group = session.group?.() ?? null;
        if (group !== null) rec.group = group;
        const tree = session.processes?.() ?? null;
        if (tree) ledger.record(rec, { pids: tree });
        if (session.partial?.() === true) rec.partial = true;
      } catch { /* a lookup that failed adds nothing */ }
    },
    /** What the runner already read (its own `noteTree`): merged, never replaced. */
    record(rec: ChildRecord, seen: { leader?: number | null; group?: number | null; pids?: number[]; partial?: boolean }): void {
      if (typeof seen.leader === "number") rec.leader = seen.leader;
      if (typeof seen.group === "number") rec.group = seen.group;
      if (seen.partial === true) rec.partial = true;
      const next = new Set([...rec.pids, ...(seen.pids ?? []), ...(rec.leader !== null ? [rec.leader] : [])]);
      rec.pids = [...next].filter(one => Number.isInteger(one) && one > 1).sort((a, b) => a - b);
    },
    closing(rec: ChildRecord): void { ledger.observe(rec); rec.phase = "closing"; },
    /**
     * The close finished. THE CHILD IS GONE ONLY IF THE ADAPTER SAID SO ON THE ONE BASIS THAT COVERS WHAT WAS NEVER SEEN: its own
     * process group, empty, with the leader exited, for the group this record names. Anything else (no evidence, an observed tree, a
     * failed lookup, a survivor) leaves the record owed. What the exit evidence itself reports (every process the session had seen,
     * the ones still present and the ones whose lookup failed) is merged into the union first: it is part of what is known of the
     * child, and a pre-close document that lacks it is made good by a final intent before the set is sealed (`settleSet`).
     */
    closed(rec: ChildRecord, exit: ExitEvidence | null, why: string | null): void {
      rec.phase = "closed";
      rec.session = null;
      rec.exit = exit;
      if (exit) {
        const reported = [exit.pids, exit.survivors, exit.unknown].flatMap(list => (Array.isArray(list) ? list : []));
        ledger.record(rec, { pids: reported, partial: exit.partial === true });
      }
      const proven = exit?.confirmed === true && exit.basis === "process-group" && typeof exit.group === "number" && exit.group === rec.group;
      if (proven) {
        rec.gone = true;
        rec.unproven = null;
        if (rec.intents.size === 0) drop(rec);
      } else {
        rec.gone = false;
        rec.unproven = why ?? (exit ? `exit not confirmed (leader ${exit.leader}, descendants ${exit.descendants}, basis ${exit.basis ?? "none"})` : "no exit evidence");
      }
    },
    /** Nothing is owed for it any more. */
    forget(rec: ChildRecord): void { drop(rec); },
    of: (agent: string): ChildRecord[] => [...(byAgent.get(agent) ?? [])],
    /** A child is being started or closed by somebody right now. */
    busy: (agent: string): boolean => (byAgent.get(agent) ?? []).some(one => one.phase === "starting" || one.phase === "closing"),
  };
  return ledger;
}
export type ChildLedger = ReturnType<typeof createLedger>;

export interface Look {
  state: "gone" | "alive" | "unknown";
  why: string;
  /** The recorded processes still present. */
  present: number[];
}

/**
 * A fresh look at the process table of THIS machine in THIS boot: the group is empty, the leader is gone and every process
 * recorded under it is gone. Only the system's "no such process" is gone, a lookup that failed is unknown, and an empty record
 * (no group, no leader) proves nothing: a child that did not lead a group of its own has no witness for what was never seen.
 * Nothing is signalled (signal 0 only asks), and a recycled pid can only make a child look present, never gone.
 */
export function lookAt(seen: { leader?: number | null; group?: number | null; pids?: number[] | null }): Look {
  const group = typeof seen.group === "number" ? seen.group : null;
  if (group === null) return { state: "unknown", why: "no-process-group", present: [] };
  const inGroup = groupPresence(group);
  const leader = typeof seen.leader === "number" ? presence(seen.leader) : "unknown";
  const looked = (seen.pids ?? []).filter(one => Number.isInteger(one)).map(one => [one, presence(one)] as const);
  const present = looked.filter(([, said]) => said === "present").map(([one]) => one);
  if (inGroup === "present" || leader === "present" || present.length > 0) return { state: "alive", why: "survivors", present };
  if (inGroup === "absent" && leader === "absent" && looked.every(([, said]) => said === "absent")) return { state: "gone", why: "gone", present: [] };
  return { state: "unknown", why: "unverified", present: [] };
}

/**
 * The intent for one child under one move: what it is, in the boot and on the machine this incarnation registered. Frozen on the
 * record PER MOVE, the first time that move asks, so that a retry within the move sends the same bytes; a later move gets a document
 * of its own, built from the union as it is then (a child that stayed open after a withdrawal has been seen since).
 * `pids` is the WHOLE union the ledger holds, never a prefix: a successor looks at nothing else. A document the store finds too large
 * is refused (`intent-invalid`), and a refused intent is never sealed, closed for movement or submitted (`settleSet`).
 */
export function intentOf(rec: ChildRecord, move: string, here: Here, late: boolean): DrainIntent {
  let doc = rec.docs.get(move);
  if (!doc) {
    doc = {
      id: rec.id, boot_id: here.boot!, machine: here.machine!,
      leader: rec.leader, group: rec.group, pids: [...rec.pids],
      conversation: rec.conversation, native_session: rec.nativeSession, placement_generation: rec.placement,
      partial: rec.partial, ...(rec.lost ? { lost: true } : {}), ...(late ? { late: true } : {}), set: "open",
    };
    rec.docs.set(move, doc);
  }
  return doc;
}

/** Whether a document already names everything the ledger knows of the child now: every process, the leader and group, and the doubts. */
function covers(doc: DrainIntent, rec: ChildRecord): boolean {
  const named = new Set(doc.pids ?? []);
  return rec.pids.every(one => named.has(one))
    && (!rec.partial || doc.partial === true)
    && (!rec.lost || doc.lost === true)
    && (rec.leader === null || rec.leader === doc.leader)
    && (rec.group === null || rec.group === doc.group);
}

/**
 * The FINAL intent of a closed child under one move, or null when its pre-close document (immutable, already durable) still covers all
 * that is known of it. The close observes the child once more (`closing`) and the adapter's exit evidence reports processes of its own
 * (`closed`), so the union can have grown after the pre-close document was frozen: a process seen only then would be missing from what a
 * successor of the same boot reads. The final document is ADDITIVE, never a replacement: it has an id of its own (stable, per child:
 * the store keys intents by id within the move, so one per child and move), carries the whole union as it is after the close, and is
 * frozen like the first so that a retry sends the same bytes. A document that grew again after it was frozen is not replaced either
 * (`settleSet` refuses to seal over it).
 */
export function finalIntentOf(rec: ChildRecord, move: string, here: Here): DrainIntent | null {
  const first = rec.docs.get(move);
  if (!first) return null;
  const frozen = rec.finals.get(move);
  if (frozen) return frozen;
  if (covers(first, rec)) return null;
  const doc: DrainIntent = {
    id: `${rec.id}:final`, boot_id: here.boot!, machine: here.machine!,
    leader: rec.leader, group: rec.group, pids: [...rec.pids],
    conversation: rec.conversation, native_session: rec.nativeSession, placement_generation: rec.placement,
    partial: rec.partial, ...(rec.lost ? { lost: true } : {}), of: rec.id, final: true, set: "open",
  };
  rec.finals.set(move, doc);
  return doc;
}

// ---------------------------------------------------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What the runner's tick has to look at again: the store owes an answer, or local evidence may move (read nothing until it does): a process
 * (the drain's) or the facts of this machine a refusal was made from (the registry's bytes, the tree, the default instruction files).
 */
export type Owed = { kind: "store" } | { kind: "local"; changed(): boolean };

export interface DrainStep {
  state: "drained" | "waiting" | "ended";
  why: string;
  owed: Owed | null;
  /**
   * The move as this look READ it before it decided (never re-read after its awaits): a change committed meanwhile, by the other side, differs
   * from it and is looked at. What this look itself wrote differs from it too, and is looked at ONCE more: every write repeated on facts that did
   * not change is a no-op, so that look writes nothing and ends on the row it read.
   */
  seen: string | null;
}

export interface DrainWorld {
  store: StoreLike;
  runner: string;
  incarnation: string;
  here: Here;
  ledger: ChildLedger;
  /** Whether spawns of this agent are fenced here: no-child is asserted only while they are. */
  fenced(agent: string): boolean;
  /** Nothing holds the agent: no attempt of its own, no stop in flight, no child being started or closed. */
  quiet(agent: string): boolean;
  /** Close one open child of this process, recording what became of it in the ledger and letting go of it. */
  close(record: ChildRecord): Promise<void>;
  /** The diary. The caller keeps to one line per move and per thing said. */
  say(kind: string, detail: Record<string, unknown>): Promise<void>;
}

/** The row as one look read it: its stage and time, and a hash of every column, because two commits of one stage can share a millisecond. */
export const digestOf = (move: MoveRow): string =>
  `${move.stage}|${move.updated_at.getTime()}|${createHash("sha256").update(JSON.stringify(move)).digest("hex").slice(0, 16)}`;

interface Item { kind: "intent" | "owner" | "seal"; id: string; incarnation: string | null; boot: string | null; unknown?: boolean; intent?: DrainIntent & { incarnation: string } }

/** What the store lists as owed (`hub_move_drain_items`), read off the move: for diagnosis and for sending only what is pending. The store decides. */
function itemsOf(move: MoveRow, mine: string, boot: string | null): Item[] {
  const items: Item[] = [];
  const owners: string[] = [];
  for (const intent of move.drain_intents) {
    items.push({ kind: "intent", id: intent.id, incarnation: intent.incarnation, boot: intent.boot_id ?? null, intent });
    owners.push(intent.incarnation);
  }
  // An incarnation that wrote its intents open owes a seal item until it sealed them (`hub_move_drain_items`).
  const sealed = new Set((move.drain_sealed ?? []).map(one => one.incarnation));
  const opened = new Set<string>();
  for (const intent of move.drain_intents) {
    if (intent.set !== "open" || opened.has(intent.incarnation)) continue;
    opened.add(intent.incarnation);
    if (!sealed.has(intent.incarnation)) items.push({ kind: "seal", id: intent.incarnation, incarnation: intent.incarnation, boot: intent.boot_id ?? null });
  }
  const baseline = move.source_incarnation;
  if (baseline.known) {
    if (!owners.includes(baseline.incarnation)) {
      items.push({ kind: "owner", id: baseline.incarnation, incarnation: baseline.incarnation, boot: baseline.boot_id });
      owners.push(baseline.incarnation);
    }
  } else items.push({ kind: "owner", id: "unknown", incarnation: null, boot: null, unknown: true });
  if (!owners.includes(mine)) items.push({ kind: "owner", id: mine, incarnation: mine, boot });
  return items;
}
const resolvedIn = (move: MoveRow, item: Item): boolean => move.drain_resolutions.some(one => one.kind === item.kind && one.id === item.id);
const pendingOf = (move: MoveRow, mine: string, boot: string | null): Item[] => itemsOf(move, mine, boot).filter(item => !resolvedIn(move, item));

const exitGroup = (group: number, via: string): DrainExit =>
  ({ confirmed: true, leader: "exited", descendants: "none", basis: "process-group", via, group });
const EXIT_BOOT: DrainExit = { confirmed: true, leader: "exited", descendants: "none", basis: "boot",
  via: "the machine booted again after the intent or the incarnation was recorded, so none of its processes can still be running" };
const EXIT_NO_CHILD: DrainExit = { confirmed: true, basis: "no-child", children: "none", spawn_closed: true,
  via: "this incarnation holds no child of the agent, every child it started is shown gone, and its spawns of the agent are fenced" };

interface Reason { reason: string; detail: Record<string, unknown> }

/**
 * The intent to close one child, durable BEFORE it is closed. `intent` and `replay` mean it is; anything else is the store's
 * refusal and the child is not closed for movement. An intent for a child that is already closed and not shown gone is recorded
 * too, late (`late`): what an incarnation cannot show is owed must survive the incarnation that could not show it.
 */
export async function recordIntent(w: DrainWorld, move: MoveRow, rec: ChildRecord, late = false): Promise<DrainIntentAnswer | "boot-unknown"> {
  if (w.here.boot === null || w.here.machine === null) return "boot-unknown";
  if (rec.intents.has(move.id)) return "replay";
  if (rec.phase === "open") w.ledger.observe(rec);
  const answer = await recordDrainIntent(w.store, move.id, { runner: w.runner, incarnation: w.incarnation }, intentOf(rec, move.id, w.here, late));
  if (answer === "intent" || answer === "replay") {
    rec.intents.add(move.id);
    await w.say("move.drain.intent", { move: move.id, agent: move.agent, intent: rec.id, group: rec.group, leader: rec.leader, late });
  }
  return answer;
}

export interface SetStep {
  /**
   * PRE-CLOSE RECORDED: every child of the agent that is not shown gone has its pre-close intent durable, so a close may begin. It says
   * nothing about the lifetime evidence being final: while a child is open or closing the set is never sealed.
   */
  recorded: boolean;
  /**
   * FINAL-SEALED: no child of the agent is open, closing or starting, the final known union of every child is durable (its pre-close
   * intent or a final one that covers it), and the set is sealed (or there is nothing to seal). Only this lets evidence be submitted.
   */
  sealed: boolean;
  /**
   * Why it is not sealed, in the drain's own words (`intent-refused`, `intent-unrecorded`, `final-unrecorded`, `final-changed`,
   * `seal-refused`, `unfenced`, `child-open`, `child-in-flight`, `boot-unknown`).
   */
  reason: string | null;
  /** The store's answer to the write that stopped it. */
  answer: string | null;
  /** The child whose intent stopped it. */
  child: string | null;
  /** A child is being started or closed by somebody: nothing was written, and the look is for later. */
  inflight: boolean;
}

/**
 * MAKE THE SET OF THIS INCARNATION'S INTENTS COMPLETE AND FINAL, and only then say so (`sealDrainIntents`). The store treats the intents
 * an incarnation recorded as the whole account of its lifetime once it has recorded any (a `set: "open"` intent keeps a `seal` item
 * pending until sealed), so the set has to hold every child of the agent that is not shown gone, as they are known AFTER they are
 * closed. Two stages, one function, called wherever a child is about to be closed and again after it was:
 *   RECORDED  (the pre-close intents): first the children that were closed without proof and have no intent (late, in ledger order),
 *             then the open one, each only if every one before it was durable. A child that is open or closing is never sealed over:
 *             the close observes it again and the adapter's exit evidence reports processes of its own, so what is known of it is not
 *             final until it is closed. `recorded` is what lets a close begin.
 *   SEALED    (the final evidence): once no child is open, closing or starting, every closed child whose pre-close intent no longer
 *             covers the union known of it gets a final intent of its own (`finalIntentOf`, additive and immutable), and only when
 *             all of them are durable is the set sealed, once and only while spawns of the agent are fenced, so that the seal says
 *             what is true: this incarnation can start no other child under this move.
 * The first write the store refuses (an intent too large, the limit of intents, a seal) ends it: what was written stays, the set
 * stays UNSEALED (the store keeps its `seal` item pending, so the successor of an incarnation that dies anywhere in here, after the
 * close and before the final write or between it and the seal, finds an open set and certifies nothing in the same boot), and
 * the caller submits no evidence. A close is never prevented by this: a stop or a shutdown may close, it just cannot certify.
 * An incarnation with nothing recorded has nothing to seal (`no-child` is its account). It signals nothing and shows nothing gone;
 * a record already shown gone by a fresh look needs no intent of its own.
 */
export async function settleSet(w: DrainWorld, move: MoveRow): Promise<SetStep> {
  const who = { runner: w.runner, incarnation: w.incarnation };
  const stop = (reason: string, answer: string | null, child: string | null, recorded: boolean, inflight = false): SetStep =>
    ({ recorded, sealed: false, reason, answer, child, inflight });
  const busy = (): ChildRecord | undefined => w.ledger.of(move.agent).find(rec => rec.phase === "starting" || rec.phase === "closing");
  if (w.here.boot === null || w.here.machine === null) return stop("boot-unknown", null, null, false);
  const first = busy();
  if (first) return stop("child-in-flight", null, first.id, false, true);
  const records = w.ledger.of(move.agent);
  for (const rec of records) {
    if (rec.phase === "closed" && !rec.gone && !rec.lost && lookAt(rec).state === "gone") rec.gone = true;
  }
  let wrote = false;
  const owed = records.filter(rec => !(rec.phase === "closed" && rec.gone) && !rec.intents.has(move.id));
  for (const rec of [...owed.filter(one => one.phase === "closed"), ...owed.filter(one => one.phase === "open")]) {
    const said = await recordIntent(w, move, rec, rec.phase === "closed");
    if (said !== "intent" && said !== "replay") return stop(rec.phase === "closed" ? "intent-unrecorded" : "intent-refused", said, rec.id, false);
    wrote = true;
  }
  // A child that began to close (or to start) while the intents were written: nothing is sealed over it, and the look is for later.
  const meanwhile = busy();
  if (meanwhile) return stop("child-in-flight", null, meanwhile.id, false, true);
  const open = w.ledger.of(move.agent).find(rec => rec.phase === "open");
  if (open) return stop("child-open", null, open.id, true);

  // FINAL: every child is closed. What is known of each now is made durable before anything is sealed.
  for (const rec of w.ledger.of(move.agent)) {
    if (rec.phase !== "closed" || !rec.intents.has(move.id)) continue;
    const doc = finalIntentOf(rec, move.id, w.here);
    if (doc === null) continue;
    if (!covers(doc, rec)) return stop("final-changed", null, rec.id, true);
    if (rec.finalized.has(move.id)) continue;
    const answer = await recordDrainIntent(w.store, move.id, who, doc);
    if (answer !== "intent" && answer !== "replay") return stop("final-unrecorded", answer, rec.id, true);
    rec.finalized.add(move.id);
    wrote = true;
    await w.say("move.drain.intent", { move: move.id, agent: move.agent, intent: doc.id, group: doc.group ?? null, leader: doc.leader ?? null, final: true });
  }
  const current = wrote ? (await readMove(w.store, move.id)) ?? move : move;
  const mine = current.drain_intents.filter(one => one.incarnation === w.incarnation).map(one => one.id);
  const sealed: SetStep = { recorded: true, sealed: true, reason: null, answer: null, child: null, inflight: false };
  if (mine.length === 0 || (current.drain_sealed ?? []).some(one => one.incarnation === w.incarnation)) return sealed;
  if (!w.fenced(move.agent)) return stop("unfenced", null, null, true);
  const answer = await sealDrainIntents(w.store, move.id, who, mine);
  return answer === "sealed" || answer === "replay" ? sealed : stop("seal-refused", answer, null, true);
}

/**
 * ONE LOOK AT ONE MOVE OF WHICH THIS RUNNER IS THE SOURCE, and whatever follows from it that can be done now. It is idempotent: a
 * look that finds nothing to do writes nothing, and one that finds the same thing says it once.
 */
export async function drainSource(w: DrainWorld, id: string): Promise<DrainStep> {
  let move = await readMove(w.store, id);
  const step = (state: DrainStep["state"], why: string, owed: Owed | null = null, last: MoveRow | null = move): DrainStep =>
    ({ state, why, owed, seen: last ? digestOf(last) : null });
  if (!move) return step("ended", "unknown-move");
  if (move.stage === "active" || move.stage === "withdrawn") return step("ended", move.stage);
  if (move.source_runner !== w.runner) return step("ended", "not-source");
  // `awaiting_owner` waits for the owner's explicit continue (and so does everything else past the drain): nothing is touched.
  if (move.stage !== "waiting") return step("waiting", move.stage);
  const agent = move.agent;
  const who = { runner: w.runner, incarnation: w.incarnation };
  if (!w.quiet(agent)) return step("waiting", "not-quiet", { kind: "store" });

  const reasons: Reason[] = [];
  const local: (() => boolean)[] = [];

  // What answers end the look, whatever it was doing. A stage that moved on is waited for (the next notification looks again), a
  // move that is gone or not this runner's is not looked at again.
  const over = (answer: string): DrainStep | null => {
    if (answer === "terminal" || answer === "not-source" || answer === "unknown-move") return step("ended", answer);
    if (answer === "stage") return step("waiting", "stage");
    if (answer === "failure-unacknowledged") return step("waiting", "awaiting_owner");
    if (answer === "busy") return step("waiting", "busy", { kind: "store" });
    return null;
  };

  /** One piece of evidence. The answers that say the move is not here to be drained end the look; the rest go on. */
  const submit = async (exit: DrainExit, intent?: string): Promise<{ answer: string; over: DrainStep | null }> => {
    for (let tried = 0; ; tried += 1) {
      const checkpoint = await checkpointOf(w.store, move!.conversation_id);
      if (!checkpoint) return { answer: "no-checkpoint", over: null };
      if (checkpoint.placement_generation !== move!.source_generation) return { answer: "placement-changed", over: null };
      const answer = await recordDrainDone(w.store, move!.id, who, {
        move: move!.id, conversation: checkpoint.conversation, native_session: checkpoint.native_session, placement_generation: move!.source_generation,
        runner: move!.source_runner, machine: move!.source_machine, incarnation: w.incarnation, boot_id: w.here.boot!,
        ...(intent ? { intent } : {}), exit,
      });
      // The native identity moved between the read and the call: read it again, once.
      if (answer === "drain-identity-mismatch" && tried === 0) continue;
      return { answer, over: over(answer) };
    }
  };
  const refused = (answer: string, detail: Record<string, unknown> = {}): void => { reasons.push({ reason: "store-refused", detail: { answer, ...detail } }); };
  /** Every answer that is neither progress nor the end of the look is the store refusing what was asserted. */
  const accepted = (answer: string): boolean => answer === "partial" || answer === "drained" || answer === "replay" || answer === "owner-unknown";

  if (w.here.boot === null || w.here.machine === null) {
    // Nothing the store accepts can be said without a boot: no child is closed for movement, and nothing is certified.
    const boundary = w.ledger.of(agent).length > 0;
    reasons.push({ reason: "boot-unknown", detail: { children: boundary } });
  } else {
    // 1. THE SET, IN TWO STAGES (`settleSet`). BEFORE ANYTHING IS CLOSED OR ASSERTED every child of the agent that is not shown gone has
    //    its pre-close intent recorded: that, and nothing more, is what lets a close begin. The set is NOT sealed over a child that is
    //    still open (the close observes it again), so after the closes it is settled a second time: the final known union of every
    //    child, the exit evidence's processes included, is made durable (a final intent where the pre-close one does not cover it), and
    //    only then sealed. A set that cannot be made complete is a block (stable: nothing is owed), and this look submits nothing: what
    //    the store would be told about part of a set proves nothing about the rest. A child already closed here stays closed.
    let set = await settleSet(w, move);
    let stopped = set.answer ? over(set.answer) : null;
    if (stopped) return stopped;
    if (set.inflight) return step("waiting", "not-quiet", { kind: "store" });
    if (set.recorded) {
      // The open child is closed under its intent, durable above. The agent is looked at again at the instant of the close: a loop that
      // took an attempt meanwhile is not closed under.
      let closedHere = false;
      for (const rec of w.ledger.of(agent)) {
        if (rec.phase !== "open") continue;
        if (!rec.intents.has(move.id) || !w.quiet(agent)) return step("waiting", "not-quiet", { kind: "store" });
        await w.close(rec);
        closedHere = true;
      }
      if (closedHere) {
        move = (await readMove(w.store, id)) ?? move;
        if (move.stage !== "waiting") return step("waiting", move.stage);
        set = await settleSet(w, move);
        stopped = set.answer ? over(set.answer) : null;
        if (stopped) return stopped;
        if (set.inflight) return step("waiting", "not-quiet", { kind: "store" });
      }
    }
    if (!set.sealed) {
      reasons.push({ reason: set.reason!, detail: { ...(set.answer ? { answer: set.answer } : {}), ...(set.child ? { child: set.child } : {}) } });
    } else {
      for (const rec of w.ledger.of(agent)) {
        if (rec.phase === "closed" && !rec.gone && !rec.lost && lookAt(rec).state === "gone") rec.gone = true;
      }
      move = (await readMove(w.store, id)) ?? move;
      if (move.stage !== "waiting") return step("waiting", move.stage);

      // 2. EVIDENCE FOR EACH INTENT THIS INCARNATION RECORDED, one at a time: the pre-close intent of a child and, where it needed one,
      //    its final intent. Each names the group of ITS document, and both are judged against the whole union known of the child now:
      //    a process that survived outside the group blocks both.
      const mine = w.ledger.of(agent);
      for (const rec of mine) {
        if (!rec.intents.has(move.id) || rec.phase !== "closed") continue;
        let answered = true;
        for (const doc of [rec.docs.get(move.id), rec.finals.get(move.id)]) {
          if (!doc) continue;
          const item: Item = { kind: "intent", id: doc.id, incarnation: w.incarnation, boot: w.here.boot };
          if (resolvedIn(move, item)) continue;
          const group = typeof doc.group === "number" ? doc.group : null;
          const look = rec.gone && group !== null && group === rec.group ? ({ state: "gone", why: "gone", present: [] } as Look)
            : lookAt({ leader: rec.leader, group, pids: rec.pids });
          if (look.state !== "gone") {
            answered = false;
            reasons.push({ reason: look.why === "survivors" ? "survivors" : look.why === "no-process-group" ? "no-process-group" : "unverified-child",
              detail: { child: rec.id, group: rec.group, ...(doc.id !== rec.id ? { intent: doc.id } : {}), ...(look.present.length > 0 ? { present: look.present.slice(0, 16) } : {}) } });
            if (look.why !== "no-process-group") local.push(() => lookAt({ leader: rec.leader, group, pids: rec.pids }).state === "gone");
            continue;
          }
          rec.gone = true;
          const sent = await submit(exitGroup(group!, rec.exit?.confirmed === true
            ? "the adapter closed the child and its own process group was empty, with the leader and every recorded process gone"
            : "the process group the intent named and every process recorded under it, looked up again on this machine in this boot (a process that left the group before it was recorded is not covered)"), doc.id);
          if (sent.over) return sent.over;
          if (!accepted(sent.answer)) { answered = false; refused(sent.answer, { child: rec.id, ...(doc.id !== rec.id ? { intent: doc.id } : {}) }); }
          move = (await readMove(w.store, id)) ?? move;
          if (move.stage !== "waiting") return step("waiting", move.stage);
        }
        if (answered && rec.gone) w.ledger.forget(rec);
      }

      // 3. THIS INCARNATION'S OWN LIFETIME, when it recorded no intent: `no-child` covers it, and only it, and only with nothing
      //    unproven behind it and spawning fenced.
      const intended = move.drain_intents.some(one => one.incarnation === w.incarnation);
      const ownerItem: Item = { kind: "owner", id: w.incarnation, incarnation: w.incarnation, boot: w.here.boot };
      if (!intended && !resolvedIn(move, ownerItem)) {
        const remaining = w.ledger.of(agent);
        const clear = remaining.every(rec => rec.phase === "closed" && rec.gone) && w.fenced(agent) && w.quiet(agent);
        if (clear) {
          const sent = await submit(EXIT_NO_CHILD);
          if (sent.over) return sent.over;
          if (!accepted(sent.answer)) refused(sent.answer, { owner: w.incarnation });
          move = (await readMove(w.store, id)) ?? move;
          if (move.stage !== "waiting") return step("waiting", move.stage);
        } else if (!reasons.some(one => one.reason === "survivors" || one.reason === "no-process-group" || one.reason === "unverified-child")) {
          reasons.push({ reason: "unverified-child", detail: { children: remaining.map(rec => ({ child: rec.id, phase: rec.phase, gone: rec.gone })) } });
        }
      }

      // 4. THE PREDECESSORS: items of earlier incarnations (their intents, the incarnation that was the source's at the request). A
      //    reboot resolves every one recorded in another boot; in this boot only a group that is shown empty resolves an intent, and a
      //    predecessor that recorded nothing, or whose set it never sealed, is never covered by anything this incarnation says about itself.
      const pending = pendingOf(move, w.incarnation, w.here.boot).filter(item => !item.unknown && item.incarnation !== w.incarnation);
      const rebooted = pending.filter(item => bootMoved(item.boot, w.here.boot));
      if (rebooted.length > 0) {
        const sent = await submit(EXIT_BOOT);
        if (sent.over) return sent.over;
        if (!accepted(sent.answer)) refused(sent.answer, { items: rebooted.map(item => item.id) });
        move = (await readMove(w.store, id)) ?? move;
        if (move.stage !== "waiting") return step("waiting", move.stage);
      }
      for (const item of pendingOf(move, w.incarnation, w.here.boot)) {
        if (item.unknown || item.incarnation === w.incarnation) continue;
        const sameBoot = item.boot !== null && item.boot === w.here.boot;
        if (!sameBoot) {
          reasons.push({ reason: "predecessor-boot-unknown", detail: { item: item.id, kind: item.kind, boot: item.boot, here: w.here.boot } });
          continue;
        }
        if (item.kind === "owner") {
          // Nothing was recorded for it, so nothing can be looked at: not a poll, not a signal, and not `no-child`.
          reasons.push({ reason: "predecessor-no-intent", detail: { incarnation: item.id, boot: item.boot } });
          continue;
        }
        if (item.kind === "seal") {
          // It recorded some intents and died before it said they were all: a child it never wrote down cannot be looked at either.
          reasons.push({ reason: "predecessor-intents-incomplete", detail: { incarnation: item.id, boot: item.boot } });
          continue;
        }
        const seen = item.intent!;
        const look = lookAt({ leader: seen.leader ?? null, group: seen.group ?? null, pids: seen.pids ?? [] });
        if (look.state === "gone") {
          const sent = await submit(exitGroup(seen.group as number, "the process group the predecessor's intent named and every process recorded under it, looked up again on this machine in this boot"), item.id);
          if (sent.over) return sent.over;
          if (!accepted(sent.answer)) refused(sent.answer, { item: item.id });
          move = (await readMove(w.store, id)) ?? move;
          if (move.stage !== "waiting") return step("waiting", move.stage);
          continue;
        }
        reasons.push({ reason: look.state === "alive" ? "predecessor-alive" : look.why === "no-process-group" ? "predecessor-no-process-group" : "predecessor-unverified",
          detail: { item: item.id, group: seen.group ?? null, ...(look.present.length > 0 ? { present: look.present.slice(0, 16) } : {}) } });
        if (look.why !== "no-process-group") local.push(() => lookAt({ leader: seen.leader ?? null, group: seen.group ?? null, pids: seen.pids ?? [] }).state === "gone");
      }
    }
  }

  // 5. WHERE IT STANDS, from the store.
  move = (await readMove(w.store, id)) ?? move;
  if (move.stage !== "waiting") return step("waiting", move.stage);
  const left = pendingOf(move, w.incarnation, w.here.boot);
  const unknownOwner = left.some(item => item.unknown);
  const final = move.drain !== null && move.drain.incarnation === w.incarnation && left.length === 0;
  // The store says some of it is still pending and nothing above could say which: it is named, not guessed at.
  if (!final && !unknownOwner && reasons.length === 0) reasons.push({ reason: "partial", detail: { pending: left.map(item => `${item.kind}:${item.id}`).slice(0, 8) } });
  if (unknownOwner) await w.say("move.owner-unknown", { move: id, agent, baseline: move.source_incarnation });
  await settleBlock(w, move, final ? [] : reasons);
  move = (await readMove(w.store, id)) ?? move;
  if (final) {
    await w.say("move.drained", { move: id, agent, export_generation: move.export_generation });
    return step("drained", "drained");
  }
  const owed: Owed | null = local.length > 0 ? { kind: "local", changed: () => local.some(check => check()) } : null;
  return step("waiting", reasons[0]?.reason ?? "owner-unknown", owed);
}

/** A JSON text that does not depend on the order a database gave the keys in. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The block says why the drain stands, in the one code this side owns. It is written when there is a reason, replaced when the
 * reason changed, and cleared ONLY when it is this side's own and its reason is gone. Another party's block is never replaced or
 * cleared (`occupied`): it is said once and the gate stays.
 */
async function settleBlock(w: DrainWorld, move: MoveRow, reasons: Reason[]): Promise<void> {
  const who = { runner: w.runner, incarnation: w.incarnation };
  const current = move.block;
  const wanted = reasons[0] ?? null;
  const detail = wanted ? { reason: wanted.reason, incarnation: w.incarnation, ...wanted.detail } : null;
  if (current && current.by !== "source") {
    if (wanted) await w.say("move.block.foreign", { move: move.id, held: current.code, by: current.by, reason: wanted.reason, ...wanted.detail });
    return;
  }
  if (current && current.code !== BLOCK) return;
  if (wanted === null) {
    if (current) await unblockMove(w.store, move.id, who, BLOCK);
    return;
  }
  if (current && stable(current.detail) === stable(detail)) return;
  if (current) await unblockMove(w.store, move.id, who, BLOCK);
  const answer = await blockMove(w.store, move.id, who, BLOCK, detail!);
  await w.say("move.drain.blocked", { move: move.id, agent: move.agent, answer, reason: wanted.reason, ...wanted.detail });
}

// ---------------------------------------------------------------------------------------------------------------------
// A feed the move refused
// ---------------------------------------------------------------------------------------------------------------------

export interface HandedBack {
  /** What the attempt is after the existing machinery ended it: `failed` is an attempt nothing was ever given to. */
  state: string;
  revision: number | null;
  /** The store showed the attempt unfed when it was looked at (observational: `endAttempt` decided). */
  observed: boolean;
}

/**
 * An attempt the move refused before its first feed (`MoveGated`, `SpawnFenced` for one opened before the request) is handed back
 * with the arguments of `provenUnfedEnd` and the existing `endAttempt`, WITHOUT `delivered: false`: what the attempt is is read under
 * `endAttempt`'s own locks, so an attempt that was fed meanwhile is held or left unknown by the machinery that always did that, and
 * is never released as unfed. When the store does not show it unfed the same call is made with no verdict of ours at all. The child is
 * not closed here (the drain closes it, after its intent), no retry is written and no one is told. `MoveNoteRefused` rolled the
 * feed back: it ends the same way, with its own cause.
 */
export async function handBackFeed(store: StoreLike, at: {
  error: MoveGated | MoveNoteRefused | SpawnFenced;
  execution: string;
  agent: string;
  registry: Registry | null;
}): Promise<HandedBack> {
  const { error } = at;
  let observed = false;
  let end: { execution: string; evidence: null; cause: string };
  if (error instanceof MoveNoteRefused) {
    end = { execution: at.execution, evidence: null, cause: `move-note-refused:${error.move}:${error.answer}` };
  } else {
    const gated = error instanceof MoveGated ? error : new MoveGated(at.execution, at.agent, error.move ?? "unknown");
    const seen = await provenUnfedEnd(store, gated);
    observed = seen !== null;
    end = seen ?? { execution: at.execution, evidence: null, cause: `move-gated:${gated.move}:not-shown-unfed` };
  }
  const ended = await endAttempt(store, { execution: end.execution, evidence: end.evidence, cause: end.cause, registry: at.registry });
  return { state: ended.state, revision: ended.revision, observed };
}

// ---------------------------------------------------------------------------------------------------------------------
// The watch
// ---------------------------------------------------------------------------------------------------------------------

export const MOVE_CHANNEL = "hub_move";

export interface Placement { machine: string | null; runner: string | null; generation: number }

/** Where the store places the master conversation of an agent now. Authoritative: the conversation and the topic, not a registry file. */
export async function placementOf(store: StoreLike, agent: string): Promise<Placement | null> {
  const [row] = (await store.sql`select c.machine as machine, c.placement_generation as generation, t.runner as runner
    from conversation c left join topic t on t.conversation_id = c.id
    where c.agent = ${agent} and c.kind = 'master'`) as unknown as { machine: string | null; generation: number | string; runner: string | null }[];
  return row ? { machine: row.machine, runner: row.runner, generation: Number(row.generation) } : null;
}

export interface MoveWatch {
  /** Something is owed another look: the store owes an answer, or local evidence may move. */
  readonly owed: boolean;
  /** The runner's tick: reads nothing unless something is owed, and then only the store's answer or evidence that moved locally. */
  tick(): void;
  /** Read now: something happened here that the store's notification may not have reached yet. */
  refresh(): void;
  close(): Promise<void>;
}

/**
 * The runner's end of the store's `hub_move` notifications, as the source of a move. Event-driven, like `watchStops`: it reads
 * once when the listener is open (BEFORE anything is served: `watchMoves` does not return until the fences of every move are
 * placed, and throws if that first read cannot be made), on every notification for this runner, and once after a lost listener is
 * opened again. Nothing here is a timer: a runner with no move and nothing owed issues no statement. What is owed is looked at
 * again on the runner's own tick (`tick`): a store answer (`busy`, a failed call) by a read, evidence that may move locally (a
 * survivor, a predecessor's process group) by a look at the process table alone, and only when that moved is anything read.
 *
 * One consumer per move and one chain per agent, so two looks never run together; a notification that arrives while a consumer is
 * working marks it dirty and it looks again before it finishes. A move whose row did not change since a look that left nothing
 * owed is not looked at again, so what a look itself wrote does not make it look at its own writes. Closing waits for every
 * consumer, and a consumer that waits for an agent's loop is released by the loop ending.
 *
 * THE DESTINATION'S SIDE is the same watch with another consumer: a move of which this runner is the DESTINATION is looked at by `driveDest`
 * (preflight, import, serve) under the same one-consumer-per-move rule and the same chain per agent, and it places NO fence (the destination
 * serves nothing until the registry says so and the store releases the gate). And on every read pass (the first read, a notification, a
 * listener opened again) `cleanup` runs once on a chain of its own: the copies the store owes this runner a removal of are listed by
 * `copiesDueForCleanup`, never by the open moves, because `movesOfRunner` leaves a withdrawn move out. While it leaves a copy owed the tick
 * reads again; a pass that finds nothing owed asks nothing more.
 */
export async function watchMoves(
  store: StoreLike,
  at: {
    runner: string;
    machine: string | null;
    fences: Fences;
    /** Look at one move once: in the agent's loop when it has one. */
    drive(request: { id: string; agent: string }): Promise<DrainStep>;
    /** Look at one move of which this runner is the destination, once. Absent: the destination's moves are not looked at. */
    driveDest?(request: { id: string; agent: string }): Promise<DrainStep>;
    /** Remove what the store owes this runner a removal of; the number of copies it left owed (a pass that left none asks nothing more). */
    cleanup?(): Promise<number>;
    /** A fence was lifted: whoever waits on it looks again. */
    lifted(agent: string): void;
    say(kind: string, detail: Record<string, unknown>): Promise<void>;
    report?(error: Error): void;
  },
): Promise<MoveWatch> {
  let closed = false;
  let ready = false;
  let early = false;
  let readOwed = false;
  let listener: Listener | undefined;
  let work: Promise<void> = Promise.resolve();
  const running = new Map<string, Promise<void>>();
  const byAgent = new Map<string, Promise<void>>();
  const dirty = new Set<string>();
  const debts = new Map<string, Owed>();
  const settled = new Map<string, string>();
  const said = new Set<string>();

  const report = (error: Error): void => {
    if (at.report) at.report(error);
    else process.stderr.write(`move-watch: ${safeValue(String(error.message ?? error)).slice(0, 300)}\n`);
  };
  const once = async (key: string, kind: string, detail: Record<string, unknown>): Promise<void> => {
    if (said.has(key)) return;
    said.add(key);
    await at.say(kind, detail);
  };

  const consume = async (id: string, agent: string, role: "source" | "dest"): Promise<void> => {
    for (;;) {
      dirty.delete(id);
      const step = role === "dest" ? await at.driveDest!({ id, agent }) : await at.drive({ id, agent });
      if (step.state === "ended") { debts.delete(id); settled.delete(id); }
      else {
        if (step.owed) debts.set(id, step.owed); else debts.delete(id);
        // A destination's look that stands on this machine's own facts (a recorded preflight, a refusal of a file or a checkout here) is settled on the
        // row it read too: the debt it keeps wakes it when those facts change (`schedule`), and a notification of the same row asks nothing.
        if (step.seen !== null && (step.owed === null || (role === "dest" && step.owed.kind === "local"))) settled.set(id, step.seen); else settled.delete(id);
      }
      if (closed || !dirty.has(id)) return;
    }
  };

  const schedule = (row: MoveRow, role: "source" | "dest" = "source"): void => {
    const id = row.id;
    if (running.has(id)) { dirty.add(id); return; }
    // A row already looked at is not looked at again, unless the look owes the STORE an answer, or owes it to facts of this machine and those moved.
    const debt = debts.get(id);
    if (settled.get(id) === digestOf(row) && (!debt || (debt.kind === "local" && !debt.changed()))) return;
    const before = byAgent.get(row.agent) ?? Promise.resolve();
    const one: Promise<void> = before.then(() => (closed ? undefined : consume(id, row.agent, role)))
      .catch((error: Error) => { report(error); debts.set(id, { kind: "store" }); settled.delete(id); })
      .finally(() => {
        running.delete(id);
        if (byAgent.get(row.agent) === one) byAgent.delete(row.agent);
      });
    running.set(id, one);
    byAgent.set(row.agent, one);
  };

  const lift = async (fence: Fence, why: string): Promise<void> => {
    if (at.fences.get(fence.agent) !== fence) return;
    at.fences.lift(fence.agent);
    at.lifted(fence.agent);
    await at.say("move.fence.lifted", { agent: fence.agent, move: fence.move, why });
  };

  /**
   * A fence whose move is no longer in the open list is judged from the move and the placement, never from its absence. A
   * withdrawal lifts it. A move that went through (`active`) keeps it as a placement fence until the store places the
   * conversation HERE again at a later generation (a move back): a registry that still lists the agent here cannot start it.
   */
  const reconcile = async (open: Set<string>): Promise<void> => {
    for (const id of [...debts.keys()]) if (id !== CLEANUP && !open.has(id)) debts.delete(id);
    for (const id of [...settled.keys()]) if (!open.has(id)) settled.delete(id);
    for (const fence of at.fences.all()) {
      if (fence.kind === "move" && fence.move !== null && open.has(fence.move)) continue;
      let current = fence;
      if (fence.kind === "move" && fence.move !== null) {
        const move = await readMove(store, fence.move);
        if (at.fences.get(fence.agent) !== fence) continue;
        if (!move) { await once(`gone:${fence.move}`, "move.vanished", { agent: fence.agent, move: fence.move }); continue; }
        if (move.stage === "withdrawn") { await lift(fence, "withdrawn"); continue; }
        if (move.stage !== "active") continue;
        current = { agent: fence.agent, move: move.id, kind: "placed", stage: "active", after: move.dest_generation };
        at.fences.set(current);
      }
      const placed = await placementOf(store, current.agent);
      if (at.fences.get(current.agent) !== current) continue;
      if (placed && placed.machine !== null && placed.machine === at.machine && (placed.runner === null || placed.runner === at.runner)
          && placed.generation > (current.after ?? 0)) await lift(current, "placed-here");
    }
  };

  /** The debt the cleanup sweep leaves while a copy it could not remove is still owed: not a move's id, so the reconcile leaves it alone. */
  const CLEANUP = "cleanup:copies";
  let sweeping: Promise<void> = Promise.resolve();
  /** One cleanup per read pass, on a chain of its own (never behind a move's look, never beside another sweep). */
  const sweep = (): void => {
    if (!at.cleanup) return;
    sweeping = sweeping.then(async () => {
      if (closed) return;
      try {
        const left = await at.cleanup!();
        if (left > 0) debts.set(CLEANUP, { kind: "store" }); else debts.delete(CLEANUP);
      } catch (error) { report(error as Error); debts.set(CLEANUP, { kind: "store" }); }
    });
  };

  const drain = async (): Promise<void> => {
    const rows = await movesOfRunner(store, at.runner);
    const mine = rows.filter(row => row.source_runner === at.runner);
    // A move of which this runner is the destination and not the source (the two are never one runner: the store refuses a same-machine move).
    const incoming = at.driveDest ? rows.filter(row => row.dest_runner === at.runner && row.source_runner !== at.runner) : [];
    // THE FENCES ARE PLACED HERE, from the read and before anything below is awaited: nothing the runner starts after this read
    // (and nothing it served before the first read, because the runner opens this watch before it serves) can start a child for them.
    const fresh = mine.filter(row => at.fences.get(row.agent)?.move !== row.id);
    for (const row of mine) at.fences.set({ agent: row.agent, move: row.id, kind: "move", stage: row.stage, after: null });
    for (const row of mine) schedule(row);
    for (const row of incoming) schedule(row, "dest");
    sweep();
    // Said once per move, after the fence is up: it is what a person (or a check) reads to know this runner has the move.
    for (const row of fresh) {
      try { await once(`fenced:${row.id}`, "move.fenced", { agent: row.agent, move: row.id, stage: row.stage }); }
      catch (error) { report(error as Error); }
    }
    // The moves the debts and settled looks are kept for are every open one this runner looks at, as source or as destination; the FENCES are
    // judged from the source's own moves only (`reconcile` reads `at.fences`, and a destination places none).
    await reconcile(new Set([...mine, ...incoming].map(row => row.id)));
  };

  const wake = (): void => {
    if (closed) return;
    if (!ready) { early = true; return; }
    work = work.then(() => (closed ? undefined : drain())).then(() => { readOwed = false; }, (error: Error) => { report(error); readOwed = true; });
  };

  const open = async (): Promise<Listener> => await listenForWork({ url: store.url, channel: MOVE_CHANNEL,
    onNotify: payload => { if (payload === at.runner) wake(); },
    onLost() { if (!closed) void reconnect(); } });
  const reconnect = async (): Promise<void> => {
    while (!closed) {
      try {
        const next = await open();
        if (closed) { await next.close(); return; }
        listener = next;
        // What was asked while nothing was listening is read now, once.
        wake();
        return;
      } catch { await Bun.sleep(1000); }
    }
  };

  // LISTENING FIRST, THEN THE FIRST READ, and the first read must succeed: a runner that could not place its fences must not serve.
  listener = await open();
  try { await drain(); } catch (error) { closed = true; await listener.close().catch(() => {}); throw error; }
  ready = true;
  if (early) wake();

  return {
    get owed() { return readOwed || debts.size > 0; },
    tick() {
      if (closed) return;
      let go = readOwed;
      for (const debt of debts.values()) if (debt.kind === "store" || debt.changed()) go = true;
      if (go) wake();
    },
    refresh: wake,
    async close() {
      closed = true;
      await listener?.close();
      await work;
      await Promise.allSettled([...running.values()]);
      await sweeping;
    },
  };
}
