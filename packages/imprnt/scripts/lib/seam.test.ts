// Unit tests for the seam predicates. These are the exact functions `imprnt vault move` asks BEFORE a
// note crosses into a mount and `imprnt check` asks AFTER, so a disagreement here is a tool that moves
// a note into a state its own checker condemns. Testing them once, directly, is what keeps the two honest.
import { test, expect } from "bun:test";
import { corpusOf, resolveSlugs, mountOf, innerFolder, isEvidenceTarget, graphLinks, isSeamLeak, hasMountTwin, sourceTargets, deadSourceTargets, hasConflictMarkers, replaceOutsideCode, mountAcceptsFolder, mountFolderRoster, setFrontmatterKey, moveInProgressLine, moveDoneLine, unfinishedMoves } from "./seam.ts";
import { DEFAULT_ENTITIES, DEFAULT_DOMAINS, DEFAULT_FORMS, type FolderRoles } from "./folders.ts";
import { frontmatter } from "./moc.ts";

const corpus = corpusOf([
  { slug: "people/sam" },
  { slug: "orgs/acme" },
  { slug: "finances/rent" },
  { slug: "household/people/sam" },
  { slug: "household/finances/rent" },
]);

test("a path target resolves to one note, a bare name to every folder holding it", () => {
  expect(resolveSlugs("people/sam", corpus)).toEqual(["people/sam"]);
  expect(resolveSlugs("sam", corpus).sort()).toEqual(["household/people/sam", "people/sam"]);
  expect(resolveSlugs("people/ghost", corpus)).toEqual([]);
});

test("a `.md` suffix and a `./` prefix resolve the same as the bare slug", () => {
  expect(resolveSlugs("./people/sam.md", corpus)).toEqual(["people/sam"]);
});

test("mountOf reads the first path segment, and innerFolder the second", () => {
  expect(mountOf("household/finances/rent", ["household"])).toBe("household");
  expect(mountOf("finances/rent", ["household"])).toBeUndefined();
  expect(innerFolder("household/finances/rent", "household")).toBe("finances");
  expect(innerFolder("household/loose", "household")).toBe(""); // a note sitting at the mount root
});

test("evidence links are the top-level raw/ and each mount's own _raw/, and nothing else", () => {
  const mounts = ["household", "team"];
  expect(isEvidenceTarget("raw/lease/scan", mounts)).toBe(true);
  expect(isEvidenceTarget("household/_raw/lease/scan", mounts)).toBe(true);
  expect(isEvidenceTarget("team/_raw/x", mounts)).toBe(true);
  expect(isEvidenceTarget("household/finances/rent", mounts)).toBe(false);
  expect(isEvidenceTarget("rawhide/x", mounts)).toBe(false); // a folder that merely starts with "raw"
});

test("graphLinks drops evidence links and anything inside code, and keeps frontmatter links", () => {
  const raw = [
    "---",
    "owner: \"[[people/sam]]\"",
    "source: \"[[household/_raw/lease/scan]]\"",
    "---",
    "",
    "# Rent",
    "",
    "signed at [[orgs/acme]]",
    "```sh",
    "[[ -f x ]] && echo [[people/ghost]]",
    "```",
  ].join("\n");
  expect(graphLinks(raw, ["household"]).sort()).toEqual(["orgs/acme", "people/sam"]);
});

test("a seam leak is a link that resolves ONLY outside the mount", () => {
  expect(isSeamLeak("people/sam", "household", corpus)).toBe(true);
  expect(isSeamLeak("household/people/sam", "household", corpus)).toBe(false);
  // Unresolvable is an orphan, which check already reports. Never both.
  expect(isSeamLeak("people/ghost", "household", corpus)).toBe(false);
  // A bare name that a mount note can answer inside the mount is not a leak.
  expect(isSeamLeak("sam", "household", corpus)).toBe(false);
});

test("a mount twin is the same relative path filed inside the mount", () => {
  expect(hasMountTwin("people/sam", "household", corpus)).toBe(true);
  expect(hasMountTwin("orgs/acme", "household", corpus)).toBe(false);
  expect(hasMountTwin("household/people/sam", "household", corpus)).toBe(true);
});

test("source targets come from both the singular and the plural field, unwrapped", () => {
  const fm = "source: \"[[raw/a/one]]\"\nsources: [\"[[raw/b/two]]\", \"[[household/_raw/three]]\"]";
  expect(sourceTargets(fm).sort()).toEqual(["household/_raw/three", "raw/a/one", "raw/b/two"]);
  expect(deadSourceTargets(fm).sort()).toEqual(["raw/a/one", "raw/b/two"]);
});

test("conflict markers are read at column 0 on the raw text, fence or no fence", () => {
  expect(hasConflictMarkers("# Note\n\n<<<<<<< HEAD\nours\n")).toBe(true);
  expect(hasConflictMarkers("# Note\n\n```\n<<<<<<< HEAD\n```\n")).toBe(true);
  expect(hasConflictMarkers("# Note\n\n  <<<<<<< indented, quoting the shape\n")).toBe(false);
  expect(hasConflictMarkers("# Note\n\nnothing here\n")).toBe(false);
});

