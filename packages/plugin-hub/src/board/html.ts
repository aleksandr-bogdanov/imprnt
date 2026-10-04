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
 * THE PHONE IS THE MAIN VIEW. The stylesheet is written for a 390 pixel screen
 * first and widens from there: body text at 16 pixels, the nav a row that
 * scrolls sideways with tap targets 44 pixels tall, and every table below 600
 * pixels laid out as one block per row with each cell labelled by its own
 * heading, so no page ever scrolls sideways. Two rulings bind the look: ONE
 * accent, teal, used for links, focus and the state a row is in, and a service
 * manager's own states printed in the manager's own words and never coloured by
 * a rule of the board's, because red is a `check` finding and never a page's
 * opinion. Paper first: warm light surfaces with a dark scheme that follows the
 * phone's, hairline rules and no coloured borders, gradients, glass or icons.
 *
 * ONE TYPEFACE FOR EVERYTHING A PERSON READS, Golos Text, and JetBrains Mono
 * only for what is copied or matched literally: a command and an id. Both are
 * served by the board itself from `assets/fonts` (see `FONT_FILES`), so a phone
 * on the tailnet with no internet still renders them; `font-display: swap`
 * shows the text in the fallback until the file arrives.
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

/** What a measure with no data prints. A zero in a table a person reads is a claim. */
export const NOTHING = "-";

/**
 * One cell, its value escaped, empty printed as the nothing mark.
 *
 * The heading it sits under is written onto it by `table`, which is what lets
 * a phone lay the row out as a block and still say what each value is.
 */
export function cell(value: unknown, className = ""): string {
  const empty = value === null || value === undefined || value === "";
  // An empty cell is marked, so a compact table on a phone can leave it out
  // rather than print a labelled row holding only the nothing mark.
  const classes = [className, empty ? "nil" : ""].filter((one) => one !== "").join(" ");
  return `<td${classes === "" ? "" : ` class="${classes}"`}>${escape(empty ? NOTHING : String(value))}</td>`;
}

/**
 * Text with every short hyphenated word kept whole: `home-server`,
 * `claude-code`, `2026-10-04` never break at their hyphen, which a browser
 * otherwise treats as a place to wrap. A word longer than a narrow column could
 * hold (a path) is left free to wrap, so nothing is pushed off a phone screen.
 */
export function whole(value: unknown, longest = 32): string {
  return String(value ?? "")
    .split(/(\s+)/)
    .map((word) => (word.includes("-") && word.length <= longest && !/\s/.test(word) ? `<span class="nw">${escape(word)}</span>` : escape(word)))
    .join("");
}

/** A cell of prose whose short hyphenated words are kept whole, empty printed as the nothing mark. */
export function wordsCell(value: unknown, className = "", longest = 32): string {
  const empty = value === null || value === undefined || value === "";
  const classes = [className, empty ? "nil" : ""].filter((one) => one !== "").join(" ");
  // One element around the words: on a phone a cell is a two-column grid, and
  // each bare span would otherwise be a grid item of its own.
  return `<td${classes === "" ? "" : ` class="${classes}"`}>${empty ? NOTHING : `<span>${whole(value, longest)}</span>`}</td>`;
}

/** A cell holding markup a caller already escaped, such as a link or a form. */
export function rawCell(markup: string, className = ""): string {
  return `<td${className === "" ? "" : ` class="${className}"`}>${markup}</td>`;
}

/**
 * A table: the headings once, then one row per list of cells.
 *
 * Every cell is stamped with the heading above it as `data-label`, which is
 * what the narrow stylesheet prints before the value once the columns are
 * gone. A heading that is empty stamps an empty label, and the stylesheet
 * prints nothing for it, so an acts column carries no stray word.
 */
