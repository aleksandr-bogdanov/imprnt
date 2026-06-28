import { test, expect, describe, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchConversations } from "./client.ts";
import { loadFacts } from "./facts.ts";
import { classify, belowFloor } from "./rate.ts";
import { writeConversation, listConversations, turnAwaiting, type Conversation } from "./mirror.ts";
import { composeDigest } from "./notify.ts";
import { guardSend } from "./send.ts";

// End-to-end over the REAL fixtures (the 2026-06-12 inbox) and the REAL shipped fact sheets. We drive
// the actual client -> facts -> rate -> mirror -> notify modules, exactly what the CLI wires together,
// in the new me/them + two-sided shape (the fixtures are all selling-side buyer inquiries).
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(pkgRoot, "fixtures");
const LISTINGS = join(pkgRoot, "listings");

let rated: Conversation[];

beforeAll(async () => {
  process.env.KLEINANZEIGEN_FIXTURES = FIXTURES;
  const mirror = mkdtempSync(join(tmpdir(), "ka-mirror-"));
  const raws = await fetchConversations(pkgRoot); // fixtures env wins
  for (const r of raws) {
    const facts = loadFacts(r.listing, LISTINGS);
    const them = [...r.messages].reverse().find((m) => m.from === "them")!;
    const cl = classify(them.body, r.counterpart, facts, r.side);
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

  test("exactly David Thiess is the scam, with >=3 named tells", () => {
    const scams = rated.filter((c) => c.rating === "scam");
    expect(scams).toHaveLength(1);
    expect(scams[0].conv).toBe("david-thiess");
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
    const frank = rated.find((c) => c.conv === "frank-puerschel")!;
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
    expect(lines[3]).toContain("david-thiess"); // scam sorts to the top
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
});
