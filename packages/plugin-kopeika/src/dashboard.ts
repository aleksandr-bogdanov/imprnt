/**
 * Self-contained HTML dashboard — "Where We Are" / "Где мы сейчас".
 *
 * Leads with savings: an interactive multi-line timeline (Total is the hero line;
 * Trading212 and the N26 house pot are secondary, toggleable). Solid is real, a
 * grey bridge marks months with no data, dashed is the projection at the rate the
 * slider sets. New savings fill the N26 pot to a 5k safety margin first, then
 * overflow into Trading212. Year gridlines, milestone goals (incl. a 10M-rouble
 * house), pinch/scroll zoom, hover/touch tooltips. Below: spend with a
 * mandatory-vs-flex split bar, a per-tier 100% bar, then foldable categories.
 *
 * Bilingual (EN/RU, switched server-side) and themed (light/dark, client-side),
 * mobile-first. One HTML string, inline <style> + SVG + vanilla script. No
 * external JS, no CDN, no fetch. `today` and `lang` are injected so output is
 * reproducible.
 */

import type { MonthSummary, Report, SpendTierGroup } from "./analytics.ts";
import type { SavingsSeriesData, StockComponent } from "./savings.ts";
import type { Bilingual, MerchantInfoEntry } from "./profile.ts";

export type Lang = "en" | "ru";
/** Module-level language for the current render (set once at renderDashboard). */
let LANG: Lang = "en";

/**
 * Display labels injected at render time from the user's profile, so no personal
 * merchant notes, account labels, or footer text live in this module. Empty by
 * default: a render with no profile shows raw merchant and account strings.
 */
export interface DisplayConfig {
  footer?: Bilingual;
  accountLabels?: Record<string, Bilingual>;
  merchantInfo?: MerchantInfoEntry[];
}
let DISPLAY: DisplayConfig = {};

const PALETTE = {
  green: "#18935a",
  greenBright: "#1faf76",
  amber: "#c2641e",
  blue: "#3E7CA8",
} as const;

const HOUSE_CAP_EUR = 2000;
const SLIDER_DEFAULT_EUR = 1500;
const SLIDER_DEFAULT_RUB = 20000;
// Distinct colour per spend category (a categorical palette, NOT shades of one hue).
// Used by the per-tier 100% bar and the category row fills. Unlisted categories fall
// back to a stable hash pick so every category still gets its own colour.
const CATEGORY_COLORS: Readonly<Record<string, string>> = {
  "Rent & utilities": "#3E7CA8",
  Subscriptions: "#7E5B9E",
  Groceries: "#3E8E6B",
  "Eating out": "#E07B39",
  "Business lunch": "#C98A2B",
  Travel: "#2C9C9C",
  Shopping: "#C9568E",
  Clothing: "#D6788F",
  Commute: "#5B7C99",
  Transport: "#5B7C99",
  Health: "#C0392B",
  Entertainment: "#9B59B6",
  Gaming: "#5E5BB8",
  Music: "#B5485D",
  Drogerie: "#5FAE9E",
  Cash: "#8A867A",
  Other: "#9E988A",
  Miscellaneous: "#A89A86",
  Admin: "#6B7A8F",
  PayPal: "#3B6EA5",
  Home: "#9B6A43",
  Household: "#B5925A",
  Books: "#8E4A5E",
  Sport: "#5BA37E",
  Fitness: "#4CAF7D",
  Fees: "#A03A3A",
  Insurance: "#5E7E8F",
  Phone: "#3E9C9C",
  Kids: "#E0795B",
  Crypto: "#C8A23E",
  Beauty: "#D67A9E",
  Band: "#8E5BA0",
  Uncategorized: "#B0AA9C",
};
const CATEGORY_FALLBACK = ["#3E7CA8", "#E07B39", "#3E8E6B", "#9B59B6", "#C9568E", "#2C9C9C", "#C98A2B", "#5E5BB8", "#C0392B", "#5FAE9E"] as const;
function categoryColor(cat: string): string {
  const hit = CATEGORY_COLORS[cat];
  if (hit) return hit;
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
  return CATEGORY_FALLBACK[h % CATEGORY_FALLBACK.length]!;
}

// --- i18n -------------------------------------------------------------------

const STRINGS: Readonly<Record<string, { en: string; ru: string }>> = {
  title: { en: "Where We Are", ru: "Где мы сейчас" },
  subtitle: {
    en: "What you've put aside, where it's heading, and where the rest goes.",
    ru: "Сколько отложено, куда это растёт и на что уходит остальное.",
  },
  savedSoFar: { en: "Saved so far", ru: "Накоплено" },
  netWorth: { en: "Net worth", ru: "Чистый капитал" },
  in1y: { en: "In 1 year", ru: "Через год" },
  in5y: { en: "In 5 years", ru: "Через 5 лет" },
  total: { en: "Total", ru: "Всего" },
  tapToggle: { en: "tap to toggle", ru: "нажмите, чтобы скрыть" },
  monthly: { en: "Monthly savings", ru: "Откладываем в месяц" },
  eurMonthly: { en: "In euros", ru: "В евро" },
  rubMonthly: { en: "In roubles", ru: "В рублях" },
  whereItGoes: { en: "Where it goes", ru: "Куда уходит" },
  spendKicker: { en: "Spending", ru: "Траты" },
  worthKicker: { en: "kopeika", ru: "kopeika" },
  tapCategory: { en: "Tap a category to see the transactions", ru: "Нажмите на категорию, чтобы увидеть операции" },
  mandatory: { en: "Mandatory", ru: "Обязательные" },
  nonMandatory: { en: "Non-mandatory", ru: "Необязательные" },
  mandatorySub: { en: "Rent, utilities and subscriptions - owed no matter what", ru: "Аренда, коммуналка и подписки - платим всегда" },
  flexSub: { en: "Everything else — the part you can flex", ru: "Всё остальное — здесь можно ужаться" },
  spent: { en: "spent", ru: "потрачено" },
  none: { en: "No spend recorded — nice and quiet.", ru: "Трат нет — тихий период." },
  now: { en: "now", ru: "сейчас" },
  safe: { en: "safe", ru: "запас" },
  projected: { en: "projected", ru: "прогноз" },
  house: { en: "House · 10M ₽", ru: "Квартира · 10М ₽" },
  soFar: { en: "so far", ru: "пока" },
  updated: { en: "Updated", ru: "Обновлено" },
  theme: { en: "Theme", ru: "Тема" },
};
function t(key: keyof typeof STRINGS): string {
  return STRINGS[key]?.[LANG] ?? STRINGS[key]?.en ?? String(key);
}

const CATEGORY_RU: Readonly<Record<string, string>> = {
  Rent: "Аренда",
  "Rent & utilities": "Аренда и ЖКХ",
  Subscriptions: "Подписки",
  Groceries: "Продукты",
  "Eating out": "Кафе и рестораны",
  Drinking: "Бары",
  Travel: "Путешествия",
  Clothing: "Одежда",
  Cash: "Наличные",
  Transport: "Транспорт",
  Commute: "Транспорт",
  Micromobility: "Самокаты",
  Miscellaneous: "Разное",
  Utilities: "Коммуналка",
  Health: "Здоровье",
  Kids: "Дети",
  Shopping: "Покупки",
  Entertainment: "Развлечения",
  Music: "Музыка",
  Sport: "Спорт",
  Insurance: "Страховка",
  Phone: "Связь",
  Home: "Дом",
  Household: "Хозяйство",
  Drogerie: "Дрогери",
  Books: "Книги",
  Gaming: "Игры",
  Crypto: "Крипта",
  Fitness: "Фитнес",
  "Business lunch": "Бизнес-ланч",
  Other: "Другое",
  Admin: "Документы",
  Uncategorized: "Без категории",
  "Bank fees": "Комиссии банка",
};
function catName(cat: string): string {
  return LANG === "ru" ? CATEGORY_RU[cat] ?? cat : cat;
}

// Account label -> display name comes from the profile (DISPLAY). Unknown accounts
// fall back to the raw label.
function accountLabel(account: string): string {
  return DISPLAY.accountLabels?.[account]?.[LANG] ?? account;
}

// Display-only merchant info: a clean name (optional) and a "what's it for" note,
// matched case-insensitively by substring, supplied by the profile (DISPLAY). It is
// display only — the raw string still drives categorization, and the personal
// content lives in data/profile.json, never in this module.
function merchantInfo(raw: string): { name: string; note: string } {
  const r = raw.toLowerCase();
  for (const m of DISPLAY.merchantInfo ?? []) {
    if (r.includes(m.pat.toLowerCase())) {
      const note = (LANG === "ru" ? m.ru ?? m.en : m.en) ?? "";
      return { name: m.name ?? raw, note };
    }
  }
  return { name: raw, note: "" };
}
/** Transaction date for display: YYYY-MM-DD -> DD-MM-YYYY (unambiguous day-first). */
function txDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}

