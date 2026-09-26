import { fileURLToPath } from "node:url";
import { voiceFor } from "../registry/entries.ts";
import { VOICE_DEFAULTS, type RunEntry } from "../registry/load.ts";

/**
 * Every supported service has its own entry point.
 *
 * Seven of them are this package's own TypeScript, started by the interpreter
 * that renders the unit. The eighth is the local recognizer's reference
 * server, which is Python, and it is the ONE program here that is not a bun
 * entry point. Nothing downstream branches on that: the interpreter and the whole
 * command line arrive at the renderer as a value.
 */
export function programForKind(kind: string): string {
  switch (kind) {
    case "hub": return fileURLToPath(new URL("../entry/hub.ts", import.meta.url));
    case "door": return fileURLToPath(new URL("../entry/door.ts", import.meta.url));
    case "runner": return fileURLToPath(new URL("../entry/runner.ts", import.meta.url));
    case "sync": return fileURLToPath(new URL("../entry/sync.ts", import.meta.url));
    case "board": return fileURLToPath(new URL("../entry/board.ts", import.meta.url));
    case "backup": return fileURLToPath(new URL("../entry/backup.ts", import.meta.url));
    case "watch": return fileURLToPath(new URL("../entry/watch.ts", import.meta.url));
    case "transcriber": return fileURLToPath(new URL("../../tools/transcribe-server.py", import.meta.url));
    default: throw new Error(`unsupported-run-kind: ${kind}`);
  }
}

/**
 * The whole command line the recognizer's server is started with, derived from
 * the registry and from nothing else.
 *
 * EVERY KNOB IS AN ARGUMENT. A behaviour switch on the command line is what an
 * operator reading the unit file can see, and one in an environment variable is
 * not, which is why the file forbids the second. The server this replaces took
 * every one of its knobs that way, and none of them survives here.
 *
 * The interpreter is the runtime's own, because the runtime is where the
 * virtual environment and the weights live and both are outside this package.
 * The residency decides the tail: the value that holds the model says so with
 * `--warm` and an idle window of zero, and the value that drops it names the
 * window it waits. There is no third shape.
 */
export function transcriberArgv(registry: unknown, entry: RunEntry): string[] {
  const voice = voiceFor(registry);
  if (voice === null || voice.provider !== "sherpa-onnx" || voice.runtime === null) {
    // The loader already refuses such a file by line, so reaching this means a
    // caller built an entry the registry never carried.
    throw new Error("unsupported-run-kind: transcriber, because no recognizer runs on this machine");
  }
  const residency = entry.residency ?? VOICE_DEFAULTS.residency;
  return [
    `${voice.runtime}/venv/bin/python`,
    programForKind("transcriber"),
    "--port",
    String(entry.port),
    "--runtime",
    voice.runtime,
    "--model",
    voice.model,
    ...(residency === "idle-unload"
      ? ["--idle-s", String(entry.idle_seconds ?? VOICE_DEFAULTS.idle_seconds)]
      : ["--warm", "--idle-s", "0"]),
  ];
}
