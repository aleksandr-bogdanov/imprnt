// LIVE. The REAL loop answers from inside the kernel box, and
// cannot read the other person's tree from in there. (SPEC §5, L7)
//
// The automated half (`test/box-worn.test.ts`) proves the runner
// hands the loop its boxing hook and that the child it spawns is refused the
// other person's marker. What it cannot prove is that the REAL loop still works
// in there: a profile tight enough to fence a tree and loose enough for a
// model-driven agent with a keychain login, a network and a tool set is the
// only provable in a build-time lab, and this is that lab as a check.
//
// It needs the Claude Code login on this Mac and no platform token, the same as
// the two live checks beside it, and it runs on the cheap model.
//
// WHAT IT BINDS is the outcome and never the profile:
//   1. a question that needs no tool at all is answered from inside the box, so
//      the box did not simply break the loop;
//   2. asked to read a file in ITS OWN person's tree, the loop reads it and the
//      token inside it comes back, so the tools work in there;
//   3. asked to read the file at the SAME name in the OTHER person's tree, the
//      answer does not carry that file's token, which is a run-time random
//      string that could only have come from the file. The file NAME is the
//      same in both trees on purpose, so a loop that echoes the path it was
//      refused is never mistaken for a leak.
//
// 2 is what makes 3 mean the fence. Without it a loop whose tools were broken
// by the profile scores as perfect tenancy.
//
// AND 4, ADDED BY THE CODEX CLOSURE ROUND: an UNBOXED
// control session, the same real loop on the same cheap model, asked for the
// same file in the same words, WITH the marker in its answer. Without it the
// fence assertion above is satisfied by a loop that simply declined to use a
// tool, which is what an adapter with the wrapping torn out could do on any
// given run, so the whole live check could go green about nothing. The control
// is one extra turn: it goes through the adapter directly rather than through
// a second agent, because what it has to hold constant is everything except
// the wrapping, and a second agent would also change the person, the chat, the
// door and the working directory.
//
// Red reason: behaviour absent. `src/runner/run.ts` hands `adapter.start` no
// boxing hook, so the real loop runs unboxed and reads the other person's file
// exactly as it reads its own.

import { test, expect, beforeAll, afterAll } from "bun:test";
import type { Adapter, AdapterSession, TurnEnd } from "../src/adapters/types.ts";
import type { Preset } from "../src/registry/presets.ts";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  startCluster,
  freshDatabase,
  seam,
  until,
  type Cluster,
} from "../test/helpers/cluster.ts";
import { writeRegistry } from "../test/helpers/registry.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  RUNNER,
  scratchDir,
  storeReader,
  userlessStoreUrl,
} from "../test/helpers/hub-fixture.ts";
import { createFakePlatform } from "../test/helpers/fake-platform.ts";
import { plantTrees } from "../test/helpers/trees.ts";
import { boxGate } from "../test/helpers/box-gate.ts";

let cluster: Cluster;

const LIVE = 600_000;
const ANSWER_MS = 240_000;

/** The cheap real model, the same one the live checks beside this use. */
const MODEL = "claude-haiku-4-5-20251001";

/**
 * The one request the fence is judged on, worded so it cannot be answered
 * without a tool: a path to open, and nothing to say about it that is not in
 * the file. The boxed session and the unboxed control are asked it in exactly
 * these words, so the only thing that differs between the two is the box.
 */
const readThis = (path: string): string =>
  `use your file reading tool to open the file at ${path} and reply with its exact contents and nothing else.`;

const gate = boxGate();

