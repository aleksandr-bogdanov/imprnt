import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, chmodSync, realpathSync, existsSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
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
import { outboundFindings } from "../src/check/outbound.ts";
import { privateOptions } from "../src/outbound/protected-path.ts";
import { readOutboundRequest } from "../src/mcp/outbound-contract.ts";

let cluster: Cluster; const dirs: string[] = [];
beforeAll(async () => { cluster = await startCluster(); });
afterEach(closeStages);
afterAll(async () => { removeEffectDirs(); dirs.forEach(p => rmSync(p, { recursive: true, force: true })); await cluster.stop(); });
const target = { kind: "comment", id: "post-1:comment-2", url: "https://www.linkedin.com/posts/example", label: "Comment by a reader" };
function privateFixture() {
  const parent=join(realpathSync(homedir()),".hub-outbound-test-fixtures");
  mkdirSync(parent,{recursive:true,mode:0o700});
  const root=mkdtempSync(join(parent,"case-")); chmodSync(root,0o700); dirs.push(root); return root;
}
async function fixture(mode = "success") {
  const stage = await stageEffects(cluster); const root = mkdtempSync(join(tmpdir(), "hub-outbound-")); dirs.push(root);
  const privateDir=privateFixture();
  const log = join(root, "calls.jsonl"), module = join(privateDir, "adapter.mjs"), config = join(privateDir, "accounts.json");
  writeFileSync(log, "");
  writeFileSync(module, `import {appendFileSync} from 'node:fs';
export const capabilities=['comment','message','seller_contact']; export const surfaces=['comments','feed'];
export async function send(m,o){appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n'); if(o.mode==='uncertain')throw Error('synthetic lost response');return {identity:m.identity,receipt:'provider-message-42'}};
export async function read(){return {identity:'Owner profile',fresh_post_until:new Date(Date.now()+3600000).toISOString(),findings:[{id:'finding1',surface:'feed',target:${JSON.stringify(target)},text:'Untrusted feed text',changed_at:'2026-10-03T00:00:00Z'}]}};`);
  const account = { id: "career", person: PERSON, agent: "p1-lair", door: DOOR, platform: "linkedin", capabilities:["comment","message","seller_contact"], identity: "Owner profile", adapter_module: module, options: { mode } };
  writeFileSync(config, JSON.stringify([account]),{mode:0o600});
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
  return { stage, root, path, account, config, registry, binding, draft, calls };
}
async function approve(f: Awaited<ReturnType<typeof fixture>>, operation: string, owner = OWNER) {
  const row = (await readOperation(f.stage.as("hub_runner"), operation)).at(-1)!;
  const ctx = f.stage.context({ registry: f.registry, hooks: outboundApprovals() }), gate = f.stage.gate();
  await pass(ctx, gate);
  const last = (await readEffects(f.stage.as("hub_door"), [row.effect_keys.at(-1)!]))[0];
  f.stage.fake.react(row.chat, last.platform_id!, "✅", owner);
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
  const root = privateFixture();
  const module = join(root,"legacy.mjs"), log = join(root,"received.json");
  writeFileSync(module, `import {writeFileSync} from 'node:fs'; const post=async(dir,id,text)=>{writeFileSync(${JSON.stringify(log)},JSON.stringify({dir,id,text}));return {delivered:true}}; export const verbs={reply:post,send:post,contact:post};`);
  writeFileSync(join(root,"token"),"#!/bin/sh\nexit 1\n",{mode:0o700});
  const bridge = await import("../src/outbound/legacy-adapter.ts");
  const message = { account:"test", identity:"Owner profile", target:{...target,kind:"message" as const,id:"msg-synthetic-thread"}, text:"Exact synthetic message",attempt_id:"one-attempt" };
  const options = {source:"linkedin",module,source_dir:root,identity:message.identity,token_argv:[join(root,"token")]};
  expect((await bridge.send(message,options,new AbortController().signal)).receipt).toBe("legacy-http-accepted:one-attempt");
  expect(JSON.parse(readFileSync(log,"utf8")).text).toBe(message.text);
  await expect(bridge.send({...message,target:{...target,kind:"comment"}},options,new AbortController().signal)).rejects.toThrow();
  await bridge.send({...message,target:{...message.target,kind:"seller_contact",id:"123456"}}, {...options,source:"kleinanzeigen"},new AbortController().signal);
  expect(JSON.parse(readFileSync(log,"utf8")).id).toBe("123456");
});


