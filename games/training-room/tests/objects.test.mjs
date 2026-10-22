// SceneObjects (room -> meshes), Phaser material swapping and Field construction, in Node.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../vendor/three.module.min.js";
import { Room } from "../js/room.js";
import * as build from "../js/parts/build/index.js";
import { getMeta } from "../js/parts/meta/index.js";
import { kit } from "../js/parts/build/kit.js";
import { SceneObjects } from "../js/world/objects.js";
import { Phaser, localBox } from "../js/world/phase.js";
import { Field } from "../js/world/field.js";

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const assertVec = (v, arr, eps = 1e-3, msg = "") => {
  const got = Array.isArray(v) ? v : v.toArray();
  for (let i = 0; i < arr.length; i++) assert.ok(near(got[i], arr[i], eps), `${msg} [${i}] got ${got.map((n) => n.toFixed(4))} want ${arr}`);
};

// Phaser stand-in: records calls and lets the test resolve them.
function fakePhaser() {
  const calls = [];
  return {
    calls,
    phaseIn(object, opts) {
      return new Promise((resolve) => calls.push({ kind: "in", object, opts, resolve }));
    },
    phaseOut(object, opts) {
      return new Promise((resolve) => calls.push({ kind: "out", object, opts, resolve }));
    },
    burst() {
      calls.push({ kind: "burst" });
    },
    cancel() {},
    settle() {
      for (const call of calls.splice(0)) call.resolve?.();
      return new Promise((r) => setTimeout(r, 0));
    },
  };
}

function setup({ hands = {} } = {}) {
  const scene = new THREE.Scene();
  const room = new Room();
  const phaser = fakePhaser();
  const getHand = (user, hand) => hands[`${user}:${hand}`] || null;
  const objects = new SceneObjects({ scene, room, build, phaser, getHand });
  let n = 0;
  const add = (part, extra = {}) => {
    const id = `o${++n}`;
    room.apply({ t: "add", obj: { id, part, label: part, p: [0, 0, 0], ry: 0, s: 1, ...extra } });
    return id;
  };
  return { scene, room, phaser, objects, add, hands };
}

test("add builds, positions and phases in; load rebuilds without phase", async () => {
  const { scene, room, phaser, objects, add } = setup();
  const id = add("crate", { p: [2, 0, -3], ry: Math.PI / 2, s: 1.5 });
  const wrapper = objects.get(id);
  assert.ok(wrapper, "wrapper exists");
  assert.equal(wrapper.parent, scene);
  assertVec(wrapper.position, [2, 0, -3]);
  assert.ok(near(wrapper.scale.x, 1.5));
  assert.ok(near(new THREE.Euler().setFromQuaternion(wrapper.quaternion).y, Math.PI / 2));
  assert.deepEqual(objects.ids(), [id]);
  assert.equal(phaser.calls.filter((c) => c.kind === "in").length, 1);
  assert.equal(phaser.calls[0].object, wrapper);

  const snapshot = room.snapshot();
  phaser.calls.length = 0;
  room.load(snapshot);
  assert.equal(phaser.calls.length, 0, "load must not phase");
  const rebuilt = objects.get(id);
  assert.ok(rebuilt && rebuilt !== wrapper);
  assert.equal(wrapper.parent, null, "old wrapper removed");
  assertVec(rebuilt.position, [2, 0, -3]);
});

test("transient moves apply at once, normal moves tween over 0.25 s", () => {
  const { room, objects, add } = setup();
  const id = add("crate");
  room.apply({ t: "set", id, patch: { p: [1, 0, 1] }, transient: true });
  assertVec(objects.get(id).position, [1, 0, 1]);
  room.apply({ t: "set", id, patch: { p: [3, 0, 1], ry: 1 } });
  assertVec(objects.get(id).position, [1, 0, 1], 1e-3, "not yet moved");
  objects.update(0.1, 0);
  const mid = objects.get(id).position.x;
  assert.ok(mid > 1 && mid < 3, `mid-tween x ${mid}`);
  objects.update(0.2, 0.3);
  assertVec(objects.get(id).position, [3, 0, 1]);
  assert.ok(near(new THREE.Euler().setFromQuaternion(objects.get(id).quaternion).y, 1));
});

