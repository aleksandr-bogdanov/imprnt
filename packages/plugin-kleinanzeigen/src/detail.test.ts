import { test, expect, describe } from "bun:test";
import { parseAdDetail } from "./detail.ts";

// A trimmed, structurally-faithful slice of a real Kleinanzeigen ad page — enough to exercise the
// brittle selectors: the attribute list (label + value spans), the seller box, the calendar "posted"
// span, the "TOP Zufriedenheit" badge, and the JSON-LD fallback for title/price.
const html = `
<html><head>
<meta property="og:title" content="Gaming PC Ryzen 9800X3D"/>
<meta property="og:image" content="https://img.example/1.jpg"/>
<script type="application/ld+json">{"@type":"Product","name":"Gaming PC Ryzen 9800X3D","description":"top zustand","offers":{"price":"2200","priceCurrency":"EUR"}}</script>
</head><body>
<h1 id="viewad-title">Gaming PC Ryzen 9800X3D RTX 5070TI</h1>
<h2 id="viewad-price">2.200 € VB</h2>
<span id="viewad-locality">13595 Berlin - Spandau</span>
<div id="viewad-extra-info"><i class="icon icon-calendar"></i><span>27.06.2026</span></div>
<ul class="addetailslist">
  <li class="addetailslist--detail">
    Zustand
    <span class="addetailslist--detail--value">Sehr Gut</span>
  </li>
  <li class="addetailslist--detail">Marke<span class="addetailslist--detail--value">Eigenbau</span></li>
</ul>
<div class="userprofile-vip">
  Street
</div>
<a href="/s-bestandsliste.html?userId=26184696">Mehr Anzeigen</a>
<div class="userbadge"><span>TOP Zufriedenheit</span></div>
<span class="text-light">Privater Nutzer</span>
</body></html>`;

describe("parseAdDetail — robust against the real page's structure", () => {
  const p = parseAdDetail(html);

  test("the attribute list parses each label/value pair, not spanning into the next detail", () => {
    expect(p.attributes).toEqual({ Zustand: "Sehr Gut", Marke: "Eigenbau" });
  });

  test("seller_name falls back to the bare text node when there's no inner <a>", () => {
    expect(p.seller_name).toBe("Street");
  });

  test("seller_id reads off the s-bestandsliste userId, seller_type off the Privater/Gewerblicher text", () => {
    expect(p.seller_id).toBe("26184696");
    expect(p.seller_type).toBe("privat");
  });

  test("posted reads the viewad calendar span; zufriedenheit reads the TOP-badge text node", () => {
    expect(p.posted).toBe("27.06.2026");
    expect(p.zufriedenheit).toBe("TOP Zufriedenheit");
  });

  test("title/price/location come off the viewad ids", () => {
    expect(p.title).toBe("Gaming PC Ryzen 9800X3D RTX 5070TI");
    expect(p.price).toBe("2.200 € VB");
    expect(p.location).toBe("13595 Berlin - Spandau");
  });

  test("title/price fall back to JSON-LD when the viewad ids are absent", () => {
    const bare = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Bare Product","offers":{"price":"99"}}</script></head><body></body></html>`;
    const b = parseAdDetail(bare);
    expect(b.title).toBe("Bare Product");
    expect(b.price).toBe("99 €");
  });
});
