// ROLL-09 ROLL-14. A runner whose agent's door is on another machine is served
// from the store, and every refusal that is about THIS machine still refuses.
//
// The chat log file is written by the door, on the door's own machine. A runner
// somewhere else has no such file and never will, so it reads the same lines
// out of the store, which already holds every message in both directions. The
// reader is chosen by where the two entries say their machines are and by
// nothing else: no switch, no setting, nothing to read wrong.
//
// The code word is planted ONLY as a store row and the chat log directory is
// read off the filesystem in the same check, so nobody can read this as a file
// the fixture quietly wrote. The same check's second case plants a line in the
// FILE with no row behind it and asserts a local runner still reads it, which
// is what says the placement rule chose a reader rather than replacing one.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import { fakeProber } from "./helpers/prober.ts";
import { controlledAdapter, observe } from "./helpers/rollout-runner.ts";
import { serviceOs } from "./helpers/rollout-service.ts";
import {
  AGENT,
  CHAT,
  DOOR,
  PERSON,
  RUNNER,
  RUNNER2,
  SPOKE_MACHINE,
  insertInbound,
  plantChatLine,
  spokeStage,
  stageHub,
  stageSpoke,
  superStore,
} from "./helpers/hub-fixture.ts";
import { proveRolloutRunner } from "../live/prove-rollout-runner.ts";
import { TAIL_PREAMBLE } from "../src/chatlog.ts";
import { encodeHarvestBody, harvestRowId } from "../src/harvest/row.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { runRunner } from "../src/runner/run.ts";
import type { InboundSource } from "../src/store/inbound.ts";

const SLOW = 120_000;

let cluster: Cluster;

