// During an outage exactly one notice per person exists and zero
// per-row apologies, and when it clears one catch-up line says how much was
// waiting.
//
// SPEC §6 and L10 rule 3: "Identical failures across agents are one notice per
// person naming the cause, sent once, and one 'it works again, catching up on N
// messages' when it clears. Waiting rows stay waiting, nothing is handed to a
// human as 'could not answer', and the runners retry on their own on a fixed
// interval." Its Forbidden carries "a per-message apology for a household-wide
// cause". Its Check line is the name of the first test below.
//
// Staged the way L10's own incident was: TWO persons, TWO agents, TWO runners,
// ONE credential. A one-runner check would pass a build whose notice is a flag
// in one process's memory.
//
// TWO SCRIPTED LOOPS, one per runner, and it is a fixture choice worth stating.
// One fixture serves one open turn at a time (`turn` is a single field on it),
// so two runners feeding it concurrently could interleave two turns into one.
// That would be a fixture defect wearing a runner's clothes. Each runner gets
// its own, both refuse, and the check drives them together.
//
// Every string a person reads is asserted IN FULL, in that person's own
// language, against the pinned table. A check that asserted three
// fragments would pass a sentence with anything between them, and these are
// sentences a household reads on a phone.
//
// Red reason for both: import missing, `src/runner/outage.ts`. Against today's
// code the assertion that fires first is the zero-apologies one: the shipped
// runner calls `settleTurn(store, { chunks: [end.text] })` unconditionally, so
// every refused turn writes a chunk that references the person's own message.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { startCluster, seam, until, type Cluster } from "./helpers/cluster.ts";
import { createScriptedAdapter, scriptedReply } from "./helpers/scripted-adapter.ts";
import {
  AGENT,
  AGENT2,
  CHAT,
  DOOR,
  PERSON,
  PERSON2,
  insertInbound,
  stageHub,
  type StagedHub,
} from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 120_000;
const RUNNER_PI = "runner-pi";
const RUNNER_MAC = "runner-mac";
/** The first person's second agent, on the first person's own runner. */
const AGENT_B = "p1-study";
const CREDENTIAL = "household-claude";
/** Short on purpose, so the retry is seconds and the check is not a minute. */
const RETRY_SECONDS = 2;

/** The pinned strings, written out by the TEST and never imported. */
const OUTAGE_LOGIN = {
  en: `[door] the model login was refused. Messages are waiting and nothing is lost. I try again every ${RETRY_SECONDS} s and will say when it works.`,
  ru: `[дверь] вход в модель отклонён. Сообщения ждут, ничего не потеряно. Повторяю попытку каждые ${RETRY_SECONDS} с и сообщу, когда заработает.`,
};

function catchUp(language: "en" | "ru", count: number): string {
  return language === "en"
    ? `[door] it works again. Messages waiting: ${count}.`
    : `[дверь] снова работает. Сообщений в очереди: ${count}.`;
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

interface Staged {
  it: StagedHub;
  loops: Record<string, ReturnType<typeof createScriptedAdapter>>;
}

/**
 * Two persons, two agents on two runners, one credential, and a short retry.
 *
 * `tick_seconds` is 30 and the retry is 2, so a row that comes back inside
 * three seconds can only have come back on the deadline the row itself
 * carries. That is assertion 7, and it is why the tick is long.
 */
async function stageOutage(options: { refusals: number; declare?: boolean }): Promise<Staged> {
  const declare = options.declare !== false;
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 30, outage_retry_seconds: RETRY_SECONDS },
    people: [
      { id: PERSON, language: "en" },
      { id: PERSON2, language: "ru" },
    ],
    ...(declare
      ? {
          credentials: [
            {
              id: CREDENTIAL,
              kind: "claude-login",
              file: "/var/lib/imprnt-hub/credentials/claude.json",
              owner: "household",
            },
          ],
        }
      : {}),
    ...(declare ? { preset: { credential: CREDENTIAL } } : {}),
    agents: [
      {
        id: AGENT2,
        person: PERSON2,
        preset: "daily",
        chat: `${CHAT}1`,
        door: DOOR,
        runner: RUNNER_MAC,
      },
      // A SECOND AGENT FOR THE FIRST PERSON (the lead A). One
      // agent per person cannot tell a notice keyed on the person from one
      // keyed on the agent, because the two sets are the same size. With two
      // agents here, an agent-keyed build writes three notices and fails the
      // count.
      {
        id: AGENT_B,
        person: PERSON,
        preset: "daily",
        chat: `${CHAT}2`,
        door: DOOR,
        runner: RUNNER_PI,
      },
    ],
    // The default agent is on `runner-test`, and this registry puts one agent
    // on each of two runners instead.
    registry: (base) => ({
      ...base,
      agents: (base.agents ?? []).map((agent) =>
        agent.id === AGENT ? { ...agent, runner: RUNNER_PI } : agent,
      ),
    }),
  });
  // A refused turn was handed to the engine, so its input is HELD (design §4) with the exit proof of the
  // loop it was fed to. The scripted loop has no process of its own (`exitProof`), and it says it can
  // resume an interrupted conversation, so the rows behind a held one are fed in their turn on the
  // recorded interval and are refused and held in theirs.
  const loopOptions = {
    name: it.adapterName,
    refusals: options.refusals,
    exitProof: true,
    capabilities: { stableSession: true, safeResume: true, delegationDisabled: true },
  };
  const loops: Record<string, ReturnType<typeof createScriptedAdapter>> = {
    [RUNNER_PI]: createScriptedAdapter(loopOptions),
    [RUNNER_MAC]: createScriptedAdapter(loopOptions),
  };
  for (const loop of Object.values(loops)) {
    loop.setUsage({ input_tokens: null, cached_input_tokens: null, output_tokens: null,
      plan_usage: null, raw: { evidence: { kind: "authenticated-response", status: options.refusals > 0 ? 401 : 200,
        credential: declare ? CREDENTIAL : "preset:daily" } } });
  }
  return { it, loops };
}

