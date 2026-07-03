import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

/**
 * The hero: the real Meridian example vault as an interactive knowledge graph,
 * styled after Obsidian's hover preview. Hover or drag a node to open its note
 * next to it. The note's links are clickable and re-focus the graph, so you can
 * walk the graph from inside the preview. Moving off the graph closes it.
 * Data mirrors examples/organization/.
 *
 * Layout adapts to width. On desktop the note preview floats beside the focused
 * node and any pill it would cover drops its label so no label is ever bisected.
 * On phones the nodes sit in a tightened cluster that stays fully in frame, and
 * the note preview drops in below the cluster instead of over it.
 */

const REDUCED =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type TypeKey = "person" | "org" | "project" | "event" | "mistake" | "principle";

const TYPE: Record<TypeKey, { color: string; label: string }> = {
  person: { color: "#5fd49a", label: "person" },
  org: { color: "#45d2ca", label: "org" },
  project: { color: "#e6b65f", label: "project" },
  event: { color: "#85a9ff", label: "event" },
  mistake: { color: "#f3796f", label: "mistake" },
  principle: { color: "#bd97f5", label: "principle" },
};

type Node = {
  id: string; label: string; type: TypeKey; x: number; y: number; hub?: boolean;
  path: string; title: string; meta: string; summary: string; facts: string[];
};

const NODES: Node[] = [
  { id: "meridian", label: "Meridian", type: "org", x: 50, y: 46, hub: true, path: "orgs/meridian.md", title: "Meridian", meta: "status: active", summary: "Field-service scheduling and billing SaaS. The company this vault covers.", facts: ["Software for plumbers, electricians, HVAC", "~9 people", "Q2 2026 priority is billing-v2"] },
  { id: "billing", label: "billing-v2", type: "project", x: 74, y: 54, hub: true, path: "projects/billing-v2.md", title: "Billing v2", meta: "owner: Tom Decker · active", summary: "The Q2 priority. No new pricing ships until billing is solid.", facts: ["P0: idempotency keys on charge creation, 2-week target", "P0: duplicate-charge metric + pager alert", "P1: invoice redesign (Lena), dunning emails", "60% of billing tickets: charged twice or no invoice"] },
  { id: "planning", label: "eng planning", type: "event", x: 28, y: 36, hub: true, path: "events/2026-05-18-eng-planning.md", title: "Engineering planning", meta: "date: 2026-05-18", summary: "Where the billing-v2 backlog was ranked and on-call was formalized.", facts: ["Present: Priya, Tom, Lena, Marcus", "Decision: billing-v2 first, no new pricing", "Tom owns it, idempotency in two weeks"] },
  { id: "priya", label: "Priya Nair", type: "person", x: 15, y: 14, path: "people/priya-nair.md", title: "Priya Nair", meta: "role: Founder / CEO", summary: "Sets quarterly priorities. Holds the line on quality over new features.", facts: ["Made the call: billing-v2 ships before any new pricing"] },
  { id: "tom", label: "Tom Decker", type: "person", x: 49, y: 14, path: "people/tom-decker.md", title: "Tom Decker", meta: "role: Engineering Lead", summary: "Owns billing-v2 and sets its priority order.", facts: ["The only person who can fix production billing today", "That bus-factor-of-one is what on-call fixes"] },
  { id: "lena", label: "Lena Brandt", type: "person", x: 84, y: 21, path: "people/lena-brandt.md", title: "Lena Brandt", meta: "role: Product Designer", summary: "Owns the invoice redesign.", facts: ["Invoice redesign is P1 in the billing-v2 backlog", "Customers cannot read the current invoice"] },
  { id: "marcus", label: "Marcus Hale", type: "person", x: 88, y: 78, path: "people/marcus-hale.md", title: "Marcus Hale", meta: "role: Support Lead", summary: "Brings the ticket data that ranks the backlog.", facts: ["60% of billing tickets are double-charge or invoice", "Joins the weekly on-call rotation with Tom in June"] },
  { id: "bramble", label: "Bramble Plumbing", type: "org", x: 56, y: 85, path: "orgs/bramble-plumbing.md", title: "Bramble Plumbing", meta: "status: active customer", summary: "One of Meridian's larger accounts.", facts: ["Trust took a hit from the April double-charge", "A reason billing-v2 is the quarter's priority"] },
  { id: "incident", label: "double-charge", type: "mistake", x: 32, y: 82, path: "mistakes/2026-05-double-charge-incident.md", title: "Double-charge incident", meta: "April 2026", summary: "A retry with no idempotency key charged some customers twice.", facts: ["Found by customers, not Meridian: no alert existed", "Lesson: idempotency is mandatory on money endpoints", "Lesson: every incident needs a metric and an alert"] },
  { id: "oncall", label: "on-call policy", type: "principle", x: 13, y: 60, path: "work/oncall-policy.md", title: "On-call policy", meta: "decided: 2026-05-18", summary: "A weekly production-billing rotation to end the bus-factor-of-one risk.", facts: ["Rotation members: Tom Decker and Marcus Hale", "Starts June 2026", "An incident is not closed without a metric and alert"] },
];

