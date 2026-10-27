// Materialize (LOOK-BIBLE.md section 7, build order step 5): sizing by height and footprint, shimmer motes on the seam
// through the real dot3d particle system, the ring and dust-settle rules, the in-hand variant, the seam light and its
// tier cap, phase-out motes falling, and the rebind hook for the later model swap. Claude (Command), Oct 26 2026.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../vendor/three.module.min.js";
import { Phaser, materializeSpec } from "../js/world/phase.js";
import { createParticles } from "../js/dot3d/particles.js";
import { Room } from "../js/room.js";
import * as build from "../js/parts/build/index.js";
import { SceneObjects } from "../js/world/objects.js";

const near = (a, b, eps) => Math.abs(a - b) <= eps;
const DT = 1 / 60;

function part(w, h, d, { name = "part", at = [0, 0, 0] } = {}) {
  const root = new THREE.Group();
  root.name = name;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: "#8a6a4a" }));
  mesh.position.y = h / 2;
  root.add(mesh);
  root.position.fromArray(at);
  return { root, mesh };
}

// Runs one reveal to the end at 60 fps and returns its log entry.
async function run(phaser, root, opts, { extraSeconds = 0 } = {}) {
  let done = false;
  const promise = phaser.phaseIn(root, opts).then(() => (done = true));
  for (let i = 0; i < 600 && !done; i++) {
    phaser.update(DT);
    await Promise.resolve();
  }
  await promise;
  for (let t = 0; t < extraSeconds; t += DT) phaser.update(DT);
  return phaser.log.at(-1);
}

test("materializeSpec reproduces the bible's numbers", () => {
  const mug = materializeSpec(0.1, 0.0064), dummy = materializeSpec(1.82, 0.35), house = materializeSpec(6.92, 40);
  const villa = materializeSpec(9.04, 72), castle = materializeSpec(15.3, 400), crate = materializeSpec(0.9, 0.8);
  assert.equal(mug.duration, 1.2);
  assert.ok(near(dummy.duration, 1.2184, 1e-6));
  assert.ok(near(house.duration, 1.8304, 1e-6));
  assert.ok(near(villa.duration, 2.0848, 1e-6));
  assert.equal(castle.duration, 2.6);
  assert.deepEqual([mug.band, villa.band], [0.05, 0.25]);
  assert.ok(near(dummy.band, 0.0946, 1e-6));
  assert.deepEqual([mug.motes, dummy.motes, crate.motes, villa.motes], [12, 26, 44, 400]);
  assert.deepEqual([mug.ring, dummy.ring, villa.ring], [false, true, true]);
  assert.deepEqual([mug.dust, dummy.dust, villa.dust, castle.dust], [0, 0, 24, 24]);
  assert.deepEqual([mug.lightIntensity, dummy.lightIntensity, villa.lightIntensity], [2, 2.73, 10]);
  assert.deepEqual([mug.lightDistance, villa.lightDistance], [1, 18.08]);
  // Quest halves anything above 100 motes; smaller totals are untouched.
  assert.equal(materializeSpec(9.04, 72, { tier: "quest" }).motes, 200);
  assert.equal(materializeSpec(1.82, 0.35, { tier: "quest" }).motes, 26);
  // In hand: 0.9 s, motes only.
  const sword = materializeSpec(1.0, 0.0025, { inHand: true });
  assert.deepEqual([sword.duration, sword.ring, sword.dust, sword.motes], [0.9, false, 0, 12]);
  const held = materializeSpec(4, 1, { inHand: true });
  assert.deepEqual([held.duration, held.ring, held.dust], [0.9, false, 0]);
});

