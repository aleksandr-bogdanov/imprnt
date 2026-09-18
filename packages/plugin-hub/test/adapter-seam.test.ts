// LOOP-04 and LOOP-05. The loop is a field on a preset, and a missing one is a
// loud refusal rather than a silence.
//
// SPEC §3: "The rest of the hub sees one field on the preset: `adapter`." Its
// Forbidden list carries "loop-specific code outside `adapters/`" and "a branch
// on the adapter name anywhere but the adapter registry".
//
// THE PARTIAL, and its reason. That Forbidden line quantifies over code that
// does not exist yet, so no probe run today can enumerate every call site, and
// the first test's name carries [partial] the way phase 1's RUN-06 checks do.
// What CAN be probed is the mechanism, and it is probed hard: the runner drives
// an adapter registered under a name generated at run time, which no build can
// have in a list and no build can have branched on, and then the same adapter
// object under a second such name, and the two runs must be identical. The
// census over real call sites belongs to a later `check` verb.
//
// No source file is grepped. Phase 1 established that a grep is not a behaviour
// and cannot fail for the right reason.
//
// THE SECOND CHECK'S CITATIONS. The decision record does not say what a missing
// adapter looks like at run time, so the check rests on the two rules that do
// reach it: SPEC §7, "appending an id that exists to a state sheet is refused,
// editing a diary entry is refused, both attempts are ledger events", which is
// where a refused attempt belongs, and SPEC §6, L14, "a file with a bad value
// is refused loudly", which is what a preset naming a loop nobody registered
// is. The exact shape of the record is an inferred seam rule, pinned in
// 02-CONTEXT and named in the test rather than claimed as a spec line.
//
// Red reasons: import missing, src/adapters/types.ts and src/runner/run.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import {
  createScriptedAdapter,
  scriptedReply,
} from "./helpers/scripted-adapter.ts";
import {
  AGENT,
  DOOR,
  RUNNER,
  insertInbound,
  stageHub,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 90_000;
const MESSAGE = "which loop answered this";

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** A name no build could have enumerated, because it did not exist until now. */
function unknowableName(): string {
  return `scripted-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

test(
  "[partial] LOOP-05 loop-specific code outside adapters/ is absent, and so is a branch on the adapter name: one adapter object answers under two names generated at run time, and the two runs agree on the reply, the stamp sequence and what the loop lacks (SPEC §3 Forbidden, D11)",
  async () => {
    // The seam definition itself. `Adapter` is a type and erases, so the
    // runtime export that binds the module is its error class.
    const { AdapterMissing } = await seam("src/adapters/types.ts");
    expect(typeof AdapterMissing).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");
    // The delivered stamp is the DOOR's, so this check starts one. The first
    // pass expected the five stamps from a runner alone, which no conforming
    // build could have written: the schema fences that kind to hub_door.
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");

    const nameA = unknowableName();
    const nameB = unknowableName();
    expect(nameA).not.toBe(nameB);

    // ONE adapter object, registered twice under two names it does not know.
    const scripted = createScriptedAdapter({ name: nameA, lacks: ["stream"], usage: { input_tokens: 1234, cached_input_tokens: 900, output_tokens: 210, plan_usage: null, raw: {}, resolved_model_ids: ["fixture-model"] } });

    const runs: {
      reply: string;
      posted: string[];
      stamps: string[];
      lacks: unknown;
      presetId: unknown;
    }[] = [];

    for (const name of [nameA, nameB]) {
      const it = await stageHub(cluster, { preset: { adapter: name } });
      let runner: { stop(): Promise<void> } | null = null;
      let door: { stop(): Promise<void> } | null = null;
      try {
        await insertInbound(cluster, it.db, { id: `m-${name}`, body: MESSAGE });
        door = await (runDoor as Function)({
          door: DOOR,
          registryFile: it.registryFile,
          platform: it.fake.platform,
        });
        runner = await (runRunner as Function)({
          runner: RUNNER,
          registryFile: it.registryFile,
          adapters: { [name]: scripted.adapter },
        });
        await until(
          `the message was answered under ${name}`,
          async () => (await it.read.outbox()).length >= 1,
          60_000,
          async () =>
            JSON.stringify(await it.read.ledger({ stream: "inbound" })),
        );
        await until(
          "the reply was settled, posted and stamped delivered",
          async () =>
            (await it.read.ledger({ stream: "inbound", kind: "delivered" }))
              .length === 1,
          30_000,
          async () =>
            JSON.stringify(await it.read.ledger({ stream: "inbound" })),
        );
        await Bun.sleep(1000);

        const chunks = await it.read.outbox();
        expect(chunks.length).toBe(1);
        const turn = (await it.read.ledger({ stream: "turn" })).find(
          (t) => t.subject === `m-${name}`,
        )!;
        expect(turn).toBeDefined();
        runs.push({
          reply: chunks.map((c) => c.body).join(""),
          posted: it.fake.posts().map((p) => p.text),
          stamps: (await it.read.ledger({ stream: "inbound" })).map(
            (e) => e.kind,
          ),
          lacks: turn.detail.lacks,
          presetId: turn.detail.preset_id,
        });
      } finally {
        if (runner) await runner.stop();
        if (door) await door.stop();
        await it.stop();
      }
    }

    // Each run answered for real, with the five stamps and the loop's own list.
    for (const run of runs) {
      expect(run.reply).toBe(scriptedReply(MESSAGE));
      expect(run.stamps).toEqual([
        "received",
        "acked",
        "started",
        "answered",
        "delivered",
      ]);
      expect(run.lacks).toEqual(["stream"]);
      expect(typeof run.presetId).toBe("string");
      expect(run.posted).toEqual([scriptedReply(MESSAGE)]);
    }

    // Identical behaviour under two names neither the code nor a list could
    // know is what "no branch on the adapter name" looks like from outside.
    expect(runs[0].reply).toBe(runs[1].reply);
    expect(runs[0].stamps).toEqual(runs[1].stamps);
    expect(runs[0].lacks).toEqual(runs[1].lacks);
    expect(runs[0].posted).toEqual(runs[1].posted);
    // And the ids differ, because the adapter is one of the five settings, so
    // the two runs are genuinely two presets rather than one read twice.
    expect(runs[0].presetId).not.toBe(runs[1].presetId);
  },
  SLOW,
);

test(
  "LOOP-04 a preset naming an adapter the registry lacks is a loud refusal in the ledger, never a silent wait: a refusal event names the adapter and the agent, the row is still there unanswered, no acked was written, and the same message with the adapter registered is answered (SPEC §7 a refused attempt is a ledger event, SPEC §6 L14 a bad value is refused loudly, and 02-CONTEXT D-34 for the injected registry)",
  async () => {
    const { AdapterMissing } = await seam("src/adapters/types.ts");
    expect(typeof AdapterMissing).toBe("function");
    const { adapterFor } = await seam("src/adapters/index.ts");
    expect(typeof adapterFor).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const missing = unknowableName();
    const it = await stageHub(cluster, { preset: { adapter: missing } });
    let runner: { stop(): Promise<void> } | null = null;

    try {
      // The seam's own refusal, before any process is involved.
      let direct: unknown;
      try {
        (adapterFor as Function)({}, missing);
      } catch (err) {
        direct = err;
      }
      expect(direct).toBeInstanceOf(AdapterMissing as Function);
      expect((direct as { adapter: string }).adapter).toBe(missing);

      await insertInbound(cluster, it.db, { id: "m-missing", body: MESSAGE });
      runner = await (runRunner as Function)({
        runner: RUNNER,
        // A map that lacks it, which is the whole point.
        adapters: {},
        registryFile: it.registryFile,
      });

      // THE LOAD. A runner that simply waits forever also leaves the row
      // unanswered and writes no stamps, and that is a silent hole the
      // household discovers as a day of nothing. The refusal is the difference
      // between a fault and a silence.
      await until(
        "the runner recorded a refusal",
        async () => (await it.read.ledger({ stream: "refusal" })).length >= 1,
        15_000,
        async () => JSON.stringify(await it.read.ledger()),
      );
      const refusals = await it.read.ledger({ stream: "refusal" });
      expect(refusals.length).toBe(1);
      expect(refusals[0].actor).toBe("runner");
      expect(refusals[0].detail.adapter).toBe(missing);
      expect(refusals[0].detail.agent).toBe(AGENT);
      expect(String(refusals[0].detail.error)).toContain("AdapterMissing");

      // Nothing was dropped, and nothing accepted the message.
      const rows = await it.read.inbound();
      expect(rows.length).toBe(1);
      expect(rows[0].state).toBe("received");
      expect(await it.read.ledger({ stream: "inbound", kind: "acked" })).toEqual(
        [],
      );
      expect(await it.read.outbox()).toEqual([]);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }

    // The control. Without it the check passes on a runner that refuses
    // everything, which is not the rule.
    const good = await stageHub(cluster, { preset: { adapter: missing } });
    let second: { stop(): Promise<void> } | null = null;
    try {
      const scripted = createScriptedAdapter({ name: missing });
      await insertInbound(cluster, good.db, {
        id: "m-registered",
        body: MESSAGE,
      });
      second = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: good.registryFile,
        adapters: { [missing]: scripted.adapter },
      });
      await until(
        "the same message is answered once the adapter is registered",
        async () => (await good.read.outbox()).length >= 1,
        60_000,
      );
      const chunks = await good.read.outbox();
      expect(chunks.map((c) => c.body).join("")).toBe(scriptedReply(MESSAGE));
      expect(await good.read.ledger({ stream: "refusal" })).toEqual([]);
    } finally {
      if (second) await second.stop();
      await good.stop();
    }
  },
  SLOW,
);
