// Effects with causes (LOOK-BIBLE.md section 7, build order step 6): the contact bridge tags each collider's surface beside
// its physics material, the core annotates every contact with the prop ids, the striker's biting edge and whether the striker
// is blunt, and the dot3d particles and decals answer by what struck what: straw wisps and never a cut on straw, a gash along
// the blade's edge in wood, green dust and flecks plus a trodden press on grass, blunt weapons at x0.7 and marking only above
// 4 N*s, a 'bite' when a blade sticks, rate emitters for the campfire that lean with the wind, and a tracked contact blob.
// Owner, Oct 23 2026 (Codex transmitter): "If I smack a wall with my sword, it should put an axe mark into the wall. It should
// do something ... The world should respond as the world would really respond." Claude (Command), Oct 26 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../vendor/three.module.min.js';
import { Room } from '../js/room.js';
import { SceneObjects } from '../js/world/objects.js';
import * as build from '../js/parts/build/index.js';
import { Interact } from '../js/play/interact.js';
import { PhysicsRoom, initPhysics } from '../js/physics/sync.js';
import { colliderShapes } from '../js/physics/colliders.js';
import { createBus } from '../js/dot3d/bus.js';
import { createParticles, defaultRules, biteRules, EFFECTS } from '../js/dot3d/particles.js';
import { createDecals, contactDecal, biteDecal, DECAL_RULES } from '../js/dot3d/decals.js';
import { makeVfxTextures } from '../js/dot3d/vfx-textures.js';
await initPhysics();
build.setPhysicsColliders(true);
const DEG = Math.PI / 180;
const UP = { x: 0, y: 1, z: 0 };
const record = (id, part, p, extra = {}) => ({ id, part, p, ry: 0, s: 1, label: part, ...extra });
const FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -90 * DEG);
const flat = { physicsPose: [FLAT.x, FLAT.y, FLAT.z, FLAT.w] };
const wall = (mat) => ({ blueprint: { name: mat + ' wall', size: [5, 3, .1], parts: [{ shape: 'box', p: [0, 1.5, 0], s: [5, 3, .1], mat, color: '#818b91' }] } });
const vec = (o) => new THREE.Vector3(o.x, o.y, o.z);
const sum = (o, keys) => keys.reduce((n, k) => n + (o[k] || 0), 0);
const MARKS = ['scuff', 'gash', 'scorch', 'skid', 'chip'];

// A bus with a particle pool and a decal pool on it, no physics: the rules alone.
function pools({ maxParticles = 600, maxDecals = 32 } = {}) {
  const bus = createBus(), scene = new THREE.Scene();
  const tex = makeVfxTextures(THREE, { size: 16 });
  const particles = createParticles(THREE, { scene, bus, maxParticles, textures: tex, seed: 7 });
  const decals = createDecals(THREE, { scene, bus, maxDecals, textures: tex, seed: 7 });
  return { bus, scene, particles, decals, dispose() { particles.dispose(); decals.dispose(); for (const t of Object.values(tex)) t.dispose(); } };
}
const contact = (over) => ({ point: { x: 0, y: 1.2, z: -1.15 }, normal: { x: 0, y: 0, z: 1 }, impulse: 15, relVelocity: { x: 0, y: 0, z: -4 },
  materials: ['metal', 'wood'], surfaces: ['steel', 'plank'], colliders: [1, 2], ids: ['sword', 'crate'], striker: 0,
  edge: { id: 'sword', dir: { x: 0, y: 1, z: 0 }, along: 0.1 }, blunt: false, time: 1, ...over });

