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
}

export interface RenderContext {
  machine: string;
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

/** A wanted unit: the entry, the name it renders to and the state it asks for. */
export interface WantedUnit extends RunEntry {
  entry: RunEntry;
  name: string;
  unit: string;
  state: WantedState;
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
  show(entryId: string): Promise<UnitState | null>;
  memory(pid: number): Promise<MemoryReading>;               // stateless: it accumulates nothing
  available(): Promise<{ ok: boolean; reason: string }>;      // the gate
}
