// Executor: intents → room ops, applied to a real room state; plus the card helpers.
import test from "node:test";
import assert from "node:assert/strict";
import { planIntents } from "../js/core/execute.js";
import { parseCommand } from "../js/core/parse.js";
import { createState, applyOp, invertOp, snapshot, validateOp } from "../js/core/room-state.js";
import { newDeck, shuffle, cardName, RANKS, SUITS } from "../js/core/cards.js";
import { rng as seeded } from "../js/util/ids.js";
import { COLORS } from "../js/core/lexicon.js";

const grip = { p: [0, 0.1, 0], r: [0, 0, 0] };
const METAS = [
  { name: "villa", aliases: ["mansion"], category: "structures", size: [14, 9, 12] },
  { name: "house", aliases: [], category: "structures", size: [8, 7, 7] },
  { name: "axe", aliases: [], category: "combat", size: [0.3, 0.9, 0.08], holdable: true, grip, tip: [0, 0.85, 0] },
  { name: "sword", aliases: [], category: "combat", size: [0.25, 1.1, 0.05], holdable: true, grip, tip: [0, 1.1, 0] },
  { name: "shield", aliases: [], category: "combat", size: [0.6, 0.6, 0.1], holdable: true, grip },
  { name: "card table", aliases: ["poker table"], category: "leisure", size: [1, 0.78, 1], surface: 0.76, surfaceSize: [0.9, 0.9] },
  { name: "deck of cards", aliases: ["deck of playing cards", "playing cards", "cards", "card deck", "deck"], category: "leisure", size: [0.063, 0.017, 0.088], holdable: true, grip, deck: true },
  { name: "playing card", aliases: ["card"], category: "leisure", size: [0.063, 0.002, 0.088], holdable: true, grip },
  { name: "whiteboard", aliases: [], category: "office", size: [1.8, 1.9, 0.56], writable: true },
  { name: "sticky note", aliases: ["note"], category: "office", size: [0.3, 0.38, 0.1], holdable: true, grip, writable: true },
  { name: "crate", aliases: ["box"], category: "structures", size: [1, 1, 1], surface: 1, surfaceSize: [0.95, 0.95] },
  { name: "training dummy", aliases: ["dummy"], category: "combat", size: [0.6, 1.8, 0.6], hittable: true },
  { name: "tree", aliases: [], category: "nature", size: [4, 6, 4] },
  { name: "chair", aliases: [], category: "office", size: [0.45, 0.9, 0.45] },
  { name: "desk", aliases: [], category: "office", size: [1.6, 0.76, 0.8], surface: 0.76, surfaceSize: [1.56, 0.76] },
  { name: "screen", aliases: ["monitor"], category: "office", size: [2, 1.9, 0.6], screen: true },
  { name: "ball", aliases: [], category: "leisure", size: [0.23, 0.22, 0.22], holdable: true, grip },
];

// A tiny room: plans with the real parser/executor and applies ops like the runner does.
function makeRoom({ player = { p: [0, 1.6, 0], yaw: 0, hands: {} }, user = "u1" } = {}) {
  const state = createState();
  let n = 0;
  const history = [];
  const room = {
    state,
    player: { ...player, user },
    ctx(extra = {}) {
      return {
        state, player: room.player, user, hand: "right", metas: METAS,
        metaOf: (part) => METAS.find((m) => m.name === part),
        newId: (prefix = "o") => `${prefix}${++n}`,
        rng: seeded(7),
        now: () => 1000,
        ...extra,
      };
    },
    plan(intents, extra) {
      return planIntents(intents, room.ctx(extra));
    },
    // Applies a plan like the runner: inverse computed before each op, history for undo.
    run(input, extra) {
      const intents = typeof input === "string" ? parseCommand(input, { metas: METAS }).intents : input;
      const plan = room.plan(intents, extra);
      const inverse = [];
      for (const op of plan.ops) {
        inverse.unshift(...invertOp(state, op));
        applyOp(state, op);
      }
      if (plan.ops.length) history.push(inverse);
      for (let i = 0; i < plan.undo; i++) for (const op of history.pop() || []) applyOp(state, op);
      return plan;
    },
    all: () => state.order.map((id) => state.objects[id]),
    find: (part) => room.all().filter((r) => r.part === part),
  };
  return room;
}

