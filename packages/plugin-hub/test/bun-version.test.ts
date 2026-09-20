// One bun version across the household. (SPEC §8)
//
// Three boxes ran three answers: this Mac and CI on 1.3.10, the hub box on
// 1.3.14. A suite that passes on one runtime and is never run on the other is a
// suite that says nothing about the box the hub actually lives on, and the
// difference is silent: nothing in the repository ever compares them.
//
// THE VERSION TO ALIGN ON IS THE HUB BOX'S, and that is a fact about the house
// rather than a preference. The live v2 on that box runs on its bun, thirteen
// of its unit files and four of its modules name it, and downgrading it would
// be a change to a system this phase must not touch. So the Mac and CI move UP:
// `packageManager` in the root `package.json` and the CI action's pin become
// `bun@1.3.14`, and a `.bun-version` file carries the same value for the
// toolchains that read that instead.
//
// WHAT THIS BINDS is the agreement between the pin and the runtime, so a
// machine on the wrong version fails loudly at its first test rather than
// differing quietly for a phase. It is deliberately NOT a floor test: "at least
// 1.3.14" would pass on three different runtimes again, which is the state this
// closes.
//
// THE PINNED VALUE MOVES WITH THE HOUSEHOLD. When the hub box's bun moves, this
// constant, the root `package.json`, `.bun-version` and the CI pin move in one
// commit, and this check is what refuses a commit that moves three of the four.
//
// WHAT THE FIRST VERSION OF THIS FILE MISSED. It read
// `Bun.version`, which is the runtime executing THIS file, and nothing about
// the runtimes the suite goes on to spawn. Every subprocess in this package was
// started as the bare word `bun`, resolved by PATH, so a 1.3.14 parent with an
// older `bun` earlier on PATH passed this check while its door, its runner, its
// hub, its install script and its holder child all ran on the older one. That
// is the exact state this check exists to end, and it is why PATH has to be
// ordered by hand on a box carrying two of them.
//
// So there are two more assertions below: a child really spawned reports the
// same version, and no spawn under `src/`, `test/` or `live/` names bun by the
// bare word at all. `process.execPath` is the runtime that is running, asked
// rather than resolved, and it needs no PATH to be right.
//
// Red reason: behaviour absent. The root `package.json` says `bun@1.3.10`
// today, there is no `.bun-version` file, and this Mac runs 1.3.10, so the pin
// assertion is red and the runtime assertion is red behind it.

import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hubPath } from "./helpers/cluster.ts";

/** The hub box's own bun, which is the fixed point. */
const PINNED = "1.3.14";

/** The monorepo root: two directories above this package. */
function rootPath(name: string): string {
  return join(hubPath("."), "..", "..", name);
}

test(
  "SPEC §8 every machine runs the household's one bun: the root package.json pins bun@1.3.14, the .bun-version file beside it says the same, and the runtime this suite is running on IS that version, so a box on another one fails here instead of differing quietly (SPEC §8)",
  () => {
    const manifestPath = rootPath("package.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      packageManager?: string;
    };

    // --- the pin itself, as a whole string, because `bun@1.3` and
    //     `bun@1.3.14-canary` are both things somebody could type.
    expect(typeof manifest.packageManager).toBe("string");
    expect(manifest.packageManager).toBe(`bun@${PINNED}`);

    // --- the file the toolchains read when they do not read the manifest.
    const versionFile = rootPath(".bun-version");
    expect(existsSync(versionFile)).toBe(true);
    expect(readFileSync(versionFile, "utf8").trim()).toBe(PINNED);

    // --- and the runtime under it. `Bun.version` is what is really executing
    //     this file, so the three cannot drift apart without a red test.
    const pinned = String(manifest.packageManager).slice("bun@".length);
    expect(Bun.version).toBe(pinned);
    expect(Bun.version).toBe(PINNED);
  },
  30_000,
);

/** Every `.ts` file under a directory of this package, recursively. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (here: string) => {
    for (const name of readdirSync(here)) {
      const path = join(here, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) out.push(path);
    }
  };
  walk(dir);
  return out;
}

test(
  "SPEC §8 the children run the household's one bun too: a child this suite spawns the way every helper spawns one reports the pinned version, and no spawn under src, test or live names bun by the bare word, so a box with an older bun earlier on PATH fails here instead of running the parent on one runtime and everything it starts on another (SPEC §8)",
  async () => {
    // --- 1. A REAL CHILD, spawned the way the helpers spawn theirs. The parent
    //     assertion above says nothing about this: the suite's doors, runners,
    //     hubs, install script and holder children are all separate processes,
    //     and what runtime they get is a question about how they are started.
    const child = Bun.spawn([process.execPath, "-e", "console.log(Bun.version)"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const said = (await new Response(child.stdout).text()).trim();
    const complained = (await new Response(child.stderr).text()).trim();
    expect(`${await child.exited} ${said}`).toBe(`0 ${PINNED}`);
    expect(complained).toBe("");

    // --- 2. AND NOTHING SPAWNS THE BARE WORD, which is the only way a child
    //     could get a different one. `process.execPath` is the runtime that is
    //     already running, asked rather than resolved, so it cannot disagree
    //     with the parent whatever PATH says.
    //
    //     The needle is built rather than written, so this file does not match
    //     itself and cannot pass by being the only offender.
    const bare = /Bun\.spawn(?:Sync)?\s*\(\s*\[\s*(["'])bun\1/;
    const offenders: string[] = [];
    for (const dir of ["src", "test", "live"]) {
      for (const path of filesUnder(hubPath(dir))) {
        const body = readFileSync(path, "utf8");
        if (bare.test(body)) offenders.push(path.slice(hubPath(".").length + 1));
      }
    }
    expect(offenders).toEqual([]);
    // THE CONTROL for that scan, because a walk that read nothing would pass
    // it: the three directories are really there and really full.
    const counted = ["src", "test", "live"].map((dir) => filesUnder(hubPath(dir)).length);
    expect(counted.every((n) => n > 0)).toBe(true);
    expect(counted.reduce((a, b) => a + b, 0)).toBeGreaterThan(50);
    // And the scan really can find what it is looking for. The samples are
    // ASSEMBLED, for the same reason the needle is: written out, they would be
    // offenders in this very file and the scan would be reporting itself.
    const q = String.fromCharCode(34);
    const tick = String.fromCharCode(39);
    expect(bare.test(`Bun.spawn([${q}bun${q}, ${q}run${q}, ${q}x${q}])`)).toBe(true);
    expect(bare.test(`Bun.spawnSync([  ${tick}bun${tick} , ${tick}-e${tick}])`)).toBe(true);
    expect(bare.test(`Bun.spawn([process.execPath, ${q}run${q}, ${q}x${q}])`)).toBe(false);
  },
  30_000,
);