test("snap grip puts meta.grip.p in the hand with grip.r rotation; keep grip uses rel", () => {
  const hand = { p: new THREE.Vector3(0.3, 1.1, -0.4), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.7, -0.1)) };
  const { room, objects, add, hands } = setup({ hands: { "u1:right": hand } });
  const id = add("axe", { s: 1.2, attach: { user: "u1", hand: "right", grip: "snap" } });
  objects.update(0.016, 0);
  const wrapper = objects.get(id);
  wrapper.updateMatrixWorld(true);
  const meta = getMeta("axe");
  const gripWorld = new THREE.Vector3().fromArray(meta.grip.p).applyMatrix4(wrapper.matrixWorld);
  assertVec(gripWorld, hand.p.toArray(), 1e-4, "grip point at hand");
  const gripQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(...meta.grip.r.map((d) => (d * Math.PI) / 180), "XYZ"));
  const expected = hand.q.clone().multiply(gripQ);
  assert.ok(Math.abs(wrapper.quaternion.dot(expected)) > 0.9999, "orientation = hand * grip.r");
  assert.ok(near(wrapper.scale.x, 1.2));

  // Hand moves: object follows next frame.
  hand.p.set(1, 1.3, 0);
  objects.update(0.016, 0.016);
  wrapper.updateMatrixWorld(true);
  assertVec(new THREE.Vector3().fromArray(meta.grip.p).applyMatrix4(wrapper.matrixWorld), [1, 1.3, 0], 1e-4);

  // Hand lost: keep the last pose.
  delete hands["u1:right"];
  objects.update(0.016, 0.03);
  assertVec(wrapper.position, wrapper.position.toArray());
  const before = wrapper.position.clone();
  objects.update(0.016, 0.05);
  assertVec(wrapper.position, before.toArray());

  // Keep grip: object = hand * rel.
  hands["u2:left"] = { p: new THREE.Vector3(-1, 1, 2), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2) };
  const relQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3);
  room.apply({ t: "set", id, patch: { attach: { user: "u2", hand: "left", grip: "keep", rel: { p: [0, 0, -0.5], q: relQ.toArray() } } } });
  objects.update(0.016, 0.07);
  // rel.p (0,0,-0.5) rotated 90deg about Y = (-0.5, 0, 0)
  assertVec(wrapper.position, [-1.5, 1, 2], 1e-4);
  const q = hands["u2:left"].q.clone().multiply(relQ);
  assert.ok(Math.abs(wrapper.quaternion.dot(q)) > 0.9999);

  // Release without a pose: tween back to the record pose.
  room.apply({ t: "set", id, patch: { attach: null, p: [4, 0, 4], ry: 0 } });
  objects.update(0.3, 0.4);
  assertVec(wrapper.position, [4, 0, 4]);
});

test("thrown objects fly, land on the ground or a table and emit landed", () => {
  const { room, objects, add } = setup();
  const table = add("card table", { p: [5, 0, 0] });
  const ball = add("ball", { p: [0, 1.5, 0] });
  const landed = [];
  objects.on("landed", (e) => landed.push(e));
  room.apply({ t: "set", id: ball, patch: { p: [0, 1.5, 0] }, fly: { vel: [2, 3, 0], spin: 4 }, transient: true });
  for (let i = 0; i < 400 && !landed.length; i++) objects.update(1 / 60, i / 60);
  assert.equal(landed.length, 1, "landed once");
  assert.equal(landed[0].id, ball);
  assert.ok(near(landed[0].p[1], 0, 0.02), `rests on ground y=${landed[0].p[1]}`);
  assert.ok(landed[0].p[0] > 1, "travelled forward");
  // The settle tween makes it upright with the reported yaw.
  for (let i = 0; i < 20; i++) objects.update(1 / 60, 1);
  const box = objects.bounds(ball);
  assert.ok(near(box.min.y, 0, 0.03), `bottom on ground ${box.min.y}`);

  // A spinning throw tumbles around the middle: the center follows the ballistic arc.
  landed.length = 0;
  const axe = add("axe", { p: [0, 2, 3] });
  objects.update(0.016, 2);
  const c0 = objects.bounds(axe).getCenter(new THREE.Vector3());
  room.apply({ t: "set", id: axe, patch: { p: [0, 2, 3] }, fly: { vel: [3, 2, 0], spin: 12 } });
  const steps = 15;
  for (let i = 0; i < steps; i++) objects.update(1 / 60, 3 + i / 60);
  const c1 = objects.bounds(axe).getCenter(new THREE.Vector3());
  const tf = steps / 60;
  assert.ok(near(c1.x - c0.x, 3 * tf, 0.06), `center x moved ${(c1.x - c0.x).toFixed(3)} want ${(3 * tf).toFixed(3)}`);
  assert.ok(near(c1.y - c0.y, 2 * tf - 0.5 * 9.81 * tf * tf, 0.08), `center y moved ${(c1.y - c0.y).toFixed(3)}`);
  for (let i = 0; i < 400 && !landed.length; i++) objects.update(1 / 60, 4 + i / 60);
  assert.equal(landed[0]?.id, axe);
  for (let i = 0; i < 20; i++) objects.update(1 / 60, 9);
  assert.ok(near(objects.bounds(axe).min.y, 0, 0.03), "axe rests upright on the ground");

  // Drop straight onto the card table.
  landed.length = 0;
  const surface = getMeta("card table").surface;
  room.apply({ t: "set", id: ball, patch: { p: [5, 2, 0] }, fly: { vel: [0, 0, 0], spin: 0 } });
  for (let i = 0; i < 400 && !landed.length; i++) objects.update(1 / 60, i / 60);
  assert.equal(landed.length, 1);
  assert.ok(near(landed[0].p[1], surface, 0.03), `rests on table top ${landed[0].p[1]} vs ${surface}`);
  assert.ok(objects.get(table));
});

