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

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
import { backfillEur, loadRates, rateToEur, toEur } from "./fx.ts";
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
import { parseLexofficeDatev, type DatevFile } from "./connectors/lexoffice-datev.ts";
import { loadPack } from "./tax/pack.ts";
import {
  listPersons,
  loadPerson,
  savePins,
  taxRuleMatches,
  type Person,
} from "./tax/person.ts";
import { buildEuer, loadAssets } from "./tax/euer.ts";
import {
  clientsPath,
  commitCounter,
  deriveClientsFromDatev,
  findChrome,
  findClient,
  fmtDeMoney,
  formatInvoiceNumber,
  htmlToPdf,
  loadClients,
  loadCounter,
  logoDataUri,
  mergeClients,
  nextKundennr,
  parseInvoiceProfile,
  paypalAmountSegment,
  renderInvoiceHtml,
  saveClients,
  type Client,
} from "./tax/invoice.ts";
import { encodeQr, qrToSvg } from "./tax/qr.ts";
import {
  applyForward,
  evaluateThresholds,
  loadForward,
  loadThresholds,
  monthsElapsedInYear,
  pickBinding,
  type ThresholdEval,
  type YearActuals,
} from "./tax/thresholds.ts";
import { EXCLUDE_CATEGORY } from "./analytics.ts";

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
// The household profile lives in profiles/ (the consolidated PII zone) since the
// tax face landed; data/profile.json is the pre-migration location and still reads.
const PROFILE_PATHS = [join(ROOT, "profiles", "household.json"), join(DATA_DIR, "profile.json")];

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
      `usage: kopeika import <${[...connectorNames(), "lexoffice-datev"].join("|")}> <file> --account <name> --owner <${ownerHint}>`,
    );
    return 1;
  }
  if (source === "lexoffice-datev") {
    return cmdImportDatev(args);
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
      tax_person: "",
      tax_category: "",
      tax_source: "",
    };
    return tx;
  });

  const existing = loadLedger(LEDGER_PATH);
  const { appended, skippedDuplicate, merged } = appendDeduped(existing, candidates);
  // Rows imported before their FX rate existed carry amount_eur=null; now that
  // the rates table may have grown, resolve them (deterministic, never guessed).
  const backfilled = backfillEur(merged, rates);
  writeLedger(LEDGER_PATH, merged);

  console.log(`imported ${appended} / skipped-dup ${skippedDuplicate} / skipped-non-completed ${skippedNonCompleted}`);
  if (backfilled > 0) {
    console.log(`backfilled amount_eur for ${backfilled} earlier row(s) from data/rates.csv`);
  }

  if (missingRates.size > 0) {
    console.log("");
    console.log(`⚠ missing FX rates for ${missingRates.size} (month, currency) pair(s) — amount_eur left empty:`);
    for (const { month, currency } of [...missingRates.values()].sort((a, b) =>
      `${a.month}${a.currency}`.localeCompare(`${b.month}${b.currency}`),
    )) {
      console.log(`    ${month}  ${currency}   (add a row to data/rates.csv: ${month},${currency},<rate_to_eur>)`);
    }
    console.log("    then re-run `kopeika report` — already-imported rows are backfilled once the rate exists.");
  }

  return 0;
}

/** Count data rows (excluding header) in a CSV. Quote-safe: reuses the RFC 4180
 * parser so embedded newlines inside quoted fields are not miscounted. Used only
 * for the skipped-non-completed report (raw rows minus connector-kept rows). */
function countDataRows(text: string): number {
  return parseCsv(text).records.length;
}

// --- import lexoffice-datev (a DIRECTORY of DATEV Beleg XMLs) ----------------
/**
 * Book rows, not bank rows: each DATEV ledger entry lands with the household
 * category "Exclude" (invisible to the family analytics) and a full tax
 * disposition from the SKR account code via the person's country pack. An
 * unmapped SKR code leaves the row undisposed — it queues, never guessed.
 */
