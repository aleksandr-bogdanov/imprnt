// Check: provisioning the shared zone is a STAGE somebody runs, and it refuses
// to touch a checkout that is not the zone's. (SPEC §6, L13, ROLL-27)
//
// Cloning is a network operation. The hub's reconcile loop is what the six
// protected timing windows are measured around, so the clone belongs to a
// command an operator runs once, and after a new person, and to nothing that
// ticks. Nothing in this file schedules anything and nothing here touches the
// hub's own loop.
//
// EVERY CLAIM ABOUT A CHECKOUT IS ASKED OF GIT, never read off an exit code. A
// stage that answered "cloned two" while writing nothing would pass a check
// built on its own report, so each assertion below reads the remote url, the
// branch and the HEAD out of the checkout itself.
//
// REFUSING WITHOUT DAMAGING IS THE WHOLE ASSERTION for the two refusals: the
// offending path's HEAD, its remote and its file listing are recorded before
// the run and compared after it. A directory somebody put there by hand is a
// thing to tell a person about and never a thing to remove.
//
// NO NETWORK. Every remote is a local bare repository, and the one deliberately
// wrong remote is a second local bare repository, so "a different remote" is a
// real url comparison rather than a string nobody could reach.
//
// Which of the six protected windows this could reach: none. No door, no
// runner, no hub tick. The stage is a command and this check runs it as one.
//
// Red reason: behaviour absent. `runInstall` refuses any stage that is not
// `all`, `database`, `services` or `entry`, `command` refuses the word on the
// command line, and `src/install/zone.ts` does not exist behind either.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDatabase, seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import { storeReader, userlessStoreUrl } from "./helpers/hub-fixture.ts";
import { fixtureGit, localRepository } from "./helpers/rollout-git.ts";
import { withAmbient } from "./helpers/rollout-loop.ts";
import { zoneStage, type ZoneStage } from "./helpers/zone-stage.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";
import { operation } from "../src/door/lines.ts";
import type { OsSeam } from "../src/os/types.ts";

const SLOW = 120_000;

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** A git seam for the CHECK's own reads, isolated from this machine's config. */
const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "file",
  GIT_AUTHOR_NAME: "p1",
  GIT_AUTHOR_EMAIL: "p1@example.invalid",
  GIT_COMMITTER_NAME: "p1",
  GIT_COMMITTER_EMAIL: "p1@example.invalid",
};

/**
 * An operating system seam that RECORDS and never acts.
 *
 * The stage may not render a unit, install one or start one, and the only way
 * to say that from outside is to hand it a seam and read what it was asked.
 */
function recordingOs(): { os: OsSeam; asked: string[] } {
  const asked: string[] = [];
  const note = <T>(name: string, answer: T) => { asked.push(name); return answer; };
  const os = {
    flavour: "launchd" as const,
    render: () => note("render", []),
    install: async () => note("install", [] as string[]),
    remove: async () => { note("remove", null); },
    start: async () => { note("start", null); },
    stop: async () => { note("stop", null); },
    restart: async () => { note("restart", null); },
    list: async () => note("list", []),
    show: async () => note("show", null),
    memory: async () => note("memory", { rss: 0, source: "none" }),
    available: async () => note("available", { ok: true, reason: "" }),
  } as unknown as OsSeam;
  return { os, asked };
}

/** Every file a checkout holds, git's own bookkeeping left out. */
function everything(path: string): string[] {
  return readdirSync(path, { recursive: true })
    .map(String)
    .filter((one) => one !== ".git" && !one.startsWith(".git/"))
    .sort();
}

interface Scene {
  dir: string;
  stage: ZoneStage;
  database: string;
  read: ReturnType<typeof storeReader>;
  close(): Promise<void>;
}