test("remove phases out then disposes; clear retires everything quickly", async () => {
  const { scene, room, phaser, objects, add } = setup();
  const a = add("crate");
  const b = add("barrel", { p: [3, 0, 0] });
  await phaser.settle();
  const wrapperA = objects.get(a);
  room.apply({ t: "del", ids: [a] });
  assert.equal(objects.get(a), undefined, "gone from lookup at once");
  assert.equal(wrapperA.parent, scene, "still visible while phasing out");
  const out = phaser.calls.find((c) => c.kind === "out");
  assert.ok(out && out.object === wrapperA);
  await phaser.settle();
  assert.equal(wrapperA.parent, null, "removed after phase-out");

  room.apply({ t: "clear" });
  const outs = phaser.calls.filter((c) => c.kind === "out");
  assert.equal(outs.length, 1);
  assert.equal(outs[0].opts.duration, 0.4);
  assert.deepEqual(objects.ids(), []);
  await phaser.settle();
  assert.ok(!scene.children.some((c) => c.name === `obj:${b}`));
});

test("color patches recolor tinted meshes with the original material kind; null restores", async () => {
  const { room, phaser, objects, add } = setup();
  const id = add("crate");
  await phaser.settle();
  const tinted = [];
  objects.get(id).traverse((c) => c.isMesh && c.userData.tint && tinted.push([c, c.material]));
  assert.ok(tinted.length > 0);
  room.apply({ t: "set", id, patch: { color: "#ff0000" } });
  for (const [mesh, original] of tinted) assert.equal(mesh.material, kit.mat("#ff0000", original.userData.kind || "matte"));
  room.apply({ t: "set", id, patch: { color: null } });
  for (const [mesh, original] of tinted) assert.equal(mesh.material, original);
});

test("color during phase-in waits until the phase ends", async () => {
  const { room, phaser, objects, add } = setup();
  const id = add("crate");
  let tinted = null;
  objects.get(id).traverse((c) => c.isMesh && c.userData.tint && !tinted && (tinted = c));
  const original = tinted.material;
  room.apply({ t: "set", id, patch: { color: "#0000ff" } });
  assert.equal(tinted.material, original, "deferred while phasing");
  await phaser.settle();
  assert.notEqual(tinted.material, original);
});

test("hits wobble the object and count on hittable parts", () => {
  const { objects, add, phaser } = setup();
  const dummy = add("training dummy");
  const crate = add("crate", { p: [3, 0, 0] });
  assert.equal(objects.hit(dummy, 1, new THREE.Vector3(1, 0, 0)), 1);
  assert.equal(objects.hit(dummy, 0.5), 2);
  assert.ok(phaser.calls.some((c) => c.kind === "burst"));
  objects.update(0.05, 0);
  const inner = objects.get(dummy).userData.inner;
  assert.ok(inner.quaternion.angleTo(new THREE.Quaternion()) > 0.01, "wobbling");
  for (let i = 0; i < 400; i++) objects.update(1 / 60, i / 60);
  assert.ok(inner.quaternion.angleTo(new THREE.Quaternion()) < 1e-3, "settles");
  assert.equal(objects.hit(crate), 0, "not hittable: no counter");
  assert.equal(objects.hit("missing"), 0);
});

