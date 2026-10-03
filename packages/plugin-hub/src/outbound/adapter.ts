import { pathToFileURL } from "node:url";
import type { Account } from "./accounts.ts";

export interface Target { kind: "seller_contact" | "message" | "comment"; id: string; url: string; label: string }
export interface Message { account: string; identity: string; target: Target; text: string }
export interface Finding { id: string; surface: "comments" | "feed" | "messages"; target: Target; text: string; changed_at: string }
export interface Adapter {
  /** No retries. A success must identify this account and supply a concrete provider receipt. */
  send(input: Message & { attempt_id: string }, options: Record<string, unknown>, signal: AbortSignal): Promise<{ identity: string; receipt: string }>;
  /** Read only. Private adapters own endpoints/auth; no credentials enter findings. */
  read?(input: { surfaces: readonly string[] }, options: Record<string, unknown>, signal: AbortSignal): Promise<{ identity: string; findings: Finding[]; fresh_post_until?: string }>;
  capabilities: readonly Target["kind"][];
  surfaces?: readonly string[];
}
export async function adapterFor(account: Account): Promise<Adapter> {
  const module = await import(pathToFileURL(account.adapter_module).href);
  const adapter = (module.default ?? module) as Adapter;
  if (typeof adapter.send !== "function" || !Array.isArray(adapter.capabilities)) throw new Error("outbound-adapter-unavailable");
  return adapter;
}
export function validTarget(target: Target, platform: Account["platform"]): boolean {
  if (!target || !["seller_contact", "message", "comment"].includes(target.kind) ||
    ![target.id,target.url,target.label].every(v => typeof v === "string" && v.length > 0 && v.length <= 2000)) return false;
  if ((platform === "linkedin" && target.kind === "seller_contact") || (platform === "kleinanzeigen" && target.kind === "comment")) return false;
  try {
    const url = new URL(target.url);
    const host = platform === "linkedin" ? "linkedin.com" : "kleinanzeigen.de";
    return url.protocol === "https:" && !url.username && !url.password && (url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}
