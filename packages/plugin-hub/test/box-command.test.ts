// STORE-07. The boxed command is derived from the registry, and its order is
// load-bearing. (SPEC §1, L7)
//
// L7: "each agent runs in a kernel-enforced box that can reach its own person's
// tree and nothing else", "the boundary is the person", "one shared zone is
// mounted into every vault", and Forbidden: "a shared zone for a subset of
// people". The zone is ONE household setting, so a subset zone is
// unwriteable rather than merely discouraged.
//
// PURE, BOTH PLATFORMS, NOTHING EXECUTED. This is what survives when check 15's
// gate is closed on a box with no user namespaces, and it is the half that can
// assert the ORDER, which no outcome can: `--proc /proc` before `--dev-bind / /`
// produces a box that looks exactly like a working one from the outside and
// hides nothing, because the host's `/proc` is bound back over the namespace's
// (measured, and v2's notes agree).
//
// THE FLAVOUR IS SUPPLIED, deliberately. `boxCommand(argv, ctx)` carries no
// flavour selector of its own, while BOTH flavours have to be produced from
// one registry on whichever box runs the check, with no branch on
// process.platform in the test.
// The two cannot both be true, so the check supplies the platform in both of the
// places a build could reasonably read it (a third argument, and a field on the
// context) and asserts `tool`, which is the pinned field that says which flavour
// came back.
//
// Red reason: import missing, src/box/index.ts.

import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { plantTrees } from "./helpers/trees.ts";
import { writeRegistry, type RegistrySpec } from "./helpers/registry.ts";
import { loadRegistry } from "../src/registry/load.ts";

const PROBE = ["/bin/sh", "-c", "echo the command the loop would have run"];

// ---------------------------------------------------------------------------
// Reading a sandbox profile as RULES rather than as text.
//
// the first shape of this check asserted that no allow
// rule named the other tree by its exact path, and that a profile carrying a
// BARE `(allow file-read*)` also carried a deny. `(allow file-read* (subpath
// "/"))` is neither of those and grants the other tree through an ancestor, and
// so does an allow on the scratch directory both trees sit in. The kernel
// resolves a subpath to everything under it, so the check has to as well.
// ---------------------------------------------------------------------------

/** Every top-level `(<head> ...)` form, with nesting and strings honoured. */
function forms(text: string, head: string): string[] {
  const out: string[] = [];
  const opens = new RegExp(`^\\s*${head}(\\s|\\)|$)`);
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "(") continue;
    if (!opens.test(text.slice(i + 1, i + 40))) continue;
    let depth = 0;
    let quoted = false;
    let j = i;
    for (; j < text.length; j += 1) {
      const c = text[j];
      if (quoted) {
        if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(text.slice(i, j + 1));
    i = j;
  }
  return out;
}

interface Grant {
  /** The whole rule, for a readable failure. */
  rule: string;
  /** `subpath` grants everything under it, `literal` grants exactly it. */
  kind: "subpath" | "literal" | "regex" | "everything";
  path: string;
}

/** Every path a file-READ allow grants, however the rule spells it. */
function readGrants(profile: string): Grant[] {
  const out: Grant[] = [];
  for (const rule of forms(profile, "allow")) {
    const head = rule.slice(1, rule.indexOf("(", 1) < 0 ? rule.length - 1 : rule.indexOf("(", 1));
    const operations = head.trim().split(/\s+/).slice(1);
    const reads = operations.some((op) => /^(default|file\*|file-read)/.test(op));
    if (!reads) continue;
    const filters = [...rule.matchAll(/\((subpath|literal|regex)\s+"([^"]*)"\)/g)];
    if (filters.length === 0) {
      // No filter at all: this rule grants the whole file system.
      out.push({ rule, kind: "everything", path: "/" });
      continue;
    }
    for (const [, kind, path] of filters) {
      out.push({ rule, kind: kind as Grant["kind"], path });
    }
  }
  return out;
}

/** Whether a grant reaches a path: the ancestor question, spelled out. */
function reaches(grant: Grant, path: string): boolean {
  if (grant.kind === "everything") return true;
  if (grant.kind === "literal") return grant.path === path;
  if (grant.kind === "regex") return true;
  const base = grant.path.endsWith("/") ? grant.path.slice(0, -1) : grant.path;
  return path === base || path.startsWith(`${base}/`);
}

function stage(people: string[]): {
  dir: string;
  registryFile: string;
  trees: ReturnType<typeof plantTrees>;
} {
  const dir = mkdtempSync(join(tmpdir(), "hub-boxcmd-"));
  const trees = plantTrees(dir, people);
  const spec: RegistrySpec = {
    hub: {
      store_url: "postgres://127.0.0.1:5432/hub",
      state_dir: dir,
      shared_zone: trees.sharedZone,
    },
    machines: [
      { id: "pi", os: "linux" },
      { id: "mac", os: "macos" },
    ],
    people: trees.people.map((p) => ({ id: p.id, tree: p.tree })),
    presets: {
      daily: { adapter: "scripted", model: "m", provider: "p", effort: "medium", paid: "plan" },
    },
    agents: trees.people.map((p, n) => ({
      id: `${p.id}-lair`,
      person: p.id,
      preset: "daily",
      chat: `000000000${n}`,
      door: "door-fake",
      runner: "runner-pi",
    })),
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: people[0], token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ],
  };
  return { dir, registryFile: writeRegistry(dir, spec), trees };
}

