import type { RunEntry } from "../registry/load.ts";
import { entryIdOf, isOurs, isWatched, unitName } from "./names.ts";
import type { OsSeam, UnitState, WantedState, WantedUnit } from "./types.ts";

/**
 * The arithmetic behind criterion 1: running units minus the registry's set is
 * empty and the reverse is empty.
 *
 * Three answers rather than two, because L13 rules two different things at
 * once. `stale` is under the RENDER prefix and unwanted, which is a unit the hub
 * itself generated and the registry no longer wants, so the hub removes it.
 * `extra` is under the SCAN prefix only, which was never the hub's to write, so
 * it is `check`'s to report and nobody's to touch. Keeping them apart is what
 * makes "never stopped by a robot" structural rather than promised.
 */

/** The cadence a scheduled entry asks for, in seconds, or null. */
export function scheduleSeconds(schedule: string): number | null {
  const text = String(schedule).trim().toLowerCase();
  if (text === "hourly") return 3600;
  if (text === "daily") return 86400;
  const every = /^every\s+(\d+)\s*(s|m|h|d|sec|secs|min|mins|hour|hours|day|days)?$/.exec(text);
  if (!every) return null;
  const size =
    { s: 1, sec: 1, secs: 1, m: 60, min: 60, mins: 60, h: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400 }[
      every[2] ?? "m"
    ] ?? 60;
  return Number(every[1]) * size;
}

/**
 * Four states. Three come from the schedule, and the fourth from the file.
 *
 * Without the third the transcriber is reported missing forever, and a
 * permanent finding is worse than no check at all.
 *
 * `stopped` is answered FIRST, before the schedule is read, because it is a
 * household saying it does not want this piece up at all and the schedule has
 * nothing to add to that. It lives in the registry because the hub re-reads the
 * registry on every tick and starts whatever it says should be running, so a
 * hold kept anywhere else would be undone within a tick, and because the file
 * is the one place the installer, a page and an editor all write.
 */
export function wantedState(entry: RunEntry | { schedule: string; enabled?: boolean }): WantedState {
  if ((entry as { enabled?: boolean }).enabled === false) return "stopped";
  const schedule = String((entry as { schedule: string }).schedule ?? "").trim().toLowerCase();
  if (schedule === "always") return "running";
  if (scheduleSeconds(schedule) !== null) return "scheduled";
  return "loaded";
}

/**
 * The registry's entries as the set `diffUnits` compares against: each one's
 * id, the unit name it renders to and the state its schedule asks for. It is
 * built here so the hub and `check` cannot name or want a unit differently and
 * then disagree about whether the manager is carrying it.
 */
export function wantedUnits(entries: RunEntry[]): WantedUnit[] {
  return entries.map((entry) => ({
    id: entry.id,
    name: unitName(entry.id),
    state: wantedState(entry),
    entry,
  }));
}

/**
 * Whether the manager is still carrying this unit in a way that would start
 * work: a running service, or a timer it has armed.
 *
 * AN ARMED TIMER IS NOT A RUNNING SERVICE. A scheduled entry between runs has
 * an inactive service and a timer the manager reports as active and waiting,
 * and that timer starts the service on its own cadence. So a household that
 * asked for a piece to be down and got only its service stopped would watch it
 * run again every quarter of an hour while the file, the status and the board
 * all said stopped. The word is the manager's own, carried verbatim through the
 * seam, and a service that is merely loaded is not this: it is doing nothing
 * and nothing will make it start.
 */
export function stillUp(unit: UnitState): boolean {
  return unit.running === true || (unit.name.endsWith(".timer") && unit.state === "active");
}

/** Every found unit that belongs to this entry, whatever suffix it wears. */
function unitsFor(found: UnitState[], entryId: string): UnitState[] {
  return found.filter((unit) => entryIdOf(unit.name) === entryId);
}

function satisfied(state: WantedState, units: UnitState[]): boolean {
  // A piece the household asked to be down is never MISSING, whether the
  // manager carries a unit for it or carries none: missing means the registry
  // wants it and the manager has not got it, which cannot be true of something
  // the registry wants down. The opposite fault, a stopped entry the manager is
  // still running, is its own finding and is read off the manager's own list,
  // so nothing is lost by answering yes here. This arm comes before the empty
  // test for that reason.
  if (state === "stopped") return true;
  if (units.length === 0) return false;
  if (state === "running") return units.some((unit) => unit.running === true);
  if (state === "scheduled") return units.some((unit) => unit.loaded === true);
  return units.some((unit) => unit.loaded === true);
}

