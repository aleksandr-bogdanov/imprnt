// Check: the household declares its shared zone once, as a mount, and every bad
// shape of that declaration refuses the file by key and by line.
// (SPEC §1, §6, L14, L7, ROLL-27, ROLL-16)
//
// SPEC 1: "One shared zone mounted into every vault, sharing a note means moving
// it there", with Forbidden carrying "a shared zone for a subset of people". The
// core's own contract already defines that mount: a shared repository checked
// out inside `vault/`, declared under `## Mounts` in `_folders.md`. So the file
// declares it ONCE for the household, as a `[zone]` table naming the folder name
// every vault carries it under, the git remote NAME every checkout wears and the
// URL a clone reads, plus one `[[repositories]]` entry per person marked
// `zone = true` at the path that mount implies.
//
// THE REMOTE IS TWO STRINGS IN THE SHIPPED SCHEMA and the table declares both. A
// repository's `remote` is a git remote NAME, because `runSync` tests it by
// asking `git remote` for the list of names, and a clone needs a URL. Splitting
// them is what keeps the loader's refusal a pure string comparison and leaves
// `runSync` alone.
//
// PURE. No Postgres and no operating system: the registry is a file and the
// loader is a file loader. No path below exists, because the loader asks whether
// one path lies inside another, which is string arithmetic decidable from the
// file alone, and never whether it is on this machine.
//
// Which of the six protected windows this could reach: none. Nothing here starts
// a door, a runner or a cluster of agents.
//
// Red reason: behaviour absent. The loader parses no `[zone]` table and has no
// rule about a `zone` key on a repository entry, and `zoneFor`,
// `zoneRepositoryFor` and `zonePathFor` do not exist.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubPath, seam } from "./helpers/cluster.ts";
import { writeRegistry, type RegistrySpec } from "./helpers/registry.ts";
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts";

const MOUNT = "shared-notes";
const TREE: Record<string, string> = { p1: "/srv/hub/p1", p2: "/srv/hub/p2" };
const VAULT: Record<string, string> = { p1: "/srv/hub/p1/vault", p2: "/srv/hub/p2/vault" };
const REMOTE = "origin";
const URL = "file:///srv/zone.git";

