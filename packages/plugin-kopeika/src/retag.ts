/**
 * The retag page: one month (or one salary-to-salary period) of counted spend rows,
 * grouped mandatory / optional then by category, each row with one category
 * dropdown, one "mandatory" tick preset from the category default, and a note to
 * the agent. Nothing writes to the ledger from here: changes live in the browser
 * (localStorage `kopeika-changes`), the "changes" panel shows them as one JSON
 * object per line, and the human pastes that block into the chat. The agent turns
 * each line into a pin (row scope) or an exact rule (merchant scope), runs
 * `categorize`, re-renders. By ruling there is no apply command.
 *
 * Its own page on purpose (2026-09-13): a first version built into the dashboard's
 * spend section was rejected on sight, so this one is calm - generous rows, hairline
 * rules only, no cards, nothing bold. Same fonts, palette and column as the July
 * dashboard. Grouping is by the row's ORIGINAL tier and category, so an edited row
 * stays where the eye left it and is highlighted instead of jumping groups.
 */
import { isAnalyticsExcluded } from "./analytics.ts";
import { tierOf, type Tiers } from "./tiers.ts";
import type { Transaction } from "./types.ts";
import { CATEGORIES, categoryLabel, pickableCategories } from "./categories.ts";

export interface RetagOptions {
  lang: "en" | "ru";
  /** Earliest date embedded (ISO). Everything before it is not on the page. */
  from: string;
  accountLabels: Record<string, { en: string; ru: string }>;
  tiers: Tiers;
  /** Category of salary rows; each salary date opens a salary-to-salary preset. */
  salaryCategory: string;
  /** Persons with a tax profile: the values of the books dropdown. */
  persons: readonly string[];
}

