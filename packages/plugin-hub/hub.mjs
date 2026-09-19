import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The command opens a store, and the store refuses a process started without
// this variable (src/store/connect.ts, STARTED_WITH). Bun reads it only at the
// start, so this launcher is where `imprnt hub` supplies it.
const env = { ...process.env, BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING: "1" };
const child = spawn("bun", [fileURLToPath(new URL("./src/entry/command.ts", import.meta.url)), ...process.argv.slice(2)], { stdio: "inherit", env });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
// A spawn that never started leaves no child to speak, so the shim says why.
// It exits once the line is written, because a pipe on macOS writes later.
child.on("error", error => {
  process.stderr.write(error.code === "ENOENT"
    ? "hub: bun was not found on PATH, and the hub runs on bun. Install it from https://bun.sh with `curl -fsSL https://bun.sh/install | bash`, then add its bin directory (usually ~/.bun/bin) to PATH.\n"
    : `hub: bun could not be started: ${error.message}\n`, () => process.exit(1));
});
child.on("exit", (code, signal) => {
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
  else process.exit(code ?? 1);
});
