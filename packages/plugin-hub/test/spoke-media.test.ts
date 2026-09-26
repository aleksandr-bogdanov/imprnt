// An attachment reaches an agent whose runner is on another machine.
//
// The door saves a photo, a file or a voice note under its own state directory
// and the row's body names that path. A runner elsewhere has no such file, so
// the door also writes the bytes into the store, in the same transaction as
// the receipt, and the runner elsewhere writes them into its own person inbox
// before it feeds the row, checks the hash, and feeds the body with its own
// path in it. The tail names the same local path, so a session never reads a
// path from another disk. The hub machine's runner keeps reading the door's
// file directly, which the second check pins.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { controlledAdapter, observe } from "./helpers/rollout-runner.ts";
import { rolloutStage } from "./helpers/rollout-stage.ts";
import { message, payload } from "./helpers/rollout-ingress.ts";
import {
  AGENT,
  CHAT,
  DOOR,
  PERSON,
  RUNNER2,
  SPOKE_MACHINE,
  insertInbound,
  scratchDir,
  spokeStage,
  stageHub,
  superStore,
} from "./helpers/hub-fixture.ts";
import { localMediaPath, readMedia } from "../src/store/media.ts";
import { runDoor } from "../src/door/run.ts";
import { runRunner } from "../src/runner/run.ts";
import { TAIL_PREAMBLE } from "../src/chatlog.ts";

const SLOW = 120_000;
const HUB_ONLY = join("/nowhere-on-this-machine", crypto.randomUUID());

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

function sha256(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

test(
  "the door writes an attachment's bytes into the store in the receipt's own transaction, and the hub machine's runner feeds the door's file",
  async () => {
    const it = await rolloutStage(cluster, "telegram", { people: [{ id: "p1", language: "en" }, { id: "p2", language: "ru" }] });
    let door: Awaited<ReturnType<typeof runDoor>> | undefined;
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
    try {
      const input = { ...message("1", "here is the file"), media: [{ kind: "file" as const, remote_id: "file", name: "fixture.bin", mime: "application/octet-stream", bytes: 4, caption: null }] };
      it.edge.file("file", payload);
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform });
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } });
      it.edge.batch([input], "2");
      expect(await observe(async () => (await it.read.inbound()).length === 1)).toBe(true);
      const row = (await it.read.inbound())[0];
      const stored = await readMedia(await superStore(cluster, it.db), row.id);
      expect(stored.length).toBe(1);
      expect(stored[0]).toMatchObject({ index: 0, kind: "file", name: "fixture.bin", sha256: sha256(payload) });
      expect(new Uint8Array(stored[0].bytes)).toEqual(payload);
      // The body names the door's own file, which the hub machine's runner fed
      // as it is: no copy was made on this machine for a door that is here.
      const path = row.body.match(/\(file ([^)]+)\)/)![1];
      expect(path.startsWith(it.stateDir)).toBe(true);
      expect(await observe(() => it.scripted.fed().some((fed) => fed.text.includes(path)))).toBe(true);
    } finally {
      await runner?.stop();
      await door?.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "a spoke's runner writes the attachment out of the store into its own inbox, checks the hash, and feeds the row and the tail with its own path",
  async () => {
    const spokeState = await scratchDir("hub-spoke-media-");
    const tree = join(spokeState, "trees", PERSON);
    mkdirSync(tree, { recursive: true });
    const it = await stageHub(cluster, {
      ...spokeStage(),
      machines: spokeStage().machines!.map((one) => (one.id === SPOKE_MACHINE ? { ...one, state_dir: spokeState } : one)),
      people: [{ id: PERSON, language: "en", tree: HUB_ONLY, on: { [SPOKE_MACHINE]: { tree } } }],
    });
    const edge = controlledAdapter(it.adapterName);
    const store = await superStore(cluster, it.db);
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined;
    try {
      // Two rows the door wrote on the hub machine, each naming a file under
      // the hub machine's state directory, each with its bytes in the store.
      const planted = async (id: string, text: string, at: Date, bytes: Uint8Array, ext: string) => {
        const doorPath = join(HUB_ONLY, "state", PERSON, "inbox", sha256(id), `0.${ext}`);
        const media = [{ path: doorPath, failed: false, kind: "file", name: `note.${ext}`, sha256: sha256(bytes) }];
        const body = `(file ${doorPath})\n${text}`;
        await insertInbound(cluster, it.db, {
          id, body, receivedAt: at.toISOString(), logReady: true,
          source: { log_id: id, at: at.toISOString(), door: DOOR, chat: CHAT, sender_id: "fixture-sender", text: body, media },
        });
        await store.sql`insert into media (inbound_id, index, sha256, kind, name, bytes) values (${id}, 0, ${sha256(bytes)}, 'file', ${`note.${ext}`}, ${bytes})`;
        return { doorPath, local: localMediaPath(spokeState, PERSON, id, 0, doorPath) };
      };
      const now = Date.now();
      const earlier = await planted("media-earlier", "the earlier file", new Date(now - 600_000), new Uint8Array([1, 2, 3]), "txt");
      await store.sql`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'media-earlier', 'answered', 'runner')`;
      const waiting = await planted("media-now", "read this one", new Date(now - 60_000), payload, "bin");

      runner = await runRunner({ runner: RUNNER2, registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } });
      expect(await observe(() => edge.sessions.length === 1 && edge.sessions[0].fed.length >= 2)).toBe(true);
      const [tail, turn] = edge.sessions[0].fed;
      // The turn names the spoke's own file, and the file holds the bytes.
      expect(turn.id).toBe("media-now");
      expect(turn.text).toContain(`(file ${waiting.local})`);
      expect(turn.text).not.toContain(HUB_ONLY);
      expect(existsSync(waiting.local)).toBe(true);
      expect(new Uint8Array(readFileSync(waiting.local))).toEqual(payload);
      expect(waiting.local.startsWith(join(spokeState, PERSON, "inbox"))).toBe(true);
      // The tail names the spoke's path for the earlier file too, and never
      // the hub machine's.
      expect(tail.text.startsWith(TAIL_PREAMBLE)).toBe(true);
      expect(tail.text).toContain(earlier.local);
      expect(tail.text).not.toContain(HUB_ONLY);

      // Bytes that do not match what the door recorded are refused, never fed.
      const bad = "media-bad";
      const doorPath = join(HUB_ONLY, "state", PERSON, "inbox", sha256(bad), "0.bin");
      await insertInbound(cluster, it.db, {
        id: bad, body: `(file ${doorPath})\ncorrupt`, receivedAt: new Date().toISOString(), logReady: true,
        source: { log_id: bad, at: new Date().toISOString(), door: DOOR, chat: CHAT, sender_id: "fixture-sender", text: "corrupt",
          media: [{ path: doorPath, failed: false, kind: "file", name: "note.bin", sha256: sha256(payload) }] },
      });
      await store.sql`insert into media (inbound_id, index, sha256, kind, name, bytes) values (${bad}, 0, ${sha256(payload)}, 'file', 'note.bin', ${new Uint8Array([9, 9])})`;
      expect(await observe(async () => (await it.read.ledger({ stream: "refusal", subject: bad })).length > 0 ||
        (await it.read.sheet("agent_health")).some((row) => JSON.stringify(row.data).includes("media-mismatch")), 20_000)).toBe(true);
      expect(edge.sessions.flatMap((one) => one.fed).some((fed) => fed.id === bad)).toBe(false);
    } finally {
      await runner?.stop();
      await edge.stop();
      await store.close();
      await it.stop();
    }
  },
  SLOW,
);
