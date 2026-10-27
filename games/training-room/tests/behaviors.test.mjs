// Item behaviors in Node: popcorn you take out and throw, a rubber chicken that flops, a pistol that
// fires, and the commands that spawn them ("spawn a box of popcorn", "a bag of marbles").
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../vendor/three.module.min.js";
import { Room } from "../js/room.js";
import * as build from "../js/parts/build/index.js";
import { SceneObjects } from "../js/world/objects.js";
import { Interact } from "../js/play/interact.js";
import { Behaviors, rewriteCommand, pieceFor } from "../js/play/behaviors.js";
import { gunOf } from "../js/play/guns.js";
import { floppyOf } from "../js/play/floppy.js";
import { capacity, fillSlots, inCavity } from "../js/core/fill.js";
import { validateOp } from "../js/core/room-state.js";
import { parseCommand } from "../js/core/parse.js";
import { allMeta, getMeta } from "../js/parts/meta/index.js";

const DT = 1 / 72;

function world({ hands = {} } = {}) {
  const scene = new THREE.Scene();
  const room = new Room();
  const phaser = { phaseIn: () => Promise.resolve(), phaseOut: () => Promise.resolve(), burst() {}, cancel() {} };
  const handPose = (hand) => hands[hand] || null;
  const getHand = (user, hand) => (user === "me" ? handPose(hand) : null);
  const objects = new SceneObjects({ scene, room, build, phaser, getHand });
  const ops = [];
  const fxs = [];
  const thrown = new Set();
  const send = (op) => {
    const checked = validateOp(op);
    assert.ok(checked.ok, `op must be network-valid: ${checked.error} ${JSON.stringify(op).slice(0, 300)}`);
    op.uid = op.uid || `u${ops.length}`;
    op.by = "me";
    if (op.fly) thrown.add(op.id);
    ops.push(op);
    room.apply(op, { local: true });
  };
  objects.on("landed", ({ id, p, ry }) => {
    if (thrown.delete(id)) send({ t: "set", id, patch: { p, ry } });
  });
  const hooks = {};
  const interact = new Interact({ objects, room, getUser: () => "me", metaOf: (r) => build.metaOfRecord(r), send, fx: (fx) => fxs.push(fx), hooks });
  const behaviors = new Behaviors({
    scene, room, objects, interact, send, fx: (fx) => fxs.push(fx), getUser: () => "me",
    metaOf: (r) => build.metaOfRecord(r), getHand, phaser, isThrownByMe: (id) => thrown.has(id),
  });
  Object.assign(hooks, behaviors.interactHooks());
  let n = 0;
  const add = (part, extra = {}) => {
    const id = `o${++n}`;
    send({ t: "add", obj: { id, part, label: part, p: [0, 0, 0], ry: 0, s: 1, by: "me", t: Date.now(), ...extra } });
    return id;
  };
  const frame = (count = 1) => {
    for (let i = 0; i < count; i++) {
      interact.update(DT, { left: handPose("left"), right: handPose("right") });
      objects.update(DT, 0);
      behaviors.update(DT);
    }
  };
  return { scene, room, objects, interact, behaviors, ops, fxs, add, frame, hands, thrown };
}

const pose = (p, q = new THREE.Quaternion()) => ({ p: new THREE.Vector3(...p), q });
const fillN = (room, id) => room.get(id).data?.fill?.n;

test("spawn commands: box of popcorn, rubber chicken and pistol are real parts", () => {
  const metas = allMeta();
  const part = (text) => parseCommand(text, { metas }).intents.find((i) => i.do === "spawn")?.what?.part;
  assert.equal(part("spawn a box of popcorn"), "popcorn box");
  assert.equal(part("spawn a rubber chicken"), "rubber chicken");
  assert.equal(part("spawn a pistol"), "pistol");
  assert.equal(part("spawn a bag of chips"), "snack bag");
  assert.equal(part(rewriteCommand("spawn popcorn").text), "popcorn box");
});

