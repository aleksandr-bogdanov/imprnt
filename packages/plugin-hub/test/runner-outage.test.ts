// RUN-18. During an outage exactly one notice per person exists and zero
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
// language, against 04-CONTEXT's pinned table. A check that asserted three
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

/** 04-CONTEXT's pinned strings, written out by the TEST and never imported. */
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
      // A SECOND AGENT FOR THE FIRST PERSON (the second seat's lead A). One
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
  const loops: Record<string, ReturnType<typeof createScriptedAdapter>> = {
    [RUNNER_PI]: createScriptedAdapter({ name: it.adapterName, refusals: options.refusals }),
    [RUNNER_MAC]: createScriptedAdapter({ name: it.adapterName, refusals: options.refusals }),
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
 * its bound in the world this round is in AND in the world the build round
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

      // --- 1. ZERO APOLOGIES, phrased as the property RUN-18's Forbidden line
      //     names: no outbox row references an inbound row that was refused. A
      //     build that wrote an EMPTY chunk fails this too, which is the point
      //     of counting rows rather than reading their text.
      const chunks = await it.read.outbox();
      const ids = new Set(MESSAGES.map((m) => m.id));
      expect(chunks.filter((row) => ids.has(String(row.inbound_id)))).toEqual([]);

      // --- 2. exactly one notice per person, with ONE `since` between them,
      //     and each body in that person's own language, in full.
      const notices = await it.read.noticeRows();
      expect(notices.length).toBe(2);
      const byPerson = new Map(notices.map((row) => [row.person, row]));
      expect([...byPerson.keys()].sort()).toEqual([PERSON, PERSON2]);
      const keys = notices.map((row) => String(row.notice_key));
      for (const key of keys) expect(key.startsWith(`outage:${CREDENTIAL}:`)).toBe(true);
      const sinces = keys.map((key) => key.split(":").slice(2, -1).join(":"));
      // THE WHOLE OF D-122: the `since` is the outage sheet's own, so both
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

      // --- 3. the rows WAIT. Nothing was handed to a human as could not
      //     answer, nothing is claimed, and every one carries a retry.
      const waiting = await it.read.inbound();
      expect(waiting.length).toBe(MESSAGES.length);
      for (const row of waiting) {
        // D-121a: the measured wire replays the user line, so a refused row is
        // `acked` when it is released and every retry re-stamps it. Never
        // `started` and never `answered`, which is the whole of "the rows
        // wait": nothing was handed to a human as could not answer.
        expect(["received", "acked"]).toContain(row.state);
        // A CLAIM MAY BE IN FLIGHT AT THE MOMENT OF THIS READ. The retry here
        // is two seconds, so a row is picked up, refused and released over and
        // over while the check reads. What is bound is that no claim belongs
        // to anybody but the two runners of this household, and the row above
        // that never reached `started`.
        expect([null, RUNNER_PI, RUNNER_MAC]).toContain(row.claimed_by);
      }
      // Every row carries a retry, so the release is on a recorded deadline
      // and not on a tick. A row whose retry has just come due reads as past,
      // which is why this asks for the column rather than for the future.
      const retries = (await it.read.sql(
        "select id, retry_at from inbound where retry_at is not null",
      )) as Record<string, unknown>[];
      expect(retries.length).toBe(MESSAGES.length);

      // --- 4. the diary says why, once per message. The household can see
      //     every refused turn and no PERSON saw any of them.
      const refused = await it.read.ledger({ stream: "refusal", kind: "refused.outage" });
      expect(refused.length).toBeGreaterThanOrEqual(MESSAGES.length);
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

      // --- 6. THE RETRY, and it is asserted BEFORE anything is restarted (the
      //     second seat's finding: with the restart first, a runner that only
      //     revisits refused rows when it starts up passes this).
      //
      //     EVERY row is retried, not one. A runner that kept one row on its
      //     clock and abandoned the other five would satisfy a single-row
      //     assertion and leave four people waiting forever, and nothing else
      //     in this check would notice: an abandoned row writes no chunk.
      const secondRefusals = async (): Promise<Map<string, number[]>> => {
        const rows = await it.read.ledger({ stream: "refusal", kind: "refused.outage" });
        const byMessage = new Map<string, number[]>();
        for (const row of rows) {
          const at = new Date(row.at as unknown as string).getTime();
          byMessage.set(String(row.subject), [...(byMessage.get(String(row.subject)) ?? []), at]);
        }
        return byMessage;
      };
      await until(
        "every one of the messages was refused a second time, on its own clock",
        async () =>
          [...(await secondRefusals()).values()].filter((at) => at.length >= 2).length ===
          MESSAGES.length,
        45_000,
        async () =>
          JSON.stringify(
            [...(await secondRefusals()).entries()].map(([id, at]) => [id, at.length]),
          ),
      );

      // THE INTERVAL HAS A FLOOR AS WELL AS A CEILING. Without the floor, a
      // runner that spun on the row as fast as it could satisfies "not on the
      // tick" while burning a credential that is already refusing it, which is
      // the opposite of the fixed interval L10 rule 3 asks for. The floor is
      // the interval less a second of slack, because a deadline wakes a moment
      // past itself and two runners share one clock.
      const gaps = [...(await secondRefusals()).entries()].map(([id, at]) => {
        const ordered = [...at].sort((a, b) => a - b);
        return { id, gap: ordered[1] - ordered[0] };
      });
      expect(gaps.length).toBe(MESSAGES.length);
      // THE INTERVAL IS THE INTERVAL, both ends (the second pass's finding: a
      // ceiling of "under the tick" accepted a twenty second retry for a two
      // second setting, which is a household waiting ten times as long as its
      // own file says). The band is the setting less a second, because a
      // deadline wakes a moment past itself and two runners share one clock,
      // to the setting plus three, which covers a turn that was mid-flight
      // when the retry came due.
      const floorMs = RETRY_SECONDS * 1000 - 1000;
      const ceilingMs = RETRY_SECONDS * 1000 + 3000;
      for (const { id, gap } of gaps) {
        if (gap < floorMs || gap > ceilingMs) {
          throw new Error(
            `${id} was refused again after ${gap} ms, and hub.outage_retry_seconds is ${RETRY_SECONDS}: the retry has to land between ${floorMs} and ${ceilingMs} ms, so this is not the fixed interval the file asks for`,
          );
        }
      }

      // --- 7. A RESTART WRITES NOTHING MORE. That is the case v2's own
      //     UNIQUE(reply_key, seq) was for, and the one a flag in memory fails.
      await pi!.stop();
      pi = null;
      const before = (await it.read.noticeRows()).length;
      pi = await startRunner(staged, RUNNER_PI);
      await Bun.sleep(RETRY_SECONDS * 1000 + 1500);
      expect((await it.read.noticeRows()).length).toBe(before);
      expect((await it.read.noticeRows()).length).toBe(2);
    } finally {
      if (pi) await pi.stop();
      if (mac) await mac.stop();
      await it.stop();
    }

    // --- 8. the undeclared fallback. The file loads (04-01 check 3), the
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

      const notices = await bare.it.read.noticeRows();
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
  "RUN-18 one 'it works again' line per person carries the count that was waiting, every held row is answered, and the sheet is empty rather than carrying a fixed flag (SPEC §6, L10 rule 3, L17)",
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

      const outage = await it.read.noticeRows();
      expect(outage.length).toBe(2);
      const since = String(outage[0].notice_key).split(":").slice(2, -1).join(":");

      // --- the loop works again. Both runners find out by trying, which is
      //     the retry L10 rule 3 names.
      for (const loop of Object.values(staged.loops)) {
        loop.setUsage({ input_tokens: 12, cached_input_tokens: 3, output_tokens: 7,
          plan_usage: null, raw: { evidence: { kind: "authenticated-response", status: 200, credential: CREDENTIAL } } });
      }
      staged.loops[RUNNER_PI].setRefusal(null);
      staged.loops[RUNNER_MAC].setRefusal(null);

      await until(
        "every held row was answered",
        async () =>
          (await it.read.ledger({ stream: "inbound", kind: "answered" })).length >=
          MESSAGES.length,
        45_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      await Bun.sleep(1500);

      // --- 1 and 2. one catch-up per person, carrying the count that was
      //     waiting for that credential's agents at the moment it cleared.
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
      expect(byPerson.get(PERSON)?.body).toBe(catchUp("en", 4));
      expect(byPerson.get(PERSON2)?.body).toBe(catchUp("ru", 2));

      // --- 3. the rows are answered, once each, with their own reply.
      const chunks = await it.read.outbox();
      for (const message of MESSAGES) {
        const its = chunks.filter((row) => row.inbound_id === message.id);
        expect(its.length).toBe(1);
        expect(its[0].body).toBe(scriptedReply(message.body));
      }

      // --- 4. the sheet is EMPTY. A thing that is gone leaves no line behind
      //     (L17), and a "fixed" flag underneath is what that entry forbids.
      expect(await it.read.outageSheet()).toEqual([]);

      // --- 5. the order a person reads: it stopped, then it works again, then
      //     the answers.
      for (const [person, agent] of [
        [PERSON, AGENT],
        [PERSON2, AGENT2],
      ] as [string, string][]) {
        const stopped = all.find(
          (row) => row.person === person && String(row.notice_key).startsWith("outage:"),
        )!;
        const back = byPerson.get(person)!;
        const firstReply = chunks
          .filter((row) => MESSAGES.some((m) => m.id === row.inbound_id && m.agent === agent))
          .map((row) => row.id)
          .sort((a, b) => a - b)[0];
        expect(back.id).toBeGreaterThan(stopped.id);
        expect(firstReply).toBeGreaterThan(back.id);
      }

      // --- 6. a second success writes no second catch-up.
      await insertInbound(cluster, it.db, {
        id: "out-7",
        body: "one more thing p1 asked",
        person: PERSON,
        agent: AGENT,
      });
      await until(
        "the extra message was answered",
        async () => (await it.read.outbox()).some((row) => row.inbound_id === "out-7"),
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
