// Synthetic-only credential-boundary probe, run by both the MCP fixture and
// OpenCode's actual shell tool. Never returns environment bytes or token values.
import { readFileSync, writeFileSync } from "node:fs";
import { dlopen, ptr } from "bun:ffi";

const KEY = "HUB_OPENCODE_API_KEY";
const containsKey = (value: string) => new RegExp(`${KEY}=[^\\s\\0]+`).test(value);
type Evidence = { readable: boolean; exposed: boolean };
function inspect(pid: number): Record<string, Evidence> {
  if (process.platform === "linux") {
    try { return { proc: { readable: true, exposed: containsKey(readFileSync(`/proc/${pid}/environ`, "utf8")) } }; }
    catch { return { proc: { readable: false, exposed: false } }; }
  }
  let psEvidence: Evidence = { readable: false, exposed: false };
  try {
    const ps = Bun.spawnSync(["/bin/ps", "eww", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
    psEvidence = { readable: ps.exitCode === 0, exposed: containsKey(ps.stdout.toString()) };
  } catch { /* The outer box may refuse execution of the setuid ps binary. */ }
  // KERN_PROCARGS2 is the direct sysctl route, independent of ps formatting.
  const libc = dlopen("/usr/lib/libSystem.B.dylib", { sysctl: { args: ["ptr", "u32", "ptr", "ptr", "ptr", "usize"], returns: "i32" } });
  try {
    const mib = new Int32Array([1, 49, pid]);
    const bytes = new Uint8Array(1024 * 1024), size = new BigUint64Array([BigInt(bytes.length)]);
    const code = libc.symbols.sysctl(ptr(mib), 3, ptr(bytes), ptr(size), null, 0);
    return { ps: psEvidence, sysctl: { readable: code === 0, exposed: code === 0 && containsKey(Buffer.from(bytes.subarray(0, Number(size[0]))).toString()) } };
  } finally { libc.close(); }
}

export async function positiveControl() {
  // Use an ordinary non-platform process: macOS hides environment strings
  // for protected /bin binaries even outside the Hub sandbox.
  const control = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], { env: { PATH: process.env.PATH, [KEY]: "synthetic-positive-control" }, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  try { return inspect(control.pid); }
  finally { control.stdin.end(); await control.exited; }
}

export async function probeKey(pidFile: string) {
  const target = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; pids?: number[] };
  const parents: Record<string, Evidence>[] = [];
  if (process.platform === "linux") {
    // The engine's host PID is outside the box's private PID namespace.
    // Walk only our ancestors; no unrelated host process is inspected.
    let pid = process.ppid;
    for (let n = 0; n < 20 && pid > 0; n++) {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      // Include the engine and its sandbox launcher where present.
      if (cmd.includes("serve")) parents.push(inspect(pid));
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      pid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
    }
    if (!parents.length) throw new Error("fixture-opencode-parent-unidentified");
  } else for (const pid of target.pids ?? [target.pid]) parents.push(inspect(pid));
  const authFile = `${process.env.XDG_DATA_HOME}/opencode/auth.json`;
  let persistedKeyReadable = false;
  try { persistedKeyReadable = readFileSync(authFile, "utf8").includes("synthetic-auth-api-key"); } catch {}
  let configKeyReadable = false;
  const publicState = JSON.parse(readFileSync(pidFile, "utf8"));
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    const response = await fetch(`http://127.0.0.1:${publicState.port}/config`, { headers: { Authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` } });
    configKeyReadable = (await response.text()).includes("synthetic-env-api-key");
  }
  return { own_environment_exposed: Boolean(process.env[KEY]), server_password_inherited: Boolean(process.env.OPENCODE_SERVER_PASSWORD), config_key_readable: configKeyReadable, persisted_auth_key_readable: persistedKeyReadable, parents, positive: await positiveControl() };
}

if (import.meta.main && process.argv[2] === "--mcp") {
  const { createInterface } = await import("node:readline");
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    let result: unknown = {};
    if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "opencode-key-proof", version: "1" } };
    if (request.method === "tools/list") {
      try { writeFileSync(process.env.FIXTURE_OUTPUT!, JSON.stringify(await probeKey(process.env.FIXTURE_PID_FILE!))); }
      catch (error) { writeFileSync(process.env.FIXTURE_OUTPUT!, JSON.stringify({ error: String((error as Error).message) })); }
      result = { tools: [] };
    }
    if (request.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  }
} else if (import.meta.main) {
  const [pidFile, output] = process.argv.slice(2);
  const result = await probeKey(pidFile);
  writeFileSync(output, JSON.stringify(result));
  console.log("synthetic key probe recorded");
}
