// A static transcript of one imp session. No typing animation, no terminal-window
// chrome (the redesign killed both: typing effects and traffic-light dots are
// named bans). Mono is correct here - it is a real CLI transcript, which is code,
// not a UI label. Rendered server-side with no client directive, so it ships zero JS.

type Line = { who: string; text: string };

function tone(who: string) {
  if (who === "You") return "text-ink";
  if (who === "imp") return "text-accent";
  return "text-ink-faint";
}

export default function Terminal({ lines }: { lines: Line[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="border-b border-line bg-bg-soft px-4 py-2.5">
        <span className="font-mono text-xs text-ink-chrome">imp - your vault</span>
      </div>
      <div className="space-y-3 p-5 font-mono text-[13px] leading-relaxed sm:text-sm">
        {lines.map((line, idx) => (
          <Row key={idx} who={line.who} body={line.text} />
        ))}
      </div>
    </div>
  );
}

function Row({ who, body }: { who: string; body: string }) {
  if (who === "gap") {
    return <p className="select-none py-1 text-ink-faint">{body}</p>;
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