test("cards helpers", () => {
  const deck = newDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
  assert.equal(deck[0], "AS");
  assert.equal(deck[51], "KC");
  assert.equal(RANKS, "A23456789TJQK");
  assert.equal(SUITS, "SHDC");
  const mixed = shuffle(deck, seeded(1));
  assert.equal(mixed.length, 52);
  assert.notDeepEqual(mixed, deck);
  assert.deepEqual([...mixed].sort(), [...deck].sort());
  assert.deepEqual(shuffle(deck, seeded(1)), mixed, "seeded shuffles repeat");
  assert.equal(deck[0], "AS", "shuffle does not mutate its input");
  assert.equal(cardName("TH"), "ten of hearts");
  assert.equal(cardName("AS"), "ace of spades");
  assert.equal(cardName("QD"), "queen of diamonds");
  assert.equal(cardName("2C"), "two of clubs");
  assert.equal(cardName("ZZ"), "card");
});

test("spawn builds full records with absolute poses", () => {
  const room = makeRoom();
  const plan = room.run("ai spawn a villa to my left");
  assert.equal(plan.ops.length, 1);
  const op = plan.ops[0];
  assert.equal(op.t, "add");
  assert.equal(op.by, "u1");
  assert.ok(op.uid.startsWith("u"));
  const villa = op.obj;
  assert.equal(villa.part, "villa");
  assert.equal(villa.label, "villa");
  assert.equal(villa.s, 1);
  assert.equal(villa.by, "u1");
  assert.equal(villa.t, 1000);
  assert.ok(villa.p[0] < -7, "to the left and clear of the player");
  assert.equal(villa.p[1], 0);
  assert.equal(plan.focus, villa.id);
  assert.equal(validateOp(op).ok, true, "planned ops pass the network validator");
  const colored = room.run("spawn a big red crate in front of me").ops[0].obj;
  assert.equal(colored.color, COLORS.red);
  assert.equal(colored.s, 2);
  assert.ok(colored.p[2] < -1);
});

test("deck on a missing card table creates both, in order", () => {
  const room = makeRoom();
  const plan = room.run("Ai spawn a deck of playing cards on a card table.");
  assert.deepEqual(plan.ops.map((op) => op.obj.part), ["card table", "deck of cards"]);
  const [table, deck] = room.all();
  assert.equal(deck.onto, table.id);
  assert.ok(Math.abs(deck.p[1] - 0.76) < 1e-9, "deck sits on the table top");
  assert.equal(deck.data.cards.length, 52);
  assert.equal(new Set(deck.data.cards).size, 52);
  assert.notDeepEqual(deck.data.cards, newDeck(), "deck is shuffled");
  assert.equal(deck.data.faceUp, false);
  // A second deck uses the existing table (within 10 m) and does not overlap the first.
  room.run("spawn a deck of cards on a card table");
  assert.equal(room.find("card table").length, 1);
  const decks = room.find("deck of cards");
  assert.equal(decks.length, 2);
  assert.ok(Math.hypot(decks[0].p[0] - decks[1].p[0], decks[0].p[2] - decks[1].p[2]) > 0.05);
});

test("a far table is not reused for 'a card table' but is for 'the card table'", () => {
  const room = makeRoom();
  room.run([{ do: "spawn", what: { part: "card table" }, place: { rel: "front", dist: 30 } }]);
  room.run("spawn a deck on a card table");
  assert.equal(room.find("card table").length, 2, "nothing within 10 m, so a new table appears");
  const room2 = makeRoom();
  room2.run([{ do: "spawn", what: { part: "card table" }, place: { rel: "front", dist: 30 } }]);
  room2.run("spawn a deck on the card table");
  assert.equal(room2.find("card table").length, 1);
  assert.equal(room2.find("deck of cards")[0].onto, room2.find("card table")[0].id);
  const room3 = makeRoom();
  room3.run("spawn a ball on the desk");
  assert.equal(room3.find("desk").length, 1, "a named support that does not exist yet is created");
});

test("batch references within one command", () => {
  const room = makeRoom();
  room.run("spawn a desk then put a monitor on it");
  const [desk, screen] = room.all();
  assert.equal(desk.part, "desk");
  assert.equal(screen.part, "screen");
  assert.equal(screen.onto, desk.id);
  assert.ok(Math.abs(screen.p[1] - 0.76) < 1e-9);
  room.run("spawn a crate and paint it blue");
  assert.equal(room.find("crate")[0].color, COLORS.blue);
});