test(
  "STORE-07 the box is derived from the registry and its order is load-bearing: otherTrees is every OTHER declared person and never the agent's own, --proc /proc comes after --dev-bind / /, there is no --unshare-net, and the macOS profile denies by default while REACHING the agent's own tree and the one shared zone and no path that the other person's tree sits under (SPEC §1, L7, D-92, D-93)",
  async () => {
    const { boxCommand, boxContextFor, BoxUnavailable } = await seam("src/box/index.ts");
    expect(typeof boxCommand).toBe("function");
    expect(typeof boxContextFor).toBe("function");
    expect(typeof BoxUnavailable).toBe("function");

    const contextFor = boxContextFor as (
      registry: unknown,
      agent: string,
    ) => {
      agent: string;
      person: string;
      tree: string;
      sharedZone: string;
      otherTrees: string[];
    };
    const build = boxCommand as (
      argv: string[],
      ctx: Record<string, unknown>,
      platform?: string,
    ) => { argv: string[]; profile?: { path: string; text: string }; tool: string };

    const two = stage(["p1", "p2"]);
    try {
      const registry = loadRegistry(two.registryFile);
      const p1 = two.trees.person("p1");
      const p2 = two.trees.person("p2");

      // --- the context comes from the FILE, all four of its facts.
      const ctx = contextFor(registry, "p1-lair");
      expect(ctx.agent).toBe("p1-lair");
      expect(ctx.person).toBe("p1");
      expect(ctx.tree).toBe(p1.tree);
      expect(ctx.sharedZone).toBe(two.trees.sharedZone);
      // Every OTHER declared person, and never the agent's own. A box that
      // masked its own tree would be a box the agent cannot work in, and one
      // that forgot another person is the leak this criterion exists to catch.
      expect(ctx.otherTrees).toEqual([p2.tree]);
      expect(ctx.otherTrees).not.toContain(p1.tree);

      const mirror = contextFor(registry, "p2-lair");
      expect(mirror.tree).toBe(p2.tree);
      expect(mirror.otherTrees).toEqual([p1.tree]);

      // --- the linux flavour, produced on whichever box this runs.
      const linux = build(PROBE, { ...ctx, platform: "linux" }, "linux");
      expect(linux.tool).toBe("bwrap");
      const argv = linux.argv;
      expect(argv[0]).toBe("/usr/bin/bwrap");
      expect(argv).toContain("--unshare-pid");
      expect(argv).toContain("--die-with-parent");

      // The whole host is bound read-only, with a fresh /dev on top.
      const hostBind = argv.findIndex(
        (a, i) => a === "--ro-bind" && argv[i + 1] === "/" && argv[i + 2] === "/",
      );
      expect(hostBind).toBeGreaterThanOrEqual(0);
      const dev = argv.findIndex((a, i) => a === "--dev" && argv[i + 1] === "/dev");
      expect(dev).toBeGreaterThan(hostBind);
      const proc = argv.findIndex((a, i) => a === "--proc" && argv[i + 1] === "/proc");
      expect(proc).toBeGreaterThanOrEqual(0);
      // THE ORDER ASSERTION, by index. Reversed, the host's /proc is bound back
      // over the namespace's and the pid namespace hides nothing, which is a box
      // that passes every outcome check because the outcome is read through the
      // same /proc.
      expect(proc).toBeGreaterThan(hostBind);

      const tmpfsAt = argv
        .map((a, i) => (a === "--tmpfs" ? argv[i + 1] : null))
        .filter((a): a is string => a !== null);
      // One --tmpfs per other tree, over that tree.
      expect(tmpfsAt.filter((path) => !path.startsWith("/run/"))).toEqual([p2.tree]);
      // The user runtime directory and the system bus directory are masked too,
      // on a machine that has them. Naming one that is not there would fail
      // every boxed launch, because bwrap cannot make a mount point under the
      // read-only host.
      for (const path of ["/run/user", "/run/dbus"]) {
        if (existsSync(path)) expect(tmpfsAt).toContain(path);
        else expect(tmpfsAt).not.toContain(path);
      }

      // No --unshare-net: the loop needs the model API and the tailnet, so a
      // network namespace here breaks the hub rather than fencing it.
      expect(argv).not.toContain("--unshare-net");

      // `--` then the original argv, unchanged, at the end.
      const sep = argv.lastIndexOf("--");
      expect(sep).toBeGreaterThan(proc);
      expect(argv.slice(sep + 1)).toEqual(PROBE);

      // --- the darwin flavour, from the same registry on the same box.
      const mac = build(PROBE, { ...ctx, platform: "darwin" }, "darwin");
      expect(mac.tool).toBe("sandbox-exec");
      expect(mac.argv[0]).toBe("/usr/bin/sandbox-exec");
      expect(mac.argv).toContain("-f");
      expect(mac.argv.slice(mac.argv.length - PROBE.length)).toEqual(PROBE);
      expect(mac.profile).toBeDefined();
      const profile = mac.profile!.text;

      // `(deny default)` is the FIRST rule, so nothing is allowed by omission.
      const rules = profile
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith(";") && !l.startsWith("(version"));
      expect(rules[0]).toBe("(deny default)");

      // The four the probe needs to run at all, measured.
      expect(profile).toContain("process-exec");
      expect(profile).toContain("process-fork");
      expect(profile).toContain("sysctl-read");
      expect(profile).toContain("mach-lookup");

      // Its own tree and the ONE shared zone are named in an allow. The zone is
      // one household setting, so "a shared zone for a subset of people" has
      // nowhere to be written.
      expect(profile).toContain(`(subpath "${p1.tree}")`);
      expect(profile).toContain(`(subpath "${two.trees.sharedZone}")`);
      const allowsOwn = new RegExp(
        `\\(allow file-read\\*[^\\n]*\\(subpath "${p1.tree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`,
      );
      expect(allowsOwn.test(profile)).toBe(true);

      // And the other person's tree is NOT REACHABLE. Two shapes are legal and
      // both are covered: a profile that never grants a path the tree sits
      // under (denied by default), and one that opens file-read broadly and
      // then denies that tree back. What is never legal is a grant that reaches
      // it with no deny, and "reaches" includes every ancestor: `(subpath "/")`
      // and `(subpath "<the directory both trees are in>")` each hand over the
      // other person's vault as surely as naming it does.
      const grants = readGrants(profile);
      const deniesOther = forms(profile, "deny").some(
        (rule) => /file-read|file\*|default/.test(rule) && rule.includes(`"${p2.tree}"`),
      );
      const reaching = grants.filter((g) => reaches(g, p2.tree));
      if (!deniesOther) {
        expect(
          reaching.map((g) => `${g.kind} ${g.path} in ${g.rule.replace(/\s+/g, " ")}`),
        ).toEqual([]);
      }
      // The SHARED ZONE'S PARENT is the same question wearing another hat: the
      // zone is one directory that every person reads, and its parent is the
      // scratch root both trees live in, so a build that allowed the parent to
      // save a rule would open every vault on the box.
      const zoneParent = dirname(two.trees.sharedZone);
      for (const grant of grants) {
        if (grant.kind === "subpath" && !deniesOther) {
          expect(grant.path).not.toBe(zoneParent);
        }
      }
      // Its OWN tree is still reachable, or the agent cannot work at all. This
      // is the control that stops the rule above from being satisfied by a
      // profile that grants nothing.
      expect(grants.some((g) => reaches(g, p1.tree))).toBe(true);
      expect(grants.some((g) => reaches(g, two.trees.sharedZone))).toBe(true);

      // --- a THIRD person, added to the file and to nothing else.
      const three = stage(["p1", "p2", "p3"]);
      try {
        const grown = loadRegistry(three.registryFile);
        const withThree = contextFor(grown, "p1-lair");
        expect(withThree.otherTrees.sort()).toEqual(
          [three.trees.person("p2").tree, three.trees.person("p3").tree].sort(),
        );
        const masked = build(PROBE, { ...withThree, platform: "linux" }, "linux");
        const masks = masked.argv
          .map((a, i) => (a === "--tmpfs" ? masked.argv[i + 1] : null))
          .filter((a): a is string => a !== null && !a.startsWith("/run/"))
          .sort();
        expect(masks).toEqual(
          [three.trees.person("p2").tree, three.trees.person("p3").tree].sort(),
        );
      } finally {
        rmSync(three.dir, { recursive: true, force: true });
      }
    } finally {
      rmSync(two.dir, { recursive: true, force: true });
    }
  },
  30_000,
);