const T = {
  en: {
    title: "kopeika · retag", h1: "Retag", back: "dashboard", rows: "rows", period: "period", bySalary: "salary to salary", byMonth: "calendar month",
    from: "from", to: "to", today: "today", changes: "changes", copy: "copy", copied: "copied", clear: "clear", collapse: "collapse all", expand: "expand all",
    date: "date", merchant: "merchant", amount: "EUR", category: "category", mandatory: "mandatory", books: "business", note: "note to the agent",
    tierM: "Mandatory", tierO: "Optional", spend: "spend", tMand: "mandatory", tOpt: "optional", n: "rows",
    hint: "Changes stay in this browser. Copy the block into the chat and the agent files it.",
    empty: "No counted spend in this period.",
  },
  ru: {
    title: "kopeika · разметка", h1: "Разметка", back: "дашборд", rows: "строки", period: "период", bySalary: "от зарплаты до зарплаты", byMonth: "календарный месяц",
    from: "с", to: "по", today: "сегодня", changes: "изменения", copy: "скопировать", copied: "скопировано", clear: "очистить", collapse: "свернуть всё", expand: "развернуть всё",
    date: "дата", merchant: "получатель", amount: "EUR", category: "категория", mandatory: "обязательно", books: "бизнес", note: "заметка агенту",
    tierM: "Обязательные", tierO: "Свободные", spend: "расход", tMand: "обязательные", tOpt: "свободные", n: "строк",
    hint: "Изменения хранятся в этом браузере. Скопируй блок в чат, агент его применит.",
    empty: "За этот период нет расходов в расчёте.",
  },
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
/** JSON for an inline <script>: `<` escaped so a merchant string can never close the tag. */
function json(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c");
}
function prevDay(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function fmtD(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}
function monthName(ym: string, lang: "en" | "ru"): string {
  const names = {
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    ru: ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"],
  }[lang];
  return `${names[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}

export function renderRetagHtml(txs: readonly Transaction[], o: RetagOptions): string {
  const t = T[o.lang];
  const rows = txs
    .filter((x) => x.date >= o.from && !isAnalyticsExcluded(x) && x.amount_eur !== null && x.amount_eur < 0)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .map((x) => ({
      id: x.id,
      d: x.date,
      tm: x.time,
      m: x.merchant_raw,
      a: o.accountLabels[x.account]?.[o.lang] ?? x.account,
      e: Math.round(-x.amount_eur! * 100) / 100,
      c0: x.category,
      t0: tierOf(o.tiers, x.category, x.merchant_raw, x.id),
      b0: x.tax_person,
    }));

  const salaryDates = [...new Set(txs.filter((x) => x.category === o.salaryCategory && (x.amount_eur ?? 0) > 0 && x.date >= o.from).map((x) => x.date))].sort();
  const periods = salaryDates.map((d, i) => ({ from: d, to: salaryDates[i + 1] ? prevDay(salaryDates[i + 1]!) : "" })).reverse();
  const months = [...new Set(rows.map((r) => r.d.slice(0, 7)))].sort().reverse();

  const spendCats = pickableCategories().filter((c) => c.kind === "spend").map((c) => ({ value: c.key, label: o.lang === "ru" ? c.ru : c.en, tier: c.tier }));
  const seen = [...new Set(rows.map((r) => r.c0))].filter((c) => !spendCats.some((s) => s.value === c));
  const labels: Record<string, string> = Object.fromEntries([...spendCats.map((c) => [c.value, c.label] as const), ...seen.map((c) => [c, categoryLabel(c, o.lang)] as const)]);
  const colors = Object.fromEntries(CATEGORIES.filter((c) => c.color).map((c) => [c.key, c.color]));

  const cfg = {
    locale: o.lang === "ru" ? "ru-RU" : "en-GB",
    cats: spendCats,
    labels,
    colors,
    tier: { m: t.tierM, o: t.tierO },
    cols: { d: t.date, m: t.merchant, e: t.amount, c: t.category, man: t.mandatory, b: t.books, n: t.note },
    persons: o.persons,
    copied: t.copied,
    copy: t.copy,
  };

  const periodOptions = [
    periods.length ? `<optgroup label="${esc(t.bySalary)}">${periods.map((p) => `<option value="${p.from}|${p.to}">${t.from} ${fmtD(p.from)} ${t.to} ${p.to ? fmtD(p.to) : t.today}</option>`).join("")}</optgroup>` : "",
    months.length ? `<optgroup label="${esc(t.byMonth)}">${months.map((m) => `<option value="${m}-01|${m}-31">${esc(monthName(m, o.lang))}</option>`).join("")}</optgroup>` : "",
  ].join("");

  const themeBoot = `(function(){try{var t=localStorage.getItem('kopeika-theme');if(!t)t=window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

  const script = `(function(){
var ROWS=${json(rows)}, C=${json(cfg)}, KEY='kopeika-changes';
var CT={}; C.cats.forEach(function(c){CT[c.value]=c.tier==='mandatory';});
var $=function(id){return document.getElementById(id);};
var CH={}; try{CH=JSON.parse(localStorage.getItem(KEY)||'{}');}catch(e){CH={};} if(!CH||typeof CH!=='object')CH={};
function fmtE(n){return n.toLocaleString(C.locale,{minimumFractionDigits:2,maximumFractionDigits:2,useGrouping:false});}
function escH(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function label(c){return C.labels[c]||c||'';}
function defMan(r){return r.c===r.c0?r.t0==='mandatory':!!CT[r.c];}
function restore(r){var ch=CH[r.id]; r.c=ch&&ch.category?ch.category:r.c0; r.man=ch&&ch.mandatory?ch.mandatory==='yes':defMan(r); r.b=ch&&ch.books!==undefined?ch.books:r.b0; r.n=ch&&ch.note?ch.note:''; return r;}
function save(){try{localStorage.setItem(KEY,JSON.stringify(CH));}catch(e){} var n=Object.keys(CH).length; $('chgN').textContent=n; $('chgBtn').classList.toggle('on',n>0); renderCh();}
function renderCh(){$('chgText').value=Object.keys(CH).map(function(k){return JSON.stringify(CH[k]);}).join(String.fromCharCode(10));}
function record(r){var c={id:r.id,date:r.d,merchant:r.m,eur:r.e},diff=false;
  if(r.c!==r.c0){c.category=r.c;diff=true;}
  if(r.man!==defMan(r)){c.mandatory=r.man?'yes':'no';diff=true;}
  if(r.b!==r.b0){c.books=r.b;diff=true;}
  if(r.n){c.note=r.n;diff=true;}
  if(diff)CH[r.id]=c;else delete CH[r.id]; save(); return diff;}
ROWS.forEach(restore);

var table=new Tabulator('#table',{data:[],index:'id',layout:'fitColumns',renderVertical:'basic',columnHeaderVertAlign:'bottom',
  groupBy:[function(r){return r.t0==='mandatory'?'1':'0';},'c0'],groupStartOpen:[true,true],groupToggleElement:'header',
  groupHeader:[
    function(v,count,data){var sum=data.reduce(function(s,r){return s+r.e;},0);return '<span class="g-tier">'+(v==='1'?C.tier.m:C.tier.o)+'</span><span class="g-sum">'+fmtE(sum)+'</span>';},
    function(v,count,data){var sum=data.reduce(function(s,r){return s+r.e;},0);return '<span class="g-dot" style="background:'+(C.colors[v]||'#98917f')+'"></span><span class="g-cat">'+escH(label(v))+'</span><span class="g-n">'+count+'</span><span class="g-sum">'+fmtE(sum)+'</span>';}
  ],
  rowFormatter:function(row){var d=row.getData(); row.getElement().classList.toggle('chg',!!CH[d.id]);},
  columns:[
    {title:C.cols.d,field:'d',width:78,cssClass:'mono',headerSort:true,sorter:function(a,b,ra,rb){var x=a+' '+(ra.getData().tm||''),y=b+' '+(rb.getData().tm||'');return x<y?-1:x>y?1:0;},formatter:function(c){var r=c.getRow().getData();return '<div class="t-wrap"><span class="t-name">'+r.d.slice(8,10)+'.'+r.d.slice(5,7)+'</span><span class="t-acct t-time">'+escH(r.tm||'')+'</span></div>';}},
    {title:C.cols.m,field:'m',minWidth:180,headerSort:false,formatter:function(c){var r=c.getRow().getData();return '<div class="t-wrap"><span class="t-name">'+escH(r.m)+'</span><span class="t-acct">'+escH(r.a)+'</span></div>';}},
    {title:C.cols.e,field:'e',width:104,hozAlign:'right',headerHozAlign:'right',cssClass:'mono',sorter:'number',headerSort:true,formatter:function(c){return fmtE(c.getValue());}},
    {title:C.cols.c,field:'c',width:210,headerSort:false,formatter:function(c){var r=c.getRow().getData();var cur=r.c;var opts='';
      if(!C.labels[cur]||!CT.hasOwnProperty(cur))opts+='<option value="'+escH(cur)+'" selected>'+escH(label(cur))+'</option>';
      C.cats.forEach(function(k){opts+='<option value="'+escH(k.value)+'"'+(k.value===cur?' selected':'')+'>'+escH(k.label)+'</option>';});
      return '<select class="pick" data-id="'+escH(r.id)+'" data-f="c">'+opts+'</select>';}},
    {title:C.cols.man,field:'man',width:118,hozAlign:'center',headerHozAlign:'center',headerSort:false,formatter:function(c){var r=c.getRow().getData();return '<label class="tick"><input type="checkbox" data-id="'+escH(r.id)+'" data-f="man"'+(r.man?' checked':'')+'></label>';}},
    {title:C.cols.b,field:'b',width:112,headerSort:false,formatter:function(c){var r=c.getRow().getData();var opts='<option value=""'+(r.b?'':' selected')+'>\u2014</option>';C.persons.forEach(function(p){opts+='<option value="'+escH(p)+'"'+(p===r.b?' selected':'')+'>'+escH(p)+'</option>';});return '<select class="pick books'+(r.b?' set':'')+'" data-id="'+escH(r.id)+'" data-f="b">'+opts+'</select>';}},
    {title:C.cols.n,field:'n',minWidth:160,headerSort:false,formatter:function(c){var r=c.getRow().getData();return '<input type="text" class="note" data-id="'+escH(r.id)+'" data-f="n" value="'+escH(r.n)+'">';}}
  ]});

var host=$('table');
host.addEventListener('change',function(ev){var el=ev.target; if(!el.dataset||!el.dataset.id)return; var row=table.getRow(el.dataset.id); if(!row)return; var r=row.getData();
  if(el.dataset.f==='c'){r.c=el.value; r.man=defMan(r); var box=row.getElement().querySelector('input[data-f="man"]'); if(box)box.checked=r.man;}
  else if(el.dataset.f==='man'){r.man=el.checked;}
  else if(el.dataset.f==='b'){r.b=el.value; el.classList.toggle('set',!!r.b);}
  else if(el.dataset.f==='n'){r.n=el.value.trim();}
  row.getElement().classList.toggle('chg',record(r));});
host.addEventListener('input',function(ev){var el=ev.target; if(!el.dataset||el.dataset.f!=='n')return; var row=table.getRow(el.dataset.id); if(!row)return; var r=row.getData(); r.n=el.value.trim(); row.getElement().classList.toggle('chg',record(r));});

function period(){var v=$('period').value||'|'; var p=v.split('|'); return {from:p[0],to:p[1]};}
function apply(){var p=period(); var rs=ROWS.filter(function(r){return (!p.from||r.d>=p.from)&&(!p.to||r.d<=p.to);});
  var tot={}; rs.forEach(function(r){var k=r.t0+'|'+r.c0; tot[k]=(tot[k]||0)+r.e;});
  rs.sort(function(a,b){if(a.t0!==b.t0)return a.t0==='mandatory'?-1:1; var ta=tot[a.t0+'|'+a.c0],tb=tot[b.t0+'|'+b.c0]; if(ta!==tb)return tb-ta; if(a.c0!==b.c0)return a.c0<b.c0?-1:1; if(a.e!==b.e)return b.e-a.e; return a.d<b.d?1:-1;});
  var sp=0,mand=0; rs.forEach(function(r){sp+=r.e; if(r.t0==='mandatory')mand+=r.e;});
  $('tSpend').textContent=fmtE(sp); $('tMand').textContent=fmtE(mand); $('tOpt').textContent=fmtE(sp-mand); $('tN').textContent=rs.length;
  $('empty').hidden=rs.length>0; host.hidden=rs.length===0; table.setData(rs);}
table.on('tableBuilt',function(){apply();});
$('period').addEventListener('change',apply);
$('collapseBtn').addEventListener('click',function(){table.getGroups().forEach(function(g){g.getSubGroups().forEach(function(s){s.hide();});});});
$('expandBtn').addEventListener('click',function(){table.getGroups().forEach(function(g){g.show();g.getSubGroups().forEach(function(s){s.show();});});});
$('chgBtn').addEventListener('click',function(){var p=$('chgPanel'); p.hidden=!p.hidden; renderCh();});
$('copyBtn').addEventListener('click',function(){navigator.clipboard.writeText($('chgText').value).then(function(){$('copyBtn').textContent=C.copied;setTimeout(function(){$('copyBtn').textContent=C.copy;},1500);});});
$('clearBtn').addEventListener('click',function(){CH={};save();ROWS.forEach(restore);apply();});
var U=new URLSearchParams(location.search); var want=U.get('month'); if(want){var opt=$('period').querySelector('option[value^="'+want+'-01"]'); if(opt)opt.selected=true;}
save();
})();`;

  return `<!DOCTYPE html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title>
<script>${themeBoot}</script>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;0,700;0,800;1,600;1,700&family=Golos+Text:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
<link href="https://cdnjs.cloudflare.com/ajax/libs/tabulator/6.4.0/css/tabulator.min.css" rel="stylesheet" />
<script src="https://cdnjs.cloudflare.com/ajax/libs/tabulator/6.4.0/js/tabulator.min.js"></script>
<style>
:root{--bg:#f5efe2;--card:#fffdf6;--ink:#26221a;--ink-soft:#615c4e;--ink-faint:#8f8875;--green:#186a45;--amber:#b06028;--border:#e6dcc4;--line-soft:#eee6d1;--ink-chrome:#736d5c;
  --serif:"Playfair Display",Georgia,"Times New Roman",serif;--sans:"Golos Text",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
[data-theme="dark"]{--bg:#11130e;--card:#191c15;--ink:#ede9dc;--ink-soft:#a9ac9e;--ink-faint:#878c7b;--green:#63d197;--amber:#e3a35c;--border:#2c3026;--line-soft:#242820;--ink-chrome:#8f9184}
*{box-sizing:border-box}html{background:var(--bg)}body{margin:0 auto;max-width:1120px;padding:40px 40px 96px;background:var(--bg);color:var(--ink);font:13.5px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
@media(max-width:700px){body{padding:20px 16px 64px}}
a{color:var(--green);text-decoration:none}a:hover{text-decoration:underline}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}
h1{font-family:var(--serif);font-size:34px;font-weight:600;letter-spacing:-.01em;margin:0;line-height:1.1}
.nav{display:flex;gap:18px;font-size:13px;color:var(--ink-soft)}.nav a.on{color:var(--ink-faint);pointer-events:none}
.hint{color:var(--ink-chrome);font-size:13px;margin:10px 0 0;max-width:60ch}
.bar{display:flex;flex-wrap:wrap;gap:12px 22px;align-items:end;margin-top:26px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.bar label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--ink-faint);letter-spacing:.02em}
select,button{font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--border);border-radius:8px;padding:7px 10px;cursor:pointer}
select{min-width:220px;padding-right:28px}button:hover{border-color:var(--ink-faint)}button.on{border-color:var(--green);color:var(--green)}
.tools{display:flex;gap:8px;margin-left:auto;align-items:center}.tools .quiet{border-color:transparent;background:transparent;color:var(--ink-chrome);padding:7px 4px}.tools .quiet:hover{color:var(--ink)}
.tot{display:flex;gap:26px;flex-wrap:wrap;margin:14px 0 6px;font-size:13px;color:var(--ink-chrome)}.tot b{font-family:var(--mono);font-weight:400;color:var(--ink-soft);font-variant-numeric:tabular-nums}
#chgPanel{margin-top:16px;padding-bottom:16px;border-bottom:1px solid var(--border)}#chgPanel textarea{width:100%;font:12px/1.55 var(--mono);color:var(--ink);background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 12px;resize:vertical}
#chgPanel .row{display:flex;gap:8px;margin-top:8px}
#empty{color:var(--ink-faint);padding:40px 0}
.tabulator{background:transparent;border:0;font-family:var(--sans);font-size:13.5px;color:var(--ink);margin-top:4px;overflow:visible}
.tabulator .tabulator-header{position:sticky;top:0;z-index:3;background:var(--bg);border-bottom:1px solid var(--border);border-top:0;color:var(--ink-chrome);font-family:var(--sans);font-size:11.5px;font-weight:400;letter-spacing:.02em}
.tabulator .tabulator-header .tabulator-col{background:transparent;border-right:0}.tabulator .tabulator-header .tabulator-col .tabulator-col-content{padding:10px 10px}
.tabulator .tabulator-header .tabulator-col.tabulator-sortable:hover{background:transparent;color:var(--ink)}
.tabulator .tabulator-header .tabulator-col.tabulator-sortable .tabulator-col-title{padding-right:20px}
.tabulator .tabulator-header .tabulator-col.tabulator-sortable[aria-sort=none] .tabulator-col-content .tabulator-col-sorter .tabulator-arrow{border-bottom-color:var(--border)}
.tabulator .tabulator-header .tabulator-col.tabulator-sortable[aria-sort=ascending] .tabulator-col-content .tabulator-col-sorter .tabulator-arrow{border-bottom-color:var(--ink-chrome)}
.tabulator .tabulator-header .tabulator-col.tabulator-sortable[aria-sort=descending] .tabulator-col-content .tabulator-col-sorter .tabulator-arrow{border-top-color:var(--ink-chrome)}
.tabulator .tabulator-tableholder{background:transparent;overflow:visible}.tabulator .tabulator-tableholder .tabulator-table{background:transparent}
.tabulator .tabulator-row{background:transparent;border-bottom:1px solid var(--line-soft);color:var(--ink);min-height:52px}
.tabulator .tabulator-row.tabulator-row-even{background:transparent}.tabulator .tabulator-row:hover{background:transparent}
.tabulator .tabulator-row .tabulator-cell{border-right:0;padding:11px 10px;display:inline-flex;align-items:center;vertical-align:middle}
.tabulator .tabulator-row .tabulator-cell.mono{font-family:var(--mono);font-size:13px;font-variant-numeric:tabular-nums;color:var(--ink-soft)}
.tabulator .tabulator-row .tabulator-cell.mono[tabulator-field="e"]{color:var(--ink);justify-content:flex-end}
.tabulator .tabulator-row .tabulator-cell[tabulator-field="c"],.tabulator .tabulator-row .tabulator-cell[tabulator-field="b"],.tabulator .tabulator-row .tabulator-cell[tabulator-field="n"]{padding-left:2px}
.tabulator select.books:not(.set){color:var(--ink-faint)}
.tabulator .tabulator-row.chg{background:color-mix(in srgb,var(--amber) 9%,transparent)}
.tabulator .tabulator-row.tabulator-group{background:transparent;border:0;border-bottom:1px solid var(--line-soft);padding:26px 10px 12px;color:var(--ink);font-weight:400;display:flex;align-items:center;gap:10px;min-height:0}
.tabulator .tabulator-row.tabulator-group.tabulator-group-level-0{margin-top:34px;border-bottom:0;padding:8px 10px 12px}
.tabulator .tabulator-row.tabulator-group.tabulator-group-level-1{padding-left:26px}
.tabulator .tabulator-row.tabulator-group .tabulator-arrow{width:0;height:0;margin-right:6px;border-top:5px solid transparent;border-bottom:5px solid transparent;border-left:6px solid var(--ink-chrome);border-right:6px solid transparent}
.tabulator .tabulator-row.tabulator-group.tabulator-group-visible .tabulator-arrow{border-top:6px solid var(--ink-chrome);border-bottom:0;border-left:6px solid transparent;border-right:6px solid transparent}
.tabulator .tabulator-row.tabulator-group span{margin:0;color:inherit}
.g-tier{font-family:var(--serif);font-size:26px;font-weight:600;letter-spacing:-.005em}.g-cat{font-size:17px;letter-spacing:-.004em}.g-n{color:var(--ink-chrome);font-family:var(--mono);font-size:12px}
.g-sum{margin-left:auto !important;font-family:var(--mono);font-size:13.5px;color:var(--ink-soft);font-variant-numeric:tabular-nums}.tabulator-group-level-0 .g-sum{font-size:14px;color:var(--ink)}
.g-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.t-wrap{min-width:0;overflow:hidden}.t-time{font-family:var(--mono);font-size:11.5px}.t-name{display:block;line-height:1.3;overflow:hidden;text-overflow:ellipsis}.t-acct{display:block;font-size:11.5px;color:var(--ink-chrome);margin-top:2px}
.tabulator select.pick{width:auto;max-width:100%;min-width:0;padding:6px 22px 6px 8px;font-size:13.5px;color:var(--ink);border-color:transparent;appearance:none;-webkit-appearance:none;background-color:transparent;background-image:linear-gradient(45deg,transparent 50%,var(--ink-chrome) 50%),linear-gradient(135deg,var(--ink-chrome) 50%,transparent 50%);background-position:right 12px center,right 8px center;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
.tabulator select.pick:hover,.tabulator select.pick:focus{border-color:var(--border);background-color:var(--card);outline:none}
.tabulator .tick{display:flex;justify-content:center;width:100%;cursor:pointer}.tabulator .tick input{width:16px;height:16px;margin:0;accent-color:var(--green);cursor:pointer}
.tabulator input.note{width:100%;font:inherit;font-size:13.5px;color:var(--ink);background:transparent;border:1px solid transparent;border-radius:6px;padding:6px 8px}
.tabulator input.note:hover,.tabulator input.note:focus{border-color:var(--border);background:var(--card);outline:none}
.tabulator .tabulator-col-resize-handle{display:none}.tabulator .tabulator-footer{display:none}
@media(max-width:700px){.tabulator .tabulator-header{display:none}.tabulator .tabulator-row .tabulator-cell{padding:8px 6px}}
</style></head><body>
<div class="top"><h1>${t.h1}</h1><nav class="nav"><a href="/">${t.back}</a><a href="/rows">${t.rows}</a><a href="/retag?lang=en"${o.lang === "en" ? ' class="on"' : ""}>EN</a><a href="/retag?lang=ru"${o.lang === "ru" ? ' class="on"' : ""}>RU</a></nav></div>
<p class="hint">${t.hint}</p>
<div class="bar">
<label>${t.period}<select id="period">${periodOptions}</select></label>
<div class="tools"><button type="button" class="quiet" id="collapseBtn">${t.collapse}</button><button type="button" class="quiet" id="expandBtn">${t.expand}</button><button type="button" id="chgBtn">${t.changes} <span id="chgN">0</span></button></div>
</div>
<div id="chgPanel" hidden><textarea id="chgText" rows="8" readonly spellcheck="false"></textarea><div class="row"><button type="button" id="copyBtn">${t.copy}</button><button type="button" id="clearBtn">${t.clear}</button></div></div>
<div class="tot"><span>${t.spend} <b id="tSpend"></b></span><span>${t.tMand} <b id="tMand"></b></span><span>${t.tOpt} <b id="tOpt"></b></span><span><b id="tN"></b> ${t.n}</span></div>
<div id="empty" hidden>${t.empty}</div>
<div id="table"></div>
<script>${script}</script>
</body></html>`;
}
