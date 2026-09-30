import { safeValue } from "../door/lines.ts";
import type { Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { UNRESOLVED, noteExecution, readExecution } from "../store/conversations.ts";
import { listenForWork, type Listener } from "../store/listen.ts";
import { endAttempt, evidenceFromRecord, settleStored, type Here } from "./execution.ts";

/**
 * The runner's end of a stop request (`hub_stop_request`): it is asked, by a row,
 * to stop ONE attempt that it owns, and it does that with the same stop it has
 * always had (`stopExecution`) and the same proof it has always required.
 *
 * WHEN IT LOOKS. Once at start, before anything else is asked of it, on every
 * notification the store sends this runner when a request commits, and once after a
 * lost listener is opened again. Beyond that it looks again only while a request is
 * OWED a look (below), which the runner's tick asks for. Nothing here is a timer: a
 * runner with no request and nothing owed issues no statement, however long it waits.
 *
 * WHAT IT WILL STOP. The attempt the request FROZE, by its id, and nothing else. A
 * live session is asked only when the attempt it is running is that very one and the
 * stop was accepted for it (see `stopExecution` in `run.ts`); if it is running
 * another (a newer attempt of the same conversation, after a restart or a retry), the
 * request does not touch it and is settled from what the frozen attempt is. The
 * intent is already in the store, and the attempt is moved to `stop_requested`
 * before any signal is sent, so a crash between them is a stop that was asked for and
 * is reconciled as one.
 *
 * WHAT DEFERS. Only an attempt that is being OPENED: claimed, not yet fed, so its
 * loop has not yet got a session to be stopped and a resident session that is still
 * there belongs to something else; or one this process holds that the stop's own
 * write met claimed and the loop fed before the read that followed (it has moved on
 * from claimed and is not yet stopped). Both are looked for again a few times and
 * then left owed. Nothing else waits for anything: an attempt that is no longer held
 * by a loop here is ended from what is recorded, at once.
 *
 * WHAT IT WILL SAY. The request says what the attempt says (a trigger carries it),
 * so this file never writes "stopped". An attempt that is not being run by a loop
 * of this process (an earlier incarnation's, one of an agent this runner is not
 * serving, or one of this incarnation that is `unknown` or `stop_requested` and has
 * no loop holding it any more) is not signalled at all: nobody here holds its
 * process, and a recorded pid is not proof of which process it is now. It is judged
 * from the process table as an interrupted attempt is, with the stop recorded as
 * asked, so it is `stopped` only on proof and otherwise stays `stop_unknown`,
 * blocking its agent, until that proves it gone. A stop that lands after the model
 * finished leaves the result: a journaled answer is settled, not interrupted.
 *
 * WHAT IS OWED. A request whose look was deferred, failed (a read, a write, the
 * stop itself) or was not finished, is owed another look, and the runner is told by
 * `owed`. The debt carries a mark: a look lowers it only when it began after the last
 * time it was raised, found every request open with a consumer of its own (none was
 * skipped because another consumer still held it), and every consumer finished. A
 * debt raised while a look is in progress therefore survives it. This is recovery of
 * known debt on the runner's own tick, and it reads nothing while nothing is owed.
 *
 * A long stop is awaited here, in this consumer, never inside a database
 * transaction and never in whatever asked for it: the request returned when it was
 * made.
 */
export const STOP_CHANNEL = "hub_stop";

/** What a consumed request moved that the runner's own watches have to be told about. */
export type StopMoved = "unresolved" | "hold" | "journal";

export interface StopWatch {
  /** A request is owed another look: raised by a deferral or a failure, lowered only by a complete look that found nothing left. */
  readonly owed: boolean;
  /** Read the requests now, without waiting for the consumers. The runner's tick calls it only while `owed`. */
  retry(): void;
  close(): Promise<void>;
}

interface OpenRequest { id: string; execution_id: string; agent: string }

export async function watchStops(
  store: StoreLike,
  at: {
    runner: string;
    incarnation: string;
    here: Here;
    registry(): Registry;
    /**
     * The runner's own stop of an attempt of an agent it serves. The state is
     *   `none`     this process is not running that attempt: the request is judged from the store;
     *   `opening`  it is running it and the attempt is passing from claimed to fed (still claimed, or fed
     *              between the stop's write and its read): nothing was signalled and nothing was
     *              consumed, so the request is looked at again;
     *   anything else the attempt's own state after the stop, which is the request's answer.
     */
    stop(request: { agent: string; execution: string }): Promise<{ state: string; revision: number | null }>;
    moved(what: StopMoved): void;
    /** How many times an attempt that is being opened is looked for again before the request is left owed. */
    retries?: number;
    retryMs?: number;
  },
): Promise<StopWatch> {
  let closed = false;
  let listener: Listener | undefined;
  let work = Promise.resolve();
  const open = new Set<string>();
  const deferred = new Set<string>();
  const running = new Set<Promise<void>>();
  /** One consumer per attempt, so two requests about one attempt do not stop it twice at once. */
  const byAttempt = new Map<string, Promise<void>>();

  let owed = false;
  let mark = 0;
  /** Something is owed a look: also moves the mark, so a look that began before it cannot lower the debt. */
  const owe = (): void => { owed = true; mark += 1; };
  /** The most recent complete read of the requests: where the mark stood when it began, and whether it left none behind. */
  let read = { mark: -1, whole: false };
  const lowerIfDone = (): void => {
    if (owed && open.size === 0 && read.whole && read.mark === mark) owed = false;
  };

  const known = (): Registry | null => { try { return at.registry(); } catch { return null; } };
  const say = (error: Error): void => { process.stderr.write(safeValue(error.message) + "\n"); };

  /** Whether the request is done with (its attempt has an answer) and does not need another look. */
  const attempt = async (request: OpenRequest): Promise<"done" | "again"> => {
    const done = await at.stop({ agent: request.agent, execution: request.execution_id });
    // Being opened is not handled: the loop is still handing it to its session, so nothing was stopped, and it is not reported as consumed.
    if (done.state === "opening") return "again";
    if (done.state !== "none") return "done";
    const ex = await readExecution(store, request.execution_id);
    if (!ex) return "done";
    if (!(UNRESOLVED as readonly string[]).includes(ex.state)) {
      // The attempt ended by its own road (a result settled, an interruption, a stop of another request): the request only catches up.
      await store.sql`select hub_stop_settle(${request.id})`;
      return "done";
    }
    // Owned by THIS incarnation, claimed and not held by a loop here yet: the instant between the store opening it and the loop holding it.
    if (ex.state === "claimed" && ex.incarnation === at.incarnation) return "again";
    if (ex.state === "stop_unknown") {
      // Asked already and not shown gone: the runner's own look at unresolved attempts moves it on proof, and only on proof.
      at.moved("unresolved");
      return "done";
    }
    // Nothing here holds a process for it: an earlier incarnation's, an agent this runner is not serving, or one of this
    // incarnation that ended unresolved (`unknown`, `stop_requested`) or is being closed by a loop that has let go of it.
    // No signal can be sent to a process nobody here holds and a recorded pid is not proof of which process it is, so it is
    // ended as asked from what is recorded: the journal first, and stopped only if that shows every process gone.
    const ended = await endAttempt(store, { execution: ex.id, evidence: evidenceFromRecord(ex, at.here), cause: "stop requested", requested: true, registry: known() });
    if (ended.state === "stop_unknown" || ended.state === "unknown") at.moved("unresolved");
    if (ended.revision !== null) at.moved("hold");
    if (ended.state === "journaled") {
      at.moved("journal");
      await settleStored(store, { runner: at.runner, only: ex.id });
    }
    return "done";
  };

  const consume = async (request: OpenRequest): Promise<void> => {
    const retries = at.retries ?? 5;
    for (let tried = 0; ; tried += 1) {
      if ((await attempt(request)) === "done") return;
      if (tried >= retries || closed) {
        // Left owed BEFORE it is written down, so a failed note does not lose the debt.
        owe();
        // Said once per request however many times the debt is looked at again.
        if (!deferred.has(request.id)) {
          deferred.add(request.id);
          await noteExecution(store, request.execution_id, "stop.deferred", { request: request.id });
        }
        return;
      }
      await Bun.sleep(at.retryMs ?? 200);
    }
  };

  const drain = async (): Promise<void> => {
    const began = mark;
    const rows = (await store.sql`select id, execution_id, agent from stop_request
      where runner = ${at.runner} and state in ('requested', 'stopping') order by created_at, id`) as unknown as OpenRequest[];
    let whole = true;
    for (const request of rows) {
      // Held by a consumer that has not finished: this look cannot say how it will end.
      if (open.has(request.id)) { whole = false; continue; }
      open.add(request.id);
      const before = byAttempt.get(request.execution_id) ?? Promise.resolve();
      const one: Promise<void> = before.then(() => (closed ? undefined : consume(request)))
        .catch((error: Error) => { say(error); owe(); })
        .finally(() => {
          open.delete(request.id);
          running.delete(one);
          if (byAttempt.get(request.execution_id) === one) byAttempt.delete(request.execution_id);
          lowerIfDone();
        });
      byAttempt.set(request.execution_id, one);
      running.add(one);
    }
    read = { mark: began, whole };
    lowerIfDone();
  };

  const wake = () => {
    if (closed) return;
    work = work.then(() => (closed ? undefined : drain())).catch((error: Error) => { say(error); owe(); });
  };
  const connect = async () => {
    listener = await listenForWork({ url: store.url, channel: STOP_CHANNEL, onNotify: payload => { if (payload === at.runner) wake(); },
      onLost() { if (!closed) void reconnect(); } });
    // What was asked while nothing was listening is read now, once.
    wake();
  };
  const reconnect = async () => {
    while (!closed) {
      try { await connect(); return; } catch { await Bun.sleep(1000); }
    }
  };
  await connect();
  await work;
  return {
    get owed() { return owed; },
    retry: wake,
    async close() {
      closed = true;
      await listener?.close();
      await work;
      await Promise.allSettled([...running]);
    },
  };
}
