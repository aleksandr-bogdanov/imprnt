// D-176, D-92, D-93. An agent whose person has no tree cannot start, and
// `check` says so.
//
// Before 6a an agent with no tree ran without a box, and `agent-unboxed` said
// "runs unboxed". D-176 made the production launch take the box as an input:
// `makeLoopLaunch` refuses a launch with no tree before any child exists, the
// runner records the refusal as a retry and tries again for ever, and the
// harvest goes through the same launch. So the agent never answers anyone, and
// a finding that told the operator it was running, merely unfenced, pointed
// them at a privacy problem when the real problem is a dead chat.
//
// The finding keeps its kind, its id and its fix (the fix was right: give the
// person a tree). What changes is the sentence a person reads.
//
// The control: an agent on the same production preset whose person HAS a tree
// gets no such finding.
//
// Red reason: behaviour absent. The finding still says the agent "runs
// unboxed".

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import { fakeProber } from "./helpers/prober.ts";
import { AGENT, AGENT2, CHAT, DOOR, PERSON, PERSON2, stageHub, superStore } from "./helpers/hub-fixture.ts";
import type { Finding } from "./helpers/finding.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listAgents } from "../src/registry/entries.ts";
import { getPreset } from "../src/registry/presets.ts";
import { boxContextFor } from "../src/box/index.ts";
import { makeLoopLaunch } from "../src/adapters/launch.ts";

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

const RUNNER_PI = "runner-pi";

test(
  "D-176 an agent on a production preset whose person has no tree is reported as unable to start and answer, both when the person declares no tree and when the file declares no person, and an agent whose person has a tree gets no such finding (D-92, D-93)",
  async () => {
    const { runCheck } = await seam("src/check/run.ts");
    const run = [
      { id: DOOR, kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: RUNNER_PI, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ];
    // The production loop, which the loader only accepts with a declared
    // credential. The credential is never opened: `check` is handed a fake
    // prober and the launch below refuses before it reads one.
    const production = (base: Record<string, any>) => ({
      ...base,
      credentials: [{ id: "login-main", kind: "claude-login", file: "/var/lib/imprnt-hub/login/.credentials.json", owner: "household" }],
      presets: {
        ...base.presets,
        loop: {
          adapter: "claude-code",
          model: "a-model-name",
          provider: "a-provider",
          effort: "medium",
          paid: "plan",
          credential: "login-main",
          window_pause_at: 85,
          window_notice_at: 95,
          window_hold_at: 100,
        },
      },
      agents: (base.agents ?? []).map((agent: Record<string, unknown>) => ({ ...agent, preset: "loop", runner: RUNNER_PI })),
    });
    const ask = async (it: { registryFile: string; db: string }): Promise<Finding[]> => {
      const store = await superStore(cluster, it.db);
      try {
        return ((await (runCheck as Function)({
          machine: "pi",
          registryFile: it.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: fakeProber({}),
        })) as Finding[]).filter((one) => one.kind === "agent-unboxed");
      } finally {
        await store.close().catch(() => {});
      }
    };

    // --- p1 declares no tree, p2 declares one. Both agents are on the loop.
    const half = await stageHub(cluster, {
      machines: [{ id: "pi", os: "linux" }],
      people: [{ id: PERSON }, { id: PERSON2, tree: "/var/lib/imprnt-hub/p2" }],
      agents: [{ id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}2`, door: DOOR, runner: RUNNER_PI }],
      run,
      registry: production as never,
    });
    const scratch = mkdtempSync(join(tmpdir(), "hub-no-tree-"));
    try {
      // THE FACT the finding has to state. The launch the runner and the
      // harvest both go through refuses this agent before any child exists.
      const registry = loadRegistry(half.registryFile);
      const agent = listAgents(registry).find((one) => one.id === AGENT)!;
      expect(getPreset(registry, agent.preset).adapter).toBe("claude-code");
      await expect(
        makeLoopLaunch({
          registry,
          agent,
          preset: getPreset(registry, agent.preset),
          sessionDir: join(scratch, "session"),
          purpose: "ordinary",
          box: boxContextFor(registry, AGENT),
        }),
      ).rejects.toThrow();

      const found = await ask(half);
      expect(found.map((one) => one.subject), "only the agent whose person has no tree").toEqual([AGENT]);
      const declared = found[0];
      expect(declared.id).toBe(`pi/agent-unboxed:${AGENT}`);
      expect(declared.says).toContain(AGENT);
      expect(declared.says).toContain("cannot start");
      expect(declared.says).toContain("will not answer");
      expect(declared.says).not.toContain("runs unboxed");
      // The fix was already right, and it stays: give the person a tree.
      expect(declared.fix).toContain("tree");
      expect(declared.fix).toContain(half.registryFile);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      await half.stop();
    }

    // --- the file declares no people at all. The same finding, the other
    //     wording of its reason.
    const nobody = await stageHub(cluster, {
      machines: [{ id: "pi", os: "linux" }],
      run,
      registry: production as never,
    });
    try {
      const found = await ask(nobody);
      expect(found.map((one) => one.subject)).toEqual([AGENT]);
      expect(found[0].says).toContain("cannot start");
      expect(found[0].says).toContain("will not answer");
      expect(found[0].says).toContain("[[people]]");
      expect(found[0].says).not.toContain("runs unboxed");
    } finally {
      await nobody.stop();
    }

    // --- THE CONTROL. Every person has a tree, so no agent gets the finding.
    const whole = await stageHub(cluster, {
      machines: [{ id: "pi", os: "linux" }],
      people: [
        { id: PERSON, tree: "/var/lib/imprnt-hub/p1" },
        { id: PERSON2, tree: "/var/lib/imprnt-hub/p2" },
      ],
      agents: [{ id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}2`, door: DOOR, runner: RUNNER_PI }],
      run,
      registry: production as never,
    });
    try {
      expect(await ask(whole)).toEqual([]);
    } finally {
      await whole.stop();
    }
  },
  90_000,
);
