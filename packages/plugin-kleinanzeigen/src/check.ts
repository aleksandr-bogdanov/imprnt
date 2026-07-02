// imprnt · kleinanzeigen plugin — integrity check. Shipped as built check.js (node banner).
//
//   node plugins/kleinanzeigen/check.js   exits 0 if the plugin's data is sound, non-zero if not.
//
// This is the file `imprnt check --all` globs (plugins/*/check.js). The core reads ONLY the exit code
// and forwards stdout verbatim — so we print a rich diagnosis and let the code carry pass/fail. No LLM,
// pure reads. The questions: is the mirror fresh, does every conversation have a fact sheet, and is the
// transport wired (a NOTE, not a failure — offline/pre-probe is a legitimate state).
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MIRROR = join(here, "mirror");
const LISTINGS = join(here, "listings");
const LAST_SYNC = join(MIRROR, ".last-sync");
const ENDPOINTS = join(here, "endpoints.json");

const STALE_HOURS = 2; // cron is documented at 15min; a mirror older than 2h means sync isn't running

const problems: string[] = [];
const notes: string[] = [];

// How many conversation mirror files exist, and which listings they reference (for the fact-sheet
// check). A fact sheet is a SELL-side concern (it fuels FAQ drafts to buyers); buy-side conversations
// (you contacted a seller) need none, so they're skipped. Absent `side:` means a legacy/sell file.
function mirrorConversations(): { count: number; listings: Set<string>; unparseable: string[] } {
  const listings = new Set<string>();
  const unparseable: string[] = [];
  let count = 0;
  if (!existsSync(MIRROR)) return { count, listings, unparseable };
  for (const f of readdirSync(MIRROR)) {
    if (!f.endsWith(".md")) continue;
    count++;
    const text = readFileSync(join(MIRROR, f), "utf8");
    const m = text.match(/^listing:\s*(.+)$/m);
    if (!m) { unparseable.push(`${f} has no \`listing:\` field`); continue; }
    const sideM = text.match(/^side:\s*(.+)$/m);
    const side = sideM ? sideM[1].trim().replace(/^["']|["']$/g, "") : "selling";
    if (side === "buying") continue;
    listings.add(m[1].trim().replace(/^["']|["']$/g, ""));
  }
  return { count, listings, unparseable };
}

const { count, listings, unparseable } = mirrorConversations();
problems.push(...unparseable);

console.log(`kleinanzeigen check — ${count} conversation(s) in mirror`);

// 1. transport wired? (a NOTE — the deterministic pipeline runs offline against fixtures)
if (!existsSync(ENDPOINTS)) {
  notes.push("no endpoints.json yet — live sync isn't wired; run `node kleinanzeigen.js probe` (or use KLEINANZEIGEN_FIXTURES offline)");
}
// Auth resolves at sync time through a chain (KLEINANZEIGEN_TOKEN / KLEINANZEIGEN_COOKIES override →
// the session-host broker → a direct browser-session read), so an unset env var is normal, not a
// problem. Only note the absence of an explicit override, and name the chain that runs instead.
if (!process.env.KLEINANZEIGEN_TOKEN && !process.env.KLEINANZEIGEN_COOKIES) {
  notes.push("no KLEINANZEIGEN_TOKEN/KLEINANZEIGEN_COOKIES override in this shell — live sync auths via the session host or the local browser session (offline fixtures need neither)");
}

// 2. mirror staleness
if (!existsSync(LAST_SYNC)) {
  if (count > 0) problems.push("mirror has conversations but never stamped a sync — run `node kleinanzeigen.js sync`");
  else notes.push("mirror empty, no sync yet — nothing to check");
} else {
  const stamp = readFileSync(LAST_SYNC, "utf8").trim();
  const synced = Date.parse(stamp);
  if (Number.isNaN(synced)) {
    problems.push(`mirror/.last-sync is unparseable ("${stamp}") — re-run sync`);
  } else {
    const ageHours = (Date.now() - synced) / 3_600_000;
    if (ageHours < 0) problems.push(`mirror/.last-sync is in the future ("${stamp}") — corrupt stamp, re-run sync`);
    else if (ageHours > STALE_HOURS) problems.push(`mirror is ${ageHours.toFixed(1)}h stale (>${STALE_HOURS}h) — is the cron sync running?`);
    else console.log(`  ✓ mirror synced ${ageHours.toFixed(1)}h ago`);
  }
}

// 3. orphan listing refs — a conversation about a listing with no fact sheet (its FAQs can't be answered)
const orphans: string[] = [];
for (const l of listings) {
  if (!existsSync(join(LISTINGS, `${l}.yaml`))) orphans.push(l);
}
if (orphans.length) {
  for (const l of orphans) problems.push(`no fact sheet listings/${l}.yaml for a mirrored conversation — FAQs on it can't be answered`);
} else if (listings.size) {
  console.log(`  ✓ every mirrored listing has a fact sheet (${listings.size})`);
}

// verdict
if (notes.length) {
  console.log("\nnotes:");
  for (const n of notes) console.log(`  · ${n}`);
}
if (problems.length) {
  console.log(`\n⚠ ${problems.length} issue(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("\nsound.");
process.exit(0);
