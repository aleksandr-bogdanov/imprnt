import type { RunEntry } from "../registry/load.ts";

/**
 * The operating system, as the hub sees it. Two implementations, launchd and
 * systemd, behind one interface, and nothing above this file knows which one it
 * is talking to.
 *
 * Types only. No runtime code lives here.
 */

/**
 * What a `[[run]]` entry asks the manager for.
 *
 * Three of the four come from the schedule. The fourth, `stopped`, comes from
 * the file's own `enabled` field, because a hold kept anywhere the hub does not
 * re-read would be undone by its next tick.
 */
export type WantedState = "running" | "scheduled" | "loaded" | "stopped";

export interface UnitState {
  name: string;            // imprnt-hub-runner-pi.service, or an imprnt-* stray
  loaded: boolean;
  running: boolean;
  pid: number | null;
  // Four fields, one meaning each, because launchd's single counter
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
   * `running` above is a BOOLEAN derived from one substate, and a
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
   * which keeps no such field and never gives up.
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
  /**
   * The home directory the PATH a unit carries is written against, on the
   * flavour whose unit file has no specifier for it. Absent means the home of
   * the account rendering, which is the account the unit runs as.
   */
  home?: string;
  /**
   * The whole command line this entry is started with, when it is not the bun
   * default.
   *
   * It exists for the ONE kind whose program is not a bun entry point: the
   * local recognizer's Python server, whose interpreter lives in the
   * household's runtime and whose knobs are all arguments. Absent means the
   * default, which is what keeps every other render what it is.
   *
   * It is NOT a way for a household to pass arguments to a door or a runner.
   * Nothing reads it from the registry: the only caller that sets it is the
   * function that derives the recognizer's argv from the file.
   */
  argv?: string[];
}

export interface UnitFile {
  path: string;
  text: string;
}

/**
 * The PATH every unit carries, so the runner finds a model CLI installed the
 * usual way. A service manager starts a unit with a PATH of the system
 * directories alone, and Claude Code's own installer puts its binary in the
 * account's `.local/bin` on Linux, so the runner looked the CLI up by name,
 * found nothing, and reported the login as an unsupported source, which sent
 * an operator looking for a credential problem that was not there. Written
 * against `home`, which is systemd's `%h` specifier or the literal directory
 * for launchd, and the account's own directories go first so an install there
 * wins over an older one the system carries.
 */
export function unitPath(home: string): string {
  return [`${home}/.local/bin`, `${home}/.bun/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
}

export interface MemoryReading {
  current_bytes: number;          // bytes. Both sources report kB and convert at their own edge
  peak_bytes: number | null;      // the kernel's high-water mark, or null where the kernel keeps none
  source: "proc-status" | "ps-rss";
}

/**
 * A wanted unit: the entry, the name it renders to and the state it asks for.
 *
 * Four fields, pinned, and `diffUnits` accepts exactly this. The earlier
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
   * Every unit FILE in this seam's unit directory under the RENDER
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