test("pick, nearest, bounds and worldPose", () => {
  const { objects, add } = setup();
  const a = add("crate", { p: [0, 0, -3] });
  const b = add("axe", { p: [0, 0, -6] });
  objects.update(0.016, 0);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0.4, 0), new THREE.Vector3(0, 0, -1));
  const hit = objects.pick(ray);
  assert.equal(hit.id, a);
  assert.ok(hit.distance > 2 && hit.distance < 3);
  assert.ok(hit.point.isVector3);
  // Aim through the crate at the axe behind it: holdableOnly skips the crate.
  const grip = new THREE.Vector3().fromArray(getMeta("axe").grip.p).add(objects.get(b).position);
  const holdRay = new THREE.Raycaster(new THREE.Vector3(grip.x, grip.y, 0), new THREE.Vector3(0, 0, -1));
  assert.equal(objects.pick(holdRay)?.id, grip.y < getMeta("crate").size[1] ? a : b);
  assert.equal(objects.pick(holdRay, { holdableOnly: true })?.id, b);
  assert.equal(objects.pick(new THREE.Raycaster(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 1, 0))), null);

  const n = objects.nearest(new THREE.Vector3(0, 0.4, -1), 5);
  assert.equal(n.id, a);
  assert.ok(near(n.distance, 3 - 1 - getMeta("crate").size[2] / 2, 0.06), `distance ${n.distance}`);
  assert.equal(objects.nearest(new THREE.Vector3(0, 0.4, -1), 0.5), null);
  assert.equal(objects.nearest(new THREE.Vector3(0, 0.4, -1), 10, { holdableOnly: true }).id, b);

  const box = objects.bounds(a);
  assert.ok(box.containsPoint(new THREE.Vector3(0, 0.3, -3)));
  const pose = objects.worldPose(a);
  assertVec(pose.p, [0, 0, -3]);
  assert.equal(objects.worldPose("missing"), null);
});

test("highlight swaps to same-program clones and restores", async () => {
  const { objects, add, phaser } = setup();
  const id = add("crate");
  objects.setHighlight(id);
  const mesh = objects.get(id).userData.inner.children.find((c) => c.isMesh);
  const original = mesh.material;
  assert.equal(mesh.material, original, "no highlight while phasing");
  await phaser.settle();
  assert.notEqual(mesh.material, original, "highlighted after phase");
  assert.equal(mesh.material.type, original.type);
  objects.setHighlight(null);
  assert.equal(mesh.material, original);
});

test("behaviors animate the inner object after the phase-in", async () => {
  const { room, objects, add, phaser } = setup();
  const id = add("ball", { data: { behavior: { kind: "fly", speed: 1 } } });
  objects.update(0.5, 0);
  const inner = objects.get(id).userData.inner;
  assert.ok(inner.position.length() < 1e-6, "still at rest while phasing");
  await phaser.settle();
  for (let i = 0; i < 60; i++) objects.update(1 / 60, i / 60);
  assert.ok(inner.position.y > 1, `flying above the record pose (${inner.position.y})`);
  room.apply({ t: "set", id, patch: { data: { behavior: { kind: "none" } } } });
  for (let i = 0; i < 60; i++) objects.update(1 / 60, 1 + i / 60);
  assert.ok(inner.position.length() < 1e-6, "back at rest");
});

