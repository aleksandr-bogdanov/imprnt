/**
 * The one escape helper every interpolated value passes, and the frame every
 * page is assembled into.
 *
 * ZERO DEPENDENCIES MEANS HAND-BUILT HTML, so the escaping is the page's own
 * job and there is exactly one function that does it. `safeValue` in
 * `src/door/lines.ts` deliberately leaves `<` and `>` alone, because that one
 * is an operator's terminal sanitizer where `&lt;` would be noise, so a page
 * value goes through both: the sentence for the line and this for the markup.
 *
 * THERE IS NO SCRIPT ON ANY PAGE AT ALL, and no refresh meta either. What it
 * costs is stated rather than hidden: nothing on a page is live and a person
 * refreshes to see a change. What it buys is that a board nobody is looking at
 * is asleep, and that a page nobody wrote can do nothing.
 *
 * THE LOOK IS A LATER SESSION under the household's own design rules and
 * nothing here is that session's work. Two rulings bind the markup now: ONE
 * accent, used for links and for the one word a card carries, and a service
 * manager's own states printed in the manager's own words and never coloured by
 * a rule of the board's, because red is a `check` finding and never a page's
 * opinion.
 */

/** Everything a page interpolates goes through this, and nothing else does. */
export function escape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface PageFrame {
  /** The page's own name, which is also what the nav marks as the one you are on. */
  title: string;
  /** The sentence an act left behind, already one of the pinned ones, or null. */
  notice?: string | null;
  /** The body, already assembled and already escaped. */
  body: string;
  /** Where in the nav this page sits. */
  here: string;
}

const NAV: { at: string; name: string }[] = [
  { at: "/", name: "machines" },
  { at: "/people", name: "people" },
  { at: "/findings", name: "findings" },
  { at: "/metrics", name: "metrics" },
];

const STYLE = [
  ":root { --ink: #1b1d1a; --paper: #fbfaf7; --line: #ddd7c7; --soft: #585b51; --accent: #0f5f5f; }",
  "body { background: var(--paper); color: var(--ink); font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 62rem; padding: 1.5rem 1rem 4rem; }",
  "a { color: var(--accent); }",
  "h1 { font-size: 1.4rem; margin: 0 0 1rem; }",
  "h2 { font-size: 1.05rem; margin: 2rem 0 0.5rem; }",
  "nav { border-bottom: 1px solid var(--line); margin-bottom: 1.5rem; padding-bottom: 0.5rem; }",
  "nav a { margin-right: 1rem; text-decoration: none; }",
  "nav strong { margin-right: 1rem; }",
  "table { border-collapse: collapse; width: 100%; }",
  "th, td { border-bottom: 1px solid var(--line); padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }",
  "th { color: var(--soft); font-weight: 600; }",
  "td.word { color: var(--accent); }",
  "p.empty, td.said { color: var(--soft); }",
  "p.notice { border: 1px solid var(--line); padding: 0.5rem 0.75rem; }",
  "form { display: inline; }",
  "button { background: none; border: 1px solid var(--line); color: var(--accent); cursor: pointer; font: inherit; padding: 0.1rem 0.5rem; }",
].join("\n");

/** The whole document. One stylesheet, inline, and no script element at all. */
export function page(frame: PageFrame): string {
  const links = NAV.map((one) =>
    one.at === frame.here
      ? `<strong>${escape(one.name)}</strong>`
      : `<a href="${escape(one.at)}">${escape(one.name)}</a>`,
  ).join("");
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(frame.title)}</title>`,
    `<style>\n${STYLE}\n</style>`,
    "</head>",
    "<body>",
    `<nav>${links}</nav>`,
    `<h1>${escape(frame.title)}</h1>`,
    frame.notice ? `<p class="notice">${escape(frame.notice)}</p>` : "",
    frame.body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
