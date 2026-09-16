import { appendChatLine } from "../chatlog.ts";
import { stamp } from "../records/stamps.ts";
import { putRow, readSheet, removeRow } from "../records/statesheet.ts";
import { agentsFor, languageOf, thresholdsFor } from "../registry/entries.ts";
import { loadRegistry, readSetting, type AgentEntry } from "../registry/load.ts";
import { TURN_PROGRESS_SHEET, type ProgressRow } from "../runner/progress.ts";
import { openStore, storeUrlAs, type Store } from "../store/connect.ts";
import { enqueueInbound, inboundId } from "../store/inbound.ts";
import { markDelivered, readPendingChunks } from "../store/outbox.ts";
import { readOpenTurns, type OpenTurnRow } from "../store/turns.ts";
import { openOutboxWaiter, openTurnWaiter } from "../store/wake.ts";
import { clockDeadlines, readSpokenClocks, recordExpiry } from "./clock.ts";
import { readCursor, writeCursor } from "./cursor.ts";
import { clockLine, progressLine, progressTotals, type Language } from "./lines.ts";
import type { Platform } from "./platform.ts";

/**
 * The one progress line this door posted for a message, while its turn is open.
 *
 * It is shared between `attend`, which posts it and edits it as the work goes,
 * and `post`, which waits for its totals before it puts the reply underneath.
 * That wait is what makes L6's "ending with the totals" an ordering rather than
 * a hope: both tasks are woken by the same settling commit, and without it the
 * reply and the last edit race.
 */
interface ProgressLine {
  platformId: string | null;
  actions: number;
  lastAction: string;
  startedAt: number;
  /** Resolves once the totals are on the line. */
  totals: Promise<void>;
  finished(): void;
}

/** How long `post` waits for those totals before it goes ahead anyway. */
const TOTALS_WAIT_MS = 5000;

/**
 * REVIEW S5. Which platform message the progress line of an open turn IS.
 *
 * The door's own sheet, one row per message id, written when the line is posted
 * and removed when the totals land on it. Without it the id lived only in the
 * memory of the process that posted it, so a door started again mid-turn found
 * the runner's `turn_progress` row still there, thought a line was owed, and
 * posted a SECOND one: the first was left frozen in the chat at whatever second
 * count it had, never edited to its totals, and the person read two lines about
 * one turn. The clock half of the same restart already worked, because a `clock`
 * ledger row is what a restarted door reads to know it has already spoken.
 */
const PROGRESS_SHEET = "door_progress";

interface ProgressOnDisk {
  post_id: string;
  chat: string;
  agent: string;
  started_at: string;
}

/**
 * An in-process poke, so one task of a door can tell another that something
 * happened without either of them asking the store.
 *
 * D-127 arms a clock "per message it knows about", and a message the door has
 * just written down is one it knows about WITHOUT a read: nothing on
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
  // next iteration whatever woke it (REVIEW's note on this function).
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
 * D-104. The door reconciles its agent set on the tick exactly as the runner
 * does, because RUN-09's Forbidden line is "a process that reads its
 * configuration only at startup" and it does not say "the runner": an agent
 * added to the file whose door never pulls its chat is an agent nobody can
 * reach, so the routine operation "add an agent" is not done until the door has
 * noticed too. The reconcile is one file parse per tick and issues no SQL, so
 * the door's outbox wait still issues nothing at all.
 */
