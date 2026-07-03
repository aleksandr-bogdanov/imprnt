import { test, expect, describe } from "bun:test";
import { classify, scamTells, belowFloor } from "./rate.ts";
import { parseFacts, type Facts } from "./facts.ts";

// The BT-200 fact sheet, shaped like a real one: artikelnummer + cable + age deliberately EMPTY (unverified).
const factsBt200: Facts = parseFacts(`
listing: 9000000001
model: Acme BT-200 Bluetooth-Lautsprecher
variant: Bluetooth 5.3, 20W, tragbar
artikelnummer:
includes:
  - Netzteil
condition: einwandfrei, voll funktionsfähig
age:
software: Firmware (aktuelle Version)
cable:
price: 95
floor: 80
pickup_area: Musterstadt
shipping: Versand möglich gegen Aufpreis
`);

describe("scam detection (the whole point — hostile text, zero LLM)", () => {
  test("the classic PayPal + drop-address pitch: paypal + name-mismatch + instant-full-price, >=3 tells", () => {
    const body =
      "Könnten Sie mir Ihre PayPal-Daten schicken, ich zahle den Preis zusammen mit dem Versand.\n" +
      "Lieferung bitte an:\nEmpfänger: Mara Weidmann\nMusterstrasse 12\nPLZ 12345 Musterstadt";
    const r = classify(body, "Timo Falkner", factsBt200);
    expect(r.rating).toBe("scam");
    expect(r.tells).toContain("paypal");
    expect(r.tells).toContain("name-mismatch");
    expect(r.tells).toContain("instant-full-price");
    expect(r.tells.length).toBeGreaterThanOrEqual(3);
    expect(r.draft).toBeNull();
  });

  test("name-mismatch needs a payer/recipient surname difference, not just any name", () => {
    // Same surname as counterpart -> NOT a mismatch (a buyer shipping to themselves).
    const same = scamTells("Empfänger: Timo Falkner, Musterstr. 12", "Timo Falkner");
    expect(same).not.toContain("name-mismatch");
    const diff = scamTells("Empfänger: Mara Weidmann, Musterstr. 12", "Timo Falkner");
    expect(diff).toContain("name-mismatch");
  });

  test("a tell-free follow-up can NOT wash out an earlier pitch (tells run over the whole history)", () => {
    const pitch = "Könnten Sie mir Ihre PayPal-Daten schicken, ich zahle den Preis zusammen mit dem Versand.";
    // Alone, the follow-up is harmless interest…
    expect(classify("Na, noch da?", "Timo Falkner", factsBt200).rating).toBe("interest");
    // …but with the pitch in the history, the thread stays scam.
    const r = classify("Na, noch da?", "Timo Falkner", factsBt200, "selling", [pitch]);
    expect(r.rating).toBe("scam");
    expect(r.tells).toContain("paypal");
    expect(r.draft).toBeNull();
  });

  test("an honest 'I'll pay full price' WITHOUT a payment push is not a scam", () => {
    // instant-full-price only counts when paired with paypal/link/recipient — else it's a good buyer.
    const r = classify("Ich zahle gern den vollen Preis, passt für mich.", "Lena Hoffmann", factsBt200);
    expect(r.rating).not.toBe("scam");
  });

  test("a payment-link and an external-contact each trip a tell", () => {
    expect(scamTells("zahl über diesen link bit.ly/xyz", "Tom")).toContain("payment-link");
    expect(scamTells("schreib mir auf whatsapp 0176 1234567", "Tom")).toContain("external-contact");
  });
});

