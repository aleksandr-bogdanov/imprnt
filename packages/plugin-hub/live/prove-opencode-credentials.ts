// Synthetic-only exposure measurement, never a live provider or account.
// "measured" reports observations; it does not mean credential isolation passed.
// bun live/prove-opencode-credentials.ts --bin /absolute/path/to/opencode
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCode } from "../src/adapters/opencode.ts";
import { makeOpenCodeLaunch, probeOpenCodeVersion } from "../src/adapters/opencode-launch.ts";
import type { AdapterSession } from "../src/adapters/types.ts";

const bin = process.argv[process.argv.indexOf("--bin") + 1];
if (!process.argv.includes("--bin") || probeOpenCodeVersion(bin) !== "1.18.34") throw new Error("pinned-opencode-required");
const root = realpathSync(mkdtempSync(join(tmpdir(), "hub-opencode-key-proof-")));
const tree = join(root, "tree"), secrets = join(root, "secrets"), sessionDir = join(root, "state/p1/session");
for (const path of [tree, secrets, sessionDir]) mkdirSync(path, { recursive: true });
const keyFile = join(secrets, "key"); writeFileSync(keyFile, "synthetic-env-api-key", { mode: 0o600 });
const pidFile = join(sessionDir, "probe-target.json"), mcpOutput = join(sessionDir, "mcp-proof.json");
const helper = join(import.meta.dir, "opencode-key-probe.ts");
let providerRequests = 0;
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { providerRequests++; return new Response("synthetic proof forbids model calls", { status: 503 }); } });
const preset = { adapter: "opencode", provider: "openai", model: "gpt-5", effort: "default", paid: "key" };
let session: AdapterSession | null = null;
try {
  const launch = makeOpenCodeLaunch({ registry: null, preset,
    credential: { id: "synthetic", owner: "p1", kind: "model-key", file: keyFile, base_url: `http://127.0.0.1:${provider.port}/v1` },
    agent: { id: "worker", person: "p1", preset: "synthetic", runner: "synthetic", tools: ["Read", "Bash"] }, sessionDir, purpose: "ordinary",
    box: { tree, person: "p1", agent: "worker", otherTrees: [], stateRoot: join(root, "state/p1"), secretPaths: [secrets], purpose: "ordinary" },
    hubMcp: { command: process.execPath, args: [helper, "--mcp"], env: { FIXTURE_PID_FILE: pidFile, FIXTURE_OUTPUT: mcpOutput }, reads: [helper], writes: [] },
  } as never, bin);
  let port = 0;
  const wrap = (args: string[]) => { port = Number(args[args.indexOf("--port") + 1]); return launch.wrap!(args); };
  session = await createOpenCode().start({ ...launch, wrap, preset, sessionId: null, session: { id: "synthetic-key-proof", resume: false } });
  writeFileSync(pidFile, JSON.stringify({ port, pid: session.pid, pids: session.processes?.() ?? [session.pid] }));
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { Authorization: `Basic ${Buffer.from(`opencode:${launch.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    if (!response.ok) throw new Error(`fixture-request-failed:${path}:${response.status}`);
    return result;
  };
  await request("GET", "/mcp");
  const until = Date.now() + 10_000;
  while (!existsSync(mcpOutput) && Date.now() < until) await Bun.sleep(50);
  const mcp = JSON.parse(readFileSync(mcpOutput, "utf8"));
  if (mcp.error) throw new Error(mcp.error);
  const mapping = JSON.parse(readFileSync(join(sessionDir, "opencode/hub-session.json"), "utf8"));
  const engine = mapping.sessions["synthetic-key-proof"].engine_session;
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const shellProbe = async (name: string) => {
    const output = join(sessionDir, `${name}.json`);
    await request("POST", `/session/${engine}/shell`, { agent: "build", command: [process.execPath, helper, pidFile, output].map(quote).join(" ") });
    return JSON.parse(readFileSync(output, "utf8"));
  };
  const shell = await shellProbe("shell-proof");
  // Evaluate the documented alternative with a second synthetic key. This
  // writes only this disposable conversation's own auth store.
  await request("PUT", "/auth/openai", { type: "api", key: "synthetic-auth-api-key" });
  const afterAuth = await shellProbe("shell-after-auth");
  const authFile = join(sessionDir, "opencode/data/opencode/auth.json");
  const apiPersistsKey = existsSync(authFile) && readFileSync(authFile, "utf8").includes("synthetic-auth-api-key");
  await session.close();
  const exitConfirmed = (await session.exitEvidence!()).confirmed;
  if (providerRequests !== 0 || !exitConfirmed) throw new Error("fixture-proof-incomplete");
  console.log(JSON.stringify({ status: "measured", version: "1.18.34", platform: process.platform, boxed: true, provider_requests: providerRequests, mcp, shell, api_auth_persists_key: apiPersistsKey, shell_after_auth: afterAuth, process_exit_confirmed: exitConfirmed }));
} finally {
  await session?.close(); provider.stop(true); rmSync(root, { recursive: true, force: true });
}