test("Phaser swaps materials for patched clones and restores them", async () => {
  const scene = new THREE.Scene();
  const phaser = new Phaser({ scene });
  const shared = new THREE.MeshStandardMaterial({ color: "#336699" });
  const other = new THREE.MeshStandardMaterial({ color: "#996633" });
  const root = new THREE.Group();
  const a = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
  const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
  const c = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [shared, other]);
  const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), other, 3);
  b.position.y = 1;
  c.position.y = 2;
  root.add(a, b, c, inst);
  scene.add(root);
  assertVec(localBox(root).max, [0.5, 2.5, 0.5]);

  let done = false;
  const promise = phaser.phaseIn(root, { duration: 1 }).then(() => (done = true));
  assert.notEqual(a.material, shared);
  assert.equal(a.material, b.material, "one clone per original");
  assert.equal(a.material.customProgramCacheKey(), "phase:MeshStandardMaterial:" + shared.customProgramCacheKey());
  assert.ok(Array.isArray(c.material) && c.material[0] === a.material);
  assert.ok(a.children.some((s) => s.userData.phaseHelper), "hologram shell attached");
  assert.ok(inst.children[0]?.isInstancedMesh, "instanced shell");
  phaser.update(0.5);
  root.position.x = 3; // moving during the effect is fine
  phaser.update(0.6);
  await promise;
  assert.ok(done);
  assert.equal(a.material, shared);
  assert.deepEqual(c.material, [shared, other]);
  assert.equal(inst.material, other);
  assert.equal(a.children.length, 0, "shells removed");
  assert.equal(phaser.group.children.length, 0, "ring and sparks removed");

  // phaseOut, interrupted phase-in, summon and burst lifecycles.
  const out = phaser.phaseOut(root, { duration: 0.5 });
  phaser.phaseIn(root); // interrupt: the out promise resolves, a new job starts
  await out;
  phaser.cancel(root);
  assert.equal(a.material, shared);
  const handle = phaser.summon(new THREE.Vector3(1, 0, 1), 0.8);
  phaser.update(0.3);
  assert.equal(phaser.summons.size, 1);
  handle.setPosition(new THREE.Vector3(2, 0, 2));
  handle.setRadius(1.2);
  handle.stop();
  phaser.update(0.2);
  phaser.update(0.2);
  assert.equal(phaser.summons.size, 0, "summon removed after fading");
  phaser.burst(new THREE.Vector3(), 0.4);
  assert.equal(phaser.bursts.length, 1);
  phaser.update(1);
  assert.equal(phaser.bursts.length, 0);
  phaser.dispose();
  assert.equal(phaser.group.parent, null);
});

test("Phaser.precompile compiles every effect material once and leaves nothing behind", () => {
  const scene = new THREE.Scene();
  const phaser = new Phaser({ scene });
  const compiled = [];
  const renderer = {
    compile(stage, camera, target) {
      assert.equal(target, scene, "lights and fog come from the real scene");
      stage.traverse((o) => o.material && compiled.push(o.material));
    },
  };
  phaser.precompile(renderer, new THREE.PerspectiveCamera());
  const names = compiled.map((m) => m.name || m.customProgramCacheKey?.() || m.type);
  assert.ok(compiled.some((m) => m.userData?.phaseClone), "patched part materials");
  for (const want of ["phase-ring", "phase-rune", "phase-column", "phase-shell", "phase-spark-rise", "phase-spark-burst"]) {
    assert.ok(names.some((n) => n.includes(want)) || compiled.some((m) => m.customProgramCacheKey?.() === want), `missing ${want}`);
  }
  assert.equal(phaser.jobs.size, 0);
  assert.equal(phaser.summons.size, 0);
  assert.equal(phaser.group.children.length, 0);
  assert.ok(phaser.keepers.size >= 10, `keepers ${phaser.keepers.size}`);
  assert.ok(!scene.userData.fieldClearings?.size, "no stray grass clearings");
  phaser.dispose();
});

test("Field builds in Node, changes time of day and cleans up", () => {
  const scene = new THREE.Scene();
  const field = new Field({ scene, quality: "low" });
  assert.ok(scene.fog?.isFog);
  assert.equal(field.time, "day");
  const dayFog = scene.fog.color.clone();
  field.setTime("night");
  assert.equal(field.time, "night");
  field.update(1.5, 1, new THREE.Vector3(10, 1.6, -4));
  assert.ok(!scene.fog.color.equals(dayFog), "transition in progress");
  field.update(2, 3, new THREE.Vector3(10, 1.6, -4));
  const nightFog = scene.fog.color.clone();
  field.update(1, 4, new THREE.Vector3(10, 1.6, -4));
  assert.ok(scene.fog.color.equals(nightFog), "transition finished after ~3 s");
  assert.equal(field.ground.position.x, 10);
  field.setTime("sunset", { instant: true });
  assert.ok(!scene.fog.color.equals(nightFog));
  field.setQuality("high");
  assert.equal(field.grass.geometry.instanceCount, 60000);
  let draws = 0;
  field.group.traverse((o) => (o.isMesh || o.isPoints) && draws++);
  assert.ok(draws <= 10, `field draw calls ${draws}`);
  field.dispose();
  assert.equal(scene.fog, null);
  assert.ok(!scene.children.includes(field.group));
});

