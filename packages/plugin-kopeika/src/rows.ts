/**
 * The raw-table view: every ledger row, one line each, with the account it came
 * from, the amount, the household category and tier, the tax disposition, and the
 * note. Self-contained HTML (data embedded as JSON, filters in ~60 lines of JS):
 * period presets cut salary-to-salary, plus month, account, category, kind and a
 * text search. Nothing here is a chart; it is the table you check a number against.
 */
import { isAnalyticsExcluded, EXCLUDE_CATEGORY, SAVINGS_CATEGORY } from "./analytics.ts";
import { tierOf, type Tiers } from "./tiers.ts";
import type { Transaction } from "./types.ts";

export interface RowsOptions {
  lang: "en" | "ru";
  from: string;
  accountLabels: Record<string, { en: string; ru: string }>;
  tiers: Tiers;
  /** Merchant substring that marks a salary row; period presets cut on those dates. */
  salaryCategory: string;
}

const T = {
  en: { title: "kopeika · rows", period: "period", all: "all", month: "month", account: "account", category: "category", kind: "kind", search: "search", counted: "counted", internal: "internal move", savings: "savings", excluded: "excluded", mandatory: "mandatory", optional: "optional", date: "date", merchant: "merchant", amount: "EUR", tier: "tier", books: "books", note: "note", spend: "spend", income: "income", rows: "rows", from: "from", to: "to", today: "today", back: "dashboard" },
  ru: { title: "kopeika · строки", period: "период", all: "все", month: "месяц", account: "счёт", category: "категория", kind: "вид", search: "поиск", counted: "в расчёте", internal: "между своими", savings: "накопления", excluded: "исключено", mandatory: "обязательное", optional: "свободное", date: "дата", merchant: "получатель", amount: "EUR", tier: "тип", books: "книги", note: "заметка", spend: "расход", income: "доход", rows: "строк", from: "с", to: "по", today: "сегодня", back: "дашборд" },
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderRowsHtml(txs: readonly Transaction[], o: RowsOptions): string {
  const t = T[o.lang];
  const rows = txs
    .filter((x) => x.date >= o.from)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((x) => {
      const kind = x.category === SAVINGS_CATEGORY ? "savings" : x.category === EXCLUDE_CATEGORY ? "excluded" : isAnalyticsExcluded(x) ? "internal" : "counted";
      return {
        id: x.id,
        d: x.date,
        a: o.accountLabels[x.account]?.[o.lang] ?? x.account,
        m: x.merchant_raw,
        e: x.amount_eur,
        n: x.currency !== "EUR" ? `${x.amount_native} ${x.currency}` : "",
        c: x.category,
        t: kind === "counted" && x.amount_eur !== null && x.amount_eur < 0 ? tierOf(o.tiers, x.category, x.merchant_raw) : "",
        k: kind,
        p: x.tax_person,
        x: x.tax_category,
        nt: x.note,
      };
    });
  // Salary-to-salary period presets: each salary date opens a period that runs to the day before the next one.
  const salaryDates = [...new Set(txs.filter((x) => x.category === o.salaryCategory && (x.amount_eur ?? 0) > 0 && x.date >= o.from).map((x) => x.date))].sort();
  const periods = salaryDates.map((d, i) => ({ from: d, to: salaryDates[i + 1] ? prevDay(salaryDates[i + 1]!) : "" })).reverse();
  const accounts = [...new Set(rows.map((r) => r.a))].sort();
  const categories = [...new Set(rows.map((r) => r.c || "—"))].sort();
  const months = [...new Set(rows.map((r) => r.d.slice(0, 7)))].sort().reverse();

  return `<!DOCTYPE html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title>
<style>
:root{--display:"Space Grotesk","Inter",sans-serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;--paper:#f6f4ec;--surface:#fbf9f2;--line:#ddd7c7;--ink:#1b1d1a;--soft:#585b51;--faint:#8b8d81;--accent:#0f9999;--neg:#a33a2f;--pos:#2f7d4f}
@media(prefers-color-scheme:dark){:root{--paper:#141310;--surface:#1c1a15;--line:#2c2a23;--ink:#ece9e0;--soft:#a3a094;--faint:#75736a;--accent:#60baba;--neg:#e0705f;--pos:#6cc08b}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.45 "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;padding:0 16px 40px}
header{position:sticky;top:0;background:var(--paper);padding:12px 0 10px;border-bottom:1px solid var(--line);z-index:2}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.bar label{display:flex;flex-direction:column;font-size:11px;color:var(--faint)}
select,input{font:inherit;padding:5px 7px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink);min-width:120px}
.tot{margin-top:8px;display:flex;gap:18px;font-family:var(--mono);font-size:12.5px;color:var(--soft)}.tot b{color:var(--ink)}
table{border-collapse:collapse;width:100%;margin-top:10px;font-variant-numeric:tabular-nums}th{position:sticky;top:96px;background:var(--paper);text-align:left;font-family:var(--mono);font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:var(--faint);font-size:10.5px;padding:6px 6px;border-bottom:1px solid var(--line);cursor:pointer;white-space:nowrap}
td{padding:5px 6px;border-bottom:1px solid var(--line);vertical-align:top}td.num{text-align:right;white-space:nowrap;font-family:var(--mono);font-size:12.5px}td:first-child{font-family:var(--mono);font-size:12px}.neg{color:var(--neg)}.pos{color:var(--pos)}
tr.internal td,tr.excluded td{color:var(--faint)}tr.savings td{color:var(--accent)}td.nt{color:var(--soft);font-size:12px;max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}td.nt:hover{white-space:normal}
.chip{display:inline-block;padding:0 6px;border-radius:10px;border:1px solid var(--line);font-size:11px;color:var(--soft)}.chip.m{border-color:var(--accent);color:var(--accent)}
a{color:var(--accent)}.top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}h1{font-family:var(--display);font-size:16px;margin:0;font-weight:600}
@media(max-width:700px){td.nt,th.nt,td.acc,th.acc{display:none}th{top:140px}}
</style></head><body>
<header><div class="top"><h1>${t.title}</h1><a href="/">${t.back}</a></div>
<div class="bar">
<label>${t.period}<select id="period"><option value="">${t.all}</option>${periods.map((p) => `<option value="${p.from}|${p.to}">${t.from} ${fmtD(p.from)} ${t.to} ${p.to ? fmtD(p.to) : t.today}</option>`).join("")}</select></label>
<label>${t.month}<select id="month"><option value="">${t.all}</option>${months.map((m) => `<option>${m}</option>`).join("")}</select></label>
<label>${t.account}<select id="account"><option value="">${t.all}</option>${accounts.map((a) => `<option>${esc(a)}</option>`).join("")}</select></label>
<label>${t.category}<select id="category"><option value="">${t.all}</option>${categories.map((c) => `<option>${esc(c)}</option>`).join("")}</select></label>
<label>${t.kind}<select id="kind"><option value="counted">${t.counted}</option><option value="">${t.all}</option><option value="internal">${t.internal}</option><option value="savings">${t.savings}</option><option value="excluded">${t.excluded}</option></select></label>
<label>${t.search}<input id="q" type="search" placeholder="…"></label>
</div>
<div class="tot"><span>${t.spend} <b id="tSpend"></b></span><span>${t.income} <b id="tInc"></b></span><span>${t.mandatory} <b id="tMand"></b></span><span>${t.optional} <b id="tOpt"></b></span><span><b id="tN"></b> ${t.rows}</span></div></header>
<table><thead><tr><th data-k="d">${t.date}</th><th class="acc" data-k="a">${t.account}</th><th data-k="m">${t.merchant}</th><th data-k="e" style="text-align:right">${t.amount}</th><th data-k="c">${t.category}</th><th data-k="t">${t.tier}</th><th data-k="p">${t.books}</th><th class="nt" data-k="nt">${t.note}</th></tr></thead><tbody id="tb"></tbody></table>
<script>
const ROWS=${JSON.stringify(rows)};const L=${JSON.stringify({ mandatory: t.mandatory, optional: t.optional })};
const $=(id)=>document.getElementById(id);let sortK='d',sortDir=-1;
function fmt(n){return n==null?'':n.toLocaleString('${o.lang === "ru" ? "ru-RU" : "en-GB"}',{minimumFractionDigits:2,maximumFractionDigits:2})}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function apply(){const [pf,pt]=($('period').value||'|').split('|');const mo=$('month').value,ac=$('account').value,ca=$('category').value,ki=$('kind').value,q=$('q').value.toLowerCase();
let rs=ROWS.filter(r=>(!pf||r.d>=pf)&&(!pt||r.d<=pt)&&(!mo||r.d.startsWith(mo))&&(!ac||r.a===ac)&&(!ca||(r.c||'—')===ca)&&(!ki||r.k===ki)&&(!q||(r.m+' '+r.nt+' '+r.c+' '+r.a).toLowerCase().includes(q)));
rs.sort((a,b)=>{const x=a[sortK],y=b[sortK];return (x==null?-1:y==null?1:x<y?-1:x>y?1:0)*sortDir});
let sp=0,inc=0,mand=0;for(const r of rs){if(r.k!=='counted'||r.e==null)continue;if(r.e<0){sp-=r.e;if(r.t==='mandatory')mand-=r.e}else inc+=r.e}
$('tSpend').textContent=fmt(sp);$('tInc').textContent=fmt(inc);$('tMand').textContent=fmt(mand);$('tOpt').textContent=fmt(sp-mand);$('tN').textContent=rs.length;
$('tb').innerHTML=rs.map(r=>'<tr class="'+r.k+'"><td>'+r.d.slice(5)+'</td><td class="acc">'+esc(r.a)+'</td><td>'+esc(r.m)+(r.n?' <span class="chip">'+esc(r.n)+'</span>':'')+'</td><td class="num '+(r.e<0?'neg':'pos')+'">'+fmt(r.e)+'</td><td>'+esc(r.c||'—')+'</td><td>'+(r.t?'<span class="chip'+(r.t==='mandatory'?' m':'')+'">'+L[r.t]+'</span>':'')+'</td><td>'+(r.p?esc(r.p+' · '+r.x):'')+'</td><td class="nt" title="'+esc(r.nt)+'">'+esc(r.nt)+'</td></tr>').join('')}
for(const id of ['period','month','account','category','kind'])$(id).addEventListener('change',apply);$('q').addEventListener('input',apply);
document.querySelectorAll('th').forEach(th=>th.addEventListener('click',()=>{const k=th.dataset.k;if(sortK===k)sortDir=-sortDir;else{sortK=k;sortDir=k==='d'||k==='e'?-1:1}apply()}));
if(ROWS.length&&$('period').options.length>1)$('period').selectedIndex=1;apply();
</script></body></html>`;
}

function prevDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function fmtD(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}
