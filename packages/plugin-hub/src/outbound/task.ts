import type { Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { deliverOutbound } from "./delivery.ts";
import { readOutbound } from "./reading.ts";
/** A door-owned, single-pass loop. Failure never turns an uncertain send back into queued. */
export function startOutbound(store: StoreLike, registry: () => Registry, door: string) {
  let stopping = false;
  let wake: (() => void) | undefined;
  const done = (async () => {
    while (!stopping) {
      try { const fresh = registry(); await deliverOutbound(store, fresh, door); if (!stopping) await readOutbound(store, fresh, door); }
      catch { /* Authority/store unavailable: make no external call; next pass rereads authority. */ }
      if (stopping) break;
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); wake = () => { clearTimeout(timer); resolve(); }; });
    }
  })();
  return { async stop() { stopping = true; wake?.(); await done; } };
}