test("counts spawn rows perpendicular to the view", () => {
  const room = makeRoom();
  const plan = room.run("spawn three crates");
  assert.equal(plan.ops.length, 3);
  const crates = room.find("crate");
  const zs = crates.map((c) => c.p[2]);
  assert.ok(zs.every((z) => Math.abs(z - zs[0]) < 1e-6), "same depth");
  const xs = crates.map((c) => c.p[0]).sort((a, b) => a - b);
  assert.ok(Math.abs(xs[1] - xs[0] - 1.3) < 1e-3 && Math.abs(xs[2] - xs[1] - 1.3) < 1e-3, "width + 0.3 spacing");
  assert.equal(room.plan([{ do: "spawn", what: { part: "ball" }, count: 99 }]).ops.length, 30, "capped at 30");
});

test("hands: spawn into a hand, hold, drop", () => {
  const room = makeRoom({ player: { p: [0, 1.6, 0], yaw: 0, hands: { right: { p: [0.2, 1.1, -0.3], q: [0, 0, 0, 1] }, left: { p: [-0.2, 1.1, -0.3], q: [0, 0, 0, 1] } } } });
  room.run("ai spawn an axe in my hand");
  const axe = room.find("axe")[0];
  assert.deepEqual(axe.attach, { user: "u1", hand: "right", grip: "snap" });
  assert.deepEqual(axe.p, [0.2, 1.1, -0.3]);
  // A new item in the same hand drops the old one.
  room.run("give me a sword");
  assert.equal(room.find("sword")[0].attach.hand, "right");
  assert.equal(room.find("axe")[0].attach, undefined);
  assert.deepEqual(room.find("axe")[0].p, [0.2, 0, -0.3], "dropped below the hand");
  room.run("put the axe in my left hand");
  assert.equal(room.find("axe")[0].attach.hand, "left");
  room.run("drop what's in my left hand");
  assert.equal(room.find("axe")[0].attach, undefined);
  assert.equal(room.find("sword")[0].attach.hand, "right");
  room.run("let go");
  assert.equal(room.all().filter((r) => r.attach).length, 0);
  const none = room.run("drop it");
  assert.deepEqual(none.ops, []);
  assert.match(none.say.join(" "), /not holding/);
  room.run("give me the shield");
  assert.equal(room.find("shield")[0].attach.hand, "right", "missing holdable is spawned into the hand");
  room.run("give me two swords");
  assert.equal(room.all().filter((r) => r.attach).length, 2, "one sword per hand");
  const tooBig = room.run("ai spawn a villa in my hand");
  assert.match(tooBig.say.join(" "), /too big to hold/);
  assert.equal(room.find("villa")[0].attach, undefined);
  const holdBig = room.run([{ do: "hold", target: { part: "villa" }, hand: "left" }]);
  assert.match(holdBig.say.join(" "), /too big/);
});

test("deal takes cards from the deck and fans them on the table", () => {
  const room = makeRoom();
  room.run("spawn a deck of cards on a card table");
  const deck = room.find("deck of cards")[0];
  const table = room.find("card table")[0];
  const top = deck.data.cards.slice(0, 5);
  const plan = room.run("deal 5 cards");
  assert.equal(plan.ops[0].t, "set");
  assert.equal(room.find("deck of cards")[0].data.cards.length, 47, "deck count drops by 5");
  const cards = room.find("playing card");
  assert.equal(cards.length, 5);
  assert.deepEqual(cards.map((c) => c.data.card), top, "dealt from the top");
  for (const c of cards) {
    assert.equal(c.data.faceUp, true);
    assert.equal(c.onto, table.id);
    assert.ok(c.p[1] >= 0.76 && c.p[1] < 0.8);
    assert.ok(Math.hypot(c.p[0] - table.p[0], c.p[2] - table.p[2]) < 0.45, "on the table top");
  }
  assert.equal(cards[0].label, cardName(cards[0].data.card));
  const xs = cards.map((c) => c.p[0]);
  assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]), "fanned left to right");
  room.run("deal 50 cards");
  assert.equal(room.find("deck of cards")[0].data.cards.length, 0);
  const empty = room.run("deal 1 card");
  assert.match(empty.say.join(" "), /empty/);
  const fresh = makeRoom();
  fresh.run("deal 3 cards");
  assert.equal(fresh.find("deck of cards").length, 1, "dealing without a deck makes one");
  assert.equal(fresh.find("playing card").length, 3);
  assert.equal(fresh.find("deck of cards")[0].data.cards.length, 49);
});

