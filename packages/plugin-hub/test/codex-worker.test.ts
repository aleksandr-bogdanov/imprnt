import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { stageHub, insertInbound, PERSON, RUNNER, AGENT, DOOR, CHAT } from "./helpers/hub-fixture.ts";
import { requestHoldChoice } from "../src/door/recovery.ts";
import { loadRegistry } from "../src/registry/load.ts";
import type { StoreLike } from "../src/store/connect.ts";
import { openCode } from "../src/adapters/opencode.ts";
import { insertJob } from "./helpers/conversations.ts";
import { observe, retrySettings } from "./helpers/rollout-runner.ts";
import { runRunner } from "../src/runner/run.ts";
import { createCodex, codexSessionMapPath } from "../src/adapters/codex.ts";
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
      const config = { model: options.preset.model, model_provider: options.preset.provider, agents: { enabled: false }, cli_auth_credentials_store: "ephemeral", model_providers: { [options.preset.provider]: { base_url: "http://127.0.0.1:9/v1", requires_openai_auth: true } } };
      const session = await real.start({ ...options, preset: { ...options.preset, effort: "high" }, cwd,
        argv: [process.execPath, join(import.meta.dir, "helpers/codex-server.ts")], wrap: args => args, privateModelKey: () => "synthetic-codex-key", env: { PATH: process.env.PATH, HUB_CODEX_CONFIG: JSON.stringify(config) } });
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

test("an eagerly launched Codex master restarts before its first input without an identity deadlock", async () => {
  const it = await stageHub(cluster); retrySettings(it);
  const cwd = join(it.stateDir, "codex-master-fixture"); mkdirSync(join(cwd, "codex"), { recursive: true });
  const real = createCodex({ timeoutMs: 2000 });
  const opened: { id: string; resume: boolean; session: AdapterSession }[] = [];
  const adapter: Adapter = {
    name: it.adapterName,
    async capabilities() { return { stableSession: true, safeResume: false, delegationDisabled: true }; },
    async start(options) {
      const config = { model: options.preset.model, model_provider: options.preset.provider, agents: { enabled: false }, cli_auth_credentials_store: "ephemeral", model_providers: { [options.preset.provider]: { base_url: "http://127.0.0.1:9/v1", requires_openai_auth: true } } };
      const session = await real.start({ ...options, cwd,
        argv: [process.execPath, join(import.meta.dir, "helpers/codex-server.ts")], wrap: args => args, privateModelKey: () => "synthetic-codex-key",
        env: { PATH: process.env.PATH, HUB_CODEX_CONFIG: JSON.stringify(config) } });
      opened.push({ ...options.session!, session }); return session;
    },
  };
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
  try {
    runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: adapter } });
    expect(await observe(() => opened.length === 1)).toBe(true);
    expect(JSON.parse(readFileSync(codexSessionMapPath(cwd, opened[0].id), "utf8"))).toMatchObject({ sent: false, dirty: false });
    await runner.stop(); runner = undefined;
    runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: adapter } });
    expect(await observe(() => opened.length === 2, 10_000)).toBe(true);
    expect(opened[1].id).not.toBe(opened[0].id);
    expect(opened.map(one => one.resume)).toEqual([false, false]);
    await insertInbound(cluster, it.db, { id: "first-after-restart", body: "first real input" });
    expect(await observe(async () => (await it.read.inbound()).find(row => row.id === "first-after-restart")?.state === "answered", 15_000)).toBe(true);
    expect((await it.read.sql("select state from execution")).map(row => row.state)).toEqual(["completed"]);
    expect((await it.read.outbox()).map(row => row.body).join("")).toContain("first real input");
  } finally { await runner?.stop(); for (const one of opened) await one.session.close(); await it.stop(); }
}, 60_000);

