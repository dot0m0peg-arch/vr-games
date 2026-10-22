// Rule parser and wake word: spoken commands → intents.
import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../js/core/parse.js";
import { stripWake } from "../js/core/wake.js";
import { COLORS } from "../js/core/lexicon.js";
import { allMeta } from "../js/parts/meta/index.js";

const grip = { p: [0, 0.1, 0], r: [0, 0, 0] };
const METAS = [
  { name: "villa", aliases: ["mansion"], category: "structures", size: [14, 9, 12] },
  { name: "house", aliases: ["home", "cottage"], category: "structures", size: [8, 7, 7] },
  { name: "axe", aliases: ["hatchet"], category: "combat", size: [0.3, 0.9, 0.08], holdable: true, grip, tip: [0, 0.85, 0] },
  { name: "sword", aliases: ["blade"], category: "combat", size: [0.25, 1.1, 0.05], holdable: true, grip, tip: [0, 1.1, 0] },
  { name: "shield", aliases: [], category: "combat", size: [0.6, 0.6, 0.1], holdable: true, grip },
  { name: "card table", aliases: ["poker table"], category: "leisure", size: [1, 0.78, 1], surface: 0.76, surfaceSize: [0.9, 0.9] },
  { name: "deck of cards", aliases: ["deck of playing cards", "playing cards", "cards", "card deck", "deck"], category: "leisure", size: [0.063, 0.017, 0.088], holdable: true, grip, deck: true },
  { name: "playing card", aliases: ["card"], category: "leisure", size: [0.063, 0.002, 0.088], holdable: true, grip },
  { name: "whiteboard", aliases: ["white board"], category: "office", size: [1.8, 1.9, 0.56], writable: true },
  { name: "sticky note", aliases: ["note"], category: "office", size: [0.3, 0.38, 0.1], holdable: true, grip, writable: true },
  { name: "crate", aliases: ["box"], category: "structures", size: [1, 1, 1], surface: 1, surfaceSize: [0.95, 0.95] },
  { name: "training dummy", aliases: ["dummy"], category: "combat", size: [0.6, 1.8, 0.6], hittable: true },
  { name: "tree", aliases: ["oak"], category: "nature", size: [4, 6, 4] },
  { name: "chair", aliases: ["seat"], category: "office", size: [0.45, 0.9, 0.45] },
  { name: "desk", aliases: [], category: "office", size: [1.6, 0.76, 0.8], surface: 0.76, surfaceSize: [1.56, 0.76] },
  { name: "screen", aliases: ["monitor", "tv"], category: "office", size: [2, 1.9, 0.6], screen: true },
  { name: "ball", aliases: [], category: "leisure", size: [0.23, 0.22, 0.22], holdable: true, grip },
];

const parse = (text, opts = {}) => parseCommand(text, { metas: METAS, ...opts });
const one = (text, opts) => {
  const r = parse(text, opts);
  assert.equal(r.intents.length, 1, `${text}: ${JSON.stringify(r.intents)}`);
  return r.intents[0];
};

test("stripWake detects wake words at the start only", () => {
  assert.deepEqual(stripWake("AI, spawn a villa"), { matched: true, rest: "spawn a villa" });
  assert.deepEqual(stripWake("A.I. spawn a villa"), { matched: true, rest: "spawn a villa" });
  assert.deepEqual(stripWake("Ai: spawn a villa"), { matched: true, rest: "spawn a villa" });
  assert.deepEqual(stripWake("hey AI spawn a crate"), { matched: true, rest: "spawn a crate" });
  assert.deepEqual(stripWake("okay ai, make it night"), { matched: true, rest: "make it night" });
  assert.deepEqual(stripWake("yo AI spawn a crate"), { matched: true, rest: "spawn a crate" });
  assert.deepEqual(stripWake("ok, AI. undo"), { matched: true, rest: "undo" });
  assert.equal(stripWake("a i spawn a tree").matched, true);
  assert.equal(stripWake("eh i spawn a tree").rest, "spawn a tree");
  assert.equal(stripWake("aim the cannon").matched, false);
  assert.equal(stripWake("air horn please").matched, false);
  assert.equal(stripWake("spawn an AI robot").matched, false);
  assert.equal(stripWake("hey there").matched, false);
  assert.equal(stripWake("spawn a crate").rest, "spawn a crate");
  assert.deepEqual(stripWake("AI"), { matched: true, rest: "" });
  assert.deepEqual(stripWake("computer, spawn a crate", ["computer"]), { matched: true, rest: "spawn a crate" });
  assert.equal(stripWake("ai spawn a crate", ["computer"]).matched, false);
  assert.equal(stripWake("Write NOTE: Buy Milk").rest, "Write NOTE: Buy Milk");
});

