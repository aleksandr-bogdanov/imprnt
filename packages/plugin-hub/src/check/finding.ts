/**
 * What `check` reports. One line a human reads and one command a human pastes,
 * and nothing anywhere runs the second one (L13).
 */
export interface Finding {
  id: string;        // <machine>/<kind>:<subject>, or <machine>/<kind> with no subject
  kind: string;      // unit-extra | unit-missing | job-stale | job-no-stamp | peak-missing
                     // | kernel-memory-cgroup | kernel-earlyoom | runner-silent | crash-loop
  subject: string;
  machine: string;
  says: string;      // one line a human reads
  fix: string;       // the command, as TEXT. Nothing in check runs it
}

/**
 * D-90. The id is MACHINE-SCOPED, because two machines write their findings
 * into one store: `kernel-earlyoom` from both would otherwise be one row that
 * each run overwrites, and a run on one machine removes only the rows under its
 * own prefix.
 */
export function findingId(machine: string, kind: string, subject?: string): string {
  return subject === undefined || subject === "" ? `${machine}/${kind}` : `${machine}/${kind}:${subject}`;
}
