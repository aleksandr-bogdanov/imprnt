// Test infrastructure: a whole household whose shared zone is real on disk.
//
// The zone is the MOUNT the core's contract already defines: one shared
// repository checked out inside each person's own `vault/`, under the folder
// name `_folders.md` declares beneath `## Mounts`. Three checks need the same
// scene, so it is built once here: a real vault per person scaffolded by the
// real `imprnt init`, one local bare repository that is the zone's remote, a
// registry declaring `[zone]` plus one marked repository per person, one sync
// entry per person listing that person's vault and their zone checkout, and an
// `imprnt` shim pointing at the monorepo's own CLI.
//
// EVERY VAULT IS COMMITTED AND CLEAN when this returns. `runSync` refuses a
// dirty tree and never commits (the person commits), so a scene that left the
// `## Mounts` line uncommitted would stall the very sync the checks run.
//
// THE PERSON'S TREE IS THE VAULT PROJECT ROOT, the directory holding `vault/`
// and `raw/`, which is what `people[].vault` names everywhere in this package.
// The zone therefore lands at `<root>/vault/<mount>`, which is the path the
// loader computes and the path the core's own `--vault <root>/vault` reaches.
//
// NO NETWORK. The zone's remote is a local bare repository made the way every
// other rollout check makes one, and each person's vault pushes into a bare
// repository of its own.
//
// THE BASE DIRECTORY IS REAL-PATHED, because macOS hands out scratch
// directories under `/var/folders/...` which is a symlink into `/private`, the
// box resolves a path before it grants it, and `runSync` compares real paths.

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hubPath, seam } from "./cluster.ts";
import { writeImprntShim } from "./imprnt-shim.ts";
import { scratchVault, type ScratchVault } from "./scratch-vault.ts";
import { fixtureGit, localRepository } from "./rollout-git.ts";
import { writeRegistry, type MachineSpec, type RegistrySpec, type RepositorySpec, type RunSpec } from "./registry.ts";

/** The folder name every vault in this scene carries the shared zone under. */
export const ZONE_MOUNT = "shared-notes";

/** The machine a one-machine household runs on, named the way fixtures name one. */
export const THIS_MACHINE = process.platform === "darwin" ? "mac" : "pi";

export interface ZonePerson {
  id: string;
  /** The person's tree: the project root holding `vault/` and `raw/`. */
  tree: string;
  /** What `people[].vault` names. The same root, because a vault is a project. */
  vault: string;
  /** `<root>/vault`, the directory the core's `--vault` is handed. */
  vaultDir: string;
  /** `<root>/vault/<mount>`, this person's own checkout of the shared zone. */
  zonePath: string;
  /** The declared id of this person's vault repository. */
  vaultRepository: string;
  /** The declared id of this person's zone checkout. */
  zoneRepository: string;
  /** The `[[run]]` entry that keeps both of them in step. */
  syncEntry: string;
  /** The machine that entry runs on. */
  machine: string;
  /** Where a note of this slug lives inside this person's vault. */
  notePath(slug: string): string;
}

export interface ZoneStageOptions {
  /** How many people, or their ids. Two by default. */
  people?: number | string[];
  /** The folder name the zone mounts at. */
  mount?: string;
  /** The machines the file declares. One, named after this platform, by default. */
  machines?: MachineSpec[];
  /** Which machine runs this person's sync. The single machine by default. */
  machineOf?: (person: string) => string;
  /** Extra or overriding `[hub]` settings: a store url, a state dir. */
  hub?: Record<string, string | number>;
  /** Clone the zone into every declared path before returning. */
  provision?: boolean;
  /** Declare no `[zone]` table and no marked repository at all. */
  withoutZone?: boolean;
  /** The last word on the rendered file, for a check that needs its own shape. */
  over?: (spec: RegistrySpec) => RegistrySpec;
}

export interface ZoneStage {
  dir: string;
  registryFile: string;
  mount: string;
  /** The bare repository every zone checkout clones and pushes to. */
  remote: string;
  /** The remote NAME every checkout wears, which is what `runSync` asks git for. */
  remoteName: string;
  branch: string;
  people: ZonePerson[];
  person(id: string): ZonePerson;
  other(id: string): ZonePerson;
  /** The path `hub.imprnt` names: the real CLI behind a one line shim. */
  imprnt: string;
  /** A config home a BOXED command may write, so no real registry is touched. */
  configHome: string;
  /** Write a note into this person's vault and commit it. Answers its path. */
  plantNote(person: string, slug: string, text: string): string;
  /** Commit everything standing in this person's own vault tree. */
  commitVault(person: string, message?: string): void;
  /** Commit everything standing in this person's zone checkout. */
  commitZone(person: string, message?: string): void;
  remove(): Promise<void>;
}