async function cmdImportDatev(args: Args): Promise<number> {
  const [, dir] = args.positionals;
  const account = flagString(args, "account");
  const ownerRaw = flagString(args, "owner");
  const who = flagString(args, "who") ?? ownerRaw;

  if (!dir || !account || !ownerRaw) {
    console.error(
      "usage: kopeika import lexoffice-datev <unzipped-export-dir> --account <name> --owner <owner> [--who <person>]",
    );
    return 1;
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`not a directory: ${dir} — unzip the DATEV Belegbilder export and pass the folder`);
    return 1;
  }
  if (PROFILE.owners.length > 0 && !PROFILE.owners.includes(ownerRaw)) {
    console.error(`--owner "${ownerRaw}" is not in your profile owners: ${PROFILE.owners.join(", ")}`);
    return 1;
  }
  const owner: Owner = ownerRaw;

  // The person's profile names the country pack that maps SKR codes.
  const person = loadPerson(ROOT, who!);
  const pack = loadPack(ROOT, person.profile.pack);

  const xmlNames = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".xml")).sort();
  if (xmlNames.length === 0) {
    console.error(`no .xml files in ${dir}`);
    return 1;
  }
  const files: DatevFile[] = xmlNames.map((name) => ({
    name,
    text: readFileSync(join(dir, name), "utf8"),
  }));
  const entries = parseLexofficeDatev(files);

  // Archive every XML immutably under data/raw/lexoffice-datev/<export-dir-name>/.
  const batch = basename(dir.replace(/\/+$/, ""));
  const rawDir = join(DATA_DIR, "raw", "lexoffice-datev", batch);
  mkdirSync(rawDir, { recursive: true });
  let archived = 0;
  for (const f of files) {
    const dest = join(rawDir, f.name);
    if (!existsSync(dest)) {
      writeFileSync(dest, f.text, "utf8");
      archived += 1;
    }
  }

  const rates = loadRates(RATES_PATH);
  const missingRates = new Map<string, { month: string; currency: string }>();
  let unmappedSkr = new Map<string, number>();

  const candidates: Transaction[] = entries.map((e) => {
    let amountEur: number | null;
    if (e.currency === "EUR") {
      amountEur = e.amount;
    } else {
      const fx = toEur(e.amount, e.currency, e.date, rates);
      amountEur = fx.amount_eur;
      if (fx.missing) missingRates.set(`${fx.missing.month}|${fx.missing.currency}`, fx.missing);
    }
    const taxCategory = pack.skr.get(e.accountNo) ?? "";
    if (taxCategory === "") {
      unmappedSkr.set(e.accountNo, (unmappedSkr.get(e.accountNo) ?? 0) + 1);
    }
    const id = transactionId({
      data_source: "lexoffice-datev",
      account,
      date: e.date,
      merchant_raw: e.merchant,
      amount_native: e.amount,
      currency: e.currency,
      dedupExtra: e.dedupExtra,
    });
    return {
      id,
      date: e.date,
      data_source: "lexoffice-datev",
      account,
      owner,
      merchant_raw: e.merchant,
      merchant_clean: e.merchant,
      amount_native: e.amount,
      currency: e.currency,
      amount_eur: amountEur,
      category: EXCLUDE_CATEGORY, // book documentation, not household cash flow
      type: e.side === "income" ? "income" : "spend",
      is_transfer: false,
      transfer_group: "",
      fee: 0,
      // Fidelity: the Beleg's own identifiers ride along on the row.
      note: `${e.invoiceId} · SKR ${e.accountNo} ${e.accountName}${e.information !== "" ? ` · ${e.information}` : ""}`,
      source_file: e.file,
      balance: null,
      tax_person: who!,
      tax_category: taxCategory,
      tax_source: taxCategory !== "" ? "import" : "",
    };
  });

  const existing = loadLedger(LEDGER_PATH);
  const { appended, skippedDuplicate, merged } = appendDeduped(existing, candidates);

  // A grown pack heals old rows: when a re-import parses the same entry and the
  // SKR code now maps, an existing row still UNDISPOSED (no pin, no rule, no
  // import category) adopts the mapping. Decided rows are never touched.
  const byId = new Map(candidates.map((c) => [c.id, c]));
  let taxBackfilled = 0;
  for (const tx of merged) {
    const cand = byId.get(tx.id);
    if (!cand) continue;
    if (tx.tax_category === "" && tx.tax_source === "" && cand.tax_category !== "") {
      tx.tax_person = cand.tax_person;
      tx.tax_category = cand.tax_category;
      tx.tax_source = cand.tax_source;
      taxBackfilled += 1;
    }
  }
  writeLedger(LEDGER_PATH, merged);

  const incomeNet = candidates
    .filter((c) => c.type === "income" && c.amount_eur !== null)
    .reduce((s, c) => s + c.amount_eur!, 0);
  const expenseNet = candidates
    .filter((c) => c.type === "spend" && c.amount_eur !== null)
    .reduce((s, c) => s - c.amount_eur!, 0);

  console.log(
    `parsed ${files.length} XML file(s) -> ${entries.length} ledger entr(ies); imported ${appended} / skipped-dup ${skippedDuplicate} / archived ${archived} raw file(s)` +
      (taxBackfilled > 0 ? ` / tax-backfilled ${taxBackfilled} undisposed row(s)` : ""),
  );
  console.log(
    `source totals: income net €${incomeNet.toFixed(2)} · expenses €${expenseNet.toFixed(2)} (books of "${who}", account ${account})`,
  );
  if (unmappedSkr.size > 0) {
    console.log("");
    console.log(`⚠ ${unmappedSkr.size} SKR code(s) not in the ${person.profile.pack} pack — rows queued undisposed:`);
    for (const [code, n] of unmappedSkr) {
      console.log(`    SKR ${code}  (${n} row(s))  — add it to categories.${person.profile.pack}.json or \`decide\` each row`);
    }
  }
  if (missingRates.size > 0) {
    console.log(`⚠ missing FX rates for ${missingRates.size} pair(s) — see data/rates.csv`);
  }
  console.log(`verify: kopeika report --who ${who} --year ${entries[0]?.date.slice(0, 4) ?? ""}`);
  return 0;
}

// --- tax: categorize --who ----------------------------------------------------
/**
 * The deterministic tax pass: pins first (never overridden), then ratified
 * rules (fill EMPTY dispositions only), then the queue — undisposed rows on
 * `dedicated` accounts, listed for explicit `decide`. Nothing is ever guessed.
 */
