// Actual pinned Codex + the production Hub box, using only a loopback Responses
// fixture and synthetic key. No provider/account/vault state is read or changed.
// bun live/prove-codex-box.ts --bin /absolute/path/to/codex
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { makeCodexLaunch, probeCodexVersion } from "../src/adapters/codex-launch.ts";
import { createCodex } from "../src/adapters/codex.ts";
import type { LoopLaunchInput } from "../src/adapters/launch.ts";
import type { AdapterSession, TurnEnd } from "../src/adapters/types.ts";
import { positiveControl } from "./codex-key-probe.ts";

const at = process.argv.indexOf("--bin"), bin = at < 0 ? null : process.argv[at + 1];
if (!bin) throw new Error("usage: bun live/prove-codex-box.ts --bin /absolute/path/to/codex");
const version = probeCodexVersion(bin);
if (version !== "0.160.0") throw new Error(`codex-version-unvalidated:${version}`);
const root = realpathSync(mkdtempSync(join(tmpdir(), "hub-codex-box-proof-")));
const tree = join(root, "tree"), other = join(root, "other-person"), secrets = join(root, "secrets");
const sessionDir = join(root, "state", "p1", "session"), marker = join(sessionDir, "mcp-called.json");
const pidFile = join(sessionDir, "codex-pid.json"), shellMarker = join(sessionDir, "shell-key-probe.json");
const probe = join(dirname(fileURLToPath(import.meta.url)), "codex-key-probe.ts");
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const shellCommand = [process.execPath, probe, pidFile, shellMarker].map(quote).join(" ");
// A disposable sentinel in the actual Homebrew service-data subtree, never an
// existing database file. The proof removes only its newly created directory.
let brewData: string | null = null;
if (process.platform === "darwin") {
  const prefix = Bun.spawnSync(["brew", "--prefix"], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  if (!prefix.startsWith("/")) throw new Error("fixture-brew-prefix-unavailable");
  brewData = mkdtempSync(join(prefix, "var/hub-codex-data-proof-"));
  writeFileSync(join(brewData, "synthetic-db-page"), "synthetic other-person database content");
}
for (const path of [tree, other, secrets]) mkdirSync(path);
const secret = join(secrets, "key"), privateNote = join(other, "private-note");
writeFileSync(secret, "synthetic-only", { mode: 0o600 });
writeFileSync(privateNote, "synthetic-other-person", { mode: 0o600 });
let requests = 0, unexpected = 0;
const advertised = new Set<string>();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/responses") { unexpected++; return new Response("unexpected", { status: 400 }); }
  const body = await req.json() as Record<string, any>;
  if (body.model !== "gpt-6-sol" || req.headers.get("authorization") !== "Bearer synthetic-only") { unexpected++; return new Response("unexpected", { status: 400 }); }
  requests++;

  for (const tool of body.tools ?? []) for (const name of tool.type === "namespace" ? (tool.tools ?? []).map((one: any) => `${tool.name}.${one.name}`) : [tool.name ?? tool.type]) advertised.add(name);
  const toolRequest = requests === 1;
  const item: any = toolRequest
    ? { type: "custom_tool_call", id: "call_fixture", call_id: "call_fixture", name: "exec", namespace: "functions", input: `const result = await tools.mcp__hub__hub_probe({}); text(result); const shell = await tools.exec_command({cmd:${JSON.stringify(shellCommand)}}); text(shell);` }
    : { id: `msg_${requests}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "offline fixture answer", annotations: [] }] };
  const response = { id: `resp_${requests}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: "gpt-6-sol", output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: toolRequest ? item : { ...item, status: "in_progress", content: [] } },
    ...(!toolRequest ? [
      { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "offline fixture answer" },
      { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "offline fixture answer" },
    ] : []),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(events.map((event, i) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: i })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
const mcp = join(dirname(fileURLToPath(import.meta.url)), "codex-box-mcp-fixture.ts");
const input = {
  registry: null, preset: { adapter: "codex", model: "gpt-6-sol", provider: "hub_test", effort: "high", paid: "key" },
  credential: { id: "test", owner: "p1", kind: "model-key", file: secret, base_url: `http://127.0.0.1:${server.port}/v1` },
  agent: { id: "worker", person: "p1", preset: "test", runner: "test" }, sessionDir, purpose: "ordinary",
  box: { tree, agent: "worker", person: "p1", stateRoot: join(root, "state", "p1"), otherTrees: [other], secretPaths: [secrets], purpose: "ordinary" },
  hubMcp: { command: process.execPath, args: [mcp], env: { FIXTURE_MARKER: marker, FIXTURE_SECRET: secret, FIXTURE_OTHER: privateNote, FIXTURE_PID_FILE: pidFile,
    ...(brewData ? { FIXTURE_BREW_DATA: join(brewData, "synthetic-db-page") } : {}) }, reads: [mcp, probe], writes: [] },
} as LoopLaunchInput;
let session: AdapterSession | null = null;
const exits: boolean[] = [];
try {
  const unboxedControl = await positiveControl();
  if (!Object.values(unboxedControl).some(one => one.exposed)) throw new Error("fixture-key-positive-control-failed");
  const launch = makeCodexLaunch(input, bin);
  const adapter = createCodex({ timeoutMs: 10_000 });
  for (let i = 0; i < 2; i++) {
    session = await adapter.start({ ...launch, preset: input.preset, sessionId: "fixture-job", session: { id: "fixture-job", resume: i > 0 } });
    writeFileSync(pidFile, JSON.stringify({ pid: session.pid, pids: session.processes?.() ?? [session.pid] }));
    const ended = new Promise<TurnEnd>(resolve => session!.onTurnEnd(resolve));
    await session.feed({ id: `fixture-${i}`, text: "return the fixture result" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("fixture-turn-timeout")), 10_000); })]).finally(() => clearTimeout(timer));
    if (result.text !== "offline fixture answer" || result.refused) throw new Error("fixture-answer-mismatch");
    await session.close();
    exits.push((await session.exitEvidence!()).confirmed);
  }
  if (!existsSync(marker)) throw new Error("fixture-mcp-not-called");
  const fences = JSON.parse(readFileSync(marker, "utf8"));
  if (fences.probe_error) throw new Error(fences.probe_error);
  const shell = JSON.parse(readFileSync(shellMarker, "utf8"));
  const keyExposed = (result: any) => result.own_environment_exposed || result.parents.some((one: Record<string, { exposed: boolean }>) => Object.values(one).some(route => route.exposed));
  if (keyExposed(fences.key_probe) || keyExposed(shell)) throw new Error("fixture-provider-key-exposed");
  const containsKeyOnDisk = (path: string): boolean => readdirSync(path, { withFileTypes: true }).some(entry =>
    entry.isDirectory() ? containsKeyOnDisk(join(path, entry.name)) : entry.isFile() && readFileSync(join(path, entry.name)).includes(Buffer.from("synthetic-only")));
  if (containsKeyOnDisk(sessionDir) || existsSync(join(sessionDir, "codex/auth.json"))) throw new Error("fixture-provider-key-persisted");
  if (brewData && fences.brew_data_denied !== true) throw new Error("fixture-brew-data-exposed");
  if (!fences.secret_denied || !fences.other_person_denied || !exits.every(Boolean) || requests !== 3 || unexpected) throw new Error("fixture-proof-incomplete");
  const nativeDelegation = [...advertised].some(name => /spawn_agent|create_goal/.test(name));
  if (nativeDelegation) throw new Error("fixture-unexpected-native-delegation");
  console.log(JSON.stringify({ status: "passed", version, platform: process.platform, boxed: true, turns: 2, normal_resume: true, requests, provider: "loopback-only", hub_tool_called: true, ...fences, shell_key_probe: shell, unboxed_control: unboxedControl,
    credential_transport: "ephemeral-stdio-rpc", credential_not_persisted: true, process_exit_confirmed: true, native_delegation_advertised: false }));
} finally {
  await session?.close();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
  if (brewData) rmSync(brewData, { recursive: true, force: true });
}