test("'a bag of marbles' becomes a snack bag filled with that thing", () => {
  const out = rewriteCommand("spawn a bucket of gumballs on the table");
  assert.equal(out.text, "spawn a snack bucket on the table");
  assert.deepEqual({ container: out.fill.container, part: out.fill.part }, { container: "snack bucket", part: "gumball" });
  const box = rewriteCommand("spawn two boxes of ball");
  assert.equal(box.text, "spawn two snack boxes");
  assert.equal(box.fill.part, "ball");
  assert.ok(box.fill.s < 0.3, "a soccer ball shrinks to a piece");
  assert.equal(rewriteCommand("spawn a box of popcorn").text, "spawn a box of popcorn", "known phrases stay");
  assert.equal(rewriteCommand("spawn a deck of cards").text, "spawn a deck of cards");
  assert.equal(rewriteCommand("delete the popcorn").text, "delete the popcorn");
  assert.equal(pieceFor("fries").part, "french fry");
});

test("which items fire and which flop", () => {
  const meta = (name, extra = {}) => ({ name, size: [0.2, 0.3, 0.1], ...extra });
  for (const name of ["pistol", "semi automatic pistol", "laser blaster", "sniper rifle", "pistol axe", "water gun", "flintlock pistol", "uzi"]) {
    assert.ok(gunOf(meta(name), { label: name }), `${name} fires`);
  }
  for (const name of ["pistol shrimp", "gun safe", "gun rack", "axe", "cannonball", "rubber chicken"]) {
    assert.equal(gunOf(meta(name), { label: name }), null, `${name} does not fire`);
  }
  assert.equal(gunOf(meta("uzi"), {}).auto, true);
  assert.equal(gunOf(meta("pump shotgun"), {}).pellets, 8);
  assert.equal(gunOf(meta("ray gun"), {}).style, "laser");
  assert.ok(floppyOf(getMeta("rubber chicken"), {}));
  assert.ok(floppyOf(meta("rubber shark", { size: [0.3, 0.2, 0.9] }), {}), "mashups flop by name");
  assert.ok(floppyOf(meta("clownfish", { behavior: "swim" }), {}));
  assert.equal(floppyOf(getMeta("pistol"), {}), null);
  assert.equal(floppyOf(meta("brick wall", { size: [3, 2, 0.3] }), {}), null);
});

test("fill layout: full heap reaches the rim, pieces come off the top", () => {
  const c = getMeta("popcorn box").container;
  const cap = capacity(c, 0.03);
  assert.ok(cap >= 30 && cap <= 60, `popcorn capacity ${cap}`);
  const slots = fillSlots(c, 0.03, cap, 7);
  assert.equal(slots.length, cap);
  assert.ok(slots.at(-1)[1] >= c.rim - 0.01, "heap reaches the rim");
  for (const s of slots) assert.ok(inCavity(c, s.slice(0, 3), 0.03), `slot inside ${s.slice(0, 3)}`);
  const few = fillSlots(c, 0.03, 4, 7);
  assert.ok(Math.min(...few.map((s) => s[1])) < 0.05, "a nearly empty box has its pieces on the bottom");
});

test("popcorn: reach into the box, take a piece, throw it, put one back", () => {
  const w = world();
  const box = w.add("popcorn box", { p: [0, 0.76, -0.5] });
  w.frame();
  const full = getMeta("popcorn box").container;
  const cap = capacity(full, 0.03);
  // Hand above the popcorn, inside the opening.
  w.hands.right = pose([0, 0.76 + 0.2, -0.5]);
  w.frame();
  const piece = w.interact.grab("right", { point: w.hands.right.p, quat: w.hands.right.q });
  assert.ok(piece && piece !== box, "took a piece, not the box");
  const record = w.room.get(piece);
  assert.equal(record.part, "popcorn piece");
  assert.equal(record.attach?.hand, "right");
  assert.equal(fillN(w.room, box), cap - 1);
  // Throw it.
  for (let i = 0; i < 6; i++) {
    w.hands.right.p.z -= 0.05;
    w.frame();
  }
  w.interact.release("right", { velocity: new THREE.Vector3(0, 2, -6) });
  const last = w.ops.at(-1);
  assert.ok(last.fly && last.id === piece, "the piece flies");
  w.frame(200);
  assert.ok(w.room.get(piece).p[2] < -1.5, `landed far away ${w.room.get(piece).p}`);
  // Take another and drop it back in gently.
  w.hands.right = pose([0, 0.96, -0.5]);
  w.frame();
  const second = w.interact.grab("right", { point: w.hands.right.p, quat: w.hands.right.q });
  assert.equal(fillN(w.room, box), cap - 2);
  w.interact.release("right", { velocity: new THREE.Vector3() });
  assert.equal(w.room.get(second), undefined, "the piece went back in");
  assert.equal(fillN(w.room, box), cap - 1);
  // A hand at the side of the box grabs the box itself.
  w.hands.right = pose([0.1, 0.84, -0.5]);
  w.frame();
  assert.equal(w.interact.grab("right", { point: w.hands.right.p, quat: w.hands.right.q }), box);
});

