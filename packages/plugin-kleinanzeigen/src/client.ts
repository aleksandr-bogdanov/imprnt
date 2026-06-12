// imprnt · kleinanzeigen plugin — the network edge. The ONLY module that may touch the wire.
//
// Kleinanzeigen has no public API. The real endpoints can only be discovered from a logged-in session,
// so they live in `endpoints.json`, written by the `probe` subcommand (which Alex runs once with his
// cookies). Until that file exists, every wire call fails LOUD, naming the probe step — never silently.
//
// Two test/offline doors, so the whole pipeline is exercisable with ZERO network:
//   KLEINANZEIGEN_FIXTURES=<dir>  read conversations from *.json there instead of the wire
//   KLEINANZEIGEN_DRY_RUN=1       `send` records intent without posting
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Msg } from "./mirror.ts";

export type RawConv = {
  conv: string;
  listing: string;
  counterpart: string;
  synthetic?: boolean;
  messages: Msg[];
};

export type Endpoints = {
  transport: string; // "messagebox-json" | "api-basic" | ...
  conversations_url?: string;
  reply_url?: string;
  note?: string;
};

const PROBE_HINT =
  "no endpoints.json — the live transport isn't wired yet.\n" +
  "  Run the probe once while logged in:  KLEINANZEIGEN_COOKIES=<jar> node kleinanzeigen.js probe\n" +
  "  Or run offline against fixtures:      KLEINANZEIGEN_FIXTURES=./fixtures node kleinanzeigen.js sync";

export function loadEndpoints(here: string): Endpoints | null {
  const p = join(here, "endpoints.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as Endpoints; } catch { return null; }
}

function readFixtures(dir: string): RawConv[] {
  if (!existsSync(dir)) throw new Error(`KLEINANZEIGEN_FIXTURES points at a missing dir: ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as RawConv);
}

// Fetch every conversation. Fixtures win when the env var is set (the offline/test path). Otherwise we
// require endpoints.json; even with it, the live HTTP client is a v1 TODO and says so plainly rather
// than pretending to sync. No silent empty result — a watcher that lies about "0 new" is worse than one
// that fails.
export function fetchConversations(here: string): RawConv[] {
  const fixtures = process.env.KLEINANZEIGEN_FIXTURES;
  if (fixtures) return readFixtures(fixtures);

  const endpoints = loadEndpoints(here);
  if (!endpoints) throw new Error(PROBE_HINT);

  throw new Error(
    `endpoints.json present (transport: ${endpoints.transport}) but the live HTTP client is not implemented in v1.\n` +
    "  v1 ships the deterministic pipeline; wiring the real fetch is the post-probe follow-up.\n" +
    "  Run offline meanwhile: KLEINANZEIGEN_FIXTURES=./fixtures node kleinanzeigen.js sync",
  );
}

export type SendResult = { delivered: boolean; dryRun: boolean; note: string };

// Post one reply to one conversation. Dry-run / fixtures mode records intent without a wire call. The
// live path is the same v1 TODO as fetch — loud, never a silent no-op that looks like success.
export function postReply(here: string, conv: string, _text: string): SendResult {
  if (process.env.KLEINANZEIGEN_DRY_RUN || process.env.KLEINANZEIGEN_FIXTURES) {
    return { delivered: false, dryRun: true, note: `dry-run: reply to ${conv} recorded, not sent` };
  }
  const endpoints = loadEndpoints(here);
  if (!endpoints) throw new Error(PROBE_HINT);
  throw new Error(
    `endpoints.json present (transport: ${endpoints.transport}) but live send is not implemented in v1.\n` +
    "  Use KLEINANZEIGEN_DRY_RUN=1 to record intent, or wire the reply transport after probe.",
  );
}