const MONTHS_LONG: Readonly<Record<Lang, readonly string[]>> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  ru: ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"],
};
const MONTHS_SHORT: Readonly<Record<Lang, readonly string[]>> = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  ru: ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"],
};

/** Russian plural for an item count: 1 операция, 2-4 операции, 5+ операций. */
function itemsWord(n: number): string {
  if (LANG === "en") return n === 1 ? "item" : "items";
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "операция";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "операции";
  return "операций";
}

// --- formatting helpers -----------------------------------------------------

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
/** Thousands separator: comma for EN, thin-free space for RU. */
function sep(): string {
  return LANG === "ru" ? " " : ",";
}
function money(amount: number, symbol: string): string {
  const r = Math.round(amount);
  const sign = r < 0 ? "-" : "";
  const digits = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, sep());
  return `${sign}${symbol}${digits}`;
}
function eur(amount: number): string {
  return money(amount, "€");
}
function rub(amount: number): string {
  return money(amount, "₽");
}
function splitMonth(month: string): { year: number; monthIndex: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  return { year: Number(m[1]), monthIndex: Number(m[2]) - 1 };
}
function prettyMonth(month: string): string {
  const parts = splitMonth(month);
  if (parts === null) return month;
  const name = MONTHS_LONG[LANG][parts.monthIndex];
  if (name === undefined) return month;
  const cap = LANG === "ru" ? name.charAt(0).toUpperCase() + name.slice(1) : name;
  return `${cap} ${parts.year}`;
}
function periodLabel(period: string): string {
  if (/^\d{4}$/.test(period)) return `${period} ${t("soFar")}`;
  return prettyMonth(period);
}
function monthsBetween(from: string, to: string): number {
  const a = splitMonth(from);
  const b = splitMonth(to);
  if (a === null || b === null) return 0;
  return (b.year - a.year) * 12 + (b.monthIndex - a.monthIndex);
}

export interface ProjectionView {
  startEur: number;
  defaultRateEur: number;
  rubPerEur: number | null;
  components: StockComponent[];
  lookbackMonths: number;
  /** Illiquid net-worth layer that sits under liquid savings: the Voronezh flats
   *  net of the VTB mortgage (RUB, appreciating) and the BCS note (CNY, flat). */
  netWorth?: {
    propertyEur: number;
    propertyBaseEur: number;
    propertyDebtEur: number;
    propertyApr: number;
    bcsEur: number;
    milestones: { eur: number; label: string; hero: boolean }[];
  };
}

export interface MonthSpend {
  month: string;
  groups: SpendTierGroup[];
}

export interface DashboardInput {
  report: Report;
  focusMonth: string;
  today: Date;
  nowMonth: string;
  lang?: Lang;
  projection?: ProjectionView;
  series?: SavingsSeriesData;
  months?: MonthSpend[];
  selectedMonth?: string;
  display?: DisplayConfig;
}

// --- Savings section --------------------------------------------------------

// `cur` says which slider grows this line: "eur" (euro destinations, fed by the
// EUR slider via the house->T212 waterfall), "rub" (rouble destinations, fed by
// the RUB slider), or null for the Total (sum of both). New RU banks fall through
// to "rub" so they grow with roubles by default.
// `label` is the full chip name (currency-tagged); `short` is the compact name drawn
// at the line's right end on the chart, where space is tight (esp. on mobile).
function seriesMeta(key: string, fallbackLabel: string): { label: string; short: string; color: string; cap: number | null; cur: "eur" | "rub" | null } {
  const k = key.toLowerCase();
  const ru = LANG === "ru";
  if (k === "total") return { label: t("total"), short: t("total"), color: PALETTE.green, cap: null, cur: null };
  if (k === "trading212") return { label: "EUR · Trading212 ETF", short: "Trading212", color: PALETTE.blue, cap: null, cur: "eur" };
  if (k === "house") return { label: ru ? "N26 (квартира)" : "N26 (house)", short: "N26", color: PALETTE.amber, cap: HOUSE_CAP_EUR, cur: "eur" };
  if (k === "alfa-deposit") return { label: ru ? "RUR · Альфа-Банк вклад" : "RUR · Alfa Bank", short: ru ? "Альфа-Банк" : "Alfa Bank", color: "#8A5A9E", cap: null, cur: "rub" };
  if (k === "property") return { label: ru ? "Недвижимость" : "Real estate", short: ru ? "Недвижимость" : "Real estate", color: "#9B6A43", cap: null, cur: null };
  if (k === "bcs") return { label: ru ? "RUR · БКС Инвестиции" : "RUR · BCS", short: "BCS", color: "#B84C4C", cap: null, cur: null };
  return { label: fallbackLabel, short: fallbackLabel, color: "#7A776F", cap: null, cur: "rub" };
}