// The physics path, as the hits and stick checks build it.
function setup(records) {
  const scene = new THREE.Scene(), room = new Room(), ops = [];
  const objects = new SceneObjects({ scene, room, build });
  const send = (op) => { ops.push(op); room.apply(op, { local: true }); };
  const physics = new PhysicsRoom({ objects, room, send });
  room.load({ objects: Object.fromEntries(records.map((r) => [r.id, r])), order: records.map((r) => r.id), env: { time: 'day' } });
  physics.sync();
  const interact = new Interact({ objects, room, send, getUser: () => 'local', metaOf: build.metaOfRecord });
  const contacts = [], bites = [];
  physics.bus.on('contact', (e) => contacts.push(e)); physics.bus.on('bite', (e) => bites.push(e));
  const tex = makeVfxTextures(THREE, { size: 16 });
  const decals = createDecals(THREE, { scene, bus: physics.bus, maxDecals: 64, textures: tex });
  const particles = createParticles(THREE, { scene, bus: physics.bus, maxParticles: 900, textures: tex });
  const tick = (n, hands = {}) => { for (let i = 0; i < n; i++) { objects.update(1 / 90, i / 90); physics.setHands(hands); physics.update(1 / 90); particles.update(1 / 90); decals.update(1 / 90); } };
  return { scene, room, objects, physics, interact, tick, contacts, bites, decals, particles, dispose() { physics.dispose(); objects.dispose(); } };
}
const pose = (x, y, z) => ({ p: new THREE.Vector3(x, y, z), q: new THREE.Quaternion() });
function arm(s, id = 'sword', y = 1.3) {
  const hand = pose(0, 1.1, 0);
  s.physics.setHands({ right: hand });
  assert.equal(s.interact.grab('right', { point: hand.p, quat: hand.q }), id);
  s.tick(120, { right: hand });
  const raised = pose(0, y, -.1);
  s.tick(90, { right: raised });
  return raised;
}

test('the bible\'s check: 15 N*s steel on wood leaves one gash and 10 or more chips; 3 N*s on straw throws 4 or more wisps and cuts nothing', () => {
  const p = pools();
  try {
    p.bus.emit('contact', contact());
    let st = p.particles.stats(), ds = p.decals.stats();
    assert.ok(st.byKind.chips >= 10, 'wood chips off the blade: ' + JSON.stringify(st.byKind));
    assert.equal(st.byKind.wisps, 0); assert.equal(st.byKind.sparks, 0, 'steel on wood does not spark');
    assert.equal(ds.byKind.gash, 1, 'one gash: ' + JSON.stringify(ds.byKind));
    assert.equal(sum(ds.byKind, ['scuff', 'scorch', 'press', 'dent']), 0, 'the gash replaces the scuff');
    assert.equal(p.decals.count(), 1);
    const straw = pools();
    try {
      straw.bus.emit('contact', contact({ impulse: 3, materials: ['metal', 'soft'], surfaces: ['steel', 'straw'], ids: ['sword', 'dummy'], edge: null }));
      st = straw.particles.stats(); ds = straw.decals.stats();
      assert.ok(st.byKind.wisps >= 4, 'straw wisps: ' + JSON.stringify(st.byKind));
      assert.ok(st.byKind.dust > 0 && st.byKind.sparks === 0 && st.byKind.chips === 0, 'tinted dust, no sparks, no chips off straw: ' + JSON.stringify(st.byKind));
      assert.equal(sum(ds.byKind, MARKS), 0, 'straw is never cut or scuffed: ' + JSON.stringify(ds.byKind));
      // The step-4 rig check reads "a mark on the straw" (tests/physics-rig.test.mjs), so the blow presses the stalks: a faint dent, alpha <= 0.21.
      assert.ok(ds.byKind.dent <= 1, 'at most a dent');
      const { aColor } = straw.decals.state.attributes;
      for (let i = 0; i < straw.decals.state.capacity; i++) if (straw.decals.state.alive[i]) assert.ok(aColor.array[i * 4 + 3] <= 0.21 + 1e-6, 'dent alpha ' + aColor.array[i * 4 + 3]);
    } finally { straw.dispose(); }
  } finally { p.dispose(); }
});

