import { useEffect, useRef, useState } from "react";
import { useInView } from "framer-motion";

type Line = { who: string; text: string };

const REDUCED =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function tone(who: string) {
  if (who === "You") return "text-ink";
  if (who === "imp") return "text-green-bright";
  return "text-ink-faint";
}

export default function Terminal({ lines }: { lines: Line[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-15%" });

  // Default: the full conversation is shown. This is what the server renders,
  // what a no-JS visitor sees, and what reduced-motion keeps. The typing
  // animation only kicks in once motion is allowed and the block scrolls in.
  const [started, setStarted] = useState(false);
  const [shown, setShown] = useState(lines.length);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (REDUCED || started || !inView) return;
    setStarted(true);
    setShown(0);
    setTyped("");
  }, [inView, started]);

  useEffect(() => {
    if (!started || REDUCED || shown >= lines.length) return;
    const full = lines[shown].text;
    const pause = lines[shown].who === "gap" ? 0 : 1;
    let i = 0;
    const tick = window.setInterval(() => {
      i += Math.max(1, Math.round(full.length / 64));
      setTyped(full.slice(0, i));
      if (i >= full.length) {
        window.clearInterval(tick);
        window.setTimeout(() => {
          setShown((s) => s + 1);
          setTyped("");
        }, 340);
      }
    }, pause || 14);
    return () => window.clearInterval(tick);
  }, [started, shown, lines]);

  return (
    <div ref={ref} className="overflow-hidden rounded-2xl border border-line bg-[#0c0e11] shadow-2xl shadow-black/40">
      <div className="flex items-center gap-2 border-b border-line/80 bg-surface/40 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 font-mono text-xs text-ink-faint">imp - your vault</span>
      </div>
      <div className="space-y-3 p-5 font-mono text-[13px] leading-relaxed sm:text-sm">
        {lines.map((line, idx) => {
          if (started) {
            const isDone = idx < shown;
            const isCurrent = idx === shown;
            if (!isDone && !isCurrent) return null;
            const body = isCurrent ? typed : line.text;
            return <Row key={idx} who={line.who} body={body} caret={isCurrent} />;
          }
          return <Row key={idx} who={line.who} body={line.text} caret={false} />;
        })}
      </div>
    </div>
  );
}

function Row({ who, body, caret }: { who: string; body: string; caret: boolean }) {
  if (who === "gap") {
    return <p className="select-none py-1 text-ink-faint">{body}</p>;
  }
  return (
    <p className="flex gap-3">
      <span className={`shrink-0 font-semibold ${tone(who)}`}>
        {who}
        <span className="text-ink-faint">:</span>
      </span>
      <span className="text-ink-soft">
        {body}
        {caret && (
          <span className="ml-0.5 inline-block h-[1.05em] w-[0.5ch] translate-y-[0.15em] animate-pulse bg-green-bright/80" />
        )}
      </span>
    </p>
  );
}
