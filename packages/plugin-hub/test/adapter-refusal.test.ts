// The adapter's half: a loop that will not answer says so
// in a type, and the window it reports is normalised.
//
// SPEC §6 and L10 rule 3: "Waiting rows stay waiting, nothing is handed to a
// human as 'could not answer', and the runners retry on their own on a fixed
// interval." Its Forbidden carries "a per-message apology for a household-wide
// cause". Rule 4: "An agent on a per-token key has no window."
//
// EVERY WIRE SHAPE BELOW IS A MEASUREMENT, taken on 2026-09-16 and recorded in
// The CLI was 2.1.273 on this Mac and 2.1.258 on the hub box, and
// the no-login shape is identical on both in every field that matters. Nothing
// here invents a shape a loop might emit. The one shape that was never observed
// is a plan window actually used up, and it is not planted: what is planted is
// the `utilization` the loop really reports, which is the number v2's whole
// rule ran on.
//
// The three ungated checks drive the REAL `claudeCode` adapter through the
// PRODUCTION `wrap` hook: `Adapter.start` takes it, the adapter
// spawns whatever comes back, and the hook returns a small script that emits
// the measured lines. What is bound is the shipped adapter's own reading of a
// real shape, not a fake loop standing in for a real edge.
//
// The MEASURED no-login stream, with `CLAUDE_CONFIG_DIR` at an empty directory
// (exit 1, 42 ms, no network), after the replayed user line:
//   {"type":"system","subtype":"init","apiKeySource":"none", ...}
//   {"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text",
//     "text":"Not logged in · Please run /login"}]},"error":"authentication_failed",
//     "is_api_error_message":true, ...}
//   {"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error",
//     "result":"Not logged in · Please run /login","num_turns":1,"usage":{zeros},
//     "total_cost_usd":0, ...}
// `subtype` is `success` and `is_error` is true, which is the trap: an adapter
// that read `subtype` alone settles this as a reply and the person reads "Not
// logged in" as their answer.
//
// The MEASURED refused-key stream (ANTHROPIC_API_KEY set to an invalid key):
//   {"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,
//    "retry_delay_ms":623,"error_status":401,"error":"authentication_failed", ...}
// once per attempt, with delays 623, 1153, 2188, 4969, 8302, 18484, 35294 ms and
// rising. Seven had gone by when a 60 s alarm killed the probe, so the tenth
// lands minutes later and no `result` is written meanwhile.
//
// The MEASURED healthy `rate_limit_event`, verbatim with its real numbers:
//   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
//    "resetsAt":1789523400,"rateLimitType":"five_hour","overageStatus":"rejected",
//    "overageDisabledReason":"org_level_disabled","isUsingOverage":false,
//    "unifiedWindows":{"five_hour":{"utilization":0.27,"resetsAt":1789523400},
//    "seven_day":{"utilization":0.55,"resetsAt":1789808400}}}, ...}
// `utilization` is a fraction of 1 and `resetsAt` is unix SECONDS.
//
// Red reasons: export missing `TurnEnd.refused` plus behaviour absent for check
// 7 (the shipped adapter settles that `result` as a reply carrying "Not logged
// in"), behaviour absent for check 8 (`system` subtype `api_retry` is ignored
// entirely, so the planted stream produces no turn end at all), export missing
// `AdapterUsage.window` for check 9, and behaviour absent against the real
// binary for check 10.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { fakeClaudeCli, healthyResult } from "./helpers/fake-cli.ts";
import { claudeGate, gateSuffix, announceGate } from "./helpers/claude-gate.ts";
import { childGone, createScriptedAdapter } from "./helpers/scripted-adapter.ts";
import type { AdapterSession, TurnEnd } from "../src/adapters/types.ts";

const SLOW = 60_000;

/** What a turn end really carries, window fields included. */
type Ended = TurnEnd & {
  refused?: { cause: string; said: string } | null;
  usage: TurnEnd["usage"] & { window?: { utilization: number; resets_at: string | null } | null };
};

const gate = claudeGate();

let dir: string;

/** Sessions a check asked to keep open, so none survives this file. */
const handed: { close(): Promise<void> }[] = [];

beforeAll(() => {
  announceGate(gate, "check 10, the real loop with no login");
  dir = mkdtempSync(join(tmpdir(), "hub-adapter-refusal-"));
});