test('rules by surface: grass landings throw green dust and flecks and press the grass; a thrown hay bale marks nothing; blunt weapons at x0.7 and no mark under 4 N*s; metal never sparks on straw', () => {
  // grass landing: a crate on the floor (stone to the solver, grass to the effects)
  const land = contact({ impulse: 5, materials: ['wood', 'stone'], surfaces: ['plank', 'grass'], ids: ['crate', '__floor'], edge: null, normal: UP, relVelocity: { x: 0, y: -3, z: 0 } });
  const rules = defaultRules(land);
  assert.deepEqual(rules.map((r) => r[0]).sort(), ['chips', 'dust'], 'dust and flecks only: ' + JSON.stringify(rules));
  const flecks = rules.find((r) => r[0] === 'chips');
  assert.deepEqual(flecks[2].size, [0.015, 0.03], 'grass flecks are 15-30 mm');
  assert.ok(flecks[2].color[1] > flecks[2].color[0] && flecks[2].color[1] > flecks[2].color[2], 'green flecks, not wood chips');
  assert.ok(Math.abs(flecks[1] - 0.3) < 1e-9 && Math.abs(rules.find((r) => r[0] === 'dust')[1] - 0.7) < 1e-9);
  assert.deepEqual(defaultRules({ ...land, impulse: 0.4 }), [], 'a light touch on grass does nothing');
  const d = contactDecal(land);
  assert.ok(d && d.kind === 'press' && d.size >= 0.1 && d.size <= 0.45, 'trodden grass: ' + JSON.stringify(d));
  // a crate landing elsewhere keeps the old rules (chips + dust by both materials, a scuff)
  const stoneLand = { ...land, surfaces: ['plank', 'stone'] };
  assert.deepEqual(defaultRules(stoneLand).map((r) => r[0]).sort(), ['chips', 'dust']);
  assert.equal(contactDecal(stoneLand).kind, 'scuff');
  // a thrown hay bale leaves nothing on the wall it hits; the straw side spawns wisps
  const bale = contact({ impulse: 6, materials: ['soft', 'stone'], surfaces: ['straw', 'stone'], ids: ['hay', 'wall'], edge: null });
  assert.equal(contactDecal(bale), null);
  assert.ok(defaultRules(bale).some((r) => r[0] === 'wisps'));
  // blunt: everything x0.7, a scuff only above 4 N*s
  const edged = contact({ impulse: 3, materials: ['wood', 'soft'], surfaces: ['wood', 'leather'], ids: ['bat', 'ball'], edge: null, blunt: false });
  const blunt = { ...edged, blunt: true };
  const chipsE = defaultRules(edged).find((r) => r[0] === 'chips')[1], chipsB = defaultRules(blunt).find((r) => r[0] === 'chips')[1];
  assert.ok(Math.abs(chipsB / chipsE - 0.7) < 1e-9, `blunt x0.7: ${chipsB} vs ${chipsE}`);
  assert.equal(contactDecal(blunt), null, 'a 3 N*s knock with a bat leaves no mark');
  assert.equal(contactDecal({ ...blunt, impulse: 6 }).kind, 'scuff', 'a 6 N*s bat hit scuffs');
  assert.equal(contactDecal(edged).kind, 'scuff', 'the same hit from an edgeless, unheld thing marks as before');
  assert.equal(DECAL_RULES.BLUNT_THRESHOLD, 4);
  // metal: sparks on stone and metal, none against straw
  const sparks = (over) => (defaultRules(contact(over)).find((r) => r[0] === 'sparks') || [0, 0])[1];
  assert.ok(sparks({ materials: ['metal', 'stone'], surfaces: ['steel', 'stone'] }) === 1 && sparks({ materials: ['metal', 'metal'], surfaces: ['steel', 'iron'] }) === 1.2);
  assert.equal(sparks({ materials: ['metal', 'soft'], surfaces: ['steel', 'straw'] }), 0);
  assert.equal(sparks({ materials: ['metal', 'soft'], surfaces: ['steel', 'leather'] }), 0, 'nothing soft sparks');
  assert.equal(sparks({ materials: ['metal', 'wood'], surfaces: ['steel', 'plank'] }), 0, 'steel on wood is chips and a gash, not sparks');
  // the kit's sword blade is a light `plastic` body under a `steel` surface: the surface sparks on stone
  assert.equal(sparks({ materials: ['stone', 'plastic'], surfaces: ['stone', 'steel'] }), 1, 'a steel surface sparks on stone whatever its solver material');
  assert.deepEqual(defaultRules(contact({ impulse: 20, materials: ['stone', 'plastic'], surfaces: ['stone', 'steel'], striker: 1, edge: null })).map((r) => r[0]).sort(), ['chips', 'dust', 'sparks'], 'and the blade side raises no plastic dust');
  // without surfaces (an old event) the rules read the materials as before
  const old = { impulse: 10, materials: ['metal', 'stone'] };
  assert.deepEqual(defaultRules(old).map((r) => r[0]).sort(), ['chips', 'dust', 'sparks']);
  assert.equal(contactDecal(old).kind, 'scuff');
  // a light touch (a crate rocking on a corner, a sword set down) raises dust and nothing else; 0.8 N*s and up chips and sparks
  assert.deepEqual(defaultRules({ ...old, impulse: 0.5 }).map((r) => r[0]), ['dust']);
  assert.deepEqual(defaultRules({ impulse: 0.6, materials: ['wood', 'wood'], surfaces: ['plank', 'plank'] }).map((r) => r[0]), ['dust']);
  const knock = defaultRules({ impulse: 12, materials: ['wood', 'wood'], surfaces: ['plank', 'plank'] }).find((r) => r[0] === 'chips');
  assert.ok(Math.abs(knock[1] - 0.5) < 1e-9, 'two crates knocking shed a quarter of an edge\'s chips: ' + knock[1]);
  assert.deepEqual(defaultRules({ ...old, impulse: 0.8 }).map((r) => r[0]).sort(), ['chips', 'dust', 'sparks']);
});

