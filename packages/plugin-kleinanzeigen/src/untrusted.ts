// The quarantine for text a stranger wrote.
//
// Every digest this plugin composes lands in a full-capability agent's context, and several of the
// fields in it are written by someone on a public marketplace: an ad title, a counterpart's display
// name, the body of a message they sent. That text is DATA. It is never an instruction, never a
// command to run, never a URL to fetch, and never a reason to act - however it is phrased.
//
// Two mechanisms, doing different jobs:
//
//   sdz()   strips what could break out of a line: control characters (which hide content in a
//           terminal and in a log), the delimiters this fence is built from, and backticks (which
//           open a code fence in every downstream renderer). Then it collapses whitespace and caps
//           length, because an agent's context is finite and an ad title is not.
//
//   udata() wraps the result in guillemets. The marks matter because POSITION is lost the moment a
//           value is lifted out of its field and pasted into a reply or into the agent's own
//           reasoning - the marks travel with the value. Stripping the marks inside sdz() first is
//           what stops a hostile string forging its own closing mark to appear to escape the fence.
//
// This existed only in a hand-edited build artifact in one person's vault. The PUBLISHED package
// shipped without it, so every other install spliced hostile marketplace text into an agent's
// context raw. Ported here, to the source, where a rebuild cannot delete it again.

const CONTROL = /[\u0000-\u001f\u007f]/g;
const FENCE_CHARS = /[<>\u00ab\u00bb`]/g;

/** Strip, collapse and cap a string that came from outside. Safe to embed, still unfenced. */
export function sdz(v: unknown, cap = 80): string {
  return String(v ?? "")
    .replace(CONTROL, " ")
    .replace(FENCE_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, cap);
}

/** Fence a string that came from outside, so a reader can never mistake it for our own words. */
export function udata(v: unknown, cap = 80): string {
  const s = sdz(v, cap);
  return s ? "\u00ab" + s + "\u00bb" : "";
}
