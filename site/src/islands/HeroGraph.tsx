import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

/**
 * The hero: the real Meridian example vault rendered as an interactive knowledge
 * graph. Nodes are notes, colored by type. Edges are the wikilinks between them.
 * Hover or drag a node to focus it, and its note opens as a floating window.
 * Drives off real data from examples/organization/.
 */

const REDUCED =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type TypeKey = "person" | "org" | "project" | "event" | "mistake" | "principle";

const TYPE: Record<TypeKey, { color: string; soft: string }> = {
  person: { color: "#54c98a", soft: "rgba(84,201,138,0.16)" },
  org: { color: "#36c7bf", soft: "rgba(54,199,191,0.16)" },
  project: { color: "#e0b15a", soft: "rgba(224,177,90,0.16)" },
  event: { color: "#7aa2ff", soft: "rgba(122,162,255,0.16)" },
  mistake: { color: "#ef6f6f", soft: "rgba(239,111,111,0.16)" },
  principle: { color: "#b48ef0", soft: "rgba(180,142,240,0.16)" },
};

type Node = {
  id: string;
  label: string;
  type: TypeKey;
  x: number; // 0-100
  y: number; // 0-100
  hub?: boolean;
  path: string;
  fields: [string, string][];
  summary: string;
};

const NODES: Node[] = [
  { id: "meridian", label: "Meridian", type: "org", x: 50, y: 47, hub: true, path: "orgs/meridian.md", fields: [["type", "org"], ["status", "active"]], summary: "Small SaaS company for field-service scheduling. The org this vault covers." },
  { id: "billing", label: "billing-v2", type: "project", x: 74, y: 56, hub: true, path: "projects/billing-v2.md", fields: [["type", "project"], ["status", "active"], ["owner", "[[people/tom-decker]]"]], summary: "Q2 priority. Fix billing reliability before any new pricing, idempotency first." },
  { id: "planning", label: "eng planning", type: "event", x: 29, y: 38, hub: true, path: "events/2026-05-18-eng-planning.md", fields: [["type", "event"], ["date", "2026-05-18"]], summary: "Planning where Meridian ranked the billing-v2 backlog and formalized on-call." },
  { id: "priya", label: "Priya Nair", type: "person", x: 16, y: 16, path: "people/priya-nair.md", fields: [["type", "person"], ["role", "Founder / CEO"]], summary: "Founder and CEO of Meridian." },
  { id: "tom", label: "Tom Decker", type: "person", x: 49, y: 15, path: "people/tom-decker.md", fields: [["type", "person"], ["role", "Engineering Lead"]], summary: "Engineering lead at Meridian. Owns billing-v2." },
  { id: "lena", label: "Lena Brandt", type: "person", x: 82, y: 24, path: "people/lena-brandt.md", fields: [["type", "person"], ["role", "Product Designer"]], summary: "Product designer at Meridian. Owns the invoice redesign." },
  { id: "marcus", label: "Marcus Hale", type: "person", x: 88, y: 76, path: "people/marcus-hale.md", fields: [["type", "person"], ["role", "Support Lead"]], summary: "Support lead at Meridian. Joins the on-call rotation in June." },
  { id: "bramble", label: "Bramble Plumbing", type: "org", x: 58, y: 84, path: "orgs/bramble-plumbing.md", fields: [["type", "org"], ["status", "active"]], summary: "A key Meridian customer hit by the April double-charge incident." },
  { id: "incident", label: "double-charge", type: "mistake", x: 34, y: 80, path: "mistakes/2026-05-double-charge-incident.md", fields: [["type", "mistake"]], summary: "April double-charge bug from missing idempotency. Hurt trust with Bramble." },
  { id: "oncall", label: "on-call policy", type: "principle", x: 13, y: 60, path: "work/oncall-policy.md", fields: [["type", "principle"]], summary: "A weekly billing on-call rotation to end the bus-factor-of-one risk." },
];

const EDGES: [string, string][] = [
  ["meridian", "priya"], ["meridian", "tom"], ["meridian", "lena"], ["meridian", "marcus"], ["meridian", "billing"],
  ["billing", "tom"], ["billing", "lena"], ["billing", "marcus"], ["billing", "bramble"], ["billing", "incident"], ["billing", "oncall"],
  ["planning", "priya"], ["planning", "tom"], ["planning", "lena"], ["planning", "marcus"], ["planning", "meridian"], ["planning", "billing"], ["planning", "incident"], ["planning", "oncall"],
  ["incident", "bramble"], ["incident", "oncall"],
  ["oncall", "tom"], ["oncall", "marcus"], ["oncall", "meridian"],
  ["tom", "marcus"],
];

const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
const neighbors = (id: string) =>
  new Set(EDGES.filter((e) => e.includes(id)).flat().filter((x) => x !== id));

const HUBS = ["billing", "planning", "meridian"];

