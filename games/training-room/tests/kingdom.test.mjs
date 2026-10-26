// Kingdom mode: advisor addressing, realm questions and report, pointed placement, villagers.
import test from "node:test";
import assert from "node:assert/strict";
import { ADVISORS, ADVISOR_WORDS, addressAdvisor, kingdomQuery, kingdomStats, kingdomReport, kingdomAdvice, advisorAck, WORTH } from "../js/core/kingdom.js";
import { resolvePlacement } from "../js/core/place.js";
import { parseCommand } from "../js/core/parse.js";
import { planIntents } from "../js/core/execute.js";
import { createState } from "../js/core/room-state.js";
import { allMeta, getMeta } from "../js/parts/meta/index.js";
import { rng as seeded } from "../js/util/ids.js";

test("advisors are addressed by any of their titles, with or without a greeting", () => {
  const cases = [
    ["Builder, build a house right here", "builder", "build a house right here"],
    ["hey builder build a castle", "builder", "build a castle"],
    ["Architect: put a well next to the house", "builder", "put a well next to the house"],
    ["Steward, how is the kingdom?", "steward", "how is the kingdom?"],
    ["treasurer how much gold do we have", "steward", "how much gold do we have"],
    ["Marshal, how are our defenses", "marshal", "how are our defenses"],
    ["General build a wall", "marshal", "build a wall"],
    ["advisors, what should we build next", "steward", "what should we build next"],
  ];
  for (const [text, id, rest] of cases) {
    const got = addressAdvisor(text);
    assert.equal(got.advisor?.id, id, text);
    assert.equal(got.rest, rest, text);
  }
  for (const text of ["build a house", "AI, spawn a crate", "builders yard is empty", "the general store"]) {
    assert.equal(addressAdvisor(text).advisor, null, text);
  }
  assert.ok(ADVISOR_WORDS.includes("builder") && ADVISOR_WORDS.includes("steward") && ADVISOR_WORDS.includes("marshal"));
});

test("realm questions are recognized and commands are not", () => {
  assert.equal(kingdomQuery("how is the kingdom?"), "all");
  assert.equal(kingdomQuery("give me a report"), "all");
  assert.equal(kingdomQuery("how many peasants do we have"), "people");
  assert.equal(kingdomQuery("how much gold is in the treasury"), "gold");
  assert.equal(kingdomQuery("is there enough food"), "food");
  assert.equal(kingdomQuery("how are our defenses"), "defense");
  assert.equal(kingdomQuery("what should we build next"), "advice");
  for (const text of ["build a house right here", "spawn a farm field", "what can you build", "put a wall to my left", ""]) {
    assert.equal(kingdomQuery(text), null, text);
  }
});

test("the realm report counts buildings and advises the next build", () => {
  assert.match(kingdomReport(kingdomStats([])), /empty land/);
  assert.equal(kingdomAdvice(kingdomStats([{ part: "house" }])).part, "castle");
  const stats = kingdomStats([
    { part: "castle" }, { part: "house" }, { part: "house" }, { part: "farm field" }, { part: "peasant" },
    { part: "axe", attach: { user: "u", hand: "right" } }, { part: "crate" },
  ]);
  assert.deepEqual(stats, { homes: 32, food: 10, gold: 6, defense: 15, faith: 0, buildings: 4, peasants: 1, castle: true });
  assert.equal(kingdomAdvice(stats).part, "farm field");
  assert.match(kingdomReport(stats, "food"), /only 10 of 32/);
  assert.match(kingdomReport(stats), /^10 peasants, 32 homes/);
  const fed = kingdomStats([{ part: "castle" }, { part: "farm field" }, { part: "farm field" }, { part: "windmill" }, { part: "wall" }, { part: "tower" }, { part: "market stall" }, { part: "market stall" }]);
  assert.equal(kingdomAdvice(fed).part, "chapel");
  // Every part the report counts is a real catalog part.
  for (const part of Object.keys(WORTH)) assert.ok(getMeta(part), `WORTH lists unknown part ${part}`);
});