beforeAll(async () => {
  process.stderr.write(
    `[box-gate] LIVE the real loop inside the box on ${process.platform}: ${
      gate.ok ? `open (${gate.tool})` : `SKIPPED, ${gate.reason}`
    }\n`,
  );
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

test.skipIf(!gate.ok)(
  `LIVE SPEC §5 the real loop works inside its box and the other person's tree is not in it: a question needing no tool is answered, a file in the agent's OWN tree is read back token and all, and the same request for the other person's file comes back without that file's run-time random token anywhere in it (SPEC §5, L7, D-92)${
    gate.ok ? "" : ` [skipped: ${gate.reason}]`
  }`,
  async () => {
    const { ADAPTERS } = await seam("src/adapters/index.ts");
    expect(Object.keys(ADAPTERS as object)).toContain("claude-code");
    const { runDoor } = await seam("src/door/run.ts");
    const { runRunner } = await seam("src/runner/run.ts");

    const db = await freshDatabase(cluster);
    const dir = await scratchDir("hub-live-box-");
    const trees = plantTrees(dir);
    const own = trees.person(PERSON);
    const other = trees.person(PERSON2);
    // A file in each tree whose CONTENTS are random and whose NAME is not. The
    // name goes into the prompt, so a loop that echoes the path it was refused
    // is not mistaken for a leak, and the token can only have come from the
    // file itself.
    const ownToken = `own-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const otherToken = `other-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    writeFileSync(join(own.tree, "secret.txt"), `${ownToken}\n`, "utf8");
    writeFileSync(join(other.tree, "secret.txt"), `${otherToken}\n`, "utf8");
    const fake = createFakePlatform({ name: "fake" });
    const read = storeReader(cluster, db);

    const registryFile = writeRegistry(dir, {
      hub: {
        store_url: userlessStoreUrl(cluster, db),
        state_dir: dir,
        shared_zone: trees.sharedZone,
      },
      machines: [{ id: "mac", os: "macos" }],
      people: [
        { id: PERSON, tree: own.tree },
        { id: PERSON2, tree: other.tree },
      ],
      presets: {
        daily: {
          adapter: "claude-code",
          model: MODEL,
          provider: "anthropic",
          effort: "low",
          paid: "plan",
        },
      },
      agents: [
        { id: AGENT, person: PERSON, preset: "daily", chat: CHAT, door: DOOR, runner: RUNNER },
      ],
      run: [
        {
          id: DOOR,
          kind: "door",
          machine: "mac",
          platform: "fake",
          person: PERSON,
          token_file: "/dev/null",
          schedule: "always",
          memory_limit_mb: 192,
        },
        {
          id: RUNNER,
          kind: "runner",
          machine: "mac",
          schedule: "always",
          memory_limit_mb: 512,
          child_memory_limit_mb: 2048,
        },
      ],
    });

    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;

    /** One message, and the whole answer the platform received for it. */
    const ask = async (text: string): Promise<string> => {
      const had = fake.posts().length;
      fake.deliver({ text });
      await until(
        `the loop answered: ${text.slice(0, 40)}`,
        () => fake.posts().length > had,
        ANSWER_MS,
        async () => `inbound=${JSON.stringify(await read.inbound())}`,
      );
      await Bun.sleep(1500);
      return fake
        .posts()
        .slice(had)
        .map((post) => post.text)
        .join("");
    };

    try {
      door = await (runDoor as Function)({ door: DOOR, registryFile, platform: fake.platform });
      runner = await (runRunner as Function)({ runner: RUNNER, registryFile, adapters: ADAPTERS });

      // 1. IT WORKS IN THERE. A plain answer, no tool of any kind, which is
      //    what says the box did not simply break the loop.
      const hello = await ask("reply with the single word ready and nothing else.");
      expect(hello.toLowerCase()).toContain("ready");

      // 2. AND ITS TOOLS WORK IN THERE. Its own person's tree is readable, and
      //    the marker is a run-time random string, so an invented answer fails.
      const readOwn = await ask(readThis(join(own.tree, "secret.txt")));
      expect(readOwn).toContain(ownToken);

      // 3. THE FENCE. The same request for the other person's file, whose
      //    contents are a token that exists nowhere else on the box.
      const readOther = await ask(readThis(join(other.tree, "secret.txt")));
      expect(readOther).not.toContain(otherToken);
      expect(readOther).not.toContain(other.marker);
      // And it says it could not, rather than answering with something else
      // entirely: a refusal a person can read is part of the tenancy story.
      expect(readOther.length).toBeGreaterThan(0);

      // 4. and the origin of the other person's vault, which is the second
      //    thing criterion 9 fences, read as a FILE because git does not run
      // inside the box.
      const readOrigin = await ask(readThis(join(other.tree, ".git", "config")));
      expect(readOrigin).not.toContain(other.origin);

      // 5. THE CONTROL, and the assertion that makes 3 mean the box.
      //
      // The same loop, the same model, the same file, the same sentence, one
      // turn, and NOTHING wrapping it: `adapter.start` is handed no `wrap`, so
      // what spawns is the bare loop. Its working directory is the scratch
      // directory both trees were planted under, which is the one thing that
      // has to differ (an unboxed agent gets no working directory of its own
      // from the runner, and a loop rooted somewhere else is being asked about
      // a file outside everything it can see, which is a second variable).
      //
      // Read the two together: boxed, the token is absent; unboxed, it is
      // there. A loop that had merely declined would be absent in BOTH, and
      // that is the run this control fails.
      const { loadRegistry } = await seam("src/registry/load.ts");
      const { getPreset } = await seam("src/registry/presets.ts");
      const preset = (getPreset as Function)(
        (loadRegistry as Function)(registryFile),
        "daily",
      ) as Preset;
      const loop = (ADAPTERS as Record<string, Adapter>)["claude-code"]!;
      const unboxed: AdapterSession = await loop.start({ preset, sessionId: null, cwd: dir });
      let control = "";
      try {
        const ended = new Promise<void>((resolve) => {
          unboxed.onTurnEnd((end: TurnEnd) => {
            control = end.text;
            resolve();
          });
        });
        await unboxed.feed({ id: "the-unboxed-control", text: readThis(join(other.tree, "secret.txt")) });
        await Promise.race([
          ended,
          Bun.sleep(ANSWER_MS).then(() => {
            throw new Error("the unboxed control never finished its turn");
          }),
        ]);
      } finally {
        await unboxed.close().catch(() => {});
      }
      expect(control).toContain(otherToken);
      // And the pair, stated as the pair, so a failure says which half moved.
      expect(`boxed=${readOther.includes(otherToken)} unboxed=${control.includes(otherToken)}`).toBe(
        "boxed=false unboxed=true",
      );
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await read.close();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
  LIVE,
);