test("a villa reveals in 2.08 s with 400 motes on the seam, a ring, a seam light and a dust settle at the base", async () => {
  const scene = new THREE.Scene();
  const particles = createParticles(THREE, { maxParticles: 3000, seed: 5 });
  let active = 2;
  const phaser = new Phaser({ scene, particles, tier: "laptop", lightCap: 16, activeLights: () => active });
  assert.equal(phaser.light.parent, scene, "seam light lives in the scene from the start");
  assert.equal(phaser.light.intensity, 0);
  const villa = part(9, 9.04, 8, { name: "obj:villa", at: [3, 0, -5] });
  scene.add(villa.root);

  let lightSeen = 0, lightY = [], topFrame = -1, dustFrame = -1;
  let done = false;
  const promise = phaser.phaseIn(villa.root).then(() => (done = true));
  assert.ok(phaser.isPhasing(villa.root));
  assert.notEqual(villa.mesh.material.color.getHexString(), undefined);
  assert.equal(phaser.light.visible, true);
  // Motes land on the footprint's perimeter at the seam height, never inside the volume. The particles are not stepped
  // here, so every alive mote still sits where it spawned: on the outline, at or below the current seam, the newest at it.
  const checkPerimeter = () => {
    const { pos, alive, kind, capacity } = particles.state;
    const reveal = Math.min(Math.max(phaser.jobs.get(villa.root).uniforms.uReveal.value, 0), 9.04);
    let newest = -1;
    for (let i = 0; i < capacity; i++) {
      if (!alive[i] || kind[i] !== 3) continue;
      const x = pos[i * 3] - 3, y = pos[i * 3 + 1], z = pos[i * 3 + 2] + 5;
      const toEdge = Math.min(Math.abs(x + 4.5), Math.abs(x - 4.5), Math.abs(z + 4), Math.abs(z - 4));
      assert.ok(toEdge <= 0.03 && Math.abs(x) <= 4.52 && Math.abs(z) <= 4.02, `mote off the perimeter: ${x.toFixed(3)}, ${z.toFixed(3)}`);
      assert.ok(y >= -0.03 && y <= reveal + 0.03, `mote above the seam: y ${y.toFixed(3)} reveal ${reveal.toFixed(3)}`);
      newest = Math.max(newest, y);
    }
    // Bursts come every 50 ms and the seam of a villa climbs up to 0.13 m a frame early on: the newest mote trails by under half a metre.
    assert.ok(newest >= reveal - 0.5, `no mote near the seam: newest ${newest.toFixed(3)} reveal ${reveal.toFixed(3)}`);
  };
  for (let i = 0; i < 400 && !done; i++) {
    phaser.update(DT);
    if (phaser.light.intensity > 0) {
      lightSeen++;
      lightY.push(phaser.light.position.y);
      assert.ok(near(phaser.light.distance, 18.08, 1e-3), `distance ${phaser.light.distance}`); // float32 box bounds
      assert.ok(phaser.light.intensity <= 10 + 1e-9);
    }
    if (i === 30 || i === 60) checkPerimeter();
    if (topFrame < 0 && phaser.jobs.get(villa.root)?.topAt !== null) topFrame = i;
    if (dustFrame < 0 && particles.stats().byKind.dust > 0) dustFrame = i;
    await Promise.resolve();
  }
  await promise;
  const entry = phaser.log.at(-1);
  assert.equal(entry.name, "obj:villa");
  assert.ok(near(entry.duration, 2.0848, 1e-6));
  assert.ok(near(entry.seconds, 2.0848, DT + 1e-6), `seconds ${entry.seconds}`);
  assert.ok(entry.frames === 126 || entry.frames === 125, `frames ${entry.frames}`);
  assert.ok(Math.abs(entry.motes - 400) <= 2, `motes ${entry.motes}`);
  assert.equal(particles.stats().byKind.shimmer, entry.motes);
  assert.deepEqual([entry.ring, entry.dust, entry.light, entry.lightIntensity, entry.band], [true, 24, true, 10, 0.25]);
  assert.ok(lightSeen > 60, "the seam light burned through most of the reveal");
  assert.ok(lightY[0] < 1 && lightY.at(-1) > 8, "the light rode the seam from the base to the roof");
  assert.ok(Math.max(...lightY) <= 9.05, "the light never leaves the part's height");
  assert.equal(phaser.light.intensity, 0, "idle again after the reveal");
  assert.equal(phaser.group.children.length, 0, "ring removed");
  // Dust settles 0.3 s after the seam cleared the top (the band runs 1.2 bands past the roof, so that is before the end).
  assert.ok(topFrame > 60 && topFrame < 120, `top cleared at frame ${topFrame}`);
  assert.ok(dustFrame - topFrame >= 17 && dustFrame - topFrame <= 20, `dust ${dustFrame - topFrame} frames after the top (want 18)`);
  for (let t = 0; t < 0.4; t += DT) phaser.update(DT);
  assert.equal(phaser.settles.length, 0);
  assert.equal(particles.stats().byKind.dust, 24, "one 24-puff settle, tinted by the ground");
  phaser.dispose();
  assert.equal(phaser.light.parent, null);
  particles.dispose();
});

