/**
 * kopeika — deterministic local-first personal-finance bookkeeping CLI.
 *
 * Ops (the whole surface): import, categorize, transfers, recurring, list, report.
 * No LLM runs at runtime. Everything below is parse -> normalize -> FX -> dedup
 * -> categorize via ratified rules -> match transfers.
 *
 * Data layout (all under data/, gitignored):
 *   data/raw/<source>/   archived immutable original exports
 *   data/ledger.csv      clean normalized ledger
 *   data/rules.csv       categorization rules
 *   data/rates.csv       month/currency -> EUR rates
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCsv } from "./csv.ts";
import {
  buildReport,
  buildSpendGroups,
  latestCompleteMonth,
  type MonthSummary,
  type Report,
} from "./analytics.ts";
import { renderDashboard, type ProjectionView } from "./dashboard.ts";
import { loadProfile, EMPTY_PROFILE, type Profile } from "./profile.ts";
import { setIdentity } from "./identity.ts";
import { getConnector, connectorNames } from "./connectors/index.ts";
import { loadRates, rateToEur, toEur } from "./fx.ts";
import {
  loadSavingsConfig,
  savingsConfigured,
  savingsStock,
  savingsSeries,
  recentMonthlyRate,
  DEFAULT_RATE_LOOKBACK,
  type StockComponent,
} from "./savings.ts";
import { projectAt, type ProjectionInput } from "./projection.ts";
import { transactionId } from "./hash.ts";
import {
  appendDeduped,
  archiveRaw,
  loadLedger,
  writeLedger,
} from "./ledger.ts";
import {
  firstMatch,
  loadRules,
  summarizeUnknowns,
} from "./rules.ts";
import {
  detectRecurring,
  DEFAULT_RECURRING_OPTIONS,
} from "./recurring.ts";
import { loadTiers, tiersConfigured } from "./tiers.ts";
import {
  DEFAULT_TRANSFER_OPTIONS,
  matchTransfers,
} from "./transfers.ts";
import {
  isOwner,
  type Owner,
  type Transaction,
} from "./types.ts";

// --- Paths ------------------------------------------------------------------
// data/ sits at the plugin root. The built single-file kopeika.js lives there with
// data/ as a sibling; running the source (src/cli.ts) it is one level up. Resolve
// relative to this file (never cwd), so it works from any working directory.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = basename(HERE) === "src" ? dirname(HERE) : HERE;
const DATA_DIR = join(ROOT, "data");
const LEDGER_PATH = join(DATA_DIR, "ledger.csv");
const RULES_PATH = join(DATA_DIR, "rules.csv");
const RATES_PATH = join(DATA_DIR, "rates.csv");
const TIERS_PATH = join(DATA_DIR, "tiers.csv");
const SAVINGS_PATH = join(DATA_DIR, "savings.csv");
const PROFILE_PATH = join(DATA_DIR, "profile.json");

// The personal layer (own names/IBANs, net-worth marks, display labels), loaded
// once in main() from data/profile.json. Empty until then, so nothing personal is
// baked into the code. See src/profile.ts.
let PROFILE: Profile = EMPTY_PROFILE;

// --- Tiny arg parser --------------------------------------------------------
interface Args {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function flagString(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function hasFlag(args: Args, name: string): boolean {
  return args.flags.has(name);
}

// --- Money formatting for tables -------------------------------------------
function fmtEur(n: number | null): string {
  return n === null ? "—" : n.toFixed(2);
}
function fmtNative(n: number): string {
  return n.toFixed(2);
}
/** Right-pad / left-pad helpers for a minimal fixed-width table. */
function padEnd(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}
function padStart(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : " ".repeat(w - s.length) + s;
}

