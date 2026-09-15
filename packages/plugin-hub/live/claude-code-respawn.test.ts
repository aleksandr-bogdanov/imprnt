// LIVE. A code word planted in the log survives a REAL respawn.
//
// SPEC §2: "On every spawn the runner feeds the tail (24 hours, 8k tokens,
// defaults until measured) before any human message." Its Check line is exactly
// this one, and the scripted version in test/chatlog.test.ts cannot stand in
// for it: a scripted loop is told what to say, so only a real loop can
// demonstrate that the tail actually arrived and was understood.
//
// A REAL RESPAWN, not a fresh start. The first pass started one runner and
// called that a respawn, and a runner that fed the human message first and the
// tail second could still have answered with the word. So this one runs a whole
// ordinary exchange, STOPS the runner, plants the word into the log the door
// has been writing, starts a SECOND runner, and asks. The word can only reach
// the second session through the log, because the first session is gone and the
// second one never saw the planting.
//
// And the feed order is OBSERVED rather than trusted: within the second spawn's
// own stretch of the diary, the tail turn's record must come before the message
// turn's by `seq`.
//
// WHY THIS LIVES OUTSIDE test/. It needs the Claude Code login on this Mac. CI
// has no model login, so bunfig.toml's `[test] root = "test"` keeps `bun test`
// from finding it and `bun run test:live` runs it by hand with an explicit path.
// It is part of the phase's red run and the phase's green run.
//
// It needs NO platform token. The real loop is driven through the in-memory
// fake platform and a throwaway Postgres, so nothing here touches Telegram or
// Discord. Those two are build tasks whose only check is a human sending one
// real message, because SPEC section 2 forbids a synthetic test message.
//
// The model name appears in this file's own scratch registry and nowhere else,
// because SPEC section 3 forbids "a model or provider name hard-coded outside
// the registry and the adapters".
//
// Red reason: import missing, src/adapters/claude-code.ts, reached through
// src/adapters/index.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
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
  CHAT,
  DOOR,
  PERSON,
  RUNNER,
  chatLogFile,
  chatLogLines,
  scratchDir,
  storeReader,
  userlessStoreUrl,
} from "../test/helpers/hub-fixture.ts";
import { createFakePlatform } from "../test/helpers/fake-platform.ts";

let cluster: Cluster;

/**
 * The bound for the whole test. Two real turns plus a respawn, and the waits
 * below add up to less than this on purpose: a per-test limit shorter than the
 * waits it contains reports a timeout instead of the behaviour.
 */
const LIVE = 540_000;
const FIRST_ANSWER_MS = 180_000;
const SECOND_ANSWER_MS = 240_000;

/** The cheap real model, named here and nowhere else in the repository. */
const MODEL = "claude-haiku-4-5-20251001";

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

