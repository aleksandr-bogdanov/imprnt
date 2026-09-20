// LOOP-02 and LOOP-03. What every turn records, and where the numbers come from.
//
// SPEC §3: "Every turn records the preset ID, the tokens the loop reported
// (input, cached input, output), the price when knowable from a dated rate
// table in the registry, otherwise plan usage as the loop reports it. Record
// everything the loop gives, never guess a number." And: "Changing a preset is
// a registry edit picked up on the next turn." Its Forbidden list carries "a
// turn without a preset ID" and "a guessed price".
//
// The scripted loop reports numbers the test chose, including a zero and a
// large one, so a rounded or recomputed value is caught. "Record everything the
// loop gives, never guess a number" has no meaning unless a check would notice.
//
// Red reasons: import missing, src/registry/presets.ts and src/runner/run.ts.
// Schema missing, the ledger_event_runner_turn policy.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import {
  startCluster,
  seam,
  startReadySubprocess,
  until,
  type Cluster,
  type ReadyProcess,
} from "./helpers/cluster.ts";
import type { AdapterUsage } from "../src/adapters/types.ts";
import {
  AGENT,
  RUNNER,
  insertInbound,
  stageHub,
  type LedgerRow,
} from "./helpers/hub-fixture.ts";
/** The pinned formula, computed by the test rather than read from the build. */
import { expectedPresetId } from "./helpers/preset-oracle.ts";

let cluster: Cluster;

const SLOW = 90_000;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** The turn record for one inbound row, and there must be exactly one. */
function turnFor(turns: LedgerRow[], subject: string): LedgerRow {
  const mine = turns.filter((t) => t.subject === subject);
  expect(mine.length).toBe(1);
  return mine[0];
}

// Deliberately odd numbers, including a zero and a large one.
const ODD_USAGE: AdapterUsage = {
  resolved_model_ids: ["fixture-model"],
  input_tokens: 0,
  cached_input_tokens: 7,
  output_tokens: 123_456_789,
  plan_usage: null,
  raw: {
    input_tokens: 0,
    cache_read_input_tokens: 7,
    cache_creation_input_tokens: 41,
    output_tokens: 123_456_789,
    service_tier: "a-tier",
  },
};

