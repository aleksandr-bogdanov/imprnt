import { agentAdopted, agentBound, agentRefused, agentRetired, recoveryDone, recoveryRefused, safeValue, type Language } from "../door/lines.ts";
import { languageOf, listAgents, listRunEntries, senderAllowed } from "../registry/entries.ts";
import { wantedState } from "../os/diff.ts";
import { loadRegistry, type Registry } from "../registry/load.ts";
import { appendEntry } from "../records/diary.ts";
import type { StoreLike } from "../store/connect.ts";
import { listenForWork, type Listener } from "../store/listen.ts";
import { prepareReply } from "../door/reply.ts";
import type { ReplyRoute } from "../store/outbox.ts";

/**
 * The entry kinds a restart may name through the `run` target.
 *
 * It is the pieces a person would press restart on, and it is a named constant
 * rather than a literal inside the condition so that widening it is one line.
 * The hub is absent because the hub is what acts on a restart, a board because
 * the board is the asker and its own unit is what would go away, and a door
 * because a door has a target kind of its own and two ways to name one thing is
 * a difference somebody has to explain later.
 *
 * `transcriber` is on the list because a household that transcribes on its own
 * machines declares one and a wedged recognizer is the thing its door asks to
 * have back. A household that names no such recognizer carries no entry of that
 * kind at all, so for it the name matches nothing.
 */
export const RUN_RECOVERY_KINDS = ["runner", "sync", "transcriber"] as const;

/**
 * The entry kinds a `run` target may name, for the front end that is asking.
 *
 * A DOOR REACHES EXACTLY ONE OF THEM: the recognizer beside it, whose failures
 * the hub can classify. The wider set is for a person, at the command line or
 * on the board, and a door asking for a runner back would be a door reaching
 * past what it is allowed to know about. It is one function because the rule is
 * asked twice: once where a request is made, and once by the hub before it acts
 * on a row, since the roles a door and a runner hold may insert one into the
 * store without passing through the first.
 */
export function reachableKinds(source: unknown): readonly string[] {
  return source === "door" ? ["transcriber"] : RUN_RECOVERY_KINDS;
}

/** Whether a request from this source may name this target at all. */
export function mayReach(source: unknown, targetKind: unknown, entryKind: string): boolean {
  // A chat asks for an agent and for nothing a machine carries, and a source
  // this hub has no name for asks for nothing at all.
  if (source !== "cli" && source !== "board" && source !== "door") return false;
  if (targetKind === "door") return source !== "door";
  if (targetKind !== "run") return false;
  return reachableKinds(source).includes(entryKind);
}

interface RecoveryRequest {
  id: string; source: "cli" | "chat" | "door" | "board"; actor: string; person?: string;
  sender_id?: string; door?: string; chat?: string; target_kind: string; target_id: string;
  /** The agent whose chat a chat request came in on. */
  agent?: string;
  /**
   * What a lifecycle row asks for and what it asks it with. Only the two agent
   * verbs carry them, and a recovery row is written without them, so its shape
   * is the one two shipped checks compare whole.
   */
  operation?: string;
  arguments?: Record<string, unknown>;
  registryFile?: string; registry?: Registry;
}

/**
 * Every refusal `requestRecovery` names. A command typed in a chat that meets
 * one of them is answered with a refusal, and never left as an error that
 * stops the door from acknowledging the batch it came in.
 */
export const CONTROL_REFUSALS = ["invalid-recovery-target", "recovery-not-authorized", "recovery-target-stopped",
  "invalid-recovery-source"] as const;

/** The target kinds a control row may name, and there is no fifth. */
const TARGET_KINDS = ["agent", "door", "run", "agent-lifecycle"];

/**
 * A notice asked for by a process that is not the runner.
 *
 * It goes through the security-definer function the door already asks with,
 * because the hub owns no insert on the outbox and never will: the function
 * writes a keyed machinery notice and nothing else, so what the hub can say
 * through it is one sentence per control row and never a reply.
 */
async function sayNotice(store: StoreLike, notice: { person: string; agent: string; body: string;
  noticeKey: string; route: ReplyRoute; platform: string; language: Language }): Promise<void> {
  for (const [index, part] of prepareReply(notice.body, notice.platform, notice.language).entries()) {
    const key = index === 0 ? notice.noticeKey : `${notice.noticeKey}:part:${index + 1}`;
    await store.sql`select hub_door_notice(${notice.person}, ${notice.agent}, ${part}, ${key},
      ${notice.route}::jsonb, ${index + 1})`;
  }
}

/**
 * The outcome of a recovery somebody asked for in a chat, said back
 * in that chat. It is an ordinary machinery notice on the route the request
 * was pinned to, keyed on the request, so a replayed control says it once.
 */
