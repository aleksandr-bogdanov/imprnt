import { useEffect, useState } from "react";

/**
 * The three plugin KINDS and the core they all depend on. Page-specific to
 * docs/plugins.mdx. Shows categories, never individual plugins, so adding or
 * removing a plugin never touches this diagram.
 *
 * Layout: the core sits at the top as the hub everything points back to, and the
 * three kinds sit in a row beneath it, each a large readable card with a caption
 * always visible (no hover needed to read it). The connectors are thick and
 * tinted per kind. On mobile the row restacks vertically so every card stays full
 * size and legible. The band height is constrained so the diagram reads as the
 * hero, not lost whitespace.
 *
 * Inline styles only: this renders inside Starlight docs, which do not load the
 * site's Tailwind. Colors come from Starlight's --sl-* tokens plus a theme-aware
 * palette read from the data-theme attribute.
 */

const MONO = "var(--sl-font-mono, ui-monospace, monospace)";
const SANS = "var(--sl-font, system-ui, sans-serif)";

type Kind = {
  id: string;
  label: string;
  tag: string;
  caption: string;
  em: string;
};

const KINDS: Kind[] = [
  {
    id: "data",
    label: "Data",
    tag: "mirror a service, propose notes",
    caption: "Mirrors an outside service into its own folder. A sync you run refreshes it, then it proposes notes you approve.",
    em: "outside service",
  },
  {
    id: "behavior",
    label: "Behavior",
    tag: "a prompt fragment you wire in",
    caption: "Feeds the assistant a fixed prompt fragment you wire in. Removing it is deleting one line. The vault never force-feeds it.",
    em: "prompt fragment",
  },
  {
    id: "harness",
    label: "Harness",
    tag: "change the session runtime",
    caption: "Changes the session runtime, like a hook or the status line. Plain claude stays plain. Only imp sessions see it.",
    em: "session runtime",
  },
];

const PALETTE = {
  dark: {
    core: "#80e7a8",
    kind: { data: "#45d2ca", behavior: "#5fd49a", harness: "#e6b65f" },
    cardBg: "rgba(16,19,23,0.92)",
    coreBg: "#80e7a8",
    coreText: "#08130d",
    onText: "#eceae4",
    subText: "#b9bcb3",
    capText: "#c9ccc3",
    edge: "rgba(160,167,160,0.32)",
  },
  light: {
    core: "#0e9e6a",
    kind: { data: "#0d9488", behavior: "#178a4e", harness: "#c2641e" },
    cardBg: "#ffffff",
    coreBg: "#0e9e6a",
    coreText: "#ffffff",
    onText: "#15171a",
    subText: "#43463e",
    capText: "#3a3d35",
    edge: "rgba(120,123,109,0.4)",
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

function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const read = () => setNarrow(mq.matches);
    read();
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);
  return narrow;
}

function caption(text: string, em: string, color: string) {
  const i = text.indexOf(em);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <strong style={{ color, fontWeight: 700 }}>{em}</strong>
      {text.slice(i + em.length)}
    </>
  );
}

export default function PluginsKindsDiagram() {
  const C = usePalette();
  const narrow = useNarrow();

  return (
    <div
      style={{
        margin: "1.6rem 0",
        padding: narrow ? "1.4rem 1rem" : "1.7rem 1.5rem",
        borderRadius: 18,
        background: `radial-gradient(120% 90% at 50% 0%, color-mix(in oklab, ${C.core} 9%, transparent), transparent 70%)`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: narrow ? "1rem" : "0.9rem",
      }}
    >
      {/* core hub */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "0.18rem",
          padding: narrow ? "0.85rem 1.2rem" : "0.95rem 1.7rem",
          borderRadius: 16,
          background: C.coreBg,
          color: C.coreText,
          boxShadow: `0 0 38px -8px ${C.core}`,
          textAlign: "center",
          maxWidth: "30rem",
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: narrow ? 17 : 19, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          core
        </span>
        <span style={{ fontFamily: MONO, fontSize: narrow ? 11.5 : 12.5, fontWeight: 600, opacity: 0.82 }}>
          vault + ingest &middot; recall &middot; check
        </span>
      </div>

      <p
        style={{
          margin: 0,
          fontFamily: SANS,
          fontSize: narrow ? 12.5 : 13,
          lineHeight: 1.4,
          color: C.subText,
          textAlign: "center",
          maxWidth: "32rem",
        }}
      >
        Every plugin is one of three kinds. Each kind depends on the core, and the core knows about none of them.
      </p>

      {/* connector band: an arrow down to each kind */}
      <svg
        width="100%"
        height={narrow ? 18 : 30}
        viewBox="0 0 300 30"
        preserveAspectRatio="none"
        aria-hidden="true"
        style={{ maxWidth: "30rem" }}
      >
        {narrow ? (
          <line x1="150" y1="0" x2="150" y2="30" stroke={C.edge} strokeWidth="3" />
        ) : (
          <>
            <path d="M150 0 C150 14, 50 14, 50 30" fill="none" stroke={C.kind.data} strokeWidth="3" opacity="0.55" />
            <line x1="150" y1="0" x2="150" y2="30" stroke={C.kind.behavior} strokeWidth="3" opacity="0.55" />
            <path d="M150 0 C150 14, 250 14, 250 30" fill="none" stroke={C.kind.harness} strokeWidth="3" opacity="0.55" />
          </>
        )}
      </svg>

      {/* the three kind cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: narrow ? "1fr" : "repeat(3, 1fr)",
          gap: narrow ? "0.85rem" : "1rem",
          width: "100%",
          maxWidth: "44rem",
        }}
      >
        {KINDS.map((k) => {
          const c = (C.kind as Record<string, string>)[k.id];
          return (
            <div
              key={k.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.45rem",
                padding: narrow ? "0.95rem 1.05rem" : "1.05rem 1.1rem",
                borderRadius: 14,
                background: C.cardBg,
                boxShadow: `0 8px 26px -16px ${c}, inset 0 0 0 1.5px color-mix(in oklab, ${c} 38%, transparent)`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span style={{ width: 11, height: 11, flexShrink: 0, borderRadius: 9999, background: c }} />
                <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: C.onText }}>
                  {k.label}
                </span>
              </div>
              <span style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 500, color: c }}>{k.tag}</span>
              <p style={{ margin: 0, fontFamily: SANS, fontSize: 13, lineHeight: 1.5, color: C.capText }}>
                {caption(k.caption, k.em, C.onText)}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
