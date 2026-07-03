import { test, expect } from "bun:test";
import { composeDigest } from "./notify.ts";
import type { Conversation } from "./mirror.ts";

function c(over: Partial<Conversation>): Conversation {
  return {
    conv: "x", side: "selling", listing: "9000000001", ad_title: "", ad_status: "",
    counterpart: "X", state: "open", awaiting: "me", unread: 0, synthetic: true, messages: [], ...over,
  };
}

test("selling digest: only awaiting-you, scams first, drafts and needs-you lines, grouped under Selling", () => {
  const convs: Conversation[] = [
    c({ conv: "2932z:1:scam", counterpart: "Timo Falkner", rating: "scam", tells: ["paypal", "name-mismatch"] }),
    c({ conv: "2932z:2:offer", counterpart: "Frank", rating: "offer", offer_amount: 70, below_floor: true }),
    c({ conv: "2932z:3:faq", counterpart: "Erik", rating: "faq", needs_fact: ["artikelnummer"], draft: null }),
    c({ conv: "2932z:4:pick", counterpart: "Patrick", rating: "pickup", draft: "Hi, Abholung ist möglich in Musterstadt. ..." }),
  ];
  const d = composeDigest(convs);

  expect(d).toContain("4 awaiting you (4 selling, 0 buying)");
  expect(d).toContain("Selling:");
  const lines = d.split("\n");
  // header, blank, "Selling:", then the four conversation lines (scam first)
  expect(lines[3]).toContain("2932z:1:scam");
  expect(lines[3]).toContain("(Timo Falkner)");
  expect(lines[3]).toContain("scam: paypal, name-mismatch");
  expect(d).toContain("2932z:2:offer (Frank) [offer 70€ (below floor)]");
  expect(d).toContain("2932z:3:faq (Erik) [faq] — needs you: confirm artikelnummer");
  expect(d).toContain('2932z:4:pick (Patrick) [pickup] draft: "Hi, Abholung');
});

test("buying digest: a seller reply surfaces as your-turn with an 80-char snippet, ·unread when unread>0", () => {
  const buy = c({
    conv: "b1", side: "buying", counterpart: "Seller Sam", ad_title: "RTX 5070 Ti", unread: 2, rating: "reply",
    messages: [
      { from: "me", at: "t1", body: "still available?" },
      { from: "them", at: "t2", body: "yes, 200€, come by Saturday" },
    ],
  });
  const d = composeDigest([buy]);
  expect(d).toContain("1 awaiting you (0 selling, 1 buying)");
  expect(d).toContain("Buying:");
  expect(d).toContain("b1 (Seller Sam) RTX 5070 Ti [buying] seller replied — your turn:");
  expect(d).toContain('"yes, 200€, come by Saturday"');
  expect(d).toContain("·unread");
});

test("buying scam: the seller-phishing-the-buyer line gets the scam variant", () => {
  const scamBuy = c({
    conv: "b2", side: "buying", counterpart: "Phisher", ad_title: "GPU", rating: "scam", tells: ["payment-link"],
    messages: [{ from: "them", at: "t", body: "zahl bitte über diesen link bit.ly/x" }],
  });
  expect(composeDigest([scamBuy])).toContain("⚠ b2 (Phisher) GPU [scam: payment-link] — do not reply");
});

test("only awaiting==me survives: awaiting-them, closed, and awaiting-none all drop out", () => {
  const convs = [
    c({ counterpart: "WaitGuy", awaiting: "them", rating: "pickup", draft: "x" }),
    c({ counterpart: "ClosedGuy", state: "closed", awaiting: "me", rating: "pickup", draft: "x" }),
    c({ counterpart: "NoneGuy", awaiting: "none", rating: "pickup", draft: "x" }),
    c({ counterpart: "LiveGuy", awaiting: "me", rating: "pickup", draft: "x" }),
  ];
  const d = composeDigest(convs);
  expect(d).not.toContain("WaitGuy");
  expect(d).not.toContain("ClosedGuy");
  expect(d).not.toContain("NoneGuy");
  expect(d).toContain("LiveGuy");
  expect(d).toContain("1 awaiting you (1 selling, 0 buying)");
});

test("nothing awaiting you -> a calm one-liner", () => {
  expect(composeDigest([c({ awaiting: "them" })])).toBe("Kleinanzeigen: nothing awaiting your reply.");
});