async function scene(options: Parameters<typeof zoneStage>[1] = {}): Promise<Scene> {
  const dir = mkdtempSync(join(tmpdir(), "hub-zone-install-"));
  const database = await freshDatabase(cluster);
  const stage = await zoneStage(dir, { hub: { store_url: userlessStoreUrl(cluster, database) }, ...options });
  const read = storeReader(cluster, database);
  return {
    dir, stage, database, read,
    async close() {
      await read.close().catch(() => {});
      await stage.remove();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("ROLL-27 install zone clones every declared checkout that is absent, and a second run clones nothing (SPEC §6, L13)", async () => {
  const { installZone } = await seam("src/install/zone.ts");
  expect(typeof installZone).toBe("function");
  const it = await scene();
  try {
    for (const person of it.stage.people) expect(existsSync(person.zonePath)).toBe(false);

    const first = (installZone as Function)(loadRegistry(it.stage.registryFile)) as {
      declared: boolean; cloned: { person: string }[]; verified: unknown[]; refused: unknown[];
    };
    expect(first.declared).toBe(true);
    expect(first.cloned.map((one) => one.person).sort()).toEqual(["p1", "p2"]);
    expect(first.verified).toEqual([]);
    expect(first.refused).toEqual([]);

    // ASKED OF GIT, one checkout at a time.
    const before = new Map<string, { head: string; files: string[] }>();
    for (const person of it.stage.people) {
      expect(existsSync(join(person.zonePath, ".git"))).toBe(true);
      expect(fixtureGit(person.zonePath, "remote", "get-url", it.stage.remoteName)).toBe(it.stage.remote);
      expect(fixtureGit(person.zonePath, "symbolic-ref", "--quiet", "--short", "HEAD")).toBe(it.stage.branch);
      before.set(person.id, {
        head: fixtureGit(person.zonePath, "rev-parse", "HEAD"),
        files: everything(person.zonePath),
      });
    }

    // IDEMPOTENCE, read as the two checkouts being byte-identical afterwards.
    const second = (installZone as Function)(loadRegistry(it.stage.registryFile)) as {
      cloned: unknown[]; verified: { person: string }[]; refused: unknown[];
    };
    expect(second.cloned).toEqual([]);
    expect(second.verified.map((one) => one.person).sort()).toEqual(["p1", "p2"]);
    expect(second.refused).toEqual([]);
    for (const person of it.stage.people) {
      expect(fixtureGit(person.zonePath, "rev-parse", "HEAD")).toBe(before.get(person.id)!.head);
      expect(everything(person.zonePath)).toEqual(before.get(person.id)!.files);
    }
  } finally {
    await it.close();
  }
}, SLOW);

test("ROLL-27 a checkout that is not the zone's is refused and left exactly as it was, and the good ones are still verified (SPEC §6, L13)", async () => {
  const { installZone } = await seam("src/install/zone.ts");
  const it = await scene({ people: ["p1", "p2", "p3", "p4"] });
  try {
    // p3: a real checkout of a DIFFERENT bare repository, which is the shape a
    // person creates by cloning the wrong thing into the right place.
    const elsewhere = localRepository(join(it.dir, "remotes"), "elsewhere");
    const p3 = it.stage.person("p3");
    mkdirSync(join(p3.vaultDir), { recursive: true });
    fixtureGit(it.dir, "clone", elsewhere.remote, p3.zonePath);
    const foreign = {
      head: fixtureGit(p3.zonePath, "rev-parse", "HEAD"),
      url: fixtureGit(p3.zonePath, "remote", "get-url", "origin"),
      files: everything(p3.zonePath),
    };

    // p4: a plain directory somebody made by hand, with a file in it.
    const p4 = it.stage.person("p4");
    mkdirSync(p4.zonePath, { recursive: true });
    writeFileSync(join(p4.zonePath, "notes.txt"), "a directory somebody put here by hand\n", "utf8");
    const byHand = everything(p4.zonePath);

    const first = (installZone as Function)(loadRegistry(it.stage.registryFile)) as {
      cloned: { person: string }[]; verified: { person: string }[];
      refused: { person: string; cause: string; path: string }[];
    };
    expect(first.cloned.map((one) => one.person).sort()).toEqual(["p1", "p2"]);
    expect(first.refused.map((one) => one.person).sort()).toEqual(["p3", "p4"]);
    expect(first.refused.find((one) => one.person === "p3")!.cause).toBe("remote-mismatch");
    expect(first.refused.find((one) => one.person === "p4")!.cause).toBe("not-a-repository");

    // NOT TOUCHED, read back rather than assumed.
    expect(fixtureGit(p3.zonePath, "rev-parse", "HEAD")).toBe(foreign.head);
    expect(fixtureGit(p3.zonePath, "remote", "get-url", "origin")).toBe(foreign.url);
    expect(fixtureGit(p3.zonePath, "remote", "get-url", "origin")).not.toBe(it.stage.remote);
    expect(everything(p3.zonePath)).toEqual(foreign.files);
    expect(existsSync(p4.zonePath)).toBe(true);
    expect(everything(p4.zonePath)).toEqual(byHand);
    expect(readFileSync(join(p4.zonePath, "notes.txt"), "utf8")).toBe("a directory somebody put here by hand\n");

    // And the two good ones are VERIFIED on the next run while the two bad ones
    // are refused again, so one wrong checkout never stops the rest.
    const second = (installZone as Function)(loadRegistry(it.stage.registryFile)) as {
      cloned: unknown[]; verified: { person: string }[]; refused: { person: string }[];
    };
    expect(second.cloned).toEqual([]);
    expect(second.verified.map((one) => one.person).sort()).toEqual(["p1", "p2"]);
    expect(second.refused.map((one) => one.person).sort()).toEqual(["p3", "p4"]);

    // A REFUSAL IS SAID OUT LOUD, and the command still exits 0: a checkout
    // this stage would not touch is a thing to tell a person about, not a
    // reason to stop installing the rest of the household.
    const { command } = await seam("src/entry/command.ts");
    const said: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { said.push(String(chunk)); return true }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await (command as Function)(["install", it.stage.registryFile, "zone"]) as number;
    } finally {
      process.stdout.write = write;
    }
    expect(code).toBe(0);
    const printed = said.join("");
    for (const person of ["p3", "p4"]) {
      expect(printed).toContain(`${person}-zone`);
      expect(printed).toContain(it.stage.person(person).zonePath);
    }
    expect(printed).toContain("remote-mismatch");
    expect(printed).toContain("not-a-repository");
    expect(printed).toContain(elsewhere.remote);
    // The stage's own line is still the last word, through the shipped template.
    expect(printed.trimEnd().split("\n").at(-1)).toBe(
      operation("en", { operation: "install", target: "zone", result: "done" }),
    );
  } finally {
    await it.close();
  }
}, SLOW);

test("ROLL-27 the stage is on the command line beside the three shipped ones, takes no target, and schedules nothing (SPEC §6, L13)", async () => {
  const { command } = await seam("src/entry/command.ts");
  const { runInstall } = await seam("src/install/run.ts");
  expect(typeof command).toBe("function");
  const it = await scene();
  try {
    const said: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { said.push(String(chunk)); return true }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await (command as Function)(["install", it.stage.registryFile, "zone"]) as number;
    } finally {
      process.stdout.write = write;
    }
    expect(code).toBe(0);
    // ASSERTED WHOLE through the shipped template, so a stage that printed a
    // line of its own invention fails here.
    expect(said.join("")).toBe(operation("en", { operation: "install", target: "zone", result: "done" }) + "\n");
    for (const person of it.stage.people) expect(existsSync(join(person.zonePath, ".git"))).toBe(true);

    // The stage takes NO target.
    expect(await (command as Function)(["install", it.stage.registryFile, "zone", "p1-zone"])).toBe(2);

    // THE CONTROL that says the list was widened and not replaced: the three
    // shipped stages keep their own argument rules in the same run.
    expect(await (command as Function)(["install", it.stage.registryFile, "database", "anything"])).toBe(2);
    expect(await (command as Function)(["install", it.stage.registryFile, "services"])).toBe(2);
    expect(await (command as Function)(["install", it.stage.registryFile, "entry"])).toBe(2);
    expect(await (command as Function)(["install", it.stage.registryFile, "not-a-stage"])).toBe(2);

    // NOTHING IS SCHEDULED. The seam records every verb and the stage asked it
    // for none of them.
    const seen = recordingOs();
    const answer = await (runInstall as Function)({ registryFile: it.stage.registryFile, stage: "zone", os: seen.os }) as {
      stage: string; result: string; zone: { verified: unknown[] };
    };
    expect(answer.stage).toBe("zone");
    expect(answer.result).toBe("done");
    expect(answer.zone.verified).toHaveLength(2);
    expect(seen.asked).toEqual([]);
  } finally {
    await it.close();
  }
}, SLOW);

test("ROLL-27 a household that declares no zone is a no-op with a named result, not a refusal (SPEC §6)", async () => {
  const { runInstall } = await seam("src/install/run.ts");
  const it = await scene({ withoutZone: true });
  try {
    const seen = recordingOs();
    const answer = await (runInstall as Function)({ registryFile: it.stage.registryFile, stage: "zone", os: seen.os }) as {
      result: string; zone: { declared: boolean; cloned: unknown[]; verified: unknown[]; refused: unknown[] };
    };
    expect(answer.result).toBe("done");
    expect(answer.zone.declared).toBe(false);
    expect(answer.zone.cloned).toEqual([]);
    expect(answer.zone.verified).toEqual([]);
    expect(answer.zone.refused).toEqual([]);
    expect(seen.asked).toEqual([]);
    // A household that has not chosen a zone is not a household whose file is
    // broken, so the command line says done and exits 0.
    const write = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      const { command } = await seam("src/entry/command.ts");
      expect(await (command as Function)(["install", it.stage.registryFile, "zone"])).toBe(0);
    } finally {
      process.stdout.write = write;
    }
  } finally {
    await it.close();
  }
}, SLOW);

