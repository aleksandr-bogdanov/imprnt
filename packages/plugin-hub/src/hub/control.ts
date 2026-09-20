import { recoveryDone, recoveryRefused, safeValue, type Language } from "../door/lines.ts";
import { languageOf, listAgents, listRunEntries, senderAllowed } from "../registry/entries.ts";
import { loadRegistry, type Registry } from "../registry/load.ts";
import { appendEntry } from "../records/diary.ts";
import type { StoreLike } from "../store/connect.ts";
import { listenForWork, type Listener } from "../store/listen.ts";
import { appendNotice, type ReplyRoute } from "../store/outbox.ts";

interface RecoveryRequest {
  id: string; source: "cli" | "chat"; actor: string; person?: string;
  sender_id?: string; door?: string; chat?: string; target_kind: string; target_id: string;
  /** The agent whose chat a chat request came in on. */
  agent?: string;
  registryFile?: string; registry?: Registry;
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
  const body = data.status === "applied" ? recoveryDone(language, { target })
    : recoveryRefused(language, { target, cause: data.cause ?? "operation failed" });
  await appendNotice(store, { person, agent, body, noticeKey: `recovery-outcome:${data.id}`, route, platform, language });
}

export async function requestRecovery(store: StoreLike, request: RecoveryRequest) {
  const registry = request.registry ?? loadRegistry(request.registryFile!);
  const agent = listAgents(registry).find(a => a.id === request.target_id);
  const door = listRunEntries(registry).find(e => e.id === request.target_id && e.kind === "door");
  if (request.target_kind === "agent" ? !agent : request.target_kind === "door" ? !door : true) throw new Error("invalid-recovery-target");
  if (request.source !== "cli" && request.source !== "chat") throw new Error("invalid-recovery-source");
  const declaredDoor = (registry.data.run as { id: string; person?: string }[]).find(e => e.id === door?.id);
  const person = agent?.person ?? declaredDoor?.person ?? request.person ?? null;
  if (request.source === "chat" && (request.target_kind !== "agent" || person !== request.person ||
    !senderAllowed(registry, person!, request.door ?? "", request.sender_id ?? "") ||
    !listAgents(registry).some(a => a.person === person && a.door === request.door && a.chat === request.chat))) throw new Error("recovery-not-authorized");
  // A chat request pins where it came from, so its outcome can be said there.
  const asked = request.source === "chat" ? {
    route: { door: request.door!, chat: request.chat! },
    agent: request.agent ?? listAgents(registry).find(a => a.person === person && a.door === request.door && a.chat === request.chat)!.id,
  } : {};
  const data = { id: request.id, actor: request.actor, person, target_kind: request.target_kind,
    target_id: request.target_id, requested_at: new Date().toISOString(), status: "pending", cause: null, ...asked };
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
        kind: "recovery.requested", actor: request.source === "chat" ? "door" : "hub", detail: data });
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
