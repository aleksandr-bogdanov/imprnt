import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

/**
 * The hero diagram for docs/memory-and-the-vault.mdx: memory as files you can
 * read. Your session sits on the left, the vault sits on the right as plain
 * files on disk, and between them stand the three on-demand doors (recall,
 * imprnt hot, imprnt context). Nothing crosses until the reader opens a door:
 * the click sends a request packet through that door, lights up what answers it
 * inside the vault, and returns a payload chip to the session. The idle state
 * carries the lesson itself: the vault is silent by default, and the only
 * always-on piece is the ~150-token pointer parked in the session.
 *
 * Inline styles only (Starlight docs do not load the site's Tailwind), plus one
 * scoped <style> block for the keyframes inline styles cannot express. Theme
 * comes from the data-theme MutationObserver pattern, with hues shared with the
 * plugins-page diagram. Reduced motion: clicks still switch every state, the
 * packets never fly. Categories only (note types, control files), never
 * individual notes, so nothing here goes stale.
 */

const MONO = "var(--sl-font-mono, ui-monospace, monospace)";
const SANS = "var(--sl-font, system-ui, sans-serif)";

const REDUCED =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type DoorId = "recall" | "hot" | "context";
type Phase = "idle" | "go" | "back" | "done";

const DOORS: { id: DoorId; cmd: string; role: string; brings: string }[] = [
  { id: "recall", cmd: "recall", role: "search the notes", brings: "the best hits, ranked" },
  { id: "hot", cmd: "imprnt hot", role: "the where-was-I glance", brings: "the primer + needs-review" },
  { id: "context", cmd: "imprnt context", role: "run before writing", brings: "the filing rules" },
];

// what the vault card shows: note TYPES from the schema (categories, never
// individual notes) plus the two control files the hot/context doors read.
const FILES = [
  { type: "person", bar: "72%" },
  { type: "holding", bar: "54%" },
  { type: "event", bar: "80%" },
  { type: "note", bar: "62%" },
];
// which files light up as recall's ranked hits (index -> rank shown)
const HITS: Record<number, number> = { 0: 2, 1: 1, 3: 3 };

const CTLS: { id: DoorId; name: string; sub: string }[] = [
  { id: "hot", name: "hot.md", sub: "the primer + needs-review" },
  { id: "context", name: "CLAUDE.md", sub: "the contract: the filing rules" },
];

const PALETTE = {
  dark: {
    accent: "#80e7a8",
    door: { recall: "#5fd49a", hot: "#e6b65f", context: "#45d2ca" } as Record<DoorId, string>,
    cardBg: "rgba(16,19,23,0.92)",
    onText: "#eceae4",
    subText: "#b9bcb3",
    capText: "#c9ccc3",
    faint: "#8f948c",
    line: "rgba(160,167,160,0.38)",
    barBg: "rgba(236,234,228,0.16)",
    fileBg: "rgba(236,234,228,0.055)",
    ring: "rgba(160,167,160,0.26)",
    badgeText: "#08130d",
  },
  light: {
    accent: "#0e9e6a",
    door: { recall: "#178a4e", hot: "#c2641e", context: "#0d9488" } as Record<DoorId, string>,
    cardBg: "#ffffff",
    onText: "#15171a",
    subText: "#43463e",
    capText: "#3a3d35",
    faint: "#70746b",
    line: "rgba(120,123,109,0.5)",
    barBg: "rgba(21,23,26,0.14)",
    fileBg: "rgba(21,23,26,0.045)",
    ring: "rgba(120,123,109,0.32)",
    badgeText: "#ffffff",
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

type C = ReturnType<typeof usePalette>;

function useNarrow() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 760px)");
    const read = () => setNarrow(mq.matches);
    read();
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, []);
  return narrow;
}

// a monospace inline-command span, matching how the docs write commands
function cmd(text: string, C: C, color?: string) {
  return (
    <code
      style={{
        fontFamily: MONO,
        fontSize: "0.94em",
        padding: "0.05em 0.32em",
        borderRadius: 5,
        background: `color-mix(in oklab, ${color ?? C.onText} 13%, transparent)`,
        color: color ?? C.onText,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </code>
  );
}

// the request/response packet that travels along a connector stub
function Dot({ mode, delay, color }: { mode: "go" | "back"; delay: number; color: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        top: -2.5,
        left: 0,
        width: 7,
        height: 7,
        borderRadius: 9999,
        background: color,
        boxShadow: `0 0 8px ${color}`,
        animation: `${mode === "go" ? "mvdGo" : "mvdBack"} 340ms ${mode === "go" ? "ease-in" : "ease-out"} ${delay}ms both`,
      }}
    />
  );
}