afterAll(async () => {
  for (const session of handed) await session.close().catch(() => {});
  handed.length = 0;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const PRESET = {
  adapter: "claude-code",
  effort: "medium",
  model: "a-model-name",
  paid: "plan",
  provider: "a-provider",
};

const INIT = { type: "system", subtype: "init", apiKeySource: "none" };

const NO_LOGIN_ASSISTANT = {
  type: "assistant",
  message: {
    model: "<synthetic>",
    content: [{ type: "text", text: "Not logged in · Please run /login" }],
  },
  error: "authentication_failed",
  is_api_error_message: true,
};

const NO_LOGIN_RESULT = {
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  duration_api_ms: 0,
  api_error_status: null,
  result: "Not logged in · Please run /login",
  num_turns: 1,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
  },
  total_cost_usd: 0,
};

const HEALTHY_RATE_LIMIT = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1789523400,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.27, resetsAt: 1789523400 },
      seven_day: { utilization: 0.55, resetsAt: 1789808400 },
    },
  },
};

function apiRetry(status: number): Record<string, unknown> {
  return {
    type: "system",
    subtype: "api_retry",
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 623,
    error_status: status,
    error: status === 401 ? "authentication_failed" : "upstream_error",
  };
}

interface Driven {
  end: Ended;
  session: AdapterSession & { pid: number | null };
  elapsedMs: number;
}

/**
 * One turn through the REAL adapter, with a bound of its own.
 *
 * The bound is what keeps a red cheap: against the shipped code some of these
 * streams produce no turn end at all, and a check that waited out bun's own
 * ninety seconds would cost the suite a minute and a half per assertion.
 */
