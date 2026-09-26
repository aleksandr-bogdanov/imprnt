// A runner on another machine keeps its state on that machine, files into the
// vault checkout that is there, and is installed with only that machine's
// units.
//
// The registry names the hub machine's paths at the top, and the spoke's own
// paths on its `[[machines]]` entry and under each person's and credential's
// `on.<machine>` table. Every process reads the file for its own machine, so
// what is asserted here is the OUTCOME on disk and in the store: where a
// session directory appears, which vault a harvested note lands in, which roots
// `check` sweeps, and which units an install writes. The spoke's state
// directory, tree and vault are all scratch directories of this check's own,
// and the hub machine's are paths that do not exist on this box at all, so a
// build that quietly kept the hub machine's paths cannot pass.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seam, startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { controlledAdapter, observe } from "./helpers/rollout-runner.ts";
import { serviceOs } from "./helpers/rollout-service.ts";
import { stageHarvest } from "./helpers/harvest-stage.ts";
import { slugOf } from "./helpers/scratch-vault.ts";
import {
  AGENT,
  DOOR,
  PERSON,
  RUNNER2,
  SPOKE_MACHINE,
  DOOR_MACHINE,
  insertInbound,
  scratchDir,
  spokeStage,
  stageHub,
  superStore,
} from "./helpers/hub-fixture.ts";
import type { RegistrySpec } from "./helpers/registry.ts";
import { encodeHarvestBody, harvestRowId } from "../src/harvest/row.ts";
import { renderSlice, type SliceLine } from "../src/harvest/slice.ts";
import { runRunner } from "../src/runner/run.ts";

const SLOW = 120_000;

/** Paths the hub machine has and this box does not. */
const HUB_ONLY = join("/nowhere-on-this-machine", crypto.randomUUID());

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** A healthy login file, with tokens of its own. */
function login(file: string, tag: string): string {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const access = `access-${tag}-${crypto.randomUUID()}`;
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: `refresh-${tag}-${crypto.randomUUID()}`, refreshTokenExpiresAt: 4102444800000 } }), { mode: 0o600 });
  return access;
}

/** The spoke's own state directory and tree, both real, plus the placement lines. */
async function spokeDisk() {
  const stateDir = await scratchDir("hub-spoke-state-");
  const tree = join(stateDir, "trees", PERSON);
  mkdirSync(tree, { recursive: true });
  return { stateDir, tree };
}

/** The stage's machines with the spoke's own state directory on its entry. */
function machinesWith(stateDir: string) {
  return spokeStage().machines!.map((one) => (one.id === SPOKE_MACHINE ? { ...one, state_dir: stateDir } : one));
}

