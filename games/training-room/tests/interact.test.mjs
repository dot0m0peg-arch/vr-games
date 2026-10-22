// Interact: grab (near vs. ray), refusals, snap/keep attach, throw, drop onto surfaces, weapon hits.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../vendor/three.module.min.js";
import { Interact, segmentHitsBox } from "../js/play/interact.js";
import { createState, applyOp, validateOp } from "../js/core/room-state.js";
import { getMeta } from "../js/parts/meta/index.js";

const DT = 1 / 72;

function metaOf(record) {
  return getMeta(record.part) || { name: record.part, size: [0.8, 0.8, 0.8] };
}

// Fake SceneObjects: AABB bounds from the record pose + meta size; pick/worldPose overridable.
function setup(records, { pick = null, worldPose = null, user = "me" } = {}) {
  const room = { state: createState() };
  for (const r of records) applyOp(room.state, { t: "add", obj: { ry: 0, s: 1, label: r.part, ...r } });
  const ops = [];
  const fxs = [];
  const hits = [];
  const objects = {
    get: (id) => room.state.objects[id],
    nearest: () => null,
    pick: (raycaster) => (pick ? pick(raycaster) : null),
    worldPose: (id) => (worldPose ? worldPose(id) : null),
    bounds: (id) => {
      const r = room.state.objects[id];
      if (!r || r.attach) return null;
      const [w, h, d] = metaOf(r).size;
      const c = Math.abs(Math.cos(r.ry || 0));
      const s = Math.abs(Math.sin(r.ry || 0));
      const hx = (c * w + s * d) / 2;
      const hz = (s * w + c * d) / 2;
      return new THREE.Box3(new THREE.Vector3(r.p[0] - hx, r.p[1], r.p[2] - hz), new THREE.Vector3(r.p[0] + hx, r.p[1] + h, r.p[2] + hz));
    },
    hit: (id, power, dir) => hits.push({ id, power, dir }),
  };
  const send = (op) => {
    const checked = validateOp(op);
    assert.ok(checked.ok, `op must be network-valid: ${checked.error} ${JSON.stringify(op)}`);
    ops.push(op);
    applyOp(room.state, op);
  };
  const interact = new Interact({ objects, room, getUser: () => user, metaOf, send, fx: (fx) => fxs.push(fx) });
  const haptics = [];
  interact.on("haptic", (event) => haptics.push(event));
  return { interact, room, ops, fxs, hits, haptics };
}

const pose = (x, y, z, q = new THREE.Quaternion()) => ({ p: new THREE.Vector3(x, y, z), q: q.clone() });

function rayFrom(origin, dir) {
  const raycaster = new THREE.Raycaster();
  raycaster.ray.origin.set(...origin);
  raycaster.ray.direction.set(...dir).normalize();
  return raycaster;
}

test("segment vs box", () => {
  const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  assert.ok(segmentHitsBox(new THREE.Vector3(-3, 0, 0), new THREE.Vector3(3, 0, 0), box));
  assert.ok(!segmentHitsBox(new THREE.Vector3(-3, 2, 0), new THREE.Vector3(3, 2, 0), box));
  assert.ok(!segmentHitsBox(new THREE.Vector3(-3, 0, 0), new THREE.Vector3(-2, 0, 0), box));
  assert.ok(segmentHitsBox(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0), box));
});

test("grabs the nearest grabbable within 0.2 m and snaps tools with a grip", () => {
  const { interact, ops, room } = setup([
    { id: "mug", part: "coffee mug", p: [0, 1, -0.3] },
    { id: "ball", part: "ball", p: [0.2, 0.9, -0.3] },
  ]);
  const events = [];
  interact.on("grab", (e) => events.push(e));
  const hand = pose(0.02, 1.05, -0.3);
  assert.equal(interact.grab("right", { point: hand.p, quat: hand.q }), "mug");
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], { t: "set", id: "mug", patch: { attach: { user: "me", hand: "right", grip: "snap" } }, transient: false });
  assert.deepEqual(room.state.objects.mug.attach, { user: "me", hand: "right", grip: "snap" });
  assert.equal(interact.held("right"), "mug");
  assert.equal(interact.held("left"), null);
  assert.deepEqual(events, [{ hand: "right", id: "mug", distance: false }]);
  // A hand that already holds something does not grab again.
  assert.equal(interact.grab("right", { point: hand.p, quat: hand.q }), null);
});

