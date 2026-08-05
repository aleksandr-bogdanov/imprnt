/**
 * § 14 UStG invoice generator (the tax face's WRITE side for income).
 *
 * Replicates the person's Lexoffice invoice layout: letterhead from
 * profile.json's `invoice` object, a clients registry with stable
 * Kundennummern (profiles/<person>/clients.json, seeded from the archived
 * DATEV XMLs so numbers continue the Lexoffice range), a gapless § 14
 * sequence (profiles/<person>/invoices/counter.json — the number is consumed
 * ONLY after the artifact is on disk), and a PayPal box with a locally
 * encoded QR code. Payment is PayPal-only by ruling: no bank/IBAN line.
 *
 * HTML is rendered from templates/invoice.html (inlined into the build as
 * text), PDF via system Chrome headless. No Chrome = the HTML is the final
 * artifact, stated loudly, never a silent failure.
 */

import invoiceTemplateRaw from "../../templates/invoice.html" with { type: "text" };

// @types/bun types every *.html import as HTMLBundle (its dev-server feature),
// but `with { type: "text" }` selects the text loader: bun run, bun:test and
// the bundled kopeika.js all receive the file content as a plain string.
const invoiceTemplateHtml = invoiceTemplateRaw as unknown as string;

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { extname, join } from "node:path";
import type { Person } from "./person.ts";

// --- The letterhead (profile.json `invoice` object) ---------------------------
export interface InvoiceProfile {
  businessName: string;
  /** Street + city lines, in order. */
  address: string[];
  phone: string;
  email: string;
  website: string;
  /** paypal.me base URL, no trailing slash (e.g. https://paypal.me/gretastudio). */
  paypalMe: string;
  /** Logo path relative to the person's profile dir. */
  logo: string;
  vatClause: string;
  serviceLabel: string;
  /** Display name for prose ("bei <Studio> entschieden") — falls back to the part after "|". */
  studioDisplay: string;
}

/** Validate the raw profile.json `invoice` object. Fails loud, never guesses. */
export function parseInvoiceProfile(person: Person): InvoiceProfile {
  const raw = person.profile.invoice;
  const path = join(person.dir, "profile.json");
  if (raw === null) {
    throw new Error(
      `${path} has no "invoice" object — add business_name, address[], phone, email, website, paypal_me, logo, vat_clause, service_label (see profiles.example/person/profile.json).`,
    );
  }
  const need = (key: string): string => {
    const v = raw[key];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`${path}: invoice.${key} is required (a non-empty string)`);
    }
    return v.trim();
  };
  const address = Array.isArray(raw.address) ? raw.address.map((l) => String(l)) : [];
  if (address.length === 0) {
    throw new Error(`${path}: invoice.address must be a non-empty array of lines`);
  }
  const businessName = need("business_name");
  const studioRaw = typeof raw.studio_display === "string" ? raw.studio_display.trim() : "";
  const afterPipe = businessName.split("|").pop()!.trim();
  return {
    businessName,
    address,
    phone: need("phone"),
    email: need("email"),
    website: need("website"),
    paypalMe: need("paypal_me").replace(/\/+$/, ""),
    logo: need("logo"),
    vatClause: need("vat_clause"),
    serviceLabel: need("service_label"),
    studioDisplay: studioRaw !== "" ? studioRaw : afterPipe !== "" ? afterPipe : businessName,
  };
}

// --- The gapless counter ------------------------------------------------------
export interface InvoiceCounter {
  prefix: string;
  width: number;
  next: number;
}

export function counterPath(personDir: string): string {
  return join(personDir, "invoices", "counter.json");
}

