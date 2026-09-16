// Test infrastructure: a service manager that WRITES DOWN every question it is
// asked, answers the reading ones honestly and refuses the rest.
//
// RED-RUN-2's stated residue: "`check` calling a manager by ABSOLUTE path is not
// caught. Check 22 runs `runCheck` in a subprocess whose PATH is fronted by
// shims ... A build that spawned `/bin/launchctl` by its full path never meets
// the shim." 03b item 7 closes it from the other side: the OS seam takes the
// manager binary as a PARAMETER whose default is the bare name, a check builds
// the seam with that parameter pointed at this shim BY ABSOLUTE PATH, and then
// a `check` that reached the real manager by any route at all leaves this log
// empty while the findings still come back.
//
// It FORWARDS the reading verbs to the real manager, because the check around it
// has to get real findings out of real units, and it REFUSES everything else
// with a non-zero exit, because a `check` that tried to act should fail loudly
// rather than quietly succeed. Both halves are recorded either way: what the log
// holds is the whole conversation.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Every verb that only ASKS. Anything else is refused and recorded. */
const READS = [
  // launchctl
  "print",
  "list",
  "print-disabled",
  "dumpstate",
  // systemctl
  "show",
  "status",
  "cat",
  "is-active",
  "is-enabled",
  "is-failed",
  "is-system-running",
  "list-units",
  "list-timers",
  "list-unit-files",
];

export interface ManagerShim {
  /** The directory the shims live in, for fronting PATH as well. */
  dir: string;
  /** The absolute path of one shim, which is what a seam is pointed at. */
  path(name: "launchctl" | "systemctl"): string;
  /** This platform's own manager shim, by absolute path. */
  here(): string;
  /** Every invocation, oldest first, exactly as the shim recorded it. */
  lines(): string[];
  /** The invocations that were not reading verbs. Must always be empty. */
  mutating(): string[];
  remove(): void;
}

export function managerShim(): ManagerShim {
  const dir = mkdtempSync(join(tmpdir(), "hub-mgrshim-"));
  const log = join(dir, "invocations.log");
  writeFileSync(log, "", "utf8");

  for (const name of ["launchctl", "systemctl"]) {
    const found = Bun.spawnSync(["/usr/bin/which", name], { stdout: "pipe", stderr: "pipe" });
    const real = (found.stdout?.toString() ?? "").trim().split("\n")[0];
    // `--user` is systemd's domain and not a verb, so the scan looks at EVERY
    // argument rather than only the first one: `systemctl --user stop x` has to
    // read as a stop and not as a `--user`.
    const reads = READS.join("|");
    writeFileSync(
      join(dir, name),
      [
        "#!/bin/sh",
        `printf '%s %s\\n' "${name}" "$*" >> ${JSON.stringify(log)}`,
        'for arg in "$@"; do',
        `  case "$arg" in`,
        `    ${reads})`,
        real ? `      exec ${real} "$@" ;;` : `      exit 0 ;;`,
        "  esac",
        "done",
        // Not a reading verb: recorded above, never forwarded, and loud.
        "exit 70",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(join(dir, name), 0o755);
  }

  const lines = (): string[] =>
    readFileSync(log, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

  return {
    dir,
    path: (name) => join(dir, name),
    here: () => join(dir, process.platform === "darwin" ? "launchctl" : "systemctl"),
    lines,
    mutating: () =>
      lines().filter(
        (line) => !line.split(/\s+/).slice(1).some((word) => READS.includes(word)),
      ),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
