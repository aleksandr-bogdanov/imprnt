import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A harvested note is staged to a file and filed by the household's own
 * `imprnt ingest --apply`, and the outcome is read from that command's own
 * bytes.
 *
 * The hub cannot import core (the plugin contract), so the apply is a CHILD
 * PROCESS and which binary it is is a setting (`hub.imprnt`). This is
 * SPEC §2's "an agent produces text, delivery is machinery" applied to filing:
 * the model produced text, the loop cannot write to the vault at all (measured
 * three ways, 05-BRIEF), and code does the filing.
 *
 * THE APPLY IS UNBOXED. The box exists to fence what the MODEL can reach (L7),
 * and this is the hub's own write of the text that model already produced.
 */
export type ApplyOutcome = "filed" | "noop" | "conflict" | "refused";

export interface ApplyResult {
  outcome: ApplyOutcome;
  /** `<folder>/<slug>`, or "" when the output named none. */
  note: string;
  /** The line that classified it, or the whole output when none did. */
  said: string;
  exit: number;
  file: string;
}

/**
 * How long an apply may take before it is killed and reported refused.
 *
 * SPEC §6's watched children
 * are the model processes and workers the runner spawns as LOOPS, and
 * `watchChildren` reads a loop's resident size on the tick. The apply is the
 * hub's own delivery machinery running the household's `imprnt` for a second or
 * two, and what goes wrong with it is not memory but a HANG: a CLI waiting on a
 * lock, on a prompt, on a vault directory that turns out to be a network mount.
 * So the bound is a wall clock. A refused apply never moves a watermark,
 * so a hung CLI costs a retry and never a lost slice.
 */
export const APPLY_TIMEOUT_MS = 120_000;

/**
 * The four markers the real CLI prints, each with the exit code it pairs with.
 *
 * Measured on 2026-09-16 against `packages/imprnt/scripts/ingest.ts`. A null
 * exit means the marker says refused whatever the code came back.
 */
const MARKERS: { marker: string; outcome: ApplyOutcome; exit: number | null; skip: number }[] = [
  // `  ✓ filed <folder>/<slug>  (type: <t>[, domain: <d>])`, so the path is the
  // token after the word `filed` and not the one after the marker.
  { marker: "✓", outcome: "filed", exit: 0, skip: 2 },
  // `  = <folder>/<slug> already filed, identical content (hash <h>) — no-op`.
  // It carries the word `filed` too, which is why the skip is per marker and
  // never one rule shared between them.
  { marker: "=", outcome: "noop", exit: 0, skip: 1 },
  // `  ! <folder>/<slug> exists with DIFFERENT content — not overwriting`.
  { marker: "!", outcome: "conflict", exit: 1, skip: 1 },
  // `  ✗ <file>: ...`, where the token after the marker is the STAGED FILE and
  // never a note path, so this one names no note.
  { marker: "✗", outcome: "refused", exit: null, skip: -1 },
];

/** The two refusals the CLI prints before it opens a note at all. */
const REFUSALS = ["no such staged note:", "no vault at "];

/**
 * Terminal escape sequences: CSI (colour, cursor), OSC (titles, links) and the
 * two-byte ones.
 *
 * Measured on 2026-09-18 under bun 1.3.14: with FORCE_COLOR set, bun paints
 * every `console.error` line of the CLI red, so the conflict line arrives as
 * `ESC[0m ESC[31m  ! <folder>/<slug> ...` and no longer starts with its
 * marker. `applyNote` hands the child an environment that cannot colour, and
 * this is the second half: a CLI that colours regardless is still read.
 */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * What the CLI said, read from its own bytes. PURE: no clock, no filesystem.
 *
 * UNKNOWN IS REFUSED, WHATEVER THE EXIT CODE, and that is the rule rather than
 * an edge case: an output no marker classified is an outcome nobody read, and
 * a watermark must never move on one.
 *
 * BOTH SIGNALS ARE NEEDED AND NEITHER IS SUFFICIENT. `conflict` and `refused`
 * both exit 1, so the code alone cannot tell them apart, and a `✓` beside a
 * non-zero exit is a success line the command then contradicted, which is again
 * an outcome nobody read.
 */
