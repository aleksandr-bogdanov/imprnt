// Folder roles: which folders in a vault hold entities, which hold domains, which hold forms, and
// which hold a MOUNT — a self-contained tree maintained somewhere else.
//
// WHY THIS IS DECLARED AND NOT HARDCODED. The contract says "Domains are user-defined. imprnt
// ships the mechanism + sensible defaults, not a fixed domain set." The code shipped a fixed set
// anyway, so a vault with a folder the defaults never heard of got its notes flagged as broken
// forever: `check` reads a note's folder as the FIRST path segment, so anything under a new
// top-level folder is neither an entity (exempt) nor a domain (checked), and every note in it lands
// in _needs-review with nothing the owner can do about it. Permanent noise in the one file that is
// supposed to mean "look here" is worse than no check at all.
//
// A vault declares its own roles in vault/_folders.md. No file means the shipped defaults, which
// are exactly the behaviour every existing vault already has — this adds a capability and changes
// nothing by default.
//
// MOUNTS are the role the defaults have no name for: a folder holding a tree that is complete on
// its own and maintained elsewhere (a shared repo checked out inside vault/, another person's
// vault, an imported corpus). Its notes are not part of THIS vault's entity graph, so demanding
// they link one is asking them to reach across a boundary they exist to respect.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type FolderRoles = {
  entities: Set<string>;
  domains: Set<string>;
  forms: Set<string>;
  mounts: Set<string>;
  declared: boolean; // true when the vault carries _folders.md, so callers can say which set is live
};

// The shipped defaults. Identical to the sets check.ts hardcoded before this file existed, so a
// vault with no _folders.md behaves exactly as it always did.
export const DEFAULT_ENTITIES = ["people", "orgs", "holdings"];
export const DEFAULT_DOMAINS = ["identity", "health", "finances", "work", "life"];
export const DEFAULT_FORMS = ["events", "mistakes", "projects"];

function section(text: string, name: string): string {
  return text.match(new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?:\\n##\\s|\\s*$)`, "i"))?.[1] ?? "";
}

// A folder name: the same shape a directory on disk can have without surprising anyone. Unicode
// letters and digits plus hyphen/underscore, matching the vault's Unicode-first stance (a Cyrillic
// vault names its folders in Cyrillic). No slashes: a role attaches to a TOP-LEVEL folder, because
// that is what `folder` means to every caller.
const FOLDER_TOKEN = /^[\p{L}\p{N}_-]+$/u;

// The folder names on one line. Comma-separated, per-token salvage so one bad token never drops the
// valid ones beside it — the same discipline _tags.md parsing learned the hard way.
function folderTokens(line: string): string[] {
  const t = line.trim();
  if (t === "" || t.startsWith("#") || t.startsWith("<!--") || t.startsWith(">")) return [];
  return t
    .replace(/^[-*]\s+/, "") // a markdown bullet is the natural way to write a list; accept it
    .split(",")
    .map((s) => s.trim().normalize("NFC").toLowerCase())
    .filter((s) => FOLDER_TOKEN.test(s));
}

function read(text: string, name: string, fallback: string[]): Set<string> {
  const found: string[] = [];
  for (const line of section(text, name).split(/\r?\n/)) found.push(...folderTokens(line));
  // An ABSENT section falls back to the default; an EMPTY one is a deliberate "none". The
  // difference matters: a vault declaring only Mounts must keep its entities and domains, while a
  // vault that genuinely wants no forms must be able to say so.
  return new RegExp(`##\\s*${name}\\s*\\n`, "i").test(text) ? new Set(found) : new Set(fallback);
}

export function loadFolders(vault: string): FolderRoles {
  const p = join(vault, "_folders.md");
  if (!existsSync(p)) {
    return {
      entities: new Set(DEFAULT_ENTITIES),
      domains: new Set(DEFAULT_DOMAINS),
      forms: new Set(DEFAULT_FORMS),
      mounts: new Set<string>(),
      declared: false,
    };
  }
  let text = "";
  try {
    text = readFileSync(p, "utf8");
  } catch {
    // Unreadable control file reads as "not declared". A permissions blip must never turn every
    // note in the vault into a reported defect.
    return { entities: new Set(DEFAULT_ENTITIES), domains: new Set(DEFAULT_DOMAINS), forms: new Set(DEFAULT_FORMS), mounts: new Set<string>(), declared: false };
  }
  const roles: FolderRoles = {
    entities: read(text, "Entities", DEFAULT_ENTITIES),
    domains: read(text, "Domains", DEFAULT_DOMAINS),
    forms: read(text, "Forms", DEFAULT_FORMS),
    mounts: read(text, "Mounts", []),
    declared: true,
  };
  // A folder in two roles is a contradiction the checks would resolve by accident of evaluation
  // order. Entity wins, because "exempt link target" is the safer reading of an ambiguous
  // declaration: it under-reports rather than flooding _needs-review, which is the failure this
  // whole file exists to prevent.
  for (const f of roles.entities) { roles.domains.delete(f); roles.forms.delete(f); roles.mounts.delete(f); }
  for (const f of roles.mounts) { roles.domains.delete(f); roles.forms.delete(f); }
  return roles;
}