test("shuffle, flip and spawned playing cards", () => {
  const room = makeRoom();
  room.run("spawn a deck of cards");
  const before = room.find("deck of cards")[0].data.cards.slice();
  room.run("shuffle the deck");
  const after = room.find("deck of cards")[0].data.cards;
  assert.equal(after.length, 52);
  assert.notDeepEqual(after, before);
  room.run("deal 2 cards");
  room.run("flip the cards");
  assert.ok(room.find("playing card").every((c) => c.data.faceUp === false));
  room.run("flip");
  assert.ok(room.find("playing card").every((c) => c.data.faceUp === true), "default flips cards near the player");
  const card = room.run("spawn a playing card").ops[0].obj;
  assert.match(card.data.card, /^[A23456789TJQK][SHDC]$/);
  assert.equal(card.data.faceUp, true);
  const noDeck = makeRoom().run("shuffle");
  assert.match(noDeck.say.join(" "), /no deck/);
  const nothing = makeRoom().run("flip");
  assert.match(nothing.say.join(" "), /no cards/);
});

test("move carries things that sit on top", () => {
  const room = makeRoom();
  room.run("spawn a deck of cards on a card table");
  room.run("move the card table to my right");
  const table = room.find("card table")[0];
  const deck = room.find("deck of cards")[0];
  assert.ok(table.p[0] > 1, "table now on the right");
  assert.ok(Math.hypot(deck.p[0] - table.p[0], deck.p[2] - table.p[2]) < 1e-3, "deck moved with it");
  assert.ok(Math.abs(deck.p[1] - 0.76) < 1e-6);
  assert.equal(deck.onto, table.id);
  room.run("put the deck on the crate");
  const crate = room.find("crate")[0];
  assert.ok(crate, "missing support spawned");
  assert.equal(room.find("deck of cards")[0].onto, crate.id);
  assert.ok(Math.abs(room.find("deck of cards")[0].p[1] - 1) < 1e-6);
  room.run("bring the dummy here");
  assert.equal(room.find("training dummy").length, 1, "move with spawnIfMissing spawns the target");
  const missing = room.run([{ do: "move", target: { part: "villa" }, place: { rel: "left" } }]);
  assert.match(missing.say.join(" "), /can't find a villa/);
  assert.equal(missing.errors.length, 1);
});

test("scale, color, remove", () => {
  const room = makeRoom();
  room.run("spawn a tree");
  room.run("make the tree bigger");
  assert.equal(room.find("tree")[0].s, 1.5);
  room.run("make it half the size");
  assert.equal(room.find("tree")[0].s, 0.75);
  room.run([{ do: "scale", target: { part: "tree" }, factor: 1000 }]);
  assert.equal(room.find("tree")[0].s, 20, "scale clamped");
  room.run("color the tree white");
  assert.equal(room.find("tree")[0].color, COLORS.white);
  const badColor = room.run([{ do: "color", target: { part: "tree" }, color: "sparkly" }]);
  assert.match(badColor.say.join(" "), /color/);
  room.run("spawn a card table and put a deck of cards on it");
  room.run("make the card table twice as big");
  const deck = room.find("deck of cards")[0];
  assert.ok(Math.abs(deck.p[1] - 1.52) < 1e-6, "things on top rise with the surface");
  room.run("remove the card table");
  assert.equal(room.find("card table").length, 0);
  assert.equal(room.find("deck of cards")[0].p[1], 0, "things on top fall to the grass");
  assert.equal(room.find("deck of cards")[0].onto, undefined);
  room.run("spawn three crates");
  room.run("get rid of all the crates");
  assert.equal(room.find("crate").length, 0);
  room.run("remove everything");
  assert.equal(room.all().length, 0);
  const gone = room.run("remove the villa");
  assert.match(gone.say.join(" "), /can't find a villa/);
});

test("write on writable things or sticky notes", () => {
  const room = makeRoom();
  room.run("write buy milk");
  const note = room.find("sticky note")[0];
  assert.equal(note.text, "buy milk", "no writable nearby: a sticky note appears");
  room.run("spawn a whiteboard to my left");
  room.run("write Ship it on the whiteboard");
  assert.equal(room.find("whiteboard")[0].text, "Ship it");
  room.run("write Plan B");
  const texts = room.all().map((r) => r.text).filter(Boolean);
  assert.ok(texts.includes("Plan B"), "nearest writable gets the text");
  room.run("spawn a crate to my right");
  const crateNote = room.run([{ do: "write", target: { part: "crate" }, text: "fragile" }]);
  assert.match(crateNote.say.join(" "), /sticky note/);
  assert.ok(room.find("sticky note").some((n) => n.text === "fragile"));
  room.run("take a note call Sam at 5");
  assert.ok(room.find("sticky note").some((n) => n.text === "call Sam at 5"));
});

test("with a design path, unknown things become a designing placeholder instead of a crate", () => {
  const room = makeRoom();
  const plan = room.run("spawn a machine gun in my hand", { design: true });
  const obj = plan.ops[0].obj;
  assert.equal(obj.part, "designing");
  assert.equal(obj.label, "machine gun");
  assert.deepEqual(obj.data, { designing: "machine gun" });
  assert.deepEqual(plan.say, [], "no \"I don't have\" while it is being designed");
  assert.equal(obj.attach?.hand, "right", "the placeholder is holdable, so it goes in the hand");
  assert.equal(validateOp(plan.ops[0]).ok, true);
  const known = room.run("spawn a crate", { design: true });
  assert.equal(known.ops[0].obj.part, "crate", "catalog parts are not designed");
});

test("unknown parts and custom blueprints", () => {
  const room = makeRoom();
  const plan = room.run("spawn a dragon statue");
  const obj = plan.ops[0].obj;
  assert.equal(obj.part, "dragon statue");
  assert.equal(obj.label, "dragon statue");
  assert.deepEqual(obj.data, { unknown: true });
  assert.deepEqual(plan.say, ["I don't have a dragon statue in the parts bin yet."]);
  assert.equal(validateOp(plan.ops[0]).ok, true);
  const custom = room.run([{ do: "spawn", what: { label: "Rubber Duck", custom: { name: "rubber duck", holdable: true, parts: [{ shape: "sphere", p: [0, 0.1, 0], s: 0.2, color: "yellow" }] } }, place: { rel: "hand" } }]);
  const duck = custom.ops[0].obj;
  assert.equal(duck.part, "custom:rubber-duck");
  assert.equal(duck.label, "Rubber Duck");
  assert.equal(duck.data.blueprint.parts.length, 1);
  assert.deepEqual(duck.attach, { user: "u1", hand: "right", grip: "snap" }, "small blueprints are holdable");
  assert.equal(validateOp(custom.ops[0]).ok, true);
  room.run("remove the rubber duck");
  assert.equal(room.all().filter((r) => r.part.startsWith("custom:")).length, 0, "custom parts are found by label");
  const alias = room.plan([{ do: "spawn", what: { part: "deck of playing cards" } }]);
  assert.equal(alias.ops[0].obj.part, "deck of cards", "model aliases resolve to catalog names");
});

test("time, clear, undo, say, list and bad intents", () => {
  const room = makeRoom();
  room.run("make it night");
  assert.equal(room.state.env.time, "night");
  room.run([{ do: "time", value: "evening" }]);
  assert.equal(room.state.env.time, "sunset");
  assert.match(room.plan([{ do: "time", value: "teatime" }]).errors[0], /time/);
  room.run("spawn a crate and a tree");
  assert.equal(room.plan([{ do: "clear" }]).ops[0].t, "clear");
  assert.equal(room.plan(parseCommand("undo 3 times", { metas: METAS }).intents).undo, 3);
  assert.equal(room.plan([{ do: "undo" }]).undo, 1);
  assert.deepEqual(room.plan([{ do: "say", text: "hello" }]).say, ["hello"]);
  const list = room.plan([{ do: "list" }]).say[0];
  assert.match(list, /Structures: villa/);
  assert.match(list, /17 parts/);
  const bad = room.plan([{ do: "explode" }, null, { do: "spawn", what: { part: "crate" } }]);
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.ops.length, 1, "bad intents do not stop the rest");
  const it = room.plan([{ do: "remove", target: { ref: "it" } }]);
  assert.equal(it.ops[0].ids[0], room.find("tree")[0].id, "'it' is the last thing this user made");
});

test("magic marker: animate and erase", () => {
  const room = makeRoom();
  room.run("spawn a ball");
  room.run("make it bounce");
  assert.deepEqual(room.find("ball")[0].data, { behavior: { kind: "bounce", speed: 1 } });
  room.run("make the ball spin fast");
  assert.deepEqual(room.find("ball")[0].data.behavior, { kind: "spin", speed: 2 });
  room.run("stop moving");
  assert.equal(room.find("ball")[0].data, undefined, "none removes the behavior");
  assert.match(room.plan([{ do: "animate", target: { ref: "it" }, behavior: "teleport" }]).say.join(" "), /don't know/);
  const drawing = (id, by, p) => ({ t: "add", obj: { id, part: "drawing", label: "drawing", p, ry: 0, s: 1, by, data: { strokes: [] } } });
  applyOp(room.state, drawing("d1", "u1", [0, 1, -2]));
  applyOp(room.state, drawing("d2", "u2", [0, 1, -1]));
  applyOp(room.state, drawing("d3", "u1", [0, 1, -40]));
  room.run("erase the drawing");
  assert.equal(room.state.objects.d1, undefined, "my latest drawing within 15 m");
  assert.ok(room.state.objects.d2 && room.state.objects.d3);
  room.run("wipe it");
  assert.equal(room.state.objects.d2, undefined, "then the nearest one");
  const none = room.run("erase the drawing");
  assert.match(none.say.join(" "), /no drawing/);
  const deferred = room.plan([{ do: "realize" }, { do: "guess" }, { do: "correct", label: "gun" }]);
  assert.equal(deferred.ops.length, 0);
  assert.equal(deferred.errors.length, 3, "model-only intents are left to the runner");
  assert.deepEqual(deferred.say, []);
});

test("magic marker: animate things by their realized label, erase every drawing", () => {
  const room = makeRoom();
  applyOp(room.state, { t: "add", obj: { id: "f1", part: "custom:fish", label: "fish", p: [0, 0, -3], ry: 0, s: 1, by: "u1" } });
  applyOp(room.state, { t: "add", obj: { id: "f2", part: "custom:fish", label: "fish", p: [2, 0, -3], ry: 0, s: 1, by: "u1" } });
  room.run("make the fish swim");
  assert.deepEqual(room.state.objects.f1.data, { behavior: { kind: "swim", speed: 1 } }, "the nearest fish");
  assert.equal(room.state.objects.f2.data, undefined);
  room.run("make all the fish fly fast");
  assert.deepEqual(room.state.objects.f2.data.behavior, { kind: "fly", speed: 2 });
  room.run("make the fish stop moving");
  assert.equal(room.state.objects.f1.data, undefined);
  const drawing = (id, p) => ({ t: "add", obj: { id, part: "drawing", label: "drawing", p, ry: 0, s: 1, by: "u1", data: { strokes: [] } } });
  applyOp(room.state, drawing("d1", [0, 1, -2]));
  applyOp(room.state, drawing("d2", [3, 1, -2]));
  room.run("erase all the drawings");
  assert.equal(room.find("drawing").length, 0);
  assert.equal(room.all().length, 2, "the fish stay");
});

test("undo inverts whole commands back to identical snapshots", () => {
  const room = makeRoom();
  const commands = [
    "spawn a card table and put a deck of cards on it",
    "deal 5 cards",
    "move the card table to my left",
    "make the card table bigger",
    "give me an axe",
    "drop it",
    "paint the crate red",
    "spawn a crate",
    "paint the crate red",
    "flip the cards",
    "remove the card table",
    "make it night",
    "write hello",
    "make the crate spin",
    "make the crate stop",
    "clear everything",
  ];
  // Commands without ops (the first "paint the crate red": no crate yet) add no history entry.
  const snapshots = [snapshot(room.state)];
  const done = [];
  for (const text of commands) {
    if (!room.run(text).ops.length) continue;
    done.push(text);
    snapshots.push(snapshot(room.state));
  }
  assert.equal(done.length, commands.length - 1);
  for (let i = done.length - 1; i >= 0; i--) {
    room.run([{ do: "undo" }]);
    assert.deepEqual(snapshot(room.state), snapshots[i], `undo of "${done[i]}"`);
  }
});

test("planning never mutates the caller's state", () => {
  const room = makeRoom();
  room.run("spawn a deck of cards on a card table");
  const before = snapshot(room.state);
  room.plan(parseCommand("deal 5 cards and move the card table to my left and clear everything", { metas: METAS }).intents);
  assert.deepEqual(snapshot(room.state), before);
});

test("wiping a board clears its text and keeps everything else", () => {
  const room = makeRoom();
  room.run("spawn a whiteboard");
  room.run("spawn a villa to my left");
  room.run("write Q3 goals on the whiteboard");
  room.run("AI, clear the board.");
  assert.equal(room.all().length, 2, "nothing is removed");
  assert.equal(room.find("whiteboard")[0].text, undefined);
  room.run("write Q4 goals on the whiteboard");
  room.run("erase the whiteboard");
  assert.equal(room.find("whiteboard").length, 1);
  assert.equal(room.find("whiteboard")[0].text, undefined);
  const blank = room.run("wipe the whiteboard");
  assert.deepEqual(blank.ops, []);
  assert.match(blank.say.join(" "), /already blank/);
  room.run("undo");
  assert.equal(room.find("whiteboard")[0].text, "Q4 goals", "undo brings the text back");
  assert.match(makeRoom().run("clear the board").say.join(" "), /no writing/);
  assert.match(makeRoom().run([{ do: "write", target: { part: "whiteboard" }, text: "" }]).say.join(" "), /can't find a whiteboard/);
});

test("a side picks the object on that side of the player", () => {
  const room = makeRoom();
  room.run([
    { do: "spawn", what: { part: "crate" }, place: { rel: "at", p: [-3, 0, 0] } },
    { do: "spawn", what: { part: "crate" }, place: { rel: "at", p: [0, 0, -1.45] } },
    { do: "spawn", what: { part: "tree" }, place: { rel: "at", p: [0, 0, -6] } },
    { do: "spawn", what: { part: "tree" }, place: { rel: "at", p: [0, 0, 8] } },
  ]);
  const [left, front] = room.find("crate");
  room.run("paint the crate on the left red");
  assert.equal(room.find("crate").find((r) => r.id === left.id).color, COLORS.red);
  assert.equal(room.find("crate").find((r) => r.id === front.id).color, undefined);
  const none = room.run("remove the crate on the right");
  assert.deepEqual(none.ops, []);
  assert.match(none.say.join(" "), /can't find a crate on your right/);
  room.run("Remove the crate, the one on the left.");
  assert.deepEqual(room.find("crate").map((r) => r.id), [front.id], "only the left crate goes");
  assert.equal(room.find("tree").length, 2);
  room.run("remove the tree behind me");
  assert.deepEqual(room.find("tree").map((r) => r.p[2]), [-6]);
});

test("model placements with a ref: a direction beside it, above over it, next at a distance", () => {
  const room = makeRoom();
  room.run([
    { do: "spawn", what: { part: "villa" }, place: { rel: "at", p: [0, 0, -30] } },
    { do: "spawn", what: { part: "desk" }, place: { rel: "at", p: [5, 0, 0] } },
  ]);
  room.run([{ do: "spawn", what: { part: "chair" }, place: { rel: "right", ref: { part: "villa" } } }]);
  assert.deepEqual(room.find("chair")[0].p, [7.525, 0, -30], "beside the villa, not the player");
  room.run([{ do: "spawn", what: { part: "ball" }, place: { rel: "above", ref: { part: "desk" } } }]);
  assert.deepEqual(room.find("ball")[0].p, [5, 1.76, 0], "1 m over the desk top");
  room.run("spawn a crate 20 meters to the left of the villa");
  assert.deepEqual(room.find("crate")[0].p, [-20, 0, -30]);
  room.run("spawn a tree to my left 20 meters away");
  assert.deepEqual(room.find("tree")[0].p, [-20, 0, 0]);
});

test("percent scaling and a count of cards", () => {
  const room = makeRoom();
  room.run("spawn a tree");
  room.run("grow the tree by 20%");
  assert.equal(room.find("tree")[0].s, 1.2);
  room.run("shrink it by 50%");
  assert.equal(room.find("tree")[0].s, 0.6);
  room.run("scale it down by 2");
  assert.equal(room.find("tree")[0].s, 0.3);
  room.run("give me five cards");
  assert.equal(room.find("playing card").length, 5);
  assert.equal(room.find("deck of cards").length, 0, "no decks");
});