test('a gash lies along the blade\'s edge on the surface, 60-220 mm by the impulse; an edge driven straight in gets no direction; the flat of a blade scuffs', () => {
  const p = pools();
  try {
    const slot = p.decals.add(contactDecal(contact({ impulse: 15 })));
    const { aQuat, aSize, aTex } = p.decals.state.attributes;
    const q = new THREE.Quaternion(aQuat.array[slot * 4], aQuat.array[slot * 4 + 1], aQuat.array[slot * 4 + 2], aQuat.array[slot * 4 + 3]);
    const longAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(q), faceNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    assert.ok(Math.abs(longAxis.y) > 0.99, 'the slit runs along the edge (world y): ' + longAxis.toArray().map((v) => v.toFixed(3)));
    assert.ok(faceNormal.z > 0.99, 'and lies on the wall');
    assert.equal(aTex.array[slot], 3, 'the gash texture');
    const w = aSize.array[slot * 2], h = aSize.array[slot * 2 + 1];
    assert.ok(w >= 0.17 && w <= 0.22 && h < w / 5, `a 15 N*s gash is long and thin: ${w.toFixed(3)} x ${h.toFixed(3)}`);
    const light = contactDecal(contact({ impulse: 1 })), heavy = contactDecal(contact({ impulse: 40 }));
    assert.ok(light.size >= 0.06 && light.size < 0.1 && heavy.size === 0.22, `${light.size} .. ${heavy.size}`);
    // tilted edge: only its projection on the wall counts
    const tilted = p.decals.add(contactDecal(contact({ edge: { dir: { x: 0.6, y: 0.6, z: -0.53 } } })));
    const q2 = new THREE.Quaternion().fromArray(aQuat.array, tilted * 4);
    const ax2 = new THREE.Vector3(1, 0, 0).applyQuaternion(q2);
    assert.ok(Math.abs(ax2.z) < 1e-3 && Math.abs(Math.abs(ax2.x) - Math.abs(ax2.y)) < 1e-3, 'diagonal on the wall: ' + ax2.toArray().map((v) => v.toFixed(3)));
    // straight in: a gash still, with no preferred direction on the surface
    const into = contactDecal(contact({ edge: { dir: { x: 0, y: 0, z: -1 } } }));
    assert.equal(into.kind, 'gash');
    assert.ok(p.decals.add(into) >= 0);
    // the flat of the blade (no edge within reach) scuffs as before
    assert.equal(contactDecal(contact({ edge: null })).kind, 'scuff');
    // a blade on stone scuffs; a blade in wood that sticks cuts 120 mm; a blade in straw leaves nothing more
    assert.equal(contactDecal(contact({ materials: ['metal', 'stone'], surfaces: ['steel', 'stone'] })).kind, 'scuff');
    const bite = { id: 'axe', onId: 'crate', point: { x: 0, y: 1, z: -1.15 }, normal: { x: 0, y: 0, z: 1 }, dir: { x: 0, y: 0, z: -1 }, depth: 0.03, impulse: 12, material: 'wood', surface: 'plank', time: 2 };
    assert.deepEqual([biteDecal(bite).kind, biteDecal(bite).size], ['gash', 0.12]);
    assert.equal(biteDecal({ ...bite, material: 'soft', surface: 'straw' }), null);
    assert.deepEqual(biteRules(bite, 0).map((r) => [r[0], r[1].count]), [['chips', 8]]);
    assert.deepEqual(biteRules({ ...bite, material: 'soft', surface: 'straw' }, 0.99).map((r) => [r[0], r[1].count]), [['wisps', 14]]);
  } finally { p.dispose(); }
});

