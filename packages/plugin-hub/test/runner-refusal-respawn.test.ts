// RUN-18. After a refused turn the runner tries again on its own clock, WITH A
// LOOP THAT IS STILL THERE.
//
// SPEC §6 and L10 rule 3: "Waiting rows stay waiting, nothing is handed to a
// human as 'could not answer', and the runners retry on their own on a fixed
// interval." A retry onto a child that is gone is not a retry: it is the
// silence this phase is named after, produced by the phase's own code.
//
// WHY NO OTHER CHECK CAN FAIL ON IT. Every outage check drives
// `createScriptedAdapter`, whose session survives a refusal and answers turn
// after turn, and the gated real-binary check feeds exactly ONE turn and
// closes. The adapter ends a refused turn itself and CLOSES THE CHILD (D-118),
// because no retry fixes a dead credential and the runner owns the retry clock,
// so the handle the next turn would feed is a handle onto a process that is
// gone. Measured in bun 1.3.14: writing to a killed child's stdin returns
// normally and discards the bytes, so the second turn never ends and the
// agent's whole serving loop stops on an await with no bound.
//
// So this check drives the REAL `claudeCode` adapter, through the production
// `wrap` hook (03b item 1, D-120), across TWO turns: the first invocation of
// the scripted CLI emits the measured 401 `api_retry` wire and holds, and the
// second emits a healthy turn. What is bound is that the runner comes back with
// a NEW child and answers the message it held.
//
// The wire shapes are the ones measured on 2026-09-16 and recorded in
// 04-BRIEF.md, quoted in test/adapter-refusal.test.ts's own header:
//   {"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,
//    "retry_delay_ms":623,"error_status":401,"error":"authentication_failed"}
// once per attempt, with rising delays and no `result` written meanwhile.
//
// Red reason: behaviour absent. The runner's refusal branch releases the row and
// returns without touching `own.session`, and `spawn` is reached only when the
// preset id changed or the memory watch killed the child, so the retry feeds a
// dead process and no turn end ever arrives.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import { fakeClaudeCli } from "./helpers/fake-cli.ts";
import { childGone } from "./helpers/scripted-adapter.ts";
import {
  AGENT,
  PERSON,
  RUNNER,
  insertInbound,
  stageHub,
  type StagedHub,
} from "./helpers/hub-fixture.ts";
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

function healthyResult(text: string): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    terminal_reason: "stop",
    result: text,
    num_turns: 1,
    session_id: "a-session",
    usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 },
    total_cost_usd: 0,
  };
}

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
 * own session. The runner supplies a `wrap` of its own only for a boxed agent
 * (a person with a tree), and these stages declare none, so this is the one
 * place a check can put a measured wire in front of a runner.
 */
function realLoopOver(
  scripts: Record<string, unknown>[][],
  hold: number[],
): { adapter: Adapter; pids(): number[]; starts(): number } {
  const pids: number[] = [];
  return {
    adapter: {
      name: "claude-code",
      async start(options): Promise<AdapterSession> {
        const { claudeCode } = await seam("src/adapters/claude-code.ts");
        const nth = Math.min(pids.length, scripts.length - 1);
        const session = (await (claudeCode as { start: Function }).start({
          ...options,
          wrap: fakeClaudeCli(scripts[nth], { holdMs: hold[nth] ?? 0 }),
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
    people: [{ id: PERSON, language: "en" }],
    credentials: [
      {
        id: CREDENTIAL,
        kind: "claude-login",
        file: "/var/lib/imprnt-hub/credentials/claude.json",
        owner: "household",
      },
    ],
    preset: { credential: CREDENTIAL, adapter: "claude-code" },
    registry: (base) => ({
      ...base,
      agents: (base.agents ?? []).map((agent) => ({ ...agent, runner: RUNNER })),
    }),
  });
}

test(
  "RUN-18 a runner whose loop refused a turn comes back with a NEW child and answers the message it held: the adapter closes the child on the measured 401 retry wire, and the retry the row carries is fed to a loop that is there (SPEC §6, L10 rule 3)",
  async () => {
    const { runRunner } = await seam("src/runner/run.ts");

    const it = await stage();
    const loop = realLoopOver(
      [
        // Turn one: the measured refused-credential wire, and then silence, the
        // way the real CLI is silent between its rising retries.
        [INIT, RETRY_401],
        // Turn two: the credential works again.
        [INIT, healthyResult(ANSWER)],
      ],
      [60_000, 0],
    );
    let runner: { stop(): Promise<void> } | null = null;

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
      const sheet = await it.read.outageSheet();
      expect(sheet.length).toBe(1);
      expect(sheet[0].id).toBe(CREDENTIAL);
      expect(sheet[0].data.cause).toBe("login");
      const notices = await it.read.noticeRows();
      expect(notices.length).toBe(1);
      expect(notices[0].person).toBe(PERSON);
      expect(String(notices[0].notice_key).startsWith(`outage:${CREDENTIAL}:`)).toBe(true);

      // --- 2. THE CHILD IS GONE. The adapter ends the turn on the first 401
      //     and closes it, because no retry fixes a dead credential and the
      //     CLI would go on retrying for minutes (D-118).
      expect(loop.starts()).toBe(1);
      const first = loop.pids()[0];
      expect(first).toBeGreaterThan(0);
      await Bun.sleep(300);
      expect(childGone(first)).toBe(true);

      // --- 3. THE RETRY IS FED TO A LOOP THAT IS THERE, and this is the whole
      //     check. `tick_seconds` is 30 and the retry is 2, so the row can only
      //     have come back on its own recorded deadline, and the turn that
      //     answers it can only have run on a child this runner started after
      //     the first one died.
      await until(
        "the held row was answered after the retry, by a loop that was started again",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "answered", subject: "rr-1" }))
            .length >= 1,
        RETRY_SECONDS * 1000 + 20_000,
        async () =>
          `starts=${loop.starts()} pids=${JSON.stringify(loop.pids())} ` +
          `inbound=${JSON.stringify(await it.read.inbound())} ` +
          `refusals=${JSON.stringify(
            (await it.read.ledger({ stream: "refusal" })).map((row) => row.kind),
          )}`,
      );
      expect(loop.starts()).toBeGreaterThanOrEqual(2);
      const second = loop.pids()[loop.pids().length - 1];
      expect(second).toBeGreaterThan(0);
      expect(second).not.toBe(first);
      // The one that answered is alive, so what ran the second turn is a real
      // child and not a handle onto the first one's corpse.
      expect(childGone(second)).toBe(false);

      // --- 4. the answer is the loop's own, and it reached the outbox once.
      const chunks = (await it.read.outbox()).filter((row) => row.inbound_id === "rr-1");
      expect(chunks.length).toBe(1);
      expect(chunks[0].body).toBe(ANSWER);

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
      await it.stop();
    }

    // --- THE CONTROL, without which this is a check on a runner that respawns
    //     whatever happens: the same stage with the FIRST wire healthy answers
    //     on the first child, opens no outage, tells nobody anything, and never
    //     starts a second loop.
    const fine = await stage();
    const healthy = realLoopOver([[INIT, healthyResult(ANSWER)]], [0]);
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
