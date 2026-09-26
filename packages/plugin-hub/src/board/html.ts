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
 * scrolls sideways with tap targets 44 pixels tall, and every table below 700
 * pixels laid out as one block per row with each cell labelled by its own
 * heading, so no page ever scrolls sideways. Two rulings bind the look: ONE
 * accent, used for links and for the sentence a card carries, and a service
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

/** What a measure with no data prints. A zero in a table a person reads is a claim. */
export const NOTHING = "-";

/**
 * One cell, its value escaped, empty printed as the nothing mark.
 *
 * The heading it sits under is written onto it by `table`, which is what lets
 * a phone lay the row out as a block and still say what each value is.
 */
export function cell(value: unknown, className = ""): string {
  const text = value === null || value === undefined || value === "" ? NOTHING : String(value);
  return `<td${className === "" ? "" : ` class="${className}"`}>${escape(text)}</td>`;
}

/** A cell holding markup a caller already escaped, such as a link or a form. */
export function rawCell(markup: string): string {
  return `<td>${markup}</td>`;
}

/**
 * A table: the headings once, then one row per list of cells.
 *
 * Every cell is stamped with the heading above it as `data-label`, which is
 * what the narrow stylesheet prints before the value once the columns are
 * gone. A heading that is empty stamps an empty label, and the stylesheet
 * prints nothing for it, so an acts column carries no stray word.
 */
export function table(headings: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  const labelled = rows.map((cells) =>
    "<tr>" +
    cells.map((one, at) => one.replace(/^<td/, `<td data-label="${escape(headings[at] ?? "")}"`)).join("") +
    "</tr>",
  );
  return [
    "<table>",
    `<thead><tr>${headings.map((one) => `<th>${escape(one)}</th>`).join("")}</tr></thead>`,
    "<tbody>",
    ...labelled,
    "</tbody>",
    "</table>",
  ].join("\n");
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
  { at: "/chats", name: "chats" },
  { at: "/usage", name: "usage" },
  { at: "/findings", name: "findings" },
  { at: "/metrics", name: "metrics" },
];

/** The width below which a table is one block per row. Chosen: a phone is under it and a tablet is over it. */
const NARROW = "699px";

const STYLE = [
  ":root { --ink: #1b1d1a; --paper: #fbfaf7; --line: #ddd7c7; --soft: #585b51; --accent: #0f5f5f; }",
  "* { box-sizing: border-box; }",
  "html { -webkit-text-size-adjust: 100%; }",
  "body { background: var(--paper); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 62rem; overflow-x: hidden; padding: 0.5rem 1rem 4rem; }",
  "a { color: var(--accent); overflow-wrap: anywhere; }",
  "h1 { font-size: 1.4rem; margin: 0.75rem 0 1rem; }",
  "h2 { font-size: 1.05rem; margin: 2rem 0 0.5rem; }",
  // The nav is a row that scrolls sideways rather than wrapping, so every
  // page is one tap away on a phone, and each link is a 44 pixel target.
  "nav { border-bottom: 1px solid var(--line); display: flex; gap: 0.25rem; margin: 0 -1rem 1rem; overflow-x: auto; padding: 0 0.5rem; white-space: nowrap; -webkit-overflow-scrolling: touch; }",
  "nav a, nav strong { align-items: center; display: inline-flex; min-height: 44px; padding: 0 0.6rem; text-decoration: none; }",
  "table { border-collapse: collapse; width: 100%; }",
  "th, td { border-bottom: 1px solid var(--line); overflow-wrap: anywhere; padding: 0.35rem 0.5rem; text-align: left; vertical-align: top; }",
  "th { color: var(--soft); font-weight: 600; }",
  "td.word { color: var(--accent); }",
  "p.empty, td.said, .line .when, .line .from { color: var(--soft); }",
  "p.notice { border: 1px solid var(--line); padding: 0.5rem 0.75rem; }",
  "form { display: inline; }",
  "button { background: none; border: 1px solid var(--line); color: var(--accent); cursor: pointer; font: inherit; min-height: 44px; padding: 0.1rem 0.75rem; }",
  // A chat line: the time and the sender muted, the text as the person wrote
  // it, code kept as code and wrapped rather than scrolled.
  ".line { border-bottom: 1px solid var(--line); padding: 0.5rem 0; }",
  ".line .text { white-space: pre-wrap; }",
  "pre { border: 1px solid var(--line); margin: 0.25rem 0; overflow-wrap: anywhere; padding: 0.5rem; white-space: pre-wrap; }",
  "code { border: 1px solid var(--line); padding: 0 0.2rem; }",
  "pre code { border: 0; padding: 0; }",
  `@media (max-width: ${NARROW}) {`,
  // One block per row. The heading row goes, and each cell says its own
  // heading before its value, so the wide numeric tables read as a list of
  // labelled facts and nothing has to scroll sideways.
  "  table, tbody, tr, td { display: block; width: 100%; }",
  "  thead { display: none; }",
  "  tr { border-bottom: 1px solid var(--line); padding: 0.5rem 0; }",
  "  td { border-bottom: 0; padding: 0.15rem 0; }",
  "  td::before { color: var(--soft); content: attr(data-label); display: block; font-size: 0.85rem; }",
  '  td[data-label=""]::before { content: none; }',
  "  form { display: inline-block; margin: 0.25rem 0.5rem 0 0; }",
  "}",
  `@media (min-width: 700px) {`,
  "  body { padding: 1.5rem 1rem 4rem; }",
  "  nav { margin: 0 0 1.5rem; padding: 0; }",
  "  button { min-height: 0; padding: 0.1rem 0.5rem; }",
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