test('wisps fall slowly, drift with the wind, land and lie on the ground for 6 s; embers rise and cool; smoke rises and grows', () => {
  const p = pools({ maxParticles: 400 });
  try {
    const st = p.particles.state;
    p.particles.setWind({ x: 1, z: 0 }, 1);
    assert.equal(p.particles.burst('wisps', { point: { x: 0, y: 1, z: 0 }, normal: UP, impulse: 6 }), 24, 'a 6 N*s hit throws the most wisps');
    let aliveY = [], aliveX = [];
    for (let i = 0; i < 60; i++) p.particles.update(1 / 60);      // 1.0 s
    for (let i = 0; i < st.capacity; i++) if (st.alive[i] && st.kinds[st.kind[i]] === 'wisps') { aliveY.push(st.pos[i * 3 + 1]); aliveX.push(st.pos[i * 3]); }
    assert.ok(aliveY.length >= 16, 'still in the air or on the ground after 1 s: ' + aliveY.length);
    assert.ok(aliveX.reduce((a, b) => a + b, 0) / aliveX.length > 0.03, 'the wind carried them downwind: mean x ' + (aliveX.reduce((a, b) => a + b, 0) / aliveX.length).toFixed(3));
    for (let i = 0; i < 270; i++) p.particles.update(1 / 60);     // 5.5 s
    let resting = 0, flat = 0;
    for (let i = 0; i < st.capacity; i++) if (st.alive[i] && st.kinds[st.kind[i]] === 'wisps') { if (st.resting[i]) resting++; if (st.pos[i * 3 + 1] < 0.01) flat++; }
    assert.ok(resting >= 12 && flat >= 12, `most lie on the ground 5.5 s in (the rest faded in the air): resting ${resting}, flat ${flat}`);
    for (let i = 0; i < 300; i++) p.particles.update(1 / 60);     // 10.5 s
    assert.equal(p.particles.alive(), 0, 'gone after their linger');
    // a settled wisp is a flat card: the chips layer draws the kind's shape
    assert.deepEqual(EFFECTS.wisps.shape, [1, 0.08, 0.35]);
    assert.ok(EFFECTS.wisps.linger === 6 && EFFECTS.wisps.gravity === -2 && EFFECTS.wisps.size[0] === 0.02 && EFFECTS.wisps.size[1] === 0.06);
    // embers: buoyant, cooling ramp, 8-20 mm
    p.particles.setWind({ x: 0, z: 1 }, 1);
    const fire = p.particles.emitter('fire', { kind: 'ember', rate: 5, point: { x: 0, y: 0.5, z: 0 }, normal: UP });
    p.particles.emitter('smoke', { kind: 'smoke', rate: 2, point: { x: 0, y: 0.8, z: 0 }, normal: UP });
    for (let i = 0; i < 120; i++) p.particles.update(1 / 60);     // 2 s
    const stats = p.particles.stats();
    assert.ok(stats.byKind.ember >= 9 && stats.byKind.ember <= 11, '5 embers a second: ' + stats.byKind.ember);
    assert.ok(stats.byKind.smoke >= 3 && stats.byKind.smoke <= 5, '2 puffs a second: ' + stats.byKind.smoke);
    let emberY = 0, emberZ = 0, n = 0, smokeUp = 0, m = 0;
    for (let i = 0; i < st.capacity; i++) if (st.alive[i]) {
      const k = st.kinds[st.kind[i]];
      if (k === 'ember') { emberY += st.pos[i * 3 + 1]; emberZ += st.pos[i * 3 + 2]; n++; }
      if (k === 'smoke') { smokeUp += st.vel[i * 3 + 1]; m++; }
    }
    assert.ok(n > 0 && emberY / n > 0.5, 'embers rise: mean y ' + (emberY / n).toFixed(2));
    assert.ok(emberZ / n > 0.02, 'embers lean downwind: mean z ' + (emberZ / n).toFixed(3));
    assert.ok(m > 0 && smokeUp / m > 0.3 && smokeUp / m < 0.9, 'smoke rises about 0.6 m/s: ' + (smokeUp / m).toFixed(2));
    assert.deepEqual([EFFECTS.ember.size, EFFECTS.ember.life, EFFECTS.smoke.growth], [[0.008, 0.02], [1.2, 2.4], 3]);
    assert.deepEqual(p.particles.emitters().sort(), ['fire', 'smoke']);
    fire.set({ active: false });
    const before = p.particles.stats().byKind.ember;
    for (let i = 0; i < 60; i++) p.particles.update(1 / 60);
    assert.equal(p.particles.stats().byKind.ember, before, 'an emitter switched off spawns nothing');
    assert.ok(p.particles.removeEmitter('smoke') && !p.particles.removeEmitter('smoke'));
    assert.deepEqual(p.particles.emitters(), ['fire']);
    assert.equal(p.particles.burst('ember', { point: UP, count: 4 }), 4, 'count overrides the impulse formula');
  } finally { p.dispose(); }
});

