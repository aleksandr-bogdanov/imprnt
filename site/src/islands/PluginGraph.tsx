import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

/**
 * The plugin architecture as an interactive graph. The core is the hub; the
 * three plugin KINDS orbit it and depend on it (a kind depends on the core,
 * never the other way). It shows categories, not individual plugins, so adding
 * or removing a plugin never touches this graph. Hover or drag a kind to read
 * what it is.
 *
 * Inline styles only: this renders inside Starlight docs, which do not load the
 * site's Tailwind. Colors come from Starlight's --sl-* tokens plus a theme-aware
 * palette read from the data-theme attribute.
 */

const REDUCED =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const MONO = "var(--sl-font-mono, ui-monospace, monospace)";
const SANS = "var(--sl-font, system-ui, sans-serif)";

type Kind = "data" | "behavior" | "harness" | "core";

type Line = { text: string; em?: string };
type PNode = {
  id: Kind;
  label: string;
  tag: string;
  x: number;
  y: number;
  hub?: boolean;
  lines: Line[];
};

// Three kinds orbit the core: one above, two below and symmetric. Positions are
// tuned so the core sits at the visual center with roughly equal vertical space
// above it (to Data) and below it (to the Behavior/Harness pair), which reads as
// balanced even though that means the connectors are not pixel-equal. The box is
// a short rectangle (6/5 on desktop, 5/6 on mobile) sized to hug the cluster
// without a big empty band. NODES carries the desktop layout; COMPACT_POS holds
// the mobile one. x/y are percentages of the box.
const NODES: PNode[] = [
  { id: "core", label: "core", tag: "vault + ingest · recall · check", x: 50, y: 50, hub: true, lines: [
    { text: "Your notes plus three commands.", em: "three commands" },
    { text: "Every plugin depends on it.", em: "Every plugin" },
    { text: "It knows about none of them.", em: "none of them" },
  ] },
  { id: "data", label: "Data", tag: "mirror a service, propose notes", x: 50, y: 18, lines: [
    { text: "Mirrors an outside service into your folder.", em: "outside service" },
    { text: "A sync command you run refreshes it.", em: "sync command" },
    { text: "It proposes notes for you to approve, never writing on its own.", em: "you approve" },
  ] },
  { id: "behavior", label: "Behavior", tag: "a prompt fragment you wire in", x: 76, y: 80, lines: [
    { text: "Feeds the assistant a fixed prompt fragment you wire in.", em: "prompt fragment" },
    { text: "The vault never force-feeds it.", em: "never force-feeds" },
    { text: "Removing it is deleting one line.", em: "one line" },
  ] },
  { id: "harness", label: "Harness", tag: "change the session runtime", x: 24, y: 80, lines: [
    { text: "Changes the session runtime, like a hook or the status line.", em: "session runtime" },
    { text: "Plain claude stays plain.", em: "Plain claude" },
    { text: "Only sessions you start with imp see it.", em: "imp" },
  ] },
];

// Mobile layout: a taller 5/6 box. Same balanced spirit as desktop with the core
// centered and Data above, the lower pair spread a bit wider so nothing crowds
// the core.
const COMPACT_POS: Record<string, { x: number; y: number }> = {
  core: { x: 50, y: 50 },
  data: { x: 50, y: 18 },
  behavior: { x: 82, y: 80 },
  harness: { x: 18, y: 80 },
};

const byId: Record<string, PNode> = Object.fromEntries(NODES.map((n) => [n.id, n]));

// render one popup line, bolding the key term for scannability
function renderLine(ln: Line, strong: string) {
  if (!ln.em) return ln.text;
  const i = ln.text.indexOf(ln.em);
  if (i < 0) return ln.text;
  return (
    <>
      {ln.text.slice(0, i)}
      <strong style={{ color: strong, fontWeight: 700 }}>{ln.em}</strong>
      {ln.text.slice(i + ln.em.length)}
    </>
  );
}

