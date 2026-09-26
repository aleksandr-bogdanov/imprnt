// The spec file of a hunt: one JSON file a person edits, validated on every
// read, refused with every problem named. (SPEC section 5)
//
// A hard constraint can never be prose, so the `hard` set is closed and typed
// and an unknown key refuses the file. A refused spec never runs and is
// reported, so a typo in a ceiling cannot turn a watch off in silence.

import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpecs, specProblems, targetProblems } from "../src/watch/spec.ts";

const owner = (id: string) => (["p1-lair", "p1-shop"].includes(id) ? null : `owner "${id}" is not an agent of p1 with a door and a chat`);

const good = () => ({
  id: "de__32gb-ddr5-6000", source: "kleinanzeigen", owner: "p1-lair", lane: "digest",
  target: { query: "32gb ddr5 6000", location: "" },
  hard: { max_price: 260, exclude: ["laptop"], wanted_ad: false, rental_ad: false },
  notify: { price_at_or_under: 260 },
  soft: ["a 2x16 kit only, not 1x32"],
  note: "why this watch exists", added: "2026-07-14T21:27:53.667Z",
});

test("the household's own shape loads with no problem, byte for byte", () => {
  expect(specProblems(good(), "kleinanzeigen", owner)).toEqual([]);
  expect(specProblems({ ...good(), updated: "2026-09-01T00:00:00Z", paused: false }, "kleinanzeigen", owner)).toEqual([]);
  // Every hard rule with its typed value, and both predicates.
  expect(specProblems({
    ...good(), hard: { max_price: 1, min_price: 0, radius_km: 20, exclude: ["a"], seller_kind: "private", min_temperature: 50, wanted_ad: true, rental_ad: false },
    notify: { price_at_or_under: null, price_record_low: true },
  }, "kleinanzeigen", owner)).toEqual([]);
});

test("each refusal names its key and what the value must be", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ ...good(), id: "Bad Id" }, 'id "Bad Id" is not'],
    [{ ...good(), source: "mydealz" }, 'source "mydealz" filed under kleinanzeigen/'],
    [{ ...good(), owner: "" }, 'owner "" is not an agent id'],
    [{ ...good(), owner: "p2-lair" }, 'owner "p2-lair" is not an agent of p1 with a door and a chat'],
    [{ ...good(), lane: "fast" }, 'lane "fast" is not one of tripwire, digest'],
    [{ ...good(), target: "x" }, "target must be an object"],
    [{ ...good(), hard: [] }, "hard must be an object"],
    [{ ...good(), hard: { max_price: "260" } }, "hard.max_price must be a finite number"],
    [{ ...good(), hard: { exclude: "laptop" } }, "hard.exclude must be an array of non-empty strings"],
    [{ ...good(), hard: { seller_kind: "shop" } }, 'hard.seller_kind must be "private" or "commercial"'],
    [{ ...good(), hard: { wanted_ad: "no" } }, "hard.wanted_ad must be true or false"],
    [{ ...good(), hard: { colour: "red" } }, "hard.colour is not a rule: the closed set is max_price, min_price, radius_km, exclude, seller_kind, min_temperature, wanted_ad, rental_ad"],
    [{ ...good(), hard: { min_events: 3 } }, "hard.min_events is a Sentry rule and is not read by a hunt"],
    [{ ...good(), notify: [] }, "notify must be an object"],
    [{ ...good(), notify: {} }, "notify is empty: name a predicate or remove the block"],
    [{ ...good(), notify: { events_at_least: 1 } }, "notify.events_at_least is not a predicate: the closed set is price_at_or_under, price_record_low"],
    [{ ...good(), notify: { price_at_or_under: "260" } }, "notify.price_at_or_under must be a finite number or null"],
    [{ ...good(), notify: { price_record_low: false } }, "notify.price_record_low must be true"],
    [{ ...good(), lane: "tripwire", notify: undefined }, "a tripwire spec needs a notify block"],
    [{ ...good(), soft: "one line" }, "soft must be an array of strings"],
    [{ ...good(), note: 3 }, "note must be a string"],
    [{ ...good(), paused: "yes" }, "paused must be true or false"],
    [{ ...good(), extra: 1 }, 'unknown key "extra"'],
  ];
  for (const [spec, said] of cases) {
    const problems = specProblems(spec, "kleinanzeigen", owner);
    expect(problems.some((one) => one.includes(said)), `${said}\n  got: ${problems.join(" | ")}`).toBe(true);
  }
  expect(specProblems(null, "kleinanzeigen", owner)).toEqual(["not a JSON object"]);
  expect(specProblems([], "kleinanzeigen", owner)).toEqual(["not a JSON object"]);
  // Every problem, not the first.
  expect(specProblems({ ...good(), id: "X", lane: "y", extra: 1 }, "kleinanzeigen", owner).length).toBe(3);
});

