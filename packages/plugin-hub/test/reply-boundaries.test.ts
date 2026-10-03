import { expect, test } from "bun:test";
import { prepareReply } from "../src/door/reply.ts";

test("long replies retain lines and URLs, and concatenate to exactly the original", () => {
  const url = "<https://example.sentry.io/issues/123456789/>";
  for (const [platform, limit] of [["discord", 2000], ["telegram", 4000]] as const) {
    for (const separator of ["\n", " ", "\t"]) {
      const text = "x".repeat(limit - 10) + separator + url + "\nnext issue";
      const parts = prepareReply(text, platform, "en");
      expect(parts.join("")).toBe(text);
      expect(parts.every(part => part.length <= limit)).toBe(true);
      expect(parts.some(part => part.includes(url))).toBe(true);
    }
  }
});

test("unbreakable text falls back to bounded Unicode-safe chunks", () => {
  const text = "x".repeat(1999) + "😀" + "x".repeat(2100);
  const parts = prepareReply(text, "discord", "en");
  expect(parts.join("")).toBe(text);
  expect(parts.every(part => part.length <= 2000 && !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
});
