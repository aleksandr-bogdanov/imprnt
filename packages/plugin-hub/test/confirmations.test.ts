// A frozen exact preview and the one green-check approval it can earn, in the door,
// over Discord's REST reads alone: no Gateway, no connection of its own, no model
// that can say "approved".
//
// The store is a disposable Postgres, the door's poll and the Discord seam are the
// shipped ones and the network behind the seam is the fake Discord. The last two
// checks run a REAL `runDoor` as a synthetic consumer would: it freezes a preview and
// asks for a status line as the runner's role, the door delivers both and reads the
// reaction on its own tick, and one approval and one unit of work commit together.
//
// THE RULES UNDER TEST, from the root dispositions of this task: every part of the
// preview is delivered unchanged before any reaction is read; the owner is checked
// against the registry when the poll is made; an unknown, refused or failed read is
// never an approval and never a deletion; approval and the work it authorizes are one
// transaction with nothing external inside it; and an approval nobody can act on is
// not recorded at all.

import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { closeStages, DOOR, OWNER, PERSON, effectRow, pass, removeEffectDirs, stageEffects, type EffectsStage } from "./helpers/effects-fixture.ts";
import { stageHub } from "./helpers/authorized-registry.ts";
import { CHECK, createFakeDiscord, type Fault } from "./helpers/fake-discord-rest.ts";
import { createFakePlatform } from "./helpers/fake-platform.ts";
import { pollConfirmations, readPending, type ApprovalHooks, type PollSchedule } from "../src/door/confirm.ts";
import { readEffectWork, runEffectWork } from "../src/door/effects.ts";
import { startEffects } from "../src/door/effects-task.ts";
import { discord } from "../src/door/platforms/discord.ts";
import { runDoor } from "../src/door/run.ts";
import { storeUrlAs } from "../src/store/connect.ts";
import { enqueueInbound } from "../src/store/inbound.ts";
import {
  CONFIRM_EMOJI, ConfirmationRefused, canonicalJson, freezeConfirmation, normalizePayload, previewHash, readConfirmation, readOperation,
  type ConfirmationRow, type FreezeConfirmation,
} from "../src/store/confirmations.ts";
import { EffectTooLong, effectMarker, readEffects, wantEffect } from "../src/store/effects.ts";

let cluster: Cluster;

beforeAll(async () => { cluster = await startCluster(); });
afterEach(closeStages);
afterAll(async () => {
  removeEffectDirs();
  await cluster?.stop();
});

const KIND = "synthetic.job";
const PREVIEW = "Chat: alpha\nExecution machine: pi\nAgent: p1-alpha\n\nRequest:\nsummarise the week";
const ASK = "React with ✅ to confirm.";

/** The work an approval authorizes, recorded in the approval's own transaction. */
function hooks(work: ConfirmationRow[]): ApprovalHooks {
  return {
    [KIND]: async (tx, approval) => {
      const payload = approval.payload as { task: string };
      await enqueueInbound(tx, { id: `synthetic:${approval.operation_id}`, person: PERSON, agent: "p1-lair", body: payload.task });
      work.push(approval);
    },
  };
}

function freeze(stage: EffectsStage, over: Partial<FreezeConfirmation> = {}) {
  return freezeConfirmation(stage.as("hub_runner"), {
    operationId: "op-1", operationKind: KIND, person: PERSON, door: DOOR, chat: stage.channel, ownerSender: OWNER,
    payload: { agent: "p1-alpha", task: "summarise the week" }, preview: PREVIEW, confirmation: ASK, ...over,
  });
}

const long = () => Array.from({ length: 120 }, (_, at) => `line ${at}: ${"word ".repeat(10).trim()}`).join("\n");

/** The message the ledger made for one effect key. */
async function messageOf(stage: EffectsStage, key: string): Promise<string> {
  const [row] = await readEffects(stage.as("hub_hub"), [key]);
  return row.platform_id!;
}

/** The message a reaction is read from: the last part of the confirmation. */
async function lastOf(stage: EffectsStage, id: string): Promise<string> {
  const row = (await readConfirmation(stage.as("hub_hub"), id))!;
  return await messageOf(stage, row.effect_keys[row.effect_keys.length - 1]);
}

const reads = (stage: EffectsStage) => stage.fake.requestsTo(/^GET .*\/reactions\//);
const posts = (stage: EffectsStage) => stage.fake.requestsTo(new RegExp(`^POST /channels/${stage.channel}/messages$`));
const state = async (stage: EffectsStage, id: string) => (await readConfirmation(stage.as("hub_hub"), id))!;
const inbox = async (stage: EffectsStage) => Number((await stage.admin`select count(*)::int as n from inbound where id like 'synthetic:%'`)[0].n);

test("freezing gives the exact labelled preview, the hash of what the owner saw and one confirmation message last, and every part is frozen", async () => {
  const stage = await stageEffects(cluster);
  const frozen = await freeze(stage);
  const hash = previewHash(KIND, { agent: "p1-alpha", task: "summarise the week" }, PREVIEW, ASK);
  expect(frozen).toMatchObject({ revision: 1, state: "pending", hash, created: true });
  expect(hash).toMatch(/^[0-9a-f]{64}$/);

  const row = (await state(stage, frozen.id));
  expect(row.effect_keys).toHaveLength(2);
  const [preview, ask] = await readEffects(stage.as("hub_hub"), row.effect_keys);
  // The labels and the request, verbatim, and the marker line under them.
  expect(preview.wanted_content).toBe(`${PREVIEW}\n\`${effectMarker(row.effect_keys[0])}\``);
  expect(ask.wanted_content).toBe(`${ASK}\n\`sha256:${hash}\`\n\`${effectMarker(row.effect_keys[1])}\``);
  for (const part of [preview, ask]) {
    expect([part.frozen, part.state, part.owner_ref, part.door, part.chat]).toEqual([true, "not_sent", `confirmation:${frozen.id}`, DOOR, stage.channel]);
  }
  expect(row).toMatchObject({ operation_id: "op-1", operation_kind: KIND, person: PERSON, owner_sender: OWNER, state: "pending", payload: { agent: "p1-alpha", task: "summarise the week" } });

  // The hash binds the kind, the payload, the preview text AND the request line, in a fixed order of keys.
  expect(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] })).toBe('{"a":[{"c":2}],"b":1}');
  expect(previewHash(KIND, { task: "summarise the week", agent: "p1-alpha" }, PREVIEW, ASK)).toBe(hash);
  expect(previewHash(KIND, { agent: "p1-alpha", task: "summarise the month" }, PREVIEW, ASK)).not.toBe(hash);
  expect(previewHash(KIND, { agent: "p1-alpha", task: "summarise the week" }, `${PREVIEW}!`, ASK)).not.toBe(hash);
  expect(previewHash("other.kind", { agent: "p1-alpha", task: "summarise the week" }, PREVIEW, ASK)).not.toBe(hash);
  expect(previewHash(KIND, { agent: "p1-alpha", task: "summarise the week" }, PREVIEW, "React with 👍 to confirm.")).not.toBe(hash);

  // A part of a frozen preview cannot be changed by anybody who can ask for a message.
  await expect(wantEffect(stage.as("hub_runner"), { key: row.effect_keys[0], door: DOOR, chat: stage.channel, owner: `confirmation:${frozen.id}`, text: "altered" }))
    .rejects.toThrow(/effect-frozen/);
  expect(CONFIRM_EMOJI).toBe("✅");
});

test("a long preview is several parts that each fit with their marker and read back as the whole, and one that cannot fit is refused, not cut", async () => {
  const stage = await stageEffects(cluster);
  const frozen = await freeze(stage, { operationId: "op-long", preview: long() });
  const row = await state(stage, frozen.id);
  expect(row.effect_keys.length).toBeGreaterThan(3);
  const parts = await readEffects(stage.as("hub_hub"), row.effect_keys);
  for (const part of parts) {
    expect(part.wanted_content.length).toBeLessThanOrEqual(2000);
    expect(part.wanted_content.endsWith(`\`${part.marker}\``)).toBe(true);
  }
  const shown = parts.slice(0, -1).map(part => part.wanted_content.split("\n").slice(0, -1).join("\n")).join("\n");
  expect(shown.replace(/\s+/g, " ")).toBe(long().replace(/\s+/g, " "));
  expect(parts[parts.length - 1].wanted_content).toContain(`sha256:${frozen.hash}`);

  await expect(freeze(stage, { operationId: "op-big", confirmation: "x".repeat(2000) })).rejects.toBeInstanceOf(EffectTooLong);
  expect(Number((await stage.admin`select count(*)::int as n from confirmation where operation_id = 'op-big'`)[0].n)).toBe(0);
  await expect(freeze(stage, { operationId: "op-x", ownerSender: "" })).rejects.toThrow(/ownerSender/);
  await expect(freeze(stage, { operationId: "op-x", preview: " \u0000 " })).rejects.toThrow(/its text/);
  await expect(freeze(stage, { operationId: "op-x", payload: ["no"] })).rejects.toThrow(/object/);
});

