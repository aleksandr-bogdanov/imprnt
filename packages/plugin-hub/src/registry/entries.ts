import { Registry, type RunEntry } from "./load.ts";

/**
 * Everything the hub runs for this household. A missing field and a reused id
 * are refusals raised by loadRegistry, so one place refuses a file.
 */
export function listRunEntries(registry: unknown): RunEntry[] {
  if (!(registry instanceof Registry)) {
    throw new TypeError(
      `listRunEntries reads a registry loaded by loadRegistry, and this is ${typeof registry}`,
    );
  }
  return registry.run.map((entry) => ({ ...entry }));
}