test(
  "LIVE MSG-12 a code word planted in the log survives a respawn: the runner is stopped after an ordinary exchange, the word is planted, a second runner spawns with no session of its own, and its reply carries a word only the log could have held (SPEC §2, L2)",
  async () => {
    // Reached through the registry, never imported directly, because that is
    // the seam the rest of the hub is allowed to know about.
    const { ADAPTERS } = await seam("src/adapters/index.ts");
    expect(typeof ADAPTERS).toBe("object");
    expect(Object.keys(ADAPTERS as object)).toContain("claude-code");
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const db = await freshDatabase(cluster);
    const dir = await scratchDir("hub-live-respawn-");
    const fake = createFakePlatform({ name: "fake" });
    const read = storeReader(cluster, db);
    const registryFile = writeRegistry(dir, {
      hub: { store_url: userlessStoreUrl(cluster, db), state_dir: dir },
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
        {
          id: AGENT,
          person: PERSON,
          preset: "daily",
          chat: CHAT,
          door: DOOR,
          runner: RUNNER,
        },
      ],
    });

    let door: { stop(): Promise<void> } | null = null;
    let first: { stop(): Promise<void> } | null = null;
    let second: { stop(): Promise<void> } | null = null;

    try {
      door = await (runDoor as Function)({
        door: DOOR,
        registryFile,
        platform: fake.platform,
      });

      // SPAWN ONE. An ordinary exchange, so the log the door writes is real and
      // the session that answers it is real.
      first = await (runRunner as Function)({
        runner: RUNNER,
        registryFile,
        adapters: ADAPTERS,
      });
      fake.deliver({ text: "say hello in one short sentence." });
      await until(
        "the first spawn answered",
        () => fake.posts().length >= 1,
        FIRST_ANSWER_MS,
        async () =>
          `the first exchange never completed. ledger=${JSON.stringify(
            await read.ledger({ stream: "inbound" }),
          )}`,
      );

      // The runner goes away, and with it the session that heard anything.
      await first.stop();
      first = null;

      // A word an empty session cannot know, generated at run time so no build
      // can have it baked in, planted into the log AFTER the first session is
      // gone so nothing that ran can have heard it.
      //
      // It is planted as ORDINARY CONVERSATION, a thing the person decided and
      // the agent acknowledged, and the question below asks it back the same
      // way. An earlier wording called it the passphrase for today and asked
      // for it by that name, and the real loop refused three times out of
      // three: instructions embedded in chat history framed as a passphrase
      // are not something it follows, and the tail's own preamble says do not
      // answer it. SPEC section 2 asks for a word an empty chat cannot know,
      // and says nothing about a secret.
      const codeWord = `Pelican${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
      const planted = new Date();
      const file = chatLogFile({
        stateDir: dir,
        person: PERSON,
        agent: AGENT,
        at: planted,
      });
      mkdirSync(dirname(file), { recursive: true });
      // Both halves of the exchange, because a person deciding something and an
      // agent answering is what the log holds, and a lone unanswered line reads
      // as an instruction left lying about.
      writeFileSync(
        file,
        [
          JSON.stringify({
            at: planted.toISOString(),
            direction: "in",
            from: PERSON,
            text: `by the way, I have decided to call the new espresso machine ${codeWord}`,
          }),
          JSON.stringify({
            at: new Date(planted.getTime() + 1000).toISOString(),
            direction: "out",
            from: AGENT,
            text: `Got it, ${codeWord} it is.`,
          }),
        ].join("\n") + "\n",
        "utf8",
      );
      expect(
        chatLogLines(dir, PERSON, AGENT).some((l) => l.text.includes(codeWord)),
      ).toBe(true);

      // The high water mark of the diary, so the second spawn's own records can
      // be told apart from the first one's by sequence rather than by guess.
      const [{ seq: seqBeforeSpawnTwo }] = (await read.sql(
        "select coalesce(max(seq), 0) as seq from ledger_event",
      )) as { seq: string }[];

      // SPAWN TWO.
      second = await (runRunner as Function)({
        runner: RUNNER,
        registryFile,
        adapters: ADAPTERS,
      });
      fake.deliver({
        text: "what did I decide to call the new espresso machine? answer with the name only.",
      });

      // The three ways this can miss are told apart, so a failure says which.
      await until(
        "the second spawn was fed at all, so the tail reached it",
        async () =>
          (await read.ledger({ stream: "inbound", kind: "acked" })).length >= 2,
        120_000,
        async () =>
          `the second spawn fed nothing. Either the tail was not fed or the loop never started. ledger=${JSON.stringify(
            await read.ledger(),
          )}`,
      );
      await until(
        "the second spawn answered",
        () => fake.posts().length >= 2,
        SECOND_ANSWER_MS,
        async () =>
          `the second spawn was fed and did not answer. ledger=${JSON.stringify(
            await read.ledger({ stream: "inbound" }),
          )}`,
      );

      const answer = fake.posts()[1].text;
      if (!answer.includes(codeWord)) {
        throw new Error(
          `the second spawn answered and the answer lacked the word from the log. ` +
            `Expected ${codeWord} somewhere in: ${answer}`,
        );
      }
      expect(answer).toContain(codeWord);

      // THE FEED ORDER, observed rather than trusted. Inside the second spawn's
      // own stretch of the diary, the priming turn is recorded before the
      // message turn, so a runner that fed the human first and the tail second
      // fails even when the word happens to come back.
      const mine = (await read.ledger({ stream: "turn" })).filter(
        (t) => t.seq > Number(seqBeforeSpawnTwo),
      );
      const tailTurn = mine.find((t) => t.detail.tail === true);
      const messageTurn = mine.find((t) => t.detail.tail === false);
      expect(tailTurn).toBeDefined();
      expect(messageTurn).toBeDefined();
      expect(tailTurn!.subject).toBe(AGENT);
      expect(tailTurn!.seq).toBeLessThan(messageTurn!.seq);

      // And the priming turn produced no message in the chat: two exchanges,
      // two posts.
      expect(fake.posts().length).toBe(2);
    } finally {
      if (second) await second.stop();
      if (first) await first.stop();
      if (door) await door.stop();
      await read.close();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
  LIVE,
);