test('a tracked blob keeps its slot while the pool recycles marks around it, follows each call and goes when released', () => {
  const p = pools({ maxDecals: 16 });
  try {
    const d = p.decals;
    const slot = d.track('blob:sword', { kind: 'blob', point: { x: 1, y: 0.004, z: 2 }, normal: UP, sizeW: 0.9, sizeH: 0.3, opacity: 0.8 });
    assert.ok(slot >= 0 && d.tracked() === 1 && d.count() === 1);
    const { aPos, aSize, aColor, aTex } = d.state.attributes;
    assert.equal(aTex.array[slot], 4, 'the radial falloff');
    assert.ok(Math.abs(aSize.array[slot * 2] - 0.9) < 1e-6 && Math.abs(aSize.array[slot * 2 + 1] - 0.3) < 1e-6, 'exact sizes, no variation');
    assert.ok(Math.abs(aColor.array[slot * 4 + 3] - 0.35 * 0.8) < 1e-6, 'blob opacity 0.35 x the caller\'s');
    for (let i = 0; i < 200; i++) d.add({ point: { x: i, y: 0, z: 0 }, normal: UP, size: 0.1 });
    assert.ok(d.state.alive[slot] && d.state.tracked[slot] && Math.abs(aPos.array[slot * 3] - 1) < 1e-6, 'two hundred marks later the blob is where it was');
    assert.equal(d.count(), 16, 'the rest of the pool filled around it');
    d.track('blob:sword', { kind: 'blob', point: { x: 3, y: 0.004, z: 2 }, normal: UP, sizeW: 0.5, sizeH: 0.5 });
    assert.ok(Math.abs(aPos.array[slot * 3] - 3) < 1e-6 && d.tracked() === 1, 'the same slot moved');
    for (let i = 0; i < 100; i++) d.update(1);                     // 100 s: every mark faded
    assert.ok(d.state.alive[slot] && d.count() === 1, 'a tracked blob never ages out');
    assert.ok(d.untrack('blob:sword') && !d.untrack('blob:sword'));
    assert.equal(d.count(), 0); assert.equal(aSize.array[slot * 2], 0);
    for (let i = 0; i < 4; i++) assert.ok(d.track('b' + i, { point: UP, normal: UP, sizeW: 0.1, sizeH: 0.1 }) >= 0);
    assert.equal(d.track('one too many', { point: UP, normal: UP, sizeW: 0.1, sizeH: 0.1 }), -1, 'a quarter of the pool at most');
    assert.ok(d.kinds.includes('gash') && d.kinds.includes('blob') && d.kinds.includes('press') && d.kinds.includes('dent'));
  } finally { p.dispose(); }
});

