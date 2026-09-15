/**
 * What the hub's units are called, and what it is allowed to touch.
 *
 * D-75. TWO PREFIXES, and the difference between them is the whole fence. The
 * RENDER prefix is what the hub writes: a unit under it with no registry entry
 * is one the hub itself generated and the registry no longer wants, so the hub
 * removes it. The SCAN prefix is SPEC's own `imprnt-*`, which is what `check`
 * watches: a unit under it that is not under the render prefix was never the
 * hub's to write, so it is reported with the command to stop it and nothing
 * executes that command.
 *
 * The two cannot collide. A live v2 on the hub box owns `imprnt-board.service`,
 * `imprnt-runner@<instance>.service` and forty-odd others, and the shipped
 * example registry has an entry whose id is `board`. `imprnt-hub-board` is not
 * a name any of them can be, because no v2 unit begins `imprnt-hub-`.
 */
export const UNIT_PREFIX = "imprnt-hub-";
export const SCAN_PREFIX = "imprnt-";

const SUFFIXES = [".service", ".timer", ".plist"];

/** The base name, with a manager's own suffix taken off if it carries one. */
function base(unitName: string): string {
  const found = SUFFIXES.find((suffix) => unitName.endsWith(suffix));
  return found ? unitName.slice(0, -found.length) : unitName;
}

/** `imprnt-hub-<entry id>`: a launchd Label as it stands, a systemd unit plus a suffix. */
export function unitName(entryId: string): string {
  return `${UNIT_PREFIX}${entryId}`;
}

/** The systemd timer that drives a scheduled entry's service. */
export function timerName(entryId: string): string {
  return `${UNIT_PREFIX}${entryId}.timer`;
}

/** The entry this unit was rendered for, or null when it is not one of ours. */
export function entryIdOf(unitName: string): string | null {
  const name = base(unitName);
  if (!name.startsWith(UNIT_PREFIX)) return null;
  const id = name.slice(UNIT_PREFIX.length);
  return id === "" ? null : id;
}

/** The hub generated this one, so the hub may stop and remove it. */
export function isOurs(unitName: string): boolean {
  return entryIdOf(unitName) !== null;
}

/** `check` watches this one. It reports it and nothing touches it. */
export function isWatched(unitName: string): boolean {
  return base(unitName).startsWith(SCAN_PREFIX);
}
