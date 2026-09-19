import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn("bun", [fileURLToPath(new URL("./src/entry/command.ts", import.meta.url)), ...process.argv.slice(2)], { stdio: "inherit" });
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
