import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCluster, freshDatabase, type Cluster } from "./helpers/cluster.ts";
import { claimNext } from "../src/runner/claim.ts";

let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

test("RUN-02 admission claims the planned row when higher-priority work arrives before the claim", async () => {
  const db = await freshDatabase(cluster);
  const sql = cluster.connect(db);
  const store = { sql, url: cluster.url(db) };
  await sql`insert into inbound (id, person, agent, body, kind)
    values ('planned-harvest', 'p1', 'p1-lair', 'harvest', 'harvest')`;
  const [planned] = await sql`select id from inbound order by rank, received_at, id limit 1`;
  await sql`insert into inbound (id, person, agent, body, kind)
    values ('later-human', 'p1', 'p1-lair', 'human', 'human')`;
  const who = { runner: 'runner-test', agent: 'p1-lair', leaseMs: 1000, rowId: String(planned.id) };
  expect((await claimNext(store, who))?.id).toBe('planned-harvest');
  expect((await sql`select claimed_by from inbound where id = 'later-human'`)[0].claimed_by).toBeNull();
  await sql`delete from inbound where id = 'planned-harvest'`;
  expect(await claimNext(store, who)).toBeNull();
  expect((await claimNext(store, { runner: 'runner-test', agent: 'p1-lair', leaseMs: 1000 }))?.id).toBe('later-human');
});