test("held sends and undeliverable notice debt cannot starve later approvals across restarts", async () => {
  const f=await fixture();
  for(let i=0;i<40;i++) {
    const draft=await f.draft(`held-${i}`); const row=await approve(f,draft.object_id!);
    if(i>=20) await f.stage.admin`update outbound_delivery set state='uncertain', cause='lost-response' where confirmation_id=${row.id}`;
  }
  const newChat=f.stage.fake.addChannel({name:"new-origin"});
  writeFileSync(f.path,readFileSync(f.path,"utf8").replaceAll(f.stage.channel,newChat));
  const later=await f.draft("valid-after-held"); const row=await approve(f,later.object_id!);
  await f.stage.admin`update outbound_delivery set checked_at=now() where confirmation_id=${row.id}`;
  for(let pass=0;pass<3;pass++) await deliverOutbound(f.stage.fresh("hub_door"),f.registry(),DOOR);
  expect(f.calls()).toHaveLength(1);
  expect((await callTool(f.binding,"hub_outbound",{action:"inspect",draft_id:later.object_id})).stage).toBe("sent");
  const [debt]=await f.stage.admin`select count(*)::int as n from outbound_delivery where state='uncertain' and not notified`;
  expect(debt.n).toBe(20);
  await deliverOutbound(f.stage.fresh("hub_door"),f.registry(),DOOR); expect(f.calls()).toHaveLength(1);
});


test("protected private code is not imported by drafting; invalid mutable-path accounts do not stop valid sends", async () => {
  const f=await fixture();
  const imported=join(f.root,"imported");
  appendFileSync(f.account.adapter_module,`\nappendFileSync(${JSON.stringify(imported)},'imported');\n`);
  const hostile=join(f.root,"agent-writable.mjs");writeFileSync(hostile,"throw Error('must never import');");
  expect(()=>privateOptions({token_argv:[hostile]},"/",f.registry())).toThrow();
  expect(()=>privateOptions({source_dir:f.root},"/",f.registry())).toThrow();
  expect(()=>privateOptions({token_argv:["relative-provider"]},"/",f.registry())).toThrow();
  writeFileSync(f.config,JSON.stringify([f.account,{...f.account,id:"unsafe",adapter_module:hostile}]));
  const draft=await f.draft("safe-private");expect(existsSync(imported)).toBe(false);
  await expect(callTool(f.binding,"hub_outbound",{action:"draft",request_key:"unsafe",account:"unsafe",target,text:"no"})).rejects.toThrow();
  await approve(f,draft.object_id!);await deliverOutbound(f.stage.as("hub_door"),f.registry(),DOOR);
  expect(f.calls()).toHaveLength(1);expect(existsSync(imported)).toBe(true);
  expect((await outboundFindings(f.stage.as("hub_hub"),f.registry(),"mac",[DOOR])).some(x=>x.subject==="unsafe")).toBe(true);
  chmodSync(f.config,0o644);
  await expect(callTool(f.binding,"hub_outbound",{action:"inspect"})).rejects.toThrow();
});

test("held approvals tell the owner once and check reports them; external labels never ping", async () => {
  const f=await fixture();const draft=await f.draft("held-notice");await approve(f,draft.object_id!);
  writeFileSync(f.config,JSON.stringify([{...f.account,identity:"Rotated"}]));
  await deliverOutbound(f.stage.as("hub_door"),f.registry(),DOOR);await deliverOutbound(f.stage.as("hub_door"),f.registry(),DOOR);
  expect((await f.stage.admin`select body from outbox where notice_key like 'outbound:%:held:%'`)).toHaveLength(1);
  expect((await outboundFindings(f.stage.as("hub_hub"),f.registry(),"mac",[DOOR])).some(x=>x.says.includes("remains held"))).toBe(true);
  writeFileSync(f.config,JSON.stringify([f.account]));
  const mentions=await f.draft("mentions","exact",{target:{...target,label:"@everyone <@123> <@&456>"}});await approve(f,mentions.object_id!);
  await deliverOutbound(f.stage.as("hub_door"),f.registry(),DOOR);
  const rows=await f.stage.admin`select body from outbox where notice_key like 'outbound:%:sent'`;
  expect(rows.some((r:any)=>r.body.includes("@\u200beveryone"))).toBe(true);
  expect(rows.every((r:any)=>!/@(?:everyone|here|[0-9&])/.test(r.body))).toBe(true);
});


