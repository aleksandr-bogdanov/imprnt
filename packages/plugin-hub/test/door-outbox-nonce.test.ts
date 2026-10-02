// Retry nonce regression kept separate from the byte-pinned acceptance window.
import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  seam,
  statementWatch,
  untilIssued,
  backendPid,
  foreignBackends,
  until,
  type Cluster,
} from "./helpers/cluster.ts";
import { AGENT, CHAT, DOOR, PERSON, stageHub } from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 90_000;

/** The door's allowance to LISTEN and read its pending chunks once. */
const SETTLE_MS = 700;

/** Inside the window a door asleep on the notification issues nothing. */
const STATEMENTS_ALLOWED_IN_WINDOW = 0;

beforeAll(async () => {
  cluster = await startCluster({
    settings: {
      log_statement: "'all'",
      log_line_prefix: "'pid=%p '",
      log_min_duration_statement: "-1",
    },
  });
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

type Conn = {
  unsafe(query: string, values?: unknown[]): Promise<unknown>;
  close(): Promise<void>;
};

/** One throwaway database, one registry naming it, one in-process platform. */
function stage() {
  return stageHub(cluster, { preset: { adapter: "scripted" } });
}

/** A committed inbound row, written by the door role, with no runner involved. */
async function committedInbound(db: string, id: string, body: string) {
  const door = cluster.connectAs("hub_door", db) as unknown as Conn;
  await door.unsafe(
    `insert into inbound (id, person, agent, body)
     values ('${id}', '${PERSON}', '${AGENT}', '${body}')`,
  );
  await door.unsafe(
    `insert into ledger_event (stream, subject, kind, actor)
     values ('inbound', '${id}', 'received', 'door')`,
  );
  await door.close();
}
test(
  "outbox retries retain one nonce across a door restart",
  async () => {
    const { runDoor } = await seam("src/door/run.ts");
    expect(typeof runDoor).toBe("function");

    const it = await stage();
    await Bun.write(it.registryFile, (await Bun.file(it.registryFile).text()) + "\n[door]\ndelivery_retry_seconds = 1\n");
    const nonces: (string | undefined)[] = [];
    const platform = { ...it.fake.platform, post: async (input: { chat: string; text: string; nonce?: string }) => {
      nonces.push(input.nonce);
      return await it.fake.platform.post(input);
    } };
    let handle: { stop(): Promise<void> } | null = null;
    const runner = cluster.connectAs("hub_runner", it.db) as unknown as Conn;

    try {
      await committedInbound(it.db, "m-deliver", "a human message");
      it.fake.holdPosts(true);

      handle = await (runDoor as Function)({
        door: DOOR,
        registryFile: it.registryFile,
        platform,
      });
      await Bun.sleep(SETTLE_MS);

      await runner.unsafe(
        `insert into outbox (inbound_id, seq_in_reply, body)
         values ('m-deliver', 1, 'the reply the platform will refuse')`,
      );

      // The refusing half is the load. Without it a door that marks a chunk
      // delivered the moment it hands it over passes every other check in the
      // phase, and the failure behind this rule is a channel that reported
      // success at every layer while swallowing messages.
      await until(
        "the door tried to post the chunk",
        () => it.fake.attempts().length >= 1,
        10_000,
      );
      await Bun.sleep(2000);

      const pending = await it.read.outbox();
      expect(pending.length).toBe(1);
      expect(pending[0].delivered_at).toBeNull();
      expect(
        await it.read.ledger({ stream: "inbound", kind: "delivered" }),
      ).toEqual([]);
      expect(it.fake.posts().length).toBe(0);

      // Now the platform accepts, and the two facts land together.
      await handle!.stop();
      it.fake.holdPosts(false);
      handle = await (runDoor as Function)({ door: DOOR, registryFile: it.registryFile, platform });
      await until(
        "the chunk was marked delivered",
        async () => (await it.read.outbox())[0].delivered_at !== null,
        15_000,
      );
      await Bun.sleep(1000);

      expect(nonces.length).toBeGreaterThan(1);
      expect(new Set(nonces).size).toBe(1);
      expect(nonces[0]).toMatch(/^[A-Za-z0-9_-]{25}$/);
      expect(it.fake.posts().length).toBe(1);
      expect(it.fake.posts()[0].text).toBe(
        "the reply the platform will refuse",
      );
      const stamps = await it.read.ledger({
        stream: "inbound",
        kind: "delivered",
      });
      expect(stamps.length).toBe(1);
      expect(stamps[0].actor).toBe("door");
      expect(stamps[0].subject).toBe("m-deliver");
    } finally {
      await runner.close();
      if (handle) await handle.stop();
      await it.read.close();
    }
  },
  SLOW,
);
