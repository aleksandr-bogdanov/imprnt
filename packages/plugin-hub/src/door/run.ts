import { outboundNoticeFence } from "../outbound/fence.ts";
import { outboundApprovals } from "../outbound/delivery.ts";
import { startOutbound } from "../outbound/task.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { erasureFence } from "../erasure/startup.ts";
import { historyHarvestFrom } from "../registry/entries.ts";
import { archiveOf, generalOf, legacyMastersOf } from "../registry/topics.ts";
import { doorHealth, recordOperationFailure, routeNotice } from "./health.ts";
import { classifyPlatformError, prepareReply } from "./reply.ts";
import { requestRecovery } from "../hub/control.ts";
import { appendChatLineOnce, lineOrigin, type BadRecord } from "../chatlog.ts";
import { recordOperationFailure as recordDiagnostic } from "../diagnostics.ts";
import { projectInbound } from "../chatlog/project.ts";
import {
  dueTrigger,
  encodeHarvestBody,
  harvestRowId,
  lastMidnight,
  nextMidnight,
  type HarvestBody,
} from "../harvest/row.ts";
import { readWatermark, type Watermark } from "../harvest/sheet.ts";
import { isDemand, newestLine, readSlice } from "../harvest/slice.ts";
import { stamp } from "../records/stamps.ts";
import { putRow, readSheet, removeRow } from "../records/statesheet.ts";
import {
  agentsFor,
  credentialFor,
  harvestFor,
  languageOf,
  listPeople,
  listRunEntries,
  senderAllowed,
  thresholdsFor,
  transcribedSecondsFor,
  transcriberFor,
  voiceFor,
  type VoiceSettings,
} from "../registry/entries.ts";
import {
  loadRegistry,
  readSetting,
  type ChatAgent,
  type Registry,
  type RunEntry,
} from "../registry/load.ts";
import { readVoiceHealth } from "../voice/health.ts";
import { markMediaFailed, readMediaState, recordTranscribe } from "../voice/records.ts";
import { spliceTranscript, transcribeRow, voiceMediaOf } from "../voice/step.ts";
import {
  chunkFilePath,
  readChunkFile,
  renderPartial,
  type ChunkFile,
} from "../voice/transcript.ts";
import { getPreset } from "../registry/presets.ts";
import { TURN_PROGRESS_SHEET, type ProgressRow } from "../runner/progress.ts";
import { openStore, type Store } from "../store/connect.ts";
import { isSettled, readEffect, renderEffect, wantEffect, type EffectRow } from "../store/effects.ts";
import { storeUrlFor } from "../store/secrets.ts";
import { enqueueInbound, inboundId } from "../store/inbound.ts";
import { markDelivered, readPendingChunks } from "../store/outbox.ts";
import { readOpenTurns, readOpenTurnsWithWait, type OpenTurnRow, type WaitSidecar } from "../store/turns.ts";
import { openOutboxWaiter, openTurnWaiter } from "../store/wake.ts";
import { listenForWork, type Listener } from "../store/listen.ts";
import { acceptBatch, type PendingVoiceRow } from "./ingest.ts";
import { lookUpAdopt, parseAgentCommand, type ResolvedRef } from "./agentctl.ts";
import { clockDeadlines, readSpokenClocks, recordExpiry } from "./clock.ts";
import { CURSOR_SHEET, cursorId, readCursor, writeCursor } from "./cursor.ts";
import { startCouncilWatch, type CouncilWatch } from "../council/watch.ts";
import {
  clockLine,
  finding,
  safeValue,
  statusCard,
  transcriberBack,
  transcriberDown,
  voiceGaveUp,
  voicePending,
  waitReasonLine,
  waitReasonText,
  type CardState,
  type Language,
} from "./lines.ts";
import type { Platform, PlatformPull } from "./platform.ts";
import { credentialKeyOf, waitFacts, waitReason } from "./reason.ts";
import type { ApprovalHooks } from "./confirm.ts";
import { startEffects, type EffectsTask } from "./effects-task.ts";
import { startTopics, type TopicsTask } from "./topic-task.ts";
import { topicApprovals } from "./topic-approval.ts";

/**
 * What a card remembers of the last clock that ran out on its message: the
 * state the row was in, when, and the reason the door found from the closed list.
 */
interface CardWait {
  state: string;
  at: number;
  kind: string;
  values: Record<string, string | number>;
}

/**
 * The ONE status card this door keeps for a message, while its turn is open.
 *
 * It is a single platform message, and this task never talks to the platform
 * about it: every content it should read is ASKED for in the message-effect
 * ledger (`store/effects.ts`), on disk before anything is sent, under one key per
 * input. The door's effects task (`effects-task.ts`) creates the message, edits
 * it to the newest content, looks for it after a lost answer and backs off, and
 * this file has no retry of its own. A clock that runs out, a turn that starts,
 * and the tool calls that follow all land on it, so a person never reads a second
 * line about the same message.
 *
 * It is shared between `attend`, which asks for its contents as the work goes,
 * and `post`, which waits a bounded time for the last one to go out before it
 * puts the reply underneath. That wait is what makes L6's "ending with the
 * totals" an ordering rather than a hope, and it is bounded so an answer never
 * waits on a status edit that will not go out.
 */
interface ProgressLine {
  /** The card's key in the ledger. One per input, so a restart and a replay mean the same message. */
  key: string;
  /**
   * The chat the card is in, and it never changes. It is set when the card is made, or read back
   * from the tracking row when it is inherited, and it is what the row and every request for this
   * card carry. The agent's own chat is an ordinary edit and may move while the input is open:
   * the card stays where it was posted, and the next input follows the new one. Empty only for an
   * inherited row that names none, which is a card of unknown identity and is left alone.
   */
  chat: string;
  /**
   * The message id of a card an earlier build posted with no ledger row, or null.
   * Such a card is never edited, replaced or adopted here: there is no reviewed
   * way to put a message the ledger did not make into it, and a new card would be
   * a second message about the same input.
   */
  legacy: string | null;
  actions: number;
  lastAction: string;
  /** When the door began counting this wait, in milliseconds. */
  startedAt: number;
  /**
   * The last moment the LOOP was seen doing anything, from the runner's sheet,
   * and what that was. Moves only when the runner reports a newer moment.
   */
  activityAt: number | null;
  activity: string;
  wait: CardWait | null;
  /** The content last handed to the ledger, marker included, so a card that reads as it did costs nothing. */
  wanted: string;
  /** Whether this input's tracking row is on the sheet with the reason the card shows. */
  tracked: boolean;
  /** The ledger refused this key for another message's identity; nothing more is asked for it. */
  blocked: boolean;
  /** The turn left the open set and its last content is on disk; nothing else changes the card. */
  closing: boolean;
  /** Resolves once the last content has gone out, or is known not to be going out soon. */
  totals: Promise<void>;
  finished(): void;
}

/**
 * The health code of a chat whose fetched batch the door could not
 * accept twice in a row. A successful read does not clear it, an accepted batch
 * does.
 */
const ACCEPT_FAILED = "accept-failed";

/**
 * How long `post` waits for those totals before it goes ahead anyway, for ONE reply chunk and
 * one card. It is not a bound on a door's start or on a whole multi-part answer, and it does not
 * bound a store statement or a platform call: only the wait for the card's last content is capped.
 */
const TOTALS_WAIT_MS = 5000;

/**
 * The door's tracking of the inputs that have a status card: one row per message
 * id, written before the card's first content is asked for and removed only once
 * its LAST content is on disk in the ledger.
 *
 * It is not the card's identity (that is the ledger key, one per input) and it is
 * not evidence that anything was delivered. It says two things a restarted door
 * needs: that this input's card is still owed its final content (so a turn that
 * ended while the door was down is finished, and one that is still open is edited
 * on), and the reason the card was last showing. A row of an earlier build carries
 * a `post_id` and no `key`: that is a message the ledger never made.
 */
const PROGRESS_SHEET = "door_progress";

/**
 * Where the store names a door that owes a chat line for a row it did not
 * write. The payload is the door's id, and each door acts on its own alone.
 */
const PROJECT_CHANNEL = "hub_project";

interface ProgressOnDisk {
  /** The card's ledger key. Absent on a row an earlier build wrote. */
  key?: string;
  /** Only on a row an earlier build wrote: the message it posted by hand. */
  post_id?: string;
  chat: string;
  agent: string;
  /** When the door began counting this wait. */
  started_at: string;
  /** Optional: the reason a restarted door keeps showing until the row moves. */
  wait?: CardWait;
}

/**
 * An in-process poke, so one task of a door can tell another that something
 * happened without either of them asking the store.
 *
 * A clock is armed per message the door knows about, and a message the door
 * has just written down is one it knows about WITHOUT a read: nothing on
 * `hub_turn` fires for a `received` row, because no turn has opened, so the
 * acked clock would otherwise be armed by nobody until some later wake
 * happened to read the table.
 */
interface Nudge {
  wake(): void;
  wait(): Promise<void>;
}

function nudge(): Nudge {
  // A `wake()` that finds a resolver another branch of the race already settled
  // resolves it again and sets no flag, so THAT poke is dropped. It costs
  // nothing and the reason is worth writing down rather than rediscovering: the
  // payload rides in `own.arrivals`, which is drained at the top of the very
  // next iteration whatever woke it.
  let pending = false;
  let fire: (() => void) | null = null;
  return {
    wake() {
      const waiting = fire;
      fire = null;
      if (waiting) waiting();
      else pending = true;
    },
    wait() {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        fire = resolve;
      });
    },
  };
}

export interface DoorHandle {
  door: string;
  stop(): Promise<void>;
}

/**
 * One agent this door is serving right now.
 *
 * The door reconciles its agent set on the tick exactly as the runner
 * does, because a process that reads its configuration only at startup is
 * forbidden here and that rule is not the runner's alone: an agent
 * added to the file whose door never pulls its chat is an agent nobody can
 * reach, so the routine operation "add an agent" is not done until the door has
 * noticed too. The reconcile is one file parse per tick and issues no SQL, so
 * the door's outbox wait still issues nothing at all.
 */
interface Served {
  agent: ChatAgent;
  rebinding: boolean;
  readDone: Promise<void>;
  reading: Promise<void>;
  readied(): void;
  leaving: boolean;
  /** Resolves when this agent alone is asked to leave. */
  left: Promise<"stopped">;
  release(): void;
  done: Promise<void>;
  /** Resolves once `attend` has done its one read at connect. */
  attending: Promise<void>;
  attended(): void;
  /** Resolves once the harvest task has done its one read at connect. */
  harvesting: Promise<void>;
  harvested(): void;
  /**
   * Resolves once the transcription task has read this agent's waiting notes
   * and checked each one's saved bytes against its receipt.
   *
   * It is a member of readiness because a restarted door must have decided
   * about every waiting note before anything else looks at the table: a note
   * whose bytes no longer match is finished on the spot, and one that is sound
   * is re-armed from its own retry.
   */
  transcribing: Promise<void>;
  transcribed(): void;
  /** Resolves once `post` has made its first pass over the replies waiting. */
  posting: Promise<void>;
  posted(): void;
  /** The status card of each open turn, by message id. */
  progress: Map<string, ProgressLine>;
  /**
   * The reply sender met a hold notice for this agent: an attempt was cut short and
   * its input is now held. Set by `post`, which the settling commit already woke,
   * and read by `attend` on its next turn round, so a card that says "in progress"
   * moves to "held" at that commit and not at some later read. Memory only.
   */
  holdSeen: boolean;
  /** Rows this door wrote down itself, handed to `attend` with no read. */
  arrivals: OpenTurnRow[];
  arrived: Nudge;
  /** Notes this door wrote down that are waiting for their words. */
  voice: PendingVoiceRow[];
  voiced: Nudge;
  /** Notes whose transcription attempt is running right now, by message id. */
  inFlight: Set<string>;
}

/**
 * The door: everything a person says is written down before the platform is
 * told it arrived, and everything the loop answered is posted only after the
 * transaction that settled it committed.
 *
 * Inbound is the order L1 fixes: read the platform, commit the row and its
 * received stamp together, then move the cursor. A kill in either gap loses
 * nothing and duplicates nothing, because the id is the platform's own and a
 * redelivery meets the row it already wrote.
 *
 * Outbound waits on the notification the settling transaction emits. Between
 * one wake and the next it issues no statement at all.
 */
/**
 * Where a dialled recognizer is reached. One entry per provider, because a
 * household names the provider and never a URL: a setting that could point a
 * chunk's audio at any host is not a setting this file wants to own.
 */
const CLOUD_ENDPOINTS: Record<string, string> = {
  deepgram: "https://api.deepgram.com/v1/listen",
};

/** The recognizer entry on this door's own machine, or null. */
function transcriberEntry(registry: Registry, door: string): RunEntry | null {
  const machine = listRunEntries(registry).find((one) => one.id === door)?.machine ?? "";
  return transcriberFor(registry, machine);
}

/**
 * The whole URL a chunk is posted to.
 *
 * A recognizer beside the door is reached on LOOPBACK and nowhere else, at the
 * port its own entry carries, which is why an entry with no port is refused
 * when the file is read.
 */
