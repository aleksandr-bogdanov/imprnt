import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { stageEffects, closeStages, removeEffectDirs, pass, OWNER, PERSON, DOOR, type EffectsStage } from "./helpers/effects-fixture.ts";
import { writeRegistry } from "./helpers/authorized-registry.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { callTool, type McpBinding } from "../src/mcp/handlers.ts";
import { readOperation } from "../src/store/confirmations.ts";
import { readEffects } from "../src/store/effects.ts";
import { pollConfirmations } from "../src/door/confirm.ts";
import { outboundApprovals, deliverOutbound } from "../src/outbound/delivery.ts";
import { readOutbound, nextRead, NORMAL_MS, COOKING_MS } from "../src/outbound/reading.ts";
import { enqueueInbound } from "../src/store/inbound.ts";
import { readOutboundRequest } from "../src/mcp/outbound-contract.ts";

let cluster: Cluster; const dirs: string[] = [];
beforeAll(async () => { cluster = await startCluster(); });
afterEach(closeStages);
afterAll(async () => { removeEffectDirs(); dirs.forEach(p => rmSync(p, { recursive: true, force: true })); await cluster.stop(); });
const target = { kind: "comment", id: "post-1:comment-2", url: "https://www.linkedin.com/posts/example", label: "Comment by a reader" };
async function fixture(mode = "success") {
  const stage = await stageEffects(cluster); const root = mkdtempSync(join(tmpdir(), "hub-outbound-")); dirs.push(root);
  const log = join(root, "calls.jsonl"), module = join(root, "adapter.mjs"), config = join(root, "accounts.json");
  writeFileSync(log, "");
  writeFileSync(module, `import {appendFileSync} from 'node:fs';
export const capabilities=['comment','message','seller_contact']; export const surfaces=['comments','feed'];
export async function send(m,o){appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n'); if(o.mode==='uncertain')throw Error('synthetic lost response');return {identity:m.identity,receipt:'provider-message-42'}};
export async function read(){return {identity:'Owner profile',fresh_post_until:new Date(Date.now()+3600000).toISOString(),findings:[{id:'finding1',surface:'feed',target:${JSON.stringify(target)},text:'Untrusted feed text',changed_at:'2026-10-03T00:00:00Z'}]}};`);
  const account = { id: "career", person: PERSON, agent: "p1-lair", door: DOOR, platform: "linkedin", identity: "Owner profile", adapter_module: module, options: { mode } };
  writeFileSync(config, JSON.stringify([account]));
  const path = writeRegistry(root, { hub: { state_dir: root }, people: [{ id: PERSON, allowed_senders: { [DOOR]: [OWNER] } } as never],
    presets: { daily: { adapter: "synthetic", model: "m", provider: "p", effort: "medium", paid: "plan" } },
    agents: [{ id: "p1-lair", person: PERSON, preset: "daily", chat: stage.channel, door: DOOR, runner: "runner-test" }] });
  appendFileSync(path, `\n[outbound]\naccounts_file = ${JSON.stringify(config)}\n`);
  const registry = () => loadRegistry(path);
  await stage.admin`insert into conversation (id,person,agent,kind,adapter,native_session) values ('outbound-chat',${PERSON},'p1-lair','master','synthetic','none')`;
  await enqueueInbound(stage.as("hub_door"), { id: "owner-message", person: PERSON, agent: "p1-lair", body: "Help with my replies", source: {
    log_id: "owner-message", at: new Date().toISOString(), door: DOOR, chat: stage.channel, sender_id: OWNER, text: "Help with my replies" } });
  const binding: McpBinding = { store: stage.as("hub_runner"), person: PERSON, agent: "p1-lair", conversation: "outbound-chat", kind: "master", registry, attempt: () => null };
  const draft = (key: string, text = "Exact approved reply", extra = {}) => callTool(binding, "hub_outbound", { action: "draft", request_key: key, account: "career", target, text, ...extra });
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { stage, root, account, config, registry, binding, draft, calls };
}
async function approve(f: Awaited<ReturnType<typeof fixture>>, operation: string, owner = OWNER) {
  const row = (await readOperation(f.stage.as("hub_runner"), operation)).at(-1)!;
  const ctx = f.stage.context({ registry: f.registry, hooks: outboundApprovals() }), gate = f.stage.gate();
  await pass(ctx, gate);
  const last = (await readEffects(f.stage.as("hub_door"), [row.effect_keys.at(-1)!]))[0];
  f.stage.fake.react(f.stage.channel, last.platform_id!, "✅", owner);
  await pollConfirmations(ctx, gate);
  if (owner === OWNER) { const checked = (await readOperation(f.stage.as("hub_runner"), operation)).at(-1)!; expect({state:checked.state,evidence:checked.evidence}).toMatchObject({state:"approved"}); }
  return row;
}

test("exact draft revision supersedes edits; only owner reaction sends once, including concurrent/restarted delivery", async () => {
  const f = await fixture();
  const first = await f.draft("first", "old draft");
  const second = await f.draft("edit", "owner's revised text", { draft_id: first.object_id, expected_revision: first.revision });
  expect(second.revision).toBe(2);
  expect((await f.draft("stale", "stale", { draft_id: first.object_id, expected_revision: 1 })).status).toBe("failed");
  await deliverOutbound(f.stage.as("hub_door"), f.registry(), DOOR); expect(f.calls()).toHaveLength(0);
  await approve(f, first.object_id!, "200000000000000001");
  await deliverOutbound(f.stage.as("hub_door"), f.registry(), DOOR); expect(f.calls()).toHaveLength(0);
  await approve(f, first.object_id!);
  await Promise.all([deliverOutbound(f.stage.as("hub_door"), f.registry(), DOOR), deliverOutbound(f.stage.fresh("hub_door"), f.registry(), DOOR)]);
  await deliverOutbound(f.stage.fresh("hub_door"), f.registry(), DOOR);
  expect(f.calls()).toHaveLength(1); expect(f.calls()[0].text).toBe("owner's revised text"); expect(f.calls()[0].target).toEqual(target);
  expect((await callTool(f.binding, "hub_outbound", { action: "inspect", draft_id: first.object_id })).stage).toBe("sent");
  expect((await f.draft("after", "changed", { draft_id: first.object_id, expected_revision: 2 })).status).toBe("failed");
});