test("popcorn: aim at the top of the box from a distance to take a piece", () => {
  const w = world();
  const box = w.add("popcorn box", { p: [0, 0.76, -1.2] });
  w.frame();
  const raycaster = new THREE.Raycaster();
  const eye = new THREE.Vector3(0, 1.6, 0);
  raycaster.set(eye, new THREE.Vector3(0, 0.76 + 0.2, -1.2).sub(eye).normalize());
  w.hands.right = pose([0.28, 1.3, -0.4]);
  w.frame();
  const id = w.interact.grab("right", { point: w.hands.right.p, quat: w.hands.right.q, raycaster });
  assert.equal(w.room.get(id)?.part, "popcorn piece");
  assert.ok(fillN(w.room, box) < capacity(getMeta("popcorn box").container, 0.03));
});

test("popcorn: turn the held box upside down and it pours out", () => {
  const w = world();
  w.hands.right = pose([0, 1.2, -0.4]);
  const box = w.add("popcorn box", { p: [0, 0, -0.4], attach: { user: "me", hand: "right", grip: "snap" } });
  w.frame(5);
  const before = w.ops.filter((o) => o.t === "add").length;
  // Flip the hand over.
  w.hands.right.q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  w.frame(60);
  const spilled = w.ops.filter((o) => o.t === "add" && o.obj.part === "popcorn piece");
  assert.ok(spilled.length >= 10, `spilled ${spilled.length}`);
  assert.ok(spilled.every((o) => o.obj.data.fly?.vel), "pieces fly out");
  assert.ok(w.ops.length > before);
  w.frame(10);
  assert.ok(fillN(w.room, box) <= capacity(getMeta("popcorn box").container, 0.03) - spilled.length + 3, "count goes down");
  w.frame(300);
  const flying = [...w.objects.entries.values()].filter((e) => e.fly);
  assert.equal(flying.length, 0, "everything landed");
  const landed = w.room.get(spilled[0].obj.id);
  assert.ok(!landed.data.fly, "landing clears the flight");
  assert.ok(Math.abs(landed.p[1]) < 0.05, `popcorn on the floor at ${landed.p}`);
});

test("rubber chicken: dangles and swings when carried, settles back when put down", () => {
  const w = world();
  w.hands.right = pose([0, 1.3, -0.4]);
  const chicken = w.add("rubber chicken", { p: [0, 0, -0.4] });
  w.frame();
  w.interact.grab("right", { point: new THREE.Vector3(0, 0.05, -0.28), quat: w.hands.right.q });
  // grab by the neck: the hand is near the head end, so attach snaps to the grip
  assert.equal(w.room.get(chicken).attach?.hand, "right");
  const entry = w.objects.entries.get(chicken);
  const meshes = [];
  entry.inner.traverse((o) => o.isMesh && meshes.push(o));
  const rest = meshes.map((m) => Float32Array.from(m.geometry.attributes.position.array));
  // Swing the hand left and right fast.
  let moved = 0;
  for (let i = 0; i < 90; i++) {
    w.hands.right.p.x = Math.sin(i * 0.25) * 0.4;
    w.frame();
    const arr = meshes[0].geometry.attributes.position.array;
    let d = 0;
    for (let k = 0; k < arr.length; k++) d = Math.max(d, Math.abs(arr[k] - rest[0][k]));
    moved = Math.max(moved, d);
  }
  assert.ok(moved > 0.03, `the body bends (max vertex offset ${moved.toFixed(3)} m)`);
  // Others' copies of the shared primitives are untouched.
  const fresh = build.buildObject({ id: "x", part: "rubber chicken", p: [0, 0, 0], ry: 0, s: 1 });
  const freshMeshes = [];
  fresh.traverse((o) => o.isMesh && freshMeshes.push(o));
  assert.deepEqual([...freshMeshes[0].geometry.attributes.position.array].slice(0, 9).map((n) => n.toFixed(4)), [...rest[0]].slice(0, 9).map((n) => n.toFixed(4)));
  // Drop it and let it settle: the shape comes back exactly.
  w.interact.release("right", { velocity: new THREE.Vector3() });
  w.frame(400);
  const arr = meshes[0].geometry.attributes.position.array;
  let d = 0;
  for (let k = 0; k < arr.length; k++) d = Math.max(d, Math.abs(arr[k] - rest[0][k]));
  assert.ok(d < 1e-4, `back to its built shape (${d})`);
});

