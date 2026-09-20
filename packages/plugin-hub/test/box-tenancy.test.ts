// Check: the tenancy probe with its control, per agent. Inside the box the
// other person's tree, origin and process list are empty; outside, the same
// command reads them. (SPEC §1, L7, STORE-07)
//
// L7: "each agent runs in a kernel-enforced box that can reach its own person's
// tree and nothing else", with Forbidden carrying "a Unix user per person" and
// "a shared zone for a subset of people". Both are bound here as behaviours: the
// uid inside the box is the uid outside, and each agent reads its own checkout
// of the shared zone, which sits inside its own vault, and reads nothing of the
// other person's.
//
// WHICH ASSERTIONS WERE ALREADY TRUE BEFORE THIS FILE ASKED THEM, so a green run
// is not read as evidence of a change that has not happened. Already true: the
// other person's tree, marker and origin are unreachable, the enumeration, and
// the uid. Already true for the same reason and asked here for the first time:
// each agent reading its OWN zone checkout (it is inside the tree the box
// already grants) and reading none of the other person's (it is inside the tree
// the box already denies), and the symlink below.
//
// THE SYMLINK. `canonical()` resolves every path in the context with
// `realpathSync` before rendering, so a symlink and its target are one path in
// every grant and every deny: the other person's tree is denied by its real
// path on macOS and covered by a tmpfs on Linux. A link planted inside one
// vault pointing at a note in the other person's tree is therefore dead inside
// the box and alive outside it, and the note carries a token generated at run
// time so the assertion is about that note and nothing else.
//
// THE REAL TOOL, on both platforms, gated by `boxGate()` with its reason in the
// test name. The probe is built only from binaries that run inside the minimal
// profile, and the other vault's origin is read from `<tree>/.git/config` as a
// FILE rather than through git, because `/usr/bin/git` on macOS is an Xcode shim
// that dies loading `libxcrun` from a denied path.
//
// THE CHECK BINDS WHAT THE PROBE PRINTED, never the profile text or the argv
// string, so a build may change either as long as the outcome holds. Check 16 is
// where the argv's order and the profile's shape are bound, and it is pure.
//
// THE PROCESS HALF IS A LINUX QUESTION, MEASURED:
// that `/bin/ps` prints nothing inside the macOS box, and the first shape of
// this check read that as the fence. It is not: `/bin/ps` is SETUID root
// (`-rwsr-xr-x root wheel`) and the sandbox refuses to exec a setuid binary
// under `(deny default)` whatever `process-exec*` says, so what was being
// measured was the probe failing rather than the box working, which is exactly
// what the lead named.
//
// `/usr/bin/pgrep` is not setuid, does exec inside the minimal profile, and
// prints ALL 896 processes there: under the minimal profile, under the same one
// with `(allow sysctl-read)` removed, under one carrying `(deny
// process-info*)`, and under one denying the `kern.proc` sysctls by name.
// macOS has no pid namespace and sandbox-exec has no rule that makes one. So
// this check binds the count on LINUX, where `--unshare-pid` after
// `--dev-bind / /` really does produce one, and on darwin it asserts only that
// the enumeration RAN inside the box, which is what says the tree assertions
// beside it mean the fence rather than a dead probe. The macOS process list is
// a stated boundary, not an assertion that would pass on a refusal.
//
// `[partial]`: what this proves is that a BOXED COMMAND cannot see the
// other person's tree, origin or process list while the same command unboxed
// reads all three, per agent. What it does not yet prove is that an agent's
// model process runs inside one, because the profile that lets the real loop
// start is a build-time lab with the real child, and this file does not wire
// `boxCommand` into `Adapter.start`.
//
// Red reason: import missing, src/box/index.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { boxGate } from "./helpers/box-gate.ts";
import { plantTrees } from "./helpers/trees.ts";
import { writeRegistry, type RegistrySpec } from "./helpers/registry.ts";
import { loadRegistry } from "../src/registry/load.ts";

const SLOW = 120_000;

const gate = boxGate();
let dir: string;

