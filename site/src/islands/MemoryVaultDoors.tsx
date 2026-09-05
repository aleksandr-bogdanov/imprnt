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
 * always-on piece is the ~200-token pointer parked in the session.
 *
 * Inline styles only (Starlight docs do not load the site's Tailwind), plus one
 * scoped <style> block for the keyframes. Every colour is a Starlight token,
 * so the theme follows data-theme with no script. Filled surfaces, hairlines,
 * one accent carrying the active state, no borders. Reduced motion: clicks
 * still switch every state, the packets never fly. Categories only (note
 * types, control files), never individual notes, so nothing here goes stale.
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

// Starlight tokens. gray-1 and gray-2 are the readable steps, gray-3 is the
// caption floor (4.5:1 on paper), nothing lighter carries text.
const T = {
  accent: "var(--sl-color-text-accent)",
  accentInk: "var(--brand-accent-ink)",
  ink: "var(--sl-color-white)",
  text: "var(--sl-color-gray-1)",
  sub: "var(--sl-color-gray-2)",
  cap: "var(--sl-color-gray-3)",
  bg: "var(--sl-color-bg)",
  band: "color-mix(in oklab, var(--sl-color-gray-3) 15%, var(--sl-color-bg))",
  card: "color-mix(in oklab, var(--sl-color-bg) 55%, transparent)",
  row: "color-mix(in oklab, var(--sl-color-gray-3) 12%, transparent)",
  bar: "color-mix(in oklab, var(--sl-color-gray-3) 30%, transparent)",
  line: "color-mix(in oklab, var(--sl-color-gray-2) 32%, transparent)",
  lit: "color-mix(in oklab, var(--sl-color-text-accent) 24%, var(--sl-color-bg))",
  tint: "color-mix(in oklab, var(--sl-color-text-accent) 16%, var(--sl-color-bg))",
};

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
function cmd(text: string) {
  return (
    <code
      style={{
        fontFamily: MONO,
        fontSize: "0.94em",
        padding: "0.05em 0.32em",
        border: 0,
        borderRadius: 5,
        background: T.row,
        color: T.ink,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </code>
  );
}

// the request/response packet that travels along a connector stub
function Dot({ mode, delay }: { mode: "go" | "back"; delay: number }) {
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
        background: T.accent,
        animation: `${mode === "go" ? "mvdGo" : "mvdBack"} 340ms ${mode === "go" ? "ease-in" : "ease-out"} ${delay}ms both`,
      }}
    />
  );
}