test("pistol: the trigger fires, the shot knocks a ball flying and wobbles a crate", () => {
  const w = world();
  w.hands.right = pose([0.2, 1.2, 0]);
  const pistol = w.add("pistol", { p: [0, 0, 0], attach: { user: "me", hand: "right", grip: "snap" } });
  const ball = w.add("ball", { p: [0, 0.9, -4] });
  const crate = w.add("crate", { p: [3, 0, -6] });
  w.frame(3);
  const aimAt = (target) => () => {
    const origin = new THREE.Vector3(0.2, 1.25, 0);
    return new THREE.Ray(origin, target.clone().sub(origin).normalize());
  };
  assert.equal(w.behaviors.trigger("right", true, aimAt(new THREE.Vector3(0, 1.0, -4))), true, "the trigger belongs to the gun");
  w.behaviors.trigger("right", false, aimAt(new THREE.Vector3(0, 1.0, -4)));
  const fly = w.ops.find((o) => o.t === "set" && o.id === ball && o.fly);
  assert.ok(fly, "the ball was knocked");
  assert.ok(fly.fly.vel[2] < -1, `away from the shooter ${fly.fly.vel}`);
  assert.ok(w.fxs.some((f) => f.kind === "shot"), "others see the shot");
  assert.ok(w.fxs.some((f) => f.kind === "hit" && f.id === ball));
  assert.ok(w.objects.entries.get(pistol), "the pistol is still in hand");
  // A big crate only wobbles.
  w.frame(20);
  w.behaviors.trigger("right", true, aimAt(new THREE.Vector3(3, 0.5, -6)));
  w.behaviors.trigger("right", false, aimAt(new THREE.Vector3(3, 0.5, -6)));
  assert.ok(w.fxs.some((f) => f.kind === "hit" && f.id === crate), "the crate was hit");
  // Recoil kicks the hand pose that draws the gun.
  const kicked = w.behaviors.applyRecoil("right", w.hands.right);
  assert.notEqual(kicked, w.hands.right);
  // Not holding a gun: the trigger is left alone.
  w.interact.release("right", { velocity: new THREE.Vector3() });
  assert.equal(w.behaviors.trigger("right", true, aimAt(new THREE.Vector3(0, 1, -4))), false);
});

test("shooting the popcorn box spills popcorn", () => {
  const w = world();
  w.hands.right = pose([0.2, 1.2, 0]);
  w.add("pistol", { p: [0, 0, 0], attach: { user: "me", hand: "right", grip: "snap" } });
  const box = w.add("popcorn box", { p: [0, 0.76, -3] });
  w.add("card table", { p: [0, 0, -3] });
  w.frame(3);
  const origin = new THREE.Vector3(0.2, 1.25, 0);
  const aim = () => new THREE.Ray(origin, new THREE.Vector3(0, 0.88, -3).sub(origin).normalize());
  w.behaviors.trigger("right", true, aim);
  const pieces = w.ops.filter((o) => o.t === "add" && o.obj.part === "popcorn piece");
  assert.ok(pieces.length >= 5, `spilled ${pieces.length}`);
  assert.ok(fillN(w.room, box) < capacity(getMeta("popcorn box").container, 0.03));
});

test("a bag of marbles style fill: pending fill lands on the new container", async () => {
  const w = world();
  const text = w.behaviors.prepareCommand("spawn a bowl of gumballs");
  assert.equal(text, "spawn a snack bowl");
  const id = w.add("snack bowl", { p: [0, 0, -1] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(w.room.get(id).data?.fill?.part, "gumball");
  assert.equal(w.room.get(id).label, "bowl of gumballs");
});
