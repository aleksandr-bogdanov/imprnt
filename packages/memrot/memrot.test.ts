// memrot tests — every check gets a minimal workspace built in a temp dir, then we
// assert on the findings it produces (and, just as important, the ones it must not).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
// @ts-ignore - plain js module, no types on purpose (zero-build package)
import { runChecks, maskCode, maskFrontmatter, render } from "./memrot.js";

const roots: string[] = [];
function ws(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "memrot-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const TODAY = new Date("2026-08-27T12:00:00Z");
const run = (root: string) => runChecks(root, { today: TODAY });
const of = (r: ReturnType<typeof runChecks>, check: string) =>
  r.findings.filter((f: any) => f.check === check);

describe("links", () => {
  test("dead wikilink and dead relative link are problems; live ones are not", () => {
    const r = run(
      ws({
        "MEMORY.md": "# m\n\n[[notes/alive]] and [[notes/gone]] and [a](notes/alive.md) and [b](notes/missing.md)\n",
        "notes/alive.md": "# alive\n",
      }),
    );
    const links = of(r, "links");
    expect(links.length).toBe(2);
    expect(links.map((f: any) => f.message).join(" ")).toContain("notes/gone");
    expect(links.map((f: any) => f.message).join(" ")).toContain("notes/missing.md");
  });

  test("wikilinks resolve by basename anywhere; md links get a moved? suggestion instead", () => {
    const r = run(
      ws({
        "MEMORY.md": "# m\n\n[[flat-viewing]] and [f](notes/flat-viewing.md)\n",
        "archive/flat-viewing.md": "# fv\n",
      }),
    );
    const links = of(r, "links");
    expect(links.length).toBe(1);
    expect(links[0].message).toContain("moved?");
    expect(links[0].message).toContain("archive/flat-viewing.md");
  });

  test("case-only matches are flagged (they break on case-sensitive disks)", () => {
    const r = run(
      ws({
        "MEMORY.md": "# m\n\n[n](Notes/Thing.md)\n",
        "notes/thing.md": "# t\n",
      }),
    );
    expect(of(r, "links")[0].message).toContain("case");
  });

  test("links in code fences, urls, and anchors are ignored", () => {
    const r = run(
      ws({
        "MEMORY.md":
          "# m\n\n```\n[[not/a/link]]\n[x](fake/path.md)\n```\n[web](https://example.com) [m](mailto:a@b.c) [a](#section) [abs](/concepts/x)\n",
      }),
    );
    expect(of(r, "links").length).toBe(0);
  });
});

describe("orphans", () => {
  test("unlinked note is an orphan; well-known roots, dated logs, and linked notes are not", () => {
    const r = run(
      ws({
        "AGENTS.md": "# a\n",
        "MEMORY.md": "# m\n\n[[notes/linked]]\n",
        "notes/linked.md": "# l\n",
        "notes/lonely.md": "# lonely note that nothing references anywhere\n",
        "memory/2026-08-01-0900.md": "# Session\n",
        "skills/foo/SKILL.md": "# skill\n",
      }),
    );
    const orphans = of(r, "orphans").map((f: any) => f.file);
    expect(orphans).toEqual(["notes/lonely.md"]);
  });
});

describe("duplicates", () => {
  test("near-identical files are caught", () => {
    const body =
      "Deep dive on the health insurance switch. TK exit confirmed for end of September. " +
      "OGK needs passport copy, Meldezettel, employer confirmation from HR. Deadline for the " +
      "employer letter is early September. Marco asked to be reminded if the letter has not arrived. " +
      "Restaurant shortlist for the birthday narrowed to Mraz and Sohn. Also discussed the server " +
      "backup rotation and agreed to keep nightly restic runs with weekly verification checks.";
    const r = run(
      ws({
        "memory/2026-08-20-1415.md": "# Session A\n\n" + body + "\n",
        "memory/2026-08-20-1417.md": "# Session B\n\n" + body + " One extra sentence here.\n",
        "notes/unrelated.md":
          "# Something else entirely\n\nGroceries, bike routes, a book list, and a recipe for shakshuka that has nothing in common with insurance paperwork at all. Completely different words about completely different things, long enough to have shingles of its own.\n",
      }),
    );
    const dups = of(r, "duplicates").filter((f: any) => f.severity === "warn");
    expect(dups.length).toBe(1);
    expect(dups[0].message).toContain("2026-08-20-1417");
  });

  test("the same long line across 3+ files is reported once", () => {
    const line = "Marco prefers concise updates; briefing goes to Telegram at 08:00; timezone Europe/Berlin.";
    const r = run(
      ws({
        "memory/2026-08-14-0910.md": `# S\n\n${line}\n`,
        "memory/2026-08-15-0905.md": `# S\n\n${line}\n`,
        "memory/2026-08-16-2340.md": `# S\n\n${line}\n`,
      }),
    );
    const rep = of(r, "duplicates").filter((f: any) => f.severity === "info");
    expect(rep.length).toBe(1);
    expect(rep[0].message).toContain("3 files");
  });
});

describe("stale", () => {
  test("past-due lines flagged in durable files, ignored in dated logs", () => {
    const r = run(
      ws({
        "MEMORY.md": "# m\n\n- insurance: renew by 2026-05-31\n- rent paid until 2026-01-01\n",
        "memory/2026-05-01-0900.md": "# S\n\nrenew by 2026-05-31 discussed\n",
      }),
    );
    const stale = of(r, "stale");
    expect(stale.every((f: any) => f.file === "MEMORY.md")).toBe(true);
    expect(stale.length).toBe(2);
    expect(stale[0].message).toContain("88 days");
  });

  test("aging active directives and future observed dates", () => {
    const r = run(
      ws({
        "USER.md":
          "# u\n\n<!-- observed: 2026-01-14 | status: active -->\n\n- Prefer concise updates.\n\n" +
          "<!-- observed: 2026-08-20 | status: active -->\n\n- Always reply in German.\n\n" +
          "<!-- observed: 2027-01-01 | status: active -->\n\n- Never book flights without asking.\n",
      }),
    );
    const stale = of(r, "stale");
    expect(stale.filter((f: any) => f.message.includes("still true")).length).toBe(1);
    expect(stale.filter((f: any) => f.message.includes("future")).length).toBe(1);
  });

  test("relative time words rot in MEMORY.md but are fine in dailies", () => {
    const r = run(
      ws({
        "MEMORY.md": "# m\n\n- decide about the gym next week\n",
        "memory/2026-08-20-0900.md": "# S\n\nMarco said he will decide next week.\n",
      }),
    );
    const rel = of(r, "stale").filter((f: any) => f.message.includes("relative"));
    expect(rel.length).toBe(1);
    expect(rel[0].file).toBe("MEMORY.md");
  });
});

describe("conflicts", () => {
  test("same key with different values across durable root files", () => {
    const r = run(
      ws({
        "MEMORY.md": "# m\n\n- Timezone: Europe/Vienna\n",
        "USER.md": "# u\n\n- Timezone: Europe/Berlin\n",
      }),
    );
    const c = of(r, "conflicts");
    expect(c.length).toBe(1);
    expect(c[0].message).toContain("timezone");
    expect(c[0].message).toContain("Europe/Vienna");
    expect(c[0].message).toContain("Europe/Berlin");
  });

  test("opposite-polarity directives about the same thing", () => {
    const r = run(
      ws({
        "USER.md":
          "# u\n\n- Always send the morning briefing to Telegram.\n- Never send the morning briefing to Telegram before 08:00.\n",
      }),
    );
    expect(of(r, "conflicts").some((f: any) => f.message.includes("contradiction"))).toBe(true);
  });

  test("noise keys and dated logs never produce conflicts", () => {
    const r = run(
      ws({
        "memory/2026-08-01-0900.md": "# S\n\n- **Session ID**: abc\n",
        "memory/2026-08-02-0900.md": "# S\n\n- **Session ID**: def\n",
        "MEMORY.md": "# m\n\n- Status: active\n",
        "USER.md": "# u\n\n- Status: parked\n",
      }),
    );
    expect(of(r, "conflicts").length).toBe(0);
  });
});

describe("hygiene", () => {
  test("merge conflict markers, empty files, unclosed frontmatter, placeholders", () => {
    const r = run(
      ws({
        "memory/2026-08-18-0902.md": "# S\n\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> origin/main\n",
        "notes/empty.md": "",
        "notes/badfm.md": "---\ntitle: x\nnever closed\n",
        "USER.md": "# u\n\n<!-- observed: YYYY-MM-DD | status: active -->\n\n- Prefer ...\n",
      }),
    );
    const msgs = of(r, "hygiene").map((f: any) => f.message).join("\n");
    expect(msgs).toContain("merge conflict");
    expect(msgs).toContain("empty");
    expect(msgs).toContain("never closes");
    expect(msgs).toContain("YYYY-MM-DD");
    expect(msgs).toContain("unfinished template line");
  });

  test("placeholders inside code are documentation, not rot", () => {
    const r = run(
      ws({
        "AGENTS.md": "# a\n\nPrecede each directive with `<!-- observed: YYYY-MM-DD | status: active -->`.\n",
      }),
    );
    expect(of(r, "hygiene").length).toBe(0);
  });

  test("filename case collisions are problems", () => {
    const r = run(ws({ "MEMORY.md": "# a\n", "memory.md": "# b\n" }));
    const c = of(r, "hygiene").filter((f: any) => f.message.includes("case collision"));
    expect(c.length).toBe(1);
    expect(c[0].severity).toBe("problem");
  });

  test("openclaw-style workspaces: skill folder without SKILL.md", () => {
    const r = run(
      ws({
        "AGENTS.md": "# a\n",
        "SOUL.md": "# s\n",
        "skills/ok/SKILL.md": "# ok\n",
        "skills/broken/notes.md": "# scratch\n",
      }),
    );
    const c = of(r, "hygiene").filter((f: any) => f.message.includes("SKILL.md"));
    expect(c.length).toBe(1);
    expect(c[0].file).toBe("skills/broken/");
  });
});

describe("other workspace shapes", () => {
  test("nanobot: nested memory/MEMORY.md is durable — conflicts with root USER.md are caught, and it is no orphan", () => {
    const r = run(
      ws({
        "AGENTS.md": "# a\n",
        "USER.md": "# u\n\n- City: Hamburg\n",
        "memory/MEMORY.md": "# Long-term Memory\n\n- City: Leipzig\n- Passport renewal must be booked until 2026-06-15\n",
      }),
    );
    expect(of(r, "conflicts").length).toBe(1);
    expect(of(r, "conflicts")[0].message).toContain("city");
    expect(of(r, "stale").some((f: any) => f.file === "memory/MEMORY.md")).toBe(true);
    expect(of(r, "orphans").length).toBe(0);
  });

  test("hermes: same entry twice in a durable file is flagged; dailies are left alone", () => {
    const line = "- Project atlas: client is Berenberg, kickoff was 2026-05-12, weekly sync Thursdays";
    const r = run(
      ws({
        "memories/MEMORY.md": `${line}\n- something else entirely, unrelated and long enough\n${line}\n`,
        "memory/2026-08-01-0900.md": `# S\n\n${line}\n${line}\n`,
      }),
    );
    const dups = of(r, "duplicates").filter((f: any) => f.message.includes("twice in this file"));
    expect(dups.length).toBe(1);
    expect(dups[0].file).toBe("memories/MEMORY.md");
  });

  test("moved? suggestion never points at the linking file and stays silent when ambiguous", () => {
    const r = run(
      ws({
        "skills/a/deep/SKILL.md": "# a\n\n[b](../missing/SKILL.md)\n",
        "skills/b/deep/SKILL.md": "# b\n",
        "skills/c/deep/SKILL.md": "# c\n",
      }),
    );
    const links = of(r, "links");
    expect(links.length).toBe(1);
    expect(links[0].message).not.toContain("moved?");
    // and nested SKILL.md files are not orphans — they load by name
    expect(of(r, "orphans").length).toBe(0);
  });
});

describe("plumbing", () => {
  test("maskCode blanks fences and inline code but keeps line count", () => {
    const src = "a\n```js\n[[link]]\n```\nb `[[inline]]` c\n";
    const masked = maskCode(src);
    expect(masked.split("\n").length).toBe(src.split("\n").length);
    expect(masked).not.toContain("[[link]]");
    expect(masked).not.toContain("[[inline]]");
    expect(masked).toContain("b ");
  });

  test("maskFrontmatter strips only the leading block", () => {
    expect(maskFrontmatter("---\ntitle: x\n---\nbody\n")).toBe("\n\n\nbody\n");
    expect(maskFrontmatter("body first\n---\n")).toBe("body first\n---\n");
  });

  test("scan never writes: mtimes are untouched and stats add up", () => {
    const root = ws({ "MEMORY.md": "# m\n\n[[gone]]\n" });
    const before = statSync(join(root, "MEMORY.md")).mtimeMs;
    const r = run(root);
    expect(statSync(join(root, "MEMORY.md")).mtimeMs).toBe(before);
    expect(r.stats.problems + r.stats.warns + r.stats.infos).toBe(r.findings.length);
  });

  test("render mentions imprnt exactly once, in the last line", () => {
    const r = run(ws({ "MEMORY.md": "# m\n" }));
    const text = render(r);
    const lines = text.trim().split("\n");
    const mentions = lines.filter((l: string) => l.toLowerCase().includes("imprnt"));
    expect(mentions.length).toBe(1);
    expect(lines[lines.length - 1].toLowerCase()).toContain("imprnt");
  });
});