function savingsSection(p: ProjectionView, series: SavingsSeriesData, nowMonth: string): string {
  const start = Math.round(p.startEur);
  const showRub = p.rubPerEur !== null;
  const rubAt = showRub ? p.rubPerEur! : 0;
  const maxEur = 5000;
  const maxRub = 100000;
  const initEur = Math.min(SLIDER_DEFAULT_EUR, maxEur);
  const initRub = Math.min(SLIDER_DEFAULT_RUB, maxRub);

  const firstMonth = series.months.length > 0 ? series.months[0]! : nowMonth;
  const firstParts = splitMonth(firstMonth) ?? { year: 2020, monthIndex: 0 };
  const nowIndex = Math.max(0, monthsBetween(firstMonth, nowMonth));
  const idxOf = (m: string): number => monthsBetween(firstMonth, m);
  const histOf = (vals: number[]): number[][] => series.months.map((m, i) => [idxOf(m), Math.round(vals[i]!)]);

  // Net-worth base: illiquid assets (flats net of mortgage, BCS note) that sit
  // under the liquid savings. They lift the Total's start and history; the Total
  // appreciates with the property (grow/gm) on top of the slider rate.
  const nw = p.netWorth;
  const nwBase = nw ? nw.propertyEur + nw.bcsEur : 0;
  const netWorthStart = start + Math.round(nwBase);

  type ChartSeries = { key: string; label: string; short: string; color: string; start: number; hist: number[][]; cap: number | null; cur: "eur" | "rub" | null; nw?: boolean; base?: number; debt?: number; apr?: number; off?: boolean };
  const chartSeries: ChartSeries[] = [
    { key: "total", ...seriesMeta("total", "Total"), start: netWorthStart, hist: histOf(series.total.map((v) => v + nwBase)) },
  ];
  for (const line of series.lines) {
    if (line.key === "house") continue; // N26 house pot dropped from the chart — it sits at €0 and just clutters
    const meta = seriesMeta(line.key, line.label);
    chartSeries.push({ key: line.key, label: meta.label, short: meta.short, color: meta.color, cap: meta.cap, cur: meta.cur, start: Math.round(line.values[line.values.length - 1] ?? 0), hist: histOf(line.values) });
  }
  if (nw) {
    const flat = (v: number): number[][] => series.months.map((m) => [idxOf(m), Math.round(v)]);
    const pMeta = seriesMeta("property", "Property");
    const bMeta = seriesMeta("bcs", "BCS");
    // BCS before Real estate so Real estate sits LAST in the legend, and it starts
    // toggled OFF so the headline opens on the liquid (touchable) number.
    chartSeries.push({ key: "bcs", label: bMeta.label, short: bMeta.short, color: bMeta.color, cap: null, cur: null, start: Math.round(nw.bcsEur), hist: flat(nw.bcsEur), nw: true });
    chartSeries.push({ key: "property", label: pMeta.label, short: pMeta.short, color: pMeta.color, cap: null, cur: null, start: Math.round(nw.propertyEur), hist: flat(nw.propertyEur), nw: true, base: Math.round(nw.propertyBaseEur), debt: Math.round(nw.propertyDebtEur), apr: nw.propertyApr, off: true });
  }
  const houseSeries = chartSeries.find((s) => s.cap !== null);
  const houseStart = houseSeries?.start ?? 0;
  const houseCap = houseSeries?.cap ?? HOUSE_CAP_EUR;

  const chips = chartSeries
    .map(
      (s) =>
        `<button type="button" class="sv-chip ${s.key === "total" ? "sv-chip-tot" : "sv-chip-sec"}${s.off ? " off" : ""}" data-key="${esc(s.key)}" style="--c:${s.color}">` +
        `<span class="sv-dot"></span><span class="sv-cname">${esc(s.label)}</span> <strong>${esc(eur(s.start))}</strong></button>`,
    )
    .join("");

  const eurPerRub = showRub && rubAt > 0 ? 1 / rubAt : 0.0105;
  const initEff = initEur + initRub * eurPerRub;
  // Real estate opens toggled OFF, so the initial server render shows the liquid
  // total (everything except property); the script recomputes live as chips toggle.
  const initVisStart = netWorthStart - (nw ? Math.round(nw.propertyEur) : 0);
  const projEur = (mo: number): number => initVisStart + initEff * mo;
  const houseEur = Math.round((10_000_000 * eurPerRub) / 100) * 100;
  const milestones = nw
    ? nw.milestones
    : [
        { eur: 25000, label: "25k", hero: false },
        { eur: 50000, label: "50k", hero: false },
        { eur: houseEur, label: "\u{1F3E0} " + t("house"), hero: true },
      ];

  const data = {
    nowI: nowIndex,
    fy: firstParts.year,
    fm: firstParts.monthIndex,
    rub: showRub ? Number(rubAt.toFixed(4)) : 0,
    houseStart,
    houseCap,
    eurPerRub: Number(eurPerRub.toFixed(6)),
    maxRub,
    series: chartSeries,
    milestones,
    sep: sep(),
    mShort: MONTHS_SHORT[LANG],
    sNow: t("now"),
    sSafe: t("safe"),
    sProj: t("projected"),
  };
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");

  return `
    <section class="card savings" aria-label="${esc(t("savedSoFar"))}">
      <div class="sv-head">
        <div class="sv-now">
          <div class="sv-now-label">${esc(nw ? t("netWorth") : t("savedSoFar"))}</div>
          <div class="sv-now-amt" id="svNowEur">${esc(eur(initVisStart))}</div>
          ${showRub ? `<div class="sv-now-rub" id="svNowRub">${esc(rub(initVisStart * rubAt))}</div>` : ""}
        </div>
        <div class="sv-figs">
          <div class="sv-fig">
            <span class="sv-fig-label">${esc(t("in1y"))}</span>
            <strong class="sv-fig-amt" id="svY1eur">${esc(eur(projEur(12)))}</strong>
            ${showRub ? `<em class="sv-fig-rub" id="svY1rub">${esc(rub(projEur(12) * rubAt))}</em>` : ""}
          </div>
          <div class="sv-fig sv-fig-hero">
            <span class="sv-fig-label">${esc(t("in5y"))}</span>
            <strong class="sv-fig-amt" id="svY5eur">${esc(eur(projEur(60)))}</strong>
            ${showRub ? `<em class="sv-fig-rub" id="svY5rub">${esc(rub(projEur(60) * rubAt))}</em>` : ""}
          </div>
        </div>
      </div>
      <div class="sv-legend">${chips}</div>
      <div class="sv-chart-wrap">
        <svg id="svChart" viewBox="0 0 1040 480" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(t("savedSoFar"))}"></svg>
        <div id="svTip" class="sv-tip" hidden></div>
      </div>
      <div class="sv-rate-head">${esc(t("monthly"))}</div>
      <div class="sv-controls">
        <div class="sv-slider">
          <div class="sv-control-row">
            <span class="sv-rate-label">${esc(t("eurMonthly"))}</span>
            <span class="sv-rate"><span id="svRateEurLabel">${esc(eur(initEur))}</span>/${LANG === "ru" ? "мес" : "mo"}</span>
          </div>
          <input type="range" id="svRateEur" min="0" max="${maxEur}" step="25" value="${initEur}" aria-label="${esc(t("eurMonthly"))}" />
        </div>
        <div class="sv-slider">
          <div class="sv-control-row">
            <span class="sv-rate-label">${esc(t("rubMonthly"))}</span>
            <span class="sv-rate sv-rate-rub"><span id="svRateRubLabel">${esc(rub(initRub))}</span>/${LANG === "ru" ? "мес" : "mo"}</span>
          </div>
          <input type="range" id="svRateRub" min="0" max="${maxRub}" step="1000" value="${initRub}" aria-label="${esc(t("rubMonthly"))}" />
        </div>
      </div>
      <script>${savingsScript(dataJson)}</script>
    </section>`;
}