test("ROLL-27 the zone checkout never stalls the vault's own sync, and its own sync commits what was written into it (SPEC §6, ROLL-31)", async () => {
  const { runSync } = await seam("src/sync/run.ts");
  expect(typeof runSync).toBe("function");
  // THE CONTROL on this whole test: the household is provisioned BY HAND, with
  // no stage run at all, so everything below is a property of the checkout and
  // not of the stage that made it.
  const it = await scene();
  try {
    for (const person of it.stage.people) {
      fixtureGit(it.dir, "clone", "--branch", it.stage.branch, it.stage.remote, person.zonePath);
    }
    const registry = loadRegistry(it.stage.registryFile);
    const entry = (id: string) => listRunEntries(registry).find((one) => one.id === id)!;
    const sync = (id: string) => withAmbient(GIT_ENV, () => (runSync as Function)(entry(id), registry) as Promise<void>);

    for (const person of it.stage.people) await sync(person.syncEntry);
    const rows = await it.read.sheet("sync");
    expect(rows.map((one) => one.id).sort()).toEqual(it.stage.people.map((one) => one.syncEntry).sort());
    for (const row of rows) expect(row.data.status).toBe("success");

    // An uncommitted change INSIDE the zone checkout. The parent vault sets a
    // declared nested checkout aside, so its own sync is untouched by it.
    const p1 = it.stage.person("p1");
    writeFileSync(join(p1.zonePath, "a-shared-note.md"), "# a note somebody is still writing\n", "utf8");
    await sync(p1.syncEntry);
    const after = (await it.read.sheet("sync")).find((one) => one.id === p1.syncEntry)!;
    const results = after.data.repositories as { id: string; status: string; committed?: number }[];
    // The vault's own commit takes nothing of the zone, and the zone's own
    // entry commits the note into the zone and pushes it.
    expect(results.find((one) => one.id === p1.vaultRepository)!.status).toBe("success");
    expect(results.find((one) => one.id === p1.vaultRepository)!.committed).toBeUndefined();
    expect(results.find((one) => one.id === p1.zoneRepository)!.status).toBe("success");
    expect(results.find((one) => one.id === p1.zoneRepository)!.committed).toBe(1);
    expect(fixtureGit(it.dir, "--git-dir", it.stage.remote, "show", `${it.stage.branch}:a-shared-note.md`))
      .toBe("# a note somebody is still writing");
  } finally {
    await it.close();
  }
}, SLOW);