test("lost send reply and crashed send claim are uncertain and never replayed", async () => {
  const f = await fixture("uncertain"); const draft = await f.draft("uncertain"); await approve(f, draft.object_id!);
  await deliverOutbound(f.stage.as("hub_door"), f.registry(), DOOR);
  await deliverOutbound(f.stage.fresh("hub_door"), f.registry(), DOOR);
  expect(f.calls()).toHaveLength(1);
  expect((await callTool(f.binding, "hub_outbound", { action: "inspect", draft_id: draft.object_id })).stage).toBe("uncertain");
  const second = await f.draft("crash"); const row = await approve(f, second.object_id!);
  await f.stage.admin`update outbound_delivery set state='sending', attempt_id='dead-process', updated_at=now()-interval '3 minutes' where confirmation_id=${row.id}`;
  await deliverOutbound(f.stage.fresh("hub_door"), f.registry(), DOOR);
  expect(f.calls()).toHaveLength(1);
  expect((await callTool(f.binding, "hub_outbound", { action: "inspect", draft_id: second.object_id })).stage).toBe("uncertain");
});

test("account changes and role boundaries cannot send a different identity or forge approval", async () => {
  const f = await fixture(); const draft = await f.draft("identity"); await approve(f, draft.object_id!);
  writeFileSync(f.config, JSON.stringify([{ ...f.account, identity: "Different account" }]));
  await deliverOutbound(f.stage.as("hub_door"), f.registry(), DOOR); expect(f.calls()).toHaveLength(0);
  const row = (await readOperation(f.stage.as("hub_runner"), draft.object_id!)).at(-1)!;
  await expect((async () => await f.stage.as("hub_runner").sql`insert into outbound_delivery (confirmation_id,door) values (${row.id},${DOOR})`)()).rejects.toThrow();
  await expect((async () => await f.stage.as("hub_agent").sql`update outbound_delivery set state='queued'`)()).rejects.toThrow();
  await expect(callTool({ ...f.binding, person: "p2" }, "hub_outbound", { action: "inspect", draft_id: draft.object_id })).rejects.toThrow();
  expect(() => readOutboundRequest({ action: "send", approved: true })).toThrow();
});

test("LinkedIn findings persist for master selection with two-hour/five-minute durable cadence", async () => {
  const f = await fixture(); const now = Date.now()+1000;
  expect(nextRead(now,null)-now).toBe(NORMAL_MS); expect(nextRead(now,new Date(now+1000).toISOString())-now).toBe(COOKING_MS);
  await readOutbound(f.stage.as("hub_door"), f.registry(), DOOR, now);
  const inspected = await callTool(f.binding, "hub_outbound", { action: "inspect" });
  const findings = inspected.findings as any[];
  expect(findings[0].findings[0].surface).toBe("feed"); expect(findings[0].findings[0].text).toBe("Untrusted feed text");
  expect(new Date(findings[0].next_at).getTime()-now).toBe(COOKING_MS);
  const before = findings[0].next_at;
  await readOutbound(f.stage.fresh("hub_door"), f.registry(), DOOR, now+1000);
  expect((await f.stage.admin`select next_at from outbound_read`)[0].next_at).toEqual(before);
  expect(f.calls()).toHaveLength(0);
  writeFileSync(f.config, JSON.stringify([{ ...f.account, identity: "Replacement identity" }]));
  expect((await callTool(f.binding, "hub_outbound", { action: "inspect" })).findings).toEqual([]);
});

test("private legacy bridge calls existing seller and inbox verbs with exact text; missing comment support refuses", async () => {
  const root = mkdtempSync(join(tmpdir(), "hub-outbound-legacy-")); dirs.push(root);
  const module = join(root,"legacy.mjs"), log = join(root,"received.json");
  writeFileSync(module, `import {writeFileSync} from 'node:fs'; const post=async(dir,id,text)=>{writeFileSync(${JSON.stringify(log)},JSON.stringify({dir,id,text}));return {delivered:true}}; export const verbs={reply:post,send:post,contact:post};`);
  const bridge = await import("../src/outbound/legacy-adapter.ts");
  const message = { account:"test", identity:"Owner profile", target:{...target,kind:"message" as const,id:"msg-synthetic-thread"}, text:"Exact synthetic message",attempt_id:"one-attempt" };
  const options = {source:"linkedin",module,source_dir:root,identity:message.identity,token_argv:["/not-executed"]};
  expect((await bridge.send(message,options,new AbortController().signal)).receipt).toBe("legacy-http-accepted:one-attempt");
  expect(JSON.parse(readFileSync(log,"utf8")).text).toBe(message.text);
  await expect(bridge.send({...message,target:{...target,kind:"comment"}},options,new AbortController().signal)).rejects.toThrow();
  await bridge.send({...message,target:{...message.target,kind:"seller_contact",id:"123456"}}, {...options,source:"kleinanzeigen"},new AbortController().signal);
  expect(JSON.parse(readFileSync(log,"utf8")).id).toBe("123456");
});