// A separate, tightened layout for phones. Every pill sits fully inside a
// ~342px-wide stage with margin to spare, and no two labelled pills overlap, so
// nothing bleeds off the viewport edge the way the desktop scatter would.
const MOBILE: Record<string, { x: number; y: number }> = {
  meridian: { x: 50, y: 30 },
  billing: { x: 70, y: 46 },
  planning: { x: 30, y: 18 },
  priya: { x: 22, y: 46 },
  tom: { x: 50, y: 12 },
  lena: { x: 76, y: 20 },
  marcus: { x: 78, y: 74 },
  bramble: { x: 55, y: 86 },
  incident: { x: 28, y: 74 },
  oncall: { x: 22, y: 62 },
};

type Edge = { a: string; b: string; why: string };
const EDGES: Edge[] = [
  { a: "meridian", b: "priya", why: "Founder & CEO" },
  { a: "meridian", b: "tom", why: "Engineering lead" },
  { a: "meridian", b: "lena", why: "Product designer" },
  { a: "meridian", b: "marcus", why: "Support lead" },
  { a: "meridian", b: "billing", why: "Its Q2 priority" },
  { a: "billing", b: "tom", why: "Owns it, sets the order" },
  { a: "billing", b: "lena", why: "Invoice redesign (P1)" },
  { a: "billing", b: "marcus", why: "Ticket data ranks the backlog" },
  { a: "billing", b: "bramble", why: "Lost trust drives the priority" },
  { a: "billing", b: "incident", why: "Triggered it, idempotency is the P0 fix" },
  { a: "billing", b: "oncall", why: "On-call keeps billing reliable" },
  { a: "planning", b: "priya", why: "Made the no-new-pricing call" },
  { a: "planning", b: "tom", why: "Took ownership of billing-v2" },
  { a: "planning", b: "lena", why: "Attended" },
  { a: "planning", b: "marcus", why: "Brought the ticket data" },
  { a: "planning", b: "billing", why: "Ranked the backlog here" },
  { a: "planning", b: "oncall", why: "Formalized on-call here" },
  { a: "planning", b: "incident", why: "The meeting was driven by it" },
  { a: "incident", b: "bramble", why: "Bramble was double-charged" },
  { a: "incident", b: "oncall", why: "Its lesson created the policy" },
  { a: "oncall", b: "tom", why: "Rotation member" },
  { a: "oncall", b: "marcus", why: "Joins the rotation in June" },
  { a: "oncall", b: "meridian", why: "Adopted company-wide" },
  { a: "tom", b: "marcus", why: "On-call partners for prod billing" },
];

