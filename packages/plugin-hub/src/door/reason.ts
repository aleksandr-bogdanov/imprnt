import { lifetimeFor } from "../registry/entries.ts";
import type { ChatAgent } from "../registry/load.ts";
import { credentialOfPreset } from "../registry/presets.ts";
import type { OutageRow } from "../runner/outage.ts";
import type { AgentWait } from "../runner/waiting.ts";
import type { OpenTurnRow, WaitSidecar } from "../store/turns.ts";
import { type WaitReason } from "./lines.ts";

/**
 * Everything a reason can be read off, for one expired clock.
 *
 * The runner writes down only what lives in its own memory (`wait`). The rest
 * is already in the store or the registry: the agent's retry after a failed
 * turn, the household's outage on this agent's credential, the sleeping flag
 * on the agent's entry, and whether the runner is connected at all.
 */
export interface WaitFacts {
  row: OpenTurnRow;
  stamp: string;
  /** This agent's open rows, the one above included. */
  open: OpenTurnRow[];
  wait: AgentWait | null;
  health: { status?: string; cause?: string; retry_at?: string } | null;
  outage: OutageRow | null;
  sleeping: boolean;
  runner: string;
  runnerLive: boolean;
  now: number;
}

export interface WaitVerdict {
  kind: WaitReason;
  values: Record<string, string | number>;
}

/** A date a person reads, to the minute, in UTC. */
function minute(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : iso;
}

/**
 * Why this row is waiting, from the closed list, pure.
 *
 * The order is the order a person would want the causes ruled out in: a
 * switched-off agent or a dead runner explains everything after it, an outage
 * on the credential explains a refused turn, the runner's own recorded wait
 * explains a slot or a cold start, and only then is a claimed row "the model
 * is working" or an unclaimed one "waiting behind your previous message".
 * What matches nothing is `unknown` with the raw state, so it is visible.
 */
export function waitReason(f: WaitFacts): WaitVerdict {
  const wait: AgentWait | null = f.wait;
  if (f.sleeping) return { kind: "off", values: {} };
  if (!f.runnerLive) return { kind: "runner-down", values: { runner: f.runner } };
  if (f.outage?.cause === "login") return { kind: "login", values: {} };
  if (f.outage?.cause === "window") return { kind: "window", values: { date: minute(f.outage.retry_at) } };
  const retryAt = f.health?.retry_at ? Date.parse(f.health.retry_at) : Number.NaN;
  if (f.health?.status === "retry" && Number.isFinite(retryAt) && retryAt > f.now) {
    return { kind: "retry", values: { cause: f.health.cause ?? "unknown", seconds: Math.max(1, Math.ceil((retryAt - f.now) / 1000)) } };
  }
  if (wait?.kind === "slots") return { kind: "slots", values: { count: wait.count, holders: wait.holders.join(", ") || "nobody" } };
  if (wait?.kind === "starting") return { kind: "starting", values: {} };
  if (wait?.kind === "harvest") return { kind: "harvest", values: {} };
  if (f.row.claimed_by !== null && (f.row.state === "acked" || f.row.state === "started")) return { kind: "working", values: {} };
  const received = new Date(f.row.received_at).getTime();
  const previous = f.open.some(other => other.id !== f.row.id && other.claimed_by !== null &&
    (other.state === "acked" || other.state === "started") && new Date(other.received_at).getTime() <= received);
  if (previous) return { kind: "previous", values: {} };
  const raw = wait === null ? "" : `/${(wait as { kind: string }).kind}`;
  return { kind: "unknown", values: { state: `${f.row.state}/${f.row.claimed_by ?? "unclaimed"}${raw}` } };
}

/** Which credential this agent's outage is keyed by, or null when the file cannot say. */
export function credentialKeyOf(registry: unknown, agent: Pick<ChatAgent, "preset">): string | null {
  try { return credentialOfPreset(registry, agent.preset); } catch { return null; }
}

/**
 * The facts for one expired clock, assembled from the sidecar the expiry's
 * own read carried and from the registry. Pure: nothing here reads the store.
 */
export function waitFacts(sidecar: WaitSidecar, input: {
  registry: unknown;
  agent: ChatAgent;
  row: OpenTurnRow;
  stamp: string;
  open: OpenTurnRow[];
  now?: number;
}): WaitFacts {
  const { registry, agent } = input;
  let sleeping = false;
  try { sleeping = lifetimeFor(registry, agent.id).sleeping; } catch { /* an agent the file no longer names is not asleep */ }
  // A row that names no kind this list knows is no wait at all, so a runner
  // ahead of or behind this door cannot make every reason "unknown".
  const noted = sidecar.wait;
  const wait = noted && ["slots", "starting", "harvest"].includes(String(noted.kind)) ? (noted as unknown as AgentWait) : null;
  return {
    row: input.row,
    stamp: input.stamp,
    open: input.open,
    wait,
    health: sidecar.health as WaitFacts["health"],
    outage: sidecar.outage as unknown as OutageRow | null,
    sleeping,
    runner: agent.runner,
    runnerLive: sidecar.runnerLive,
    now: input.now ?? Date.now(),
  };
}
