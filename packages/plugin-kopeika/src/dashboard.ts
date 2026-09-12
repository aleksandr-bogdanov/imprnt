// @ts-nocheck
/**
 * The dashboard renderer, "Where We Are": the July 2026 magazine redesign
 * (Playfair Display headings, Golos Text body, JetBrains Mono numbers - all with
 * Cyrillic) plus the levers section, recovered on 2026-09-13 from the vault's
 * built kopeika.js of 2026-07-04 (vault commit adb7b89a). That redesign had been
 * made directly in the built file and never reached this source, so the August
 * rebuild silently replaced it with the older Inter/Space Grotesk page while
 * production kept serving the July one. This file is that renderer, verbatim, with
 * the typed public surface (interfaces below) kept for cli.ts. It is checked at
 * the bundle level, not by tsc, until it is typed properly.
 */
import type { MonthSummary, Report, SpendTierGroup } from "./analytics.ts";
import type { SavingsSeriesData, StockComponent } from "./savings.ts";
import type { Bilingual, MerchantInfoEntry } from "./profile.ts";
import { CATEGORIES, categoryLabel, pickableCategories } from "./categories.ts";

/** The levers playbook (data/levers.json): phases of bilingual items shown as "our plan". */
export interface Levers {
  phases: unknown[];
  [k: string]: unknown;
}

export type Lang = "en" | "ru";
/** Module-level language for the current render (set once at renderDashboard). */

export interface DisplayConfig {
  footer?: Bilingual;
  accountLabels?: Record<string, Bilingual>;
  merchantInfo?: MerchantInfoEntry[];
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
  levers?: Levers | null;
}

