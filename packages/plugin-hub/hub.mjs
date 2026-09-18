import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn("bun", [fileURLToPath(new URL("./src/entry/command.ts", import.meta.url)), ...process.argv.slice(2)], { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", () => process.exit(1));
child.on("exit", (code, signal) => {
  if (signal) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
  else process.exit(code ?? 1);
});
