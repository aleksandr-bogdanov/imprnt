// Test infrastructure: two people's trees and the one shared zone.
//
// L7: "the boundary is the person", "a person is a registry entry", "one shared
// zone is mounted into every vault". The zone is a household setting so
// "a shared zone for a subset of people" is unwriteable rather than merely
// discouraged, and the people are `p1` and `p2` because the repository
// is public.
//
// THE ORIGIN IS GENERATED AT RUN TIME. "The other person's origin does not
// appear in the output" is then an assertion against a string that could only
// have come from that file. A fixed word like `origin` or `example.com` could be
// anywhere in a probe's output for reasons that have nothing to do with the box,
// and a check that looked for one would pass on a box that leaked everything.
//
// THE ORIGIN IS READ AS A FILE, never through git. `/usr/bin/git` on macOS is an
// Xcode shim that dies loading `libxcrun` from a path the box denies, so the
// probe reads `<tree>/.git/config` directly.

import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PlantedPerson {
  id: string;
  tree: string;
  /** A file name only this tree has. */
  marker: string;
  /** The `url` in this tree's `.git/config`, generated at run time. */
  origin: string;
}

export interface PlantedTrees {
  dir: string;
  sharedZone: string;
  /** A file name only the shared zone has. */
  sharedMarker: string;
  people: PlantedPerson[];
  person(id: string): PlantedPerson;
  other(id: string): PlantedPerson;
}

function token(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export function plantTrees(base: string, ids: string[] = ["p1", "p2"]): PlantedTrees {
  // THE REAL PATH, measured. macOS hands out scratch directories under
  // `/var/folders/...`, which is a symlink to `/private/var/folders/...`, and a
  // sandbox profile's `(subpath "/var/folders/...")` matches nothing because
  // the kernel resolves the path first. A tree path in a real registry is a
  // real path, so the fixture hands out one too.
  const dir = realpathSync(base);
  const people: PlantedPerson[] = [];
  for (const id of ids) {
    const tree = join(dir, id);
    const marker = `marker-${id}-${token()}.txt`;
    const origin = `origin-${id}-${token()}`;
    mkdirSync(join(tree, ".git"), { recursive: true });
    writeFileSync(join(tree, marker), `the tree of ${id}\n`, "utf8");
    writeFileSync(
      join(tree, ".git", "config"),
      `[remote "origin"]\n\turl = git@example.invalid:${origin}.git\n`,
      "utf8",
    );
    people.push({ id, tree, marker, origin });
  }

  const sharedZone = join(dir, "shared");
  const sharedMarker = `marker-shared-${token()}.txt`;
  mkdirSync(sharedZone, { recursive: true });
  writeFileSync(join(sharedZone, sharedMarker), "the one zone\n", "utf8");

  const person = (id: string): PlantedPerson => {
    const found = people.find((p) => p.id === id);
    if (!found) throw new Error(`no planted tree for ${id}`);
    return found;
  };

  return {
    dir,
    sharedZone,
    sharedMarker,
    people,
    person,
    other(id) {
      const rest = people.filter((p) => p.id !== id);
      if (rest.length !== 1) {
        throw new Error(`other() wants exactly one other person, and there are ${rest.length}`);
      }
      return rest[0];
    },
  };
}
