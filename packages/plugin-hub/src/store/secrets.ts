import { join } from "node:path";
import { readSetting } from "../registry/load.ts";

/**
 * The hub's own secrets: one password per store role, each in its own file.
 *
 * IMP-158. An agent's box shares the machine's network, so its shell reaches
 * the store on loopback, and a role that logs in without a password is a role
 * any agent can be, including one steered by outside content it read. So
 * every role has a password, the install generates it and writes it to
 * `<role>.password` in this directory (0700, files 0600), each hub process
 * reads its own role's file when it opens its store, and every box masks the
 * directory.
 */
export const HUB_ROLES = ["hub_door", "hub_runner", "hub_agent", "hub_hub"] as const;

/**
 * Where the passwords live: `hub.secrets_dir` when the registry names one, or
 * `secrets` under `hub.state_dir`, a sibling of every person's own state root
 * and never inside one. Null when the registry names neither.
 */
export function secretsDirOf(registry: unknown): string | null {
  const named = readSetting(registry, "hub.secrets_dir");
  if (typeof named === "string" && named !== "") return named;
  const state = readSetting(registry, "hub.state_dir");
  return typeof state === "string" && state !== "" ? join(state, "secrets") : null;
}

export function passwordFileOf(dir: string, role: string): string {
  return join(dir, `${role}.password`);
}
