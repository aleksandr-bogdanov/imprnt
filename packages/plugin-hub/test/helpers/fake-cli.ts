// Test infrastructure: a scripted command-line loop, put in front of the REAL
// adapter through the production `wrap` hook.
//
// D-120. `Adapter.start` already takes `wrap?: (argv: string[]) => string[]`
// (03b item 1) and `src/adapters/claude-code.ts` spawns whatever comes back, so
// a check hands the real adapter a hook that returns a small script emitting
// the JSON lines MEASURED against the real CLI on 2026-09-16. What is bound is
// the shipped adapter's own reading of a real wire shape, not a fake loop
// standing in for a real edge.
//
// The hook IGNORES the argv it is handed, which is the point: the adapter's own
// flags (`--include-partial-messages`, `--effort`, `--model` and the rest) are
// irrelevant to what the adapter READS, and a fixture that tried to honour them
// would be re-implementing the CLI.
//
// The script is run with `process.execPath` and never with the bare word `bun`
// (03b item 10): a check that spawned whatever the PATH happened to carry would
// be measuring the box rather than the loop.

/** What the script does between the lines it was given. */
export interface FakeCliOptions {
  /** Milliseconds between one planted line and the next. Zero by default. */
  delayMs?: number;
  /**
   * Milliseconds the script stays silent AFTER its last line, before it would
   * say anything more. It says nothing more in any case: the hold is how a
   * check keeps a turn open with no `result` ever written, which is the shape a
   * refused key produces.
   */
  holdMs?: number;
  /** Replay the user line the way `--replay-user-messages` does. On by default. */
  replay?: boolean;
}

/**
 * A `wrap` hook that runs a script emitting `lines` on stdout, in order, one
 * JSON object per line, after replaying the fed user message.
 *
 * The replay is what the shipped adapter reads as the receipt (it wants
 * `type: "user"`, `isReplay: true` and the same content it fed), so a planted
 * stream behaves like a real turn from the first verb on.
 */
export function fakeClaudeCli(
  lines: Record<string, unknown>[],
  options: FakeCliOptions = {},
): (argv: string[]) => string[] {
  const planted = JSON.stringify(JSON.stringify(lines));
  const delay = Number(options.delayMs ?? 0);
  const hold = Number(options.holdMs ?? 0);
  const replay = options.replay === false ? "false" : "true";
  const script = `
const LINES = JSON.parse(${planted});
const DELAY = ${delay};
const HOLD = ${hold};
const REPLAY = ${replay};

function say(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function turn(raw) {
  let fed = null;
  try { fed = JSON.parse(raw); } catch (error) { fed = null; }
  const content = fed && fed.message ? fed.message.content : "";
  if (REPLAY) {
    say({ type: "user", isReplay: true, message: { role: "user", content: content } });
  }
  for (const one of LINES) {
    if (DELAY > 0) await sleep(DELAY);
    say(one);
  }
  if (HOLD > 0) await sleep(HOLD);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut = buffer.indexOf("\\n");
  while (cut >= 0) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    cut = buffer.indexOf("\\n");
    if (line.trim() !== "") void turn(line);
  }
});

// The real CLI stays up for the whole session and the adapter's close() is what
// ends it, so this one does too. A script that exited after its lines would
// close the stream under a reader that is still being asserted about.
setInterval(() => {}, 1000000000);
`;
  return () => [process.execPath, "-e", script];
}
