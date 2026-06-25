/**
 * Own-account identity for internal-transfer detection.
 *
 * The names and IBANs that mark an account-to-account move as "mine" are personal
 * data. They are NOT hardcoded here. They live in data/profile.json (gitignored)
 * and are installed once at startup via setIdentity(). The defaults are empty, so
 * a fresh checkout bakes in no identity: connectors fall back to structural hints
 * (such as N26's MoneyBeam type) until a profile is loaded. Either way, the
 * `transfers` command pairs the authoritative legs by amount and date, so a missed
 * hint never loses a transfer.
 */

let ownNames: string[] = [];
let ownIbans = new Set<string>();

function normName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
function normIban(s: string): string {
  return s.toUpperCase().replace(/\s+/g, "");
}

/** Install the current user's own names and IBANs (from the profile). */
export function setIdentity(names: string[], ibans: string[]): void {
  ownNames = names.map(normName).filter((n) => n.length > 0);
  ownIbans = new Set(ibans.map(normIban).filter((i) => i.length > 0));
}

/** Clear the installed identity. Used by tests to isolate cases. */
export function resetIdentity(): void {
  ownNames = [];
  ownIbans = new Set();
}

/** True when `text` contains one of the installed own names (whitespace-normalized). */
export function matchesOwnName(text: string): boolean {
  if (ownNames.length === 0) return false;
  const t = normName(text);
  return ownNames.some((n) => t.includes(n));
}

/** True when `iban` is one of the installed own IBANs (case- and space-insensitive). */
export function isOwnIban(iban: string): boolean {
  if (iban === "") return false;
  return ownIbans.has(normIban(iban));
}
