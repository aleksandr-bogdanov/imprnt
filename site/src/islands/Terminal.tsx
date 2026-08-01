// A static transcript of one imp session. No typing animation, no terminal-window
// chrome (the redesign killed both: typing effects and traffic-light dots are
// named bans). Mono is correct here - it is a real CLI transcript, which is code,
// not a UI label. Rendered server-side with no client directive, so it ships zero JS.
//
// Lines are SEGMENTS, not flat strings, so the transcript reads as the product's
// output instead of a mono wall: vault paths get a chip, recovered facts go full
// ink, and a superseded value keeps its strike-through - which is what the
// contract does to a fact that changed. Four marks, no second accent invented.

import type { TermLine as Line, TermSeg as Seg } from "../lib/landing";

function tone(who: string) {
  if (who === "You") return "text-ink";
  if (who === "imp") return "text-accent";
  return "text-ink-faint";
}

export default function Terminal({ lines }: { lines: Line[] }) {
  return (
    // rounded-xl, not 2xl: all four captures on the landing share one corner
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <div className="border-b border-line bg-chrome px-4 py-2.5">
        <span className="font-mono text-xs text-ink-chrome">imp - your vault</span>
      </div>
      <div className="space-y-3 p-5 font-mono text-[13px] leading-relaxed sm:text-sm">
        {lines.map((line, idx) => (
          <Row key={idx} who={line.who} segs={line.segs} />
        ))}
      </div>
    </div>
  );
}

function Mark({ seg }: { seg: Seg }) {
  if (typeof seg === "string") return <>{seg}</>;
  // -mx-[3px] pulls the chip's own padding back out of the text flow, so a path
  // followed by a comma or a full stop does not sit in a visible gap
  if (seg.k === "path") {
    return (
      <span className="-mx-[3px] whitespace-nowrap rounded-[5px] bg-accent-wash px-[5px] py-[1.5px] font-semibold text-accent">
        {seg.v}
      </span>
    );
  }
  // a recovered fact is the point of the transcript, so it never breaks across
  // two lines ("July 15" split at the wrap was reading as two facts)
  if (seg.k === "key") return <span className="whitespace-nowrap font-semibold text-ink">{seg.v}</span>;
  if (seg.k === "gone") return <span className="text-ink-faint line-through decoration-from-font">{seg.v}</span>;
  return <span className="text-ink-faint">{seg.v}</span>;
}

function Row({ who, segs }: { who: string; segs: Seg[] }) {
  const body = segs.map((seg, i) => <Mark key={i} seg={seg} />);

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
