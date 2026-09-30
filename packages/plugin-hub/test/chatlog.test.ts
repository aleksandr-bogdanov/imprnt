// The chat log is the record, and a spawned session is handed its tail with the
// first message it answers.
//
// SPEC §2: "Chat log: the door appends every message in both directions to one
// dated file per agent, before sending. The loop's session is a cache. On every
// spawn of a fresh master session the runner hands it the tail (24 hours, 8k
// tokens, defaults until measured) as delimited background on the first real
// input: one feed, one model turn, one answer. The agent never chooses what to
// read on spawn. No per-agent tail size." Its Forbidden list carries "a fresh
// master session answering without the tail it was owed; the tail run as a model
// turn of its own". Its Check line: "A code word planted in the log survives a
// respawn."
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
  "MSG-12 a code word planted in the log survives a respawn: the first and only feed of a spawned session is the human message with the tail carrying the code word as delimited background, the conversation records the message as it was sent, and nothing is fed for the history alone (SPEC §2, L2)",
  async () => {
    const { TAIL_PREAMBLE, BACKGROUND_OPEN, BACKGROUND_CLOSE, readTail } = await seam("src/chatlog.ts");
    expect(typeof TAIL_PREAMBLE).toBe("string");
    expect(typeof BACKGROUND_OPEN).toBe("string");
    expect(typeof BACKGROUND_CLOSE).toBe("string");
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

      // The scripted loop echoes what it was fed, and what it was fed carries the
      // history: what is asserted about the ANSWER is that it is one, so it says
      // something of its own.
      it.scripted.setAnswer(() => "the one answer");

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

      // The session is up (an eager start) and it has been fed NOTHING: history alone is not a turn.
      await until("the resident session was started", () => it.scripted.starts().length >= 1, 60_000);
      await Bun.sleep(1500);
      expect(it.scripted.fed()).toEqual([]);

      it.fake.deliver({ text: MESSAGE });
      await until(
        "the reply was posted",
        () => it.fake.posts().length >= 1,
        60_000,
        () => JSON.stringify(it.scripted.fed().map((f) => f.text)),
      );
      await Bun.sleep(1500);

      // ONE feed, the message, with the tail in front of it between two delimiters.
      const fed = it.scripted.fed();
      expect(fed.length).toBe(1);
      const text = fed[0].text;
      expect(text.startsWith(BACKGROUND_OPEN as string)).toBe(true);
      expect(text).toContain(TAIL_PREAMBLE as string);
      expect(text).toContain(codeWord);
      expect(text.endsWith(`${BACKGROUND_CLOSE as string}\n\n${MESSAGE}`)).toBe(true);
      // The delimiters are in the right order: the code word is background, and the message is after it.
      expect(text.indexOf(codeWord)).toBeLessThan(text.indexOf(BACKGROUND_CLOSE as string));
      // The message being answered is not also in the history it rides with.
      expect(text.split(MESSAGE).length - 1).toBe(1);

      // THE CONVERSATION KEEPS THE MESSAGE AS IT WAS SENT: history is not put into
      // a transcript it did not come from, so nothing rebuilt from the transcript can carry it.
      const entries = (await it.read.sql(
        "select kind, body from conversation_entry order by seq",
      )) as { kind: string; body: string }[];
      expect(entries.map((e) => e.kind)).toEqual(["input", "reply"]);
      expect(entries[0].body).toBe(MESSAGE);
      for (const entry of entries) expect(entry.body).not.toContain(codeWord);
      // The attempt's digest names the input, and the feed intent says that history rode with it.
      const intents = await it.read.ledger({ stream: "execution", kind: "feed.intent" });
      expect(intents.length).toBe(1);
      expect(intents[0].detail.context).toMatchObject({ kind: "chat-tail" });
      expect(Number((intents[0].detail.context as { chars: number }).chars)).toBeGreaterThan(0);
      expect((await it.read.sql("select purpose from execution")).map((r) => r.purpose)).toEqual(["turn"]);

      // One visible answer, and it is the one the loop gave to the message.
      const chunks = await it.read.outbox();
      expect(chunks.length).toBe(1);
      expect(it.fake.posts().length).toBe(1);
      expect(it.fake.posts()[0].text).toBe("the one answer");
    } finally {
      if (runner) await runner.stop();
      if (door) await door.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "LOOP-02 a turn without a preset ID is forbidden, and a spawn takes ONE turn: the record is written against the inbound id with the numbers of the turn that was run, no turn is recorded or paid for the history, and the history reaches neither the outbox nor the platform (SPEC §3 Forbidden, L18, and 02-CONTEXT D-50)",
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

      // The one turn of this session reports its own numbers, so a record that
      // is not the turn's own (copied, or made up for the history) fails.
      const messageUsage = {
        input_tokens: 9222,
        cached_input_tokens: 2022,
        output_tokens: 3133,
        plan_usage: null,
        raw: { which: "the message turn", input_tokens: 9222 },
      };

      // Held at the end so the turn is settled with the numbers set just before it ends.
      it.scripted.holdTurnEnd(true);
      it.scripted.setAnswer(() => "the one answer");

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

      // The session comes up and nothing is fed for the history: no turn is run,
      // so none is recorded and none is paid for.
      await until("the resident session was started", () => it.scripted.starts().length >= 1, 60_000);
      await Bun.sleep(1500);
      expect(it.scripted.fed()).toEqual([]);
      expect(await it.read.ledger({ stream: "turn" })).toEqual([]);

      it.scripted.setUsage(messageUsage);
      it.fake.deliver({ text: MESSAGE });
      await until(
        "the loop was fed the message",
        () => it.scripted.fed().length >= 1,
        60_000,
      );
      it.scripted.endTurn();
      await until(
        "the reply was posted",
        () => it.fake.posts().length >= 1,
        60_000,
      );
      await Bun.sleep(1500);

      // A spawn takes one turn, and that turn costs real tokens: it is recorded
      // once, against the message, and there is no second record for the history.
      const turns = await it.read.ledger({ stream: "turn" });
      expect(turns.length).toBe(1);
      expect(it.scripted.fed().length).toBe(1);

      const [row] = await it.read.inbound();
      const messageTurn = turns[0];
      expect(messageTurn.detail.tail).toBe(false);
      expect(messageTurn.subject).toBe(row.id);
      expect(turns.some((t) => t.subject === AGENT)).toBe(false);

      // Every turn carries the preset id the registry held at that moment.
      // Asserting only that the record has SOME sixteen-character string leaves
      // a build free to write a constant there, which is the Forbidden line with
      // a hole the size of every spawn.
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

      // THE LOAD: the record carries the numbers of the turn that was run.
      expect(messageTurn.detail.input_tokens).toBe(messageUsage.input_tokens);
      expect(messageTurn.detail.cached_input_tokens).toBe(
        messageUsage.cached_input_tokens,
      );
      expect(messageTurn.detail.output_tokens).toBe(messageUsage.output_tokens);
      expect(messageTurn.detail.raw_usage).toEqual(messageUsage.raw);

      // The history the turn carried never becomes a reply.
      const chunks = await it.read.outbox();
      expect(chunks.length).toBe(1);
      for (const chunk of chunks) {
        expect(chunk.body).not.toContain(TAIL_PREAMBLE as string);
        expect(chunk.body).not.toContain(codeWord);
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
