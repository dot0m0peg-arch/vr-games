// Lexicon: normalization, numbers, plurals, part matching and colors.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeText, parseNumber, singularize, matchPart, matchColor, COLORS, editDistance } from "../js/core/lexicon.js";

const METAS = [
  { name: "villa", aliases: ["mansion"], size: [14, 9, 12] },
  { name: "card table", aliases: ["poker table", "game table"], size: [1, 0.78, 1] },
  { name: "deck of cards", aliases: ["deck of playing cards", "playing cards", "cards", "card deck", "deck"], size: [0.06, 0.02, 0.09] },
  { name: "playing card", aliases: ["card", "single card"], size: [0.06, 0.002, 0.09] },
  { name: "crate", aliases: ["box", "wooden crate"], size: [1, 1, 1] },
  { name: "training dummy", aliases: ["dummy", "target dummy"], size: [0.6, 1.8, 0.6] },
  { name: "sticky note", aliases: ["note", "post-it", "post it"], size: [0.3, 0.38, 0.1] },
  { name: "knife", aliases: [], size: [0.03, 0.25, 0.02] },
  { name: "bench", aliases: [], size: [1.6, 0.9, 0.6] },
  { name: "statue", aliases: [], size: [1.6, 4.4, 1.6] },
  { name: "dice", aliases: ["die", "pair of dice"], size: [0.08, 0.03, 0.04] },
  { name: "whiteboard", aliases: ["white board"], size: [1.8, 1.9, 0.56] },
];

test("normalizeText lowercases, converts quotes and strips punctuation", () => {
  assert.equal(normalizeText("Ai, spawn a VILLA!"), "ai spawn a villa");
  assert.equal(normalizeText("  spawn   a   crate  "), "spawn a crate");
  assert.equal(normalizeText("Don’t move"), "don't move");
  assert.equal(normalizeText("“Hello” world"), "hello world");
  assert.equal(normalizeText("move it 2.5 meters."), "move it 2.5 meters");
  assert.equal(normalizeText("A.I. spawn"), "a i spawn");
  assert.equal(normalizeText("note: buy milk"), "note: buy milk");
  assert.equal(normalizeText("crate: big"), "crate big");
  assert.equal(normalizeText("post-it note"), "post it note");
  assert.equal(normalizeText("'quoted'"), "quoted");
  assert.equal(normalizeText(""), "");
  assert.equal(normalizeText(null), "");
  assert.equal(normalizeText("paint it #FF8800"), "paint it #ff8800");
});

test("normalizeText turns number words into digits but keeps articles", () => {
  assert.equal(normalizeText("spawn three crates"), "spawn 3 crates");
  assert.equal(normalizeText("a couple of chairs"), "2 chairs");
  assert.equal(normalizeText("a couple chairs"), "2 chairs");
  assert.equal(normalizeText("a few trees"), "3 trees");
  assert.equal(normalizeText("a dozen eggs"), "12 eggs");
  assert.equal(normalizeText("dozen eggs"), "12 eggs");
  assert.equal(normalizeText("half a meter"), "0.5 meter");
  assert.equal(normalizeText("one and a half meters"), "1.5 meters");
  assert.equal(normalizeText("2 and a half meters"), "2.5 meters");
  assert.equal(normalizeText("twenty five crates"), "25 crates");
  assert.equal(normalizeText("twenty-five crates"), "25 crates");
  assert.equal(normalizeText("one hundred and five"), "105");
  assert.equal(normalizeText("a hundred meters"), "100 meters");
  assert.equal(normalizeText("spawn an axe and a sword"), "spawn an axe and a sword");
  assert.equal(normalizeText("twelve"), "12");
  assert.equal(normalizeText("the last one"), "the last 1");
});

test("parseNumber reads digits and number words", () => {
  assert.equal(parseNumber("3"), 3);
  assert.equal(parseNumber("2.5"), 2.5);
  assert.equal(parseNumber("three"), 3);
  assert.equal(parseNumber("Twenty"), 20);
  assert.equal(parseNumber("dozen"), 12);
  assert.equal(parseNumber("twice"), 2);
  assert.equal(parseNumber("half"), 0.5);
  assert.equal(parseNumber("crate"), null);
  assert.equal(parseNumber(""), null);
  assert.equal(parseNumber(undefined), null);
});

