import { beforeAll, afterAll, test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { stageHub, insertInbound, superStore, AGENT, RUNNER } from "./helpers/hub-fixture.ts";
import { insertJob } from "./helpers/conversations.ts";
import { observe, retrySettings } from "./helpers/rollout-runner.ts";
import { runRunner } from "../src/runner/run.ts";
import { runCheck } from "../src/check/run.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";
import { openCode } from "../src/adapters/opencode.ts";
import { checkLoopSource } from "../src/adapters/index.ts";
import { codex } from "../src/adapters/codex.ts";
import { blockedAdapter, SYNTHETIC_BLOCK } from "./helpers/blocked-adapter.ts";
let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

// THE BLOCKED-ENGINE PATH, with a blocked adapter injected under the preset's own adapter name. No production
// adapter declares an `activationBlock` any more: OpenCode launches under the own-credential policy, and the
// last test here says so, so a refusal that came back would fail it rather than make these pass.
test("a blocked engine keeps all configured work unclaimed across wakes and restart with one notice, and is never asked for anything", async () => {
  const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, preset: { adapter: "opencode", paid: "key", credential: "blocked-key" },
    credentials: [{ id: "blocked-key", kind: "model-key", file: "/synthetic-unreadable-key", owner: "p1" }], harvest: { harvester: "daily", vault: "/synthetic-vault" } }); retrySettings(it);
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
  try {
    const sql = cluster.connect(it.db);
    try { await sql`insert into conversation (id, person, agent, kind, adapter, native_session, native_state)
      values ('existing-opencode', 'p1', ${AGENT}, 'master', 'opencode', 'preserved-native', 'started')`; }
    finally { await sql.close(); }
    await insertInbound(cluster, it.db, { id: "blocked-human", body: "keep my work" });
    await insertJob(cluster, it.db, { id: "blocked-job", target: AGENT, task: "keep this job" });
    await insertInbound(cluster, it.db, { id: "blocked-harvest", body: "never decoded while blocked", kind: "harvest" });
    const blocked = blockedAdapter("opencode");
    const start = () => runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { opencode: blocked } });
    runner = await start();
    expect(await observe(async () => (await it.read.noticeRows()).some(row => row.notice_key === `engine-unavailable:${AGENT}:${SYNTHETIC_BLOCK.cause}`))).toBe(true);
    await Bun.sleep(2200); await runner.stop(); runner = await start(); await Bun.sleep(1200);
    for (const row of await it.read.sql("select state, claimed_by, retry_at from inbound")) expect(row).toMatchObject({ state: "received", claimed_by: null, retry_at: null });
    expect(await it.read.sql("select id from execution")).toHaveLength(0);
    expect(await it.read.sql("select id, adapter, native_session, native_state from conversation")).toEqual([{ id: "existing-opencode", adapter: "opencode", native_session: "preserved-native", native_state: "started" }]);
    expect((await it.read.noticeRows()).filter(row => row.notice_key?.startsWith("engine-unavailable:"))).toHaveLength(1);
    expect((await it.read.ledger()).filter(row => row.kind.includes("refused") || row.kind.includes("retry"))).toHaveLength(0);
    expect((await it.read.sql("select data from state_row where sheet='agent_health' and id=$1", [AGENT]))[0].data)
      .toMatchObject({ status: "blocked", cause: "configured-engine-unavailable", ordinary_preset: "daily", harvest_preset: "daily",
        remedy: SYNTHETIC_BLOCK.remedy, blockers: [SYNTHETIC_BLOCK.cause] });
    expect(blocked.calls, "a blocked engine was asked to start").toEqual([]);
    const store = await superStore(cluster, it.db);
    try {
      const machine = listRunEntries(loadRegistry(it.registryFile)).find(row => row.id === RUNNER)!.machine;
      const findings = await runCheck({ machine, registryFile: it.registryFile, store, os: null, kernel: null, disk: null });
      expect(findings.find(row => row.kind === "configured-engine-unavailable" && row.subject === AGENT)).toMatchObject({ fix: SYNTHETIC_BLOCK.remedy });
    } finally { await store.sql.close(); }
  } finally { await runner?.stop(); await it.stop(); }
}, 45_000);

