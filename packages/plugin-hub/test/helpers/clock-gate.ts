// Test infrastructure: the one gate a TRIGGER check asks about the clock.
//
// The daily BACKSTOP is asked first and it ignores the minimum, so
// one unharvested line older than the last UTC midnight is enough to owe one.
// A check that plants a line ten minutes back and expects a QUIET row therefore
// gets a backstop row instead for the first ten minutes of every UTC day, and a
// check that expects NO row gets one. On this Mac that window is 02:00 local,
// which is exactly when an unattended suite runs.
//
// ROUND 2 TRIED TO CLAMP THE PLANTED TIMES AND THAT WAS WORSE, which is the
// finding and the harness's ruling. `Math.max(now - back, 00:01)`
// returns a time in the FUTURE when the run starts before 00:01, and at 00:10 a
// forty minute, a thirty-nine minute and a twenty minute offset all collapse
// onto 00:01, so the strict lower bound of a slice silently drops lines the
// check believes it planted and the order it believes it has does not exist.
// The clamp is withdrawn. Times are plain offsets again, strictly ordered.
//
// What replaces it is the standing rule for a gate, the one
// `test/helpers/os-gate.ts` already follows: evaluated ONCE at module load, the
// reason carried in the TEST NAME so bun's reporter prints it beside the skip,
// one line on stderr, and `test.skipIf`. A closed gate is never a silent pass.
//
// Each check asks for its OWN number, and that number is the oldest line it
// plants plus the time it takes to run. Before the NEXT midnight, every check
// needs the same fifteen-minute margin: the full suite takes about twelve
// minutes on the slowest machine, and a file can load before its checks run.

const BEFORE = 15;

export interface ClockGate {
  ok: boolean;
  reason: string;
  /** Minutes since the last UTC midnight at the moment the gate was asked. */
  sinceMidnight: number;
  /** Minutes until the next UTC midnight at the moment the gate was asked. */
  untilMidnight: number;
  /** What the check said it needs, for the record and the message. */
  needs: number;
}

/** The most recent UTC midnight at or before this moment. */
export function lastMidnightUtc(now: number): number {
  const at = new Date(now);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/**
 * Whether this moment is too close to a UTC midnight for a trigger check.
 *
 * `minutes` is the check's own need: the age of the oldest line it plants, plus
 * the wall time the check takes. BEFORE leaves room for the whole suite before
 * the next midnight, independently of that check's need after the last one.
 */
export function clockGate(minutes: number, now = Date.now()): ClockGate {
  const since = (now - lastMidnightUtc(now)) / 60_000;
  const until = 24 * 60 - since;
  const ok = since >= minutes && until >= BEFORE;
  const timing = `${Math.floor(since)} min past the last UTC midnight, ` +
    `${Math.floor(until)} min until the next UTC midnight, need ${minutes} min, BEFORE ${BEFORE} min`;
  return {
    ok,
    sinceMidnight: Math.floor(since),
    untilMidnight: Math.floor(until),
    needs: minutes,
    reason: ok
      ? ""
      : `${since < minutes ? "after-midnight need" : "before-midnight margin"} shut the gate: ${timing}; ` +
        "the daily backstop is asked first and ignores the minimum, so planted lines " +
        "before a midnight crossed by the suite can owe a backstop instead of the intended trigger",
  };
}

/** The reason, as a suffix on the test NAME, so the skip is never silent. */
export function clockSuffix(gate: ClockGate): string {
  return gate.ok ? "" : ` [skipped: ${gate.reason}]`;
}

/** One line on stderr, beside the OS gates' own. */
export function announceClock(gate: ClockGate, what: string): void {
  process.stderr.write(
    `[clock-gate] ${what}: ${
      gate.ok
        ? `open, ${gate.sinceMidnight} min past the last UTC midnight, ` +
          `${gate.untilMidnight} min until the next UTC midnight, need ${gate.needs} min, BEFORE ${BEFORE} min`
        : `SKIPPED, ${gate.reason}`
    }\n`,
  );
}