test("the target shapes are per source, and the kleinanzeigen message box is refused by name", () => {
  expect(targetProblems("kleinanzeigen", { query: "ddr5" })).toEqual([]);
  expect(targetProblems("kleinanzeigen", { query: "ddr5", location: "berlin", radius_km: 20 })).toEqual([]);
  expect(targetProblems("kleinanzeigen", { inbox: true })).toEqual(["target.inbox: the message box is not read by this version"]);
  expect(targetProblems("kleinanzeigen", { query: "" })).toEqual(["target.query must be a non-empty string"]);
  expect(targetProblems("kleinanzeigen", { query: "x", radius_km: 0 })).toEqual(["target.radius_km must be a number above zero"]);
  expect(targetProblems("kleinanzeigen", { query: "x", page: 2 })).toEqual(["target.page is not a key of a kleinanzeigen target: the keys are query, location, radius_km"]);

  expect(targetProblems("mydealz", { query: "xbox controller" })).toEqual([]);
  expect(targetProblems("mydealz", { query: "page:hot" })).toEqual([]);
  expect(targetProblems("mydealz", { query: "page:new" })).toEqual([]);
  expect(targetProblems("mydealz", { query: "page:top" })).toEqual(['target.query names a page that is not "page:hot" or "page:new"']);
  expect(targetProblems("mydealz", { query: "x", location: "berlin" })).toEqual(["target.location is not a key of a mydealz target: the keys are query"]);

  expect(targetProblems("vstdeals", { kind: "interest", term: "rx" })).toEqual([]);
  expect(targetProblems("vstdeals", { kind: "track", slug: "rx-12-standard", name: "RX 12 Standard", url: "https://example.invalid/price-history/rx-12" })).toEqual([]);
  expect(targetProblems("vstdeals", { kind: "interest" })).toEqual(["target.term must be a non-empty string on an interest spec"]);
  expect(targetProblems("vstdeals", { kind: "track", slug: "x", name: "x", url: "http://example.invalid/x" })).toEqual(["target.url must be an https link"]);
  expect(targetProblems("vstdeals", { kind: "track", slug: "x" })).toEqual([
    "target.name must be a non-empty string on a track spec",
    "target.url must be a non-empty string on a track spec",
  ]);
  expect(targetProblems("vstdeals", { kind: "feed" })).toEqual(['target.kind "feed" is not "interest" or "track"']);
  expect(targetProblems("sentry", { org: "x" })).toEqual(['source "sentry" is not a source this hub hunts on']);
});

test("a folder loads its specs sorted, refuses by file with the problems, skips a paused one in silence and filters by lane", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-watch-spec-"));
  try {
    const specs = join(dir, "kleinanzeigen");
    mkdirSync(specs);
    writeFileSync(join(specs, "de__32gb-ddr5-6000.json"), JSON.stringify(good()));
    writeFileSync(join(specs, "de__tripwire.json"), JSON.stringify({ ...good(), id: "de__tripwire", lane: "tripwire", notify: { price_at_or_under: 100 } }));
    writeFileSync(join(specs, "de__paused.json"), JSON.stringify({ ...good(), id: "de__paused", paused: true }));
    writeFileSync(join(specs, "de__renamed.json"), JSON.stringify({ ...good(), id: "de__other" }));
    writeFileSync(join(specs, "de__broken.json"), "{ not json");
    writeFileSync(join(specs, "de__wrong.json"), JSON.stringify({ ...good(), id: "de__wrong", hard: { max_price: "x" }, extra: 1 }));
    writeFileSync(join(specs, "notes.txt"), "not a spec");

    const all = loadSpecs(specs, "kleinanzeigen", { owner });
    expect(all.ok.map((one) => one.id)).toEqual(["de__32gb-ddr5-6000", "de__tripwire"]);
    expect(all.paused).toEqual(["de__paused"]);
    expect(all.refused.map((one) => one.file)).toEqual(["de__broken.json", "de__renamed.json", "de__wrong.json"]);
    expect(all.refused[0].problems[0]).toMatch(/^not JSON: /);
    expect(all.refused[1]).toEqual({ file: "de__renamed.json", id: "de__other", problems: ['id "de__other" does not match the filename de__renamed.json'] });
    expect(all.refused[2].problems).toEqual(["hard.max_price must be a finite number", 'unknown key "extra"']);

    expect(loadSpecs(specs, "kleinanzeigen", { owner, lane: "tripwire" }).ok.map((one) => one.id)).toEqual(["de__tripwire"]);
    expect(loadSpecs(specs, "kleinanzeigen", { owner, lane: "digest" }).ok.map((one) => one.id)).toEqual(["de__32gb-ddr5-6000"]);
    // A spec in the wrong folder is refused as filed under the wrong source.
    expect(loadSpecs(specs, "mydealz", { owner }).refused.find((one) => one.file === "de__32gb-ddr5-6000.json")!.problems).toContain('source "kleinanzeigen" filed under mydealz/');
    // A folder that is not there is a source with no hunts.
    expect(loadSpecs(join(dir, "none"), "kleinanzeigen", { owner })).toEqual({ ok: [], refused: [], paused: [] });
    // A spec with no hard block runs with an empty one.
    writeFileSync(join(specs, "de__bare.json"), JSON.stringify({ ...good(), id: "de__bare", hard: undefined, notify: undefined, soft: undefined }));
    expect(loadSpecs(specs, "kleinanzeigen", { owner }).ok.find((one) => one.id === "de__bare")!.hard).toEqual({});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