async function driveTurn(options: {
  lines?: Record<string, unknown>[];
  /**
   * Variables the CHILD is started with, set through the production `wrap`
   * hook as an `env VAR=value` prefix on its own argv.
   *
   * MEASURED on 2026-09-16, and the reason this is not `process.env`: bun
   * snapshots the environment at startup, so a variable assigned to
   * `process.env` after that is NOT in a `Bun.spawn` child's environment
   * (`Bun.spawn(["/bin/sh","-c","echo $VAR"])` prints nothing for a variable
   * the parent set a line earlier). The first version of check 10 set
   * CLAUDE_CONFIG_DIR that way, the real binary never saw it, and it answered
   * the check's question with the owner's own login instead of refusing.
   */
  env?: Record<string, string>;
  boundMs?: number;
  /** The preset the loop is started with. The fixture's own by default. */
  preset?: typeof PRESET;
  text?: string;
  keepOpen?: boolean;
}): Promise<Driven> {
  const { claudeCode } = await seam("src/adapters/claude-code.ts");
  const bound = options.boundMs ?? 8000;
  const named = Object.entries(options.env ?? {});
  const envPrefix = named.length === 0
    ? null
    : (argv: string[]) => ["/usr/bin/env", ...named.map(([k, v]) => `${k}=${v}`), ...argv];
  let session: (AdapterSession & { pid: number | null }) | null = null;
  // A session the check is going to go on reading is closed by the CHECK, and
  // one whose turn never arrived is closed HERE whatever happens. A fixture
  // that left a child behind on the failure path holds the whole run open
  // after the reds have been printed, which is a helper crash wearing a
  // hang's clothes.
  let handedOver = false;
  try {
    session = (await (claudeCode as { start: Function }).start({
      preset: options.preset ?? PRESET,
      sessionId: null,
      ...(options.lines
        ? { wrap: fakeClaudeCli(options.lines) }
        : envPrefix
          ? { wrap: envPrefix }
          : {}),
    })) as AdapterSession & { pid: number | null };
    const ends: Ended[] = [];
    session.onTurnEnd((end) => ends.push(end as Ended));
    const started = Date.now();
    await session.feed({ id: "m1", text: options.text ?? "how many chunks does one reply take" });
    while (ends.length === 0 && Date.now() - started < bound) await Bun.sleep(25);
    if (ends.length === 0) {
      throw new Error(
        `the loop's turn never ended within ${bound} ms, so nothing said whether it refused`,
      );
    }
    handedOver = options.keepOpen === true;
    if (handedOver) handed.push(session);
    return { end: ends[0], session, elapsedMs: Date.now() - started };
  } finally {
    if (session && !handedOver) await session.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Check 7: the typed refusal off the measured no-login wire.
// ---------------------------------------------------------------------------

test(
  "RUN-18 a loop that refuses the login says so in a type and its sentence reaches no person: the measured no-login stream gives cause login and an EMPTY text, both routes to it are read, and a healthy stream refuses nothing (SPEC §6, L10 rule 3)",
  async () => {
    const driven = await driveTurn({
      lines: [INIT, NO_LOGIN_ASSISTANT, NO_LOGIN_RESULT],
    });
    const end = driven.end;

    expect(end.refused).not.toBeUndefined();
    expect(end.refused?.cause).toBe("login");
    // What the household later reads in its own diary is what the loop said,
    // copied. Nothing parses it.
    expect(String(end.refused?.said)).toContain("Not logged in");

    // THE ASSERTION THE SHIPPED CODE FAILS, and the one that matters. `subtype`
    // is `success`, so an adapter that reads it alone settles this as a reply,
    // the runner writes "Not logged in" into the outbox and the door posts it
    // to the person, which is the per-row apology L10 forbids by name.
    expect(end.text).toBe("");

    // No `rate_limit_event` is emitted with no login (measured), so there is no
    // window to report.
    expect(end.usage.window ?? null).toBeNull();

    // The second route, on its own: a stream with no `assistant` error line,
    // where the `result` is all there is. A build that bound to one of the two
    // events would miss the other.
    const resultOnly = await driveTurn({ lines: [INIT, NO_LOGIN_RESULT] });
    expect(resultOnly.end.refused?.cause).toBe("login");
    expect(resultOnly.end.text).toBe("");

    // --- THE CONTROL, and it is this check's discriminator. The same real
    //     adapter over the measured healthy order refuses nothing and answers
    //     with the result's own text. A build that reported a refusal on every
    //     turn passes everything above and fails here.
    const healthy = await driveTurn({
      lines: [
        INIT,
        HEALTHY_RATE_LIMIT,
        { type: "assistant", message: { content: [{ type: "text", text: "an answer" }] } },
        healthyResult("an answer"),
      ],
    });
    expect(healthy.end.refused ?? null).toBeNull();
    expect(healthy.end.text).toBe("an answer");
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 8: one retry line and not ten.
// ---------------------------------------------------------------------------

test(
  "RUN-18 a refused credential is one retry line and not ten: the adapter ends the turn on the FIRST 401 retry with no result in the stream at all, closes the child, and passes over a 503 that the loop should retry itself (SPEC §6, L10 rule 3)",
  async () => {
    // The stream plants the first `api_retry` and then says nothing for longer
    // than this check's own bound, exactly as the measured one does: the second
    // attempt is 1153 ms away and the tenth is minutes away.
    const driven = await driveTurn({
      lines: [INIT, apiRetry(401)],
      boundMs: 8000,
      keepOpen: true,
    });

    expect(driven.end.refused?.cause).toBe("login");
    expect(String(driven.end.refused?.said)).toContain("authentication_failed");
    expect(driven.end.text).toBe("");

    // The child is GONE. The runner owns the retry clock (L10 rule 3), so the
    // adapter releases the process rather than paying for ten rising delays.
    const pid = driven.session.pid;
    expect(typeof pid).toBe("number");
    await Bun.sleep(300);
    expect(childGone(Number(pid))).toBe(true);
    // And closing a session the adapter already closed is still safe.
    await driven.session.close();

    // --- control (a): a 503 is the loop's OWN to retry. The stream goes on and
    //     a later `result` is what ends the turn, with nothing refused. Without
    //     this an adapter that ended on every retry line passes the half above.
    const transient = await driveTurn({
      lines: [INIT, apiRetry(503), healthyResult("an answer after a wobble")],
    });
    expect(transient.end.refused ?? null).toBeNull();
    expect(transient.end.text).toBe("an answer after a wobble");

    // --- control (b): A 429 IS PASSED OVER TOO, exactly as the 503 above is.
    //     A 429 must NOT end the turn with cause
    //     `window`: "no retry fixes it" is an argument about a dead
    //     credential, a 429 is the provider asking the loop to wait, and the
    //     CLI's own backoff is what waits. Ending the turn on the first one
    //     killed the child, opened the household-wide outage and told every
    //     person on that credential the plan's allowance was gone, over one
    //     transient throttle.
    //
    //     Driven inline rather than through `driveTurn`, because what is bound
    //     is that NO turn end arrives and `driveTurn` exists to insist that one
    //     does.
    {
      const { claudeCode } = await seam("src/adapters/claude-code.ts");
      const session = (await (claudeCode as { start: Function }).start({
        preset: PRESET,
        sessionId: null,
        wrap: fakeClaudeCli([INIT, apiRetry(429)]),
      })) as AdapterSession & { pid: number | null };
      const ends: Ended[] = [];
      session.onTurnEnd((end) => ends.push(end as Ended));
      await session.feed({ id: "m1", text: "a turn the provider asked to wait for" });
      await Bun.sleep(3000);
      // The turn is still open, so the loop is still the one retrying it.
      expect(ends.length).toBe(0);
      // AND THE CHILD IS STILL THERE, which is what lets the CLI's own backoff
      // run at all.
      expect(childGone(Number(session.pid))).toBe(false);
      await session.close();
    }

    // --- control (c): what DOES say the window is gone, on the unmeasured
    //     route. A `result` that ends the turn with `is_error` and names a rate
    //     limit is cause `window`, and it is read off the event's `error` field
    //     as well as its text, because a result carrying the sentence in `error` beside
    //     `terminal_reason: "api_error"` would otherwise be read as a dead
    //     login and tell a household to go and log in again.
    const usedUp = await driveTurn({
      lines: [
        INIT,
        {
          type: "result",
          subtype: "success",
          is_error: true,
          terminal_reason: "api_error",
          error: "rate limit reached for this plan",
          result: "",
          num_turns: 1,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
          total_cost_usd: 0,
        },
      ],
    });
    expect(usedUp.end.refused?.cause).toBe("window");
    expect(usedUp.end.text).toBe("");
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 9: the normalised window.
// ---------------------------------------------------------------------------

test(
  "RUN-19 the window the loop reports is normalised to the HIGHEST of its windows with that window's own reset, and a loop that reports none has none (SPEC §6, L10 rule 4)",
  async () => {
    const driven = await driveTurn({
      lines: [INIT, HEALTHY_RATE_LIMIT, healthyResult("an answer")],
    });

    // The HIGHER of the two: a build that reads `five_hour`
    // alone reports 0.27 here, and a weekly cap at 100% would never pause
    // anything while the household was held by the provider with nothing said.
    expect(driven.end.usage.window).not.toBeUndefined();
    expect(driven.end.usage.window?.utilization).toBe(0.55);
    // The seven-day window's OWN reset, and the ISO form is computed by the
    // TEST from the unix seconds, so a build that treats the number as
    // milliseconds lands in 1970 and fails here.
    expect(driven.end.usage.window?.resets_at).toBe(
      new Date(1789808400 * 1000).toISOString(),
    );

    // `plan_usage` is untouched: it stays the raw object the shipped adapter
    // records, because `test/turn-record.test.ts` reads it.
    expect(driven.end.usage.plan_usage).toEqual(
      HEALTHY_RATE_LIMIT.rate_limit_info.unifiedWindows as unknown as Record<string, unknown>,
    );

    // --- control (a): a stream with no `rate_limit_event` at all has no
    //     window, which is the per-token key's case and the no-login case both.
    const none = await driveTurn({ lines: [INIT, healthyResult("an answer")] });
    expect(none.end.usage.window ?? null).toBeNull();

    // --- control (b): a second event later in the same session replaces the
    //     first, so the NEWEST reading is what a turn records. That is what the
    //     shipped adapter already does for `plan_usage`.
    const later = {
      ...HEALTHY_RATE_LIMIT,
      rate_limit_info: {
        ...HEALTHY_RATE_LIMIT.rate_limit_info,
        unifiedWindows: {
          five_hour: { utilization: 0.91, resetsAt: 1789523400 },
          seven_day: { utilization: 0.6, resetsAt: 1789808400 },
        },
      },
    };
    const newest = await driveTurn({
      lines: [INIT, HEALTHY_RATE_LIMIT, later, healthyResult("an answer")],
    });
    expect(newest.end.usage.window?.utilization).toBe(0.91);
    expect(newest.end.usage.window?.resets_at).toBe(
      new Date(1789523400 * 1000).toISOString(),
    );

    // --- control (c): AND A FALLING READING FALLS (the
    //     finding). Keeping the highest utilization ever seen passes control
    //     (b), because the second reading there is the higher one, and then
    //     holds a household on a number that has already reset: the window
    //     came back and every runner still reads 91%. The newest reading is
    //     the reading, up or down.
    const fallen = {
      ...HEALTHY_RATE_LIMIT,
      rate_limit_info: {
        ...HEALTHY_RATE_LIMIT.rate_limit_info,
        unifiedWindows: {
          five_hour: { utilization: 0.02, resetsAt: 1789523400 },
          seven_day: { utilization: 0.08, resetsAt: 1789808400 },
        },
      },
    };
    const lower = await driveTurn({
      lines: [INIT, later, fallen, healthyResult("an answer")],
    });
    expect(lower.end.usage.window?.utilization).toBe(0.08);
    expect(lower.end.usage.window?.resets_at).toBe(
      new Date(1789808400 * 1000).toISOString(),
    );
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 10: the REAL binary, gated.
// ---------------------------------------------------------------------------

test.skipIf(!gate.ok)(
  `RUN-18 the REAL loop with no login answers a typed refusal: the shipped binary with CLAUDE_CONFIG_DIR at an empty directory reports cause login in well under a second, and the scripted loop is the control that refuses nothing${gateSuffix(gate)}`,
  async () => {
    // No login, no network, no token: the real CLI answers `authentication_failed`
    // and exits 1 in 42 ms, measured on this Mac at 2.1.273 and on the hub box
    // at 2.1.258.
    const empty = mkdtempSync(join(dir, "empty-config-"));
    const driven = await driveTurn({
      env: { CLAUDE_CONFIG_DIR: empty },
      boundMs: 20_000,
      // THE MODEL HAS TO BE A REAL ONE, and this is the one measured
      // with. The fixture preset every other check uses says `a-model-name`,
      // and the real binary refuses an unknown model BEFORE it ever looks at a
      // credential: this check then bound "that model does not exist" while
      // reading as though it bound a login. Measured on 2026-09-16 with an
      // empty CLAUDE_CONFIG_DIR: with the placeholder the result is "There's
      // an issue with the selected model", and with the id below it is
      // `authentication_failed` and "Not logged in · Please run /login".
      preset: { ...PRESET, model: "claude-haiku-4-5-20251001" },
    });

    // WHAT THE BINARY ITSELF SAID, from THIS invocation, recorded before
    // anything is asserted about the typed refusal (needed
    // it: the record showed an undefined refusal and no proof that the real
    // loop had failed a login). The shipped adapter already copies the
    // `result` event's own text into `usage.raw.result`, so this reads what
    // came back over the wire whether or not the refusal exists yet.
    const raw = String((driven.end.usage.raw as Record<string, unknown>).result ?? "");
    process.stderr.write(
      `[claude-gate] the real binary with an empty CLAUDE_CONFIG_DIR said: ${JSON.stringify(raw)}\n`,
    );
    expect(raw.toLowerCase()).toContain("login");

    expect(driven.end.refused?.cause).toBe("login");
    expect(String(driven.end.refused?.said).length).toBeGreaterThan(0);
    expect(driven.end.text).toBe("");
    // The measured run is 42 ms. A build that waited on the CLI's own retries
    // would be minutes, so the bound fails rather than hangs.
    expect(driven.elapsedMs).toBeLessThan(10_000);

    // --- THE CONTROL, ungated and in the same body, so a closed gate never
    //     takes it with it: the scripted loop over the same runner-facing
    //     interface refuses nothing on a healthy turn.
    //
    //     WHAT REJECTS AN ADAPTER THAT ALWAYS REFUSES is check 7's healthy
    //     control, not this one: it drives the SAME production adapter over the
    //     measured healthy wire, ungated, and asserts `refused` is null and the
    //     text is the result's own. This control is the weaker statement that
    //     the runner-facing interface is not refusing by construction. A real
    //     logged-in turn would be a third thing again, and it belongs under
    //     `live/` with the two Claude Code files that need a login, not in a
    //     suite that has to run on a box with no credential.
    const scripted = createScriptedAdapter({ name: "scripted-control" });
    const session = await scripted.adapter.start({ preset: PRESET, sessionId: null });
    const ends: Ended[] = [];
    session.onTurnEnd((end) => ends.push(end as Ended));
    await session.feed({ id: "m1", text: "a healthy turn" });
    const started = Date.now();
    while (ends.length === 0 && Date.now() - started < 5000) await Bun.sleep(10);
    await session.close();
    expect(ends.length).toBe(1);
    expect(ends[0].refused ?? null).toBeNull();
    expect(ends[0].text.length).toBeGreaterThan(0);
  },
  SLOW,
);