var LANG = "en";
var DISPLAY = {};
var PALETTE = {
  green: "#1a8355",
  greenBright: "#1fae72",
  amber: "#b06028",
  blue: "#3d7fb2"
};
var HOUSE_CAP_EUR = 2000;
var SLIDER_DEFAULT_EUR = 1500;
var SLIDER_DEFAULT_CASH = 1500;
var SLIDER_DEFAULT_RUB = 20000;
var CATEGORY_COLORS = {
  "Rent & utilities": "#3d7fb2",
  Subscriptions: "#8a63b8",
  Groceries: "#3f9668",
  "Eating out": "#cd6a38",
  "Business lunch": "#b8892e",
  Travel: "#00958a",
  Shopping: "#c55a8b",
  Clothing: "#b874a0",
  Commute: "#54819f",
  Transport: "#54819f",
  Health: "#b5503f",
  Entertainment: "#9a5fae",
  Gaming: "#6a6fbf",
  Music: "#a85570",
  Drogerie: "#45988a",
  Cash: "#8c8672",
  Other: "#98917f",
  Miscellaneous: "#a09681",
  Admin: "#71809b",
  PayPal: "#4b6fa8",
  Home: "#ab6330",
  Household: "#ad8a4a",
  Books: "#9d5b74",
  Sport: "#55a37c",
  Fitness: "#47a875",
  Fees: "#ad4a3e",
  Insurance: "#5c8296",
  Phone: "#3d95a3",
  Kids: "#cd7053",
  Crypto: "#b3953d",
  Beauty: "#c877a3",
  Band: "#8f62a8",
  Uncategorized: "#a39c8b"
};
var CATEGORY_FALLBACK = ["#3d7fb2", "#cd6a38", "#3f9668", "#c55a8b", "#b8892e", "#8a63b8", "#b5503f", "#00958a", "#6a6fbf", "#ab6330"];
function categoryColor(cat) {
  const def = CATEGORIES.find((c) => c.key === cat);
  if (def && def.color) return def.color;
  const hit = CATEGORY_COLORS[cat];
  if (hit)
    return hit;
  let h = 0;
  for (let i = 0;i < cat.length; i++)
    h = h * 31 + cat.charCodeAt(i) >>> 0;
  return CATEGORY_FALLBACK[h % CATEGORY_FALLBACK.length];
}
var STRINGS = {
  title: { en: "Where We Are", ru: "Где мы сейчас" },
  subtitle: {
    en: "What you've put aside, where it's heading, and where the rest goes.",
    ru: "Сколько отложено, куда это движется и на что уходит остальное."
  },
  savedSoFar: { en: "Saved so far", ru: "Накоплено" },
  netWorth: { en: "Net worth", ru: "Чистый капитал" },
  in1y: { en: "In 1 year", ru: "Через год" },
  in5y: { en: "In 5 years", ru: "Через 5 лет" },
  total: { en: "Total", ru: "Всего" },
  tapToggle: { en: "tap to toggle", ru: "нажмите, чтобы скрыть или вернуть" },
  monthly: { en: "Monthly savings", ru: "Откладываем в месяц" },
  eurMonthly: { en: "Euros on cards", ru: "Евро на картах" },
  cashMonthly: { en: "Euros in cash", ru: "Евро наличными" },
  rubMonthly: { en: "In roubles", ru: "В рублях" },
  whereItGoes: { en: "Where it goes", ru: "Куда уходят деньги" },
  spendKicker: { en: "Spending", ru: "Траты" },
  worthKicker: { en: "kopeika", ru: "kopeika" },
  tapCategory: { en: "Tap a category to see the transactions", ru: "Нажмите на категорию, чтобы раскрыть операции" },
  chgBtn: { en: "changes", ru: "изменения" },
  chgCopy: { en: "copy", ru: "скопировать" },
  chgClear: { en: "clear", ru: "очистить" },
  colDate: { en: "date", ru: "дата" },
  colMerchant: { en: "merchant", ru: "получатель" },
  colAmount: { en: "EUR", ru: "EUR" },
  colCategory: { en: "category", ru: "категория" },
  colMandatory: { en: "mandatory", ru: "обязательно" },
  colNote: { en: "note", ru: "заметка" },
  mandatory: { en: "Mandatory", ru: "Обязательные" },
  nonMandatory: { en: "Optional", ru: "Свободные" },
  mandatorySub: { en: "Housing, groceries, transport, work tools - owed no matter what", ru: "Жильё, продукты, транспорт, рабочие подписки — платим всегда" },
  flexSub: { en: "Everything else — the part you can flex", ru: "Всё остальное — здесь можно ужаться" },
  spent: { en: "spent", ru: "потрачено" },
  none: { en: "No spend recorded — nice and quiet.", ru: "Трат не было — тихий период." },
  now: { en: "now", ru: "сейчас" },
  safe: { en: "safe", ru: "запас" },
  projected: { en: "projected", ru: "прогноз" },
  house: { en: "House · 10M ₽", ru: "Квартира · 10 млн ₽" },
  soFar: { en: "so far", ru: "пока" },
  updated: { en: "Updated", ru: "Обновлено" },
  theme: { en: "Theme", ru: "Тема" },
  leversKicker: { en: "Playbook", ru: "Стратегия" },
  leversTitle: { en: "The levers", ru: "Наш план" },
  leversSub: {
    en: "Tap a row for details.",
    ru: "Нажмите на строку, чтобы раскрыть подробности."
  }
};
function t(key) {
  return STRINGS[key]?.[LANG] ?? STRINGS[key]?.en ?? String(key);
}
export var CATEGORY_RU = {
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
  Admin: "Бюрократия",
  Uncategorized: "Без категории",
  "Bank fees": "Комиссии банка"
};
function catName(cat) {
  return categoryLabel(cat, LANG);
}
function accountLabel(account) {
  return DISPLAY.accountLabels?.[account]?.[LANG] ?? account;
}
function merchantInfo(raw) {
  const r = raw.toLowerCase();
  for (const m of DISPLAY.merchantInfo ?? []) {
    if (r.includes(m.pat.toLowerCase())) {
      const note = (LANG === "ru" ? m.ru ?? m.en : m.en) ?? "";
      return { name: m.name ?? raw, note };
    }
  }
  return { name: raw, note: "" };
}
function txDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : iso;
}
var MONTHS_LONG = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  ru: ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"]
};
var MONTHS_SHORT = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  ru: ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]
};
function itemsWord(n) {
  if (LANG === "en")
    return n === 1 ? "item" : "items";
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11)
    return "операция";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
    return "операции";
  return "операций";
}
function esc(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function sep() {
  return LANG === "ru" ? "\u00A0" : ",";
}
function money(amount, symbol) {
  const r = Math.round(amount);
  const sign = r < 0 ? "-" : "";
  const abs = Math.abs(r);
  const digits = abs >= (LANG === "ru" ? 1e4 : 1000) ? String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, sep()) : String(abs);
  return `${sign}${symbol} ${digits}`;
}
function eur(amount) {
  return money(amount, "€");
}
function rub(amount) {
  return money(amount, "₽");
}
function splitMonth(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m)
    return null;
  return { year: Number(m[1]), monthIndex: Number(m[2]) - 1 };
}
function prettyMonth(month) {
  const parts = splitMonth(month);
  if (parts === null)
    return month;
  const name = MONTHS_LONG[LANG][parts.monthIndex];
  if (name === undefined)
    return month;
  const cap = LANG === "ru" ? name.charAt(0).toUpperCase() + name.slice(1) : name;
  return `${cap} ${parts.year}`;
}
function periodLabel(period) {
  if (/^\d{4}$/.test(period))
    return `${period} ${t("soFar")}`;
  return prettyMonth(period);
}
function monthsBetween(from, to) {
  const a = splitMonth(from);
  const b = splitMonth(to);
  if (a === null || b === null)
    return 0;
  return (b.year - a.year) * 12 + (b.monthIndex - a.monthIndex);
}
function seriesMeta(key, fallbackLabel) {
  const k = key.toLowerCase();
  const ru = LANG === "ru";
  if (k === "total")
    return { label: t("total"), short: t("total"), color: PALETTE.green, cap: null, cur: null };
  if (k === "trading212")
    return { label: ru ? "Евро" : "Euros", short: ru ? "Евро" : "Euros", color: PALETTE.blue, cap: null, cur: "eur" };
  if (k === "house")
    return { label: ru ? "N26 (квартира)" : "N26 (house)", short: "N26", color: PALETTE.amber, cap: HOUSE_CAP_EUR, cur: "eur" };
  if (k === "alfa-deposit")
    return { label: "RUB", short: "RUB", color: "#8a63b8", cap: null, cur: "rub", off: true };
  if (k === "cash")
    return { label: ru ? "Наличные" : "Cash", short: ru ? "Нал" : "Cash", color: "#5a8f3c", cap: null, cur: "cash" };
  if (k === "property")
    return { label: ru ? "Недвижимость" : "Real estate", short: ru ? "Недвижимость" : "Real estate", color: "#9B6A43", cap: null, cur: null };
  if (k === "bcs")
    return { label: "CNY", short: "CNY", color: "#b07a63", cap: null, cur: null, off: true };
  return { label: fallbackLabel, short: fallbackLabel, color: "#7A776F", cap: null, cur: "rub" };
}
function savingsSection(p, series, nowMonth) {
  const start = Math.round(p.startEur);
  const showRub = p.rubPerEur !== null;
  const rubAt = showRub ? p.rubPerEur : 0;
  const maxEur = 5000;
  const maxRub = 1e5;
  const initEur = Math.min(SLIDER_DEFAULT_EUR, maxEur);
  const initCash = Math.min(SLIDER_DEFAULT_CASH, maxEur);
  const initRub = Math.min(SLIDER_DEFAULT_RUB, maxRub);
  const firstMonth = series.months.length > 0 ? series.months[0] : nowMonth;
  const firstParts = splitMonth(firstMonth) ?? { year: 2020, monthIndex: 0 };
  const nowIndex = Math.max(0, monthsBetween(firstMonth, nowMonth));
  const idxOf = (m) => monthsBetween(firstMonth, m);
  const histOf = (vals) => series.months.map((m, i) => [idxOf(m), Math.round(vals[i])]);
  const nw = p.netWorth;
  const nwBase = nw ? nw.propertyEur + nw.bcsEur : 0;
  const netWorthStart = start + Math.round(nwBase);
  const chartSeries = [
    { key: "total", ...seriesMeta("total", "Total"), start: netWorthStart, hist: histOf(series.total.map((v) => v + nwBase)) }
  ];
  for (const line of series.lines) {
    if (line.key === "house")
      continue;
    const meta = seriesMeta(line.key, line.label);
    chartSeries.push({ key: line.key, label: meta.label, short: meta.short, color: meta.color, cap: meta.cap, cur: meta.cur, start: Math.round(line.values[line.values.length - 1] ?? 0), hist: histOf(line.values), off: meta.off === true });
  }
  if (nw) {
    const flat = (v) => series.months.map((m) => [idxOf(m), Math.round(v)]);
    const pMeta = seriesMeta("property", "Property");
    const bMeta = seriesMeta("bcs", "BCS");
    chartSeries.push({ key: "bcs", label: bMeta.label, short: bMeta.short, color: bMeta.color, cap: null, cur: null, start: Math.round(nw.bcsEur), hist: flat(nw.bcsEur), nw: true, off: true });
    chartSeries.push({ key: "property", label: pMeta.label, short: pMeta.short, color: pMeta.color, cap: null, cur: null, start: Math.round(nw.propertyEur), hist: flat(nw.propertyEur), nw: true, base: Math.round(nw.propertyBaseEur), debt: Math.round(nw.propertyDebtEur), apr: nw.propertyApr, off: true });
  }
  const houseSeries = chartSeries.find((s) => s.cap !== null);
  const houseStart = houseSeries?.start ?? 0;
  const houseCap = houseSeries?.cap ?? HOUSE_CAP_EUR;
  const chips = chartSeries.map((s) => `<button type="button" class="sv-chip ${s.key === "total" ? "sv-chip-tot" : "sv-chip-sec"}${s.off ? " off" : ""}" data-key="${esc(s.key)}" style="--c:${s.color}">` + `<span class="sv-dot"></span><span class="sv-cname">${esc(s.label)}</span> <strong>${esc(eur(s.start))}</strong></button>`).join("");
  const eurPerRub = showRub && rubAt > 0 ? 1 / rubAt : 0.0105;
  const initEff = initEur + initCash + initRub * eurPerRub;
  // The headline "now" starts from the VISIBLE lines only: every chip that is off by
  // default (real estate, RUB, CNY) is subtracted, the same sum the chart's JS keeps live.
  const initVisStart = chartSeries.filter((s) => s.key !== "total" && !s.off).reduce((sum, s) => sum + s.start, 0);
  const projEur = (mo) => initVisStart + initEff * mo;
  const milestones = [
    { eur: 50000, label: "\u20AC\u00A050k", hero: false },
    { eur: 100000, label: "\u20AC\u00A0100k", hero: true }
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
    gmin: LANG === "ru" ? 1e4 : 1000,
    mShort: MONTHS_SHORT[LANG],
    sNow: t("now"),
    sSafe: t("safe"),
    sProj: t("projected")
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
            <span class="sv-rate-label">${esc(t("cashMonthly"))}</span>
            <span class="sv-rate"><span id="svRateCashLabel">${esc(eur(initCash))}</span>/${LANG === "ru" ? "мес" : "mo"}</span>
          </div>
          <input type="range" id="svRateCash" min="0" max="${maxEur}" step="25" value="${initCash}" aria-label="${esc(t("cashMonthly"))}" />
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
function savingsScript(dataJson) {
  return `(function(){
var D=JSON.parse(${JSON.stringify(dataJson)});
var SH=D.mShort;
var svg=document.getElementById('svChart'),tip=document.getElementById('svTip');
var eurS=document.getElementById('svRateEur'),cashS=document.getElementById('svRateCash'),rubS=document.getElementById('svRateRub');
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
var pts=[], dMin=0, dMax=1;
var vS=D.nowI-12, vE=D.nowI+12;
function fmt(n){var s=Math.round(n),sg=s<0?'-':'';s=Math.abs(s);var d=s.toString();if(s>=(D.gmin||1000))d=d.replace(/\\B(?=(\\d{3})+(?!\\d))/g,D.sep);return sg+d;}
function setText(id,t){var e=document.getElementById(id);if(e)e.textContent=t;}
function lbl(i){var t=D.fy*12+D.fm+Math.round(i);return SH[((t%12)+12)%12]+" '"+String(Math.floor(t/12)).slice(2);}
function xAt(i){return PL+pw*(i-vS)/((vE-vS)||1);}
function yAt(v){return PT+ph*(1-(v-dMin)/((dMax-dMin)||1));}
function projVal(s,k,rE,rEff){ if(s.nw)return (s.base!=null?s.base:s.start)*Math.pow(1+(s.apr||0),k/12)-(s.debt||0);
  if(s.cur==='rub')return s.start+((rEff-rE-rC)/RUBN)*k;
  if(s.cur==='cash')return s.start+rC*k;
  if(s.cur==='eur')return s.start+rE*k;
  return s.start; }
var rC=0;
function clampV(){ var sp=vE-vS; sp=Math.max(4,Math.min(D.nowI+126,sp));
  if(vS<-4){vE=-4+sp;vS=-4;} if(vE>D.nowI+120){vS=D.nowI+120-sp;vE=D.nowI+120;} }
function hx(c){return [parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)];}
function mix(a,b,t){var x=hx(a),y=hx(b);return 'rgb('+Math.round(x[0]+(y[0]-x[0])*t)+','+Math.round(x[1]+(y[1]-x[1])*t)+','+Math.round(x[2]+(y[2]-x[2])*t)+')';}
function valColor(r){var S=[[0,'#a89f8d'],[500,'#8fac8b'],[1000,'#6cab84'],[1500,'#4aa778'],[2500,'#2f9e6c'],[3000,'#1fae72'],[5000,'#0fbf7f']];
  for(var i=1;i<S.length;i++){if(r<=S[i][0]){var t=(r-S[i-1][0])/((S[i][0]-S[i-1][0])||1);return mix(S[i-1][1],S[i][1],t);}}return S[S.length-1][1];}
function line(a,color,dash,w,op){ if(a.length<1)return '';
  var p=a.map(function(d){return xAt(d[0]).toFixed(1)+','+yAt(d[1]).toFixed(1);}).join(' ');
  return '<polyline points="'+p+'" fill="none" stroke="'+color+'" stroke-width="'+(w||2.6)+'" stroke-linejoin="round" stroke-linecap="round" stroke-opacity="'+(op==null?1:op)+'"'+(dash?' stroke-dasharray="'+dash+'"':'')+'/>'; }
function draw(){
  var rE=Number(eurS.value), rR=Number(rubS.value); rC=Number(cashS.value); var rEff=rE+rC+rR*D.eurPerRub;
  var colE=valColor(rE), colC=valColor(rC), colR=valColor(rR*(5000/(D.maxRub||100000)));
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
  setText('svRateEurLabel','€ '+fmt(rE)); setText('svRateCashLabel','€ '+fmt(rC)); setText('svRateRubLabel','₽ '+fmt(rR));
  var rle=document.getElementById('svRateEurLabel'); if(rle)rle.style.color=colE;
  var rlc=document.getElementById('svRateCashLabel'); if(rlc)rlc.style.color=colC;
  cashS.style.setProperty('--thumb',colC); cashS.classList.toggle('hot', rC>=3000);
  var rlr=document.getElementById('svRateRubLabel'); if(rlr)rlr.style.color=colR;
  eurS.style.setProperty('--thumb',colE); eurS.classList.toggle('hot', rE>=3000);
  rubS.style.setProperty('--thumb',colR); rubS.classList.toggle('hot', rR>=60000);
  setText('svNowEur','€ '+fmt(totProj(0))); if(D.rub)setText('svNowRub','₽ '+fmt(totProj(0)*D.rub));
  setText('svY1eur','€ '+fmt(totProj(12))); setText('svY5eur','€ '+fmt(totProj(60)));
  if(D.rub){setText('svY1rub','₽ '+fmt(totProj(12)*D.rub)); setText('svY5rub','₽ '+fmt(totProj(60)*D.rub));}
  var tc=document.querySelector('.sv-chip[data-key="total"] strong'); if(tc)tc.textContent='€ '+fmt(totProj(0));
}
function showTip(cx,cy){ if(!pts.length)return;
  var rc=svg.getBoundingClientRect(), vx=(cx-rc.left)/rc.width*W, vy=(cy-rc.top)/rc.height*H;
  var best=null,bd=1e9; pts.forEach(function(p){var d=(p.x-vx)*(p.x-vx)+(p.y-vy)*(p.y-vy)*0.3; if(d<bd){bd=d;best=p;}});
  if(!best)return;
  var dot=document.getElementById('svDot');
  if(dot){dot.setAttribute('cx',best.x.toFixed(1));dot.setAttribute('cy',best.y.toFixed(1));dot.setAttribute('stroke',best.c);dot.style.display='';}
  tip.innerHTML='<span class="sv-tip-m">'+best.s+' · '+lbl(best.i)+(best.f?' · '+D.sProj:'')+'</span><span class="sv-tip-v" style="color:'+best.c+'">€'+fmt(best.v)+(D.rub?'  ·  ₽ '+fmt(best.v*D.rub):'')+'</span>';
  tip.style.left=(best.x/W*rc.width)+'px'; tip.style.top=(best.y/H*rc.height)+'px'; tip.hidden=false;
}
function hideTip(){tip.hidden=true; var d=document.getElementById('svDot'); if(d)d.style.display='none';}
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
cashS.addEventListener('input',draw);
rubS.addEventListener('input',draw);
var raf=0;
function relayout(){ if(raf)cancelAnimationFrame(raf); raf=requestAnimationFrame(function(){layout();draw();}); }
if(window.ResizeObserver){ new ResizeObserver(relayout).observe(svg); } else { window.addEventListener('resize',relayout); }
layout(); draw();
})();`;
}
function splitBar(groups, total) {
  if (total <= 0)
    return "";
  const mand = groups.find((g) => g.tier === "mandatory")?.total ?? 0;
  const flex = groups.find((g) => g.tier === "non-mandatory")?.total ?? 0;
  const seg = (amount, color, name) => {
    if (amount <= 0)
      return "";
    const pct = amount / total * 100;
    return `<div class="bd-seg" style="width:${pct.toFixed(2)}%;background:${color}" title="${esc(name)} ${esc(eur(amount))} (${Math.round(pct)}%)"><span class="bd-seg-l bd-full">${esc(name)} ${Math.round(pct)}%</span><span class="bd-seg-l bd-min">${Math.round(pct)}%</span></div>`;
  };
  return `<div class="bd-bar bd-split">${seg(mand, PALETTE.green, t("mandatory"))}${seg(flex, PALETTE.amber, t("nonMandatory"))}</div>`;
}
function tierBar(g) {
  if (g.total <= 0 || g.categories.length === 0)
    return "";
  const bars = g.categories.map((c) => {
    const pct = c.total / g.total * 100;
    const color = categoryColor(c.category);
    const label = pct >= 4.5 ? `<span class="bd-seg-l">${esc(catName(c.category))} ${Math.round(pct)}%</span>` : "";
    return `<div class="bd-seg" data-cat="${esc(c.category)}" style="width:${pct.toFixed(2)}%;background:${color}" title="${esc(catName(c.category))} ${esc(eur(c.total))}">${label}</div>`;
  }).join("");
  return `<div class="bd-bar bd-tier">${bars}</div>`;
}
function categoryDetails(c, monthTotal, tierMax, monthKey) {
  const pct = monthTotal > 0 ? Math.round(c.total / monthTotal * 100) : 0;
  const widthPct = tierMax > 0 ? c.total / tierMax * 100 : 0;
  const rows = c.txns.map((tx) => (() => {
    const mi = merchantInfo(tx.merchant);
    return `<li><span class="t-date">${esc(txDate(tx.date))}</span><span class="t-merch"><span class="t-name">${esc(mi.name)}</span>${mi.note ? `<span class="t-note">${esc(mi.note)}</span>` : ""}</span><span class="t-acct">${esc(accountLabel(tx.account))}</span><span class="t-amt">${esc(eur(tx.eur))}</span></li>`;
  })()).join("");
  return `
          <details class="cat" data-cat="${esc(c.category)}">
            <summary>
              <span class="cat-fill" style="width:${widthPct.toFixed(1)}%;background:${categoryColor(c.category)}2E"></span>
              <span class="cat-dot" style="background:${categoryColor(c.category)}"></span>
              <span class="cat-name">${esc(catName(c.category))} <a class="cat-rows" href="/rows?month=${esc(encodeURIComponent(monthKey))}&category=${esc(encodeURIComponent(c.category))}" onclick="event.stopPropagation()" title="${LANG === "ru" ? "все строки" : "all rows"}">&#8599;</a></span>
              <span class="cat-pct">${pct}%</span>
              <span class="cat-meta">${c.count} ${esc(itemsWord(c.count))}</span>
              <span class="cat-amt">${esc(eur(c.total))}</span>
            </summary>
            <ul class="txns">${rows}</ul>
          </details>`;
}
function tierBlock(g, monthTotal, monthMax, monthKey) {
  if (g.categories.length === 0)
    return "";
  const label = g.tier === "mandatory" ? t("mandatory") : t("nonMandatory");
  const sub = g.tier === "mandatory" ? t("mandatorySub") : t("flexSub");
  const fillMax = monthMax > 0 ? monthMax : g.categories.reduce((mx, c) => Math.max(mx, c.total), 0);
  const cats = g.categories.map((c) => categoryDetails(c, monthTotal, fillMax, monthKey)).join("");
  return `
      <div class="tier tier-${g.tier}">
        <div class="tier-head"><h3>${esc(label)}</h3><span class="tier-total">${esc(eur(g.total))}</span></div>
        <p class="tier-sub">${esc(sub)}</p>
        ${cats}
      </div>`;
}
function monthBlock(m, selected) {
  const total = m.groups.reduce((s, g) => s + g.total, 0);
  const monthMax = m.groups.reduce((mx, g) => g.categories.reduce((mx2, c) => Math.max(mx2, c.total), mx), 0);
  const blocks = m.groups.map((g) => tierBlock(g, total, monthMax, m.month)).join("");
  return `
      <div class="month-block" data-month="${esc(m.month)}"${selected ? "" : " hidden"}>
        <div class="month-total">${esc(eur(total))}<span class="month-total-label">${esc(periodLabel(m.month))} · ${esc(t("spent"))}</span></div>
        ${splitBar(m.groups, total)}
        ${blocks || `<p class="muted">${esc(t("none"))}</p>`}
      </div>`;
}
function spendSection(months, selected) {
  const ordered = [...months].sort((a, b) => {
    const ay = /^\d{4}$/.test(a.month) ? 1 : 0;
    const by = /^\d{4}$/.test(b.month) ? 1 : 0;
    if (ay !== by)
      return ay - by;
    return a.month < b.month ? 1 : -1;
  });
  const options = ordered.map((m) => `<option value="${esc(m.month)}"${m.month === selected ? " selected" : ""}>${esc(periodLabel(m.month))}</option>`).join("");
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
function isoDay(today) {
  const y = today.getUTCFullYear();
  const m = String(today.getUTCMonth() + 1).padStart(2, "0");
  const d = String(today.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
var RU_MONTH_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function humanDay(today) {
  const d = today.getUTCDate();
  const mi = today.getUTCMonth();
  const y = today.getUTCFullYear();
  if (LANG === "ru")
    return `${d} ${RU_MONTH_GEN[mi]} ${y}`;
  return `${MONTHS_LONG.en[mi]} ${d}, ${y}`;
}
function controls() {
  const other = LANG === "ru" ? "en" : "ru";
  return `
      <div class="controls">
        <a class="ctl lang ${LANG === "en" ? "on" : ""}" href="/?lang=en">EN</a>
        <a class="ctl lang ${LANG === "ru" ? "on" : ""}" href="/?lang=ru" data-other="${other}">RU</a>
        <button type="button" class="ctl theme" id="themeBtn" aria-label="${esc(t("theme"))}"><span class="theme-ic">\uD83C\uDF19</span></button>
      </div>`;
}
function lvText(field) {
  if (!field)
    return "";
  return field[LANG] ?? field.en ?? "";
}
function leverStatusMeta(status) {
  const ru = LANG === "ru";
  switch (status) {
    case "done":
      return { label: ru ? "готово" : "done", cls: "done" };
    case "active":
      return { label: ru ? "в работе" : "in progress", cls: "active" };
    case "next":
      return { label: ru ? "на очереди" : "up next", cls: "next" };
    case "rule":
      return { label: ru ? "правило" : "standing", cls: "rule" };
    default:
      return { label: ru ? "ждёт" : "waiting", cls: "wait" };
  }
}
function leversSection(cfg) {
  const phases = (cfg.phases ?? []).map((ph) => {
    const inline = (p) => esc(p).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    const paras = (txt, cls) => {
      if (!txt)
        return "";
      const out = [];
      let list = null;
      const flush = () => {
        if (list) {
          out.push(`<${list.tag} class="${cls} lv-list">${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
          list = null;
        }
      };
      for (const line of txt.split(/\n+/)) {
        const m = /^(?:[-•]\s+|(\d+)[.)]\s+)(.*)$/.exec(line.trim());
        if (m) {
          const tag = m[1] ? "ol" : "ul";
          if (!list || list.tag !== tag) {
            flush();
            list = { tag, items: [] };
          }
          list.items.push(inline(m[2]));
        } else {
          flush();
          out.push(`<p class="${cls}">${inline(line)}</p>`);
        }
      }
      flush();
      return out.join("");
    };
    const rows = (ph.levers ?? []).map((l) => {
      const st = l.status ? leverStatusMeta(l.status) : null;
      const value = lvText(l.value);
      const action = lvText(l.action);
      const note = lvText(l.note);
      const body = paras(action, "lv-act") + paras(note, "lv-note");
      const chip = st ? `<span class="lv-st lv-${st.cls}"><span class="lv-st-dot"></span>${esc(st.label)}</span>` : "";
      return `<details class="lever">
          <summary>${chip}<span class="lv-title">${esc(lvText(l.title))}</span>${value ? `<span class="lv-val">${esc(value)}</span>` : ""}</summary>
          <div class="lv-body">${body}</div>
        </details>`;
    }).join("");
    const on = (ph.levers ?? []).some((l) => l.status === "active");
    const when = lvText(ph.when);
    const sub = lvText(ph.sub);
    const title = lvText(ph.title);
    const head = title ? `<div class="lv-phase-head"><h3>${esc(title)}</h3>${when ? `<span class="lv-when">${esc(when)}</span>` : ""}</div>` : "";
    return `<div class="lv-phase${on ? " on" : ""}${title ? "" : " lv-phase-bare"}">
        ${head}
        ${sub ? `<p class="lv-phase-sub">${esc(sub)}</p>` : ""}
        ${rows}
      </div>`;
  }).join("");
  return `
    <section class="card levers" aria-label="${esc(t("leversTitle"))}">
      <header class="block-head">
        <div class="eyebrow">${esc(t("leversKicker"))}</div>
        <h2>${esc(t("leversTitle"))}</h2>
        <p class="muted">${esc(t("leversSub"))}</p>
      </header>
      ${phases}
    </section>`;
}
export function renderDashboard(input) {
  LANG = input.lang ?? "en";
  DISPLAY = input.display ?? {};
  const { report, focusMonth, today, nowMonth, projection, series, months, selectedMonth } = input;
  const focus = report.months.find((m) => m.month === focusMonth);
  if (focus === undefined) {
    throw new Error(`renderDashboard: focus month "${focusMonth}" not found in report (have: ${report.months.map((m) => m.month).join(", ") || "none"})`);
  }
  const savingsBlock = projection && series && series.months.length >= 2 ? savingsSection(projection, series, nowMonth) : "";
  const leversBlock = input.levers && Array.isArray(input.levers.phases) && input.levers.phases.length > 0 ? leversSection(input.levers) : "";
  const spendBlock = months && months.length > 0 ? spendSection(months, selectedMonth ?? focusMonth) : "";
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
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;0,700;0,800;1,600;1,700&family=Golos+Text:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
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
${leversBlock}
${spendBlock}
    <footer class="page-foot">
      ${esc(t("updated"))} ${esc(humanDay(today))} · kopeika${DISPLAY.footer ? ` · ${esc(DISPLAY.footer[LANG])}` : ""}
    </footer>
  </main>
  <script>${themeToggle}</script>
</body>
</html>
`;
}
function buildCss() {
  return `    :root {
      --bg:#f5efe2; --card:#fffdf6; --card-soft:#f3ecdb;
      --ink:#26221a; --ink-soft:#615c4e; --ink-faint:#8f8875;
      --green:#186a45; --green-bright:#1ea36a; --green-soft:#e5efe3;
      --amber:#b06028; --amber-soft:#f5e7d2; --blue:#3d7fb2; --border:#e6dcc4; --line-soft:#eee6d1;
      --dot:rgba(38,34,26,.05);
      --wash-a:rgba(30,163,106,.11); --wash-b:rgba(205,106,56,.09);
      --serif:"Playfair Display",Georgia,"Times New Roman",serif;
      --sans:"Golos Text",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
      --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
      --radius:26px; --radius-sm:15px; --radius-xs:11px;
      --shadow:0 1px 2px rgba(76,62,34,.05), 0 24px 56px -30px rgba(76,62,34,.28);
    }
    [data-theme="dark"] {
      --bg:#11130e; --card:#191c15; --card-soft:#232720;
      --ink:#ede9dc; --ink-soft:#a9ac9e; --ink-faint:#878c7b;
      --green:#63d197; --green-bright:#82e8ad; --green-soft:rgba(99,209,151,.13);
      --amber:#e3a35c; --amber-soft:rgba(227,163,92,.14); --blue:#6fa9d3; --border:#2c3026; --line-soft:#242820;
      --dot:rgba(255,255,255,.03);
      --wash-a:rgba(99,209,151,.07); --wash-b:rgba(227,163,92,.05);
      --shadow:0 1px 2px rgba(0,0,0,.4), 0 26px 52px -28px rgba(0,0,0,.62);
    }
    * { box-sizing:border-box; }
    html,body { margin:0; padding:0; }
    body { background-color:var(--bg);
      background-image:
        radial-gradient(1100px 480px at 12% -6%, var(--wash-a), transparent 62%),
        radial-gradient(900px 430px at 88% -5%, var(--wash-b), transparent 60%),
        radial-gradient(circle at 1px 1px, var(--dot) 1px, transparent 0);
      background-size:auto, auto, 26px 26px;
      color:var(--ink); line-height:1.6;
      font-family:var(--sans); -webkit-font-smoothing:antialiased; transition:background-color .2s,color .2s; }
    ::selection { background:color-mix(in srgb, var(--green-bright) 28%, transparent); }
    .page { max-width:1080px; margin:0 auto; padding:56px 40px 88px; }
    .eyebrow { font-family:var(--sans); font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.15em; color:var(--green-bright); }
    .page-head { margin-bottom:36px; position:relative; }
    .page-head .eyebrow { margin-bottom:14px; }
    .page-head h1 { font-family:var(--serif); font-size:clamp(42px,5.4vw,58px); font-weight:700; letter-spacing:-.01em; line-height:1.05; margin:0; color:var(--ink); }
    .page-head .subtitle { font-size:17px; color:var(--ink-soft); margin:14px 0 0; max-width:56ch; }
    .controls { position:absolute; top:2px; right:0; display:flex; gap:6px; align-items:center; }
    .ctl { font-family:var(--sans); font-size:12px; font-weight:700; letter-spacing:.04em; color:var(--ink-soft); background:var(--card); border:1px solid var(--border);
      border-radius:999px; padding:8px 12px; cursor:pointer; text-decoration:none; line-height:1; display:inline-flex; align-items:center; transition:.15s; }
    .ctl:hover { border-color:var(--green-bright); color:var(--green); }
    .ctl.lang.on, .ctl.lang.on:hover { background:var(--green); border-color:var(--green); color:var(--card); }
    [data-theme="dark"] .ctl.lang.on, [data-theme="dark"] .ctl.lang.on:hover { color:#10130e; }
    .ctl.theme { font-size:14px; padding:7px 10px; }
    .card { background:linear-gradient(180deg, var(--card) 0%, var(--card-soft) 260%); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); padding:36px 40px; margin-bottom:26px; }
    .block-head { margin-bottom:22px; }
    .block-head h2 { font-family:var(--serif); font-size:30px; font-weight:700; letter-spacing:-.005em; margin:0; line-height:1.15; }
    .block-head .eyebrow { margin-bottom:10px; }
    .block-head .muted { font-size:14px; color:var(--ink-soft); margin:6px 0 0; }
    .muted { color:var(--ink-soft); }

    .savings { background:linear-gradient(168deg, var(--card) 0%, color-mix(in srgb, var(--green-bright) 7%, var(--card)) 150%); border-color:color-mix(in srgb, var(--green-bright) 22%, var(--border)); }
    .sv-head { display:flex; justify-content:space-between; align-items:flex-start; gap:24px; flex-wrap:wrap; margin-bottom:20px; }
    .sv-now-label { font-family:var(--sans); font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.15em; color:var(--green-bright); }
    .sv-now-amt { font-family:var(--serif); font-size:clamp(52px,6.4vw,68px); font-weight:800; letter-spacing:0; line-height:1; margin-top:10px; }
    .sv-now-rub { font-family:var(--sans); font-size:17px; font-weight:500; color:var(--ink-soft); margin-top:9px; font-variant-numeric:tabular-nums; }
    .sv-figs { display:flex; gap:12px; }
    .sv-fig { background:var(--card); border:1px solid var(--border); border-radius:18px; padding:16px 20px; min-width:152px; }
    .sv-fig-label { font-family:var(--sans); font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.12em; color:var(--ink-faint); display:block; }
    .sv-fig-amt { font-family:var(--serif); font-size:28px; font-weight:700; display:block; margin-top:6px; }
    .sv-fig-rub { font-family:var(--sans); font-size:12.5px; color:var(--ink-soft); font-style:normal; display:block; margin-top:4px; font-variant-numeric:tabular-nums; }
    .sv-fig-hero { background:linear-gradient(150deg,#17754c 0%,#22b077 100%); border-color:transparent; color:#fff; box-shadow:0 16px 34px -16px rgba(23,117,76,.65); }
    .sv-fig-hero .sv-fig-label { color:rgba(255,255,255,.85); }
    .sv-fig-hero .sv-fig-amt { color:#fff; }
    .sv-fig-hero .sv-fig-rub { color:rgba(255,255,255,.92); }
    .sv-legend { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:6px; }
    /* ON: chip ringed + tinted in its own colour, solid dot, dark text. OFF: grey,
       hollow dot, struck-through, dimmed - so on/off reads at a glance. */
    .sv-chip { display:inline-flex; align-items:center; gap:8px; font-family:var(--sans); font-size:13px; font-weight:600; color:var(--ink);
      background:color-mix(in srgb, var(--c) 9%, var(--card)); border:1.4px solid color-mix(in srgb, var(--c) 50%, var(--border));
      border-radius:999px; padding:6px 14px 6px 11px; cursor:pointer; transition:.15s; }
    .sv-chip:hover { border-color:var(--c); box-shadow:0 3px 10px -4px color-mix(in srgb, var(--c) 55%, transparent); }
    .sv-chip strong { color:var(--ink); font-weight:700; font-variant-numeric:tabular-nums; }
    .sv-chip .sv-dot { width:9px; height:9px; border-radius:50%; background:var(--c); flex:0 0 auto; }
    .sv-chip.off { background:var(--card); border-color:var(--border); color:var(--ink-faint); opacity:.72; box-shadow:none; }
    .sv-chip.off strong { color:var(--ink-faint); font-weight:600; }
    .sv-chip.off .sv-dot { background:transparent; box-shadow:inset 0 0 0 1.6px var(--ink-faint); }
    .sv-chip.off .sv-cname { text-decoration:line-through; }
    .sv-yr { fill:var(--ink-faint); font-family:var(--sans); font-size:11px; font-weight:600; opacity:.8; }
    .sv-ms { fill:var(--ink-faint); font-family:var(--sans); font-size:10.5px; font-weight:600; }
    .sv-ms.hero { fill:var(--green-bright); font-size:11px; font-weight:700; }
    .sv-llabel { font-family:var(--sans); font-size:10.5px; font-weight:700; }
    .sv-scrimc { stop-color:var(--card); }
    .sv-chart-wrap { position:relative; margin:16px 0 4px; height:clamp(360px,40vw,500px); touch-action:pan-y; }
    #svChart { display:block; width:100%; height:100%; cursor:grab; }
    #svChart:active { cursor:grabbing; }
    .sv-ax { fill:var(--ink-faint); font-family:var(--sans); font-size:11.5px; font-weight:500; }
    .sv-tgt { fill:var(--amber); font-family:var(--sans); font-size:11px; font-weight:600; }
    .sv-now-mk { fill:var(--ink-faint); font-family:var(--sans); font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.12em; }
    .sv-tip { position:absolute; transform:translate(-50%,-130%); pointer-events:none; background:var(--ink); color:var(--bg); border-radius:12px; padding:8px 12px; font-family:var(--sans); font-size:12.5px; white-space:nowrap; box-shadow:0 10px 26px -8px rgba(0,0,0,.4); z-index:3; }
    .sv-tip-m { display:block; opacity:.72; font-size:11px; }
    .sv-tip-v { display:block; font-weight:700; font-size:14.5px; font-variant-numeric:tabular-nums; }
    .sv-rate-head { margin-top:26px; font-family:var(--sans); font-size:11.5px; font-weight:700; text-transform:uppercase; letter-spacing:.14em; color:var(--ink-faint); }
    .sv-controls { margin-top:14px; display:grid; grid-template-columns:1fr 1fr 1fr; gap:18px 28px; }
    .sv-slider { min-width:0; }
    .spend-ctl { display:flex; gap:10px; align-items:center; }
    .chg-btn, .chg-row button { font-family:var(--sans); font-size:13px; font-weight:600; padding:7px 12px; border:1px solid var(--border); border-radius:10px; background:var(--card); color:var(--ink); cursor:pointer; }
    .chg-btn:hover, .chg-row button:hover { border-color:var(--green-bright); color:var(--green); }
    .chg-btn b { color:var(--green); }
    .chg-panel { margin:10px 0 16px; }
    .chg-panel textarea { width:100%; box-sizing:border-box; font-family:var(--mono); font-size:12px; line-height:1.5; padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:var(--bg); color:var(--ink); resize:vertical; }
    .chg-row { display:flex; gap:8px; margin-top:8px; }
    .txtable { margin-top:18px; }
    .tabulator { background:transparent; border:0; font-family:var(--sans); font-size:13.5px; color:var(--ink); }
    .tabulator .tabulator-header { background:transparent; border-bottom:1px solid var(--border); color:var(--ink-faint); font-family:var(--mono); font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.12em; }
    .tabulator .tabulator-header .tabulator-col { background:transparent; border-right:0; }
    .tabulator .tabulator-header .tabulator-col .tabulator-col-content { padding:8px 8px; }
    .tabulator .tabulator-header .tabulator-col.tabulator-sortable:hover { background:transparent; color:var(--ink); }
    .tabulator .tabulator-tableholder { background:transparent; }
    .tabulator .tabulator-row { background:transparent; border-bottom:1px solid var(--border); color:var(--ink); min-height:34px; }
    .tabulator .tabulator-row.tabulator-row-even { background:transparent; }
    .tabulator .tabulator-row:hover { background:color-mix(in srgb, var(--green) 7%, transparent); }
    .tabulator .tabulator-row .tabulator-cell { border-right:0; padding:7px 8px; }
    .tabulator .tabulator-row .tabulator-cell.mono { font-family:var(--mono); font-size:12.5px; font-variant-numeric:tabular-nums; }
    .tabulator .tabulator-row.chg { background:color-mix(in srgb, var(--amber) 12%, transparent); }
    .tabulator .tabulator-row .tabulator-cell.tabulator-editing { border:1px solid var(--green); background:var(--card); }
    .tabulator .tabulator-row .tabulator-cell.tabulator-editing input, .tabulator .tabulator-row .tabulator-cell.tabulator-editing select { background:var(--card); color:var(--ink); font-family:var(--sans); }
    .tabulator-edit-list { background:var(--card); border:1px solid var(--border); border-radius:10px; font-family:var(--sans); font-size:13px; color:var(--ink); box-shadow:0 10px 26px -8px rgba(0,0,0,.35); }
    .tabulator-edit-list .tabulator-edit-list-item { color:var(--ink); padding:6px 10px; }
    .tabulator-edit-list .tabulator-edit-list-item.active, .tabulator-edit-list .tabulator-edit-list-item:hover { background:var(--green); color:#fff; }
    .tabulator .tabulator-row.tabulator-group { background:transparent; border-bottom:1px solid var(--border); border-right:0; padding:9px 10px; color:var(--ink); font-weight:600; display:flex; align-items:center; gap:10px; }
    .tabulator .tabulator-row.tabulator-group .tabulator-arrow { border-left-color:var(--ink-faint); margin-right:6px; }
    .tabulator .tabulator-row.tabulator-group.tabulator-group-level-1 { padding-left:24px; font-weight:500; }
    .gh-tier { font-family:var(--serif); font-size:17px; }
    .gh-m { color:var(--green); } .gh-o { color:var(--amber); }
    .gh-dot { width:9px; height:9px; border-radius:50%; display:inline-block; }
    .gh-n { font-family:var(--mono); font-size:11px; color:var(--ink-faint); }
    .gh-sum { margin-left:auto; font-family:var(--mono); font-size:12.5px; font-variant-numeric:tabular-nums; color:var(--ink); }
    .tabulator .t-name { display:block; } .tabulator .t-acct { display:block; font-size:11px; color:var(--ink-faint); }
    .tabulator .t-note { font-size:12.5px; color:var(--ink-soft); } .tabulator .t-note.faint { color:var(--ink-faint); }
    .tabulator .pick { border-bottom:1px dotted var(--ink-faint); }
    .tick { font-family:var(--mono); color:var(--ink-faint); } .tick.on { color:var(--green); font-weight:700; }
    .tabulator .tabulator-col-resize-handle { display:none; }
    @media (max-width:640px) { .tabulator .tabulator-header { display:none; } }
    .cat-rows { font-size:11px; color:var(--ink-faint); text-decoration:none; margin-left:4px; opacity:0; transition:opacity .15s; }
    details.cat summary:hover .cat-rows { opacity:1; }
    .cat-rows:hover { color:var(--green); }
    .sv-control-row { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:10px; gap:10px; }
    .sv-rate-label { font-family:var(--sans); font-size:11.5px; font-weight:600; text-transform:uppercase; letter-spacing:.1em; color:var(--ink-soft); }
    .sv-rate { font-family:var(--sans); font-size:24px; font-weight:700; letter-spacing:-.01em; color:var(--green); transition:color .1s; white-space:nowrap; font-variant-numeric:tabular-nums; }
    input[type=range] { -webkit-appearance:none; appearance:none; width:100%; height:7px; border-radius:999px;
      background:linear-gradient(90deg, color-mix(in srgb, var(--ink-faint) 26%, var(--card-soft)) 0%, color-mix(in srgb, var(--green-bright) 34%, var(--card-soft)) 55%, var(--green-bright) 100%); outline:none; }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:26px; height:26px; border-radius:50%; background:var(--card); border:7px solid var(--thumb,var(--green)); box-shadow:0 2px 8px rgba(0,0,0,.22); cursor:grab; transition:box-shadow .2s; }
    input[type=range]::-moz-range-thumb { width:26px; height:26px; border-radius:50%; background:var(--card); border:7px solid var(--thumb,var(--green)); box-shadow:0 2px 8px rgba(0,0,0,.22); cursor:grab; }
    input[type=range].hot::-webkit-slider-thumb { box-shadow:0 0 0 5px rgba(15,191,127,.16), 0 0 20px rgba(15,191,127,.55); }
    input[type=range].hot::-moz-range-thumb { box-shadow:0 0 0 5px rgba(15,191,127,.16), 0 0 20px rgba(15,191,127,.55); }

    .spend-head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; }
    select.month-pick { font-family:var(--sans); font-size:13.5px; font-weight:600; color:var(--ink); padding:11px 15px; border:1px solid var(--border); border-radius:14px; background:var(--card); cursor:pointer; }
    select.month-pick:hover { border-color:var(--green-bright); }
    .month-total { font-family:var(--serif); font-size:40px; font-weight:700; margin:6px 0 18px; }
    .month-total-label { font-family:var(--sans); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.1em; color:var(--ink-faint); margin-left:14px; }
    .bd-bar { display:flex; width:100%; border-radius:12px; overflow:hidden; }
    .bd-split { height:34px; margin-bottom:10px; gap:2px; }
    .bd-seg { height:100%; display:flex; align-items:center; padding:0 12px; overflow:hidden; min-width:2px; cursor:default; transition:opacity .12s, filter .12s; }
    .bd-seg.dim { opacity:.3; filter:saturate(.5); }
    .bd-seg.hot { box-shadow:inset 0 0 0 2px rgba(255,255,255,.85); }
    .bd-seg-l { font-family:var(--sans); font-size:12px; font-weight:700; color:#fff; white-space:nowrap; text-shadow:0 1px 1px rgba(0,0,0,.22); overflow:hidden; text-overflow:ellipsis; max-width:100%; }
    .bd-min { display:none; }
    .tier { margin-top:30px; }
    .tier-head { display:flex; justify-content:space-between; align-items:baseline; gap:12px; }
    .tier-head h3 { font-family:var(--serif); font-size:21px; font-weight:700; margin:0; }
    .tier-head h3::before { content:""; display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:10px; vertical-align:2px; }
    .tier-mandatory .tier-head h3::before { background:var(--green-bright); }
    .tier-non-mandatory .tier-head h3::before { background:var(--amber); }
    .tier-total { font-family:var(--sans); font-size:17px; font-weight:700; font-variant-numeric:tabular-nums; }
    .tier-sub { font-size:13px; color:var(--ink-soft); margin:4px 0 14px; }
    details.cat { border:1px solid var(--line-soft); border-radius:var(--radius-sm); background:var(--card); margin-bottom:8px; overflow:hidden; transition:opacity .12s, border-color .12s, box-shadow .15s; }
    details.cat:hover { border-color:var(--border); box-shadow:0 4px 14px -8px rgba(76,62,34,.25); }
    details.cat.rowdim { opacity:.4; }
    details.cat summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:12px; padding:14px 17px; user-select:none; position:relative; }
    .cat-fill { position:absolute; left:0; top:0; bottom:0; z-index:0; }
    details.cat summary > *:not(.cat-fill) { position:relative; z-index:1; }
    details.cat summary::-webkit-details-marker { display:none; }
    details.cat summary::before { content:"\\203A"; color:var(--ink-faint); font-size:18px; line-height:1; width:12px; display:inline-block; transition:transform .15s ease; position:relative; z-index:1; }
    details.cat[open] summary::before { transform:rotate(90deg); }
    .cat-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; position:relative; z-index:1; }
    .cat-name { font-size:15px; font-weight:600; flex:1; }
    .cat-pct { font-family:var(--sans); font-size:12px; font-weight:600; color:var(--ink-soft); min-width:38px; text-align:right; font-variant-numeric:tabular-nums; }
    .cat-meta { font-family:var(--sans); font-size:11.5px; color:var(--ink-faint); min-width:56px; text-align:right; }
    .cat-amt { font-family:var(--sans); font-size:15px; font-weight:700; min-width:76px; text-align:right; font-variant-numeric:tabular-nums; }
    .txns { list-style:none; margin:0; padding:2px 17px 12px 41px; background:var(--card); position:relative; z-index:1; }
    .txns li { display:flex; align-items:center; gap:12px; padding:8px 0; border-top:1px solid var(--line-soft); font-size:13.5px; }
    .t-date { font-family:var(--mono); color:var(--ink-faint); font-variant-numeric:tabular-nums; font-size:11.5px; min-width:82px; white-space:nowrap; }
    .t-merch { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
    .t-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .t-note { font-size:11.5px; font-weight:500; color:var(--ink-faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .t-acct { font-family:var(--sans); font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.05em; color:var(--ink-soft); background:var(--card-soft); border:1px solid var(--line-soft); border-radius:999px; padding:2px 9px; white-space:nowrap; }
    .t-amt { font-family:var(--mono); font-weight:700; font-size:13px; min-width:66px; text-align:right; font-variant-numeric:tabular-nums; }

    .lv-phase { margin-top:34px; }
    .lv-phase-bare { margin-top:8px; }
    .lv-phase-head { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom:12px; }
    .lv-phase-head h3 { font-family:var(--serif); font-size:23px; font-weight:700; margin:0; }
    .lv-phase.on .lv-phase-head h3 { color:var(--green); }
    .lv-when { font-family:var(--sans); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.1em; color:var(--ink-faint); }
    .lv-phase-sub { font-size:13px; color:var(--ink-soft); margin:-6px 0 12px; }
    details.lever { border:1px solid var(--line-soft); border-radius:var(--radius-sm); background:var(--card); margin-bottom:8px; overflow:hidden; transition:border-color .15s, box-shadow .15s; }
    details.lever:hover { border-color:color-mix(in srgb, var(--green-bright) 30%, var(--border)); box-shadow:0 4px 14px -8px rgba(76,62,34,.25); }
    details.lever[open] { border-color:color-mix(in srgb, var(--green-bright) 35%, var(--border)); }
    details.lever summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:12px; padding:15px 18px; user-select:none; }
    details.lever summary::-webkit-details-marker { display:none; }
    details.lever summary::before { content:"\\203A"; color:var(--ink-faint); font-size:18px; line-height:1; width:12px; flex:0 0 auto; display:inline-block; transition:transform .15s ease; }
    details.lever[open] summary::before { transform:rotate(90deg); }
    .lv-st { display:inline-flex; align-items:center; gap:6px; font-family:var(--sans); font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; border-radius:999px; padding:4px 10px; flex:0 0 auto; white-space:nowrap; }
    .lv-st-dot { width:7px; height:7px; border-radius:50%; background:currentColor; flex:0 0 auto; }
    .lv-active { color:var(--green); background:var(--green-soft); }
    .lv-active .lv-st-dot { animation:lvpulse 1.6s ease-in-out infinite; }
    .lv-done { color:var(--card); background:var(--green); }
    .lv-next { color:var(--amber); background:var(--amber-soft); }
    .lv-wait { color:var(--ink-faint); background:var(--card-soft); }
    .lv-rule { color:var(--blue); background:color-mix(in srgb, var(--blue) 11%, var(--card)); }
    @keyframes lvpulse { 0%,100%{opacity:1;} 50%{opacity:.35;} }
    .lv-title { font-size:15.5px; font-weight:600; flex:1; min-width:0; line-height:1.4; }
    .lv-val { font-family:var(--sans); font-size:12.5px; font-weight:700; color:var(--green); background:var(--green-soft); border-radius:999px; padding:4px 12px; white-space:nowrap; font-variant-numeric:tabular-nums; }
    .lv-body { padding:2px 20px 18px 42px; animation:lvreveal .25s ease; }
    @keyframes lvreveal { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
    .lv-act { font-size:15px; line-height:1.66; margin:8px 0 0; max-width:66ch; }
    .lv-act + .lv-act { margin-top:9px; }
    .lv-note { font-size:14px; line-height:1.64; color:var(--ink-soft); margin:10px 0 0; max-width:66ch; }
    .lv-note + .lv-note { margin-top:9px; }
    .lv-list { margin:9px 0 0; padding-left:21px; }
    .lv-list li { margin-top:5px; padding-left:3px; }
    .lv-list li::marker { color:var(--ink-faint); font-weight:600; }
    .lv-act strong, .lv-note strong { color:var(--green); font-weight:700; font-variant-numeric:tabular-nums; }
    [data-theme="dark"] .lv-act strong, [data-theme="dark"] .lv-note strong { color:var(--green-bright); }

    .page-foot { text-align:center; font-family:var(--sans); font-size:12.5px; font-weight:500; letter-spacing:.02em; color:var(--ink-faint); margin-top:48px; }

    @media (max-width:760px) {
      .page { padding:24px 14px 56px; }
      .card { padding:22px 16px; border-radius:22px; }
      .page-head { margin-top:48px; }
      .page-head h1 { font-size:37px; }
      .page-head .subtitle { font-size:15px; }
      .block-head h2 { font-size:25px; }
      .sv-head { gap:14px; }
      .sv-now-amt { font-size:47px; }
      /* The chart is the centerpiece: break it out of the card padding so it runs
         edge-to-edge, and give it real height. Right-edge labels overlay a soft
         fade (drawn in the SVG) instead of eating a margin that crops the plot. */
      .sv-chart-wrap { height:454px; margin:14px -16px 6px; }
      .sv-figs { width:100%; gap:9px; }
      .sv-fig { flex:1; min-width:0; padding:13px 15px; }
      .sv-fig-amt { font-size:23px; }
      .sv-fig-rub { font-size:11.5px; }
      .sv-control-row { flex-wrap:wrap; }
      .sv-rate-label { font-size:10.5px; }
      .sv-rate { font-size:21px; }
      .sv-controls { grid-template-columns:1fr; gap:14px; }
      .controls .ctl { padding:7px 10px; font-size:11px; }
      .spend-head { flex-direction:column; gap:12px; }
      select.month-pick { width:100%; }
      .month-total { font-size:31px; }
      .month-total-label { margin-left:10px; }
      .bd-split { height:30px; }
      .bd-full { display:none; }
      .bd-min { display:inline; }
      .cat-meta { display:none; }
      /* Flatten the nested look on phones: drop the card-in-card borders, keep the
         category colour via the fill. */
      .tier { margin-top:24px; }
      .tier-head h3 { font-size:19px; }
      details.cat { border:none; border-radius:11px; margin-bottom:2px; }
      details.cat summary { padding:13px 10px; gap:9px; }
      .cat-amt { min-width:0; }
      .lv-phase { margin-top:26px; }
      .lv-phase-head h3 { font-size:20px; }
      details.lever summary { flex-wrap:wrap; padding:13px 12px; row-gap:7px; }
      .lv-title { flex:1 1 100%; order:3; padding-left:23px; }
      .lv-val { margin-left:auto; }
      .lv-body { padding:0 13px 14px 13px; }
      .lv-act { font-size:14.5px; }
      .lv-note { font-size:13.5px; }
      .t-date { min-width:0; font-size:11px; }
      .t-acct { font-size:9.5px; padding:2px 7px; }
      .txns { padding-left:12px; padding-right:2px; }
      .txns li { gap:9px; }
    }`;
}

