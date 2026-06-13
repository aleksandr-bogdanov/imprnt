import { test, expect } from "bun:test";
import { composeDigest } from "./notify.ts";
import type { Conversation } from "./mirror.ts";

function c(over: Partial<Conversation>): Conversation {
  return {
    conv: "x", listing: "3432924231", counterpart: "X", state: "open", synthetic: true,
    messages: [], ...over,
  };
}

test("digest groups by listing, leads with scams, shows drafts and needs-you lines", () => {
  const convs: Conversation[] = [
    c({ conv: "2932z:1:scam", counterpart: "David Thiess", rating: "scam", tells: ["paypal", "name-mismatch"] }),
    c({ conv: "2932z:2:offer", counterpart: "Frank", rating: "offer", offer_amount: 70, below_floor: true }),
    c({ conv: "2932z:3:faq", counterpart: "Erik", rating: "faq", needs_fact: ["artikelnummer"], draft: null }),
    c({ conv: "2932z:4:pick", counterpart: "Patrick", rating: "pickup", draft: "Hi, Abholung ist möglich in Berlin. ..." }),
  ];
  const d = composeDigest(convs);

  expect(d).toContain("3432924231: 4 new");
  // each line LEADS with the verifiable conv id (the argument `send` takes); the name is a hint in ()
  const lines = d.split("\n");
  expect(lines[1]).toContain("2932z:1:scam");
  expect(lines[1]).toContain("(David Thiess)");
  expect(lines[1]).toContain("scam: paypal, name-mismatch");
  expect(d).toContain("2932z:2:offer (Frank) [offer 70€ (below floor)]");
  expect(d).toContain("2932z:3:faq (Erik) [faq] — needs you: confirm artikelnummer");
  expect(d).toContain('2932z:4:pick (Patrick) [pickup] draft: "Hi, Abholung');
});

test("answered/closed conversations drop out of the digest", () => {
  const convs = [
    c({ conv: "done", counterpart: "DoneGuy", state: "answered", rating: "faq" }),
    c({ conv: "live", counterpart: "LiveGuy", state: "open", rating: "pickup", draft: "x" }),
  ];
  const d = composeDigest(convs);
  expect(d).not.toContain("DoneGuy");
  expect(d).toContain("LiveGuy");
});

test("nothing fresh -> a calm one-liner", () => {
  expect(composeDigest([c({ state: "answered" })])).toBe("Kleinanzeigen: nothing new.");
});