async function cmdTaxCategorize(who: string, _args: Args): Promise<number> {
  const person = loadPerson(ROOT, who);
  const pack = loadPack(ROOT, person.profile.pack);
  const ledger = loadLedger(LEDGER_PATH);
  if (ledger.length === 0) {
    console.log("ledger is empty — import something first.");
    return 0;
  }

  // Validate rule/pin categories against the pack up front — a typo fails loud.
  for (const r of person.rules) {
    if (!pack.categories.has(r.category)) {
      console.error(`rules.json: rule "${r.pattern}" names unknown category "${r.category}"`);
      return 1;
    }
  }
  for (const [txid, pin] of person.pins) {
    if (!pack.categories.has(pin.category)) {
      console.error(`pins.json: pin ${txid} names unknown category "${pin.category}"`);
      return 1;
    }
  }

  let pinned = 0;
  let ruled = 0;
  let conflicts = 0;
  for (const tx of ledger) {
    const pin = person.pins.get(tx.id);
    if (pin) {
      if (tx.tax_person !== "" && tx.tax_person !== who && tx.tax_source === "pin") {
        console.error(`⚠ pin conflict: ${tx.id} is pinned on "${tx.tax_person}"'s books — skipped`);
        conflicts += 1;
        continue;
      }
      if (tx.tax_person !== who || tx.tax_category !== pin.category || tx.tax_source !== "pin") {
        tx.tax_person = who;
        tx.tax_category = pin.category;
        tx.tax_source = "pin";
        pinned += 1;
      }
      continue;
    }
    // Rules fill EMPTY dispositions only: never a pin, never an import-carried
    // category, never another person's row.
    if (tx.tax_source !== "" || (tx.tax_person !== "" && tx.tax_person !== who)) continue;
    const rule = person.rules.find((r) => taxRuleMatches(r, tx));
    if (rule) {
      tx.tax_person = who;
      tx.tax_category = rule.category;
      tx.tax_source = "rule";
      ruled += 1;
    }
  }
  writeLedger(LEDGER_PATH, ledger);

  const queue = taxQueue(ledger, person);
  console.log(
    `tax categorize (${who}): pinned ${pinned}, ruled ${ruled}` + (conflicts > 0 ? `, ${conflicts} conflict(s)` : ""),
  );
  if (queue.length === 0) {
    console.log("queue: empty — every dedicated-account row is disposed.");
  } else {
    console.log(`queue: ${queue.length} undisposed row(s) on dedicated account(s) — decide each:`);
    console.log("");
    for (const t of queue.slice(0, 30)) {
      console.log(
        `  ${t.id}  ${t.date}  ${padStart(fmtEur(t.amount_eur), 10)} EUR  ${padEnd(t.merchant_raw, 30)} ${t.note}`,
      );
    }
    if (queue.length > 30) console.log(`  … and ${queue.length - 30} more (kopeika list --who ${who} --queued)`);
    console.log("");
    console.log(`decide with: kopeika decide <txid> <category> --who ${who}`);
  }
  return 0;
}

/** Undisposed rows on the person's dedicated accounts (the explicit-decision queue). */
function taxQueue(ledger: readonly Transaction[], person: Person): Transaction[] {
  const dedicated = new Set(
    Object.entries(person.profile.accounts)
      .filter(([, mode]) => mode === "dedicated")
      .map(([acc]) => acc),
  );
  return ledger.filter(
    (t) =>
      dedicated.has(t.account) &&
      t.tax_category === "" &&
      (t.tax_person === "" || t.tax_person === person.profile.slug),
  );
}

// --- tax: decide --------------------------------------------------------------
async function cmdDecide(args: Args): Promise<number> {
  const [txidRaw, category] = args.positionals;
  const who = flagString(args, "who");
  if (!txidRaw || !category || !who) {
    console.error("usage: kopeika decide <txid> <category> --who <person>   (txid may be a unique prefix)");
    return 1;
  }
  const person = loadPerson(ROOT, who);
  const pack = loadPack(ROOT, person.profile.pack);
  if (!pack.categories.has(category)) {
    console.error(
      `unknown category "${category}". Known: ${[...pack.categories.keys()].join(", ")}`,
    );
    return 1;
  }
  const ledger = loadLedger(LEDGER_PATH);
  const matches = ledger.filter((t) => t.id === txidRaw || t.id.startsWith(txidRaw));
  if (matches.length === 0) {
    console.error(`no ledger row with id (or prefix) "${txidRaw}"`);
    return 1;
  }
  if (matches.length > 1) {
    console.error(`"${txidRaw}" is ambiguous (${matches.length} rows) — use the full id`);
    return 1;
  }
  const tx = matches[0]!;
  if (tx.tax_source === "pin" && tx.tax_person !== who) {
    console.error(`row ${tx.id} is pinned on "${tx.tax_person}"'s books — undo there first`);
    return 1;
  }

  const noteFlag = flagString(args, "note") ?? "";
  person.pins.set(tx.id, { category, note: noteFlag });
  savePins(person.dir, person.pins);
  tx.tax_person = who;
  tx.tax_category = category;
  tx.tax_source = "pin";
  writeLedger(LEDGER_PATH, ledger);

  console.log(
    `pinned ${tx.id} -> ${category} (${who})  ${tx.date}  ${fmtEur(tx.amount_eur)} EUR  ${tx.merchant_raw}`,
  );
  return 0;
}

