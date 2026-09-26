import { readdirSync, readFileSync, statSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { CredentialEntry } from "../registry/load.ts";
import { readKeychainItem, type KeychainOptions } from "../adapters/keychain.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * What one credential's health is. L10 rule 2: "Blank, expired, unreadable,
 * each a named finding. Presence is not health."
 */
export type CredentialHealth =
  | { ok: true }
  | { ok: false; kind: "blank" | "expired" | "unreadable" | "refused"; says: string };

/**
 * The seam `check` opens a credential through, in the style of `os` and
 * `kernel`: the two bot kinds answer with the platform's own identity call, and
 * no automated check can reach Telegram or Discord.
 */
export interface CredentialProber {
  open(entry: CredentialEntry): Promise<CredentialHealth>;
  /** The secret strings this credential holds. They never leave the process. */
  secrets(entry: CredentialEntry): Promise<string[]>;
}

/** How far into a root the copy scan looks, and how big a file it reads. */
export const SCAN_MAX_DEPTH = 4;
export const SCAN_MAX_BYTES = 1_048_576;

/** Directories a household's own tree carries and a credential never lives in. */
const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);

/** A secret shorter than this is not a secret, and matching on one is noise. */
const SHORTEST_SECRET = 8;

type Send = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * How long an identity call may take before it is one this household is not
 * getting an answer to.
 *
 * This runtime's `fetch` has no deadline of its own, and `check` is the one
 * command a household runs to find out what is wrong: a black-holed packet
 * would turn it into a command that prints nothing at all. An abort lands in
 * the catch below and is reported as `unreadable`, which is what it is.
 */
const IDENTITY_TIMEOUT_MS = 10_000;

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

/**
 * Where a login is kept, for the sentences below: its keychain item on a Mac,
 * its file everywhere else.
 */
export function loginPlace(entry: Pick<CredentialEntry, "file" | "keychain">): string {
  return entry.keychain === undefined ? entry.file : `the keychain item ${JSON.stringify(entry.keychain)}`;
}

/**
 * The login's own text: the keychain item when the entry names one, the file
 * otherwise. Null when it cannot be read, with the reason beside it.
 */
function loginText(entry: CredentialEntry, options: KeychainOptions): { text: string } | { text: null; says: string } {
  if (entry.keychain !== undefined) {
    const read = readKeychainItem(entry.keychain, options);
    return read.ok ? { text: read.text } : { text: null, says: read.says };
  }
  const text = readText(entry.file);
  return text === null ? { text: null, says: `${entry.file} cannot be read` } : { text };
}

function loginOf(text: string | null): Record<string, unknown> | null | "unreadable" {
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
function loginHealth(entry: CredentialEntry, options: KeychainOptions): CredentialHealth {
  const read = loginText(entry, options);
  if (read.text === null) return unreadable(read.says);
  const place = loginPlace(entry);
  const held = loginOf(read.text);
  if (held === "unreadable") {
    return unreadable(`${place} cannot be read as JSON`);
  }
  if (held === null) {
    return { ok: false, kind: "blank", says: `${place} carries no claudeAiOauth object` };
  }
  const access = String(held.accessToken ?? "");
  const refresh = String(held.refreshToken ?? "");
  if (access === "" && refresh === "") {
    return { ok: false, kind: "blank", says: `${place} carries no access token and no refresh token` };
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
 * The real prober: one reader per kind, and the FILE is read before
 * anything is dialled, so a credential that is not there is `unreadable` with
 * no network call at all.
 *
 * `fetch` is a seam of its own for the same reason the two platform files take
 * one: a check binds the identity REQUEST without reaching the platform, and
 * what stays the cutover's is whether the platform accepts it.
 */
export function realProber(options: { fetch?: typeof fetch } & KeychainOptions = {}): CredentialProber {
  const send: Send = options.fetch ?? ((input, init) => fetch(input, init));
  const keychain: KeychainOptions = { keychain: options.keychain };

  const askTelegram = async (token: string): Promise<CredentialHealth> => {
    try {
      const answer = await send(`https://api.telegram.org/bot${token}/getMe`, {
        method: "GET",
        signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
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
      if (entry.kind === "claude-login") return loginHealth(entry, keychain);
      const held = tokenOf(entry.file);
      if (!("token" in held)) return held;
      if (entry.kind === "telegram") return await askTelegram(held.token);
      if (entry.kind === "discord") return await askDiscord(held.token);
      // A recognizer's key is opened and never dialled. What a cheap
      // authenticated probe costs per provider is unmeasured, and the last real
      // result is on the `voice_health` sheet already, written by real notes.
      // Opening the file still catches the two states that stop every note:
      // a key that is not there and a key file that is empty.
      if (entry.kind === "api-key") return { ok: true };
      return unreadable(`${entry.kind} is not a credential kind this hub knows how to open`);
    },
    async secrets(entry) {
      if (entry.kind === "claude-login") {
        const held = loginOf(loginText(entry, keychain).text);
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
      says: `${entry.id} is a ${entry.kind} credential ${entry.keychain === undefined ? "at" : "in"} ${loginPlace(entry)} and it is ${health.kind}: ${health.says}`,
      fix:
        entry.keychain !== undefined
          ? `log in with claude on the Mac that holds ${loginPlace(entry)}, then run check`
          : health.kind === "unreadable"
            ? `check that ${entry.file} exists and is readable by the hub's user`
            : health.kind === "refused"
              ? `issue a new token for ${entry.id} and write it into ${entry.file}`
              : `log in again on the machine that owns ${entry.file}, then run check`,
    });
  }
  return out;
}

/** Every file under one root, bounded, with no symlink followed. */
function filesUnder(root: string, out: string[], depth: number, maxDepth: number): void {
  if (depth > maxDepth) return;
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
      // is not a way around the roots.
      about = lstatSync(here);
    } catch {
      continue;
    }
    if (about.isSymbolicLink()) continue;
    if (about.isDirectory()) {
      if (SKIP_DIRECTORIES.has(name)) continue;
      filesUnder(here, out, depth + 1, maxDepth);
      continue;
    }
    if (!about.isFile()) continue;
    if (about.size > SCAN_MAX_BYTES) continue;
    out.push(here);
  }
}

/**
 * A copy anywhere inside the roots the registry already names is a
 * finding, "because the thing that owns the file rewrites it and copies
 * diverge".
 *
 * BOUNDED, and derived rather than chosen: every declared person's tree, the
 * state dir, and the directory of each credential file the registry names. A
 * person's checkout of the shared zone is inside their own tree and is swept
 * with it. Never a walk of the disk, which is what makes this a check a
 * household runs rather than one it dreads.
 *
 * A root may carry its own depth. A credential's directory is swept one level
 * deep: a copy beside the file is what that root exists to find, and a login
 * kept in a home directory would otherwise have the whole home walked four
 * levels down on every check.
 *
 * THE SECRET IS HELD IN MEMORY AND REACHES NOTHING. The finding carries the
 * PATH and the credential id, never the secret and never a hash of it.
 */
export async function copyFindings(args: {
  entries: CredentialEntry[];
  prober: CredentialProber;
  roots: (string | { path: string; depth: number })[];
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
  for (const one of args.roots) {
    const root = typeof one === "string" ? one : one.path;
    const depth = typeof one === "string" ? SCAN_MAX_DEPTH : one.depth;
    if (root === "" || seenRoot.has(root)) continue;
    seenRoot.add(root);
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }
    filesUnder(root, candidates, 1, depth);
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

/** A door's `token_file` is a credential without being an entry. */
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