test("singularize handles regular and irregular plurals", () => {
  const cases = {
    boxes: "box", knives: "knife", dice: "dice", glasses: "glass", benches: "bench", cards: "card",
    statues: "statue", crates: "crate", trees: "tree", berries: "berry", axes: "axe", wolves: "wolf",
    leaves: "leaf", houses: "house", dishes: "dish", chess: "chess", grass: "grass", cactus: "cactus",
    men: "man", feet: "foot", tvs: "tv", movies: "movie", toys: "toy", crate: "crate", gloves: "glove",
  };
  for (const [plural, single] of Object.entries(cases)) assert.equal(singularize(plural), single, plural);
});

test("editDistance counts transpositions as one edit", () => {
  assert.equal(editDistance("villa", "vilal"), 1);
  assert.equal(editDistance("crate", "crates"), 1);
  assert.equal(editDistance("crate", "grate"), 1);
  assert.ok(editDistance("crate", "table", 1) > 1);
});

test("matchPart finds the longest phrase", () => {
  let m = matchPart("spawn a deck of playing cards on a card table".split(" "), METAS);
  assert.equal(m.name, "deck of cards");
  assert.equal(m.phrase, "deck of playing cards");
  assert.equal(m.start, 2);
  assert.equal(m.end, 6);
  m = matchPart(["a", "card", "table"], METAS);
  assert.equal(m.name, "card table");
  m = matchPart("put a card table here", METAS);
  assert.equal(m.name, "card table");
  m = matchPart(["card"], METAS);
  assert.equal(m.name, "playing card");
  m = matchPart(["cards"], METAS);
  assert.equal(m.name, "deck of cards", "exact alias beats singular match");
  m = matchPart(["playing", "cards"], METAS);
  assert.equal(m.name, "deck of cards");
});

test("matchPart handles plurals, typos and anchoring", () => {
  assert.equal(matchPart(["three", "crates"], METAS).name, "crate");
  assert.equal(matchPart(["boxes"], METAS).name, "crate");
  assert.equal(matchPart(["knives"], METAS).name, "knife");
  assert.equal(matchPart(["benches"], METAS).name, "bench");
  assert.equal(matchPart(["statues"], METAS).name, "statue");
  const typo = matchPart(["vilal"], METAS);
  assert.equal(typo.name, "villa");
  assert.ok(typo.score < 1);
  assert.equal(matchPart(["vila"], METAS), null, "no typo tolerance below 5 letters");
  assert.equal(matchPart(["dragon"], METAS), null);
  assert.equal(matchPart([], METAS), null);
  assert.equal(matchPart(["spawn", "a", "crate"], METAS, { start: 0, anchored: true }), null);
  assert.equal(matchPart(["spawn", "a", "crate"], METAS, { start: 2, anchored: true }).name, "crate");
  assert.equal(matchPart(["crate", "and", "villa"], METAS, { start: 1 }).name, "villa");
  assert.equal(matchPart(["training", "dummy"], METAS).name, "training dummy");
  assert.equal(matchPart("post-it", METAS).name, "sticky note");
  assert.equal(matchPart(["white", "board"], METAS).name, "whiteboard");
  assert.equal(matchPart(["pair", "of", "dice"], METAS).name, "dice");
  const exact = matchPart(["crate"], METAS);
  assert.equal(exact.score, 1);
});

test("COLORS and matchColor", () => {
  assert.ok(Object.keys(COLORS).length >= 30);
  for (const name of ["lime", "gold", "silver", "navy", "teal", "maroon", "pink", "purple", "orange", "brown", "black", "white", "gray", "grey"]) {
    assert.match(COLORS[name], /^#[0-9a-f]{6}$/, name);
  }
  assert.equal(matchColor("Red"), COLORS.red);
  assert.equal(matchColor("light blue"), COLORS["light blue"]);
  assert.equal(matchColor("#ABCDEF"), "#abcdef");
  assert.equal(matchColor("#abc"), "#aabbcc");
  assert.equal(matchColor("grey"), matchColor("gray"));
  assert.equal(matchColor("lime"), "#d5fb6a");
  assert.equal(matchColor("rainbow"), null);
  assert.equal(matchColor("<script>"), null);
  assert.equal(matchColor(""), null);
  assert.equal(matchColor(null), null);
});