export function diffUnits(args: { wanted: WantedUnit[]; found: UnitState[] }): {
  missing: WantedUnit[];
  stale: UnitState[];
  extra: UnitState[];
} {
  const { wanted, found } = args;
  const wantedIds = new Set(wanted.map((one) => one.id));

  const missing = wanted.filter((one) => !satisfied(one.state, unitsFor(found, one.id)));

  const stale: UnitState[] = [];
  const extra: UnitState[] = [];
  for (const unit of found) {
    const id = entryIdOf(unit.name);
    if (id !== null) {
      if (!wantedIds.has(id)) stale.push(unit);
      continue;
    }
    if (isWatched(unit.name)) extra.push(unit);
  }
  return { missing, stale, extra };
}

/** What the manager has, plus what it knows about an entry it did not list. */
export async function seenUnits(os: OsSeam, entries: RunEntry[]): Promise<UnitState[]> {
  const listed = await os.list();
  const known = new Set(listed.map((unit) => entryIdOf(unit.name)).filter((id) => id !== null));
  const out = [...listed];
  for (const entry of entries) {
    if (known.has(entry.id)) continue;
    const one = await os.show(entry.id);
    if (one) out.push(one);
  }
  return out;
}

/**
 * The command a human PASTES, per flavour, and nothing here or anywhere else
 * runs it (L13). The whole string is the contract, because a fix that does not
 * run is worse than no fix at all. launchd's takes the uid from the
 * running process, because there is nowhere else in the signature for it.
 */
export function stopCommand(flavour: string, unit: string): string {
  if (flavour === "launchd") {
    const uid = process.getuid?.() ?? -1;
    return `launchctl bootout gui/${uid}/${unit}`;
  }
  return `systemctl --user stop ${unit}`;
}

/**
 * The command a human pastes to START a listed piece the manager is not
 * running. It lives here and not in `check`: a manager's name that `check`
 * can spell is a name `check` could invoke, and the one place the difference
 * cannot be observed from outside is a string built in the right place for the
 * wrong reason. It takes the ENTRY ID, because the two flavours name the same
 * entry differently and only this file knows which.
 */
export function startCommand(flavour: string, entryId: string): string {
  if (flavour === "launchd") {
    const uid = process.getuid?.() ?? -1;
    return `launchctl kickstart gui/${uid}/${unitName(entryId)}`;
  }
  return `systemctl --user start ${unitName(entryId)}.service`;
}

/**
 * The command that clears a unit the manager has GIVEN UP on.
 *
 * systemd parks a unit that hit its start limit in `ActiveState=failed` with
 * `Result=start-limit-hit`, and such a unit does not come back from `start`
 * alone: the failure has to be reset first, so a crash-loop fix that only said
 * "start it" would not run. launchd never gives up, so there is no
 * state to reset there and the honest command for a job that is bouncing is the
 * one that takes it out of the domain. The whole string is the contract on both.
 */
export function resetCommand(flavour: "systemd" | "launchd" | string, unit: string): string {
  if (flavour === "launchd") {
    const uid = process.getuid?.() ?? -1;
    return `launchctl bootout gui/${uid}/${unit}`;
  }
  return `systemctl --user reset-failed ${unit}`;
}

/** A path as one shell word, quoted only when it must be. */
function shellWord(text: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that takes away a hub unit FILE no registry entry declares,
 * per flavour. It finishes the removal a dead hub started, in the
 * hub's own order with the stop brought forward: the manager lets go of the
 * unit, the file goes, and on systemd the manager re-reads its directory. The
 * steps are joined so each runs whatever the one before it said, because the
 * usual reason this file exists is that the manager has already forgotten the
 * unit and would refuse the first step. The whole string is the contract
 * a person pastes, and nothing here or anywhere else runs it (L13).
 */
export function removeFileCommand(flavour: string, path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (flavour === "launchd") {
    const uid = process.getuid?.() ?? -1;
    return `launchctl bootout gui/${uid}/${name.replace(/\.plist$/, "")}; rm -f ${shellWord(path)}`;
  }
  return `systemctl --user disable --now ${name}; rm -f ${shellWord(path)}; systemctl --user daemon-reload`;
}

export { isOurs, isWatched };