test("freezing the same content again is the same preview, and a correction supersedes the old one before any of the new is posted, so the old text is never posted after it", async () => {
  const stage = await stageEffects(cluster);
  const one = await freeze(stage);
  const again = await freeze(stage);
  expect(again).toMatchObject({ id: one.id, created: false, revision: 1 });
  expect(await readOperation(stage.as("hub_hub"), "op-1")).toHaveLength(1);
  expect(Number((await stage.admin`select count(*)::int as n from platform_effect`)[0].n)).toBe(2);

  const two = await freeze(stage, { payload: { agent: "p1-alpha", task: "summarise the month" }, preview: PREVIEW.replace("week", "month") });
  expect(two).toMatchObject({ revision: 2, created: true, state: "pending" });
  const [old, fresh] = await readOperation(stage.as("hub_hub"), "op-1");
  expect([old.state, old.cause, fresh.state]).toEqual(["superseded", "superseded", "pending"]);
  // Both are in the ledger and neither is sent; the door then sends the newest and nothing of the old.
  const ctx = stage.context();
  await pass(ctx, stage.gate());
  const said = stage.fake.messagesIn(stage.channel).map(message => message.content);
  expect(said).toHaveLength(2);
  expect(said[0]).toContain("summarise the month");
  expect(said.join("\n")).not.toContain("summarise the week");

  // Correcting again after an approval changes nothing: the operation has been approved.
  const work: ConfirmationRow[] = [];
  const approving = stage.context({ hooks: hooks(work) });
  stage.fake.react(stage.channel, await lastOf(stage, two.id), CHECK, OWNER);
  await pollConfirmations(approving, stage.gate());
  expect(work).toHaveLength(1);
  // Asking for the very same content returns the approval. ANYTHING else about an approved operation is refused,
  // never answered with an approval the owner did not give for it: other content, another request line or owner,
  // person, door, chat or kind.
  const month = { payload: { agent: "p1-alpha", task: "summarise the month" }, preview: PREVIEW.replace("week", "month") };
  expect(await freeze(stage, month)).toMatchObject({ id: two.id, state: "approved", created: false });
  const changes: Partial<FreezeConfirmation>[] = [
    { payload: { agent: "p1-alpha", task: "something else" }, preview: "something else" },
    { ...month, payload: { agent: "p1-alpha", task: "summarise the month", extra: 1 } },
    { ...month, preview: `${month.preview}\nP.S.` },
    { ...month, confirmation: "React with 👍 to confirm." },
    { ...month, ownerSender: "200000000000000009" },
    { ...month, person: "p2" },
    { ...month, chat: "1000000009" },
    { ...month, door: "door-other" },
    { ...month, operationKind: "other.kind" },
  ];
  for (const changed of changes) {
    const refused = await freeze(stage, changed).catch(error => error);
    expect(refused, JSON.stringify(changed)).toBeInstanceOf(ConfirmationRefused);
    expect(refused.code).toBe("conflict");
    expect(refused.message).toMatch(/confirmation-conflict/);
  }
  expect(await readOperation(stage.as("hub_hub"), "op-1")).toHaveLength(2);
  expect(Number((await stage.admin`select count(*)::int as n from platform_effect`)[0].n)).toBe(4);
  // Not even an explicit replacement makes another preview of an approved operation.
  await expect(freeze(stage, { ...month, preview: "again", replace: { revision: 2 } })).rejects.toMatchObject({ code: "conflict" });
});

test("the payload is normalized once, to the form the store keeps, and that is what is hashed and stored: no Date, undefined or key order can make the two differ, and what JSON cannot hold is refused", async () => {
  const stage = await stageEffects(cluster);
  const when = new Date("2026-09-30T10:00:00.000Z");
  const messy = { when, gone: undefined, nested: { b: 2, a: [1, undefined, { z: undefined, y: 1 }] }, text: "x" };
  const plain = { text: "x", nested: { a: [1, null, { y: 1 }], b: 2 }, when: "2026-09-30T10:00:00.000Z" };
  expect(normalizePayload(messy)).toEqual(plain);
  const frozen = await freeze(stage, { operationId: "op-json", payload: messy });
  expect(frozen.hash).toBe(previewHash(KIND, plain, PREVIEW, ASK));
  const row = await state(stage, frozen.id);
  expect(row.payload).toEqual(plain);
  expect(row.payload_hash).toBe(previewHash(KIND, row.payload, PREVIEW, ASK));
  // The same value in another shape is the same binding: asking again is not a conflict and makes nothing.
  expect(await freeze(stage, { operationId: "op-json", payload: plain })).toMatchObject({ id: frozen.id, created: false });

  const cycle: Record<string, unknown> = { a: 1 };
  cycle.self = cycle;
  for (const payload of [cycle, { n: Number.NaN }, { n: Number.POSITIVE_INFINITY }, { n: 10n }] as unknown[]) {
    await expect(freeze(stage, { operationId: "op-bad", payload }), String(payload)).rejects.toBeInstanceOf(TypeError);
  }
  await expect(freeze(stage, { operationId: "op-bad", payload: [] })).rejects.toThrow(/object/);
  await expect(freeze(stage, { operationId: "op-bad", payload: null })).rejects.toThrow(/object/);
  expect(Number((await stage.admin`select count(*)::int as n from confirmation where operation_id = 'op-bad'`)[0].n)).toBe(0);
});

test("freezes of one operation made at the same moment end with exactly one pending preview, and the same content made three times is one preview", async () => {
  const stage = await stageEffects(cluster);
  const as = () => stage.fresh("hub_runner");
  const same = await Promise.all([1, 2, 3].map(() => freezeConfirmation(as(), {
    operationId: "op-race", operationKind: KIND, person: PERSON, door: DOOR, chat: stage.channel, ownerSender: OWNER,
    payload: { task: "same" }, preview: "same", confirmation: ASK,
  })));
  expect(new Set(same.map(one => one.id)).size).toBe(1);
  expect(same.filter(one => one.created)).toHaveLength(1);
  expect(await readOperation(stage.as("hub_hub"), "op-race")).toHaveLength(1);
  expect(Number((await stage.admin`select count(*)::int as n from platform_effect`)[0].n)).toBe(2);

  const different = await Promise.all(["one", "two", "three", "four"].map(word => freezeConfirmation(as(), {
    operationId: "op-race", operationKind: KIND, person: PERSON, door: DOOR, chat: stage.channel, ownerSender: OWNER,
    payload: { task: word }, preview: word, confirmation: ASK,
  })));
  const revisions = await readOperation(stage.as("hub_hub"), "op-race");
  expect(revisions.map(one => one.revision)).toEqual([1, 2, 3, 4, 5]);
  expect(revisions.filter(one => one.state === "pending")).toHaveLength(1);
  expect(revisions.filter(one => one.state === "superseded")).toHaveLength(4);
  expect(revisions[4].id).toBe(different.find(one => one.revision === 5)!.id);
});

test("the owner's green check approves once, in the same transaction as the work, and a repeat, a restart and a second door change nothing", async () => {
  const stage = await stageEffects(cluster);
  const work: ConfirmationRow[] = [];
  const frozen = await freeze(stage);
  const gate = stage.gate();
  await pass(stage.context(), gate);
  const last = await lastOf(stage, frozen.id);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(2);

  // Before the reaction: read to the end, nothing approved, and the freshness is recorded.
  const ctx = stage.context({ hooks: hooks(work) });
  expect(await pollConfirmations(ctx, gate)).toBe(stage.fake.now() + 1000);
  let row = await state(stage, frozen.id);
  expect([row.state, row.evidence.cause, row.observed_at?.getTime()]).toEqual(["pending", "awaiting-reaction", stage.fake.now()]);
  expect(work).toHaveLength(0);

  stage.fake.react(stage.channel, last, CHECK, OWNER);
  expect(await pollConfirmations(ctx, gate)).toBeNull();
  row = await state(stage, frozen.id);
  expect([row.state, row.approved_by, row.cause]).toEqual(["approved", OWNER, null]);
  expect(work).toHaveLength(1);
  expect(work[0]).toMatchObject({ id: frozen.id, revision: 1, payload_hash: frozen.hash, payload: { task: "summarise the week" } });
  expect(await inbox(stage)).toBe(1);

  // A repeat, a restart and a second door with its own connection: nothing more.
  await pollConfirmations(ctx, gate);
  await pollConfirmations(stage.context({ hooks: hooks(work), store: stage.fresh("hub_door") }), stage.gate());
  expect(work).toHaveLength(1);
  expect(await inbox(stage)).toBe(1);
  expect(Number((await stage.admin`select count(*)::int as n from confirmation where state = 'approved'`)[0].n)).toBe(1);
});

