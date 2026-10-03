import { privateOptions, privateRootFor, protectedPath } from "./protected-path.ts";
import type { Target } from "./adapter.ts";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
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
  capabilities: Target["kind"][];
  options?: Record<string, unknown>;
}
export interface AccountConfiguration { accounts: Account[]; invalid: { id: string; cause: string }[] }
export function accountConfiguration(registry: Registry): AccountConfiguration {
  const path = readSetting(registry, "outbound.accounts_file");
  if (path === undefined) return {accounts:[],invalid:[]};
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("outbound-config-unavailable");
  const root=privateRootFor(path,registry);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let parsed:unknown;
  try {
    const info=fstatSync(fd);
    if(!info.isFile() || info.uid!==process.getuid?.() || (info.mode & 0o077)!==0 || info.size>262144) throw new Error("outbound-config-unprotected");
    parsed=JSON.parse(readFileSync(fd,"utf8"));
  } finally {closeSync(fd);}
  if (!Array.isArray(parsed) || parsed.length > 20) throw new Error("outbound-config-unavailable");
  const accounts: Account[]=[], invalid: AccountConfiguration["invalid"]=[];
  const ids=parsed.map(a=>a?.id);
  for (const raw of parsed) {
    try {
      const a=raw as Account;
      if (!a || ![a.id,a.person,a.agent,a.door,a.identity,a.adapter_module].every(v => typeof v === "string" && v.length > 0 && v.length <= 1000) ||
        !["linkedin", "kleinanzeigen"].includes(a.platform) || ids.filter(id=>id===a.id).length!==1 ||
        !Array.isArray(a.capabilities) || !a.capabilities.length || a.capabilities.some(c=>!["seller_contact","message","comment"].includes(c))) throw new Error("invalid-account");
      protectedPath(a.adapter_module,registry);
      privateOptions(a.options,root,registry);
      if (!listAgents(registry).some(one=>one.id===a.agent && one.person===a.person && one.door===a.door && one.chat)) throw new Error("route-unavailable");
      accounts.push(a);
    } catch { invalid.push({id:typeof raw?.id==="string" && /^[a-zA-Z0-9_-]{1,100}$/.test(raw.id) ? raw.id : "invalid-entry",cause:"account-unavailable"}); }
  }
  return {accounts,invalid};
}
export const accountsOf = (registry: Registry): Account[] => accountConfiguration(registry).accounts;
export const accountHash = (a: Account): string => createHash("sha256").update(canonicalJson(a)).digest("hex");