const PALETTE = {
  dark: {
    kind: { core: "#80e7a8", data: "#45d2ca", behavior: "#5fd49a", harness: "#e6b65f" },
    edgeOn: "rgba(128,231,168,0.6)",
    edgeOff: "rgba(160,167,160,0.2)",
    nodeBg: "rgba(16,19,23,0.96)",
    onText: "#eceae4",
    subText: "#c2c5bd",
    focusText: "#08130d",
    popupBg: "rgba(12,14,18,0.97)",
    popupShadow: "0 24px 60px -20px rgba(0,0,0,0.72)",
  },
  light: {
    kind: { core: "#0e9e6a", data: "#0d9488", behavior: "#178a4e", harness: "#c2641e" },
    edgeOn: "rgba(23,138,78,0.55)",
    edgeOff: "rgba(120,123,109,0.28)",
    nodeBg: "#ffffff",
    onText: "#15171a",
    subText: "#43463e",
    focusText: "#ffffff",
    popupBg: "#ffffff",
    popupShadow: "0 18px 48px -18px rgba(60,50,30,0.34)",
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
  const [focus, setFocus] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => {
      setCompact(mq.matches);
      // Re-seed the layout for the active breakpoint, leaving a node mid-drag put.
      const layout = mq.matches
        ? COMPACT_POS
        : Object.fromEntries(NODES.map((n) => [n.id, { x: n.x, y: n.y }]));
      setPos((s) =>
        Object.fromEntries(NODES.map((n) => [n.id, dragId.current === n.id ? s[n.id] : layout[n.id]])),
      );
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  function pct(clientX: number, clientY: number) {
    const r = ref.current!.getBoundingClientRect();
    return {
      x: Math.max(10, Math.min(90, ((clientX - r.left) / r.width) * 100)),
      y: Math.max(8, Math.min(92, ((clientY - r.top) / r.height) * 100)),
    };
  }

  const f = focus ? byId[focus] : null;
  const kindColor = (n: PNode) => C.kind[n.id];

  function popupStyle(): React.CSSProperties {
    if (!f) return {};
    if (compact) return { left: "0.5rem", right: "0.5rem", bottom: "0.5rem" };
    const p = pos[f.id];
    // Anchor the card just beside the node (the floating-tooltip look). It can
    // overlap the core or other nodes, which is fine because the card always
    // paints on top (high z-index on the popup).
    const s: React.CSSProperties = { width: "14.5rem" };
    if (p.x >= 50) s.right = `calc(${(100 - p.x).toFixed(1)}% + 22px)`;
    else s.left = `calc(${p.x.toFixed(1)}% + 22px)`;
    if (p.y >= 50) s.bottom = `calc(${(100 - p.y).toFixed(1)}% - 14px)`;
    else s.top = `calc(${p.y.toFixed(1)}% - 14px)`;
    return s;
  }

  return (
    <div
      style={{ position: "relative", margin: "1.5rem 0" }}
      onPointerLeave={() => { if (!dragId.current) setFocus(null); }}
    >
      <div
        ref={ref}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: compact ? "26rem" : "38rem",
          margin: "0 auto",
          aspectRatio: compact ? "5 / 6" : "6 / 5",
          touchAction: "none",
          userSelect: "none",
        }}
      >
        {/* glow behind the core */}
        <div
          style={{
            position: "absolute", left: `${pos.core.x}%`, top: `${pos.core.y}%`,
            width: "16rem", height: "16rem", transform: "translate(-50%, -50%)",
            borderRadius: "9999px", pointerEvents: "none",
            background: `radial-gradient(circle, ${kindColor(byId.core)}26, transparent 70%)`,
          }}
        />

        {/* edges: every kind -> core */}
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }} aria-hidden="true">
          {NODES.filter((n) => !n.hub).map((n) => {
            const pa = pos[n.id]; const pb = pos.core;
            const on = focus === null || focus === n.id;
            return (
              <line key={n.id} x1={`${pa.x}%`} y1={`${pa.y}%`} x2={`${pb.x}%`} y2={`${pb.y}%`}
                stroke={on ? C.edgeOn : C.edgeOff} strokeWidth={on ? 2 : 1.25}
                style={{ transition: "stroke .3s, stroke-width .3s" }} />
            );
          })}
        </svg>

        {/* nodes */}
        {NODES.map((n) => {
          const p = pos[n.id];
          const isFocus = n.id === focus;
          const on = !focus || isFocus;
          const c = kindColor(n);
          const filled = isFocus || n.hub;
          return (
            <button
              key={n.id} type="button" aria-label={n.label}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); dragId.current = n.id; setFocus(n.id); }}
              onPointerMove={(e) => { if (dragId.current === n.id) setPos((s) => ({ ...s, [n.id]: pct(e.clientX, e.clientY) })); }}
              onPointerUp={(e) => { if (dragId.current === n.id) { e.currentTarget.releasePointerCapture(e.pointerId); dragId.current = null; } }}
              onPointerCancel={() => { dragId.current = null; }}
              onPointerEnter={() => { if (!dragId.current) setFocus(n.id); }}
              onFocus={() => setFocus(n.id)}
              style={{
                position: "absolute", left: `${p.x}%`, top: `${p.y}%`, transform: "translate(-50%, -50%)",
                display: "flex", flexDirection: "column", alignItems: "center", gap: "0.12rem",
                width: n.hub ? "11.5rem" : "10.5rem",
                padding: "0.7rem 0.9rem",
                borderRadius: 16,
                borderStyle: "solid", borderWidth: 2, borderColor: c,
                background: filled ? c : C.nodeBg,
                color: filled ? C.focusText : C.onText,
                opacity: on ? 1 : 0.5,
                boxShadow: filled ? `0 0 32px -6px ${c}` : "0 4px 16px -6px rgba(20,22,18,0.28)",
                zIndex: isFocus ? 4 : n.hub ? 3 : 2,
                cursor: "grab",
                font: "inherit",
                transition: "opacity .3s, color .3s, background .3s, box-shadow .3s",
              }}
            >
              <span style={{ whiteSpace: "nowrap", fontFamily: MONO, fontSize: 13, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>{n.label}</span>
              <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 500, color: filled ? C.focusText : C.subText, opacity: filled ? 0.85 : 1, textAlign: "center", lineHeight: 1.3 }}>{n.tag}</span>
            </button>
          );
        })}

        {/* floating preview card, anchored beside the focused node. Very high
            z-index so it always paints above every node. */}
        {f && !f.hub && (
          <motion.div
            key={f.id}
            initial={REDUCED ? false : { opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            style={{
              position: "absolute", zIndex: 9999, borderRadius: 13, padding: "0.75rem 0.85rem",
              background: C.popupBg, boxShadow: C.popupShadow, backdropFilter: "blur(8px)",
              ...popupStyle(),
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", marginBottom: "0.45rem" }}>
              <span style={{ width: 9, height: 9, flexShrink: 0, borderRadius: "9999px", background: kindColor(f) }} />
              <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 700, color: C.onText }}>{f.label}</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
              {f.lines.map((ln, i) => (
                <p key={i} style={{ margin: 0, fontFamily: SANS, fontSize: 12.5, lineHeight: 1.4, color: C.subText }}>{renderLine(ln, C.onText)}</p>
              ))}
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