test("a blocked harvester cannot starve independently supported ordinary work", async () => {
  const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, harvest: { harvester: "blocked", vault: "/synthetic-vault" },
    credentials: [{ id: "blocked-key", kind: "model-key", file: "/synthetic-unreadable-key", owner: "p1" }],
    registry: base => ({ ...base, presets: { ...base.presets, blocked: { adapter: "opencode", model: "synthetic", provider: "openai", effort: "default", paid: "key", credential: "blocked-key" } } }) }); retrySettings(it);
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
  try {
    await insertInbound(cluster, it.db, { id: "older-harvest", body: "never decoded", kind: "harvest" });
    await insertInbound(cluster, it.db, { id: "supported-human", body: "answer normally" });
    const blocked = blockedAdapter("opencode");
    runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter, opencode: blocked } });
    expect(await observe(async () => (await it.read.inbound()).find(row => row.id === "supported-human")?.state === "answered", 15_000)).toBe(true);
    expect((await it.read.sql("select claimed_by, retry_at from inbound where id='older-harvest'"))[0]).toEqual({ claimed_by: null, retry_at: null });
    expect((await it.read.sql("select data from state_row where sheet='agent_health' and id=$1", [AGENT]))[0].data).toMatchObject({ status: "blocked", ordinary_preset: null, harvest_preset: "blocked" });
    expect(blocked.calls, "a blocked harvester was asked to start").toEqual([]);
  } finally { await runner?.stop(); await it.stop(); }
}, 45_000);

test("production OpenCode is not blocked: an unreadable key is a launch failure the runner retries, with no engine-unavailable notice", async () => {
  // The own-credential policy restored OpenCode. Its key is read at launch, so a key that is not there is
  // an ordinary launch failure: the resident is retried and the input waits for it, never parked as an
  // unavailable engine.
  expect(openCode.activationBlock).toBeUndefined();
  const it = await stageHub(cluster, { hub: { tick_seconds: 1 }, preset: { adapter: "opencode", paid: "key", credential: "missing-key" },
    credentials: [{ id: "missing-key", kind: "model-key", file: "/synthetic-unreadable-key", owner: "p1" }] }); retrySettings(it);
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
  try {
    await insertInbound(cluster, it.db, { id: "opencode-human", body: "answer when you can" });
    runner = await runRunner({ runner: RUNNER, registryFile: it.registryFile, adapters: { opencode: openCode } });
    const health = async () => (await it.read.sql("select data from state_row where sheet='agent_health' and id=$1", [AGENT]))[0]?.data as { status?: string; cause?: string } | undefined;
    expect(await observe(async () => (await health())?.status === "retry", 15_000)).toBe(true);
    expect((await health())?.cause).not.toBe("configured-engine-unavailable");
    expect((await it.read.sql("select state from inbound where id='opencode-human'"))[0].state).toBe("received");
    expect((await it.read.noticeRows()).filter(row => row.notice_key?.startsWith("engine-unavailable:"))).toHaveLength(0);
  } finally { await runner?.stop(); await it.stop(); }
}, 45_000);

test("Codex source checks and launches share the exact required build and actionable check finding", async () => {
  const it = await stageHub(cluster, { preset: { adapter: "codex", provider: "openai", paid: "key", credential: "model" },
    registry: base => ({ ...base, credentials: [{ id: "model", kind: "model-key", owner: "p1", file: join(String(base.hub!.state_dir), "synthetic-key") }] }) });
  writeFileSync(join(it.stateDir, "synthetic-key"), "synthetic-test-key");
  const store = await superStore(cluster, it.db);
  try {
    const registry = loadRegistry(it.registryFile), machine = listRunEntries(registry).find(row => row.id === RUNNER)!.machine;
    for (const version of ["0.151.0", "0.160.0"]) {
      const bin = join(it.stateDir, `codex-${version}`); writeFileSync(bin, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`, { mode: 0o700 });
      if (version === "0.160.0") await checkLoopSource(registry, "daily", { bin });
      else {
        await expect(checkLoopSource(registry, "daily", { bin })).rejects.toThrow("installed 0.151.0; required 0.160.0");
        await expect(codex.prepareLaunch!({} as never, { bin })).rejects.toThrow("installed 0.151.0; required 0.160.0");
      }
      const findings = await runCheck({ machine, registryFile: it.registryFile, store, os: null, kernel: null, loopProbe: { bin }, disk: null });
      expect(findings.some(row => row.kind === "codex-runtime-unavailable")).toBe(version !== "0.160.0");
      if (version !== "0.160.0") expect(findings.find(row => row.kind === "codex-runtime-unavailable")!.says).toContain("installed 0.151.0; required 0.160.0");
    }
    const bin = join(it.stateDir, "missing-codex");
    await expect(checkLoopSource(registry, "daily", { bin })).rejects.toThrow("codex-binary-missing");
    const findings = await runCheck({ machine, registryFile: it.registryFile, store, os: null, kernel: null, loopProbe: { bin }, disk: null });
    expect(findings.find(row => row.kind === "codex-runtime-unavailable")!.says).toContain("Required Codex CLI: 0.160.0");
    const broken = join(it.stateDir, "broken-codex"); writeFileSync(broken, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
    await expect(checkLoopSource(registry, "daily", { bin: broken })).rejects.toThrow("codex-version-unavailable");
  } finally { await store.sql.close(); await it.stop(); }
}, 45_000);