interface Served {
  leaving: boolean;
  /** Resolves when this agent alone is asked to leave. */
  left: Promise<"stopped">;
  release(): void;
  done: Promise<void>;
  /** Resolves once `attend` has done its one read at connect. */
  attending: Promise<void>;
  attended(): void;
  /** The progress line of each open turn, by message id. */
  progress: Map<string, ProgressLine>;
  /** Rows this door wrote down itself, handed to `attend` with no read. */
  arrivals: OpenTurnRow[];
  arrived: Nudge;
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
/** D-125's pinned refusal, thrown by `runDoor` at start. */
function cannotShowTyping(door: string): string {
  return (
    `${door} serves a platform that cannot show typing, and a turn open with no typing ` +
    `shown is forbidden. A platform carries typing() and typingSeconds.`
  );
}

export async function runDoor(options: {
  door: string;
  registryFile: string;
  platform: Platform;
}): Promise<DoorHandle> {
  // SPEC §2's Forbidden line, refused BY NAME and at START. It lives here and
  // not in `src/entry/door.ts` because every check drives `runDoor` directly
  // (D-33, D-94), so a refusal in the entry point would be a promise rather
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
    url: storeUrlAs(String(readSetting(registry, "hub.store_url")), "hub_door"),
  });

  let stopping = false;
  let release: () => void = () => {};
  const stopped = new Promise<"stopped">((resolve) => {
    release = () => resolve("stopped");
  });

  const read = async (agent: AgentEntry, own: Served): Promise<void> => {
    let cursor = await readCursor(store, options.door, agent.chat);
    while (!stopping && !own.leaving) {
      const pulled = await Promise.race([
        options.platform
          .pull({ chat: agent.chat, cursor, timeoutMs })
          .catch(() => null),
        stopped,
        own.left,
      ]);
      // An agent that left the file is a chat this door no longer pulls, so
      // anything said in it after that is never read and never written down.
      if (pulled === "stopped" || stopping || own.leaving) return;
      if (pulled === null) {
        // The platform is unreachable. Nothing announces its return, so this is
        // the one wait on a clock, and it touches no table.
        await Promise.race([Bun.sleep(timeoutMs), stopped, own.left]);
        continue;
      }

      for (const message of pulled.messages) {
        const id = inboundId(
          options.platform.name,
          message.chat,
          message.platform_message_id,
        );
        const fresh = await store.sql.begin(async (tx) =>
          enqueueInbound(
            { ...store, sql: tx as unknown as Store["sql"] },
            { id, person: agent.person, agent: agent.id, body: message.text },
          ),
        );
        // Only a row this pull created gets a line. A redelivery that wrote
        // nothing would otherwise put a second message in the diary that
        // nobody sent.
        if (fresh) {
          // D-127. The door arms a clock per message it KNOWS ABOUT, and it
          // knows about this one because it just wrote it: nothing announces a
          // `received` row on `hub_turn`, so `attend` is told here rather than
          // finding out on some later wake that happened to read the table.
          own.arrivals.push({
            id,
            person: agent.person,
            agent: agent.id,
            received_at: new Date(),
            state: "received",
            claimed_by: null,
          });
          own.arrived.wake();
          await appendChatLine(
            { stateDir, person: agent.person, agent: agent.id },
            {
              at: message.at,
              direction: "in",
              from: agent.person,
              text: message.text,
            },
          );
        }
      }

      if (pulled.messages.length > 0 && pulled.cursor !== null) {
        cursor = pulled.cursor;
        await writeCursor(store, options.door, agent.chat, cursor);
      }
    }
  };

  const post = async (agent: AgentEntry, own: Served): Promise<void> => {
    // Which chunks already have their line on disk, so a post the platform
    // refused is tried again with no second line: the chat log is a diary and
    // not a record of attempts. A delivered chunk leaves the set, which is what
    // keeps it the size of what is in flight.
    const logged = new Set<number>();
    let owed = false;

    const deliver = async (): Promise<void> => {
      const pending = await readPendingChunks(store, { agent: agent.id });
      const refused = new Set<string>();
      const posted = new Set<string>();
      let anyRefused = false;
      for (const chunk of pending) {
        if (stopping || own.leaving) return;
        // D-113. A NOTICE has no message on it, so none of the per-message
        // bookkeeping below is about it: it is not half of a reply, it holds
        // nothing else back, and there is nothing to stamp delivered.
        if (chunk.inbound_id !== null && refused.has(chunk.inbound_id)) continue;
        if (!logged.has(chunk.id)) {
          await appendChatLine(
            { stateDir, person: chunk.person, agent: chunk.agent },
            {
              at: new Date().toISOString(),
              direction: "out",
              // D-129. A machinery line is the DOOR speaking, so the tail
              // renders `<door id>: [door] ...` and the next spawned session
              // reads exactly what the chat holds, marked as machinery twice
              // over. A reply chunk keeps the agent and nothing about it
              // changes.
              from: chunk.kind === "notice" ? options.door : chunk.agent,
              text: chunk.body,
            },
          );
          logged.add(chunk.id);
        }
        // L6's "ending with the totals": the progress line is edited to them
        // BEFORE the reply is posted. `attend` and this task are woken by the
        // same settling commit, so without this wait the two race and a person
        // reads the answer above a line still saying "working".
        if (chunk.kind === "reply" && chunk.inbound_id !== null) {
          const line = own.progress.get(chunk.inbound_id);
          if (line) {
            await Promise.race([line.totals, Bun.sleep(TOTALS_WAIT_MS)]);
          }
        }
        try {
          await options.platform.post({ chat: agent.chat, text: chunk.body });
        } catch {
          // The rest of this reply waits with it, so a person never reads the
          // second half of an answer before the first.
          if (chunk.inbound_id !== null) refused.add(chunk.inbound_id);
          anyRefused = true;
          continue;
        }
        await markDelivered(store, chunk.id);
        logged.delete(chunk.id);
        if (chunk.inbound_id !== null) posted.add(chunk.inbound_id);
      }
      for (const id of posted) {
        if (!refused.has(id)) {
          await stamp(store, { messageId: id, kind: "delivered", actor: "door" });
        }
      }
      owed = anyRefused;
    };

    // The LISTEN is opened before the first read and held across every wait,
    // so a settle that commits between a read and the wait after it is
    // announced to a listener that already exists. Opened after the read, it
    // would miss exactly that commit, and this door never re-reads on a bare
    // timeout to recover from one.
    const waiter = await openOutboxWaiter(store, { person: agent.person });
    try {
      // Once on connect, because a reply settled while this door was down is on
      // disk with nothing left to announce it.
      await deliver();
      while (!stopping && !own.leaving) {
        const why = await Promise.race([
          waiter.wait(timeoutMs).catch(() => "timeout" as const),
          stopped,
          own.left,
        ]);
        if (why === "stopped" || stopping || own.leaving) return;
        // The notification is what says there is something to post. The bound
        // running out says nothing, and reading the table on it would be the
        // timer the store exists to avoid. A refused post is the one thing owed
        // to the clock, because nothing will announce the platform's return.
        if (why === "notified" || owed) await deliver();
      }
    } finally {
      await waiter.close();
    }
  };

  /**
   * The third task per agent, and the only thing in the door that knows a turn
   * is open (D-126).
   *
   * It owns its own waiter on `hub_turn`, so `post`'s loop is untouched and the
   * window `test/door-outbox.test.ts` counts statements inside is exactly what
   * it was. What it reads, and NOTHING else: once at connect, once per
   * notification, and once per clock that has run out. The typing refresh is a
   * timer over memory and issues no statement at all.
   */
  const attending = async (agent: AgentEntry, own: Served): Promise<void> => {
    const thresholds = thresholdsFor(registry, agent.person);
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
      // D-126's table: a turn OPENS at `acked` and ENDS at `answered`. A
      // `received` row would show a person somebody working on a message the
      // loop has not accepted, and an `answered` one would show it after the
      // answer was written.
      //
      // AND IT HAS TO BE CLAIMED (D-126 as amended after the review, REVIEW
      // S4). A turn the loop REFUSED leaves its row at `acked` (D-121a) and
      // releases it onto `retry_at`, so the state alone cannot tell a turn that
      // is running from one that is waiting out an outage. Without the claim
      // the door typed for the whole of an outage: a person watched a chat
      // saying somebody was typing while the notice beside it said messages
      // were waiting, and the platform took one call every few seconds per
      // agent for as long as it lasted.
      open.filter(
        (row) =>
          (row.state === "acked" || row.state === "started") && row.claimed_by !== null,
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
        for (const clock of clockDeadlines(row, thresholds)) {
          const key = `${row.id}/${clock.stamp}`;
          if (!spoken.has(key)) {
            out.push({ row, stamp: clock.stamp, at: clock.at });
            continue;
          }
          // D-126. Only the answered clock comes back, and it comes back
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

    /** MSG-10's clock line: the chat log first, then the diary, then the chat. */
    const sayExpired = async (row: OpenTurnRow, stamp: string): Promise<void> => {
      const key = `${row.id}/${stamp}`;
      if (spoken.has(key)) {
        // The silent re-arm: the read happened, and that is the whole of it.
        spokenAt.set(key, Date.now());
        return;
      }
      const seconds = Math.max(
        1,
        Math.round((Date.now() - new Date(row.received_at).getTime()) / 1000),
      );
      const text = clockLine(language, stamp, seconds);
      spoken.add(key);
      spokenAt.set(key, Date.now());
      // L2's "before sending", the same order a reply chunk is written in, so
      // the next spawned session reads exactly what the person read.
      await appendChatLine(
        { stateDir, person: row.person, agent: row.agent },
        {
          at: new Date().toISOString(),
          direction: "out",
          // D-129. A machinery line is the DOOR speaking.
          from: options.door,
          text,
        },
      );
      await recordExpiry(store, {
        messageId: row.id,
        stamp,
        seconds,
        person: row.person,
        agent: row.agent,
      });
      try {
        await options.platform.post({ chat: agent.chat, text });
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
     * rule rather than a delay for comfort: MSG-10's line says what the agent
     * is doing WHILE IT WORKS, and a turn that answers in five milliseconds
     * gives a person "working: 0 s" above the answer itself. The threshold is
     * `hub.tick_seconds`, which is already the cadence the runner writes the
     * sheet at (D-124), so no second number exists to be the same one.
     */
    const lineDueAt = (row: OpenTurnRow): number | null => {
      if (row.state !== "started") return null;
      if (own.progress.has(row.id)) return null;
      const said = sheet.get(row.id);
      if (!said) return null;
      const startedAt = Date.parse(String(said.started_at));
      return (Number.isNaN(startedAt) ? Date.now() : startedAt) + timeoutMs;
    };

    /** MSG-10's progress line: one message, posted once and edited as it goes. */
    const carryProgress = async (byId: Map<string, ProgressRow>): Promise<void> => {
      for (const row of open) {
        if (row.state !== "started") continue;
        const said = byId.get(row.id);
        if (!said) continue;
        const startedAt = Date.parse(String(said.started_at));
        const seconds = Math.max(
          0,
          Math.round((Date.now() - (Number.isNaN(startedAt) ? Date.now() : startedAt)) / 1000),
        );
        let line = own.progress.get(row.id);
        if (!line) {
          const due = lineDueAt(row);
          if (due === null || due > Date.now()) continue;
          let finished: () => void = () => {};
          const totals = new Promise<void>((resolve) => {
            finished = () => resolve();
          });
          line = {
            platformId: null,
            // The counts a person watches only ever go up, whatever order two
            // reads of one sheet come back in.
            actions: Number(said.actions ?? 0),
            lastAction: String(said.last_action ?? ""),
            startedAt: Number.isNaN(startedAt) ? Date.now() : startedAt,
            totals,
            finished,
          };
          own.progress.set(row.id, line);
          try {
            const made = await options.platform.post({
              chat: agent.chat,
              text: progressLine(language, {
                lastAction: line.lastAction,
                actions: line.actions,
                seconds,
              }),
            });
            line.platformId = made.id;
            // Written down before anything else can happen to this door, so a
            // door started again mid-turn edits this message rather than
            // posting a second one beside it.
            if (made.id !== null) {
              await putRow(store, PROGRESS_SHEET, row.id, {
                post_id: made.id,
                chat: agent.chat,
                agent: agent.id,
                started_at: new Date(line.startedAt).toISOString(),
              });
            }
          } catch {
            // Nothing else waits on the line, and the reply still goes.
          }
          continue;
        }
        line.actions = Math.max(line.actions, Number(said.actions ?? 0));
        if (String(said.last_action ?? "") !== "") line.lastAction = String(said.last_action);
        if (line.platformId === null) continue;
        try {
          await options.platform.edit({
            chat: agent.chat,
            id: line.platformId,
            text: progressLine(language, {
              lastAction: line.lastAction,
              actions: line.actions,
              seconds,
            }),
          });
        } catch {
          // An edit the platform refused. The totals edit is the one that has
          // to land, and it is tried on its own.
        }
      }
    };

    /** The last edit of all: L6's "ending with the totals". */
    const finishProgress = async (): Promise<void> => {
      const still = new Set(open.map((row) => row.id));
      for (const [id, line] of [...own.progress.entries()]) {
        if (still.has(id)) continue;
        own.progress.delete(id);
        const seconds = Math.max(0, Math.round((Date.now() - line.startedAt) / 1000));
        if (line.platformId !== null) {
          try {
            await options.platform.edit({
              chat: agent.chat,
              id: line.platformId,
              text: progressTotals(language, { actions: line.actions, seconds }),
            });
          } catch {
            // Said as loudly as the platform allows, and the reply follows.
          }
        }
        // The turn is over, so the row is gone: a thing that is gone leaves no
        // line behind (L17), and the next door has nothing stale to inherit.
        await removeRow(store, PROGRESS_SHEET, id).catch(() => {});
        line.finished();
      }
    };

    const waiter = await openTurnWaiter(store, { person: agent.person });
    try {
      // ONE read at connect, which is where a restarted door picks up every
      // turn that opened while it was down and re-arms every clock it owed,
      // and one read of what the door before it had already said.
      try {
        open = await readOpenTurns(store, { agent: agent.id });
        for (const key of await readSpokenClocks(store, { agent: agent.id })) {
          spoken.add(key);
          spokenAt.set(key, Date.now());
        }
        // The progress lines a door before this one posted. One that belongs to
        // a turn still open is INHERITED, and one whose turn has ended is swept:
        // the door that posted it died before it could edit its totals, so
        // nobody will, and the row would otherwise stand for ever.
        for (const row of (await readSheet(store, PROGRESS_SHEET)) as unknown as {
          id: string;
          data: ProgressOnDisk;
        }[]) {
          if (String(row.data.agent) !== agent.id) continue;
          const still = open.find((one) => one.id === row.id);
          if (!still) {
            await removeRow(store, PROGRESS_SHEET, row.id).catch(() => {});
            continue;
          }
          let finished: () => void = () => {};
          const totals = new Promise<void>((resolve) => {
            finished = () => resolve();
          });
          const startedAt = Date.parse(String(row.data.started_at));
          own.progress.set(row.id, {
            platformId: String(row.data.post_id),
            actions: 0,
            lastAction: "",
            startedAt: Number.isNaN(startedAt) ? Date.now() : startedAt,
            totals,
            finished,
          });
        }
      } finally {
        own.attended();
      }
      retune();

      while (!stopping && !own.leaving) {
        // Rows this door wrote down since the last pass. In memory, so a
        // message that nobody has claimed still has its acked clock armed.
        if (own.arrivals.length > 0) {
          const here = new Set(open.map((row) => row.id));
          for (const row of own.arrivals.splice(0)) {
            if (!here.has(row.id)) open.push(row);
          }
          retune();
        }
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
          open = await readOpenTurns(store, { agent: agent.id });
          const rows = (await readSheet(store, TURN_PROGRESS_SHEET)) as unknown as {
            id: string;
            data: ProgressRow;
          }[];
          sheet = new Map<string, ProgressRow>();
          for (const row of rows) sheet.set(row.id, row.data);
          retune();
          await carryProgress(sheet);
          await finishProgress();
          continue;
        }

        // The bound ran out. It says nothing on its own: reading the table on
        // it would be the timer the store exists to avoid. What it may do is
        // act on a deadline this door already holds, and the first of those is
        // the progress line, which costs the store nothing at all.
        await carryProgress(sheet);

        // A clock that is really due is the one recorded deadline a wake is
        // allowed on.
        const ripe = clocksOf(open).filter((clock) => clock.at <= Date.now());
        if (ripe.length === 0) continue;
        open = await readOpenTurns(store, { agent: agent.id });
        const here = new Map(open.map((row) => [row.id, row]));
        for (const clock of clocksOf(open)) {
          if (clock.at > Date.now()) continue;
          const row = here.get(clock.row.id);
          if (!row) continue;
          await sayExpired(row, clock.stamp);
        }
        retune();
      }
    } finally {
      if (typing !== null) clearInterval(typing);
      for (const line of own.progress.values()) line.finished();
      own.progress.clear();
      await waiter.close();
    }
  };

  const attend = async (agent: AgentEntry, own: Served): Promise<void> => {
    // REVIEW S7. `runDoor` waits on `attending` before it hands its caller a
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

  const served = new Map<string, Served>();

  const serve = (agent: AgentEntry): void => {
    let release: () => void = () => {};
    const left = new Promise<"stopped">((resolve) => {
      release = () => resolve("stopped");
    });
    let attended: () => void = () => {};
    const attending = new Promise<void>((resolve) => {
      attended = () => resolve();
    });
    const it: Served = {
      leaving: false,
      left,
      release,
      done: Promise.resolve(),
      attending,
      attended,
      progress: new Map<string, ProgressLine>(),
      arrivals: [],
      arrived: nudge(),
    };
    served.set(agent.id, it);
    it.done = Promise.allSettled([
      read(agent, it),
      post(agent, it),
      attend(agent, it),
    ]).then(() => {});
  };

  const drop = async (id: string): Promise<void> => {
    const it = served.get(id);
    if (!it) return;
    served.delete(id);
    it.leaving = true;
    it.release();
    await it.done.catch(() => {});
  };

  for (const agent of agentsFor(registry, { door: options.door })) serve(agent);
  // Ready means ATTENDING, so a caller handed this door is handed one whose
  // clocks are armed and whose connect read has landed. Without it the read
  // rides into whatever window the caller opens next, which is what
  // test/door-clock.test.ts's restart budget counts (BUILD-NOTES 12).
  await Promise.all([...served.values()].map((it) => it.attending));

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
        const wanted = agentsFor(fresh, { door: options.door });
        for (const agent of wanted) if (!served.has(agent.id)) serve(agent);
        for (const id of [...served.keys()]) {
          if (!wanted.some((agent) => agent.id === id)) await drop(id);
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
      await Promise.allSettled([...served.values()].map((it) => it.done));
      await store.close();
    },
  };
}
