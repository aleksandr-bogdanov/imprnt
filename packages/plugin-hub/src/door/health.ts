import { recordOperationFailure as recordFailure } from "../diagnostics.ts";
import { appendEntry } from "../records/diary.ts";
import { putRow, readSheet } from "../records/statesheet.ts";
import { agentsFor, languageOf } from "../registry/entries.ts";
import type { AgentEntry, Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { chatUnreadable, deliveryFailed, deliveryUncertain, type Language } from "./lines.ts";
import { classifyPlatformError, prepareReply, type PlatformFailure } from "./reply.ts";

export async function recordOperationFailure(store: StoreLike, operation: string, door: string, chat: string, failure: PlatformFailure, actor: "door" | "hub" = "door"): Promise<void> {
  await recordFailure(store, { operation, target: `${door}/${chat}`, actor,
    error: { code: failure.code, message: [failure.cause, failure.detail].filter(Boolean).join(": ") } });
}

export async function doorHealth(store: StoreLike, door: string) {
  const health = new Map<string, Record<string, unknown>>();
  for (const row of await readSheet(store, "door_health")) if (row.data.door === door) health.set(String(row.data.chat), row.data);
  return {
    health,
    async initialize(agent: AgentEntry) {
      if (health.has(agent.chat)) return;
      const data = { door, chat: agent.chat, status: "unknown", since: new Date().toISOString() };
      health.set(agent.chat, data);
      await putRow(store, "door_health", `${door}/${agent.chat}`, data);
    },
    async failed(chat: string, error: unknown, seconds: number) {
      const failure = classifyPlatformError(error);
      const old = health.get(chat);
      const data = { door, chat, status: "failed", ...failure,
        since: old?.status === "failed" ? old.since : new Date().toISOString(),
        retry_at: new Date(Date.now() + seconds * 1000).toISOString(),
        ...(old?.notice_key ? { notice_key: old.notice_key } : {}) };
      health.set(chat, data);
      await putRow(store, "door_health", `${door}/${chat}`, data);
      await recordOperationFailure(store, "read", door, chat, failure);
    },
    async succeeded(chat: string) {
      const old = health.get(chat);
      if (old?.status === "healthy") return;
      const data = { door, chat, status: "healthy", since: new Date().toISOString(), read_at: new Date().toISOString() };
      health.set(chat, data);
      await putRow(store, "door_health", `${door}/${chat}`, data);
      if (old?.status === "failed") await appendEntry(store, { stream: "operation", subject: `${door}/${chat}`,
        kind: "read-restored", actor: "door", detail: { door, chat } });
    },
  };
}

export async function routeNotice(store: StoreLike, options: {
  registry: Registry; door: string; platform: string; agent: AgentEntry; chat: string;
  health: Map<string, Record<string, unknown>>; key: string; failure: PlatformFailure;
  operation: "read" | "post"; seconds: number;
}): Promise<boolean> {
  const route = agentsFor(options.registry, { door: options.door }).find(agent => agent.person === options.agent.person &&
    agent.chat !== options.chat && options.health.get(agent.chat)?.status === "healthy");
  if (!route) return false;
  const language = languageOf(options.registry, route.person) as Language;
  const render = options.operation === "read" ? chatUnreadable : options.failure.kind === "uncertain" ? deliveryUncertain : deliveryFailed;
  const parts = prepareReply(render(language, { chat: options.chat, cause: options.failure.cause, seconds: options.seconds }), options.platform, language);
  await store.sql.begin(async tx => {
    for (const [index, part] of parts.entries()) await tx`select hub_door_notice(${route.person}, ${route.id}, ${part},
      ${index === 0 ? options.key : `${options.key}:part:${index + 1}`},
      ${{ door: options.door, chat: route.chat }}::jsonb, ${index + 1})`;
  });
  return true;
}