test("two doors polling the same preview at once approve it once and run its work once", async () => {
  const stage = await stageEffects(cluster);
  const work: ConfirmationRow[] = [];
  const frozen = await freeze(stage);
  await pass(stage.context(), stage.gate());
  stage.fake.react(stage.channel, await lastOf(stage, frozen.id), CHECK, OWNER);
  const doors = [stage.fresh("hub_door"), stage.fresh("hub_door"), stage.fresh("hub_door")];
  const owed = await readPending(stage.context({ hooks: hooks(work) }));
  await Promise.all(doors.map(store => pollConfirmations(stage.context({ hooks: hooks(work), store }), stage.gate(), owed)));
  expect(work).toHaveLength(1);
  expect(await inbox(stage)).toBe(1);
  expect((await state(stage, frozen.id)).state).toBe("approved");
});

test("nothing else approves: another person, a bot, another emoji, a reaction on another part, or a person the registry no longer allows", async () => {
  const stage = await stageEffects(cluster);
  const work: ConfirmationRow[] = [];
  const frozen = await freeze(stage, { preview: long() });
  const gate = stage.gate();
  await pass(stage.context(), gate);
  const row = await state(stage, frozen.id);
  const first = await messageOf(stage, row.effect_keys[0]);
  const last = await lastOf(stage, frozen.id);
  const ctx = stage.context({ hooks: hooks(work) });
  const pending = async (cause: string) => {
    await pollConfirmations(ctx, gate);
    const now = await state(stage, frozen.id);
    expect([now.state, now.evidence.cause]).toEqual(["pending", cause]);
    expect(work).toHaveLength(0);
  };

  stage.fake.react(stage.channel, last, CHECK, "200000000000000001");
  await pending("awaiting-reaction");
  stage.fake.react(stage.channel, last, CHECK, "200000000000000002", true);
  await pending("awaiting-reaction");
  stage.fake.react(stage.channel, last, "👍", OWNER);
  await pending("awaiting-reaction");
  // The owner's check on a part that is not the confirmation message is a check on the preview, not on the request.
  stage.fake.react(stage.channel, first, CHECK, OWNER);
  await pending("awaiting-reaction");

  // The owner's own id, but as a bot account: it is not the owner.
  const impostor = await stageEffects(cluster);
  const impostorWork: ConfirmationRow[] = [];
  const copy = await freeze(impostor);
  await pass(impostor.context(), impostor.gate());
  impostor.fake.react(impostor.channel, await lastOf(impostor, copy.id), CHECK, OWNER, true);
  await pollConfirmations(impostor.context({ hooks: hooks(impostorWork) }), impostor.gate());
  expect((await state(impostor, copy.id)).state).toBe("pending");
  expect(impostorWork).toHaveLength(0);

  // The registry is asked when the poll is made: the owner stops being allowed and the check no longer counts.
  stage.fake.react(stage.channel, last, CHECK, OWNER);
  let allowed = false;
  const registry = () => stage.registry(allowed ? [OWNER] : []);
  const asking = stage.context({ hooks: hooks(work), registry });
  const reading = reads(stage).length;
  await pollConfirmations(asking, gate);
  let now = await state(stage, frozen.id);
  expect([now.state, now.evidence.cause]).toEqual(["pending", "owner-not-allowed"]);
  expect(reads(stage)).toHaveLength(reading);
  const broken = stage.context({ hooks: hooks(work), registry: () => { throw new Error("half-written"); } });
  await pollConfirmations(broken, gate);
  expect((await state(stage, frozen.id)).evidence.cause).toBe("registry-unreadable");
  expect(work).toHaveLength(0);

  allowed = true;
  await pollConfirmations(asking, gate);
  now = await state(stage, frozen.id);
  expect([now.state, now.approved_by]).toEqual(["approved", OWNER]);
  expect(work).toHaveLength(1);
});

test("a preview that was edited or deleted fails for good and an old check cannot approve its correction", async () => {
  const stage = await stageEffects(cluster);
  const work: ConfirmationRow[] = [];
  const gate = stage.gate();
  const ctx = stage.context({ hooks: hooks(work) });

  const edited = await freeze(stage, { operationId: "op-edit", preview: long() });
  await pass(ctx, gate);
  const keys = (await state(stage, edited.id)).effect_keys;
  stage.fake.react(stage.channel, await lastOf(stage, edited.id), CHECK, OWNER);
  stage.fake.humanEdit(stage.channel, await messageOf(stage, keys[1]), "somebody changed the middle of it");
  await pollConfirmations(ctx, gate);
  let row = await state(stage, edited.id);
  expect([row.state, row.cause, row.evidence.part]).toEqual(["failed", "preview-changed", keys[1]]);
  expect(work).toHaveLength(0);
  // It stays failed. Asking again with the SAME content returns it, failure included, and makes no message; other
  // wording over it is refused, not resurrected; only an explicit replacement makes another preview.
  await pollConfirmations(ctx, gate);
  expect((await state(stage, edited.id)).state).toBe("failed");
  const shown = stage.fake.messagesIn(stage.channel).length;
  expect(await freeze(stage, { operationId: "op-edit", preview: long() })).toMatchObject({ id: edited.id, revision: 1, state: "failed", created: false });
  const worded = await freeze(stage, { operationId: "op-edit", preview: `${long()}\nand more` }).catch(error => error);
  expect(worded).toBeInstanceOf(ConfirmationRefused);
  expect(worded.code).toBe("replace-required");
  await pass(ctx, gate);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(shown);
  expect(await readOperation(stage.as("hub_hub"), "op-edit")).toHaveLength(1);

  // The explicit replacement names the revision the caller saw. It makes ONE new preview with its own messages
  // and its own reaction, the failed one stays as history, and the same request again is that same replacement.
  const again = await freeze(stage, { operationId: "op-edit", preview: long(), replace: { revision: 1 } });
  expect(again).toMatchObject({ revision: 2, created: true, state: "pending" });
  expect((await state(stage, again.id)).replaces).toBe(1);
  const repeated = await freeze(stage, { operationId: "op-edit", preview: long(), replace: { revision: 1 } });
  expect(repeated).toMatchObject({ id: again.id, revision: 2, created: false });
  const [was, now] = await readOperation(stage.as("hub_hub"), "op-edit");
  expect([was.state, was.cause, now.state, now.replaces]).toEqual(["failed", "preview-changed", "pending", 1]);
  expect(Number((await stage.admin`select count(*)::int as n from platform_effect where owner_ref = ${`confirmation:${again.id}`}`)[0].n)).toBeGreaterThan(1);
  // A request that saw an older revision than the standing one is stale and changes nothing, changed wording or not.
  await expect(freeze(stage, { operationId: "op-edit", preview: "other", replace: { revision: 1 } })).rejects.toMatchObject({ code: "stale-replacement" });
  await expect(freeze(stage, { operationId: "op-edit", preview: "other", replace: { revision: 5 } })).rejects.toMatchObject({ code: "stale-replacement" });
  await expect(freeze(stage, { operationId: "op-nothing", replace: { revision: 1 } })).rejects.toMatchObject({ code: "replace-unexpected" });
  expect(await readOperation(stage.as("hub_hub"), "op-edit")).toHaveLength(2);

  await pass(ctx, gate);
  expect(stage.fake.messagesIn(stage.channel).length).toBeGreaterThan(shown);
  await pollConfirmations(ctx, gate);
  expect(work).toHaveLength(0);
  expect((await state(stage, again.id)).evidence.cause).toBe("awaiting-reaction");
  // The old check cannot approve the replacement: it is on other messages.
  stage.fake.react(stage.channel, await lastOf(stage, edited.id), CHECK, OWNER);
  await pollConfirmations(ctx, gate);
  expect([(await state(stage, again.id)).state, work.length]).toEqual(["pending", 0]);
  stage.fake.react(stage.channel, await lastOf(stage, again.id), CHECK, OWNER);
  await pollConfirmations(ctx, gate);
  expect([(await state(stage, again.id)).state, work.length]).toEqual(["approved", 1]);
  // (the rest of this check is about previews that must not approve)
  work.length = 0;

  const gone = await freeze(stage, { operationId: "op-gone" });
  await pass(ctx, gate);
  stage.fake.react(stage.channel, await lastOf(stage, gone.id), CHECK, OWNER);
  stage.fake.deleteMessage(stage.channel, await messageOf(stage, (await state(stage, gone.id)).effect_keys[0]));
  await pollConfirmations(ctx, gate);
  row = await state(stage, gone.id);
  expect([row.state, row.cause]).toEqual(["failed", "preview-missing"]);
  expect(work).toHaveLength(0);

  // A message under our id that somebody else wrote is not our preview either: the id was reused, the author differs.
  const swapped = await freeze(stage, { operationId: "op-swap" });
  await pass(ctx, gate);
  const swapKeys = (await state(stage, swapped.id)).effect_keys;
  const ours = await messageOf(stage, swapKeys[0]);
  stage.fake.deleteMessage(stage.channel, ours);
  const impostor = stage.fake.say(stage.channel, (await readEffects(stage.as("hub_hub"), [swapKeys[0]]))[0].wanted_content, "200000000000000009");
  // The ledger still names the deleted one, which Discord now says is gone; nothing authored by anyone else stands in for it.
  expect(impostor).not.toBe(ours);
  stage.fake.react(stage.channel, await lastOf(stage, swapped.id), CHECK, OWNER);
  await pollConfirmations(ctx, gate);
  expect((await state(stage, swapped.id)).cause).toBe("preview-missing");
  expect(work).toHaveLength(0);
});

