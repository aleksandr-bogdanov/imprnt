// HARV-01. A harvest on a machine whose agent's door is elsewhere reads the
// same lines out of the store, files them through the real apply path, and
// settles its watermark at the last harvested line's own time.
//
// Only the READER moves. The watermark is still a sheet row settled with the
// turn, the staging directory is still this machine's own `hub.state_dir`, the
// vault must still be on this machine, and a slice is still the person's lines
// and the agent's, with the door's machinery lines and the demand phrase
// dropped. The last clause of the watermark is the one that matters: it carries
// the last harvested LINE's own time, so a line that arrives between the read
// and the settle falls into the next slice instead of being skipped.
//
// The filing is the real `imprnt` CLI against a real vault, the way every other
// harvest check in this suite drives it. Only the loop is scripted.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { seam, startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { fakeProber } from "./helpers/prober.ts";
import { plantLine, stageHarvest, type HarvestStage } from "./helpers/harvest-stage.ts";
import { slugOf } from "./helpers/scratch-vault.ts";
import {
  AGENT,
  CHAT,
  DOOR,
  PERSON,
  RUNNER,
  RUNNER2,
  SPOKE_MACHINE,
  DOOR_MACHINE,
  insertInbound,
  spokeStage,
  superStore,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
import { renderSlice, readSlice, type SliceLine } from "../src/harvest/slice.ts";
import { encodeHarvestBody, harvestRowId } from "../src/harvest/row.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { openStore, type Store } from "../src/store/connect.ts";
import { runRunner } from "../src/runner/run.ts";

let cluster: Cluster;

const SLOW = 120_000;

const TITLE = "The card fee rises in October";
const NOTE = `---
type: note
domain: finances
kind: reference
summary: The monthly card fee rises from nine to eleven in October.
tags: [banking, fees]
---

# ${TITLE}

The bank said the monthly card fee goes from nine to eleven in October.`;

function envelope(note: string): string {
  return `=== NOTE ===\n${note}\n=== END ===`;
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** A person's line, as a store row and in no file anywhere. */
async function plantSaid(it: StagedHub, id: string, text: string, at: Date): Promise<SliceLine> {
  await insertInbound(cluster, it.db, {
    id,
    body: text,
    receivedAt: at.toISOString(),
    logReady: true,
    source: {
      log_id: id,
      at: at.toISOString(),
      door: DOOR,
      chat: CHAT,
      sender_id: "fixture-sender",
      text,
    },
  });
  // The message is over: it was answered and delivered long ago. Without that
  // the runner would claim it as work and answer it again, which is a
  // conversation this check is not about.
  await it.read.sql(
    `insert into ledger_event (at, stream, subject, kind, actor)
     values ($2, 'inbound', $1, 'delivered', 'door')`,
    [id, new Date(at.getTime() + 1000).toISOString()],
  );
  return { at: at.toISOString(), direction: "in", from: PERSON, text };
}

/** The agent's answer, as the outbox row the door would have posted. */
async function plantAnswer(it: StagedHub, to: string, text: string, at: Date): Promise<SliceLine> {
  const [row] = await it.read.sql(
    `insert into outbox (inbound_id, seq_in_reply, body, written_at, delivered_at, delivery_state)
     values ($1, 1, $2, $3, $3, 'delivered') returning id`,
    [to, text, at.toISOString()],
  );
  expect(row.id).toBeDefined();
  return { at: at.toISOString(), direction: "out", from: AGENT, text };
}

async function spokeHarvestStage(options: Parameters<typeof stageHarvest>[1] = {}): Promise<HarvestStage> {
  const spoke = spokeStage();
  return await stageHarvest(cluster, {
    ...spoke,
    ...options,
    harvestPeople: [{ id: PERSON, language: "en" }],
  });
}

test(
  "a harvest row for a spoke agent files from a store-derived slice and settles at the last harvested line's own time",
  async () => {
    const stage = await spokeHarvestStage({
      hub: { tick_seconds: 2 },
      harvest: { quiet_minutes: 600, min_messages: 99, report: false },
    });
    const it = stage.hub;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      const now = Date.now();
      const ago = (minutes: number) => new Date(now - minutes * 60_000);
      // The first line is BEFORE the watermark and must not be harvested twice.
      const harvested = await plantSaid(it, "said-long-ago", "the old news", ago(90));
      await it.read.sql(
        `insert into state_row (sheet, id, data) values ('harvest', $1, $2::jsonb)`,
        [
          `${PERSON}/${AGENT}`,
          JSON.stringify({
            at: harvested.at,
            row: "an earlier harvest",
            harvested_at: harvested.at,
            notes: 1,
            lines: 1,
          }),
        ],
      );
      const first = await plantSaid(it, "said-one", "the bank raised the card fee", ago(40));
      const answer = await plantAnswer(it, "said-one", "from nine to eleven, in October", ago(39));
      const last = await plantSaid(it, "said-two", "and it starts in October", ago(38));
      // A demand is a line in the chat and never a line in a slice.
      const demand = await plantSaid(it, "harvest-demand:said-three", "harvest this", ago(37));
      const slice = [first, answer, last];

      it.scripted.setAnswer(() => envelope(NOTE));
      runner = await runRunner({
        runner: RUNNER2,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      const until_ = new Date(now).toISOString();
      const rowId = harvestRowId(AGENT, until_);
      await insertInbound(cluster, it.db, {
        id: rowId,
        kind: "harvest",
        body: encodeHarvestBody({ from: null, until: until_, reason: "quiet", lines: slice.length }),
      });

      await until(
        "the harvest settled",
        async () => (await it.read.harvestSheet()).some((row) => row.id === `${PERSON}/${AGENT}` && row.data.row === rowId),
        60_000,
        async () =>
          `inbound=${JSON.stringify(await it.read.inbound())} sheet=${JSON.stringify(
            await it.read.harvestSheet(),
          )} refusals=${JSON.stringify(await it.read.ledger({ stream: "refusal" }))}`,
      );

      // --- the message the harvester was fed is the slice, rendered the one way
      const fed = it.scripted.fed().filter((one) => one.id === rowId);
      expect(fed.length).toBe(1);
      expect(fed[0].text.endsWith(renderSlice(slice)), `fed: ${fed[0].text}`).toBe(true);
      expect(fed[0].text).not.toContain("the old news");
      // The demand's own rendered line, because the harvester's prompt is
      // allowed to talk about harvesting and the slice is not.
      expect(fed[0].text).not.toContain(renderSlice([demand]));

      // --- the note really landed in the vault, through the real CLI
      expect(existsSync(join(stage.vault.vaultDir, "finances", `${slugOf(TITLE)}.md`))).toBe(true);
      expect(
        readFileSync(join(stage.vault.vaultDir, "finances", `${slugOf(TITLE)}.md`), "utf8"),
      ).toContain("nine to eleven");

      // --- the watermark is the LAST HARVESTED LINE's own time
      const sheet = (await it.read.harvestSheet()).find((row) => row.id === `${PERSON}/${AGENT}`)!;
      expect(sheet.data.at).toBe(last.at);
      expect(sheet.data.at).not.toBe(until_);
      expect(sheet.data.lines).toBe(slice.length);

      // --- the staging directory was this machine's own state dir
      const { stageDirFor } = await seam("src/harvest/apply.ts");
      const staged = (stageDirFor as Function)(it.stateDir, PERSON, rowId) as string;
      expect(staged.startsWith(it.stateDir)).toBe(true);
      // --- and the turn was recorded under the HARVESTER's preset
      const turns = await it.read.ledger({ stream: "turn", subject: rowId });
      expect(turns.length).toBe(1);
      expect((turns[0].detail as { preset?: string }).preset).toBe("harvest");
    } finally {
      await runner?.stop();
      await stage.stop();
    }
  },
  SLOW,
);

test(
  "the derived slice is the file's slice, line for line, and the lower bound is exclusive in both",
  async () => {
    const stage = await spokeHarvestStage();
    const it = stage.hub;
    const { deriveSlice } = await seam("src/chatlog/derive.ts");
    let store: Store | null = null;
    try {
      store = await openStore({ url: cluster.url(it.db) });
      const now = Date.now();
      const ago = (minutes: number) => new Date(now - minutes * 60_000);
      const lines: SliceLine[] = [
        await plantSaid(it, "one", "the bank raised the card fee", ago(40)),
        await plantAnswer(it, "one", "from nine to eleven", ago(39)),
        await plantSaid(it, "two", "and the lease notice is two months", ago(38)),
      ];
      // The same conversation in the FILE, so the two readers can be compared
      // over one set of lines rather than over two different ones.
      for (const line of lines) plantLine(stage, { ...line, direction: line.direction as "in" | "out" });

      const registry = loadRegistry(it.registryFile);
      const until_ = new Date(now).toISOString();
      for (const from of [null, lines[0].at, lines[1].at]) {
        const fromFile = await readSlice({
          stateDir: it.stateDir,
          person: PERSON,
          agent: AGENT,
          from,
          until: until_,
        });
        const fromStore = (await (deriveSlice as Function)(store, {
          registry,
          person: PERSON,
          agent: AGENT,
          from,
          until: until_,
        })) as SliceLine[];
        expect(
          fromStore.map((line) => [line.at, line.direction, line.from, line.text]),
          `lower bound ${from}`,
        ).toEqual(fromFile.map((line) => [line.at, line.direction, line.from, line.text]));
      }
      // The line AT the bound is outside the next slice in both readers, which
      // is what stops one line being harvested twice at its own edge.
      const atTheBound = (await (deriveSlice as Function)(store, {
        registry,
        person: PERSON,
        agent: AGENT,
        from: lines[0].at,
        until: until_,
      })) as SliceLine[];
      expect(atTheBound.length).toBe(2);
      expect(atTheBound.some((line) => line.text === lines[0].text)).toBe(false);
    } finally {
      if (store) await store.close();
      await stage.stop();
    }
  },
  SLOW,
);

test(
  "check measures a spoke chat's unharvested lines where its runner is, and reports it once",
  async () => {
    const { runCheck } = await seam("src/check/run.ts");
    const stage = await spokeHarvestStage({ harvest: { quiet_minutes: 30, min_messages: 2, report: false } });
    const it = stage.hub;
    const store = await superStore(cluster, it.db);
    try {
      const now = Date.now();
      const old = new Date(now - 3 * 86_400_000);
      await plantSaid(it, "ancient-one", "something worth keeping", old);
      await plantSaid(it, "ancient-two", "and something else", new Date(old.getTime() + 60_000));
      const ask = async (machine: string) =>
        ((await (runCheck as Function)({
          machine,
          registryFile: it.registryFile,
          store,
          os: null,
          kernel: null,
          credentials: fakeProber({}),
          now: new Date(now),
        })) as { kind: string; subject: string; says: string }[]).filter(
          (one) => one.kind === "harvest-stale",
        );

      const onTheRunner = await ask(SPOKE_MACHINE);
      expect(onTheRunner.length).toBe(1);
      expect(onTheRunner[0].subject).toBe(`${PERSON}/${AGENT}`);
      expect(onTheRunner[0].says).toContain("2 line(s)");
      // The door's machine reports nothing about this chat: the finding belongs
      // where the runner that would harvest it is.
      expect(await ask(DOOR_MACHINE)).toEqual([]);
    } finally {
      await store.close();
      await stage.stop();
    }
  },
  SLOW,
);

test(
  "a local agent's harvest still reads its file and still settles where it settled",
  async () => {
    const stage = await stageHarvest(cluster, {
      hub: { tick_seconds: 2 },
      harvest: { quiet_minutes: 600, min_messages: 99, report: false },
    });
    const it = stage.hub;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      const now = Date.now();
      const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
      const lines = [
        plantLine(stage, { at: at(40), direction: "in", from: PERSON, text: "the bank raised the card fee" }),
        plantLine(stage, { at: at(39), direction: "out", from: AGENT, text: "from nine to eleven, in October" }),
      ];
      it.scripted.setAnswer(() => envelope(NOTE));
      runner = await runRunner({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      const until_ = new Date(now).toISOString();
      const rowId = harvestRowId(AGENT, until_);
      await insertInbound(cluster, it.db, {
        id: rowId,
        kind: "harvest",
        body: encodeHarvestBody({ from: null, until: until_, reason: "quiet", lines: lines.length }),
      });
      await until(
        "the local harvest settled",
        async () => (await it.read.harvestSheet()).some((row) => row.data.row === rowId),
        60_000,
        async () =>
          `sheet=${JSON.stringify(await it.read.harvestSheet())} refusals=${JSON.stringify(
            await it.read.ledger({ stream: "refusal" }),
          )}`,
      );
      const fed = it.scripted.fed().filter((one) => one.id === rowId);
      expect(fed.length).toBe(1);
      expect(fed[0].text.endsWith(renderSlice(lines as SliceLine[]))).toBe(true);
      expect(existsSync(join(stage.vault.vaultDir, "finances", `${slugOf(TITLE)}.md`))).toBe(true);
      const sheet = (await it.read.harvestSheet()).find((row) => row.id === `${PERSON}/${AGENT}`)!;
      expect(sheet.data.at).toBe(lines[lines.length - 1].at);
    } finally {
      await runner?.stop();
      await stage.stop();
    }
  },
  SLOW,
);
