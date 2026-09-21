// LIVE. A real harvester, on a machine whose agent's door is elsewhere, reads a
// slice that exists ONLY as store rows and files what came back into a real
// vault through the real `imprnt`. (SPEC §4, L19)
//
// WHY IT IS HERE RATHER THAN IN THE AUTOMATED SET. Everything a shim can close
// about a spoke harvest is closed by `test/spoke-harvest.test.ts`: the derived
// slice equals the file's line for line, the watermark lands at the last
// harvested line's own time, and the staging directory is this machine's own.
// What no shim can close is that a real model turn, fed a slice nothing on this
// machine has a file for, produces something a real CLI can file into a real
// vault. That is this file, and it lives outside bun's test root so no
// automated run reaches it. `bun run test:live` is what runs it.
//
// IT TAKES ITS VAULT AND ITS COMMAND AS ARGUMENTS AND REFUSES TO RUN WITHOUT
// THEM. `HUB_LIVE_VAULT` is the vault PROJECT ROOT, the directory holding
// `vault/` and `raw/`, and `HUB_LIVE_IMPRNT` is the command `hub.imprnt` names.
// Both are checked before the test is named, the reason is printed, and the
// test is not run. A check that quietly passed with neither would prove
// nothing and would look like evidence.
//
// THE VAULT IT IS POINTED AT IS A SCRATCH CLONE. This check WRITES A NOTE INTO
// IT through a real filing, and the note's path is recorded before anything is
// removed so a run that fell over says what it left behind. Never point it at a
// vault anybody relies on.
//
// WHAT THE MODEL WROTE IS ASSERTED NOWHERE. A harvester's judgement is the
// model's, and a check that bound its words would fail for a model release.
// What is asserted is the machinery: a note landed, the watermark moved to the
// last line the harvester was shown, and the turn carries the harvester's
// preset and the loop's own token counts. The measured numbers are PRINTED,
// because those are what a first real week is supposed to produce.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { seam, startCluster, until, type Cluster } from "../test/helpers/cluster.ts";
import {
  AGENT,
  CHAT,
  DOOR,
  PERSON,
  RUNNER2,
  chatLogFile,
  insertInbound,
  spokeStage,
  stageHub,
  type StagedHub,
} from "../test/helpers/hub-fixture.ts";
import type { PresetSpec } from "../test/helpers/registry.ts";
import { encodeHarvestBody, harvestRowId } from "../src/harvest/row.ts";
import type { SliceLine } from "../src/harvest/slice.ts";

/** Bounds the whole check, and the wait below is well inside it. */
const LIVE = 600_000;
const ANSWER_MS = 300_000;

/** The cheap real model, named here and nowhere else in this file. */
const MODEL = "claude-haiku-4-5-20251001";

const vaultRoot = process.env.HUB_LIVE_VAULT ?? "";
const imprnt = process.env.HUB_LIVE_IMPRNT ?? "";

function why(): string {
  if (vaultRoot === "") return "HUB_LIVE_VAULT names no vault project root, and this check writes a note into one";
  if (imprnt === "") return "HUB_LIVE_IMPRNT names no imprnt command, and this check files through a real one";
  if (!existsSync(join(vaultRoot, "vault"))) return `${vaultRoot} holds no vault directory`;
  if (!existsSync(join(vaultRoot, "raw"))) return `${vaultRoot} holds no raw directory`;
  if (!existsSync(imprnt)) return `${imprnt} is not there`;
  return "";
}

const reason = why();
if (reason !== "") process.stderr.write(`SKIP: the live spoke harvest: ${reason}\n`);

let cluster: Cluster;

beforeAll(async () => {
  if (reason === "") cluster = await startCluster();
});

afterAll(async () => {
  await cluster?.stop();
});

/** Every `.md` under the vault's own note folders, relative, sorted. */
function notesOnDisk(vaultDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
      const here = join(dir, entry.name);
      if (entry.isDirectory()) walk(here, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith(".md") && prefix !== "") out.push(`${prefix}${entry.name}`);
    }
  };
  walk(vaultDir, "");
  return out.sort();
}

