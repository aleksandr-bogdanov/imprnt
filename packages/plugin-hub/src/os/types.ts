import type { RunEntry } from "../registry/load.ts";

/**
 * The operating system, as the hub sees it. Two implementations, launchd and
 * systemd, behind one interface, and nothing above this file knows which one it
 * is talking to.
 *
 * Types only. No runtime code lives here.
 */

/** What a `[[run]]` entry's schedule asks the manager for (D-97). */
export type WantedState = "running" | "scheduled" | "loaded";

export interface UnitState {
  name: string;            // imprnt-hub-runner-pi.service, or an imprnt-* stray
  loaded: boolean;
  running: boolean;
  pid: number | null;
  // D-101. Four fields, one meaning each, because launchd's single counter
  // counts executions and systemd's counts restarts.
  runs: number | null;     // executions, where the manager counts: launchd runs, null on systemd
  ran: boolean;            // the manager's own record says the program executed at least once
  restarts: number | null; // systemd NRestarts, launchd max(runs - 1, 0)
  lastExit: number | null; // launchd last exit code (null on "(never exited)"), systemd ExecMainStatus
  since: string | null;    // ISO 8601, or null
  /**
   * The manager's own word for what state the unit is in, verbatim: systemd's
   * `ActiveState` (`active`, `failed`, `activating`) and launchd's `state`
   * (`running`, `not running`). Null when the manager did not say.
   *
   * 03b row 3. `running` above is a BOOLEAN derived from one substate, and a
   * finding that has to tell a household what is wrong cannot say "it is not
   * running" when the manager's answer is "it is failed and I have stopped
   * trying". The two flavours disagree about what the words are, so what is
   * carried here is the manager's, unedited, and the reader says which manager
   * it is reading.
   */
  state: string | null;
  /**
   * The manager's own word for why it last stopped, verbatim: systemd's
   * `Result` (`success`, `exit-code`, `start-limit-hit`). Null on launchd,
   * which keeps no such field and never gives up (D-96).
   */
  result: string | null;
}

export interface RenderContext {
  machine: string;
  stateDir?: string;
  execPath: string;        // the interpreter, supplied, never discovered here
  entryScript: string;     // src/entry/<kind>.ts, absolute
  registryFile: string;
  restartDelaySeconds: number;
  giveUpAfter: number;
  giveUpWindowSeconds: number;
}

export interface UnitFile {
  path: string;
  text: string;
}

export interface MemoryReading {
  current_bytes: number;          // bytes. Both sources report kB and convert at their own edge
  peak_bytes: number | null;      // the kernel's high-water mark, or null where the kernel keeps none
  source: "proc-status" | "ps-rss";
}

/**
 * A wanted unit: the entry, the name it renders to and the state it asks for.
 *
 * D-107. Four fields, pinned, and `diffUnits` accepts exactly this. The earlier
 * shape spread the whole `RunEntry` in beside `entry` and carried `name` twice
 * (once as `unit`), so the same fact had three spellings and nothing said which
 * one a reader was meant to use. `id` is the entry's, because that is what the
 * diff matches a found unit against.
 */
export interface WantedUnit {
  id: string;
  name: string;
  state: WantedState;
  entry: RunEntry;
}

export interface OsSeam {
  readonly flavour: "systemd" | "launchd";
  render(entry: RunEntry, ctx: RenderContext): UnitFile[];   // pure
  install(files: UnitFile[]): Promise<string[]>;             // returns every path it wrote
  remove(entryId: string): Promise<void>;
  start(entryId: string): Promise<void>;
  stop(entryId: string): Promise<void>;
  restart(entryId: string): Promise<void>;
  list(): Promise<UnitState[]>;                              // everything under SCAN_PREFIX
  /**
   * REVIEW S6. Every unit FILE in this seam's unit directory under the RENDER
   * prefix, as absolute paths. Read from the directory and never from the
   * manager, because the file it exists to find is one the manager has no
   * record of. Optional, so a seam a check assembles by hand may leave it out,
   * and a seam without it reports no file rather than failing the run.
   */
  unitFiles?(): Promise<string[]>;
  show(entryId: string): Promise<UnitState | null>;
  memory(pid: number): Promise<MemoryReading>;               // stateless: it accumulates nothing
  available(): Promise<{ ok: boolean; reason: string }>;      // the gate
}
