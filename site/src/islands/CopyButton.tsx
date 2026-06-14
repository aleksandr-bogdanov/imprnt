import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

type Props = {
  value: string;
  label?: string;
};

export default function CopyButton({ value, label }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked, no-op */
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label ? `Copy ${label}` : "Copy to clipboard"}
      className="group inline-flex items-center gap-2 rounded-lg border border-line bg-surface/60 px-2.5 py-1.5 text-ink-soft transition-colors hover:border-green/50 hover:text-ink"
    >
      <span className="relative grid h-4 w-4 place-items-center">
        <AnimatePresence mode="wait" initial={false}>
          {copied ? (
            <motion.svg
              key="check"
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.4, opacity: 0 }}
              transition={{ duration: 0.18 }}
              viewBox="0 0 24 24"
              fill="none"
              className="h-4 w-4 text-green"
            >
              <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </motion.svg>
          ) : (
            <motion.svg
              key="copy"
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.4, opacity: 0 }}
              transition={{ duration: 0.18 }}
              viewBox="0 0 24 24"
              fill="none"
              className="h-4 w-4"
            >
              <rect x="9" y="9" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </motion.svg>
          )}
        </AnimatePresence>
      </span>
      <span className="font-mono text-xs">{copied ? "copied" : "copy"}</span>
    </button>
  );
}
