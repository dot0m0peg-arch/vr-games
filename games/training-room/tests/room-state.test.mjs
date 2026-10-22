// Room state: ops, undo inversion, network validation and the model summary.
import test from "node:test";
import assert from "node:assert/strict";
import { createState, applyOp, invertOp, snapshot, loadState, validateOp, validateRecord, summarize } from "../js/core/room-state.js";

const rec = (id, extra = {}) => ({ id, part: "crate", label: "crate", p: [0, 0, -2], ry: 0, s: 1, by: "u1", t: 1, ...extra });

function seeded() {
  const state = createState();
  applyOp(state, { t: "add", obj: rec("o1") });
  applyOp(state, { t: "add", obj: rec("o2", { part: "card table", label: "card table", p: [2, 0, -3] }) });
  applyOp(state, { t: "add", obj: rec("o3", { part: "deck of cards", label: "deck", p: [2, 0.76, -3], onto: "o2", data: { cards: ["AS", "KD"], faceUp: false } }) });
  applyOp(state, { t: "add", obj: rec("o4", { color: "#ff0000", text: "hi", attach: { user: "u1", hand: "left", grip: "snap" } }) });
  applyOp(state, { t: "env", time: "sunset" });
  return state;
}

// Applying an op and then its inverse must restore the exact snapshot.
function roundTrip(state, op) {
  const before = snapshot(state);
  const inverse = invertOp(state, op);
  applyOp(state, op);
  for (const inv of inverse) applyOp(state, inv);
  assert.deepEqual(snapshot(state), before, `round trip failed for ${JSON.stringify(op)}`);
  return inverse;
}

test("createState shape", () => {
  assert.deepEqual(createState(), { objects: {}, order: [], env: { time: "day" }, seq: 0 });
});

test("applyOp add/set/del/clear/env with events", () => {
  const state = createState();
  let r = applyOp(state, { t: "add", obj: rec("o1") });
  assert.equal(r.changed, true);
  assert.equal(r.events[0].type, "add");
  assert.deepEqual(state.order, ["o1"]);
  const obj = rec("o2");
  applyOp(state, { t: "add", obj });
  obj.p[0] = 99;
  assert.equal(state.objects.o2.p[0], 0, "records are copied, not aliased");

  r = applyOp(state, { t: "set", id: "o1", patch: { p: [1, 2, 3], color: "#00ff00" } });
  assert.equal(r.events[0].type, "update");
  assert.deepEqual(r.events[0].prev, { p: [0, 0, -2], color: null });
  assert.deepEqual(state.objects.o1.p, [1, 2, 3]);
  assert.equal(state.objects.o1.color, "#00ff00");
  applyOp(state, { t: "set", id: "o1", patch: { attach: { user: "u1", hand: "right", grip: "snap" } } });
  assert.equal(state.objects.o1.attach.hand, "right");
  applyOp(state, { t: "set", id: "o1", patch: { attach: null, color: null } });
  assert.equal("attach" in state.objects.o1, false, "attach null removes the key");
  assert.equal("color" in state.objects.o1, false);
  assert.equal(applyOp(state, { t: "set", id: "missing", patch: { s: 2 } }).changed, false, "unknown ids are ignored");

  applyOp(state, { t: "set", id: "o2", patch: { onto: "o1" } });
  r = applyOp(state, { t: "del", ids: ["o1", "nope"] });
  assert.deepEqual(r.events.map((e) => e.type), ["remove", "update"]);
  assert.equal(state.objects.o1, undefined);
  assert.equal(state.objects.o2.onto, undefined, "onto links to deleted ids are removed");
  assert.deepEqual(state.order, ["o2"]);

  r = applyOp(state, { t: "env", time: "night" });
  assert.equal(r.events[0].prev, "day");
  assert.equal(state.env.time, "night");
  assert.equal(applyOp(state, { t: "env", time: "noon" }).changed, false);

  r = applyOp(state, { t: "clear" });
  assert.equal(r.events[0].type, "clear");
  assert.deepEqual(state.objects, {});
  assert.deepEqual(state.order, []);
  assert.equal(applyOp(state, { t: "bogus" }).changed, false);
  assert.equal(applyOp(state, null).changed, false);
});