test("the three required example commands", () => {
  assert.deepEqual(parse("ai spawn a villa to my left").intents, [{ do: "spawn", what: { part: "villa" }, place: { rel: "left" } }]);
  assert.deepEqual(parse("ai spawn an axe in my hand").intents, [{ do: "spawn", what: { part: "axe" }, place: { rel: "hand", hand: "right" } }]);
  assert.deepEqual(parse("Ai spawn a deck of playing cards on a card table.").intents, [
    { do: "spawn", what: { part: "deck of cards" }, place: { rel: "on", ref: { part: "card table", which: "nearest", spawnIfMissing: true } } },
  ]);
  const r = parse("ai spawn a villa to my left");
  assert.equal(r.wake, true);
  assert.ok(r.confidence >= 0.8);
  assert.equal(r.text, "spawn a villa to my left");
});

test("wakeRequired ignores speech without the wake word", () => {
  const r = parse("spawn a villa", { wakeRequired: true });
  assert.deepEqual(r.intents, []);
  assert.equal(r.wake, false);
  assert.equal(r.confidence, 0);
  assert.equal(parse("AI spawn a villa", { wakeRequired: true }).intents.length, 1);
  assert.equal(parse("aim the villa", { wakeRequired: true }).intents.length, 0);
});

test("spawn verbs, fillers and counts", () => {
  for (const text of [
    "spawn a crate", "summon a crate", "create a crate", "make a crate", "build a crate", "conjure a crate", "add a crate",
    "put a crate", "place a crate", "bring a crate", "can you spawn a crate", "could you please summon a crate",
    "please spawn a crate", "let's build a crate", "I need a crate", "get me a crate", "I want a crate",
  ]) {
    const intent = one(text);
    assert.equal(intent.do, "spawn", text);
    assert.equal(intent.what.part, "crate", text);
  }
  assert.equal(one("spawn three crates").count, 3);
  assert.equal(one("spawn 12 crates").count, 12);
  assert.equal(one("spawn a couple of chairs").count, 2);
  assert.equal(one("summon a few trees").count, 3);
  assert.equal(one("spawn some crates").count, 3);
  assert.equal(one("spawn a dozen balls").count, 12);
  assert.equal(one("spawn 500 crates").count, 30, "capped");
  assert.equal(one("spawn a crate").count, undefined);
  assert.deepEqual(one("drop a crate here"), { do: "spawn", what: { part: "crate" }, place: { rel: "here" } });
  assert.ok(parse("spawn three crates").confidence >= 0.8);
});

test("placement phrases", () => {
  const place = (text) => one(text).place;
  assert.deepEqual(place("spawn a crate to my right"), { rel: "right" });
  assert.deepEqual(place("spawn a crate on my left"), { rel: "left" });
  assert.deepEqual(place("spawn a crate on the left"), { rel: "left" });
  assert.deepEqual(place("spawn a crate on the right"), { rel: "right" });
  assert.deepEqual(place("spawn a crate in front of me"), { rel: "front" });
  assert.deepEqual(place("spawn a crate in front"), { rel: "front" });
  assert.deepEqual(place("spawn a crate ahead"), { rel: "front" });
  assert.deepEqual(place("spawn a crate before me"), { rel: "front" });
  assert.deepEqual(place("spawn a crate behind me"), { rel: "behind" });
  assert.deepEqual(place("spawn a crate behind"), { rel: "behind" });
  assert.deepEqual(place("spawn a crate here"), { rel: "here" });
  assert.deepEqual(place("spawn a crate right here"), { rel: "here" });
  assert.deepEqual(place("spawn a crate at my feet"), { rel: "feet" });
  assert.deepEqual(place("spawn a chair next to me"), { rel: "left", dist: 1 });
  assert.deepEqual(place("spawn a ball above me"), { rel: "above" });
  assert.deepEqual(place("spawn a ball over my head"), { rel: "above" });
  assert.deepEqual(place("spawn a ball overhead"), { rel: "above" });
  assert.deepEqual(place("spawn a tree far away"), { rel: "far" });
  assert.deepEqual(place("spawn a tree in the distance"), { rel: "far" });
  assert.deepEqual(place("spawn a crate 5 meters to my left"), { rel: "left", dist: 5 });
  assert.deepEqual(place("spawn a crate 3 m in front of me"), { rel: "front", dist: 3 });
  assert.deepEqual(place("spawn a crate 10 feet away"), { rel: "front", dist: 3.048 });
  assert.deepEqual(place("spawn a crate 2 ft behind me"), { rel: "behind", dist: 0.61 });
  assert.deepEqual(place("spawn a crate close"), { rel: "front", dist: 1.5 });
  assert.deepEqual(place("spawn a crate near me"), { rel: "front", dist: 1.5 });
  assert.deepEqual(place("spawn a crate far to the left"), { rel: "left", dist: 25 });
});

