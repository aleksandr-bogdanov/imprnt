#!/usr/bin/env node
import { createRequire } from "node:module";
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/sites.ts
var exports_sites = {};
__export(exports_sites, {
  resolveSite: () => resolveSite,
  SITES: () => SITES
});
function resolveSite(key) {
  const host = key.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return SITES[host] ?? null;
}
var SITES;
var init_sites = __esm(() => {
  SITES = {
    "kleinanzeigen.de": {
      site: "kleinanzeigen.de",
      loginUrl: "https://www.kleinanzeigen.de/m-einloggen.html",
      warmUrl: "https://www.kleinanzeigen.de/m-nachrichten.html",
      tokenCookie: "access_token",
      tokenDomain: "https://www.kleinanzeigen.de"
    }
  };
});

// src/cli.ts
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/server.ts
init_sites();
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
var PORT = Number(process.env.SESSION_HOST_PORT ?? 8787);
function audit(dir, event, detail) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...detail });
  try {
    appendFileSync(join(dir, "audit.log"), line + `
`);
  } catch {}
}
function fingerprint(token) {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}
async function serve(here) {
  const profileDir = join(here, "profile");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    channel: "chrome"
  });
  audit(here, "serve.start", { port: PORT });
  const pages = new Map;
  async function warmPage(warmUrl) {
    let p = pages.get(warmUrl);
    if (!p || p.isClosed()) {
      p = await context.newPage();
      pages.set(warmUrl, p);
    }
    try {
      await p.goto(warmUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    } catch {}
    return p;
  }
  async function readToken(siteKey) {
    const cfg = resolveSite(siteKey);
    if (!cfg)
      return { error: `unknown site '${siteKey}' — add it to sites.ts`, status: 404 };
    await warmPage(cfg.warmUrl);
    const cookies = await context.cookies(cfg.tokenDomain);
    const c = cookies.find((x) => x.name === cfg.tokenCookie);
    if (!c || !c.value) {
      return { error: `no '${cfg.tokenCookie}' for ${cfg.site} — run \`session-host login ${cfg.loginUrl}\` once (with serve stopped)`, status: 401 };
    }
    return { token: c.value };
  }
  async function siteStatus() {
    const out = {};
    for (const key of Object.keys(await Promise.resolve().then(() => (init_sites(), exports_sites)).then((m) => m.SITES))) {
      const cfg = resolveSite(key);
      const cookies = await context.cookies(cfg.tokenDomain).catch(() => []);
      out[cfg.site] = cookies.some((x) => x.name === cfg.tokenCookie && !!x.value);
    }
    return out;
  }
  const server = createServer((req, res) => {
    (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
      const send = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      try {
        if (url.pathname === "/health")
          return send(200, { ok: true, port: PORT });
        if (url.pathname === "/status")
          return send(200, { enrolled: await siteStatus() });
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
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  console.log(`session-host: warm on http://127.0.0.1:${PORT} (profile: ${profileDir})`);
  console.log(`  endpoints: /health  /status  /session/token?site=<host>`);
  console.log(`  stop with Ctrl-C; nothing runs unless you started this.`);
  const shutdown = async () => {
    audit(here, "serve.stop", {});
    try {
      await context.close();
    } catch {}
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// src/cli.ts
init_sites();
var here = dirname(fileURLToPath(import.meta.url));
var PORT2 = Number(process.env.SESSION_HOST_PORT ?? 8787);
async function cmdLogin(arg) {
  const cfg = resolveSite(arg);
  const loginUrl = cfg?.loginUrl ?? (arg.startsWith("http") ? arg : `https://${arg}`);
  const { chromium: chromium2 } = await import("playwright-core");
  const profileDir = join2(here, "profile");
  console.log(`login: opening the dedicated browser at ${loginUrl}`);
  console.log("  (stop `serve` first if it's running — they share one profile)");
  let context;
  try {
    context = await chromium2.launchPersistentContext(profileDir, { headless: false, channel: "chrome" });
  } catch (e) {
    console.error(`login: could not open the browser — ${e instanceof Error ? e.message : e}`);
    console.error("  is `serve` still running? it locks the profile. Stop it and retry.");
    return 1;
  }
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(loginUrl).catch(() => {});
  console.log("  sign in by hand. I'll detect the session and finish automatically.");
  const deadline = Date.now() + 300000;
  if (cfg) {
    while (Date.now() < deadline) {
      if (context.pages().length === 0)
        break;
      const cookies = await context.cookies(cfg.tokenDomain).catch(() => []);
      if (cookies.some((c) => c.name === cfg.tokenCookie && c.value)) {
        console.log(`login: ${cfg.site} session captured. You can close the window.`);
        await new Promise((r) => setTimeout(r, 1500));
        await context.close();
        return 0;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } else {
    while (Date.now() < deadline && context.pages().length > 0)
      await new Promise((r) => setTimeout(r, 1500));
  }
  await context.close().catch(() => {});
  console.log("login: done (or timed out). Run `status` to confirm the session is enrolled.");
  return 0;
}
async function cmdStatus() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT2}/status`);
    const j = await res.json();
    console.log(`session-host: warm on :${PORT2}`);
    for (const [site, ok] of Object.entries(j.enrolled))
      console.log(`  ${ok ? "✓ enrolled" : "✗ not enrolled"}  ${site}`);
    return 0;
  } catch {
    console.log(`session-host: not running on :${PORT2} (start it with \`session-host serve\`)`);
    return 1;
  }
}
var cmd = process.argv[2];
var arg = process.argv[3] ?? "";
async function main() {
  switch (cmd) {
    case "serve":
      await serve(here);
      return 0;
    case "login":
      if (!arg) {
        console.error("usage: session-host login <url|site>");
        return 1;
      }
      return await cmdLogin(arg);
    case "status":
      return await cmdStatus();
    default:
      console.error("usage: session-host <serve|login <url>|status>");
      return 1;
  }
}
main().then((code) => {
  if (cmd !== "serve")
    process.exit(code);
});