test("invertOp round-trips every op type to an identical snapshot", () => {
  const state = seeded();
  assert.deepEqual(roundTrip(state, { t: "add", obj: rec("o9", { p: [5, 0, 5] }) }), [{ t: "del", ids: ["o9"] }]);
  roundTrip(state, { t: "add", obj: rec("o1", { p: [7, 0, 7], color: "#123456" }) });
  roundTrip(state, { t: "del", ids: ["o1"] });
  roundTrip(state, { t: "del", ids: ["o2"] });
  roundTrip(state, { t: "del", ids: ["o1", "o3", "o4"] });
  roundTrip(state, { t: "del", ids: ["o4", "o1"] });
  roundTrip(state, { t: "set", id: "o1", patch: { p: [1, 1, 1], ry: 2, s: 3 } });
  roundTrip(state, { t: "set", id: "o1", patch: { color: "#abcdef", text: "new", label: "box" } });
  roundTrip(state, { t: "set", id: "o4", patch: { attach: null, color: null, text: null } });
  roundTrip(state, { t: "set", id: "o3", patch: { data: { cards: [], faceUp: true }, onto: null } });
  roundTrip(state, { t: "set", id: "o1", patch: { attach: { user: "u2", hand: "right", grip: "keep" }, onto: "o2" } });
  roundTrip(state, { t: "clear" });
  roundTrip(state, { t: "env", time: "night" });
  assert.deepEqual(invertOp(state, { t: "set", id: "missing", patch: { s: 2 } }), []);
  assert.deepEqual(invertOp(state, { t: "del", ids: ["missing"] }), []);
});

test("inverse of del restores order and onto links", () => {
  const state = seeded();
  const inverse = invertOp(state, { t: "del", ids: ["o2"] });
  assert.equal(inverse[0].t, "add");
  assert.equal(inverse[0].at, 1);
  assert.deepEqual(inverse[1], { t: "set", id: "o3", patch: { onto: "o2" } });
  const clearInverse = invertOp(state, { t: "clear" });
  assert.equal(clearInverse.length, 4);
  assert.deepEqual(clearInverse.map((op) => op.obj.id), ["o1", "o2", "o3", "o4"]);
});

test("snapshot is a deep copy and loadState validates", () => {
  const state = seeded();
  const snap = snapshot(state);
  snap.objects.o1.p[0] = 42;
  assert.equal(state.objects.o1.p[0], 0);
  const loaded = loadState(JSON.stringify(snapshot(state)));
  assert.deepEqual(snapshot(loaded), snapshot(state));
  const messy = loadState({
    objects: { a: rec("a"), b: { id: "b", part: "crate", p: [NaN, 0, 0] }, c: rec("c", { onto: "gone" }), d: rec("x") },
    order: ["c", "a", "zzz"],
    env: { time: "eclipse" },
    seq: -4,
  });
  assert.deepEqual(messy.order, ["c", "a"]);
  assert.equal(messy.objects.b, undefined, "invalid records are dropped");
  assert.equal(messy.objects.c.onto, undefined, "dangling onto removed");
  assert.equal(messy.env.time, "day");
  assert.equal(messy.seq, 0);
  assert.deepEqual(loadState("not json"), createState());
  assert.deepEqual(loadState(null), createState());
});

