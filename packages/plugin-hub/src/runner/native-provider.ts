import type { StoreLike } from "../store/connect.ts";
import { credentialFor } from "../registry/entries.ts";
import { credentialOfPreset, type Preset } from "../registry/presets.ts";

/**
 * THE ROUTE A NATIVE SESSION IS SPOKEN TO THE MODEL OVER: who the provider is, what kind of credential pays for it, and
 * where it is sent. Nothing secret is in it: the key file's path and the key are never part of it, and a `model-key`
 * endpoint is already an https origin with no login, query or fragment (`modelBaseUrlRefusal`).
 *
 * A provider label alone is not the route: the same label behind another endpoint, or behind a key where there was a
 * login, hands the session's transcript to somebody else.
 */
export interface NativeRoute {
  provider: string;
  /** The credential kind (`claude-login`, `model-key`), or `none` for a preset that names no credential. */
  credential: string;
  /** The normalized endpoint a `model-key` is sent to, else null. */
  endpoint: string | null;
}

/** Scheme, lowercased host, default port dropped, no trailing slash: two spellings of one endpoint are one route. */
export function normalizeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.trim();
  }
}

/** The route a preset launches on, from the registry the launch itself reads. */
export function routeOf(registry: unknown, presetName: string, preset: Pick<Preset, "provider">): NativeRoute {
  const id = credentialOfPreset(registry, presetName);
  const entry = id === null ? null : credentialFor(registry, id);
  return {
    provider: preset.provider,
    credential: entry?.kind ?? "none",
    endpoint: entry?.kind === "model-key" && entry.base_url ? normalizeEndpoint(entry.base_url) : null,
    // The id and the file are deliberately not part of it: they say which secret, not where it is sent.
  };
}

/** The route as one string, for comparing and for a resident child to remember what it was started on. */
export const routeKey = (route: NativeRoute): string => JSON.stringify([route.provider, route.credential, route.endpoint]);

const sayRoute = (route: NativeRoute): string =>
  `${route.provider} (${route.credential}${route.endpoint ? ` at ${route.endpoint}` : ""})`;

/**
 * THE ROUTE THE CONVERSATION'S NATIVE SESSION WAS LAST GIVEN A MESSAGE OVER, from the store.
 *
 * It is written BEFORE the first launch and the first feed: the route rides in the attempt's `evidence`, in the very
 * statement that opens the attempt (`openExecution`, fenced like the attempt), so an interrupted first turn leaves it too.
 * The newest attempt that reached its feed intent decides: an attempt opened and never fed (a refused spawn, a crash before
 * the feed) put nothing into the session and is not asked.
 *
 * Null is "no recorded route": no attempt of the conversation has one, which is every conversation an earlier build used.
 */
export async function boundRoute(store: StoreLike, conversation: string): Promise<NativeRoute | null> {
  const [seen] = (await store.sql`select x.evidence -> 'route' as route from execution x
    where x.conversation_id = ${conversation} and x.feed_intent_at is not null and x.evidence -> 'route' is not null
    order by x.feed_intent_at desc, x.started_at desc limit 1`) as unknown as { route: NativeRoute | null }[];
  return seen?.route ?? null;
}

/**
 * The provider of the conversation's newest settled turn, from the turn record's `preset_settings`. This is what a
 * conversation of an earlier build has: no route was recorded, but every settled turn named its provider. Null is no
 * settled turn.
 */
export async function lastTurnProvider(store: StoreLike, conversation: string): Promise<string | null> {
  const [seen] = (await store.sql`select e.detail #>> '{preset_settings,provider}' as provider
    from execution x
    join ledger_event e on e.stream = 'turn' and e.kind = 'turn' and e.subject = x.inbound_id
    where x.conversation_id = ${conversation} and x.state = 'completed'
    order by e.seq desc limit 1`) as unknown as { provider: string | null }[];
  return seen?.provider ?? null;
}

/** Why a session is not resumed on the route a preset now has, and what is said to whoever is told. */
export interface RouteRefusal {
  why: "route-changed" | "route-unknown";
  /** What the session is known to have been spoken over, said without a secret; the `unknown` ones say what is not known. */
  said: string;
}

/**
 * A NATIVE SESSION IS THE ENGINE'S OWN RECORD OF A CONVERSATION, and it was written by whichever route answered in it.
 * Resuming it on another route hands that route the first one's transcript without anyone having said so. A respawn that
 * WOULD resume (the engine took a message under the session: `started` or `verified`; anything earlier is replaced by a
 * fresh session and holds nothing) is refused unless the route is the one it was last spoken over:
 *
 *   a recorded route         resumes on the same provider, credential kind and normalized endpoint, and only on those;
 *   no recorded route, but a settled turn (a session an earlier build began)
 *                            resumes on a route that is not a model-key and has the provider that turn ran under. A
 *                            model-key route is newer than every such session, so the session cannot have been on one and
 *                            nothing says it may be given to one now;
 *   neither (a first turn an earlier build left unsettled)
 *                            the same, without the provider test: unknown provenance may continue on a login, as it always
 *                            did, and never onto a model-key.
 *
 * An existing Claude-login session therefore resumes under its login with no question asked, and its next attempt writes
 * the route down. The native state is read here, at the store, and never taken from a caller's earlier read.
 */
export async function routeRefusal(store: StoreLike, conversation: string, now: NativeRoute): Promise<RouteRefusal | null> {
  const [row] = (await store.sql`select native_state from conversation where id = ${conversation}`) as unknown as { native_state: string }[];
  if (row?.native_state !== "started" && row?.native_state !== "verified") return null;
  const was = await boundRoute(store, conversation);
  if (was) {
    return routeKey(was) === routeKey(now) ? null
      : { why: "route-changed", said: `this conversation's native session was last used over ${sayRoute(was)} and the agent is now bound to ${sayRoute(now)}: it is not resumed across routes` };
  }
  const provider = await lastTurnProvider(store, conversation);
  if (now.credential === "model-key") {
    return { why: "route-unknown", said: `this conversation's native session has no recorded route${provider ? ` (its last settled turn ran under provider ${provider})` : ""} and the agent is now bound to ${sayRoute(now)}: it is not resumed onto a model key` };
  }
  return provider === null || provider === now.provider ? null
    : { why: "route-changed", said: `this conversation's native session was last used under provider ${provider} and the agent is now bound to ${sayRoute(now)}: it is not resumed across providers` };
}

/**
 * The same refusal raised from the spawn itself, which is where a child is actually started: the loop asks `routeRefusal`
 * first and refuses the row by name without opening an attempt, and this is the answer for a configuration that moved in
 * between. It is thrown before anything is launched or written, and is a failure before the engine was handed the input.
 */
export class RouteRefused extends Error {
  readonly notDelivered = true as const;
  constructor(readonly refusal: RouteRefusal) {
    super(`route-refused: ${refusal.why}`);
    this.name = "RouteRefused";
  }
}
