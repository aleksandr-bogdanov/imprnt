// Build-time brand pass for the docs. Every standalone "imprnt" becomes a
// gradient brand word, and every competitor tool name becomes a neutral code
// chip, so each page carries one consistent visual language without anyone
// hand-wrapping every mention. Runs on the rendered HTML (hast).
//
// What it skips: links, code, and pre (never restyle a hyperlink or code).
// Tool chips are skipped inside headings too, where a small mono chip in a
// large display heading reads as a glitch. The brand word is allowed in
// headings, where the gradient looks deliberate.

// The competitor roster, longest first so multi-word names match before any
// substring. Extend this list as the comparison page grows.
const TOOLS = [
  "Basic Memory",
  "OpenMemory",
  "Supermemory",
  "mempalace",
  "Graphiti",
  "cognee",
  "MemGPT",
  "Letta",
  "Obsidian",
  "Logseq",
  "Khoj",
  "Reor",
  "mem0",
  "Zep",
  "ECC",
  "iai",
].sort((a, b) => b.length - a.length);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Tool names sit between non-alphanumerics so "Reor" never fires inside
// "reorder" and "mem0" never inside "mem0ry-ish" identifiers.
const TOOL_RE = new RegExp(
  `(?<![A-Za-z0-9])(${TOOLS.map(escapeRe).join("|")})(?![A-Za-z0-9])`,
  "g",
);

// The brand word, lowercase only, never a fragment of a larger token such as
// the package name imprnt-plugin-timemachine or the word imprint.
const IMPRNT_RE = /(?<![A-Za-z0-9-])imprnt(?![A-Za-z0-9-])/g;

const SKIP = new Set(["a", "code", "pre"]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

const brandNode = () => ({
  type: "element",
  tagName: "span",
  properties: { className: ["brand-imprnt"] },
  children: [{ type: "text", value: "imprnt" }],
});

const toolNode = (name) => ({
  type: "element",
  tagName: "code",
  properties: { className: ["tool-name"] },
  children: [{ type: "text", value: name }],
});

// Split a string on a regex, keeping the gaps as text nodes and mapping each
// match through makeNode.
function splitText(value, re, makeNode) {
  const out = [];
  let last = 0;
  for (const m of value.matchAll(re)) {
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push(makeNode(m[0]));
    last = m.index + m[0].length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

export default function rehypeBrand() {
  return (tree) => {
    const walk = (node, inHeading) => {
      if (!node.children || !node.children.length) return;
      const next = [];
      for (const child of node.children) {
        if (child.type === "text") {
          let nodes = splitText(child.value, IMPRNT_RE, brandNode);
          if (!inHeading) {
            nodes = nodes.flatMap((n) =>
              n.type === "text" ? splitText(n.value, TOOL_RE, toolNode) : [n],
            );
          }
          next.push(...nodes);
          continue;
        }
        if (child.type === "element" && SKIP.has(child.tagName)) {
          next.push(child);
          continue;
        }
        const childHeading =
          inHeading || (child.type === "element" && HEADINGS.has(child.tagName));
        walk(child, childHeading);
        next.push(child);
      }
      node.children = next;
    };
    walk(tree, false);
  };
}