function savingsScript(dataJson: string): string {
  return `(function(){
var D=JSON.parse(${JSON.stringify(dataJson)});
var SH=D.mShort;
var svg=document.getElementById('svChart'),tip=document.getElementById('svTip');
var eurS=document.getElementById('svRateEur'),rubS=document.getElementById('svRateRub');
var W=1040,H=480,PL=24,PR=82,PT=28,PB=38,pw=W-PL-PR,ph=H-PT-PB,narrow=false;
function layout(){
  var r=svg.getBoundingClientRect();
  W=Math.max(260,Math.round(r.width)||1040); H=Math.max(220,Math.round(r.height)||480);
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  narrow=W<560;
  PL=narrow?8:24; PR=narrow?12:92; PT=narrow?20:28; PB=narrow?34:38;
  pw=W-PL-PR; ph=H-PT-PB;
}
var BORD='rgba(125,120,108,.28)',SOFT='rgba(120,116,104,.75)',GAP='rgba(150,145,132,.6)';
var vis={}; D.series.forEach(function(s){vis[s.key]=!s.off;});
var RUBN=D.series.filter(function(s){return s.cur==='rub';}).length||1;
var pts=[], dMin=0, dMax=1, capY=-99;
var vS=D.nowI-12, vE=D.nowI+12;
function fmt(n){var s=Math.round(n),sg=s<0?'-':'';s=Math.abs(s);return sg+s.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g,D.sep);}
function setText(id,t){var e=document.getElementById(id);if(e)e.textContent=t;}
function lbl(i){var t=D.fy*12+D.fm+Math.round(i);return SH[((t%12)+12)%12]+" '"+String(Math.floor(t/12)).slice(2);}
function xAt(i){return PL+pw*(i-vS)/((vE-vS)||1);}
function yAt(v){return PT+ph*(1-(v-dMin)/((dMax-dMin)||1));}
function projVal(s,k,rE,rEff){ if(s.nw)return (s.base!=null?s.base:s.start)*Math.pow(1+(s.apr||0),k/12)-(s.debt||0);
  if(s.cur==='rub')return s.start+((rEff-rE)/RUBN)*k;
  return s.start+rE*k; }
function clampV(){ var sp=vE-vS; sp=Math.max(4,Math.min(D.nowI+126,sp));
  if(vS<-4){vE=-4+sp;vS=-4;} if(vE>D.nowI+120){vS=D.nowI+120-sp;vE=D.nowI+120;} }
function hx(c){return [parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)];}
function mix(a,b,t){var x=hx(a),y=hx(b);return 'rgb('+Math.round(x[0]+(y[0]-x[0])*t)+','+Math.round(x[1]+(y[1]-x[1])*t)+','+Math.round(x[2]+(y[2]-x[2])*t)+')';}
function valColor(r){var S=[[0,'#C0392B'],[500,'#E07B39'],[1000,'#C7A23E'],[1500,'#6BA877'],[2500,'#2F8F5E'],[3000,'#1FB07A'],[5000,'#10D6A1']];
  for(var i=1;i<S.length;i++){if(r<=S[i][0]){var t=(r-S[i-1][0])/((S[i][0]-S[i-1][0])||1);return mix(S[i-1][1],S[i][1],t);}}return S[S.length-1][1];}
function line(a,color,dash,w,op){ if(a.length<1)return '';
  var p=a.map(function(d){return xAt(d[0]).toFixed(1)+','+yAt(d[1]).toFixed(1);}).join(' ');
  return '<polyline points="'+p+'" fill="none" stroke="'+color+'" stroke-width="'+(w||2.6)+'" stroke-linejoin="round" stroke-linecap="round" stroke-opacity="'+(op==null?1:op)+'"'+(dash?' stroke-dasharray="'+dash+'"':'')+'/>'; }
function draw(){
  var rE=Number(eurS.value), rR=Number(rubS.value), rEff=rE+rR*D.eurPerRub;
  var colE=valColor(rE), colR=valColor(rR*(5000/(D.maxRub||100000)));
  // Total is computed from the VISIBLE component lines, so toggling a chip (e.g.
  // real estate) moves the headline number too — hide property and you see the liquid pile.
  var comps=[]; D.series.forEach(function(s){ if(s.key!=='total') comps.push(s); });
  var nMonths=comps.length?comps[0].hist.length:0;
  function visC(){ var a=[]; comps.forEach(function(c){ if(vis[c.key]) a.push(c); }); return a; }
  function totHistArr(){ var vc=visC(),arr=[]; for(var i=0;i<nMonths;i++){ var sum=0,mi=comps[0].hist[i][0]; for(var j=0;j<vc.length;j++){ var h=vc[j].hist[i]; if(h)sum+=h[1]; } arr.push([mi,sum]); } return arr; }
  function totProj(k){ var vc=visC(),s=0; for(var j=0;j<vc.length;j++) s+=projVal(vc[j],k,rE,rEff); return s; }
  var TH=totHistArr();
  var allV=[0];
  comps.forEach(function(s){ if(!vis[s.key])return;
    s.hist.forEach(function(p){ if(p[0]>=vS&&p[0]<=vE) allV.push(p[1]); });
    for(var k=0;k<=120;k++){ if(D.nowI+k>vE)break; allV.push(projVal(s,k,rE,rEff)); } });
  if(vis.total){ TH.forEach(function(p){ if(p[0]>=vS&&p[0]<=vE) allV.push(p[1]); });
    for(var kt=0;kt<=120;kt++){ if(D.nowI+kt>vE)break; allV.push(totProj(kt)); } }
  dMax=Math.max.apply(null,allV); dMin=Math.min.apply(null,allV); if(dMin>0)dMin=0;
  var out='<defs><linearGradient id="svFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${PALETTE.greenBright}" stop-opacity="0.16"/><stop offset="100%" stop-color="${PALETTE.greenBright}" stop-opacity="0.01"/></linearGradient><linearGradient id="svScrim" x1="0" y1="0" x2="1" y2="0"><stop offset="0" class="sv-scrimc" stop-opacity="0"/><stop offset="0.55" class="sv-scrimc" stop-opacity="0.82"/><stop offset="1" class="sv-scrimc" stop-opacity="1"/></linearGradient><clipPath id="svClip"><rect x="'+PL+'" y="0" width="'+pw+'" height="'+H+'"/></clipPath></defs>';
  out+='<g clip-path="url(#svClip)">';
  var cal0=D.fy*12+D.fm, ci;
  for(ci=Math.ceil(vS);ci<=Math.floor(vE);ci++){ if(((((cal0+ci)%12)+12)%12)===0){ var yx=xAt(ci);
    out+='<line x1="'+yx.toFixed(1)+'" y1="'+PT+'" x2="'+yx.toFixed(1)+'" y2="'+(PT+ph)+'" stroke="'+BORD+'" stroke-width="1"/>';
    if(yx<W-(narrow?108:40)) out+='<text x="'+(yx+5).toFixed(1)+'" y="'+(PT+12)+'" class="sv-yr">'+Math.floor((cal0+ci)/12)+'</text>'; } }
  D.milestones.forEach(function(m){ var my=yAt(m.eur); if(my>PT+2&&my<PT+ph){
    out+='<line x1="'+PL+'" y1="'+my.toFixed(1)+'" x2="'+(W-PR)+'" y2="'+my.toFixed(1)+'" stroke="'+(m.hero?'${PALETTE.green}':SOFT)+'" stroke-width="'+(m.hero?1.4:1)+'" stroke-dasharray="'+(m.hero?'6 4':'2 6')+'" stroke-opacity="'+(m.hero?0.8:0.4)+'"/>'; } });
  out+='<line x1="'+PL+'" y1="'+yAt(0).toFixed(1)+'" x2="'+(W-PR)+'" y2="'+yAt(0).toFixed(1)+'" stroke="'+BORD+'" stroke-width="1" stroke-dasharray="3 4"/>';
  capY=yAt(D.houseCap);
  if(capY>PT && capY<PT+ph){ out+='<line x1="'+PL+'" y1="'+capY.toFixed(1)+'" x2="'+(W-PR)+'" y2="'+capY.toFixed(1)+'" stroke="'+SOFT+'" stroke-width="1" stroke-dasharray="2 6" stroke-opacity="0.4"/>'; }
  pts=[]; var labels=[];
  if(vis.total && TH.length){ var thlast=TH[TH.length-1][0];
    var ha=TH.filter(function(p){return p[0]>=vS&&p[0]<=Math.min(vE,thlast);});
    if(ha.length){ var base=(PT+ph).toFixed(1);
      out+='<path d="M '+xAt(ha[0][0]).toFixed(1)+' '+base+' '+ha.map(function(p){return 'L '+xAt(p[0]).toFixed(1)+' '+yAt(p[1]).toFixed(1);}).join(' ')+' L '+xAt(ha[ha.length-1][0]).toFixed(1)+' '+base+' Z" fill="url(#svFill)"/>'; } }
  comps.forEach(function(s){ if(!vis[s.key])return;
    var lh=s.hist.length?s.hist[s.hist.length-1]:[D.nowI,s.start];
    var hp=s.hist.filter(function(p){return p[0]>=vS-1&&p[0]<=vE;});
    out+=line(hp,s.color,'',2,0.52);
    if(lh[0]<D.nowI){ out+=line([[lh[0],lh[1]],[D.nowI,lh[1]]],GAP,'1 5',2.2,0.8); }
    var pp=[]; for(var k=0;k<=120;k++){var i=D.nowI+k; if(i>vE)break; pp.push([i,projVal(s,k,rE,rEff)]);}
    out+=line(pp,s.color,'7 6',1.7,0.52);
    hp.forEach(function(p){pts.push({x:xAt(p[0]),y:yAt(p[1]),i:p[0],v:p[1],s:s.label,c:s.color,f:0});});
    pp.forEach(function(p,j){if(j>0)pts.push({x:xAt(p[0]),y:yAt(p[1]),i:p[0],v:p[1],s:s.label,c:s.color,f:1});});
    var ep=pp.length?pp[pp.length-1]:(hp.length?hp[hp.length-1]:null); if(ep)labels.push({y:yAt(ep[1]),t:s.short||s.label,c:s.color}); });
  if(vis.total && TH.length){ var T0=D.series[0],tcol=T0.color,tlab=T0.label,tsh=T0.short||T0.label;
    var tlh=TH[TH.length-1];
    var thp=TH.filter(function(p){return p[0]>=vS-1&&p[0]<=vE;});
    out+=line(thp,tcol,'',3.6,1);
    if(tlh[0]<D.nowI){ out+=line([[tlh[0],tlh[1]],[D.nowI,tlh[1]]],GAP,'1 5',2.2,0.8); }
    var tpp=[]; for(var kk=0;kk<=120;kk++){var ii=D.nowI+kk; if(ii>vE)break; tpp.push([ii,totProj(kk)]);}
    out+=line(tpp,tcol,'7 6',3,1);
    thp.forEach(function(p){pts.push({x:xAt(p[0]),y:yAt(p[1]),i:p[0],v:p[1],s:tlab,c:tcol,f:0});});
    tpp.forEach(function(p,j){if(j>0)pts.push({x:xAt(p[0]),y:yAt(p[1]),i:p[0],v:p[1],s:tlab,c:tcol,f:1});});
    var tep=tpp.length?tpp[tpp.length-1]:(thp.length?thp[thp.length-1]:null); if(tep)labels.push({y:yAt(tep[1]),t:tsh,c:tcol}); }
  if(D.nowI>=vS&&D.nowI<=vE){ var nx=xAt(D.nowI).toFixed(1);
    out+='<line x1="'+nx+'" y1="'+PT+'" x2="'+nx+'" y2="'+(PT+ph)+'" stroke="'+SOFT+'" stroke-width="1.2"/><text x="'+nx+'" y="'+(PT-8)+'" text-anchor="middle" class="sv-now-mk">'+D.sNow+'</text>'; }
  out+='</g>';
  var ticks=narrow?3:4,i; for(i=0;i<=ticks;i++){ var idx=vS+(vE-vS)*i/ticks; var x=xAt(idx).toFixed(1);
    var an=(i===0?'start':(i===ticks?'end':'middle'));
    out+='<text x="'+x+'" y="'+(H-12)+'" text-anchor="'+an+'" class="sv-ax">'+lbl(idx)+'</text>'; }
  D.milestones.forEach(function(m){ var my=yAt(m.eur); if(my>PT+2&&my<PT+ph){
    out+='<text x="'+(PL+5)+'" y="'+(my-5).toFixed(1)+'" class="sv-ms'+(m.hero?' hero':'')+'">'+m.label+'</text>'; } });
  out+='<text id="svTgt" x="'+(PL+5)+'" y="'+(capY-5).toFixed(1)+'" class="sv-tgt" style="display:none">'+fmt(D.houseCap)+' '+D.sSafe+'</text>';
  if(labels.length){ labels.sort(function(a,b){return a.y-b.y;});
    var gap=narrow?13:13, fs=narrow?10:10.5;
    for(var li=1;li<labels.length;li++){ if(labels[li].y-labels[li-1].y<gap) labels[li].y=labels[li-1].y+gap; }
    var ov=labels[labels.length-1].y-(PT+ph-2); if(ov>0){ for(var lj=0;lj<labels.length;lj++) labels[lj].y-=ov; }
    if(labels[0].y<PT+8){ var un=PT+8-labels[0].y; for(var lm=0;lm<labels.length;lm++) labels[lm].y+=un; }
    if(narrow){ var scW=Math.min(104,pw*0.46);
      out+='<rect x="'+(W-scW).toFixed(1)+'" y="'+PT+'" width="'+scW.toFixed(1)+'" height="'+ph+'" fill="url(#svScrim)"/>';
      labels.forEach(function(L){ out+='<text x="'+(W-7)+'" y="'+(L.y+3).toFixed(1)+'" text-anchor="end" class="sv-llabel" style="font-size:'+fs+'px" fill="'+L.c+'">'+L.t+'</text>'; }); }
    else { labels.forEach(function(L){ out+='<text x="'+(W-PR+6)+'" y="'+(L.y+3).toFixed(1)+'" class="sv-llabel" style="font-size:'+fs+'px" fill="'+L.c+'">'+L.t+'</text>'; }); } }
  out+='<circle id="svDot" r="5.5" fill="#fff" stroke="${PALETTE.green}" stroke-width="2.5" style="display:none"/>';
  svg.innerHTML=out;
  setText('svRateEurLabel','€'+fmt(rE)); setText('svRateRubLabel','₽'+fmt(rR));
  var rle=document.getElementById('svRateEurLabel'); if(rle)rle.style.color=colE;
  var rlr=document.getElementById('svRateRubLabel'); if(rlr)rlr.style.color=colR;
  eurS.style.setProperty('--thumb',colE); eurS.classList.toggle('hot', rE>=3000);
  rubS.style.setProperty('--thumb',colR); rubS.classList.toggle('hot', rR>=60000);
  setText('svNowEur','€'+fmt(totProj(0))); if(D.rub)setText('svNowRub','₽'+fmt(totProj(0)*D.rub));
  setText('svY1eur','€'+fmt(totProj(12))); setText('svY5eur','€'+fmt(totProj(60)));
  if(D.rub){setText('svY1rub','₽'+fmt(totProj(12)*D.rub)); setText('svY5rub','₽'+fmt(totProj(60)*D.rub));}
  var tc=document.querySelector('.sv-chip[data-key="total"] strong'); if(tc)tc.textContent='€'+fmt(totProj(0));
}
function showTip(cx,cy){ if(!pts.length)return;
  var rc=svg.getBoundingClientRect(), vx=(cx-rc.left)/rc.width*W, vy=(cy-rc.top)/rc.height*H;
  var tgt=document.getElementById('svTgt'); if(tgt)tgt.style.display=(Math.abs(vy-capY)<13)?'':'none';
  var best=null,bd=1e9; pts.forEach(function(p){var d=(p.x-vx)*(p.x-vx)+(p.y-vy)*(p.y-vy)*0.3; if(d<bd){bd=d;best=p;}});
  if(!best)return;
  var dot=document.getElementById('svDot');
  if(dot){dot.setAttribute('cx',best.x.toFixed(1));dot.setAttribute('cy',best.y.toFixed(1));dot.setAttribute('stroke',best.c);dot.style.display='';}
  tip.innerHTML='<span class="sv-tip-m">'+best.s+' · '+lbl(best.i)+(best.f?' · '+D.sProj:'')+'</span><span class="sv-tip-v" style="color:'+best.c+'">€'+fmt(best.v)+(D.rub?'  ·  ₽'+fmt(best.v*D.rub):'')+'</span>';
  tip.style.left=(best.x/W*rc.width)+'px'; tip.style.top=(best.y/H*rc.height)+'px'; tip.hidden=false;
}
function hideTip(){tip.hidden=true; var d=document.getElementById('svDot'); if(d)d.style.display='none'; var t=document.getElementById('svTgt'); if(t)t.style.display='none';}
var drag=false,dragX=0;
svg.addEventListener('mousemove',function(e){ if(drag){var rc=svg.getBoundingClientRect();var sp=vE-vS;var d=-(e.clientX-dragX)/rc.width*sp;vS+=d;vE+=d;dragX=e.clientX;clampV();draw();} else showTip(e.clientX,e.clientY); });
svg.addEventListener('mouseleave',function(){hideTip();drag=false;});
svg.addEventListener('mousedown',function(e){drag=true;dragX=e.clientX;});
window.addEventListener('mouseup',function(){drag=false;});
svg.addEventListener('wheel',function(e){
  var rc=svg.getBoundingClientRect();
  if(e.ctrlKey||e.metaKey){ e.preventDefault(); var vx=(e.clientX-rc.left)/rc.width*W; var cidx=vS+(vx-PL)/pw*(vE-vS);
    var f=Math.exp(e.deltaY*0.012); var nsp=Math.max(4,Math.min(D.nowI+126,(vE-vS)*f)); var fr=(cidx-vS)/((vE-vS)||1);
    vS=cidx-fr*nsp; vE=vS+nsp; clampV(); draw(); }
  else if(Math.abs(e.deltaX)>Math.abs(e.deltaY)){ e.preventDefault(); var sp=vE-vS,d=e.deltaX/pw*sp; vS+=d;vE+=d;clampV();draw(); }
},{passive:false});
var pd=0;
svg.addEventListener('touchstart',function(e){if(e.touches.length===2)pd=Math.abs(e.touches[0].clientX-e.touches[1].clientX); else if(e.touches.length===1)showTip(e.touches[0].clientX,e.touches[0].clientY);},{passive:true});
svg.addEventListener('touchmove',function(e){ if(e.touches.length===2){ e.preventDefault(); var rc=svg.getBoundingClientRect();
  var d=Math.abs(e.touches[0].clientX-e.touches[1].clientX); if(pd){ var cx=((e.touches[0].clientX+e.touches[1].clientX)/2-rc.left)/rc.width*W;
    var cidx=vS+(cx-PL)/pw*(vE-vS); var f=pd/d; var nsp=Math.max(4,Math.min(D.nowI+126,(vE-vS)*f)); var fr=(cidx-vS)/((vE-vS)||1);
    vS=cidx-fr*nsp; vE=vS+nsp; clampV(); draw(); } pd=d; }
  else if(e.touches.length===1){ showTip(e.touches[0].clientX,e.touches[0].clientY); } },{passive:false});
svg.addEventListener('touchend',function(){hideTip();});
document.querySelectorAll('.sv-chip').forEach(function(b){ b.addEventListener('click',function(){
  var k=b.getAttribute('data-key'); vis[k]=!vis[k]; b.classList.toggle('off',!vis[k]); draw(); }); });
eurS.addEventListener('input',draw);
rubS.addEventListener('input',draw);
var raf=0;
function relayout(){ if(raf)cancelAnimationFrame(raf); raf=requestAnimationFrame(function(){layout();draw();}); }
if(window.ResizeObserver){ new ResizeObserver(relayout).observe(svg); } else { window.addEventListener('resize',relayout); }
layout(); draw();
})();`;
}