test("failed Codex input stays held while authorized fresh_context completes new input with a separate durable map", async () => {
  const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, people: [{ id: PERSON, allowed_senders: { [DOOR]: [PERSON] } }] }); retrySettings(it);
  const cwd = join(it.stateDir, "codex-recovery"); mkdirSync(join(cwd, "codex"), { recursive: true });
  const log = join(cwd, "wire.jsonl"), real = createCodex({ timeoutMs: 2000 });
  const opened: { id: string; resume: boolean; session: AdapterSession }[] = [];
  const adapter: Adapter = { name: it.adapterName,
    async capabilities() { return { stableSession: true, safeResume: false, delegationDisabled: true }; },
    async start(options) {
      const config = { model: options.preset.model, model_provider: options.preset.provider, agents: { enabled: false }, cli_auth_credentials_store: "ephemeral", model_providers: { [options.preset.provider]: { base_url: "http://127.0.0.1:9/v1", requires_openai_auth: true } } };
      const session = await real.start({ ...options, cwd, argv: [process.execPath, join(import.meta.dir, "helpers/codex-server.ts")], wrap: args => args,
        privateModelKey: () => "synthetic-codex-key", env: { PATH: process.env.PATH, HUB_CODEX_CONFIG: JSON.stringify(config), CODEX_FIXTURE_LOG: log, CODEX_FIXTURE_MODE: opened.length === 0 ? "disconnect" : "normal" } });
      opened.push({ ...options.session!, session }); return session;
    } };
  const door = { sql: cluster.connectAs("hub_door", it.db), url: cluster.url(it.db) } as StoreLike;
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
  try {
    runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: adapter } });
    await insertInbound(cluster, it.db, { id: "codex-failed", body: "old risky input" });
    expect(await observe(async () => (await it.read.sql("select 1 from replay_hold where inbound_id = 'codex-failed'")).length === 1, 15_000)).toBe(true);
    const [attempt] = await it.read.sql("select id, native_session, state from execution where inbound_id = 'codex-failed'");
    expect(attempt.state).toBe("interrupted");
    const oldMap = codexSessionMapPath(cwd, String(attempt.native_session)), oldBytes = readFileSync(oldMap, "utf8");
    expect(JSON.parse(oldBytes).dirty).toBe(true);
    const holdBefore = await it.read.sql("select state, revision, choice from replay_hold where inbound_id='codex-failed'");
    await runner.stop();
    runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile,
      adapters: { [it.adapterName]: { ...adapter, activationBlock: openCode.activationBlock } } });
    await insertInbound(cluster, it.db, { id: "codex-new", body: "new authorized input" });
    await Bun.sleep(1200);
    expect((await it.read.inbound()).find(row => row.id === "codex-new")).toMatchObject({ state: "received", claimed_by: null });
    expect(await it.read.sql("select state, revision, choice from replay_hold where inbound_id='codex-failed'")).toEqual(holdBefore);
    expect(opened).toHaveLength(1);
    await runner.stop();
    runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: adapter } });
    expect(await requestHoldChoice(door, { registry: loadRegistry(it.registryFile), person: PERSON, door: DOOR, chat: CHAT, sender_id: PERSON,
      message: "authorize-fresh", at: new Date().toISOString(), agent: AGENT, attempt: String(attempt.id), revision: 1, choice: "fresh_context" })).toBe("fresh_context");
    const [fresh] = await it.read.sql("select native_session from conversation where agent = $1 and kind = 'master'", [AGENT]);
    expect(fresh.native_session).not.toBe(attempt.native_session);
    expect(await observe(async () => (await it.read.inbound()).find(row => row.id === "codex-new")?.state === "answered", 15_000)).toBe(true);
    expect(opened.at(-1)).toMatchObject({ id: fresh.native_session, resume: false });
    expect(readFileSync(oldMap, "utf8")).toBe(oldBytes);
    expect((await it.read.sql("select hub_row_held('codex-failed') as held"))[0].held).toBe(true);
    const sent = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.method === "turn/start");
    expect(sent.map(row => row.params.clientUserMessageId)).toEqual(["codex-failed", "codex-new"]);
    expect(sent[1].params.input[0].text).toContain("Do not continue unfinished work");
  } finally { await runner?.stop(); for (const one of opened) await one.session.close(); await door.sql.close(); await it.stop(); }
}, 60_000);
