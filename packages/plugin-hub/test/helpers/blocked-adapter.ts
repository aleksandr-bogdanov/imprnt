// Test infrastructure. An adapter that declares an `activationBlock`, for the
// runner's blocked-engine path, which no production adapter takes any more:
// OpenCode launches under the own-credential policy now. Every verb throws and
// is counted, so a test can say the runner never asked a blocked engine for
// anything, rather than only that nothing happened.

import type { Adapter } from "../../src/adapters/types.ts";

export const SYNTHETIC_BLOCK = {
  cause: "synthetic-engine-blocked",
  remedy: "Synthetic block for a test: nothing on this machine can run this engine.",
};

export function blockedAdapter(name: string, block: { cause: string; remedy: string } = SYNTHETIC_BLOCK): Adapter & { calls: string[] } {
  const calls: string[] = [];
  const refuse = (verb: string) => async (): Promise<never> => {
    calls.push(verb);
    throw new Error(block.cause);
  };
  return {
    name,
    activationBlock: block,
    calls,
    capabilities: refuse("capabilities"),
    prepareLaunch: refuse("prepareLaunch"),
    start: refuse("start"),
  };
}