export function table(headings: string[], rows: string[][], options: { compact?: boolean; keep?: boolean } = {}): string {
  if (rows.length === 0) return "";
  const labelled = rows.map((cells) =>
    "<tr>" +
    cells.map((one, at) => one.replace(/^<td/, `<td data-label="${escape(headings[at] ?? "")}"`)).join("") +
    "</tr>",
  );
  return [
    // The frame scrolls a wide table sideways on a wide screen rather than
    // squeezing its columns until words break; on a phone the rows are blocks
    // and nothing scrolls.
    // A compact table drops its empty cells on a phone, where each would be a
    // labelled row of its own; on a wide screen every column stays. A kept
    // table is narrow enough to stay a table on a phone.
    `<div class="rows${options.compact ? " compact" : ""}${options.keep ? " keep" : ""}">`,
    "<table>",
    `<thead><tr>${headings.map((one) => `<th>${escape(one)}</th>`).join("")}</tr></thead>`,
    "<tbody>",
    ...labelled,
    "</tbody>",
    "</table>",
    "</div>",
  ].join("\n");
}

export interface PageFrame {
  /** The page's own name, which is also what the nav marks as the one you are on. */
  title: string;
  /** What the page's heading says when it is a sentence rather than the page's name. */
  heading?: string;
  /** The sentence an act left behind, already one of the pinned ones, or null. */
  notice?: string | null;
  /** The body, already assembled and already escaped. */
  body: string;
  /** Where in the nav this page sits. */
  here: string;
}

const NAV: { at: string; name: string }[] = [
  { at: "/", name: "status" },
  { at: "/chats", name: "chats" },
  { at: "/people", name: "people" },
  { at: "/usage", name: "usage" },
  { at: "/findings", name: "findings" },
  { at: "/metrics", name: "metrics" },
];

/**
 * The font files the board serves, by the name a page asks for and nothing
 * else: a request for any other name is the 404, so this list is the whole of
 * what `/fonts/` can read. Copied byte for byte from the `@fontsource-variable`
 * packages named in `assets/fonts/sources.json`, with their licences beside.
 */
export const FONT_FILES: Record<string, string> = {
  "golos-text-latin-wght-normal.woff2": "font/woff2",
  "golos-text-latin-ext-wght-normal.woff2": "font/woff2",
  "golos-text-cyrillic-wght-normal.woff2": "font/woff2",
  "golos-text-cyrillic-ext-wght-normal.woff2": "font/woff2",
  "jetbrains-mono-latin-wght-normal.woff2": "font/woff2",
  "jetbrains-mono-latin-ext-wght-normal.woff2": "font/woff2",
  "jetbrains-mono-cyrillic-wght-normal.woff2": "font/woff2",
  "jetbrains-mono-cyrillic-ext-wght-normal.woff2": "font/woff2",
  "golos-text-LICENSE.txt": "text/plain; charset=utf-8",
  "jetbrains-mono-LICENSE.txt": "text/plain; charset=utf-8",
};

/** Each subset's characters, as the packages declare them, so a page fetches only the files its text needs. */
const SUBSETS: [string, string][] = [
  ["cyrillic-ext", "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F"],
  ["cyrillic", "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116"],
  ["latin-ext", "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF"],
  ["latin", "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"],
];

const FACES = [
  ["Golos Text", "golos-text"],
  ["JetBrains Mono", "jetbrains-mono"],
].flatMap(([family, file]) =>
  SUBSETS.map(([subset, range]) =>
    `@font-face { font-family: "${family}"; font-style: normal; font-display: swap; font-weight: 400 700; ` +
    `src: url("/fonts/${file}-${subset}-wght-normal.woff2") format("woff2"); unicode-range: ${range}; }`,
  ),
);

/** The width below which a table is one block per row. Chosen: a phone is under it and a tablet is over it. */
const NARROW = "599px";