/** The ids two people carry, because the repository is public. */
function idsOf(people: ZoneStageOptions["people"]): string[] {
  if (Array.isArray(people)) return people;
  const many = people ?? 2;
  return Array.from({ length: many }, (_, n) => `p${n + 1}`);
}

/**
 * The `## Mounts` line, written into a vault that has no `_folders.md` at all.
 *
 * Only the Mounts section is declared. An ABSENT section keeps the shipped
 * default, so the vault's entities, domains and forms stay exactly what every
 * other vault has, and the file says one new thing.
 */
/**
 * An `imprnt` a BOXED command can actually read, and a config home it can write.
 *
 * On macOS the box grants `/usr`, `/bin`, brew's prefix, `~/.local`, `~/.bun`
 * and `/private/tmp`, which is where an installed `imprnt` lives. A repository
 * checkout under the home directory is none of those, so the core's own scripts
 * are copied under `/private/tmp` and the shim runs THAT copy: the same bytes at
 * a path the box reaches, which is the shape a household really has. On Linux
 * the whole host is bound read-only inside the box, so the checkout is reachable
 * where it stands and the plain shim is the one used everywhere else.
 */
function reachableImprnt(dir: string): { imprnt: string; configHome: string; home: string | null } {
  if (process.platform !== "darwin") {
    const configHome = join(dir, "xdg-boxed");
    mkdirSync(configHome, { recursive: true });
    return { imprnt: writeImprntShim(dir), configHome, home: null };
  }
  const home = mkdtempSync("/private/tmp/imprnt-hub-cli-");
  cpSync(hubPath("../imprnt/scripts"), join(home, "scripts"), { recursive: true });
  const shim = join(home, "imprnt");
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(home, "scripts", "cli.ts"))} "$@"\n`,
    "utf8",
  );
  chmodSync(shim, 0o755);
  const configHome = join(home, "xdg");
  mkdirSync(configHome, { recursive: true });
  return { imprnt: shim, configHome, home };
}

function declareMount(vaultDir: string, mount: string): void {
  const file = join(vaultDir, "_folders.md");
  const had = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (new RegExp(`^\\s*${mount}\\s*$`, "im").test(had)) return;
  const text = had === "" ? `# Folder roles\n\n## Mounts\n${mount}\n` : `${had.trimEnd()}\n\n## Mounts\n${mount}\n`;
  writeFileSync(file, text, "utf8");
}