test(
  "a spoke's runner keeps its session state under the spoke's own state directory and boxes the agent in the tree that is on the spoke",
  async () => {
    const spoke = await spokeDisk();
    const it = await stageHub(cluster, {
      ...spokeStage(),
      machines: machinesWith(spoke.stateDir),
      people: [{ id: PERSON, language: "en", tree: HUB_ONLY, on: { [SPOKE_MACHINE]: { tree: spoke.tree } } }],
    });
    const edge = controlledAdapter(it.adapterName);
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
    try {
      await insertInbound(cluster, it.db, { id: "spoke-1", body: "a message for the spoke's agent" });
      runner = await runRunner({ runner: RUNNER2, registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } });
      expect(await observe(() => edge.sessions.length === 1 && edge.sessions[0].fed.length > 0)).toBe(true);
      // The session directory is where a session's own files go, and it is
      // under the SPOKE's state directory, inside this person's own root.
      expect(existsSync(join(spoke.stateDir, PERSON, "sessions", AGENT))).toBe(true);
      // The hub machine's state directory got nothing for this person.
      expect(existsSync(join(it.stateDir, PERSON))).toBe(false);
      // The runner said which machine it connected from.
      const connected = await it.read.ledger({ stream: "runner", subject: RUNNER2 });
      expect(connected.some((one) => one.kind === "connected" && one.detail.machine === SPOKE_MACHINE)).toBe(true);
    } finally {
      await runner?.stop();
      await edge.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "check on the spoke opens the spoke's own copy of the login and sweeps the spoke's own roots, and check on the hub machine sweeps the hub's",
  async () => {
    const { runCheck } = await seam("src/check/run.ts");
    const spoke = await spokeDisk();
    const hubLogin = join(HUB_ONLY, "credentials", ".credentials.json");
    const spokeLogin = join(spoke.stateDir, "login", ".credentials.json");
    const spokeAccess = login(spokeLogin, "spoke");
    const it = await stageHub(cluster, {
      ...spokeStage(),
      machines: machinesWith(spoke.stateDir),
      people: [{ id: PERSON, language: "en", tree: HUB_ONLY, on: { [SPOKE_MACHINE]: { tree: spoke.tree } } }],
      credentials: [{ id: "household-claude", kind: "claude-login", file: hubLogin, owner: "household", on: { [SPOKE_MACHINE]: { file: spokeLogin } } }],
      preset: { credential: "household-claude" },
    });
    // The spoke's own route to the store, which is what makes the hub machine
    // the file's own machine, where every credential is opened.
    const text = readFileSync(it.registryFile, "utf8");
    writeFileSync(it.registryFile, text
      .replace("[hub]\n", `[hub]\nstore_machine = ${JSON.stringify(DOOR_MACHINE)}\n`)
      .replace('id = "mac"\nos = "macos"', `id = "mac"\nos = "macos"\nstore_url = ${JSON.stringify(it.storeUrl)}`));
    const store = await superStore(cluster, it.db);
    try {
      // A copy of the SPOKE's login, planted where only the spoke's roots
      // reach: inside the spoke's state directory.
      const leak = join(spoke.stateDir, PERSON, "notes.json");
      mkdirSync(join(spoke.stateDir, PERSON), { recursive: true });
      writeFileSync(leak, JSON.stringify({ kept: spokeAccess }));
      const ask = async (machine: string) =>
        (await (runCheck as Function)({ machine, registryFile: it.registryFile, store, os: null, kernel: null, now: new Date() })) as
          { kind: string; subject: string; says: string; fix: string }[];

      const onSpoke = await ask(SPOKE_MACHINE);
      const copies = onSpoke.filter((one) => one.kind === "credential-copy");
      expect(copies.map((one) => one.subject)).toEqual([leak]);
      expect(copies[0].fix).toContain(spokeLogin);
      // The spoke's own copy of the login is healthy and is read as the
      // credential: no blank, no unreadable, and never the hub machine's path.
      expect(onSpoke.filter((one) => one.kind.startsWith("credential-") && one.kind !== "credential-copy")).toEqual([]);
      expect(JSON.stringify(onSpoke)).not.toContain(HUB_ONLY);

      // The hub machine reads its own file, which this box does not have, and
      // sweeps its own roots, which do not hold the spoke's leak.
      const onHub = await ask(DOOR_MACHINE);
      expect(onHub.some((one) => one.kind === "credential-unreadable" && one.says.includes(hubLogin))).toBe(true);
      expect(onHub.filter((one) => one.kind === "credential-copy")).toEqual([]);
    } finally {
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "a harvest on the spoke files into the vault checkout the spoke has, at the person's placement there, and never looks for the hub machine's",
  async () => {
    const spoke = await spokeDisk();
    const stage = await stageHarvest(cluster, {
      ...spokeStage(),
      machines: machinesWith(spoke.stateDir),
      hub: { tick_seconds: 2 },
      harvestPeople: [{ id: PERSON, language: "en", harvest_quiet_minutes: 600, harvest_min_messages: 99, harvest_report: false }],
      // The vault the stage scaffolded becomes the SPOKE's placement, and the
      // entry's own tree and vault become paths this box does not have.
      registry: (base: RegistrySpec) => {
        const placed = spokeStage().registry!(base);
        return {
          ...placed,
          people: (placed.people ?? []).map((one) =>
            one.id === PERSON
              ? {
                  ...one,
                  tree: HUB_ONLY,
                  vault: join(HUB_ONLY, "vault-project"),
                  on: { [SPOKE_MACHINE]: { tree: one.tree as string, vault: one.vault as string } },
                }
              : one,
          ),
        };
      },
    });
    const it = stage.hub;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      const now = Date.now();
      const ago = (minutes: number) => new Date(now - minutes * 60_000);
      const said = async (id: string, text: string, at: Date): Promise<SliceLine> => {
        await insertInbound(cluster, it.db, {
          id, body: text, receivedAt: at.toISOString(), logReady: true,
          source: { log_id: id, at: at.toISOString(), door: DOOR, chat: "0000000000", sender_id: "fixture-sender", text },
        });
        await it.read.sql(
          `insert into ledger_event (at, stream, subject, kind, actor) values ($2, 'inbound', $1, 'delivered', 'door')`,
          [id, new Date(at.getTime() + 1000).toISOString()],
        );
        return { at: at.toISOString(), direction: "in", from: PERSON, text };
      };
      const lines = [await said("spoke-said-one", "the bank raised the card fee", ago(40)), await said("spoke-said-two", "and it starts in October", ago(38))];
      const title = "The card fee rises in October";
      it.scripted.setAnswer(() => `=== NOTE ===\n---\ntype: note\ndomain: finances\nkind: reference\nsummary: The monthly card fee rises in October.\ntags: [banking, fees]\n---\n\n# ${title}\n\nThe bank said the monthly card fee rises in October.\n=== END ===`);
      runner = await runRunner({ runner: RUNNER2, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
      const until_ = new Date(now).toISOString();
      const rowId = harvestRowId(AGENT, until_);
      await insertInbound(cluster, it.db, { id: rowId, kind: "harvest", body: encodeHarvestBody({ from: null, until: until_, reason: "quiet", lines: lines.length }) });
      await until(
        "the harvest settled on the spoke",
        async () => (await it.read.harvestSheet()).some((row) => row.id === `${PERSON}/${AGENT}` && row.data.row === rowId),
        60_000,
        async () => `refusals=${JSON.stringify(await it.read.ledger({ stream: "refusal" }))} inbound=${JSON.stringify(await it.read.inbound())}`,
      );
      const fed = it.scripted.fed().filter((one) => one.id === rowId);
      expect(fed.length).toBe(1);
      expect(fed[0].text.endsWith(renderSlice(lines))).toBe(true);
      // The note landed in the vault that is on the spoke, through the real CLI.
      const note = join(stage.vault.vaultDir, "finances", `${slugOf(title)}.md`);
      expect(existsSync(note)).toBe(true);
      expect(readFileSync(note, "utf8")).toContain("card fee");
      // It was staged under the spoke's own state directory, and no refusal
      // named the hub machine's vault.
      expect(existsSync(join(spoke.stateDir, PERSON, "harvest"))).toBe(true);
      expect(await it.read.ledger({ stream: "refusal" })).toEqual([]);
    } finally {
      await runner?.stop();
      await stage.stop();
    }
  },
  SLOW,
);

test(
  "installing the services for the spoke's hub writes only the spoke's units, with the spoke's own state directory in them",
  async () => {
    const { runInstall } = await seam("src/install/run.ts");
    const spoke = await spokeDisk();
    const hub = "hub-mac";
    const it = await stageHub(cluster, {
      ...spokeStage(),
      machines: machinesWith(spoke.stateDir),
      people: [{ id: PERSON, language: "en", tree: HUB_ONLY, on: { [SPOKE_MACHINE]: { tree: spoke.tree } } }],
      run: [...spokeStage().run!, { id: hub, kind: "hub", machine: SPOKE_MACHINE, schedule: "always", memory_limit_mb: 256 }],
    });
    try {
      const unitDir = join(it.stateDir, "units");
      mkdirSync(unitDir, { recursive: true });
      // launchd on purpose, whatever this box runs: the spoke is a Mac, and a
      // plist is the one unit file that carries the state directory in it.
      const probe = serviceOs(unitDir, "launchd", [hub, RUNNER2, DOOR]);
      await (runInstall as Function)({ registryFile: it.registryFile, stage: "services", target: hub, os: probe.os });
      const written = probe.files.map((file) => file.path.slice(file.path.lastIndexOf("/") + 1)).sort();
      expect(written).toEqual([`imprnt-hub-${hub}.plist`, `imprnt-hub-${RUNNER2}.plist`]);
      for (const file of probe.files) {
        expect(file.text).toContain(join(spoke.stateDir, "service-log"));
        expect(file.text).not.toContain(join(it.stateDir, "service-log"));
        // What every launchd unit of the hub carries: the runtime switch the
        // store refuses to open without, a PATH that finds a CLI installed the
        // usual way, and a resident kept alive.
        expect(file.text).toContain("BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING");
        expect(file.text).toContain("/.local/bin");
        expect(file.text).toContain("<key>KeepAlive</key>");
      }
      expect(probe.calls.filter((call) => call.operation === "install").map((call) => call.target).sort()).toEqual([hub, RUNNER2]);
    } finally {
      await it.stop();
    }
  },
  SLOW,
);
