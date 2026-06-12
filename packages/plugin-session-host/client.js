#!/usr/bin/env node

// src/client.ts
var PORT = Number(process.env.SESSION_HOST_PORT ?? 8787);
async function sessionToken(site, timeoutMs = 8000) {
  const ctrl = new AbortController;
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/session/token?site=${encodeURIComponent(site)}`, { signal: ctrl.signal });
    if (!res.ok)
      return null;
    const j = await res.json();
    return "token" in j ? j.token : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
async function hostAlive(timeoutMs = 2000) {
  const ctrl = new AbortController;
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
export {
  sessionToken,
  hostAlive
};
