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
    c({ conv: "david-thiess", counterpart: "David Thiess", rating: "scam", tells: ["paypal", "name-mismatch"] }),
    c({ conv: "frank", counterpart: "Frank", rating: "offer", offer_amount: 70, below_floor: true }),
    c({ conv: "erik", counterpart: "Erik", rating: "faq", needs_fact: ["artikelnummer"], draft: null }),
    c({ conv: "patrick", counterpart: "Patrick", rating: "pickup", draft: "Hi, Abholung ist möglich in Berlin. ..." }),
  ];
  const d = composeDigest(convs);

  expect(d).toContain("3432924231: 4 new");
  // scam first, with named tells and no draft
  const lines = d.split("\n");
  expect(lines[1]).toContain("David Thiess");
  expect(lines[1]).toContain("scam: paypal, name-mismatch");
  expect(d).toContain("Frank [offer 70€ (below floor)]");
  expect(d).toContain("Erik [faq] — needs you: confirm artikelnummer");
  expect(d).toContain('Patrick [pickup] draft: "Hi, Abholung');
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
