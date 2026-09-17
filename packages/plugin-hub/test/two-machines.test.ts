// STORE-02 and MSG-04. Two machines, one store.
//
// D5: "one Postgres server on the Pi holds every message, reply, job and turn
// for every person and every machine. Every runner, on the Pi or on a spoke,
// connects to it over the tailnet. A job for a machine that is off waits in its
// table." MSG-04: a job for a spoke is a row in the same database, the spoke's
// runner claims and settles it, and a machine that is off finds its rows
// waiting.
//
// PROVED ON ONE BOX WITH TWO RUNNER PROCESSES (D-98). There is no Postgres on
// the hub box today, so until it is installed no check can run there, and these
// two criteria are proved on the Mac with two runner PROCESSES against one
// throwaway cluster on its loopback TCP port, never its unix socket. WHAT THIS
// DOES NOT PROVE IS A TAILNET HOP, and that is the cutover's acceptance rather
// than a check: SPEC §2 rules that a human sends one real message per person and
// gets a real answer, never a script.
//
// D-86: `report` rows stay deferred to phase 4, so the waiting row goes in the
// way phase 2's feed-order check put its report row in. MSG-04's own content is
// the routing, the waiting and the draining, and all three are true of an
// inbound row of any kind whose agent names the spoke's runner.
//
// Red reasons: check 17 behaviour absent (a runner's backend reports a null
// `application_name` today, so neither runner is identifiable in the server's
// own view); check 18 export missing (`listMachines` and `runEntriesFor` in
// `src/registry/entries.ts`, which is where "which machine runs this agent" is
// derived rather than being a second fact that can disagree).

import { test, expect, beforeAll, afterAll } from "bun:test";
import {
  startCluster,
  seam,
  startReadySubprocess,
  until,
  type Cluster,
  type ReadyProcess,
} from "./helpers/cluster.ts";
import { scriptedReply } from "./helpers/scripted-adapter.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  RUNNER2,
  insertInbound,
  plantChatLine,
  stageHub,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
import { loadRegistry, readSetting } from "../src/registry/load.ts";

const RUNNER_PI = "runner-pi";
const SLOW = 120_000;

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/** One registry, two machines, two people, two runners, two agents. */
async function stageTwoMachines(): Promise<StagedHub> {
  const it = await stageHub(cluster, {
    servers: true,
    machines: [
      { id: "pi", os: "linux" },
      { id: "mac", os: "macos" },
    ],
    people: [
      { id: PERSON, tree: "/var/lib/imprnt-hub/p1" },
      { id: PERSON2, tree: "/var/lib/imprnt-hub/p2" },
    ],
    hub: { shared_zone: "/var/lib/imprnt-hub/shared" },
    agents: [
      {
        id: AGENT2,
        person: PERSON2,
        preset: "daily",
        chat: `${CHAT}1`,
        door: "door-mac",
        runner: RUNNER2,
      },
    ],
    run: [
      {
        id: DOOR,
        kind: "door",
        machine: "pi",
        platform: "fake",
        person: PERSON,
        token_file: "/dev/null",
        schedule: "always",
        memory_limit_mb: 192,
      },
      {
        id: RUNNER_PI,
        kind: "runner",
        machine: "pi",
        schedule: "always",
        memory_limit_mb: 512,
        child_memory_limit_mb: 512,
      },
      {
        id: RUNNER2,
        kind: "runner",
        machine: "mac",
        schedule: "always",
        memory_limit_mb: 512,
        child_memory_limit_mb: 2048,
      },
    ],
  });
  // The default agent is on `runner-test`, and this registry has no such entry.
  // Rewriting it onto `runner-pi` keeps one agent per runner, one per machine.
  const text = await Bun.file(it.registryFile).text();
  await Bun.write(it.registryFile, text.replace(/runner = "runner-test"/, `runner = "${RUNNER_PI}"`));
  return it;
}

function startRunner(it: StagedHub, id: string): Promise<ReadyProcess> {
  return startReadySubprocess("test/helpers/runner-subprocess.ts", [
    it.registryFile,
    id,
    it.adapterUrl,
    it.adapterName,
  ]);
}

