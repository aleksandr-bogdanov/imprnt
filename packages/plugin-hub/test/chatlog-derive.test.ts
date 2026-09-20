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
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
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
