import { AdapterMissing, type Adapter } from "./types.ts";
import { claudeCode } from "./claude-code.ts";

/**
 * The one place in the hub where a name maps to a loop. Every other piece takes
 * a map like this one as a parameter and looks the name up in it, so nothing
 * outside this file knows a loop exists.
 */
export const ADAPTERS: Record<string, Adapter> = {
  [claudeCode.name]: claudeCode,
};

export function adapterFor(adapters: Record<string, Adapter>, name: string): Adapter {
  const adapter = adapters[name];
  if (!adapter) throw new AdapterMissing(name, Object.keys(adapters));
  return adapter;
}
