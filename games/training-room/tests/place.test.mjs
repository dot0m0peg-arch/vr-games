// Placement geometry: directions relative to the player, distances, surfaces, overlap avoidance.
import test from "node:test";
import assert from "node:assert/strict";
import { resolvePlacement, forwardOf, rightOf, faceYaw, findRef } from "../js/core/place.js";

const METAS = {
  villa: { name: "villa", size: [14, 9, 12] },
  crate: { name: "crate", size: [1, 1, 1], surface: 1, surfaceSize: [0.95, 0.95] },
  "card table": { name: "card table", size: [1, 0.78, 1], surface: 0.76, surfaceSize: [0.9, 0.9] },
  "deck of cards": { name: "deck of cards", size: [0.063, 0.017, 0.088] },
  chair: { name: "chair", size: [0.45, 0.9, 0.45] },
  ball: { name: "ball", size: [0.23, 0.22, 0.22] },
};
const metaOf = (part) => METAS[part];
const sizeOf = (r) => METAS[r.part].size.map((n) => n * (r.s || 1));
const rec = (id, part, p, extra = {}) => ({ id, part, label: part, p, ry: 0, s: 1, ...extra });
const ctxFor = (player, part, records = [], extra = {}) => ({ player, size: METAS[part].size, records, sizeOf, metaOf, batch: [], hand: "right", ...extra });
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const flat = (p, head) => [p[0] - head[0], p[2] - head[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[2];

test("forward, right and faceYaw follow the three.js yaw convention", () => {
  assert.deepEqual(forwardOf(0).map(Math.round), [0, 0, -1]);
  assert.deepEqual(rightOf(0).map(Math.round), [1, 0, 0]);
  const f = forwardOf(Math.PI / 2);
  assert.ok(near(f[0], -1) && near(f[2], 0), "yaw +90° looks toward -X");
  const r = rightOf(Math.PI / 2);
  assert.ok(near(r[0], 0) && near(r[2], -1));
  // An object at the origin facing a point on +Z has yaw 0; facing +X has yaw +90°.
  assert.ok(near(faceYaw([0, 0, 0], [0, 0, 5]), 0));
  assert.ok(near(faceYaw([0, 0, 0], [5, 0, 0]), Math.PI / 2));
  assert.ok(near(Math.abs(faceYaw([0, 0, 0], [0, 0, -5])), Math.PI));
  assert.equal(faceYaw([1, 0, 1], [1, 5, 1]), 0);
});

test("left really is the player's left for any yaw", () => {
  for (const yaw of [0, 0.7, Math.PI / 2, 2.5, Math.PI, -1.2, -Math.PI / 2]) {
    const player = { user: "u1", p: [3, 1.6, -2], yaw };
    const res = resolvePlacement({ rel: "left" }, ctxFor(player, "crate"));
    const v = flat(res.p, player.p);
    const left = [-rightOf(yaw)[0], 0, -rightOf(yaw)[2]];
    const fwd = forwardOf(yaw);
    assert.ok(dot(v, left) > 1.3, `yaw ${yaw}: left component ${dot(v, left)}`);
    assert.ok(Math.abs(dot(v, fwd)) < 1e-3, `yaw ${yaw}: no forward drift`);
    assert.equal(res.p[1], 0);
    const right = resolvePlacement({ rel: "right" }, ctxFor(player, "crate"));
    assert.ok(dot(flat(right.p, player.p), rightOf(yaw)) > 1.3);
    const behind = resolvePlacement({ rel: "behind" }, ctxFor(player, "crate"));
    assert.ok(dot(flat(behind.p, player.p), fwd) < -1.3);
    // Objects turn their front (+Z) toward the player.
    const toPlayer = [player.p[0] - res.p[0], player.p[2] - res.p[2]];
    const front = [Math.sin(res.ry), Math.cos(res.ry)];
    assert.ok(toPlayer[0] * front[0] + toPlayer[1] * front[1] > 0.99 * Math.hypot(...toPlayer));
  }
});

test("default distances grow with object size", () => {
  const player = { user: "u1", p: [0, 1.6, 0], yaw: 0 };
  const villa = resolvePlacement({ rel: "left" }, ctxFor(player, "villa"));
  assert.ok(Math.hypot(...flat(villa.p, player.p)) > 7, "villa to my left is far enough to not swallow the player");
  assert.ok(near(Math.hypot(...flat(villa.p, player.p)), 8));
  const crate = resolvePlacement({ rel: "front" }, ctxFor(player, "crate"));
  assert.ok(near(crate.p[2], -1.5));
  const ball = resolvePlacement({}, ctxFor(player, "ball"));
  assert.ok(near(ball.p[2], -1.4), "default rel is front, min 1.4 m");
  const far = resolvePlacement({ rel: "far" }, ctxFor(player, "crate"));
  assert.ok(near(far.p[2], -20));
  const farVilla = resolvePlacement({ rel: "far" }, ctxFor(player, "villa"));
  assert.ok(near(farVilla.p[2], -20));
  const here = resolvePlacement({ rel: "here" }, ctxFor(player, "ball"));
  assert.ok(near(here.p[2], -0.7));
  const feet = resolvePlacement({ rel: "feet" }, ctxFor(player, "ball"));
  assert.ok(near(feet.p[2], -0.7) && feet.p[1] === 0);
  const dist = resolvePlacement({ rel: "right", dist: 5 }, ctxFor(player, "crate"));
  assert.ok(near(dist.p[0], 5) && near(dist.p[2], 0));
  const tooClose = resolvePlacement({ rel: "front", dist: 1 }, ctxFor(player, "villa"));
  assert.ok(Math.hypot(...flat(tooClose.p, player.p)) >= 7.3 - 1e-6, "dist never puts the player inside the object");
});

test("above, hand and at", () => {
  const player = { user: "u9", p: [0, 1.6, 0], yaw: 0, hands: { left: { p: [-0.3, 1.1, -0.3], q: [0, 0, 0, 1] }, right: null } };
  const above = resolvePlacement({ rel: "above" }, ctxFor(player, "ball"));
  assert.ok(near(above.p[1], 2.8) && near(above.p[2], -1.5));
  const left = resolvePlacement({ rel: "hand", hand: "left" }, ctxFor(player, "ball"));
  assert.deepEqual(left.attach, { user: "u9", hand: "left", grip: "snap" });
  assert.deepEqual(left.p, [-0.3, 1.1, -0.3]);
  const right = resolvePlacement({ rel: "hand" }, ctxFor(player, "ball"));
  assert.equal(right.attach.hand, "right");
  assert.ok(near(right.p[2], -0.4), "unknown hand pose: 0.4 m in front of the head");
  const at = resolvePlacement({ rel: "at", p: [4, 0, 4] }, ctxFor(player, "crate"));
  assert.deepEqual(at.p, [4, 0, 4]);
  const atBad = resolvePlacement({ rel: "at", p: [NaN, 0, 1] }, ctxFor(player, "crate"));
  assert.ok(Number.isFinite(atBad.p[0]));
});

test("on: sits on the surface height and does not overlap earlier items", () => {
  const player = { user: "u1", p: [0, 1.6, 0], yaw: 0 };
  const table = rec("t1", "card table", [0, 0, -2], { ry: 0.3 });
  const res = resolvePlacement({ rel: "on", ref: { id: "t1" } }, ctxFor(player, "deck of cards", [table]));
  assert.equal(res.onto, "t1");
  assert.ok(near(res.p[1], 0.76), "y equals the surface height");
  assert.ok(near(res.p[0], 0) && near(res.p[2], -2), "centered on the table");
  assert.ok(near(res.ry, 0.3), "takes the table's yaw");
  const scaled = { ...table, s: 2 };
  assert.ok(near(resolvePlacement({ rel: "on", ref: { id: "t1" } }, ctxFor(player, "deck of cards", [scaled])).p[1], 1.52));
  const raised = { ...table, p: [0, 1, -2] };
  assert.ok(near(resolvePlacement({ rel: "on", ref: { id: "t1" } }, ctxFor(player, "deck of cards", [raised])).p[1], 1.76));
  const deck = rec("d1", "deck of cards", [0, 0.76, -2], { onto: "t1", ry: 0.3 });
  const second = resolvePlacement({ rel: "on", ref: { id: "t1" } }, ctxFor(player, "deck of cards", [table, deck]));
  assert.equal(second.onto, "t1");
  assert.ok(Math.hypot(second.p[0] - deck.p[0], second.p[2] - deck.p[2]) >= 0.06, "second item is offset");
  assert.ok(Math.hypot(second.p[0], second.p[2] + 2) <= 0.45, "and still on the table top");
  const byPart = resolvePlacement({ rel: "on", ref: { part: "card table" } }, ctxFor(player, "deck of cards", [table]));
  assert.equal(byPart.onto, "t1");
  const crate = rec("c1", "crate", [3, 0, 0]);
  const stacked = resolvePlacement({ rel: "on", ref: { id: "c1" } }, ctxFor(player, "crate", [crate]));
  assert.ok(near(stacked.p[1], 1) && near(stacked.p[0], 3));
  const missing = resolvePlacement({ rel: "on", ref: { id: "nope" } }, ctxFor(player, "crate", []));
  assert.equal(missing.onto, undefined);
  assert.ok(near(missing.p[2], -1.5), "missing ref falls back to front");
  const batchRef = resolvePlacement({ rel: "on", ref: { batch: 0 } }, ctxFor(player, "deck of cards", [table], { batch: [table] }));
  assert.equal(batchRef.onto, "t1");
});

test("next: beside the reference on the requested side", () => {
  const player = { user: "u1", p: [0, 1.6, 0], yaw: 0 };
  const villa = rec("v1", "villa", [0, 0, -20]);
  const res = resolvePlacement({ rel: "next", ref: { id: "v1" } }, ctxFor(player, "chair", [villa]));
  assert.ok(res.p[0] < -7, `left of the villa as seen by the player (x=${res.p[0]})`);
  assert.ok(near(res.p[0], -(7 + 0.3 + 0.225)));
  assert.ok(near(res.p[2], -20));
  const right = resolvePlacement({ rel: "next", side: "right", ref: { id: "v1" } }, ctxFor(player, "chair", [villa]));
  assert.ok(right.p[0] > 7);
  const front = resolvePlacement({ rel: "next", side: "front", ref: { id: "v1" } }, ctxFor(player, "chair", [villa]));
  assert.ok(front.p[2] > -14 && front.p[2] < -13, "between the villa and the player");
  const behind = resolvePlacement({ rel: "next", side: "behind", ref: { id: "v1" } }, ctxFor(player, "chair", [villa]));
  assert.ok(behind.p[2] < -26);
});

test("ground placements push past existing footprints", () => {
  const player = { user: "u1", p: [0, 1.6, 0], yaw: 0 };
  const blocker = rec("c1", "crate", [0, 0, -1.5]);
  const res = resolvePlacement({ rel: "front" }, ctxFor(player, "crate", [blocker]));
  assert.ok(res.p[2] <= -2.5 + 1e-6, `pushed beyond the crate (z=${res.p[2]})`);
  assert.ok(near(res.p[0], 0), "along the same direction");
  assert.ok(near(((-res.p[2] - 1.5) / 0.5) % 1, 0), "in 0.5 m steps");
  const row = [rec("a", "crate", [0, 0, -1.5]), rec("b", "crate", [0, 0, -2.5]), rec("c", "crate", [0, 0, -3.5])];
  const pushed = resolvePlacement({ rel: "front" }, ctxFor(player, "crate", row));
  assert.ok(pushed.p[2] <= -4.5 + 1e-6);
  const excluded = resolvePlacement({ rel: "front" }, ctxFor(player, "crate", [blocker], { exclude: new Set(["c1"]) }));
  assert.ok(near(excluded.p[2], -1.5), "excluded records do not block");
  const held = { ...blocker, attach: { user: "u1", hand: "right", grip: "snap" } };
  assert.ok(near(resolvePlacement({ rel: "front" }, ctxFor(player, "crate", [held])).p[2], -1.5), "held things do not block");
  const onTop = { ...blocker, onto: "x" };
  assert.ok(near(resolvePlacement({ rel: "front" }, ctxFor(player, "crate", [onTop])).p[2], -1.5), "things on surfaces do not block");
  const bigVilla = rec("v", "villa", [0, 0, -1.5]);
  const capped = resolvePlacement({ rel: "front" }, ctxFor(player, "villa", [bigVilla, rec("v2", "villa", [0, 0, -40])]));
  assert.ok(Number.isFinite(capped.p[2]) && capped.p[2] >= -1.5 - 40 * 0.5 - 1e-6, "at most 40 steps");
});

test("findRef resolves ids, batches, pronouns and nearest parts", () => {
  const player = { p: [0, 1.6, 0], yaw: 0 };
  const a = rec("a", "crate", [0, 0, -10]);
  const b = rec("b", "crate", [0, 0, -2]);
  const c = rec("c", "chair", [1, 0, 0]);
  const ctx = { player, records: [a, b, c], batch: [c] };
  assert.equal(findRef({ id: "a" }, ctx), a);
  assert.equal(findRef({ part: "crate" }, ctx), b);
  assert.equal(findRef({ part: "crate", which: "last" }, ctx), b);
  assert.equal(findRef({ part: "crate", which: 1 }, ctx), a);
  assert.equal(findRef({ batch: 0 }, ctx), c);
  assert.equal(findRef({ ref: "it" }, ctx), c);
  assert.equal(findRef({ part: "villa" }, ctx), null);
  assert.equal(findRef(null, ctx), null);
});
