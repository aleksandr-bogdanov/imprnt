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
  // The production login page as served on 2026-09-12 (system font stack, green card),
  // with the error line shown only after a failed attempt. The name field is kept for
  // password-manager autofill and is not checked: one shared password.
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>kopeika</title>
<style>
  :root { --green:#2F6F4E; --ink:#3A3A36; --soft:#7A776F; --border:#ECE6DA; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#FAF8F4; color:var(--ink); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .card { background:#fff; border:1px solid var(--border); border-radius:18px; padding:36px 32px;
    width:340px; box-shadow:0 10px 30px rgba(58,58,54,0.08); }
  h1 { color:var(--green); font-size:24px; margin:0 0 4px; }
  p.sub { color:var(--soft); font-size:14px; margin:0 0 22px; }
  label { display:block; font-size:13px; font-weight:600; color:var(--soft); margin:14px 0 6px; }
  input { width:100%; padding:11px 13px; font-size:15px; border:1px solid var(--border);
    border-radius:10px; background:#FAF8F4; outline:none; }
  input:focus { border-color:var(--green); background:#fff; }
  button { width:100%; margin-top:22px; padding:12px; font-size:15px; font-weight:600; color:#fff;
    background:var(--green); border:none; border-radius:10px; cursor:pointer; }
  .err { color:#B4452F; font-size:13px; margin-top:14px; display:${failed ? "block" : "none"}; }
</style></head>
<body>
  <form class="card" method="post" action="/login">
    <h1>Where We Are</h1>
    <p class="sub">Alex &amp; Anna's savings</p>
    <label for="username">Name</label>
    <input id="username" name="username" type="text" autocomplete="username" value="anna" />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
    <button type="submit">Open</button>
    <div class="err">That password did not match. Try again.</div>
  </form>
</body></html>`;
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
