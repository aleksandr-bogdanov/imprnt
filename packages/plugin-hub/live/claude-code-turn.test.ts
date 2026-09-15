// LIVE. A turn with no tool call lands, and it records what the real loop
// reported.
//
// SPEC §2: "A turn with no tool call still lands." SPEC §3: "Every turn records
// the preset ID, the tokens the loop reported (input, cached input, output)...
// Record everything the loop gives, never guess a number." And on a plan login
// "it is not a price, it is plan usage, recorded as the loop reports it."
//
// The scripted version of the stamp ordering in test/runner-turn.test.ts is
// deterministic by construction. This one is not, which is why it is worth
// running: only a real loop puts the order under real timing pressure.
//
// It needs the Claude Code login on this Mac and no platform token. See
// live/claude-code-respawn.test.ts for why it lives outside test/.
//
// Red reason: import missing, src/adapters/claude-code.ts, reached through
// src/adapters/index.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
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
  scratchDir,
  storeReader,
  userlessStoreUrl,
} from "../test/helpers/hub-fixture.ts";
import { createFakePlatform } from "../test/helpers/fake-platform.ts";
/** The pinned formula, computed by the test rather than read from the build. */
import { expectedPresetId } from "../test/helpers/preset-oracle.ts";

let cluster: Cluster;

/** Bounds the whole test, and the wait below is well inside it. */
const LIVE = 420_000;
const ANSWER_MS = 240_000;

/** The cheap real model, named here and nowhere else in the repository. */
const MODEL = "claude-haiku-4-5-20251001";

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

test(
  "LIVE MSG-03 and LOOP-02 a turn with no tool call still lands and carries the loop's own numbers: the posted text is the turn's text, the preset id is the pinned formula over the scratch registry, the token counts are above zero, and acked precedes started precedes answered (SPEC §2 and §3, L1 and L18)",
  async () => {
    const { ADAPTERS } = await seam("src/adapters/index.ts");
    expect(typeof ADAPTERS).toBe("object");
    expect(Object.keys(ADAPTERS as object)).toContain("claude-code");
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const db = await freshDatabase(cluster);
    const dir = await scratchDir("hub-live-turn-");
    const fake = createFakePlatform({ name: "fake" });
    const read = storeReader(cluster, db);
    const settings = {
      adapter: "claude-code",
      model: MODEL,
      provider: "anthropic",
      effort: "low",
      paid: "plan",
    };
    const registryFile = writeRegistry(dir, {
      hub: { store_url: userlessStoreUrl(cluster, db), state_dir: dir },
      presets: { daily: settings },
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
    let runner: { stop(): Promise<void> } | null = null;

    try {
      door = await (runDoor as Function)({
        door: DOOR,
        registryFile,
        platform: fake.platform,
      });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile,
        adapters: ADAPTERS,
      });

      // An answer that needs no tool of any kind.
      fake.deliver({
        text: "reply with the single word ready and nothing else.",
      });

      await until(
        "the reply was posted",
        () => fake.posts().length >= 1,
        ANSWER_MS,
        async () =>
          `ledger=${JSON.stringify(await read.ledger({ stream: "inbound" }))}`,
      );
      await Bun.sleep(2000);

      // The reply reached the outbox and the platform, and the posted text is
      // the turn's own text.
      const chunks = await read.outbox();
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(fake.posts().length).toBe(chunks.length);
      expect(fake.posts().map((p) => p.text).join("")).toBe(
        chunks.map((c) => c.body).join(""),
      );

      const [row] = await read.inbound();
      const turns = (await read.ledger({ stream: "turn" })).filter(
        (t) => t.subject === row.id,
      );
      expect(turns.length).toBe(1);
      const turn = turns[0];

      expect(turn.detail.preset_id).toBe(expectedPresetId(settings));
      expect(turn.detail.preset_settings).toEqual(settings);

      // The loop's own numbers, asserted above zero rather than against fixed
      // ones, because they are the real loop's.
      expect(Number(turn.detail.input_tokens)).toBeGreaterThan(0);
      expect(Number(turn.detail.output_tokens)).toBeGreaterThan(0);
      const raw = turn.detail.raw_usage as Record<string, unknown>;
      expect(raw).toBeTruthy();
      expect(Object.keys(raw).length).toBeGreaterThan(0);

      // THE NO-TOOL-CALL OBSERVATION. The loop reports how many turns it took,
      // and a tool round trip makes that larger than one. This is what "a turn
      // with no tool call still lands" means when a real loop is answering, and
      // it is read from the loop's own report rather than from a flag we set.
      expect(Number(raw.num_turns)).toBe(1);

      // THE INDEPENDENT COMPARISON. The posted text is the loop's own result,
      // not merely the same as the outbox the same code wrote. A runner that
      // replaced the loop's text with anything of its own fails here.
      expect(typeof raw.result).toBe("string");
      expect(String(raw.result).trim().length).toBeGreaterThan(0);
      expect(fake.posts().map((p) => p.text).join("")).toBe(String(raw.result));
      expect(typeof turn.detail.session_id).toBe("string");
      expect((turn.detail.session_id as string).length).toBeGreaterThan(8);

      // A plan login reports its windows and has no price.
      expect(turn.detail.price).toBeNull();
      expect(turn.detail.plan_usage).not.toBeNull();

      // The ordering, under real timing pressure.
      const stamps = await read.ledger({ stream: "inbound", subject: row.id });
      const at = (kind: string) => {
        const found = stamps.find((s) => s.kind === kind);
        expect(found).toBeDefined();
        return found!;
      };
      expect(at("acked").seq).toBeLessThan(at("started").seq);
      expect(at("started").seq).toBeLessThan(at("answered").seq);
      expect(new Date(at("acked").at).getTime()).toBeLessThanOrEqual(
        new Date(at("started").at).getTime(),
      );
      expect(new Date(at("started").at).getTime()).toBeLessThanOrEqual(
        new Date(at("answered").at).getTime(),
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