// --- import -----------------------------------------------------------------
async function cmdImport(args: Args): Promise<number> {
  const [source, file] = args.positionals;
  const account = flagString(args, "account");
  const ownerRaw = flagString(args, "owner");

  const ownerHint = PROFILE.owners.length > 0 ? PROFILE.owners.join("|") : "owner";
  if (!source || !file) {
    console.error(
      `usage: kopeika import <${connectorNames().join("|")}> <file> --account <name> --owner <${ownerHint}>`,
    );
    return 1;
  }
  const connector = getConnector(source);
  if (!connector) {
    console.error(`unknown source "${source}". Known: ${connectorNames().join(", ")}`);
    return 1;
  }
  if (!account) {
    console.error("--account <name> is required (e.g. revolut-eur, n26-alex)");
    return 1;
  }
  if (!ownerRaw || !isOwner(ownerRaw)) {
    console.error(`--owner is required (a non-empty label like ${ownerHint})`);
    return 1;
  }
  // When the profile declares an owner set, hold imports to it (typo guard). With
  // no profile, any non-empty owner is accepted.
  if (PROFILE.owners.length > 0 && !PROFILE.owners.includes(ownerRaw)) {
    console.error(`--owner "${ownerRaw}" is not in your profile owners: ${PROFILE.owners.join(", ")}`);
    return 1;
  }
  const owner: Owner = ownerRaw;
  if (!existsSync(file)) {
    console.error(`file not found: ${file}`);
    return 1;
  }

  const rawText = readFileSync(file, "utf8");

  // Connectors filter non-completed/invalid rows internally. We surface the count
  // of dropped rows by diffing against the connector's pre-filter view: the
  // connector returns only kept rows, so non-completed = (rows we won't see). We
  // recompute the raw data-row count to report skipped-non-completed accurately.
  const parsedRows = connector(rawText);
  const rawDataRowCount = countDataRows(rawText);
  const skippedNonCompleted = rawDataRowCount - parsedRows.length;

  // Archive the immutable original and record its basename.
  const sourceFile = archiveRaw(DATA_DIR, source, file);

  // FX table for native->EUR resolution.
  const rates = loadRates(RATES_PATH);
  const missingRates = new Map<string, { month: string; currency: string }>();

  const candidates: Transaction[] = parsedRows.map((row) => {
    let amountEur: number | null;
    if (row.amountEur !== null) {
      // Connector already provided an authoritative EUR value (N26).
      amountEur = row.amountEur;
    } else {
      const fx = toEur(row.amount_native, row.currency, row.date, rates);
      amountEur = fx.amount_eur;
      if (fx.missing) {
        missingRates.set(`${fx.missing.month}|${fx.missing.currency}`, fx.missing);
      }
    }

    const id = transactionId({
      data_source: source,
      account,
      date: row.date,
      merchant_raw: row.merchant_raw,
      amount_native: row.amount_native,
      currency: row.currency,
      dedupExtra: row.dedupExtra,
    });

    const tx: Transaction = {
      id,
      date: row.date,
      data_source: source,
      account,
      owner,
      merchant_raw: row.merchant_raw,
      merchant_clean: row.merchant_raw, // no cleaning pass yet; mirror raw
      amount_native: row.amount_native,
      currency: row.currency,
      amount_eur: amountEur,
      category: "",
      type: row.type,
      is_transfer: row.transferCandidate,
      transfer_group: "",
      fee: row.fee,
      note: row.note,
      source_file: sourceFile,
      balance: row.balance,
    };
    return tx;
  });

  const existing = loadLedger(LEDGER_PATH);
  const { appended, skippedDuplicate, merged } = appendDeduped(existing, candidates);
  writeLedger(LEDGER_PATH, merged);

  console.log(`imported ${appended} / skipped-dup ${skippedDuplicate} / skipped-non-completed ${skippedNonCompleted}`);

  if (missingRates.size > 0) {
    console.log("");
    console.log(`⚠ missing FX rates for ${missingRates.size} (month, currency) pair(s) — amount_eur left empty:`);
    for (const { month, currency } of [...missingRates.values()].sort((a, b) =>
      `${a.month}${a.currency}`.localeCompare(`${b.month}${b.currency}`),
    )) {
      console.log(`    ${month}  ${currency}   (add a row to data/rates.csv: ${month},${currency},<rate_to_eur>)`);
    }
  }

  return 0;
}

/** Count data rows (excluding header) in a CSV. Quote-safe: reuses the RFC 4180
 * parser so embedded newlines inside quoted fields are not miscounted. Used only
 * for the skipped-non-completed report (raw rows minus connector-kept rows). */
function countDataRows(text: string): number {
  return parseCsv(text).records.length;
}

// --- categorize -------------------------------------------------------------
async function cmdCategorize(args: Args): Promise<number> {
  const review = hasFlag(args, "review");
  const ledger = loadLedger(LEDGER_PATH);
  if (ledger.length === 0) {
    console.log("ledger is empty — import something first.");
    return 0;
  }

  if (review) {
    const unknowns = summarizeUnknowns(ledger);
    if (unknowns.length === 0) {
      console.log("no uncategorized merchants — every row has a category. 🎉");
      return 0;
    }
    console.log(`${unknowns.length} unique uncategorized merchant(s), sorted by spend desc:`);
    console.log("");
    console.log(`  ${padEnd("merchant_raw", 40)} ${padStart("count", 6)} ${padStart("eur_total", 12)}  missing_fx`);
    console.log(`  ${"-".repeat(40)} ${"-".repeat(6)} ${"-".repeat(12)}  ${"-".repeat(10)}`);
    for (const u of unknowns) {
      const missing = u.missingEurCount > 0 ? String(u.missingEurCount) : "";
      console.log(
        `  ${padEnd(u.merchant_raw, 40)} ${padStart(String(u.count), 6)} ${padStart(u.totalEur.toFixed(2), 12)}  ${missing}`,
      );
    }
    console.log("");
    console.log("Add a rule per merchant in data/rules.csv, then run: kopeika categorize");
    return 0;
  }

  const rules = loadRules(RULES_PATH);
  if (rules.length === 0) {
    console.log("no rules in data/rules.csv — nothing to apply. Run `categorize --review` to see unknowns.");
    return 0;
  }

  let categorized = 0;
  let retyped = 0;
  for (const tx of ledger) {
    if (tx.category !== "") continue; // only touch uncategorized rows
    const rule = firstMatch(rules, tx);
    if (!rule) continue;
    tx.category = rule.category;
    categorized += 1;
    if (rule.type !== null && rule.type !== tx.type) {
      tx.type = rule.type;
      retyped += 1;
    }
  }

  writeLedger(LEDGER_PATH, ledger);
  console.log(`categorized ${categorized} row(s)` + (retyped > 0 ? `, retyped ${retyped}` : ""));
  const remaining = ledger.filter((t) => t.category === "").length;
  if (remaining > 0) {
    console.log(`${remaining} row(s) still uncategorized — run \`categorize --review\` to triage.`);
  }
  return 0;
}