test("nothing near: grabs the first grabbable along the ray (distance grab, keep grip in front of the palm)", () => {
  const { interact, ops } = setup([
    { id: "crate", part: "crate", p: [0, 0, -5] },
    { id: "far", part: "crate", p: [0, 0, -30] },
  ]);
  const hand = pose(0, 1, 0);
  const id = interact.grab("right", { point: hand.p, quat: hand.q, raycaster: rayFrom([0, 0.45, 0], [0, 0, -1]) });
  assert.equal(id, "crate");
  const attach = ops[0].patch.attach;
  assert.equal(attach.grip, "keep");
  assert.equal(attach.hand, "right");
  // Crate center sits in front of the right palm (-X): gap = 0.04 + 0.45, origin 0.45 m below center.
  assert.ok(Math.abs(attach.rel.p[0] + 0.49) < 1e-3, `rel.p ${attach.rel.p}`);
  assert.ok(Math.abs(attach.rel.p[1] + 0.45) < 1e-3);
  assert.ok(Math.abs(attach.rel.p[2]) < 1e-3);

  // Left palm faces +X.
  const left = setup([{ id: "crate", part: "crate", p: [0, 0, -5] }]);
  left.interact.grab("left", { point: hand.p, quat: hand.q, raycaster: rayFrom([0, 0.45, 0], [0, 0, -1]) });
  assert.ok(left.ops[0].patch.attach.rel.p[0] > 0.4);

  // Beyond 12 m nothing is grabbed.
  const far = setup([{ id: "far", part: "crate", p: [0, 0, -30] }]);
  assert.equal(far.interact.grab("right", { point: hand.p, quat: hand.q, raycaster: rayFrom([0, 0.45, 0], [0, 0, -1]) }), null);
  assert.equal(far.ops.length, 0);
});

test("ray grab prefers SceneObjects.pick and is blocked by ungrabbable things in front", () => {
  const hand = pose(0, 1, 0);
  const picked = setup([{ id: "ball", part: "ball", p: [0.5, 0, -4] }], { pick: () => ({ id: "ball", distance: 4 }) });
  assert.equal(picked.interact.grab("right", { point: hand.p, quat: hand.q, raycaster: rayFrom([0, 1, 0], [0, 0, -1]) }), "ball");

  const blocked = setup([
    { id: "wall", part: "wall", p: [0, 0, -3] },
    { id: "crate", part: "crate", p: [0, 0, -6] },
  ], { pick: () => ({ id: "wall", distance: 2.45 }) });
  assert.equal(blocked.interact.grab("right", { point: hand.p, quat: hand.q, raycaster: rayFrom([0, 0.45, 0], [0, 0, -1]) }), null);
});