// --- tax: the EÜR report ------------------------------------------------------
/** Money with cents and thousands separators for tax figures (never rounded). */
function fmtCents(n: number): string {
  const sign = n < 0 ? "-" : "";
  const [int, frac] = Math.abs(n).toFixed(2).split(".");
  return `${sign}${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

async function cmdTaxReport(who: string, args: Args): Promise<number> {
  const person = loadPerson(ROOT, who);
  const pack = loadPack(ROOT, person.profile.pack);
  const ledger = loadLedger(LEDGER_PATH);
  const bookRows = ledger.filter((t) => t.tax_person === who);
  if (bookRows.length === 0) {
    console.log(`no rows on "${who}"'s books yet — import or categorize first.`);
    return 0;
  }

  const yearFlag = flagString(args, "year");
  if (yearFlag !== undefined && !/^\d{4}$/.test(yearFlag)) {
    console.error(`--year must be YYYY (got "${yearFlag}")`);
    return 1;
  }
  const year = yearFlag ?? bookRows.map((t) => t.date.slice(0, 4)).sort().pop()!;

  const assets = loadAssets(person.dir);
  const report = buildEuer(ledger, who, year, pack, assets);

  const idLine = Object.entries(person.profile.identity)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  console.log(`EÜR ${year} — ${person.profile.name} (§ 4 Abs. 3 EStG, pack ${pack.country} ${pack.packYear})`);
  if (idLine !== "") console.log(idLine);
  console.log("");

  console.log("Betriebseinnahmen");
  for (const c of report.income) {
    console.log(
      `  ${padEnd(`[${c.category.euerLine}]`, 6)} ${padEnd(c.category.label, 58)} ${padStart(fmtCents(c.amountEur), 12)}  (${c.rows})`,
    );
  }
  if (report.incomeCorrections !== 0) {
    console.log(
      `         darin verrechnet: Storno/Korrekturen ${fmtCents(report.incomeCorrections)} (brutto ${fmtCents(report.incomeGross)})`,
    );
  }
  console.log(`  ${padEnd("", 6)} ${padEnd("Summe Betriebseinnahmen", 58)} ${padStart(fmtCents(report.incomeTotal), 12)}`);
  console.log("");

  console.log("Betriebsausgaben");
  for (const c of report.expenses) {
    const tag = c.category.nondeductible ? "  [nicht abziehbar]" : "";
    console.log(
      `  ${padEnd(`[${c.category.euerLine}]`, 6)} ${padEnd(c.category.label, 58)} ${padStart(fmtCents(c.amountEur), 12)}  (${c.rows})${tag}`,
    );
  }
  for (const a of report.afa) {
    console.log(
      `  ${padEnd("[36]", 6)} ${padEnd(`AfA: ${a.asset.label} (${a.asset.acquired}, ${Math.round(a.asset.businessShare * 100)}%, ${a.asset.usefulLifeMonths} Mon.)`, 58)} ${padStart(fmtCents(a.claimEur), 12)}`,
    );
  }
  console.log(
    `  ${padEnd("", 6)} ${padEnd("Summe abziehbare Betriebsausgaben", 58)} ${padStart(fmtCents(report.expenseDeductibleTotal), 12)}`,
  );
  if (report.expenseNondeductibleTotal !== 0) {
    console.log(
      `  ${padEnd("", 6)} ${padEnd("nachrichtlich: nicht abziehbar (außerhalb des Gewinns)", 58)} ${padStart(fmtCents(report.expenseNondeductibleTotal), 12)}`,
    );
  }
  console.log("");
  console.log(`Gewinn / Verlust ${year}: €${fmtCents(report.profit)}`);

  if (report.neutral.length > 0) {
    console.log("");
    console.log("neutral (auf den Büchern, in keiner Summe):");
    for (const c of report.neutral) {
      console.log(`  ${padEnd(c.category.label, 64)} ${padStart(fmtCents(c.amountEur), 12)}  (${c.rows})`);
    }
  }
  if (report.unknownCategories.size > 0) {
    console.log("");
    console.log("⚠ rows outside the pack (fix before filing):");
    for (const [key, agg] of report.unknownCategories) {
      console.log(`  ${padEnd(key, 24)} ${agg.rows} row(s), €${fmtCents(agg.amountEur)} — \`categorize --who ${who}\` / \`decide\``);
    }
  }
  if (report.missingEurRows > 0) {
    console.log(`⚠ ${report.missingEurRows} row(s) missing FX — excluded from every figure`);
  }
  const queue = taxQueue(ledger, person).filter((t) => t.date.startsWith(year));
  if (queue.length > 0) {
    console.log(`⚠ ${queue.length} row(s) queued undisposed for ${year} — run \`kopeika categorize --who ${who}\``);
  }
  return 0;
}

// --- tax: status --------------------------------------------------------------
async function cmdStatus(_args: Args): Promise<number> {
  const persons = listPersons(ROOT);
  if (persons.length === 0) {
    console.log("no tax profiles under profiles/ — create profiles/<person>/profile.json (see profiles.example/).");
    return 0;
  }
  const ledger = loadLedger(LEDGER_PATH);
  for (const slug of persons) {
    const person = loadPerson(ROOT, slug);
    const rows = ledger.filter((t) => t.tax_person === slug);
    const queue = taxQueue(ledger, person);
    const years = [...new Set(rows.map((t) => t.date.slice(0, 4)))].sort();
    const lastDate = rows.map((t) => t.date).sort().pop() ?? "—";
    console.log(
      `${padEnd(slug, 12)} ${rows.length} book row(s), years ${years.join("/") || "—"}, last ${lastDate}, ` +
        `pins ${person.pins.size}, rules ${person.rules.length}, queue ${queue.length}`,
    );
    // The binding threshold (tightest headroom / first violated) for the current
    // year, when the person keeps thresholds.json. Full table: `project --who`.
    if (rows.length > 0 && loadThresholds(person.dir).length > 0) {
      const nowMonth = currentMonth();
      const { evals } = projectThresholds(person, ledger, nowMonth.slice(0, 4), nowMonth);
      const b = pickBinding(evals);
      if (b !== null) {
        const state = b.violated ? (b.threshold.direction === "stay-under" ? "OVER" : "SHORT") : "ok";
        console.log(
          `${padEnd("", 12)} ${b.violated ? "⚠ " : ""}binding: ${b.threshold.name} — landing ${fmtLanding(b.landing, b)} vs limit ${fmtLanding(b.threshold.limit, b)} (${state})`,
        );
      }
    }
  }
  return 0;
}

// --- tax: the threshold projector ---------------------------------------------
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Current UTC month as YYYY-MM (the actuals/forward cut for the projector). */
function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Assemble the projector inputs for one person and year: per-year actuals off
 * buildEuer (so the projector and the EÜR report can never disagree), the
 * forward book resolved against the remaining months, and every threshold
 * evaluated. Shared by `project --who` and the `status` one-liner.
 */
