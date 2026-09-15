// 03b item 10. One bun version across the household. (SPEC §8)
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
// Red reason: behaviour absent. The root `package.json` says `bun@1.3.10`
// today, there is no `.bun-version` file, and this Mac runs 1.3.10, so the pin
// assertion is red and the runtime assertion is red behind it.

import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hubPath } from "./helpers/cluster.ts";

/** The hub box's own bun, which is the fixed point (03b item 10). */
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