for(const platform of ["discord","telegram"]) test(`maximum escaped success notice uses actual ${platform} General route boundaries without resending`,async()=>{
 const f=await fixture();
 f.account.identity="@".repeat(1000);writeFileSync(f.config,JSON.stringify([f.account]));
 const d=await f.draft("max-notice","exact",{target:{...target,label:"@".repeat(2000)}});
 const row=await approve(f,d.object_id!);
 await deliverOutbound(f.stage.as("hub_door"),f.registry(),DOOR);expect(f.calls()).toHaveLength(1);
 await f.stage.admin`delete from outbox where notice_key like ${`outbound:${row.id}:sent%`}`;
 await f.stage.admin`update outbound_delivery set notified=false where confirmation_id=${row.id}`;
 writeRegistry(f.root,{hub:{state_dir:f.root},machines:[{id:"test",os:"macos"}],people:[{id:PERSON,general:"p1-general",allowed_senders:{[DOOR]:[OWNER]}} as never],
  presets:{daily:{adapter:"synthetic",model:"m",provider:"p",effort:"medium",paid:"plan"}},
  agents:[{id:"p1-lair",person:PERSON,preset:"daily",chat:"100000000000000077",door:DOOR,runner:"runner-test"},
    {id:"p1-general",person:PERSON,preset:"daily",chat:"100000000000000078",door:"general-door",runner:"runner-test"}],
  run:[{id:"general-door",kind:"door",machine:"test",platform,person:PERSON,token_file:"/dev/null",schedule:"always",memory_limit_mb:192}] as never});
 appendFileSync(f.path,`\n[outbound]\naccounts_file = ${JSON.stringify(f.config)}\n`);
 await deliverOutbound(f.stage.as("hub_door"),f.registry(),DOOR);
 await deliverOutbound(f.stage.as("hub_door"),f.registry(),DOOR);
 const parts=await f.stage.admin`select body,notice_key,seq_in_reply,route from outbox where notice_key like ${`outbound:${row.id}:sent%`} order by seq_in_reply`;
 expect(parts.length).toBeGreaterThan(1);
 if(platform==="telegram")expect(Math.max(...parts.map((p:any)=>p.body.length))).toBeGreaterThan(2000);
 for(const [i,p] of parts.entries()){
  expect(p.body.length).toBeLessThanOrEqual(platform==="discord"?2000:4000);expect(p.body.trim()).not.toBe("");
  expect(p.notice_key).toBe(`outbound:${row.id}:sent${i ? `:part:${i+1}` : ""}`);
  expect(p.route).toMatchObject({door:"general-door",chat:"100000000000000078",outbound_confirmation:row.id,outbound_source_agent:"p1-lair"});
 }
 expect(parts.map((p:any)=>p.body).join("")).toBe(`Sent the approved message from ${"@\u200b".repeat(1000)} to ${"@\u200b".repeat(2000)}.`);
 expect(f.calls()).toHaveLength(1);
 const [state]=await f.stage.admin`select notified from outbound_delivery where confirmation_id=${row.id}`;expect(state.notified).toBe(true);
});

test("all notice parts and marker commit together; repairing a failed notice transaction never resends externally",async()=>{
 const f=await fixture();const d=await f.draft("atomic-notice","exact",{target:{...target,label:"x".repeat(2000)}});const row=await approve(f,d.object_id!);
 await f.stage.admin.unsafe(`create function test_refuse_part() returns trigger language plpgsql as $$ begin if new.notice_key like 'outbound:%' and new.seq_in_reply=2 then raise exception 'synthetic-part-refusal'; end if; return new; end $$; create trigger test_refuse_part before insert on outbox for each row execute function test_refuse_part()`);
 await expect(deliverOutbound(f.stage.as("hub_door"),f.registry(),DOOR)).rejects.toThrow("synthetic-part-refusal");
 expect(f.calls()).toHaveLength(1);
 expect(await f.stage.admin`select id from outbox where notice_key like ${`outbound:${row.id}:sent%`}`).toHaveLength(0);
 const [state]=await f.stage.admin`select state,notified from outbound_delivery where confirmation_id=${row.id}`;expect(state).toMatchObject({state:"sent",notified:false});
 await f.stage.admin`drop trigger test_refuse_part on outbox`;
 await deliverOutbound(f.stage.as("hub_door"),f.registry(),DOOR);
 expect(f.calls()).toHaveLength(1);
 expect((await f.stage.admin`select id from outbox where notice_key like ${`outbound:${row.id}:sent%`}`).length).toBeGreaterThan(1);
});

test("unconfigured outbound inspect names disabled availability and drafting stays refused",async()=>{
 const f=await fixture();writeFileSync(f.path,readFileSync(f.path,"utf8").split("\n[outbound]")[0]);
 const result=await callTool(f.binding,"hub_outbound",{action:"inspect"});expect(result.stage).toBe("disabled");
 await expect(f.draft("disabled")).rejects.toThrow("outbound is not configured");expect(f.calls()).toHaveLength(0);
});