test("hands", () => {
  assert.deepEqual(one("spawn an axe in my left hand").place, { rel: "hand", hand: "left" });
  assert.deepEqual(one("spawn an axe in my right hand").place, { rel: "hand", hand: "right" });
  assert.deepEqual(one("spawn an axe in my hands").place, { rel: "hand", hand: "right" });
  assert.deepEqual(one("spawn an axe in my hand", { hand: "left" }).place, { rel: "hand", hand: "left" });
  assert.deepEqual(one("give me an axe"), { do: "spawn", what: { part: "axe" }, place: { rel: "hand", hand: "right" } });
  assert.deepEqual(one("give me a crate"), { do: "spawn", what: { part: "crate" } }, "not holdable: no hand");
  assert.deepEqual(one("give me an axe to my left").place, { rel: "left" }, "explicit placement wins");
  const both = parse("give me a sword and a shield").intents;
  assert.equal(both[0].place.hand, "right");
  assert.equal(both[1].place.hand, "left", "second item goes to the free hand");
  assert.deepEqual(one("give me the sword"), { do: "hold", target: { part: "sword", which: "nearest", spawnIfMissing: true }, hand: "right" });
  assert.deepEqual(one("put the sword in my left hand"), { do: "hold", target: { part: "sword", which: "nearest", spawnIfMissing: true }, hand: "left" });
  assert.equal(one("pick up the axe").do, "hold");
  assert.equal(one("grab the ball with my left hand").hand, "left");
});

test("on / next relations", () => {
  assert.deepEqual(one("spawn a crate on the card table").place, { rel: "on", ref: { part: "card table", which: "nearest" } });
  assert.deepEqual(one("spawn a ball on top of the crate").place, { rel: "on", ref: { part: "crate", which: "nearest" } });
  assert.deepEqual(one("spawn a chair next to the villa").place, { rel: "next", ref: { part: "villa", which: "nearest" } });
  assert.deepEqual(one("spawn a chair beside the tree").place, { rel: "next", ref: { part: "tree", which: "nearest" } });
  assert.deepEqual(one("spawn a chair near the desk").place, { rel: "next", ref: { part: "desk", which: "nearest" } });
  assert.deepEqual(one("spawn a chair next to a desk").place, { rel: "next", ref: { part: "desk", which: "nearest", spawnIfMissing: true } });
  assert.deepEqual(one("spawn a crate left of the villa").place, { rel: "next", side: "left", ref: { part: "villa", which: "nearest" } });
  assert.deepEqual(one("spawn a crate in front of the villa").place, { rel: "next", side: "front", ref: { part: "villa", which: "nearest" } });
  assert.deepEqual(one("spawn a crate behind the tree").place, { rel: "next", side: "behind", ref: { part: "tree", which: "nearest" } });
});

test("colors and sizes", () => {
  assert.deepEqual(one("spawn a red crate"), { do: "spawn", what: { part: "crate" }, color: COLORS.red });
  assert.equal(one("spawn a light blue crate").color, COLORS["light blue"]);
  assert.equal(one("spawn a crate in gold").color, COLORS.gold);
  assert.equal(one("spawn a big tree").scale, 2);
  assert.equal(one("spawn a huge tree").scale, 3);
  assert.equal(one("spawn a giant tree").scale, 3);
  assert.equal(one("spawn a small crate").scale, 0.5);
  assert.equal(one("spawn a tiny crate").scale, 0.3);
  assert.equal(one("spawn a mini crate").scale, 0.3);
  assert.equal(one("spawn a crate twice as big").scale, 2);
  const combo = one("spawn a big red crate to my left");
  assert.equal(combo.scale, 2);
  assert.equal(combo.color, COLORS.red);
  assert.deepEqual(combo.place, { rel: "left" });
});

