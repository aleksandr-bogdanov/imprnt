import type { UnitFile } from "../os/types.ts";

/**
 * The box, as a spawn sees it. Types only.
 *
 * L7: the boundary is the PERSON. Each agent's process reaches its own person's
 * tree and nothing else. The household's shared zone is a checkout inside that
 * tree, so the grant on the tree is the grant that reaches it, the box carries
 * no path for it, and no agent can reach another person's copy of it.
 */
export interface BoxContext {
  agent: string;
  person: string;
  tree: string;            // this person's vault tree
  sessionDir?: string;
  purpose?: string;
  readPaths?: string[];
  stateRoot?: string;
  otherStateRoots?: string[];
  otherTrees: string[];    // every other declared person's tree
  /**
   * Paths under the read-only host that must be writable: this person's declared
   * repositories, and the launched login's own directory, because the model CLI
   * rotates its token in place there. Everything else on the host is read-only,
   * so a boxed command cannot rewrite the registry, drop a user unit or edit a
   * shell startup file that would later run outside the box.
   */
  writePaths?: string[];
  /**
   * What no agent may read: the hub's secrets directory, every door's token file
   * and every declared credential file. A launch takes out the one model login
   * it runs on and nothing else.
   */
  secretPaths?: string[];
}

export interface BoxedCommand {
  argv: string[];
  /** The generated sandbox profile, on the flavour that has one. */
  profile?: UnitFile;
  tool: "bwrap" | "sandbox-exec";
}