async function startRunner(
  staged: Staged,
  id: string,
): Promise<{ stop(): Promise<void> }> {
  const { runRunner } = await seam("src/runner/run.ts");
  return (await (runRunner as Function)({
    runner: id,
    registryFile: staged.it.registryFile,
    adapters: { [staged.it.adapterName]: staged.loops[id].adapter },
  })) as { stop(): Promise<void> };
}

/** The five messages of the incident: three for one person, two for the other. */
const MESSAGES = [
  { id: "out-1", agent: AGENT, person: PERSON, body: "the first thing p1 asked" },
  { id: "out-2", agent: AGENT, person: PERSON, body: "the second thing p1 asked" },
  { id: "out-3", agent: AGENT, person: PERSON, body: "the third thing p1 asked" },
  // The first person's OTHER agent, so one person is waiting on two of them.
  { id: "out-6", agent: AGENT_B, person: PERSON, body: "what p1 asked the other agent" },
  { id: "out-4", agent: AGENT2, person: PERSON2, body: "the first thing p2 asked" },
  { id: "out-5", agent: AGENT2, person: PERSON2, body: "the second thing p2 asked" },
];

async function plantMessages(it: StagedHub): Promise<void> {
  for (const message of MESSAGES) {
    await insertInbound(cluster, it.db, {
      id: message.id,
      body: message.body,
      person: message.person,
      agent: message.agent,
    });
  }
}

/**
 * Every message has been through a turn once, whichever way this build ends
 * one: a settled turn writes a `turn` line and a refused one writes a
 * `refusal` line, both keyed on the message. The condition therefore reaches
 * its bound in the world this check is in AND in the world a later build
 * makes, so the red below is an assertion and never a timeout.
 */
async function everyMessageSeen(it: StagedHub): Promise<boolean> {
  const rows = await it.read.sql(
    `select distinct subject from ledger_event
      where stream in ('turn', 'refusal')
        and subject in (${MESSAGES.map((_, nth) => `$${nth + 1}`).join(", ")})`,
    MESSAGES.map((m) => m.id),
  );
  return rows.length === MESSAGES.length;
}

