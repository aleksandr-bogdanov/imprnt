// kopeika-view: serves the rendered dashboard behind a login FORM (not HTTP Basic, so
// password managers autofill). One shared password, verified against an argon2 hash
// (PUBLISH_PASSWORD_HASH, made with Bun.password.hash), then a signed httpOnly cookie
// (HMAC-SHA256 of an expiry with PUBLISH_SECRET, 30 days). Bilingual: ru default, en via
// the toggle, remembered in a `lang` cookie. Static files only: public/{en,ru}.html.
// Rebuilt 2026-09-12 from the description in vault/work/kopeika-hosting-decision.md after
// the original bundle was lost with the standalone repo.
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HASH = process.env.PUBLISH_PASSWORD_HASH ?? "";
const SECRET = process.env.PUBLISH_SECRET ?? "";
const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC = join(import.meta.dir, "public");
const DAY = 86400;
if (HASH === "" || SECRET === "") throw new Error("PUBLISH_PASSWORD_HASH and PUBLISH_SECRET are required");

function sign(exp: string): string {
  return createHmac("sha256", SECRET).update(exp).digest("hex");
}
function cookie(req: Request, name: string): string {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]!) : "";
}
function authed(req: Request): boolean {
  const [exp, sig] = cookie(req, "auth").split(".");
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  const want = Buffer.from(sign(exp));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}
function loginPage(failed = false): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>kopeika</title><link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin /><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet" />
<style>body{font:16px "Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f6f4ec;color:#1b1d1a;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#fbf9f2;border:1px solid #ddd7c7;padding:28px;border-radius:8px;width:min(320px,90vw)}input{width:100%;box-sizing:border-box;padding:10px;margin:8px 0 14px;border:1px solid #ddd7c7;border-radius:6px;font:inherit}
button{width:100%;padding:10px;border:0;border-radius:6px;background:#1b1d1a;color:#f6f4ec;font:inherit}p.err{color:#a33;margin:0 0 8px}</style>
<form method="post" action="/login" autocomplete="on"><label>kopeika<input type="password" name="password" autocomplete="current-password" autofocus></label>${failed ? '<p class="err">wrong password</p>' : ""}<button>open</button></form>`;
  return new Response(html, { status: failed ? 401 : 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
function page(lang: string): Response {
  const file = join(PUBLIC, `${lang}.html`);
  if (!existsSync(file)) return new Response("not rendered yet", { status: 404 });
  return new Response(Bun.file(file), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/login" && req.method === "POST") {
      const form = await req.formData();
      const pw = String(form.get("password") ?? "");
      if (!(await Bun.password.verify(pw, HASH))) return loginPage(true);
      const exp = String(Math.floor(Date.now() / 1000) + 30 * DAY);
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `auth=${exp}.${sign(exp)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * DAY}` } });
    }
    if (url.pathname === "/logout") return new Response(null, { status: 303, headers: { location: "/", "set-cookie": "auth=; Path=/; Max-Age=0" } });
    if (!authed(req)) return loginPage();
    if (url.pathname === "/lang") {
      const lang = url.searchParams.get("set") === "en" ? "en" : "ru";
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": `lang=${lang}; Path=/; Max-Age=${365 * DAY}; SameSite=Lax` } });
    }
    if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/rows") {
      const q = url.searchParams.get("lang");
      const lang = q === "en" || q === "ru" ? q : cookie(req, "lang") === "en" ? "en" : "ru";
      return page(url.pathname === "/rows" ? `rows-${lang}` : lang);
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`kopeika-view on :${PORT}`);
