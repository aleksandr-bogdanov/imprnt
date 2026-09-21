// Check: a shared zone for a SUBSET of the household has nowhere to be written.
// (SPEC §1, §6, L14)
//
// SPEC 1 rules "One shared zone mounted into every vault", and its Forbidden
// carries "a shared zone for a subset of people". In a loader that is one
// household-wide rule: once a `[zone]` table is declared, every person who
// declares a `vault` carries exactly one repository marked `zone = true`, or the
// whole file is refused by line naming that person.
//
// WHAT THE REFUSAL COSTS, said plainly because it is the reason the rule is a
// refusal rather than a finding: removing one person's entry turns the file red
// for every process on its next tick, each of which keeps running on its last
// good snapshot, and `check` exits 1 naming the line. That is the outcome this
// household wants. The alternative is one person's zone quietly not being there
// while everything keeps working, and nobody learning until a note that was
// shared cannot be read.
//
// PURE. No Postgres, no operating system, no vault on disk. The registry is a
// file and the loader is a file loader, so every path below is a string the
// loader does arithmetic on and none of them exists.
//
// Which of the six protected windows this could reach: none. Nothing here starts
// a door, a runner or a cluster of agents.
//
// Red reason: behaviour absent. `loadRegistry` has a rule about each marked
// repository it MEETS and no rule about the person who has none, so the first
// assertion finds the file loading.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { writeRegistry, type RegistrySpec, type RepositorySpec } from "./helpers/registry.ts";
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts";

const MOUNT = "shared-notes";
const TREE: Record<string, string> = { p1: "/srv/hub/p1", p2: "/srv/hub/p2", p3: "/srv/hub/p3" };
const VAULT: Record<string, string> = { p1: "/srv/hub/p1", p2: "/srv/hub/p2", p3: "/srv/hub/p3" };
const REMOTE = "origin";
const URL = "file:///srv/zone.git";

/** The path the mount implies for this person, which is what the loader compares. */
function implied(person: string): string {
  return `${VAULT[person]}/vault/${MOUNT}`;
}

function marked(person: string): RepositorySpec {
  return { id: `${person}-zone`, person, path: implied(person), remote: REMOTE, branch: "main", required: true, zone: true };
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-zone-household-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * A household that is COMPLETE: it declares a zone, two people with vaults, and
 * one marked checkout each. Every assertion below either loads this file or
 * breaks it in exactly one named way.
 */
function household(over: Partial<RegistrySpec> = {}): RegistrySpec {
  return {
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: "/srv/hub/state" },
    people: [
      { id: "p1", tree: TREE.p1, vault: VAULT.p1 },
      { id: "p2", tree: TREE.p2, vault: VAULT.p2 },
    ],
    zone: { mount: MOUNT, remote: REMOTE, url: URL },
    repositories: [marked("p1"), marked("p2")],
    ...over,
  };
}

function write(spec: RegistrySpec): string {
  return writeRegistry(dir, spec);
}

/** The refusal this file earns, or a failure saying the loader took it. */
function refusal(spec: RegistrySpec): { file: string; error: RegistryRefused } {
  const file = write(spec);
  try {
    loadRegistry(file);
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryRefused);
    return { file, error: error as RegistryRefused };
  }
  throw new Error("the loader accepted a file it has to refuse");
}

/** The line a key sits on, so "by line" is read off the file and never counted. */
function lineOf(file: string, starts: string): number {
  const at = readFileSync(file, "utf8").split("\n").findIndex((line) => line.trim().startsWith(starts));
  expect(at).toBeGreaterThanOrEqual(0);
  return at + 1;
}

/** The line a key sits on inside the entry that opens with `anchor`. */
function lineWithin(file: string, anchor: string, starts: string): number {
  const rows = readFileSync(file, "utf8").split("\n");
  const from = rows.findIndex((line) => line.trim() === anchor);
  expect(from).toBeGreaterThanOrEqual(0);
  const at = rows.findIndex((line, i) => i > from && line.trim().startsWith(starts));
  expect(at).toBeGreaterThan(from);
  return at + 1;
}

test("ROLL-27 a declared zone and a vault-holding person with no checkout refuses the file at THAT person's own line (SPEC §1, §6, L14)", () => {
  // p2 keeps its vault and loses its checkout. Nothing else changes.
  const it = refusal(household({ repositories: [marked("p1")] }));

  // THE PERSON'S OWN KEY, never the zone table's. The thing a reader has to fix
  // is the person who is missing one, and the zone table is correct as written.
  expect(it.error.key).toBe("people[1].vault");
  expect(it.error.line).toBe(lineWithin(it.file, 'id = "p2"', "vault ="));
  expect(it.error.line).not.toBe(lineOf(it.file, "[zone]"));
  // The sentence names the person, so the line and the words agree.
  expect(it.error.reason).toContain("p2");
  expect(it.error.reason).not.toContain("p1");

  // And it is the LOADER'S THROW, carrying the file, the line and the key on
  // it. A process that kept running on a half-declared zone is the outcome this
  // rule exists to prevent, so a warning on a returned registry would be wrong.
  expect(it.error).toBeInstanceOf(RegistryRefused);
  expect(it.error.file).toBe(it.file);
  expect(it.error.line).toBeGreaterThan(0);
  expect(it.error.message).toContain(`line ${it.error.line}`);
  expect(() => loadRegistry(it.file)).toThrow(RegistryRefused);
});

