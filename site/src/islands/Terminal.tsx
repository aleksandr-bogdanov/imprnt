// A static transcript of one imp session. No typing animation, no terminal-window
// chrome (the redesign killed both: typing effects and traffic-light dots are
// named bans). Mono is correct here - it is a real CLI transcript, which is code,
// not a UI label. Rendered server-side with no client directive, so it ships zero JS.
//
// Lines are SEGMENTS, not flat strings, so the transcript reads as the product's
// output instead of a mono wall: vault paths get a chip, recovered facts go full
// ink, and a superseded value keeps its strike-through - which is what the
// contract does to a fact that changed. Four marks, no second accent invented.
//
// Any segment carrying `pop` is HOVERABLE and opens the thing it names: the pasted
// source, the note each path produced, the superseded line the vault kept. CSS-only on
// :hover and :focus-visible, so it stays zero-JS and reachable from the keyboard.

import type { TermLine as Line, TermSeg as Seg } from "../lib/landing";

function tone(who: string) {
  if (who === "You") return "text-ink";
  if (who === "imp") return "text-accent";
  return "text-ink-faint";
}

export default function Terminal({ lines }: { lines: Line[] }) {
  return (
    // rounded-xl, not 2xl: all four captures on the landing share one corner
    <div className="term overflow-visible rounded-xl border border-line bg-surface">
      <div className="border-b border-line bg-chrome px-4 py-2.5">
        <span className="font-mono text-xs text-ink-chrome">imp - your vault</span>
      </div>
      <div className="space-y-3 p-5 font-mono text-[13px] leading-relaxed sm:text-sm">
        {lines.map((line, idx) => (
          <Row key={idx} who={line.who} segs={line.segs} up={idx >= lines.length - 2} />
        ))}
      </div>
    </div>
  );
}

/** Wraps a mark carrying `pop` so the thing it names can be opened. */
function Hoverable({ children, pop, up }: { children: React.ReactNode; pop: string; up: boolean }) {
  return (
    <span className={`pop-host${up ? " pop-up" : ""}`} tabIndex={0}>
      {children}
      <span className="pop"><span className="pop-body">{pop}</span></span>
    </span>
  );
}

function Mark({ seg, up }: { seg: Seg; up: boolean }) {
  if (typeof seg === "string") return <>{seg}</>;
  // -mx-[3px] pulls the chip's own padding back out of the text flow, so a path
  // followed by a comma or a full stop does not sit in a visible gap
  let inner: React.ReactNode;
  if (seg.k === "path") {
    inner = (
      <span className="-mx-[3px] whitespace-nowrap rounded-[5px] bg-accent-wash px-[5px] py-[1.5px] font-semibold text-accent">
        {seg.v}
      </span>
    );
  } else
  // a recovered fact is the point of the transcript, so it never breaks across
  // two lines ("July 15" split at the wrap was reading as two facts)
  if (seg.k === "key") {
    inner = <span className="whitespace-nowrap font-semibold text-ink">{seg.v}</span>;
  } else if (seg.k === "gone") {
    inner = <span className="text-ink-faint line-through decoration-from-font">{seg.v}</span>;
  } else {
    inner = <span className="text-ink-faint">{seg.v}</span>;
  }
  return seg.pop ? <Hoverable pop={seg.pop} up={up}>{inner}</Hoverable> : <>{inner}</>;
}

function Row({ who, segs, up }: { who: string; segs: Seg[]; up: boolean }) {
  const body = segs.map((seg, i) => <Mark key={i} seg={seg} up={up} />);

  // the elapsed-time marker is a rule with the interval sitting on it, so the
  // three-week gap reads as a break in the session rather than another message
  // ink-chrome, not ink-faint: this rule is what makes the section's whole
  // claim ("two chats, three weeks apart") visible inside the capture, and at
  // 11px the faint step measured ~3.1:1. Faint stays for what is genuinely
  // muted here - the pasted-transcript stub and the superseded date.
  if (who === "gap") {
    return (
      <p className="flex select-none items-center gap-3 py-1 text-ink-chrome">
        <span className="h-px flex-1 bg-line" />
        <span className="text-[11px] uppercase tracking-wider">{body}</span>
        <span className="h-px flex-1 bg-line" />
      </p>
    );
  }

  return (
    <p className="flex gap-3">
      <span className={`shrink-0 font-semibold ${tone(who)}`}>
        {who}
        <span className="text-ink-faint">:</span>
      </span>
      <span className="text-ink-soft">{body}</span>
    </p>
  );
}
