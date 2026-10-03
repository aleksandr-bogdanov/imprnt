import {afterAll,afterEach,beforeAll,expect,test} from "bun:test";
import {startCluster,type Cluster} from "./helpers/cluster.ts";
import {stageTopics,PERSON,DOOR} from "./helpers/topics-fixture.ts";
import {closeStages,removeEffectDirs,OWNER} from "./helpers/effects-fixture.ts";
import {bound,confirmed,finish} from "./helpers/deletion-fixture.ts";
import {freezeConfirmation} from "../src/store/confirmations.ts";
import {readErasureManifest,applyErasureManifest} from "../src/store/deletions.ts";
import {outboundFence,outboundNoticeFence} from "../src/outbound/fence.ts";
let cluster:Cluster;
beforeAll(async()=>{cluster=await startCluster()});afterEach(closeStages);afterAll(async()=>{removeEffectDirs();await cluster.stop()});

test("topic deletion and tombstone restore erase outbound revisions, receipts and General notices but preserve other masters and account-wide reads",async()=>{
 const s=await stageTopics(cluster),topic=await bound(s);
 const ids:string[]=[];
 for(const [n,state] of ["pending","queued","sent","uncertain"].entries()) {
  const f=await freezeConfirmation(s.as("hub_runner"),{operationId:`outbound-erase-${n}`,operationKind:"outbound.send",person:PERSON,door:DOOR,chat:s.channel,ownerSender:OWNER,
   payload:{agent:topic.agent_id,text:"OWNED-SECRET",account:"shared-account"},preview:"OWNED-SECRET",confirmation:"approve",platform:"discord"});
  ids.push(f.id);
  if(state!=="pending"){
   await s.admin`update confirmation set state='approved',approved_by=owner_sender,approved_at=now() where id=${f.id}`;
   await s.admin`insert into outbound_delivery(confirmation_id,door,state,receipt) values(${f.id},${DOOR},${state},${{secret:"OWNED-SECRET"}}::jsonb)`;
  }
  await s.as("hub_door").sql`select hub_outbound_notice(${f.id},${PERSON},'p1-lair','OWNED-SECRET',${`outbound:${f.id}:sent`},${{door:DOOR,chat:s.channel}}::jsonb,1)`;
 }
 // A legacy notice lacks route provenance; exact confirmation ownership still finds it.
 await s.admin`insert into outbox(kind,seq_in_reply,person,agent,body,notice_key,route) values('notice',2,${PERSON},'p1-lair','OWNED-SECRET',${`outbound:${ids[0]}:sent:part:2`},${{door:DOOR,chat:s.channel}}::jsonb)`;
 const other=await freezeConfirmation(s.as("hub_runner"),{operationId:"unrelated-outbound",operationKind:"outbound.send",person:PERSON,door:DOOR,chat:s.channel,ownerSender:OWNER,
  payload:{agent:"p1-lair",text:"OTHER-MASTER"},preview:"OTHER-MASTER",confirmation:"approve",platform:"discord"});
 await s.admin`insert into outbound_read(account,person,config_hash,findings) values('shared-account',${PERSON},'h','[{"text":"ACCOUNT-WIDE"}]')`;
 const saved=await s.admin`select * from confirmation where id in ${s.admin(ids)}`;
 const notices=await s.admin`select * from outbox where notice_key like 'outbound:%'`;
 const [inv]=await s.admin`select hub_deletion_inventory(${topic.agent_id},${topic.conversation_id},'[]',${PERSON},${DOOR},${topic.chat},${topic.id}) as data`;
 expect(Number(inv.data.confirmations)).toBeGreaterThanOrEqual(4);expect(Number(inv.data.outbound_deliveries)).toBe(3);
 const [notice]=await s.admin`select id from outbox where notice_key=${`outbound:${ids[1]}:sent`}`;
 const held=await outboundNoticeFence(s.as("hub_door"),notice.id);expect(held).not.toBeNull();
 let erased=false;
 const deletion=confirmed(s,topic).then(()=>{erased=true});
 await Bun.sleep(100);expect(erased).toBe(false);await held!.release();await deletion;await finish(s);
 expect(await s.admin`select id from confirmation where id in ${s.admin(ids)}`).toHaveLength(0);
 expect(await s.admin`select * from outbound_delivery`).toHaveLength(0);
 expect(await s.admin`select key from platform_effect where owner_ref in ${s.admin(ids.map(id=>`confirmation:${id}`))}`).toHaveLength(0);
 expect(await s.admin`select * from outbox where notice_key like 'outbound:%'`).toHaveLength(0);
 expect(await s.admin`select id from confirmation where id=${other.id}`).toHaveLength(1);
 expect(await s.admin`select * from outbound_read where account='shared-account'`).toHaveLength(1);
 expect(await outboundNoticeFence(s.as("hub_door"),notice.id)).toBeNull();
 const [late]=await s.as("hub_door").sql`select hub_outbound_notice(${ids[1]},${PERSON},'p1-lair','late',${`outbound:${ids[1]}:late`},${{door:DOOR,chat:s.channel}}::jsonb,1) as ok`;
 expect(late.ok).toBe(false);
 const manifest=await readErasureManifest(s.as("hub_hub"));
 // Restore a snapshot that predates the deletion; only this historical fixture bypasses the live insert fence.
 await s.admin`alter table confirmation disable trigger outbound_confirmation_source`;
 try {for(const row of saved)await s.admin`insert into confirmation select * from json_populate_record(null::confirmation,${row}::json)`;}
 finally{await s.admin`alter table confirmation enable trigger outbound_confirmation_source`}
 for(const row of notices)await s.admin`insert into outbox select * from json_populate_record(null::outbox,${row}::json)`;
 await s.admin`insert into outbound_delivery(confirmation_id,door,state) values(${ids[3]},${DOOR},'uncertain')`;
 const [before]=await s.admin`select hub_erasure_remaining(${topic.id}) as n`;expect(Number(before.n)).toBeGreaterThan(0);
 await applyErasureManifest(s.as("hub_hub"),manifest);
 const [after]=await s.admin`select hub_erasure_remaining(${topic.id}) as n`;expect(Number(after.n)).toBe(0);
 expect(await s.admin`select id from confirmation where id=${other.id}`).toHaveLength(1);
 expect(await s.admin`select * from outbound_read`).toHaveLength(1);
 await expect(freezeConfirmation(s.as("hub_runner"),{operationId:"late-new",operationKind:"outbound.send",person:PERSON,door:DOOR,chat:s.channel,ownerSender:OWNER,
  payload:{agent:topic.agent_id,text:"late"},preview:"late",confirmation:"approve",platform:"discord"})).rejects.toThrow("outbound-source-erased");
},90000);