test("acknowledgements vary by seed and stay in character", () => {
  for (const advisor of ADVISORS) {
    assert.ok(advisor.acks.length >= 3);
    assert.notEqual(advisorAck(advisor, 0), advisorAck(advisor, 1));
    assert.equal(advisorAck(advisor, 5), advisorAck(advisor, 5));
  }
});

const SIZES = { house: [7.84, 6.92, 7.35], castle: [16, 15.3, 16] };
const sizeOf = (r) => SIZES[r.part];
const ctx = (player, part, records = []) => ({ player, size: SIZES[part], records, sizeOf, metaOf: () => null, batch: [], hand: "right" });

test("'here' and 'over there' land on the pointed ground spot when the player points", () => {
  const player = { user: "u1", p: [0, 1.6, 0], yaw: 0, aimHere: true, aim: [12, 0, -20] };
  const here = resolvePlacement({ rel: "here" }, ctx(player, "house"));
  assert.deepEqual(here.p, [12, 0, -20]);
  const there = resolvePlacement(parseCommand("build a house over there", { metas: allMeta() }).intents[0].place, ctx(player, "house"));
  assert.deepEqual(there.p, [12, 0, -20]);
  // Plain "in front" ignores the pointer.
  const front = resolvePlacement({ rel: "front" }, ctx(player, "house"));
  assert.notDeepEqual(front.p, [12, 0, -20]);
});

test("a pointed spot too close to the player or inside a building is pushed clear", () => {
  const near = resolvePlacement({ rel: "here" }, ctx({ user: "u1", p: [0, 1.6, 0], yaw: 0, aimHere: true, aim: [0, 0, -1] }, "castle"));
  assert.ok(Math.hypot(near.p[0], near.p[2]) > 8, `castle center ${near.p} too close to the player`);
  const records = [{ id: "h1", part: "house", p: [0, 0, -20], ry: 0, s: 1 }];
  const busy = resolvePlacement({ rel: "here" }, ctx({ user: "u1", p: [0, 1.6, 0], yaw: 0, aimHere: true, aim: [0, 0, -20] }, "house", records));
  assert.ok(Math.hypot(busy.p[0], busy.p[2] + 20) > 5, "second house overlaps the first");
});

test("outside Kingdom mode 'here' stays next to the player; 'over there' follows the pointer", () => {
  const pose = { user: "u1", p: [0, 1.6, 0], yaw: 0, aim: [0, 0, -40] };
  const here = resolvePlacement({ rel: "here" }, ctx(pose, "crate"));
  assert.ok(Math.hypot(here.p[0], here.p[2]) < 3, `"bring the crate to me" went to ${here.p}`);
  const there = resolvePlacement({ rel: "front", dist: 6, point: true }, ctx(pose, "crate"));
  assert.deepEqual(there.p, [0, 0, -40]);
});

test("without a pointer, or pointing too far away, 'here' keeps its old meaning", () => {
  const plain = resolvePlacement({ rel: "here" }, ctx({ user: "u1", p: [0, 1.6, 0], yaw: 0 }, "house"));
  const far = resolvePlacement({ rel: "here" }, ctx({ user: "u1", p: [0, 1.6, 0], yaw: 0, aimHere: true, aim: [0, 0, -500] }, "house"));
  assert.deepEqual(far.p, plain.p);
  assert.ok(plain.p[2] < 0 && plain.p[2] > -8);
});

test("spawned peasants wander (walk behavior) and buildings do not", () => {
  const state = createState();
  let n = 0;
  const plan = planIntents(parseCommand("build two peasants and a castle", { metas: allMeta() }).intents, {
    state, player: { user: "u1", p: [0, 1.6, 0], yaw: 0, hands: {} }, user: "u1", hand: "right", metas: allMeta(),
    metaOf: getMeta, newId: (p = "o") => `${p}${++n}`, rng: seeded(3), now: () => 1,
  });
  const adds = plan.ops.filter((op) => op.t === "add").map((op) => op.obj);
  assert.equal(adds.filter((r) => r.part === "peasant").length, 2);
  for (const r of adds) {
    if (r.part === "peasant") assert.deepEqual(r.data.behavior, { kind: "walk", speed: 1 });
    else assert.equal(r.data?.behavior, undefined);
  }
});
