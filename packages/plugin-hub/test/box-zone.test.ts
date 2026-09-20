// Check: the box carries no zone of its own. (SPEC §1, §6, L7, D-92, D-93)
//
// SPEC 1: "One shared zone mounted into every vault, sharing a note means moving
// it there." The zone is that mount: one checkout inside each person's own
// vault, at `<vault>/vault/<mount>`. An ordinary turn already writes that tree
// and a harvest already reads it, so the box needs no grant for the zone and
// carries no field, no profile line, no hash input and no sweep root for one.
// SPEC 6's Forbidden carries "a setting nothing in production reads", which is
// what a household directory nothing provisions and no phase fills would be.
//
// PURE FOR THE FIRST THREE, NOTHING EXECUTED, BOTH FLAVOURS PRODUCED ON
// WHICHEVER BOX RUNS THIS. `boxCommand` takes the flavour as an argument, the
// way check 16 already asks for it, so the macOS profile is readable on Linux
// and the assertions below need no gate. The fourth starts a throwaway cluster,
// because the sweep it is about is reported by `runCheck`.
//
// THE CONTROL EVERY ASSERTION CARRIES is the same one: the coverage did not
// shrink. A zone checkout is inside a person's tree, so what the profile grants
// and what the sweep reads still reach it, and each assertion below proves that
// on the same path it proves the absence on.
//
// Which of the six protected windows this could reach: none. Nothing here
// starts a door, a runner or a cluster of agents.
//
// Red reason: behaviour absent. The box reads a zone setting into its context,
// grants it in the macOS profile, hashes it into the profile's name, and
// `check` sweeps it as a root of its own.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import { fakeProber } from "./helpers/prober.ts";
import { PERSON, PERSON2, stageHub, superStore } from "./helpers/hub-fixture.ts";
import { plantTrees } from "./helpers/trees.ts";
import { writeRegistry, type RegistrySpec } from "./helpers/registry.ts";
import { loadRegistry } from "../src/registry/load.ts";

const SLOW = 90_000;
const PROBE = ["/bin/sh", "-c", "echo the command the loop would have run"];

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** Every path an `(allow ...)` rule names, and the rules that name none. */
function allowed(profile: string): { paths: string[]; pathless: string[] } {
  const paths: string[] = [];
  const pathless: string[] = [];
  for (const raw of profile.split("\n")) {
    const rule = raw.trim();
    if (!rule.startsWith("(allow ")) continue;
    const named = [...rule.matchAll(/\((?:subpath|literal)\s+"([^"]*)"\)/g)].map((m) => m[1]);
    if (named.length === 0) {
      // A rule with no path filter grants its whole operation, so one that
      // touches a file operation is the hole every assertion below would miss.
      if (/file-read|file-write|file\*/.test(rule)) pathless.push(rule);
      continue;
    }
    paths.push(...named);
  }
  return { paths, pathless };
}

/** The household's shape under one scratch directory, with no zone setting. */
function stage(): { root: string; registryFile: string; household: string; stateDir: string; trees: ReturnType<typeof plantTrees> } {
  const trees = plantTrees(mkdtempSync(join(tmpdir(), "hub-boxzone-")));
  const root = trees.dir;
  // A household directory the registry does not name, planted so "no grant
  // reaches it" is an assertion about a real path rather than about a string.
  const household = join(root, "household");
  const stateDir = join(root, "state");
  mkdirSync(household, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(household, "a-note.txt"), "the household directory nothing declares\n", "utf8");
  const spec: RegistrySpec = {
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: stateDir },
    machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
    people: trees.people.map((p) => ({ id: p.id, tree: p.tree, vault: p.tree })),
    credentials: [{ id: "household-claude", kind: "claude-login", file: "/dev/null", owner: "household" }],
    presets: {
      daily: { adapter: "scripted", model: "m", provider: "p", effort: "medium", paid: "key" },
    },
    agents: trees.people.map((p, n) => ({
      id: `${p.id}-lair`, person: p.id, preset: "daily",
      chat: `000000000${n}`, door: "door-fake", runner: "runner-pi",
    })),
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ],
  };
  return { root, registryFile: writeRegistry(root, spec), household, stateDir, trees };
}

