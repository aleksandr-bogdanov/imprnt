// After a terminal refusal the runner does NOT feed the assignment again by
// itself, and the child it was fed to is gone.
//
// SPEC §6 and L10 rule 3 said the runners retry a refused turn on their own on a
// fixed interval. Design §4 supersedes that for an input the engine was handed:
// the engine's own API backoff (429, 503) happens inside the ONE attempt, but once
// the adapter reports a TERMINAL failure the hub does not feed the assignment
// again without the owner's choice. The absence of output or of a receipt is not
// the absence of delivery: the input was handed to the engine, and a riding tail
// may already have run tools. So the refused input is HELD with real exit proof,
// the outage is still reported once per person, and only the owner's explicit
// continuation, a NEW input on the same conversation, runs again.
//
// WHY NO OTHER CHECK CAN FAIL ON IT. Every outage check drives
// `createScriptedAdapter`, whose session survives a refusal and answers turn
// after turn, and the gated real-binary check feeds exactly ONE turn and
// closes. The adapter ends a refused turn itself and CLOSES THE CHILD,
// because no retry fixes a dead credential, so the handle the next turn would
// feed is a handle onto a process that is gone. Measured in bun 1.3.14: writing
// to a killed child's stdin returns normally and discards the bytes, so a feed
// to it would never end a turn (the adapter now refuses such a feed by name,
// before writing a byte).
//
// So this check drives the REAL `claudeCode` adapter, through the production
// `wrap` hook, across TWO turns: the first invocation of the scripted CLI emits
// the measured 401 `api_retry` wire and holds, and the second emits a healthy
// turn. What is bound is that the first input is held and fed once, that the
// household is told once, that the child is gone, and that the owner's
// continuation runs on a NEW child and answers.
//
// The wire shapes are the ones measured on 2026-09-16 and recorded in
// quoted in test/adapter-refusal.test.ts's own header:
//   {"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,
//    "retry_delay_ms":623,"error_status":401,"error":"authentication_failed"}
// once per attempt, with rising delays and no `result` written meanwhile.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import { fakeClaudeCli, healthyResult } from "./helpers/fake-cli.ts";
import { childGone } from "./helpers/scripted-adapter.ts";
import {
  AGENT,
  CHAT,
  DOOR,
  PERSON,
  RUNNER,
  insertInbound,
  stageHub,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
import { requestHoldChoice } from "../src/door/recovery.ts";
import { loadRegistry } from "../src/registry/load.ts";
import type { StoreLike } from "../src/store/connect.ts";
import type { Adapter, AdapterSession } from "../src/adapters/types.ts";

let cluster: Cluster;

const SLOW = 120_000;
const CREDENTIAL = "household-claude";
/** Short on purpose, so the retry is seconds and the check is not a minute. */
const RETRY_SECONDS = 2;
const ANSWER = "the answer the loop gave once it worked again";

const INIT = { type: "system", subtype: "init", apiKeySource: "none" };

const RETRY_401 = {
  type: "system",
  subtype: "api_retry",
  attempt: 1,
  max_retries: 10,
  retry_delay_ms: 623,
  error_status: 401,
  error: "authentication_failed",
};

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

/**
 * The REAL adapter, handed the production `wrap` hook, with a different
 * scripted wire per invocation.
 *
 * It is a shim over `claudeCode.start` and nothing else: what reads the wire is
 * the shipped adapter, and what the runner is handed is the shipped adapter's
 * own session. A real person box and a canonical synthetic login are supplied,
 * and the scripted wire is composed inside that production wrapper.
 */
function realLoopOver(
  scripts: Record<string, unknown>[][],
  /** What the build says it can do. Given, the conversation has a native session and an interrupted one may be resumed. */
  ready = false,
): { adapter: Adapter; pids(): number[]; starts(): number } {
  const pids: number[] = [];
  return {
    adapter: {
      name: "claude-code",
      ...(ready ? { capabilities: async () => ({ stableSession: true, safeResume: true, delegationDisabled: true, version: "synthetic" }) } : {}),
      async start(options): Promise<AdapterSession> {
        const { claudeCode } = await seam("src/adapters/claude-code.ts");
        const nth = Math.min(pids.length, scripts.length - 1);
        const session = (await (claudeCode as { start: Function }).start({
          ...options,
          wrap: (argv: string[]) => options.wrap!(fakeClaudeCli(scripts[nth])(argv)),
        })) as AdapterSession;
        pids.push(Number(session.pid ?? 0));
        return session;
      },
    },
    pids: () => [...pids],
    starts: () => pids.length,
  };
}

async function stage(): Promise<StagedHub> {
  return await stageHub(cluster, {
    // Long, so a row that comes back can only have come back on the deadline
    // the row itself carries and never on the tick.
    hub: { tick_seconds: 30, outage_retry_seconds: RETRY_SECONDS },
    preset: { credential: CREDENTIAL, adapter: "claude-code" },
    registry: (base) => {
      const root = String(base.hub!.state_dir);
      const tree = join(root, "tree");
      const file = join(root, "login", ".credentials.json");
      mkdirSync(tree, { recursive: true });
      mkdirSync(join(root, "login"), { recursive: true });
      writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "synthetic-login", scopes: ["user:inference"] } }), { mode: 0o600 });
      return {
        ...base,
        people: [{ id: PERSON, language: "en", tree, allowed_senders: { [DOOR]: [PERSON] } } as never],
        credentials: [{ id: CREDENTIAL, kind: "claude-login", file, owner: "household" }],
        agents: (base.agents ?? []).map((agent) => ({ ...agent, runner: RUNNER })),
      };
    },
  });
}

