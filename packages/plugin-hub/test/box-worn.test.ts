// 03b item 1. The agent's process WEARS the box, and an agent that cannot be
// boxed is a finding. (SPEC §5, L7, D-92, D-93)
//
// Phase 3 closed the box and left it hanging in the wardrobe: check 15 proves a
// boxed command cannot read the other person's tree and check 16 proves the
// command is derived from the registry, and NOTHING wires `boxCommand` into
// `Adapter.start`, so no agent's model process runs inside one. That residue is
// D-92's `[partial]` and this file is what closes it.
//
// THE SEAM, per 03b: the runner computes the boxing for the agent and hands the
// adapter a hook, `wrap(argv) => argv`. The adapter stays loop-specific and
// box-agnostic: it imports nothing from `src/box/`, knows no tool name, and
// spawns whatever comes back. `test/helpers/scripted-adapter.ts` records the
// argv it really used, which is the production code's own output read at the
// seam rather than the boxing code being asked whether it boxed.
//
// WHY THE PLANNED macOS PROBE IS NOT THE ONE BELOW. 03b-DEBTS asks for the
// child's `argv[0]` read from `ps -o command= -p <pid>`. MEASURED on this Mac,
// 2026-09-15: `sandbox-exec` applies the profile and then EXECS the target in
// the same process, so the pid's own argv is the target's and never names the
// tool (`/usr/bin/sandbox-exec -f p.sb /bin/sh -c 'sleep 5'` reads back as
// `sleep 5`). A check that looked for `sandbox-exec` there could only ever fail,
// including against a perfectly boxed child. `bwrap` is the other way round: it
// forks, so the spawned pid stays bwrap's and `/proc/<pid>/cmdline` does name
// it, and that reading is kept as the Linux extra. What replaces it on both
// platforms is the OUTCOME, which is what D-92 says a box check binds: the
// child, from inside itself, cannot read the other person's marker, and the
// same child unboxed reads it.
//
// MEASURED BESIDE IT, and recorded because it narrows D-92's stated reason:
// bun DOES start inside a `(deny default)` profile carrying the allow set
// 03b-DEBTS measured for the real loop (root literal, the system paths,
// /opt/homebrew, read and write on /private/tmp and /private/var/folders,
// process-exec, sysctl-read, mach-lookup, network, ipc-posix, system-socket,
// user-preference-read, iokit-open). "bun itself did not start" was true of the
// MINIMAL profile only.
//
// Red reasons. Test 1: behaviour absent, `src/check/run.ts` has no
// `agent-unboxed` finding, so an agent whose person declares no tree is
// reported as nothing at all. Test 2: behaviour absent, `src/runner/run.ts`
// calls `adapter.start({ preset, sessionId: null })` with no boxing hook, so
// the spawn record's `wrapped` is false and its `argv[0]` is `bun`.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import { boxGate } from "./helpers/box-gate.ts";
import { plantTrees, type PlantedTrees } from "./helpers/trees.ts";
import {
  spawnHolder,
  survivingHolders,
  type HeldChild,
} from "./helpers/scripted-adapter.ts";
import {
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  RUNNER,
  plantChatLine,
  scratchDir,
  stageHub,
  superStore,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
import { thisMachine } from "./helpers/os-gate.ts";
import type { Finding } from "./helpers/finding.ts";

const SLOW = 180_000;
const gate = boxGate();

let cluster: Cluster;
const spares: HeldChild[] = [];
/** The trees live OUTSIDE any staged hub's own directory, which that hub deletes. */
let treeDir = "";
let trees: PlantedTrees;

beforeAll(async () => {
  process.stderr.write(
    `[box-gate] 03b item 1, the agent's process wears the box, on ${process.platform}: ${
      gate.ok ? `open (${gate.tool})` : `SKIPPED, ${gate.reason}`
    }\n`,
  );
  cluster = await startCluster();
  treeDir = await scratchDir("hub-box-trees-");
  trees = plantTrees(treeDir);
});

afterAll(async () => {
  try {
    for (const spare of spares) spare.kill();
    // INDEPENDENT PROOF that nothing this file spawned outlived it, asked of the
    // platform rather than of any list this file keeps.
    await until(
      "every memory holder left the box",
      () => survivingHolders().length === 0,
      15_000,
      () => `still holding: ${survivingHolders().join(", ")}`,
    );
  } finally {
    if (treeDir) await rm(treeDir, { recursive: true, force: true }).catch(() => {});
    if (cluster) await cluster.stop();
  }
});

/** One machine, two people who both have a tree, one agent, one real child. */
async function stageBoxed(): Promise<StagedHub> {
  const machine = thisMachine();
  const p1 = trees.person(PERSON);
  const p2 = trees.person(PERSON2);
  return await stageHub(cluster, {
    adapter: {
      child: true,
      probePath: join(p2.tree, p2.marker),
    },
    hub: { shared_zone: trees.sharedZone },
    machines: [machine],
    // D-93. A person is a registry entry and the tree is the boundary. With no
    // tree there is nothing to fence, which is the `agent-unboxed` case.
    people: [
      { id: PERSON, tree: p1.tree },
      { id: PERSON2, tree: p2.tree },
    ],
    run: [
      {
        id: DOOR,
        kind: "door",
        machine: machine.id,
        platform: "fake",
        person: PERSON,
        token_file: "/dev/null",
        schedule: "always",
        memory_limit_mb: 192,
      },
      {
        id: RUNNER,
        kind: "runner",
        machine: machine.id,
        schedule: "always",
        memory_limit_mb: 512,
        child_memory_limit_mb: 2048,
      },
    ],
  });
}

test(
  "SPEC §5 an agent whose person declares no tree cannot be boxed and is a finding rather than a refusal: check reports agent-unboxed naming that agent and nothing for the agent whose person has a tree, and a file where both have trees produces none at all (SPEC §5, L7, D-92, D-93)",
  async () => {
    const { runCheck } = await seam("src/check/run.ts");
    expect(typeof runCheck).toBe("function");
    const check = runCheck as (options: Record<string, unknown>) => Promise<Finding[]>;
    const machine = thisMachine();

    // One person with a tree, one without, an agent each, both on this
    // machine's runner. The file LOADS: D-93 rules that a person with no tree
    // is a question about a machine and not about the file.
    const half = await stageHub(cluster, {
      machines: [machine],
      people: [{ id: PERSON, tree: "/var/lib/imprnt-hub/p1" }, { id: PERSON2 }],
      agents: [
        { id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}1`, door: DOOR, runner: RUNNER },
      ],
      run: [
        { id: DOOR, kind: "door", machine: machine.id, platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: RUNNER, kind: "runner", machine: machine.id, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      ],
    });
    const store = await superStore(cluster, half.db);
    try {
      const findings = await check({
        machine: machine.id,
        registryFile: half.registryFile,
        store,
        os: null,
        kernel: null,
      });
      const unboxed = findings.filter((one) => one.kind === "agent-unboxed");
      expect(unboxed.map((one) => one.subject)).toEqual([AGENT2]);
      expect(unboxed[0].machine).toBe(machine.id);
      expect(unboxed[0].id).toBe(`${machine.id}/agent-unboxed:${AGENT2}`);
      // It names the agent and it carries a fix a human can act on, which for
      // this one is a line to add to the file rather than a command to run.
      expect(unboxed[0].says).toContain(AGENT2);
      expect(typeof unboxed[0].fix).toBe("string");
      expect(unboxed[0].fix.length).toBeGreaterThan(0);
      // Not a refusal: the registry loaded and everything else about the run
      // happened, which is the half that separates a finding from a fence.
      expect(findings.some((one) => one.kind === "peak-missing")).toBe(true);

      // THE CONTROL. The same shape with a tree for both people produces none
      // of this finding, so it is the missing tree that fires it and not the
      // presence of two agents.
      const whole = await stageHub(cluster, {
        machines: [machine],
        people: [
          { id: PERSON, tree: "/var/lib/imprnt-hub/p1" },
          { id: PERSON2, tree: "/var/lib/imprnt-hub/p2" },
        ],
        agents: [
          { id: AGENT2, person: PERSON2, preset: "daily", chat: `${CHAT}1`, door: DOOR, runner: RUNNER },
        ],
        run: [
          { id: DOOR, kind: "door", machine: machine.id, platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
          { id: RUNNER, kind: "runner", machine: machine.id, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
        ],
      });
      const second = await superStore(cluster, whole.db);
      try {
        const clean = await check({
          machine: machine.id,
          registryFile: whole.registryFile,
          store: second,
          os: null,
          kernel: null,
        });
        expect(clean.filter((one) => one.kind === "agent-unboxed")).toEqual([]);
      } finally {
        await second.close().catch(() => {});
        await whole.stop();
      }
    } finally {
      await store.close().catch(() => {});
      await half.stop();
    }
  },
  SLOW,
);

test.skipIf(!gate.ok)(
  `SPEC §5 the agent's model child runs inside the kernel box: the runner hands the loop its boxing hook, the child is really spawned through ${
    process.platform === "darwin" ? "sandbox-exec with its profile already on disk" : "bwrap"
  }, and from inside itself that child is REFUSED the other person's marker while the same child unboxed reads it${
    gate.ok ? "" : ` [skipped: ${gate.reason}]`
  }`,
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const other = trees.other(PERSON);
    const marker = join(other.tree, other.marker);
    const mine = trees.person(PERSON);

    const it = await stageBoxed();
    let runner: { stop(): Promise<void> } | null = null;
    try {
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      await until(
        "the runner spawned the agent's child",
        () => it.scripted.spawns().length >= 1,
        60_000,
        () => `starts=${JSON.stringify(it.scripted.starts())}`,
      );
      const spawn = it.scripted.spawns()[0];

      // --- the hook reached the loop at all. A runner that computed a box and
      //     never handed it over fails here.
      expect(spawn.wrapped).toBe(true);

      // --- and what it spawned is the boxed argv, with the tool of this
      //     platform at the head of it.
      if (process.platform === "darwin") {
        expect(spawn.argv[0]).toBe("/usr/bin/sandbox-exec");
        // The profile is a FILE sandbox-exec opens. `boxCommand` computes its
        // path and its text and writes nothing, so a wiring that forgot to put
        // it on disk gets "cannot open profile" and a child that never starts.
        expect(spawn.profile).not.toBeNull();
        expect(spawn.profileExisted).toBe(true);
        const profile = readFileSync(spawn.profile!, "utf8");
        expect(profile).toContain(other.tree);
        expect(profile).toContain(mine.tree);
        expect(profile).toContain("(deny default)");
      } else {
        expect(spawn.argv[0]).toBe("/usr/bin/bwrap");
        expect(spawn.argv).toContain("--tmpfs");
        expect(spawn.argv).toContain(other.tree);
        // bwrap FORKS, so the spawned pid stays bwrap's and the manager's own
        // truth names it. This is the half of the planned probe that survives.
        expect(
          readFileSync(`/proc/${spawn.pid}/cmdline`, "utf8").replace(/\0/g, " "),
        ).toContain("bwrap");
      }

      // --- THE OUTCOME, which is what the box is for. The child says, from
      //     inside itself, what it could read of the other person's marker.
      await until(
        "the boxed child reported what it could read",
        () => spawn.child.boxProbe() !== null,
        60_000,
        () => `the child said nothing. pid ${spawn.pid}, argv ${spawn.argv.slice(0, 3).join(" ")}`,
      );
      const probe = spawn.child.boxProbe()!;
      expect(probe.probe).toBe(marker);
      expect(probe.saw).toBeNull();
      expect(typeof probe.refused).toBe("string");
      expect(probe.refused!.length).toBeGreaterThan(0);

      // --- THE CONTROL, beside it, in the same run: the same child with no box
      //     reads the same file. Without it a probe that failed for any other
      //     reason would score as the fence working.
      const open = spawnHolder({ probePath: marker });
      spares.push(open);
      await until(
        "the unboxed control child reported",
        () => open.boxProbe() !== null,
        30_000,
        () => "the control child said nothing",
      );
      expect(open.boxProbe()!.saw).toContain(PERSON2);
      expect(open.boxProbe()!.refused).toBeNull();
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

test.skipIf(!gate.ok)(
  `SPEC §5 a household that declares no trees runs its agents UNBOXED rather than refusing them: the runner hands the loop no hook, the child's argv is the loop's own, and it reads what a boxed one could not${
    gate.ok ? "" : ` [skipped: ${gate.reason}]`
  }`,
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    // The trees exist on disk, and the REGISTRY declares none of them. What
    // decides is the file, which is D-93's rule and is why this is the control
    // for the check above rather than a second copy of it.
    const other = trees.other(PERSON);
    const marker = join(other.tree, other.marker);

    const machine = thisMachine();
    const it = await stageHub(cluster, {
      adapter: { child: true, probePath: marker },
      machines: [machine],
      people: [{ id: PERSON }, { id: PERSON2 }],
      run: [
        { id: DOOR, kind: "door", machine: machine.id, platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: RUNNER, kind: "runner", machine: machine.id, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      ],
    });
    let runner: { stop(): Promise<void> } | null = null;
    try {
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      await until(
        "the runner spawned the agent's child",
        () => it.scripted.spawns().length >= 1,
        60_000,
        () => `starts=${JSON.stringify(it.scripted.starts())}`,
      );
      const spawn = it.scripted.spawns()[0];
      expect(spawn.wrapped).toBe(false);
      expect(spawn.argv[0]).toBe("bun");
      expect(spawn.profile).toBeNull();
      await until(
        "the unboxed child reported what it could read",
        () => spawn.child.boxProbe() !== null,
        60_000,
        () => `the child said nothing. pid ${spawn.pid}`,
      );
      expect(spawn.child.boxProbe()!.saw).toContain(PERSON2);
      expect(existsSync(marker)).toBe(true);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);
