import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

/**
 * The plugin architecture as an interactive graph, in the style of the landing
 * hero. The core is the hub; every plugin orbits it and points at it (a plugin
 * depends on the core, never the other way). Hover, focus, or drag a node to see
 * what it does and jump to its page. Theme-aware off the data-theme attribute.
 */

const REDUCED =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Kind = "data" | "behavior" | "harness";

type PNode = {
  id: string;
  label: string;
  kind: Kind | "core";
  x: number;
  y: number;
  hub?: boolean;
  blurb: string;
  href?: string;
};

const NODES: PNode[] = [
  { id: "core", label: "core", kind: "core", x: 50, y: 50, hub: true, blurb: "Your notes plus ingest, recall, and check. The one thing every plugin depends on, and it knows about none of them." },
  { id: "anti-slop", label: "anti-slop", kind: "behavior", x: 50, y: 15, blurb: "Rules that keep your assistant's prose from reading like AI.", href: "/plugins/anti-slop/" },
  { id: "character", label: "character", kind: "behavior", x: 78, y: 26, blurb: "A voice and standards your assistant writes in.", href: "/plugins/character/" },
  { id: "whenful", label: "whenful", kind: "data", x: 89, y: 50, blurb: "Your Whenful tasks, shown on the notes they relate to.", href: "/plugins/whenful/" },
  { id: "kleinanzeigen", label: "kleinanzeigen", kind: "data", x: 78, y: 75, blurb: "Sorts hostile marketplace messages, drafts the replies, you press send.", href: "/plugins/kleinanzeigen/" },
  { id: "timemachine", label: "timemachine", kind: "harness", x: 50, y: 86, blurb: "Snapshots your work before each change, so you can undo what the agent breaks.", href: "/plugins/timemachine/" },
  { id: "statusline", label: "statusline", kind: "harness", x: 22, y: 75, blurb: "Model, branch, context, cost, rate-limit windows, clock.", href: "/plugins/statusline/" },
  { id: "telegram", label: "telegram", kind: "harness", x: 11, y: 50, blurb: "Your vault from your phone. Text a bot, the answer comes from your notes.", href: "/plugins/telegram/" },
  { id: "session-host", label: "session-host", kind: "harness", x: 22, y: 26, blurb: "Holds your logged-in sessions and hands out a fresh token over localhost.", href: "/plugins/session-host/" },
];

const byId: Record<string, PNode> = Object.fromEntries(NODES.map((n) => [n.id, n]));

const PALETTE = {
  dark: {
    kind: { core: "#80e7a8", data: "#45d2ca", behavior: "#5fd49a", harness: "#e6b65f" },
    edgeOn: "rgba(128,231,168,0.55)",
    edgeOff: "rgba(160,167,160,0.16)",
    nodeBg: "rgba(16,19,23,0.94)",
    nodeBorder: "rgba(39,44,51,0.9)",
    onText: "#eceae4",
    offText: "#71756f",
    focusText: "#08130d",
    popupBg: "rgba(12,14,18,0.97)",
    popupShadow: "0 24px 60px -20px rgba(0,0,0,0.72)",
  },
  light: {
    kind: { core: "#0e9e6a", data: "#0d9488", behavior: "#178a4e", harness: "#c2641e" },
    edgeOn: "rgba(23,138,78,0.5)",
    edgeOff: "rgba(120,123,109,0.22)",
    nodeBg: "rgba(251,249,242,0.96)",
    nodeBorder: "rgba(221,215,199,0.95)",
    onText: "#1b1d1a",
    offText: "#8b8d81",
    focusText: "#f3fffd",
    popupBg: "rgba(251,249,242,0.98)",
    popupShadow: "0 24px 60px -20px rgba(60,50,30,0.30)",
  },
};