test("remove and clear", () => {
  assert.deepEqual(one("remove the villa"), { do: "remove", target: { part: "villa", which: "nearest" } });
  assert.deepEqual(one("delete that"), { do: "remove", target: { ref: "it" } });
  assert.deepEqual(one("destroy it"), { do: "remove", target: { ref: "it" } });
  assert.deepEqual(one("despawn everything"), { do: "remove", target: { ref: "all" } });
  assert.deepEqual(one("get rid of all the crates"), { do: "remove", target: { part: "crate", which: "all" } });
  assert.deepEqual(one("remove the crates"), { do: "remove", target: { part: "crate", which: "all" } });
  assert.deepEqual(one("erase the last one"), { do: "remove", target: { ref: "last" } });
  assert.deepEqual(one("banish the dummy"), { do: "remove", target: { part: "training dummy", which: "nearest" } });
  assert.deepEqual(one("vanish the tree"), { do: "remove", target: { part: "tree", which: "nearest" } });
  assert.deepEqual(one("remove the second crate"), { do: "remove", target: { part: "crate", which: 2 } });
  assert.deepEqual(one("remove the last crate"), { do: "remove", target: { part: "crate", which: "last" } });
  for (const text of ["clear everything", "clear all", "reset the room", "clear the field", "start over"]) {
    assert.deepEqual(parse(text).intents, [{ do: "clear" }], text);
  }
});

test("move", () => {
  assert.deepEqual(one("move the crate to my left"), { do: "move", target: { part: "crate", which: "nearest" }, place: { rel: "left" } });
  assert.deepEqual(one("bring the dummy here"), { do: "move", target: { part: "training dummy", which: "nearest", spawnIfMissing: true }, place: { rel: "here" } });
  assert.deepEqual(one("bring the dummy to me").place, { rel: "here" });
  assert.deepEqual(one("bring the dummy closer").place, { rel: "front", dist: 1.5 });
  assert.deepEqual(one("put the deck on the desk"), {
    do: "move", target: { part: "deck of cards", which: "nearest", spawnIfMissing: true }, place: { rel: "on", ref: { part: "desk", which: "nearest" } },
  });
  assert.deepEqual(one("move it 5 meters to the right"), { do: "move", target: { ref: "it" }, place: { rel: "right", dist: 5 } });
  assert.deepEqual(one("move the villa far away").place, { rel: "far" });
});

test("scale", () => {
  const factor = (text) => one(text).factor;
  assert.equal(factor("make the tree bigger"), 1.5);
  assert.equal(factor("make the tree larger"), 1.5);
  assert.equal(factor("make the tree huge"), 3);
  assert.equal(factor("make it smaller"), 0.67);
  assert.equal(factor("double the size of the villa"), 2);
  assert.equal(factor("make it half the size"), 0.5);
  assert.equal(factor("make it twice as big"), 2);
  assert.equal(factor("make it 3 times bigger"), 3);
  assert.equal(factor("make it much bigger"), 2);
  assert.equal(factor("make it a bit smaller"), 0.8);
  assert.equal(factor("scale the crate by 4"), 4);
  assert.equal(factor("scale it up"), 1.5);
  assert.equal(factor("shrink the villa"), 0.67);
  assert.equal(factor("grow the tree"), 1.5);
  assert.deepEqual(one("double the size of the villa").target, { part: "villa", which: "nearest" });
  assert.deepEqual(one("make it half the size").target, { ref: "it" });
});

test("color commands", () => {
  assert.deepEqual(one("make the crate red"), { do: "color", target: { part: "crate", which: "nearest" }, color: COLORS.red });
  assert.deepEqual(one("paint it blue"), { do: "color", target: { ref: "it" }, color: COLORS.blue });
  assert.deepEqual(one("color the villa white"), { do: "color", target: { part: "villa", which: "nearest" }, color: COLORS.white });
  assert.equal(one("turn the crate green").color, COLORS.green);
  assert.equal(one("change the color of the crate to purple").color, COLORS.purple);
  assert.equal(one("paint everything gold").target.ref, "all");
});

test("hold and drop", () => {
  assert.deepEqual(one("drop it"), { do: "drop" });
  assert.deepEqual(one("let go"), { do: "drop" });
  assert.deepEqual(one("drop everything"), { do: "drop" });
  assert.deepEqual(one("put it down"), { do: "drop" });
  assert.deepEqual(one("drop what's in my left hand"), { do: "drop", hand: "left" });
  assert.deepEqual(one("drop the sword"), { do: "drop", target: { part: "sword", which: "nearest" } });
});