test(
  "LOOP-02 every turn's preset ID matches the registry at that moment and carries the token counts the loop reported: the id is the pinned formula over the file's five settings, the numbers are the loop's own, and there is exactly one record for the message (SPEC §3, L18)",
  async () => {
    const { presetId } = await seam("src/registry/presets.ts");
    expect(typeof presetId).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    // The session id the loop will report, fixed here so the record can be
    // compared against it rather than against its own shape.
    const sessionId = `session-${crypto.randomUUID().slice(0, 8)}`;
    const it = await stageHub(cluster, {
      adapter: { usage: ODD_USAGE, lacks: ["stream"], sessionId },
    });
    let runner: { stop(): Promise<void> } | null = null;

    try {
      await insertInbound(cluster, it.db, {
        id: "m-turn",
        body: "what did that turn cost",
      });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      await until(
        "the turn was settled",
        async () => (await it.read.outbox()).length >= 1,
        60_000,
        async () => JSON.stringify(await it.read.ledger({ stream: "turn" })),
      );
      await Bun.sleep(1500);

      const turns = await it.read.ledger({ stream: "turn" });
      const turn = turnFor(turns, "m-turn");
      expect(turn.kind).toBe("turn");
      expect(turn.actor).toBe("runner");

      const settings = {
        adapter: it.adapterName,
        effort: "medium",
        model: "a-model-name",
        paid: "plan",
        provider: "a-provider",
      };
      expect(turn.detail.preset).toBe("daily");
      expect(turn.detail.preset_id).toBe(expectedPresetId(settings));
      expect(turn.detail.preset_settings).toEqual(settings);
      expect(turn.detail.agent).toBe(AGENT);
      expect(turn.detail.runner).toBe(RUNNER);
      expect(turn.detail.tail).toBe(false);

      // THE LOAD: the numbers are the loop's, not ours. A rounded or recomputed
      // value fails here, including the zero, which a build that treats a
      // falsy count as missing would drop.
      expect(turn.detail.input_tokens).toBe(0);
      expect(turn.detail.cached_input_tokens).toBe(7);
      expect(turn.detail.output_tokens).toBe(123_456_789);
      expect(turn.detail.raw_usage).toEqual(ODD_USAGE.raw);
      expect(turn.detail.session_id).toBe(sessionId);
      expect(turn.detail.lacks).toEqual(["stream"]);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "LOOP-03 changing a preset is a registry edit picked up on the agent's next turn with no restart: the loop is started again with the edited settings, the second turn carries the edited preset's id, and the runner process never exited (SPEC §3, L18, and L11's no routine restart)",
  async () => {
    const { presetId } = await seam("src/registry/presets.ts");
    expect(typeof presetId).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const it = await stageHub(cluster, { servers: true });
    let runner: ReadyProcess | null = null;

    try {
      runner = await startReadySubprocess("test/helpers/runner-subprocess.ts", [
        it.registryFile,
        RUNNER,
        it.adapterUrl,
        it.adapterName,
      ]);
      const pidBefore = runner.pid;

      await insertInbound(cluster, it.db, { id: "m-before", body: "the first" });
      await until(
        "the first turn was settled",
        async () =>
          (await it.read.ledger({ stream: "turn" })).some(
            (t) => t.subject === "m-before",
          ),
        60_000,
      );

      // A real write to the registry file, not a second registry.
      const text = readFileSync(it.registryFile, "utf8");
      expect(text).toContain('effort = "medium"');
      writeFileSync(
        it.registryFile,
        text.replace('effort = "medium"', 'effort = "high"'),
        "utf8",
      );

      await insertInbound(cluster, it.db, { id: "m-after", body: "the second" });
      await until(
        "the second turn was settled",
        async () =>
          (await it.read.ledger({ stream: "turn" })).some(
            (t) => t.subject === "m-after",
          ),
        60_000,
      );
      await Bun.sleep(1000);

      const turns = await it.read.ledger({ stream: "turn" });
      const before = turnFor(turns, "m-before");
      const after = turnFor(turns, "m-after");

      const settings = {
        adapter: it.adapterName,
        model: "a-model-name",
        provider: "a-provider",
        paid: "plan",
      };
      expect(before.detail.preset_id).toBe(
        expectedPresetId({ ...settings, effort: "medium" }),
      );
      expect(after.detail.preset_id).toBe(
        expectedPresetId({ ...settings, effort: "high" }),
      );
      expect(after.detail.preset_id).not.toBe(before.detail.preset_id);
      expect(
        (after.detail.preset_settings as Record<string, string>).effort,
      ).toBe("high");

      // THE LOAD, and the hole an obvious version leaves: a runner that re-read the
      // registry only to label the ledger, while the session kept running on
      // the old effort, passed every assertion above. A session is bound to the
      // preset it was started with, so a changed preset means a new start with
      // the new settings, and the adapter records every start it was asked for.
      const starts = it.scripted.starts();
      expect(starts.length).toBeGreaterThanOrEqual(2);
      const first = starts[0].preset as unknown as Record<string, string>;
      const last = starts[starts.length - 1].preset as unknown as Record<
        string,
        string
      >;
      expect(first.effort).toBe("medium");
      expect(last.effort).toBe("high");
      expect(last.model).toBe("a-model-name");
      expect(last.adapter).toBe(it.adapterName);

      // The unchanged-process assertion. Without it a build that reloads by
      // exiting and being restarted passes, and the rule it breaks is one the
      // record states twice. The CHILD is restarted with the new settings, the
      // runner process itself is not.
      expect(runner.pid).toBe(pidBefore);
      expect(runner.proc.exitCode).toBeNull();
      expect(runner.proc.killed).toBe(false);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "LOOP-02 on a plan login there is no price, there is plan usage recorded as the loop reports it: price is exactly null even with a covering rate row, and the loop's own cost estimate lives only inside raw_usage (SPEC §3, L18)",
  async () => {
    const { priceFor } = await seam("src/registry/presets.ts");
    expect(typeof priceFor).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    // Shaped like the verified rate_limit_event, with the loop's own cost
    // estimate beside it.
    const planUsage = {
      five_hour: { utilization: 0.44, resets_at: "2026-09-15T12:00:00Z" },
      seven_day: { utilization: 0.12, resets_at: "2026-09-20T00:00:00Z" },
    };
    const estimate = 0.03917;
    const usage: AdapterUsage = {
      input_tokens: 4321,
      cached_input_tokens: 1000,
      output_tokens: 555,
      plan_usage: planUsage,
      raw: {
        input_tokens: 4321,
        cache_read_input_tokens: 1000,
        output_tokens: 555,
        total_cost_usd: estimate,
      },
    };

    const it = await stageHub(cluster, {
      adapter: { usage },
      preset: { paid: "plan" },
      registry: (base) => ({
        ...base,
        // A rate row that WOULD cover this model, so the null below is the
        // plan's doing and not a missing row's.
        rates: [
          {
            model: "a-model-name",
            from: "2020-01-01",
            input_per_m: 3,
            cached_per_m: 0.3,
            output_per_m: 15,
            currency: "USD",
          },
        ],
      }),
    });
    let runner: { stop(): Promise<void> } | null = null;

    try {
      await insertInbound(cluster, it.db, { id: "m-plan", body: "on the plan" });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      await until(
        "the turn was settled",
        async () =>
          (await it.read.ledger({ stream: "turn" })).some(
            (t) => t.subject === "m-plan",
          ),
        60_000,
      );

      const turn = turnFor(await it.read.ledger({ stream: "turn" }), "m-plan");
      // Exactly null, not zero and not absent.
      expect(turn.detail.price).toBeNull();
      expect("price" in turn.detail).toBe(true);
      expect(turn.detail.plan_usage).toEqual(planUsage);

      // THE LOAD. On a plan login the loop hands back its own cost estimate,
      // and a build that copies it into `price` is recording a number the
      // household never paid.
      expect(JSON.stringify(turn.detail.price)).not.toContain(String(estimate));
      expect(JSON.stringify(turn.detail.raw_usage)).toContain(String(estimate));
      expect(
        (turn.detail.raw_usage as Record<string, unknown>).total_cost_usd,
      ).toBe(estimate);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "LOOP-02 on a per-token key the price comes from the newest dated rate row that covers the turn: rate_from names it, the currency is the row's, and the amount is the unrounded sum the test computed itself (SPEC §3, L18)",
  async () => {
    const { priceFor, rateFor } = await seam("src/registry/presets.ts");
    expect(typeof priceFor).toBe("function");
    expect(typeof rateFor).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const usage: AdapterUsage = {
      input_tokens: 1_234_567,
      cached_input_tokens: 987_654,
      output_tokens: 321_987,
      plan_usage: null,
      raw: { input_tokens: 1_234_567, output_tokens: 321_987 },
    };
    const older = {
      model: "a-model-name",
      from: "2020-01-01",
      input_per_m: 30,
      cached_per_m: 3,
      output_per_m: 150,
      currency: "EUR",
    };
    const newer = {
      model: "a-model-name",
      from: "2026-01-01",
      input_per_m: 3.75,
      cached_per_m: 0.375,
      output_per_m: 18.75,
      currency: "USD",
    };

    const it = await stageHub(cluster, {
      adapter: { usage },
      preset: { paid: "key" },
      registry: (base) => ({ ...base, rates: [older, newer] }),
    });
    let runner: { stop(): Promise<void> } | null = null;

    try {
      await insertInbound(cluster, it.db, { id: "m-key", body: "on a key" });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      await until(
        "the turn was settled",
        async () =>
          (await it.read.ledger({ stream: "turn" })).some(
            (t) => t.subject === "m-key",
          ),
        60_000,
      );

      const turn = turnFor(await it.read.ledger({ stream: "turn" }), "m-key");
      const price = turn.detail.price as {
        amount: number;
        currency: string;
        rate_from: string;
      };
      expect(price).not.toBeNull();

      // The newer of two covering rows, named by rate_from, so a build that
      // took the first or the oldest fails.
      expect(price.rate_from).toBe("2026-01-01");
      expect(price.currency).toBe("USD");

      const expected =
        (usage.input_tokens! / 1_000_000) * newer.input_per_m +
        (usage.cached_input_tokens! / 1_000_000) * newer.cached_per_m +
        (usage.output_tokens! / 1_000_000) * newer.output_per_m;
      expect(price.amount).toBeCloseTo(expected, 12);
      // Unrounded. A build that rounded to cents lands on a different number.
      expect(price.amount).not.toBe(Number(price.amount.toFixed(2)));

      // A key has no plan window.
      expect(turn.detail.plan_usage).toBeNull();
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "LOOP-02 a guessed price is forbidden: with every rate row dated after the turn nothing covers it, so the price is null rather than the nearest row, zero, or the loop's own estimate (SPEC §3 Forbidden, L18)",
  async () => {
    const { priceFor } = await seam("src/registry/presets.ts");
    expect(typeof priceFor).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const usage: AdapterUsage = {
      input_tokens: 5000,
      cached_input_tokens: 100,
      output_tokens: 900,
      plan_usage: null,
      raw: { input_tokens: 5000, output_tokens: 900, total_cost_usd: 0.0212 },
    };

    const it = await stageHub(cluster, {
      adapter: { usage },
      preset: { paid: "key" },
      registry: (base) => ({
        ...base,
        rates: [
          {
            model: "a-model-name",
            from: "2099-01-01",
            input_per_m: 3,
            cached_per_m: 0.3,
            output_per_m: 15,
            currency: "USD",
          },
          {
            model: "another-model-name",
            from: "2020-01-01",
            input_per_m: 1,
            cached_per_m: 0.1,
            output_per_m: 5,
            currency: "USD",
          },
        ],
      }),
    });
    let runner: { stop(): Promise<void> } | null = null;

    try {
      await insertInbound(cluster, it.db, {
        id: "m-no-rate",
        body: "nothing covers this",
      });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      await until(
        "the turn was settled",
        async () =>
          (await it.read.ledger({ stream: "turn" })).some(
            (t) => t.subject === "m-no-rate",
          ),
        60_000,
      );

      const turn = turnFor(
        await it.read.ledger({ stream: "turn" }),
        "m-no-rate",
      );
      // Null rather than a fallback. That is what "never guess a number" means
      // in a check.
      expect(turn.detail.price).toBeNull();
      expect(turn.detail.plan_usage).toBeNull();
      expect(JSON.stringify(turn.detail.price)).not.toContain("0.0212");
      // And the counts were still recorded, so nothing was dropped with it.
      expect(turn.detail.input_tokens).toBe(5000);
      expect(turn.detail.output_tokens).toBe(900);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "LOOP-02 a guessed price is forbidden: with one of the three token counts missing the price is null, because a price from two of three counts is a guess wearing a number's clothes (SPEC §3 Forbidden, L18)",
  async () => {
    const { priceFor } = await seam("src/registry/presets.ts");
    expect(typeof priceFor).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const usage: AdapterUsage = {
      input_tokens: 5000,
      cached_input_tokens: null,
      output_tokens: 900,
      plan_usage: null,
      raw: { input_tokens: 5000, output_tokens: 900 },
    };

    const it = await stageHub(cluster, {
      adapter: { usage },
      preset: { paid: "key" },
      registry: (base) => ({
        ...base,
        rates: [
          {
            model: "a-model-name",
            from: "2020-01-01",
            input_per_m: 3,
            cached_per_m: 0.3,
            output_per_m: 15,
            currency: "USD",
          },
        ],
      }),
    });
    let runner: { stop(): Promise<void> } | null = null;

    try {
      await insertInbound(cluster, it.db, {
        id: "m-partial",
        body: "two counts of three",
      });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      await until(
        "the turn was settled",
        async () =>
          (await it.read.ledger({ stream: "turn" })).some(
            (t) => t.subject === "m-partial",
          ),
        60_000,
      );

      const turn = turnFor(
        await it.read.ledger({ stream: "turn" }),
        "m-partial",
      );
      expect(turn.detail.price).toBeNull();
      // The missing count is recorded as missing rather than as zero, because
      // zero is a number the loop reported and null is one it did not.
      expect(turn.detail.cached_input_tokens).toBeNull();
      expect(turn.detail.input_tokens).toBe(5000);
      expect(turn.detail.output_tokens).toBe(900);

      // The control, so the null above is the missing count's doing and not a
      // rate table that never works: the same rate row prices a whole count.
      const registry = (await seam("src/registry/load.ts")).loadRegistry as Function;
      const priced = (priceFor as Function)(registry(it.registryFile), {
        model: "a-model-name",
        at: new Date(),
        paid: "key",
        usage: { ...usage, cached_input_tokens: 0 },
      }) as { amount: number } | null;
      expect(priced).not.toBeNull();
      expect(priced!.amount).toBeGreaterThan(0);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);
