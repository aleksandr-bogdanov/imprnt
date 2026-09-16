import { readdirSync, readFileSync, statSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CredentialEntry } from "../registry/load.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * What one credential's health is. L10 rule 2: "Blank, expired, unreadable,
 * each a named finding. Presence is not health."
 */
export type CredentialHealth =
  | { ok: true }
  | { ok: false; kind: "blank" | "expired" | "unreadable" | "refused"; says: string };

/**
 * D-131. The seam `check` opens a credential through, in the style of `os` and
 * `kernel`: the two bot kinds answer with the platform's own identity call, and
 * no automated check can reach Telegram or Discord.
 */
export interface CredentialProber {
  open(entry: CredentialEntry): Promise<CredentialHealth>;
  /** The secret strings this credential holds. They never leave the process. */
  secrets(entry: CredentialEntry): Promise<string[]>;
}

/** D-132. How far into a root the copy scan looks, and how big a file it reads. */
export const SCAN_MAX_DEPTH = 4;
export const SCAN_MAX_BYTES = 1_048_576;

/** Directories a household's own tree carries and a credential never lives in. */
const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

/** A secret shorter than this is not a secret, and matching on one is noise. */
const SHORTEST_SECRET = 8;

type Send = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function unreadable(says: string): CredentialHealth {
  return { ok: false, kind: "unreadable", says };
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function loginOf(file: string): Record<string, unknown> | null | "unreadable" {
  const text = readText(file);
  if (text === null) return "unreadable";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unreadable";
  }
  if (parsed === null || typeof parsed !== "object") return "unreadable";
  const held = (parsed as Record<string, unknown>).claudeAiOauth;
  return held === undefined || held === null || typeof held !== "object"
    ? null
    : (held as Record<string, unknown>);
}

/**
 * MEASURED on the hub box, 2026-09-16, and this is the whole reason the rule is
 * what it is: a LIVE login answering real people runs on a file whose
 * `claudeAiOauth.expiresAt` is `0`. The refresh token is what keeps it alive and
 * the access token is minted on demand, so a rule that read `expiresAt` alone
 * would report the working household dead and the household would stop trusting
 * `check` altogether.
 */
function loginHealth(file: string): CredentialHealth {
  const held = loginOf(file);
  if (held === "unreadable") {
    return unreadable(`${file} cannot be read as JSON`);
  }
  if (held === null) {
    return { ok: false, kind: "blank", says: `${file} carries no claudeAiOauth object` };
  }
  const access = String(held.accessToken ?? "");
  const refresh = String(held.refreshToken ?? "");
  if (access === "" && refresh === "") {
    return { ok: false, kind: "blank", says: `${file} carries no access token and no refresh token` };
  }
  const now = Date.now();
  const refreshUntil = held.refreshTokenExpiresAt;
  if (typeof refreshUntil === "number" && refreshUntil > 0) {
    return refreshUntil <= now
      ? {
          ok: false,
          kind: "expired",
          says: `its refresh token expired at ${new Date(refreshUntil).toISOString()}`,
        }
      : { ok: true };
  }
  const accessUntil = held.expiresAt;
  if (typeof accessUntil === "number" && accessUntil <= now) {
    return {
      ok: false,
      kind: "expired",
      says:
        `it carries no refreshTokenExpiresAt and its access token expired at ` +
        `${new Date(accessUntil).toISOString()}`,
    };
  }
  return { ok: true };
}

function tokenOf(file: string): { token: string } | CredentialHealth {
  const text = readText(file);
  if (text === null) return unreadable(`${file} cannot be read`);
  const token = text.trim();
  if (token === "") return { ok: false, kind: "blank", says: `${file} holds no token` };
  return { token };
}

/**
 * D-131. The real prober: one reader per kind, and the FILE is read before
 * anything is dialled, so a credential that is not there is `unreadable` with
 * no network call at all.
 *
 * `fetch` is a seam of its own for the same reason the two platform files take
 * one: a check binds the identity REQUEST without reaching the platform, and
 * what stays the cutover's is whether the platform accepts it.
 */
export function realProber(options: { fetch?: typeof fetch } = {}): CredentialProber {
  const send: Send = options.fetch ?? ((input, init) => fetch(input, init));

  const askTelegram = async (token: string): Promise<CredentialHealth> => {
    try {
      const answer = await send(`https://api.telegram.org/bot${token}/getMe`, {
        method: "GET",
      });
      const said = (await answer.json().catch(() => ({}))) as Record<string, unknown>;
      if (!answer.ok || said.ok !== true) {
        return {
          ok: false,
          kind: "refused",
          says: `telegram answered ${answer.status} ${String(said.description ?? "with no reason")}`,
        };
      }
      return { ok: true };
    } catch (error) {
      return unreadable(`telegram could not be asked: ${(error as Error).message}`);
    }
  };

  const askDiscord = async (token: string): Promise<CredentialHealth> => {
    try {
      const answer = await send("https://discord.com/api/v10/users/@me", {
        method: "GET",
        headers: { Authorization: `Bot ${token}` },
      });
      if (!answer.ok) {
        const said = await answer.text().catch(() => "");
        return {
          ok: false,
          kind: "refused",
          says: `discord answered ${answer.status} ${said}`,
        };
      }
      return { ok: true };
    } catch (error) {
      return unreadable(`discord could not be asked: ${(error as Error).message}`);
    }
  };

  return {
    async open(entry) {
      if (entry.kind === "claude-login") return loginHealth(entry.file);
      const held = tokenOf(entry.file);
      if (!("token" in held)) return held;
      if (entry.kind === "telegram") return await askTelegram(held.token);
      if (entry.kind === "discord") return await askDiscord(held.token);
      return unreadable(`${entry.kind} is not a credential kind this hub knows how to open`);
    },
    async secrets(entry) {
      if (entry.kind === "claude-login") {
        const held = loginOf(entry.file);
        if (held === "unreadable" || held === null) return [];
        return [String(held.accessToken ?? ""), String(held.refreshToken ?? "")].filter(
          (one) => one.length >= SHORTEST_SECRET,
        );
      }
      const held = tokenOf(entry.file);
      return "token" in held && held.token.length >= SHORTEST_SECRET ? [held.token] : [];
    },
  };
}

