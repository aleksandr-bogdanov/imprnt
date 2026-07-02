import { test, expect, describe, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchConversations } from "./client.ts";
import { loadFacts } from "./facts.ts";
import { classify, belowFloor } from "./rate.ts";
import {
  writeConversation, listConversations, latestCounterpartMessage, priorCounterpartBodies,
  turnAwaiting, type Conversation,
} from "./mirror.ts";
import { composeDigest } from "./notify.ts";
import { guardSend } from "./send.ts";

// End-to-end over the shipped fixtures (a synthetic replay of a real 2026-06-12 afternoon) and
// per-test fact sheets (real ones carry live listing ids + price floors and never ship). We drive
// the actual client -> facts -> rate -> mirror -> notify modules, exactly what the CLI wires together,
// in the new me/them + two-sided shape (the fixtures are all selling-side buyer inquiries).
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(pkgRoot, "fixtures");

// The two fixture listings' fact sheets, shaped like the real ones: the 6660's artikelnummer/age/cable
// deliberately EMPTY (drives needs_fact), the 7590 fully confirmed.
const SHEET_6660 = `listing: 9000000001
model: FRITZ!Box 6660 Cable
variant: DOCSIS 3.1, WiFi 6, Retail-Version
artikelnummer:
includes:
  - Netzteil
condition: einwandfrei, voll funktionsfähig
age:
software: FRITZ!OS (aktuelle Version)
cable:
price: 90
floor: 75
pickup_area: Berlin
shipping: Versand möglich gegen Aufpreis
`;
const SHEET_7590 = `listing: 9000000002
model: FRITZ!Box 7590
variant: DSL, ohne AX (kein WiFi 6)
artikelnummer:
includes:
  - Netzteil
  - DSL-Kabel
  - LAN-Kabel
condition: neu, unbenutzt, originalverpackt
age: neu, nie in Betrieb
software: FRITZ!OS (Werkszustand)
cable: DSL- und LAN-Kabel sind dabei
price: 100
floor: 85
pickup_area: Berlin
shipping: Versand möglich gegen Aufpreis
`;

let rated: Conversation[];

beforeAll(async () => {
  process.env.KLEINANZEIGEN_FIXTURES = FIXTURES;
  const mirror = mkdtempSync(join(tmpdir(), "ka-mirror-"));
  const LISTINGS = mkdtempSync(join(tmpdir(), "ka-listings-"));
  writeFileSync(join(LISTINGS, "9000000001.yaml"), SHEET_6660);
  writeFileSync(join(LISTINGS, "9000000002.yaml"), SHEET_7590);
  const raws = await fetchConversations(pkgRoot); // fixtures env wins
  for (const r of raws) {
    const facts = loadFacts(r.listing, LISTINGS);
    const themAll = r.messages.filter((m) => m.from === "them");
    const them = themAll[themAll.length - 1]!;
    const cl = classify(them.body, r.counterpart, facts, r.side, themAll.slice(0, -1).map((m) => m.body));
    const conv: Conversation = {
      conv: r.conv, side: r.side, listing: r.listing, ad_title: r.ad_title, ad_status: r.ad_status,
      counterpart: r.counterpart, state: "open", unread: r.unread, synthetic: r.synthetic ?? false,
      messages: r.messages, rating: cl.rating, tells: cl.tells, needs_fact: cl.needs_fact, draft: cl.draft,
      offer_amount: cl.offer_amount, below_floor: belowFloor(cl.offer_amount, facts),
      last_message_at: them.at,
    };
    conv.awaiting = turnAwaiting(conv);
    writeConversation(mirror, conv);
  }
  rated = listConversations(mirror);
});

describe("the real inbox, classified", () => {
  test("all 15 conversations mirrored", () => {
    expect(rated).toHaveLength(15);
  });

  test("every fixture conversation reads as selling-side and awaiting you", () => {
    expect(rated.every((c) => c.side === "selling")).toBe(true);
    expect(rated.every((c) => c.awaiting === "me")).toBe(true);
  });

  test("the bucket distribution matches the hand-traced expectation", () => {
    const tally: Record<string, number> = {};
    for (const c of rated) tally[c.rating!] = (tally[c.rating!] ?? 0) + 1;
    expect(tally).toEqual({ scam: 1, offer: 1, faq: 6, pickup: 5, interest: 2 });
    // odd is absent -> nothing fell through to the model. Good.
    expect(tally.odd ?? 0).toBe(0);
  });

  test("exactly Timo Falkner is the scam, with >=3 named tells", () => {
    const scams = rated.filter((c) => c.rating === "scam");
    expect(scams).toHaveLength(1);
    expect(scams[0].conv).toBe("timo-falkner");
    expect(scams[0].tells!.length).toBeGreaterThanOrEqual(3);
  });

  test("all five Artikelnummer askers rate faq AND need the (empty) artikelnummer confirmed", () => {
    const artikel = ["erik", "jemand", "nima", "wisp", "nina"];
    for (const id of artikel) {
      const c = rated.find((x) => x.conv === id)!;
      expect(c.rating).toBe("faq");
      expect(c.needs_fact).toContain("artikelnummer");
      expect(c.draft).toBeNull(); // empty field, never guessed
    }
  });

  test("Frank's 70€ offer is below the 75€ floor", () => {
    const frank = rated.find((c) => c.conv === "frank-bergmann")!;
    expect(frank.rating).toBe("offer");
    expect(frank.offer_amount).toBe(70);
    expect(frank.below_floor).toBe(true);
  });

  test("pickup conversations get a ready draft naming Berlin", () => {
    const patrick = rated.find((c) => c.conv === "patrick")!;
    expect(patrick.rating).toBe("pickup");
    expect(patrick.draft).toContain("Berlin");
  });
});

describe("the digest (the phone-sized money demo)", () => {
  test("renders all 15 awaiting-you lines, scam first, grouped under Selling", () => {
    const d = composeDigest(rated);
    expect(d).toContain("15 awaiting you (15 selling, 0 buying)");
    expect(d).toContain("Selling:");
    const lines = d.split("\n");
    // header + blank + "Selling:" + 15 conversation lines
    expect(lines).toHaveLength(18);
    expect(lines[3]).toContain("timo-falkner"); // scam sorts to the top
    expect(lines[3]).toContain("scam");
  });
});

describe("the send guard (human-only, scam-refusing)", () => {
  test("refuses to send to the scam without --force", () => {
    const scam = rated.find((c) => c.rating === "scam")!;
    expect(guardSend(scam, false).allowed).toBe(false);
    expect(guardSend(scam, true).allowed).toBe(true); // explicit override allowed
  });

  test("allows a normal pickup reply", () => {
    const patrick = rated.find((c) => c.conv === "patrick")!;
    expect(guardSend(patrick, false).allowed).toBe(true);
  });

  test("a benign follow-up from the scammer does NOT clear the verdict (tells run over the history)", () => {
    // The exact cmdSend path: re-classify the LATEST counterpart message with the prior bodies, then
    // guard. "Na, noch da?" alone matches INTEREST — the earlier pitch must keep the thread scam.
    const scam = rated.find((c) => c.rating === "scam")!;
    const followUp: Conversation = {
      ...scam,
      messages: [...scam.messages, { from: "them", at: "2026-06-13T09:00:00Z", body: "Na, noch da?" }],
    };
    const them = latestCounterpartMessage(followUp)!;
    const r = classify(them.body, followUp.counterpart, null, followUp.side, priorCounterpartBodies(followUp));
    expect(r.rating).toBe("scam");
    expect(guardSend({ ...followUp, rating: r.rating, tells: r.tells }, false).allowed).toBe(false);
  });
});
