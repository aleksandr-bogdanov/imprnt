// imprnt · kleinanzeigen plugin — the rater. PURE regex + arithmetic, ZERO LLM, by design.
//
// Buyer messages are attacker-controlled text (the scam fixture replays a real PayPal + drop-address
// pitch, re-cast with invented names — real inbox data never ships). A model
// reading that text and able to act is a prompt-injection target; a regex cannot be social-engineered.
// So classification is code. The model only ever drafts the `odd` residue, later, in a session a human
// is watching — never here, never in the scheduled loop.
//
// Buckets, in priority order (first hit wins): scam > offer > faq > pickup > interest > odd.
//
// Two-sided: the offer/faq/pickup/interest/odd ladder is the SELL-side triage (you're answering a
// buyer). On the BUY side (you contacted a seller, the seller replied) there are no template drafts to
// generate — you're the human in that thread — so a non-scam buy-side message rates `reply`: surface it,
// let the human answer. The scam tells run on BOTH sides (a seller can phish a buyer too).
import type { Facts } from "./facts.ts";

export type Bucket = "scam" | "offer" | "faq" | "pickup" | "interest" | "reply" | "odd";

export type Rating = {
  rating: Bucket;
  tells: string[]; // named scam signals, like guard.js — empty unless rating==="scam"
  needs_fact: string[]; // fields a FAQ asked for that the fact sheet doesn't carry (never guessed)
  draft: string | null; // a template reply, or null when a human must write it (scam/offer/odd/needs_fact)
  offer_amount: number | null; // euros, when an offer was detected
};

const lc = (s: string) => s.toLowerCase();

// ── scam blocklist ────────────────────────────────────────────────────────────────────────────────
// Each detector names its tell. send.js refuses a scam-rated conversation without --force. The rule of
// thumb mirrors the vault's kleinanzeigen-cpu-scam lesson: anyone steering off "Sicher bezahlen" is the
// signal. We err toward flagging — a false scam costs one human glance, a missed scam costs the router.

const PAYPAL = /\bpaypal\b/i;
const FRIENDS_FAMILY = /\b(friends?\s*(&|and|\/)?\s*family|f\s*&\s*f|freunde\s*(und|&)\s*familie)\b/i;
const PAYMENT_LINK = /(zahlungslink|payment link|bezahllink|kleinanzeigen[.-]?(sicher|pay)|tinyurl|bit\.ly|t\.ly|\bhttps?:\/\/(?!www\.kleinanzeigen\.de))/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE = /(\+\d{2,3}[\s/-]?\d{3,}|\b0\d{2,4}[\s/-]?\d{4,}|whatsapp)/i;
const ABROAD = /(im ausland|bin gerade (im|in)|auf (geschäftsreise|dienstreise|montage)|abroad|currently (abroad|overseas))/i;
const COURIER = /(kurier|spediteur|spedition|versanddienst|abholdienst|transportunternehmen|shipping (agent|company)|courier)/i;

// "I'll just pay the full price + shipping" with no question and no haggling = the classic over-eager
// buyer. We treat full-price-plus-shipping language as a tell; on its own it's weak, but it stacks.
const INSTANT_FULL_PRICE = /(zahle?\s+(den\s+)?(vollen\s+)?preis|pay\s+(the\s+)?(full\s+)?price|preis\s+zusammen\s+mit\s+(dem\s+)?versand|full\s+(asking\s+)?price)/i;

// A delivery recipient named in the message ("Empfänger: X", "Lieferung an: X", "deliver to X").
// When that surname differs from the conversation counterpart, that's triangulation-fraud shaped:
// the payer and the parcel target are different people.
function deliveryRecipient(body: string): string | null {
  // Two steps: find the recipient TRIGGER case-insensitively (the German labels are capitalized), then
  // from just after it capture a real (capitalized) name. One mixed-flag regex can't require capitals
  // for the name while ignoring case for the trigger, so we split it.
  const trigger = body.match(/(?:empf[aä]nger|lieferung\s+(?:bitte\s+)?an|liefern\s+an|deliver(?:y)?\s+(?:to|address)|recipient)\s*:?\s*\n?\s*/iu);
  if (!trigger || trigger.index === undefined) return null;
  let rest = body.slice(trigger.index + trigger[0].length);
  // The real scam stacks labels: "Lieferung an:\nEmpfänger: <name>". The outer trigger lands on the
  // inner "Empfänger:" label, so skip a stacked secondary label to reach the actual name.
  rest = rest.replace(/^(?:empf[aä]nger|recipient)\s*:?\s*\n?\s*/iu, "");
  // Require first + last (>=2 capitalized words) so a lone label or a street name isn't read as a person.
  const name = rest.match(/^([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){1,3})/u);
  return name ? name[1].trim() : null;
}

