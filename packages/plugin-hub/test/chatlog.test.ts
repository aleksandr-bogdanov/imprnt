// MSG-12. The chat log is the record, and a spawned session is fed its tail.
//
// SPEC §2: "Chat log: the door appends every message in both directions to one
// dated file per agent, before sending. The loop's session is a cache. On every
// spawn the runner feeds the tail (24 hours, 8k tokens, defaults until
// measured) before any human message. The agent never chooses what to read on
// spawn. No per-agent tail size." Its Forbidden list carries "a session
// answering before the tail was fed". Its Check line: "A code word planted in
// the log survives a respawn."
//
// The scripted loop stands in for the real one here, and it cannot stand in for
// it completely: a scripted loop is told what to say, so only a real loop can
// demonstrate that the tail arrived and was understood. That is live check
// L1 in live/claude-code-respawn.test.ts, and this is its deterministic half.
//
// Red reason: import missing, src/chatlog.ts.

import { stageHub } from "./helpers/authorized-registry.ts";
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import { scriptedReply } from "./helpers/scripted-adapter.ts";
/** The pinned formula, computed by the test rather than read from the build. */
import { expectedPresetId } from "./helpers/preset-oracle.ts";
import {
  AGENT,
  DOOR,
  PERSON,
  RUNNER,
  chatLogFile,
  chatLogLines,
  chatLogRawLines,
  outLineOnDisk,
  plantChatLine,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 90_000;
const MESSAGE = "which chunk of the log did you get";

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

test(
  "MSG-12 the door appends every message in both directions to one dated file per agent, one line per message, before sending: the out line is on disk at the moment the door attempts the post (SPEC §2, L2)",
  async () => {
    const { appendChatLine, chatLogPath } = await seam("src/chatlog.ts");
    expect(typeof appendChatLine).toBe("function");
    expect(typeof chatLogPath).toBe("function");
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    // The fake platform observes, INSIDE every post attempt and before it
    // answers, whether the out line is already on disk. Reading the file after
    // the call cannot tell "written before the send" from "posted, refused,
    // written, retried", and the second of those is a door that has already
    // lost the record of anything it crashed during. The probe reads every
    // dated file for the agent, so a UTC midnight between the two lines does
    // not hide one.
    const stateDirForProbe = { value: "" };
    const it = await stageHub(cluster, {
      probe: (post) =>
        stateDirForProbe.value === ""
          ? null
          : outLineOnDisk({ stateDir: stateDirForProbe.value })(post),
    });
    stateDirForProbe.value = it.stateDir;
    // The first post is refused on purpose, so the retry must come well inside
    // the wait below rather than at the thirty second default spacing.
    await Bun.write(it.registryFile, (await Bun.file(it.registryFile).text()) + "\n[door]\ndelivery_retry_seconds = 1\n");
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;

    try {
      // The platform refuses at first, so there is a first attempt to look at
      // and a retry after it.
      it.fake.holdPosts(true);

      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      const delivered = it.fake.deliver({ text: MESSAGE });

      // The path is computed by the TEST from the pinned shape and the
      // message's own time in UTC, so a build that writes somewhere else fails
      // rather than being followed.
      const file = chatLogFile({
        stateDir: it.stateDir,
        person: PERSON,
        agent: AGENT,
        at: new Date(delivered.at),
      });

      await until(
        "the door attempted the post",
        () => it.fake.attempts().length >= 1,
        60_000,
        async () =>
          `outbox=${JSON.stringify(await it.read.outbox())} log=${JSON.stringify(chatLogRawLines(file))}`,
      );

      // THE LOAD. The FIRST attempt's own snapshot, taken inside the post. A
      // door that logs after its first send fails here and passes every other
      // assertion in this check.
      const firstAttempt = it.fake.attempts()[0];
      expect(firstAttempt.text).toBe(scriptedReply(MESSAGE));
      expect(firstAttempt.probe).toBe(true);

      it.fake.holdPosts(false);
      await until(
        "the reply was posted",
        () => it.fake.posts().length >= 1,
        30_000,
      );
      await Bun.sleep(1500);

      expect(existsSync(file)).toBe(true);

      // Exactly two lines for this agent, and each one in the dated file its
      // OWN time implies. Counting one file would be wrong across a UTC
      // midnight, and "dated from the line's own time" is the rule anyway.
      const lines = chatLogLines(it.stateDir, PERSON, AGENT) as unknown as Record<
        string,
        unknown
      >[];
      expect(lines.length).toBe(2);
      for (const line of lines) {
        const ownFile = chatLogFile({
          stateDir: it.stateDir,
          person: PERSON,
          agent: AGENT,
          at: new Date(String(line.at)),
        });
        expect(chatLogRawLines(ownFile)).toContain(JSON.stringify(line));
      }

      for (const line of lines) {
        expect(Object.keys(line).sort()).toEqual([
          "at",
          "direction",
          "from",
          "id",
          "text",
        ]);
      }
      expect(lines[0]).toMatchObject({
        direction: "in",
        from: PERSON,
        text: MESSAGE,
      });
      expect(lines[1]).toMatchObject({
        direction: "out",
        from: AGENT,
        text: scriptedReply(MESSAGE),
      });
      expect(lines[1].text).toBe(it.fake.posts()[0].text);

    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-12 a code word planted in the log survives a respawn: the first feed of a spawned session is the tail carrying the code word and the human message is second, and the priming turn produces no reply (SPEC §2, L2)",
  async () => {
    const { TAIL_PREAMBLE, readTail } = await seam("src/chatlog.ts");
    expect(typeof TAIL_PREAMBLE).toBe("string");
    expect(typeof readTail).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");

    const it = await stageHub(cluster);
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;

    try {
      // Generated at run time, so no build can have it baked in and an empty
      // chat cannot know it.
      const codeWord = `codeword-${crypto.randomUUID().slice(0, 8)}`;
      plantChatLine({
        stateDir: it.stateDir,
        text: `the word for today is ${codeWord}`,
      });

      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      it.fake.deliver({ text: MESSAGE });
      await until(
        "the reply was posted",
        () => it.fake.posts().length >= 1,
        60_000,
        () => JSON.stringify(it.scripted.fed().map((f) => f.text)),
      );
      await Bun.sleep(1500);

      const fed = it.scripted.fed();
      expect(fed.length).toBe(2);

      // The first feed of a spawned session is the tail, and it is marked as
      // the tail so the loop can tell it from a human.
      expect(fed[0].text.startsWith(TAIL_PREAMBLE as string)).toBe(true);
      expect(fed[0].text).toContain(codeWord);

      // The second-feed assertion keeps the first from being satisfiable by a
      // build that feeds the tail and then nothing.
      expect(fed[1].text).toBe(MESSAGE);
      expect(fed[1].text).not.toContain(TAIL_PREAMBLE as string);

      // And the priming turn produced no message in the chat, which catches a
      // build that lets the agent answer the tail.
      const chunks = await it.read.outbox();
      expect(chunks.length).toBe(1);
      expect(it.fake.posts().length).toBe(1);
      expect(it.fake.posts()[0].text).toBe(scriptedReply(MESSAGE));
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "LOOP-02 a turn without a preset ID is forbidden and the priming turn is a turn: a spawn records two turn records, the tail one against the agent and the message one against the inbound id, and the tail turn's text reaches neither the outbox nor the platform (SPEC §3 Forbidden, L18, and 02-CONTEXT D-50)",
  async () => {
    const { TAIL_PREAMBLE } = await seam("src/chatlog.ts");
    expect(typeof TAIL_PREAMBLE).toBe("string");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");

    const it = await stageHub(cluster);
    let door: { stop(): Promise<void> } | null = null;
    let runner: { stop(): Promise<void> } | null = null;

    try {
      const codeWord = `codeword-${crypto.randomUUID().slice(0, 8)}`;
      plantChatLine({
        stateDir: it.stateDir,
        text: `the word for today is ${codeWord}`,
      });

      // Each turn of this session reports its OWN numbers. Two records that
      // carry the same counts could be one record copied, and a copy is exactly
      // the build this check has to fail: the spend it would hide is every
      // spawn's priming turn.
      const tailUsage = {
        input_tokens: 4111,
        cached_input_tokens: 11,
        output_tokens: 17,
        plan_usage: null,
        raw: { which: "the priming turn", input_tokens: 4111 },
      };
      const messageUsage = {
        input_tokens: 9222,
        cached_input_tokens: 2022,
        output_tokens: 3133,
        plan_usage: null,
        raw: { which: "the message turn", input_tokens: 9222 },
      };

      // Held at the end so the two turns are settled one at a time, each with
      // its own numbers set just before it ends.
      it.scripted.holdTurnEnd(true);

      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      await until(
        "the tail of the log was fed first",
        () => it.scripted.fed().length >= 1,
        60_000,
        () => JSON.stringify(it.scripted.fed().map((f) => f.text)),
      );
      it.scripted.setUsage(tailUsage);
      it.scripted.endTurn();
      await until(
        "the priming turn was recorded",
        async () => (await it.read.ledger({ stream: "turn" })).length >= 1,
        60_000,
      );

      it.scripted.setUsage(messageUsage);
      it.fake.deliver({ text: MESSAGE });
      await until(
        "the loop was fed the message",
        () => it.scripted.fed().length >= 2,
        60_000,
      );
      it.scripted.endTurn();
      await until(
        "the reply was posted",
        () => it.fake.posts().length >= 1,
        60_000,
      );
      await Bun.sleep(1500);

      // A spawn feeds the tail, the loop runs a turn, and that turn costs real
      // tokens. Without this check a build hides a whole class of spend and the
      // Forbidden line has a hole exactly the size of every spawn.
      const turns = await it.read.ledger({ stream: "turn" });
      expect(turns.length).toBe(2);

      const [row] = await it.read.inbound();
      const tailTurn = turns.find((t) => t.detail.tail === true);
      const messageTurn = turns.find((t) => t.detail.tail === false);
      expect(tailTurn).toBeDefined();
      expect(messageTurn).toBeDefined();
      // Identified by subject, so a build writing two identical records fails.
      expect(tailTurn!.subject).toBe(AGENT);
      expect(messageTurn!.subject).toBe(row.id);

      // Every turn carries the preset id the registry held at that moment, the
      // priming one included. Asserting only that the tail record has SOME
      // sixteen-character string leaves a build free to write a constant there,
      // which is the Forbidden line with a hole the size of every spawn.
      const settings = {
        adapter: it.adapterName,
        effort: "medium",
        model: "a-model-name",
        paid: "plan",
        provider: "a-provider",
      };
      const expectedId = expectedPresetId(settings);
      for (const turn of turns) {
        expect(turn.actor).toBe("runner");
        expect(turn.detail.preset).toBe("daily");
        expect(turn.detail.preset_id).toBe(expectedId);
        expect(turn.detail.preset_settings).toEqual(settings);
      }

      // THE LOAD on the copy: each record carries the numbers ITS OWN turn
      // reported, and the two sets differ in all three counts and in the raw
      // object, so a record copied from the other fails every one of them.
      expect(tailTurn!.detail.input_tokens).toBe(tailUsage.input_tokens);
      expect(tailTurn!.detail.cached_input_tokens).toBe(
        tailUsage.cached_input_tokens,
      );
      expect(tailTurn!.detail.output_tokens).toBe(tailUsage.output_tokens);
      expect(tailTurn!.detail.raw_usage).toEqual(tailUsage.raw);

      expect(messageTurn!.detail.input_tokens).toBe(messageUsage.input_tokens);
      expect(messageTurn!.detail.cached_input_tokens).toBe(
        messageUsage.cached_input_tokens,
      );
      expect(messageTurn!.detail.output_tokens).toBe(messageUsage.output_tokens);
      expect(messageTurn!.detail.raw_usage).toEqual(messageUsage.raw);

      expect(tailTurn!.detail.input_tokens).not.toBe(
        messageTurn!.detail.input_tokens,
      );
      expect(tailTurn!.detail.output_tokens).not.toBe(
        messageTurn!.detail.output_tokens,
      );

      // The tail turn's own text is discarded and never becomes a reply.
      const tailReply = scriptedReply(`${TAIL_PREAMBLE as string}`);
      const chunks = await it.read.outbox();
      expect(chunks.length).toBe(1);
      for (const chunk of chunks) {
        expect(chunk.body).not.toContain(TAIL_PREAMBLE as string);
        expect(chunk.body).not.toContain(codeWord);
        expect(chunk.body).not.toBe(tailReply);
      }
      expect(it.fake.posts().length).toBe(1);
      for (const post of it.fake.posts()) {
        expect(post.text).not.toContain(TAIL_PREAMBLE as string);
        expect(post.text).not.toContain(codeWord);
      }
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);