async function announceOutcome(store: StoreLike, registry: Registry, data: Record<string, unknown>): Promise<void> {
  const route = data.route as ReplyRoute | undefined;
  if (!route) return;
  const person = String(data.person);
  const agent = typeof data.agent === "string" ? data.agent : listAgents(registry)
    .find(one => one.person === person && one.door === route.door && one.chat === route.chat)?.id;
  if (!agent) return;
  const language = languageOf(registry, person) as Language;
  const platform = ((registry.data.run ?? []) as { id: string; platform?: string }[])
    .find(entry => entry.id === route.door)?.platform ?? "discord";
  const target = String(data.target_id);
  const lifecycle = data.target_kind === "agent-lifecycle";
  const operation = String(data.operation ?? "recover");
  const named = (data.arguments ?? {}) as Record<string, unknown>;
  const body = !lifecycle
    ? (data.status === "applied" ? recoveryDone(language, { target })
      : recoveryRefused(language, { target, cause: data.cause ?? "operation failed" }))
    : data.status !== "applied"
      ? agentRefused(language, { operation, agent: target, cause: data.cause ?? "operation failed" })
      : operation === "retire" ? agentRetired(language, { agent: target })
        : agentBound(language, { agent: target, name: named.name ?? named.chat });
  await sayNotice(store, { person, agent, body, noticeKey: `recovery-outcome:${data.id}`, route, platform, language });
  // THE ADOPTED CHAT IS TOLD TOO, on the route the resolution produced rather
  // than the one the command came in on. That sentence landing where the new
  // agent now answers is the proof the binding took: a notice that only went
  // back where the command came from proves the command was read.
  if (lifecycle && data.status === "applied" && operation !== "retire" && typeof named.chat === "string") {
    await sayNotice(store, { person, agent: target, body: agentAdopted(language, { agent: target }),
      noticeKey: `agent-adopted:${data.id}`, route: { door: String(data.door ?? route.door), chat: named.chat },
      platform, language });
  }
}

/**
 * The one control verb, which the two agent lifecycle commands and the shipped
 * recovery both ask through.
 *
 * `requestRecovery` is this function under its own name: the row shape, the
 * replay fence, the pinned route, the diary kinds and the two refusal names are
 * all the shipped ones, and a second implementation of a control verb is
 * exactly what this project forbids.
 */
export async function requestControl(store: StoreLike, request: RecoveryRequest) {
  return await requestRecovery(store, request);
}

export async function requestRecovery(store: StoreLike, request: RecoveryRequest) {
  const registry = request.registry ?? loadRegistry(request.registryFile!);
  const agent = listAgents(registry).find(a => a.id === request.target_id);
  const door = listRunEntries(registry).find(e => e.id === request.target_id && e.kind === "door");
  // A `run` target is authorized by the entry's KIND and by nothing else, so
  // the hub, the board and a door named this way all fall out through the one
  // refusal a check can bind by name.
  const reachable = reachableKinds(request.source);
  const piece = listRunEntries(registry).find(e => e.id === request.target_id && reachable.includes(e.kind));
  if (!TARGET_KINDS.includes(request.target_kind)) throw new Error("invalid-recovery-target");
  // A lifecycle row names an agent that may not exist yet, which is what an
  // adopt of a new id is, so the file cannot be asked whether it is there. What
  // may be asked of it is asked by the door, which authorized the sender, and
  // by the hub, which is the only process that writes the file.
  const lifecycle = request.target_kind === "agent-lifecycle";
  if (!lifecycle && (request.target_kind === "agent" ? !agent : request.target_kind === "door" ? !door
    : !piece)) throw new Error("invalid-recovery-target");
  // A PIECE THE FILE SAYS IS DOWN IS NEVER RESTARTED. The manager's restart
  // starts a service it is not running, so this would bring a stopped piece up
  // for as long as it takes the hub's next tick to stop it again, and the
  // household that asked for it to be down would watch it run.
  //
  // Asked of a run or door target only. An agent may carry the same id as an
  // entry the file stopped, and neither restarting an agent nor making one is a
  // restart of that entry.
  const declared = request.target_kind === "run" ? piece : request.target_kind === "door" ? door : undefined;
  if (declared && wantedState(declared) === "stopped") throw new Error("recovery-target-stopped");
  // The board is treated as the operator is, because nobody on a tailnet page
  // is identified and the row records that plainly.
  if (!["cli", "chat", "door", "board"].includes(request.source)) throw new Error("invalid-recovery-source");
  // A door may ask for the recognizer beside it back and for nothing else. It
  // cannot ask for a door, its own included, because a piece that can restart
  // its own supervisor is the failure this fence exists about.
  if (request.source === "door" && request.target_kind !== "run") throw new Error("recovery-not-authorized");
  const declaredDoor = (registry.data.run as { id: string; person?: string }[]).find(e => e.id === door?.id);
  const person = lifecycle ? (request.person ?? null) : agent?.person ?? declaredDoor?.person ?? request.person ?? null;
  if (request.source === "chat" && !lifecycle && (request.target_kind !== "agent" || person !== request.person ||
    !senderAllowed(registry, person!, request.door ?? "", request.sender_id ?? "") ||
    !listAgents(registry).some(a => a.person === person && a.door === request.door && a.chat === request.chat))) throw new Error("recovery-not-authorized");
  // A chat request pins where it came from, so its outcome can be said there.
  const asked = request.source === "chat" ? {
    route: { door: request.door!, chat: request.chat! },
    agent: request.agent ?? listAgents(registry).find(a => a.person === person && a.door === request.door && a.chat === request.chat)!.id,
  } : {};
  // `source` beside `actor`: which front end asked, as well as on whose behalf.
  // The ledger's own actor column stays what the store's insert policy pins it
  // to for the role that writes it, so the honest record of who pressed the
  // button is here.
  const data = { id: request.id, actor: request.actor, source: request.source, person,
    target_kind: request.target_kind, target_id: request.target_id,
    requested_at: new Date().toISOString(), status: "pending", cause: null, ...asked,
    // Only a lifecycle row carries these three, so a recovery row is written
    // with the keys it has always had.
    ...(lifecycle ? { door: request.door, operation: request.operation, arguments: request.arguments ?? {} } : {}) };
  // An active coordinator can confirm completion without polling. Otherwise
  // the durable request remains pending for its next startup.
  let completion: Listener | undefined;
  let complete!: () => void;
  const applied = new Promise<void>(resolve => { complete = resolve; });
  if (request.source === "cli" && door) {
    const [running] = await store.sql`select exists (select 1 from pg_stat_activity
      where datname=current_database() and application_name=${`hub-${door.machine}`}) as present`;
    if (running.present) completion = await listenForWork({ url: store.url, channel: "hub_control_result",
      onNotify(id) { if (id === request.id) complete(); } });
  }
  try {
    const result = await store.sql.begin(async sql => {
      const rows = await sql`insert into state_row (sheet,id,data) values ('control',${request.id},${data})
        on conflict (sheet,id) do nothing returning data`;
      if (!rows.length) return (await sql`select data from state_row where sheet='control' and id=${request.id}`)[0].data;
      await appendEntry({ ...store, sql: sql as unknown as StoreLike["sql"] }, { stream: "control", subject: request.id,
        // The ledger's actor is the ROLE that wrote the line. A door writes the
        // two a door asks for, and everything else reaches this function
        // inside the hub's own process.
        kind: "recovery.requested",
        actor: request.source === "chat" || request.source === "door" ? "door" : "hub", detail: data });
      await sql`select pg_notify('hub_control',${request.id})`;
      return data;
    });
    if (!completion || result.status !== "pending") return result;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([applied, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); }
    finally { clearTimeout(timer); }
    const [standing] = await store.sql`select data from state_row where sheet='control' and id=${request.id}`;
    return standing.data;
  } finally { await completion?.close(); }
}

