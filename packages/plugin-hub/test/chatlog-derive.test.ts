// The chat log file and the lines derived from the store are two projections
// of one conversation, and over one real conversation they render the same
// bytes.
//
// The store already holds every message in both directions: an inbound row
// carries the platform's own record of what a person said, an outbox row
// carries what the agent or the door said back, and a `clock` diary row carries
// the one line the door says on its own. A runner whose agent's door is on
// another machine cannot read the file that door wrote, so it reads those rows
// instead, and the only thing that makes that safe is that the two readers
// agree line for line.
//
// THE CONVERSATION IS DRIVEN THROUGH THE REAL DOOR, never planted as file
// lines, because a planted file is a check on the planter. Every append site
// the log has is produced here: a person's message in, a two part reply out, a
// notice on the door's own route, a clock line the door posts when nobody
// claims the message, a harvest demand, and a `/recover` command. The recovery
// exchange is planted on purpose: it is the one exchange the store never holds,
// so the difference between the two readers is visible in the check rather than
// hidden.
//
// The clock line's TEXT is not stored. It is a pure function of the stamp, the
// seconds and the person's own language, so the diary row carries the line's id
// and its time and the derivation re-renders the sentence through that same
// function. One spelling, not two that have to be kept in step.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import { rolloutStage } from "./helpers/rollout-stage.ts";
import { fakeRecognizer } from "./helpers/fake-recognizer.ts";
import { WAV_RATE, plantSamples, writeWav } from "./helpers/wav.ts";
import { stageHub } from "./helpers/authorized-registry.ts";
import {
  AGENT,
  DOOR,
  PERSON,
  chatLogLines,
  insertInbound,
  plantChatLine,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
import { runDoor } from "../src/door/run.ts";
import { readTail } from "../src/chatlog.ts";
import { clockLine } from "../src/door/lines.ts";
import { readSlice } from "../src/harvest/slice.ts";
import { loadRegistry, readSetting } from "../src/registry/load.ts";
import { openStore, type Store } from "../src/store/connect.ts";

const SLOW = 120_000;

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** The five fields a line IS, whichever reader answered it. */
function five(line: { id?: string; at: string; direction: string; from: string; text: string }) {
  return {
    id: line.id,
    at: line.at,
    direction: line.direction,
    from: line.from,
    text: line.text,
  };
}

async function stageFor(language: "en" | "ru"): Promise<StagedHub> {
  return await stageHub(cluster, {
    hub: { tick_seconds: 5 },
    people: [
      {
        id: PERSON,
        language,
        // Short, so a clock really runs out while nobody has claimed the
        // message, which is the one line the door says on its own.
        acked_seconds: 1,
        started_seconds: 600,
        answered_seconds: 600,
        delivered_seconds: 600,
      },
    ],
  });
}

test(
  "the lines derived from the store are the lines in the chat log file, less the recovery exchange the store never holds",
  async () => {
    const it = await stageFor("en");
    const registry = loadRegistry(it.registryFile);
    const { deriveLines, deriveTail, deriveSlice } = await seam("src/chatlog/derive.ts");
    expect(typeof deriveLines).toBe("function");
    expect(typeof deriveTail).toBe("function");
    expect(typeof deriveSlice).toBe("function");
    let door: { stop(): Promise<void> } | null = null;
    let store: Store | null = null;
    try {
      store = await openStore({ url: cluster.url(it.db) });
      const derived = () =>
        (deriveLines as Function)(store, {
          registry,
          person: PERSON,
          agent: AGENT,
          from: new Date(Date.now() - 86_400_000).toISOString(),
          until: new Date(Date.now() + 60_000).toISOString(),
        }) as Promise<{ id?: string; at: string; direction: string; from: string; text: string }[]>;

      // A notice nobody has posted yet: its route is still null, and the door
      // that will speak it is the one the agent declares.
      await it.read.sql(
        `insert into outbox (kind, person, agent, notice_key, seq_in_reply, body)
         values ('notice', $1, $2, 'notice-one', 1, $3)`,
        [PERSON, AGENT, "a machinery line"],
      );
      const unpinned = (await derived()).find((line) => line.text === "a machinery line");
      expect(unpinned?.from, "a notice read before its route is pinned").toBe(DOOR);

      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      const said = it.fake.deliver({ text: "a message from the person" });
      await until(
        "the message is a row",
        async () => (await it.read.inbound()).some((row) => row.id.endsWith(said.platform_message_id)),
        20_000,
      );
      const messageId = (await it.read.inbound()).find((row) =>
        row.id.endsWith(said.platform_message_id),
      )!.id;
      // The clock runs out while the row is still `received`, so it is waited
      // for before a reply is written: a delivered reply takes the row out of
      // that state and no clock is owed after that.
      await until(
        "the clock ran out",
        async () => (await it.read.ledger({ stream: "clock" })).length === 1,
        30_000,
      );
      // ONE transaction, so both parts carry one `written_at` and the two lines
      // are a tie the order has to settle by something other than the clock.
      await it.read.sql(
        `insert into outbox (inbound_id, seq_in_reply, body)
         values ($1, 1, 'first part'), ($1, 2, 'later part')`,
        [messageId],
      );
      await until(
        "both parts of the reply landed",
        async () =>
          chatLogLines(it.stateDir, PERSON, AGENT).filter((line) => line.text.endsWith("part"))
            .length === 2,
        30_000,
      );
      const demanded = it.fake.deliver({ text: "harvest this" });
      await until(
        "the demand is a row of its own",
        async () => (await it.read.inbound()).some((row) => row.id.startsWith("harvest-demand:")),
        20_000,
      );

      // --- the tail, before the recovery exchange, which is the one thing the
      //     two readers differ by ------------------------------------------
      const now = new Date();
      const hours = Number(readSetting(registry, "hub.tail_hours"));
      const tokens = Number(readSetting(registry, "hub.tail_tokens"));
      const fileTail = await readTail({
        stateDir: it.stateDir,
        person: PERSON,
        agent: AGENT,
        now,
        hours,
        tokens,
      });
      expect(fileTail).not.toBe("");
      expect(
        await (deriveTail as Function)(store, { registry, person: PERSON, agent: AGENT, now, hours, tokens }),
        "the derived tail at the household's own budget",
      ).toBe(fileTail);
      // Again at a budget small enough to drop the oldest lines, so the
      // dropping rule is asserted and not only the happy case.
      const small = 40;
      const smallFileTail = await readTail({
        stateDir: it.stateDir,
        person: PERSON,
        agent: AGENT,
        now,
        hours,
        tokens: small,
      });
      expect(smallFileTail.split("\n").length).toBeLessThan(fileTail.split("\n").length);
      expect(
        await (deriveTail as Function)(store, { registry, person: PERSON, agent: AGENT, now, hours, tokens: small }),
        "the derived tail at a budget that drops the oldest lines",
      ).toBe(smallFileTail);

      // --- the clock line is derived and not stored ----------------------
      const expiry = (await it.read.ledger({ stream: "clock" }))[0];
      expect(expiry.kind).toBe("expired");
      // The four the shipped clock checks read, unchanged, beside the two new
      // ones: the detail grew and nothing moved.
      expect(expiry.detail.stamp).toBe("acked");
      expect(typeof expiry.detail.seconds).toBe("number");
      expect(expiry.detail.person).toBe(PERSON);
      expect(expiry.detail.agent).toBe(AGENT);
      expect(expiry.detail.id).toBe(`clock:${messageId}:acked`);
      expect(Number.isFinite(Date.parse(String(expiry.detail.at)))).toBe(true);
      // No rendered sentence anywhere in the row.
      expect(JSON.stringify(expiry.detail)).not.toContain("still waiting");
      const clockFromStore = (await derived()).find((line) => line.id === expiry.detail.id);
      expect(clockFromStore?.text).toBe(
        clockLine("en", String(expiry.detail.stamp), Number(expiry.detail.seconds)),
      );
      expect(clockFromStore?.from).toBe(DOOR);

      // --- the notice's speaker, now that its route is pinned -------------
      expect((await derived()).find((line) => line.text === "a machinery line")?.from).toBe(DOOR);

      // --- the recovery exchange: in the file, never in the store ---------
      const recovered = it.fake.deliver({ text: `/recover ${AGENT}` });
      await until(
        "the door answered the recovery command",
        async () =>
          chatLogLines(it.stateDir, PERSON, AGENT).some((line) =>
            String((line as { id?: string }).id ?? "").endsWith(`${recovered.platform_message_id}:notice`),
          ),
        20_000,
      );

      // --- a damaged row costs only itself --------------------------------
      await insertInbound(cluster, it.db, {
        id: "damaged-no-source",
        body: "a row whose source nobody wrote",
        logReady: true,
      });
      await insertInbound(cluster, it.db, {
        id: "damaged-no-text",
        body: "a row whose source says nothing",
        source: {
          log_id: "damaged-no-text",
          at: new Date().toISOString(),
          door: DOOR,
          chat: String(said.chat),
          sender_id: "fixture-sender",
        } as never,
        logReady: true,
      });

      // --- the two arrays, whole -----------------------------------------
      const fileLines = chatLogLines(it.stateDir, PERSON, AGENT);
      const recoveryIds = fileLines
        .map((line) => String((line as { id?: string }).id ?? ""))
        .filter((id) => id.startsWith("recover:"));
      expect(recoveryIds.length, "the recovery command and the door's answer").toBe(2);
      const spoken = fileLines.filter(
        (line) => !String((line as { id?: string }).id ?? "").startsWith("recover:"),
      );
      const lines = await derived();
      expect(lines.map(five), "every line of the conversation, in the file's own order").toEqual(
        spoken.map(five),
      );
      for (const id of recoveryIds) expect(lines.some((line) => line.id === id)).toBe(false);
      expect(lines.some((line) => line.text.includes("nobody wrote"))).toBe(false);
      expect(lines.some((line) => line.text.includes("says nothing"))).toBe(false);

      // --- the demand is ONE line in both ---------------------------------
      const demandId = `harvest-demand:${(await it.read.inbound()).find((row) =>
        row.id.endsWith(demanded.platform_message_id),
      )!.id.replace("harvest-demand:", "")}`;
      expect(lines.filter((line) => line.id === demandId).length).toBe(1);
      expect(
        fileLines.filter((line) => (line as { id?: string }).id === demandId).length,
      ).toBe(1);
      expect(lines.find((line) => line.id === demandId)?.from).toBe(PERSON);
      expect(lines.find((line) => line.id === demandId)?.text).toBe("harvest this");

      // --- the slice ------------------------------------------------------
      const until_ = new Date(Date.now() + 60_000).toISOString();
      const from = new Date(Date.now() - 86_400_000).toISOString();
      const fileSlice = await readSlice({
        stateDir: it.stateDir,
        person: PERSON,
        agent: AGENT,
        from,
        until: until_,
      });
      const storeSlice = (await (deriveSlice as Function)(store, {
        registry,
        person: PERSON,
        agent: AGENT,
        from,
        until: until_,
      })) as { at: string; direction: string; from: string; text: string }[];
      expect(storeSlice.map((line) => [line.at, line.direction, line.from, line.text])).toEqual(
        fileSlice.map((line) => [line.at, line.direction, line.from, line.text]),
      );
      expect(storeSlice.length).toBeGreaterThan(0);
      for (const dropped of ["harvest this", "/recover", "still waiting", "a machinery line"]) {
        expect(storeSlice.some((line) => line.text.includes(dropped)), dropped).toBe(false);
        expect(fileSlice.some((line) => line.text.includes(dropped)), dropped).toBe(false);
      }

      // --- the control: a line the file has and the store does not ---------
      plantChatLine({ stateDir: it.stateDir, text: "a line no store row is behind" });
      const afterPlanting = chatLogLines(it.stateDir, PERSON, AGENT).filter(
        (line) => !String((line as { id?: string }).id ?? "").startsWith("recover:"),
      );
      expect((await derived()).length).toBe(afterPlanting.length - 1);
    } finally {
      if (door) await door.stop();
      if (store) await store.close();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "the clock line is rendered in the person's own language from the diary row, because the sentence is never stored",
  async () => {
    const it = await stageFor("ru");
    const registry = loadRegistry(it.registryFile);
    const { deriveLines } = await seam("src/chatlog/derive.ts");
    let door: { stop(): Promise<void> } | null = null;
    let store: Store | null = null;
    try {
      store = await openStore({ url: cluster.url(it.db) });
      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.fake.platform,
      });
      it.fake.deliver({ text: "сообщение от человека" });
      await until(
        "the clock ran out",
        async () => (await it.read.ledger({ stream: "clock" })).length === 1,
        30_000,
      );
      const expiry = (await it.read.ledger({ stream: "clock" }))[0];
      const lines = (await (deriveLines as Function)(store, {
        registry,
        person: PERSON,
        agent: AGENT,
        from: new Date(Date.now() - 86_400_000).toISOString(),
        until: new Date(Date.now() + 60_000).toISOString(),
      })) as { id?: string; text: string }[];
      const clock = lines.find((line) => line.id === expiry.detail.id);
      const russian = clockLine("ru", String(expiry.detail.stamp), Number(expiry.detail.seconds));
      expect(clock?.text).toBe(russian);
      expect(russian).not.toBe(
        clockLine("en", String(expiry.detail.stamp), Number(expiry.detail.seconds)),
      );
      // The door wrote the same sentence into the file, which is what says the
      // derivation re-rendered it rather than guessed at it.
      expect(
        chatLogLines(it.stateDir, PERSON, AGENT).some((line) => line.text === russian),
      ).toBe(true);
    } finally {
      if (door) await door.stop();
      if (store) await store.close();
      await it.stop();
    }
  },
  SLOW,
);

const FFMPEG = Bun.which("ffmpeg");
const NEEDS_FFMPEG = FFMPEG ? "" : " [the words-have-landed half is skipped: ffmpeg is not on PATH]";

/** A decodable clip, as the bytes a platform would hand over. */
function clip(seconds = 1): Uint8Array {
  const path = `${tmpdir()}/derive-${crypto.randomUUID()}.wav`;
  try {
    writeWav(path, plantSamples({ seconds, rate: WAV_RATE, quietAt: [] }), WAV_RATE);
    return new Uint8Array(readFileSync(path));
  } finally {
    Bun.spawnSync(["rm", "-f", path]);
  }
}

test(
  `the two readers agree over a voice note, while it is still transcribing and once its words have landed${NEEDS_FFMPEG}`,
  async () => {
    // A VOICE NOTE IS THE ONE MESSAGE THAT IS A ROW BEFORE IT IS A LINE. The
    // door writes the note down at once and the words arrive later, and until
    // they do the file deliberately carries no line for it and carries the
    // door's own "still transcribing" line instead. A derivation that read
    // every row with a source served a spoke a line with no words in it and
    // dropped the sentence the person actually saw, which is the gap this
    // covers: the same conversation, read both ways, at both moments.
    const audio = clip();
    const recognizer = await fakeRecognizer();
    recognizer.setAnswer({ text: "synthetic spoken codeword", audio_s: 1, decode_ms: 1 });
    // The recognizer refuses, which is an infra failure, so the note stays
    // pending and the moment before the words is a state that holds still.
    recognizer.setStatus(503);
    const it = await rolloutStage(cluster, "telegram", {
      people: [
        // One second to the transcribing line, and every other clock long
        // enough that no other line of the door's own arrives in the window.
        {
          id: PERSON,
          language: "en",
          transcribed_seconds: 1,
          acked_seconds: 600,
          started_seconds: 600,
          answered_seconds: 600,
          delivered_seconds: 600,
        },
        { id: "p2", language: "ru" },
      ],
      voice: { port: recognizer.port, chunk_seconds: 0, retry_seconds: 1 },
    });
    const registry = loadRegistry(it.registryFile);
    const { deriveLines, deriveTail } = await seam("src/chatlog/derive.ts");
    let door: { stop(): Promise<void> } | null = null;
    let store: Store | null = null;
    try {
      store = await openStore({ url: cluster.url(it.db) });
      const derived = () =>
        (deriveLines as Function)(store, {
          registry,
          person: PERSON,
          agent: AGENT,
          from: new Date(Date.now() - 86_400_000).toISOString(),
          until: new Date(Date.now() + 60_000).toISOString(),
        }) as Promise<{ id?: string; at: string; direction: string; from: string; text: string }[]>;
      /**
       * The file's lines in the order EITHER reader answers them.
       *
       * The file is appended to as the door writes, and a voice note's line is
       * written when its words land rather than when it arrived, so the file
       * holds it after lines that are older than it is. Both readers answer in
       * the line's own time order (`readTail` sorts the file walk by it), so
       * that is the order the two are compared in, and the rendered tails
       * below are compared as the bytes a session is fed.
       */
      const fileLines = () =>
        [...chatLogLines(it.stateDir, PERSON, AGENT)].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      /** Nothing the door owes the chat is still in flight. */
      const settled = async () =>
        (await it.read.sql(
          "select count(*)::int as owed from outbox where coalesce(agent, $1) = $1 and delivered_at is null",
          [AGENT],
        ))[0].owed === 0;

      it.edge.file("voice", audio);
      door = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform: it.edge.platform,
      });
      it.edge.batch(
        [
          {
            platform_message_id: "1",
            chat: "1000000001",
            sender_id: PERSON,
            from: PERSON,
            text: "",
            at: new Date().toISOString(),
            media: [
              { kind: "voice", remote_id: "voice", name: "note.wav", mime: "audio/wav", bytes: audio.length, caption: null },
            ],
          },
        ],
        "1",
      );

      // --- while the words do not exist yet ------------------------------
      await until(
        "the door said it is still transcribing, and nothing is in flight",
        async () =>
          fileLines().some((line) => line.text === clockLine("en", "transcribed", 1)) && (await settled()),
        40_000,
        async () => JSON.stringify(fileLines()),
      );
      const [pending] = await it.read.sql("select id, log_ready, media_state from inbound where agent = $1", [AGENT]);
      expect(pending.media_state, "the note is waiting for its words").toBe("pending");
      expect(pending.log_ready, "a note with no words is no line").toBe(false);

      const waiting = await derived();
      expect(waiting.map(five), "every line of the chat while the note is transcribing").toEqual(
        fileLines().map(five),
      );
      // Said on its own, because a row with no words is the line a reader
      // could invent, and it is not a line in either of them.
      expect(waiting.some((line) => String(line.id) === String(pending.id))).toBe(false);
      // And the sentence the person really saw is in both.
      expect(waiting.some((line) => line.text === clockLine("en", "transcribed", 1))).toBe(true);
      // The tail a spoke would feed a session, over the same window.
      const now = new Date();
      const hours = Number(readSetting(registry, "hub.tail_hours"));
      const tokens = Number(readSetting(registry, "hub.tail_tokens"));
      expect(
        await (deriveTail as Function)(store, { registry, person: PERSON, agent: AGENT, now, hours, tokens }),
      ).toBe(await readTail({ stateDir: it.stateDir, person: PERSON, agent: AGENT, now, hours, tokens }));
      // The row is STILL waiting, so both reads above were taken at the moment
      // this test is about.
      expect(
        (await it.read.sql("select log_ready from inbound where agent = $1", [AGENT]))[0].log_ready,
      ).toBe(false);

      // --- and once they land --------------------------------------------
      if (!FFMPEG) return;
      recognizer.setStatus(200);
      await until(
        "the words landed, the line was written and nothing is in flight",
        async () =>
          fileLines().some((line) => line.text.includes("synthetic spoken codeword")) && (await settled()),
        60_000,
        async () => JSON.stringify(fileLines()),
      );
      const landed = await derived();
      expect(landed.map(five), "every line of the chat once the words landed").toEqual(fileLines().map(five));
      const spoken = landed.find((line) => line.text.includes("synthetic spoken codeword"));
      expect(spoken?.direction, "the note is the person's own message").toBe("in");
      expect(spoken?.from).toBe(PERSON);
      expect(landed.some((line) => line.text === clockLine("en", "transcribed", 1))).toBe(true);
      expect(
        await (deriveTail as Function)(store, {
          registry,
          person: PERSON,
          agent: AGENT,
          now: new Date(),
          hours,
          tokens,
        }),
      ).toBe(
        await readTail({ stateDir: it.stateDir, person: PERSON, agent: AGENT, now: new Date(), hours, tokens }),
      );
    } finally {
      if (door) await door.stop();
      if (store) await store.close();
      await recognizer.stop();
      await it.stop();
    }
  },
  SLOW,
);
