import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { LocalLights, fireFlicker } from '../js/world/local-lights.js';
import { Field } from '../js/world/field.js';
import { tierBudget } from '../js/dot3d/tiers.js';
import { builders as nature } from '../js/parts/build/nature.js';
import { builders as structures } from '../js/parts/build/structures.js';
import { colliderShapes } from '../js/physics/colliders.js';

test('tiers cap actual visible lights; walking and removal update selection and glows', () => {
  for (const [tier, count] of [['quest', 4], ['tablet', 8], ['laptop', 16]]) {
    const scene = new THREE.Scene(), rig = new LocalLights(scene, tierBudget(tier).pointLights);
    const lamps = Array.from({ length: 20 }, (_, i) => {
      const lamp = new THREE.PointLight('#ffcf8a', 18, 14, 2);
      lamp.position.set(i * 2, 3.4, 0); lamp.userData.fieldLight = { intensity: 18 }; scene.add(lamp); return lamp;
    });
    rig.update(new THREE.Vector3(), 0);
    assert.equal(lamps.filter(l => l.visible).length, count);
    assert.ok(lamps.slice(0, count).every(l => l.visible && !l.castShadow));
    rig.update(new THREE.Vector3(40, 0, 0), 1);
    assert.ok(lamps.slice(-count).every(l => l.visible));
    scene.remove(lamps[19]); rig.update(new THREE.Vector3(40, 0, 0), 2);
    assert.equal(rig.entries.size, 19); assert.equal(lamps.slice(0, 19).filter(l => l.visible).length, count);
    const container = new THREE.Group(); scene.add(container); container.add(lamps[18]); container.visible = false;
    rig.update(new THREE.Vector3(40, 0, 0), 3); assert.equal(lamps[18].visible, false);
    container.visible = true; rig.update(new THREE.Vector3(40, 0, 0), 4); assert.equal(lamps[18].visible, true);
    rig.dispose(); assert.equal(rig.entries.size, 0); assert.equal(rig.group.parent, null);
  }
});

test('lamp and fire emit at the specified positions, keep colliders and flicker bounded', () => {
  const scene = new THREE.Scene(), rig = new LocalLights(scene, 4);
  const lamp = structures['lamp post']({}), fire = nature.campfire({ seed: 0 }); scene.add(lamp, fire);
  const shapes = [colliderShapes(lamp), colliderShapes(fire)];
  rig.update(new THREE.Vector3(), 0);
  const lights = [...rig.entries.keys()]; assert.equal(lights.length, 2);
  const l = lights.find(l => !l.userData.fieldLight.fire), f = lights.find(l => l.userData.fieldLight.fire);
  assert.deepEqual([l.position.y, l.intensity, l.distance, l.decay], [3.4, 18, 14, 2]);
  assert.deepEqual([f.position.y, f.intensity, f.distance, f.decay], [.35, 10, 9, 2]);
  assert.equal(rig.entries.get(l).halo.scale.x, 2.2);
  assert.equal(rig.entries.get(l).glow.geometry.parameters.width, 3);
  assert.equal(rig.entries.get(f).glow.geometry.parameters.width, 2);
  for (let i = 0; i < 1000; i++) assert.ok(fireFlicker(i / 100) >= .75 && fireFlicker(i / 100) <= 1.25);
  rig.update(new THREE.Vector3(), .03); assert.notEqual(f.intensity, 10);
  assert.deepEqual([colliderShapes(lamp), colliderShapes(fire)], shapes);
  rig.dispose();
});

test('night and dawn presets and three-second crossfade reach the bible values', () => {
  const scene = new THREE.Scene(), renderer = { toneMappingExposure: 1, getPixelRatio: () => 1 };
  // No WebGL renderer: PMREM belongs to the GPU capture check.
  const field = new Field({ scene, tier: 'quest', quality: 'low' }); field.renderer = renderer;
  field.setTime('night', { instant: true });
  // Values from LOOK-BIBLE.md section 3a (the Oct 26 de-cartoon grade): night fill 0.45, dawn sun 2.2 with fill 0.5.
  assert.equal(field.sun.intensity, .5); assert.equal(field.hemi.intensity, .45);
  assert.equal(renderer.toneMappingExposure, 1.15); assert.equal(field.mist.group.visible, false);
  field.setTime('dawn'); field.update(1.5, 1.5, new THREE.Vector3());
  assert.ok(field.sun.intensity > .5 && field.sun.intensity < 2.2);
  assert.ok(field.mist.uniforms.density.value > 0 && field.mist.uniforms.density.value < .03);
  field.update(1.5, 3, new THREE.Vector3());
  assert.equal(field.sun.intensity, 2.2); assert.equal(field.hemi.intensity, .5);
  assert.equal(renderer.toneMappingExposure, .95); assert.equal(field.mist.uniforms.density.value, .03);
  assert.equal(field.fog.color.getHexString(THREE.SRGBColorSpace), 'd3aab4');
  assert.equal(field.mist.group.children.length, 0, 'mist adds no geometry or draw calls');
  field.setTime('day', { instant: true }); assert.equal(field.mist.group.visible, false);
  field.dispose(); assert.equal(scene.children.length, 0);
});