// --- Spend section ----------------------------------------------------------

function splitBar(groups: SpendTierGroup[], total: number): string {
  if (total <= 0) return "";
  const mand = groups.find((g) => g.tier === "mandatory")?.total ?? 0;
  const flex = groups.find((g) => g.tier === "non-mandatory")?.total ?? 0;
  const seg = (amount: number, color: string, name: string): string => {
    if (amount <= 0) return "";
    const pct = (amount / total) * 100;
    return `<div class="bd-seg" style="width:${pct.toFixed(2)}%;background:${color}" title="${esc(name)} ${esc(eur(amount))} (${Math.round(pct)}%)"><span class="bd-seg-l">${esc(name)} ${Math.round(pct)}%</span></div>`;
  };
  return `<div class="bd-bar bd-split">${seg(mand, PALETTE.green, t("mandatory"))}${seg(flex, PALETTE.amber, t("nonMandatory"))}</div>`;
}

function tierBar(g: SpendTierGroup): string {
  if (g.total <= 0 || g.categories.length === 0) return "";
  const bars = g.categories
    .map((c) => {
      const pct = (c.total / g.total) * 100;
      const color = categoryColor(c.category);
      const label = pct >= 4.5 ? `<span class="bd-seg-l">${esc(catName(c.category))} ${Math.round(pct)}%</span>` : "";
      return `<div class="bd-seg" data-cat="${esc(c.category)}" style="width:${pct.toFixed(2)}%;background:${color}" title="${esc(catName(c.category))} ${esc(eur(c.total))}">${label}</div>`;
    })
    .join("");
  return `<div class="bd-bar bd-tier">${bars}</div>`;
}

