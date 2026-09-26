import { HUNT_SOURCES, type Registry, type RunEntry } from "../registry/load.ts";
import { runHuntWatch, type HuntWatchOptions, type HuntWatchResult } from "./hunt.ts";
import { WatchRefused } from "./record.ts";
import { runSentryWatch, type SentryWatchOptions, type SentryWatchResult } from "./sentry.ts";

export { WatchRefused } from "./record.ts";

export type WatchOptions = SentryWatchOptions & HuntWatchOptions;
export type WatchResult = SentryWatchResult | HuntWatchResult;

/**
 * One sweep of one watch entry, by its source.
 *
 * The loader refuses a source outside `WATCH_SOURCES`, so reaching the throw
 * below means a caller built an entry the registry never carried.
 */
export async function runWatch(entry: RunEntry, registry: Registry, options: WatchOptions = {}): Promise<WatchResult> {
  if (entry.kind === "watch" && entry.source === "sentry") return await runSentryWatch(entry, registry, options);
  if (entry.kind === "watch" && (HUNT_SOURCES as readonly string[]).includes(String(entry.source))) return await runHuntWatch(entry, registry, options);
  throw new WatchRefused("source", "invalid configuration", `${String(entry.source)} is not a source this hub reads`);
}
