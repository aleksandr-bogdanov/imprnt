import { kleinanzeigen } from "./kleinanzeigen.ts";
import { mydealz } from "./mydealz.ts";
import { vstdeals } from "./vstdeals.ts";
import type { Source } from "./html.ts";

export type { Fetch, FetchContext, Fetched, Source } from "./html.ts";

/** The hunt sources by name, which is the string a `[[run]]` entry's `source` carries. */
export const HUNT_SOURCES: Record<string, Source> = { kleinanzeigen, mydealz, vstdeals };

export function sourceFor(name: string): Source | null {
  return Object.hasOwn(HUNT_SOURCES, name) ? HUNT_SOURCES[name] : null;
}