function categoryDetails(c: SpendTierGroup["categories"][number], monthTotal: number, tierMax: number): string {
  const pct = monthTotal > 0 ? Math.round((c.total / monthTotal) * 100) : 0;
  const widthPct = tierMax > 0 ? (c.total / tierMax) * 100 : 0;
  const rows = c.txns
    .map(
      (tx) =>
        (() => {
          const mi = merchantInfo(tx.merchant);
          return `<li><span class="t-date">${esc(txDate(tx.date))}</span><span class="t-merch"><span class="t-name">${esc(mi.name)}</span>${mi.note ? `<span class="t-note">${esc(mi.note)}</span>` : ""}</span><span class="t-acct">${esc(accountLabel(tx.account))}</span><span class="t-amt">${esc(eur(tx.eur))}</span></li>`;
        })(),
    )
    .join("");
  return `
          <details class="cat" data-cat="${esc(c.category)}">
            <summary>
              <span class="cat-fill" style="width:${widthPct.toFixed(1)}%;background:${categoryColor(c.category)}2E"></span>
              <span class="cat-dot" style="background:${categoryColor(c.category)}"></span>
              <span class="cat-name">${esc(catName(c.category))}</span>
              <span class="cat-pct">${pct}%</span>
              <span class="cat-meta">${c.count} ${esc(itemsWord(c.count))}</span>
              <span class="cat-amt">${esc(eur(c.total))}</span>
            </summary>
            <ul class="txns">${rows}</ul>
          </details>`;
}

function tierBlock(g: SpendTierGroup, monthTotal: number): string {
  if (g.categories.length === 0) return "";
  const label = g.tier === "mandatory" ? t("mandatory") : t("nonMandatory");
  const sub = g.tier === "mandatory" ? t("mandatorySub") : t("flexSub");
  const tierMax = g.categories.reduce((mx, c) => Math.max(mx, c.total), 0);
  const cats = g.categories.map((c) => categoryDetails(c, monthTotal, tierMax)).join("");
  return `
      <div class="tier tier-${g.tier}">
        <div class="tier-head"><h3>${esc(label)}</h3><span class="tier-total">${esc(eur(g.total))}</span></div>
        <p class="tier-sub">${esc(sub)}</p>
        ${tierBar(g)}
        ${cats}
      </div>`;
}

function monthBlock(m: MonthSpend, selected: boolean): string {
  const total = m.groups.reduce((s, g) => s + g.total, 0);
  const blocks = m.groups.map((g) => tierBlock(g, total)).join("");
  return `
      <div class="month-block" data-month="${esc(m.month)}"${selected ? "" : " hidden"}>
        <div class="month-total">${esc(eur(total))}<span class="month-total-label">${esc(periodLabel(m.month))} · ${esc(t("spent"))}</span></div>
        ${splitBar(m.groups, total)}
        ${blocks || `<p class="muted">${esc(t("none"))}</p>`}
      </div>`;
}

function spendSection(months: MonthSpend[], selected: string): string {
  const ordered = [...months].sort((a, b) => {
    const ay = /^\d{4}$/.test(a.month) ? 1 : 0;
    const by = /^\d{4}$/.test(b.month) ? 1 : 0;
    if (ay !== by) return ay - by;
    return a.month < b.month ? 1 : -1;
  });
  const options = ordered
    .map((m) => `<option value="${esc(m.month)}"${m.month === selected ? " selected" : ""}>${esc(periodLabel(m.month))}</option>`)
    .join("");
  const blocks = ordered.map((m) => monthBlock(m, m.month === selected)).join("");
  const script = `(function(){
var sec=document.currentScript.parentElement, sel=document.getElementById('monthSel');
if(sel)sel.addEventListener('change',function(){var m=sel.value;
  sec.querySelectorAll('.month-block').forEach(function(b){b.hidden=b.getAttribute('data-month')!==m;});});
function setFocus(blk,cat){ blk.querySelectorAll('.bd-seg').forEach(function(s){var on=s.getAttribute('data-cat')===cat;s.classList.toggle('dim',!on);s.classList.toggle('hot',on);});
  blk.querySelectorAll('details.cat').forEach(function(d){d.classList.toggle('rowdim',d.getAttribute('data-cat')!==cat);}); }
function clearFocus(blk){ blk.querySelectorAll('.bd-seg').forEach(function(s){s.classList.remove('dim','hot');}); blk.querySelectorAll('details.cat').forEach(function(d){d.classList.remove('rowdim');}); }
sec.addEventListener('mouseover',function(e){var el=e.target.closest('[data-cat]'); if(!el)return; var blk=el.closest('.month-block'); if(blk)setFocus(blk,el.getAttribute('data-cat')); });
sec.addEventListener('mouseout',function(e){var el=e.target.closest('[data-cat]'); if(!el)return; var blk=el.closest('.month-block'); if(blk&&!blk.querySelector('[data-cat]:hover'))clearFocus(blk); });
})();`;
  return `
    <section class="card spend" aria-label="${esc(t("whereItGoes"))}">
      <header class="block-head spend-head">
        <div><div class="eyebrow">${esc(t("spendKicker"))}</div><h2>${esc(t("whereItGoes"))}</h2><p class="muted">${esc(t("tapCategory"))}</p></div>
        <select id="monthSel" class="month-pick" aria-label="${esc(t("whereItGoes"))}">${options}</select>
      </header>
      ${blocks}
      <script>${script}</script>
    </section>`;
}

// --- Page assembly ----------------------------------------------------------

