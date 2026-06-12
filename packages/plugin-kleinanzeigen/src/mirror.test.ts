import { test, expect } from "bun:test";
import { serializeConversation, parseConversation, latestBuyerMessage, type Conversation } from "./mirror.ts";

const conv: Conversation = {
  conv: "david-thiess",
  listing: "3432924231",
  counterpart: "David Thiess",
  state: "open",
  synthetic: false,
  messages: [
    { from: "buyer", at: "2026-06-12T03:46:00Z", body: "Hi Alex, ist das noch verfügbar??" },
    { from: "seller", at: "2026-06-12T03:47:00Z", body: "Hi, yes!" },
    { from: "buyer", at: "2026-06-12T03:50:00Z", body: "Empfänger: Cara Burrichter\nHaspelstrasse 24" },
  ],
  rating: "scam",
  tells: ["paypal", "name-mismatch"],
  needs_fact: [],
  draft: null,
  offer_amount: null,
  below_floor: false,
};

test("a conversation round-trips through serialize -> parse unchanged", () => {
  const text = serializeConversation(conv);
  const back = parseConversation(text);
  expect(back.conv).toBe(conv.conv);
  expect(back.listing).toBe(conv.listing);
  expect(back.counterpart).toBe(conv.counterpart);
  expect(back.rating).toBe("scam");
  expect(back.tells).toEqual(["paypal", "name-mismatch"]);
  expect(back.messages).toHaveLength(3);
  // the multi-line hostile body survives intact inside its fence
  expect(back.messages[2].body).toBe("Empfänger: Cara Burrichter\nHaspelstrasse 24");
});

test("every message body is written inside a ```text fence (the injection seam)", () => {
  const text = serializeConversation(conv);
  // three messages -> three opening fences
  expect(text.split("```text").length - 1).toBe(3);
});

test("latestBuyerMessage skips seller replies and returns the last buyer line", () => {
  const m = latestBuyerMessage(conv);
  expect(m?.from).toBe("buyer");
  expect(m?.body).toContain("Cara Burrichter");
});
