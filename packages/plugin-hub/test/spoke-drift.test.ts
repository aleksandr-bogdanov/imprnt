// Two machines, one registry, and what happens when the spoke's copy falls
// behind, plus what `check` on a Mac says about a runner login that is not
// there yet.
//
// A spoke reads a COPY of the file. An agent added on the hub machine with the
// spoke's runner is claimed by nobody until the copy is refreshed, and one
// moved back off the spoke is claimed by both runners: one chat gets two
// sessions and two harvests. So every hub writes the digest of the file it
// runs on to the `registry` sheet on its tick, a spoke's runner measures its
// own copy against the store machine's row before it claims anything and
// claims nothing while they differ, and `check` reports `registry-stale`
// naming the machine. The copy here differs by one comment line, so the two
// files say the same thing and only their bytes differ, which is exactly the
// difference a digest exists to see.
//
// The login on a Mac is a file made for the runner, once, by the owner, with
// the CLI pointed at that file's directory. Until then `check` reports the
// login unreadable with that command as the fix, so the operator step is in
// the finding and nowhere else.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seam, startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { controlledAdapter, observe } from "./helpers/rollout-runner.ts";
import { serviceOs } from "./helpers/rollout-service.ts";
import {
  AGENT,
  DOOR,
  DOOR_MACHINE,
  PERSON,
  RUNNER2,
  SPOKE_MACHINE,
  insertInbound,
  scratchDir,
  spokeStage,
  stageHub,
  superStore,
} from "./helpers/hub-fixture.ts";
import { loginCommand } from "../src/adapters/launch.ts";
import { REGISTRY_SHEET, recordRegistryDigest, registryStale, storeMachineOf } from "../src/hub/digest.ts";
import { loadRegistry, registryDigest } from "../src/registry/load.ts";
import { runHub } from "../src/hub/run.ts";
import { runRunner } from "../src/runner/run.ts";

const SLOW = 120_000;
const HUB_ONLY = join("/nowhere-on-this-machine", crypto.randomUUID());

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** The spoke's own state directory and tree, both real. */
async function spokeDisk() {
  const stateDir = await scratchDir("hub-spoke-drift-");
  const tree = join(stateDir, "trees", PERSON);
  mkdirSync(tree, { recursive: true });
  return { stateDir, tree };
}

/** The stage's machines, the spoke with its own state directory and its own route to the store. */
function machinesWith(stateDir: string, storeUrl: string) {
  return spokeStage().machines!.map((one) => (one.id === SPOKE_MACHINE ? { ...one, state_dir: stateDir, store_url: storeUrl } : one));
}

