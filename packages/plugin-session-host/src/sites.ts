// imprnt · session-host — the per-site registry.
//
// Each entry says how to keep a site's session warm and where its bearer token lives. Adding a site is
// one entry here plus a one-time `login`. This is the only site-specific knowledge in the host; the
// broker, the warm loop, and the audit log are all generic.
export type SiteConfig = {
  site: string; // the key consumers ask for, e.g. "kleinanzeigen.de"
  loginUrl: string; // where `login` opens for the one-time manual sign-in
  warmUrl: string; // a page kept loaded so the SPA refreshes its own token (the reliability trick)
  tokenCookie: string; // the cookie holding the bearer token
  tokenDomain: string; // the URL to read cookies against
};

export const SITES: Record<string, SiteConfig> = {
  "kleinanzeigen.de": {
    site: "kleinanzeigen.de",
    loginUrl: "https://www.kleinanzeigen.de/m-einloggen.html",
    warmUrl: "https://www.kleinanzeigen.de/m-nachrichten.html",
    tokenCookie: "access_token",
    tokenDomain: "https://www.kleinanzeigen.de",
  },
};

export function resolveSite(key: string): SiteConfig | null {
  // accept "kleinanzeigen.de", "www.kleinanzeigen.de", or a full URL
  const host = key.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return SITES[host] ?? null;
}