test("refuses big things and things held by someone else", () => {
  const { interact, ops } = setup([
    { id: "villa", part: "villa", p: [0, 0, -3] },
    { id: "tree", part: "tree", p: [3, 0, 0] },
    { id: "axe", part: "axe", p: [0, 1, 0.5], attach: { user: "other", hand: "right", grip: "snap" } },
  ]);
  // Hand inside the villa's bounds, and a ray straight at it.
  assert.equal(interact.grab("right", { point: new THREE.Vector3(0, 1, -2), quat: new THREE.Quaternion(), raycaster: rayFrom([0, 1, 0], [0, 0, -1]) }), null);
  assert.equal(interact.grab("left", { point: new THREE.Vector3(3, 1, 0), quat: new THREE.Quaternion(), raycaster: rayFrom([0, 1, 0], [1, 0, 0]) }), null);
  // The other player's axe: hand right on it.
  assert.equal(interact.grab("right", { point: new THREE.Vector3(0, 1.3, 0.5), quat: new THREE.Quaternion() }), null);
  assert.equal(ops.length, 0);
  assert.equal(interact.grabbable({ id: "x", part: "villa", p: [0, 0, 0] }), false);
  assert.equal(interact.grabbable({ id: "x", part: "crate", p: [0, 0, 0] }), true);
  assert.equal(interact.grabbable({ id: "x", part: "crate", p: [0, 0, 0], s: 4 }), false);
  assert.equal(interact.grabbable({ id: "x", part: "axe", p: [0, 0, 0], s: 10 }), true, "holdables are always grabbable");
});

test("keep grip stores the object pose relative to the hand", () => {
  const { interact, ops } = setup([{ id: "crate", part: "crate", p: [0.3, 0.5, -0.4], ry: 0.5 }]);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.7, 0.2));
  const hand = pose(0.3, 1.1, -0.4, q);
  assert.equal(interact.grab("left", { point: hand.p, quat: hand.q }), "crate");
  const { rel, grip } = ops[0].patch.attach;
  assert.equal(grip, "keep");
  // hand * rel must reproduce the object's world pose.
  const objP = new THREE.Vector3(...rel.p).applyQuaternion(q).add(hand.p);
  const objQ = q.clone().multiply(new THREE.Quaternion(...rel.q));
  assert.ok(objP.distanceTo(new THREE.Vector3(0.3, 0.5, -0.4)) < 1e-3, `object at ${objP.toArray()}`);
  const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5);
  assert.ok(objQ.angleTo(yawQ) < 1e-3);
});

test("lifting a thing off a surface clears onto; voice-held items count as held", () => {
  const { interact, ops } = setup([
    { id: "table", part: "card table", p: [0, 0, -1] },
    { id: "deck", part: "deck of cards", p: [0, 0.78, -1], onto: "table" },
    { id: "axe", part: "axe", p: [0, 1, 0], attach: { user: "me", hand: "left", grip: "snap" } },
  ]);
  assert.equal(interact.grab("right", { point: new THREE.Vector3(0, 0.82, -1), quat: new THREE.Quaternion() }), "deck");
  assert.equal(ops[0].patch.onto, null);
  assert.equal(interact.held("left"), "axe");
});

test("throw: hand velocity over the last ~100 ms becomes a fly op", () => {
  let state = null;
  const { interact, ops, room } = setup([{ id: "ball", part: "ball", p: [0, 1, -0.3] }], {
    worldPose: (id) => (id === "ball" && state.objects.ball.attach ? { p: [0.1, 1.2, -1], q: [0, 0, 0, 1] } : null),
  });
  state = room.state;
  interact.grab("right", { point: new THREE.Vector3(0, 1.1, -0.3), quat: new THREE.Quaternion() });
  // Hand moves forward (-Z) at 3 m/s and up at 1 m/s.
  for (let i = 0; i < 20; i++) interact.update(DT, { left: null, right: pose(0, 1 + i * DT, -i * DT * 3) });
  const v = interact.handVelocity("right");
  assert.ok(Math.abs(v.z + 3) < 0.05 && Math.abs(v.y - 1) < 0.05, `velocity ${v.toArray()}`);
  assert.equal(interact.release("right"), "ball");
  const op = ops.at(-1);
  assert.equal(op.t, "set");
  assert.equal(op.patch.attach, null);
  assert.deepEqual(op.patch.p, [0.1, 1.2, -1]);
  assert.equal(typeof op.patch.ry, "number");
  assert.ok(Math.abs(op.fly.vel[2] + 3) < 0.05 && Math.abs(op.fly.vel[1] - 1) < 0.05, `fly ${op.fly.vel}`);
  assert.equal(room.state.objects.ball.attach, undefined);
  assert.equal(interact.held("right"), null);

  // Explicit velocity (desktop throw) wins over hand history.
  interact.grab("right", { point: new THREE.Vector3(0.1, 1.3, -1), quat: new THREE.Quaternion() });
  interact.release("right", { velocity: new THREE.Vector3(0, 2.5, -9) });
  assert.deepEqual(ops.at(-1).fly.vel, [0, 2.5, -9]);
});