function usePalette() {
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

export default function PluginGraph() {
  const C = usePalette();
  const ref = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>(
    Object.fromEntries(NODES.map((n) => [n.id, { x: n.x, y: n.y }])),
  );
  const [focus, setFocus] = useState<string | null>("core");
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setCompact(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  function pct(clientX: number, clientY: number) {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.max(7, Math.min(93, ((clientX - r.left) / r.width) * 100)),
      y: Math.max(7, Math.min(93, ((clientY - r.top) / r.height) * 100)),
    };
  }

  const f = focus ? byId[focus] : null;

  function popupStyle(): React.CSSProperties {
    if (!f) return {};
    if (compact) return { left: "0.5rem", right: "0.5rem", bottom: "0.5rem" };
    const p = pos[f.id];
    const s: React.CSSProperties = { width: "15.5rem" };
    if (p.x >= 50) s.right = `calc(${(100 - p.x).toFixed(1)}% + 16px)`;
    else s.left = `calc(${p.x.toFixed(1)}% + 16px)`;
    if (p.y >= 50) s.bottom = `calc(${(100 - p.y).toFixed(1)}% - 14px)`;
    else s.top = `calc(${p.y.toFixed(1)}% - 14px)`;
    return s;
  }

  const kindColor = (n: PNode) => C.kind[n.kind];

  return (
    <div className="pg-wrap" onPointerLeave={() => { if (!dragId.current) setFocus("core"); }}>
      <style>{`
        @keyframes pgFloat { 0%,100%{transform:translate(-50%,-50%)} 50%{transform:translate(-50%,calc(-50% - 4px))} }
        .pg-node.floaty { animation: pgFloat 6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce){ .pg-node.floaty { animation: none; } }
      `}</style>

      <div ref={ref} className="relative h-[26rem] w-full touch-none select-none sm:h-[30rem]">
        {/* glow behind the core */}
        <div
          className="pointer-events-none absolute h-56 w-56 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: `${pos.core.x}%`, top: `${pos.core.y}%`, background: `radial-gradient(circle, ${kindColor(byId.core)}22, transparent 70%)` }}
        />

        {/* edges: every plugin -> core */}
        <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
          {NODES.filter((n) => !n.hub).map((n) => {
            const pa = pos[n.id]; const pb = pos.core;
            const on = focus === "core" || focus === n.id;
            return (
              <line key={n.id} x1={`${pa.x}%`} y1={`${pa.y}%`} x2={`${pb.x}%`} y2={`${pb.y}%`}
                stroke={on ? C.edgeOn : C.edgeOff} strokeWidth={on ? 1.6 : 1}
                style={{ transition: "stroke .3s, stroke-width .3s" }} />
            );
          })}
        </svg>

        {/* nodes */}
        {NODES.map((n) => {
          const p = pos[n.id];
          const isFocus = n.id === focus;
          const on = !focus || isFocus || (focus === "core" && !n.hub) || (n.hub && focus !== null) || focus === n.id;
          const c = kindColor(n);
          return (
            <button
              key={n.id} type="button" aria-label={n.label}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); dragId.current = n.id; setFocus(n.id); }}
              onPointerMove={(e) => { if (dragId.current === n.id) setPos((s) => ({ ...s, [n.id]: pct(e.clientX, e.clientY) })); }}
              onPointerUp={(e) => { if (dragId.current === n.id) { e.currentTarget.releasePointerCapture(e.pointerId); dragId.current = null; } }}
              onPointerCancel={() => { dragId.current = null; }}
              onPointerEnter={() => { if (!dragId.current) setFocus(n.id); }}
              onFocus={() => setFocus(n.id)}
              className={`pg-node group absolute flex cursor-grab items-center gap-1.5 rounded-full border active:cursor-grabbing ${n.hub ? "px-4 py-2.5" : "px-2.5 py-1.5"} ${dragId.current === n.id ? "" : "floaty"}`}
              style={{
                left: `${p.x}%`, top: `${p.y}%`, transform: "translate(-50%, -50%)",
                background: isFocus || n.hub ? c : C.nodeBg,
                borderColor: c,
                borderWidth: n.hub ? 2.5 : 1.5,
                color: isFocus || n.hub ? C.focusText : on ? C.onText : C.offText,
                opacity: on ? 1 : 0.45,
                boxShadow: n.hub ? `0 0 30px -4px ${c}` : isFocus ? `0 0 22px -6px ${c}` : "none",
                zIndex: isFocus ? 3 : n.hub ? 2 : 1,
                animationDelay: `${(n.x % 5) * 0.45}s`,
                transition: "opacity .3s, color .3s, background .3s, border-color .3s, box-shadow .3s",
              }}
            >
              {!n.hub && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: isFocus ? C.focusText : c }} />}
              <span className={`whitespace-nowrap font-mono ${n.hub ? "text-[15px] font-bold" : "text-[11px]"}`}>{n.label}</span>
            </button>
          );
        })}

        {/* preview card */}
        {f && (
          <motion.div
            key={f.id}
            initial={REDUCED ? false : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="absolute z-20 rounded-xl border p-3.5"
            style={{ ...popupStyle(), background: C.popupBg, borderColor: C.nodeBorder, boxShadow: C.popupShadow, backdropFilter: "blur(8px)" }}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: kindColor(f) }} />
              <span className="font-mono text-[13px] font-semibold" style={{ color: C.onText }}>{f.label}</span>
              <span className="ml-auto font-mono text-[10px] uppercase tracking-wider" style={{ color: kindColor(f) }}>
                {f.kind === "core" ? "the core" : f.kind}
              </span>
            </div>
            <p className="text-[12.5px] leading-snug" style={{ color: C.offText }}>{f.blurb}</p>
            {f.href && (
              <a href={f.href} className="mt-2 inline-block font-mono text-[11px] font-medium underline decoration-dotted underline-offset-2"
                style={{ color: kindColor(f) }}>
                read more →
              </a>
            )}
          </motion.div>
        )}
      </div>

      <p className="mt-2 text-center font-mono text-[10px]" style={{ color: C.offText }}>
        hover or drag a node. arrows point one way: a plugin depends on the core, the core on nothing.
      </p>
    </div>
  );
}
