// imprnt · session-host — CLI. Shipped as built session-host.js (node banner).
//
//   serve            run the warm browser + localhost broker (you start it; Ctrl-C stops it)
//   login <url>      open the dedicated browser headful to sign into a site ONCE (run with serve stopped)
//   status           show the warm host's health + which sites are enrolled
//
// The host holds only what you enroll, in its own profile, separate from your daily browser. Automation
// never types a password — `login` is the one human step.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./server.ts";
import { resolveSite } from "./sites.ts";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SESSION_HOST_PORT ?? 8787);

async function cmdLogin(arg: string): Promise<number> {
  const cfg = resolveSite(arg);
  const loginUrl = cfg?.loginUrl ?? (arg.startsWith("http") ? arg : `https://${arg}`);
  const { chromium } = await import("playwright-core");
  const profileDir = join(here, "profile");
  console.log(`login: opening the dedicated browser at ${loginUrl}`);
  console.log("  (stop `serve` first if it's running — they share one profile)");
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, { headless: false, channel: "chrome", chromiumSandbox: true });
  } catch (e) {
    console.error(`login: could not open the browser — ${e instanceof Error ? e.message : e}`);
    console.error("  is `serve` still running? it locks the profile. Stop it and retry.");
    return 1;
  }
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(loginUrl).catch(() => {});
  console.log("  sign in by hand. I'll detect the session and finish automatically.");

  // poll for the token cookie if we know the site; otherwise wait for the window to close
  const deadline = Date.now() + 5 * 60 * 1000;
  if (cfg) {
    while (Date.now() < deadline) {
      if (context.pages().length === 0) break; // user closed it
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
    // unknown site: just wait until the user closes the window
    while (Date.now() < deadline && context.pages().length > 0) await new Promise((r) => setTimeout(r, 1500));
  }
  await context.close().catch(() => {});
  console.log("login: done (or timed out). Run `status` to confirm the session is enrolled.");
  return 0;
}

async function cmdStatus(): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/status`);
    const j = (await res.json()) as { enrolled: Record<string, boolean> };
    console.log(`session-host: warm on :${PORT}`);
    for (const [site, ok] of Object.entries(j.enrolled)) console.log(`  ${ok ? "✓ enrolled" : "✗ not enrolled"}  ${site}`);
    return 0;
  } catch {
    console.log(`session-host: not running on :${PORT} (start it with \`session-host serve\`)`);
    return 1;
  }
}

const cmd = process.argv[2];
const arg = process.argv[3] ?? "";

async function main(): Promise<number> {
  switch (cmd) {
    case "serve": await serve(here); return 0; // serve() runs until SIGINT
    case "login":
      if (!arg) { console.error("usage: session-host login <url|site>"); return 1; }
      return await cmdLogin(arg);
    case "status": return await cmdStatus();
    default:
      console.error("usage: session-host <serve|login <url>|status>");
      return 1;
  }
}

main().then((code) => { if (cmd !== "serve") process.exit(code); });