// a short connector line between a card edge and a door
function Stub({ on, children }: { on: boolean; children?: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      style={{
        position: "relative",
        width: "2.2rem",
        height: 2,
        flexShrink: 0,
        borderRadius: 2,
        background: on ? T.accent : T.line,
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

  const caption = (() => {
    if (active && (phase === "go" || phase === "back")) {
      if (active === "recall") return <>searching the vault with BM25...</>;
      if (active === "hot") return <>reading {cmd("hot.md")}...</>;
      return <>printing the filing rules...</>;
    }
    if (returned && active === "recall")
      return <>{cmd("recall")} ran BM25, plain ranking math, and returned only the best hits. Everything else stayed on disk.</>;
    if (returned && active === "hot")
      return <>{cmd("imprnt hot")} returned the short primer in {cmd("hot.md")} plus anything waiting for review.</>;
    if (returned && active === "context")
      return <>{cmd("imprnt context")} returned the full filing rules, run right before the assistant writes a note.</>;
    return <>Nothing crosses on its own. Open a door and watch the one thing it brings back.</>;
  })();

  const cardStyle: CSSProperties = {
    background: T.card,
    borderRadius: 12,
    padding: narrow ? "0.85rem 0.9rem" : "0.9rem 0.95rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.55rem",
    minWidth: 0,
  };

  const headStyle: CSSProperties = {
    fontFamily: SANS,
    fontSize: 11.5,
    fontWeight: 700,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: T.ink,
  };

  const subStyle: CSSProperties = {
    fontFamily: SANS,
    fontSize: 11.5,
    lineHeight: 1.4,
    color: T.sub,
    marginTop: 2,
  };

  const labelStyle: CSSProperties = {
    fontFamily: SANS,
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: T.cap,
  };

  return (
    <div
      className="not-content"
      role="group"
      aria-label="The vault's three on-demand doors"
      style={{
        margin: "1.6rem 0",
        padding: narrow ? "1.15rem 0.9rem 1rem" : "1.5rem 1.4rem 1.15rem",
        borderRadius: 16,
        background: T.band,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: narrow ? "0.9rem" : "1rem",
      }}
    >
      {/* kicker */}
      <span style={{ ...labelStyle, fontWeight: 600, letterSpacing: "0.13em" }}>three doors, all on demand</span>

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
            <span style={{ alignSelf: "flex-end", width: "58%", height: 7, borderRadius: 4, background: T.bar }} />
            <span style={{ width: "76%", height: 7, borderRadius: 4, background: T.bar }} />
            <span style={{ width: "44%", height: 7, borderRadius: 4, background: T.bar }} />
          </div>

          {/* what the open door brought back. flex-grow centres the slot in
              whatever height the taller vault card hands the session card */}
          <div aria-live="polite" style={{ minHeight: "2.9rem", flex: "1 0 auto", display: "flex", flexDirection: "column", justifyContent: "center" }}>
            {returned && door ? (
              <div
                className={REDUCED ? undefined : "mvd-chip"}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  padding: "0.42rem 0.6rem",
                  borderRadius: 9,
                  background: T.lit,
                }}
              >
                <span style={labelStyle}>came back</span>
                <span style={{ fontFamily: SANS, fontSize: 12, fontWeight: 600, lineHeight: 1.35, color: T.ink }}>{door.brings}</span>
              </div>
            ) : (
              <div
                style={{
                  padding: "0.45rem 0.6rem",
                  borderRadius: 9,
                  background: T.row,
                  fontFamily: SANS,
                  fontSize: 11.5,
                  lineHeight: 1.4,
                  color: T.sub,
                }}
              >
                nothing from the vault in context
              </div>
            )}
          </div>

          {/* the only always-on piece */}
          <div style={{ marginTop: "auto", paddingTop: "0.55rem", borderTop: `1px solid ${T.line}`, display: "flex", flexDirection: "column", gap: "0.35rem" }}>
            <span style={labelStyle}>always loaded</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem" }}>
              <span style={{ fontFamily: SANS, fontSize: 10.5, fontWeight: 500, padding: "0.16rem 0.5rem", borderRadius: 999, background: T.row, color: T.text }}>
                your behavior plugins
              </span>
              <span style={{ fontFamily: SANS, fontSize: 10.5, fontWeight: 500, padding: "0.16rem 0.5rem", borderRadius: 999, background: T.tint, color: T.ink }}>
                the pointer &middot; ~200 tokens
              </span>
            </div>
            <p style={{ margin: 0, fontFamily: SANS, fontSize: 11, lineHeight: 1.45, color: T.sub }}>
              the pointer: the vault exists, how to search it, run {cmd("imprnt context")} before writing
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
            const isActive = active === d.id;
            const on = isActive && phase !== "idle";
            return (
              <div key={d.id} style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
                {!narrow && (
                  <Stub on={on}>
                    {isActive && phase === "go" && <Dot key={`gl${run}`} mode="go" delay={0} />}
                    {isActive && phase === "back" && <Dot key={`bl${run}`} mode="back" delay={340} />}
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
                    borderRadius: "14px 14px 10px 10px",
                    border: "none",
                    cursor: "pointer",
                    background: isActive ? T.lit : T.card,
                    color: T.ink,
                  }}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <DoorGlyph color={isActive ? T.accent : T.sub} />
                    <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700 }}>{d.cmd}</span>
                  </span>
                  <span style={{ fontFamily: SANS, fontSize: 11, color: T.sub }}>{d.role}</span>
                </button>
                {!narrow && (
                  <Stub on={on}>
                    {isActive && phase === "go" && <Dot key={`gr${run}`} mode="go" delay={340} />}
                    {isActive && phase === "back" && <Dot key={`br${run}`} mode="back" delay={0} />}
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
                    borderRadius: 8,
                    background: isHit ? T.lit : T.row,
                    opacity: dimmed ? 0.5 : 1,
                    transition: "background 0.25s ease, opacity 0.25s ease",
                  }}
                >
                  <FileGlyph color={T.cap} />
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.text, flexShrink: 0 }}>{f.type}</span>
                  <span aria-hidden="true" style={{ width: f.bar, maxWidth: "5rem", height: 5, borderRadius: 3, background: T.bar }} />
                  {isHit && (
                    <span
                      style={{
                        marginLeft: "auto",
                        width: 15,
                        height: 15,
                        flexShrink: 0,
                        borderRadius: 9999,
                        background: T.accent,
                        color: T.accentInk,
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

          <div style={{ display: "flex", flexDirection: "column", gap: "0.32rem", marginTop: "auto", paddingTop: "0.45rem", borderTop: `1px solid ${T.line}` }}>
            {CTLS.map((ctl) => {
              const lit = arrived && active === ctl.id;
              const dimmed = arrived && active !== ctl.id;
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
                    borderRadius: 8,
                    background: lit ? T.lit : T.row,
                    opacity: dimmed ? 0.55 : 1,
                    transition: "opacity 0.25s ease, background 0.25s ease",
                  }}
                >
                  <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: T.ink }}>{ctl.name}</span>
                  <span style={{ fontFamily: SANS, fontSize: 10.5, color: T.sub }}>{ctl.sub}</span>
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
          color: T.sub,
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
        .mvd-door { transition: transform 0.16s ease, background 0.25s ease; }
        .mvd-door:hover { transform: translateY(-1px); }
        .mvd-door:active { transform: translateY(0); }
        .mvd-door:focus-visible { outline: 2px solid var(--sl-color-text-accent); outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) {
          .mvd-door, .mvd-door:hover, .mvd-door:active { transform: none; transition: none; }
          .mvd-chip { animation: none; }
        }
      `}</style>
    </div>
  );
}