function projectThresholds(
  person: Person,
  ledger: readonly Transaction[],
  year: string,
  nowMonth: string,
): { evals: ThresholdEval[]; fwd: ReturnType<typeof applyForward>; actuals: YearActuals[]; monthsElapsed: number } {
  const pack = loadPack(ROOT, person.profile.pack);
  const assets = loadAssets(person.dir);
  const bookYears = [
    ...new Set([...ledger.filter((t) => t.tax_person === person.profile.slug).map((t) => t.date.slice(0, 4)), year]),
  ].sort();
  const actuals: YearActuals[] = bookYears.map((y) => {
    const r = buildEuer(ledger, person.profile.slug, y, pack, assets);
    return { year: y, profit: r.profit, revenue: r.incomeTotal };
  });
  const fwd = applyForward(loadForward(person.dir), year, nowMonth);
  const monthsElapsed = monthsElapsedInYear(year, nowMonth);
  const evals = evaluateThresholds({
    thresholds: loadThresholds(person.dir),
    actuals,
    year,
    forward: fwd,
    monthsElapsed,
  });
  return { evals, fwd, actuals, monthsElapsed };
}

/** Landing/limit with the window's unit attached (/mo for a monthly average). */
function fmtLanding(n: number, e: ThresholdEval): string {
  return fmtMoney(n) + (e.threshold.window === "monthly-average" ? "/mo" : "");
}

async function cmdTaxProject(who: string, args: Args): Promise<number> {
  const person = loadPerson(ROOT, who);
  const thresholds = loadThresholds(person.dir);
  if (thresholds.length === 0) {
    console.log(`no thresholds for "${who}" — add profiles/${who}/thresholds.json (see profiles.example/person/).`);
    return 0;
  }
  const yearFlag = flagString(args, "year");
  if (yearFlag !== undefined && !/^\d{4}$/.test(yearFlag)) {
    console.error(`--year must be YYYY (got "${yearFlag}")`);
    return 1;
  }
  const ledger = loadLedger(LEDGER_PATH);
  const bookRows = ledger.filter((t) => t.tax_person === who);
  if (bookRows.length === 0) {
    console.log(`no rows on "${who}"'s books yet — import or categorize first.`);
    return 0;
  }
  // Default to the CURRENT year: the projection exists to steer the year still
  // in progress (the gap priced while the fix is buyable), not to grade a past one.
  const nowMonth = currentMonth();
  const year = yearFlag ?? nowMonth.slice(0, 4);

  const { evals, fwd, actuals, monthsElapsed } = projectThresholds(person, ledger, year, nowMonth);
  const current = actuals.find((a) => a.year === year)!;

  console.log(`threshold projection — ${person.profile.name}, ${year} (as of ${nowMonth})`);
  console.log("");

  // Actuals + forward, the two ingredients of every landing figure below.
  const actualsSpan =
    monthsElapsed === 0 ? "(none yet)" : `${MONTH_NAMES[0]}-${MONTH_NAMES[monthsElapsed - 1]}`;
  console.log(
    `actuals ${padEnd(actualsSpan, 9)} income ${fmtMoney(current.revenue)}   expenses ${fmtMoney(current.revenue - current.profit)}   profit ${fmtMoney(current.profit)}`,
  );
  const fwdSpan = fwd.fromMonth > fwd.toMonth ? "(none)" : `${MONTH_NAMES[fwd.fromMonth - 1]}-${MONTH_NAMES[fwd.toMonth - 1]}`;
  const fwdParts = [
    ...fwd.incomeParts.map((p) => `+${fmtMoney(p.eur)} ${p.label}`),
    ...fwd.purchaseParts.map((p) => `-${fmtMoney(p.eur)} ${p.label}`),
    ...fwd.offbookParts.map((p) => `${p.eur >= 0 ? "+" : ""}${fmtMoney(p.eur)} off-book: ${p.label}`),
  ];
  console.log(
    `forward ${padEnd(fwdSpan, 9)} ${fwdParts.length > 0 ? fwdParts.join("   ") : "(empty — nothing expected, nothing planned)"}`,
  );
  for (const p of fwd.stalePurchases) {
    console.log(
      `⚠ planned purchase "${p.label}" (€${fmtMoney(p.eur)} by ${p.by}) dates an elapsed month — NOT counted (bought already? remove it, or move the date)`,
    );
  }
  console.log("");

  // The landing table: one row per threshold, the fix line under a violated one.
  const label = (e: ThresholdEval): string => {
    const unit =
      e.threshold.window === "monthly-average" ? "/mo" : e.threshold.window === "calendar-year" ? "/yr" : ", all years";
    return `${e.threshold.name} (${e.threshold.basis}${unit})`;
  };
  const labelW = Math.max(...evals.map((e) => label(e).length)) + 2;
  console.log(`${padEnd("", labelW)} ${padStart("landing", 11)} ${padStart("limit", 11)} ${padStart("gap", 11)}`);
  for (const e of evals) {
    const gapStr = (e.gap >= 0 ? "+" : "") + fmtLanding(e.gap, e);
    console.log(
      `${padEnd(label(e), labelW)} ${padStart(fmtLanding(e.landing, e), 11)} ${padStart(fmtLanding(e.threshold.limit, e), 11)} ${padStart(gapStr, 11)}   ${e.violated ? (e.threshold.direction === "stay-under" ? "OVER" : "SHORT") : "ok"}`,
    );
    if (e.violated && e.fixEur !== null) {
      const cc = e.threshold.crossingCosts !== "" ? `, or crossing costs: ${e.threshold.crossingCosts}` : "";
      if (e.threshold.direction === "stay-under") {
        const lever = e.threshold.basis === "profit" ? "more Ausgaben" : "less Einnahmen";
        console.log(`  -> ~${fmtMoney(e.fixEur)} ${lever} by ${MONTH_NAMES[11]}${cc}`);
      } else {
        console.log(`  -> ~${fmtMoney(e.fixEur)} still missing in total${cc}`);
      }
    }
  }

  // The naive run-rate, printed BECAUSE it is wrong: in July it said
  // "comfortably under" while the forward book already priced the crossing.
  if (monthsElapsed > 0) {
    console.log("");
    console.log(`run-rate cross-check (actuals ÷ ${monthsElapsed} mo × 12, no forward book — the naive view):`);
    console.log(
      `  ${evals.map((e) => `${e.threshold.name} ${e.runRate === null ? "—" : fmtLanding(e.runRate, e)}`).join(" · ")}`,
    );
  }
  return 0;
}

