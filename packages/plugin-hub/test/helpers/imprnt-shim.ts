// Test infrastructure: the real `imprnt` CLI, reachable as one command.
//
// D-140. `hub.imprnt` names the command the runner spawns to file a harvested
// note, because which binary files a note is a household fact and not a thing
// for code to guess. This Mac's is one build, the hub box's is another, and the
// monorepo's own is `packages/imprnt/scripts/cli.ts`, which runs under `bun`
// with no build step at all.
//
// So a check writes a one-line shell script that runs THAT file and puts its
// path in `hub.imprnt`. Every check in phase 5 then drives the REAL apply path,
// on this Mac, on the hub box and in CI, against a scratch vault, with nothing
// built and no developer's own vault registry touched.
//
// The bun binary and the CLI path are substituted at WRITE time rather than
// read from the environment at run time, because the runner spawns this script
// with whatever environment it has, and a `bun` that is not on that PATH would
// make every check red for a reason no plan names.

import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubPath } from "./cluster.ts";

/** The monorepo's own CLI, resolved from this package rather than from a PATH. */
export function imprntCliPath(): string {
  return hubPath("../imprnt/scripts/cli.ts");
}

/**
 * Write an executable `imprnt` into `dir` and return its path.
 *
 * Two lines: the shell marker and one `exec`. Both the interpreter and the
 * script it runs are absolute, so the command works from any working directory
 * and with any PATH.
 */
export function writeImprntShim(dir: string): string {
  const shim = join(dir, "imprnt");
  const cli = imprntCliPath();
  writeFileSync(
    shim,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`,
    "utf8",
  );
  chmodSync(shim, 0o755);
  return shim;
}

/**
 * The same shim, with a GATE in front of the real CLI.
 *
 * The second seat's finding on check 10: every assertion about the watermark
 * reads the sheet AFTER the apply has finished, so a runner that writes the
 * watermark early, spawns the apply and restores the row on a refusal shows the
 * same final state as a correct one. The only way to tell them apart from
 * outside is to look at the sheet WHILE an apply is in flight.
 *
 * So this shim announces itself and waits. It writes a marker file the moment
 * it is spawned, then spins until the check drops a `go` file, then execs the
 * real CLI exactly as the plain shim does. Between the marker and the `go` the
 * check owns the moment: the loop has answered, the note is staged, the apply
 * is running, and the watermark must not be there.
 *
 * THE SPIN IS BOUNDED. An unbounded wait turns a gate the check forgot to open
 * into a test timeout with nothing to read. It gives up after a minute and
 * execs anyway, so the worst case is a slow pass rather than a hang.
 *
 * It is a SECOND function rather than an option on the first, so every check
 * that calls `writeImprntShim` gets the byte-identical script it gets today.
 */
export interface GatedImprnt {
  /** The path `hub.imprnt` names. */
  shim: string;
  /** How many applies have reached the gate and not yet been let through. */
  waiting(): number;
  /** The argv of each apply that reached the gate, in order. */
  seen(): string[];
  /** Let every apply through, the ones waiting and the ones still to come. */
  open(): void;
  /** Let the nth apply through ALONE, so the next one is still held. */
  release(nth?: number): void;
  /** How many applies have announced themselves, released or not. */
  held(): number;
}

export function writeGatedImprntShim(dir: string): GatedImprnt {
  const gate = join(dir, "imprnt-gate");
  mkdirSync(gate, { recursive: true });
  const shim = join(dir, "imprnt-gated");
  const cli = imprntCliPath();
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      `gate=${JSON.stringify(gate)}`,
      // Each apply takes the next TICKET, so a check can release them one at a
      // time and read the world between two of them. `go` releases all of them
      // at once and `go.<n>` releases the nth alone.
      'n=$(ls "$gate" 2>/dev/null | grep -c "^started\\." || true)',
      "n=$((n+1))",
      'printf "%s\\n" "$*" > "$gate/started.$n"',
      "i=0",
      'while [ ! -f "$gate/go" ] && [ ! -f "$gate/go.$n" ]; do',
      "  i=$((i+1))",
      '  if [ "$i" -ge 600 ]; then break; fi',
      "  sleep 0.1",
      "done",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o755);

  const markers = (): string[] =>
    existsSync(gate) ? readdirSync(gate).filter((name) => name.startsWith("started.")) : [];

  return {
    shim,
    waiting: () => (existsSync(join(gate, "go")) ? 0 : markers().length),
    seen: () => markers().sort(),
    open() {
      writeFileSync(join(gate, "go"), "go\n", "utf8");
    },
    release(nth = 1) {
      writeFileSync(join(gate, `go.${nth}`), "go\n", "utf8");
    },
    held: () => markers().length,
  };
}

/**
 * A shim that NEVER EXITS, for the one thing that can really go wrong with an
 * apply child.
 *
 * The harness's ruling after the second Codex pass: SPEC section 6's watched
 * children are the model processes and workers the runner spawns as loops, and
 * `watchChildren` reads a loop's resident size on the tick. The apply is the
 * hub's own delivery machinery running the household's `imprnt` for a second or
 * two, and what goes wrong with it is not memory but a HANG: a CLI waiting on a
 * lock, on a prompt, on a vault directory that is a network mount. So the bound
 * `applyNote` carries is a wall clock, not a resident size, and this is the
 * child that exercises it.
 *
 * It ignores every signal a polite stop would send, so a build that "kills" it
 * by asking nicely and then waiting is caught too. Only SIGKILL takes it.
 */
export function writeHangingImprntShim(dir: string, name = "imprnt-hangs"): string {
  const shim = join(dir, name);
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      "trap '' TERM INT HUP",
      "while true; do sleep 1; done",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o755);
  return shim;
}