export function classifyApply(
  output: string,
  exit: number,
): { outcome: ApplyOutcome; note: string; said: string } {
  // The colour comes out before any marker is looked for, and `said` carries
  // the plain text too, because it lands in a diary a household reads.
  const plain = output.replace(ESCAPES, "");
  for (const raw of plain.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (REFUSALS.some((said) => line.startsWith(said))) {
      return { outcome: "refused", note: "", said: line };
    }
    const found = MARKERS.find((one) => line.startsWith(one.marker));
    if (!found) continue;
    const note = found.skip < 0 ? "" : (line.split(/\s+/)[found.skip] ?? "");
    // The first line that classifies wins, and it wins as `refused` when the
    // command's own exit code says the thing that marker announces did not
    // happen.
    if (found.exit !== null && exit !== found.exit) {
      return { outcome: "refused", note, said: line };
    }
    return { outcome: found.outcome, note, said: line };
  }
  return { outcome: "refused", note: "", said: plain };
}

/**
 * The staging directory's name, with every character a filesystem or a
 * file browser could misread taken out.
 *
 * A harvest row id is `harvest:<agent>:<until iso>`. Colons are legal at the
 * POSIX layer and are shown as `/` by macOS's Finder, so a household looking at
 * what is staged would read one directory as three.
 */
export function stageSlug(rowId: string): string {
  return rowId.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function stageDirFor(stateDir: string, person: string, rowId: string): string {
  return join(stateDir, person, "harvest", stageSlug(rowId));
}

/**
 * Each note of a reply on disk, `1.md`, `2.md`, in the order the reply gave
 * them. The order is the contract: the notes are applied in it, and a refusal
 * partway through leaves the ones before it filed and the watermark unmoved.
 */
export async function stageNotes(args: {
  stateDir: string;
  person: string;
  rowId: string;
  notes: string[];
}): Promise<string[]> {
  const dir = stageDirFor(args.stateDir, args.person, args.rowId);
  mkdirSync(dir, { recursive: true });
  return args.notes.map((body, at) => {
    const file = join(dir, `${at + 1}.md`);
    writeFileSync(file, body, "utf8");
    return file;
  });
}

/**
 * File one staged note through the household's own `imprnt`, and answer what
 * the command said.
 *
 * The vault the CLI is handed is `<vault>/vault`, because `applyStaged`
 * resolves the snapshot directory as that path's sibling (`join(vault, "..",
 * "raw", "proposed")`), and `[[people]].vault` names the project root the way
 * `imprnt init <path>` scaffolds it.
 */
export async function applyNote(args: {
  imprnt: string;
  vault: string;
  file: string;
  timeoutMs?: number;
}): Promise<ApplyResult> {
  const bound = args.timeoutMs ?? APPLY_TIMEOUT_MS;
  // AN ENVIRONMENT THAT CANNOT COLOUR, for this child only. The outcome is
  // read from the marker at the start of a line, and a runner started from a
  // shell that exports FORCE_COLOR would otherwise hand it on and have every
  // conflict read as a refusal. FORCE_COLOR is taken OUT rather than set to
  // something: bun paints under an empty one too, and it wins over NO_COLOR
  // (both measured on 2026-09-18). Everything else is inherited, because the
  // CLI is a normal program and needs a normal environment.
  const { FORCE_COLOR: _colour, ...inherited } = process.env;
  const child = Bun.spawn(
    [args.imprnt, "ingest", "--apply", args.file, "--vault", join(args.vault, "vault")],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...inherited, NO_COLOR: "1" } },
  );
  let killed = false;
  // SIGKILL and not a polite signal. A CLI that is hung on a lock may well be
  // ignoring the ones a stop would send, and the bound exists precisely for the
  // child that does not answer.
  const timer = setTimeout(() => {
    killed = true;
    try {
      child.kill(9);
    } catch {
      // It ended between the bound running out and the signal, which is the
      // same outcome by another route.
    }
  }, bound);
  let out = "";
  let err = "";
  let exit = -1;
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    out = stdout;
    err = stderr;
    exit = typeof code === "number" ? code : -1;
  } finally {
    clearTimeout(timer);
  }
  if (killed) {
    return {
      outcome: "refused",
      note: "",
      said: `the apply did not finish within ${bound} ms and was killed`,
      exit,
      file: args.file,
    };
  }
  // Both streams, because `filed` and `noop` land on stdout while `conflict`
  // and every refusal land on stderr, and one of them alone reads half of what
  // the command said.
  const read = classifyApply(`${out}${err}`, exit);
  return { ...read, exit, file: args.file };
}