// --- transfers --------------------------------------------------------------
async function cmdTransfers(_args: Args): Promise<number> {
  const ledger = loadLedger(LEDGER_PATH);
  if (ledger.length === 0) {
    console.log("ledger is empty — import something first.");
    return 0;
  }

  const { pairs, unmatched, updated } = matchTransfers(ledger, DEFAULT_TRANSFER_OPTIONS);
  writeLedger(LEDGER_PATH, updated);

  console.log(
    `matched ${pairs.length} transfer pair(s) (tolerance €${DEFAULT_TRANSFER_OPTIONS.toleranceEur.toFixed(2)}, ±${DEFAULT_TRANSFER_OPTIONS.maxDayGap}d)`,
  );
  if (pairs.length > 0) {
    console.log("");
    for (const p of pairs) {
      console.log(`  ${p.groupId}`);
      console.log(
        `    out  ${p.outflow.date}  ${padEnd(p.outflow.account, 14)} ${padStart(fmtEur(p.outflow.amount_eur), 12)} EUR  ${p.outflow.merchant_raw}`,
      );
      console.log(
        `    in   ${p.inflow.date}  ${padEnd(p.inflow.account, 14)} ${padStart(fmtEur(p.inflow.amount_eur), 12)} EUR  ${p.inflow.merchant_raw}`,
      );
    }
  }

  if (unmatched.length > 0) {
    console.log("");
    console.log(`${unmatched.length} unmatched candidate leg(s):`);
    for (const u of unmatched) {
      console.log(
        `  ${u.date}  ${padEnd(u.account, 14)} ${padStart(fmtEur(u.amount_eur), 12)} EUR  ${u.merchant_raw}`,
      );
    }
  }
  return 0;
}

// --- recurring --------------------------------------------------------------
async function cmdRecurring(args: Args): Promise<number> {
  const ledger = loadLedger(LEDGER_PATH);
  if (ledger.length === 0) {
    console.log("ledger is empty — import something first.");
    return 0;
  }

  const minMonthsRaw = flagString(args, "min-months");
  let minMonths = DEFAULT_RECURRING_OPTIONS.minMonths;
  if (minMonthsRaw !== undefined) {
    const parsed = Number(minMonthsRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      console.error(`--min-months must be a positive integer (got "${minMonthsRaw}")`);
      return 1;
    }
    minMonths = parsed;
  }

  const fromFlag = flagString(args, "from");
  if (fromFlag !== undefined && !/^\d{4}-\d{2}$/.test(fromFlag)) {
    console.error(`--from must be YYYY-MM (got "${fromFlag}")`);
    return 1;
  }

  const tiers = loadTiers(TIERS_PATH);
  const recurring = detectRecurring(ledger, tiers, { minMonths, from: fromFlag });

  if (recurring.length === 0) {
    console.log(`no merchant appears in ≥${minMonths} distinct months${fromFlag ? ` since ${fromFlag}` : ""}.`);
    return 0;
  }

  const tiered = tiersConfigured(tiers);
  const floorTotal = recurring.filter((r) => r.tier === "mandatory").reduce((s, r) => s + r.perMonth, 0);
  const flexTotal = recurring.filter((r) => r.tier === "optional").reduce((s, r) => s + r.perMonth, 0);

  console.log(
    `${recurring.length} recurring merchant(s) — seen in ≥${minMonths} distinct months${fromFlag ? ` since ${fromFlag}` : ""}, by €/mo desc`,
  );
  console.log("");
  console.log(
    `  ${padStart("#mo", 4)} ${padStart("~eur/mo", 9)} ${padEnd("tier", 6)} ${padEnd("category", 16)} ${padEnd("since", 8)} merchant`,
  );
  console.log(`  ${"-".repeat(4)} ${"-".repeat(9)} ${"-".repeat(6)} ${"-".repeat(16)} ${"-".repeat(8)} ${"-".repeat(24)}`);
  for (const r of recurring) {
    // padEnd counts UTF-16 units; the lock/balloon emoji is 2, so pad the ASCII
    // label to a fixed width and prefix the emoji separately to keep columns aligned.
    const tierLabel = tiered ? (r.tier === "mandatory" ? `🔒 ${padEnd("fix", 3)}` : `🎈 ${padEnd("opt", 3)}`) : padEnd("—", 6);
    console.log(
      `  ${padStart(String(r.monthsCount), 4)} ${padStart(fmtMoney(r.perMonth), 9)} ${tierLabel} ${padEnd(r.category, 16)} ${padEnd(r.firstMonth, 8)} ${r.merchant_raw}`,
    );
  }
  console.log("");
  if (tiered) {
    console.log(
      `recurring backbone ≈ €${fmtMoney(floorTotal + flexTotal)}/mo  (🔒 floor €${fmtMoney(floorTotal)}/mo · 🎈 flex €${fmtMoney(flexTotal)}/mo)`,
    );
    console.log("note: recurring ≠ mandatory — frequent buys (groceries, Amazon) recur but flex; only 🔒 rows are the fixed floor.");
  } else {
    console.log(`recurring backbone ≈ €${fmtMoney(floorTotal + flexTotal)}/mo  (no tiers configured — add data/tiers.csv to split floor vs flex)`);
  }
  return 0;
}