/** The path the mount implies for this person, which the loader compares against. */
function implied(person: string, mount = MOUNT): string {
  return `${VAULT[person]}/vault/${mount}`;
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-registry-zone-"));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * A household that declares its zone and is COMPLETE from the first line: every
 * vault-holding person it declares carries exactly one marked repository, at the
 * path the mount implies. A check that deliberately breaks that rule says so in
 * its own words where it breaks it.
 */
function household(over: Partial<RegistrySpec> = {}): RegistrySpec {
  return {
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: "/srv/hub/state" },
    people: [
      { id: "p1", tree: TREE.p1, vault: VAULT.p1 },
      { id: "p2", tree: TREE.p2, vault: VAULT.p2 },
    ],
    zone: { mount: MOUNT, remote: REMOTE, url: URL },
    repositories: [
      { id: "p1-zone", person: "p1", path: implied("p1"), remote: REMOTE, branch: "main", required: true, zone: true },
      { id: "p2-zone", person: "p2", path: implied("p2"), remote: REMOTE, branch: "main", required: true, zone: true },
    ],
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

/** The line a key sits on inside the entry that opens with `anchor`. */
function lineWithin(file: string, anchor: string, starts: string): number {
  const rows = readFileSync(file, "utf8").split("\n");
  const from = rows.findIndex((line) => line.trim() === anchor);
  expect(from).toBeGreaterThanOrEqual(0);
  const at = rows.findIndex((line, i) => i > from && line.trim().startsWith(starts));
  expect(at).toBeGreaterThan(from);
  return at + 1;
}

/** The line a key sits on, so "by line" is read off the file rather than counted. */
function lineOf(file: string, starts: string): number {
  const at = readFileSync(file, "utf8").split("\n").findIndex((line) => line.trim().startsWith(starts));
  expect(at).toBeGreaterThanOrEqual(0);
  return at + 1;
}

test("ROLL-27 a [zone] table with no mount and one with no remote each refuse the file by key and by line (SPEC §1, L14)", () => {
  // 1. no mount: the folder name every vault carries the zone under.
  const noMount = refusal(household({ zone: { remote: REMOTE, url: URL } }));
  expect(noMount.error.key).toBe("zone.mount");
  expect(noMount.error.line).toBe(lineOf(noMount.file, "[zone]"));
  expect(noMount.error.reason).toContain("mount");

  // 2. no remote.
  const noRemote = refusal(household({ zone: { mount: MOUNT, url: URL } }));
  expect(noRemote.error.key).toBe("zone.remote");
  expect(noRemote.error.line).toBe(lineOf(noRemote.file, "[zone]"));

  // The shape every string on a table gets, for the reason every other one has
  // it: a url that is a number, and a mount that is an empty string.
  const badUrl = refusal(household({ zone: { mount: MOUNT, remote: REMOTE, url: 8794 as unknown as string } }));
  expect(badUrl.error.key).toBe("zone.url");
  expect(badUrl.error.line).toBe(lineOf(badUrl.file, "url ="));

  const emptyMount = refusal(household({ zone: { mount: "", remote: REMOTE, url: URL } }));
  expect(emptyMount.error.key).toBe("zone.mount");
  expect(emptyMount.error.line).toBe(lineOf(emptyMount.file, "mount ="));
});

// One value per assertion, never a group, because a rule written as a prefix
// test or as a `path.sep` test passes some of these and fails others.
for (const mount of ["a/b", "a\\b", "../up", "."]) {
  test(`ROLL-27 a mount carrying a separator (${JSON.stringify(mount)}) refuses the file, naming zone.mount (SPEC §1, L7)`, () => {
    const it = refusal(household({
      zone: { mount, remote: REMOTE, url: URL },
      repositories: [
        { id: "p1-zone", person: "p1", path: implied("p1", mount), remote: REMOTE, branch: "main", zone: true },
        { id: "p2-zone", person: "p2", path: implied("p2", mount), remote: REMOTE, branch: "main", zone: true },
      ],
    }));
    expect(it.error.key).toBe("zone.mount");
    expect(it.error.line).toBe(lineOf(it.file, "mount ="));
  });
}

test("ROLL-27 a mount that is not kebab-case refuses the file, naming zone.mount (SPEC §1)", () => {
  const it = refusal(household({
    zone: { mount: "Shared Notes", remote: REMOTE, url: URL },
    repositories: [
      { id: "p1-zone", person: "p1", path: implied("p1", "Shared Notes"), remote: REMOTE, branch: "main", zone: true },
      { id: "p2-zone", person: "p2", path: implied("p2", "Shared Notes"), remote: REMOTE, branch: "main", zone: true },
    ],
  }));
  expect(it.error.key).toBe("zone.mount");
  expect(it.error.line).toBe(lineOf(it.file, "mount ="));
});

// A sibling of the right path, and the right path with the mount folder missing.
// The second is here because a rule written as a prefix test passes it.
for (const [shape, wrong] of [
  ["a sibling of the path the mount implies", `${VAULT.p1}/vault/other-notes`],
  ["the path with the mount folder missing", `${VAULT.p1}/vault`],
] as const) {
  test(`ROLL-27 a marked repository whose path is ${shape} refuses the file, naming its own path (SPEC §1, L7)`, () => {
    const it = refusal(household({
      repositories: [
        { id: "p1-zone", person: "p1", path: wrong, remote: REMOTE, branch: "main", zone: true },
        { id: "p2-zone", person: "p2", path: implied("p2"), remote: REMOTE, branch: "main", zone: true },
      ],
    }));
    expect(it.error.key).toBe("repositories[0].path");
    expect(it.error.line).toBe(lineOf(it.file, `path = "${wrong}"`));
    expect(it.error.reason).toContain(implied("p1"));
  });
}

test("ROLL-27 a marked repository whose remote is not the zone's refuses the file, naming its own remote (SPEC §1)", () => {
  const it = refusal(household({
    repositories: [
      { id: "p1-zone", person: "p1", path: implied("p1"), remote: "upstream", branch: "main", zone: true },
      { id: "p2-zone", person: "p2", path: implied("p2"), remote: REMOTE, branch: "main", zone: true },
    ],
  }));
  expect(it.error.key).toBe("repositories[0].remote");
  expect(it.error.line).toBe(lineOf(it.file, 'remote = "upstream"'));
});

test("ROLL-27 a zone marker that is not a boolean refuses the file, and two marked repositories for one person refuse naming the second (SPEC §1)", () => {
  const written = refusal(household({
    repositories: [
      { id: "p1-zone", person: "p1", path: implied("p1"), remote: REMOTE, branch: "main", zone: "true" as unknown as boolean },
      { id: "p2-zone", person: "p2", path: implied("p2"), remote: REMOTE, branch: "main", zone: true },
    ],
  }));
  expect(written.error.key).toBe("repositories[0].zone");
  expect(written.error.line).toBe(lineOf(written.file, 'zone = "true"'));

  // Exactly one checkout per person is what "one shared zone" means in a loader.
  const twice = refusal(household({
    repositories: [
      { id: "p1-zone", person: "p1", path: implied("p1"), remote: REMOTE, branch: "main", zone: true },
      { id: "p1-zone-again", person: "p1", path: implied("p1"), remote: REMOTE, branch: "main", zone: true },
      { id: "p2-zone", person: "p2", path: implied("p2"), remote: REMOTE, branch: "main", zone: true },
    ],
  }));
  expect(twice.error.key).toBe("repositories[1].zone");
  // The second entry's own marker, which is the line the reader has to delete.
  expect(twice.error.line).toBe(lineWithin(twice.file, 'id = "p1-zone-again"', "zone ="));
});

test("ROLL-27 a marked repository whose person declares no vault refuses the file, naming its person (SPEC §1)", () => {
  const it = refusal(household({
    people: [{ id: "p1", tree: TREE.p1 }, { id: "p2", tree: TREE.p2, vault: VAULT.p2 }],
    repositories: [
      { id: "p1-zone", person: "p1", path: implied("p1"), remote: REMOTE, branch: "main", zone: true },
      { id: "p2-zone", person: "p2", path: implied("p2"), remote: REMOTE, branch: "main", zone: true },
    ],
  }));
  expect(it.error.key).toBe("repositories[0].person");
  expect(it.error.line).toBe(lineOf(it.file, 'person = "p1"'));
  expect(it.error.reason).toContain("vault");
});

test("ROLL-27 the whole shape loads and reads back, one zone for the household, and an unmarked repository is untouched by every zone rule (SPEC §1, L7)", async () => {
  const { zoneFor, zoneRepositoryFor, zonePathFor } = await seam("src/registry/entries.ts");
  expect(typeof zoneFor).toBe("function");
  expect(typeof zoneRepositoryFor).toBe("function");
  expect(typeof zonePathFor).toBe("function");

  // ONE ZONE PER HOUSEHOLD, written as a signature: the accessor takes no
  // person, so a per-person zone has nowhere to be asked for.
  expect((zoneFor as Function).length).toBe(1);

  // The everything-declared control. A build that refused every zone-shaped
  // file passes all five refusals above and fails this one.
  const registry = loadRegistry(write(household({
    repositories: [
      // An ORDINARY repository, at a path nothing like the one the mount
      // implies, sitting beside a declared zone: the zone rules apply to
      // marked entries and to nothing else.
      { id: "p1-vault", person: "p1", path: `${VAULT.p1}`, remote: "upstream", branch: "trunk", required: false },
      { id: "p1-zone", person: "p1", path: implied("p1"), remote: REMOTE, branch: "main", required: true, zone: true },
      { id: "p2-zone", person: "p2", path: implied("p2"), remote: REMOTE, branch: "main", required: true, zone: true },
    ],
  })));

  expect((zoneFor as Function)(registry)).toEqual({ mount: MOUNT, remote: REMOTE, url: URL });
  expect((zoneRepositoryFor as Function)(registry, "p1")).toEqual({
    id: "p1-zone", person: "p1", path: implied("p1"), remote: REMOTE, branch: "main", required: true, zone: true,
  });
  expect((zonePathFor as Function)(registry, "p1")).toBe(implied("p1"));
  expect((zonePathFor as Function)(registry, "p2")).toBe(implied("p2"));
  // The unmarked one is not the zone's, by id.
  expect(((zoneRepositoryFor as Function)(registry, "p1") as { id: string }).id).not.toBe("p1-vault");
  // And no `[[people]]` field carries the zone: it is one table for the
  // household, so a person who named a mount would be naming a key nothing reads.
  for (const person of registry.people) {
    expect(Object.keys(person)).not.toContain("mount");
    expect(Object.keys(person)).not.toContain("zone");
  }
});

test("ROLL-27 a file with no [zone] table and no repositories loads, the accessors answer null, and listPeople's rows gain no keys (SPEC §1, L14)", async () => {
  const { zoneFor, zoneRepositoryFor, zonePathFor, listPeople } = await seam("src/registry/entries.ts");

  const registry = loadRegistry(write({
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: "/srv/hub/state" },
    people: [{ id: "p1", tree: TREE.p1 }, { id: "p2", tree: TREE.p2 }],
  }));

  expect((zoneFor as Function)(registry)).toBeNull();
  for (const person of ["p1", "p2"]) {
    expect((zoneRepositoryFor as Function)(registry, person)).toBeNull();
    expect((zonePathFor as Function)(registry, person)).toBeNull();
  }
  // THE TOLERANCE THAT KEEPS EVERY SHIPPED CHECK GREEN: a person's row is
  // exactly `id` and `tree`, which is the shape a shipped check asserts.
  expect((listPeople as Function)(registry)).toEqual([
    { id: "p1", tree: TREE.p1 },
    { id: "p2", tree: TREE.p2 },
  ]);
});

test("ROLL-27 the shipped example declares the zone, carries no retired setting, and loads whole (SPEC §1, §6, L14)", async () => {
  const { zoneFor, zonePathFor } = await seam("src/registry/entries.ts");

  const file = hubPath("src/registry/registry.example.toml");
  // A setting nothing reads has nowhere to be written.
  expect(readFileSync(file, "utf8")).not.toContain("shared_zone");

  // The whole shipped file loads, so a build that made `[zone]` required turns
  // this red rather than turning the household red.
  const registry = loadRegistry(file);
  const zone = (zoneFor as Function)(registry) as { mount: string; remote: string; url: string };
  expect(typeof zone.mount).toBe("string");
  expect(typeof zone.remote).toBe("string");
  expect(typeof zone.url).toBe("string");
  // Household-complete: every person the example declares with a vault carries
  // one marked checkout, at the path the mount implies.
  for (const person of registry.people.filter((one) => one.vault)) {
    expect((zonePathFor as Function)(registry, person.id)).toBe(`${person.vault}/vault/${zone.mount}`);
  }
});