// a short connector line between a card edge and a door
function Stub({ on, color, C, children }: { on: boolean; color: string; C: C; children?: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "relative",
        width: "2.2rem",
        height: 2,
        flexShrink: 0,
        borderRadius: 2,
        background: on ? `color-mix(in oklab, ${color} 60%, transparent)` : C.line,
        transition: "background 0.25s ease",
      }}
    >
      {children}
    </span>
  );
}

// a tiny door-arch glyph for the door buttons
function DoorGlyph({ color }: { color: string }) {
  return (
    <svg width="11" height="12" viewBox="0 0 14 15" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M2 14 V8 a5 5 0 0 1 10 0 v6" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
      <line x1="0" y1="14" x2="14" y2="14" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

// a small document glyph for the vault's file rows
function FileGlyph({ color }: { color: string }) {
  return (
    <svg width="11" height="13" viewBox="0 0 12 14" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M1 1 h6 l4 4 v8 h-10 z" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M7 1 v4 h4" fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export default function MemoryVaultDoors() {
  const C = usePalette();
  const narrow = useNarrow();
  const [active, setActive] = useState<DoorId | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [run, setRun] = useState(0);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  const open = (id: DoorId) => {
    clearTimers();
    setActive(id);
    setRun((r) => r + 1);
    if (REDUCED || narrow) {
      setPhase("done");
      return;
    }
    setPhase("go");
    timers.current.push(window.setTimeout(() => setPhase("back"), 700));
    timers.current.push(window.setTimeout(() => setPhase("done"), 1400));
  };

  // the vault side lights up once the request has arrived
  const arrived = active !== null && (phase === "back" || phase === "done");
  const returned = active !== null && phase === "done";
  const door = DOORS.find((d) => d.id === active) ?? null;
  const doorColor = door ? C.door[door.id] : C.accent;

  const caption = (() => {
    if (active && (phase === "go" || phase === "back")) {
      if (active === "recall") return <>searching the vault with BM25...</>;
      if (active === "hot") return <>reading {cmd("hot.md", C, C.door.hot)}...</>;
      return <>printing the filing rules...</>;
    }
    if (returned && active === "recall")
      return (
        <>
          {cmd("recall", C, C.door.recall)} ran BM25, plain ranking math, and returned only the best hits. Everything else stayed on disk.
        </>
      );
    if (returned && active === "hot")
      return (
        <>
          {cmd("imprnt hot", C, C.door.hot)} returned the short primer in {cmd("hot.md", C, C.door.hot)} plus anything waiting for review.
        </>
      );
    if (returned && active === "context")
      return (
        <>
          {cmd("imprnt context", C, C.door.context)} returned the full filing rules, run right before the assistant writes a note.
        </>
      );
    return <>Nothing crosses on its own. Open a door and watch the one thing it brings back.</>;
  })();

  const cardStyle: CSSProperties = {
    background: C.cardBg,
    borderRadius: 14,
    boxShadow: `inset 0 0 0 1px ${C.ring}`,
    padding: narrow ? "0.85rem 0.9rem" : "0.9rem 0.95rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.55rem",
    minWidth: 0,
  };

  const headStyle: CSSProperties = {
    fontFamily: MONO,
    fontSize: 11.5,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: C.onText,
  };

  const subStyle: CSSProperties = {
    fontFamily: SANS,
    fontSize: 11,
    lineHeight: 1.4,
    color: C.faint,
    marginTop: 2,
  };

  return (
    <div
      role="group"
      aria-label="The vault's three on-demand doors"
      style={{
        margin: "1.6rem 0",
        padding: narrow ? "1.15rem 0.9rem 1rem" : "1.5rem 1.4rem 1.15rem",
        borderRadius: 18,
        background: `radial-gradient(120% 70% at 50% 0%, color-mix(in oklab, ${C.accent} 8%, transparent), transparent 62%), radial-gradient(140% 60% at 50% 118%, color-mix(in oklab, ${C.accent} 5%, transparent), transparent 70%)`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: narrow ? "0.9rem" : "1rem",
      }}
    >
      {/* kicker */}
      <span
        style={{
          fontFamily: MONO,
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.faint,
        }}
      >
        three doors, all on demand
      </span>

      {/* session | doors | vault */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: narrow ? "1fr" : "minmax(0, 1fr) auto minmax(0, 1fr)",
          gap: narrow ? "0.8rem" : 0,
          alignItems: "stretch",
          width: "100%",
          maxWidth: "46rem",
        }}
      >
        {/* ---- your session ---- */}
        <section aria-label="Your session" style={cardStyle}>
          <div>
            <span style={headStyle}>your session</span>
            <p style={{ ...subStyle, margin: "2px 0 0" }}>the assistant you talk to</p>
          </div>

          {/* abstract chat: your line right-aligned, the assistant's replies left */}
          <div aria-hidden="true" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "2px 0" }}>
            <span style={{ alignSelf: "flex-end", width: "58%", height: 7, borderRadius: 4, background: `color-mix(in oklab, ${C.accent} 42%, transparent)` }} />
            <span style={{ width: "76%", height: 7, borderRadius: 4, background: C.barBg }} />
            <span style={{ width: "44%", height: 7, borderRadius: 4, background: C.barBg }} />
          </div>

          {/* what the open door brought back */}
          {/* flex-grow so the slot centers itself in whatever height the taller
              vault card hands the session card, instead of leaving a dead band */}
          <div aria-live="polite" style={{ minHeight: "2.9rem", flex: "1 0 auto", display: "flex", flexDirection: "column", justifyContent: "center" }}>
            {returned && door ? (
              <div
                className={REDUCED ? undefined : "mvd-chip"}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  padding: "0.42rem 0.6rem",
                  borderRadius: 10,
                  background: `color-mix(in oklab, ${doorColor} 15%, transparent)`,
                  boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${doorColor} 45%, transparent)`,
                }}
              >
                <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: doorColor }}>
                  came back
                </span>
                <span style={{ fontFamily: SANS, fontSize: 12, fontWeight: 600, lineHeight: 1.35, color: C.onText }}>
                  {door.brings}
                </span>
              </div>
            ) : (
              <div
                style={{
                  padding: "0.45rem 0.6rem",
                  borderRadius: 10,
                  border: `1px dashed ${C.line}`,
                  fontFamily: SANS,
                  fontSize: 11,
                  lineHeight: 1.4,
                  color: C.faint,
                }}
              >
                nothing from the vault in context
              </div>
            )}
          </div>

          {/* the only always-on piece */}
          <div style={{ marginTop: "auto", paddingTop: "0.55rem", borderTop: `1px solid ${C.ring}`, display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: C.faint }}>
              always loaded
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
              <span style={{ fontFamily: MONO, fontSize: 10, padding: "0.16rem 0.5rem", borderRadius: 999, background: `color-mix(in oklab, ${C.onText} 10%, transparent)`, color: C.capText }}>
                your behavior plugins
              </span>
              <span style={{ fontFamily: MONO, fontSize: 10, padding: "0.16rem 0.5rem", borderRadius: 999, background: `color-mix(in oklab, ${C.accent} 16%, transparent)`, color: C.onText }}>
                the pointer &middot; ~150 tokens
              </span>
            </div>
            <p style={{ margin: 0, fontFamily: SANS, fontSize: 10.5, lineHeight: 1.45, color: C.faint }}>
              the pointer: the vault exists, how to search it, run {cmd("imprnt context", C)} before writing
            </p>
          </div>
        </section>

        {/* ---- the three doors ---- */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: narrow ? "0.5rem" : "0.85rem",
            padding: narrow ? 0 : "0.5rem 0",
          }}
        >
          {DOORS.map((d) => {
            const c = C.door[d.id];
            const isActive = active === d.id;
            return (
              <div key={d.id} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
                {!narrow && (
                  <Stub on={isActive && phase !== "idle"} color={c} C={C}>
                    {isActive && phase === "go" && <Dot key={`gl${run}`} mode="go" delay={0} color={c} />}
                    {isActive && phase === "back" && <Dot key={`bl${run}`} mode="back" delay={340} color={c} />}
                  </Stub>
                )}
                <button
                  type="button"
                  className="mvd-door"
                  onClick={() => open(d.id)}
                  aria-pressed={isActive}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 2,
                    width: narrow ? "100%" : "11.5rem",
                    padding: "0.5rem 0.9rem 0.55rem",
                    borderRadius: "16px 16px 11px 11px",
                    border: "none",
                    cursor: "pointer",
                    background: isActive ? `color-mix(in oklab, ${c} 16%, ${C.cardBg})` : C.cardBg,
                    boxShadow: isActive
                      ? `inset 0 0 0 1.5px color-mix(in oklab, ${c} 65%, transparent), 0 6px 22px -12px ${c}`
                      : `inset 0 0 0 1px ${C.ring}`,
                    color: C.onText,
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <DoorGlyph color={c} />
                    <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700 }}>{d.cmd}</span>
                  </span>
                  <span style={{ fontFamily: SANS, fontSize: 10.5, color: C.subText }}>{d.role}</span>
                </button>
                {!narrow && (
                  <Stub on={isActive && phase !== "idle"} color={c} C={C}>
                    {isActive && phase === "go" && <Dot key={`gr${run}`} mode="go" delay={340} color={c} />}
                    {isActive && phase === "back" && <Dot key={`br${run}`} mode="back" delay={0} color={c} />}
                  </Stub>
                )}
              </div>
            );
          })}
        </div>

        {/* ---- the vault ---- */}
        <section aria-label="The vault" style={cardStyle}>
          <div>
            <span style={headStyle}>the vault</span>
            <p style={{ ...subStyle, margin: "2px 0 0" }}>plain files on your disk, readable in any editor</p>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.32rem" }}>
            {FILES.map((f, i) => {
              const isHit = arrived && active === "recall" && HITS[i] !== undefined;
              const dimmed = arrived && !isHit && active === "recall";
              return (
                <div
                  key={f.type}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.45rem",
                    padding: "0.34rem 0.55rem",
                    borderRadius: 9,
                    background: C.fileBg,
                    boxShadow: isHit ? `inset 0 0 0 1.5px color-mix(in oklab, ${C.door.recall} 70%, transparent)` : "none",
                    opacity: dimmed ? 0.5 : 1,
                    transition: "box-shadow 0.25s ease, opacity 0.25s ease",
                  }}
                >
                  <FileGlyph color={C.faint} />
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.capText, flexShrink: 0 }}>{f.type}</span>
                  <span aria-hidden="true" style={{ width: f.bar, maxWidth: "5rem", height: 5, borderRadius: 3, background: C.barBg }} />
                  {isHit && (
                    <span
                      style={{
                        marginLeft: "auto",
                        width: 15,
                        height: 15,
                        flexShrink: 0,
                        borderRadius: 9999,
                        background: C.door.recall,
                        color: C.badgeText,
                        fontFamily: MONO,
                        fontSize: 9.5,
                        fontWeight: 700,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {HITS[i]}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.32rem", marginTop: "auto", paddingTop: "0.45rem", borderTop: `1px solid ${C.ring}` }}>
            {CTLS.map((ctl) => {
              const lit = arrived && active === ctl.id;
              const dimmed = arrived && active !== ctl.id;
              const cc = C.door[ctl.id];
              return (
                <div
                  key={ctl.name}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    flexWrap: "wrap",
                    columnGap: "0.45rem",
                    rowGap: 0,
                    padding: "0.3rem 0.55rem",
                    borderRadius: 9,
                    background: lit ? `color-mix(in oklab, ${cc} 14%, transparent)` : C.fileBg,
                    boxShadow: lit ? `inset 0 0 0 1.5px color-mix(in oklab, ${cc} 60%, transparent)` : "none",
                    opacity: dimmed ? 0.55 : 1,
                    transition: "box-shadow 0.25s ease, opacity 0.25s ease, background 0.25s ease",
                  }}
                >
                  <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: lit ? cc : C.capText }}>{ctl.name}</span>
                  <span style={{ fontFamily: SANS, fontSize: 10, color: C.faint }}>{ctl.sub}</span>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* the moral, live-updating */}
      <p
        aria-live="polite"
        style={{
          margin: 0,
          minHeight: "2.7em",
          maxWidth: "34rem",
          textAlign: "center",
          fontFamily: SANS,
          fontSize: narrow ? 12 : 12.5,
          lineHeight: 1.5,
          color: C.subText,
        }}
      >
        {caption}
      </p>

      <style>{`
        @keyframes mvdGo {
          from { left: 0; opacity: 0; }
          20% { opacity: 1; }
          to { left: calc(100% - 7px); opacity: 1; }
        }
        @keyframes mvdBack {
          from { left: calc(100% - 7px); opacity: 0; }
          20% { opacity: 1; }
          to { left: 0; opacity: 1; }
        }
        @keyframes mvdChipIn {
          from { opacity: 0; transform: translateY(3px); }
          to { opacity: 1; transform: none; }
        }
        .mvd-chip { animation: mvdChipIn 260ms ease-out both; }
        .mvd-door { transition: transform 0.16s ease, box-shadow 0.25s ease, background 0.25s ease; }
        .mvd-door:hover { transform: translateY(-1px); }
        .mvd-door:active { transform: translateY(0); }
        @media (prefers-reduced-motion: reduce) {
          .mvd-door, .mvd-door:hover, .mvd-door:active { transform: none; transition: none; }
          .mvd-chip { animation: none; }
        }
      `}</style>
    </div>
  );
}
