import { openStore, type Store } from "./connect.ts";
import { readEligible, type EligibleRow } from "./wake.ts";

/**
 * A runner coming up. Connecting is what surfaces the rows that waited while it
 * was down: nothing has to ask, and no notification is involved, because the
 * ones emitted while it was off are gone.
 */
export async function connectRunner(options: {
  url: string;
  agent: string;
}): Promise<{ store: Store; agent: string; eligible: EligibleRow[] }> {
  const store = await openStore({ url: options.url });
  const eligible = await readEligible(store, { agent: options.agent });
  return { store, agent: options.agent, eligible };
}