test("writing keeps the original text", () => {
  assert.deepEqual(one("write hello world on the whiteboard"), { do: "write", text: "hello world", target: { part: "whiteboard", which: "nearest" } });
  assert.deepEqual(one("AI, write Hello World on the whiteboard."), { do: "write", text: "Hello World", target: { part: "whiteboard", which: "nearest" } });
  assert.deepEqual(one("write buy milk"), { do: "write", text: "buy milk" });
  assert.deepEqual(one("note: buy milk"), { do: "spawn", what: { part: "sticky note" }, text: "buy milk" });
  assert.deepEqual(one("take a note buy milk"), { do: "spawn", what: { part: "sticky note" }, text: "buy milk" });
  assert.deepEqual(one("add a sticky note that says ship it"), { do: "spawn", what: { part: "sticky note" }, text: "ship it" });
  assert.deepEqual(one("note: eggs, milk and bread"), { do: "spawn", what: { part: "sticky note" }, text: "eggs, milk and bread" }, "no clause split inside notes");
  assert.deepEqual(one("write on the whiteboard: Ship v2 on Friday"), { do: "write", text: "Ship v2 on Friday", target: { part: "whiteboard", which: "nearest" } });
  assert.deepEqual(one("make the whiteboard say Hello"), { do: "write", target: { part: "whiteboard", which: "nearest" }, text: "Hello" });
  const noteless = parseCommand("note: hi", { metas: METAS.filter((m) => !m.writable) });
  assert.deepEqual(noteless.intents, [{ do: "write", text: "hi" }]);
});

test("cards", () => {
  assert.deepEqual(one("deal 5 cards"), { do: "deal", count: 5 });
  assert.deepEqual(one("deal five cards on the card table"), { do: "deal", count: 5, place: { rel: "on", ref: { part: "card table", which: "nearest" } } });
  assert.deepEqual(one("deal me a hand"), { do: "deal", count: 5 });
  assert.deepEqual(one("deal a card"), { do: "deal", count: 1 });
  assert.deepEqual(one("deal"), { do: "deal", count: 5 });
  assert.deepEqual(one("shuffle the deck"), { do: "shuffle" });
  assert.deepEqual(one("shuffle"), { do: "shuffle" });
  assert.deepEqual(one("flip the cards"), { do: "flip", target: { part: "playing card", which: "all" } });
  assert.deepEqual(one("turn the cards over"), { do: "flip", target: { part: "playing card", which: "all" } });
  assert.deepEqual(one("flip it"), { do: "flip", target: { ref: "it" } });
  assert.deepEqual(one("flip"), { do: "flip" });
});

test("undo, time, list", () => {
  assert.deepEqual(one("undo"), { do: "undo" });
  assert.deepEqual(one("undo that"), { do: "undo" });
  assert.deepEqual(one("take that back"), { do: "undo" });
  assert.deepEqual(one("undo 3 times"), { do: "undo", count: 3 });
  assert.deepEqual(one("undo three times"), { do: "undo", count: 3 });
  assert.deepEqual(one("make it night"), { do: "time", value: "night" });
  assert.deepEqual(one("set it to sunset"), { do: "time", value: "sunset" });
  assert.deepEqual(one("make it daytime"), { do: "time", value: "day" });
  assert.deepEqual(one("dawn"), { do: "time", value: "dawn" });
  assert.deepEqual(one("make it dark"), { do: "time", value: "night" });
  for (const text of ["what can you spawn", "list parts", "help", "what can you make", "show me the parts"]) {
    assert.deepEqual(parse(text).intents, [{ do: "list" }], text);
  }
});

test("magic marker phrases", () => {
  assert.deepEqual(one("AI, make it real"), { do: "realize" });
  assert.deepEqual(one("bring it to life"), { do: "realize" });
  assert.deepEqual(one("make the drawing come alive"), { do: "realize" });
  assert.deepEqual(one("make it a fish"), { do: "realize", hint: "fish" });
  assert.deepEqual(one("turn it into a dragon"), { do: "realize", hint: "dragon" });
  assert.deepEqual(one("make it a bit bigger"), { do: "scale", target: { ref: "it" }, factor: 1.2 }, "size phrases are not hints");
  assert.deepEqual(one("what is this?"), { do: "guess" });
  assert.deepEqual(one("no, it's a gun"), { do: "correct", label: "gun" });
  assert.ok(parse("no, it's a gun").confidence >= 0.8, "a lone 'no' clause does not lower confidence");
  assert.deepEqual(one("that's a fish"), { do: "correct", label: "fish" });
  assert.deepEqual(one("it's night"), { do: "time", value: "night" }, "time still wins");
  assert.deepEqual(one("make it fly"), { do: "animate", target: { ref: "it" }, behavior: "fly" });
  assert.deepEqual(one("make the crate spin fast"), { do: "animate", target: { part: "crate", which: "nearest" }, behavior: { kind: "spin", speed: 2 } });
  assert.deepEqual(one("stop moving"), { do: "animate", target: { ref: "it" }, behavior: "none" });
  assert.deepEqual(one("erase the drawing"), { do: "erase" });
  assert.deepEqual(one("wipe it"), { do: "erase" });
  assert.deepEqual(one("erase the villa"), { do: "remove", target: { part: "villa", which: "nearest" } });
  assert.deepEqual(one("clear it"), { do: "remove", target: { ref: "it" } }, "'clear it' is not 'clear everything'");
});