test('the real chain: colliders carry the kit surface; a held sword into the dummy throws straw wisps and cuts nothing, and the stick bites more; a thrown axe into a wooden wall gashes it and sheds chips; the floor is grass to the effects', () => {
  // surfaces from the kit: the dummy's straw body, the sword's steel blade and leather grip, the axe's iron head
  const kinds = (part) => { const w = build.buildObject(record('x', part, [0, 0, 0])); return new Set((w.userData.physicsShapes ?? colliderShapes(w)).map((s) => s.surface)); };
  assert.ok(kinds('training dummy').has('straw'), 'dummy: ' + [...kinds('training dummy')]);
  assert.ok(kinds('sword').has('steel'), 'sword: ' + [...kinds('sword')]);
  assert.ok(kinds('axe').has('iron'), 'axe: ' + [...kinds('axe')]);
  assert.ok(kinds('crate').has('plank') || kinds('crate').has('wood'), 'crate: ' + [...kinds('crate')]);
  const s = setup([record('sword', 'sword', [.04, 1.1, 0], { data: flat }), record('dummy', 'training dummy', [0, 0, -1.5])]);
  try {
    arm(s);
    const d0 = s.decals.stats(), p0 = s.particles.stats();
    let stuckAt = null;
    for (let i = 0; i < 60; i++) { s.tick(1, { right: pose(0, 1.3, -.8) }); if (stuckAt === null && s.physics.stuck('sword')) stuckAt = i; }
    const hit = s.contacts.find((c) => c.materials.includes('soft'));
    assert.ok(hit && hit.impulse >= 3, 'a real thrust: ' + hit?.impulse);
    assert.deepEqual([...hit.surfaces].sort(), ['steel', 'straw'], 'surfaces beside the materials: ' + hit.surfaces);
    assert.deepEqual([...hit.ids].sort(), ['dummy', 'sword'], 'the prop ids: ' + hit.ids);
    assert.ok(hit.edge && hit.edge.id === 'sword' && Math.abs(vec(hit.edge.dir).length() - 1) < 1e-6, 'the tip\'s edge within reach, as a unit direction: ' + JSON.stringify(hit.edge));
    assert.equal(hit.blunt, false);
    const d1 = s.decals.stats(), p1 = s.particles.stats();
    assert.ok(p1.byKind.wisps - p0.byKind.wisps >= 4, 'straw in the air: ' + JSON.stringify(p1.byKind));
    assert.equal(p1.byKind.chips - p0.byKind.chips, 0, 'no chips off straw');
    assert.equal(sum(d1.byKind, MARKS) - sum(d0.byKind, MARKS), 0, 'the straw is not cut or scuffed: ' + JSON.stringify(d1.byKind));
    assert.ok(stuckAt !== null, 'the thrust stuck');
    assert.equal(s.bites.length, 1, 'one bite for the stick');
    const bite = s.bites[0];
    assert.ok(bite.id === 'sword' && bite.onId === 'dummy' && bite.material === 'soft' && bite.surface === 'straw' && bite.dir && bite.point && bite.impulse >= 3, JSON.stringify(bite));
    assert.ok(p1.bites === 1 && d1.bites === 1, 'both pools heard it');
    assert.ok(Object.keys(s.physics.core.stickState('sword')).length === 7, 'the saved stick is unchanged');
  } finally { s.dispose(); }
  const BIT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const t = setup([record('axe', 'axe', [0, 1.4, -.5], { data: { physicsPose: [BIT.x, BIT.y, BIT.z, BIT.w] } }), record('wall', 'wood wall', [0, 0, -1.2], { data: wall('wood') })]);
  try {
    t.physics.entries.get('axe').body.setLinvel({ x: 0, y: 0, z: -6 }, true);
    t.tick(45, {});
    const c = t.contacts.find((c) => c.materials.includes('wood'));
    assert.ok(c && c.impulse > 5 && c.surfaces.some((x) => x === 'iron' || x === 'steel') && c.surfaces.includes('wood'), 'the axe\'s metal bit on wood: ' + JSON.stringify({ i: c?.impulse, s: c?.surfaces }));
    assert.ok(c.edge && c.edge.id === 'axe' && c.ids.includes('wall'), 'the bit within reach: ' + JSON.stringify(c.edge));
    assert.ok(t.physics.stuck('axe'), 'stuck in the wood');
    const ds = t.decals.stats(), ps = t.particles.stats();
    assert.ok(ds.byKind.gash >= 1, 'a gash in the wall: ' + JSON.stringify(ds.byKind));
    assert.ok(ps.byKind.chips >= 8, 'chips off the wood: ' + JSON.stringify(ps.byKind));
    assert.equal(t.bites.length, 1); assert.equal(t.bites[0].surface, 'wood');
    // the gash sits on the wall face
    const { aPos, aTex } = t.decals.state.attributes;
    let onFace = 0;
    for (let i = 0; i < t.decals.state.capacity; i++) if (t.decals.state.alive[i] && aTex.array[i] === 3 && Math.abs(aPos.array[i * 3 + 2] - (-1.15)) < 0.05) onFace++;
    assert.ok(onFace >= 1, 'gash on the face: ' + onFace);
    // dropped on the floor afterwards: green dust and flecks, a press, no stone chips (the floor is stone to the solver)
    t.physics.core.unstick('axe');
    const before = t.particles.stats(), dBefore = t.decals.stats();
    t.tick(200, {});
    const floor = t.contacts.find((e) => e.surfaces.includes('grass'));
    assert.ok(floor && floor.materials.includes('stone') && floor.ids.includes('__floor'), 'the floor is stone to the solver and grass to the effects: ' + JSON.stringify({ m: floor?.materials, s: floor?.surfaces, ids: floor?.ids }));
    const after = t.particles.stats(), dAfter = t.decals.stats();
    assert.ok(after.byKind.dust > before.byKind.dust && dAfter.byKind.press > dBefore.byKind.press, 'green dust and a press: ' + JSON.stringify({ p: after.byKind, d: dAfter.byKind }));
  } finally { t.dispose(); }
});

