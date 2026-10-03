import { privateOptions, protectedPath } from "./protected-path.ts";
/** Bridge to an INSTALLED private v2 source. Provider code/endpoints/cookies stay private.
 * Supports only verbs actually shipped there: KA contact/send and LinkedIn inbox reply.
 * LinkedIn comment posting/feed require a private adapter implementing those surfaces.
 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { Adapter, Finding, Message } from "./adapter.ts";

interface Options { source: "linkedin" | "kleinanzeigen"; module: string; source_dir: string; identity: string; token_argv: string[]; fixtures?: string }
function options(raw: Record<string, unknown>): Options {
  const o = raw as unknown as Options;
  if (!["linkedin","kleinanzeigen"].includes(o.source) || !isAbsolute(o.module ?? "") || !isAbsolute(o.source_dir ?? "") || !o.identity ||
    !Array.isArray(o.token_argv) || !o.token_argv.length || o.token_argv.some(v => typeof v !== "string")) throw new Error("private-adapter-config");
  protectedPath(o.source_dir);
  privateOptions(raw, "/");
  return o;
}
async function context(o: Options, signal: AbortSignal) {
  return { sourceDir: o.source_dir, ...(o.fixtures ? { fixtures: o.fixtures } : {}),
    http: (input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, signal }),
    token: async (site: string) => {
      // The trusted command owns session-host integration. No shell; its output never reaches notices/logs.
      const child = Bun.spawn([...o.token_argv, site], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const stop = () => child.kill(); signal.addEventListener("abort", stop, { once: true });
      try {
        const bytes = await new Response(child.stdout).arrayBuffer();
        if (bytes.byteLength > 65536 || await child.exited !== 0) throw new Error("private-session-unavailable");
        return { ok: true, cookie: new TextDecoder().decode(bytes).trim() };
      } finally { signal.removeEventListener("abort", stop); }
    },
  };
}
export const capabilities = ["seller_contact", "message"] as const;
export const surfaces = ["comments", "messages"] as const;
export async function send(message: Message & { attempt_id: string }, raw: Record<string, unknown>, signal: AbortSignal) {
  const o = options(raw);
  if (message.identity !== o.identity || message.target.kind === "comment" || /[/\\\u0000]|^\./.test(message.target.id)) throw new Error("private-target-unsupported");
  const source = await import(pathToFileURL(o.module).href);
  const verb = o.source === "linkedin" ? "reply" : message.target.kind === "seller_contact" ? "contact" : "send";
  if (o.source === "linkedin" && message.target.kind !== "message") throw new Error("private-target-unsupported");
  const result = await source.verbs[verb](o.source_dir, message.target.id, message.text, await context(o, signal));
  if (result?.delivered !== true) throw new Error("private-send-unconfirmed");
  // The old transport acknowledges HTTP acceptance but supplies no provider message ID.
  return { identity: o.identity, receipt: `legacy-http-accepted:${message.attempt_id}` };
}
export async function read(_request: { surfaces: readonly string[] }, raw: Record<string, unknown>, signal: AbortSignal) {
  const o = options(raw);
  if (o.source !== "linkedin") throw new Error("private-read-unsupported");
  const source = await import(pathToFileURL(o.module).href);
  const ctx = await context(o, signal);
  const spec = { target: { inbox: true } };
  const fetched = await source.fetch(spec, null, ctx);
  if (!fetched?.ok) throw new Error("private-read-unavailable");
  const listings = source.parse(fetched.raw, spec, ctx);
  const findings: Finding[] = listings.slice(0, 100).map((one: any) => ({ id: String(one.id), surface: one.kind === "comment" ? "comments" : "messages",
    target: { kind: one.kind === "comment" ? "comment" : "message", id: String(one.x?.thread || one.id), url: String(one.url), label: String(one.text?.counterpart || one.text?.title || one.id) },
    text: String(one.text?.snippet || one.text?.title || ""), changed_at: new Date(Number(String(one.state).split("|")[0]) || 0).toISOString() }));
  return { identity: o.identity, findings };
}
const adapter: Adapter = { capabilities, surfaces, send, read };
export default adapter;
