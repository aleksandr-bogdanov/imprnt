import type { RunEntry } from "../registry/load.ts";
import { entryIdOf, isOurs, isWatched } from "./names.ts";
import type { UnitState, WantedState, WantedUnit } from "./types.ts";

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
 * D-97. Three states, derived from the schedule and from nothing else.
 *
 * Without the third one the transcriber is reported missing forever, and a
 * permanent finding is worse than no check at all.
 */
export function wantedState(entry: RunEntry | { schedule: string }): WantedState {
  const schedule = String((entry as { schedule: string }).schedule ?? "").trim().toLowerCase();
  if (schedule === "always") return "running";
  if (scheduleSeconds(schedule) !== null) return "scheduled";
  return "loaded";
}

/** Every found unit that belongs to this entry, whatever suffix it wears. */
function unitsFor(found: UnitState[], entryId: string): UnitState[] {
  return found.filter((unit) => entryIdOf(unit.name) === entryId);
}

function satisfied(state: WantedState, units: UnitState[]): boolean {
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
  const wanted = args.wanted ?? [];
  const found = args.found ?? [];
  const wantedIds = new Set(wanted.map((one) => idOf(one)));

  const missing = wanted.filter(
    (one) => !satisfied(stateOf(one), unitsFor(found, idOf(one))),
  );

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

/** The entry id of a wanted unit, however the caller shaped it. */
function idOf(one: WantedUnit | Record<string, unknown>): string {
  const direct = (one as { id?: unknown }).id;
  if (typeof direct === "string" && direct !== "") return direct;
  const entry = (one as { entry?: { id?: string } }).entry;
  return String(entry?.id ?? "");
}

function stateOf(one: WantedUnit | Record<string, unknown>): WantedState {
  const given = (one as { state?: unknown }).state;
  if (given === "running" || given === "scheduled" || given === "loaded") return given;
  return wantedState(one as { schedule: string });
}

/**
 * The command a human PASTES, per flavour, and nothing here or anywhere else
 * runs it (L13). The whole string is the contract, because a fix that does not
 * run is worse than no fix at all (D-105). launchd's takes the uid from the
 * running process, because there is nowhere else in the signature for it.
 */
export function stopCommand(flavour: string, unitName: string): string {
  if (flavour === "launchd") {
    const uid = process.getuid?.() ?? -1;
    return `launchctl bootout gui/${uid}/${unitName}`;
  }
  return `systemctl --user stop ${unitName}`;
}

export { isOurs, isWatched };
