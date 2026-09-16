// Test infrastructure: the one gate a TRIGGER check asks about the clock.
//
// D-145 asks the daily BACKSTOP first and the backstop ignores the minimum, so
// one unharvested line older than the last UTC midnight is enough to owe one.
// A check that plants a line ten minutes back and expects a QUIET row therefore
// gets a backstop row instead for the first ten minutes of every UTC day, and a
// check that expects NO row gets one. On this Mac that window is 02:00 local,
// which is exactly when an unattended suite runs.
//
// ROUND 2 TRIED TO CLAMP THE PLANTED TIMES AND THAT WAS WORSE, which is the
// second seat's finding and the harness's ruling. `Math.max(now - back, 00:01)`
// returns a time in the FUTURE when the run starts before 00:01, and at 00:10 a
// forty minute, a thirty-nine minute and a twenty minute offset all collapse
// onto 00:01, so the strict lower bound of a slice silently drops lines the
// check believes it planted and the order it believes it has does not exist.
// The clamp is withdrawn. Times are plain offsets again, strictly ordered.
//
// What replaces it is 03-CONTEXT's own rule for a gate, the one
// `test/helpers/os-gate.ts` already follows: evaluated ONCE at module load, the
// reason carried in the TEST NAME so bun's reporter prints it beside the skip,
// one line on stderr, and `test.skipIf`. A closed gate is never a silent pass.
//
// Each check asks for its OWN number, and that number is the oldest line it
// plants plus the time it takes to run, because a run that starts four minutes
// before a midnight and takes six minutes crosses it. Both halves are stated at
// the call site. A check is therefore skipped for a few minutes a day and never
// fails there and never lies there.

export interface ClockGate {
  ok: boolean;
  reason: string;
  /** Minutes since the last UTC midnight at the moment the gate was asked. */
  sinceMidnight: number;
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
 * the wall time the check takes, so the whole of it runs inside one UTC day.
 */
export function clockGate(minutes: number, now = Date.now()): ClockGate {
  const since = (now - lastMidnightUtc(now)) / 60_000;
  const ok = since >= minutes;
  return {
    ok,
    sinceMidnight: Math.floor(since),
    needs: minutes,
    reason: ok
      ? ""
      : `it is ${Math.floor(since)} min past a UTC midnight and this check needs ${minutes}: ` +
        "the daily backstop is asked first and ignores the minimum, so a line planted " +
        "before that midnight is owed a backstop and no quiet assertion here can hold",
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
        ? `open, ${gate.sinceMidnight} min past the last UTC midnight and it needs ${gate.needs}`
        : `SKIPPED, ${gate.reason}`
    }\n`,
  );
}