test("a preview whose parts did not all arrive never approves, whether one was refused, is unknown or is still waiting on a limit", async () => {
  const stage = await stageEffects(cluster);
  const work: ConfirmationRow[] = [];
  const gate = stage.gate();
  const ctx = stage.context({ hooks: hooks(work) });
  const post = new RegExp(`^POST /channels/${stage.channel}/messages$`);

  // The first part is refused: nothing after it is sent, so there is no confirmation message to react to,
  // and the preview is undeliverable.
  const refused = await freeze(stage, { operationId: "op-refused", preview: long() });
  stage.fake.script(post, { kind: "refuse", status: 403, code: 50013 });
  await pass(ctx, gate);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(0);
  expect(posts(stage)).toHaveLength(1);
  await pollConfirmations(ctx, gate);
  let row = await state(stage, refused.id);
  expect([row.state, row.cause]).toEqual(["failed", "preview-undeliverable"]);
  await pass(ctx, gate);
  await pass(ctx, gate, true);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(0);

  // The first part waits on a rate limit and holds the rest back: nothing is read, nothing is approved, and once
  // the parts are all there, in order, the owner's check counts.
  const waiting = await freeze(stage, { operationId: "op-limited", preview: long() });
  stage.fake.script(post, { kind: "rate_limit", retryAfter: 2 });
  await pass(ctx, gate);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(0);
  const before = reads(stage).length;
  await pollConfirmations(ctx, gate);
  row = await state(stage, waiting.id);
  expect([row.state, row.evidence.cause]).toEqual(["pending", "preview-not-delivered"]);
  expect(reads(stage)).toHaveLength(before);
  expect(work).toHaveLength(0);
  stage.fake.advance(2000);
  await pass(ctx, gate);
  stage.fake.react(stage.channel, await lastOf(stage, waiting.id), CHECK, OWNER);
  await pollConfirmations(ctx, gate);
  expect((await state(stage, waiting.id)).state).toBe("approved");
  expect(work.map(one => one.operation_id)).toEqual(["op-limited"]);

  // A part whose delivery is unknown is never a preview the owner saw.
  const unknown = await freeze(stage, { operationId: "op-unknown" });
  const keys = (await state(stage, unknown.id)).effect_keys;
  await stage.admin`update platform_effect set state = 'unknown', attempt_id = 'a', attempt_revision = 1, attempt_hash = 'h' where key = ${keys[0]}`;
  await pass(ctx, gate);
  await pollConfirmations(ctx, gate);
  row = await state(stage, unknown.id);
  expect([row.state, row.evidence.cause]).toEqual(["pending", "preview-delivery-unknown"]);
  expect(work).toHaveLength(1);

  // Asking again for the same content does NOT make a message for it: the standing preview comes back, still pending.
  const shown = stage.fake.messagesIn(stage.channel).length;
  expect(await freeze(stage, { operationId: "op-unknown" })).toMatchObject({ id: unknown.id, created: false, state: "pending" });
  await pass(ctx, gate);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(shown);
  expect(await readOperation(stage.as("hub_hub"), "op-unknown")).toHaveLength(1);
  // An owner who wants another preview asks for it, naming the revision that stands: one replacement with its own
  // messages, and the stuck one stays as history.
  const replacement = await freeze(stage, { operationId: "op-unknown", replace: { revision: 1 } });
  expect(replacement).toMatchObject({ revision: 2, created: true, state: "pending" });
  expect(await freeze(stage, { operationId: "op-unknown", replace: { revision: 1 } })).toMatchObject({ id: replacement.id, created: false });
  const [stuck, fresh] = await readOperation(stage.as("hub_hub"), "op-unknown");
  expect([stuck.state, stuck.cause, fresh.state, fresh.replaces]).toEqual(["superseded", "replaced", "pending", 1]);
  await pass(ctx, gate);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(shown + 2);
  // A pending preview that is not stuck is not replaced by asking for a replacement of the same content.
  expect(await freeze(stage, { operationId: "op-unknown", replace: { revision: 2 } })).toMatchObject({ id: replacement.id, created: false });
  expect(await readOperation(stage.as("hub_hub"), "op-unknown")).toHaveLength(2);

  // A poll for another door reads nothing of this door's.
  const other = stage.context({ hooks: hooks(work), door: "door-other" });
  expect(await readPending(other)).toHaveLength(0);
  expect(await readPending(stage.context())).toHaveLength(1);
});

test("the parts of a long preview appear in order with the confirmation message last, even past nine parts and across a rate limit in the middle", async () => {
  const stage = await stageEffects(cluster);
  const gate = stage.gate();
  const ctx = stage.context();
  const text = Array.from({ length: 600 }, (_, at) => `line ${at}: ${"word ".repeat(10).trim()}`).join("\n");
  const frozen = await freeze(stage, { operationId: "op-order", preview: text });
  const keys = (await state(stage, frozen.id)).effect_keys;
  expect(keys.length).toBeGreaterThan(12);
  expect([...keys].sort()).toEqual(keys);

  // The third post is rate limited: the parts after it wait, and the ones before it are already there.
  const post = new RegExp(`^POST /channels/${stage.channel}/messages$`);
  stage.fake.script(post, { kind: "rate_limit", retryAfter: 2 }, { skip: 2 });
  const next = await pass(ctx, gate);
  expect(next).toBe(stage.fake.now() + 2000);
  expect(stage.fake.messagesIn(stage.channel)).toHaveLength(2);
  expect(posts(stage)).toHaveLength(3);
  expect((await effectRow(stage, keys[3])).attempts).toBe(0);

  stage.fake.advance(2000);
  await pass(ctx, gate);
  const shown = stage.fake.messagesIn(stage.channel).map(message => message.content.split("\n").at(-1));
  expect(shown).toEqual(keys.map(key => `\`${effectMarker(key)}\``));
  expect(stage.fake.messagesIn(stage.channel).at(-1)!.content).toContain(`sha256:${frozen.hash}`);
});

test("through the door's task: a preview part that was unknown and is found at start lets the parts after it go out by themselves, in order, and until it is found none goes", async () => {
  const stage = await stageEffects(cluster);
  const gate = stage.gate();
  const ctx = stage.context();
  const frozen = await freeze(stage, { operationId: "op-adopt", preview: long() });
  const keys = (await state(stage, frozen.id)).effect_keys;
  expect(keys.length).toBeGreaterThan(2);

  // The first part is sent and its answer never comes: its request is still on the way. The looks find nothing
  // and it is unknown, which keeps every part after it out of what the door reads.
  stage.fake.script(new RegExp(`^POST /channels/${stage.channel}/messages$`), { kind: "drop", late: true });
  await pass(ctx, gate);
  for (let look = 1; look <= 5; look += 1) {
    stage.fake.advance(31_000);
    await pass(ctx, gate);
  }
  expect((await effectRow(stage, keys[0])).state).toBe("unknown");
  expect(stage.fake.inTransit()).toBe(1);
  expect(posts(stage)).toHaveLength(1);

  const start = () => startEffects({
    store: { ...stage.as("hub_door"), close: async () => {} } as never,
    platform: stage.platform(), door: DOOR, hooks: hooks([]), registry: () => stage.registry([OWNER]), tickMs: 60_000,
    settings: () => ({ retrySeconds: 30, maxAttempts: 5 }),
    gate: read => read(),
  });

  // Nothing has landed: the start looks again, finds nothing, and no later part is sent.
  let task = start();
  try {
    await task.ready;
    await until("the start looked for the unknown part again", async () => (await effectRow(stage, keys[0])).evidence.rechecked !== undefined, 10_000);
    await Bun.sleep(400);
    expect(posts(stage)).toHaveLength(1);
    expect(stage.fake.messagesIn(stage.channel)).toHaveLength(0);
    for (const key of keys.slice(1)) expect([(await effectRow(stage, key)).state, (await effectRow(stage, key)).attempts]).toEqual(["not_sent", 0]);
  } finally {
    await task.stop();
  }

  // It lands. The start adopts it, and the parts after it follow with no ask, no wake and no second pass.
  expect(stage.fake.land()).toBe(1);
  task = start();
  try {
    await task.ready;
    await until("every part after the adopted one was delivered", () => stage.fake.messagesIn(stage.channel).length === keys.length, 10_000,
      async () => JSON.stringify(await Promise.all(keys.map(async key => (await effectRow(stage, key)).state))));
    const shown = stage.fake.messagesIn(stage.channel).map(message => message.content.split("\n").at(-1));
    expect(shown).toEqual(keys.map(key => `\`${effectMarker(key)}\``));
    expect((await effectRow(stage, keys[0])).evidence.confirmed).toMatchObject({ by: "readback" });
    // The adopted part was not sent again.
    expect(posts(stage)).toHaveLength(keys.length);
  } finally {
    await task.stop();
  }
});