const byId: Record<string, Node> = Object.fromEntries(NODES.map((n) => [n.id, n]));
function connectionsOf(id: string) {
  return EDGES.filter((e) => e.a === id || e.b === id).map((e) => ({ other: byId[e.a === id ? e.b : e.a], why: e.why }));
}
const NEIGHBORS: Record<string, Set<string>> = Object.fromEntries(
  NODES.map((n) => [n.id, new Set(connectionsOf(n.id).map((c) => c.other.id))]),
);

// Rough on-screen pill width from the label, matching the mono type + chrome
// (dot, gap, horizontal padding). Used only to test whether the note card would
// clip a pill's label, never to lay anything out.
function pillWidth(label: string, hub?: boolean) {
  return label.length * (hub ? 7.2 : 6.6) + 34;
}

// graph chrome that has to adapt to the theme (the type colours below read on
// both). Driven off the data-theme attribute the toggle sets, observed live so
// the graph reflows the instant the theme flips.
const PALETTE = {
  dark: {
    edgeOn: "rgba(128,231,168,0.55)",
    edgeOff: "rgba(160,167,160,0.13)",
    nodeBg: "rgba(16,19,23,0.94)",
    nodeBorder: "rgba(39,44,51,0.9)",
    nodeOnText: "#eceae4",
    nodeOffText: "#71756f",
    focusText: "#08130d",
    popupBg: "rgba(12,14,18,0.97)",
    popupShadow: "0 24px 60px -20px rgba(0,0,0,0.72)",
  },
  light: {
    edgeOn: "rgba(23,138,78,0.5)",
    edgeOff: "rgba(120,123,109,0.22)",
    nodeBg: "rgba(251,249,242,0.95)",
    nodeBorder: "rgba(221,215,199,0.95)",
    nodeOnText: "#1b1d1a",
    nodeOffText: "#8b8d81",
    focusText: "#08130d",
    popupBg: "rgba(251,249,242,0.98)",
    popupShadow: "0 24px 60px -20px rgba(60,50,30,0.30)",
  },
};