/** Read before readiness and on notifications only. The row lock fences replay. */
export async function watchControls(store: StoreLike, actor: "hub" | "runner", accepts: (data: Record<string, unknown>) => boolean,
  apply: (data: Record<string, unknown>) => Promise<void>,
  /** Where a chat request's outcome is said: the registry for its language and platform. */
  options: { registry?: () => Registry } = {}) {
  let stopped = false;
  let listener: Listener | undefined;
  let work = Promise.resolve();
  const drain = async () => {
    const rows = await store.sql`select id,data from state_row where sheet='control' and data->>'status'='pending' order by updated_at,id`;
    for (const row of rows) {
      if (!accepts(row.data)) continue;
      // Read before the transaction, so a file caught half written costs the
      // notice and never the recovery.
      let registry: Registry | null = null;
      try { registry = options.registry?.() ?? null; } catch { registry = null; }
      await store.sql.begin(async sql => {
        const [current] = await sql`select data from state_row where sheet='control' and id=${row.id} for update`;
        if (current?.data.status !== "pending" || !accepts(current.data)) return;
        let cause: string | null = null;
        try { await apply(current.data); }
        catch (error) { cause = safeValue((error as Error).message); }
        const data = { ...current.data, status: cause === null ? "applied" : "refused", cause, applied_at: new Date().toISOString() };
        await sql`update state_row set data=${data},updated_at=now() where sheet='control' and id=${row.id}`;
        const inside = { ...store, sql: sql as unknown as StoreLike["sql"] };
        await appendEntry(inside, { stream: "control", subject: row.id,
          kind: cause === null ? "recovery.applied" : "recovery.refused", actor, detail: { request_id: row.id, target: data.target_id, cause } });
        if (registry) await announceOutcome(inside, registry, data);
        await sql`select pg_notify('hub_control_result',${row.id})`;
      });
    }
  };
  const wake = () => { work = work.then(() => stopped ? undefined : drain()).catch(error => { process.stderr.write(safeValue(error.message) + "\n"); }); };
  const connect = async () => {
    listener = await listenForWork({ url: store.url, channel: "hub_control", onNotify: wake,
      onLost() { if (!stopped) void reconnect(); } });
    wake();
  };
  const reconnect = async () => {
    while (!stopped) {
      try { await connect(); return; } catch { await Bun.sleep(1000); }
    }
  };
  await connect();
  await work;
  return { async close() { stopped = true; await listener?.close(); await work; } };
}