// ---------- review fixes: programs, shadows, labels, drawings, screens ----------

// Stand-in renderer: compile() "links" one program per material variant (alphaTest included).
function fakeRenderer() {
  const props = new WeakMap();
  const properties = { get: (m) => (props.has(m) ? props.get(m) : props.set(m, {}).get(m)) };
  const keyOf = (m) => `prog:${m.type}|${m.name}|${m.customProgramCacheKey?.()}|${!!m.map}|${m.alphaTest > 0}|${m.transparent}|${m.side}`;
  const draw = (root) => root.traverse((o) => {
    for (const m of o.material ? [o.material].flat() : []) properties.get(m).currentProgram = { cacheKey: keyOf(m) };
  });
  return { properties, draw, compile: (stage) => draw(stage) };
}

function phaseRoot(scene, material) {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
  scene.add(root);
  return root;
}

test("Phaser keeps a keeper per real program: alphaTest variants survive, undrawn clones are not kept", async () => {
  const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1);
  const plain = new THREE.MeshStandardMaterial({ map: texture });
  const cut = new THREE.MeshStandardMaterial({ map: texture, alphaTest: 0.5 }); // dice pips, chip decals
  // Runs a phase-in; draw = the clone was rendered (compiled) before the effect ended.
  const run = async (phaser, scene, material, renderer = null) => {
    const root = phaseRoot(scene, material);
    const done = phaser.phaseIn(root, { duration: 0.1 });
    const clone = root.children[0].material;
    let disposed = false;
    clone.addEventListener("dispose", () => (disposed = true));
    renderer?.draw(root);
    phaser.update(0.2);
    await done;
    return { clone, disposed: () => disposed };
  };

  // Without a renderer (variant key): the alphaTest clone no longer shares the plain map keeper.
  let scene = new THREE.Scene();
  let phaser = new Phaser({ scene });
  const first = await run(phaser, scene, plain);
  const second = await run(phaser, scene, cut);
  assert.ok(!first.disposed() && !second.disposed(), "both variants kept");
  assert.ok([...phaser.keepers.values()].includes(second.clone));
  phaser.dispose();

  // With the renderer: keepers are keyed by the compiled program.
  scene = new THREE.Scene();
  phaser = new Phaser({ scene });
  const renderer = fakeRenderer();
  phaser.precompile(renderer, new THREE.PerspectiveCamera());
  assert.ok([...phaser.keepers.keys()].every((k) => k.startsWith("prog:")), "warmed keepers re-keyed by program");
  const size = phaser.keepers.size;
  const unseen = await run(phaser, scene, cut); // spawned out of view: never compiled
  assert.ok(unseen.disposed(), "an undrawn clone is not kept");
  assert.equal(phaser.keepers.size, size);
  const seen = await run(phaser, scene, cut, renderer);
  assert.ok(!seen.disposed() && [...phaser.keepers.values()].includes(seen.clone), "first drawn alphaTest clone kept");
  const again = await run(phaser, scene, cut, renderer);
  assert.ok(again.disposed(), "same program: the keeper already holds it");
  const map = await run(phaser, scene, plain, renderer);
  assert.ok(map.disposed(), "plain map variant was warmed by precompile");
  phaser.dispose();
});

test("warmUp compiles the whole scene (hidden things too) and loose materials with the scene's lights", async () => {
  const { warmUp } = await import("../js/world/phase.js");
  const { inkMaterial, haloMaterial } = await import("../js/parts/build/sketch.js");
  const scene = new THREE.Scene();
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  hidden.visible = false;
  scene.add(hidden);
  const calls = [];
  const renderer = { compile: (root, camera, target) => calls.push({ root, target, materials: (() => { const l = []; root.traverse((o) => o.material && l.push(o.material)); return l; })() }) };
  const label = new THREE.SpriteMaterial();
  warmUp(renderer, scene, new THREE.PerspectiveCamera(), [inkMaterial(), haloMaterial(), label]);
  assert.equal(calls[0].root, scene, "whole scene first");
  assert.ok(calls[0].materials.includes(hidden.material));
  const stage = calls.find((c) => c.root !== scene);
  assert.equal(stage.target, scene, "lights and fog come from the real scene");
  for (const m of [inkMaterial(), haloMaterial(), label]) assert.ok(stage.materials.includes(m));
  assert.ok(stage.root.children.length === 0, "throwaway stage emptied");
  warmUp(null, scene, null); // no renderer: no-op
});

