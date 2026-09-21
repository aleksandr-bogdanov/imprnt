import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { listRepositories, zoneFor } from "../registry/entries.ts";
import type { RepositoryEntry } from "../registry/load.ts";

/**
 * Provisioning the household's shared zone: one checkout of one shared remote
 * inside every person's own vault.
 *
 * IT IS A STAGE SOMEBODY RUNS, once and after a new person, and never a tick.
 * A clone reaches a remote over the network, and the hub's reconcile loop is
 * what this household's timing is measured around, so nothing here is reachable
 * from that loop.
 *
 * IT INVENTS NO PATH AND REACHES NOTHING THE FILE DID NOT NAME. Every path
 * comes off a repository the registry marked as the zone's, and the loader has
 * already refused a marked entry whose path is not the one the mount implies or
 * whose remote is not the zone's. What is left for this stage is the question
 * the file cannot answer: what is actually on this disk.
 *
 * IT NEVER TOUCHES WHAT IT DID NOT MAKE. A path holding a checkout of some
 * other repository, or holding files somebody put there by hand, is reported
 * and left exactly as it is. Deleting it would be the one irreversible thing a
 * provisioning stage could do, and `check` goes on saying so every time it runs.
 */

/** One checkout this stage made or found in order. */
export interface ZoneCheckout {
  person: string;
  /** The declared repository id, which is what a refusal names. */
  id: string;
  path: string;
}

/** One checkout this stage would not touch, and the plain reason why. */
export interface ZoneRefused extends ZoneCheckout {
  /** `remote-mismatch` · `branch-mismatch` · `not-a-repository`. */
  cause: string;
  /** What is actually there, so a person can see the difference at a glance. */
  found: string;
}

export interface ZoneInstallResult {
  /** False when the household declares no `[zone]` table, which is not an error. */
  declared: boolean;
  mount: string | null;
  cloned: ZoneCheckout[];
  verified: ZoneCheckout[];
  refused: ZoneRefused[];
}

interface GitAnswer {
  ok: boolean;
  out: string;
}

/**
 * Git as a child, with the prompt turned off.
 *
 * A clone that asks for a password with nobody there waits for ever, and a
 * provisioning stage that can hang is a stage an operator stops trusting. Every
 * other variable is inherited, because git is a normal program and needs a
 * normal environment to find its own configuration.
 */
function git(args: string[], cwd?: string): GitAnswer {
  const done = Bun.spawnSync(["git", ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: done.exitCode === 0, out: (done.stdout?.toString() ?? "").trim() };
}

/**
 * Whether this path is somewhere a clone may land.
 *
 * An absent path and an EMPTY directory both are: git itself clones into an
 * empty directory, and a directory left behind by a run that died is the common
 * way one appears. Anything with a file in it is not.
 */
function clonable(path: string): boolean {
  if (!existsSync(path)) return true;
  try {
    return statSync(path).isDirectory() && readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

function look(one: RepositoryEntry, zone: { remote: string; url: string }): ZoneRefused | null {
  if (!existsSync(join(one.path, ".git"))) {
    return { person: one.person, id: one.id, path: one.path, cause: "not-a-repository", found: "no checkout at this path" };
  }
  // A path INSIDE another repository answers that repository's questions, so
  // the top level is compared rather than trusted.
  const top = git(["-C", one.path, "rev-parse", "--show-toplevel"]);
  if (!top.ok || realpathSync(top.out) !== realpathSync(one.path)) {
    return { person: one.person, id: one.id, path: one.path, cause: "not-a-repository", found: top.ok ? `the top of the repository here is ${top.out}` : "git cannot read this path as a repository" };
  }
  const url = git(["-C", one.path, "remote", "get-url", one.remote]);
  if (!url.ok || url.out !== zone.url) {
    return { person: one.person, id: one.id, path: one.path, cause: "remote-mismatch", found: url.ok ? url.out : `no remote called ${one.remote}` };
  }
  const branch = git(["-C", one.path, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch.ok || branch.out !== one.branch) {
    return { person: one.person, id: one.id, path: one.path, cause: "branch-mismatch", found: branch.ok ? branch.out : "a detached HEAD" };
  }
  return null;
}

export function installZone(registry: unknown): ZoneInstallResult {
  const zone = zoneFor(registry);
  const result: ZoneInstallResult = {
    declared: zone !== null,
    mount: zone?.mount ?? null,
    cloned: [],
    verified: [],
    refused: [],
  };
  if (zone === null) return result;

  for (const one of listRepositories(registry).filter((entry) => entry.zone === true)) {
    const where: ZoneCheckout = { person: one.person, id: one.id, path: one.path };
    if (clonable(one.path)) {
      const done = git(["clone", "--branch", one.branch, "--origin", one.remote, "--", zone.url, one.path]);
      if (done.ok) result.cloned.push(where);
      else result.refused.push({ ...where, cause: "clone-failed", found: `git could not clone ${zone.url} onto ${one.branch}` });
      continue;
    }
    const wrong = look(one, zone);
    if (wrong) result.refused.push(wrong);
    else result.verified.push(where);
  }
  return result;
}