function recognizerEndpoint(
  registry: Registry,
  voice: VoiceSettings,
  door: string,
): string | null {
  if (voice.provider !== "sherpa-onnx") return CLOUD_ENDPOINTS[voice.provider] ?? null;
  const entry = transcriberEntry(registry, door);
  return entry === null ? null : `http://127.0.0.1:${entry.port}/transcribe`;
}

/** The pinned refusal, thrown by `runDoor` at start. */
function cannotShowTyping(door: string): string {
  return (
    `${door} serves a platform that cannot show typing, and a turn open with no typing ` +
    `shown is forbidden. A platform carries typing() and typingSeconds.`
  );
}

/**
 * A door with a declared cutover batch serves nothing until that batch
 * is complete.
 *
 * It WAITS rather than refusing to start. A door that threw here was
 * restarted by its unit until systemd's start limit parked it, and it then
 * stayed down after the handoff completed until someone reset the unit by hand.
 * The install order puts the handoff before the services, and this wait is
 * what holds a door to it. The reason goes to the diary once, not once a tick, and
 * the door reads one row a tick while it waits: it has not started serving, so
 * no idle window is open, and the wait is written down rather than hidden
 * behind a readiness that never comes.
 */
async function awaitHandoff(store: Store, options: {
  door: string; batch: string; tickMs: number; signal?: AbortSignal;
}): Promise<void> {
  const complete = async (): Promise<boolean> => {
    const rows = await store.sql`select data from state_row where sheet='cutover' and id=${options.batch}`;
    return Boolean(rows[0]?.data?.complete);
  };
  if (await complete()) return;
  await recordDiagnostic(store, { operation: "start", target: options.door, actor: "door", error: {
    code: "cutover-incomplete", message: `waiting for cutover handoff batch ${options.batch} to complete` } });
  const stopped = new Promise<void>(resolve => {
    if (options.signal?.aborted) resolve();
    else options.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  for (;;) {
    await Promise.race([Bun.sleep(options.tickMs), stopped]);
    if (options.signal?.aborted) throw new Error(`stopped while waiting for cutover handoff batch ${options.batch}`);
    // A store that does not answer one tick is asked again the next.
    if (await complete().catch(() => false)) return;
  }
}

/** The door's agents take turns through their connect reads. See the note at the reads. */
let connectGate: Promise<void> = Promise.resolve();

export async function runDoor(options: {
  door: string;
  registryFile: string;
  platform: Platform;
  /**
   * What acts on an owner's approval of a frozen preview, by the kind of operation the
   * preview was for (`store/confirmations.ts`). A kind with nothing registered here is
   * never approved by this door: its preview waits, and says why. Nothing registers
   * one yet in a shipped door, because nothing yet freezes a preview; the door that
   * owns an operation passes its own.
   */
  approvals?: ApprovalHooks;
  /**
   * Stops a door that is still waiting for its cutover batch. Once
   * the door is ready, `stop()` on the handle is how it is stopped.
   */
  signal?: AbortSignal;
}): Promise<DoorHandle> {
  // SPEC §2's Forbidden line, refused BY NAME and at START. It lives here and
  // not in `src/entry/door.ts` because every check drives `runDoor` directly,
  // so a refusal in the entry point would be a promise rather
  // than a behaviour. Nothing has been read and no chat has been pulled yet.
  if (
    typeof (options.platform as { typing?: unknown }).typing !== "function" ||
    !(Number(options.platform.typingSeconds) > 0)
  ) {
    throw new Error(cannotShowTyping(options.door));
  }
  const registry = loadRegistry(options.registryFile);
  const stateDir = String(readSetting(registry, "hub.state_dir"));
  const timeoutMs = Number(readSetting(registry, "hub.tick_seconds")) * 1000;
  const store: Store = await openStore({
    url: storeUrlFor(registry, "hub_door", options.door),
  });
  // A store restored from a copy older than a deletion this machine recorded is not served from: the hub brings it forward, and the
  // manager starts this process again after it. Nothing has been read from a chat yet.
  const erasureHold = await erasureFence(store, stateDir);
  if (erasureHold !== null) { await store.close().catch(() => {}); throw new Error(`erasure-behind: ${erasureHold}`); }

  const batch = (registry.data.hub as { cutover_batch?: string }).cutover_batch;
  if (batch) {
    try { await awaitHandoff(store, { door: options.door, batch, tickMs: timeoutMs, signal: options.signal }); }
    catch (error) { await store.close(); throw error; }
  }

  // A successful projection is already fsynced. Keep that knowledge only for
  // pending chunks in this process; a restarted door repairs them all again.
  const projected = new Set<number>();
  // A complete record in a day file that is not a chat line must not stop
  // every append to that file, nor the whole door at start. The door
  // skips it (its bytes stay, a complete record is never truncated) and says
  // where, once per file and line in this process: the diary and stderr.
  const reportedBad = new Set<string>();
  const skipBad = async (bad: BadRecord): Promise<void> => {
    const where = `${bad.file}:${bad.line}`;
    if (reportedBad.has(where)) return;
    reportedBad.add(where);
    await recordDiagnostic(store, { operation: "chatlog", target: where, actor: "door",
      error: { code: "chatlog-bad-record", message: "a record that is not a chat line was skipped" } }).catch(() => {});
  };
  /**
   * Every row this door owes a chat line, projected. The ONE implementation of
   * projection that is not a door's own acceptance: the startup repair runs
   * it, and so does the door when the store says a row it did not write is
   * waiting. Two sweeps that overlap still write each line once, because a
   * line is appended once by its id and a row is marked ready once.
   */
  const sweepOwed = async (): Promise<void> => {
    // A ROW WAITING FOR ITS OWN TEXT IS SKIPPED HERE. Projecting it would put a
    // voice note with no words into the chat log and make it claimable on every
    // door start, and the person would be answered about a note nobody has
    // heard. The transcription task's own connect scan takes those rows,
    // checks their saved bytes and finishes them.
    const pending = await store.sql`select id from inbound
      where not log_ready and source->>'door' = ${options.door}
        and media_state is distinct from 'pending'`;
    for (const row of pending) await projectInbound(store, { stateDir, inboundId: String(row.id), skipBad });
  };

  // THE DOOR IS TOLD ABOUT ROWS IT DID NOT WRITE. A report, and a job for an
  // agent this door serves, are inserted by a runner or by another door, so no
  // process of this door is in their loop. The store names the door on a
  // channel of its own at the commit, and the door runs the sweep above.
  //
  // It is a THIRD connection per door process, beside the outbox waiter and the
  // turn waiter, and one per process rather than one per agent, which is what
  // keeps it cheaper than either. It rides the plain listener rather than a
  // second channel on the shared waiter, because three statement-count windows
  // sit on that waiter. It issues no statement while nothing arrives.
  //
  // Opened BEFORE the startup sweep, so a row committed between the sweep's
  // read and the listen is announced to a listener that already exists.
  let projecting: Promise<void> = Promise.resolve();
  // The same wake carries the platform-message task's (`effects-task.ts`): its rows are
  // announced on this channel too, with a payload that says so, so that task costs
  // the door no connection of its own.
  let outbound: ReturnType<typeof startOutbound> | null = null;
  let effects: EffectsTask | null = null;
  // And the council task's (`council/watch.ts`), the same way: `council:<door>` on this channel.
  let council: CouncilWatch | null = null;
  // And the topic task's (`topic-task.ts`), on the same wake, for the same reason.
  let topics: TopicsTask | null = null;
  let projection: Listener | null = null;
  let projectionClosed = false;
  let projectionRetry: ReturnType<typeof setTimeout> | null = null;
  const sweepSoon = (): void => {
    projecting = projecting.then(() => projectionClosed ? undefined : sweepOwed()).catch(() => {
      // A sweep the store refused leaves its rows owed, and the next
      // notification or the next door start sweeps them again.
    });
  };
  const listenForProjection = async (): Promise<void> => {
    if (projectionClosed) return;
    try {
      projection = await listenForWork({
        url: store.url,
        channel: PROJECT_CHANNEL,
        onNotify: (payload) => {
          if (payload === options.door) sweepSoon();
          else if (payload === `effect:${options.door}`) effects?.wake();
          else if (payload === `council:${options.door}`) council?.wake();
          else if (payload === `topic:${options.door}`) topics?.wake();
        },
        // Every notification after a drop is gone, so the rows they announced
        // are found by sweeping once something is listening again.
        onLost: () => {
          projection = null;
          void listenForProjection().then(() => { if (projection) { sweepSoon(); effects?.wake(); council?.wake(); topics?.wake(); } });
        },
      });
      if (projectionClosed) { await projection.close(); projection = null; }
    } catch {
      // A store that cannot be listened on is not a reason to refuse the door.
      // Nothing announces the server coming back, so the tick is the bound,
      // and the sweep after a listen that finally opens finds what was missed.
      projectionRetry = setTimeout(() => {
        projectionRetry = null;
        void listenForProjection().then(() => { if (projection) { sweepSoon(); effects?.wake(); council?.wake(); topics?.wake(); } });
      }, timeoutMs);
    }
  };
  const closeProjection = async (): Promise<void> => {
    projectionClosed = true;
    if (projectionRetry !== null) clearTimeout(projectionRetry);
    const held = projection;
    projection = null;
    if (held) await held.close();
    await projecting;
  };
  await listenForProjection();

  try {
    // Only an explicit operator recovery releases terminal delivery failures.
    // The door keeps its own delivery authority; the hub only restarts it.
    await store.sql`update outbox set delivery_state='pending', attempts=0, retry_at=null, failure=null
      where delivery_state='failed' and route->>'door'=${options.door}
        and exists (select 1 from state_row where sheet='control'
          and data->>'target_kind'='door' and data->>'target_id'=${options.door}
          and data->>'status'='pending')`;
    await sweepOwed();
    for (const agent of agentsFor(registry, { door: options.door })) {
      for (const chunk of await readPendingChunks(store, { agent: agent.id })) {
        if (chunk.route && chunk.route.door !== options.door) continue;
        const outbound = chunk.kind === "notice" && String(chunk.notice_key ?? "").startsWith("outbound:");
        const fenced = outbound ? await outboundNoticeFence(store,chunk.id) : null;
        if(outbound && !fenced) continue;
        try {
          await appendChatLineOnce({ stateDir, person: chunk.person, agent: fenced?.sourceAgent ?? chunk.agent }, {
            id: `outbox:${chunk.id}`, at: new Date(chunk.written_at).toISOString(), direction: "out",
            from: chunk.kind === "notice" ? options.door : chunk.agent, text: chunk.body,
            // The same mark the delivery projection writes, so a watcher's line
            // projected at start is left out of the tail too.
            ...(lineOrigin(chunk.route?.origin) ? { origin: lineOrigin(chunk.route?.origin) } : {}),
          }, { skipBad });
          projected.add(chunk.id);
        } finally { await fenced?.release(); }
      }
    }
  } catch {
    await closeProjection();
    await store.close();
    throw new Error("chatlog-projection-repair-failed");
  }

  let stopping = false;
  let release: () => void = () => {};
  const stopped = new Promise<"stopped">((resolve) => {
    release = () => resolve("stopped");
  });

  const health = await doorHealth(store, options.door);
  for (const agent of agentsFor(registry, { door: options.door })) await health.initialize(agent);
  let releaseHealth!: () => void;
  const healthReady = new Promise<void>(resolve => { releaseHealth = resolve; });
  /** `seconds` is the retry that really follows: the read retry unless said otherwise. */
  const sayReadFailure = async (agent: ChatAgent, seconds?: number) => {
    const data = health.health.get(agent.chat);
    if (data?.status !== "failed" || data.notice_key) return;
    // A platform blip that heals on the next retry costs nobody a message, and
    // Discord answers about one read in five thousand with a 503 or a stall,
    // which across seventeen channels is a notice every few minutes. So a
    // transient failure speaks only once the chat has stayed unreadable past
    // the grace. The health row and the `check` finding are written at once
    // either way, and a refused or missing chat, or a batch this door cannot
    // accept, speaks on the first failure because no retry fixes it.
    const grace = Number(readSetting(registryThisTick(), "door.read_notice_after_seconds")) * 1000;
    if (data.kind === "transient" && data.code !== ACCEPT_FAILED && Date.now() - Date.parse(String(data.since)) < grace) return;
    const key = `chat-read:${options.door}:${agent.chat}:${data.since}`;
    const sent = await routeNotice(store, { registry: registryThisTick(), door: options.door,
      platform: options.platform.name, agent, chat: agent.chat, health: health.health, key,
      failure: { kind: "transient", code: String(data.code), cause: String(data.cause) },
      operation: "read", seconds: seconds ?? Number(readSetting(registryThisTick(), "door.read_retry_seconds")) });
    if (sent) {
      data.notice_key = key;
      await putRow(store, "door_health", `${options.door}/${agent.chat}`, data);
    }
  };

  // Bun can dispatch an already queued pool query into a reserved connection's
  // transaction. Ingress therefore owns a pool that posting and clocks never
  // use, as well as serializing batches from the chats this door serves.
  let ingress: Store;
  try { ingress = await openStore({ url: store.url, max: 1 }); }
  catch (error) { await store.close(); throw error; }
  let accepting: Promise<void> = Promise.resolve();
  const read = async (agent: ChatAgent, own: Served, activate = false): Promise<void> => {
    let cursor = await readCursor(store, options.door, agent.chat);
    // A route this door has never read starts at the
    // platform's high-water mark, asked for ONCE at activation and saved before
    // the first pull. What the chat held before it is history, and everything
    // after it is served. THE MARK IS NEVER FOUND BY WALKING THE CHAT: paging
    // through it and skipping every page until one comes back empty puts the
    // boundary wherever that walk ended, and a message a person sends during
    // the walk is skipped as history with nothing said.
    //
    // One gap stays named rather than closed: a message sent between the edit
    // and this call (the tick that notices the edit, then the old reader's last
    // read) is below the mark and stays unanswered. Asking earlier would mean
    // asking while the old reader still polls, which Telegram refuses for a bot
    // and which would put a platform branch in this door.
    let capturing = activate && cursor === null;
    let first = true;
    /** How many times in a row this chat's fetched batch could not be accepted. */
    let refused = 0;
    const acceptFailing = () => health.health.get(agent.chat)?.code === ACCEPT_FAILED;
    while (!stopping && !own.leaving && !own.rebinding) {
      let fresh: Registry;
      try { fresh = registryThisTick(); }
      catch { fresh = parsedRegistry ?? registry; }
      const seconds = Number(readSetting(fresh, "door.read_retry_seconds"));
      const retry = Date.parse(String(health.health.get(agent.chat)?.retry_at ?? ""));
      if (retry > Date.now()) await Promise.race([Bun.sleep(retry - Date.now()), stopped, own.left]);
      if (stopping || own.leaving || own.rebinding) return;
      let expired: Promise<void> = Promise.resolve();
      const timer = setTimeout(() => {
        expired = health.failed(agent.chat, Object.assign(new Error("operation failed"), { code: "read-timeout" }), seconds)
          .then(() => sayReadFailure(agent)).finally(() => own.readied());
      }, Number(readSetting(fresh, "door.read_timeout_seconds")) * 1000);
      // The mark is asked for under the same timeout, failure and retry a pull
      // gets, because it is a read of the same chat.
      const asking: Promise<{ mark: string | null } | { batch: PlatformPull }> = capturing
        ? options.platform.highWater({ chat: agent.chat }).then(mark => ({ mark }))
        : options.platform.pull({ chat: agent.chat, cursor, timeoutMs: first ? 0 : timeoutMs,
          allowed: sender => senderAllowed(fresh, agent.person, options.door, sender) }).then(batch => ({ batch }));
      const pulled = await Promise.race([
        asking.then(answer => answer, (error: unknown) => ({ error })), stopped, own.left,
      ]);
      clearTimeout(timer);
      await expired;
      if (pulled === "stopped" || stopping || own.leaving) return;
      if ("error" in pulled) {
        await health.failed(agent.chat, pulled.error, seconds);
        await sayReadFailure(agent);
        own.readied();
        first = false;
        continue;
      }
      // A read that worked says nothing about a batch that cannot be accepted.
      // Clearing that here would open a fresh episode, and a fresh notice, on
      // every replay, so only an accepted batch clears it (below).
      if (!acceptFailing()) await health.succeeded(agent.chat);
      if ("mark" in pulled) {
        capturing = false;
        // A null mark is a chat with nothing to skip, so there is nothing to
        // save: a pull from no cursor already reads only what arrives from now.
        if (pulled.mark !== null) {
          cursor = pulled.mark;
          await writeCursor(store, options.door, agent.chat, cursor);
        }
        continue;
      }
      // THE CHAT LOOKUP AN ADOPT NEEDS IS MADE HERE, in this chat's own reader
      // and before the batch joins the accepting chain every chat of this door
      // shares. It retries under the delivery bounds, so made inside the chain
      // during a platform outage it would hold up every person on this door.
      // Here it holds up only this chat, and the batch is still acknowledged
      // only after the command in it has been asked for.
      const lookups = new Map<string, ResolvedRef>();
      for (const message of pulled.batch.messages) {
        if (stopping || own.leaving) break;
        if (message.chat !== agent.chat || !message.sender_id) continue;
        const typed = parseAgentCommand(message.text);
        if (typed === null || typed === "usage" || typed.operation !== "adopt") continue;
        const answer = await Promise.race([lookUpAdopt({ id: "", registry: fresh, person: agent.person,
          door: options.door, chat: agent.chat, agent: agent.id, sender_id: message.sender_id,
          platform: options.platform, operation: "adopt", target: typed.agent, ref: typed.ref }), stopped, own.left]);
        if (answer !== undefined && answer !== "stopped") lookups.set(message.platform_message_id, answer);
      }
      if (stopping || own.leaving) return;
      try {
        const accepted = accepting.then(async () => {
          let current: Registry;
          try { current = registryThisTick(); }
          catch (error) {
            // Preserve an authorized demand's diary during an incomplete save.
            // Execution and acknowledgement still wait for a valid registry.
            for (const message of pulled.batch.messages) {
              if (message.chat !== agent.chat || !message.sender_id || !isDemand(message.text) ||
                  !senderAllowed(fresh, agent.person, options.door, message.sender_id)) continue;
              await appendChatLineOnce({ stateDir, person: agent.person, agent: agent.id }, {
                id: "harvest-demand:" + inboundId(options.platform.name, message.chat, message.platform_message_id),
                at: message.at, direction: "in", from: agent.person, text: message.text,
              }, { skipBad });
            }
            throw error;
          }
          // Keep acceptance and its cursor on one connection until the batch
          // completes, separate from concurrent posting and clock reads.
          const connection = await ingress.sql.reserve();
          try {
            cursor = await acceptBatch({ store: { ...ingress, sql: connection as unknown as Store["sql"] }, registry: current, stateDir,
              door: options.door, agent, platform: options.platform, batch: pulled.batch, cursor, skipBad, lookups,
              received(id, mediaState) {
                // The media state travels with the row, because the clock it
                // arms depends on it: a note still waiting for its words is
                // waiting for a different stamp, and a row with no media is
                // null here exactly as the store holds it. A row the door
                // accepted is a person's own message and never a report, so
                // the report's own stamp is null on all of these.
                own.arrivals.push({ id, person: agent.person, agent: agent.id,
                  received_at: new Date(), state: "received", claimed_by: null,
                  media_state: mediaState, media_done_at: null, reported_at: null });
                own.arrived.wake();
              },
              pending(row) {
                own.voice.push(row);
                own.voiced.wake();
              },
            });
          } finally { connection.release(); }
        });
        accepting = accepted.catch(() => {});
        await accepted;
        refused = 0;
      } catch (error) {
        console.error("ingress: accepted batch remains unacknowledged");
        // The same batch comes back on every replay, so a second
        // refusal in a row is a failure that repeats, not a blip. It leaves the
        // trace a read failure leaves: the chat's health row that `check`
        // reports, the diary, and one notice per episode to a working chat of
        // the same person. The retry is the replay one tick from now.
        refused += 1;
        if (refused >= 2 && !stopping && !own.leaving) {
          try {
            await health.failed(agent.chat, error, timeoutMs / 1000, { code: ACCEPT_FAILED, cause: "operation failed" });
            await sayReadFailure(agent, timeoutMs / 1000);
          } catch {
            // The store that refused the batch may refuse this too. The next
            // replay tries again.
          }
        }
        await Promise.race([Bun.sleep(timeoutMs), stopped, own.left]);
      }
      if (refused === 0 && acceptFailing()) await health.succeeded(agent.chat).catch(() => {});
      own.readied();
      first = false;
    }
  };

  const post = async (agent: ChatAgent, own: Served): Promise<void> => {
    let retryAt: number | null = null;
    /** The hold notices whose arrival `attend` was already told of, by outbox row. */
    const heldTold = new Set<string>();
    const deliver = async (): Promise<void> => {
      retryAt = null;
      const pending = await readPendingChunks(store, { agent: agent.id });
      // A hold is committed together with its notice, and this pass is woken by that
      // commit, so seeing the notice is the moment the store began to say "held". It is
      // the one wake an interrupted attempt has, and it costs `attend` one read, once.
      for (const chunk of pending) {
        if (chunk.kind !== "notice" || !String(chunk.notice_key ?? "").startsWith("hold:") || heldTold.has(String(chunk.id))) continue;
        heldTold.add(String(chunk.id));
        own.holdSeen = true;
        own.arrived.wake();
      }
      const blocked = new Set<string>();
      const posted = new Set<string>();
      for (const chunk of pending) {
        if (stopping || own.leaving) return;
        const group = chunk.inbound_id ?? chunk.notice_key!.replace(/:part:\d+$/, "");
        if (blocked.has(group)) continue;
        const route = chunk.route ?? { door: options.door, chat: agent.chat };
        if (route.door !== options.door) continue;
        const due = chunk.retry_at ? new Date(chunk.retry_at).getTime() : 0;
        if (due > Date.now()) {
          retryAt = Math.min(retryAt ?? Infinity, due);
          blocked.add(group);
          continue;
        }
        const outbound = chunk.kind === "notice" && String(chunk.notice_key ?? "").startsWith("outbound:");
        const fenced = outbound ? await outboundNoticeFence(store,chunk.id) : null;
        if(outbound && !fenced) continue;
        try {
          if (!chunk.route) await store.sql`update outbox set route = ${route}::jsonb where id = ${chunk.id} and route is null`;
          if (!projected.has(chunk.id)) {
            await appendChatLineOnce({ stateDir, person: chunk.person, agent: fenced?.sourceAgent ?? chunk.agent }, {
              id: `outbox:${chunk.id}`, at: new Date(chunk.written_at).toISOString(), direction: "out",
              from: chunk.kind === "notice" ? options.door : chunk.agent, text: chunk.body,
              // A watcher's notice is marked in the log as it is on the row, so
              // the file tail leaves it out the way the store tail does.
              ...(lineOrigin(chunk.route?.origin) ? { origin: lineOrigin(chunk.route?.origin) } : {}),
            }, { skipBad });
            projected.add(chunk.id);
          }
          if (chunk.kind === "reply" && chunk.inbound_id !== null) {
            const line = own.progress.get(chunk.inbound_id);
            // With no effects task yet (the first pass of a start runs before it does) nothing could
            // deliver the card's last content, so waiting would only spend the allowance. The allowance
            // is a bound on this one wait, for this one chunk: not on the start, and not on a whole answer.
            if (line && effects !== null) {
              await Promise.race([line.totals, Bun.sleep(TOTALS_WAIT_MS)]);
              // A stop or a person change ends the wait too, by resolving the totals: that is no
              // evidence anything went out, and the reply now belongs to whoever serves next.
              if (stopping || own.leaving) return;
            }
          }
          const fresh = registryThisTick();
          const seconds = Number(readSetting(fresh, "door.delivery_retry_seconds"));
          const attempts = Number(chunk.attempts) + 1;
          const maxAttempts = Number(readSetting(fresh, "door.delivery_max_attempts"));
          if (Number(chunk.attempts) >= maxAttempts) {
            const failure = chunk.failure ?? { kind: "uncertain" as const, code: "send-interrupted", cause: "delivery outcome unknown" };
            await store.sql`update outbox set delivery_state = 'failed', retry_at = null, failure = ${failure}::jsonb where id = ${chunk.id}`;
            projected.delete(chunk.id);
            await recordOperationFailure(store, "post", options.door, route.chat, failure);
            await routeNotice(store, { registry: fresh, door: options.door, platform: options.platform.name,
              agent, chat: route.chat, health: health.health, key: `delivery-failed:${chunk.id}`, failure, operation: "post", seconds });
            blocked.add(group);
            continue;
          }
          // If this process dies during the send, restart retains an honest
          // unknown receipt and the same bounded retry deadline.
          const next = new Date(Date.now() + seconds * 1000).toISOString();
          await store.sql`update outbox set attempts = ${attempts}, retry_at = ${next}::timestamptz,
            failure = '{"kind":"uncertain","code":"send-interrupted","cause":"delivery outcome unknown"}'::jsonb where id = ${chunk.id}`;
          try {
            // Stable across retries and process restarts. Discord enforces this only within
            // its recent-message window; it is not an unlimited exactly-once guarantee.
            const nonce = createHash("sha256").update(`hub-outbox:${options.door}:${route.chat}:${chunk.id}`).digest("base64url").slice(0, 25);
            await options.platform.post({ chat: route.chat, text: chunk.body, nonce });
          } catch (error) {
            const failure = classifyPlatformError(error);
            // A limit the platform named is waited out as named, and never sooner than
            // the retry spacing. A request the platform seam HELD for a limit it already
            // knew of never left, so it is not an attempt and is not a new failure to
            // record: the limit that held it was.
            const limit = error as { retryAfterMs?: unknown; blocked?: unknown } | null;
            const named = typeof limit?.retryAfterMs === "number" ? limit.retryAfterMs : 0;
            const held = limit?.blocked === true;
            const spent = held ? Number(chunk.attempts) : attempts;
            const terminal = failure.kind === "permanent" || spent >= maxAttempts;
            // The pre-send durable stamp may itself have waited on storage.
            // Space retries from the observed failure, not that earlier write.
            const retry = terminal ? null : new Date(Date.now() + Math.max(seconds * 1000, named)).toISOString();
            await store.sql`update outbox set attempts = ${spent}, delivery_state = ${terminal ? "failed" : "pending"},
              retry_at = ${retry}::timestamptz, failure = ${failure}::jsonb where id = ${chunk.id}`;
            if (terminal) projected.delete(chunk.id);
            if (!held) await recordOperationFailure(store, "post", options.door, route.chat, failure);
            if (terminal) await routeNotice(store, { registry: fresh, door: options.door, platform: options.platform.name,
              agent, chat: route.chat, health: health.health, key: `delivery-failed:${chunk.id}`,
              failure, operation: "post", seconds });
            else retryAt = Math.min(retryAt ?? Infinity, Date.parse(retry!));
            blocked.add(group);
            continue;
          }
          await markDelivered(store, chunk.id);
          projected.delete(chunk.id);
          if (chunk.inbound_id !== null) posted.add(chunk.inbound_id);
        } finally { await fenced?.release(); }
      }
      for (const id of posted) if (!blocked.has(id)) {
        const [row] = await store.sql`select 1 from outbox where inbound_id = ${id} and delivered_at is null limit 1`;
        if (!row) await stamp(store, { messageId: id, kind: "delivered", actor: "door" });
      }
    };
    // A reply is announced under the person of the message it answers, and a
    // message keeps the person it came in under. So after this agent is given
    // to another person, the answers to messages it took in before are
    // announced under the earlier person, which this task would not hear on its
    // own. It also hears every other person this agent still has an unanswered
    // message under. Once a message is answered its reply is in the outbox,
    // which the pass reads by agent, so that person drops out of the set.
    //
    // The set is read at the start of every pass while it may be non-empty, and
    // on the first pass always, which also covers a door started after the
    // move. Reading it BEFORE the pending replies is what closes the race with
    // a settle: a message answered before this read has its reply seen by the
    // read that follows, and one answered after it is announced to a person
    // still in the set. An agent with nothing owed under anyone else pays one
    // read per task start and nothing afterwards.
    const owedUnder = new Set<string>();
    let owedKnown = false;
    const readOwed = async (): Promise<void> => {
      const rows = await store.sql`select distinct person from inbound
        where agent = ${agent.id} and person <> ${agent.person} and state in ('received', 'acked', 'started')`;
      owedUnder.clear();
      for (const row of rows) owedUnder.add(String(row.person));
      owedKnown = true;
    };
    const waiter = await openOutboxWaiter(store, { person: agent.person, also: owedUnder });
    // A pass that throws never rejects: the door's readiness waits on the first
    // one, and a store that refuses it must not keep the door from starting.
    // What refused is said once per run of failures, on stderr, because the
    // store that refused the read may refuse a diary row too.
    let failing = false;
    const attempt = async () => {
      try {
        if (!owedKnown || owedUnder.size > 0) await readOwed();
        await deliver();
        failing = false;
      } catch (error) {
        retryAt = Date.now() + timeoutMs;
        if (!failing) {
          process.stderr.write(finding("en", { code: "post:pass-failed", target: `${options.door}/${agent.id}`,
            cause: safeValue((error as Error)?.message ?? error) }) + "\n");
        }
        failing = true;
      }
    };
    try {
      await healthReady;
      await attempt();
      own.posted();
      while (!stopping && !own.leaving) {
        const why = await Promise.race([
          waiter.wait(retryAt === null ? timeoutMs : Math.max(1, retryAt - Date.now())).catch(() => "timeout" as const),
          stopped, own.left,
        ]);
        if (why === "stopped" || stopping || own.leaving) return;
        if (why === "notified" || retryAt !== null && retryAt <= Date.now()) await attempt();
      }
    } finally { await waiter.close(); }
  };

  /**
   * The third task per agent, and the only thing in the door that knows a turn
   * is open.
   *
   * It owns its own waiter on `hub_turn`, so `post`'s loop is untouched and the
   * window `test/door-outbox.test.ts` counts statements inside is exactly what
   * it was. What it reads, and NOTHING else: once at connect, once per
   * notification, and once per clock that has run out. The typing refresh is a
   * timer over memory and issues no statement at all.
   */
  const attending = async (agent: ChatAgent, own: Served): Promise<void> => {
    const thresholds = thresholdsFor(registry, agent.person);
    // The fourth clock's own threshold, this person's. A note waiting for its
    // words is waiting for a stamp none of the three above measures.
    const transcribedSeconds = transcribedSecondsFor(registry, agent.person);
    const language = languageOf(registry, agent.person) as Language;
    // One second inside the platform's own lifetime, so the status never
    // lapses: Telegram's is 5 seconds and Discord's is 10, and the number is
    // the platform's rather than this file's.
    const refreshEvery = Math.max(
      250,
      (Number(options.platform.typingSeconds) - 1) * 1000,
    );

    /** (message, stamp) pairs this door has already said a line about. */
    const spoken = new Set<string>();
    /** When each of them was said, for the answered clock's silent re-arm. */
    const spokenAt = new Map<string, number>();
    let open: OpenTurnRow[] = [];
    let typing: ReturnType<typeof setInterval> | null = null;
    /** The sheet as this door last read it, so a timer needs no read of its own. */
    let sheet = new Map<string, ProgressRow>();

    const typable = (): OpenTurnRow[] =>
      // A turn OPENS at `acked` and ENDS at `answered`. A
      // `received` row would show a person somebody working on a message the
      // loop has not accepted, and an `answered` one would show it after the
      // answer was written.
      //
      // AND IT HAS TO BE CLAIMED. A turn the loop REFUSED leaves its row at `acked` and
      // releases it onto `retry_at`, so the state alone cannot tell a turn that
      // is running from one that is waiting out an outage. Without the claim
      // the door typed for the whole of an outage: a person watched a chat
      // saying somebody was typing while the notice beside it said messages
      // were waiting, and the platform took one call every few seconds per
      // agent for as long as it lasted.
      //
      // AND A NOTE BEING TRANSCRIBED RIGHT NOW. Nobody has claimed it, because
      // it has no words yet, and the door itself is the one working on it:
      // the person sees typing from the moment their note is picked up, and
      // not across the wait for a retry.
      open.filter(
        (row) =>
          ((row.state === "acked" || row.state === "started") && row.claimed_by !== null) ||
          own.inFlight.has(row.id),
      );

    const show = async (): Promise<void> => {
      try {
        await options.platform.typing({ chat: agent.chat });
      } catch {
        // A refused refresh is the platform having a bad day. The next one
        // goes out on the same timer and nothing here waits on it.
      }
    };

    const retune = (): void => {
      const wanted = typable().length > 0;
      if (wanted && typing === null) {
        // At once, so the person sees typing from the moment the loop accepted
        // the message rather than a refresh period later.
        void show();
        typing = setInterval(() => void show(), refreshEvery);
      } else if (!wanted && typing !== null) {
        clearInterval(typing);
        typing = null;
      }
    };

    const clocksOf = (rows: OpenTurnRow[]): { row: OpenTurnRow; stamp: string; at: number }[] => {
      const out: { row: OpenTurnRow; stamp: string; at: number }[] = [];
      for (const row of rows) {
        for (const clock of clockDeadlines(row, thresholds, transcribedSeconds)) {
          const key = `${row.id}/${clock.stamp}`;
          if (!spoken.has(key)) {
            out.push({ row, stamp: clock.stamp, at: clock.at });
            continue;
          }
          // Only the answered clock comes back, and it comes back
          // SILENT: a turn that is stuck gets one read every
          // `answered_seconds` and no second chat line, because nothing else
          // announces a stuck loop coming back.
          if (clock.stamp !== "answered") continue;
          out.push({
            row,
            stamp: clock.stamp,
            at: (spokenAt.get(key) ?? clock.at) + thresholds.answered_seconds * 1000,
          });
        }
      }
      return out;
    };

    const nextDeadline = (): number | null => {
      let soonest: number | null = null;
      for (const clock of clocksOf(open)) {
        soonest = soonest === null ? clock.at : Math.min(soonest, clock.at);
      }
      // The first progress line is a deadline of this door's own, held in
      // memory: a turn with no tool call reports nothing after `started`, so
      // nothing would wake the door to say the agent is working at all.
      for (const row of open) {
        const due = lineDueAt(row);
        if (due === null) continue;
        soonest = soonest === null ? due : Math.min(soonest, due);
      }
      return soonest;
    };

    /**
     * What a wait on this row is counted from.
     *
     * The same base the deadline itself is derived from, so the seconds a person
     * reads and the moment the line goes out agree. A note still waiting for its
     * words counts from when the person sent it, which is what they are counting
     * from. Once the words exist the three shipped clocks count from the moment
     * they landed, because the loop could not have accepted a message whose text
     * did not exist yet. A row with no media is unchanged either way.
     */
    const countFrom = (row: OpenTurnRow): number => {
      const received = new Date(row.received_at).getTime();
      if (row.media_state === "pending" || !row.media_done_at) return received;
      return new Date(row.media_done_at).getTime();
    };

    /**
     * When the wait on this row is counted from, for the card. The same base the
     * clocks use, and for a report the moment it landed rather than the job's
     * own arrival, which is what the person is waiting from.
     */
    const sinceOf = (row: OpenTurnRow): number => {
      const received = new Date(row.received_at).getTime();
      if (row.media_state === "pending") return received;
      const from = row.reported_at ?? row.media_done_at ?? null;
      return from === null ? received : new Date(from).getTime();
    };

    /** What the card says a row is doing, from the row as the store last showed it. */
    const stateOf = (row: OpenTurnRow): CardState => {
      // A hold is the owner's to decide, whatever the claim column says. Once
      // the continuation has been claimed again it is running like any turn.
      if (row.claimed_by === null && row.hold_cause) {
        return row.hold_state === "continue_pending" || row.hold_state === "continuing" ? "continuing" : "held";
      }
      if (row.state === "received") return "queued";
      if (row.claimed_by === null) return "idle";
      return row.state === "started" ? "working" : "accepted";
    };

    /**
     * A card's text at `now`. `row` is null for the last content, after the turn
     * left, and `now` is then the moment the turn ended when that is known.
     */
    const cardOf = (row: OpenTurnRow | null, line: ProgressLine, state: CardState, now = Date.now()): string => {
      // A reason belongs to the state the row was in when the clock found it,
      // and to the time before the loop was next seen doing anything.
      const wait = row !== null && line.wait !== null && line.wait.state === row.state &&
        (line.activityAt === null || line.activityAt <= line.wait.at) ? line.wait : null;
      return statusCard(language, {
        state,
        elapsed: Math.max(0, Math.round((now - line.startedAt) / 1000)),
        quiet: line.activityAt === null ? null : Math.max(0, Math.round((now - line.activityAt) / 1000)),
        actions: line.actions,
        tool: line.lastAction,
        event: line.activity,
        // "accepted, nothing recorded" is what the state and the age already say.
        why: wait === null || wait.kind === "working" ? null : waitReasonText(language, wait.kind, wait.values),
        hold: row?.hold_cause ?? null,
        spoilers: options.platform.spoilers === true,
      });
    };

    /** Takes what the runner's sheet says the loop was seen doing. Only ever forward. */
    const absorb = (line: ProgressLine, said: ProgressRow): void => {
      line.actions = Math.max(line.actions, Number(said.actions ?? 0));
      if (String(said.last_action ?? "") !== "") line.lastAction = String(said.last_action);
      const at = Date.parse(String(said.activity_at ?? ""));
      if (!Number.isNaN(at) && (line.activityAt === null || at > line.activityAt)) {
        line.activityAt = at;
        line.activity = String(said.activity ?? "");
      }
    };

    /** The ledger key of an input's card: door and message, so nothing else can mean this message. */
    const cardKey = (id: string): string => `turn-card:${options.door}:${id}`;

    const newLine = (id: string, base: number, chat: string, seed: { said?: ProgressRow; wait?: CardWait | null; legacy?: string | null } = {}): ProgressLine => {
      let finished: () => void = () => {};
      const totals = new Promise<void>((resolve) => {
        finished = () => resolve();
      });
      const line: ProgressLine = {
        key: cardKey(id),
        chat,
        legacy: seed.legacy ?? null,
        actions: 0,
        lastAction: "",
        startedAt: Number.isNaN(base) ? Date.now() : base,
        activityAt: null,
        activity: "",
        wait: seed.wait ?? null,
        wanted: "",
        tracked: false,
        blocked: false,
        closing: false,
        totals,
        finished,
      };
      if (seed.said) absorb(line, seed.said);
      return line;
    };

    /**
     * The tracking row, written BEFORE the first content is asked for, so a message
     * that has a card in the ledger always has a row saying its final content is
     * still owed. It is rewritten when the reason the card shows moves.
     */
    const track = async (id: string, line: ProgressLine): Promise<boolean> => {
      try {
        await putRow(store, PROGRESS_SHEET, id, {
          key: line.key,
          chat: line.chat,
          agent: agent.id,
          started_at: new Date(line.startedAt).toISOString(),
          ...(line.wait === null ? {} : { wait: line.wait }),
        });
        return true;
      } catch {
        return false;
      }
    };

    /**
     * Asks the ledger for `text` as the card's content, and says whether it is on
     * disk. THAT IS ALL THIS DOOR DOES ABOUT A CARD: the effects task creates the
     * message, edits it, looks for it after a lost answer and waits out a limit. A
     * failed create is not repeated from here, because a 503 or a timeout does not
     * prove the message was never made, and an edit whose outcome is unknown holds
     * every newer one back in the ledger, this one included. Nothing is asked twice
     * for the same content, and a content the ledger already holds costs nothing.
     */
    const ask = async (id: string, line: ProgressLine, text: string): Promise<boolean> => {
      if (line.legacy !== null || line.blocked) return false;
      let content: string;
      try {
        content = renderEffect(line.key, text, options.platform.name).content;
      } catch {
        // Too long for the platform, which a card never is; nothing is cut and nothing is asked.
        return false;
      }
      if (content === line.wanted && line.tracked) return true;
      if (!line.tracked) {
        line.tracked = await track(id, line);
        if (!line.tracked) return false;
      }
      if (content === line.wanted) return true;
      try {
        await wantEffect(store, { key: line.key, door: options.door, chat: line.chat, owner: `turn:${id}`, text, platform: options.platform.name });
      } catch (error) {
        // The key already belongs to a message of another chat or owner. It is another message,
        // and is not merged: this input simply has no card from here on.
        if (String((error as Error)?.message ?? error).includes("effect-identity-conflict")) line.blocked = true;
        return false;
      }
      line.wanted = content;
      // The commit announces itself to the effects task on the listener, and that is the only wake a
      // card needs. With no listener the announcement is lost, so the task is told in memory instead:
      // never both, because a second pass for one row is two statements nobody owes.
      if (projection === null) effects?.wake();
      return true;
    };

    /** What the card should read now, asked for. Nothing here waits on the platform. */
    const paint = async (row: OpenTurnRow, line: ProgressLine, state: CardState): Promise<void> => {
      if (line.closing) return;
      await ask(row.id, line, cardOf(row, line, state));
    };

    /** A clock ran out: its reason goes onto the card, which is made if there is none yet. */
    const carryWait = async (row: OpenTurnRow, wait: CardWait): Promise<void> => {
      let line = own.progress.get(row.id);
      const made = line === undefined;
      if (line === undefined) {
        line = newLine(row.id, sinceOf(row), agent.chat, { said: sheet.get(row.id), wait });
        own.progress.set(row.id, line);
      }
      if (line.legacy !== null || line.closing) return;
      const moved = made || line.wait === null || line.wait.kind !== wait.kind || line.wait.state !== wait.state ||
        JSON.stringify(line.wait.values) !== JSON.stringify(wait.values);
      line.wait = wait;
      // The row carries the reason, so a moved reason is written again before the content.
      if (moved) line.tracked = false;
      await paint(row, line, stateOf(row));
    };

    /**
     * The clock's record: the chat log first, then the diary, then the chat.
     *
     * The chat LINE a clock used to post is now the card. What the chat log and
     * the diary hold is unchanged, so the expiry's evidence is exactly what it was.
     * A note still waiting for its words keeps its own line: it is the door's own
     * work and no card exists for it yet.
     */
    const sayExpired = async (row: OpenTurnRow, stamp: string, sidecar: WaitSidecar): Promise<void> => {
      const key = `${row.id}/${stamp}`;
      if (spoken.has(key)) {
        // The silent re-arm: the read happened, and that is the whole of the
        // record. It carried fresh facts, so a card that exists is brought up to
        // date on them, with no chat line of any kind.
        spokenAt.set(key, Date.now());
        if (stamp !== "transcribed" && own.progress.has(row.id)) {
          const verdict = waitReason(waitFacts(sidecar, { registry: registryThisTick(), agent, row, stamp, open }));
          await carryWait(row, { state: row.state, at: Date.now(), kind: verdict.kind, values: verdict.values });
        }
        return;
      }
      const seconds = Math.max(
        1,
        Math.round((Date.now() - countFrom(row)) / 1000),
      );
      const text = clockLine(language, stamp, seconds);
      // One instant for the line and for the row below it, because the two are
      // records of one sentence and a reader that rebuilds the line from the
      // row has to land on the moment the file already holds.
      const id = `clock:${row.id}:${stamp}`;
      const at = new Date().toISOString();
      spoken.add(key);
      spokenAt.set(key, Date.now());
      // WHY, under the clock line, from the closed list. A note waiting for
      // its own words is waiting on this door and needs no second sentence.
      // The facts rode on the read the expiry already made, so nothing is
      // read here.
      let why: { id: string; kind: string; values: Record<string, string | number> } | null = null;
      if (stamp !== "transcribed") {
        const verdict = waitReason(waitFacts(sidecar, { registry: registryThisTick(), agent, row, stamp, open }));
        why = { id: `${id}:why`, kind: verdict.kind, values: verdict.values };
      }
      // L2's "before sending", the same order a reply chunk is written in, so
      // the next spawned session reads exactly what the person read.
      //
      // The id is the message and the clock, which is what makes the line
      // unique: one message and one clock is said once. A door killed after
      // this append and before the diary row below leaves no record that it
      // spoke, so the door that replaces it says the clock again, and the id is
      // what keeps that replay out of the chat log.
      await appendChatLineOnce(
        { stateDir, person: row.person, agent: row.agent },
        {
          id,
          at,
          direction: "out",
          // A machinery line is the DOOR speaking.
          from: options.door,
          text,
        },
      );
      const reason = why === null ? null : waitReasonLine(language, why.kind, why.values);
      if (why !== null && reason !== null) {
        await appendChatLineOnce(
          { stateDir, person: row.person, agent: row.agent },
          { id: why.id, at, direction: "out", from: options.door, text: reason },
        );
      }
      await recordExpiry(store, {
        messageId: row.id,
        stamp,
        seconds,
        person: row.person,
        agent: row.agent,
        id,
        at,
        ...(why === null ? {} : { why }),
      });
      try {
        if (why === null) await options.platform.post({ chat: agent.chat, text });
        else await carryWait(row, { state: row.state, at: Date.now(), kind: why.kind, values: why.values });
      } catch {
        // The platform refused the line. The row is in the diary either way,
        // and `check`'s stamp finding is the half a household still sees.
      }
    };

    /**
     * When this turn's progress line is worth posting, or null when there is
     * nothing to post one about.
     *
     * A LINE IS OWED ONLY ONCE THE TURN HAS OUTLIVED ONE TICK, and that is the
     * rule rather than a delay for comfort: the line says what the agent
     * is doing WHILE IT WORKS, and a turn that answers in five milliseconds
     * gives a person "working: 0 s" above the answer itself. The threshold is
     * `hub.tick_seconds`, which is already the cadence the runner writes the
     * sheet at, so no second number exists to be the same one.
     */
    const lineDueAt = (row: OpenTurnRow): number | null => {
      if (row.state !== "started") return null;
      if (own.progress.has(row.id)) return null;
      const said = sheet.get(row.id);
      if (!said) return null;
      const startedAt = Date.parse(String(said.started_at));
      return (Number.isNaN(startedAt) ? Date.now() : startedAt) + timeoutMs;
    };

    /**
     * The status card: one message per input, asked for once and edited as it goes.
     * It is made here for a turn that has outlived one tick, and by `carryWait`
     * for a clock that ran out first; a turn that answers at once has neither.
     */
    const carryProgress = async (byId: Map<string, ProgressRow>): Promise<void> => {
      for (const row of open) {
        const said = byId.get(row.id);
        let line = own.progress.get(row.id);
        if (!line) {
          if (row.state !== "started" || !said) continue;
          const due = lineDueAt(row);
          if (due === null || due > Date.now()) continue;
          line = newLine(row.id, sinceOf(row), agent.chat, { said });
          own.progress.set(row.id, line);
        } else if (said) {
          // The counts a person watches only ever go up, and so does the moment
          // the loop was last seen, whatever order two reads of one sheet come back in.
          absorb(line, said);
        }
        await paint(row, line, stateOf(row));
      }
    };

    /**
     * Whether the ledger still has a request for this card that is on its way. A
     * card that is settled, or whose newest content cannot go out for a reason the
     * ledger has recorded (a refusal, a message that is gone, an outcome unknown), is
     * not: waiting for it would be waiting for nothing.
     */
    const goingOut = (row: EffectRow): boolean => {
      if (isSettled(row)) return false;
      if (row.state === "failed" || row.state === "missing" || row.state === "unknown") return false;
      if (row.edit_state === "unknown") return false;
      return !(row.failure?.permanent === true && Number(row.failure.revision ?? 0) >= row.wanted_revision);
    };

    /** The waits still running after a card's last content was asked for, so a stopping door ends them. */
    const settling = new Set<Promise<void>>();

    /**
     * Resolves `line.totals`, which the reply waits on, once the card's last content has gone
     * out or is known not to be going out soon. BOUNDED by the reply's own allowance and by
     * the door stopping, and it asks the ledger a few times with growing gaps: the card is
     * the effects task's to deliver, and an answer is never held for a status edit.
     */
    const settleTotals = (id: string, line: ProgressLine): void => {
      const run = (async () => {
        const began = Date.now();
        try {
          for (let gap = 150; Date.now() - began < TOTALS_WAIT_MS && !stopping && !own.leaving; gap = Math.min(gap * 2, 1600)) {
            const seen = await readEffect(store, line.key);
            if (seen === null || !goingOut(seen)) break;
            await Promise.race([Bun.sleep(gap), stopped, own.left]);
          }
        } catch {
          // A store that will not answer is no reason to hold an answer back.
        } finally {
          own.progress.delete(id);
          line.finished();
        }
      })();
      settling.add(run);
      void run.finally(() => settling.delete(run));
    };

    /** The card ends where it stands: nothing is left to ask for, and the row that promised a last content goes. */
    const dropLine = async (id: string, line: ProgressLine, keepRow = false): Promise<void> => {
      if (!keepRow) await removeRow(store, PROGRESS_SHEET, id).catch(() => {});
      own.progress.delete(id);
      line.finished();
    };

    /**
     * The last content of all: L6's "ending with the totals". Says whether any card still
     * owes it, because a read or a write of the store failed and it is asked again.
     *
     * A row leaving the open set is not, by itself, proof that an answer exists, so the
     * row is asked what became of it. Only an answered or delivered stamp says `finished`,
     * and even that says the answer is recorded and never that it has reached the chat.
     * Anything else is `ended`, which claims nothing.
     *
     * THE LAST CONTENT IS ASKED FOR FIRST, and only then does the tracking row go. What the
     * card finally reads is on disk in the ledger whether or not the platform takes the edit,
     * so a refused, rate-limited or unknown edit leaves that intent standing, and neither the
     * turn having ended nor the row being gone is taken for the edit having landed.
     */
    const finishProgress = async (): Promise<boolean> => {
      const still = new Set(open.map((row) => row.id));
      let owed = false;
      for (const [id, line] of [...own.progress.entries()]) {
        if (still.has(id) || line.closing) continue;
        // A card the ledger did not make is left as it is, and so is its row: it is the
        // only record of that message an adoption would ever have.
        if (line.legacy !== null) { await dropLine(id, line, true); continue; }
        // The key is another message's, or the row names no chat: no card to finish.
        if (line.blocked) { await dropLine(id, line); continue; }
        // AN EMPTY `wanted` IS WHAT THIS DOOR HEARD, NOT WHAT THE LEDGER HOLDS. A request commits
        // in one statement and is read back in another, so an answer lost between them leaves the
        // ledger with a card (and the effects task creating it) while this line still says nothing
        // was asked. The ledger is asked: a failed read leaves the row and the work owed, an absence
        // is a card that was never made, and an existing row goes on through the request below,
        // which the ledger checks against this card's own identity like every other one.
        if (line.wanted === "") {
          let held: EffectRow | null;
          try {
            held = await readEffect(store, line.key);
          } catch {
            owed = true;
            continue;
          }
          if (held === null) { await dropLine(id, line); continue; }
          line.wanted = held.wanted_content;
        }
        let state: CardState = "ended";
        let at = Date.now();
        try {
          const [now] = (await store.sql`select i.state,
              (select max(e.at) from ledger_event e where e.stream = 'inbound' and e.subject = i.id and e.kind = 'answered') as answered_at
            from inbound i where i.id = ${id}`) as unknown as { state: string; answered_at: Date | string | null }[];
          if (now !== undefined && (now.state === "answered" || now.state === "delivered")) {
            state = "finished";
            // A turn that ended while no door watched took as long as it took, not until now.
            if (now.answered_at) at = Math.min(at, new Date(now.answered_at).getTime());
          }
        } catch {
          // What became of it cannot be read, so nothing is claimed and it is asked again.
          owed = true;
          continue;
        }
        if (!(await ask(id, line, cardOf(null, line, state, at)))) { owed = true; continue; }
        line.closing = true;
        await removeRow(store, PROGRESS_SHEET, id).catch(() => {});
        // The line stays in the map until its last content has gone out or is known not to,
        // so a reply that is ready to post finds it and waits, for a bounded time, for it.
        settleTotals(id, line);
      }
      return owed;
    };
    /** Whether a card still owes its last content, so the timeout branch asks again. */
    let finishOwed = false;

    // The people other than this agent's own whose turns it still holds. A turn
    // is announced under the person of the message it belongs to, and a message
    // keeps the person it came in under, so an agent given to another person
    // hears the end of a turn it carried over only by listening for the earlier
    // person as well. Without it the chat goes on saying somebody is typing
    // after the answer has landed, and the progress line never becomes totals.
    //
    // It costs no statement: every open row this task reads carries its person,
    // so the set is rebuilt from the read it already does, and a person whose
    // last turn here has ended drops out with that same read.
    const owedUnder = new Set<string>();
    const heard = (rows: OpenTurnRow[]): OpenTurnRow[] => {
      owedUnder.clear();
      for (const row of rows) if (row.person !== agent.person) owedUnder.add(row.person);
      return rows;
    };
    const waiter = await openTurnWaiter(store, { person: agent.person, also: owedUnder });
    try {
      // ONE read at connect, which is where a restarted door picks up every
      // turn that opened while it was down and re-arms every clock it owed,
      // and one read of what the door before it had already said.
      //
      // ONE AGENT AT A TIME. A door serving many agents runs this block for
      // all of them the moment it starts, and the SQL client was measured on
      // the Pi binding one statement's parameters to another's prepared
      // statement under that burst, which left a pooled connection inside an
      // aborted transaction and stopped every delivery routed through it.
      // Taking turns costs a few hundred milliseconds at start and nothing after.
      const turn = connectGate.then(async () => {
        open = heard(await readOpenTurns(store, { agent: agent.id }));
        for (const key of await readSpokenClocks(store, { agent: agent.id })) {
          spoken.add(key);
          spokenAt.set(key, Date.now());
        }
        // The cards a door before this one kept for its inputs, whichever way each
        // input has gone since. Every row becomes a line here: one whose turn is
        // still open is EDITED ON, with what the ledger already holds for it
        // as the content it last asked for; one whose turn ended while no door
        // was watching (it was answered, or it is gone) is finished by the first
        // pass of the loop below, which asks for its last content BEFORE the row
        // goes. Sweeping such a row here, as an earlier build did, left its card
        // saying "in progress" for good.
        //
        // A row of an earlier build has a `post_id` and no `key`: it names a message
        // the ledger never made. It is inherited only so that no second card is made
        // for its input, and is never edited, replaced or swept (see `finishProgress`).
        let legacyCards = 0;
        for (const row of (await readSheet(store, PROGRESS_SHEET)) as unknown as {
          id: string;
          data: ProgressOnDisk;
        }[]) {
          if (String(row.data.agent) !== agent.id) continue;
          const legacy = row.data.key === undefined && row.data.post_id !== undefined && String(row.data.post_id) !== "";
          // The card stays in the chat the row names, whatever chat the agent has now. A row that
          // names none is never given the current one: it is a card of unknown identity.
          const chat = typeof row.data.chat === "string" ? row.data.chat : "";
          const line = newLine(row.id, Date.parse(String(row.data.started_at)), chat, {
            wait: row.data.wait ?? null,
            ...(legacy ? { legacy: String(row.data.post_id) } : {}),
          });
          if (legacy) legacyCards += 1;
          else {
            line.tracked = true;
            const held = await readEffect(store, line.key);
            line.wanted = held?.wanted_content ?? "";
            // A ledger row in another chat than the tracking row names is not this card, and asking
            // for it would be refused by the ledger anyway: nothing more is asked for this input.
            if (chat === "" || (held !== null && held.chat !== chat)) line.blocked = true;
          }
          own.progress.set(row.id, line);
        }
        if (legacyCards > 0) {
          process.stderr.write(finding("en", { code: "door:legacy-card", target: agent.id,
            cause: `${legacyCards} status card(s) posted by an earlier build are left as they are` }) + "\n");
        }
        // What the runner's sheet says the loop was last seen doing is read once
        // more, and only when there is a card to bring up to date, so a door with
        // nothing inherited issues no statement here that it did not before.
        if (own.progress.size > 0) {
          for (const row of (await readSheet(store, TURN_PROGRESS_SHEET)) as unknown as { id: string; data: ProgressRow }[]) {
            sheet.set(row.id, row.data);
            const line = own.progress.get(row.id);
            if (line) absorb(line, row.data);
          }
        }
      });
      connectGate = turn.catch(() => {});
      try {
        await turn;
      } finally {
        own.attended();
      }
      retune();
      // A card inherited from a door before this one is brought to what the store says of
      // its input NOW (held, answered, still running), and a turn that ended while no door
      // watched is finished, before anything else is waited for. Both are a write per card
      // that needs one and nothing when none does.
      await carryProgress(sheet);
      finishOwed = await finishProgress();

      while (!stopping && !own.leaving) {
        // An attempt was cut short and its input is held: the reply sender met the
        // notice committed with the hold. One read of the open rows, which carry the
        // hold, brings the cards to it now instead of at some later read.
        if (own.holdSeen) {
          own.holdSeen = false;
          open = heard(await readOpenTurns(store, { agent: agent.id }));
          retune();
          await carryProgress(sheet);
          finishOwed = await finishProgress();
        }
        // Rows this door wrote down since the last pass. In memory, so a
        // message that nobody has claimed still has its acked clock armed.
        if (own.arrivals.length > 0) {
          for (const row of own.arrivals.splice(0)) {
            const at = open.findIndex((one) => one.id === row.id);
            // A row already here has come back because its MEDIA state moved:
            // the words exist now, so the clock this row arms is a different
            // one and its base is the moment they landed. Only those two fields
            // are taken, because the row's own state and claim are what the
            // last read of the table said and this poke knows nothing about
            // them.
            if (at === -1) open.push(row);
            else open[at] = { ...open[at], media_state: row.media_state, media_done_at: row.media_done_at };
          }
        }
        // On every pass, because the poke that woke this task may carry no row
        // at all: a transcription attempt starting or ending changes what is
        // typable and nothing else. It is memory only and acts on a flip.
        retune();
        const due = nextDeadline();
        const bound =
          due === null
            ? timeoutMs
            : Math.max(0, Math.min(timeoutMs, due - Date.now())) + 50;
        const why = await Promise.race([
          waiter.wait(bound).catch(() => "timeout" as const),
          own.arrived.wait().then(() => "arrived" as const),
          stopped,
          own.left,
        ]);
        if (why === "stopped" || stopping || own.leaving) return;
        // A row this door wrote down. Its clock is armed on the next pass and
        // nothing was asked of the store.
        if (why === "arrived") continue;

        if (why === "notified") {
          // A turn opened, ended, or its progress moved. One read of this
          // agent's open rows and one of the sheet the runner writes.
          open = heard(await readOpenTurns(store, { agent: agent.id }));
          const rows = (await readSheet(store, TURN_PROGRESS_SHEET)) as unknown as {
            id: string;
            data: ProgressRow;
          }[];
          sheet = new Map<string, ProgressRow>();
          for (const row of rows) sheet.set(row.id, row.data);
          retune();
          await carryProgress(sheet);
          finishOwed = await finishProgress();
          continue;
        }

        // The bound ran out. It says nothing on its own: reading the table on
        // it would be the timer the store exists to avoid. What it may do is
        // act on a deadline this door already holds, and the first of those is
        // the progress line, which costs the store nothing at all.
        await carryProgress(sheet);
        // A card whose last content could not be asked for is asked again, once a tick
        // and only while one is owed.
        if (finishOwed) finishOwed = await finishProgress();

        // A clock that is really due is the one recorded deadline a wake is
        // allowed on.
        const ripe = clocksOf(open).filter((clock) => clock.at <= Date.now());
        if (ripe.length === 0) continue;
        // The one read an expiry makes, with the facts the reason line needs
        // riding on it.
        const read = await readOpenTurnsWithWait(store, {
          agent: agent.id, runner: agent.runner, credential: credentialKeyOf(registryThisTick(), agent),
        });
        open = heard(read.rows);
        for (const clock of clocksOf(open)) {
          if (clock.at > Date.now()) continue;
          await sayExpired(clock.row, clock.stamp, read.sidecar);
        }
        // The rows this read returned are the freshest the door has, so every
        // card is brought up to them, with no statement of its own.
        await carryProgress(sheet);
        retune();
      }
    } finally {
      if (typing !== null) clearInterval(typing);
      for (const line of own.progress.values()) line.finished();
      own.progress.clear();
      // The waits on a last content end with the door: they check `stopping` and `left`.
      await Promise.allSettled([...settling]);
      await waiter.close();
    }
  };

  const attend = async (agent: ChatAgent, own: Served): Promise<void> => {
    // `runDoor` waits on `attending` before it hands its caller a
    // handle, and everything from here to the connect read can throw: the two
    // registry reads, and `openTurnWaiter`. A throw is swallowed by the
    // `Promise.allSettled` this task sits in, so without this outer finally a
    // door that could not start would HANG its caller instead of saying so.
    // Resolving twice is free: the inner one is what makes ready mean
    // attending, and this one is what makes it mean anything at all.
    try {
      await attending(agent, own);
    } finally {
      own.attended();
    }
  };

  /**
   * The FOURTH task per agent, and the only thing in the door that knows
   * what a quiet period is.
   *
   * A task of its own rather than work folded into `post` or `attend`, because
   * five shipped checks count
   * every statement a door issues inside a window, and two of them require
   * ZERO. So what this costs is said out loud.
   *
   * ONE statement at connect, ZERO per pass, and one read plus one insert when
   * a row is actually owed. Each pass reads two FILES: the registry, which is
   * how a changed knob lands with nothing restarted, and the chat log.
   * The door already parses the registry once a tick in `supervise`, so this is
   * a second parse of a file the process is already reading.
   */
  /**
   * ONE registry parse per tick for the WHOLE door, not one per
   * agent per pass.
   *
   * The task's own reason for re-reading stands: a changed knob lands with
   * nothing restarted. The parse is shared because it is one per agent per
   * pass otherwise, so a door serving four agents reads and parses the file
   * four times a tick on top of `supervise`'s own one, and
   * `test/wait-idle.test.ts` is the processor-time window that sees exactly
   * that cost.
   *
   * Keyed on the TICK, so a knob still lands within one tick of the edit, which
   * is the bound the per-pass parse already had. A parse that THROWS leaves the
   * cache untouched, so a half-written file is met again on the next pass
   * rather than papered over by the last good one.
   */
  let parsedFor = -1;
  let parsedRegistry: Registry | null = null;
  const registryThisTick = (): Registry => {
    const tick = Math.floor(Date.now() / timeoutMs);
    if (parsedRegistry === null || parsedFor !== tick) {
      const fresh = loadRegistry(options.registryFile);
      parsedRegistry = fresh;
      parsedFor = tick;
    }
    return parsedRegistry;
  };

  const harvesting = async (agent: ChatAgent, own: Served): Promise<void> => {
    const chat = { stateDir, person: agent.person, agent: agent.id };
    const key = { person: agent.person, agent: agent.id };
    /** What a runner has SETTLED for this chat, or null when nothing has. */
    let settled: Watermark | null = null;
    try {
      // The one read at connect, the same one `attend` and
      // `readSpokenClocks` already make. `runDoor` waits on it before it hands
      // back a handle, so "ready" means this task has spoken to the store and a
      // check that plants lines and then starts a door is deterministic rather
      // than raced. It lands before readiness and therefore outside every
      // statement window a caller opens afterwards.
      settled = await readWatermark(store, key);
    } catch {
      // A store that would not answer at connect is one the other three tasks
      // are already failing on, and this task's next pass asks again.
    } finally {
      own.harvested();
    }
    /**
     * The `until` of the last row THIS TASK wrote, and nothing else.
     *
     * It starts empty because a door that has just come up has asked for
     * nothing yet. What that costs is
     * ordinary: a bound behind the real watermark overcounts, so a restarted
     * door can write one row whose slice the runner then recomputes from the
     * sheet and finds smaller, or empty, and settles with no model turn. The
     * alternative, arming the bound from the watermark, makes a restarted door
     * measure a slice it has never been asked about against the household's
     * minimum, which is the one thing the watermark cannot tell it.
     */
    let bound: string | null = null;

    while (!stopping && !own.leaving) {
      let sleepMs = timeoutMs;
      try {
        // Re-read per tick, so the harvester, the quiet timeout, the
        // minimum slice and the report switch all land with nothing restarted.
        const fresh = registryThisTick();
        const settings = harvestFor(fresh, agent.person);
        if (settings === null) {
          // This person's chats are not harvested at all, and `check`
          // says so rather than this task complaining once a tick.
          await Promise.race([
            Bun.sleep(timeoutMs),
            stopped,
            own.left,
          ]);
          continue;
        }

        const now = new Date();
        const seen = await readSlice({ ...chat, from: historyHarvestFrom(fresh, agent.person, bound), until: now.toISOString(), skipBad });
        const newest = await newestLine({ ...chat, now, skipBad });

        let reason: HarvestBody["reason"] | null = null;
        let until = now.toISOString();
        const trigger = dueTrigger({
          newest: newest?.at ?? null, oldest: seen[0]?.at ?? null, count: seen.length,
          quietMinutes: settings.quiet_minutes, minMessages: settings.min_messages, now,
        });
        if (trigger === "backstop") {
          reason = "backstop";
          until = new Date(lastMidnight(now)).toISOString();
        } else if (trigger === "quiet") reason = "quiet";

        if (reason !== null) {
          // On firing, and only then, the watermark is read, and `from`
          // comes from IT rather than from the cached bound: the bound is what
          // this door believes and the sheet is what a runner has settled.
          settled = await readWatermark(store, key);
          const from = historyHarvestFrom(fresh, agent.person, settled?.at ?? null);
          const slice = await readSlice({ ...chat, from, until, skipBad });
          // The second gate: the row is written in one transaction
          // WHEN THE COUNT IS AT LEAST THE APPLICABLE MINIMUM. The count above
          // is the door's own, measured from a bound that is empty every time
          // this task starts, so a door that has just come up counts lines a
          // runner has long since harvested. This is the count the RUNNER will
          // really read.
          //
          // IT GATES A KEY HARVESTER AND NOT A PLAN ONE, and the two are
          // different questions rather than one rule half applied. A plan
          // preset carries the three window thresholds, and the pause,
          // notice and hold are what fence what it spends. An agent on a
          // per-token key has no window at all, so for a key
          // harvester the minimum is the ONLY cost fence there is, and a turn
          // bought under it is money the household did not agree to spend. On a
          // plan the row still lands and the runner settles it for what it
          // really holds, which is what `test/door-harvest.test.ts`'s own stage
          // 4 pins.
          const paid = getPreset(fresh, settings.harvester).paid;
          const tooFew =
            reason === "quiet" && paid === "key" && slice.length < settings.min_messages;
          if (!tooFew) {
            const body: HarvestBody = {
              from,
              until,
              reason,
              lines: slice.length,
            };
            await store.sql.begin(async (tx) =>
              enqueueInbound(
                { ...store, sql: tx as unknown as Store["sql"] },
                {
                  id: harvestRowId(agent.id, until),
                  person: agent.person,
                  agent: agent.id,
                  body: encodeHarvestBody(body),
                  kind: "harvest",
                },
              ),
            );
          }
          // The bound moves either way. A pass that looked and found too few
          // has ASKED about those lines, and leaving the bound behind would
          // make it read the watermark again on every tick for ever to decline
          // again, which is a poll where a notification exists.
          bound = until;
        }

        // The bound this task sleeps on, and the rule inside it is what
        // stops a hot loop nothing else in the suite could see. A QUIET
        // DEADLINE CONTRIBUTES ONLY WHILE IT IS IN THE FUTURE: a chat sitting
        // permanently under its minimum is the ordinary case, its deadline
        // passed long ago, and `attend`'s own `Math.max(0, due - Date.now())`
        // would be zero for ever there. `attend` cannot spin because a clock it
        // has spoken about leaves `clocksOf`, and this task has no equivalent
        // for "I looked and there was too little to say", so a deadline that
        // has passed with nothing fired hands the next wake to the tick. It
        // issues no statement, so no statement window sees the failure.
        let due = timeoutMs;
        const quietAt =
          newest === null
            ? null
            : Date.parse(newest.at) + settings.quiet_minutes * 60_000;
        if (quietAt !== null && quietAt > Date.now()) {
          due = Math.min(due, quietAt - Date.now());
        }
        const midnight = nextMidnight(now) - Date.now();
        if (midnight > 0) due = Math.min(due, midnight);
        sleepMs = Math.max(50, due + 50);
      } catch {
        // A pass that could not finish is a pass, exactly as `supervise` says
        // of a tick. It writes no diary line: the door holds two insert
        // policies on `ledger_event` and a third for a failure `check` already
        // reports (`harvest-stale`) would be a fence widened for nothing.
      }
      await Promise.race([
        Bun.sleep(sleepMs),
        stopped,
        own.left,
      ]);
    }
  };

  /**
   * The FIFTH task per agent, and the only thing in the door that turns a saved
   * voice note into words.
   *
   * IT POLLS NOTHING. It learns a note from the commit that wrote it, over the
   * same in-memory poke `attend` already uses, and it waits on that note's own
   * retry on a timer the stop cancels. It issues a statement when a note is
   * actually worked on and at no other time, which is what keeps an idle door
   * at zero statements with a note waiting.
   *
   * The whole of its connect work happens before readiness: every note this
   * agent is still owed is read once, its saved bytes are checked against the
   * receipt the download wrote, and a note whose bytes no longer match is
   * finished on the spot rather than waited on for ever.
   */
  const transcribing = async (agent: ChatAgent, own: Served): Promise<void> => {
    const language = languageOf(registry, agent.person) as Language;
    /** Each note still owed, and when it is worth another try. */
    const waiting = new Map<string, { row: PendingVoiceRow; dueAt: number }>();
    /**
     * The episode of failure this door believes it is in, read from the
     * recognizer's own health sheet so a restart never opens a second one and
     * never says the same line twice.
     */
    let episode: string | null = null;

    const arm = (row: PendingVoiceRow, dueAt: number): void => {
      waiting.set(row.id, { row, dueAt });
    };

    /** One machinery line into this person's own chat, once per key. */
    const say = async (body: string, key: string): Promise<void> => {
      const parts = prepareReply(body, options.platform.name, language);
      await store.sql.begin(async tx => {
        for (const [index, part] of parts.entries()) {
          await tx`select hub_door_notice(${agent.person}, ${agent.id}, ${part},
            ${index === 0 ? key : `${key}:part:${index + 1}`},
            ${{ door: options.door, chat: agent.chat }}::jsonb, ${index + 1})`;
        }
      });
    };

    /** The saved note's bytes, still the ones the download wrote. */
    const sound = (row: PendingVoiceRow): boolean => {
      const note = voiceMediaOf(row.source);
      if (note === null) return true;
      try {
        const bytes = new Uint8Array(readFileSync(note.path));
        return new Bun.CryptoHasher("sha256").update(bytes).digest("hex") === note.sha256;
      } catch {
        return false;
      }
    };

    /**
     * The note waited out its whole window. What exists is rendered in order
     * with a marker where each missing stretch was, the person is told, and the
     * row is finished so the agent answers it.
     */
    const abandon = async (row: PendingVoiceRow, voice: VoiceSettings): Promise<void> => {
      const note = voiceMediaOf(row.source);
      let held: ChunkFile | null = null;
      try { held = note === null ? null : readChunkFile(chunkFilePath(note.path, note.index)); }
      catch { held = null; }
      const partial = held === null ? "" : renderPartial(held, language);
      const text = [partial, voiceGaveUp(language, voice.give_up_hours)].filter(Boolean).join("\n");
      const source = note === null ? row.source : spliceTranscript(row.source, note.line, text);
      await markMediaFailed(store, { id: row.id, state: "failed", retryAt: null,
        failure: { class: "infra", cause: "gave-up" },
        body: String((source as { text?: string }).text ?? ""), source });
      await recordTranscribe(store, { id: row.id, kind: "transcribe.failed",
        recognizer: voice.recognizer, chunks: held?.chunks.length ?? null, audio_s: null,
        decode_ms: null, attempts: null, class: "infra", cause: "gave-up" });
      waiting.delete(row.id);
      // The person read the give-up line, and with nothing of theirs left
      // waiting their episode is over: a later outage is theirs to hear of.
      if (waiting.size === 0) episode = null;
      await projectInbound(store, { stateDir, inboundId: row.id, skipBad });
    };

    /**
     * The household took its recognizer out of the file while this note was
     * waiting for it. Nobody is going to transcribe it now, so it is FINISHED
     * here rather than let go of: a row left pending is one the startup scan
     * passes over by design, that `check` says nothing about once the component
     * is gone, and that nobody is ever answered about. The person reads the
     * same sentence a household that never had a recognizer reads.
     */
    const finishUnnamed = async (row: PendingVoiceRow): Promise<void> => {
      waiting.delete(row.id);
      if (waiting.size === 0) episode = null;
      const at = new Date();
      await markMediaFailed(store, { id: row.id, state: "failed", retryAt: null,
        failure: { class: "infra", cause: "recognizer-unnamed" }, at });
      await say(voicePending(language), `voice:unnamed:${row.id}`);
      await projectInbound(store, { stateDir, inboundId: row.id, skipBad });
      own.arrivals.push({ id: row.id, person: row.person, agent: row.agent,
        received_at: row.receivedAt, state: "received", claimed_by: null,
        media_state: "failed", media_done_at: at, reported_at: null });
      own.arrived.wake();
    };

    /** One note, once. */
    const work = async (row: PendingVoiceRow): Promise<void> => {
      const fresh = registryThisTick();
      const voice = voiceFor(fresh);
      if (voice === null) {
        await finishUnnamed(row);
        return;
      }
      const state = await readMediaState(store, row.id);
      if (state === null) {
        waiting.delete(row.id);
        return;
      }
      if (state.state !== "pending") {
        // THE TEXT LANDED AND SOMETHING AFTER IT DID NOT. Writing the words and
        // appending the log line are two writes, and a row between them has its
        // text, no log line and no claim: the runner cannot see it, and the turn
        // stays open with its clocks running. Finishing it here is what saves it
        // from waiting for the next door start, which is the only other thing
        // that looks at a row in that state.
        waiting.delete(row.id);
        const [seen] = (await store.sql`
          select log_ready from inbound where id = ${row.id}`) as unknown as
          { log_ready: boolean }[];
        if (seen === undefined || seen.log_ready) return;
        await projectInbound(store, { stateDir, inboundId: row.id, skipBad });
        own.arrivals.push({ id: row.id, person: row.person, agent: row.agent,
          received_at: row.receivedAt, state: "received", claimed_by: null,
          media_state: state.state, media_done_at: state.done_at, reported_at: null });
        own.arrived.wake();
        return;
      }
      if (Date.now() >= row.receivedAt.getTime() + voice.give_up_hours * 3_600_000) {
        await abandon(row, voice);
        return;
      }
      const endpoint = recognizerEndpoint(fresh, voice, options.door);
      // The person sees typing while their note is being worked on, and not
      // while it waits for its next try: a chat saying somebody is typing for
      // the hours a recognizer can be down would be the same lie the claim
      // filter on the typing rule exists to prevent.
      own.inFlight.add(row.id);
      own.arrived.wake();
      let outcome: Awaited<ReturnType<typeof transcribeRow>>;
      try {
        outcome = await transcribeRow(store, {
          row: { id: row.id, source: row.source }, voice, language,
          endpoint: endpoint ?? "", attempts: state.attempts,
          credentialFile: voice.credential === null ? null
            : credentialFor(fresh, voice.credential)?.file ?? null,
        });
      } finally {
        own.inFlight.delete(row.id);
        own.arrived.wake();
      }
      if (outcome.state === "done" || outcome.failure === "content") {
        waiting.delete(row.id);
        // The words exist, so the row becomes an ordinary human message: one
        // log line, `log_ready`, and the claim gate opens.
        await projectInbound(store, { stateDir, inboundId: row.id, skipBad });
        // And the clock task is told, over the same poke the commit uses. Without
        // it a door with nothing claiming its rows would hold the clock this row
        // armed while it had no words, because nothing else wakes that task
        // until a turn opens.
        own.arrivals.push({ id: row.id, person: row.person, agent: row.agent,
          received_at: row.receivedAt, state: "received", claimed_by: null,
          media_state: outcome.state === "done" ? "done" : "failed",
          media_done_at: outcome.doneAt, reported_at: null });
        own.arrived.wake();
        if (outcome.state === "done" && episode !== null) {
          const [count] = await store.sql`select count(*)::int as waiting from inbound
            where agent = ${agent.id} and media_state = 'pending'`;
          await say(transcriberBack(language, Number(count?.waiting ?? 0)),
            `voice:back:${voice.recognizer}:${episode}:${agent.person}`);
          episode = null;
        }
        // A note that ended with no words says nothing about the recognizer,
        // so no "works again" is said for it. With no note of theirs left
        // waiting, this person's story is over and the episode is forgotten:
        // held open, it would swallow every later outage they should hear of.
        if (waiting.size === 0) episode = null;
        return;
      }
      arm(row, outcome.retryAt?.getTime() ?? Date.now() + voice.retry_seconds * 1000);
      // ONE LINE PER EPISODE PER PERSON. The episode's own id is the moment the
      // recognizer's health sheet says it began, so a door started again in the
      // middle of one says nothing a second time. The person is the last part
      // of the key because the sentence is theirs, and a household with two
      // people owes each of them one. A person already told "not answering"
      // is not told again while they wait for "works again", whatever the
      // sheet's episode is by now: another person's success may have cleared
      // and reopened it in between.
      const since = (await readVoiceHealth(store)).get(voice.recognizer)?.since ?? null;
      if (since !== null && episode === null) {
        episode = since;
        await say(transcriberDown(language, voice.retry_seconds),
          `voice:down:${voice.recognizer}:${since}:${agent.person}`);
      }
      // A converter or a recognizer that wedged is the one failure a restart
      // can fix, so the door ASKS and the hub decides. Keyed on the attempt, so
      // a replay of the same attempt asks once.
      if (outcome.cause === "chunk-deadline") {
        const entry = transcriberEntry(fresh, options.door);
        if (entry !== null) {
          await requestRecovery(store, {
            id: `voice-recovery:${entry.id}:${row.id}:${state.attempts}`,
            registry: fresh, source: "door", actor: "door",
            target_kind: "run", target_id: entry.id,
          }).catch(async error => {
            await recordDiagnostic(store, { operation: "recovery", target: entry.id, actor: "door",
              error: { code: "recovery-refused", message: (error as Error).message } }).catch(() => {});
          });
        }
      }
    };

    try {
      try {
        const rows = (await store.sql`select id, person, agent, source, received_at, media_retry_at
          from inbound where agent = ${agent.id} and media_state = 'pending'`) as unknown as {
            id: string; person: string; agent: string; source: Record<string, unknown>;
            received_at: string | Date; media_retry_at: string | Date | null;
          }[];
        // THE EPISODE IS THIS PERSON'S, read back from the last line they were
        // told, never from the recognizer's sheet. The sheet is one row per
        // recognizer, and with two people on one recognizer a success of one
        // clears it while the other is still failing: a door that took the
        // sheet's fresh episode would tell the second person "not answering"
        // twice with no "works again" between, and one that took the sheet's
        // standing episode after a restart would never tell a person who had
        // not heard it yet.
        // The first part of the newest line, because a line cut for the
        // platform carries its key on every part with a suffix after the person.
        const [told] = (await store.sql`select notice_key from outbox
          where kind = 'notice' and agent = ${agent.id} and notice_key like 'voice:%'
            and notice_key not like '%:part:%'
          order by id desc limit 1`) as unknown as { notice_key: string }[];
        const last = /^voice:(down|back):[^:]+:(.+):[^:]+$/.exec(String(told?.notice_key ?? ""));
        // Restored only while a note of theirs is still waiting: a note that
        // gave up or ended without words left no "works again" behind, and
        // its episode is over with it.
        episode = last?.[1] === "down" && rows.length > 0 ? last[2] : null;
        for (const row of rows) {
          const it: PendingVoiceRow = { id: String(row.id), person: String(row.person),
            agent: String(row.agent), source: row.source, receivedAt: new Date(row.received_at) };
          // A note whose audio no longer matches its receipt will never be the
          // right words, so it is finished here rather than retried for hours.
          if (!sound(it)) { await work(it); continue; }
          arm(it, row.media_retry_at === null ? 0 : new Date(row.media_retry_at).getTime());
        }
      } catch {
        // A store that would not answer at connect is one the other four tasks
        // are already failing on, and the next pass asks again.
      } finally {
        own.transcribed();
      }

      while (!stopping && !own.leaving) {
        for (const row of own.voice.splice(0)) if (!waiting.has(row.id)) arm(row, 0);
        let soonest: { id: string; dueAt: number } | null = null;
        for (const [id, one] of waiting) {
          if (soonest === null || one.dueAt < soonest.dueAt) soonest = { id, dueAt: one.dueAt };
        }
        if (soonest !== null && soonest.dueAt <= Date.now()) {
          const one = waiting.get(soonest.id)!;
          // THE STOP DOES NOT WAIT FOR A RECOGNIZER. A chunk may sit in a
          // request for as long as its own deadline allows, and a door whose
          // stop waited that out would hold a restart for minutes. The row is
          // still `pending` on disk, so whatever this pass does not finish the
          // next door's connect scan picks up: nothing is lost by walking away
          // from it, and the work that is still in flight writes into a store
          // that is closing, which is why its failure is swallowed.
          const finished = work(one.row).then(() => "worked" as const, () => {
            // A pass that could not finish is a pass. The note keeps its place
            // and is tried again on the tick.
            arm(one.row, Date.now() + timeoutMs);
            return "worked" as const;
          });
          const why = await Promise.race([finished, stopped, own.left]);
          if (why !== "worked") return;
          continue;
        }
        const bound = soonest === null
          ? timeoutMs
          : Math.max(1, Math.min(timeoutMs, soonest.dueAt - Date.now()));
        const why = await Promise.race([
          Bun.sleep(bound).then(() => "timeout" as const),
          own.voiced.wait().then(() => "arrived" as const),
          stopped,
          own.left,
        ]);
        if (why === "stopped" || stopping || own.leaving) return;
      }
    } finally {
      waiting.clear();
    }
  };

  const served = new Map<string, Served>();

  const serve = (agent: ChatAgent, activate = false): void => {
    let release: () => void = () => {};
    const left = new Promise<"stopped">((resolve) => {
      release = () => resolve("stopped");
    });
    let attended: () => void = () => {};
    const attending = new Promise<void>((resolve) => {
      attended = () => resolve();
    });
    let harvested: () => void = () => {};
    const waitingToHarvest = new Promise<void>((resolve) => {
      harvested = () => resolve();
    });
    let transcribed: () => void = () => {};
    const waitingToTranscribe = new Promise<void>((resolve) => {
      transcribed = () => resolve();
    });
    let readied!: () => void;
    const reading = new Promise<void>(resolve => { readied = resolve; });
    let posted!: () => void;
    const posting = new Promise<void>(resolve => { posted = resolve; });
    const it: Served = {
      agent: { ...agent }, rebinding: false, readDone: Promise.resolve(), reading, readied,
      leaving: false,
      left,
      release,
      done: Promise.resolve(),
      attending,
      attended,
      harvesting: waitingToHarvest,
      harvested,
      transcribing: waitingToTranscribe,
      transcribed,
      posting,
      posted,
      progress: new Map<string, ProgressLine>(),
      holdSeen: false,
      arrivals: [],
      arrived: nudge(),
      voice: [],
      voiced: nudge(),
      inFlight: new Set<string>(),
    };
    agent = it.agent;
    served.set(agent.id, it);
    it.readDone = read(agent, it, activate).finally(() => it.readied());
    it.done = Promise.allSettled([
      // Its waiter is opened outside the pass's own error handling, so a throw
      // there would leave `posting` pending and the door's caller waiting for
      // ever. Resolving twice is free.
      post(agent, it).finally(() => it.posted()),
      attend(agent, it),
      // The same outer `finally` `attend` carries, and for the same reason: a
      // throw before the connect read is swallowed by `allSettled`, so without
      // it a door that could not start would HANG its caller instead of saying
      // so. Resolving twice is free.
      harvesting(agent, it).finally(() => it.harvested()),
      // The same outer `finally` again, and for the same reason: a throw before
      // the connect read is swallowed by `allSettled`, so without it a door
      // that could not start would hang its caller instead of saying so.
      transcribing(agent, it).finally(() => it.transcribed()),
    ]).then(() => {});
  };

  const drop = async (id: string): Promise<void> => {
    const it = served.get(id);
    if (!it) return;
    served.delete(id);
    it.leaving = true;
    it.release();
    await Promise.allSettled([it.done, it.readDone]);
  };

  for (const agent of agentsFor(registry, { door: options.door })) serve(agent);
  await Promise.all([...served.values()].map(it => it.reading));
  for (const it of served.values()) await sayReadFailure(it.agent);
  releaseHealth();
  // Ready means ATTENDING, HARVESTING AND POSTING, so a caller handed this door
  // is handed one whose clocks are armed, whose two connect reads have landed
  // and whose reply sender has made its first pass over the replies waiting.
  // Without it a read rides into whatever window the caller opens next, which
  // is what test/door-clock.test.ts's restart budget counts from 2 s after
  // ready. The post task waits for `healthReady` before that pass, so this wait
  // comes after `releaseHealth()` and never before it. It ends when the store
  // refuses the pass too, because the pass catches its own failure.
  await Promise.all([...served.values()].map((it) => it.attending));
  await Promise.all([...served.values()].map((it) => it.harvesting));
  await Promise.all([...served.values()].map((it) => it.transcribing));
  await Promise.all([...served.values()].map((it) => it.posting));

  // The platform-message task. Ready means its connect reads are made, which is one
  // statement for the rows it owes and one for the previews it waits on, and nothing
  // after them while none is owed.
  effects = startEffects({
    // What acts on an approval is what this door was handed and, always, the topic chat's own.
    store, platform: options.platform, door: options.door, hooks: { ...topicApprovals(), ...outboundApprovals(), ...(options.approvals ?? {}) },
    registry: () => registryThisTick(),
    settings: () => {
      const fresh = registryThisTick();
      return { retrySeconds: Number(readSetting(fresh, "door.delivery_retry_seconds")),
        maxAttempts: Number(readSetting(fresh, "door.delivery_max_attempts")) };
    },
    tickMs: timeoutMs,
    gate: (read) => {
      const turn = connectGate.then(read);
      connectGate = turn.then(() => {}, () => {});
      return turn;
    },
  });
  await effects.ready;
  if (readSetting(registry, "outbound.accounts_file") !== undefined) outbound = startOutbound(store, () => registryThisTick() as Registry, options.door);

  // The council task: keeps each live council's card true and says what needs its owner. Ready means its one
  // connect read (which councils this door has something to say about) is made, in the connect gate's turn; a
  // door with none has one statement there and nothing after it.
  council = startCouncilWatch({
    store, door: options.door, registry: () => registryThisTick(), tickMs: timeoutMs,
    gate: (read) => {
      const turn = connectGate.then(read);
      connectGate = turn.then(() => {}, () => {});
      return turn;
    },
  });
  await council.ready;

  // The topic task: chats the owner asked to be made, archived, reopened, or found gone. It starts
  // once every chat is being read, so its first reads never race the connect reads above, and with
  // no topic on this door it costs one statement.
  topics = startTopics({
    store, platform: options.platform, door: options.door, registry: () => registryThisTick(), stateDir,
    settings: () => {
      const fresh = registryThisTick();
      return { retrySeconds: Number(readSetting(fresh, "door.delivery_retry_seconds")),
        maxAttempts: Number(readSetting(fresh, "door.delivery_max_attempts")),
        pollSeconds: Number(readSetting(fresh, "door.topic_poll_seconds")) };
    },
    tickMs: timeoutMs,
  });
  await topics.ready;

  // THE TOPIC TASK LINKS THE ORDINARY MASTERS THE REGISTRY NAMES, and it hears when that set changes (an adoption adds
  // one, a repair moves one, an archive mapping is added) from here, on the tick this loop already takes, rather than
  // polling for it. The shape is compared as text, so an edit that changes nothing of it wakes nothing. It also holds where each
  // person's General is, because what could not be told is owed until a place can take it, and a registry edit that names one
  // (or none) is what makes a place that could not take it able to.
  const mastersShape = (fresh: unknown): string => JSON.stringify([
    legacyMastersOf(fresh, options.door).map(one => [one.agent.id, one.agent.person, one.agent.chat, one.machine, one.runner, one.preset]),
    archiveOf(fresh, options.door),
    listPeople(fresh).map(person => { const general = generalOf(fresh, person.id); return [person.id, general?.id ?? null, general?.door ?? null, general?.chat ?? null]; }),
  ]);
  let mastersSeen = "";
  try { mastersSeen = mastersShape(loadRegistry(options.registryFile)); } catch { /* the first tick that reads a file sets it */ }

  const supervise = (async () => {
    while (!stopping) {
      await Promise.race([Bun.sleep(timeoutMs), stopped]);
      if (stopping) break;
      let fresh: unknown;
      try {
        fresh = loadRegistry(options.registryFile);
      } catch {
        continue;
      }
      try {
        const shape = mastersShape(fresh);
        if (shape !== mastersSeen) { mastersSeen = shape; topics?.wake(); }
        const wanted = agentsFor(fresh, { door: options.door });
        for (const agent of wanted) {
          const it = served.get(agent.id);
          if (!it) { await health.initialize(agent); serve(agent); }
          else if (it.agent.person !== agent.person) {
            // Everything this agent's tasks wait on or read is keyed
            // on its person: the outbox and turn waiters listen for that
            // person's notifications, `attend` holds its language and clock
            // thresholds, and the harvest task reads its chat log. So a new
            // person is a new set of tasks. The read loop stops at a batch
            // boundary, and the new one activates its route exactly as a chat
            // edit does below ONLY when the chat changed too. A person
            // edit that keeps the chat keeps reading it where the old tasks
            // left off, saved cursor or none: activating it asked the platform
            // where the chat stood and skipped a message sent right after the
            // edit as history.
            const moved = it.agent.chat !== agent.chat;
            await drop(agent.id);
            await health.initialize(agent);
            serve(agent, moved);
          }
          else if (it.agent.chat !== agent.chat) {
            it.rebinding = true;
            await it.readDone;
            Object.assign(it.agent, agent);
            await health.initialize(agent);
            it.rebinding = false;
            it.readDone = read(it.agent, it, true);
          }
        }
        for (const id of [...served.keys()]) {
          if (wanted.some((agent) => agent.id === id)) continue;
          // The cursor is THIS DOOR'S OWN sheet about a chat it no longer
          // serves, so it goes with the reader, after the reader has stopped
          // and can no longer write it back. The hub deletes it too when it
          // retires an agent, for the door that is not running at the time.
          const chat = served.get(id)!.agent.chat;
          await drop(id);
          await removeRow(store, CURSOR_SHEET, cursorId(options.door, chat)).catch(() => {});
        }
      } catch {
        // A tick that could not finish is a tick. The next one runs.
      }
    }
  })();

  return {
    door: options.door,
    async stop() {
      stopping = true;
      release();
      await supervise;
      await Promise.allSettled([...served.values()].flatMap((it) => [it.done, it.readDone]));
      await outbound?.stop();
      await topics?.stop();
      await council?.stop();
      await effects?.stop();
      await closeProjection();
      await ingress.close();
      await store.close();
    },
  };
}
