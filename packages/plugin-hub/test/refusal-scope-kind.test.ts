// The diary names a refusal for what it is.
//
// `classifyRefusal` splits a refused turn in two. A refusal with verified
// evidence against the shared credential opens an outage, and one without it is
// local to the agent that met it: no outage row, no notice to anybody, one
// agent on a retry. The diary line has to say which, because a household
// reading its own diary counts outages by that line, and an agent-local
// refusal labelled `refused.outage` reads as an outage that never opened.
//
// The control is the verified shared login refusal, which keeps its outage
// label, with the outage row standing beside it.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { insertInbound, stageHub } from "./helpers/hub-fixture.ts";
import { controlledAdapter, observe, retrySettings } from "./helpers/rollout-runner.ts";
import { runRunner } from "../src/runner/run.ts";

let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

test(
  "D-177 a refusal local to one agent is written as refused.local and never as refused.outage, and a verified shared login refusal is still written as refused.outage",
  async () => {
    const it = await stageHub(cluster, {
      hub: { tick_seconds: 1, outage_retry_seconds: 2 },
      people: [{ id: "p1", language: "en" }],
      credentials: [{ id: "shared-login", kind: "claude-login", owner: "household", file: "/tmp/synthetic-unused-login" }],
      preset: { credential: "shared-login" },
    });
    retrySettings(it);
    const edge = controlledAdapter(it.adapterName);
    let mode: "healthy" | "local" | "login" = "healthy";
    const configure = (row: (typeof edge.sessions)[number]) => {
      row.loop.setRefusal(mode === "healthy" ? null
        : { cause: mode === "local" ? "other" : "login", said: `synthetic ${mode} refusal` });
      row.loop.setUsage({ ...row.loop.usage, raw: { evidence: mode === "login"
        ? { kind: "authenticated-response", status: 401, credential: "shared-login" }
        : null } });
    };
    edge.onStart(configure);
    const setMode = (value: typeof mode) => { mode = value; for (const row of edge.sessions) configure(row); };
    const refusals = async (subject: string) => await it.read.ledger({ stream: "refusal", subject });
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
    try {
      runner = await runRunner({ runner: "runner-test", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } });
      await insertInbound(cluster, it.db, { id: "healthy-control", body: "accepted" });
      expect(await observe(async () => (await it.read.outbox()).some((r) => r.inbound_id === "healthy-control"), 20_000)).toBe(true);

      // --- 1. THE LOCAL REFUSAL. No evidence against the shared credential,
      //     so no outage opens, and the diary line must not say one did.
      setMode("local");
      await insertInbound(cluster, it.db, { id: "local-refusal", body: "retry locally" });
      await until("the local refusal reached the diary", async () => (await refusals("local-refusal")).length >= 1, 20_000,
        async () => JSON.stringify(await it.read.ledger({ stream: "refusal" })));
      expect(await it.read.outageSheet()).toEqual([]);
      const local = await refusals("local-refusal");
      expect(local.map((row) => row.kind), "an agent-local refusal is not an outage").not.toContain("refused.outage");
      expect(local[0].kind).toBe("refused.local");
      expect(local[0].actor).toBe("runner");
      expect(local[0].detail.cause).toBe("other");

      // --- 2. THE CONTROL. A verified shared login refusal opens the outage
      //     and keeps the outage label.
      setMode("login");
      await insertInbound(cluster, it.db, { id: "outage-refusal", body: "wait for the login" });
      await until("the outage refusal reached the diary", async () => (await refusals("outage-refusal")).length >= 1, 20_000,
        async () => JSON.stringify(await it.read.ledger({ stream: "refusal" })));
      const outage = await refusals("outage-refusal");
      expect(outage[0].kind).toBe("refused.outage");
      expect(outage[0].detail.cause).toBe("login");
      expect(await observe(async () => (await it.read.outageSheet()).some((row) => row.id === "shared-login"), 20_000)).toBe(true);
    } finally {
      await runner?.stop();
      await edge.stop();
      await it.stop();
    }
  },
  120_000,
);