test("magic marker: more ways to say it", () => {
  for (const text of ["make it real", "bring my drawing to life", "make it come alive", "make this real please", "realize it"]) {
    assert.deepEqual(one(text), { do: "realize" }, text);
  }
  assert.deepEqual(one("make it a red fish"), { do: "realize", hint: "red fish" }, "color + noun is a hint");
  assert.deepEqual(one("make my drawing a fish"), { do: "realize", hint: "fish" });
  assert.deepEqual(one("bring it to life as a fish"), { do: "realize", hint: "fish" });
  assert.deepEqual(one("make it come alive as a dog"), { do: "realize", hint: "dog" });
  assert.deepEqual(parse("make it a red color").intents, [], "a color phrase is not a hint");
  for (const text of ["what is this", "guess what I drew", "what do you see", "what does it look like", "what's this supposed to be"]) {
    assert.deepEqual(one(text), { do: "guess" }, text);
  }
  for (const text of ["that's supposed to be a dog", "it's supposed to be a dog", "it was meant to be a dog", "no, it's a dog not a gun",
    "it's actually a dog", "no it's not a gun it's a dog", "it's not a gun, it's a dog", "it isn't a gun but a dog", "no, I drew a dog"]) {
    const r = parse(text);
    assert.deepEqual(r.intents, [{ do: "correct", label: "dog" }], text);
    assert.ok(r.confidence >= 0.8, `${text}: ${r.confidence}`);
  }
  assert.deepEqual(parse("it's not a fish").intents, [], "a bare denial has nothing to do");
  for (const text of ["that's awesome", "it's too big", "AI, this is cool"]) {
    assert.ok(!parse(text).intents.some((i) => i.do === "correct"), `${text} is chat, not a correction`);
  }
  assert.equal(parse("that's not right, move it left").confidence, 0.2, "other denials still lower confidence");
  assert.deepEqual(one("make the fish swim"), { do: "animate", target: { part: "fish", which: "nearest" }, behavior: "swim" });
  assert.deepEqual(one("make the dog walk around"), { do: "animate", target: { part: "dog", which: "nearest" }, behavior: "walk" });
  assert.deepEqual(one("let the bird fly slowly"), { do: "animate", target: { part: "bird", which: "nearest" }, behavior: { kind: "fly", speed: 0.5 } });
  assert.deepEqual(one("make all the fish swim"), { do: "animate", target: { part: "fish", which: "all" }, behavior: "swim" });
  assert.deepEqual(one("make the drawing fly"), { do: "animate", target: { part: "drawing", which: "nearest" }, behavior: "fly" });
  assert.deepEqual(one("make the fish stop moving"), { do: "animate", target: { part: "fish", which: "nearest" }, behavior: "none" });
  assert.deepEqual(one("make the training dummy dance"), { do: "animate", target: { part: "training dummy", which: "nearest" }, behavior: "sway" });
  assert.deepEqual(one("make a crate float above me"), { do: "spawn", what: { part: "crate" }, place: { rel: "above" } }, "spawning still wins");
  assert.deepEqual(one("erase all drawings"), { do: "erase", target: { part: "drawing", which: "all" } });
  assert.deepEqual(one("wipe all the sketches"), { do: "erase", target: { part: "drawing", which: "all" } });
});

test("multiple commands in one sentence", () => {
  assert.deepEqual(parse("spawn a desk and a chair").intents, [{ do: "spawn", what: { part: "desk" } }, { do: "spawn", what: { part: "chair" } }]);
  assert.deepEqual(parse("spawn a desk then put a monitor on it").intents, [
    { do: "spawn", what: { part: "desk" } },
    { do: "spawn", what: { part: "screen" }, place: { rel: "on", ref: { batch: 0 } } },
  ]);
  assert.deepEqual(parse("spawn a card table and put a deck of cards on it").intents, [
    { do: "spawn", what: { part: "card table" } },
    { do: "spawn", what: { part: "deck of cards" }, place: { rel: "on", ref: { batch: 0 } } },
  ]);
  assert.deepEqual(parse("spawn a crate and paint it red").intents[1], { do: "color", target: { batch: 0 }, color: COLORS.red });
  const three = parse("spawn a desk, a chair and a ball");
  assert.deepEqual(three.intents.map((i) => i.what.part), ["desk", "chair", "ball"]);
  const mixed = parse("make it night and spawn a tree far away");
  assert.deepEqual(mixed.intents, [{ do: "time", value: "night" }, { do: "spawn", what: { part: "tree" }, place: { rel: "far" } }]);
  const moves = parse("move the crate to my left and the chair to my right").intents;
  assert.deepEqual(moves.map((i) => [i.do, i.target.part, i.place.rel]), [["move", "crate", "left"], ["move", "chair", "right"]]);
  assert.deepEqual(parse("spawn a crate. AI spawn a tree").intents.map((i) => i.what.part), ["crate", "tree"]);
  assert.deepEqual(parse("make the crate red and the tree blue").intents.map((i) => [i.do, i.target.part, i.color]), [
    ["color", "crate", COLORS.red], ["color", "tree", COLORS.blue],
  ], "verbless follow-ups reuse the verb, not spawn");
});