beforeAll(async () => {
  await proveRolloutRunner();
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** A message that exists as a store row and in no file anywhere. */
function planted(id: string, text: string, at: Date): { id: string; body: string; source: InboundSource; logReady: boolean; receivedAt: string } {
  return {
    id,
    body: text,
    source: {
      log_id: id,
      at: at.toISOString(),
      door: DOOR,
      chat: CHAT,
      sender_id: "fixture-sender",
      text,
    },
    // The door's own file write is what sets this, and on the spoke there is no
    // door and no file: the row is ready and the log is somewhere else.
    logReady: true,
    receivedAt: at.toISOString(),
  };
}

test(
  "a code word that exists only as a store row reaches the first message of a session the spoke's runner started",
  async () => {
    const it = await stageSpoke(cluster);
    const edge = controlledAdapter(it.adapterName);
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
    try {
      const now = Date.now();
      await insertInbound(cluster, it.db, planted("older", "sapphire-otter", new Date(now - 600_000)));
      await insertInbound(cluster, it.db, planted("newer", "brass-lantern", new Date(now - 300_000)));
      runner = await runRunner({
        runner: RUNNER2,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: edge.adapter },
      });
      expect(
        await observe(() => edge.sessions.length === 1 && edge.sessions[0].fed.length > 0),
        "the spoke's runner started a session and fed it something",
      ).toBe(true);
      const first = edge.sessions[0].fed[0].text;
      expect(first.startsWith(TAIL_PREAMBLE), `first fed message: ${first}`).toBe(true);
      expect(first).toContain("sapphire-otter");
      expect(first).toContain("brass-lantern");
      expect(first.indexOf("sapphire-otter")).toBeLessThan(first.indexOf("brass-lantern"));
      // Read off the filesystem, after the feed: there is no chat log on this
      // machine and there never was one.
      expect(existsSync(join(it.stateDir, PERSON, "chatlog"))).toBe(false);
    } finally {
      await runner?.stop();
      await edge.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "an agent whose door is on this machine is still fed the tail of the file its door wrote",
  async () => {
    const it = await stageHub(cluster);
    const edge = controlledAdapter(it.adapterName);
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
    try {
      // In the FILE, with no store row behind it, which is the only place a
      // local agent's chat has ever been.
      plantChatLine({ stateDir: it.stateDir, text: "copper-kettle" });
      await insertInbound(cluster, it.db, { id: "local", body: "a message" });
      runner = await runRunner({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: edge.adapter },
      });
      expect(
        await observe(() => edge.sessions.length === 1 && edge.sessions[0].fed.length > 0),
      ).toBe(true);
      const first = edge.sessions[0].fed[0].text;
      expect(first.startsWith(TAIL_PREAMBLE), `first fed message: ${first}`).toBe(true);
      expect(first).toContain("copper-kettle");
    } finally {
      await runner?.stop();
      await edge.stop();
      await it.stop();
    }
  },
  SLOW,
);

test("the reader is chosen by the registry and by nothing else", async () => {
  const { chatStateFor } = await seam("src/registry/entries.ts");
  expect(typeof chatStateFor).toBe("function");
  // The registry and the agent, and no third argument: a placement read off two
  // entries' machines is the opposite of a behaviour switch on the command line
  // or in an environment variable.
  expect((chatStateFor as Function).length).toBe(2);
  const spoke = await stageSpoke(cluster);
  const local = await stageHub(cluster);
  try {
    expect((chatStateFor as Function)(loadRegistry(spoke.registryFile), AGENT)).toBe("store");
    expect((chatStateFor as Function)(loadRegistry(local.registryFile), AGENT)).toBe("file");
  } finally {
    await spoke.stop();
    await local.stop();
  }
});

test(
  "a spoke chat with no lines in the store feeds no tail at all, which is an answer and not a refusal",
  async () => {
    const it = await stageSpoke(cluster);
    const edge = controlledAdapter(it.adapterName);
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
    try {
      // A row with no `source` is work with no line behind it, which is what an
      // empty chat looks like from the store. An empty chat is a valid chat: a
      // tail that is empty because the reader looked in the wrong place is the
      // failure, and this case is the other one.
      await insertInbound(cluster, it.db, { id: "first-ever", body: "the first thing anyone said" });
      runner = await runRunner({
        runner: RUNNER2,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: edge.adapter },
      });
      expect(
        await observe(() => edge.sessions.length === 1 && edge.sessions[0].fed.length > 0),
      ).toBe(true);
      expect(edge.sessions[0].fed[0].text).toBe("the first thing anyone said");
      expect(edge.sessions[0].fed.some((fed) => fed.text.includes(TAIL_PREAMBLE))).toBe(false);
    } finally {
      await runner?.stop();
      await edge.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "a state root that exists and is not a readable directory still refuses before any model starts, even for an agent served from the store",
  async () => {
    const it = await stageSpoke(cluster, { people: [{ id: PERSON, language: "en" }] });
    const edge = controlledAdapter(it.adapterName);
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
    try {
      // A regular file where a directory is required is inaccessible even when
      // the test account can bypass chmod. It is owned scratch data, not a mock.
      writeFileSync(join(it.stateDir, PERSON), "not a state directory");
      await insertInbound(cluster, it.db, planted("blocked", "amber-signal", new Date()));
      let error = "";
      try {
        runner = await runRunner({
          runner: RUNNER2,
          registryFile: it.registryFile,
          adapters: { [it.adapterName]: edge.adapter },
        });
      } catch (caught) {
        error = String(caught);
      }
      const detail =
        JSON.stringify(await it.read.sheet("agent_health")) +
        JSON.stringify(await it.read.ledger()) +
        error;
      expect(detail, "this machine's own state root is not about where the door is").toContain(
        "agent-state-unavailable",
      );
      expect(edge.sessions.length).toBe(0);
    } finally {
      await runner?.stop();
      await edge.stop();
      rmSync(join(it.stateDir, PERSON), { force: true });
      await it.stop();
    }
  },
  SLOW,
);

test(
  "installing the services accepts a door and a runner on two machines, and refuses by the store's own error when the store cannot serve the derivation",
  async () => {
    const { runInstall } = await seam("src/install/run.ts");
    const hub = "hub-mac";
    const it = await stageSpoke(cluster, {
      run: [
        ...spokeStage().run!,
        { id: hub, kind: "hub", machine: SPOKE_MACHINE, schedule: "always", memory_limit_mb: 256 },
      ],
    });
    try {
      const unitDir = join(it.stateDir, "units");
      mkdirSync(unitDir, { recursive: true });
      const probe = serviceOs(unitDir, process.platform === "darwin" ? "launchd" : "systemd", [
        hub,
        RUNNER2,
      ]);
      await (runInstall as Function)({
        registryFile: it.registryFile,
        stage: "services",
        target: hub,
        os: probe.os,
      });
      expect(probe.files.length).toBeGreaterThan(0);

      // A store that predates the columns the derivation reads cannot serve a
      // spoke, and the household is told which columns rather than being told
      // the placement is unsupported.
      await it.read.sql("alter table inbound drop column source, drop column log_ready");
      const second = serviceOs(join(it.stateDir, "units-again"), probe.os.flavour, [hub, RUNNER2]);
      let refusal = "";
      try {
        await (runInstall as Function)({
          registryFile: it.registryFile,
          stage: "services",
          target: hub,
          os: second.os,
        });
      } catch (error) {
        refusal = String(error);
      }
      expect(refusal).toContain("source");
      expect(refusal).not.toContain("agent-state-unavailable");
    } finally {
      await it.stop();
    }
  },
  SLOW,
);

test(
  "the refusals that are about this machine survive on a spoke: no tree is still agent-unboxed and an absent vault still refuses the harvest",
  async () => {
    const { runCheck } = await seam("src/check/run.ts");
    const nowhere = join("/nowhere-on-this-machine", crypto.randomUUID());
    const it = await stageSpoke(cluster, {
      // No tree, and a vault this machine does not have.
      people: [{ id: PERSON, language: "en", harvester: "harvest", vault: nowhere }],
      registry: (base) => ({
        ...base,
        presets: {
          ...(base.presets ?? {}),
          harvest: {
            ...(base.presets?.daily ?? {}),
            model: "a-stronger-model-name",
            effort: "high",
          },
        },
      }),
    });
    const edge = controlledAdapter(it.adapterName);
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
    const store = await superStore(cluster, it.db);
    try {
      const findings = (await (runCheck as Function)({
        machine: SPOKE_MACHINE,
        registryFile: it.registryFile,
        store,
        os: null,
        kernel: null,
        credentials: fakeProber({}),
        now: new Date(),
      })) as { kind: string; subject: string }[];
      expect(
        findings.some((one) => one.kind === "agent-unboxed" && one.subject === AGENT),
      ).toBe(true);

      const until = new Date().toISOString();
      const rowId = harvestRowId(AGENT, until);
      await insertInbound(cluster, it.db, {
        id: rowId,
        kind: "harvest",
        body: encodeHarvestBody({ from: null, until, reason: "demand", lines: 1 }),
      });
      runner = await runRunner({
        runner: RUNNER2,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: edge.adapter },
      });
      expect(
        await observe(
          async () => (await it.read.ledger({ stream: "refusal", subject: rowId })).length > 0,
          20_000,
        ),
      ).toBe(true);
      const refusal = (await it.read.ledger({ stream: "refusal", subject: rowId }))[0];
      expect(refusal.kind).toBe("refused.harvest");
      expect(String(refusal.detail.said)).toBe(`no vault at ${nowhere} on this machine`);
      expect(edge.sessions.length).toBe(0);
    } finally {
      await runner?.stop();
      await edge.stop();
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);