const FINDING_FOR: Record<string, string> = {
  blank: "credential-blank",
  expired: "credential-expired",
  unreadable: "credential-unreadable",
  refused: "credential-refused",
};

/**
 * L10 rule 2 as findings: four states, four named kinds, and a healthy one
 * produces none.
 */
export async function credentialFindings(args: {
  entries: CredentialEntry[];
  prober: CredentialProber;
  machine: string;
}): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const entry of args.entries) {
    const health = await args.prober.open(entry);
    if (health.ok) continue;
    const kind = FINDING_FOR[health.kind];
    out.push({
      id: findingId(args.machine, kind, entry.id),
      kind,
      subject: entry.id,
      machine: args.machine,
      says: `${entry.id} is a ${entry.kind} credential at ${entry.file} and it is ${health.kind}: ${health.says}`,
      fix:
        health.kind === "unreadable"
          ? `check that ${entry.file} exists and is readable by the hub's user`
          : health.kind === "refused"
            ? `issue a new token for ${entry.id} and write it into ${entry.file}`
            : `log in again on the machine that owns ${entry.file}, then run check`,
    });
  }
  return out;
}

/** Every file under one root, bounded, with no symlink followed. */
function filesUnder(root: string, out: string[], depth: number): void {
  if (depth > SCAN_MAX_DEPTH) return;
  let listed: string[];
  try {
    listed = readdirSync(root);
  } catch {
    return;
  }
  for (const name of listed) {
    const here = join(root, name);
    let about;
    try {
      // lstat, never stat: a symlink is not followed, so a link out of a root
      // is not a way around the roots (D-132).
      about = lstatSync(here);
    } catch {
      continue;
    }
    if (about.isSymbolicLink()) continue;
    if (about.isDirectory()) {
      if (SKIP_DIRECTORIES.has(name)) continue;
      filesUnder(here, out, depth + 1);
      continue;
    }
    if (!about.isFile()) continue;
    if (about.size > SCAN_MAX_BYTES) continue;
    out.push(here);
  }
}

/**
 * RUN-16. A copy anywhere inside the roots the registry already names is a
 * finding, "because the thing that owns the file rewrites it and copies
 * diverge".
 *
 * BOUNDED, and derived rather than chosen: every declared person's tree, the
 * shared zone, the state dir, and the directory of each credential file the
 * registry names. Never a walk of the disk, which is what makes this a check a
 * household runs rather than one it dreads.
 *
 * THE SECRET IS HELD IN MEMORY AND REACHES NOTHING. The finding carries the
 * PATH and the credential id, never the secret and never a hash of it.
 */
export async function copyFindings(args: {
  entries: CredentialEntry[];
  prober: CredentialProber;
  roots: string[];
  machine: string;
}): Promise<Finding[]> {
  const held: { entry: CredentialEntry; secrets: string[] }[] = [];
  for (const entry of args.entries) {
    const secrets = (await args.prober.secrets(entry)).filter(
      (one) => one.length >= SHORTEST_SECRET,
    );
    if (secrets.length > 0) held.push({ entry, secrets });
  }
  if (held.length === 0) return [];

  const declared = new Set(args.entries.map((entry) => entry.file));
  const candidates: string[] = [];
  const seenRoot = new Set<string>();
  for (const root of args.roots) {
    if (root === "" || seenRoot.has(root)) continue;
    seenRoot.add(root);
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    filesUnder(root, candidates, 1);
  }

  const out: Finding[] = [];
  const reported = new Set<string>();
  for (const file of candidates) {
    // The declared file is the one place the secret belongs, so a scan that
    // reported it would report a finding nobody can fix.
    if (declared.has(file) || reported.has(file)) continue;
    const text = readText(file);
    if (text === null) continue;
    for (const one of held) {
      if (!one.secrets.some((secret) => text.includes(secret))) continue;
      reported.add(file);
      out.push({
        id: findingId(args.machine, "credential-copy", file),
        kind: "credential-copy",
        subject: file,
        machine: args.machine,
        says: `${file} holds the secret of the credential ${one.entry.id}, and a credential lives in exactly one file`,
        fix: `delete ${file} and point the agent at ${one.entry.file}`,
      });
      break;
    }
  }
  return out;
}

/** D-111. A door's `token_file` is a credential without being an entry. */
export function doorCredential(door: {
  id: string;
  platform: string;
  person?: string;
  token_file: string;
}): CredentialEntry | null {
  if (door.platform !== "telegram" && door.platform !== "discord") return null;
  return {
    id: `door:${door.id}`,
    kind: door.platform,
    file: door.token_file,
    owner: door.person === undefined || door.person === "" ? "household" : door.person,
  };
}