test("unknown nouns ask the model", () => {
  const r = parse("spawn a dragon statue");
  assert.deepEqual(r.intents, [{ do: "spawn", what: { label: "dragon statue" } }]);
  assert.deepEqual(r.unknown, ["dragon statue"]);
  assert.ok(r.confidence <= 0.4);
  const plural = parse("spawn 3 dragons to my left");
  assert.deepEqual(plural.intents, [{ do: "spawn", what: { label: "dragon" }, count: 3, place: { rel: "left" } }]);
  const partial = parse("spawn a crate with wheels");
  assert.ok(partial.confidence < 0.8 && partial.confidence > 0.4, "leftover words lower confidence");
  const known = parse("spawn a crate");
  assert.ok(known.confidence >= 0.8);
  const modifierNoun = parse("spawn an orange");
  assert.deepEqual(modifierNoun.intents, [{ do: "spawn", what: { label: "orange" } }], "a lone color word is the noun");
  assert.deepEqual(modifierNoun.unknown, ["orange"]);
  const head = parse("spawn a table");
  assert.deepEqual(head.intents, [{ do: "spawn", what: { part: "card table", label: "table" } }], "head noun guess");
  assert.ok(head.confidence > 0.4 && head.confidence < 0.8);
  const descriptor = parse("spawn a golden sword");
  assert.equal(descriptor.intents[0].color, COLORS.gold);
  const nothing = parse("what's the weather like");
  assert.deepEqual(nothing.intents, []);
  assert.equal(nothing.confidence, 0);
  assert.deepEqual(parse("").intents, []);
});

test("every real catalog part parses from 'spawn a <name>'", (t) => {
  const real = allMeta();
  if (real.length < 20) {
    t.skip(`catalog has only ${real.length} entries`);
    return;
  }
  for (const meta of real) {
    const r = parseCommand(`spawn a ${meta.name}`, { metas: real });
    assert.equal(r.intents.length, 1, meta.name);
    assert.equal(r.intents[0].do, "spawn", meta.name);
    assert.equal(r.intents[0].what.part, meta.name, `spawn a ${meta.name} → ${JSON.stringify(r.intents[0].what)}`);
    assert.ok(r.confidence >= 0.8, `${meta.name} confidence ${r.confidence}`);
  }
});

test("percent and 'by N' scale factors", () => {
  const factor = (text) => one(text).factor;
  assert.equal(factor("AI, grow the tree by 20%."), 1.2);
  assert.equal(factor("shrink the crate by 50%"), 0.5);
  assert.equal(factor("scale it up by 10%"), 1.1);
  assert.equal(factor("enlarge it by 25 percent"), 1.25);
  assert.equal(factor("shrink it by 25 percent"), 0.75);
  assert.equal(factor("scale it down by 2"), 0.5);
  assert.equal(factor("scale it to 50%"), 0.5);
  assert.equal(factor("make it 10% smaller"), 0.9);
  assert.deepEqual(one("make the tree 20% bigger"), { do: "scale", target: { part: "tree", which: "nearest" }, factor: 1.2 });
  assert.equal(factor("scale the crate by 2"), 2);
  assert.equal(factor("shrink it by half"), 0.5);
  assert.ok(parse("grow the tree by 20%").confidence >= 0.8);
});

test("wiping a board clears its text, not the room or the board", () => {
  for (const text of ["AI, clear the board.", "wipe the board", "clean the board", "erase the writing on the board"]) {
    assert.deepEqual(parse(text).intents, [{ do: "write", text: "" }], text);
  }
  for (const text of ["clear the whiteboard", "erase the whiteboard", "wipe the whiteboard clean", "clear the whiteboard text"]) {
    assert.deepEqual(parse(text).intents, [{ do: "write", target: { part: "whiteboard", which: "nearest" }, text: "" }], text);
  }
  assert.deepEqual(one("clear the desk"), { do: "remove", target: { part: "desk", which: "nearest" } }, "no writing: removed");
  assert.deepEqual(one("delete the whiteboard"), { do: "remove", target: { part: "whiteboard", which: "nearest" } });
  assert.deepEqual(one("clear the whole thing"), { do: "clear" });
});

