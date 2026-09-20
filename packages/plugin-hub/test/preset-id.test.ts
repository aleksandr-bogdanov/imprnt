// LOOP-01. The preset id is derived, never typed, and an agent points at one.
//
// SPEC §3: "The preset ID is computed from the settings, never typed. Identical
// settings share an ID." Its Forbidden list carries "a typed preset ID".
//
// These three touch no Postgres. A preset is a table in a file and its id is a
// hash of five strings, so a database would add a dependency without adding a
// probe.
//
// Red reasons: import missing, src/registry/presets.ts, for the first. Behaviour
// absent, src/registry/load.ts does not yet refuse a typed preset id, for the
// second. Export missing, listAgents and agentsFor in src/registry/entries.ts,
// for the third.

import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { scratchDir } from "./helpers/hub-fixture.ts";
/** The pinned formula, computed by the test rather than read from the build. */
import { expectedPresetId } from "./helpers/preset-oracle.ts";

const BASE = {
  adapter: "an-adapter",
  effort: "medium",
  model: "a-model-name",
  paid: "plan",
  provider: "a-provider",
};

test("LOOP-01 the preset id is derived from its settings and changes when any one of the five changes, and it matches the pinned formula computed outside the code under test (SPEC §3, L18)", async () => {
  const { presetId, PRESET_FIELDS } = await seam("src/registry/presets.ts");
  expect(typeof presetId).toBe("function");

  // The five settings the id is over, so a build that hashes four of them is
  // caught by the loop below rather than by a reading.
  expect([...(PRESET_FIELDS as string[])].sort()).toEqual([
    "adapter",
    "effort",
    "model",
    "paid",
    "provider",
  ]);

  // Bound to the formula rather than to itself.
  const base = (presetId as Function)(BASE) as string;
  expect(base).toBe(expectedPresetId(BASE));
  expect(base.length).toBe(16);
  expect(base).toMatch(/^[0-9a-f]{16}$/);

  // THE LOAD, probed once per setting. "Change one setting and the ID changes"
  // has no exception, and a build that hashes four of the five passes any check
  // that varies only the fifth.
  for (const field of ["adapter", "effort", "model", "paid", "provider"]) {
    const changed = { ...BASE, [field]: `${BASE[field as keyof typeof BASE]}-x` };
    const id = (presetId as Function)(changed) as string;
    expect(id).not.toBe(base);
    expect(id).toBe(expectedPresetId(changed as typeof BASE));
  }

  // THE CONTROL, and it is only a control: any pure function of the settings
  // satisfies it. Two presets with identical settings written under different
  // names and with their keys in a different order share one id.
  const reordered = {
    provider: BASE.provider,
    paid: BASE.paid,
    model: BASE.model,
    effort: BASE.effort,
    adapter: BASE.adapter,
  };
  expect((presetId as Function)(reordered)).toBe(base);
});

