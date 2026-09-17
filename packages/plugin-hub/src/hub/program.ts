import { fileURLToPath } from "node:url";

/** Every supported service has its own entry point. */
export function programForKind(kind: string): string {
  switch (kind) {
    case "hub": return fileURLToPath(new URL("../entry/hub.ts", import.meta.url));
    case "door": return fileURLToPath(new URL("../entry/door.ts", import.meta.url));
    case "runner": return fileURLToPath(new URL("../entry/runner.ts", import.meta.url));
    case "sync": return fileURLToPath(new URL("../entry/sync.ts", import.meta.url));
    default: throw new Error(`unsupported-run-kind: ${kind}`);
  }
}
