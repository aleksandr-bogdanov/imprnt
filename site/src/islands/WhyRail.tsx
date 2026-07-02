import { useEffect, useRef, useState } from "react";

/**
 * Page-specific (why-imprnt): the origin-story arc as an interactive rail in the
 * right sidebar, replacing Starlight's "On this page" on this page only. It
 * tracks scroll, fills a progress line down to the beat you are reading, expands
 * that beat's one-line gist, and scrolls to a beat when clicked. The beats anchor
 * to invisible <span class="beat-anchor"> markers placed through the article.
 *
 * Inline styles only (Starlight docs do not load the site's Tailwind). Colors
 * come from a theme-aware palette read off data-theme, matching the other docs
 * islands. Shown only at >=72rem, where Starlight renders the right sidebar.
 */

const SANS = "var(--sl-font, system-ui, sans-serif)";
const MONO = "var(--sl-font-mono, ui-monospace, monospace)";
const DOT = 22;

type Beat = { id: string; label: string; gist: string };

const BEATS: Beat[] = [
  { id: "beat-bike", label: "The bike", gist: "I cannot buy anything without understanding it inside out first." },
  { id: "beat-claude", label: "Ask Claude", gist: "Brilliant answers, no memory. Every chat met a stranger." },
  { id: "beat-pai", label: "PAI", gist: "Finally a tool that remembered me, with real depth." },
  { id: "beat-v5", label: "Version 5", gist: "It grew machinery I never asked for and could not remove." },
  { id: "beat-tokens", label: "The token bill", gist: "At work, metered, the bloat ate the budget I needed to work." },
  { id: "beat-rule", label: "A colleague's rule", gist: "The model is the peer. The software you write is the servant." },
  { id: "beat-imprnt", label: "imprnt", gist: "Spend the model once to build the tool. Run the tool for free." },
  { id: "beat-keep", label: "What you keep", gist: "Plain files you can read, fix, and take anywhere." },
  { id: "beat-promise", label: "The promise", gist: "Ships with almost nothing. Everything is opt-in and removable." },
];

const PALETTE = {
  dark: {
    accent: "#80e7a8",
    accentText: "#08130d",
    onText: "#eceae4",
    subText: "#9aa099",
    heading: "#b9bcb3",
    dotBg: "rgba(160,167,160,0.18)",
    dotText: "#9aa099",
    rail: "rgba(160,167,160,0.26)",
  },
  light: {
    accent: "#0e9e6a",
    accentText: "#ffffff",
    onText: "#15171a",
    subText: "#5a5d54",
    heading: "#3a3d35",
    dotBg: "rgba(120,123,109,0.16)",
    dotText: "#5a5d54",
    rail: "rgba(120,123,109,0.3)",
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

export default function WhyRail() {
  const C = usePalette();
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLOListElement | null>(null);
  const dotRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [fill, setFill] = useState({ top: DOT / 2, full: 0, to: 0 });

  // scrollspy: the active beat is the last anchor whose top has crossed a read
  // line at 32% of the viewport height.
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const line = window.innerHeight * 0.32;
        let idx = 0;
        for (let i = 0; i < BEATS.length; i++) {
          const el = document.getElementById(BEATS[i].id);
          if (el && el.getBoundingClientRect().top <= line) idx = i;
        }
        setActive(idx);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // measure the rail: a muted line from the first dot to the last, and an accent
  // fill from the first dot down to the active one.
  useEffect(() => {
    const list = listRef.current;
    const first = dotRefs.current[0];
    const last = dotRefs.current[BEATS.length - 1];
    const cur = dotRefs.current[active];
    if (!list || !first || !last || !cur) return;
    const base = list.getBoundingClientRect().top;
    const top = first.getBoundingClientRect().top - base + DOT / 2;
    const full = last.getBoundingClientRect().top - base + DOT / 2 - top;
    const to = cur.getBoundingClientRect().top - base + DOT / 2 - top;
    setFill({ top, full, to });
  }, [active, C]);

  const go = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <nav aria-label="The story" style={{ fontFamily: SANS }}>
      <h2
        style={{
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: C.heading,
          margin: "0 0 0.9rem",
        }}
      >
        The story
      </h2>
      <ol ref={listRef} style={{ listStyle: "none", margin: 0, padding: 0, position: "relative" }}>
        <span aria-hidden style={{ position: "absolute", left: DOT / 2 - 1, top: fill.top, height: fill.full, width: 2, background: C.rail, borderRadius: 2 }} />
        <span aria-hidden style={{ position: "absolute", left: DOT / 2 - 1, top: fill.top, height: fill.to, width: 2, background: C.accent, borderRadius: 2, transition: "height 0.3s ease" }} />
        {BEATS.map((b, i) => {
          const on = i === active;
          const done = i <= active;
          return (
            <li key={b.id} style={{ position: "relative", marginBottom: i === BEATS.length - 1 ? 0 : "0.55rem" }}>
              <button
                onClick={() => go(b.id)}
                aria-current={on ? "true" : undefined}
                style={{
                  display: "grid",
                  gridTemplateColumns: `${DOT}px 1fr`,
                  gap: "0.6rem",
                  alignItems: "start",
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                }}
              >
                <span
                  ref={(el) => {
                    dotRefs.current[i] = el;
                  }}
                  style={{
                    width: DOT,
                    height: DOT,
                    borderRadius: "50%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: MONO,
                    fontSize: 11,
                    fontWeight: 600,
                    zIndex: 1,
                    background: done ? C.accent : C.dotBg,
                    color: done ? C.accentText : C.dotText,
                    transition: "background 0.25s ease, color 0.25s ease",
                  }}
                >
                  {i + 1}
                </span>
                <span style={{ paddingTop: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 13.5, fontWeight: on ? 700 : 500, color: on ? C.accent : C.onText, lineHeight: 1.3 }}>
                    {b.label}
                  </span>
                  {on && (
                    <span style={{ display: "block", marginTop: 3, fontSize: 12, lineHeight: 1.4, color: C.subText }}>
                      {b.gist}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
