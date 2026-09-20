import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSetting } from "../registry/load.ts";
import { storeUrlAs } from "./connect.ts";

/**
 * The hub's own secrets: one password per store role, each in its own file.
 *
 * An agent's box shares the machine's network, so its shell reaches
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

/** A role's password, or null when this machine has no file for it. */
export function readPassword(registry: unknown, role: string): string | null {
  const dir = secretsDirOf(registry);
  if (dir === null) return null;
  let text: string;
  try {
    text = readFileSync(passwordFileOf(dir, role), "utf8");
  } catch (error) {
    // No file is a store that trusts this machine's loopback, which the tests'
    // throwaway clusters do. Any other failure is a file that is there and
    // cannot be read, and that is said rather than swallowed.
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  const password = text.trim();
  return password === "" ? null : password;
}

/**
 * The store a hub process opens, as its own role and with its own password.
 *
 * The password goes into the url and nowhere else: not argv, not the
 * environment, both of which another process of the same account can read.
 */
export function storeUrlFor(registry: unknown, role: string, applicationName?: string): string {
  const url = storeUrlAs(String(readSetting(registry, "hub.store_url")), role, applicationName);
  const password = readPassword(registry, role);
  if (password === null) return url;
  const where = new URL(url);
  where.password = encodeURIComponent(password);
  return where.toString();
}