test("XR builds the teleport arc hidden up front so the warm-up compiles it", async () => {
  const { XR } = await import("../js/xr/xr.js");
  const scene = new THREE.Scene();
  const renderer = { xr: { getController: () => new THREE.Group(), getControllerGrip: () => new THREE.Group() } };
  const xr = new XR({ renderer, scene, camera: new THREE.PerspectiveCamera(), rig: new THREE.Group() });
  const arc = scene.getObjectByName("teleport");
  assert.ok(arc && !arc.visible, "in the scene, hidden");
  assert.equal(xr._ensureTeleportFx().root, arc, "reused when aiming");
});

test("blob shadows skip support tests while nothing moves and follow a moved table", async () => {
  const hand = { p: new THREE.Vector3(3, 1, 3), q: new THREE.Quaternion() };
  const { room, objects, add, phaser } = setup({ hands: { "u1:right": hand } });
  const table = add("card table", { p: [0, 0, 0] });
  const top = getMeta("card table").surface;
  const ball = add("ball", { p: [0, top, 0] });
  await phaser.settle();
  for (let i = 0; i < 90; i++) objects.update(1 / 60, i / 60); // fully appeared
  let calls = 0;
  const support = objects._support.bind(objects);
  objects._support = (...args) => {
    calls++;
    return support(...args);
  };
  const ballShadowY = () => new THREE.Vector3().setFromMatrixPosition(objects.shadows.getMatrixAt(1, new THREE.Matrix4())).y;
  for (let i = 0; i < 10; i++) objects.update(1 / 60, 2 + i / 60);
  assert.equal(calls, 0, "a still room does no support tests");
  assert.ok(near(ballShadowY(), top + 0.012, 0.01), `shadow on the table top (${ballShadowY()})`);
  room.apply({ t: "set", id: table, patch: { p: [5, 0, 0] }, transient: true });
  objects.update(1 / 60, 3);
  assert.ok(calls > 0, "a moved surface re-tests");
  assert.ok(near(ballShadowY(), 0.012, 0.01), `shadow back on the ground (${ballShadowY()})`);

  // Held while the table comes back, then put back exactly where it was: no stale support.
  room.apply({ t: "set", id: ball, patch: { attach: { user: "u1", hand: "right", grip: "snap" } } });
  objects.update(1 / 60, 4);
  room.apply({ t: "set", id: table, patch: { p: [0, 0, 0] }, transient: true });
  objects.update(1 / 60, 4.1);
  objects.update(1 / 60, 4.2);
  room.apply({ t: "set", id: ball, patch: { attach: null, p: [0, top, 0] }, transient: true });
  objects.update(1 / 60, 4.4);
  assert.ok(near(ballShadowY(), top + 0.012, 0.01), `shadow on the table again (${ballShadowY()})`);
});

// Minimal 2D canvas so text textures (hit labels) exist in Node.
async function withFakeCanvas(fn) {
  const ctx = new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : key === "measureText" ? (t) => ({ width: String(t).length * 10 }) : () => ctx),
    set: (target, key, value) => ((target[key] = value), true),
  });
  const had = "document" in globalThis;
  const old = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  try {
    await fn();
  } finally {
    if (had) globalThis.document = old;
    else delete globalThis.document;
  }
}

test("hit labels reuse one retired sprite material, so its program survives the last target", async () => {
  await withFakeCanvas(async () => {
    const { room, objects, add, phaser } = setup();
    const a = add("training dummy");
    await phaser.settle();
    const first = objects.entries.get(a).label.material;
    let disposed = 0;
    first.addEventListener("dispose", () => disposed++);
    room.apply({ t: "del", ids: [a] });
    await phaser.settle();
    assert.equal(disposed, 0, "the last label material is kept as the spare");
    assert.equal(first.map, null, "without its texture");
    const b = add("training dummy", { p: [2, 0, 0] });
    assert.equal(objects.entries.get(b).label.material, first, "reused by the next label");
    assert.ok(first.map?.isTexture);
    const c = add("training dummy", { p: [4, 0, 0] });
    const second = objects.entries.get(c).label.material;
    assert.notEqual(second, first);
    let disposedSecond = 0;
    second.addEventListener("dispose", () => disposedSecond++);
    room.apply({ t: "clear" });
    await phaser.settle();
    assert.equal(disposed + disposedSecond, 1, "one spare kept, the other disposed");
    objects.dispose();
    assert.equal(disposed + disposedSecond, 2, "dispose frees the spare");
  });
});