test("maintenance fence spans committed outbound work without holding a transaction, and cannot deadlock nested notice publication behind deletion",async()=>{
 const s=await stageTopics(cluster),topic=await bound(s);
 const f=await freezeConfirmation(s.as("hub_runner"),{operationId:"fenced-send",operationKind:"outbound.send",person:PERSON,door:DOOR,chat:s.channel,ownerSender:OWNER,payload:{agent:topic.agent_id},preview:"message",confirmation:"approve",platform:"discord"});
 const held=await outboundFence(s.as("hub_door"));
 let acquired=false;const conn=await s.admin.reserve();
 const waiting=(async()=>{await conn`select pg_advisory_lock(682151,1)`;acquired=true;await conn`select pg_advisory_unlock(682151,1)`;conn.release()})();
 await Bun.sleep(75);expect(acquired).toBe(false);
 await held.store.sql.begin(async sql=>{const [row]=await sql`select hub_outbound_notice(${f.id},${PERSON},'p1-lair','notice',${`outbound:${f.id}:sent`},${{door:DOOR,chat:s.channel}}::jsonb,1) as ok`;expect(row.ok).toBe(true)});
 await held.release();await waiting;expect(acquired).toBe(true);
},90000);

import {stageHub,superStore} from "./helpers/hub-fixture.ts";
import {rolloutPlatform} from "./helpers/rollout-platform.ts";
import {runDoor} from "../src/door/run.ts";
import {observe} from "./helpers/rollout-runner.ts";
import {readFileSync} from "node:fs";
import {join} from "node:path";

test("real door fences loaded outbound parts against deletion and logs General notices under their source ownership",async()=>{
 const it=await stageHub(cluster,{hub:{tick_seconds:1}}),store=await superStore(cluster,it.db),edge=rolloutPlatform("discord");
 let door:Awaited<ReturnType<typeof runDoor>>|undefined;
 let releasePost!:()=>void;const postHeld=new Promise<void>(resolve=>{releasePost=resolve});let entered=false;
 const platform={...edge.platform,async post(args:Parameters<typeof edge.platform.post>[0]){
  if(args.text==="source-first"){entered=true;await postHeld;}return edge.platform.post(args);
 }};
 let removal:Promise<void>|undefined;
 let starting:ReturnType<typeof runDoor>|undefined;
 try {
  const f=await freezeConfirmation(store,{operationId:"door-source",operationKind:"outbound.send",person:"p1",door:"door-fake",chat:"1000000001",ownerSender:"p1",
   payload:{agent:"p1-source"},preview:"preview",confirmation:"approve",platform:"discord"});
  for(const n of [1,2])await store.sql`select hub_outbound_notice(${f.id},'p1','p1-lair',${n===1?"source-first":"source-second"},${`outbound:${f.id}:sent${n===1?"":":part:2"}`},'{"door":"door-fake","chat":"1000000001"}'::jsonb,${n})`;
  starting=runDoor({door:"door-fake",registryFile:it.registryFile,platform});
  expect(await observe(()=>entered)).toBe(true);
  const conn=await store.sql.reserve();let acquired=false;
  removal=(async()=>{try{
   await conn`select pg_advisory_lock(682151,1)`;acquired=true;
   await conn`insert into identity_reservation(kind,id,reason) values('agent','p1-source','deleted')`;
   await conn`delete from outbox where notice_key like ${`outbound:${f.id}:%`}`;
   await conn`delete from confirmation where id=${f.id}`;
   await conn`select pg_advisory_unlock(682151,1)`;
  }finally{conn.release()}})();
  await Bun.sleep(75);expect(acquired).toBe(false);releasePost();await removal;door=await starting;
  await Bun.sleep(200);
  expect(edge.posts().filter(p=>p.text.startsWith("source-")).map(p=>p.text)).toEqual(["source-first"]);
  const source=[...new Bun.Glob("*.jsonl").scanSync({cwd:join(it.stateDir,"p1","chatlog","p1-source"),absolute:true})];
  expect(source.map(p=>readFileSync(p,"utf8")).join("")).toContain("source-first");
 }finally{releasePost();await removal;door ??= await starting;await door?.stop();await store.close();await it.stop()}
},90000);
