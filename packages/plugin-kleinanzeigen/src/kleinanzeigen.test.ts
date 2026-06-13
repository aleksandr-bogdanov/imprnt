import { test, expect, describe, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchConversations } from "./client.ts";
import { loadFacts } from "./facts.ts";
import { classify, belowFloor } from "./rate.ts";
import { writeConversation, listConversations, type Conversation } from "./mirror.ts";
import { composeDigest } from "./notify.ts";
import { guardSend } from "./send.ts";

// End-to-end over the REAL fixtures (the 2026-06-12 inbox) and the REAL shipped fact sheets. We drive
// the actual client -> facts -> rate -> mirror -> notify modules, exactly what the CLI wires together.
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
    const buyer = [...r.messages].reverse().find((m) => m.from === "buyer")!;
    const c = classify(buyer.body, r.counterpart, facts);
    writeConversation(mirror, {
      conv: r.conv, listing: r.listing, counterpart: r.counterpart,
      state: "open", synthetic: r.synthetic ?? false, messages: r.messages,
      rating: c.rating, tells: c.tells, needs_fact: c.needs_fact, draft: c.draft,
      offer_amount: c.offer_amount, below_floor: belowFloor(c.offer_amount, facts),
      last_message_at: buyer.at,
    });
  }
  rated = listConversations(mirror);
});

describe("the real inbox, classified", () => {
  test("all 15 conversations mirrored", () => {
    expect(rated).toHaveLength(15);
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
  test("renders all 15 into one message, scam first, both listings counted", () => {
    const d = composeDigest(rated);
    expect(d).toContain("3432924231: 14 new");
    expect(d).toContain("3432924164: 1 new"); // Kitty on the 7590
    const lines = d.split("\n");
    expect(lines[1]).toContain("scam"); // scam sorts to the top
    expect(lines).toHaveLength(16); // 1 header + 15 conversations
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