test(
  "RUN-18 during a refused-login outage exactly one notice per person exists and zero per-row apologies: five rows wait on a recorded retry, the diary says why for each, and a restarted runner writes no second notice (SPEC §6, L10 rule 3)",
  async () => {
    const staged = await stageOutage({ refusals: 500 });
    const it = staged.it;
    let pi: { stop(): Promise<void> } | null = null;
    let mac: { stop(): Promise<void> } | null = null;
    try {
      await plantMessages(it);
      pi = await startRunner(staged, RUNNER_PI);
      mac = await startRunner(staged, RUNNER_MAC);

      await until(
        "every message had its turn refused",
        () => everyMessageSeen(it),
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );

      // --- 1. ZERO APOLOGIES, phrased as a property:
      //     no outbox row references an inbound row that was refused. A
      //     build that wrote an EMPTY chunk fails this too, which is the point
      //     of counting rows rather than reading their text.
      const chunks = await it.read.outbox();
      const ids = new Set(MESSAGES.map((m) => m.id));
      expect(chunks.filter((row) => ids.has(String(row.inbound_id)))).toEqual([]);

      // --- 2. exactly one OUTAGE notice per person, with ONE `since` between
      //     them, and each body in that person's own language, in full. (An
      //     input the engine was handed and refused is also held, and its owner
      //     told so, which is a notice of its own: `hold:`, one per attempt.)
      const outageNoticesOf = async () =>
        (await it.read.noticeRows()).filter((row) => String(row.notice_key).startsWith("outage:"));
      const notices = await outageNoticesOf();
      expect(notices.length).toBe(2);
      const byPerson = new Map(notices.map((row) => [row.person, row]));
      expect([...byPerson.keys()].sort()).toEqual([PERSON, PERSON2]);
      const keys = notices.map((row) => String(row.notice_key));
      for (const key of keys) expect(key.startsWith(`outage:${CREDENTIAL}:`)).toBe(true);
      const sinces = keys.map((key) => key.split(":").slice(2, -1).join(":"));
      // THE WHOLE ARITHMETIC: the `since` is the outage sheet's own, so both
      // runners compute the same key. A build that took its own clock writes
      // two keys and, after a restart, two more.
      expect(new Set(sinces).size).toBe(1);
      expect(keys.sort()).toEqual(
        [
          `outage:${CREDENTIAL}:${sinces[0]}:${PERSON}`,
          `outage:${CREDENTIAL}:${sinces[0]}:${PERSON2}`,
        ].sort(),
      );
      expect(byPerson.get(PERSON)?.body).toBe(OUTAGE_LOGIN.en);
      expect(byPerson.get(PERSON2)?.body).toBe(OUTAGE_LOGIN.ru);
      // The agent on the row is one of that person's own, so the door that
      // serves them is the door that posts it.
      expect(byPerson.get(PERSON)?.agent).toBe(AGENT);
      expect(byPerson.get(PERSON2)?.agent).toBe(AGENT2);

      // --- 3. the rows are HELD, and none is handed to a human as could not
      //     answer. Each was fed once, refused, and ended as a terminal attempt
      //     with the exit proof of its loop; nothing is claimed.
      const waiting = await it.read.inbound();
      expect(waiting.length).toBe(MESSAGES.length);
      for (const row of waiting) {
        // The measured wire replays the user line, so a refused row is
        // `acked`. Never `started` and never `answered`: nothing was handed
        // to a human as could not answer.
        expect(["received", "acked"]).toContain(row.state);
        expect([null, RUNNER_PI, RUNNER_MAC]).toContain(row.claimed_by);
      }
      const attempts = (await it.read.sql(
        "select inbound_id, state from execution order by inbound_id",
      )) as { inbound_id: string; state: string }[];
      expect(attempts.map((row) => [row.inbound_id, row.state])).toEqual(
        [...ids].sort().map((id) => [id, "interrupted"]),
      );
      const holds = (await it.read.sql(
        "select inbound_id, cause, state, revision from replay_hold order by inbound_id",
      )) as { inbound_id: string; cause: string; state: string; revision: number }[];
      expect(holds.map((row) => [row.inbound_id, row.cause, row.state, row.revision])).toEqual(
        [...ids].sort().map((id) => [id, "interrupted", "held", 1]),
      );

      // --- 4. the diary says why, once per message. The household can see
      //     every refused turn and no PERSON saw any of them.
      const refused = await it.read.ledger({ stream: "refusal", kind: "refused.outage" });
      expect(refused.length).toBe(MESSAGES.length);
      expect(new Set(refused.map((row) => row.subject))).toEqual(new Set(ids));
      for (const row of refused) {
        expect(row.actor).toBe("runner");
        expect(String(row.detail.cause)).toBe("login");
        expect(String(row.detail.said).length).toBeGreaterThan(0);
      }

      // --- 5. the sheet. One row for the credential, whichever runner got
      //     there first, carrying what the other one read off it.
      const sheet = await it.read.outageSheet();
      expect(sheet.length).toBe(1);
      expect(sheet[0].id).toBe(CREDENTIAL);
      expect(sheet[0].data.cause).toBe("login");
      expect(String(sheet[0].data.since)).toBe(sinces[0]);
      expect(String(sheet[0].data.said).length).toBeGreaterThan(0);
      expect([RUNNER_PI, RUNNER_MAC]).toContain(String(sheet[0].data.reported_by));

      // --- 6. NOTHING THAT WAS FED IS FED AGAIN, and it is asserted BEFORE
      //     anything is restarted. This used to be the retry of every refused
      //     row on its own clock (L10 rule 3); a row the engine was handed is
      //     now held (design §4), so past the retry interval, twice over, no
      //     message has a second refusal, a second attempt or a second feed.
      await Bun.sleep(RETRY_SECONDS * 2000 + 1000);
      const refusalsAt = async (): Promise<Map<string, number[]>> => {
        const rows = await it.read.ledger({ stream: "refusal", kind: "refused.outage" });
        const byMessage = new Map<string, number[]>();
        for (const row of rows) {
          const at = new Date(row.at as unknown as string).getTime();
          byMessage.set(String(row.subject), [...(byMessage.get(String(row.subject)) ?? []), at]);
        }
        return byMessage;
      };
      expect([...(await refusalsAt()).values()].map((at) => at.length), "every message was refused exactly once").toEqual(
        MESSAGES.map(() => 1),
      );
      expect(
        Object.values(staged.loops).flatMap((loop) => loop.fed().map((one) => one.id)).sort(),
        "and fed exactly once",
      ).toEqual(MESSAGES.map((message) => message.id).sort());
      expect(
        ((await it.read.sql("select inbound_id from execution")) as unknown[]).length,
        "one attempt per message",
      ).toBe(MESSAGES.length);

      // WHAT WAS NEVER FED STILL WAITS ON THE FIXED INTERVAL, both ends. The
      // agent with three messages had its first refused; the other two were not
      // handed to the engine, so they were not held: they waited out
      // `hub.outage_retry_seconds` and were tried in their turn, one interval
      // apart, and not one straight after the other into an engine that had
      // just refused (each of them would have been a held input). The floor is
      // the interval less a second of slack, because a deadline wakes a moment
      // past itself and two runners share one clock, and the ceiling the
      // interval plus three, which covers a turn that was mid-flight when the
      // wait came due.
      const at = await refusalsAt();
      const floorMs = RETRY_SECONDS * 1000 - 1000;
      const ceilingMs = RETRY_SECONDS * 1000 + 3000;
      for (const agentMessages of [[ "out-1", "out-2", "out-3" ], [ "out-4", "out-5" ]]) {
        const times = agentMessages.map((id) => at.get(id)![0]).sort((a, b) => a - b);
        for (let n = 1; n < times.length; n++) {
          const gap = times[n] - times[n - 1];
          if (gap < floorMs || gap > ceilingMs) {
            throw new Error(
              `${agentMessages[n]} was tried ${gap} ms after the one before it, and hub.outage_retry_seconds is ${RETRY_SECONDS}: it has to wait between ${floorMs} and ${ceilingMs} ms, so this is not the fixed interval the file asks for`,
            );
          }
        }
      }

      // --- 7. A RESTART WRITES NOTHING MORE. That is the case v2's own
      //     UNIQUE(reply_key, seq) was for, and the one a flag in memory fails.
      //     The outage notices stay two, the hold notices stay one per attempt,
      //     and nothing held is fed on the way up.
      await pi!.stop();
      pi = null;
      const before = (await it.read.noticeRows()).length;
      pi = await startRunner(staged, RUNNER_PI);
      await Bun.sleep(RETRY_SECONDS * 1000 + 1500);
      expect((await it.read.noticeRows()).length).toBe(before);
      expect((await outageNoticesOf()).length).toBe(2);
      expect((await it.read.noticeRows()).filter((row) => String(row.notice_key).startsWith("hold:")).length).toBe(MESSAGES.length);
      expect(Object.values(staged.loops).flatMap((loop) => loop.fed()).length, "nothing held was fed on the way up").toBe(MESSAGES.length);
    } finally {
      if (pi) await pi.stop();
      if (mac) await mac.stop();
      await it.stop();
    }

    // --- 8. the undeclared fallback. The file loads, the
    //     outage keys off `credentialOf`'s fallback, and the rule holds. A
    //     household that has not written the table yet gets it anyway, and
    //     `check` is meanwhile telling it to write one.
    const bare = await stageOutage({ refusals: 500, declare: false });
    let pi3: { stop(): Promise<void> } | null = null;
    let mac3: { stop(): Promise<void> } | null = null;
    try {
      await plantMessages(bare.it);
      pi3 = await startRunner(bare, RUNNER_PI);
      mac3 = await startRunner(bare, RUNNER_MAC);
      await until(
        "every message had its turn refused",
        () => everyMessageSeen(bare.it),
        45_000,
        async () => JSON.stringify(await bare.it.read.inbound()),
      );

      // The outage notices are the household's, one per person; each held input has a notice of its own (`hold:`).
      const notices = (await bare.it.read.noticeRows()).filter((row) => !String(row.notice_key).startsWith("hold:"));
      expect(notices.length).toBe(2);
      for (const row of notices) {
        expect(String(row.notice_key).startsWith("outage:preset:daily:")).toBe(true);
      }
      expect((await bare.it.read.outageSheet()).map((row) => row.id)).toEqual([
        "preset:daily",
      ]);
    } finally {
      if (pi3) await pi3.stop();
      if (mac3) await mac3.stop();
      await bare.it.stop();
    }

    // --- THE CONTROL, without which this is a check on a runner that does
    //     nothing: the same stage with the loop ANSWERING lands five replies,
    //     five answered stamps and zero notices.
    const healthy = await stageOutage({ refusals: 0 });
    let pi2: { stop(): Promise<void> } | null = null;
    let mac2: { stop(): Promise<void> } | null = null;
    try {
      await plantMessages(healthy.it);
      pi2 = await startRunner(healthy, RUNNER_PI);
      mac2 = await startRunner(healthy, RUNNER_MAC);
      await until(
        "every message was answered",
        async () => (await healthy.it.read.outbox()).length >= MESSAGES.length,
        45_000,
        async () => JSON.stringify(await healthy.it.read.inbound()),
      );
      const chunks = await healthy.it.read.outbox();
      expect(chunks.length).toBe(MESSAGES.length);
      for (const message of MESSAGES) {
        const its = chunks.filter((row) => row.inbound_id === message.id);
        expect(its.length).toBe(1);
        expect(its[0].body).toBe(scriptedReply(message.body));
      }
      const answered = await healthy.it.read.ledger({ stream: "inbound", kind: "answered" });
      expect(answered.length).toBe(MESSAGES.length);
      expect((await healthy.it.read.noticeRows()).length).toBe(0);
      expect(await healthy.it.read.outageSheet()).toEqual([]);
    } finally {
      if (pi2) await pi2.stop();
      if (mac2) await mac2.stop();
      await healthy.it.stop();
    }
  },
  SLOW,
);