/** Load the § 14 sequence state. Fails loud when absent — never invents a range. */
export function loadCounter(personDir: string): InvoiceCounter {
  const path = counterPath(personDir);
  if (!existsSync(path)) {
    throw new Error(
      `no invoice counter at ${path} — create it, e.g. {"prefix":"RE","width":4,"next":1} (the § 14 sequence is gapless; pick the start deliberately).`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const prefix = String(raw.prefix ?? "");
  const width = Number(raw.width);
  const next = Number(raw.next);
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(next) || next < 1) {
    throw new Error(`${path}: width and next must be positive integers`);
  }
  return { prefix, width, next };
}

/** The number the NEXT invoice will carry (a peek — nothing is consumed). */
export function formatInvoiceNumber(counter: InvoiceCounter): string {
  return counter.prefix + String(counter.next).padStart(counter.width, "0");
}

/**
 * Consume the number: increment `next` on disk. Called ONLY after the final
 * artifact is written — the gapless discipline lives at this call site.
 */
export function commitCounter(personDir: string, counter: InvoiceCounter): void {
  const path = counterPath(personDir);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  raw.next = counter.next + 1;
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
}

// --- The clients registry -----------------------------------------------------
export interface Client {
  kundennr: string;
  /** Salutation prefix on the address window ("Frau", "Herr") — empty = none. */
  anrede: string;
  /** Optional recipient address lines under the name. */
  address: string[];
  /** Optional per-client PayPal note (unused by the layout, carried for the agent). */
  paypal: string;
}

export type ClientRegistry = Map<string, Client>;

export function clientsPath(personDir: string): string {
  return join(personDir, "clients.json");
}

/** Load clients.json: { "<name>": { kundennr, anrede?, address?, paypal? } }. */
export function loadClients(path: string): ClientRegistry {
  const clients: ClientRegistry = new Map();
  if (!existsSync(path)) return clients;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message})`);
  }
  for (const [name, v] of Object.entries(raw)) {
    if (name.startsWith("_")) continue;
    const rec = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
    const kundennr = String(rec.kundennr ?? "");
    if (kundennr === "") {
      throw new Error(`${path}: client "${name}" has no kundennr`);
    }
    clients.set(name, {
      kundennr,
      anrede: String(rec.anrede ?? ""),
      address: Array.isArray(rec.address) ? rec.address.map((l) => String(l)) : [],
      paypal: String(rec.paypal ?? ""),
    });
  }
  return clients;
}

export function saveClients(path: string, clients: ClientRegistry): void {
  const obj: Record<string, unknown> = {
    _comment:
      "Kundennummern continue the Lexoffice range (seeded by `invoice --sync-clients` from the archived DATEV XMLs). anrede/address are optional letterhead fields, filled by hand.",
  };
  for (const [name, c] of [...clients.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    obj[name] = {
      kundennr: c.kundennr,
      ...(c.anrede !== "" ? { anrede: c.anrede } : {}),
      ...(c.address.length > 0 ? { address: c.address } : {}),
      ...(c.paypal !== "" ? { paypal: c.paypal } : {}),
    };
  }
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/** Case-insensitive exact-name lookup. */
export function findClient(clients: ClientRegistry, name: string): { name: string; client: Client } | null {
  const wanted = name.trim().toLowerCase();
  for (const [n, c] of clients) {
    if (n.toLowerCase() === wanted) return { name: n, client: c };
  }
  return null;
}

/** Next free Kundennr: numeric max of the registry + 1. */
export function nextKundennr(clients: ClientRegistry): string {
  let max = 10000; // the Lexoffice customer range starts at 10001
  for (const c of clients.values()) {
    const n = Number(c.kundennr);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return String(max + 1);
}

/**
 * Derive name -> Kundennr from archived DATEV XMLs: every income entry
 * (accountsReceivableLedger) carries customerName + partyId. Deterministic;
 * an inconsistent pair (same name, two ids) fails loud.
 */
export function deriveClientsFromDatev(files: ReadonlyArray<{ name: string; text: string }>): Map<string, string> {
  const pairs = new Map<string, string>();
  const blockRe = /<accountsReceivableLedger>([\s\S]*?)<\/accountsReceivableLedger>/g;
  for (const file of files) {
    for (const m of file.text.matchAll(blockRe)) {
      const block = m[1]!;
      const get = (tag: string): string => {
        const t = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
        return t ? t[1]!.trim() : "";
      };
      const name = get("customerName");
      const id = get("partyId") !== "" ? get("partyId") : get("bpAccountNo");
      if (name === "" || id === "") continue;
      const seen = pairs.get(name);
      if (seen !== undefined && seen !== id) {
        throw new Error(
          `sync-clients: "${name}" appears with two Kundennummern (${seen} and ${id}) in ${file.name} — resolve by hand in clients.json`,
        );
      }
      pairs.set(name, id);
    }
  }
  return pairs;
}

/** Merge derived pairs into the registry. Existing entries always win. */
export function mergeClients(
  clients: ClientRegistry,
  derived: ReadonlyMap<string, string>,
): { added: number; kept: number } {
  let added = 0;
  let kept = 0;
  for (const [name, kundennr] of derived) {
    if (findClient(clients, name) !== null) {
      kept += 1;
      continue;
    }
    clients.set(name, { kundennr, anrede: "", address: [], paypal: "" });
    added += 1;
  }
  return { added, kept };
}

// --- Formatting ---------------------------------------------------------------
/** German money format, always two decimals: 1234.5 -> "1.234,50". */
export function fmtDeMoney(n: number): string {
  const cents = Math.round(Math.abs(n) * 100);
  const sign = n < 0 ? "-" : "";
  const int = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const frac = String(cents % 100).padStart(2, "0");
  return `${sign}${int},${frac}`;
}

/** ISO date -> German display: 2026-05-11 -> 11.05.2026. */
export function fmtDeDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`date must be YYYY-MM-DD (got "${iso}")`);
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** paypal.me amount segment: whole euros bare ("250"), else two decimals ("62.50"). */
export function paypalAmountSegment(n: number): string {
  const cents = Math.round(n * 100);
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Rendering ----------------------------------------------------------------
export interface InvoiceFill {
  invoiceNo: string;
  kundennr: string;
  /** ISO dates; rendered German. */
  date: string;
  deliveryDate: string;
  clientName: string;
  clientAnrede: string;
  clientAddress: string[];
  serviceLabel: string;
  qty: number;
  unitPriceEur: number;
  totalEur: number;
  paypalLinkUrl: string;
  /** Inline SVG for the PayPal QR. */
  qrSvg: string;
  logoDataUri: string;
  profile: InvoiceProfile;
  steuernummer: string;
  draft: boolean;
}

/** Fill the template. Throws when a placeholder survives — a drifted template fails loud. */
export function renderInvoiceHtml(fill: InvoiceFill): string {
  const p = fill.profile;
  const senderOneline = escapeHtml(`${p.businessName}, ${p.address.join(", ")}`);
  const recipientLines = [
    `${fill.clientAnrede !== "" ? fill.clientAnrede + " " : ""}${fill.clientName}`,
    ...fill.clientAddress,
  ];
  const intro = `Vielen Dank, dass Sie sich für ${fill.serviceLabel} bei ${p.studioDisplay} entschieden haben! Hier ist die Übersicht über die erbrachten Leistungen.`;
  const closing =
    "Es war mir eine Freude, mit Ihnen zu arbeiten! Ich freue mich auf die nächste Stunde. Bei Fragen stehe ich gerne zur Verfügung.";

  const replacements: Record<string, string> = {
    WATERMARK_HTML: fill.draft ? '<div class="watermark">DRAFT</div>' : "",
    LOGO_DATA_URI: fill.logoDataUri,
    INVOICE_NO: escapeHtml(fill.invoiceNo),
    KUNDENNR: escapeHtml(fill.kundennr),
    INVOICE_DATE: fmtDeDate(fill.date),
    DELIVERY_DATE: fmtDeDate(fill.deliveryDate),
    SENDER_ONELINE: senderOneline,
    RECIPIENT_HTML: recipientLines.map(escapeHtml).join("<br>"),
    SENDER_NAME: escapeHtml(p.businessName),
    SENDER_ADDRESS_HTML: p.address.map((l) => escapeHtml(l) + "<br>").join(""),
    SENDER_PHONE: escapeHtml(p.phone),
    SENDER_EMAIL: escapeHtml(p.email),
    SENDER_WEBSITE: escapeHtml(p.website),
    INTRO_TEXT: escapeHtml(intro),
    SERVICE_LABEL: escapeHtml(fill.serviceLabel),
    QTY: String(fill.qty),
    UNIT_PRICE: fmtDeMoney(fill.unitPriceEur),
    TOTAL: fmtDeMoney(fill.totalEur),
    VAT_CLAUSE: escapeHtml(p.vatClause),
    CLOSING_TEXT: escapeHtml(closing),
    PAYPAL_QR_SVG: fill.qrSvg,
    PAYPAL_LINK_URL: escapeHtml(fill.paypalLinkUrl),
    STEUERNUMMER: escapeHtml(fill.steuernummer),
  };

  let html = invoiceTemplateHtml;
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }
  const leftover = html.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) {
    throw new Error(`invoice template still contains ${leftover[0]} — template and code drifted`);
  }
  return html;
}

/** Read the logo file into a data URI. Fails loud when missing. */
export function logoDataUri(personDir: string, logoRelPath: string): string {
  const path = join(personDir, logoRelPath);
  if (!existsSync(path)) {
    throw new Error(`invoice logo not found: ${path} (profile invoice.logo is "${logoRelPath}")`);
  }
  const ext = extname(path).toLowerCase();
  const mime =
    ext === ".png" ? "image/png"
    : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".svg" ? "image/svg+xml"
    : null;
  if (mime === null) {
    throw new Error(`invoice logo ${path}: unsupported extension "${ext}" (png, jpg, svg)`);
  }
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

// --- PDF via system Chrome ----------------------------------------------------
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const CHROME_PATH_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** Locate a headless-capable Chrome/Chromium. Null = none (HTML becomes final). */
export function findChrome(): string | null {
  for (const p of CHROME_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  for (const name of CHROME_PATH_NAMES) {
    const which = spawnSync("which", [name], { encoding: "utf8" });
    if (which.status === 0) {
      const found = which.stdout.trim();
      if (found !== "") return found;
    }
  }
  return null;
}

/** Print an HTML file to PDF. Returns null on success, else the failure detail. */
export function htmlToPdf(chrome: string, htmlPath: string, pdfPath: string): string | null {
  const res = spawnSync(
    chrome,
    ["--headless", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (res.error) return res.error.message;
  if (res.status !== 0) return `chrome exited ${res.status}: ${res.stderr.trim().slice(0, 400)}`;
  if (!existsSync(pdfPath)) return "chrome exited 0 but wrote no PDF";
  return null;
}
