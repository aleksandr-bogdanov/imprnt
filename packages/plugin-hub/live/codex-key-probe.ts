// Synthetic-only credential-boundary probe, run by both the MCP fixture and
// Codex's actual shell tool. Never returns environment bytes or token values.
import { readFileSync, writeFileSync } from "node:fs";
import { dlopen, ptr } from "bun:ffi";

const KEY = "HUB_CODEX_KEY";
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
    // The app-server's host PID is outside the box's private PID namespace.
    // Walk only our ancestors; no unrelated host process is inspected.
    let pid = process.ppid;
    for (let n = 0; n < 20 && pid > 0; n++) {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      // Include both the native executable and npm's Node launcher, when
      // present. Hardening the Rust child alone would not hide its launcher.
      if (cmd.includes("app-server")) parents.push(inspect(pid));
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      pid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
    }
    if (!parents.length) throw new Error("fixture-codex-parent-unidentified");
  } else for (const pid of target.pids ?? [target.pid]) parents.push(inspect(pid));
  return { own_environment_exposed: Boolean(process.env[KEY]), parents, positive: await positiveControl() };
}

if (import.meta.main) {
  const [pidFile, output] = process.argv.slice(2);
  const result = await probeKey(pidFile);
  writeFileSync(output, JSON.stringify(result));
  console.log("synthetic key probe recorded");
}