// The rewriting half of the same fence rule graphLinks reads by. `vault move` calls this, so a link
// the checker ruled out as an edge is a link the mover must leave alone.
test("replaceOutsideCode rewrites prose links and never touches a fenced or inline-code one", () => {
  const re = () => /\[\[finances\/rent(?:\.md)?((?:#|\|)[^\]]*)?\]\]/g;
  const raw = [
    "the live one is [[finances/rent]] and [[finances/rent|the flat]]",
    "```md",
    "see [[finances/rent]]",
    "```",
    "an inline `[[finances/rent]]` example",
  ].join("\n");
  const { text, count } = replaceOutsideCode(raw, re(), (m) => `[[shared/finances/rent${m[1] ?? ""}]]`);
  expect(count).toBe(2);
  expect(text).toContain("the live one is [[shared/finances/rent]] and [[shared/finances/rent|the flat]]");
  expect(text).toContain("```md\nsee [[finances/rent]]\n```");
  expect(text).toContain("an inline `[[finances/rent]]` example");
});

test("a link that opens in prose and closes inside a fence is not an edge either", () => {
  // Both ends of a match are tested against the mask. With only the start tested, a stray `[[` above
  // an unterminated fence swallowed the fence and became a bogus link - a finding an upgrade would
  // hand a vault that had never had one.
  const raw = "see [[foo\n```\nbar]]\n";
  expect(graphLinks(raw, [])).toEqual([]);
});

test("an alias carrying an inline-code span still rewrites with its true text", () => {
  // The match runs over the RAW note, not the masked copy, so the blanked span never leaks into the
  // bytes written back.
  const raw = "see [[finances/rent|the `lease` note]]";
  const { text, count } = replaceOutsideCode(raw, /\[\[finances\/rent((?:#|\|)[^\]]*)?\]\]/g, (m) => `[[shared/finances/rent${m[1] ?? ""}]]`);
  expect(count).toBe(1);
  expect(text).toBe("see [[shared/finances/rent|the `lease` note]]");
});

const roles = (declared: boolean, over: Partial<FolderRoles> = {}): FolderRoles => ({
  entities: new Set(DEFAULT_ENTITIES), domains: new Set(DEFAULT_DOMAINS), forms: new Set(DEFAULT_FORMS),
  mounts: new Set<string>(), declared, ...over,
});

test("a mount accepts any folder until it declares some, then only the ones it named", () => {
  // The one predicate both writers ask: `vault move` about its destination, `ingest --apply` about the
  // folder a type/domain maps to. If they diverged, one command would file what the other refuses.
  expect(mountAcceptsFolder("finances", roles(false))).toBe(true);
  expect(mountAcceptsFolder("anything", roles(false))).toBe(true);
  const declared = roles(true, { entities: new Set(["people"]), domains: new Set(["finances"]), forms: new Set(["events"]) });
  expect(mountAcceptsFolder("people", declared)).toBe(true);
  expect(mountAcceptsFolder("finances", declared)).toBe(true);
  expect(mountAcceptsFolder("events", declared)).toBe(true);
  expect(mountAcceptsFolder("health", declared)).toBe(false);
  expect(mountFolderRoster("shared", declared)).toBe("shared/ entities: people · domains: finances · forms: events");
});

test("setFrontmatterKey drops and sets inside the leading block only, leaving the body alone", () => {
  const note = "---\ntype: note\ndomain: finances\nmount: shared\ntags: [rent]\n---\n\n# Rent\n\nmount: shared is prose here\n";
  const dropped = setFrontmatterKey(note, "mount", null);
  expect(dropped).toContain("type: note");
  expect(dropped).toContain("mount: shared is prose here"); // the body line survives, key-shaped or not
  expect(frontmatter(dropped)).not.toContain("mount:");
  const set = setFrontmatterKey(dropped, "domain", "life");
  expect(frontmatter(set)).toContain("domain: life");
  expect(frontmatter(set).match(/^domain:/gm)?.length).toBe(1);
});

test("an unfinished move is the marker line in log.md, and finalising it removes the marker", () => {
  const open = moveInProgressLine("2026-09-01", "finances/rent", "shared/finances/rent", "shared");
  const log = `# Log\n\n- 2026-08-30 something else\n${open}\n`;
  expect(unfinishedMoves(log)).toEqual([{ from: "finances/rent", to: "shared/finances/rent" }]);
  const done = log.replace(open, moveDoneLine("2026-09-01", "finances/rent", "shared/finances/rent", "shared"));
  expect(unfinishedMoves(done)).toEqual([]);
  expect(done).toContain("moved [[finances/rent]] → [[shared/finances/rent]]");
});