const STYLE = [
  ...FACES,
  ":root { color-scheme: light dark; --paper: #f6f4ec; --surface: #fbf9f2; --line: #ddd7c7; --ink: #1b1d1a; --soft: #585b51; --accent: #0f9999;",
  "  --sans: \"Golos Text\", system-ui, -apple-system, \"Segoe UI\", sans-serif; --mono: \"JetBrains Mono\", ui-monospace, Menlo, monospace; }",
  "@media (prefers-color-scheme: dark) { :root { --paper: #141310; --surface: #1c1b17; --line: #34322b; --ink: #ece9e0; --soft: #a8a597; --accent: #60baba; } }",
  "* { box-sizing: border-box; }",
  "html { -webkit-text-size-adjust: 100%; background: var(--paper); }",
  "body { background: var(--paper); color: var(--ink); font: 400 16px/1.5 var(--sans); margin: 0 auto; max-width: 72rem; overflow-x: hidden; padding: 0 1rem 4rem; }",
  "a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 0.18em; }",
  "a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
  "h1 { font-size: 1.375rem; font-weight: 650; letter-spacing: -0.01em; line-height: 1.3; margin: 1.25rem 0 0.25rem; }",
  "h2 { font-size: 1.0625rem; font-weight: 600; margin: 2rem 0 0.5rem; }",
  "h3 { color: var(--soft); font-size: 0.9375rem; font-weight: 600; margin: 1.25rem 0 0.25rem; }",
  "p { margin: 0.5rem 0; }",
  // The nav is a row that scrolls sideways rather than wrapping, so every
  // page is one tap away on a phone, and each link is a 44 pixel target.
  "nav { border-bottom: 1px solid var(--line); display: flex; margin: 0 -1rem; overflow-x: auto; padding: 0 0.4rem; scrollbar-width: none; white-space: nowrap; -webkit-overflow-scrolling: touch; }",
  "nav a, nav strong { align-items: center; border-bottom: 2px solid transparent; display: inline-flex; font-size: 0.875rem; min-height: 44px; padding: 0 0.55rem; text-decoration: none; }",
  "nav strong { border-bottom-color: var(--accent); color: var(--ink); font-weight: 600; }",
  "p.sub, p.empty, p.back { color: var(--soft); }",
  "p.notice { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; margin: 1rem 0; padding: 0.6rem 0.8rem; }",
  // A list of chats or findings: one row each, the name and who on one line,
  // then the one sentence, then why in the softer ink.
  "ul.chats, ul.findings { list-style: none; margin: 0.75rem 0 0; padding: 0; }",
  "ul.chats li, ul.findings li { border-top: 1px solid var(--line); padding: 0.7rem 0; }",
  "ul.chats li:last-child, ul.findings li:last-child { border-bottom: 1px solid var(--line); }",
  ".head { align-items: baseline; display: flex; flex-wrap: wrap; gap: 0.15rem 0.6rem; }",
  ".head .name { font-size: 1.0625rem; font-weight: 600; }",
  ".head .kind { font-weight: 600; }",
  ".who, .on { color: var(--soft); font-size: 0.875rem; }",
  ".says { margin-top: 0.1rem; overflow-wrap: break-word; }",
  "li.attention .says { font-weight: 600; }",
  "li.attention .head .name::after { color: var(--accent); content: \" ●\"; font-size: 0.75rem; vertical-align: 0.15em; }",
  ".why { color: var(--soft); font-size: 0.9375rem; margin-top: 0.1rem; overflow-wrap: break-word; }",
  // A command a person copies: the literal face, a whole block, chosen by one tap.
  "code, .id, td.list { font-family: var(--mono); font-size: 0.875em; }",
  "code { background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 0 0.25rem; }",
  "code.cmd { display: block; margin-top: 0.35rem; overflow-wrap: anywhere; padding: 0.5rem 0.65rem; user-select: all; -webkit-user-select: all; white-space: pre-wrap; }",
  ".fix .on { display: block; margin-top: 0.35rem; }",
  "td.fix .on { margin-top: 0; }",
  // The words around a command stay words: in the reading face, outside the
  // box, set off from the finding's own sentence by a neutral hairline.
  "div.fix { border-left: 2px solid var(--line); margin-top: 0.45rem; padding-left: 0.65rem; }",
  "div.fix > :first-child { margin-top: 0; }",
  ".fix .lead, .fix .tail, .fix .none { display: block; overflow-wrap: break-word; }",
  ".fix .lead + .on, .fix .lead + code.cmd { margin-top: 0.35rem; }",
  ".fix .tail { color: var(--soft); margin-top: 0.35rem; }",
  // Why no command is shown: a note about the fix, not a step of it.
  ".fix .none { color: var(--soft); font-size: 0.9375rem; margin-top: 0.35rem; }",
  // A machine folded to one summary line that opens to its tables.
  "details.machine { border-top: 1px solid var(--line); }",
  "details.machine:last-of-type { border-bottom: 1px solid var(--line); }",
  "details.machine > summary { align-items: baseline; cursor: pointer; display: flex; flex-wrap: wrap; gap: 0.15rem 0.6rem; list-style: none; min-height: 44px; padding: 0.65rem 0 0.65rem 1.1rem; position: relative; }",
  "details.machine > summary::-webkit-details-marker { display: none; }",
  "details.machine > summary::before { color: var(--soft); content: \"▸\"; left: 0; position: absolute; }",
  "details.machine[open] > summary::before { content: \"▾\"; }",
  "details.machine > summary .name { font-weight: 600; }",
  "details.machine[open] { padding-bottom: 1rem; }",
  "table { border-collapse: collapse; width: 100%; }",
  // Words wrap between words. `anywhere` would let a table squeeze a column
  // until a word or a number broke in the middle, so it is kept for the cells
  // that hold a literal command and nowhere else.
  "th, td { border-bottom: 1px solid var(--line); overflow-wrap: break-word; padding: 0.45rem 0.6rem 0.45rem 0; text-align: left; vertical-align: top; }",
  "th { color: var(--soft); font-size: 0.8125rem; font-weight: 600; }",
  "td.word { color: var(--accent); }",
  ".nw { white-space: nowrap; }",
  "td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }",
  "p.empty, td.said, .line .meta { color: var(--soft); }",
  "form { display: inline; }",
  "button { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; color: var(--accent); cursor: pointer; font: 500 0.9375rem var(--sans); margin: 0 0.4rem 0.25rem 0; min-height: 44px; padding: 0.1rem 0.9rem; }",
  // A chat line: the time and the sender muted above, the text as the person
  // wrote it, code kept as code and wrapped rather than scrolled.
  ".line { border-bottom: 1px solid var(--line); padding: 0.65rem 0; }",
  ".line .meta { font-size: 0.8125rem; }",
  ".line .text { overflow-wrap: break-word; white-space: pre-wrap; }",
  "pre { background: var(--surface); border: 1px solid var(--line); border-radius: 4px; font-family: var(--mono); font-size: 0.875em; margin: 0.25rem 0; overflow-wrap: anywhere; padding: 0.5rem; white-space: pre-wrap; }",
  "pre code { background: none; border: 0; font-size: 1em; padding: 0; }",
  `@media (max-width: ${NARROW}) {`,
  // One block per row. The heading row goes, and each cell says its own
  // heading before its value, so the wide numeric tables read as a list of
  // labelled facts and nothing has to scroll sideways.
  "  table, tbody, tr, td { display: block; width: 100%; }",
  "  thead { display: none; }",
  "  tr { border-bottom: 1px solid var(--line); padding: 0.6rem 0; }",
  "  td { border-bottom: 0; display: grid; gap: 0 0.75rem; grid-template-columns: 7.5rem minmax(0, 1fr); padding: 0.1rem 0; }",
  "  td::before { color: var(--soft); content: attr(data-label); font-family: var(--sans); font-size: 0.8125rem; padding-top: 0.1rem; }",
  '  td[data-label=""] { display: block; padding-top: 0.35rem; }',
  '  td[data-label=""]::before { content: none; }',
  "  td.num { white-space: normal; }",
  "  td.fix { display: block; }",
  "  td.fix::before { display: block; }",
  "  .compact td.nil { display: none; }",
  // A compact block is dense: a narrower label column, and its one button
  // beside the name on the block's first line rather than a line of its own.
  "  .compact tr { padding: 0.5rem 0; position: relative; }",
  "  .compact td { grid-template-columns: 6rem minmax(0, 1fr); line-height: 1.4; }",
  "  .compact td.acts { padding: 0; position: absolute; right: 0; top: 0.5rem; width: auto; }",
  "  .compact td.acts button { margin: 0; min-height: 40px; }",
  "  .compact tr:has(td.acts) td:first-child { align-items: center; min-height: 40px; padding-right: 5.75rem; }",
  // A kept table stays a table: four short columns fit a phone as they are.
  "  .keep table { display: table; }",
  "  .keep thead { display: table-header-group; }",
  "  .keep tbody { display: table-row-group; }",
  "  .keep tr { border-bottom: 0; display: table-row; padding: 0; }",
  "  .keep td { border-bottom: 1px solid var(--line); display: table-cell; padding: 0.35rem 0.5rem 0.35rem 0; width: auto; }",
  "  .keep td::before { content: none; }",
  "  .keep th, .keep td { font-size: 0.875rem; }",
  "}",
  `@media (min-width: 600px) {`,
  "  .rows { overflow-x: auto; }",
  "  body { padding: 0 1.5rem 4rem; }",
  "  nav { margin: 0; padding: 0; }",
  "  h1 { font-size: 1.625rem; margin-top: 1.75rem; }",
  "  td.acts { white-space: nowrap; }",
  // An id and a time are read whole: never broken at a hyphen inside them.
  "  td.id, td.when { white-space: nowrap; }",
  // A long why beside it never squeezes a state into a narrow column.
  "  td.word { min-width: min(22rem, 30vw); }",
  // A fix cell holds a copy box that may break anywhere, so a table would
  // squeeze it to nothing; it keeps room for a command to read in a few lines.
  "  td.fix { min-width: min(26rem, 45vw); width: 40%; }",
  // So the room is taken from the columns beside it rather than pushing the
  // last one out of sight: a long subject wraps at its own hyphens, the time
  // between date and hour (each kept whole by its span), and a path inside the
  // finding's sentence anywhere.
  "  .rows:has(td.fix) td.id, .rows:has(td.fix) td.when { white-space: normal; }",
  "  .rows:has(td.fix) td.said { min-width: 12rem; overflow-wrap: anywhere; }",
  "  button { min-height: 36px; padding: 0.1rem 0.7rem; }",
  "  ul.chats, ul.findings { max-width: 52rem; }",
  "  nav a, nav strong { font-size: 0.9375rem; padding: 0 0.7rem; }",
  "}",
  // A wide screen puts what `check` holds beside the chats rather than below.
  "@media (min-width: 1100px) {",
  "  .first { align-items: start; display: grid; gap: 0 3rem; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }",
  "  .first ul.chats, .first ul.findings { max-width: none; }",
  "  .first .found h2 { margin-top: 0; }",
  "  .first .found ul.findings { margin-top: 0.4rem; }",
  "}",
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
    '<meta name="color-scheme" content="light dark">',
    `<title>${escape(frame.title)}</title>`,
    // The face every page opens with, asked for before the stylesheet finds it.
    '<link rel="preload" href="/fonts/golos-text-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>',
    `<style>\n${STYLE}\n</style>`,
    "</head>",
    "<body>",
    `<nav>${links}</nav>`,
    `<h1>${escape(frame.heading ?? frame.title)}</h1>`,
    frame.notice ? `<p class="notice">${escape(frame.notice)}</p>` : "",
    frame.body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
