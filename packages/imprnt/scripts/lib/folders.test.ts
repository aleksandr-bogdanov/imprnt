// Tests for declared folder roles. The behaviour that matters is the DEFAULT one: a vault with no
// _folders.md must behave exactly as it did before this existed, or every vault in the world gets
// new findings on upgrade.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFolders, DEFAULT_ENTITIES, DEFAULT_DOMAINS, DEFAULT_FORMS } from "./folders.ts";

const vault = (body?: string): string => {
  const d = mkdtempSync(join(tmpdir(), "imprnt-folders-"));
  if (body !== undefined) writeFileSync(join(d, "_folders.md"), body);
  return d;
};

test("no _folders.md gives exactly the shipped defaults", () => {
  const r = loadFolders(vault());
  expect([...r.entities].sort()).toEqual([...DEFAULT_ENTITIES].sort());
  expect([...r.domains].sort()).toEqual([...DEFAULT_DOMAINS].sort());
  expect([...r.forms].sort()).toEqual([...DEFAULT_FORMS].sort());
  expect(r.mounts.size).toBe(0);
  expect(r.declared).toBe(false);
});

test("an ABSENT section keeps its default while another is declared", () => {
  // The seam case: a vault declares only Mounts and must keep every other role intact.
  const r = loadFolders(vault("# folders\n\n## Mounts\nhousehold\n"));
  expect(r.mounts.has("household")).toBe(true);
  expect([...r.entities].sort()).toEqual([...DEFAULT_ENTITIES].sort());
  expect([...r.domains].sort()).toEqual([...DEFAULT_DOMAINS].sort());
  expect(r.declared).toBe(true);
});

test("an EMPTY section is a deliberate none, not a fallback", () => {
  const r = loadFolders(vault("## Forms\n\n## Mounts\nhousehold\n"));
  expect(r.forms.size).toBe(0);
  expect(r.mounts.has("household")).toBe(true);
});

test("a vault can add its own domains, which is what the contract always promised", () => {
  const r = loadFolders(vault("## Domains\nidentity, health, clients, research\n"));
  expect(r.domains.has("clients")).toBe(true);
  expect(r.domains.has("research")).toBe(true);
  expect(r.domains.has("work")).toBe(false);
});

test("bullets, commas and one line per name all parse", () => {
  const r = loadFolders(vault("## Entities\n- people\n- orgs, holdings\n- vendors\n"));
  expect([...r.entities].sort()).toEqual(["holdings", "orgs", "people", "vendors"]);
});

test("prose, comments and blockquotes in a section are ignored", () => {
  const r = loadFolders(vault("## Mounts\n> the shared household seam, its own repo\n<!-- note -->\nhousehold\n"));
  expect([...r.mounts]).toEqual(["household"]);
});

test("one bad token never drops the good ones beside it", () => {
  const r = loadFolders(vault("## Entities\npeople, not a folder name, orgs\n"));
  expect(r.entities.has("people")).toBe(true);
  expect(r.entities.has("orgs")).toBe(true);
});

test("a folder in two roles resolves to entity, and never to both", () => {
  // Ambiguity must under-report rather than flood needs-review, which is the whole point.
  const r = loadFolders(vault("## Entities\npeople\n\n## Domains\npeople, health\n\n## Mounts\npeople\n"));
  expect(r.entities.has("people")).toBe(true);
  expect(r.domains.has("people")).toBe(false);
  expect(r.mounts.has("people")).toBe(false);
  expect(r.domains.has("health")).toBe(true);
});

test("a mount also wins over a domain declaration", () => {
  const r = loadFolders(vault("## Domains\nhousehold, life\n\n## Mounts\nhousehold\n"));
  expect(r.mounts.has("household")).toBe(true);
  expect(r.domains.has("household")).toBe(false);
  expect(r.domains.has("life")).toBe(true);
});

test("names are case-folded and NFC-composed, so the file matches the folder on disk", () => {
  const r = loadFolders(vault("## Mounts\nHouseHold\n"));
  expect(r.mounts.has("household")).toBe(true);
});

test("non-ASCII folder names work, because the vault is Unicode-first", () => {
  const r = loadFolders(vault("## Domains\nздоровье, финансы\n"));
  expect(r.domains.has("здоровье")).toBe(true);
  expect(r.domains.has("финансы")).toBe(true);
});

test("an unreadable _folders.md falls back to defaults instead of condemning every note", () => {
  const d = vault("## Mounts\nhousehold\n");
  chmodSync(join(d, "_folders.md"), 0o000);
  const r = loadFolders(d);
  expect(r.declared).toBe(false);
  expect([...r.entities].sort()).toEqual([...DEFAULT_ENTITIES].sort());
  chmodSync(join(d, "_folders.md"), 0o600);
});