test("LOOP-01 a typed preset ID is refused: a presets table carrying an id key refuses the whole registry and names that line, and the same file without it loads with the derived id (SPEC §3 Forbidden, L18)", async () => {
  // The tagged red reason. src/registry/load.ts is shipped and imports cleanly,
  // so this asserts the specific new refusal and is read before any seam that
  // is merely absent.
  const { loadRegistry, RegistryRefused } = await seam("src/registry/load.ts");
  expect(typeof loadRegistry).toBe("function");

  const dir = await scratchDir("hub-preset-");
  try {
    const good = [
      "# the hub's registry",
      "",
      "[hub]",
      "tick_seconds = 5",
      'store_url = "postgres://127.0.0.1:5432/hub"',
      'state_dir = "/var/lib/imprnt-hub"',
      "tail_hours = 24",
      "tail_tokens = 8000",
      "claim_lease_seconds = 300",
      "",
      "[presets.daily]",
      'adapter = "an-adapter"',
      'model = "a-model-name"',
      'provider = "a-provider"',
      'effort = "medium"',
      'paid = "plan"',
      // The three window thresholds are required
      // on every plan preset, by name.
      "window_pause_at = 85",
      "window_notice_at = 95",
      "window_hold_at = 100",
      "",
      "[[run]]",
      'id = "runner-pi"',
      'kind = "runner"',
      'schedule = "always"',
      "memory_limit_mb = 512",
      // Required on every runner entry, machines
      // declared or not. Below every line this check numbers.
      "child_memory_limit_mb = 512",
      "",
    ];

    const typed = [...good];
    const typedLine = 'id = "0f3a1c9d2b7e4a55"';
    typed.splice(typed.indexOf('paid = "plan"') + 1, 0, typedLine);
    const badLine = typed.indexOf(typedLine) + 1;
    const bad = join(dir, "typed-id.toml");
    writeFileSync(bad, typed.join("\n"), "utf8");

    let refusal: unknown;
    try {
      (loadRegistry as Function)(bad);
    } catch (err) {
      refusal = err;
    }
    // Refusing the file rather than ignoring the key is the point: a typed id
    // silently dropped looks like it worked and disagrees with the derived one
    // on the next turn, and the ledger then holds two ids for one preset with
    // nothing saying which is true.
    expect(refusal).toBeInstanceOf(RegistryRefused as Function);
    expect((refusal as { line: number }).line).toBe(badLine);
    expect((refusal as { key: string }).key).toBe("presets.daily.id");
    expect(String((refusal as Error).message)).toContain(String(badLine));
    // The reason a human reads names the offending key, so the refusal is
    // about THIS key rather than about something being wrong somewhere.
    expect(String((refusal as { reason: string }).reason)).toContain("id");

    // THE NARROWING CONTROL. Without it a loader that refuses ANY unknown key
    // inside a preset table passes the half above while refusing nothing the
    // rule names. The same table carrying an unrelated key nobody reads still
    // loads, so what is refused is the typed id and not novelty.
    const unrelated = [...good];
    const unrelatedLine = 'note = "a key nobody reads"';
    unrelated.splice(unrelated.indexOf('paid = "plan"') + 1, 0, unrelatedLine);
    const tolerated = join(dir, "unrelated-preset-key.toml");
    writeFileSync(tolerated, unrelated.join("\n"), "utf8");
    const loaded = (loadRegistry as Function)(tolerated) as {
      data: Record<string, unknown>;
    };
    expect(
      (
        (loaded.data.presets as Record<string, Record<string, string>>).daily
      ).model,
    ).toBe("a-model-name");

    // The control: the same file with the key removed loads, and the id that
    // comes back is the derived one.
    const { getPreset, presetId } = await seam("src/registry/presets.ts");
    expect(typeof getPreset).toBe("function");
    const clean = join(dir, "derived-id.toml");
    writeFileSync(clean, good.join("\n"), "utf8");
    const registry = (loadRegistry as Function)(clean);
    const preset = (getPreset as Function)(registry, "daily") as Record<
      string,
      string
    >;
    expect(preset.model).toBe("a-model-name");
    expect((presetId as Function)(preset)).toBe(
      expectedPresetId({
        adapter: "an-adapter",
        effort: "medium",
        model: "a-model-name",
        paid: "plan",
        provider: "a-provider",
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LOOP-01 an agent points at one preset and the file says which pieces serve it: listAgents returns exactly the agents named, agentsFor answers for a door and for a runner, and an agent naming a preset the file does not define refuses it by line (SPEC §3, L18, and L14's loud refusal)", async () => {
  // The tagged red reason: src/registry/entries.ts is shipped and lacks these.
  const { listAgents, agentsFor } = await seam("src/registry/entries.ts");
  expect(typeof listAgents).toBe("function");
  expect(typeof agentsFor).toBe("function");
  const { loadRegistry, RegistryRefused } = await seam("src/registry/load.ts");

  const dir = await scratchDir("hub-agents-");
  try {
    const good = [
      "[hub]",
      "tick_seconds = 5",
      'store_url = "postgres://127.0.0.1:5432/hub"',
      'state_dir = "/var/lib/imprnt-hub"',
      "tail_hours = 24",
      "tail_tokens = 8000",
      "claim_lease_seconds = 300",
      "",
      "[presets.daily]",
      'adapter = "an-adapter"',
      'model = "a-model-name"',
      'provider = "a-provider"',
      'effort = "medium"',
      'paid = "plan"',
      // The three window thresholds are required
      // on every plan preset, by name.
      "window_pause_at = 85",
      "window_notice_at = 95",
      "window_hold_at = 100",
      "",
      "[[agents]]",
      'id = "p1-lair"',
      'person = "p1"',
      'preset = "daily"',
      'chat = "1000000001"',
      'door = "door-telegram"',
      'runner = "runner-pi"',
      "",
      "[[agents]]",
      'id = "p2-lair"',
      'person = "p2"',
      'preset = "daily"',
      'chat = "1000000002"',
      'door = "door-discord"',
      'runner = "runner-mac"',
      "",
      "[[run]]",
      'id = "door-telegram"',
      'kind = "door"',
      'platform = "telegram"',
      'person = "p1"',
      'token_file = "/dev/null"',
      'schedule = "always"',
      "memory_limit_mb = 192",
      "",
      "[[run]]",
      'id = "door-discord"',
      'kind = "door"',
      'platform = "discord"',
      'person = "p2"',
      'token_file = "/dev/null"',
      'schedule = "always"',
      "memory_limit_mb = 192",
      "",
      "[[run]]",
      'id = "runner-pi"',
      'kind = "runner"',
      'schedule = "always"',
      "memory_limit_mb = 512",
      "child_memory_limit_mb = 512",
      "",
      "[[run]]",
      'id = "runner-mac"',
      'kind = "runner"',
      'schedule = "always"',
      "memory_limit_mb = 512",
      "child_memory_limit_mb = 2048",
      "",
    ];
    const file = join(dir, "agents.toml");
    writeFileSync(file, good.join("\n"), "utf8");
    const registry = (loadRegistry as Function)(file);

    // The id set is compared both ways, so an extra entry fails as well as a
    // missing one.
    const agents = (listAgents as Function)(registry) as Record<string, string>[];
    expect(new Set(agents.map((a) => a.id))).toEqual(
      new Set(["p1-lair", "p2-lair"]),
    );
    expect(agents.length).toBe(2);
    const first = agents.find((a) => a.id === "p1-lair")!;
    expect(first).toMatchObject({
      id: "p1-lair",
      person: "p1",
      preset: "daily",
      chat: "1000000001",
      door: "door-telegram",
      runner: "runner-pi",
    });

    // How a door and a runner learn what they serve, without argv.
    expect(
      ((agentsFor as Function)(registry, { door: "door-telegram" }) as {
        id: string;
      }[]).map((a) => a.id),
    ).toEqual(["p1-lair"]);
    expect(
      ((agentsFor as Function)(registry, { runner: "runner-mac" }) as {
        id: string;
      }[]).map((a) => a.id),
    ).toEqual(["p2-lair"]);
    expect(
      ((agentsFor as Function)(registry, { door: "door-nobody-named" }) as {
        id: string;
      }[]).length,
    ).toBe(0);

    // THE LOAD. Without it a typo in an agent's preset name is discovered at
    // the first turn of the day, in a place with no line number to fix, which
    // is the exact failure the loud-refusal rule exists for.
    const broken = [...good];
    const at = broken.indexOf('preset = "daily"');
    broken[at] = 'preset = "a-preset-nobody-defined"';
    const badLine = at + 1;
    const badFile = join(dir, "missing-preset.toml");
    writeFileSync(badFile, broken.join("\n"), "utf8");

    let refusal: unknown;
    try {
      (loadRegistry as Function)(badFile);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(RegistryRefused as Function);
    expect((refusal as { line: number }).line).toBe(badLine);
    expect((refusal as { key: string }).key).toContain("preset");
    expect(String((refusal as Error).message)).toContain(
      "a-preset-nobody-defined",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
