// imprnt · session-host — the broker client. Consumers COPY or import this to ask for an authed
// session, the same ~12-line reader pattern plugins copy elsewhere (no hard import edge on this module).
//
// This is the "authed-session" capability's consumer side. A module that needs a logged-in session for
// a site calls `sessionToken(site)`; it gets a fresh bearer token from the warm host, or null when the
// host is down / the site isn't enrolled — so the consumer can DEGRADE GRACEFULLY (the contract rule),
// never hard-fail because a capability provider is absent.
export type TokenResult = { token: string } | { error: string };

const PORT = Number(process.env.SESSION_HOST_PORT ?? 8787);

// Fetch a fresh bearer token for a site from the warm session host. Returns null when the host isn't
// running or the site isn't enrolled — the caller falls back (e.g. to a direct browser read). A short
// timeout keeps a missing host from stalling a sync.
export async function sessionToken(site: string, timeoutMs = 8000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/session/token?site=${encodeURIComponent(site)}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const j = (await res.json()) as TokenResult;
    return "token" in j ? j.token : null;
  } catch {
    return null; // host down / unreachable — graceful degradation, the caller has a fallback
  } finally {
    clearTimeout(t);
  }
}

// Is the warm host up at all? (cheap liveness, for status/diagnostics)
export async function hostAlive(timeoutMs = 2000): Promise<boolean> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