describe("the buckets, priority order scam > offer > faq > pickup > interest > odd", () => {
  test("offer: amount extracted, flagged below the floor", () => {
    const r = classify("ich würde dir 70€ geben", "Frank Bergmann", factsBt200);
    expect(r.rating).toBe("offer");
    expect(r.offer_amount).toBe(70);
    expect(belowFloor(r.offer_amount, factsBt200)).toBe(true);
    expect(r.draft).toBeNull(); // never auto-answer an offer
  });

  test("faq artikelnummer on the BT-200: rates faq, needs_fact artikelnummer, NO draft (empty field, never guessed)", () => {
    for (const body of [
      "Welche Version 20002910? Gruß Erik",
      "Hallo Welche Artikelnummer hat das Gerät ? Vg",
      "Hallo, hat es die Artikelnummer 20002910?",
      "Hallo. Ist es die 2000 2910?",
    ]) {
      const r = classify(body, "x", factsBt200);
      expect(r.rating).toBe("faq");
      expect(r.needs_fact).toContain("artikelnummer");
      expect(r.draft).toBeNull();
    }
  });

  test("faq artikelnummer + ladekabel (Nima): both empty -> needs_fact lists both", () => {
    const r = classify("wie lautet die Artikelnummer des Geräts? Ist das Ladekabel dabei?", "Nima", factsBt200);
    expect(r.rating).toBe("faq");
    expect(r.needs_fact).toContain("artikelnummer");
    expect(r.needs_fact).toContain("cable");
  });

  test("faq age+software (Pavel): software known, age empty -> needs_fact age only, draft suppressed", () => {
    const r = classify("wie alt ist das Gerät, beziehungsweise welche Software ist installiert?", "Pavel", factsBt200);
    expect(r.rating).toBe("faq");
    expect(r.needs_fact).toEqual(["age"]);
    expect(r.draft).toBeNull(); // any missing field suppresses the draft
  });

  test("faq with ALL fields known produces an actual template draft", () => {
    const full = parseFacts(`listing: x\nartikelnummer: 20002910\ncable: ja, Ladekabel liegt bei\nmodel: Acme BT-200 Bluetooth-Lautsprecher`);
    const r = classify("Artikelnummer? Ladekabel dabei?", "x", full);
    expect(r.rating).toBe("faq");
    expect(r.needs_fact).toEqual([]);
    expect(r.draft).toContain("20002910");
    expect(r.draft).toContain("Sicher bezahlen");
  });

  test("pickup gets a templated draft with the pickup area", () => {
    const r = classify("ist es möglich heute noch abzuholen?", "Patrick", factsBt200);
    expect(r.rating).toBe("pickup");
    expect(r.draft).toContain("Musterstadt");
  });

  test("interest gets an availability draft", () => {
    const r = classify("ich hätte Interesse, diesen Bluetooth-Lautsprecher zu kaufen. Kannst du mir mehr Details geben?", "Chitwan", factsBt200);
    expect(r.rating).toBe("interest");
    expect(r.draft).toContain("verfügbar");
  });

  test("a totally unrelated message rates odd (the only model-eligible bucket)", () => {
    const r = classify("Moin, schönes Wetter heute oder?", "x", factsBt200);
    expect(r.rating).toBe("odd");
    expect(r.draft).toBeNull();
  });

  test("with NO fact sheet, every FAQ field becomes needs_fact (never a guess)", () => {
    const r = classify("Artikelnummer?", "x", null);
    expect(r.rating).toBe("faq");
    expect(r.needs_fact).toContain("artikelnummer");
    expect(r.draft).toBeNull();
  });
});

describe("two-sided: the buy side skips the template ladder, the scam guard runs on both", () => {
  test("a benign seller reply on the buy side rates `reply`, no draft (you write buy-side replies)", () => {
    const r = classify("Ja, ist noch da. Kannst du Samstag abholen?", "Seller Sam", null, "buying");
    expect(r.rating).toBe("reply");
    expect(r.draft).toBeNull();
    expect(r.offer_amount).toBeNull();
  });

  test("a buy-side message that LOOKS like an offer is NOT bucketed as an offer — it's just `reply`", () => {
    // off-side, the "70€" would trip detectOffer on the sell side; on the buy side it must stay reply.
    const r = classify("ich gebe dir 70€ dafür", "Seller Sam", null, "buying");
    expect(r.rating).toBe("reply");
  });

  test("a scam still wins on the buy side (a seller can phish a buyer too)", () => {
    const r = classify("zahl bitte per PayPal Friends & Family", "Seller Sam", null, "buying");
    expect(r.rating).toBe("scam");
    expect(r.tells).toContain("paypal");
  });

  test("side defaults to selling, so the existing offer/faq ladder is unchanged", () => {
    expect(classify("ich würde dir 70€ geben", "Frank", factsBt200).rating).toBe("offer");
  });
});
