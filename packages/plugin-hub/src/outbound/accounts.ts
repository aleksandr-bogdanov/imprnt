import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { listAgents } from "../registry/entries.ts";
import { readSetting, type Registry } from "../registry/load.ts";
import { canonicalJson } from "../store/confirmations.ts";

export interface Account {
  id: string; person: string; agent: string; door: string;
  platform: "linkedin" | "kleinanzeigen";
  /** Exact owner-account identity shown with every message, not an access token. */
  identity: string;
  adapter_module: string;
  options?: Record<string, unknown>;
}
export function accountsOf(registry: Registry): Account[] {
  const path = readSetting(registry, "outbound.accounts_file");
  if (path === undefined) return [];
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("outbound-config-unavailable");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed) || parsed.length > 20) throw new Error("outbound-config-unavailable");
  const seen = new Set<string>();
  return parsed.map(raw => {
    const a = raw as Account;
    if (!a || ![a.id,a.person,a.agent,a.door,a.identity,a.adapter_module].every(v => typeof v === "string" && v.length > 0 && v.length <= 1000) ||
      !["linkedin", "kleinanzeigen"].includes(a.platform) || !isAbsolute(a.adapter_module) || seen.has(a.id)) throw new Error("outbound-config-unavailable");
    const agent = listAgents(registry).find(one => one.id === a.agent && one.person === a.person && one.door === a.door && one.chat);
    if (!agent) throw new Error("outbound-route-unavailable");
    seen.add(a.id); return a;
  });
}
export const accountHash = (a: Account): string => createHash("sha256").update(canonicalJson(a)).digest("hex");
