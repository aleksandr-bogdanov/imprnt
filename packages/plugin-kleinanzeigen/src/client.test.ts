import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchConversations, fetchConversationList, type Endpoints, type ListConv } from "./client.ts";

// The live sync path with global fetch stubbed — zero network. The one behavior under test: a failed
// per-conversation detail fetch (transient 429/5xx, bad JSON) must be FLAGGED (detail_failed), never
// returned as a silently-empty message log that sync would write over the prior mirror file.

const LIST = [
  { id: "good", adId: "9000000001", adTitle: "A", adStatus: "active", buyerName: "Buyer One", role: "Seller", unreadMessagesCount: 0 },
  { id: "flaky", adId: "9000000001", adTitle: "B", adStatus: "active", buyerName: "Buyer Two", role: "Seller", unreadMessagesCount: 1 },
];

let here: string;
const realFetch = globalThis.fetch;
const savedFixtures = process.env.KLEINANZEIGEN_FIXTURES;
const savedToken = process.env.KLEINANZEIGEN_TOKEN;

beforeAll(() => {
  delete process.env.KLEINANZEIGEN_FIXTURES; // fixtures would win over the live path
  process.env.KLEINANZEIGEN_TOKEN = "test-token"; // skip the browser session read
  here = mkdtempSync(join(tmpdir(), "ka-client-"));
  writeFileSync(join(here, "endpoints.json"), JSON.stringify({
    transport: "messagebox-web",
    base: "https://gateway.invalid/messagebox/api",
    userId: "1",
    listPath: "/users/{userId}/conversations?page={page}&size={size}",
    detailPath: "/users/{userId}/conversations/{convId}",
    replyPath: null,
    headers: {},
  }));
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("page=")) return Response.json({ conversations: LIST });
    if (u.endsWith("/conversations/good")) {
      return Response.json({ messages: [{ textShort: "noch da?", boundness: "INBOUND", receivedDate: "2026-06-12T10:00:00Z" }] });
    }
    // the flaky conversation's detail: a transient 500 with a non-JSON body
    return new Response("upstream error", { status: 500 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (savedFixtures !== undefined) process.env.KLEINANZEIGEN_FIXTURES = savedFixtures;
  else delete process.env.KLEINANZEIGEN_FIXTURES;
  if (savedToken !== undefined) process.env.KLEINANZEIGEN_TOKEN = savedToken;
  else delete process.env.KLEINANZEIGEN_TOKEN;
  rmSync(here, { recursive: true, force: true });
});

describe("live sync — a failed detail fetch is flagged, never a silent empty thread", () => {
  test("the ok conversation carries its messages, the 500'd one carries detail_failed", async () => {
    const raws = await fetchConversations(here);
    expect(raws).toHaveLength(2);

    const good = raws.find((r) => r.conv === "good")!;
    expect(good.detail_failed).toBe(false);
    expect(good.messages).toHaveLength(1);
    expect(good.messages[0]).toEqual({ from: "them", at: "2026-06-12T10:00:00Z", body: "noch da?" });

    const flaky = raws.find((r) => r.conv === "flaky")!;
    expect(flaky.detail_failed).toBe(true);
    expect(flaky.messages).toHaveLength(0); // empty because unreadable — sync must keep the prior mirror
  });
});

// The page walk, exercised directly (no detail fetches, no politeness delays worth waiting on).
// A single page=0&size=100 fetch used to silently drop everything past the first 100 conversations.
describe("list pagination — a 100+ conversation box is walked page by page", () => {
  const ep: Endpoints = {
    transport: "messagebox-web",
    base: "https://gateway.invalid/messagebox/api",
    userId: "1",
    listPath: "/users/{userId}/conversations?page={page}&size={size}",
    detailPath: "/users/{userId}/conversations/{convId}",
    replyPath: null,
    headers: {},
  };
  const mkConv = (i: number): ListConv => ({ id: `c${i}`, adId: "1", adTitle: "T", adStatus: "active", buyerName: "B", role: "Seller", unreadMessagesCount: 0 });
  const page = (u: string) => Number(u.match(/page=(\d+)/)![1]);

  // Each test installs its own fetch stub and restores the file-level one from beforeAll.
  async function withFetch<T>(stub: typeof fetch, body: () => Promise<T>): Promise<T> {
    const prev = globalThis.fetch;
    globalThis.fetch = stub;
    try { return await body(); } finally { globalThis.fetch = prev; }
  }

  test("a full page triggers the next; the short page ends the walk", async () => {
    const pages = [Array.from({ length: 100 }, (_, i) => mkConv(i)), [mkConv(100)]];
    const calls: number[] = [];
    const convs = await withFetch((async (url: unknown) => {
      calls.push(page(String(url)));
      return Response.json({ conversations: pages[calls[calls.length - 1]] ?? [] });
    }) as typeof fetch, () => fetchConversationList(ep, {}));
    expect(convs).toHaveLength(101);
    expect(calls).toEqual([0, 1]);
  });

  test("an API that ignores `page` cannot loop forever — a page with no new ids stops the walk", async () => {
    const same = Array.from({ length: 100 }, (_, i) => mkConv(i));
    const calls: number[] = [];
    const convs = await withFetch((async (url: unknown) => {
      calls.push(page(String(url)));
      return Response.json({ conversations: same }); // page param ignored: always the same 100
    }) as typeof fetch, () => fetchConversationList(ep, {}));
    expect(convs).toHaveLength(100); // deduped, not doubled
    expect(calls).toEqual([0, 1]); // the repeat page stopped the walk
  });

  test("a failed LATER page warns and returns the partial list; a failed page 0 still throws", async () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      const convs = await withFetch((async (url: unknown) => {
        if (page(String(url)) === 0) return Response.json({ conversations: Array.from({ length: 100 }, (_, i) => mkConv(i)) });
        return new Response("upstream error", { status: 500 });
      }) as typeof fetch, () => fetchConversationList(ep, {}));
      expect(convs).toHaveLength(100); // partial is safe: sync never prunes, the rest keep their mirror
      expect(errors.join("\n")).toContain("list page 1");

      await expect(
        withFetch((async (_url: unknown) => new Response("nope", { status: 401 })) as typeof fetch, () => fetchConversationList(ep, {})),
      ).rejects.toThrow("list fetch 401");
    } finally {
      console.error = orig;
    }
  });
});