test(
  "STORE-02 every runner connects to the same host: two runner processes against one server over TCP, each naming itself to it, both as the runner role, and the store url they read is the single value in the single registry file (SPEC §1, D5, D-85, D-98)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const it = await stageTwoMachines();
    let pi: ReadyProcess | null = null;
    let mac: ReadyProcess | null = null;
    try {
      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      plantChatLine({
        stateDir: it.stateDir,
        person: PERSON2,
        agent: AGENT2,
        text: "what the second person said yesterday",
      });

      pi = await startRunner(it, RUNNER_PI);
      mac = await startRunner(it, RUNNER2);

      // One message each, so both are past their connect rather than still
      // coming up when the server's view is read.
      await insertInbound(cluster, it.db, { id: "tm-1", body: "a message for the first agent" });
      await insertInbound(cluster, it.db, {
        id: "tm-2",
        body: "a message for the second agent",
        person: PERSON2,
        agent: AGENT2,
      });
      await until(
        "both agents answered",
        async () => (await it.read.outbox()).length >= 2,
        90_000,
        async () => JSON.stringify(await it.read.inbound()),
      );

      const mine = new Set([await it.read.pid()]);
      const backends = (await it.read.sql(
        `select pid, usename, application_name, client_addr, backend_type
           from pg_stat_activity
          where datname = current_database()
            and backend_type = 'client backend'
            and pid <> pg_backend_pid()
          order by pid`,
      )) as {
        pid: number;
        usename: string;
        application_name: string | null;
        client_addr: string | null;
      }[];
      const theirs = backends.filter((b) => !mine.has(Number(b.pid)));
      expect(theirs.length).toBeGreaterThanOrEqual(2);

      // BOTH runners, each by its OWN id. D-85's mechanism is the seam's
      // business and this binds the OUTCOME, so a url parameter and a
      // `set application_name` at connect are both allowed. Neither is in a
      // wait window, so `test/runner-drain.test.ts` stays green.
      const named = theirs.map((b) => b.application_name);
      expect(named).toContain(RUNNER_PI);
      expect(named).toContain(RUNNER2);

      // EVERY one of them, not one. A runner that opened a second connection as
      // somebody else fails here, which is phase 1's fence binding to two
      // processes rather than one.
      for (const backend of theirs) {
        expect(backend.usename).toBe("hub_runner");
        // A unix-socket backend reports a null client_addr and a TCP one does
        // not, so this is what makes "connects to the same host" an assertion
        // about a network connection rather than about a string in a file.
        expect(backend.client_addr).not.toBeNull();
      }

      // The ONE host half. The store url is a single value in a single file,
      // both runners were handed that same file, and both of their backends are
      // registered in THIS server's own view: a runner that had connected to a
      // different cluster would simply not be in it. The server's own
      // identifier is read as well, because it cannot be forged by a test that
      // opened two connections to two different clusters.
      const registry = loadRegistry(it.registryFile);
      expect(String(readSetting(registry, "hub.store_url"))).toBe(it.storeUrl);
      expect(it.storeUrl.startsWith("postgres://127.0.0.1:")).toBe(true);
      const [control] = (await it.read.sql(
        "select system_identifier::text as id from pg_control_system()",
      )) as { id: string }[];
      expect(control.id.length).toBeGreaterThan(0);
    } finally {
      if (pi) await pi.stop();
      if (mac) await mac.stop();
      await it.stop();
    }
  },
  SLOW,
);