test("the reactors are read to the end, page by page: the owner is found on either side of the page boundary, and is not there when nobody is", async () => {
  for (const reactorOrder of ["ascending", "descending"] as const) {
    for (const position of [1, 99, 100, 101, 130, 0]) {
      const stage = await stageEffects(cluster, { reactorOrder });
      const work: ConfirmationRow[] = [];
      const frozen = await freeze(stage);
      await pass(stage.context(), stage.gate());
      const last = await lastOf(stage, frozen.id);
      // 130 reactors: `position` is the owner's place among them by id, or 0 for the owner not being one.
      const below = position === 0 ? 65 : position - 1;
      const above = position === 0 ? 65 : 130 - position;
      const ids: string[] = [];
      for (let at = 1; at <= below; at += 1) ids.push(String(BigInt(OWNER) - BigInt(at)));
      for (let at = 1; at <= above; at += 1) ids.push(String(BigInt(OWNER) + BigInt(at)));
      if (position !== 0) ids.push(OWNER);
      for (const id of ids) stage.fake.react(stage.channel, last, CHECK, id);
      await pollConfirmations(stage.context({ hooks: hooks(work) }), stage.gate());
      const asked = reads(stage);
      const row = await state(stage, frozen.id);
      const label = `${reactorOrder} at ${position}`;
      if (position === 0) {
        expect([row.state, row.evidence.cause, row.evidence.reactors, asked.length], label).toEqual(["pending", "awaiting-reaction", 130, 2]);
      } else {
        expect([row.state, work.length, asked.length], label).toEqual(["approved", 1, position <= 100 ? 1 : 2]);
      }
      expect(asked[0].query, label).toEqual({ limit: "100" });
      if (asked.length === 2) {
        // The second page continues from the greatest user id of the first, whichever order a page comes in.
        const sorted = [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
        expect(asked[1].query, label).toEqual({ limit: "100", after: sorted[99] });
      }
      await closeStages();
    }
  }
  // Exactly two full pages, and the empty one after them that says it is the end.
  const stage = await stageEffects(cluster);
  const frozen = await freeze(stage);
  await pass(stage.context(), stage.gate());
  const last = await lastOf(stage, frozen.id);
  for (let at = 1; at <= 200; at += 1) stage.fake.react(stage.channel, last, CHECK, String(BigInt(OWNER) + BigInt(at)));
  await pollConfirmations(stage.context({ hooks: hooks([]) }), stage.gate());
  expect(reads(stage)).toHaveLength(3);
  expect((await state(stage, frozen.id)).evidence).toMatchObject({ cause: "awaiting-reaction", reactors: 200 });
});

test("a limit, a refusal or an outage on a read leaves the preview pending with its last successful look untouched, and waits exactly what Discord said", async () => {
  const stage = await stageEffects(cluster);
  const work: ConfirmationRow[] = [];
  const frozen = await freeze(stage);
  const gate = stage.gate();
  await pass(stage.context(), gate);
  const last = await lastOf(stage, frozen.id);
  const ctx = stage.context({ hooks: hooks(work) });
  const react = new RegExp(`^GET /channels/${stage.channel}/messages/\\d+/reactions/`);

  await pollConfirmations(ctx, gate);
  const looked = (await state(stage, frozen.id)).observed_at!.getTime();
  stage.fake.react(stage.channel, last, CHECK, OWNER);

  stage.fake.advance(1000);
  stage.fake.script(react, { kind: "rate_limit", retryAfter: 3 });
  expect(await pollConfirmations(ctx, gate)).toBe(stage.fake.now() + 3000);
  let row = await state(stage, frozen.id);
  expect([row.state, row.evidence.cause, row.evidence.retry_after_ms, row.observed_at!.getTime()]).toEqual(["pending", "rate-limited", 3000, looked]);

  // A global limit holds every request of the door, previews included, until it is over.
  stage.fake.advance(3000);
  stage.fake.script(react, { kind: "rate_limit", retryAfter: 5, global: true });
  expect(await pollConfirmations(ctx, gate)).toBe(stage.fake.now() + 5000);
  expect(gate.notBefore).toBe(stage.fake.now() + 5000);
  const count = stage.fake.requests().length;
  expect(await pollConfirmations(ctx, gate)).toBe(gate.notBefore);
  expect(stage.fake.requests().length).toBe(count);

  // A refusal and a server error and a dropped connection: not approval and not failure.
  stage.fake.advance(5000);
  const outages: [Fault, Record<string, unknown>][] = [
    [{ kind: "refuse", status: 403, code: 50001 }, { status: 403, discord_code: 50001 }],
    [{ kind: "server_error", status: 503 }, { status: 503 }],
    [{ kind: "drop" }, {}],
  ];
  for (const [fault, expected] of outages) {
    stage.fake.script(react, fault);
    expect(await pollConfirmations(ctx, gate)).toBe(stage.fake.now() + 1000);
    row = await state(stage, frozen.id);
    expect([row.state, row.evidence.cause, row.observed_at!.getTime()], JSON.stringify(fault)).toEqual(["pending", "read-failed", looked]);
    expect(row.evidence.failure).toMatchObject(expected);
  }
  // A preview read that fails is the same.
  stage.fake.script(new RegExp(`^GET /channels/${stage.channel}/messages/\\d+$`), { kind: "server_error" });
  await pollConfirmations(ctx, gate);
  expect((await state(stage, frozen.id)).evidence.cause).toBe("read-failed");
  expect(work).toHaveLength(0);

  // And when it clears, the check that was there all along counts.
  await pollConfirmations(ctx, gate);
  row = await state(stage, frozen.id);
  expect([row.state, work.length]).toEqual(["approved", 1]);
});

test("the current reaction is what counts: one made while the poll was down is approved on the next look, and one added and taken away between looks was never seen", async () => {
  const stage = await stageEffects(cluster);
  const work: ConfirmationRow[] = [];
  const frozen = await freeze(stage);
  const gate = stage.gate();
  await pass(stage.context(), gate);
  const last = await lastOf(stage, frozen.id);
  await pollConfirmations(stage.context({ hooks: hooks(work) }), gate);

  stage.fake.react(stage.channel, last, CHECK, OWNER);
  stage.fake.unreact(stage.channel, last, CHECK, OWNER);
  await pollConfirmations(stage.context({ hooks: hooks(work) }), gate);
  expect([(await state(stage, frozen.id)).state, work.length]).toEqual(["pending", 0]);

  // Down for a day; the owner reacted meanwhile; a new process, with nothing in memory, reads it and approves.
  stage.fake.advance(86_400_000);
  stage.fake.react(stage.channel, last, CHECK, OWNER);
  await pollConfirmations(stage.context({ hooks: hooks(work), store: stage.fresh("hub_door") }), stage.gate());
  expect([(await state(stage, frozen.id)).state, work.length]).toEqual(["approved", 1]);
});

test("with nothing to act on an approval, or no way to read the chat, the preview stays pending and says so, and nothing is read", async () => {
  const stage = await stageEffects(cluster);
  const gate = stage.gate();
  const frozen = await freeze(stage);
  await pass(stage.context(), gate);
  const last = await lastOf(stage, frozen.id);
  stage.fake.react(stage.channel, last, CHECK, OWNER);

  const before = stage.fake.requests().length;
  const bare = stage.context();
  expect(await pollConfirmations(bare, gate)).toBeNull();
  expect(await pollConfirmations(bare, gate)).toBeNull();
  const row = await state(stage, frozen.id);
  expect([row.state, row.evidence.cause]).toEqual(["pending", "hook-unavailable"]);
  expect(stage.fake.requests().length).toBe(before);

  // Another kind's hook is not this kind's.
  await pollConfirmations(stage.context({ hooks: { "other.kind": async () => {} } }), gate);
  expect((await state(stage, frozen.id)).state).toBe("pending");

  // The door that does own it approves the same preview, once.
  const work: ConfirmationRow[] = [];
  await pollConfirmations(stage.context({ hooks: hooks(work) }), gate);
  expect([(await state(stage, frozen.id)).state, work.length]).toEqual(["approved", 1]);

  // A kind is looked up as its own name only: nothing inherited by an object answers for it.
  const inherited = await freeze(stage, { operationId: "op-inherited", operationKind: "constructor" });
  await pass(stage.context(), gate);
  stage.fake.react(stage.channel, await lastOf(stage, inherited.id), CHECK, OWNER);
  await pollConfirmations(stage.context({ hooks: hooks(work) }), gate);
  expect([(await state(stage, inherited.id)).state, (await state(stage, inherited.id)).evidence.cause]).toEqual(["pending", "hook-unavailable"]);
  expect(work).toHaveLength(1);

  // A platform that cannot be read back can send a preview and can never approve one.
  const fake = createFakePlatform({ name: "telegram" });
  const plain = await freeze(stage, { operationId: "op-plain" });
  await pass(stage.context({ platform: fake.platform as never }), gate);
  await pollConfirmations(stage.context({ platform: fake.platform as never, hooks: hooks(work) }), gate);
  expect((await state(stage, plain.id)).evidence.cause).toBe("readback-unsupported");
  expect(work).toHaveLength(1);
});

test("an approval and its work are one transaction with nothing external inside it: a hook that fails takes the approval with it, and the work exists only once the approval does", async () => {
  const stage = await stageEffects(cluster);
  const gate = stage.gate();
  const frozen = await freeze(stage);
  await pass(stage.context(), gate);
  stage.fake.react(stage.channel, await lastOf(stage, frozen.id), CHECK, OWNER);

  // The work is written, then the hook fails: neither survives, and the preview is still pending.
  const failing: ApprovalHooks = {
    [KIND]: async (tx, approval) => {
      await enqueueInbound(tx, { id: `synthetic:${approval.operation_id}`, person: PERSON, agent: "p1-lair", body: "half" });
      throw new Error("the work could not be recorded");
    },
  };
  const next = await pollConfirmations(stage.context({ hooks: failing }), gate);
  let row = await state(stage, frozen.id);
  expect([row.state, row.approved_by, row.evidence.cause]).toEqual(["pending", null, "hook-failed"]);
  expect(row.evidence.error).toContain("could not be recorded");
  expect(next).toBe(stage.fake.now() + 1000);
  expect(await inbox(stage)).toBe(0);

  // Inside the working hook another connection sees neither the approval nor the work, and the platform is not asked anything.
  const seen: unknown[] = [];
  let requests = 0;
  const platform = stage.platform(() => { requests += 1; });
  const during = stage.fresh("hub_hub");
  const observing: ApprovalHooks = {
    [KIND]: async (tx, approval) => {
      const asked = requests;
      await enqueueInbound(tx, { id: `synthetic:${approval.operation_id}`, person: PERSON, agent: "p1-lair", body: "whole" });
      seen.push((await during.sql`select state from confirmation where id = ${approval.id}`)[0].state);
      seen.push(Number((await stage.admin`select count(*)::int as n from inbound where id like 'synthetic:%'`)[0].n));
      seen.push(requests - asked);
    },
  };
  await pollConfirmations(stage.context({ hooks: observing, platform }), gate);
  expect(seen).toEqual(["pending", 0, 0]);
  row = await state(stage, frozen.id);
  expect([row.state, row.approved_by, await inbox(stage)]).toEqual(["approved", OWNER, 1]);
});

test("a stale look cannot approve: a poll that read a preview before its correction wins nothing and runs nothing", async () => {
  const stage = await stageEffects(cluster);
  const work: ConfirmationRow[] = [];
  const gate = stage.gate();
  const old = await freeze(stage);
  await pass(stage.context(), gate);
  stage.fake.react(stage.channel, await lastOf(stage, old.id), CHECK, OWNER);
  const stale = await readPending(stage.context());
  expect(stale.map(row => row.id)).toEqual([old.id]);

  // The correction lands between the poll's read of the pending previews and its approval.
  await freeze(stage, { payload: { agent: "p1-alpha", task: "corrected" }, preview: "corrected" });
  await pollConfirmations(stage.context({ hooks: hooks(work) }), gate, stale);
  expect(work).toHaveLength(0);
  expect((await state(stage, old.id)).state).toBe("superseded");
  expect(await inbox(stage)).toBe(0);
  expect(Number((await stage.admin`select count(*)::int as n from confirmation where state = 'approved'`)[0].n)).toBe(0);
});

test("the approval record is the door's alone, its fields are fixed, and every state but pending is final", async () => {
  const stage = await stageEffects(cluster);
  const frozen = await freeze(stage);
  const runner = stage.as("hub_runner").sql;
  const door = stage.as("hub_door").sql;
  const agent = stage.as("hub_agent").sql;
  await expect(runner`update confirmation set state = 'approved', approved_by = ${OWNER}, approved_at = now() where id = ${frozen.id}`.execute()).rejects.toThrow();
  await expect(agent`select * from confirmation`.execute()).rejects.toThrow();
  await expect(agent`select hub_confirmation_freeze('x', 'o', 'k', 'p', 'd', 'c', 'w', '{}'::jsonb, 'h', '{"parts":[]}'::jsonb, null::integer)`.execute()).rejects.toThrow(/permission denied/);
  await expect(runner`insert into confirmation (id, operation_id, operation_kind, revision, person, door, chat, owner_sender, payload, payload_hash, effect_keys)
    values ('x', 'o', 'k', 1, 'p', 'd', 'c', 'w', '{}', 'h', '{a}')`.execute()).rejects.toThrow();
  await expect(door`insert into confirmation (id, operation_id, operation_kind, revision, person, door, chat, owner_sender, payload, payload_hash, effect_keys)
    values ('x', 'o', 'k', 1, 'p', 'd', 'c', 'w', '{}', 'h', '{a}')`.execute()).rejects.toThrow();
  for (const column of ["payload_hash", "owner_sender", "payload", "effect_keys", "door", "chat", "revision", "operation_id"]) {
    await expect(door.unsafe(`update confirmation set ${column} = ${column} where id = '${frozen.id}'`).execute(), column).rejects.toThrow();
  }
  // Approved by anybody but the owner the preview named is refused by the table itself.
  await expect(door`update confirmation set state = 'approved', approved_by = '200000000000000009', approved_at = now() where id = ${frozen.id}`.execute()).rejects.toThrow();
  await expect(door`update confirmation set state = 'approved' where id = ${frozen.id}`.execute()).rejects.toThrow();
  await door`update confirmation set state = 'approved', approved_by = ${OWNER}, approved_at = now() where id = ${frozen.id}`;
  await expect(door`update confirmation set state = 'failed', cause = 'x' where id = ${frozen.id}`.execute()).rejects.toThrow(/stays so/);
  await expect(door`update confirmation set state = 'pending' where id = ${frozen.id}`.execute()).rejects.toThrow(/stays so/);
  // One approval per operation, whatever the revision.
  await expect(stage.admin`insert into confirmation (id, operation_id, operation_kind, revision, person, door, chat, owner_sender, payload, payload_hash, effect_keys, state, approved_by, approved_at)
    values ('second', 'op-1', ${KIND}, 2, ${PERSON}, ${DOOR}, 'c', ${OWNER}, '{}', 'h', '{a}', 'approved', ${OWNER}, now())`.execute()).rejects.toThrow();
  // And a preview is only approved when every part is delivered as frozen, by the approving statement itself.
  const other = await freeze(stage, { operationId: "op-2" });
  const keys = (await state(stage, other.id)).effect_keys;
  expect(keys).toHaveLength(2);
  const won = await stage.as("hub_door").sql`update confirmation set state = 'approved', approved_by = owner_sender, approved_at = now()
    where id = ${other.id} and state = 'pending'
      and not exists (select 1 from platform_effect e where e.key = any(confirmation.effect_keys)
                       and not (e.state = 'confirmed' and e.applied_revision = e.wanted_revision))
    returning id`;
  expect(won).toHaveLength(0);
});

test("a correction that commits between the door's read and its claim stops the old part: the claim itself checks that the preview still stands, and a request already under way is not undone", async () => {
  const stage = await stageEffects(cluster);
  const gate = stage.gate();
  const ctx = stage.context();
  const old = await freeze(stage, { operationId: "op-race", preview: long() });
  const oldKeys = (await state(stage, old.id)).effect_keys;
  expect(oldKeys.length).toBeGreaterThan(3);

  // The door has read what is owed: every part of the old preview, all standing at this moment.
  const owed = await readEffectWork(ctx);
  expect(owed.rows.map(row => row.key)).toEqual(oldKeys);
  // The correction commits between that read and the claims.
  const corrected = await freeze(stage, { operationId: "op-race", payload: { agent: "p1-alpha", task: "corrected" }, preview: "corrected" });
  expect(corrected).toMatchObject({ revision: 2, created: true });
  await runEffectWork(ctx, gate, owed);
  expect(posts(stage)).toHaveLength(0);
  for (const key of oldKeys) expect([(await effectRow(stage, key)).state, (await effectRow(stage, key)).attempts]).toEqual(["not_sent", 0]);
  // What is sent afterwards is the correction and nothing of the old text.
  await pass(ctx, gate);
  const said = stage.fake.messagesIn(stage.channel).map(message => message.content);
  expect(said).toHaveLength(2);
  expect(said[0]).toContain("corrected");
  expect(said.join("\n")).not.toContain("line 0:");

  // A request that was already claimed is under way and is not undone; nothing after it is claimed.
  const under = await freeze(stage, { operationId: "op-under-way", preview: long() });
  const underKeys = (await state(stage, under.id)).effect_keys;
  let superseded = false;
  const busy = stage.context({
    platform: stage.platform(async (method, url) => {
      if (method !== "POST" || !url.pathname.endsWith("/messages") || superseded) return;
      superseded = true;
      await freeze(stage, { operationId: "op-under-way", payload: { agent: "p1-alpha", task: "corrected again" }, preview: "corrected again" });
    }),
  });
  const before = posts(stage).length;
  await runEffectWork(busy, gate, await readEffectWork(busy));
  expect(posts(stage)).toHaveLength(before + 1);
  expect((await effectRow(stage, underKeys[0])).state).toBe("confirmed");
  expect(stage.fake.messagesIn(stage.channel).at(-1)!.content).toContain("line 0:");
  for (const key of underKeys.slice(1)) expect([(await effectRow(stage, key)).state, (await effectRow(stage, key)).attempts]).toEqual(["not_sent", 0]);
  expect((await state(stage, under.id)).state).toBe("superseded");
  await pass(busy, gate);
  expect(posts(stage)).toHaveLength(before + 3);
  for (const key of underKeys.slice(1)) expect((await effectRow(stage, key)).state).toBe("not_sent");
});

test("a preview is not read again before it is due, whatever else wakes the door, and a limit the platform seam knows of holds its reads even when it is due", async () => {
  const stage = await stageEffects(cluster);
  const gate = stage.gate();
  const platform = stage.platform();
  const ctx = stage.context({ platform, hooks: hooks([]) });
  const frozen = await freeze(stage);
  await pass(ctx, gate);
  const schedule: PollSchedule = new Map();

  const first = await pollConfirmations(ctx, gate, undefined, schedule);
  expect(first).toBe(stage.fake.now() + 1000);
  const asked = stage.fake.requests().length;
  // Wakes for other reasons, before it is due: each says when it IS due, and none reads anything.
  for (let wake = 0; wake < 5; wake += 1) expect(await pollConfirmations(ctx, gate, undefined, schedule)).toBe(first);
  stage.fake.advance(999);
  expect(await pollConfirmations(ctx, gate, undefined, schedule)).toBe(first);
  expect(stage.fake.requests().length).toBe(asked);
  // Due: it is read.
  stage.fake.advance(1);
  await pollConfirmations(ctx, gate, undefined, schedule);
  expect(stage.fake.requests().length).toBeGreaterThan(asked);
  // A caller that paces itself passes no schedule and reads every preview it hands over.
  const before = stage.fake.requests().length;
  await pollConfirmations(ctx, gate);
  expect(stage.fake.requests().length).toBeGreaterThan(before);

  // A limit learned by ANY request of the platform holds the reads: the schedule says due, the seam says wait.
  const [preview] = await readEffects(stage.as("hub_hub"), (await state(stage, frozen.id)).effect_keys);
  stage.fake.script(new RegExp(`^GET /channels/${stage.channel}/messages/\\d+$`), { kind: "rate_limit", retryAfter: 4 });
  await expect(platform.readback!.getMessage({ chat: stage.channel, id: preview.platform_id! })).rejects.toMatchObject({ status: 429, retryAfterMs: 4000 });
  const limitedAt = stage.fake.now();
  stage.fake.advance(1000);
  const held = stage.fake.requests().length;
  expect(await pollConfirmations(ctx, gate, undefined, schedule)).toBe(limitedAt + 4000);
  expect(await pollConfirmations(ctx, gate)).toBe(limitedAt + 4000);
  expect(stage.fake.requests().length).toBe(held);
  stage.fake.advance(3000);
  await pollConfirmations(ctx, gate);
  expect(stage.fake.requests().length).toBeGreaterThan(held);
});

test("the door's task reads a pending preview once per tick, not once per wake: notifications for other things leave it alone until it is due", async () => {
  const stage = await stageEffects(cluster);
  await freeze(stage);
  await pass(stage.context(), stage.gate());
  const task = startEffects({
    store: { ...stage.as("hub_door"), close: async () => {} } as never,
    platform: stage.platform(), door: DOOR, hooks: hooks([]), registry: () => stage.registry([OWNER]), tickMs: 60_000,
    settings: () => ({ retrySeconds: 30, maxAttempts: 5 }),
    gate: read => read(),
  });
  try {
    await task.ready;
    await until("the preview was read once at connect", () => reads(stage).length === 1, 10_000);
    for (let wake = 0; wake < 5; wake += 1) {
      task.wake();
      await Bun.sleep(60);
    }
    // Another effect asked for on the same door is delivered on its wake, and the preview is still left alone.
    await wantEffect(stage.as("hub_runner"), { key: "other:effect", door: DOOR, chat: stage.channel, owner: "o", text: "another line" });
    task.wake();
    await until("the other effect was delivered", () => posts(stage).length === 3, 10_000);
    expect(reads(stage)).toHaveLength(1);
  } finally {
    await task.stop();
  }
});

// --- a synthetic consumer, through a real door ---------------------------------------------

/** A real door over the real Discord seam and the fake Discord, on a database of its own. */
async function stageDoor(options: { retrySeconds?: number } = {}) {
  const fake = createFakeDiscord({ start: Date.now() });
  const channel = fake.addChannel({ name: "chat" });
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1 },
    people: [{ id: PERSON, allowed_senders: { [DOOR]: [OWNER] } } as never],
    registry: base => ({ ...base, agents: (base.agents ?? []).map(one => ({ ...one, chat: channel })) }),
  });
  const dir = mkdtempSync(join(tmpdir(), "hub-door-effects-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "placeholder-token\n", "utf8");
  await Bun.write(it.registryFile, `${await Bun.file(it.registryFile).text()}\n[door]\ndelivery_retry_seconds = ${options.retrySeconds ?? 1}\ndelivery_max_attempts = 3\n`);
  // The wall time at which each 429 left the fake: the moment a limit was actually told to the door.
  const limited: number[] = [];
  const answering = (async (...asked: Parameters<typeof fetch>) => {
    const answer = await fake.fetch(...asked);
    if (answer.status === 429) limited.push(Date.now());
    return answer;
  }) as unknown as typeof fetch;
  const platform = discord({ tokenFile, guild: fake.guild, fetch: answering });
  const runner = { sql: cluster.connectAs("hub_runner", it.db), url: storeUrlAs(cluster.url(it.db), "hub_runner") };
  const work: ConfirmationRow[] = [];
  const start = () => runDoor({ door: DOOR, registryFile: it.registryFile, platform, approvals: hooks(work) });
  const stop = async () => {
    await runner.sql.close().catch(() => {});
    await it.stop();
    rmSync(dir, { recursive: true, force: true });
  };
  return { it, fake, channel, runner, work, start, stop, tokenFile, limited };
}

test("a synthetic consumer end to end: the runner asks for a status line and a preview, the real door delivers both on the store's own notification, and the owner's check approves once across a restart", async () => {
  const s = await stageDoor();
  let door = await s.start();
  try {
    // Asked for by the role a tool handler runs as; delivered by the door with no poll of its own.
    await wantEffect(s.runner, { key: "consumer:status", door: DOOR, chat: s.channel, owner: "consumer:1", text: "Working: 0 of 2 done" });
    const frozen = await freezeConfirmation(s.runner, {
      operationId: "consumer:op", operationKind: KIND, person: PERSON, door: DOOR, chat: s.channel, ownerSender: OWNER,
      payload: { agent: "p1-lair", task: "compare the two vendors" }, preview: "Chat: alpha\nRequest:\ncompare the two vendors", confirmation: ASK,
    });
    await until("the door delivered the status line and both parts of the preview", () => s.fake.messagesIn(s.channel).length === 3, 20_000,
      () => JSON.stringify(s.fake.messagesIn(s.channel).map(m => m.content)));
    const status = (await effectRow2(s, "consumer:status")).platform_id as string;
    expect(s.fake.messagesIn(s.channel).map(m => m.id)).toContain(status);

    // The status is edited as it changes, and nothing else is posted.
    await wantEffect(s.runner, { key: "consumer:status", door: DOOR, chat: s.channel, owner: "consumer:1", text: "Working: 1 of 2 done" });
    await until("the status line was edited in place", () => s.fake.messagesIn(s.channel).some(m => m.id === status && m.content.startsWith("Working: 1 of 2")), 20_000);
    expect(s.fake.messagesIn(s.channel)).toHaveLength(3);

    // Nobody has reacted: pending, and the door has looked at least once.
    await until("the door looked at the preview", async () => (await confirmation(s, frozen.id)).evidence?.cause === "awaiting-reaction", 20_000);
    expect(s.work).toHaveLength(0);

    // The owner reacts. The door is restarted before the next look; the new door approves it.
    const messages = s.fake.messagesIn(s.channel);
    const confirmationMessage = messages.find(m => m.content.includes(`sha256:${frozen.hash}`))!;
    s.fake.react(s.channel, confirmationMessage.id, CHECK, OWNER);
    await door.stop();
    door = await s.start();
    await until("the restarted door approved the preview", async () => (await confirmation(s, frozen.id)).state === "approved", 20_000,
      async () => JSON.stringify(await confirmation(s, frozen.id)));
    expect(s.work).toHaveLength(1);
    expect(s.work[0].payload).toEqual({ agent: "p1-lair", task: "compare the two vendors" });
    expect((await s.it.read.inbound()).filter(row => row.id === "synthetic:consumer:op")).toHaveLength(1);

    // A further restart and a further wait change nothing: one approval, one unit of work, no new post.
    await door.stop();
    door = await s.start();
    await Bun.sleep(1500);
    expect(s.work).toHaveLength(1);
    expect((await s.it.read.inbound()).filter(row => row.id === "synthetic:consumer:op")).toHaveLength(1);
    expect(s.fake.messagesIn(s.channel)).toHaveLength(3);
    expect(s.fake.requestsTo(new RegExp(`^POST /channels/${s.channel}/messages$`))).toHaveLength(3);
  } finally {
    await door.stop();
    await s.stop();
  }
});

test("a synthetic consumer across a crash between the post and the saved id: the restarted door finds the message it made, edits it, and there is one status line", async () => {
  const s = await stageDoor();
  const post = new RegExp(`^POST /channels/${s.channel}/messages$`);
  let door = await s.start();
  try {
    s.fake.script(post, { kind: "drop", afterEffect: true });
    await wantEffect(s.runner, { key: "consumer:status", door: DOOR, chat: s.channel, owner: "consumer:1", text: "Working: 0 of 2 done" });
    await until("the post landed and the answer was lost", async () => s.fake.messagesIn(s.channel).length === 1
      && (await effectRow2(s, "consumer:status")).state === "in_flight", 20_000);
    // The door dies with the id unsaved, and a new one starts.
    await door.stop();
    door = await s.start();
    await until("the restarted door adopted the message it made", async () => (await effectRow2(s, "consumer:status")).state === "confirmed", 30_000,
      async () => JSON.stringify(await effectRow2(s, "consumer:status")));
    const row = await effectRow2(s, "consumer:status");
    expect(row.platform_id).toBe(s.fake.messagesIn(s.channel)[0].id);
    expect(row.evidence.confirmed.by).toBe("readback");
    await wantEffect(s.runner, { key: "consumer:status", door: DOOR, chat: s.channel, owner: "consumer:1", text: "Working: 2 of 2 done" });
    await until("the same message was edited", () => s.fake.messagesIn(s.channel).some(m => m.content.startsWith("Working: 2 of 2")), 20_000);
    expect(s.fake.messagesIn(s.channel)).toHaveLength(1);
    expect(s.fake.requestsTo(post)).toHaveLength(1);
  } finally {
    await door.stop();
    await s.stop();
  }
});

test("through a real door: an account-wide limit the ordinary reply met holds the effect task too, the reply's retry waits as long as Discord said, and both go once it is over", async () => {
  const s = await stageDoor();
  const post = new RegExp(`^POST /channels/${s.channel}/messages$`);
  const inbound = cluster.connectAs("hub_door", s.it.db) as unknown as { unsafe(query: string): Promise<unknown>; close(): Promise<void> };
  let door: Awaited<ReturnType<typeof s.start>> | null = null;
  try {
    await inbound.unsafe(`insert into inbound (id, person, agent, body) values ('m-limit', '${PERSON}', 'p1-lair', 'a human message')`);
    await inbound.unsafe(`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'm-limit', 'received', 'door')`);
    s.fake.script(post, { kind: "rate_limit", retryAfter: 2, global: true });
    door = await s.start();
    await Bun.sleep(700);

    // The ordinary reply meets the limit first.
    await s.runner.sql.unsafe(`insert into outbox (inbound_id, seq_in_reply, body) values ('m-limit', 1, 'the reply')`);
    await until("the reply met the limit", () => s.fake.requestsTo(post).length === 1, 10_000);
    // The limit is measured from the moment it was served, not from when this test noticed it. The row carries
    // the door's own 1 s stamp from before the send until the failure replaces it, so the failure is what is waited for.
    await until("the reply's retry was written from the limit", async () =>
      (await s.it.read.sql("select failure->>'code' as code from outbox where inbound_id = 'm-limit'", []))[0]?.code === "http-429", 10_000);
    expect(s.limited).toHaveLength(1);
    const hit = s.limited[0] as number;
    const [chunk] = await s.it.read.sql("select attempts, retry_at, delivered_at from outbox where inbound_id = 'm-limit'", []);
    // Waited out as Discord said (2 s), not at the door's own 1 s retry.
    expect(new Date(chunk.retry_at as Date | string).getTime() - hit).toBeGreaterThanOrEqual(1500);
    expect(chunk.delivered_at).toBeNull();

    // An effect asked for now is held by the same boundary: nothing is sent to that route until the wait is over.
    await wantEffect(s.runner, { key: "limit:status", door: DOOR, chat: s.channel, owner: "o", text: "the status" });
    await Bun.sleep(700);
    expect(s.fake.requestsTo(post)).toHaveLength(1);
    expect((await effectRow2(s, "limit:status")).attempts).toBe(0);

    await until("the reply and the effect were both delivered", () => s.fake.messagesIn(s.channel).length === 2, 20_000,
      () => JSON.stringify(s.fake.messagesIn(s.channel).map(m => m.content)));
    expect(Date.now() - hit).toBeGreaterThanOrEqual(1300);
    expect(s.fake.messagesIn(s.channel).map(m => m.content.split("\n")[0]).sort()).toEqual(["the reply", "the status"]);
    // The effect's own post did not go until the limit was over, so it was never refused by it.
    expect((await effectRow2(s, "limit:status")).attempts).toBe(1);
  } finally {
    await inbound.close().catch(() => {});
    if (door) await door.stop();
    await s.stop();
  }
});

test("through a real door: an edit that lands late is found when the door starts, and the newest content then goes by itself, after the wait a limit named and never over the old request", async () => {
  const s = await stageDoor();
  const edit = new RegExp(`^PATCH /channels/${s.channel}/messages/\\d+$`);
  const patches = () => s.fake.requestsTo(edit);
  const text = (version: string) => ({ key: "late:status", door: DOOR, chat: s.channel, owner: "late:1", text: version });
  const shown = () => s.fake.messagesIn(s.channel).map(m => m.content.split("\n")[0]);
  let door = await s.start();
  try {
    await wantEffect(s.runner, text("v1"));
    await until("v1 was posted", async () => (await effectRow2(s, "late:status")).state === "confirmed", 20_000);

    // v2's request leaves and its answer is lost; v3 is asked for behind it. The looks find v1 and it is unknown.
    s.fake.script(edit, { kind: "drop", late: true });
    await wantEffect(s.runner, text("v2"));
    await until("the old edit's answer was lost", async () => (await effectRow2(s, "late:status")).edit_state === "in_flight", 20_000);
    await wantEffect(s.runner, text("v3"));
    await until("the looks gave up on the old edit", async () => (await effectRow2(s, "late:status")).edit_state === "unknown", 30_000,
      async () => JSON.stringify(await effectRow2(s, "late:status")));
    expect(patches()).toHaveLength(1);
    expect(shown()).toEqual(["v1"]);

    // A restart while the old request is still on its way looks again and sends nothing over it.
    await door.stop();
    door = await s.start();
    await until("the start looked at the old edit again", async () => (await effectRow2(s, "late:status")).evidence.edit_rechecked !== undefined, 20_000);
    await Bun.sleep(700);
    expect(patches()).toHaveLength(1);
    expect((await effectRow2(s, "late:status")).edit_state).toBe("unknown");

    // It lands, and the newest content meets a limit the first time. Nobody asks for anything and nothing else wakes the door.
    await door.stop();
    expect(s.fake.land()).toBe(1);
    expect(shown()).toEqual(["v2"]);
    s.fake.script(edit, { kind: "rate_limit", retryAfter: 2 });
    door = await s.start();
    await until("the settled edit released v3, which met the limit", () => patches().length === 2, 20_000,
      async () => JSON.stringify(await effectRow2(s, "late:status")));
    const hit = Date.now();
    await Bun.sleep(900);
    expect(patches()).toHaveLength(2);
    expect(shown()).toEqual(["v2"]);
    await until("v3 went out once the limit was over", () => shown()[0] === "v3", 20_000,
      async () => JSON.stringify(await effectRow2(s, "late:status")));
    expect(Date.now() - hit).toBeGreaterThanOrEqual(1300);
    expect(patches()).toHaveLength(3);
    const row = await effectRow2(s, "late:status");
    expect([row.edit_state, row.applied_revision, row.wanted_revision]).toEqual(["idle", 3, 3]);
    expect(s.fake.requestsTo(new RegExp(`^POST /channels/${s.channel}/messages$`))).toHaveLength(1);
  } finally {
    await door.stop();
    await s.stop();
  }
});

async function effectRow2(s: Awaited<ReturnType<typeof stageDoor>>, key: string): Promise<Record<string, any>> {
  return (await s.it.read.sql("select * from platform_effect where key = $1", [key]))[0];
}

async function confirmation(s: Awaited<ReturnType<typeof stageDoor>>, id: string): Promise<Record<string, any>> {
  return (await s.it.read.sql("select * from confirmation where id = $1", [id]))[0];
}