// --- tax: the § 14 invoice generator -----------------------------------------
/** Local calendar date as ISO YYYY-MM-DD (invoices are dated where you live). */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Generate a § 14 UStG invoice in the person's Lexoffice layout. The invoice
 * number is consumed (counter.json incremented) ONLY after the final artifact
 * is on disk; --dry-run renders a DRAFT preview and touches nothing.
 */
async function cmdInvoice(args: Args): Promise<number> {
  const who = flagString(args, "who");
  if (!who) {
    console.error(
      'usage: kopeika invoice --who <person> --client "<name>" --qty N --unit-price <eur> [--service <label>] [--date YYYY-MM-DD] [--delivery-date YYYY-MM-DD] [--dry-run]\n' +
        "       kopeika invoice --who <person> --from-tx <ledger-txid> [--qty N] [--dry-run]\n" +
        "       kopeika invoice --who <person> --sync-clients",
    );
    return 1;
  }
  const person = loadPerson(ROOT, who);

  // --sync-clients: seed/refresh the Kundennr registry from the archived DATEV
  // XMLs (customerName + partyId on every income entry). Existing entries win.
  if (hasFlag(args, "sync-clients")) {
    const rawRoot = join(DATA_DIR, "raw", "lexoffice-datev");
    if (!existsSync(rawRoot)) {
      console.error(`no archived DATEV exports under ${rawRoot} — run \`kopeika import lexoffice-datev\` first`);
      return 1;
    }
    const files: { name: string; text: string }[] = [];
    for (const batch of readdirSync(rawRoot).sort()) {
      const dir = join(rawRoot, batch);
      if (!statSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".xml")).sort()) {
        files.push({ name: `${batch}/${name}`, text: readFileSync(join(dir, name), "utf8") });
      }
    }
    const derived = deriveClientsFromDatev(files);
    const path = clientsPath(person.dir);
    const clients = loadClients(path);
    const { added, kept } = mergeClients(clients, derived);
    saveClients(path, clients);
    console.log(
      `sync-clients (${who}): ${derived.size} client(s) across ${files.length} XML(s) — added ${added}, kept ${kept} existing, registry now ${clients.size}`,
    );
    return 0;
  }

  const invoiceProfile = parseInvoiceProfile(person);
  const dryRun = hasFlag(args, "dry-run");
  const counter = loadCounter(person.dir);
  const cPath = clientsPath(person.dir);
  const clients = loadClients(cPath);

  // --qty: whole lessons only.
  const qtyRaw = flagString(args, "qty");
  let qtyFlag: number | undefined;
  if (qtyRaw !== undefined) {
    const n = Number(qtyRaw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`--qty must be a positive integer (got "${qtyRaw}")`);
      return 1;
    }
    qtyFlag = n;
  }
  for (const name of ["date", "delivery-date"]) {
    const v = flagString(args, name);
    if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      console.error(`--${name} must be YYYY-MM-DD (got "${v}")`);
      return 1;
    }
  }

  let clientName: string;
  let client: Client;
  let isNewClient = false;
  let qty: number;
  let unitPriceEur: number;
  let totalEur: number;
  let date: string;

  const fromTx = flagString(args, "from-tx");
  if (fromTx !== undefined) {
    // The backwards flow: the money already landed, the invoice documents it.
    const ledger = loadLedger(LEDGER_PATH);
    const matches = ledger.filter((t) => t.id === fromTx || t.id.startsWith(fromTx));
    if (matches.length === 0) {
      console.error(`no ledger row with id (or prefix) "${fromTx}"`);
      return 1;
    }
    if (matches.length > 1) {
      console.error(`"${fromTx}" is ambiguous (${matches.length} rows) — use the full id`);
      return 1;
    }
    const row = matches[0]!;
    if (row.type !== "income") {
      console.error(`row ${row.id} is not an income row (type "${row.type}") — an invoice documents money in`);
      return 1;
    }
    if (row.amount_eur === null || row.amount_eur <= 0) {
      console.error(`row ${row.id} has no positive EUR amount (missing FX or a Storno) — cannot invoice it`);
      return 1;
    }
    const found = findClient(clients, row.merchant_raw);
    if (found === null) {
      console.error(
        `row merchant "${row.merchant_raw}" is not in ${cPath} — run \`kopeika invoice --who ${who} --sync-clients\` or add the client by hand`,
      );
      return 1;
    }
    clientName = found.name;
    client = found.client;
    totalEur = row.amount_eur;
    qty = qtyFlag ?? 1;
    const totalCents = Math.round(totalEur * 100);
    if (totalCents % qty !== 0) {
      console.error(`--qty ${qty} does not split €${fmtDeMoney(totalEur)} into a whole-cent unit price — use a qty that divides it (or --qty 1)`);
      return 1;
    }
    unitPriceEur = totalCents / qty / 100;
    date = flagString(args, "date") ?? row.date;
  } else {
    const clientFlag = flagString(args, "client");
    if (clientFlag === undefined || clientFlag.trim() === "") {
      console.error(`--client "<name>" is required (or use --from-tx <ledger-txid>)`);
      return 1;
    }
    if (qtyFlag === undefined) {
      console.error("--qty <lessons> is required");
      return 1;
    }
    qty = qtyFlag;
    const unitRaw = flagString(args, "unit-price");
    if (unitRaw === undefined) {
      console.error("--unit-price <eur> is required (e.g. --unit-price 62.50)");
      return 1;
    }
    const unit = Number(unitRaw);
    if (!Number.isFinite(unit) || unit <= 0 || Math.abs(unit * 100 - Math.round(unit * 100)) > 1e-6) {
      console.error(`--unit-price must be a positive amount with at most two decimals (got "${unitRaw}")`);
      return 1;
    }
    unitPriceEur = Math.round(unit * 100) / 100;
    totalEur = (qty * Math.round(unit * 100)) / 100;
    const found = findClient(clients, clientFlag);
    if (found !== null) {
      clientName = found.name;
      client = found.client;
    } else {
      // A new client gets the next Kundennr; saved only when a number is consumed.
      isNewClient = true;
      clientName = clientFlag.trim();
      client = { kundennr: nextKundennr(clients), anrede: "", address: [], paypal: "" };
    }
    date = flagString(args, "date") ?? localToday();
  }
  const deliveryDate = flagString(args, "delivery-date") ?? date;

  const invoiceNo = formatInvoiceNumber(counter);
  const paypalLinkUrl = `${invoiceProfile.paypalMe}/${paypalAmountSegment(totalEur)}eur`;
  const html = renderInvoiceHtml({
    invoiceNo,
    kundennr: client.kundennr,
    date,
    deliveryDate,
    clientName,
    clientAnrede: client.anrede,
    clientAddress: client.address,
    serviceLabel: flagString(args, "service") ?? invoiceProfile.serviceLabel,
    qty,
    unitPriceEur,
    totalEur,
    paypalLinkUrl,
    qrSvg: qrToSvg(encodeQr(paypalLinkUrl), "22mm"),
    logoDataUri: logoDataUri(person.dir, invoiceProfile.logo),
    profile: invoiceProfile,
    steuernummer: person.profile.identity["Steuernummer"] ?? "",
    draft: dryRun,
  });

  const invoicesDir = join(person.dir, "invoices");
  mkdirSync(invoicesDir, { recursive: true });
  const baseName = dryRun ? "draft-preview" : invoiceNo;
  const htmlPath = join(invoicesDir, `${baseName}.html`);
  writeFileSync(htmlPath, html, "utf8");

  const chrome = findChrome();
  let finalPath = htmlPath;
  let chromeNote = "";
  if (chrome === null) {
    chromeNote = "no Chrome/Chromium found — wrote HTML only; open it in a browser and print to PDF";
  } else {
    const pdfPath = join(invoicesDir, `${baseName}.pdf`);
    const fail = htmlToPdf(chrome, htmlPath, pdfPath);
    if (fail !== null) {
      // Nothing consumed: remove the numbered HTML so no half-made artifact
      // squats on a number the counter never granted.
      if (!dryRun) unlinkSync(htmlPath);
      console.error(`invoice: PDF render failed (${fail}) — no number consumed`);
      return 1;
    }
    finalPath = pdfPath;
  }

  if (!dryRun) {
    // The gapless commit: the artifact exists, NOW the number is consumed.
    commitCounter(person.dir, counter);
    if (isNewClient) {
      clients.set(clientName, client);
      saveClients(cPath, clients);
    }
  }

  const clientCol = `${clientName} (Kundennr ${client.kundennr}${isNewClient ? " NEW" : ""})`;
  if (dryRun) {
    console.log(`draft preview · ${clientCol} · €${fmtDeMoney(totalEur)} · ${finalPath}  (${invoiceNo} NOT consumed)`);
  } else {
    console.log(`${invoiceNo} · ${clientCol} · €${fmtDeMoney(totalEur)} · ${finalPath}`);
  }
  if (chromeNote !== "") console.log(`⚠ ${chromeNote}`);
  return 0;
}

