// imprnt · kleinanzeigen plugin — live auth from the local browser session.
//
// Kleinanzeigen's message-box gateway authenticates with `Authorization: Bearer <access_token>`, where
// access_token is a JWT cookie the web app holds. Rather than make the user export cookies by hand on a
// short-lived token, `sync` reads it straight from the logged-in Chromium-family browser (Arc by
// default) on this Mac: copy the cookie DB, decrypt with the key from the macOS Keychain, pull the
// access_token. Local, on-demand, the user's own session — nothing leaves the machine.
//
// macOS Chromium cookie crypto: PBKDF2(key="<Keychain: '<App> Safe Storage'>", salt="saltysalt",
// 1003 iters, SHA1, 16 bytes) -> AES-128-CBC, IV = 16 spaces, "v10"/"v11" prefix. Newer builds prepend
// a 32-byte SHA256(host) to the plaintext, stripped here.
//
// Override for portability / non-Arc / headless: set KLEINANZEIGEN_TOKEN (a Bearer JWT) or
// KLEINANZEIGEN_COOKIES (a file holding `access_token=<jwt>` or a cookie header / jar).
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const printable = (s: string) => /^[\x20-\x7E]*$/.test(s);

// The Chromium-family browsers we can read on macOS, in default-preference order. Arc first (the user's).
const BROWSERS: { name: string; keychain: string; cookieDir: string }[] = [
  { name: "Arc", keychain: "Arc Safe Storage", cookieDir: "Arc/User Data/Default" },
  { name: "Chrome", keychain: "Chrome Safe Storage", cookieDir: "Google/Chrome/Default" },
  { name: "Brave", keychain: "Brave Safe Storage", cookieDir: "BraveSoftware/Brave-Browser/Default" },
  { name: "Edge", keychain: "Microsoft Edge Safe Storage", cookieDir: "Microsoft Edge/Default" },
];

function keychainKey(service: string): string | null {
  try {
    return execFileSync("security", ["find-generic-password", "-ws", service], { encoding: "utf8" }).trim();
  } catch {
    return null; // not installed, or the user declined the Keychain prompt
  }
}

function decryptValue(encHex: string, derived: Buffer): string | null {
  const buf = Buffer.from(encHex, "hex");
  if (buf.length < 4) return null;
  const ver = buf.subarray(0, 3).toString();
  if (ver !== "v10" && ver !== "v11") return null;
  const d = crypto.createDecipheriv("aes-128-cbc", derived, Buffer.alloc(16, " "));
  d.setAutoPadding(false);
  let out = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);
  const full = out.toString("latin1");
  const stripped = out.subarray(32).toString("latin1"); // newer Chromium prepends 32-byte sha256(host)
  if (printable(full)) return full;
  if (printable(stripped)) return stripped;
  return null;
}

export type LiveAuth = { token: string; source: string };

// Read the kleinanzeigen access_token (Bearer JWT) from the local browser session, or from an override
// env var. Returns null when nothing is available (the caller fails loud with guidance).
export function liveAuth(): LiveAuth | null {
  // 1. explicit token override (headless / non-Arc / CI)
  if (process.env.KLEINANZEIGEN_TOKEN) return { token: process.env.KLEINANZEIGEN_TOKEN.trim(), source: "KLEINANZEIGEN_TOKEN" };

  // 2. a cookie file holding access_token=<jwt> (or a raw jwt)
  const jar = process.env.KLEINANZEIGEN_COOKIES;
  if (jar && existsSync(jar)) {
    const raw = readFileSync(jar, "utf8");
    const m = raw.match(/access_token=([^;\s]+)/);
    if (m) return { token: m[1], source: "KLEINANZEIGEN_COOKIES" };
    if (raw.trim().split(".").length === 3) return { token: raw.trim(), source: "KLEINANZEIGEN_COOKIES (raw jwt)" };
  }

  // 3. the local browser session
  for (const b of BROWSERS) {
    const dbPath = join(homedir(), "Library", "Application Support", b.cookieDir, "Cookies");
    if (!existsSync(dbPath)) continue;
    const key = keychainKey(b.keychain);
    if (!key) continue;
    const derived = crypto.pbkdf2Sync(key, "saltysalt", 1003, 16, "sha1");
    const tmp = mkdtempSync(join(tmpdir(), "ka-auth-"));
    // copy the WAL too — fresh cookies (incl. a just-refreshed token) live there before checkpoint
    for (const f of ["Cookies", "Cookies-wal", "Cookies-shm"]) {
      const s = join(homedir(), "Library", "Application Support", b.cookieDir, f);
      if (existsSync(s)) try { copyFileSync(s, join(tmp, f)); } catch { /* ignore */ }
    }
    let rows: string;
    try {
      rows = execFileSync("sqlite3", [join(tmp, "Cookies"),
        "SELECT name, hex(encrypted_value) FROM cookies WHERE host_key LIKE '%kleinanzeigen%' AND name='access_token';"],
        { encoding: "utf8" });
    } catch { continue; }
    for (const line of rows.trim().split(/\r?\n/)) {
      const [name, hex] = line.split("|");
      if (name !== "access_token" || !hex) continue;
      const val = decryptValue(hex, derived);
      if (val && val.split(".").length === 3) return { token: val, source: `${b.name} session` };
    }
  }
  return null;
}