test(
  "RUN-18 a terminal refusal after the input was handed to the engine holds it: the adapter closes the child on the measured 401 retry wire, the input is not fed again by any retry, the outage is reported once, and the owner's explicit continuation runs on a NEW child (design §4, superseding SPEC §6 / L10 rule 3's automatic retry of a fed turn)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");

    const it = await stage();
    const loop = realLoopOver([
      // Turn one: the measured refused-credential wire, and then silence, the
      // way the real CLI is silent between its rising retries.
      [INIT, RETRY_401],
      // Turn two: the credential works again.
      [INIT, healthyResult(ANSWER)],
    ], true);
    let runner: { stop(): Promise<void> } | null = null;
    const door = { sql: cluster.connectAs("hub_door", it.db), url: cluster.url(it.db) } as StoreLike;

    try {
      await insertInbound(cluster, it.db, {
        id: "rr-1",
        body: "the message the loop refused once",
      });
      runner = (await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { "claude-code": loop.adapter },
      })) as { stop(): Promise<void> };

      // --- 1. the refusal landed: the diary says why, the household's outage
      //     row stands, and the person was told once.
      await until(
        "the first turn was refused",
        async () =>
          (await it.read.ledger({ stream: "refusal", kind: "refused.outage" })).length >= 1,
        45_000,
        async () =>
          `inbound=${JSON.stringify(await it.read.inbound())} starts=${loop.starts()}`,
      );
      // EACH OF THE THREE IS WAITED FOR ON ITS OWN, because the contract does
      // not put them in one transaction and this check may not assume it does.
      // `refuseTurn` covers the diary line, the released claim and the
      // recorded retry. The outage row is `claimRow`'s own statement, because
      // two runners race for it and the primary key is what settles that,
      // and the notice is `appendNotice`'s, because its unique key is
      // what makes one outage one line per person. A reader woken by
      // the diary line therefore lands between them on any box slow enough,
      // and the hub box is: this asserted them straight after the ledger line
      // and failed there twice, deterministically, about 350 ms in.
      await until(
        "the household's outage row was opened",
        async () => (await it.read.outageSheet()).length >= 1,
        20_000,
        async () => JSON.stringify(await it.read.outageSheet()),
      );
      const sheet = await it.read.outageSheet();
      expect(sheet.length).toBe(1);
      expect(sheet[0].id).toBe(CREDENTIAL);
      expect(sheet[0].data.cause).toBe("login");
      // The outage notice is the household's, once per person. The input the engine was
      // handed is also held and its owner told so, which is a notice of its own.
      const outageNotices = async () =>
        (await it.read.noticeRows()).filter((row) => String(row.notice_key).startsWith("outage:"));
      await until(
        "the person was told once",
        async () => (await outageNotices()).length >= 1,
        20_000,
        async () => JSON.stringify(await it.read.noticeRows()),
      );
      const notices = await outageNotices();
      expect(notices.length).toBe(1);
      expect(notices[0].person).toBe(PERSON);
      expect(String(notices[0].notice_key).startsWith(`outage:${CREDENTIAL}:`)).toBe(true);

      // --- 2. THE CHILD IS GONE. The adapter ends the turn on the first 401
      //     and closes it, because no retry fixes a dead credential and the
      // CLI would go on retrying for minutes.
      expect(loop.starts()).toBe(1);
      const first = loop.pids()[0];
      expect(first).toBeGreaterThan(0);
      await Bun.sleep(300);
      expect(childGone(first)).toBe(true);

      // --- 3. THE INPUT IS NOT FED AGAIN, and this is the whole point. It was
      //     handed to the engine, so the refusal (no output, and no more proof
      //     of non-delivery than that) held it with the exit proof of the
      //     child the adapter closed. `tick_seconds` is 30 and the retry is 2:
      //     past the retry, and past a generic recover, nothing has started a
      //     child for it or fed it.
      const [attempt] = (await it.read.sql(
        "select id, state, evidence->'exit' as exit from execution where inbound_id = 'rr-1'",
      )) as { id: string; state: string; exit: unknown }[];
      expect(
        attempt.state,
        `the closed child and its group are shown gone: a real exit proof; exit=${JSON.stringify(attempt.exit)}`,
      ).toBe("interrupted");
      expect(await it.read.sql("select cause, state, revision from replay_hold")).toEqual([
        { cause: "interrupted", state: "held", revision: 1 },
      ]);
      await (runner as unknown as { recoverAgent(request: { id: string; agent: string }): Promise<void> }).recoverAgent({
        id: "generic-recover",
        agent: AGENT,
      });
      await Bun.sleep(RETRY_SECONDS * 1000 + 2000);
      expect(loop.starts(), "no child was started to feed it again").toBe(1);
      expect(
        (await it.read.ledger({ stream: "inbound", kind: "answered", subject: "rr-1" })).length,
      ).toBe(0);
      expect((await it.read.outbox()).some((row) => row.inbound_id === "rr-1")).toBe(false);
      expect(await it.read.sql("select id from execution where inbound_id = 'rr-1'")).toEqual([
        { id: attempt.id },
      ]);
      expect((await it.read.sql("select hub_row_held('rr-1') as held"))[0].held).toBe(true);
      expect(
        (await it.read.sql("select retry_at from inbound where id = 'rr-1'"))[0].retry_at,
        "a held input carries no retry",
      ).toBeNull();
      // The refusal was reported once, and the owner was told what to type.
      expect((await it.read.ledger({ stream: "refusal", subject: "rr-1" })).length).toBe(1);
      const held = (await it.read.noticeRows()).find((row) => row.notice_key === `hold:${attempt.id}:1`);
      expect(held, "the owner is told which attempt and which command").toBeDefined();
      expect(held!.body).toContain(`/recover ${AGENT} ${attempt.id} 1 continue`);

      // --- 3b. THE OWNER CHOOSES TO CONTINUE. The old attempt is shown over and
      //     the conversation's native session is one the engine acknowledged
      //     (the wire replayed the message before it refused), so the choice
      //     queues ONE new input on the same conversation, and only that runs,
      //     on a child this runner starts now. The original stays held for good.
      const outcome = await requestHoldChoice(door, {
        registry: loadRegistry(it.registryFile),
        person: PERSON,
        door: DOOR,
        chat: CHAT,
        sender_id: PERSON,
        message: "recover:1",
        at: new Date().toISOString(),
        agent: AGENT,
        attempt: attempt.id,
        revision: 1,
        choice: "continue",
      });
      expect(outcome).toBe("continuing");
      await until(
        "the owner's continuation was answered by a loop that was started again",
        async () => (await it.read.outbox()).some((row) => row.inbound_id === "continue:rr-1:1"),
        30_000,
        async () =>
          `starts=${loop.starts()} pids=${JSON.stringify(loop.pids())} ` +
          `inbound=${JSON.stringify(await it.read.inbound())} ` +
          `context=${JSON.stringify(await it.read.sql("select native_context from replay_hold"))}`,
      );
      expect(loop.starts()).toBe(2);
      const second = loop.pids()[loop.pids().length - 1];
      expect(second).toBeGreaterThan(0);
      expect(second).not.toBe(first);
      // The one that answered is alive, so what ran the second turn is a real
      // child and not a handle onto the first one's corpse.
      expect(childGone(second)).toBe(false);

      // --- 4. the answer is the loop's own, it reached the outbox once, and it
      //     answers the continuation: the original was never answered.
      const chunks = (await it.read.outbox()).filter((row) => row.inbound_id === "continue:rr-1:1");
      expect(chunks.length).toBe(1);
      expect(chunks[0].body).toBe(ANSWER);
      expect((await it.read.outbox()).some((row) => row.inbound_id === "rr-1")).toBe(false);
      expect(await it.read.sql("select id from execution where inbound_id = 'rr-1'")).toEqual([
        { id: attempt.id },
      ]);
      expect((await it.read.sql("select hub_row_held('rr-1') as held"))[0].held).toBe(true);
      expect((await it.read.sql("select state from replay_hold"))[0].state).toBe("released");

      // --- 5. it works again, said once, carrying what was waiting.
      await until(
        "the household was told it works again",
        async () =>
          (await it.read.noticeRows()).filter((row) =>
            String(row.notice_key).startsWith("outage-over:"),
          ).length >= 1,
        20_000,
        async () => JSON.stringify(await it.read.noticeRows()),
      );
      const over = (await it.read.noticeRows()).filter((row) =>
        String(row.notice_key).startsWith("outage-over:"),
      );
      expect(over.length).toBe(1);
      expect(over[0].person).toBe(PERSON);
      // And the sheet is empty: a thing that is gone leaves no line behind.
      expect(await it.read.outageSheet()).toEqual([]);
    } finally {
      if (runner) await runner.stop();
      await door.sql.close();
      await it.stop();
    }

    // --- THE CONTROL, without which this is a check on a runner that holds
    //     whatever happens: the same stage with the FIRST wire healthy answers
    //     on the first child, opens no outage, tells nobody anything, and never
    //     starts a second loop.
    const fine = await stage();
    const healthy = realLoopOver([[INIT, healthyResult(ANSWER)]]);
    let second: { stop(): Promise<void> } | null = null;
    try {
      await insertInbound(cluster, fine.db, {
        id: "rr-ok",
        body: "a message the loop answers at once",
      });
      second = (await (runRunner as Function)({
        runner: RUNNER,
        registryFile: fine.registryFile,
        adapters: { "claude-code": healthy.adapter },
      })) as { stop(): Promise<void> };
      await until(
        "the message was answered",
        async () => (await fine.read.outbox()).length >= 1,
        45_000,
        async () => JSON.stringify(await fine.read.inbound()),
      );
      await Bun.sleep(RETRY_SECONDS * 1000 + 1000);
      expect(healthy.starts()).toBe(1);
      expect(await fine.read.outageSheet()).toEqual([]);
      expect(await fine.read.noticeRows()).toEqual([]);
    } finally {
      if (second) await second.stop();
      await fine.stop();
    }
  },
  SLOW,
);