export default function HeroGraph() {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>(
    Object.fromEntries(NODES.map((n) => [n.id, { x: n.x, y: n.y }])),
  );
  const [focus, setFocus] = useState<string>("billing");
  const [drag, setDrag] = useState<string | null>(null);
  const touched = useRef(false);

  // auto-cycle the focus through the hubs until the visitor takes over
  useEffect(() => {
    if (REDUCED) return;
    let i = 0;
    const t = window.setInterval(() => {
      if (touched.current) return window.clearInterval(t);
      i = (i + 1) % HUBS.length;
      setFocus(HUBS[i]);
    }, 2200);
    return () => window.clearInterval(t);
  }, []);

  const toPct = useCallback((clientX: number, clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.max(6, Math.min(94, ((clientX - r.left) / r.width) * 100)),
      y: Math.max(6, Math.min(94, ((clientY - r.top) / r.height) * 100)),
    };
  }, []);

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      setPos((p) => ({ ...p, [drag]: toPct(e.clientX, e.clientY) }));
    },
    [drag, toPct],
  );

  const take = (id: string) => {
    touched.current = true;
    setFocus(id);
  };

  const nb = neighbors(focus);
  const active = (id: string) => id === focus || nb.has(id);
  const f = byId[focus];

  return (
    <div className="relative mx-auto w-full max-w-xl">
      <div
        ref={ref}
        onPointerMove={onMove}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
        className="relative aspect-[4/3.4] w-full touch-none select-none"
      >
        {/* ambient glow */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-green/15 blur-[90px]" />

        {/* edges */}
        <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
          {EDGES.map(([a, b], i) => {
            const pa = pos[a];
            const pb = pos[b];
            const on = a === focus || b === focus;
            return (
              <line
                key={i}
                x1={`${pa.x}%`}
                y1={`${pa.y}%`}
                x2={`${pb.x}%`}
                y2={`${pb.y}%`}
                stroke={on ? "rgba(128,231,168,0.55)" : "rgba(160,167,160,0.13)"}
                strokeWidth={on ? 1.5 : 1}
                style={{ transition: "stroke 0.3s, stroke-width 0.3s" }}
              />
            );
          })}
        </svg>

        {/* nodes */}
        {NODES.map((n) => {
          const p = pos[n.id];
          const t = TYPE[n.type];
          const on = active(n.id);
          const isFocus = n.id === focus;
          return (
            <button
              key={n.id}
              type="button"
              onPointerDown={(e) => {
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                setDrag(n.id);
                take(n.id);
              }}
              onPointerEnter={() => !drag && take(n.id)}
              onFocus={() => take(n.id)}
              className={`group absolute flex cursor-grab items-center gap-1.5 rounded-full border px-2.5 py-1.5 active:cursor-grabbing ${n.id === drag ? "" : "node-float"}`}
              style={{
                left: `${p.x}%`,
                top: `${p.y}%`,
                transform: "translate(-50%, -50%)",
                background: isFocus ? t.color : "rgba(19,22,25,0.85)",
                borderColor: on ? t.color : "rgba(39,44,51,0.9)",
                color: isFocus ? "#08130d" : on ? "#eceae4" : "#6c706a",
                opacity: on ? 1 : 0.5,
                boxShadow: isFocus ? `0 0 26px -4px ${t.color}` : "none",
                zIndex: isFocus ? 30 : on ? 20 : 10,
                transition: "opacity .3s, color .3s, background .3s, border-color .3s, box-shadow .3s",
                backdropFilter: "blur(4px)",
                animationDelay: `${(n.x % 5) * 0.4}s`,
              }}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: isFocus ? "#08130d" : t.color }}
              />
              <span className={`whitespace-nowrap font-mono ${n.hub ? "text-[12px] font-semibold" : "text-[11px]"}`}>
                {n.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* the floating note window for the focused node */}
      <div className="pointer-events-none absolute -bottom-2 left-0 w-[15.5rem] sm:left-2">
        <AnimatePresence mode="wait">
          <motion.div
            key={f.id}
            initial={REDUCED ? false : { opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={REDUCED ? undefined : { opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="surface-glass rounded-xl p-3.5 shadow-2xl shadow-black/50"
          >
            <div className="mb-2.5 flex items-center gap-2 border-b border-line/70 pb-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: TYPE[f.type].color }} />
              <span className="font-mono text-[11px] text-ink-faint">{f.path}</span>
            </div>
            <div className="space-y-1 font-mono text-[11px]">
              {f.fields.map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="text-ink-faint">{k}:</span>
                  <span style={{ color: TYPE[f.type].color }}>{v}</span>
                </div>
              ))}
            </div>
            <p className="mt-2.5 font-display text-[13px] font-semibold text-ink"># {f.label}</p>
            <p className="mt-1 text-[12px] leading-snug text-ink-soft">{f.summary}</p>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* hint */}
      <p className="absolute -bottom-1 right-1 hidden font-mono text-[10px] text-ink-faint sm:block">
        drag a node
      </p>
    </div>
  );
}