function useGraphPalette() {
  const [light, setLight] = useState(false);
  useEffect(() => {
    const read = () => setLight(document.documentElement.dataset.theme === "light");
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return light ? PALETTE.light : PALETTE.dark;
}

// The Obsidian-style note preview. Shared by the desktop float and the mobile
// in-flow card so the two placements never drift apart.
function NoteCard({ f, conns, onLink, C }: {
  f: Node; conns: { other: Node; why: string }[]; onLink: (id: string) => void; C: typeof PALETTE.dark;
}) {
  return (
    <>
      <div className="mb-2 flex items-center gap-2 border-b border-line pb-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: TYPE[f.type].color }} />
        <span className="truncate font-mono text-[11px] text-ink-soft">{f.path}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wider" style={{ color: TYPE[f.type].color }}>{TYPE[f.type].label}</span>
      </div>

      <p className="font-display text-sm font-semibold text-ink"># {f.title}</p>
      <p className="mt-0.5 font-mono text-[10.5px] text-ink-faint">{f.meta}</p>
      <p className="mt-2 text-[12px] leading-snug text-ink-soft">{f.summary}</p>

      <ul className="mt-2.5 space-y-1">
        {f.facts.slice(0, 3).map((fact) => (
          <li key={fact} className="flex gap-1.5 text-[11.5px] leading-snug text-ink">
            <span className="mt-1 h-1 w-1 shrink-0 rounded-full" style={{ background: TYPE[f.type].color }} />
            {fact}
          </li>
        ))}
      </ul>

      <div className="mt-2.5 border-t border-line pt-2">
        <p className="mb-1 font-mono text-[9.5px] uppercase tracking-wider text-ink-faint">linked notes</p>
        <ul className="space-y-0.5">
          {conns.slice(0, 5).map((c) => (
            <li key={c.other.id} className="flex items-baseline gap-1.5 text-[11px] leading-snug">
              <button
                type="button"
                onClick={() => onLink(c.other.id)}
                className="shrink-0 rounded font-medium underline decoration-dotted underline-offset-2 transition-colors hover:bg-white/5"
                style={{ color: TYPE[c.other.type].color }}
              >
                {c.other.label}
              </button>
              <span className="truncate text-ink-faint">{c.why}</span>
            </li>
          ))}
          {conns.length > 5 && <li className="text-[10.5px] text-ink-faint">+{conns.length - 5} more linked</li>}
        </ul>
      </div>
    </>
  );
}

export default function HeroGraph({ hintMobile }: { hintMobile?: string }) {
  const C = useGraphPalette();
  const ref = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>(
    Object.fromEntries(NODES.map((n) => [n.id, { x: n.x, y: n.y }])),
  );
  const [focus, setFocus] = useState<string | null>("billing");
  const [compact, setCompact] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // The floating card's box in stage pixels, so a pill it would cover can drop
  // its label. Desktop only; the mobile card sits below the stage.
  const [cardBox, setCardBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setCompact(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => { const r = el.getBoundingClientRect(); setSize({ w: r.width, h: r.height }); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Display coordinate for a node: the tightened phone layout when compact, the
  // live (draggable) position otherwise.
  const disp = (id: string) => (compact ? MOBILE[id] : pos[id]);

  const f = focus ? byId[focus] : null;
  const conns = focus ? connectionsOf(focus) : [];

  // Measure where the floating card landed, so overlapping pills can hide their
  // label. Runs after the card paints and whenever the focus or stage changes.
  useEffect(() => {
    if (compact || !f || !ref.current || !popupRef.current) { setCardBox(null); return; }
    const cr = ref.current.getBoundingClientRect();
    const pr = popupRef.current.getBoundingClientRect();
    setCardBox({ x1: pr.left - cr.left, y1: pr.top - cr.top, x2: pr.right - cr.left, y2: pr.bottom - cr.top });
  }, [focus, compact, size.w, size.h, C]);

  function pct(clientX: number, clientY: number) {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.max(7, Math.min(93, ((clientX - r.left) / r.width) * 100)),
      y: Math.max(6, Math.min(94, ((clientY - r.top) / r.height) * 100)),
    };
  }

  // Desktop: float the card beside the focused node, offset past the pill so the
  // card edge never cuts through the focus label.
  function popupStyle(): React.CSSProperties {
    if (!f) return {};
    const p = pos[f.id];
    const gap = Math.round(pillWidth(f.label, f.hub) / 2 + 16);
    const s: React.CSSProperties = { width: "16.5rem" };
    if (p.x >= 50) s.right = `calc(${(100 - p.x).toFixed(1)}% + ${gap}px)`;
    else s.left = `calc(${p.x.toFixed(1)}% + ${gap}px)`;
    if (p.y >= 50) s.bottom = `calc(${(100 - p.y).toFixed(1)}% - 18px)`;
    else s.top = `calc(${p.y.toFixed(1)}% - 18px)`;
    return s;
  }

  // Would this pill's label be clipped by the floating card? Only asked on
  // desktop, where the card overlaps the stage.
  function coveredByCard(n: Node): boolean {
    if (compact || !cardBox || !size.w) return false;
    const d = disp(n.id);
    const w = pillWidth(n.label, n.hub);
    const cx = (d.x / 100) * size.w;
    const cy = (d.y / 100) * size.h;
    const pad = 4;
    return (
      cx + w / 2 > cardBox.x1 - pad && cx - w / 2 < cardBox.x2 + pad &&
      cy + 14 > cardBox.y1 - pad && cy - 14 < cardBox.y2 + pad
    );
  }

  return (
    <div
      className="relative mx-auto w-full max-w-2xl"
      onPointerLeave={() => { if (!dragId.current && !compact) setFocus(null); }}
    >
      <div ref={ref} className="relative h-[20rem] w-full touch-none select-none sm:h-[28rem] lg:h-[33rem]">
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full bg-green/15 blur-[90px]" />

        {/* edges */}
        <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
          {EDGES.map((e, i) => {
            const pa = disp(e.a); const pb = disp(e.b);
            const on = !!focus && (e.a === focus || e.b === focus);
            return (
              <line key={i} x1={`${pa.x}%`} y1={`${pa.y}%`} x2={`${pb.x}%`} y2={`${pb.y}%`}
                stroke={on ? C.edgeOn : C.edgeOff}
                strokeWidth={on ? 1.5 : 1} style={{ transition: "stroke .3s, stroke-width .3s" }} />
            );
          })}
        </svg>

        {/* nodes */}
        {NODES.map((n) => {
          const p = disp(n.id); const t = TYPE[n.type];
          const isFocus = n.id === focus;
          const on = !focus || isFocus || NEIGHBORS[focus].has(n.id);
          // Drop the label (leave a dot) for pills the card would clip, and for
          // nodes outside the focused subgraph, so no label is ever bisected.
          const labelled = isFocus || (on && !coveredByCard(n));
          return (
            <button
              key={n.id} type="button" aria-label={n.title}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); dragId.current = n.id; setFocus(n.id); }}
              onPointerMove={(e) => { if (dragId.current === n.id && !compact) setPos((s) => ({ ...s, [n.id]: pct(e.clientX, e.clientY) })); }}
              onPointerUp={(e) => { if (dragId.current === n.id) { e.currentTarget.releasePointerCapture(e.pointerId); dragId.current = null; } }}
              onPointerCancel={() => { dragId.current = null; }}
              onPointerEnter={() => { if (!dragId.current) setFocus(n.id); }}
              onFocus={() => setFocus(n.id)}
              className={`group absolute flex items-center gap-1.5 rounded-full border py-1.5 ${labelled ? "px-2.5" : "px-1.5"} ${compact ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"} ${dragId.current === n.id ? "" : "node-float"}`}
              style={{
                left: `${p.x}%`, top: `${p.y}%`, transform: "translate(-50%, -50%)",
                background: isFocus ? t.color : C.nodeBg,
                borderColor: on ? t.color : C.nodeBorder,
                color: isFocus ? C.focusText : on ? C.nodeOnText : C.nodeOffText,
                opacity: on ? 1 : 0.4,
                boxShadow: isFocus ? `0 0 26px -4px ${t.color}` : "none",
                zIndex: isFocus ? 3 : on ? 2 : 1,
                transition: "opacity .3s, color .3s, background .3s, border-color .3s, box-shadow .3s",
                animationDelay: `${(n.x % 5) * 0.4}s`,
              }}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: isFocus ? C.focusText : t.color }} />
              {labelled && (
                <span className={`whitespace-nowrap font-mono ${n.hub ? "text-[12px] font-semibold" : "text-[11px]"}`}>{n.label}</span>
              )}
            </button>
          );
        })}

        {/* desktop: the note preview floats beside the focused node */}
        {!compact && f && (
          <motion.div
            ref={popupRef}
            key={f.id}
            initial={REDUCED ? false : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="absolute z-20 rounded-xl border border-line p-3.5"
            style={{ ...popupStyle(), background: C.popupBg, boxShadow: C.popupShadow, backdropFilter: "blur(8px)" }}
          >
            <NoteCard f={f} conns={conns} onLink={setFocus} C={C} />
          </motion.div>
        )}
      </div>

      {/* mobile: hint under the cluster, then the note preview drops in below it */}
      {compact && (
        <>
          {hintMobile && <p className="mt-3 text-center font-mono text-[11px] text-ink-faint">{hintMobile}</p>}
          {f && (
            <motion.div
              key={f.id}
              initial={REDUCED ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="mt-3 rounded-xl border border-line p-3.5"
              style={{ background: C.popupBg, boxShadow: C.popupShadow }}
            >
              <NoteCard f={f} conns={conns} onLink={setFocus} C={C} />
            </motion.div>
          )}
        </>
      )}

      <p className="absolute -bottom-2 right-1 hidden font-mono text-[10px] text-ink-faint lg:block">a real example vault - hover, drag, or click a link</p>
    </div>
  );
}