test(
  "ROLL-27 the box carries no zone of its own: the context has no zone key, the macOS profile names no path the context does not, the profile hash is the same for a file that still carries the retired line, and the person's own zone checkout is reached through the grant on their tree (SPEC §1, §6, L7)",
  async () => {
    const { boxCommand, boxContextFor } = await seam("src/box/index.ts");
    expect(typeof boxCommand).toBe("function");
    expect(typeof boxContextFor).toBe("function");

    const it = stage();
    try {
      const registry = loadRegistry(it.registryFile);
      const p1 = it.trees.person("p1");
      const ctx = (boxContextFor as Function)(registry, "p1-lair") as Record<string, unknown>;

      // --- 1. no zone key at all, asserted against the WHOLE key set, so a
      //     build that kept the field holding an empty string fails here.
      expect(Object.keys(ctx)).not.toContain("sharedZone");
      expect(Object.keys(ctx).sort()).toEqual(
        ["agent", "otherStateRoots", "otherTrees", "person", "secretPaths", "stateRoot", "tree", "writePaths"].sort(),
      );

      // --- 2. the profile grants nothing the context does not name.
      const built = (boxCommand as Function)(PROBE, { ...ctx, platform: "darwin" }, "darwin") as {
        profile?: { path: string; text: string };
      };
      const profile = built.profile!.text;
      const grants = allowed(profile);
      // The only rule that grants a file operation without naming a path is the
      // metadata one, measured: the loop does not start without it and it hands
      // over no path a person's files are under.
      expect(grants.pathless).toEqual(["(allow file-read-metadata)"]);
      // Nothing reaches the planted household directory.
      for (const path of grants.paths) {
        expect(it.household === path || it.household.startsWith(`${path}/`)).toBe(false);
      }
      // And under this household's own root the grant set is EXACTLY what the
      // context carries, read off the context rather than written out here, so
      // the assertion tracks the build instead of a literal.
      const under = (path: string) => path === it.root || path.startsWith(`${it.root}/`);
      const fromContext = [ctx.tree as string, ctx.stateRoot as string, ...((ctx.writePaths as string[]) ?? [])]
        .filter((path) => path !== "" && under(path));
      expect([...new Set(grants.paths.filter(under))].sort()).toEqual([...new Set(fromContext)].sort());

      // The CONTROL, and the whole reason the grant above is enough: this
      // person's own zone checkout is inside their tree, so the tree's grant
      // reaches it and the mount costs the box nothing.
      expect(p1.zonePath.startsWith(`${ctx.tree as string}/`)).toBe(true);
      expect(profile).toContain(`(subpath ${JSON.stringify(ctx.tree)})`);
      // The other person's checkout of the same zone is inside the tree the
      // profile denies, so it is denied with it.
      expect(profile).toContain(`(subpath ${JSON.stringify(it.trees.person("p2").tree)})`);

      // --- 3. the profile's name is a hash of what the box renders, and a file
      //     that still carries the retired line renders the same box. The name
      //     is the only way to ask without reaching into a private function.
      const stale = join(it.root, "still-carries-the-line.toml");
      writeFileSync(
        stale,
        readFileSync(it.registryFile, "utf8").replace("[hub]", `[hub]\nshared_zone = ${JSON.stringify(it.household)}`),
        "utf8",
      );
      const staleRegistry = loadRegistry(stale);
      const staleCtx = (boxContextFor as Function)(staleRegistry, "p1-lair") as Record<string, unknown>;
      const staleBuilt = (boxCommand as Function)(PROBE, { ...staleCtx, platform: "darwin" }, "darwin") as {
        profile?: { path: string; text: string };
      };
      expect(staleBuilt.profile!.path).toBe(built.profile!.path);
      expect(staleBuilt.profile!.text).toBe(profile);
    } finally {
      rmSync(it.root, { recursive: true, force: true });
    }
  },
);