test("Whisper commas and 'between ... and' stay in one clause", () => {
  const villa = parse("Spawn a villa, to my left.");
  assert.deepEqual(villa.intents, [{ do: "spawn", what: { part: "villa" }, place: { rel: "left" } }]);
  assert.ok(villa.confidence >= 0.8);
  assert.deepEqual(one("Give me a sword, in my left hand.").place, { rel: "hand", hand: "left" });
  assert.deepEqual(one("AI, spawn a tree, 20 meters away.").place, { rel: "front", dist: 20 });
  assert.deepEqual(one("Spawn a villa... to my left.").place, { rel: "left" });
  assert.equal(one("Spawn three, uh, crates.").count, 3);
  assert.deepEqual(one("Remove the crate, the one on the left."), { do: "remove", target: { part: "crate", which: "nearest", side: "left" } });
  assert.equal(parse("Put the crate between the tree and the house").intents.length, 1);
  assert.equal(parse("spawn a desk, a chair and a ball").intents.length, 3, "lists still split");
  assert.deepEqual(parse("undo 3, spawn a crate").intents, [{ do: "undo", count: 3 }, { do: "spawn", what: { part: "crate" } }]);
});

test("a side after the target narrows it", () => {
  assert.deepEqual(one("remove the crate on the left"), { do: "remove", target: { part: "crate", which: "nearest", side: "left" } });
  assert.equal(one("remove the crate to my left").target.side, "left");
  assert.deepEqual(one("remove the tree behind me").target, { part: "tree", which: "nearest", side: "behind" });
  assert.deepEqual(one("paint the crate on the left red"), { do: "color", target: { part: "crate", which: "nearest", side: "left" }, color: COLORS.red });
  assert.deepEqual(one("remove the crate on the desk").target, { part: "crate", which: "nearest" }, "object relations are not sides");
});

test("a count of cards means single cards", () => {
  assert.deepEqual(one("AI, give me five cards."), { do: "spawn", what: { part: "playing card" }, count: 5, place: { rel: "hand", hand: "right" } });
  assert.deepEqual(one("spawn five playing cards"), { do: "spawn", what: { part: "playing card" }, count: 5 });
  assert.equal(one("give me cards").what.part, "deck of cards");
  assert.equal(one("spawn a deck of cards").what.part, "deck of cards");
  assert.equal(one("spawn two decks").what.part, "deck of cards");
});

test("typo matches are guesses; real words are not typos", () => {
  const real = allMeta();
  for (const word of ["horse", "mouse", "plane", "chain", "crane", "drill", "beach", "coach", "canyon", "chest", "power"]) {
    const r = parseCommand(`spawn a ${word}`, { metas: real });
    assert.deepEqual(r.unknown, [word], word);
    assert.ok(r.confidence < 0.8, word);
  }
  assert.deepEqual(parseCommand("remove all the stuff", { metas: real }).intents, [{ do: "remove", target: { ref: "all" } }], "not every staff");
  const typo = parse("spawn a vilal");
  assert.deepEqual(typo.intents, [{ do: "spawn", what: { part: "villa" } }]);
  assert.ok(typo.confidence > 0.4 && typo.confidence < 0.8, "a typo is a guess, so the model is asked");
  assert.match(typo.say, /"vilal".*villa/, "and the player is told");
  assert.equal(parse("spawn a villa").say, "");
});

test("unknown verbs before a part do not spawn a copy", () => {
  for (const text of ["hide the crate", "kick the ball", "attack the dummy", "turn the crate around", "make the tree 10 meters tall", "make the crate dark purple"]) {
    assert.deepEqual(parse(text).intents, [], text);
  }
  const chained = parse("spawn a crate and hide the crate");
  assert.deepEqual(chained.intents, [{ do: "spawn", what: { part: "crate" } }]);
  assert.ok(chained.confidence < 0.5);
  for (const text of ["crate", "a crate", "red crate", "a big red crate", "two crates"]) assert.equal(one(text).what.part, "crate", text);
  assert.deepEqual(one("spawn a dragon the size of a house").what, { label: "dragon" }, "unknown nouns still reach the model");
});

test("a distance after a direction keeps the direction", () => {
  assert.deepEqual(one("spawn a tree to my left 20 meters away").place, { rel: "left", dist: 20 });
  assert.deepEqual(one("spawn a crate behind me 10 meters away").place, { rel: "behind", dist: 10 });
  assert.deepEqual(one("spawn a crate 10 feet away").place, { rel: "front", dist: 3.048 });
  assert.deepEqual(one("spawn a crate 20 meters to the left of the tree").place, { rel: "next", side: "left", ref: { part: "tree", which: "nearest" }, dist: 20 });
});