test(
  "check on a Mac reports a runner login that is not there yet with the one command that makes it, and opens no credential that lives on the hub machine alone",
  async () => {
    const { runCheck } = await seam("src/check/run.ts");
    const spoke = await spokeDisk();
    const spokeLogin = join(spoke.stateDir, "login", ".credentials.json");
    const it = await stageHub(cluster, {
      ...spokeStage(),
      machines: spokeStage().machines!.map((one) => (one.id === SPOKE_MACHINE ? { ...one, state_dir: spoke.stateDir } : one)),
      people: [{ id: PERSON, language: "en", tree: HUB_ONLY, on: { [SPOKE_MACHINE]: { tree: spoke.tree } } }],
      credentials: [
        { id: "household-claude", kind: "claude-login", file: join(HUB_ONLY, "credentials", ".credentials.json"), owner: "household", on: { [SPOKE_MACHINE]: { file: spokeLogin } } },
        // A bot token the hub machine alone holds, named by nothing on the spoke.
        { id: "telegram-bot", kind: "telegram", file: join(HUB_ONLY, "telegram.token"), owner: "household" },
      ],
      preset: { credential: "household-claude" },
    });
    // The spoke's own route to the store, which is what makes the hub machine
    // the file's own machine, where every credential is opened.
    const text = readFileSync(it.registryFile, "utf8");
    writeFileSync(it.registryFile, text.replace('id = "mac"\nos = "macos"', `id = "mac"\nos = "macos"\nstore_url = ${JSON.stringify(it.storeUrl)}`));
    expect(storeMachineOf(loadRegistry(it.registryFile))).toBe(DOOR_MACHINE);
    const store = await superStore(cluster, it.db);
    try {
      const ask = async (machine: string) =>
        (await (runCheck as Function)({ machine, registryFile: it.registryFile, store, os: null, kernel: null, now: new Date() })) as
          { kind: string; subject: string; says: string; fix: string }[];
      const onSpoke = await ask(SPOKE_MACHINE);
      const login = onSpoke.find((one) => one.kind === "credential-unreadable" && one.subject === "household-claude");
      expect(login, JSON.stringify(onSpoke)).toBeDefined();
      expect(login!.says).toContain(spokeLogin);
      expect(login!.fix).toContain(loginCommand(spokeLogin));
      expect(login!.fix).toContain("CLAUDE_SECURESTORAGE_CONFIG_DIR=" + join(spoke.stateDir, "login"));
      expect(login!.fix).toContain("claude auth login");
      // The bot token is the hub machine's and is not opened here at all.
      expect(onSpoke.some((one) => one.subject === "telegram-bot")).toBe(false);
      // On the hub machine both are opened, at the hub machine's paths, and
      // the fix for its login is the plain one.
      const onHub = await ask(DOOR_MACHINE);
      expect(onHub.some((one) => one.kind === "credential-unreadable" && one.subject === "telegram-bot")).toBe(true);
      const hubLogin = onHub.find((one) => one.kind === "credential-unreadable" && one.subject === "household-claude");
      expect(hubLogin?.fix).not.toContain("claude auth login");
    } finally {
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "the hub writes its registry's digest on every tick, a spoke whose copy differs claims nothing and says so, check names the machine, and a matching copy claims again",
  async () => {
    const { runCheck } = await seam("src/check/run.ts");
    const spoke = await spokeDisk();
    const hub = "hub-pi";
    const it = await stageHub(cluster, {
      ...spokeStage(),
      hub: { tick_seconds: 1 },
      people: [{ id: PERSON, language: "en", tree: HUB_ONLY, on: { [SPOKE_MACHINE]: { tree: spoke.tree } } }],
      run: [...spokeStage().run!, { id: hub, kind: "hub", machine: DOOR_MACHINE, schedule: "always", memory_limit_mb: 128 }],
    });
    // The spoke's own route to the store is filled in after the stage exists,
    // because it is the stage's own cluster url.
    // The store machine's os is this box's, because its hub really runs here
    // and a hub refuses a machine whose declared os is not the one it is on.
    const here = process.platform === "darwin" ? "macos" : "linux";
    const text = readFileSync(it.registryFile, "utf8");
    writeFileSync(it.registryFile, text
      .replace('id = "pi"\nos = "linux"', `id = "pi"\nos = "${here}"`)
      .replace('id = "mac"\nos = "macos"', `id = "mac"\nos = "macos"\nstate_dir = ${JSON.stringify(spoke.stateDir)}\nstore_url = ${JSON.stringify(it.storeUrl)}`));
    expect(storeMachineOf(loadRegistry(it.registryFile))).toBe(DOOR_MACHINE);
    // The spoke's copy: the same file plus one comment, so it says the same
    // thing and its bytes differ.
    const copy = join(spoke.stateDir, "registry.toml");
    writeFileSync(copy, readFileSync(it.registryFile, "utf8") + "\n# copied to the spoke\n");
    const edge = controlledAdapter(it.adapterName);
    mkdirSync(join(it.stateDir, "units"), { recursive: true });
    const probe = serviceOs(join(it.stateDir, "units"), process.platform === "darwin" ? "launchd" : "systemd", [hub, DOOR]);
    const store = await superStore(cluster, it.db);
    let piHub: Awaited<ReturnType<typeof runHub>> | undefined;
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
    try {
      // --- the hub machine's hub writes its digest, one row for its machine
      piHub = await runHub({ registryFile: it.registryFile, machine: DOOR_MACHINE, os: probe.os });
      await until("the hub wrote its digest", async () => (await it.read.sheet(REGISTRY_SHEET)).some((row) => row.id === DOOR_MACHINE), 20_000);
      const row = (await it.read.sheet(REGISTRY_SHEET)).find((one) => one.id === DOOR_MACHINE)!;
      expect(row.data.sha256).toBe(registryDigest(it.registryFile));
      // The same writer, called directly for the spoke, writes the spoke's own
      // row and never the reference's.
      await recordRegistryDigest(store, SPOKE_MACHINE, copy);
      expect((await it.read.sheet(REGISTRY_SHEET)).map((one) => one.id).sort()).toEqual([DOOR_MACHINE, SPOKE_MACHINE].sort());
      expect(await registryStale(store, { registry: loadRegistry(copy, { machine: SPOKE_MACHINE }), machine: SPOKE_MACHINE, file: copy })).toBe(true);
      expect(await registryStale(store, { registry: loadRegistry(it.registryFile), machine: DOOR_MACHINE, file: it.registryFile })).toBe(false);

      // --- the spoke's runner, on the differing copy, claims nothing
      await insertInbound(cluster, it.db, { id: "drift-1", body: "a message while the copy is behind" });
      runner = await runRunner({ runner: RUNNER2, registryFile: copy, adapters: { [it.adapterName]: edge.adapter } });
      await until("the runner said its copy is stale", async () => (await it.read.ledger({ stream: "runner", subject: RUNNER2 })).some((one) => one.kind === "registry.stale"), 20_000);
      await Bun.sleep(3000);
      expect(edge.sessions.length).toBe(0);
      expect((await it.read.inbound()).find((one) => one.id === "drift-1")?.claimed_by ?? null).toBeNull();

      // --- check names the machine, from either side
      const ask = async (machine: string, file: string) =>
        ((await (runCheck as Function)({ machine, registryFile: file, store, os: null, kernel: null, now: new Date() })) as
          { kind: string; subject: string; says: string; fix: string }[]).filter((one) => one.kind === "registry-stale");
      const onSpoke = await ask(SPOKE_MACHINE, copy);
      expect(onSpoke.map((one) => one.subject)).toEqual([SPOKE_MACHINE]);
      expect(onSpoke[0].fix).toContain(copy);
      expect((await ask(DOOR_MACHINE, it.registryFile)).map((one) => one.subject)).toEqual([SPOKE_MACHINE]);

      // --- the copy is refreshed, and the runner claims within a tick
      writeFileSync(copy, readFileSync(it.registryFile, "utf8"));
      await until("the runner said its copy is current", async () => (await it.read.ledger({ stream: "runner", subject: RUNNER2 })).some((one) => one.kind === "registry.current"), 20_000);
      expect(await observe(() => edge.sessions.length === 1 && edge.sessions[0].fed.some((fed) => fed.id === "drift-1"), 30_000)).toBe(true);
      expect(await ask(SPOKE_MACHINE, copy)).toEqual([]);
      // The hub machine reads the spoke's ROW, which the spoke's hub writes on
      // its tick: until it has, the hub machine still says the spoke is behind.
      expect((await ask(DOOR_MACHINE, it.registryFile)).map((one) => one.subject)).toEqual([SPOKE_MACHINE]);
      await recordRegistryDigest(store, SPOKE_MACHINE, copy);
      expect(await ask(DOOR_MACHINE, it.registryFile)).toEqual([]);
      // The session's own state is on the spoke's disk.
      expect(existsSync(join(spoke.stateDir, PERSON, "sessions", AGENT))).toBe(true);
    } finally {
      await runner?.stop();
      await edge.stop();
      await piHub?.stop();
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);