// --- list -------------------------------------------------------------------
async function cmdList(args: Args): Promise<number> {
  const ledger = loadLedger(LEDGER_PATH);
  const sourceFilter = flagString(args, "source");
  const monthFilter = flagString(args, "month");
  const onlyUncategorized = hasFlag(args, "uncategorized");

  let rows = ledger;
  if (sourceFilter) rows = rows.filter((t) => t.data_source === sourceFilter);
  if (monthFilter) rows = rows.filter((t) => t.date.startsWith(monthFilter));
  if (onlyUncategorized) rows = rows.filter((t) => t.category === "");

  rows = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (rows.length === 0) {
    console.log("no rows match the given filters.");
    return 0;
  }

  console.log(
    `  ${padEnd("date", 10)} ${padEnd("account", 13)} ${padStart("native", 12)} ${padEnd("cur", 4)} ${padStart("eur", 11)} ${padEnd("type", 9)} ${padEnd("category", 14)} merchant`,
  );
  console.log(`  ${"-".repeat(10)} ${"-".repeat(13)} ${"-".repeat(12)} ${"-".repeat(4)} ${"-".repeat(11)} ${"-".repeat(9)} ${"-".repeat(14)} ${"-".repeat(20)}`);

  let totalEur = 0;
  let missingEur = 0;
  for (const t of rows) {
    if (t.amount_eur === null) missingEur += 1;
    else totalEur += t.amount_eur;
    const cat = t.category === "" ? "(none)" : t.category;
    console.log(
      `  ${padEnd(t.date, 10)} ${padEnd(t.account, 13)} ${padStart(fmtNative(t.amount_native), 12)} ${padEnd(t.currency, 4)} ${padStart(fmtEur(t.amount_eur), 11)} ${padEnd(t.type, 9)} ${padEnd(cat, 14)} ${t.merchant_raw}`,
    );
  }

  console.log("");
  console.log(`  ${rows.length} row(s)   net EUR ${totalEur.toFixed(2)}` + (missingEur > 0 ? `   (${missingEur} row(s) missing FX — excluded from total)` : ""));
  return 0;
}