export async function zoneStage(base: string, options: ZoneStageOptions = {}): Promise<ZoneStage> {
  const dir = realpathSync(base);
  const mount = options.mount ?? ZONE_MOUNT;
  const ids = idsOf(options.people);
  const machines = options.machines ?? [
    { id: THIS_MACHINE, os: process.platform === "darwin" ? "macos" : "linux" },
  ];
  const machineOf = options.machineOf ?? (() => machines[0].id);
  const remotes = join(dir, "remotes");
  mkdirSync(remotes, { recursive: true });

  // The zone's own remote. It arrives with one commit on `main`, so a clone of
  // it is a checkout with a history rather than an empty directory.
  const zone = localRepository(remotes, "zone");
  const vaults: ScratchVault[] = [];
  const people: ZonePerson[] = [];

  try {
    for (const id of ids) {
      const scratch = await scratchVault(join(dir, id), "vault-project");
      vaults.push(scratch);
      declareMount(scratch.vaultDir, mount);
      // The vault's own remote is an EMPTY bare repository, so the vault's own
      // history is the one that lands there. A bare made with a commit already
      // in it would refuse the first push as unrelated.
      const remote = join(remotes, `${id}-vault-remote.git`);
      fixtureGit(remotes, "init", "--bare", "--initial-branch=main", remote);
      fixtureGit(scratch.root, "init", "--initial-branch=main");
      fixtureGit(scratch.root, "add", "-A");
      fixtureGit(scratch.root, "commit", "-m", "the vault as imprnt init scaffolded it");
      fixtureGit(scratch.root, "remote", "add", "origin", remote);
      fixtureGit(scratch.root, "push", "--set-upstream", "origin", "main");
      people.push({
        id,
        tree: scratch.root,
        vault: scratch.root,
        vaultDir: scratch.vaultDir,
        zonePath: join(scratch.root, "vault", mount),
        vaultRepository: `${id}-vault`,
        zoneRepository: `${id}-zone`,
        syncEntry: `sync-${id}`,
        machine: machineOf(id),
        notePath: (slug: string) => join(scratch.vaultDir, `${slug}.md`),
      });
    }

    const reachable = reachableImprnt(dir);
    const imprnt = reachable.imprnt;
    const repositories: RepositorySpec[] = [];
    const run: RunSpec[] = [];
    for (const person of people) {
      repositories.push({
        id: person.vaultRepository, person: person.id, path: person.tree,
        remote: "origin", branch: zone.branch, required: true,
      });
      if (!options.withoutZone) {
        repositories.push({
          id: person.zoneRepository, person: person.id, path: person.zonePath,
          remote: "origin", branch: zone.branch, required: true, zone: true,
        });
      }
      run.push({
        id: person.syncEntry, kind: "sync", machine: person.machine,
        schedule: "every 5m", memory_limit_mb: 128,
        repositories: options.withoutZone
          ? [person.vaultRepository]
          : [person.vaultRepository, person.zoneRepository],
      });
    }

    const spec: RegistrySpec = {
      hub: { state_dir: join(dir, "state"), imprnt, ...(options.hub ?? {}) },
      machines,
      people: people.map((one) => ({ id: one.id, tree: one.tree, vault: one.vault })),
      ...(options.withoutZone ? {} : { zone: { mount, remote: "origin", url: zone.remote } }),
      repositories,
      presets: {},
      agents: [],
      run,
    };
    mkdirSync(join(dir, "state"), { recursive: true });
    const registryFile = writeRegistry(dir, options.over ? options.over(spec) : spec);

    const person = (id: string): ZonePerson => {
      const found = people.find((one) => one.id === id);
      if (!found) throw new Error(`no person ${id} in this stage`);
      return found;
    };

    const stage: ZoneStage = {
      dir, registryFile, mount, remote: zone.remote, remoteName: "origin", branch: zone.branch,
      people, person,
      other(id) {
        const rest = people.filter((one) => one.id !== id);
        if (rest.length !== 1) throw new Error(`other() wants exactly one other person, and there are ${rest.length}`);
        return rest[0];
      },
      imprnt,
      configHome: reachable.configHome,
      plantNote(id, slug, text) {
        const at = person(id).notePath(slug);
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, text, "utf8");
        stage.commitVault(id, `plant ${slug}`);
        return at;
      },
      commitVault(id, message = "a change the person made") {
        const tree = person(id).tree;
        fixtureGit(tree, "add", "-A");
        // Nothing standing is not an error: a caller that commits twice in a
        // row is asking for a clean tree, and it already has one.
        if (fixtureGit(tree, "status", "--porcelain") === "") return;
        fixtureGit(tree, "commit", "-m", message);
      },
      commitZone(id, message = "a note shared into the zone") {
        const path = person(id).zonePath;
        fixtureGit(path, "add", "-A");
        if (fixtureGit(path, "status", "--porcelain") === "") return;
        fixtureGit(path, "commit", "-m", message);
      },
      async remove() {
        for (const scratch of vaults) await scratch.remove();
        await rm(remotes, { recursive: true, force: true }).catch(() => {});
        await rm(join(dir, "state"), { recursive: true, force: true }).catch(() => {});
        await rm(imprnt, { force: true }).catch(() => {});
        if (reachable.home) await rm(reachable.home, { recursive: true, force: true }).catch(() => {});
        await rm(join(dir, "xdg-boxed"), { recursive: true, force: true }).catch(() => {});
        await rm(registryFile, { force: true }).catch(() => {});
        for (const id of ids) await rm(join(dir, id), { recursive: true, force: true }).catch(() => {});
      },
    };

    // PROVISIONING IS THE INSTALL STAGE ITSELF, never a second copy of it here.
    // A scene built by a hand-written clone would pass on a stage that never
    // works, which is the whole thing the stage exists to prove.
    if (options.provision) {
      const { installZone } = await seam("src/install/zone.ts");
      const { loadRegistry } = await import("../../src/registry/load.ts");
      if (typeof installZone !== "function") throw new Error("installZone is not a function");
      (installZone as (registry: unknown) => unknown)(loadRegistry(registryFile));
    }
    return stage;
  } catch (error) {
    for (const scratch of vaults) await scratch.remove().catch(() => {});
    throw error;
  }
}
