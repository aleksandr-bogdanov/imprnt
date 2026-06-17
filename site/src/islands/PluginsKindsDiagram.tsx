import type { ReactNode } from "react";
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
  // optional renderer for captions that carry inline CLI commands (claude, imp),
  // which need monospace styling the single-term caption() helper cannot give
  renderCaption?: (C: ReturnType<typeof usePalette>) => ReactNode;
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
    renderCaption: (C) => (
      <>
        Changes the <strong style={{ color: C.onText, fontWeight: 700 }}>session runtime</strong>, like a hook or the status line. Plain {cmd("claude", C)} stays plain. Only {cmd("imp", C)} sessions see it.
      </>
    ),
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

// a monospace inline-code span for a CLI command (claude, imp), matching how the
// rest of the docs write the command in backticks
function cmd(text: string, C: ReturnType<typeof usePalette>) {
  return (
    <code
      style={{
        fontFamily: MONO,
        fontSize: "0.92em",
        padding: "0.04em 0.3em",
        borderRadius: 5,
        background: `color-mix(in oklab, ${C.onText} 12%, transparent)`,
        color: C.onText,
      }}
    >
      {text}
    </code>
  );
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
        // two stacked radials: the top glow tints under the CORE hub, and a soft
        // bottom one fades the tint into the page so the band dissolves instead of
        // clipping on a hard rectangular edge above the cards.
        background: `radial-gradient(120% 70% at 50% 0%, color-mix(in oklab, ${C.core} 9%, transparent), transparent 62%), radial-gradient(140% 60% at 50% 118%, color-mix(in oklab, ${C.core} 5%, transparent), transparent 70%)`,
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

      {/* the caption sits right under the CORE box, so the fan that follows reads
          as branching from the hub the sentence names into the three cards below. */}
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
        Each kind depends on the core, and the core knows about none of them.
      </p>

      {/* connector band: a fan of arrows from the core down into each kind. It sits
          between the caption and the card row so the three lines land directly on
          the card tops. All three branches start from the CORE's bottom-center
          (apex x500 y0) and end at the horizontal center of the card beneath them.
          The card grid is 3 equal columns inside max-width 44rem with a 1rem gap,
          so each card is 14rem wide and its center sits at 7/44, 22/44, 37/44 of
          the band width = x159, x500, x841 of the 1000-unit viewBox. The outer two
          arcs are exact reflections about x500 (same control offsets, mirrored), so
          the fan is symmetric; the center line gets a matching gentle S so its
          apparent length equals the arcs instead of reading shorter as a straight
          drop. preserveAspectRatio="none" stretches the viewBox to the live width
          and non-scaling-stroke keeps every line a uniform 3px regardless. The
          negative top/bottom margins pull the apex up to the CORE box and the
          endpoints down onto the card tops so each line visibly feeds its card. On
          narrow the cards stack in one column, so the fan is meaningless: drop it
          and let the stacked order carry the relationship. */}
      {!narrow && (
        <svg
          width="100%"
          height={32}
          viewBox="0 0 1000 32"
          preserveAspectRatio="none"
          aria-hidden="true"
          style={{ maxWidth: "44rem", marginTop: "-0.3rem", marginBottom: "-0.85rem" }}
        >
          <path d="M500 0 C500 18, 159 14, 159 32" fill="none" stroke={C.kind.data} strokeWidth="2.4" opacity="0.7" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
          {/* center BEHAVIOR drop: a clean straight vertical line in its green,
              same stroke weight as the side arms, replacing the old S-curve that
              read as a stray hook at the junction */}
          <path d="M500 0 L500 32" fill="none" stroke={C.kind.behavior} strokeWidth="2.4" opacity="0.7" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
          <path d="M500 0 C500 18, 841 14, 841 32" fill="none" stroke={C.kind.harness} strokeWidth="2.4" opacity="0.7" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
        </svg>
      )}

      {/* the three kind cards. align-items:start lets each card be content-tall
          instead of stretching to the tallest sibling, so the bottom padding is
          identical across the three even though the body text differs in length
          (a stretched card left a larger empty band under the shorter blurb). The
          label row and the tag share a fixed top block (the tag's minHeight keeps
          the body's first line aligned across all three), so the tops still read as
          one row while the bottom inset stays even. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: narrow ? "1fr" : "repeat(3, 1fr)",
          alignItems: "start",
          gap: narrow ? "0.85rem" : "1rem",
          width: "100%",
          maxWidth: "44rem",
        }}
      >
        {KINDS.map((k) => {
          const c = (C.kind as Record<string, string>)[k.id];
          // Even out the inset border weight across hues: teal reads heaviest at
          // the same mix, so give it a lower percentage and lift the green/orange
          // so the three strokes land at one visual weight.
          const borderMix = { data: 30, behavior: 40, harness: 42 }[k.id] ?? 38;
          return (
            <div
              key={k.id}
              style={{
                display: "flex",
                flexDirection: "column",
                height: "auto",
                alignSelf: "start",
                marginTop: 0,
                gap: "0.45rem",
                padding: narrow ? "0.95rem 1.05rem" : "1.05rem 1.1rem",
                borderRadius: 14,
                background: C.cardBg,
                boxShadow: `0 8px 26px -16px ${c}, inset 0 0 0 1.5px color-mix(in oklab, ${c} ${borderMix}%, transparent)`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span style={{ width: 11, height: 11, flexShrink: 0, borderRadius: 9999, background: c }} />
                <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: C.onText }}>
                  {k.label}
                </span>
              </div>
              {/* the tagline is a plain-English summary, so set it in the sans
                  body font in a muted body color. monospace + code color made
                  these phrases read as literal commands. the accent color stays
                  on the dot and title only */}
              <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 500, lineHeight: 1.4, minHeight: narrow ? "auto" : "2.4em", display: "flex", alignItems: "flex-start", color: C.subText }}>{k.tag}</span>
              <p style={{ margin: 0, fontFamily: SANS, fontSize: 13, lineHeight: 1.5, color: C.capText }}>
                {k.renderCaption ? k.renderCaption(C) : caption(k.caption, k.em, C.onText)}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
