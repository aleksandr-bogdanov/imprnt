import { escape } from "./html.ts";

/**
 * A chat line's text as a page shows it: ESCAPED FIRST, then wrapped.
 *
 * The order is the whole rule. Every character a person typed goes through
 * `escape` before any tag is added, so a `<script>` in a message is text on
 * the page and never an element, and what the wrapping adds is only the six
 * tags below, around text that is already inert. Nothing here reads the
 * text as markup it should honour.
 *
 * What is wrapped: fenced code blocks, inline code, `**bold**`, bare https
 * and http links, and newlines. A `[[wikilink]]` is shown as the words
 * inside it, because a page nobody identified has no vault to point into.
 */
export function renderChatText(text: string): string {
  const safe = escape(text);
  // Fenced blocks first, whole, so nothing inside one is read as a span.
  const fence = /```(?:[^\n`]*)\n?([\s\S]*?)```/g;
  let out = "";
  let at = 0;
  for (const found of safe.matchAll(fence)) {
    out += spans(safe.slice(at, found.index));
    out += `<pre><code>${found[1].replace(/\n$/, "")}</code></pre>`;
    at = (found.index ?? 0) + found[0].length;
  }
  out += spans(safe.slice(at));
  return out;
}

/** The inline shapes, on text that carries no fenced block. */
function spans(safe: string): string {
  // Inline code next, whole, so a URL or a star inside a span stays as typed.
  const code = /`([^`\n]+)`/g;
  let out = "";
  let at = 0;
  for (const found of safe.matchAll(code)) {
    out += plain(safe.slice(at, found.index));
    out += `<code>${found[1]}</code>`;
    at = (found.index ?? 0) + found[0].length;
  }
  out += plain(safe.slice(at));
  return out;
}

/** Bold, wikilinks shown as their words, bare links, and newlines kept. */
function plain(safe: string): string {
  return safe
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[\[([^\]\n]+)\]\]/g, "$1")
    // The text is escaped already, so `&amp;` inside a link is what the href
    // has to carry too, and a quote can no longer end the attribute.
    .replace(/https?:\/\/[^\s<]*[^\s<.,;:!?)]/g, (url) => `<a href="${url}">${url}</a>`)
    .replace(/\n/g, "<br>\n");
}
