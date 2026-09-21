// No agent's box can read the off-box copy while it is assembled on the box.
//
// SPEC §6 and L7: each agent's box reaches its own person's tree and nothing
// else. The copy is staged under `hub.state_dir`, beside every person's own
// state root and inside none of them, and it holds every person's vault, chat
// logs and inbox and a dump of every message at once. On Linux the box binds the
// host read-only whole and then hides what it must, so a directory nothing hides
// is readable from every agent's box: the other-tree masks and the other-state
// masks do not reach it, because it is neither.
//
// The staged copy is planted by hand in the layout the copy writes (the dump in
// `dump/`, every file under `files/` at its own absolute path), so this check is
// about the box and not about the copy, and runs before the copy exists at all.
//
// Rendered on both flavours from either machine, the way the harvest fence is,
// and run for real where this machine has a box, with two controls: the same
// read outside the box succeeds, and the same box reads its own person's note.
//
// Red reason: behaviour absent. The box masks the secrets directory, every
// token and every credential, and nothing masks the staging directory.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import { backupStage, gateSuffix, mirrored, type BackupStage } from "./helpers/backup-stage.ts";
import { boxGate } from "./helpers/box-gate.ts";
import { loadRegistry } from "../src/registry/load.ts";

let cluster: Cluster;
beforeAll(async () => {
  cluster = await startCluster();
});
afterAll(async () => {
  await cluster?.stop();
});

const BOX = boxGate();
const boxed = BOX.ok ? test : test.skip;
const SLOW = 120_000;

/** The second person's draft and chat log, and a dump, where the copy puts them. */
async function plantCopy(stage: BackupStage): Promise<{ theirs: string[]; dump: string }> {
  const theirs: string[] = [];
  for (const path of [stage.copied.uncommitted.path, stage.chatFiles[1]]) {
    const into = mirrored(stage.staging, path);
    mkdirSync(dirname(into), { recursive: true });
    copyFileSync(path, into);
    theirs.push(into);
  }
  const dump = join(stage.staging, "dump", "hub.sql");
  await Bun.write(dump, "-- every message of every person\n");
  return { theirs, dump };
}

async function box() {
  const { boxCommand, boxContextFor } = await seam("src/box/index.ts");
  return {
    context: (stage: BackupStage, agent: string) => (boxContextFor as Function)(loadRegistry(stage.registryFile), agent),
    command: boxCommand as (argv: string[], ctx: unknown, platform: string) => {
      argv: string[]; profile?: { path: string; text: string };
    },
  };
}

test("ROLL-32 ROLL-16 every agent's box masks the copy's staging directory, on both flavours", async () => {
  const stage = await backupStage(cluster, { withoutEntry: true });
  try {
    await plantCopy(stage);
    const { context, command } = await box();
    for (const agent of ["p1-lair", "p2-lair"]) {
      const ctx = context(stage, agent);
      const linux = command(["/bin/true"], { ...ctx, platform: "linux" }, "linux");
      const at = linux.argv.findIndex((word, n) => word === "--tmpfs" && linux.argv[n + 1] === stage.staging);
      // After the read-only host bind, or the host would be bound back over it.
      expect(at, `${agent}'s Linux box masks the copy`).toBeGreaterThan(linux.argv.indexOf("/"));
      const mac = command(["/bin/true"], { ...ctx, platform: "darwin" }, "darwin");
      const rules = mac.profile!.text.trim().split("\n");
      const deny = `(deny file-read* file-write* (subpath ${JSON.stringify(stage.staging)}))`;
      expect(rules, `${agent}'s macOS box denies the copy`).toContain(deny);
      // After every allow, because the sandbox takes the last rule that matches.
      expect(rules.indexOf(deny)).toBeGreaterThan(rules.findLastIndex((rule) => rule.startsWith("(allow")));
    }
  } finally {
    await stage.remove();
  }
}, SLOW);

boxed(`ROLL-32 ROLL-16 from inside one person's box the staged copy of the other person's draft, their chat log and the dump are unreadable, and outside they read${gateSuffix(BOX)}`, async () => {
  const stage = await backupStage(cluster, { withoutEntry: true });
  try {
    const { theirs, dump } = await plantCopy(stage);
    const { context, command } = await box();
    const ctx = context(stage, "p1-lair");
    const inside = async (file: string) => {
      const built = command(["/bin/cat", file], { ...ctx, platform: process.platform }, process.platform);
      if (built.profile) await Bun.write(built.profile.path, built.profile.text);
      return Bun.spawnSync(built.argv, { stdout: "pipe", stderr: "pipe" });
    };
    // The control that says the box works: it reads its own person's note.
    const own = await inside(stage.copied.committedNote.path);
    expect(own.exitCode, "p1-lair's box reads p1's own note").toBe(0);
    expect(own.stdout.toString()).toContain(stage.copied.committedNote.canary);
    for (const file of [...theirs, dump]) {
      const outside = Bun.spawnSync(["/bin/cat", file], { stdout: "pipe", stderr: "pipe" });
      expect(outside.exitCode, `unboxed read of ${file}`).toBe(0);
      const read = await inside(file);
      expect(read.exitCode, `boxed read of ${file}`).not.toBe(0);
      expect(read.stdout.toString()).toBe("");
    }
  } finally {
    await stage.remove();
  }
}, SLOW);