test(
  "MSG-04 a row for the other machine's agent waits while its runner is off and is drained when it starts: which machine runs an agent is DERIVED from the registry and is never a second fact, the running runner never claims the other machine's row at any point AND never feeds it or the other agent's session to a loop, and the drain happens with no new arrival (SPEC §2, L1, D5, D-76, D-86)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    expect(typeof runRunner).toBe("function");

    const it = await stageTwoMachines();
    let pi: ReadyProcess | null = null;
    let mac: ReadyProcess | null = null;
    let watching = true;
    try {
      // --- the routing, DERIVED. An agent names its runner and the runner is a
      //     `[[run]]` entry, so "which machine runs this agent" is read off the
      //     file and can never be a second fact that disagrees with it (D-76).
      //     This is the half that is red today: the loader carries no machine.
      const { listMachines, runEntriesFor } = await seam("src/registry/entries.ts");
      expect(typeof listMachines).toBe("function");
      expect(typeof runEntriesFor).toBe("function");
      const registry = loadRegistry(it.registryFile);
      expect(((listMachines as Function)(registry) as { id: string }[]).map((m) => m.id)).toEqual([
        "pi",
        "mac",
      ]);
      const onMac = (runEntriesFor as Function)(registry, "mac") as { id: string }[];
      expect(onMac.map((e) => e.id)).toEqual([RUNNER2]);
      const onPi = (runEntriesFor as Function)(registry, "pi") as { id: string }[];
      expect(onPi.map((e) => e.id).sort()).toEqual([DOOR, RUNNER_PI].sort());
      // The agent the mac runs is the one whose `runner` is the mac's entry, and
      // nothing else says so.
      expect(registry.agents.find((a) => a.id === AGENT2)!.runner).toBe(RUNNER2);
      expect(registry.agents.find((a) => a.id === AGENT)!.runner).toBe(RUNNER_PI);

      plantChatLine({ stateDir: it.stateDir, text: "what was said yesterday" });
      plantChatLine({
        stateDir: it.stateDir,
        person: PERSON2,
        agent: AGENT2,
        text: "what the second person said yesterday",
      });

      // --- runner-mac is the machine that is OFF.
      pi = await startRunner(it, RUNNER_PI);

      const waiting = "the job that waits for the machine that is off";
      await insertInbound(cluster, it.db, { id: "tm-live", body: "a job for the machine that is on" });
      await insertInbound(cluster, it.db, {
        id: "tm-waiting",
        body: waiting,
        person: PERSON2,
        agent: AGENT2,
      });

      // Every claim this row ever carried, sampled through the whole window.
      // A runner that claimed another machine's work and then released it would
      // look identical to a correct run if only the final state were read, and
      // that is the exact failure this criterion exists to catch.
      const claimsSeen = new Set<string>();
      // AND EVERY FEED THE LOOP EVER SAW, which is the second seat's lead: a
      // claim writes no ledger event (`src/runner/claim.ts`), so a wrong runner
      // that claimed the row, fed it to a loop and released it between two
      // samples would leave the row looking untouched. The adapter server
      // records every session and every message fed to it, and the runner feeds
      // the tail of an agent's chat log as the first message of every session
      // it spawns with the AGENT ID as that message's id, so a session for the
      // other machine's agent is visible even when no work was settled.
      const wrongFeeds: string[] = [];
      const watch = (async () => {
        while (watching) {
          const row = (await it.read.inbound()).find((r) => r.id === "tm-waiting");
          if (row) claimsSeen.add(String(row.claimed_by));
          for (const session of it.adapterServer!.seen()) {
            for (const fed of session.fed) {
              if (fed.id === AGENT2 || fed.text === waiting) {
                wrongFeeds.push(`${session.session} was fed ${fed.id}: ${fed.text.slice(0, 40)}`);
              }
            }
          }
          await Bun.sleep(100);
        }
      })();

      // The control: without it, a store that lost both rows passes.
      await until(
        "the live agent's row was answered",
        async () => (await it.read.outbox()).some((c) => c.inbound_id === "tm-live"),
        90_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      // Several ticks of the runner that IS running, over the row that is not
      // its own.
      await Bun.sleep(4000);

      const parked = (await it.read.inbound()).find((r) => r.id === "tm-waiting")!;
      expect(parked.state).toBe("received");
      expect(parked.claimed_by).toBeNull();
      expect((await it.read.outbox()).some((c) => c.inbound_id === "tm-waiting")).toBe(false);
      expect([...claimsSeen]).toEqual(["null"]);
      expect(
        (await it.read.ledger({ stream: "inbound", subject: "tm-waiting" })).map((e) => e.kind),
      ).toEqual(["received"]);

      // NOTHING OF THE OTHER MACHINE'S EVER REACHED A LOOP. Not the waiting
      // message, and not even the other agent's session: the runner that IS
      // running never spawned one for an agent that is not its own.
      watching = false;
      await watch;
      expect(wrongFeeds).toEqual([]);
      const before = it.adapterServer!.seen();
      expect(before.some((s) => s.fed.some((f) => f.id === AGENT2))).toBe(false);
      expect(before.some((s) => s.fed.some((f) => f.text === waiting))).toBe(false);
      // The control beside it: the runner that IS running did open a session
      // for its OWN agent, so "no session for the other agent" is a fence and
      // not a loop that never ran.
      expect(before.some((s) => s.fed.some((f) => f.id === AGENT))).toBe(true);

      // --- and now the machine comes up. The notification its insert emitted
      //     was gone long before this process existed.
      const [{ seq: seqAtStart }] = (await it.read.sql(
        "select coalesce(max(seq), 0) as seq from ledger_event",
      )) as { seq: string }[];
      mac = await startRunner(it, RUNNER2);

      await until(
        "the waiting row was drained by the machine that came up",
        async () => (await it.read.outbox()).some((c) => c.inbound_id === "tm-waiting"),
        90_000,
        async () => JSON.stringify(await it.read.inbound()),
      );

      const chunk = (await it.read.outbox()).find((c) => c.inbound_id === "tm-waiting")!;
      expect(chunk.body).toBe(scriptedReply(waiting));
      const settled = (await it.read.inbound()).find((r) => r.id === "tm-waiting")!;
      expect(settled.state).not.toBe("received");
      // And the feed that answered it appeared only once the other machine was
      // up, so the work was done by the runner that owns the agent.
      const after = it.adapterServer!.seen();
      expect(after.some((s) => s.fed.some((f) => f.text === waiting))).toBe(true);
      expect(after.length).toBeGreaterThan(before.length);

      // NO NEW ARRIVAL. By sequence rather than by timestamp, the way
      // `test/runner-drain.test.ts` does it: a millisecond-truncated timestamp
      // can tie with the row that follows it, and a tie would make a correct run
      // look like an arrival after the start.
      for (const arrival of await it.read.ledger({ stream: "inbound", kind: "received" })) {
        expect(arrival.seq).toBeLessThanOrEqual(Number(seqAtStart));
      }
    } finally {
      watching = false;
      if (pi) await pi.stop();
      if (mac) await mac.stop();
      await it.stop();
    }
  },
  SLOW,
);
