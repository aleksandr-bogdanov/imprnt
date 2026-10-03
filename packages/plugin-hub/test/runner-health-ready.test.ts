import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { stageHub, superStore } from "./helpers/hub-fixture.ts";
import { controlledAdapter, observe } from "./helpers/rollout-runner.ts";
import { runRunner } from "../src/runner/run.ts";

let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });
for (const cause of ["Error: child-exited", "credential outage"]) {
  test(`IMP215 resident restart treats ${cause} narrowly without a model turn`, async () => {
    const it = await stageHub(cluster, { hub: { tick_seconds: 1 } });
    const store = await superStore(cluster, it.db);
    const edge = controlledAdapter(it.adapterName);
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
    try {
      await store.sql`insert into state_row (sheet,id,data) values ('agent_health','p1-lair',${{status:"retry",cause,retry_at:new Date(0).toISOString()}})`;
      runner = await runRunner({runner:"runner-test",registryFile:it.registryFile,adapters:{[it.adapterName]:edge.adapter}});
      expect(await observe(() => edge.sessions.length > 0)).toBe(true);
      if (cause === "Error: child-exited") {
        expect(await observe(async () => !(await it.read.sheet("agent_health")).some(r => r.id === "p1-lair"))).toBe(true);
      } else {
        expect((await it.read.sheet("agent_health")).find(r => r.id === "p1-lair")?.data.cause).toBe(cause);
      }
      expect(edge.sessions.flatMap(s => s.fed)).toEqual([]);
      await runner.stop(); runner = undefined;
      expect((await it.read.sheet("agent_health")).some(r => r.id === "p1-lair" && r.data.cause === "Error: child-exited")).toBe(false);
    } finally { await runner?.stop(); await edge.stop(); await store.close(); await it.stop(); }
  }, 30_000);
}