// --- categorize -------------------------------------------------------------
async function cmdCategorize(args: Args): Promise<number> {
  // --who <person> switches to the TAX axis (pins + rules + queue); without it
  // this is the household pass over data/rules.csv, unchanged.
  const who = flagString(args, "who");
  if (who !== undefined) return cmdTaxCategorize(who, args);
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
  const whoFilter = flagString(args, "who");
  const onlyQueued = hasFlag(args, "queued");

  let rows = ledger;
  if (sourceFilter) rows = rows.filter((t) => t.data_source === sourceFilter);
  if (monthFilter) rows = rows.filter((t) => t.date.startsWith(monthFilter));
  if (onlyUncategorized) rows = rows.filter((t) => t.category === "");
  if (whoFilter) {
    rows = onlyQueued ? taxQueue(rows, loadPerson(ROOT, whoFilter)) : rows.filter((t) => t.tax_person === whoFilter);
  }

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
    // With --who, the tax category is the interesting axis; otherwise household.
    const cat = whoFilter
      ? t.tax_category === "" ? "(queued)" : `${t.tax_category}${t.tax_source === "pin" ? " 📌" : ""}`
      : t.category === "" ? "(none)" : t.category;
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
  // --who <person> renders that person's EÜR instead of the household report.
  const who = flagString(args, "who");
  if (who !== undefined) return cmdTaxReport(who, args);
  const ledger = loadLedger(LEDGER_PATH);
  if (ledger.length === 0) {
    console.log("ledger is empty — import something first.");
    return 0;
  }

  // Rows imported before their FX rate existed carry amount_eur=null and are
  // excluded from every total. Resolve them against the current rates table
  // (deterministic; still-missing rates stay null) so adding a rate to
  // data/rates.csv actually fixes the report without a re-import.
  const backfilled = backfillEur(ledger, loadRates(RATES_PATH));
  if (backfilled > 0) {
    writeLedger(LEDGER_PATH, ledger);
    console.log(`backfilled amount_eur for ${backfilled} row(s) from data/rates.csv`);
    console.log("");
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
    // Spend dropdown: every report month (respecting --from/--month), each with
    // its grouped spend, plus a "whole year so far" aggregate for the year of the
    // latest report month — derived from the data, never a hardcoded year.
    const spendMonths = report.months.map((m) => m.month);
    const months = spendMonths.map((m) => ({ month: m, groups: buildSpendGroups(ledger, m, tiers) }));
    if (spendMonths.length > 0) {
      const latestYear = spendMonths[spendMonths.length - 1]!.slice(0, 4);
      months.push({ month: latestYear, groups: buildSpendGroups(ledger, latestYear, tiers) });
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
  // --who <person> runs the tax-face threshold projector; without it the
  // household savings projection below stays untouched.
  const who = flagString(args, "who");
  if (who !== undefined) return cmdTaxProject(who, args);
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

  kopeika import lexoffice-datev <dir> --account <name> --owner <owner> [--who <person>]
      TAX FACE: import a Lexoffice DATEV Belegbilder export (the UNZIPPED folder
      of XMLs). Rows land on <person>'s books (tax axis) with categories mapped
      from the SKR account codes via the country pack; household analytics never
      see them (category Exclude). Unmapped codes queue — never guessed.

  kopeika categorize --who <person>
      TAX FACE: apply <person>'s pins (profiles/<person>/pins.json — never
      overridden) and ratified rules (rules.json — fill empty dispositions
      only), then list the queue of undisposed rows on dedicated accounts.

  kopeika decide <txid> <category> --who <person> [--note <text>]
      TAX FACE: pin one row's tax category — the explicit-permission step.
      Pins outrank rules forever; only another \`decide\` changes a pin.
      <txid> may be a unique prefix.

  kopeika report --who <person> [--year YYYY]
      TAX FACE: the EÜR — line-mapped Betriebseinnahmen/-ausgaben, Bewirtung
      70/30, AfA from assets.json, profit, Storno reconciliation.

  kopeika project --who <person> [--year YYYY]
      TAX FACE: the threshold projector. Actuals (from the EÜR builder) plus the
      forward book (profiles/<person>/forward.json: expected income, planned
      purchases, off-book adjustments) landed against each statutory line in
      profiles/<person>/thresholds.json — landing vs limit vs gap per window
      (monthly-average / calendar-year / all-years-cumulative), with the fix
      priced while it is still buyable, plus the naive run-rate as a cross-check.
      --year YYYY defaults to the current year.

  kopeika status
      TAX FACE: one line per tax profile — book rows, years, pins, rules, queue —
      plus the binding threshold's landing vs limit when thresholds.json exists.

  kopeika invoice --who <person> --client "<name>" --qty N --unit-price <eur>
                  [--service <label>] [--date YYYY-MM-DD] [--delivery-date YYYY-MM-DD] [--dry-run]
      TAX FACE: generate a § 14 UStG invoice (Kleinunternehmer layout, PayPal-only,
      QR code encoded locally) as PDF + HTML under profiles/<person>/invoices/.
      Letterhead from profile.json's "invoice" object; Kundennr from clients.json
      (a new client gets max+1). GAPLESS: counter.json is incremented ONLY after
      the artifact is written. --dry-run renders draft-preview.* with a DRAFT
      watermark and consumes nothing.
      --from-tx <txid>   build from an existing income ledger row instead:
                         total = row amount, date = row date, client matched by
                         the row's merchant against clients.json. [--qty N] splits
                         the total into N whole-cent units (default 1).
      --sync-clients     seed/refresh clients.json from the archived DATEV XMLs
                         (customerName + partyId) so Kundennummern continue the
                         Lexoffice range. Existing entries always win.

  kopeika list [--who <person> [--queued]]
      With --who: only that person's book rows, tax category shown (📌 = pinned).
      With --queued: only the undisposed queue.

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
  data/ledger.csv      clean normalized ledger (two axes: household + tax)
  data/rules.csv       pattern,match_type,field,category,type
  data/rates.csv       month,currency,rate_to_eur
  data/tiers.csv       scope,value,tier  (mandatory=floor, else flex)
  data/savings.csv     scope,value,balance_eur  (account|marker|anchor savings)

TAX FACE (profiles/ = the consolidated PII zone; categories.<cc>.json = shipped pack)
  profiles/household.json        the household profile (was data/profile.json)
  profiles/<person>/profile.json identity: name, pack, Steuernummer, accounts
  profiles/<person>/rules.json   ratified merchant rules (tax axis)
  profiles/<person>/pins.json    per-transaction decisions — outrank rules
  profiles/<person>/assets.json  Anlagenverzeichnis for AfA
  profiles/<person>/thresholds.json  statutory lines: basis, window, limit, direction
  profiles/<person>/forward.json     the forward book: expected income, planned
                                 purchases, off-book yearly adjustments
  profiles/<person>/clients.json     invoice clients: name -> Kundennr (+ anrede, address)
  profiles/<person>/invoices/        generated invoices + counter.json (the gapless § 14 sequence)
  categories.de.json             Germany pack: categories -> Anlage EÜR lines, SKR map

NOT IMPLEMENTED (v0 stubs): Google Sheets mirror/push, LLM --suggest categorization.
No LLM is called at runtime — the core is fully deterministic.`);
}

// --- entry ------------------------------------------------------------------
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  // Load the personal layer (own names/IBANs, net-worth marks, display labels) and
  // install the own-account identity the connectors use for transfer detection.
  // profiles/household.json (the PII zone) wins; data/profile.json still reads.
  PROFILE = loadProfile(PROFILE_PATHS.find((p) => existsSync(p)) ?? PROFILE_PATHS[0]!);
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
    case "decide":
      return cmdDecide(args);
    case "status":
      return cmdStatus(args);
    case "invoice":
      return cmdInvoice(args);
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
