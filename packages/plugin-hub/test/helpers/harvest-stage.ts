// Test infrastructure: the stage the harvest checks share.
//
// Three lines of staging with one non-obvious rule in each, written once here
// rather than repeated in three files.
//
//   1. A REAL vault, scaffolded by the real `imprnt init` with
//      `XDG_CONFIG_HOME` under scratch, so the filing every check drives is the
//      real `imprnt ingest --apply` against a real vault.
//   2. The shim of `test/helpers/imprnt-shim.ts` in `hub.imprnt`, which is what
//      makes that true on this Mac, on the hub box and in CI with no build step.
//   3. TWO presets whose derived ids DIFFER: `daily` is the agent's and
//      `harvest` is the harvester's, differing by model and by effort, so the
//      test's own oracle over the five fields computes two different sixteen
//      character ids and check 14's assertion is not satisfiable by accident.
//
// THE PERSON'S VAULT LIES INSIDE THEIR TREE, or the loader refuses the
// file, and every check that uses it would be red on a
// fixture rather than on the behaviour it names. So the tree is a scratch
// directory of this stage's own and the vault is the project `imprnt init`
// scaffolded under it.
//
// THE SCRATCH VAULT IS NOT NESTED inside another vault project, because
// `imprnt init` walks up from its target and refuses to nest. `mkdtemp` under
// the system temp directory is not one.
//
// Nothing here performs a step of the hub's own work. It makes a vault, a shim,
// a registry and a database, and every check starts the real door and the real
// runner itself.

import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Cluster } from "./cluster.ts";
import { writeImprntShim } from "./imprnt-shim.ts";
import { scratchVault, type ScratchVault } from "./scratch-vault.ts";
import { AGENT, PERSON, chatLogFile, stageHub, type StageOptions, type StagedHub } from "./hub-fixture.ts";
import type { PersonSpec, PresetSpec } from "./registry.ts";

/**
 * The harvester's preset. It differs from `daily` in MODEL and in EFFORT, which
 * are two of the five fields the id is derived from, so the two ids cannot
 * collide however the hash is computed.
 */
export const HARVESTER_PRESET: Record<string, string> = {
  adapter: "",
  model: "a-stronger-model-name",
  provider: "a-provider",
  effort: "high",
  paid: "plan",
};

/** The agent's own preset, as `stageHub` writes it, for the oracle to hash. */
export const AGENT_PRESET: Record<string, string> = {
  adapter: "",
  model: "a-model-name",
  provider: "a-provider",
  effort: "medium",
  paid: "plan",
};

export interface HarvestStage {
  hub: StagedHub;
  /** The directory that is the person's tree, holding the vault project. */
  tree: string;
  vault: ScratchVault;
  /** The `imprnt` command `hub.imprnt` names. */
  shim: string;
  /** The harvester preset as the file carries it, for the oracle. */
  harvesterPreset: Record<string, string>;
  /** The agent's preset as the file carries it, for the oracle. */
  agentPreset: Record<string, string>;
  stop(): Promise<void>;
}

export interface HarvestStageOptions extends StageOptions {
  /** The people this stage declares. The first is given the vault and tree. */
  harvestPeople?: PersonSpec[];
  /** Extra presets beside `daily` and `harvest`. */
  extraPresets?: Record<string, PresetSpec>;
  /**
   * The command `hub.imprnt` names, when this stage should not write its own.
   *
   * Check 10 hands the GATED shim here, which announces every apply and waits,
   * so the check can read the watermark sheet while one is in flight. An absent
   * option writes the plain shim, which is what every other stage gets.
   */
  shim?: string;
}

/**
 * One staged hub with a real vault, a real CLI and two distinguishable presets.
 *
 * `options.harvestPeople` replaces the default person entirely, and the first
 * entry is the one the vault and tree are filled in on when it names neither.
 */
export async function stageHarvest(
  cluster: Cluster,
  options: HarvestStageOptions = {},
): Promise<HarvestStage> {
  const tree = await mkdtemp(join(tmpdir(), "hub-harvest-tree-"));
  let vault: ScratchVault | null = null;
  try {
    vault = await scratchVault(tree);
    const { harvestPeople, extraPresets, registry, harvest, people, shim: given, ...rest } =
      options;
    const shim = given ?? writeImprntShim(tree);
    const made = vault;

    const hub = await stageHub(cluster, {
      ...rest,
      imprnt: shim,
      ...(harvestPeople
        ? {
            people: harvestPeople.map((one, nth) =>
              nth === 0 ? { tree, harvester: "harvest", vault: made.root, ...one } : one,
            ),
          }
        : {
            harvest: { harvester: "harvest", vault: made.root, ...(harvest ?? {}) },
            people: people ?? [{ id: "p1", tree, language: "en" }],
          }),
      registry: (base) => {
        const withPresets = {
          ...base,
          presets: {
            ...(base.presets ?? {}),
            harvest: { ...HARVESTER_PRESET, adapter: base.presets?.daily?.adapter as string },
            ...(extraPresets ?? {}),
          },
        };
        return registry ? registry(withPresets) : withPresets;
      },
    });

    const adapterName = hub.adapterName;
    return {
      hub,
      tree,
      vault: made,
      shim,
      harvesterPreset: { ...HARVESTER_PRESET, adapter: adapterName },
      agentPreset: { ...AGENT_PRESET, adapter: adapterName },
      async stop() {
        await hub.stop();
        await made.remove();
        await rm(tree, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    if (vault) await vault.remove().catch(() => {});
    await rm(tree, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** One line of a chat log, as the door writes one. */
export interface ChatLine {
  at: string;
  direction: "in" | "out";
  from: string;
  text: string;
}

/**
 * Plant one line into this stage's chat log, exactly as the door appends one.
 *
 * Four checks wrote this out and the four copies were byte-identical, which is
 * four places for the log's own shape to drift. The shape is the and is
 * pinned by `chatLogFile`: one dated file per agent, one JSON object per line,
 * dated by the LINE's own time in UTC.
 */
export function plantLine(stage: HarvestStage, line: ChatLine): ChatLine {
  const file = chatLogFile({
    stateDir: stage.hub.stateDir,
    person: PERSON,
    agent: AGENT,
    at: new Date(line.at),
  });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
  return line;
}