function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length ? lc(parts[parts.length - 1]) : "";
}

export function scamTells(body: string, counterpart: string): string[] {
  const tells: string[] = [];
  if (PAYPAL.test(body)) tells.push("paypal");
  if (FRIENDS_FAMILY.test(body)) tells.push("friends-family");
  if (PAYMENT_LINK.test(body)) tells.push("payment-link");
  if (EMAIL.test(body) || PHONE.test(body)) tells.push("external-contact");
  if (ABROAD.test(body)) tells.push("abroad-story");
  if (COURIER.test(body)) tells.push("courier-story");

  const recipient = deliveryRecipient(body);
  if (recipient && counterpart && surname(recipient) && surname(recipient) !== surname(counterpart)) {
    tells.push("name-mismatch");
  }
  // Full-price-plus-shipping only counts as a tell when paired with a payment push — otherwise an
  // honest "I'll pay your asking price" is just a good buyer, not a scammer.
  if (INSTANT_FULL_PRICE.test(body) && (PAYPAL.test(body) || PAYMENT_LINK.test(body) || recipient)) {
    tells.push("instant-full-price");
  }
  return tells;
}

// ── offer detection ───────────────────────────────────────────────────────────────────────────────
// An amount the buyer proposes. We read "70€", "70 EUR", "für 70", "biete 70". We do NOT read the
// listing's own price back as an offer, so a bare number must sit next to euro/biete/zahle/geben.
function detectOffer(body: string): number | null {
  const m = body.match(/(?:biete|zahle|geben?|nehme|f[uü]r|w[uü]rde\s+(?:dir\s+)?)\s*(\d{2,4})\s*(?:€|eur|euro)?\b/i)
    || body.match(/(\d{2,4})\s*(?:€|eur|euro)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ── faq detection ─────────────────────────────────────────────────────────────────────────────────
// Map each question pattern to the fact-sheet field that answers it. A hit means "this is answerable
// from data" — IF the field is populated. If it's empty, the field name goes to needs_fact.
const FAQ_FIELDS: { re: RegExp; field: keyof Facts; label: string }[] = [
  { re: /(artikel ?nummer|art\.?-?nr|artnr|welche version|2000\s?2910|20002910)/i, field: "artikelnummer", label: "artikelnummer" },
  { re: /(koax|koaxial|kabel\s+dabei|mit\s+kabel|cable\s+included)/i, field: "cable", label: "cable" },
  { re: /(wie alt|alter|baujahr|how old|wie lange (genutzt|in betrieb))/i, field: "age", label: "age" },
  { re: /(software|firmware|fritz ?os|welche version installiert|os version)/i, field: "software", label: "software" },
  { re: /(zustand|condition|kratzer|gebraucht oder neu|wie ist der zustand)/i, field: "condition", label: "condition" },
  { re: /(ovp|originalverpackung|karton dabei|mit verpackung|box included)/i, field: "includes", label: "includes" },
];

function factValue(facts: Facts, field: keyof Facts): string {
  const v = facts[field];
  if (Array.isArray(v)) return v.join(", ");
  if (v === null) return "";
  return String(v);
}

// ── pickup / interest ─────────────────────────────────────────────────────────────────────────────
const PICKUP = /(abhol|vorbei ?kommen|vorbei ?schauen|holen kommen|heute noch holen|pick ?up|abzuholen|gleich (holen|abholen|kommen)|wann kann ich)/i;
// Broad on purpose: interest is the low-priority catch-all reached only after scam/offer/faq/pickup
// already missed, so a bare buy-intent word ("kaufen", "nehmen") is a safe signal here, not a risk.
const INTEREST = /(noch (da|verf[uü]gbar|zu haben)|verf[uü]gbar|interesse|interessiert|kaufen|abkaufen|\bnehmen\b|still available)/i;

// ── template drafts ───────────────────────────────────────────────────────────────────────────────
// Built ONLY from fact-sheet fields. A draft never invents a fact; when a field is missing the rater
// suppresses the draft and sets needs_fact, so a human supplies the answer. Drafts carry the standing
// safety line (Sicher bezahlen / no PayPal F&F), which is also the scam filter working in our favour.
const SAFETY = "Zahlung über Sicher bezahlen oder bar bei Abholung, kein PayPal Friends & Family.";

function faqDraft(facts: Facts, answered: { label: string; value: string }[]): string {
  const parts = answered.map((a) => {
    switch (a.label) {
      case "artikelnummer": return `Die Artikelnummer ist ${a.value}.`;
      case "cable": return `Zum Kabel: ${a.value}.`;
      case "age": return `Zum Alter: ${a.value}.`;
      case "software": return `Installiert ist ${a.value}.`;
      case "condition": return `Zustand: ${a.value}.`;
      case "includes": return `Dabei ist: ${a.value}.`;
      default: return a.value;
    }
  });
  return `Hi, ${parts.join(" ")} ${SAFETY}`;
}

function pickupDraft(facts: Facts): string {
  const where = facts.pickup_area ? ` in ${facts.pickup_area}` : "";
  return `Hi, Abholung ist möglich${where}. Wann würde es dir passen? ${SAFETY}`;
}

function interestDraft(facts: Facts): string {
  const what = facts.model || facts.variant || "das Gerät";
  return `Hi, ja, ${what} ist noch verfügbar. ${SAFETY}`;
}

// ── the classifier ────────────────────────────────────────────────────────────────────────────────
// `priorBodies` is the counterpart's earlier messages (oldest first). Buckets and drafts answer only
// the LATEST message, but the scam tells run over the WHOLE history: a scammer's tell-free follow-up
// ("Na, noch da?") must never wash out yesterday's pitch — that would open the send guard exactly
// when the scammer nudges.
export function classify(body: string, counterpart: string, facts: Facts | null, side: "selling" | "buying" = "selling", priorBodies: string[] = []): Rating {
  // 1. scam — any blocklist hit anywhere in the counterpart's history wins outright. Runs on both sides.
  const tells = [...new Set([...priorBodies, body].flatMap((b) => scamTells(b, counterpart)))];
  if (tells.length) {
    return { rating: "scam", tells, needs_fact: [], draft: null, offer_amount: null };
  }

  // buy side: no template ladder — a non-scam seller reply just goes to the human as `reply`.
  if (side === "buying") {
    return { rating: "reply", tells: [], needs_fact: [], draft: null, offer_amount: null };
  }

  // 2. offer — an amount proposed. Never auto-accepted; the draft is a neutral holder, the human decides.
  const amount = detectOffer(body);
  if (amount !== null) {
    return { rating: "offer", tells: [], needs_fact: [], draft: null, offer_amount: amount };
  }

  // 3. faq — a question that maps to fact-sheet fields. Answerable fields fill a draft; missing ones
  //    become needs_fact and SUPPRESS the draft (a partial auto-answer is worse than a human reply).
  const asked = FAQ_FIELDS.filter((q) => q.re.test(body));
  if (asked.length) {
    const answered: { label: string; value: string }[] = [];
    const missing: string[] = [];
    for (const q of asked) {
      const val = facts ? factValue(facts, q.field) : "";
      if (val) answered.push({ label: q.label, value: val });
      else missing.push(q.label);
    }
    const draft = missing.length === 0 && facts ? faqDraft(facts, answered) : null;
    return { rating: "faq", tells: [], needs_fact: missing, draft, offer_amount: null };
  }

  // 4. pickup — wants to collect, no price talk.
  if (PICKUP.test(body)) {
    return { rating: "pickup", tells: [], needs_fact: [], draft: facts ? pickupDraft(facts) : null, offer_amount: null };
  }

  // 5. interest — generic "still available / would buy".
  if (INTEREST.test(body)) {
    return { rating: "interest", tells: [], needs_fact: [], draft: facts ? interestDraft(facts) : null, offer_amount: null };
  }

  // 6. odd — nothing matched. The only bucket that may route to the model, in a watched session.
  return { rating: "odd", tells: [], needs_fact: [], draft: null, offer_amount: null };
}

// Whether an offer sits below the fact-sheet floor (advisory; never blocks, never auto-rejects).
export function belowFloor(amount: number | null, facts: Facts | null): boolean {
  return amount !== null && !!facts && facts.floor !== null && amount < facts.floor;
}