test("validateOp accepts good ops and normalizes them", () => {
  let r = validateOp({ t: "add", obj: rec("o1", { extra: "dropped", color: "#AABBCC" }), uid: "u1", by: "u1", junk: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.op.obj.extra, undefined, "unknown keys dropped");
  assert.equal(r.op.junk, undefined);
  assert.equal(r.op.obj.color, "#aabbcc");
  r = validateOp({ t: "set", id: "o1", patch: { p: [1e9, -1e9, 3], s: 900, ry: 7, nonsense: 1 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.op.patch.p, [5000, -5000, 3], "positions clamped to ±5000 m");
  assert.equal(r.op.patch.s, 50, "scale clamped");
  assert.ok(Math.abs(r.op.patch.ry) <= Math.PI);
  assert.equal(r.op.patch.nonsense, undefined);
  assert.equal(validateOp({ t: "set", id: "o1", patch: { s: 0.0001 } }).op.patch.s, 0.02);
  assert.equal(validateOp({ t: "set", id: "o1", patch: { attach: null, color: null } }).ok, true);
  assert.equal(validateOp({ t: "set", id: "o1", patch: {}, fly: { vel: [1, 2, 3], spin: 4 } }).ok, true);
  assert.equal(validateOp({ t: "del", ids: ["o1", "o1", "o2"] }).op.ids.length, 2);
  assert.deepEqual(validateOp({ t: "clear", by: "u1" }).op, { t: "clear", by: "u1" });
  assert.equal(validateOp({ t: "env", time: "dawn" }).ok, true);
  assert.equal(validateOp({ t: "add", obj: rec("o1"), at: 3 }).op.at, 3);
  const long = validateOp({ t: "set", id: "o1", patch: { label: "x".repeat(500), text: "y".repeat(5000) } });
  assert.equal(long.op.patch.label.length, 80);
  assert.equal(long.op.patch.text.length, 2000);
  assert.equal(validateOp({ t: "set", id: "o1", patch: { label: "<b>hi</b>" } }).op.patch.label, "bhi/b");
});

test("validateOp rejects garbage", () => {
  const bad = [
    null, 42, "add", [], {}, { t: "explode" },
    { t: "add" }, { t: "add", obj: { id: "o1" } },
    { t: "add", obj: rec("o1", { p: [NaN, 0, 0] }) },
    { t: "add", obj: rec("o1", { p: [Infinity, 0, 0] }) },
    { t: "add", obj: rec("o1", { p: [0, 0] }) },
    { t: "add", obj: rec("o1", { p: ["1", 0, 0] }) },
    { t: "add", obj: rec("O1!") },
    { t: "add", obj: rec("x".repeat(41)) },
    { t: "add", obj: rec("o1", { color: "<script>alert(1)</script>" }) },
    { t: "add", obj: rec("o1", { color: "red" }) },
    { t: "add", obj: rec("o1", { part: "<img src=x>" }) },
    { t: "add", obj: rec("o1", { data: { blob: "x".repeat(70000) } }) },
    { t: "add", obj: rec("o1", { data: [1, 2, 3] }) },
    { t: "add", obj: rec("o1", { attach: { user: "u1", hand: "foot" } }) },
    { t: "add", obj: rec("o1", { s: NaN }) },
    { t: "add", obj: rec("o1"), at: -1 },
    { t: "set", id: "o1" },
    { t: "set", id: "o1", patch: { color: "javascript:1" } },
    { t: "set", id: "o1", patch: { p: [0, NaN, 0] } },
    { t: "set", id: "o1", patch: { ry: Infinity } },
    { t: "set", id: "o1", patch: { onto: "../../etc" } },
    { t: "set", id: "../x", patch: { s: 1 } },
    { t: "set", id: "o1", patch: { s: 2 }, fly: { vel: [1, 2] } },
    { t: "del", ids: [] },
    { t: "del", ids: "o1" },
    { t: "del", ids: Array.from({ length: 501 }, (_, i) => `o${i}`) },
    { t: "del", ids: ["ok", 5] },
    { t: "env", time: "lunch" },
    { t: "add", obj: rec("o1"), uid: "bad uid" },
  ];
  for (const op of bad) {
    const r = validateOp(op);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(op)?.slice(0, 80)}`);
    assert.equal(r.op, null);
    assert.equal(typeof r.error, "string");
  }
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(validateOp({ t: "set", id: "o1", patch: { data: cyclic } }).ok, false);
});

test("validateRecord defaults and trims", () => {
  const r = validateRecord({ id: "o1", part: " Crate ", p: [0, 0, 0] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.record, { id: "o1", part: "crate", label: "crate", p: [0, 0, 0], ry: 0, s: 1 });
  assert.equal(validateRecord({ id: "o1", part: "custom:dragon-statue", p: [0, 0, 0] }).ok, true);
  assert.equal(validateRecord({ id: "o1", part: "", p: [0, 0, 0] }).ok, false);
});

test("summarize lists nearby objects with directions", () => {
  const state = createState();
  const add = (id, p, extra) => applyOp(state, { t: "add", obj: rec(id, { p, ...extra }) });
  add("f", [0, 0, -3]);
  add("l", [-4, 0, 0]);
  add("r", [5, 0, 0]);
  add("b", [0, 0, 6]);
  add("fl", [-2, 0, -2]);
  add("n", [0, 0.8, -1], { onto: "f", text: "a".repeat(100), attach: { user: "u1", hand: "right", grip: "snap" } });
  const list = summarize(state, { p: [0, 1.6, 0], yaw: 0 });
  const dir = Object.fromEntries(list.map((x) => [x.id, x.dir]));
  assert.deepEqual(dir, { f: "front", l: "left", r: "right", b: "behind", fl: "front-left", n: "front" });
  assert.deepEqual(list.map((x) => x.id), ["n", "fl", "f", "l", "r", "b"], "sorted by distance");
  const n = list.find((x) => x.id === "n");
  assert.equal(n.on, "f");
  assert.equal(n.held, "right");
  assert.equal(n.text.length, 40);
  assert.equal(list.find((x) => x.id === "fl").dist, 2.8);
  const turned = summarize(state, { p: [0, 1.6, 0], yaw: Math.PI / 2 });
  assert.equal(turned.find((x) => x.id === "l").dir, "front", "facing -X puts the left object in front");
  for (let i = 0; i < 60; i++) add(`m${i}`, [i, 0, i]);
  assert.equal(summarize(state, { p: [0, 1.6, 0], yaw: 0 }).length, 40);
});
