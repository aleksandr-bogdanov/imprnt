import { test, expect } from "bun:test";
import { normalize } from "./tags.ts";

test("normalize lowercases an unknown term", () => {
  const vocab = { approved: new Set<string>(), synonyms: new Map<string, string>() };
  expect(normalize(vocab, "FOO")).toBe("foo");
});