test(
  "RUN-18 the engine's own API backoff is not a terminal failure: 429 and 503 retry lines then a healthy result are ONE attempt, one child, one feed, no hold, no outage and no notice (design §4)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");
    const it = await stage();
    const backoff = (status: number, attempt: number) => ({
      type: "system",
      subtype: "api_retry",
      attempt,
      max_retries: 10,
      retry_delay_ms: 623 * attempt,
      error_status: status,
      error: "rate_limit",
    });
    const loop = realLoopOver([[INIT, backoff(429, 1), backoff(503, 2), healthyResult(ANSWER)]], true);
    let runner: { stop(): Promise<void> } | null = null;
    try {
      await insertInbound(cluster, it.db, { id: "rr-backoff", body: "a turn the provider asked to wait for" });
      runner = (await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { "claude-code": loop.adapter },
      })) as { stop(): Promise<void> };
      await until(
        "the message was answered by the attempt that backed off",
        async () => (await it.read.outbox()).some((row) => row.inbound_id === "rr-backoff"),
        45_000,
        async () => `inbound=${JSON.stringify(await it.read.inbound())} starts=${loop.starts()}`,
      );
      await Bun.sleep(RETRY_SECONDS * 1000 + 1000);
      expect(loop.starts(), "one child for the whole of it").toBe(1);
      expect(await it.read.sql("select state from execution where inbound_id = 'rr-backoff'")).toEqual([
        { state: "completed" },
      ]);
      expect(await it.read.sql("select 1 from replay_hold")).toEqual([]);
      expect((await it.read.outbox()).filter((row) => row.inbound_id === "rr-backoff").map((row) => row.body)).toEqual([ANSWER]);
      expect(await it.read.ledger({ stream: "refusal" })).toEqual([]);
      expect(await it.read.outageSheet()).toEqual([]);
      expect(await it.read.noticeRows()).toEqual([]);
    } finally {
      if (runner) await runner.stop();
      await it.stop();
    }
  },
  SLOW,
);
