// Claude (Command), Oct 25 2026. Real hand poses are THREE objects (desktop.handPose, xr.handPose).
// Spreading a THREE.Quaternion copied _x/_y/_z/_w, the drive went NaN and Rapier zeroed the hand's mass.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import RAPIER from '../vendor/rapier/dist/rapier.mjs';
import { createPhysicsWorld } from '../js/dot3d/physics.js';
import { createBus } from '../js/dot3d/bus.js';
await RAPIER.init();

test('a hand driven by THREE Vector3/Quaternion poses keeps its mass and follows the controller', () => {
  const core = createPhysicsWorld(RAPIER, createBus());
  try {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(.6, .3, 0));
    const pose = { p: new THREE.Vector3(.28, 1.32, -.5), q };
    for (let i = 0; i < 30; i++) { core.targetHand('right', pose); core.advance(1 / 90); }
    const h = core.hands.get('right');
    assert.ok(Math.abs(h.body.mass() - 1) < 1e-6, `hand mass ${h.body.mass()}`);
    const w = h.body.angvel();
    assert.ok([w.x, w.y, w.z].every(Number.isFinite), 'angular velocity stays finite');
    pose.p = new THREE.Vector3(.28, 1.02, -.8);
    pose.q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-.4, 1.1, .2));
    for (let i = 0; i < 90; i++) { core.targetHand('right', pose); core.advance(1 / 90); }
    const p = h.body.translation(), r = h.body.rotation();
    assert.ok(new THREE.Vector3(p.x, p.y, p.z).distanceTo(pose.p) < .02, 'hand reaches the moved controller');
    assert.ok(new THREE.Quaternion(r.x, r.y, r.z, r.w).angleTo(pose.q) < .1, 'hand turns with the controller');
  } finally { core.dispose(); }
});

test('a held 5.7 kg ball stays at the palm under a rotated THREE pose', () => {
  const core = createPhysicsWorld(RAPIER, createBus());
  try {
    core.add('__floor', { p: { x: 0, y: -.1, z: 0 }, fixed: true, shapes: [{ p: { x: 0, y: 0, z: 0 }, size: { x: 40, y: .2, z: 40 }, material: 'stone' }] });
    const pose = { p: new THREE.Vector3(.28, 1.32, -.5), q: new THREE.Quaternion().setFromEuler(new THREE.Euler(.61, 0, 0)) };
    const ball = core.add('ball', { p: { x: .2, y: 1.2, z: -.55 }, shapes: [{ p: { x: 0, y: .11, z: 0 }, size: { x: .22, y: .22, z: .22 }, shape: 'ball', material: 'rubber' }] });
    for (let i = 0; i < 5; i++) { core.targetHand('right', pose); core.advance(1 / 90); }
    assert.equal(core.grab('right', 'ball'), true);
    const start = new THREE.Vector3().copy(ball.translation()).distanceTo(core.hands.get('right').body.translation());
    for (let i = 0; i < 180; i++) { core.targetHand('right', pose); core.advance(1 / 90); }
    const d = new THREE.Vector3().copy(ball.translation()).distanceTo(core.hands.get('right').body.translation());
    assert.ok(Math.abs(d - start) < .01, `joint holds the ball at the palm (start ${start}, now ${d})`);
    assert.ok(ball.translation().y > 1, 'the ball is held up, not lying on the floor');
    const w = core.hands.get('right').body.angvel();
    assert.ok(Math.hypot(w.x, w.y, w.z) < .5, `the held weight does not swing the hand: ${Math.hypot(w.x, w.y, w.z)} rad/s`);
  } finally { core.dispose(); }
});