test("a teleport jump in the hand history is not a throw", () => {
  const { interact, ops } = setup([{ id: "ball", part: "ball", p: [0, 1, -0.3] }]);
  interact.grab("right", { point: new THREE.Vector3(0, 1.1, -0.3), quat: new THREE.Quaternion() });
  for (let i = 0; i < 5; i++) interact.update(DT, { right: pose(0, 1.1, -0.3) });
  for (let i = 0; i < 3; i++) interact.update(DT, { right: pose(10, 1.1, -0.3) });
  interact.release("right");
  assert.deepEqual(ops.at(-1).fly.vel, [0, 0, 0]);
});

test("slow release drops onto a surface directly below, otherwise falls", () => {
  let held = [0.2, 1.1, -1.1];
  let room = null;
  const env = setup([
    { id: "table", part: "card table", p: [0, 0, -1], ry: 0.4 },
    { id: "deck", part: "deck of cards", p: [3, 0, 3] },
  ], { worldPose: (id) => (id === "deck" && room.state.objects.deck.attach ? { p: held, q: [0, 0, 0, 1] } : null) });
  const { interact, ops } = env;
  room = env.room;
  interact.grab("right", { point: new THREE.Vector3(3, 0.05, 3), quat: new THREE.Quaternion() });
  interact.release("right", { velocity: new THREE.Vector3(0.2, 0, 0) });
  let op = ops.at(-1);
  assert.equal(op.fly, undefined);
  assert.deepEqual(op.patch.p, [0.2, getMeta("card table").surface, -1.1]);
  assert.equal(op.patch.onto, "table");
  assert.equal(op.patch.attach, null);
  assert.equal(room.state.objects.deck.onto, "table");

  // Off the table edge: falls (fly with zero velocity, the app sends the resting pose on landing).
  held = [1.2, 1.1, -1.0];
  interact.grab("right", { point: new THREE.Vector3(0.2, 0.8, -1.1), quat: new THREE.Quaternion() });
  assert.equal(ops.at(-1).patch.onto, null, "picking it up clears onto");
  interact.release("right");
  op = ops.at(-1);
  assert.deepEqual(op.fly, { vel: [0, 0, 0], spin: 0 });
  assert.equal(room.state.objects.deck.onto, undefined);
  assert.deepEqual(op.patch.p, [1.2, 1.1, -1]);
});

test("released pose falls back to hand pose + grip when SceneObjects has no world pose", () => {
  const { interact, ops } = setup([{ id: "axe", part: "axe", p: [0, 1, -0.2] }]);
  interact.grab("right", { point: new THREE.Vector3(0, 1.1, -0.2), quat: new THREE.Quaternion() });
  interact.update(DT, { right: pose(0, 1.2, -0.3) });
  interact.releaseAll();
  const op = ops.at(-1);
  // Grip r [-90, 0, 0]: handle along the fist (-Z), grip point 0.18 m up the handle.
  assert.ok(Math.abs(op.patch.p[0]) < 1e-3 && Math.abs(op.patch.p[1] - 1.2) < 1e-3 && Math.abs(op.patch.p[2] - -0.12) < 1e-3, `p ${op.patch.p}`);
});

