// Check: four findings say what is wrong with a household's shared zone, each
// carries its fix as text, and each one clears when the state is repaired.
// (L13, L17, ROLL-27)
//
// The loader compares DECLARED STRINGS and `check` compares WHAT IS ON DISK.
// That is the whole division: a file can say a checkout pulls from the zone's
// remote and be loaded on three machines, and only the machine holding the
// checkout can say whether it really does.
//
// A THING THAT IS GONE LEAVES NO LINE BEHIND, so every finding below is
// asserted from a planted state AND asserted to be gone, with its sheet row
// gone, once the state is repaired. A finding that stayed after the repair is
// worse than none: a household stops reading a list that is never empty.
//
// `check` READS FILES AND THE REGISTRY FOR ALL OF THIS. It opens no store row
// for it, contacts nothing, and writes only the sheet it already writes. The
// remote comparison reads the checkout's own git configuration, which is why
// the reader below is asked for its answer with an EMPTY PATH: a build that
// shelled out to git would have nothing to shell out to.
//
// Which of the six protected windows this could reach: window 6,
// `test/check-silence.test.ts`, binds what `check` may open and write, and the
// two assertions about statements and connections here are this check's own
// statement of the same property. That file is not edited.
//
// Red reason: behaviour absent. `runCheck` has no zone reader at all, so the
// first assertion finds zero findings, and `src/check/zone.ts` does not exist
// behind it.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDatabase, seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import { storeReader, superStore, userlessStoreUrl } from "./helpers/hub-fixture.ts";
import { fixtureGit, localRepository } from "./helpers/rollout-git.ts";
import { withAmbient } from "./helpers/rollout-loop.ts";
import { zoneStage, THIS_MACHINE, type ZoneStage } from "./helpers/zone-stage.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { finding as findingLine } from "../src/door/lines.ts";
import type { Finding } from "./helpers/finding.ts";
import type { Store } from "../src/store/connect.ts";

const SLOW = 120_000;
const KINDS = ["zone-missing", "zone-remote-mismatch", "zone-unmounted", "zone-undeclared"];

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

interface Scene {
  dir: string;
  stage: ZoneStage;
  store: Store;
  read: ReturnType<typeof storeReader>;
  check(machine?: string): Promise<Finding[]>;
  zoneOnly(machine?: string): Promise<Finding[]>;
  close(): Promise<void>;
}