beforeAll(() => {
  process.stderr.write(
    `[box-gate] check 15, the tenancy probe on ${process.platform}: ${gate.ok ? `open (${gate.tool})` : `SKIPPED, ${gate.reason}`}\n`,
  );
  dir = mkdtempSync(join(tmpdir(), "hub-tenancy-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function gateSuffix(): string {
  return gate.ok ? "" : ` [skipped: ${gate.reason}]`;
}

async function run(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return out + err;
}

/**
 * The probe, per platform.
 *
 * On linux the enumeration is `/proc` itself rather than a tool, so a box that
 * refused one binary cannot silence it: the directory IS the process list, and
 * `--unshare-pid --proc /proc` is what empties it. On darwin it is
 * `/usr/bin/pgrep`, which unlike `/bin/ps` is not setuid and does run inside
 * the profile. Both print their own exit status on a line the check reads, so
 * "the count is small" can never be scored by an enumeration that died.
 */
function probeFor(
  otherTree: string,
  own: { zonePath: string; zoneMarker: string },
  other: { zonePath: string },
  link: string,
): string[] {
  // THE STATUS IS THE ENUMERATION'S OWN, not a pipeline's. `cmd | wc -l` exits
  // with `wc`'s status, which is zero however badly `cmd` failed, so the output
  // is captured first and the status read before anything is counted.
  const enumerate =
    process.platform === "linux"
      ? 'seen=$(ls /proc 2>&1); code=$?; echo "$seen" | grep -c "^[0-9]"'
      : 'seen=$(/usr/bin/pgrep -l . 2>&1); code=$?; echo "$seen" | wc -l';
  return [
    "/bin/sh",
    "-c",
    [
      `ls ${otherTree} 2>&1`,
      `cat ${otherTree}/.git/config 2>&1`,
      `${enumerate}; echo "enum-exit=$code"`,
      "id -u",
      `cat ${join(own.zonePath, own.zoneMarker)} 2>&1`,
      `ls ${other.zonePath} 2>&1`,
      `cat ${link} 2>&1`,
    ].join("; "),
  ];
}

/** The count the enumeration printed, and whether it ran at all. */
function enumeration(text: string): { count: number; exit: number | null } {
  const lines = text.split("\n").map((line) => line.trim());
  const at = lines.findIndex((line) => line.startsWith("enum-exit="));
  const exit = at < 0 ? null : Number(lines[at].slice("enum-exit=".length));
  // The count is the last bare integer BEFORE the marker, so the uid printed
  // after it and any digits inside a diagnostic further up cannot be read as
  // the process list.
  let count = 0;
  for (let i = at < 0 ? lines.length - 1 : at - 1; i >= 0; i -= 1) {
    if (/^\d+$/.test(lines[i])) {
      count = Number(lines[i]);
      break;
    }
  }
  return { count, exit };
}

test.skipIf(!gate.ok)(
  `STORE-07 the tenancy probe with its control, per agent: inside each agent's box the OTHER person's tree lists nothing, their random origin string does not appear and no entry of that tree is in the output, the enumeration RUNS and on linux sees a handful of processes against hundreds outside, while the same command unboxed reads all of it; and inside the box the uid is the uid outside and each agent reads its own zone checkout and not the other person's, a symlink into the other person's tree included (SPEC §1, L7, D-92, D-93, D-106)${gateSuffix()}`,
  async () => {
    const { boxCommand, boxContextFor } = await seam("src/box/index.ts");
    expect(typeof boxCommand).toBe("function");
    expect(typeof boxContextFor).toBe("function");

    const trees = plantTrees(dir);
    const spec: RegistrySpec = {
      hub: {
        store_url: "postgres://127.0.0.1:5432/hub",
        state_dir: dir,
      },
      machines: [{ id: "pi", os: "linux" }],
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
        { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      ],
    };
    const registry = loadRegistry(writeRegistry(dir, spec));
    const uid = process.getuid!();

    // PER AGENT, which is the criterion's own word, so the body runs twice and
    // each run masks the other person.
    for (const person of trees.people) {
      const agent = `${person.id}-lair`;
      const other = trees.other(person.id);
      const ctx = (boxContextFor as Function)(registry, agent) as Record<string, unknown>;

      // A note in the OTHER person's tree, and a symlink to it planted inside
      // this person's own vault. The token is generated here, so a string that
      // could only have come from that note is what the assertions read.
      const seamToken = `seam-${crypto.randomUUID().replace(/-/g, "")}`;
      const note = join(other.tree, `across-${seamToken}.txt`);
      writeFileSync(note, `${seamToken}\n`, "utf8");
      const link = trees.plantZoneSymlink(person.id, note);

      const probe = probeFor(other.tree, person, other, link);

      // --- OUTSIDE, first, because without the control this check passes on a
      //     box that cannot run anything at all.
      const outside = await run(probe);
      expect(outside).toContain(other.marker);
      expect(outside).toContain(other.origin);
      expect(outside).toContain(person.zoneMarker);
      expect(outside).toContain(other.zoneMarker);
      expect(outside).toContain(seamToken);
      const outsideEnum = enumeration(outside);
      expect(outsideEnum.exit).toBe(0);
      expect(outsideEnum.count).toBeGreaterThan(50);

      // --- INSIDE.
      const boxed = (boxCommand as Function)(probe, { ...ctx, platform: process.platform }) as {
        argv: string[];
        profile?: { path: string; text: string };
        tool: string;
      };
      if (boxed.profile) await Bun.write(boxed.profile.path, boxed.profile.text);
      const inside = await run(boxed.argv);

      // The other tree lists nothing, or the attempt is refused, and either way
      // the marker only that tree has does not appear.
      expect(inside).not.toContain(other.marker);
      // The origin was generated at run time, so a string that could only have
      // come from that file is the assertion, not a word that might be anywhere.
      expect(inside).not.toContain(other.origin);
      // NOT A LISTING ENTRY EITHER: no line of the output is a name that tree
      // holds. The PATH is deliberately not asserted against, which is the
      // false failure found: "ls: /…/p2: Operation not
      // permitted" is the fence working and it carries the path by nature, so a
      // check that forbade the string would fail on the denial it wanted.
      const entries = inside.split("\n").map((line) => line.trim());
      expect(entries).not.toContain(other.marker);
      expect(entries).not.toContain(".git");

      // The enumeration RAN, on both platforms, which is what makes the
      // assertions above the fence rather than a probe the box killed.
      const insideEnum = enumeration(inside);
      expect(insideEnum.exit).toBe(0);
      if (process.platform === "linux") {
        // The pid namespace, measured: a handful of processes against hundreds.
        expect(insideEnum.count).toBeLessThanOrEqual(10);
        expect(insideEnum.count * 10).toBeLessThan(outsideEnum.count);
      } else {
        // MacOS has no pid namespace and no sandbox rule hides the
        // process list, measured four ways. The count is NOT bound here,
        // because the only thing that could make it small is the enumeration
        // failing, and a check that scored that as the fence would pass on a
        // box that isolated nothing. What is bound is that it ran.
        expect(insideEnum.count).toBeGreaterThan(0);
      }

      // --- L7's two Forbidden lines, as behaviours.
      // "a Unix user per person": the uid inside IS the uid outside.
      expect(inside).toContain(String(uid));
      // "a shared zone for a subset of people": every agent reads the zone,
      // through its OWN checkout inside its own vault, and this loop runs for
      // both. The other person's checkout of the same zone is inside the tree
      // the box denies, so nothing of it arrives.
      expect(inside).toContain(person.zoneMarker);
      expect(inside).not.toContain(other.zoneMarker);
      // A symlink and its target are one path in every grant and every deny, so
      // a link out of this vault into the other person's tree carries nothing
      // back: the note's token does not appear.
      expect(inside).not.toContain(seamToken);

      rmSync(link, { force: true });
      rmSync(note, { force: true });
    }
  },
  SLOW,
);
