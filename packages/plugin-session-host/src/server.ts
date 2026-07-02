// imprnt · session-host — the warm service.
//
// Launches ONE Playwright persistent context (a dedicated browser profile, separate from the user's
// daily Arc) and a localhost-only HTTP server. The browser stays open, so each enrolled site's own
// JavaScript keeps its token fresh on its own timer — exactly how a real browser behaves. Consumers
// ask `/session/token?site=<host>` and get a fresh bearer token. Deterministic code only; no LLM, and
// it never acts on its own — it answers requests.
//
// PAI litmus (see Plans/06): you start it, you can kill it, it auto-injects nothing, every token
// handout is logged. Localhost bind only — never exposed.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import { resolveSite } from "./sites.ts";

const PORT = Number(process.env.SESSION_HOST_PORT ?? 8787);

// Append-only audit: timestamp, event, site, token FINGERPRINT (never the token itself). The file you
// read to confirm nothing rogue ran. Caller-supplied timestamps would let a compromised caller lie, so
// we stamp with the host's own clock at write time.
function audit(dir: string, event: string, detail: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail });
  try { appendFileSync(join(dir, "audit.log"), line + "\n"); } catch { /* never let logging crash a request */ }
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

// The profile (real session cookies) and audit.log must never reach a git remote — but npm strips
// .gitignore from every tarball, so an installed copy of this module arrives without the guard the
// repo's own copy has. Lay it down at runtime, before either file exists. An existing file (any
// content) is the user's; leave it alone.
export function ensureGitignore(dir: string) {
  const path = join(dir, ".gitignore");
  if (existsSync(path)) return;
  try {
    writeFileSync(path, "# Local, private, never committed: the dedicated browser profile (holds your real sessions) and the\n# action log. Written by session-host itself — npm strips .gitignore from tarballs.\nprofile/\naudit.log\n");
  } catch { /* a read-only dir shouldn't stop the host from serving */ }
}

// DNS-rebinding fence: the 127.0.0.1 bind is TCP-level only. A hostile page in the user's everyday
// browser whose DNS was rebound to 127.0.0.1 still reaches this port — but it arrives with its own
// hostname in the Host header. Only requests addressed to loopback get answered.
export function loopbackHost(hostHeader: string | undefined): boolean {
  const host = (hostHeader ?? "").replace(/:\d+$/, "");
  return host === "127.0.0.1" || host === "localhost";
}

export async function serve(here: string): Promise<void> {
  // Lazy import so non-browser commands (status) and the CLI itself load without playwright-core
  // present; only serve/login actually need it. Fail with a clear install hint, not a stack trace.
  let chromium;
  try { ({ chromium } = await import("playwright-core")); }
  catch { console.error("session-host: playwright-core is not installed here. Run `npm i playwright-core` in this module's folder (uses your system Chrome, no browser download)."); process.exit(1); }
  ensureGitignore(here); // before the profile exists, so a later git-init of the vault can't stage it
  const profileDir = join(here, "profile");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: "chrome", // use the installed system Chrome — no bundled-browser download
    chromiumSandbox: true, // keep Chrome's sandbox ON — this browser holds credentials, security matters
  });
  audit(here, "serve.start", { port: PORT });

  // one warm page per site, reused across requests
  const pages = new Map<string, Page>();
  async function warmPage(warmUrl: string): Promise<Page> {
    let p = pages.get(warmUrl);
    if (!p || p.isClosed()) {
      p = await context.newPage();
      pages.set(warmUrl, p);
    }
    // reload to let the SPA refresh its token, with a bounded wait so a slow site can't hang a request
    try { await p.goto(warmUrl, { waitUntil: "domcontentloaded", timeout: 20000 }); } catch { /* keep the stale page; cookie read may still work */ }
    return p;
  }

  async function readToken(siteKey: string): Promise<{ token: string } | { error: string; status: number }> {
    const cfg = resolveSite(siteKey);
    if (!cfg) return { error: `unknown site '${siteKey}' — add it to sites.ts`, status: 404 };
    await warmPage(cfg.warmUrl);
    const cookies = await context.cookies(cfg.tokenDomain);
    const c = cookies.find((x) => x.name === cfg.tokenCookie);
    if (!c || !c.value) {
      return { error: `no '${cfg.tokenCookie}' for ${cfg.site} — run \`session-host login ${cfg.loginUrl}\` once (with serve stopped)`, status: 401 };
    }
    return { token: c.value };
  }

  async function siteStatus() {
    const out: Record<string, boolean> = {};
    for (const key of Object.keys(await import("./sites.ts").then((m) => m.SITES))) {
      const cfg = resolveSite(key)!;
      const cookies = await context.cookies(cfg.tokenDomain).catch(() => []);
      out[cfg.site] = cookies.some((x) => x.name === cfg.tokenCookie && !!x.value);
    }
    return out;
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (!loopbackHost(req.headers.host)) return send(403, { error: "forbidden host" }); // see loopbackHost
      try {
        if (url.pathname === "/health") return send(200, { ok: true, port: PORT });
        if (url.pathname === "/status") return send(200, { enrolled: await siteStatus() });
        if (url.pathname === "/session/token") {
          const site = url.searchParams.get("site") ?? "";
          const r = await readToken(site);
          if ("error" in r) {
            audit(here, "token.miss", { site, reason: r.error });
            return send(r.status, { error: r.error });
          }
          audit(here, "token.hand", { site, fingerprint: fingerprint(r.token) });
          return send(200, { token: r.token });
        }
        return send(404, { error: "not found" });
      } catch (e) {
        return send(500, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  });

  // localhost ONLY — the credential surface is never exposed to the network
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  console.log(`session-host: warm on http://127.0.0.1:${PORT} (profile: ${profileDir})`);
  console.log(`  endpoints: /health  /status  /session/token?site=<host>`);
  console.log(`  stop with Ctrl-C; nothing runs unless you started this.`);

  const shutdown = async () => {
    audit(here, "serve.stop", {});
    try { await context.close(); } catch { /* ignore */ }
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