test("a coffee mug gets 1.2 s, 12 motes, a 2 cd flash and no ring or dust; in hand a sword takes 0.9 s with motes only", async () => {
  const scene = new THREE.Scene();
  const particles = createParticles(THREE, { maxParticles: 500, seed: 3 });
  const phaser = new Phaser({ scene, particles });
  const mug = part(0.08, 0.1, 0.08, { name: "obj:mug", at: [3.28, 0.76, -2.2] });
  scene.add(mug.root);
  const m = await run(phaser, mug.root, undefined, { extraSeconds: 0.5 });
  assert.deepEqual([m.duration, m.ring, m.dust, m.light, m.lightIntensity, m.band, m.inHand], [1.2, false, 0, true, 2, 0.05, false]);
  assert.ok(m.frames === 72 || m.frames === 73, `frames ${m.frames}`);
  assert.ok(Math.abs(m.motes - 12) <= 2, `motes ${m.motes}`);
  assert.equal(phaser.settles.length, 0);
  assert.equal(particles.stats().byKind.dust, 0);

  const sword = part(0.05, 1.0, 0.05, { name: "obj:sword", at: [0.3, 1.2, -0.5] });
  sword.root.rotation.z = 1.2; // held: the reveal runs grip to tip in the object's own height
  scene.add(sword.root);
  const before = particles.stats().byKind.shimmer;
  const s = await run(phaser, sword.root, { inHand: true }, { extraSeconds: 0.5 });
  assert.deepEqual([s.duration, s.ring, s.dust, s.inHand], [0.9, false, 0, true]);
  assert.ok(s.frames === 54 || s.frames === 55, `frames ${s.frames}`);
  assert.ok(Math.abs(s.motes - 12) <= 2 && particles.stats().byKind.shimmer - before === s.motes, `motes ${s.motes}`);
  assert.equal(particles.stats().byKind.dust, 0, "in hand: no dust");
  // An explicit duration still wins (callers such as quick removals rely on it).
  const quick = await run(phaser, mug.root, { duration: 0.2 });
  assert.equal(quick.duration, 0.2);
  phaser.dispose();
  particles.dispose();
});

test("phase-out keeps 0.7 s, shows no ring and throws its motes downward", async () => {
  const scene = new THREE.Scene();
  const particles = createParticles(THREE, { maxParticles: 500, seed: 9 });
  const phaser = new Phaser({ scene, particles });
  const crate = part(0.9, 0.9, 0.9, { name: "obj:crate" });
  scene.add(crate.root);
  let done = false;
  phaser.phaseOut(crate.root).then(() => (done = true));
  assert.equal(phaser.group.children.length, 0, "no ring on the way out");
  for (let i = 0; i < 10; i++) phaser.update(DT);
  const { vel, alive, kind, capacity } = particles.state;
  let seen = 0;
  for (let i = 0; i < capacity; i++) {
    if (!alive[i] || kind[i] !== 3) continue;
    seen++;
    assert.ok(vel[i * 3 + 1] <= 0, `phase-out mote rising: vy ${vel[i * 3 + 1]}`);
  }
  assert.ok(seen > 0, "motes were spawned");
  for (let i = 0; i < 60 && !done; i++) {
    phaser.update(DT);
    await Promise.resolve();
  }
  const out = phaser.log.at(-1);
  assert.deepEqual([out.dir, out.duration, out.ring, out.dust], [-1, 0.7, false, 0]);
  phaser.dispose();
  particles.dispose();
});