function isoDay(today: Date): string {
  const y = today.getUTCFullYear();
  const m = String(today.getUTCMonth() + 1).padStart(2, "0");
  const d = String(today.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The fixed top-right controls: language (server-side links) and theme (client). */
function controls(): string {
  const other: Lang = LANG === "ru" ? "en" : "ru";
  return `
      <div class="controls">
        <a class="ctl lang ${LANG === "en" ? "on" : ""}" href="/?lang=en">EN</a>
        <a class="ctl lang ${LANG === "ru" ? "on" : ""}" href="/?lang=ru" data-other="${other}">RU</a>
        <button type="button" class="ctl theme" id="themeBtn" aria-label="${esc(t("theme"))}"><span class="theme-ic">\u{1F319}</span></button>
      </div>`;
}

export function renderDashboard(input: DashboardInput): string {
  LANG = input.lang ?? "en";
  DISPLAY = input.display ?? {};
  const { report, focusMonth, today, nowMonth, projection, series, months, selectedMonth } = input;
  const focus: MonthSummary | undefined = report.months.find((m) => m.month === focusMonth);
  if (focus === undefined) {
    throw new Error(
      `renderDashboard: focus month "${focusMonth}" not found in report (have: ${report.months.map((m) => m.month).join(", ") || "none"})`,
    );
  }
  const savingsBlock = projection && series && series.months.length >= 2 ? savingsSection(projection, series, nowMonth) : "";
  const spendBlock = months && months.length > 0 ? spendSection(months, selectedMonth ?? focusMonth) : "";

  // No-FOUC theme bootstrap + toggle, kept inline in <head>.
  const themeBoot = `(function(){try{var t=localStorage.getItem('kopeika-theme');if(!t)t=window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
  const themeToggle = `(function(){var b=document.getElementById('themeBtn');if(!b)return;b.addEventListener('click',function(){var d=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',d);try{localStorage.setItem('kopeika-theme',d);}catch(e){}b.querySelector('.theme-ic').textContent=d==='dark'?'\\u2600\\ufe0f':'\\u{1F319}';});var cur=document.documentElement.getAttribute('data-theme');b.querySelector('.theme-ic').textContent=cur==='dark'?'\\u2600\\ufe0f':'\\u{1F319}';})();`;

  return `<!DOCTYPE html>
<html lang="${LANG}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <title>${esc(t("title"))} · ${esc(prettyMonth(focus.month))}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet" />
  <script>${themeBoot}</script>
  <style>
${buildCss()}
  </style>
</head>
<body>
  <main class="page">
    <header class="page-head">
${controls()}
      <div class="eyebrow">${esc(t("worthKicker"))}</div>
      <h1>${esc(t("title"))}</h1>
      <p class="subtitle">${esc(t("subtitle"))}</p>
    </header>
${savingsBlock}
${spendBlock}
    <footer class="page-foot">
      ${esc(t("updated"))} ${esc(isoDay(today))} · kopeika${DISPLAY.footer ? ` · ${esc(DISPLAY.footer[LANG])}` : ""}
    </footer>
  </main>
  <script>${themeToggle}</script>
</body>
</html>
`;
}

// --- CSS --------------------------------------------------------------------

function buildCss(): string {
  return `    :root {
      --bg:#f6f4ec; --card:#fcfaf3; --card-soft:#efeadd;
      --ink:#1b1d1a; --ink-soft:#585b51; --ink-faint:#8d9083;
      --green:#16864a; --green-bright:#11a06a; --green-soft:#e4efe6;
      --amber:#c2641e; --amber-soft:#f3e7d6; --blue:#3e7ca8; --border:#e3ddcd; --line-soft:#ece7da;
      --dot:rgba(27,29,26,.05);
      --display:"Space Grotesk","Inter",sans-serif; --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
      --radius:22px; --radius-sm:13px; --radius-xs:9px;
      --shadow:0 1px 2px rgba(27,29,26,.04), 0 18px 40px -24px rgba(27,29,26,.26);
    }
    [data-theme="dark"] {
      --bg:#0e100d; --card:#181a15; --card-soft:#22251c;
      --ink:#ece9df; --ink-soft:#a6a99f; --ink-faint:#71756b;
      --green:#5ccf90; --green-bright:#79e7a6; --green-soft:rgba(92,207,144,.13);
      --amber:#e8a652; --amber-soft:rgba(232,166,82,.14); --blue:#6ba6d0; --border:#2b2e26; --line-soft:#23261d;
      --dot:rgba(255,255,255,.035);
      --shadow:0 1px 2px rgba(0,0,0,.34), 0 22px 46px -26px rgba(0,0,0,.6);
    }
    * { box-sizing:border-box; }
    html,body { margin:0; padding:0; }
    body { background-color:var(--bg);
      background-image:radial-gradient(circle at 1px 1px, var(--dot) 1px, transparent 0);
      background-size:26px 26px; color:var(--ink); line-height:1.55;
      font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; -webkit-font-smoothing:antialiased; transition:background-color .2s,color .2s; }
    .page { max-width:1120px; margin:0 auto; padding:52px 40px 80px; }
    .eyebrow { font-family:var(--mono); font-size:11.5px; font-weight:600; text-transform:uppercase; letter-spacing:.18em; color:var(--green); }
    .page-head { margin-bottom:32px; position:relative; }
    .page-head .eyebrow { margin-bottom:12px; }
    .page-head h1 { font-family:var(--display); font-size:46px; font-weight:600; letter-spacing:-.035em; line-height:1.02; margin:0; color:var(--ink); }
    .page-head .subtitle { font-size:16px; color:var(--ink-soft); margin:12px 0 0; max-width:60ch; }
    .controls { position:absolute; top:2px; right:0; display:flex; gap:6px; align-items:center; }
    .ctl { font-family:var(--mono); font-size:12px; font-weight:600; color:var(--ink-soft); background:var(--card); border:1px solid var(--border);
      border-radius:10px; padding:7px 10px; cursor:pointer; text-decoration:none; line-height:1; display:inline-flex; align-items:center; transition:.15s; }
    .ctl:hover { border-color:var(--green); color:var(--green); }
    .ctl.lang.on, .ctl.lang.on:hover { background:var(--green); border-color:var(--green); color:var(--card); }
    .ctl.theme { font-size:14px; padding:6px 9px; }
    .card { background:linear-gradient(180deg, var(--card) 0%, var(--card-soft) 240%); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); padding:30px 34px; margin-bottom:22px; }
    .block-head { margin-bottom:18px; }
    .block-head h2 { font-family:var(--display); font-size:23px; font-weight:600; letter-spacing:-.02em; margin:0; }
    .block-head .eyebrow { margin-bottom:9px; }
    .block-head .muted { font-size:13.5px; color:var(--ink-soft); margin:4px 0 0; }
    .muted { color:var(--ink-soft); }

    .savings { background:linear-gradient(168deg, var(--card) 0%, color-mix(in srgb, var(--green) 6%, var(--card)) 140%); border-color:color-mix(in srgb, var(--green) 22%, var(--border)); }
    .sv-head { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; flex-wrap:wrap; margin-bottom:18px; }
    .sv-now-label { font-family:var(--mono); font-size:11.5px; font-weight:600; text-transform:uppercase; letter-spacing:.18em; color:var(--green); }
    .sv-now-amt { font-family:var(--display); font-size:58px; font-weight:600; letter-spacing:-.035em; line-height:1; margin-top:8px; font-variant-numeric:tabular-nums; }
    .sv-now-rub { font-family:var(--mono); font-size:18px; font-weight:600; color:var(--ink-soft); letter-spacing:-.01em; margin-top:8px; font-variant-numeric:tabular-nums; }
    .sv-figs { display:flex; gap:12px; }
    .sv-fig { background:var(--card); border:1px solid var(--border); border-radius:var(--radius-sm); padding:14px 18px; min-width:138px; }
    .sv-fig-label { font-family:var(--mono); font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.14em; color:var(--ink-faint); display:block; }
    .sv-fig-amt { font-family:var(--display); font-size:27px; font-weight:600; letter-spacing:-.02em; display:block; margin-top:5px; font-variant-numeric:tabular-nums; }
    .sv-fig-rub { font-family:var(--mono); font-size:12.5px; color:var(--ink-soft); font-style:normal; display:block; margin-top:3px; font-variant-numeric:tabular-nums; }
    .sv-fig-hero { background:linear-gradient(150deg,#15935f 0%,#1fb079 100%); border-color:transparent; color:#fff; box-shadow:0 16px 32px -16px rgba(21,147,95,.7); }
    .sv-fig-hero .sv-fig-label { color:rgba(255,255,255,.85); }
    .sv-fig-hero .sv-fig-amt { color:#fff; }
    .sv-fig-hero .sv-fig-rub { color:rgba(255,255,255,.92); }
    .sv-legend { display:flex; flex-wrap:wrap; gap:7px; align-items:center; margin-bottom:4px; }
    /* ON: chip ringed + tinted in its own colour, solid dot, dark text. OFF: grey,
       hollow dot, struck-through, dimmed — so on/off reads at a glance. */
    .sv-chip { display:inline-flex; align-items:center; gap:7px; font-family:var(--mono); font-size:12px; font-weight:600; color:var(--ink);
      background:color-mix(in srgb, var(--c) 10%, var(--card)); border:1.4px solid color-mix(in srgb, var(--c) 55%, var(--border));
      border-radius:999px; padding:5px 12px; cursor:pointer; transition:.15s; }
    .sv-chip:hover { border-color:var(--c); }
    .sv-chip strong { color:var(--ink); font-weight:700; font-variant-numeric:tabular-nums; }
    .sv-chip .sv-dot { width:9px; height:9px; border-radius:50%; background:var(--c); flex:0 0 auto; }
    .sv-chip.off { background:var(--card); border-color:var(--border); color:var(--ink-faint); opacity:.75; }
    .sv-chip.off strong { color:var(--ink-faint); font-weight:600; }
    .sv-chip.off .sv-dot { background:transparent; box-shadow:inset 0 0 0 1.6px var(--ink-faint); }
    .sv-chip.off .sv-cname { text-decoration:line-through; }
    .sv-yr { fill:var(--ink-faint); font-family:var(--mono); font-size:10.5px; font-weight:600; opacity:.85; }
    .sv-ms { fill:var(--ink-faint); font-family:var(--mono); font-size:10px; font-weight:500; }
    .sv-ms.hero { fill:var(--green); font-size:10.5px; font-weight:700; }
    .sv-llabel { font-family:var(--mono); font-size:10px; font-weight:600; }
    .sv-scrimc { stop-color:var(--card); }
    .sv-chart-wrap { position:relative; margin:14px 0 4px; height:clamp(360px,40vw,500px); touch-action:pan-y; }
    #svChart { display:block; width:100%; height:100%; cursor:grab; }
    #svChart:active { cursor:grabbing; }
    .sv-ax { fill:var(--ink-faint); font-family:var(--mono); font-size:11px; font-weight:500; }
    .sv-tgt { fill:var(--amber); font-family:var(--mono); font-size:10.5px; font-weight:600; }
    .sv-now-mk { fill:var(--ink-faint); font-family:var(--mono); font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.12em; }
    .sv-tip { position:absolute; transform:translate(-50%,-130%); pointer-events:none; background:var(--ink); color:var(--bg); border-radius:10px; padding:7px 11px; font-family:var(--mono); font-size:12px; white-space:nowrap; box-shadow:0 10px 26px -8px rgba(0,0,0,.4); z-index:3; }
    .sv-tip-m { display:block; opacity:.7; font-size:10.5px; }
    .sv-tip-v { display:block; font-weight:700; font-size:14px; font-variant-numeric:tabular-nums; }
    .sv-rate-head { margin-top:24px; font-family:var(--mono); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.16em; color:var(--ink-faint); }
    .sv-controls { margin-top:14px; display:grid; grid-template-columns:1fr 1fr; gap:18px 30px; }
    .sv-slider { min-width:0; }
    .sv-control-row { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:9px; gap:10px; }
    .sv-rate-label { font-family:var(--mono); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.12em; color:var(--ink-soft); }
    .sv-rate { font-family:var(--display); font-size:26px; font-weight:600; letter-spacing:-.02em; color:var(--green); transition:color .1s; white-space:nowrap; font-variant-numeric:tabular-nums; }
    input[type=range] { -webkit-appearance:none; appearance:none; width:100%; height:8px; border-radius:6px;
      background:linear-gradient(90deg,#C0392B 0%,#E07B39 10%,#C7A23E 20%,#6BA877 30%,#2F8F5E 50%,#1FB07A 60%,#10D6A1 100%); outline:none; }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:26px; height:26px; border-radius:50%; background:var(--thumb,var(--green)); border:4px solid var(--card); box-shadow:0 2px 8px rgba(0,0,0,.22); cursor:grab; transition:box-shadow .2s; }
    input[type=range]::-moz-range-thumb { width:26px; height:26px; border-radius:50%; background:var(--thumb,var(--green)); border:4px solid var(--card); box-shadow:0 2px 8px rgba(0,0,0,.22); cursor:grab; }
    input[type=range].hot::-webkit-slider-thumb { box-shadow:0 0 0 5px rgba(16,214,161,.22), 0 0 22px rgba(16,214,161,.75); animation:pulse 1.1s ease-in-out infinite; }
    input[type=range].hot::-moz-range-thumb { box-shadow:0 0 0 5px rgba(16,214,161,.22), 0 0 22px rgba(16,214,161,.75); }
    @keyframes pulse { 0%,100%{box-shadow:0 0 0 5px rgba(16,214,161,.20), 0 0 18px rgba(16,214,161,.6);} 50%{box-shadow:0 0 0 8px rgba(16,214,161,.10), 0 0 30px rgba(16,214,161,.95);} }

    .spend-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; }
    select.month-pick { font-family:var(--mono); font-size:13px; font-weight:600; color:var(--ink); padding:10px 14px; border:1px solid var(--border); border-radius:var(--radius-xs); background:var(--card); cursor:pointer; }
    .month-total { font-family:var(--display); font-size:34px; font-weight:600; letter-spacing:-.025em; margin:8px 0 16px; font-variant-numeric:tabular-nums; }
    .month-total-label { font-family:var(--mono); font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.1em; color:var(--ink-faint); margin-left:12px; }
    .bd-bar { display:flex; width:100%; border-radius:var(--radius-xs); overflow:hidden; border:1px solid var(--border); }
    .bd-split { height:32px; margin-bottom:8px; }
    .bd-tier { height:22px; margin:10px 0 14px; }
    .bd-seg { height:100%; display:flex; align-items:center; padding:0 9px; overflow:hidden; min-width:2px; cursor:default; transition:opacity .12s, filter .12s; }
    .bd-seg.dim { opacity:.3; filter:saturate(.5); }
    .bd-seg.hot { box-shadow:inset 0 0 0 2px rgba(255,255,255,.85); }
    .bd-seg-l { font-family:var(--mono); font-size:10.5px; font-weight:600; color:#fff; white-space:nowrap; text-shadow:0 1px 1px rgba(0,0,0,.2);
      overflow:hidden; -webkit-mask-image:linear-gradient(90deg,#000 72%,transparent); mask-image:linear-gradient(90deg,#000 72%,transparent); }
    .tier { margin-top:28px; padding-left:16px; border-left:3px solid var(--border); }
    .tier-mandatory { border-left-color:var(--green); } .tier-non-mandatory { border-left-color:var(--amber); }
    .tier-head { display:flex; justify-content:space-between; align-items:baseline; }
    .tier-head h3 { font-family:var(--display); font-size:17px; font-weight:600; letter-spacing:-.01em; margin:0; }
    .tier-mandatory .tier-head h3 { color:var(--green); } .tier-non-mandatory .tier-head h3 { color:var(--amber); }
    .tier-total { font-family:var(--mono); font-size:16px; font-weight:600; font-variant-numeric:tabular-nums; }
    .tier-sub { font-size:12.5px; color:var(--ink-soft); margin:3px 0 14px; }
    details.cat { border:1px solid var(--line-soft); border-radius:var(--radius-sm); background:var(--card); margin-bottom:7px; overflow:hidden; transition:opacity .12s, border-color .12s; }
    details.cat:hover { border-color:var(--border); }
    details.cat.rowdim { opacity:.4; }
    details.cat summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:12px; padding:13px 16px; user-select:none; position:relative; }
    .cat-fill { position:absolute; left:0; top:0; bottom:0; z-index:0; background:var(--green-soft); }
    .tier-non-mandatory .cat-fill { background:var(--amber-soft); }
    details.cat summary > *:not(.cat-fill) { position:relative; z-index:1; }
    details.cat summary::-webkit-details-marker { display:none; }
    details.cat summary::before { content:"\\203A"; color:var(--ink-faint); font-size:18px; line-height:1; width:12px; display:inline-block; transition:transform .15s ease; position:relative; z-index:1; }
    details.cat[open] summary::before { transform:rotate(90deg); }
    .cat-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; position:relative; z-index:1; }
    .cat-name { font-size:14.5px; font-weight:600; flex:1; }
    .cat-pct { font-family:var(--mono); font-size:12px; font-weight:600; color:var(--ink-soft); min-width:38px; text-align:right; font-variant-numeric:tabular-nums; }
    .cat-meta { font-family:var(--mono); font-size:11px; color:var(--ink-faint); min-width:56px; text-align:right; }
    .cat-amt { font-family:var(--mono); font-size:14px; font-weight:700; min-width:74px; text-align:right; font-variant-numeric:tabular-nums; }
    .txns { list-style:none; margin:0; padding:2px 16px 10px 40px; background:var(--card); position:relative; z-index:1; }
    .txns li { display:flex; align-items:center; gap:12px; padding:8px 0; border-top:1px solid var(--line-soft); font-size:13.5px; }
    .t-date { font-family:var(--mono); color:var(--ink-faint); font-variant-numeric:tabular-nums; font-size:12px; min-width:82px; white-space:nowrap; }
    .t-merch { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
    .t-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .t-note { font-size:11px; font-weight:500; color:var(--ink-faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .t-acct { font-family:var(--mono); font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--ink-soft); background:var(--card-soft); border:1px solid var(--line-soft); border-radius:999px; padding:2px 9px; white-space:nowrap; }
    .t-amt { font-family:var(--mono); font-weight:700; min-width:66px; text-align:right; font-variant-numeric:tabular-nums; }
    .page-foot { text-align:center; font-family:var(--mono); font-size:11px; font-weight:500; letter-spacing:.04em; color:var(--ink-faint); margin-top:44px; }

    @media (max-width:760px) {
      .page { padding:22px 11px 52px; }
      .card { padding:18px 13px; border-radius:18px; }
      .page-head { margin-top:46px; }
      .page-head h1 { font-size:33px; }
      .page-head .subtitle { font-size:14px; }
      .sv-head { gap:14px; }
      .sv-now-amt { font-size:44px; }
      /* The chart is the centerpiece: break it out of the card padding so it runs
         edge-to-edge, and give it real height. Right-edge labels overlay a soft
         fade (drawn in the SVG) instead of eating a margin that crops the plot. */
      .sv-chart-wrap { height:454px; margin:14px -13px 6px; }
      .sv-figs { width:100%; gap:9px; }
      .sv-fig { flex:1; min-width:0; padding:12px 14px; }
      .sv-fig-amt { font-size:22px; }
      .sv-fig-rub { font-size:11.5px; }
      .sv-control-row { flex-wrap:wrap; }
      .sv-rate-label { font-size:10.5px; }
      .sv-rate { font-size:22px; }
      .sv-controls { grid-template-columns:1fr; gap:14px; }
      .controls .ctl { padding:6px 9px; font-size:11px; }
      .spend-head { flex-direction:column; gap:12px; }
      select.month-pick { width:100%; }
      .month-total { font-size:27px; }
      .bd-split { height:30px; } .bd-tier { height:20px; }
      .cat-meta { display:none; }
      /* Flatten the nested look on phones: drop the tier's left rule and indent,
         drop the card-in-card borders, keep the category colour via the fill. */
      .tier { margin-top:22px; padding-left:0; border-left:none; }
      .tier-head h3 { font-size:16.5px; }
      details.cat { border:none; border-radius:9px; margin-bottom:2px; }
      details.cat summary { padding:13px 10px; gap:9px; }
      .cat-amt { min-width:0; }
      .t-date { min-width:0; font-size:11px; }
      .t-acct { font-size:9.5px; padding:2px 7px; }
      .txns { padding-left:12px; padding-right:2px; }
      .txns li { gap:9px; }
    }`;
}
