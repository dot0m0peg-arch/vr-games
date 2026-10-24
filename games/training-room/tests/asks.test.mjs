// What a spoken request asks for: chatter, things that are not objects, category words.
import test from "node:test";
import assert from "node:assert/strict";
import { isChatter, isThing, expandCategories, CATEGORY_WORDS } from "../js/core/asks.js";
import { parseCommand } from "../js/core/parse.js";
import { allMeta, getMeta } from "../js/parts/meta/index.js";

const none = { intents: [] };

test("isChatter: only fillers, nothing asked for", () => {
  for (const text of ["bye bye", "but", "a.", "my hand", "okay cool", "", "   ", "oh wow thanks"]) assert.equal(isChatter(text, none), true, text);
  for (const text of ["dragon", "pirate ship", "a dragon please", "bigger", "smaller please", "a little bigger", "one more", "another one",
    "now a unicorn", "and a dragon", "also a pirate ship", "whats that", "give me a gun", "what is this", "is it night", "the big red one?"]) {
    assert.equal(isChatter(text, none), false, text);
  }
  assert.equal(isChatter("bye bye", { intents: [{ do: "clear" }] }), false, "the parser understood something");
});

test("isThing: ideas, plans and hugs are not objects to design", () => {
  for (const label of ["idea", "plan", "list idea", "wish", "hug", "reason"]) assert.equal(isThing(label), false, label);
  for (const label of ["pirate ship", "machine gun", "go kart", "zombie"]) assert.equal(isThing(label), true, label);
});

test("expandCategories: furniture means a few concrete things, catalog parts first", () => {
  const out = expandCategories([{ do: "spawn", what: { label: "furniture" }, count: 4, place: { rel: "front" } }], "spawn some furniture");
  assert.deepEqual(out.map((i) => i.what.part), CATEGORY_WORDS.furniture, "all of them are catalog parts");
  assert.ok(out.every((i) => i.place.rel === "front" && !("count" in i)));
  for (const name of CATEGORY_WORDS.furniture) assert.ok(getMeta(name), `${name} is in the catalog`);
});

test("expandCategories: the parser's singular label, one for 'a weapon', several for 'some tools'", () => {
  const metas = allMeta();
  const tools = parseCommand("spawn some tools", { metas });
  const many = expandCategories(tools.intents, "spawn some tools");
  assert.ok(many.length >= 3 && many.every((i) => i.what.part || i.what.label !== "tool"), JSON.stringify(many));
  const one = expandCategories(parseCommand("give me a weapon", { metas }).intents, "give me a weapon");
  assert.equal(one.length, 1);
  assert.ok(CATEGORY_WORDS.weapon.includes(one[0].what.part || one[0].what.label));
  const decorations = expandCategories([{ do: "spawn", what: { label: "decoration" } }], "spawn decorations");
  assert.ok(decorations.filter((i) => i.what.label).length <= 3, "at most three designs");
});

test("expandCategories: a model answer { part, label } for a category word expands too", () => {
  const out = expandCategories([{ do: "spawn", what: { part: "furniture", label: "furniture" } }], "furnish the room");
  assert.deepEqual(out.map((i) => i.what.part), CATEGORY_WORDS.furniture);
});

test("expandCategories: later { batch } refs still point at what they meant", () => {
  const out = expandCategories([
    { do: "spawn", what: { label: "furniture" } },
    { do: "spawn", what: { part: "card table" } },
    { do: "spawn", what: { part: "crate" }, place: { rel: "on", ref: { batch: 1 } } },
    { do: "color", target: { batch: 0 }, color: "red" },
  ], "spawn some furniture and a card table and put a crate on it");
  const n = CATEGORY_WORDS.furniture.length;
  assert.equal(out[n].what.part, "card table");
  assert.deepEqual(out[n + 1].place.ref, { batch: n }, "the crate goes on the card table, not an armchair");
  assert.deepEqual(out[n + 2].target, { batch: 0 }, "the category stands for its first thing");
  const other = [{ do: "spawn", what: { label: "pistol" } }, { do: "spawn", what: { part: "crate" } }, { do: "time", value: "night" }];
  assert.deepEqual(expandCategories(other), other, "everything else passes through");
});
