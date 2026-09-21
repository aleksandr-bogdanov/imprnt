import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listRepositories, runEntriesFor, zoneFor } from "../registry/entries.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * What `check` knows about this household's shared zone, and the four findings
 * it earns.
 *
 * THE LOADER COMPARES DECLARED STRINGS AND THIS COMPARES WHAT IS ON DISK. One
 * registry loads on three machines, so whether a checkout is really there, and
 * really pulls from the zone's remote, is a question only the machine holding
 * it can answer. That is the whole reason this reader exists beside the
 * loader's own refusals.
 *
 * IT READS FILES AND THE REGISTRY AND NOTHING ELSE. No store row, no
 * connection, and the remote comparison is a read of the checkout's own git
 * configuration rather than a git invocation, so `check` stays a command that
 * costs a few file reads however many checkouts a household has.
 */

export interface ZonePersonState {
  person: string;
  /** The declared repository id, which is what a person edits to fix it. */
  id: string;
  path: string;
  exists: boolean;
  /** The url the checkout itself has for the declared remote name, or null. */
  remote: string | null;
  /** Whether this person's `_folders.md` declares the mount under `## Mounts`. */
  mounted: boolean;
  foldersFile: string;
}

export interface ZoneCheckState {
  /** False when the household declares no `[zone]` table. Not an error. */
  declared: boolean;
  mount: string | null;
  /** The url every checkout is meant to have. */
  url: string | null;
  machine: string;
  registryFile: string;
  people: ZonePersonState[];
}

/**
 * The folder names a vault declares under `## Mounts`.
 *
 * A SECTION READER AND NEVER A SUBSTRING SEARCH. The mount's name can appear
 * anywhere in this file, in a heading or in a sentence about what used to live
 * there, and a search would read any of those as a declaration. The rule is the
 * vault's own: the names listed under that heading, comma separated, a markdown
 * bullet accepted, lower case, and an absent section and an empty one both mean
 * nothing is declared.
 */
function mountsIn(text: string): Set<string> {
  const section = /##\s*Mounts\s*\n([\s\S]*?)(?:\n##\s|\s*$)/i.exec(text);
  const out = new Set<string>();
  if (!section) return out;
  for (const raw of section[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(">") || line.startsWith("<!--")) continue;
    for (const token of line.replace(/^[-*]\s+/, "").split(",")) {
      const name = token.trim().normalize("NFC").toLowerCase();
      if (/^[\p{L}\p{N}_-]+$/u.test(name)) out.add(name);
    }
  }
  return out;
}

/**
 * The url a checkout has for one remote name, read out of `.git/config`.
 *
 * Read as a FILE rather than asked of git, for two reasons that both matter
 * here: `check` is a command a person runs often and spawning a child per
 * checkout is a cost it does not need, and this answer has to be the same on a
 * machine where git is not on the path at all.
 */
function configuredRemote(path: string, name: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(path, ".git", "config"), "utf8");
  } catch {
    return null;
  }
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]*)\]\s*$/.exec(line);
    if (header) {
      inside = header[1].trim() === `remote "${name}"`;
      continue;
    }
    if (!inside) continue;
    const pair = /^url\s*=\s*(.*)$/.exec(line);
    if (pair) return pair[1].trim();
  }
  return null;
}

export function readZoneState(args: {
  registry: unknown;
  machine: string;
  registryFile: string;
}): ZoneCheckState {
  const zone = zoneFor(args.registry);
  const state: ZoneCheckState = {
    declared: zone !== null,
    mount: zone?.mount ?? null,
    url: zone?.url ?? null,
    machine: args.machine,
    registryFile: args.registryFile,
    people: [],
  };
  if (zone === null) return state;

  // ONLY THE PEOPLE THIS MACHINE SYNCS. A checkout lives on the machine that
  // keeps it in step, so the machine running that person's sync is the one that
  // can see it, and two machines never both report one person.
  const marked = listRepositories(args.registry).filter((one) => one.zone === true);
  const mine = new Set<string>();
  for (const entry of runEntriesFor(args.registry, args.machine)) {
    if (entry.kind !== "sync") continue;
    for (const id of entry.repositories ?? []) {
      const found = marked.find((one) => one.id === id);
      if (found) mine.add(found.id);
    }
  }
  for (const one of marked) {
    if (!mine.has(one.id)) continue;
    // The vault DIRECTORY is `vault/` inside the person's project, which is
    // where the mount sits and where the roles file lives beside it.
    const foldersFile = join(one.path, "..", "_folders.md");
    let mounted = false;
    try {
      mounted = mountsIn(readFileSync(foldersFile, "utf8")).has(zone.mount);
    } catch {
      mounted = false;
    }
    state.people.push({
      person: one.person,
      id: one.id,
      path: one.path,
      exists: existsSync(join(one.path, ".git")),
      remote: configuredRemote(one.path, one.remote),
      mounted,
      foldersFile,
    });
  }
  return state;
}

/** The four findings, PURE: the same state answers the same findings for ever. */
export function zoneFindings(state: ZoneCheckState): Finding[] {
  const findings: Finding[] = [];
  if (!state.declared) {
    findings.push({
      // NO SUBJECT, so the id is this machine's own and a household that has
      // not chosen a zone is told once rather than once per person. Not having
      // chosen is not a broken file, which is why this is the only zone finding
      // such a household earns.
      id: findingId(state.machine, "zone-undeclared"),
      kind: "zone-undeclared",
      subject: "",
      machine: state.machine,
      says:
        `this household names no shared zone, so there is nowhere to move a note ` +
        `that two people both need and nothing is shared between their vaults`,
      fix:
        `add a [zone] table to ${state.registryFile}, carrying mount = "<a folder ` +
        `name>", remote = "<the git remote name>" and url = "<what a clone reads>", ` +
        `then one [[repositories]] entry per person marked zone = true`,
    });
    return findings;
  }

  for (const one of state.people) {
    if (!one.exists) {
      findings.push({
        id: findingId(state.machine, "zone-missing", one.person),
        kind: "zone-missing",
        subject: one.person,
        machine: state.machine,
        says:
          `${one.person} has no checkout of the shared zone at ${one.path}, so nothing ` +
          `they share reaches the rest of the household and nothing the household ` +
          `shares reaches them`,
        fix: `imprnt hub install ${state.registryFile} zone`,
      });
    } else if (one.remote !== state.url) {
      findings.push({
        id: findingId(state.machine, "zone-remote-mismatch", one.person),
        kind: "zone-remote-mismatch",
        subject: one.person,
        machine: state.machine,
        says:
          `${one.person}'s checkout at ${one.path} pulls from ` +
          `${one.remote ?? "no remote of that name"}, and the shared zone is ` +
          `${state.url}, so their notes go somewhere nobody else reads`,
        fix:
          `point ${one.path} at ${state.url} with git remote set-url, or move that ` +
          `directory aside and run imprnt hub install ${state.registryFile} zone`,
      });
    }
    if (!one.mounted) {
      findings.push({
        id: findingId(state.machine, "zone-unmounted", one.person),
        kind: "zone-unmounted",
        subject: one.person,
        machine: state.machine,
        says:
          `${one.person}'s vault does not declare ${state.mount} as a mount in ` +
          `${one.foldersFile}, so the vault's own tools treat the shared notes as ` +
          `ordinary folders of theirs and refuse to move a note into it`,
        fix:
          `add ${state.mount} under ## Mounts in ${one.foldersFile} and COMMIT it: it ` +
          `is a tracked vault file and the sync refuses a dirty tree and never commits`,
      });
    }
  }
  return findings;
}