test("ROLL-27 exactly one checkout per person is asserted in both directions, and the second marker is named (SPEC §1)", () => {
  // Zero is the assertion above. TWO is this one, so a build that read the rule
  // as "at least one" passes that assertion and fails here.
  const twice = refusal(household({
    repositories: [
      marked("p1"),
      { ...marked("p1"), id: "p1-zone-again" },
      marked("p2"),
    ],
  }));
  expect(twice.error.key).toBe("repositories[1].zone");
  expect(twice.error.line).toBe(lineWithin(twice.file, 'id = "p1-zone-again"', "zone ="));
});

test("ROLL-27 a person who declares no vault needs no checkout, and the household still loads (SPEC §1, L14)", async () => {
  const { zoneFor, zoneRepositoryFor } = await seam("src/registry/entries.ts");
  expect(typeof zoneFor).toBe("function");

  // The rule read exactly: every person who declares a VAULT, not every person.
  // A person with a tree and no vault has no mount for a checkout to sit in.
  const registry = loadRegistry(write(household({
    people: [
      { id: "p1", tree: TREE.p1, vault: VAULT.p1 },
      { id: "p2", tree: TREE.p2, vault: VAULT.p2 },
      { id: "p3", tree: TREE.p3 },
    ],
  })));
  expect((zoneFor as Function)(registry)).toEqual({ mount: MOUNT, remote: REMOTE, url: URL });
  expect((zoneRepositoryFor as Function)(registry, "p3")).toBeNull();
  expect(((zoneRepositoryFor as Function)(registry, "p1") as { id: string }).id).toBe("p1-zone");
});

test("ROLL-27 a household with no [zone] table has no household rule at all, vaults and all (SPEC §1, L14)", async () => {
  const { zoneFor, zonePathFor } = await seam("src/registry/entries.ts");

  // Both vault-holding people, no zone, no marked repository: this is the file
  // every household that has not chosen a zone carries, and it loads.
  const bare = household({ zone: undefined, repositories: [] });
  delete (bare as { zone?: unknown }).zone;
  const registry = loadRegistry(write(bare));
  expect((zoneFor as Function)(registry)).toBeNull();
  for (const person of ["p1", "p2"]) expect((zonePathFor as Function)(registry, person)).toBeNull();

  // The same file carrying an ORDINARY repository each, still no zone. The
  // household rule is about marked checkouts and a plain one is not one.
  const plain = household({
    zone: undefined,
    repositories: [
      { id: "p1-vault", person: "p1", path: TREE.p1, remote: "origin", branch: "main", required: true },
      { id: "p2-vault", person: "p2", path: TREE.p2, remote: "origin", branch: "main", required: true },
    ],
  });
  delete (plain as { zone?: unknown }).zone;
  expect((zoneFor as Function)(loadRegistry(write(plain)))).toBeNull();
});

test("ROLL-27 a marked repository with the [zone] table deleted is refused by the declaration rule, not by the household one (SPEC §1)", () => {
  // The DECLARATION rule already owns this shape: a marker on a repository
  // nothing declares a zone for names a zone that is not in the file, and the
  // refusal points at the marker rather than at any person.
  const orphan = household({ zone: undefined });
  delete (orphan as { zone?: unknown }).zone;
  const it = refusal(orphan);
  expect(it.error.key).toBe("repositories[0].zone");
  expect(it.error.reason).toContain("[zone]");
  expect(it.error.reason).toContain("p1-zone");
});

test("ROLL-27 the shipped repository cross-checks still fire beside the household rule (SPEC §6)", () => {
  // The household rule is ADDED to the cross-check pass and does not replace
  // it, so each of the three shipped refusals is asserted in miniature here. A
  // build that rewrote the loop rather than extending it fails one of them.
  const undeclared = refusal(household({
    run: [{ id: "sync-p1", kind: "sync", machine: "pi", schedule: "every 5m", memory_limit_mb: 128, repositories: ["nothing-declares-this"] }],
    machines: [{ id: "pi", os: "linux" }],
  }));
  expect(undeclared.error.key).toBe("run[0].repositories");
  expect(undeclared.error.reason).toContain("undeclared");

  const duplicated = refusal(household({
    repositories: [marked("p1"), marked("p2"), { ...marked("p2"), zone: false }],
  }));
  expect(duplicated.error.key).toBe("repositories[2].id");
  expect(duplicated.error.reason).toContain("duplicated");

  const relative = refusal(household({
    repositories: [marked("p1"), marked("p2"), { id: "spare", person: "p1", path: "relative/path", remote: "origin", branch: "main" }],
  }));
  expect(relative.error.key).toBe("repositories[2].path");
  expect(relative.error.reason).toContain("absolute");
});

test("ROLL-27 the household-complete file loads and reads back whole (SPEC §1)", async () => {
  const { zoneFor, zoneRepositoryFor, zonePathFor } = await seam("src/registry/entries.ts");

  // THE CONTROL. A build that refused every zone-declaring file passes the
  // refusals above and fails here, which is the only thing that tells the two
  // apart from outside.
  const registry = loadRegistry(write(household()));
  expect((zoneFor as Function)(registry)).toEqual({ mount: MOUNT, remote: REMOTE, url: URL });
  for (const person of ["p1", "p2"]) {
    expect((zoneRepositoryFor as Function)(registry, person)).toEqual(marked(person));
    expect((zonePathFor as Function)(registry, person)).toBe(implied(person));
  }
});
