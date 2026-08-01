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
      // bg-chrome, not bg-surface: the button sits INSIDE a bg-surface command
      // box, so at the same fill it read as an outline drawn on the box rather
      // than as a control you can press. Chrome is the one step defined off the
      // surface in both themes.
      className="group inline-flex items-center gap-2 rounded-lg border border-line bg-chrome px-2.5 py-1.5 text-ink-soft transition-colors hover:border-accent hover:text-accent"
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
              className="h-4 w-4 text-accent"
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
      {/* font-sans: this is a UI label on a control, not part of the command.
          It inherited the command box's font-mono, which is the one thing the
          brand reserves for code and terminal captures. Fixed width so the
          label swap on copy does not resize the button under the cursor. */}
      <span className="inline-block w-[3.4em] text-left font-sans text-xs font-medium">
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}
