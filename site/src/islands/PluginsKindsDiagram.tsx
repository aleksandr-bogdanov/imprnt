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
 * size and legible.
 *
 * The interaction IS the lesson: each card carries a live switch. Flip a kind
 * off and its connector goes dashed, its card dims, and the "edits to core: 0"
 * counter on the hub gives a little bump without ever changing, because removing
 * a plugin touches zero core code. Idle pulses travel UP each connector (the
 * kinds depend on the core, never the reverse). Everything animated is gated
 * behind prefers-reduced-motion: with it set, switches still flip every state,
 * nothing moves on its own.
 *
 * Inline styles only (plus one scoped <style> block for keyframes): this renders
 * inside Starlight docs, which do not load the site's Tailwind. Colors come from
 * Starlight's --sl-* tokens plus a theme-aware palette read from the data-theme
 * attribute.
 */

const MONO = "var(--sl-font-mono, ui-monospace, monospace)";
const SANS = "var(--sl-font, system-ui, sans-serif)";

const REDUCED =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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

// the fan's three connector paths in the 1000x32 viewBox. The card grid is 3
// equal columns inside max-width 44rem with a 1rem gap, so each card is 14rem
// wide and its center sits at 7/44, 22/44, 37/44 of the band width = x159,
// x500, x841. The outer two arcs are exact reflections about x500.
const PATHS: Record<string, string> = {
  data: "M500 0 C500 18, 159 14, 159 32",
  behavior: "M500 0 L500 32",
  harness: "M500 0 C500 18, 841 14, 841 32",
};

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
  // which kinds the reader has switched off, the last flip (drives the moral
  // caption), and a counter that re-triggers the hub chip's bump animation
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [last, setLast] = useState<{ id: string; on: boolean } | null>(null);
  const [bump, setBump] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);

  const toggle = (id: string) => {
    const nowOff = !off[id];
    setOff((o) => ({ ...o, [id]: nowOff }));
    setLast({ id, on: !nowOff });
    setBump((b) => b + 1);
  };

  const lastKind = last ? KINDS.find((k) => k.id === last.id) ?? null : null;
  const lastColor = lastKind ? (C.kind as Record<string, string>)[lastKind.id] : C.core;

  const moral: ReactNode = (() => {
    if (!last || !lastKind) {
      return <>Each kind leans on the core, and the core depends on none of them. Flip a switch to pull one out and watch the counter.</>;
    }
    if (!last.on) {
      return (
        <>
          <strong style={{ color: lastColor, fontWeight: 700 }}>{lastKind.label}</strong> is out: its folder and its one wiring line are gone. The counter did not move.
        </>
      );
    }
    return (
      <>
        <strong style={{ color: lastColor, fontWeight: 700 }}>{lastKind.label}</strong> is back. Removing and re-adding it both left the core untouched.
      </>
    );
  })();

  return (
    <div
      role="group"
      aria-label="The three plugin kinds and the core they depend on"
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
      {/* core hub, with the live counter that the whole interaction exists to
          keep at zero */}
      <div
        className="pkd-rise"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "0.3rem",
          padding: narrow ? "0.85rem 1.2rem" : "0.95rem 1.7rem",
          borderRadius: 16,
          background: C.coreBg,
          color: C.coreText,
          boxShadow: `0 0 38px -8px ${C.core}`,
          textAlign: "center",
          maxWidth: "30rem",
        }}
      >
        <span style={{ fontFamily: MONO, fontSize: narrow ? 17 : 19, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", lineHeight: 1 }}>
          core
        </span>
        <span style={{ fontFamily: MONO, fontSize: narrow ? 11.5 : 12.5, fontWeight: 600, opacity: 0.82 }}>
          vault + ingest &middot; recall &middot; check
        </span>
        <span
          key={bump}
          className={bump > 0 && !REDUCED ? "pkd-bump" : undefined}
          style={{
            fontFamily: MONO,
            fontSize: narrow ? 10 : 10.5,
            fontWeight: 700,
            letterSpacing: "0.08em",
            padding: "0.2rem 0.6rem",
            borderRadius: 999,
            background: "color-mix(in oklab, #000 18%, transparent)",
            color: C.coreText,
          }}
        >
          edits to core: 0
        </span>
      </div>

      {/* connector band: a fan from the core down into each kind. All three
          branches start from the CORE's bottom-center (apex x500 y0) and end at
          the horizontal center of the card beneath them (geometry documented on
          PATHS). preserveAspectRatio="none" stretches the viewBox to the live
          width and non-scaling-stroke keeps every line a uniform stroke. The
          negative top/bottom margins pull the apex up to the CORE box and the
          endpoints down onto the card tops. Pulses ride each installed kind's
          path UPWARD (keyPoints 1 -> 0): the kind reaches into the core's notes,
          never the reverse. A switched-off kind's line goes dashed and faint and
          its pulse stops. On narrow the cards stack in one column, so the fan is
          meaningless: drop it and let the stacked order carry the relationship. */}
      {!narrow && (
        <svg
          className="pkd-rise"
          width="100%"
          height={32}
          viewBox="0 0 1000 32"
          preserveAspectRatio="none"
          aria-hidden="true"
          style={{ maxWidth: "44rem", marginTop: "-0.3rem", marginBottom: "-0.85rem", animationDelay: "0.1s" }}
        >
          {KINDS.map((k, i) => {
            const c = (C.kind as Record<string, string>)[k.id];
            const isOff = !!off[k.id];
            const isHot = hovered === k.id && !isOff;
            return (
              <g key={k.id}>
                <path
                  id={`pkdP-${k.id}`}
                  d={PATHS[k.id]}
                  fill="none"
                  stroke={c}
                  strokeWidth={isHot ? 3.4 : 2.4}
                  opacity={isOff ? 0.28 : isHot ? 1 : 0.7}
                  strokeDasharray={isOff ? "5 7" : undefined}
                  vectorEffect="non-scaling-stroke"
                  strokeLinecap="round"
                  style={{ transition: "opacity 0.3s ease, stroke-width 0.2s ease" }}
                />
                {!REDUCED && !isOff && (
                  <circle r="3.2" fill={c} opacity="0">
                    <animateMotion dur="3s" begin={`${i * 0.9}s`} repeatCount="indefinite" calcMode="linear" keyPoints="1;0" keyTimes="0;1">
                      <mpath href={`#pkdP-${k.id}`} />
                    </animateMotion>
                    <animate attributeName="opacity" values="0;0.9;0.9;0" keyTimes="0;0.18;0.8;1" dur="3s" begin={`${i * 0.9}s`} repeatCount="indefinite" />
                  </circle>
                )}
              </g>
            );
          })}
        </svg>
      )}

      {/* the three kind cards. align-items:start lets each card be content-tall
          instead of stretching to the tallest sibling, so the bottom padding is
          identical across the three even though the body text differs in length.
          The label row and the tag share a fixed top block (the tag's minHeight
          keeps the body's first line aligned across all three), so the tops still
          read as one row while the bottom inset stays even. */}
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
        {KINDS.map((k, i) => {
          const c = (C.kind as Record<string, string>)[k.id];
          const isOff = !!off[k.id];
          // Even out the inset border weight across hues: teal reads heaviest at
          // the same mix, so give it a lower percentage and lift the green/orange
          // so the three strokes land at one visual weight.
          const borderMix = { data: 30, behavior: 40, harness: 42 }[k.id] ?? 38;
          return (
            <div
              key={k.id}
              className="pkd-rise pkd-card"
              onMouseEnter={() => setHovered(k.id)}
              onMouseLeave={() => setHovered((h) => (h === k.id ? null : h))}
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
                boxShadow: isOff
                  ? `inset 0 0 0 1.5px color-mix(in oklab, ${c} 14%, transparent)`
                  : `0 8px 26px -16px ${c}, inset 0 0 0 1.5px color-mix(in oklab, ${c} ${borderMix}%, transparent)`,
                animationDelay: `${0.16 + i * 0.08}s`,
                // transform is listed here too (inline style would otherwise
                // clobber a class transition), the class supplies the hover lift
                transition: "transform 0.16s ease, box-shadow 0.3s ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 11,
                    height: 11,
                    flexShrink: 0,
                    borderRadius: 9999,
                    background: isOff ? "transparent" : c,
                    boxShadow: isOff ? `inset 0 0 0 1.5px color-mix(in oklab, ${c} 55%, transparent)` : "none",
                    transition: "background 0.25s ease, box-shadow 0.25s ease",
                  }}
                />
                <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: C.onText, opacity: isOff ? 0.6 : 1, transition: "opacity 0.25s ease" }}>
                  {k.label}
                </span>
                {/* the live switch: flipping it is "imprnt plugin rm" in
                    miniature, and the hub counter above shrugs */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={!isOff}
                  aria-label={`${k.label} kind installed`}
                  className="pkd-switch"
                  onClick={() => toggle(k.id)}
                  style={{
                    marginLeft: "auto",
                    position: "relative",
                    width: 34,
                    height: 19,
                    flexShrink: 0,
                    padding: 0,
                    border: "none",
                    borderRadius: 999,
                    cursor: "pointer",
                    background: isOff ? `color-mix(in oklab, ${C.subText} 34%, transparent)` : c,
                    transition: "background 0.2s ease",
                    color: c,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      top: 2.5,
                      left: isOff ? 2.5 : 17.5,
                      width: 14,
                      height: 14,
                      borderRadius: 9999,
                      background: C.cardBg,
                      boxShadow: "0 1px 3px rgba(0,0,0,0.35)",
                      transition: "left 0.18s ease",
                    }}
                  />
                </button>
              </div>
              {/* the tagline is a plain-English summary, so set it in the sans
                  body font in a muted body color. monospace + code color made
                  these phrases read as literal commands. the accent color stays
                  on the dot and title only */}
              <span style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: 500, lineHeight: 1.4, minHeight: narrow ? "auto" : "2.4em", display: "flex", alignItems: "flex-start", color: C.subText, opacity: isOff ? 0.5 : 1, transition: "opacity 0.25s ease" }}>{k.tag}</span>
              <p style={{ margin: 0, fontFamily: SANS, fontSize: 13, lineHeight: 1.5, color: C.capText, opacity: isOff ? 0.5 : 1, transition: "opacity 0.25s ease" }}>
                {k.renderCaption ? k.renderCaption(C) : caption(k.caption, k.em, C.onText)}
              </p>
            </div>
          );
        })}
      </div>

      {/* the moral, live-updating as switches flip */}
      <p
        aria-live="polite"
        className="pkd-rise"
        style={{
          margin: 0,
          minHeight: "2.8em",
          fontFamily: SANS,
          fontSize: narrow ? 12.5 : 13,
          lineHeight: 1.4,
          color: C.subText,
          textAlign: "center",
          maxWidth: "32rem",
          animationDelay: "0.4s",
        }}
      >
        {moral}
      </p>

      <style>{`
        @keyframes pkdRise {
          from { opacity: 0; transform: translateY(14px); }
          to { opacity: 1; transform: none; }
        }
        .pkd-rise { animation: pkdRise 0.6s cubic-bezier(0.22, 0.65, 0.3, 1) backwards; }
        @keyframes pkdBump {
          0% { transform: scale(1); }
          35% { transform: scale(1.18); }
          100% { transform: scale(1); }
        }
        .pkd-bump { animation: pkdBump 0.45s ease-out; }
        .pkd-card:hover { transform: translateY(-2px); }
        .pkd-switch:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) {
          .pkd-rise, .pkd-bump { animation: none; }
          .pkd-card, .pkd-card:hover { transform: none; transition: none; }
        }
      `}</style>
    </div>
  );
}