test(
  "ROLL-27 a reader that asks for the retired zone setting fails at run time, and a file that still carries the line loads (SPEC §6, L14)",
  async () => {
    const { readSetting, SETTING_FIELDS, UnknownSetting } = await seam("src/registry/load.ts");
    expect((SETTING_FIELDS as { key: string }[]).map((field) => field.key)).not.toContain("hub.shared_zone");

    const it = stage();
    try {
      // The loader walks the settings it declares and never the file's own
      // keys, so a key it has no rule about is inert and the file still loads.
      // The refusal is at READ time, which is where "it does not exist" is a
      // behaviour rather than a spelling.
      const stale = join(it.root, "still-carries-the-line.toml");
      writeFileSync(
        stale,
        readFileSync(it.registryFile, "utf8").replace("[hub]", '[hub]\nshared_zone = "/somewhere"'),
        "utf8",
      );
      const registry = loadRegistry(stale);
      expect(registry.agents.map((agent) => agent.id).sort()).toEqual(["p1-lair", "p2-lair"]);

      let refusal: unknown;
      try {
        (readSetting as Function)(registry, "hub.shared_zone");
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(UnknownSetting as Function);
      expect((refusal as { key: string }).key).toBe("hub.shared_zone");

      // The control: a setting that IS declared still reads back off the same
      // file, so the refusal above is about this key and not about the reader.
      expect((readSetting as Function)(registry, "hub.state_dir")).toBe(it.stateDir);
    } finally {
      rmSync(it.root, { recursive: true, force: true });
    }
  },
);

test(
  "ROLL-27 a launch computes its mask set without a zone: nothing of a household directory the file still names reaches the boxed command, and the set is the same whether or not the person's zone checkout is on disk (SPEC §1, L7)",
  async () => {
    const { makeLoopLaunch } = await seam("src/adapters/launch.ts");
    const { boxContextFor } = await seam("src/box/index.ts");

    const it = stage();
    try {
      // A real login file, because the launch opens one, and a registry that
      // STILL carries the retired line, because the point is that it is inert.
      const loginDir = join(it.root, "login");
      mkdirSync(loginDir, { recursive: true });
      const login = join(loginDir, ".credentials.json");
      writeFileSync(login, JSON.stringify({ claudeAiOauth: { accessToken: "synthetic", refreshToken: "synthetic", expiresAt: 0 } }), "utf8");
      const file = join(it.root, "with-a-login.toml");
      writeFileSync(
        file,
        readFileSync(it.registryFile, "utf8")
          .replace("[hub]", `[hub]\nshared_zone = ${JSON.stringify(it.household)}`)
          .replace('adapter = "scripted"', 'adapter = "claude-code"\ncredential = "household-claude"')
          .replace('file = "/dev/null"\nowner = "household"', `file = ${JSON.stringify(login)}\nowner = "household"`),
        "utf8",
      );
      const registry = loadRegistry(file);
      const agent = registry.agents.find((one) => one.id === "p1-lair")!;
      const sessionDir = join(it.root, "session");
      const box = (boxContextFor as Function)(registry, "p1-lair");

      const launch = async () =>
        (await (makeLoopLaunch as Function)({
          registry, agent, preset: registry.presets.daily, purpose: "ordinary",
          credential: { id: "household-claude", kind: "claude-login", file: login, owner: "household" },
          sessionDir, box,
        })) as { cwd: string; wrap(argv: string[]): string[] };

      const rendered = async (): Promise<string> => {
        const made = await launch();
        const boxFile = join(made.cwd, "box.sb");
        const sb = process.platform === "darwin" ? readFileSync(boxFile, "utf8") : "";
        return JSON.stringify(made.wrap(PROBE)) + sb;
      };

      // The household directory the file still names reaches nothing the launch
      // renders, on either flavour.
      const withCheckout = await rendered();
      expect(withCheckout).not.toContain(it.household);

      // And the set does not move when the zone checkout is taken off disk:
      // the checkout is inside the tree, and the tree is already a path the
      // launch must be able to reach.
      rmSync(it.trees.person("p1").zonePath, { recursive: true, force: true });
      const withoutCheckout = await rendered();
      expect(withoutCheckout).toBe(withCheckout);
      // The control: the tree itself IS in what the launch renders, so the
      // comparison above is between two live renderings and not two empties.
      expect(withCheckout).toContain(it.trees.person("p1").tree);
    } finally {
      rmSync(it.root, { recursive: true, force: true });
    }
  },
  SLOW,
);

test(
  "ROLL-27 check sweeps no zone root of its own, and loses no coverage doing it: a copy inside a household directory the file still names is not reported, while the same copy inside a person's own zone checkout is (SPEC §6, L10 rule 1)",
  async () => {
    const { runCheck } = await seam("src/check/run.ts");

    const home = mkdtempSync(join(tmpdir(), "hub-zone-sweep-"));
    const at = (...parts: string[]) => join(home, ...parts);
    for (const one of ["p1", "p2", "state", "credentials"]) mkdirSync(at(one), { recursive: true });
    // The zone is a checkout inside each person's own vault. The household
    // directory beside the trees is there so the file below can still carry a
    // line naming it, and the sweep must read nothing from that line.
    const zone = at("p1", "vault", "shared-notes");
    const household = at("household");
    for (const one of [zone, household]) mkdirSync(one, { recursive: true });

    const secret = `token-${crypto.randomUUID()}${crypto.randomUUID()}`;
    const declared = at("credentials", "claude.json");
    writeFileSync(declared, JSON.stringify({ claudeAiOauth: { accessToken: secret, expiresAt: 0 } }), "utf8");

    const staged = await stageHub(cluster, {
      machines: [{ id: "pi", os: "linux" }],
      hub: { shared_zone: household, state_dir: at("state") },
      people: [
        { id: PERSON, language: "en", tree: at("p1") },
        { id: PERSON2, language: "en", tree: at("p2") },
      ],
      credentials: [{ id: "household-claude", kind: "claude-login", file: declared, owner: "household" }],
      preset: { credential: "household-claude" },
      run: [
        { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      ],
      registry: (base) => ({
        ...base,
        agents: (base.agents ?? []).map((one) => ({ ...one, runner: "runner-pi" })),
      }),
    });
    const store = await superStore(cluster, staged.db);
    const prober = fakeProber({ "household-claude": { ok: true } }, { "household-claude": [secret] });
    const copies = async (): Promise<string[]> =>
      ((await (runCheck as Function)({
        machine: "pi", registryFile: staged.registryFile, store, os: null, kernel: null, credentials: prober,
      })) as { kind: string; subject: string }[])
        .filter((one) => one.kind === "credential-copy")
        .map((one) => one.subject);

    try {
      // The control FIRST: with no copy anywhere, nothing is reported, so an
      // empty answer below is an answer about roots and not about the sweep.
      expect(await copies()).toEqual([]);

      // The file still carries a line naming this directory, and the sweep
      // reads nothing from it: the roots are the people's trees, the state dir
      // and each declared credential's own directory.
      const outside = join(household, "handover.json");
      writeFileSync(outside, `{"token": "${secret}"}`, "utf8");
      expect(await copies()).toEqual([]);

      // THE COVERAGE CONTROL: the same copy inside the person's own zone
      // checkout IS reported, because the checkout is inside the tree and every
      // person's tree is a root. Dropping the zone root loses nothing.
      const inZone = join(zone, "handover.json");
      writeFileSync(inZone, `{"token": "${secret}"}`, "utf8");
      const found = await copies();
      expect(found).toContain(inZone);
      expect(found).not.toContain(outside);
    } finally {
      await store.close();
      await staged.stop();
      rmSync(home, { recursive: true, force: true });
    }
  },
  SLOW,
);