test("the seam light obeys the tier's point-light cap and the newest reveal drives it", async () => {
  const scene = new THREE.Scene();
  let active = 4;
  const phaser = new Phaser({ scene, tier: "quest", lightCap: 4, activeLights: () => active });
  const a = part(1, 1.82, 1, { name: "obj:dummy" });
  scene.add(a.root);
  const full = await run(phaser, a.root);
  assert.equal(full.light, false, "cap full: the seam light stays off");
  assert.equal(phaser.light.visible, false);
  active = 3;
  const b = part(1, 1.82, 1, { name: "obj:dummy-2", at: [2, 0, 0] });
  scene.add(b.root);
  let peak = 0;
  const promise = phaser.phaseIn(b.root);
  for (let i = 0; i < 20; i++) {
    phaser.update(DT);
    peak = Math.max(peak, phaser.light.intensity);
  }
  assert.equal(phaser.light.visible, true);
  assert.ok(peak > 2 && peak <= 2.73 + 1e-3, `peak ${peak}`);
  // A second reveal takes the light over; finishing it hands the light back to the one still running.
  const c = part(0.5, 0.5, 0.5, { name: "obj:small", at: [-2, 0, 0] });
  scene.add(c.root);
  phaser.phaseIn(c.root, { duration: 0.3 });
  assert.equal(phaser.lightJob.object, c.root);
  for (let i = 0; i < 20; i++) phaser.update(DT);
  assert.equal(phaser.lightJob.object, b.root, "light handed back to the running reveal");
  phaser.cancel(b.root);
  await promise;
  assert.equal(phaser.lightJob, null);
  assert.equal(phaser.light.intensity, 0);
  // Quest halves the villa's motes: the planned total is what the particle budget sees.
  const v = part(9, 9.04, 8, { name: "obj:villa", at: [10, 0, 0] });
  scene.add(v.root);
  const villa = await run(phaser, v.root, { duration: 0.1 });
  assert.equal(villa.plannedMotes, 200);
  phaser.dispose();
});

test("rebind re-patches a swapped model at the same reveal height (the band hides the swap)", async () => {
  const scene = new THREE.Scene();
  const phaser = new Phaser({ scene });
  const proxy = part(1, 2, 1, { name: "obj:proxy" });
  scene.add(proxy.root);
  const original = proxy.mesh.material;
  const promise = phaser.phaseIn(proxy.root);
  for (let i = 0; i < 20; i++) phaser.update(DT);
  const job = phaser.jobs.get(proxy.root);
  const revealBefore = job.uniforms.uReveal.value;
  assert.ok(revealBefore > 0 && revealBefore < 2);
  // The loader arrives: the sculpt goes, the model comes in under the same root.
  proxy.root.remove(proxy.mesh);
  const model = new THREE.Mesh(new THREE.BoxGeometry(1, 2.2, 1), new THREE.MeshStandardMaterial({ color: "#445566" }));
  model.position.y = 1.1;
  const modelMaterial = model.material;
  proxy.root.add(model);
  assert.equal(phaser.rebind(proxy.root), true);
  assert.equal(proxy.mesh.material, original, "the sculpt's material was restored");
  assert.notEqual(model.material, modelMaterial, "the model is patched");
  assert.ok(model.material.userData.phaseClone);
  assert.ok(model.children.some((s) => s.userData.phaseHelper), "shell on the model");
  assert.ok(near(job.uniforms.uReveal.value, revealBefore, 0.05), "reveal height carried over");
  assert.equal(phaser.rebind(new THREE.Group()), false);
  for (let i = 0; i < 200 && phaser.isPhasing(proxy.root); i++) phaser.update(DT);
  await promise;
  assert.equal(model.material, modelMaterial, "restored at the end");
  assert.equal(model.children.length, 0);
  phaser.dispose();
});

test("objects pass the in-hand flag to the phaser for attached records", () => {
  const calls = [];
  const phaser = { phaseIn: (object, opts) => { calls.push(opts); return new Promise(() => {}); }, phaseOut: () => Promise.resolve(), cancel() {}, burst() {} };
  const scene = new THREE.Scene(), room = new Room();
  new SceneObjects({ scene, room, build, phaser, getHand: () => null });
  room.apply({ t: "add", obj: { id: "h1", part: "sword", label: "sword", p: [0, 1, 0], ry: 0, s: 1, attach: { user: "u1", hand: "right" } } });
  room.apply({ t: "add", obj: { id: "g1", part: "crate", label: "crate", p: [1, 0, 0], ry: 0, s: 1 } });
  assert.deepEqual(calls.map((c) => c.inHand), [true, false]);
});
