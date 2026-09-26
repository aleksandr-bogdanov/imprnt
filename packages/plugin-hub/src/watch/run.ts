import type { Registry, RunEntry } from "../registry/load.ts";
import { WatchRefused } from "./record.ts";
import { runSentryWatch, type SentryWatchOptions, type SentryWatchResult } from "./sentry.ts";

export { WatchRefused } from "./record.ts";

/**
 * One sweep of one watch entry, by its source.
 *
 * The loader refuses a source outside `WATCH_SOURCES`, so reaching the throw
 * below means a caller built an entry the registry never carried.
 */
export async function runWatch(entry: RunEntry, registry: Registry, options: SentryWatchOptions = {}): Promise<SentryWatchResult> {
  if (entry.kind === "watch" && entry.source === "sentry") return await runSentryWatch(entry, registry, options);
  throw new WatchRefused("source", "invalid configuration", `${String(entry.source)} is not a source this hub reads`);
}