async function scene(options: Parameters<typeof zoneStage>[1] = {}): Promise<Scene> {
  const dir = mkdtempSync(join(tmpdir(), "hub-zone-findings-"));
  const database = await freshDatabase(cluster);
  const stage = await zoneStage(dir, { hub: { store_url: userlessStoreUrl(cluster, database) }, ...options });
  const store = await superStore(cluster, database);
  const read = storeReader(cluster, database);
  const { runCheck } = await seam("src/check/run.ts");
  const check = async (machine = THIS_MACHINE) =>
    (await (runCheck as Function)({
      registryFile: stage.registryFile, machine, store, os: null, kernel: null,
    })) as Finding[];
  return {
    dir, stage, store, read, check,
    async zoneOnly(machine = THIS_MACHINE) {
      return (await check(machine)).filter((one) => one.kind.startsWith("zone-"));
    },
    async close() {
      await read.close().catch(() => {});
      await store.close().catch(() => {});
      await stage.remove();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The `check` sheet's ZONE rows, by finding id.
 *
 * A household staged with sync entries that have never run also earns the
 * shipped `job-no-stamp` and `peak-missing` rows, which are true and are not
 * this check's business. Filtering by the row's own kind keeps "the row is
 * gone" an assertion about the finding that was just repaired.
 */
async function sheetIds(it: Scene): Promise<string[]> {
  return (await it.read.sheet("check"))
    .filter((row) => String(row.data.kind ?? "").startsWith("zone-"))
    .map((row) => row.id)
    .sort();
}

test("ROLL-27 a declared checkout that is absent is one finding naming the person, the path and the stage that makes it, and it clears when the stage runs (L13, L17)", async () => {
  const { installZone } = await seam("src/install/zone.ts");
  const it = await scene();
  try {
    const p1 = it.stage.person("p1");
    // p1 alone is missing, so the finding set below is about one person.
    fixtureGit(it.dir, "clone", "--branch", it.stage.branch, it.stage.remote, it.stage.person("p2").zonePath);

    const found = await it.zoneOnly();
    const missing = found.filter((one) => one.kind === "zone-missing");
    expect(missing).toHaveLength(1);
    expect(missing[0].subject).toBe("p1");
    expect(missing[0].machine).toBe(p1.machine);
    expect(missing[0].id).toBe(`${p1.machine}/zone-missing:p1`);
    expect(missing[0].says).toContain(p1.zonePath);
    expect(missing[0].says).toContain("p1");
    // The fix is the stage, as TEXT. Nothing in `check` runs it.
    expect(missing[0].fix).toContain("install");
    expect(missing[0].fix).toContain("zone");
    expect(missing[0].fix).toContain(it.stage.registryFile);
    expect(await sheetIds(it)).toContain(missing[0].id);
    // p2 is provisioned and mounted, so it is not reported at all.
    expect(found.map((one) => one.subject)).not.toContain("p2");

    // AND IT CLEARS. The row goes with it, which is what says a fixed thing
    // leaves no line behind.
    (installZone as Function)(loadRegistry(it.stage.registryFile));
    const after = await it.zoneOnly();
    expect(after).toEqual([]);
    expect(await sheetIds(it)).toEqual([]);
  } finally {
    await it.close();
  }
}, SLOW);

test("ROLL-27 a checkout whose real remote is not the zone's is one finding naming both urls, and it clears when the remote is repointed (L13, L17)", async () => {
  const it = await scene({ provision: true });
  try {
    const p1 = it.stage.person("p1");
    const elsewhere = localRepository(join(it.dir, "remotes"), "elsewhere");
    // THE CHECKOUT'S OWN CONFIGURATION, which is what the loader cannot see:
    // the declared string still says the zone's remote and the disk disagrees.
    fixtureGit(p1.zonePath, "remote", "set-url", it.stage.remoteName, elsewhere.remote);

    const mismatched = (await it.zoneOnly()).filter((one) => one.kind === "zone-remote-mismatch");
    expect(mismatched).toHaveLength(1);
    expect(mismatched[0].subject).toBe("p1");
    expect(mismatched[0].says).toContain(elsewhere.remote);
    expect(mismatched[0].says).toContain(it.stage.remote);
    expect(mismatched[0].fix).toContain(p1.zonePath);
    expect(await sheetIds(it)).toEqual([mismatched[0].id]);

    fixtureGit(p1.zonePath, "remote", "set-url", it.stage.remoteName, it.stage.remote);
    expect(await it.zoneOnly()).toEqual([]);
    expect(await sheetIds(it)).toEqual([]);
  } finally {
    await it.close();
  }
}, SLOW);

test("ROLL-27 a vault that does not declare the mount is one finding, in each of the three shapes that are not a declaration, and it clears when the line is added (L13, L17)", async () => {
  const it = await scene({ provision: true });
  try {
    const p1 = it.stage.person("p1");
    const folders = join(p1.vaultDir, "_folders.md");
    const mount = it.stage.mount;

    const shapes: [string, string][] = [
      ["no ## Mounts section at all", "# Folder roles\n\n## Domains\nidentity, health\n"],
      // A SECTION NAMING A DIFFERENT FOLDER, with the real mount name sitting
      // in prose above it. A rule written as a substring search over the file
      // passes this one and a section reader does not.
      ["a ## Mounts section naming a different folder", `# Folder roles\n\nThe household used to keep ${mount} here.\n\n## Mounts\nsomething-else\n`],
      ["an empty ## Mounts section", "# Folder roles\n\n## Mounts\n\n## Domains\nidentity\n"],
    ];
    for (const [shape, text] of shapes) {
      writeFileSync(folders, text, "utf8");
      const unmounted = (await it.zoneOnly()).filter((one) => one.kind === "zone-unmounted");
      expect(unmounted, shape).toHaveLength(1);
      expect(unmounted[0].subject, shape).toBe("p1");
      expect(unmounted[0].says, shape).toContain(folders);
      expect(unmounted[0].says, shape).toContain(mount);
      // The person commits it themselves, because the sync never commits.
      expect(unmounted[0].fix, shape).toContain(mount);
      expect(unmounted[0].fix, shape).toContain(folders);
      expect(await sheetIds(it)).toEqual([unmounted[0].id]);
    }

    // The repair a person makes: ONE `## Mounts` section naming the mount. The
    // reader takes the first such section, exactly as the vault's own rules
    // reader does, so a second one appended below an empty first declares
    // nothing.
    writeFileSync(folders, `# Folder roles\n\n## Mounts\n${mount}\n`, "utf8");
    expect(await it.zoneOnly()).toEqual([]);
    expect(await sheetIds(it)).toEqual([]);
  } finally {
    await it.close();
  }
}, SLOW);

test("ROLL-27 each finding is reported by the machine that runs THAT person's sync, and neither machine clears the other's rows (L13)", async () => {
  const it = await scene({
    machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
    machineOf: (person) => (person === "p1" ? "pi" : "mac"),
  });
  try {
    // Neither checkout exists, so both people have something to report and the
    // only question is who reports it.
    const onPi = (await it.zoneOnly("pi")).filter((one) => one.kind === "zone-missing");
    expect(onPi.map((one) => one.subject)).toEqual(["p1"]);
    expect(onPi[0].id).toBe("pi/zone-missing:p1");

    const onMac = (await it.zoneOnly("mac")).filter((one) => one.kind === "zone-missing");
    expect(onMac.map((one) => one.subject)).toEqual(["p2"]);
    expect(onMac[0].id).toBe("mac/zone-missing:p2");

    // Both rows stand: a run on one machine removes only its own prefix, which
    // is what keeps two machines writing into one store from erasing each other.
    expect(await sheetIds(it)).toEqual(["mac/zone-missing:p2", "pi/zone-missing:p1"]);
  } finally {
    await it.close();
  }
}, SLOW);

test("ROLL-27 three broken things in one household are three findings of three kinds, reported as a set (L13)", async () => {
  const it = await scene({ people: ["p1", "p2", "p3"] });
  try {
    const elsewhere = localRepository(join(it.dir, "remotes"), "elsewhere");
    // p1 missing, p2 pointed somewhere else, p3 provisioned and unmounted.
    for (const id of ["p2", "p3"]) {
      const person = it.stage.person(id);
      fixtureGit(it.dir, "clone", "--branch", it.stage.branch, it.stage.remote, person.zonePath);
    }
    fixtureGit(it.stage.person("p2").zonePath, "remote", "set-url", it.stage.remoteName, elsewhere.remote);
    writeFileSync(join(it.stage.person("p3").vaultDir, "_folders.md"), "# Folder roles\n\n## Mounts\n\n", "utf8");

    const found = await it.zoneOnly();
    // A build that answered the first thing it found fails on the count alone.
    expect(found).toHaveLength(3);
    expect(found.map((one) => `${one.kind}:${one.subject}`).sort()).toEqual([
      "zone-missing:p1", "zone-remote-mismatch:p2", "zone-unmounted:p3",
    ]);
    expect(new Set(found.map((one) => one.id)).size).toBe(3);
    expect(await sheetIds(it)).toEqual(found.map((one) => one.id).sort());
  } finally {
    await it.close();
  }
}, SLOW);

test("ROLL-27 a household that declares no zone is told once per machine and reported for nothing else, and it clears when one is declared (L13, L17)", async () => {
  const it = await scene({ withoutZone: true });
  try {
    const found = await it.zoneOnly();
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("zone-undeclared");
    // NO SUBJECT, so the id is the machine's own and the finding cannot be one
    // per person. A household that has not chosen is not a household whose file
    // is broken, which is the shape `harvest-undeclared` already has.
    expect(found[0].subject).toBe("");
    expect(found[0].id).toBe(`${THIS_MACHINE}/zone-undeclared`);
    expect(found[0].fix).toContain(it.stage.registryFile);
    expect(found.filter((one) => one.kind !== "zone-undeclared")).toEqual([]);
    expect(await sheetIds(it)).toEqual([found[0].id]);
  } finally {
    await it.close();
  }

  // Declared and provisioned: the finding and its row are gone.
  const declared = await scene({ provision: true });
  try {
    expect(await declared.zoneOnly()).toEqual([]);
    expect(await sheetIds(declared)).toEqual([]);
  } finally {
    await declared.close();
  }
}, SLOW);

test("ROLL-27 check reads files and the registry for the zone, opens no store row and reaches nothing (L13, SPEC §2)", async () => {
  const { readZoneState, zoneFindings } = await seam("src/check/zone.ts");
  expect(typeof readZoneState).toBe("function");
  expect(typeof zoneFindings).toBe("function");
  const it = await scene({ provision: true });
  try {
    const p1 = it.stage.person("p1");
    const elsewhere = localRepository(join(it.dir, "remotes"), "elsewhere");
    fixtureGit(p1.zonePath, "remote", "set-url", it.stage.remoteName, elsewhere.remote);

    // THE READER TAKES NO STORE, which is the structural half: a function with
    // no store cannot open a row.
    const registry = loadRegistry(it.stage.registryFile);
    const state = await withAmbient({ PATH: "" }, async () =>
      (readZoneState as Function)({ registry, machine: THIS_MACHINE, registryFile: it.stage.registryFile }));
    // AND IT REACHES NOTHING. With no PATH there is no git to spawn and no
    // program to contact a remote with, and the mismatch is still found,
    // because the comparison is a read of the checkout's own configuration.
    const fromState = (zoneFindings as Function)(state) as Finding[];
    expect(fromState.map((one) => one.kind)).toEqual(["zone-remote-mismatch"]);
    expect(fromState[0].says).toContain(elsewhere.remote);

    // The pure half is pure: the same state answers the same findings twice.
    expect((zoneFindings as Function)(state)).toEqual(fromState);

    // AND THE RUN WRITES ONLY ITS OWN SHEET. Nothing else in this store has a
    // row, and the ledger is untouched by the four findings.
    const before = (await it.read.ledger()).length;
    const found = await it.zoneOnly();
    expect(found.map((one) => one.kind)).toEqual(["zone-remote-mismatch"]);
    const sheets = (await it.read.sql("select distinct sheet from state_row order by sheet")).map((row) => String(row.sheet));
    expect(sheets).toEqual(["check"]);
    expect((await it.read.ledger()).length).toBe(before);
  } finally {
    await it.close();
  }
}, SLOW);

test("ROLL-27 every zone code is machine vocabulary and survives the Russian line whole (L14)", async () => {
  const it = await scene({ withoutZone: true });
  try {
    const undeclared = await it.zoneOnly();
    expect(undeclared).toHaveLength(1);
    // A code is a word for a machine and is never translated, so the Russian
    // line carries it exactly as the finding does.
    for (const kind of [...KINDS, undeclared[0].kind]) {
      const line = findingLine("ru", { code: kind, target: "p1", cause: "operation failed" });
      expect(line).toContain(kind);
      expect(line).toBe(`${kind}: p1: операция не выполнена.`);
    }
  } finally {
    await it.close();
  }
}, SLOW);

test("ROLL-27 a household that is declared, provisioned, mounted and pointing at the right remote is reported for nothing (L13)", async () => {
  // THE CONTROL. A build that reported every household passes every assertion
  // above and fails this one, which is the only thing that tells them apart.
  const it = await scene({ provision: true });
  try {
    const all = await it.check();
    expect(all.filter((one) => one.kind.startsWith("zone-"))).toEqual([]);
    expect(await sheetIds(it)).toEqual([]);
    for (const person of it.stage.people) {
      expect(all.map((one) => one.subject)).not.toContain(person.id);
    }
  } finally {
    await it.close();
  }
}, SLOW);