test("pen-up strokes append to the drawing in place; edits, undo and limits rebuild", async () => {
  const { room, objects, add } = setup();
  const s1 = { c: "#9b6bff", w: 0.012, pts: [0, 1, 0, 0.25, 1, 0, 0.5, 1, 0] };
  const s2 = { c: "#ff3366", w: 0.01, pts: [0, 1.2, 0, 0.1, 1.25, 0, 0.2, 1.2, 0, 0.3, 1.3, 0] };
  const id = add("drawing", { data: { strokes: [s1] } });
  const wrapper = objects.get(id);
  const ink = wrapper.getObjectByName("ink");
  const count = ink.geometry.drawRange.count;
  room.apply({ t: "set", id, patch: { data: { strokes: [s1, s2] } } });
  assert.equal(objects.get(id), wrapper, "not rebuilt");
  assert.ok(ink.geometry.drawRange.count > count, "the new stroke's triangles are drawn");
  assert.ok(ink.geometry.attributes.position.updateRanges.length > 0, "only the new span is uploaded");
  // Same mesh as a fresh build of both strokes.
  const fresh = build.buildObject({ id: "x", part: "drawing", p: [0, 0, 0], data: { strokes: [s1, s2] } }).getObjectByName("ink");
  assert.equal(ink.geometry.drawRange.count, fresh.geometry.drawRange.count);
  const used = fresh.geometry.drawRange.count;
  assert.deepEqual([...ink.geometry.index.array.slice(0, used)], [...fresh.geometry.index.array.slice(0, used)]);
  const n = Math.max(...fresh.geometry.index.array.slice(0, used)) + 1;
  assert.deepEqual([...ink.geometry.attributes.position.array.slice(0, n * 3)], [...fresh.geometry.attributes.position.array.slice(0, n * 3)]);
  assert.ok(objects.bounds(id).containsPoint(new THREE.Vector3(0.3, 1.3, 0)), "bounds grew with the new stroke");
  // A data patch that keeps the strokes (behavior) changes nothing.
  room.apply({ t: "set", id, patch: { data: { strokes: [s1, s2], behavior: { kind: "none" } } } });
  assert.equal(objects.get(id), wrapper);
  // Undo (fewer strokes) and edited old strokes rebuild.
  room.apply({ t: "set", id, patch: { data: { strokes: [s1] } } });
  const undone = objects.get(id);
  assert.notEqual(undone, wrapper);
  room.apply({ t: "set", id, patch: { data: { strokes: [{ ...s1, c: "#00ff00" }, s2] } } });
  assert.notEqual(objects.get(id), undone);
});

test("picking ignores the drawing halo, and skipDrawings ignores drawings entirely", () => {
  const { objects, add } = setup();
  const id = add("drawing", { data: { strokes: [{ c: "#9b6bff", w: 0.012, pts: [0, 1, 0, 0.5, 1, 0] }] } });
  const through = (y) => new THREE.Raycaster(new THREE.Vector3(0.25, y, 2), new THREE.Vector3(0, 0, -1));
  assert.equal(objects.pick(through(1))?.id, id, "the ink is hit");
  assert.equal(objects.pick(through(1), { skipDrawings: true }), null);
  assert.equal(objects.pick(through(1.012)), null, "inside the halo only: nothing");
});

test("ended screen streams are released once no screen shows them", async () => {
  const pruned = [];
  const share = { textureFor: () => null, prune: (shown) => pruned.push([...shown]) };
  const scene = new THREE.Scene();
  const room = new Room();
  const phaser = fakePhaser();
  const objects = new SceneObjects({ scene, room, build, phaser, share });
  room.apply({ t: "add", obj: { id: "m1", part: "monitor", p: [0, 0, 0], ry: 0, s: 1, data: { stream: "s1" } } });
  await phaser.settle();
  objects.update(0.6, 0);
  assert.deepEqual(pruned.at(-1), ["s1"], "a shown stream is kept");
  room.apply({ t: "del", ids: ["m1"] });
  await phaser.settle();
  objects.update(0.6, 1);
  assert.deepEqual(pruned.at(-1), [], "no screen shows it any more");
});