test.skipIf(reason !== "")(
  `LIVE a real harvester on a spoke files into a real vault from a slice that exists only in the store${reason === "" ? "" : ` [skipped: ${reason}]`}`,
  async () => {
    const { ADAPTERS } = await seam("src/adapters/index.ts");
    expect(Object.keys(ADAPTERS as object)).toContain("claude-code");
    const { runRunner } = await seam("src/runner/run.ts");
    // The reader this whole transport rests on. A file-fed harvest would go on
    // working with this import missing, which is why it is named here.
    const { deriveSlice } = await seam("src/chatlog/derive.ts");
    expect(typeof deriveSlice).toBe("function");

    const vaultDir = join(vaultRoot, "vault");
    const before = notesOnDisk(vaultDir);
    let filed: string[] = [];
    let it: StagedHub | null = null;
    let runner: { stop(): Promise<void> } | null = null;
    try {
      const preset: PresetSpec = {
        adapter: "claude-code",
        model: MODEL,
        provider: "anthropic",
        effort: "medium",
        paid: "plan",
      };
      // The spoke placement composes rather than being copied: its own registry
      // step moves the agent onto the machine that has no door, and the
      // harvester's preset is added on top of whatever it produced. `stageHub`
      // writes one preset of its own and knows nothing about a harvester's, so
      // this is where that table gains its second entry.
      const placement = spokeStage().registry!;
      it = await stageHub(cluster, {
        ...spokeStage(),
        hub: { tick_seconds: 2 },
        imprnt,
        // The person's vault has to lie inside their tree, so the tree is the
        // directory the vault project was cloned into.
        people: [
          {
            id: PERSON,
            language: "en",
            tree: dirname(vaultRoot),
            vault: vaultRoot,
            harvester: "harvest",
            harvest_quiet_minutes: 600,
            harvest_min_messages: 99,
            harvest_report: false,
          },
        ],
        registry: (base) => {
          const placed = placement(base);
          return { ...placed, presets: { ...(placed.presets ?? {}), harvest: preset } };
        },
      });

      // --- 1. THE SLICE CAME FROM THE STORE. Every line below is a row and
      //     nothing on this machine has a file for any of them.
      const chatDir = dirname(
        chatLogFile({ stateDir: it.stateDir, person: PERSON, agent: AGENT, at: new Date() }),
      );
      expect(existsSync(chatDir), "a chat log directory exists before the run").toBe(false);

      const now = Date.now();
      const ago = (minutes: number) => new Date(now - minutes * 60_000);
      const said = async (id: string, text: string, at: Date): Promise<SliceLine> => {
        await insertInbound(cluster, it!.db, {
          id,
          body: text,
          receivedAt: at.toISOString(),
          logReady: true,
          source: { log_id: id, at: at.toISOString(), door: DOOR, chat: CHAT, sender_id: "fixture-sender", text },
        });
        await it!.read.sql(
          `insert into ledger_event (at, stream, subject, kind, actor)
           values ($2, 'inbound', $1, 'delivered', 'door')`,
          [id, new Date(at.getTime() + 1000).toISOString()],
        );
        return { at: at.toISOString(), direction: "in", from: PERSON, text };
      };
      const answered = async (to: string, text: string, at: Date): Promise<SliceLine> => {
        await it!.read.sql(
          `insert into outbox (inbound_id, seq_in_reply, body, written_at, delivered_at, delivery_state)
           values ($1, 1, $2, $3, $3, 'delivered')`,
          [to, text, at.toISOString()],
        );
        return { at: at.toISOString(), direction: "out", from: AGENT, text };
      };

      // Three durable facts with chatter around them, deliberately
      // unmistakable, so an answer of nothing is read as the prompt failing
      // rather than as the model exercising its taste.
      const lines: SliceLine[] = [
        await said("live-one", "morning", ago(50)),
        await answered("live-one", "morning, what is on today", ago(49)),
        await said(
          "live-two",
          "the dentist moved my appointment from Tuesday to Thursday the 24th at 9am, and it is the six month check rather than the filling",
          ago(48),
        ),
        await answered("live-two", "noted, Thursday the 24th at 9am", ago(47)),
        await said(
          "live-three",
          "also I cancelled the gym membership today, the last charge was 42 on the 3rd of August and they said the refund takes ten working days",
          ago(46),
        ),
        await answered("live-three", "got it, cancelled, refund in ten working days", ago(45)),
      ];
      const last = lines[lines.length - 1];

      runner = (await (runRunner as Function)({
        runner: RUNNER2,
        registryFile: it.registryFile,
        adapters: ADAPTERS as Record<string, unknown>,
      })) as { stop(): Promise<void> };

      const until_ = new Date(now).toISOString();
      const rowId = harvestRowId(AGENT, until_);
      await insertInbound(cluster, it.db, {
        id: rowId,
        kind: "harvest",
        body: encodeHarvestBody({ from: null, until: until_, reason: "quiet", lines: lines.length }),
      });

      await until(
        "the harvest settled",
        async () =>
          (await it!.read.harvestSheet()).some(
            (row) => row.id === `${PERSON}/${AGENT}` && row.data.row === rowId,
          ),
        ANSWER_MS,
        async () =>
          `inbound=${JSON.stringify(await it!.read.inbound())} refusals=${JSON.stringify(
            await it!.read.ledger({ stream: "refusal" }),
          )}`,
      );

      // Still no file for any of it, during and after.
      expect(existsSync(chatDir), "a chat log directory appeared during the run").toBe(false);

      // --- 2. A NOTE LANDED IN THE REAL VAULT. The path is printed rather than
      //     asserted: where a note goes is the vault's contract and not this
      //     check's, and the folder and the slug are the model's call.
      const after = notesOnDisk(vaultDir);
      filed = after.filter((one) => !before.includes(one));
      process.stderr.write(
        `[live-spoke-harvest] the harvester filed ${filed.length} note(s): ${filed.join(", ") || "none"}\n`,
      );
      expect(
        filed.length,
        "the harvester answered nothing to a slice carrying three dated facts, which is the prompt failing rather than this check",
      ).toBeGreaterThan(0);
      for (const one of filed) {
        const size = statSync(join(vaultDir, one)).size;
        process.stderr.write(`[live-spoke-harvest] ${one} is ${size} bytes\n`);
        expect(size).toBeGreaterThan(0);
      }

      // --- 3. THE WATERMARK IS THE LAST HARVESTED LINE'S OWN TIME, which is
      //     the property that stops a slice being harvested twice and is the
      //     one thing a real filing can get wrong that a shim cannot.
      const sheet = (await it.read.harvestSheet()).find((row) => row.id === `${PERSON}/${AGENT}`)!;
      expect(sheet.data.at).toBe(last.at);
      expect(sheet.data.at).not.toBe(until_);

      // --- 4. The turn record carries the harvester's preset and the loop's
      //     own token counts, and the numbers are printed.
      const turns = await it.read.ledger({ stream: "turn", subject: rowId });
      expect(turns.length).toBe(1);
      const detail = turns[0].detail as Record<string, unknown>;
      expect(detail.preset).toBe("harvest");
      expect(Number(detail.input_tokens)).toBeGreaterThan(0);
      expect(Number(detail.output_tokens)).toBeGreaterThan(0);
      expect(detail.cached_input_tokens).not.toBeNull();
      process.stderr.write(
        `[live-spoke-harvest] the turn cost ${detail.input_tokens} in, ${detail.output_tokens} out, ${detail.cached_input_tokens} cached\n`,
      );
      expect(await it.read.ledger({ stream: "refusal" })).toEqual([]);
    } finally {
      await runner?.stop();
      // --- 5. Everything this run put in the vault comes out again, with the
      //     paths already printed above so a failed run says what it left.
      for (const one of filed) rmSync(join(vaultRoot, "vault", one), { force: true });
      await it?.stop();
    }
  },
  LIVE,
);