test("weapon tip entering a hittable at speed hits once per cooldown", () => {
  const { interact, fxs, hits, haptics } = setup([
    { id: "axe", part: "axe", p: [0, 1, 0] },
    { id: "dummy", part: "training dummy", p: [0, 0, -1] },
  ]);
  const events = [];
  interact.on("hit", (e) => events.push(e));
  assert.equal(interact.grab("right", { point: new THREE.Vector3(0, 1.2, 0), quat: new THREE.Quaternion() }), "axe");
  // Tip sits 0.48 m along grip -Z and 0.17 m along +X from the fist.
  interact.update(DT, { right: pose(0, 1.2, 0.1) });
  interact.update(DT, { right: pose(0, 1.2, 0.1) });
  assert.equal(hits.length, 0, "standing still does not hit");
  interact.update(DT, { right: pose(0, 1.2, -0.45) }); // tip z -0.38 → -0.93: enters the dummy
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "dummy");
  assert.equal(hits[0].power, 1);
  assert.ok(hits[0].dir.isVector3 && hits[0].dir.z < -0.9);
  assert.deepEqual(fxs, [{ kind: "hit", id: "dummy", power: 1 }]);
  assert.deepEqual(haptics, [{ hand: "right", intensity: 1 }]);
  assert.equal(events[0].hand, "right");

  // Out and straight back in within 250 ms: cooldown.
  interact.update(DT, { right: pose(0, 1.2, 0.1) });
  interact.update(DT, { right: pose(0, 1.2, -0.45) });
  assert.equal(hits.length, 1);
  // Wait out the cooldown, then strike again.
  for (let i = 0; i < 20; i++) interact.update(DT, { right: pose(0, 1.2, 0.1) });
  interact.update(DT, { right: pose(0, 1.2, -0.45) });
  assert.equal(hits.length, 2);

  // Slow push into the target does not count.
  for (let i = 0; i < 30; i++) interact.update(DT, { right: pose(0, 1.2, 0.1) });
  for (let i = 0; i < 60; i++) interact.update(DT, { right: pose(0, 1.2, 0.1 - i * 0.01) });
  assert.equal(hits.length, 2, "slow motion is not a hit");
});

test("thrown or plain objects are not hit-tested", () => {
  const { interact, hits } = setup([
    { id: "ball", part: "ball", p: [0, 1, 0] },
    { id: "dummy", part: "training dummy", p: [0, 0, -1] },
  ]);
  interact.grab("right", { point: new THREE.Vector3(0, 1.1, 0), quat: new THREE.Quaternion() });
  interact.update(DT, { right: pose(0, 1.2, 0.1) });
  interact.update(DT, { right: pose(0, 1.2, -1) });
  assert.equal(hits.length, 0);
});

test("desktop swing animates the held weapon and hits along the arc", () => {
  const { interact, hits } = setup([
    { id: "axe", part: "axe", p: [0, 2, 0] },
    { id: "dummy", part: "training dummy", p: [0, 0, -0.5] },
  ]);
  assert.equal(interact.swing("right"), false, "nothing held");
  interact.grab("right", { point: new THREE.Vector3(0, 2.1, 0), quat: new THREE.Quaternion() });
  for (let i = 0; i < 4; i++) interact.update(DT, { right: pose(0, 2.1, 0) });
  assert.equal(hits.length, 0, "resting tip is above the dummy");
  assert.equal(interact.swingOffset("right"), null);
  assert.equal(interact.swing("right"), true);
  let sawOffset = false;
  for (let i = 0; i < 30; i++) {
    interact.update(DT, { right: pose(0, 2.1, 0) });
    if (interact.swingOffset("right")) sawOffset = true;
  }
  assert.ok(sawOffset);
  assert.equal(interact.swingOffset("right"), null, "swing ends after 0.25 s");
  assert.equal(hits.length, 1, "the chop hits the dummy once");
  assert.equal(hits[0].id, "dummy");

  // applySwing rotates a pose in place while a swing runs.
  interact.swing("right");
  interact.update(DT * 6, { right: pose(0, 2.1, 0) });
  const p = pose(0, 2.1, 0);
  interact.applySwing("right", p);
  assert.ok(p.q.angleTo(new THREE.Quaternion()) > 0.1);
});