// --- report -----------------------------------------------------------------
/** Format an EUR figure with no decimals and comma thousands for the text table. */
function fmtMoney(n: number): string {
  const rounded = Math.round(n);
  const sign = rounded < 0 ? "-" : "";
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${digits}`;
}

/** Clamp a raw savings-rate fraction to a 0–100% integer string for display. */
function fmtRate(fraction: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  return `${Math.round(clamped * 100)}%`;
}

/** Print the per-month summary table (income / spend / saved / rate). */
function printMonthsTable(report: Report): void {
  console.log(
    `  ${padEnd("month", 9)} ${padStart("income", 11)} ${padStart("spend", 11)} ${padStart("saved", 11)} ${padStart("rate", 6)}`,
  );
  console.log(`  ${"-".repeat(9)} ${"-".repeat(11)} ${"-".repeat(11)} ${"-".repeat(11)} ${"-".repeat(6)}`);
  for (const m of report.months) {
    console.log(
      `  ${padEnd(m.month, 9)} ${padStart(fmtMoney(m.income), 11)} ${padStart(fmtMoney(m.spend), 11)} ${padStart(fmtMoney(m.saved), 11)} ${padStart(fmtRate(m.savingsRate), 6)}`,
    );
  }
  const o = report.overall;
  console.log(`  ${"-".repeat(9)} ${"-".repeat(11)} ${"-".repeat(11)} ${"-".repeat(11)} ${"-".repeat(6)}`);
  console.log(
    `  ${padEnd("ALL", 9)} ${padStart(fmtMoney(o.income), 11)} ${padStart(fmtMoney(o.spend), 11)} ${padStart(fmtMoney(o.saved), 11)} ${padStart(fmtRate(o.savingsRate), 6)}`,
  );
}

/** Print the category breakdown for one focus month. */
function printCategoryTable(month: MonthSummary): void {
  console.log(`category breakdown — ${month.month} (spend €${fmtMoney(month.spend)})`);
  console.log("");
  if (month.categories.length === 0) {
    console.log("  (no spend recorded this month)");
    return;
  }
  console.log(`  ${padEnd("category", 24)} ${padStart("eur", 11)} ${padStart("share", 7)} ${padStart("count", 6)}`);
  console.log(`  ${"-".repeat(24)} ${"-".repeat(11)} ${"-".repeat(7)} ${"-".repeat(6)}`);
  for (const c of month.categories) {
    console.log(
      `  ${padEnd(c.category, 24)} ${padStart(fmtMoney(c.amount), 11)} ${padStart(`${Math.round(c.share * 100)}%`, 7)} ${padStart(String(c.count), 6)}`,
    );
  }
  console.log(`  ${"-".repeat(24)} ${"-".repeat(11)} ${"-".repeat(7)} ${"-".repeat(6)}`);
  console.log(
    `  ${padEnd("TOTAL", 24)} ${padStart(fmtMoney(month.spend), 11)} ${padStart("100%", 7)} ${padStart("", 6)}`,
  );
}

/**
 * Print the floor-vs-flex split for the focus month: mandatory (fixed obligation)
 * vs optional (discretionary) spend, each as the headline €/mo figure, with the
 * range per-month average underneath. Silent when no tiers are configured.
 */
function printFloorFlex(focus: MonthSummary, report: Report): void {
  if (focus.floor === null || focus.flex === null) {
    console.log("floor vs flex: (no tiers configured — add mandatory rows to data/tiers.csv)");
    return;
  }
  const o = report.overall;
  const months = o.monthCount > 0 ? o.monthCount : 1;
  const floorAvg = (o.floor ?? 0) / months;
  const flexAvg = (o.flex ?? 0) / months;
  const total = focus.floor + focus.flex;
  const floorPct = total > 0 ? Math.round((focus.floor / total) * 100) : 0;

  console.log(`floor vs flex — ${focus.month}`);
  console.log("");
  console.log(`  🔒 Floor (mandatory)  €${fmtMoney(focus.floor)}/mo   ${floorPct}% of spend`);
  console.log(`  🎈 Flex  (optional)   €${fmtMoney(focus.flex)}/mo   ${100 - floorPct}% of spend`);
  if (report.months.length > 1) {
    console.log(
      `  range avg/mo:  floor €${fmtMoney(floorAvg)}  ·  flex €${fmtMoney(flexAvg)}  (over ${months} month(s))`,
    );
  }
}

async function cmdReport(args: Args): Promise<number> {
  const ledger = loadLedger(LEDGER_PATH);
  if (ledger.length === 0) {
    console.log("ledger is empty — import something first.");
    return 0;
  }

  const monthFlag = flagString(args, "month");
  const fromFlag = flagString(args, "from");
  const htmlPath = flagString(args, "html");

  // --month YYYY-MM and --from YYYY-MM are validated loosely: they must look
  // like a year-month, otherwise the filter would silently match nothing.
  for (const [name, value] of [["month", monthFlag], ["from", fromFlag]] as const) {
    if (value !== undefined && !/^\d{4}-\d{2}$/.test(value)) {
      console.error(`--${name} must be YYYY-MM (got "${value}")`);
      return 1;
    }
  }

  const tiers = loadTiers(TIERS_PATH);
  const report = buildReport(ledger, { month: monthFlag, from: fromFlag }, tiers);
  if (report.months.length === 0) {
    console.log("no transactions matched the selected range (after excluding transfers/exchanges).");
    return 0;
  }

  // Focus month for the category detail + dashboard hero:
  //   --month -> that month; otherwise the most recent COMPLETE month.
  const focusMonth =
    monthFlag !== undefined ? monthFlag : latestCompleteMonth(report) ?? report.months[report.months.length - 1]!.month;
  const focus = report.months.find((m) => m.month === focusMonth);
  if (focus === undefined) {
    // Defensive: latestCompleteMonth always returns a month present in report.
    console.error(`internal error: focus month ${focusMonth} not in report`);
    return 1;
  }

  // --- Text output ---
  const o = report.overall;
  console.log(`kopeika report — ${report.months[0]!.month} … ${report.months[report.months.length - 1]!.month}  (${report.months.length} month(s))`);
  console.log("");
  printMonthsTable(report);
  console.log("");
  printCategoryTable(focus);
  console.log("");
  printFloorFlex(focus, report);
  console.log("");

  // Coverage / warnings: missing-FX rows are excluded from sums (never guessed),
  // and a high uncategorized share is expected until rules land.
  const uncategorized = focus.categories.find((c) => c.category === "Uncategorized");
  const uncatShare = uncategorized ? uncategorized.share : 0;
  console.log(
    `range totals: income €${fmtMoney(o.income)} · spend €${fmtMoney(o.spend)} · saved €${fmtMoney(o.saved)} (${fmtRate(o.savingsRate)})` +
      (o.invested > 0 ? ` · put aside €${fmtMoney(o.invested)} (into savings)` : ""),
  );
  console.log(
    `coverage: ${o.countedRows} row(s) counted, ${report.excludedRows} excluded (transfers/exchanges/Exclude)` +
      (o.missingEurCount > 0 ? `, ⚠ ${o.missingEurCount} row(s) missing FX — not counted` : ""),
  );
  if (uncatShare >= 0.4) {
    console.log(
      `⚠ ${Math.round(uncatShare * 100)}% of ${focus.month} spend is Uncategorized — expected until rules land; add rules and re-run \`categorize\`.`,
    );
  }

  // --- HTML dashboard ---
  if (htmlPath !== undefined) {
    // Projection panel: only when savings destinations are declared. Reads the
    // same savings stock + recent-actual rate the `project` command uses.
    const savingsCfg = loadSavingsConfig(SAVINGS_PATH);
    let projection: ProjectionView | undefined;
    let series: ReturnType<typeof savingsSeries> | undefined;
    if (savingsConfigured(savingsCfg)) {
      const stock = savingsStock(ledger, savingsCfg);
      const rates = loadRates(RATES_PATH);
      const rubToEur = rateToEur(rates, "RUB");
      const cnyToEur = rateToEur(rates, "CNY");

      const rub = rubToEur ?? 0.0105;
      const cny = cnyToEur ?? 0.127;

      // The illiquid net-worth layer (property net of its mortgage, plus any held
      // note) comes from data/profile.json — facts about the world, not ledger rows.
      // With no profile marks the chart shows liquid savings only.
      let netWorth: ProjectionView["netWorth"];
      const marks = PROFILE.netWorth;
      if (marks) {
        const flatsEur = Math.round(marks.flatsRub * rub);
        const mortgageEur = Math.round(marks.mortgageRub * rub);
        netWorth = {
          propertyEur: flatsEur - mortgageEur,
          propertyBaseEur: flatsEur,
          propertyDebtEur: mortgageEur,
          propertyApr: marks.propertyApr,
          bcsEur: Math.round(marks.bcsNominalCny * cny),
          // Rouble goal lines, generated from the RUB rate (not personal data).
          milestones: [2_500_000, 5_000_000, 10_000_000, 15_000_000, 20_000_000, 25_000_000, 30_000_000].map(
            (r) => ({ eur: Math.round(r * rub), label: `${r / 1_000_000}M ₽`, hero: false }),
          ),
        };
      }

      projection = {
        startEur: stock.totalEur,
        defaultRateEur: recentMonthlyRate(ledger, savingsCfg),
        rubPerEur: rubToEur !== null && rubToEur > 0 ? 1 / rubToEur : null,
        components: stock.components,
        lookbackMonths: DEFAULT_RATE_LOOKBACK,
        netWorth,
      };
      series = savingsSeries(ledger, savingsCfg);
    }
    const now = new Date();
    const nowMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    // Spend dropdown: 2026 months only (2025 and earlier are not categorized), each
    // with its grouped spend, plus a "whole year so far" aggregate.
    const spendMonths = report.months.map((m) => m.month).filter((m) => m >= "2026-01");
    const months = spendMonths.map((m) => ({ month: m, groups: buildSpendGroups(ledger, m, tiers) }));
    if (spendMonths.length > 0) {
      months.push({ month: "2026", groups: buildSpendGroups(ledger, "2026", tiers) });
    }
    const selectedMonth = spendMonths.length > 0 ? spendMonths[spendMonths.length - 1]! : focus.month;
    const lang = flagString(args, "lang") === "ru" ? "ru" : "en";
    const html = renderDashboard({
      report,
      focusMonth: focus.month,
      today: now,
      nowMonth,
      lang,
      projection,
      series,
      months,
      selectedMonth,
      display: {
        footer: PROFILE.footer,
        accountLabels: PROFILE.accountLabels,
        merchantInfo: PROFILE.merchantInfo,
      },
    });
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, html, "utf8");
    console.log("");
    console.log(`✓ wrote dashboard (${html.length} bytes) → ${htmlPath}`);
    console.log(`  open it: file://${htmlPath.startsWith("/") ? htmlPath : join(process.cwd(), htmlPath)}`);
  }

  return 0;
}