test('a landing on grass pulses the clearing wider for 0.4 s and back; the campfire declares its ember and smoke emitters', () => {
  const scene = new THREE.Scene(), room = new Room();
  const objects = new SceneObjects({ scene, room, build });
  room.load({ objects: { crate: record('crate', 'crate', [0, 0, 0]) }, order: ['crate'], env: { time: 'day' } });
  for (let i = 0; i < 30; i++) objects.update(1 / 60, i / 60);
  const map = scene.userData.fieldClearings;
  const r0 = map.get('crate').r;
  assert.ok(r0 > 0.15, 'the crate clears grass at rest: ' + r0);
  const entry = objects.entries.get('crate');
  entry.clearPulse = 0.4; entry.clearPulseLen = 0.4;
  let peak = 0;
  for (let i = 0; i < 12; i++) { objects.update(1 / 60, 1 + i / 60); peak = Math.max(peak, map.get('crate').r); }
  assert.ok(peak > r0 + 0.15 && peak <= r0 + 0.2 + 1e-6, `widens by up to 0.2 m: ${r0} -> ${peak}`);
  for (let i = 0; i < 30; i++) objects.update(1 / 60, 2 + i / 60);
  assert.ok(Math.abs(map.get('crate').r - r0) < 1e-6 && !(entry.clearPulse > 0), 'back to its rest radius after 0.4 s');
  objects.dispose();
  const fire = build.buildObject(record('f', 'campfire', [0, 0, 0]));
  const emitters = (fire.userData.inner ?? fire).userData.emitters;
  assert.deepEqual(emitters.map((e) => [e.kind, e.rate]), [['ember', 5], ['smoke', 2]]);
  assert.ok(emitters.every((e) => e.p.length === 3 && e.radius > 0 && e.range === 30));
  assert.equal(build.buildObject(record('c', 'crate', [0, 0, 0])).userData.inner?.userData.emitters, undefined, 'a crate has none');
});

test('the gash texture is a dark slit along u with tapered ends', () => {
  const tex = makeVfxTextures(THREE, { size: 32 });
  try {
    const g = tex.gash, d = g.image.data, n = 32;
    const at = (x, y) => ({ r: d[(y * n + x) * 4], a: d[(y * n + x) * 4 + 3] });
    const column = (x) => { let best = { a: -1, y: -1 }; for (let y = 0; y < n; y++) { const s = at(x, y); if (s.a > best.a) best = { ...s, y }; } return best; };
    const mid = column(16), end = column(0), end2 = column(31);
    assert.ok(mid.a > 200 && mid.r < 60 && Math.abs(mid.y - 16) <= 4, 'the slit is dark and solid near the middle row: ' + JSON.stringify(mid));
    assert.ok(at(16, 4).a < 40 && at(16, 28).a < 40, 'clear well off the slit: ' + at(16, 4).a + ', ' + at(16, 28).a);
    assert.ok(end.a < 80 && end2.a < 80, 'tapered at the ends: ' + end.a + ', ' + end2.a);
    assert.equal(g.name, 'vfx-gash');
    assert.deepEqual(Object.keys(tex).sort(), ['chip', 'dot', 'gash', 'scorch', 'scuff', 'smoke', 'spark']);
  } finally { for (const t of Object.values(tex)) t.dispose(); }
});