test(
  "RUN-18 one 'it works again' line per person carries the count that was waiting, no held row is answered or fed again by it, a fresh message is answered, and the sheet is empty rather than carrying a fixed flag (SPEC §6, L10 rule 3, L17, design §4)",
  async () => {
    // The module the catch-up lives in, read first so this check is red on the
    // missing seam rather than inside a reader of a column the schema has not
    // got yet. The key shape below is the test's own and is never imported.
    const { OUTAGE_SHEET, noticeKey, clearOutage } = await seam("src/runner/outage.ts");
    expect(OUTAGE_SHEET).toBe("outage");
    expect(typeof noticeKey).toBe("function");
    expect(typeof clearOutage).toBe("function");

    const staged = await stageOutage({ refusals: 500 });
    const it = staged.it;
    let pi: { stop(): Promise<void> } | null = null;
    let mac: { stop(): Promise<void> } | null = null;
    try {
      await plantMessages(it);
      pi = await startRunner(staged, RUNNER_PI);
      mac = await startRunner(staged, RUNNER_MAC);
      await until(
        "every message had its turn refused",
        () => everyMessageSeen(it),
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );

      const outage = (await it.read.noticeRows()).filter((row) => String(row.notice_key).startsWith("outage:"));
      expect(outage.length).toBe(2);
      const since = String(outage[0].notice_key).split(":").slice(2, -1).join(":");

      // --- the loop works again. The rows the engine was handed and refused are
      //     HELD (design §4), so nothing retries them: it is found out by the
      //     next message a person sends, which is a fresh input.
      for (const loop of Object.values(staged.loops)) {
        loop.setUsage({ input_tokens: 12, cached_input_tokens: 3, output_tokens: 7,
          plan_usage: null, raw: { evidence: { kind: "authenticated-response", status: 200, credential: CREDENTIAL } } });
      }
      staged.loops[RUNNER_PI].setRefusal(null);
      staged.loops[RUNNER_MAC].setRefusal(null);
      await Bun.sleep(RETRY_SECONDS * 1000 + 1000);
      expect(
        (await it.read.ledger({ stream: "inbound", kind: "answered" })).length,
        "the loop working again answers nothing that was held",
      ).toBe(0);
      expect(await it.read.outageSheet(), "and nothing has yet shown that it works").toHaveLength(1);

      await insertInbound(cluster, it.db, {
        id: "out-7",
        body: "one more thing p1 asked",
        person: PERSON,
        agent: AGENT,
      });
      await until(
        "the fresh message was answered",
        async () => (await it.read.outbox()).some((row) => row.inbound_id === "out-7"),
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      await Bun.sleep(1500);

      // --- 1 and 2. one catch-up per person, carrying the count that was
      //     waiting for that credential's agents at the moment it cleared. A
      //     held input is not "waiting": nothing will answer it by itself.
      const all = await it.read.noticeRows();
      const catchUps = all.filter((row) => String(row.notice_key).startsWith("outage-over:"));
      expect(catchUps.length).toBe(2);
      const byPerson = new Map(catchUps.map((row) => [row.person, row]));
      expect(byPerson.get(PERSON)?.notice_key).toBe(
        `outage-over:${CREDENTIAL}:${since}:${PERSON}`,
      );
      expect(byPerson.get(PERSON2)?.notice_key).toBe(
        `outage-over:${CREDENTIAL}:${since}:${PERSON2}`,
      );
      // N is that person's own count and never the total. The Russian line is
      // asserted in full because `Сообщений в очереди: {count}` is written the
      // way it is to be correct for every count, which a reader would see at
      // once if it were not.
      expect(byPerson.get(PERSON)?.body).toBe(catchUp("en", 1));
      expect(byPerson.get(PERSON2)?.body).toBe(catchUp("ru", 0));

      // --- 3. the fresh message is answered once, by a loop that was handed the
      //     recovery context with it; no held row has a reply or a second feed.
      const chunks = await it.read.outbox();
      for (const message of MESSAGES) {
        expect(chunks.filter((row) => row.inbound_id === message.id), `${message.id} stays held`).toEqual([]);
      }
      const fresh = chunks.filter((row) => row.inbound_id === "out-7");
      expect(fresh.length).toBe(1);
      expect(String(fresh[0].body)).toStartWith("reply to [Hub recovery context]");
      expect(String(fresh[0].body)).toEndWith("one more thing p1 asked");
      expect(
        Object.values(staged.loops).flatMap((loop) => loop.fed().map((one) => one.id)).sort(),
      ).toEqual([...MESSAGES.map((message) => message.id), "out-7"].sort());
      expect(((await it.read.sql("select inbound_id from execution")) as unknown[]).length).toBe(MESSAGES.length + 1);

      // --- 4. the sheet is EMPTY. A thing that is gone leaves no line behind
      //     (L17), and a "fixed" flag underneath is what that entry forbids.
      expect(await it.read.outageSheet()).toEqual([]);

      // --- 5. the order a person reads: it stopped, then it works again, then
      //     the answer to the message that showed it.
      for (const person of [PERSON, PERSON2]) {
        const stopped = all.find(
          (row) => row.person === person && String(row.notice_key).startsWith("outage:"),
        )!;
        expect(byPerson.get(person)!.id).toBeGreaterThan(stopped.id);
      }
      expect(fresh[0].id).toBeGreaterThan(byPerson.get(PERSON)!.id);

      // --- 6. a second success writes no second catch-up.
      await insertInbound(cluster, it.db, {
        id: "out-8",
        body: "and another thing p1 asked",
        person: PERSON,
        agent: AGENT,
      });
      await until(
        "the extra message was answered",
        async () => (await it.read.outbox()).some((row) => row.inbound_id === "out-8"),
        45_000,
      );
      expect(
        (await it.read.noticeRows()).filter((row) =>
          String(row.notice_key).startsWith("outage-over:"),
        ).length,
      ).toBe(2);
    } finally {
      if (pi) await pi.stop();
      if (mac) await mac.stop();
      await it.stop();
    }
  },
  SLOW,
);
