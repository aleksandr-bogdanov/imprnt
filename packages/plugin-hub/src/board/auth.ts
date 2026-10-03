import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { listPeople } from "../registry/entries.ts";
import type { Registry, RunEntry } from "../registry/load.ts";
import { secretsDirOf } from "../store/secrets.ts";

export interface BoardViewer { id: string; person: string; role: "reader" | "operator" }
interface Account extends BoardViewer { token_sha256: string }
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX = /^[a-f0-9]{64}$/;
const LIMIT = 16 * 1024;

/** This entire directory is masked from every agent box. Keeping the verifier
 * inside it also protects atomic credential-file replacement on Linux. */
export function boardAuthPath(registry: Registry, entry: RunEntry): string | null {
  const root = secretsDirOf(registry);
  return root === null ? null : entry.token_file ?? join(root, `${entry.id}-board-auth.json`);
}

function accounts(registry: Registry, entry: RunEntry): Account[] {
  const root = secretsDirOf(registry);
  const path = boardAuthPath(registry, entry);
  if (!root || !path) throw new Error("unconfigured");
  const secret = realpathSync(root);
  const parent = realpathSync(dirname(path));
  const directory = lstatSync(secret);
  if (parent !== secret || !directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid!()) throw new Error("private-directory-required");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > LIMIT) throw new Error("private-file-required");
    const bytes = Buffer.alloc(stat.size + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size !== stat.size) throw new Error("file-changed");
    const value = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    if (value?.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length < 1 || value.accounts.length > 32) throw new Error("invalid-file");
    const people = new Set(listPeople(registry).map(p => p.id));
    const ids = new Set<string>();
    const tokens = new Set<string>();
    for (const account of value.accounts) {
      if (!account || typeof account.id !== "string" || account.id.length > 64 || !ID.test(account.id) || ids.has(account.id)
          || !people.has(account.person) || !["reader", "operator"].includes(account.role)
          || typeof account.token_sha256 !== "string" || !HEX.test(account.token_sha256) || tokens.has(account.token_sha256)) throw new Error("invalid-account");
      ids.add(account.id); tokens.add(account.token_sha256);
    }
    return value.accounts as Account[];
  } finally { closeSync(fd); }
}

/** Every request rereads the private verifier: removal, rotation and role changes
 * take effect without a restart. Nothing from headers or file errors is logged. */
export function authenticateBoard(request: Request, registry: Registry, entry: RunEntry):
  { configured: false } | { configured: true; viewer: BoardViewer | null } {
  let known: Account[];
  try { known = accounts(registry, entry); } catch { return { configured: false }; }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match || header.length > 512) return { configured: true, viewer: null };
  const decoded = Buffer.from(match[1], "base64");
  if (decoded.toString("base64") !== match[1]) return { configured: true, viewer: null };
  const [id, token, ...extra] = decoded.toString("utf8").split(":");
  if (extra.length || !HEX.test(token ?? "")) return { configured: true, viewer: null };
  const account = known.find(one => one.id === id);
  const supplied = createHash("sha256").update(token).digest();
  const expected = Buffer.from(account?.token_sha256 ?? "0".repeat(64), "hex");
  if (!timingSafeEqual(supplied, expected) || !account) return { configured: true, viewer: null };
  return { configured: true, viewer: { id: account.id, person: account.person, role: account.role } };
}

export function boardSignIn(configured: boolean): Response {
  return new Response(configured ? "Sign in with your board account.\n" : "Board access is not configured.\n", {
    status: configured ? 401 : 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
      ...(configured ? { "www-authenticate": 'Basic realm="Hub board", charset="UTF-8"' } : {}) },
  });
}