// --- project ----------------------------------------------------------------
/** Short note describing what a stock component is made of, for the breakdown. */
function stockKindNote(kind: StockComponent["kind"]): string {
  switch (kind) {
    case "account":
      return "cost basis";
    case "marker":
      return "savings pot";
    case "anchor":
      return "set balance";
  }
}

/** Parse a numeric flag, returning {ok,value} so callers can error with context. */
function numberFlag(args: Args, name: string): { value: number | undefined; bad: string | null } {
  const raw = flagString(args, name);
  if (raw === undefined) return { value: undefined, bad: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { value: undefined, bad: raw };
  return { value: n, bad: null };
}

async function cmdProject(args: Args): Promise<number> {
  const ledger = loadLedger(LEDGER_PATH);
  if (ledger.length === 0) {
    console.log("ledger is empty — import something first.");
    return 0;
  }

  const config = loadSavingsConfig(SAVINGS_PATH);

  // --lump-sum <eur>: a what-if lump sum added to the stock (the lump-sum account
  // is unknown until you set the number; this stands in for an `anchor` row).
  const lump = numberFlag(args, "lump-sum");
  if (lump.bad !== null) {
    console.error(`--lump-sum must be a number in EUR (got "${lump.bad}")`);
    return 1;
  }
  // --rate <eur/mo>: the slider. Defaults to the recent actual savings rate.
  const rateFlag = numberFlag(args, "rate");
  if (rateFlag.bad !== null) {
    console.error(`--rate must be a number in EUR/month (got "${rateFlag.bad}")`);
    return 1;
  }
  // --years N: projection horizon (default 5).
  const yearsFlag = numberFlag(args, "years");
  if (yearsFlag.bad !== null || (yearsFlag.value !== undefined && (!Number.isInteger(yearsFlag.value) || yearsFlag.value < 1))) {
    console.error(`--years must be a positive integer (got "${flagString(args, "years")}")`);
    return 1;
  }
  const years = yearsFlag.value ?? 5;

  // Starting stock = declared savings (cost basis + pots + anchors), plus any
  // what-if lump sum from the flag.
  const stock = savingsStock(ledger, config);
  const components: StockComponent[] = [...stock.components];
  if (lump.value !== undefined) {
    components.push({ label: "lump-sum (--lump-sum)", eur: lump.value, kind: "anchor" });
  }
  const startEur = round2Eur(components.reduce((s, c) => s + c.eur, 0));

  // Go-forward monthly rate: the dial. Default is the recent actual.
  const defaultRate = recentMonthlyRate(ledger, config);
  const rateIsDefault = rateFlag.value === undefined;
  const monthlyRateEur = rateFlag.value ?? defaultRate;

  // EUR -> RUB for the dual-currency line, from data/rates.csv (RUB rate_to_eur).
  const rates = loadRates(RATES_PATH);
  const rubToEur = rateToEur(rates, "RUB");
  const rubPerEur = rubToEur !== null && rubToEur > 0 ? 1 / rubToEur : null;

  const input: ProjectionInput = { startEur, monthlyRateEur, horizonMonths: years * 12, rubPerEur };

  // --- output ---
  console.log("kopeika projection — where the savings land");
  console.log("");

  if (!savingsConfigured(config) && lump.value === undefined) {
    console.log("no savings declared yet — add destinations to data/savings.csv:");
    console.log("  account,trading212,        (a whole account is savings; stock = cost basis)");
    console.log("  marker,HOUSE,              (a move into an in-account savings pot)");
    console.log("  anchor,Lump-sum,12000      (a not-yet-imported savings account, by balance)");
    console.log("");
    console.log("then re-run `kopeika project`. Starting from €0 for now.");
    console.log("");
  }

  console.log("starting stock (today)");
  for (const c of components) {
    console.log(`  ${padEnd(c.label, 28)} ${padStart("€" + fmtMoney(c.eur), 12)}   ${stockKindNote(c.kind)}`);
  }
  console.log(`  ${"-".repeat(28)} ${"-".repeat(12)}`);
  console.log(`  ${padEnd("total savings now", 28)} ${padStart("€" + fmtMoney(startEur), 12)}`);
  console.log("");

  const rateNote = rateIsDefault
    ? `recent actual, last ${DEFAULT_RATE_LOOKBACK} complete months — drag with --rate <eur/mo>`
    : "your set rate (--rate)";
  console.log(`go-forward rate: €${fmtMoney(monthlyRateEur)}/mo  (${rateNote})`);
  if (rateIsDefault && defaultRate === 0) {
    console.log("  (no recent savings flow found — the line stays flat until you set a rate or save more)");
  }
  console.log("");

  // Milestones: now, 1 year, and the horizon (deduped when years == 1).
  const milestoneMonths = [...new Set([0, 12, years * 12])].filter((m) => m <= years * 12).sort((a, b) => a - b);
  const showRub = rubPerEur !== null;
  console.log(`  ${padEnd("", 18)} ${padStart("EUR", 12)}${showRub ? "   " + padStart("RUB", 14) : ""}`);
  for (const m of milestoneMonths) {
    const p = projectAt(input, m);
    const label = m === 0 ? "now" : m % 12 === 0 ? `in ${m / 12} year${m === 12 ? "" : "s"}` : `in ${m} months`;
    const eurCol = padStart("€" + fmtMoney(p.eur), 12);
    const rubCol = showRub && p.rub !== null ? "   " + padStart("₽" + fmtMoney(p.rub), 14) : "";
    console.log(`  ${padEnd(label, 18)} ${eurCol}${rubCol}`);
  }
  console.log("");

  const fxNote = rubPerEur !== null ? ` RUB at ₽${fmtMoney(rubPerEur)}/€ (data/rates.csv, flat for now).` : "";
  console.log(`ETF held flat at cost basis. The rate is an assumption you set.${fxNote}`);
  return 0;
}

/** Round an EUR figure to 2 decimals (avoids -0); the stock display sums components. */
function round2Eur(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return r === 0 ? 0 : r;
}

// --- help -------------------------------------------------------------------
function printHelp(): void {
  console.log(`kopeika — deterministic local-first bookkeeping

USAGE
  kopeika import <${connectorNames().join("|")}> <file> --account <name> --owner <owner>
      Archive the raw export, parse, normalize, FX-convert, dedup, append to ledger.
      Prints: imported / skipped-dup / skipped-non-completed, plus any missing FX rates.

  kopeika categorize [--review]
      Apply ratified rules (data/rules.csv) to uncategorized rows, first match wins.
      --review  list unique uncategorized merchants with counts + summed EUR (spend desc).

  kopeika transfers
      Pair internal-transfer legs across accounts (opposite sign, |Δeur| ≤ €${DEFAULT_TRANSFER_OPTIONS.toleranceEur}, ±${DEFAULT_TRANSFER_OPTIONS.maxDayGap}d).
      Assigns a shared transfer_group and sets is_transfer=true. Re-runnable.

  kopeika recurring [--min-months N] [--from YYYY-MM]
      List merchants seen as spend in many distinct months (the deterministic
      backbone), sorted by €/mo. Tags each 🔒 floor / 🎈 flex from data/tiers.csv.
      Recurring ≠ mandatory: frequent buys recur but flex; only 🔒 is the floor.
      --min-months N    distinct-month threshold (default ${DEFAULT_RECURRING_OPTIONS.minMonths}).
      --from YYYY-MM    only count rows on/after this month.

  kopeika list [--source <x>] [--uncategorized] [--month YYYY-MM]
      Print a table of ledger rows with a net-EUR total.

  kopeika report [--month YYYY-MM] [--from YYYY-MM] [--html <path>]
      Income / spend / saved per month + category breakdown + floor-vs-flex split,
      from amount_eur. Excludes internal transfers, exchanges, and Exclude rows.
      Floor (mandatory) vs flex (optional) is read from data/tiers.csv.
      Default (no flags): all-month summary + the most recent complete month.
      --month YYYY-MM   focus a single month (summary still spans that month).
      --from  YYYY-MM   only months >= this one.
      --html  <path>    also write a self-contained HTML dashboard to <path>.

  kopeika project [--rate <eur/mo>] [--lump-sum <eur>] [--years N]
      Project the savings stock forward. Starting stock = the savings destinations
      in data/savings.csv (account cost basis + in-account pots + manual anchors).
      Roll it forward at a monthly rate (the slider), default the recent actual,
      shown in EUR and RUB with the ETF held flat at cost basis.
      --rate <eur/mo>   set the go-forward monthly savings rate (overrides default).
      --lump-sum <eur>  add a what-if lump sum to today's stock.
      --years N         projection horizon in years (default 5; always shows 1y too).

  kopeika --help

DATA (all gitignored under data/)
  data/raw/<source>/   immutable original exports
  data/ledger.csv      clean normalized ledger
  data/rules.csv       pattern,match_type,field,category,type
  data/rates.csv       month,currency,rate_to_eur
  data/tiers.csv       scope,value,tier  (mandatory=floor, else flex)
  data/savings.csv     scope,value,balance_eur  (account|marker|anchor savings)

NOT IMPLEMENTED (v0 stubs): Google Sheets mirror/push, LLM --suggest categorization.
No LLM is called at runtime — the core is fully deterministic.`);
}

// --- entry ------------------------------------------------------------------
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  // Load the personal layer (own names/IBANs, net-worth marks, display labels) and
  // install the own-account identity the connectors use for transfer detection.
  PROFILE = loadProfile(PROFILE_PATH);
  setIdentity(PROFILE.ownNames, PROFILE.ownIbans);

  const command = args.positionals.shift();

  if (!command || command === "--help" || hasFlag(args, "help") || command === "help") {
    printHelp();
    return 0;
  }

  switch (command) {
    case "import":
      return cmdImport(args);
    case "categorize":
      return cmdCategorize(args);
    case "transfers":
      return cmdTransfers(args);
    case "recurring":
      return cmdRecurring(args);
    case "list":
      return cmdList(args);
    case "report":
      return cmdReport(args);
    case "project":
      return cmdProject(args);
    default:
      console.error(`unknown command "${command}". Run \`kopeika --help\`.`);
      return 1;
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    // Fail loudly with context — never swallow.
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error("kopeika: fatal error\n" + message);
    process.exit(1);
  });
