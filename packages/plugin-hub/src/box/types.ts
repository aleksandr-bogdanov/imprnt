import type { UnitFile } from "../os/types.ts";

/**
 * The box, as a spawn sees it. Types only.
 *
 * L7: the boundary is the PERSON. Each agent's process reaches its own person's
 * tree and the one shared zone, and nothing else. The zone is one household
 * setting (D-93), so "a shared zone for a subset of people" has nowhere to be
 * written rather than merely being discouraged.
 */
export interface BoxContext {
  agent: string;
  person: string;
  tree: string;            // this person's vault tree
  sharedZone: string;      // one zone, every person, from hub.shared_zone
  otherTrees: string[];    // every other declared person's tree
  /** Which flavour to build. Defaults to the platform this process is on. */
  platform?: string;
}

export interface BoxedCommand {
  argv: string[];
  /** The generated sandbox profile, on the flavour that has one. */
  profile?: UnitFile;
  tool: "bwrap" | "sandbox-exec";
}
