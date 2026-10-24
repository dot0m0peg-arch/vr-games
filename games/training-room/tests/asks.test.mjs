// What a spoken request asks for: chatter that asks for nothing, category words that mean several things.
import test from "node:test";
import assert from "node:assert/strict";
import { isChatter, expandCategories, CATEGORY_WORDS } from "../js/core/asks.js";
import { getMeta } from "../js/parts/meta/index.js";

test("isChatter: short fragments that ask for nothing", () => {
  for (const text of ["bye bye", "but", "a.", "my hand", "okay cool", "", "   "]) assert.equal(isChatter(text, { intents: [] }), true, text);
  for (const text of ["give me a gun", "what is this", "is it night", "spawn", "the big red one?", "I really want a castle over by the trees please"]) {
    assert.equal(isChatter(text, { intents: [] }), false, text);
  }
  assert.equal(isChatter("bye bye", { intents: [{ do: "clear" }] }), false, "the parser understood something");
});

test("expandCategories: furniture means a few concrete things, catalog parts first", () => {
  const out = expandCategories([{ do: "spawn", what: { label: "furniture" }, count: 4, place: { rel: "front" } }]);
  assert.deepEqual(out.map((i) => i.what.part), CATEGORY_WORDS.furniture, "all of them are catalog parts");
  assert.ok(out.every((i) => i.place.rel === "front" && !("count" in i)));
  for (const name of CATEGORY_WORDS.furniture) assert.ok(getMeta(name), `${name} is in the catalog`);
});

test("expandCategories: unknown members are designed, at most three of them", () => {
  const out = expandCategories([{ do: "spawn", what: { label: "decorations" } }]);
  const designs = out.filter((i) => i.what.label);
  assert.ok(designs.length <= 3);
  assert.ok(out.length >= 3);
  const other = [{ do: "spawn", what: { label: "pistol" } }, { do: "spawn", what: { part: "crate" } }, { do: "time", value: "night" }];
  assert.deepEqual(expandCategories(other), other, "everything else passes through");
});
