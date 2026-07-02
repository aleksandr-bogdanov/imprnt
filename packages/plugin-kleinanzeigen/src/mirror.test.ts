import { test, expect } from "bun:test";
import {
  serializeConversation, parseConversation, fenceFor,
  latestCounterpartMessage, priorCounterpartBodies, lastMessage, turnAwaiting, type Conversation,
} from "./mirror.ts";

const conv: Conversation = {
  conv: "timo-falkner",
  side: "selling",
  listing: "9000000001",
  ad_title: "FRITZ!Box 6660 Cable",
  ad_status: "active",
  counterpart: "Timo Falkner",
  state: "open",
  awaiting: "me",
  unread: 1,
  synthetic: true,
  messages: [
    { from: "them", at: "2026-06-12T03:46:00Z", body: "Hi Alex, ist das noch verfügbar??" },
    { from: "me", at: "2026-06-12T03:47:00Z", body: "Hi, yes!" },
    { from: "them", at: "2026-06-12T03:50:00Z", body: "Empfänger: Mara Weidmann\nMusterstrasse 12" },
  ],
  rating: "scam",
  tells: ["paypal", "name-mismatch"],
  needs_fact: [],
  draft: null,
  offer_amount: null,
  below_floor: false,
};

test("a conversation round-trips through serialize -> parse unchanged (me/them + the new fields)", () => {
  const text = serializeConversation(conv);
  const back = parseConversation(text);
  expect(back.conv).toBe(conv.conv);
  expect(back.side).toBe("selling");
  expect(back.listing).toBe(conv.listing);
  expect(back.ad_title).toBe("FRITZ!Box 6660 Cable");
  expect(back.ad_status).toBe("active");
  expect(back.counterpart).toBe(conv.counterpart);
  expect(back.awaiting).toBe("me");
  expect(back.unread).toBe(1);
  expect(back.rating).toBe("scam");
  expect(back.tells).toEqual(["paypal", "name-mismatch"]);
  expect(back.messages).toHaveLength(3);
  expect(back.messages[0].from).toBe("them");
  expect(back.messages[1].from).toBe("me");
  // the multi-line hostile body survives intact inside its fence
  expect(back.messages[2].body).toBe("Empfänger: Mara Weidmann\nMusterstrasse 12");
});

test("the H1 title uses ad_title when present, else `listing N`", () => {
  expect(serializeConversation(conv)).toContain("# Timo Falkner — FRITZ!Box 6660 Cable");
  const noTitle = serializeConversation({ ...conv, ad_title: "" });
  expect(noTitle).toContain("# Timo Falkner — listing 9000000001");
});

test("the LEGACY `### buyer|seller` headers still parse, mapping seller->me and buyer->them", () => {
  const legacy = [
    "---", "conv: old", "listing: 123", "counterpart: Old Buyer", "state: open", "synthetic: false", "---", "",
    "# Old Buyer — listing 123", "", "## Messages", "",
    "### buyer · t1", "```text", "ist das noch da?", "```", "",
    "### seller · t2", "```text", "ja!", "```", "",
  ].join("\n");
  const c = parseConversation(legacy);
  expect(c.messages.map((m) => m.from)).toEqual(["them", "me"]);
  // a missing side: field defaults to selling
  expect(c.side).toBe("selling");
});

test("the adaptive fence makes a body containing a ``` line round-trip losslessly", () => {
  const tricky: Conversation = {
    ...conv,
    messages: [{ from: "them", at: "t", body: "run this:\n```\nrm -rf /\n```\nplease" }],
  };
  const text = serializeConversation(tricky);
  // a 3-backtick run in the body forces a 4-backtick fence
  expect(fenceFor(tricky.messages[0].body)).toBe("````");
  expect(text).toContain("````text");
  const back = parseConversation(text);
  expect(back.messages[0].body).toBe("run this:\n```\nrm -rf /\n```\nplease");
});

test("old 3-backtick mirror files still parse (the fence detector reads the opening run)", () => {
  const text = serializeConversation({ ...conv, messages: [{ from: "them", at: "t", body: "plain text" }] });
  expect(text).toContain("```text");
  expect(parseConversation(text).messages[0].body).toBe("plain text");
});

test("latestCounterpartMessage skips your replies; lastMessage returns the very last", () => {
  expect(latestCounterpartMessage(conv)?.from).toBe("them");
  expect(latestCounterpartMessage(conv)?.body).toContain("Mara Weidmann");
  expect(lastMessage(conv)?.body).toContain("Mara Weidmann");
});

test("priorCounterpartBodies returns every counterpart body before the latest (yours excluded)", () => {
  expect(priorCounterpartBodies(conv)).toEqual(["Hi Alex, ist das noch verfügbar??"]);
  expect(priorCounterpartBodies({ ...conv, messages: [] })).toEqual([]);
});

test("turnAwaiting: last from them -> me; last from me -> them; closed/system-dead -> none", () => {
  expect(turnAwaiting(conv)).toBe("me"); // last is them
  expect(turnAwaiting({ ...conv, messages: [{ from: "me", at: "t", body: "ping" }] })).toBe("them");
  expect(turnAwaiting({ ...conv, state: "closed" })).toBe("none");
  expect(turnAwaiting({ ...conv, messages: [] })).toBe("none");
  // a platform "Anfrage zurückgezogen" line is nobody's turn
  expect(turnAwaiting({ ...conv, messages: [{ from: "them", at: "t", body: "Anfrage zurückgezogen." }] })).toBe("none");
});
