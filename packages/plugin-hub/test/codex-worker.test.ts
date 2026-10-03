import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { stageHub, PERSON, RUNNER } from "./helpers/hub-fixture.ts";
import { insertJob } from "./helpers/conversations.ts";
import { observe, retrySettings } from "./helpers/rollout-runner.ts";
import { runRunner } from "../src/runner/run.ts";
import { createCodex } from "../src/adapters/codex.ts";
import type { Adapter, AdapterSession } from "../src/adapters/types.ts";
let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });
test("Codex protocol adapter participates in real Hub worker conversations, reports and explicit continuation without replay", async () => {
  const it = await stageHub(cluster, { agents: [{ id: "p1-worker", person: PERSON, preset: "daily", runner: RUNNER, mode: "on-demand", idle_seconds: 1 }] });
  retrySettings(it);
  const real = createCodex({ timeoutMs: 2000 });
  const opened: { id: string; resume: boolean; gone: boolean; session: AdapterSession }[] = [];
  const adapter: Adapter = {
    name: it.adapterName,
    async capabilities() { return { stableSession: true, safeResume: false, delegationDisabled: true }; },
    async start(options) {
      const cwd = join(it.stateDir, "codex-fixture", options.session!.id); mkdirSync(join(cwd, "codex"), { recursive: true });
      const config = { model: options.preset.model, model_provider: options.preset.provider, agents: { enabled: false }, model_providers: { [options.preset.provider]: { base_url: "http://127.0.0.1:9/v1" } } };
      const session = await real.start({ ...options, preset: { ...options.preset, effort: "high" }, cwd,
        argv: [process.execPath, join(import.meta.dir, "helpers/codex-server.ts")], wrap: args => args, env: { PATH: process.env.PATH, HUB_CODEX_CONFIG: JSON.stringify(config) } });
      const record = { ...options.session!, gone: false, session }; opened.push(record); void session.exited!.then(() => { record.gone = true; }); return session;
    },
  };
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
  try {
    runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: adapter } });
    for (const id of ["codex-job-a", "codex-job-b"]) {
      await insertJob(cluster, it.db, { id, target: "p1-worker", task: id });
      expect(await observe(async () => (await it.read.inbound()).find(row => row.id === id)?.state === "answered", 15_000)).toBe(true);
      expect(await observe(() => opened.filter(row => row.gone).length >= (id.endsWith("a") ? 1 : 2), 10_000)).toBe(true);
    }
    const conversations = await it.read.sql("select id, owner_ref, native_session, native_state from conversation where kind = 'worker' order by owner_ref");
    expect(conversations).toHaveLength(2);
    expect(conversations[0].native_session).not.toBe(conversations[1].native_session);
    expect(conversations.map(row => row.native_state)).toEqual(["verified", "verified"]);
    await insertJob(cluster, it.db, { id: "codex-followup", target: "p1-worker", task: "followup only", conversation: String(conversations[0].id) });
    expect(await observe(async () => (await it.read.inbound()).find(row => row.id === "codex-followup")?.state === "answered", 15_000)).toBe(true);
    expect(opened.filter(row => row.id === conversations[0].native_session).map(row => row.resume)).toEqual([false, true]);
    const entries = await it.read.sql("select kind, body from conversation_entry where conversation_id = $1 order by seq", [conversations[0].id]);
    expect(entries.map(row => row.body)).toEqual(["codex-job-a", "result codex-job-a", "followup only", "result followup only"]);
    const attempts = await it.read.sql("select state from execution where agent = 'p1-worker'");
    expect(attempts.map(row => row.state)).toEqual(["completed", "completed", "completed"]);
  } finally { await runner?.stop(); for (const row of opened) await row.session.close(); await it.stop(); }
}, 90_000);
