// Kingdom skin (LOOK-BIBLE.md section 11, build order step 12): the trodden plaza with its worn ring, damp edge and cart
// ruts; the figure rig and its two-frame-per-step walk; hats, helm and wool robe; hanging name boards; chimney smoke and
// the night forge light; the stall's valance and the farm's furrows. Rules and counts in js/core/kingdom.js are covered by
// tests/kingdom.test.mjs, unchanged. Claude (Command), Oct 26 2026.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../vendor/three.module.min.js";
import { kit, measure, mergeStatic } from "../js/parts/build/kit.js";
import { builders, figure, nameBoard, walkPose, poseFigure, WALK, REST_POSE } from "../js/parts/build/kingdom.js";
import { buildObject } from "../js/parts/build/index.js";
import { getMeta } from "../js/parts/meta/index.js";
import { KingdomScene, PLAZA, plazaGeometry, plazaMaterial, plazaTint } from "../js/world/kingdom.js";
import { LocalLights } from "../js/world/local-lights.js";
import { Field } from "../js/world/field.js";
import { ADVISORS } from "../js/core/kingdom.js";

const DEG = Math.PI / 180;
const count = (o, pred = (x) => x.isMesh) => { let n = 0; o.traverse((x) => { if (pred(x)) n++; }); return n; };
const kinds = (o) => { const s = new Set(); o.traverse((x) => { if (x.isMesh) s.add(x.material.userData?.kind); }); return s; };

test("the walk cycle holds four poses per two steps: legs 25 degrees, arms 15 the other way, hips dipping to keep the soles down", () => {
  const apart = walkPose(0.1), pass = walkPose(0.3), other = walkPose(0.6), pass2 = walkPose(0.85);
  assert.deepEqual([apart.frame, pass.frame, other.frame, pass2.frame], [0, 1, 2, 3]);
  assert.equal(apart.legL, 25 * DEG);
  assert.equal(apart.legR, -25 * DEG);
  assert.equal(apart.armL, -15 * DEG, "arms swing opposite the legs");
  assert.equal(apart.armR, 15 * DEG);
  assert.equal(other.legL, -25 * DEG);
  assert.equal(pass.legL, 0);
  assert.equal(pass2.armR, 0);
  assert.ok(Math.abs(apart.dip - 0.76 * (1 - Math.cos(25 * DEG))) < 1e-9, "the dip is what the 0.76 m hip-to-foot loses at 25 degrees");
  assert.equal(pass.dip, 0);
  assert.equal(walkPose(1.1).frame, 0, "the cycle repeats");
  assert.equal(walkPose(-0.1).frame, 3, "negative phases wrap");
  assert.equal(walkPose(NaN), REST_POSE);
  assert.deepEqual(walkPose(0.1), walkPose(0.2), "a frame holds for a quarter cycle: two frames per step");
  assert.equal(WALK.stride, 1.3);
});

test("an animated figure keeps its limbs as pivoted groups through mergeStatic; the catalog peasant merges as before", () => {
  const f = figure({ animate: true });
  const rig = f.userData.rig;
  assert.ok(rig && rig.legs.length === 2 && rig.arms.length === 2);
  assert.deepEqual(rig.legs.map((l) => +l.position.y.toFixed(3)), [0.8, 0.8], "hips at 0.8 m");
  assert.deepEqual(rig.arms.map((a) => +a.position.y.toFixed(3)), [1.33, 1.33], "shoulders at 1.33 m");
  const before = count(f);
  mergeStatic(f);
  const limbMeshes = count(f, (x) => x.isMesh && x.userData.keep);
  assert.equal(limbMeshes, 8, "two meshes per limb stay apart");
  assert.ok(count(f) < before, "the rest merged");
  for (const l of rig.legs) assert.equal(l.children.length, 2, "a leg keeps its capsule and shoe");
  assert.equal(rig.shoes.length, 2);
  // Standing: feet on the ground, nothing below it.
  poseFigure(f, null);
  const stand = measure(f);
  assert.ok(Math.abs(stand.min[1]) <= 0.005, "soles at y = 0: " + stand.min[1]);
  assert.ok(stand.size[1] <= 1.72 + 0.02 && stand.size[1] > 1.6, "height " + stand.size[1]);
  // Legs apart: the swung legs end above the ground by the pose's dip, which the world subtracts from the root.
  const pose = poseFigure(f, 0.1);
  assert.equal(rig.legs[0].rotation.x, 25 * DEG);
  assert.equal(rig.shoes[0].rotation.x, -25 * DEG, "the shoe stays level on the swung leg");
  assert.equal(rig.arms[0].rotation.x, -15 * DEG);
  // Precise bounds: a plain AABB of the tilted capsule would hang below the real geometry.
  const precise = (o) => { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o, true); };
  const apart = precise(f);
  assert.ok(Math.abs(apart.min.y - pose.dip) < 0.005, `swung soles at ${apart.min.y.toFixed(3)} vs dip ${pose.dip.toFixed(3)}`);
  f.position.y = -pose.dip;
  assert.ok(Math.abs(precise(f).min.y) < 0.005, "the root dip puts both soles back on the ground");
  const robe = figure({ robe: true, animate: true });
  assert.equal(poseFigure(robe, 0.1).dip, 0, "a robed figure glides without a dip");
  // The catalog peasant is not animated: no kept meshes, so it merges into the same few draws as before this step.
  const peasant = buildObject({ id: "t", part: "peasant", label: "peasant", p: [0, 0, 0], ry: 0, s: 1, data: {} }).userData.inner;
  assert.equal(count(peasant, (x) => x.isMesh && x.userData.keep), 0);
  assert.equal(peasant.userData.rig, undefined);
  assert.ok(count(peasant) <= 9, "peasant draws: " + count(peasant));
  const meta = getMeta("peasant");
  const m = measure(peasant);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(m.size[i] - meta.size[i]) <= Math.max(0.05, meta.size[i] * 0.12), `peasant axis ${i}: ${m.size[i]}`);
});

test("hats, helm and wool robe use the bible's families and stay inside the figure's height", () => {
  const straw = figure({ hat: "straw" }), felt = figure({ hat: "felt" }), helm = figure({ hat: "helm" });
  assert.ok(kinds(straw).has("straw"));
  assert.ok(kinds(felt).has("felt"));
  assert.ok(kinds(helm).has("steel"), "the Marshal's helm is steel");
  assert.equal(count(helm, (x) => x.isMesh && x.material.userData?.kind === "steel"), 3, "cap, brim and nasal");
  for (const [name, f] of [["straw", straw], ["felt", felt], ["helm", helm]]) {
    const m = measure(f);
    assert.ok(m.size[1] <= 1.72 + 0.01, `${name} hat tops out at ${m.size[1]}`);
    assert.ok(Math.abs(m.min[1]) <= 0.005, name + " feet on the ground");
  }
  const robe = figure({ robe: true, wool: true, tunic: "#7a1f2b", hat: "crown", animate: true });
  const k = kinds(robe);
  assert.ok(k.has("felt") && !k.has("fabric"), "a wool robe has no linen: " + [...k]);
  assert.ok(robe.userData.rig && robe.userData.rig.arms.length === 2, "the robed figure still swings its arms");
  assert.equal(poseFigure(robe, 0.1).armL, -15 * DEG);
  const skin = []; robe.traverse((x) => { if (x.isMesh && x.material.color?.getHexString() === "d8a77c") skin.push(x); });
  assert.ok(skin.length >= 3, "skin #d8a77c on hands and head");
});

test("a name board is an oak board 1.1 x 0.24 m with pale letters, iron rings and chains, and can be renamed", () => {
  const b = nameBoard("Master Builder");
  const m = measure(b);
  assert.ok(Math.abs(m.size[0] - 1.1) < 0.02 && Math.abs(m.size[1] - (0.24 / 2 + 0.31)) < 0.03, `board ${m.size}`);
  assert.deepEqual(b.userData.board.size, [1.1, 0.24]);
  const panel = b.userData.board.panel;
  assert.equal(panel.userData.text, "Master Builder");
  panel.userData.setText("Lord Steward");
  assert.equal(panel.userData.text, "Lord Steward");
  const k = kinds(b);
  assert.ok(k.has("wood") && (k.has("metal") || k.has("iron")), [...k].join(","));
  assert.equal(count(b, (x) => x.isMesh && x.geometry.type === "TorusGeometry"), 2, "two rings");
  const board = b.children.find((x) => x.isMesh && x.geometry.userData?.bevel > 0);
  assert.ok(board, "the board is a chamfered box");
});

test("tavern and blacksmith breathe chimney smoke from their stack tops; the forge light burns at night", () => {
  for (const [name, top] of [["tavern", 7.6], ["blacksmith", 5.6]]) {
    const o = builders[name]({});
    const em = o.userData.emitters;
    assert.ok(Array.isArray(em) && em.length === 1, name + " has one emitter");
    assert.equal(em[0].kind, "smoke");
    assert.equal(em[0].rate, 1);
    assert.ok(em[0].p[1] >= top && em[0].p[1] <= top + 0.1, `${name} smoke starts at the stack top (${em[0].p[1]} vs ${top})`);
    const m = measure(o);
    assert.ok(Math.abs(m.size[1] - getMeta(name).size[1]) <= 0.05, `${name} height unchanged: ${m.size[1]}`);
    assert.ok(Math.abs(em[0].p[0]) <= m.size[0] / 2 && Math.abs(em[0].p[2]) <= m.size[2] / 2, "the stack is inside the footprint");
  }
  const smith = builders.blacksmith({ seed: 3 });
  const lights = []; smith.traverse((x) => { if (x.isPointLight) lights.push(x); });
  assert.equal(lights.length, 1);
  const l = lights[0];
  assert.equal(l.color.getHexString(), "ff8a3c");
  assert.deepEqual([l.intensity, l.distance, l.decay], [10, 7, 2]);
  assert.deepEqual({ ...l.userData.fieldLight, phase: 0 }, { intensity: 10, fire: true, night: true, phase: 0 });
  assert.ok(l.position.y > 1 && l.position.y < 2, "the light sits over the coals");
  const tavern = builders.tavern({});
  assert.ok(tavern.children.some((c) => c.name === "chimney"), "the tavern grew a chimney");
});

test("a night light is off and takes no slot by day, scales with the field's night factor, and the field reports it", () => {
  const scene = new THREE.Scene(), rig = new LocalLights(scene, 2);
  const lamp = new THREE.PointLight("#ffcf8a", 18, 14, 2); lamp.position.set(0, 3.4, 0); lamp.userData.fieldLight = { intensity: 18 };
  const forge = new THREE.PointLight("#ff8a3c", 10, 7, 2); forge.position.set(1, 1.5, 0); forge.userData.fieldLight = { intensity: 10, night: true };
  const far = new THREE.PointLight("#ffcf8a", 18, 14, 2); far.position.set(30, 3.4, 0); far.userData.fieldLight = { intensity: 18 };
  scene.add(lamp, forge, far);
  rig.update(new THREE.Vector3(), 0, 0);
  assert.equal(forge.visible, false, "day: the forge is dark");
  assert.equal(forge.intensity, 0);
  assert.equal(far.visible, true, "day: the forge's slot goes to the next lamp");
  assert.equal(rig.entries.has(forge), false, "no ground glow for a dark forge");
  rig.update(new THREE.Vector3(), 0, 1);
  assert.equal(forge.visible, true, "night: the forge burns");
  assert.equal(forge.intensity, 10);
  assert.equal(far.visible, false, "and takes the slot back from the far lamp");
  rig.update(new THREE.Vector3(), 0, 0.29);
  assert.ok(Math.abs(forge.intensity - 2.9) < 1e-9, "sunset: 29%");
  assert.equal(lamp.intensity, 18, "ordinary lamps ignore the night factor");
  rig.update(new THREE.Vector3(), 0);
  assert.equal(forge.visible, false, "the default (no factor) is day, as before this step");
  rig.dispose();
  const field = new Field({ scene: new THREE.Scene(), tier: "quest", quality: "low" });
  field.renderer = { toneMappingExposure: 1, getPixelRatio: () => 1 };
  const at = (time) => { field.setTime(time, { instant: true }); return +field.night().toFixed(2); };
  // Night factor from the blended sun strength between day (3.3 since the Oct 26 grade) and night (0.5): sunset 2.5, dawn 2.2.
  assert.deepEqual([at("day"), at("sunset"), at("dawn"), at("night")], [0, 0.29, 0.39, 1]);
  field.dispose();
});

test("the plaza is one textured dirt mesh: a worn ring at 6-8 m, a damp edge fading into the grass over 9-9.8 m, six ruts", () => {
  assert.deepEqual(plazaTint(3), [1, 1, 1, 1], "the inner disc is the base dirt");
  const ring = plazaTint(7);
  assert.ok(ring[0] > 1.1 && ring[2] > 1.2 && ring[3] === 1, "the worn ring is lighter: " + ring);
  const damp = plazaTint(8.9);
  assert.ok(damp[0] < 0.85 && damp[3] === 1, "the edge is darker and still solid: " + damp);
  assert.ok(plazaTint(9.4)[3] > 0.4 && plazaTint(9.4)[3] < 0.6, "half faded at 9.4 m");
  assert.equal(plazaTint(9.8)[3], 0, "gone at 9.8 m");
  const g = plazaGeometry();
  const info = g.userData.plaza;
  assert.equal(info.ruts, 6);
  assert.equal(info.rings, PLAZA.rings.length);
  assert.ok(info.triangles > 1500 && info.triangles < 3000, "triangles " + info.triangles);
  assert.equal(g.attributes.color.itemSize, 4, "RGBA vertex colours: the alpha makes the grass edge");
  assert.equal(g.attributes.uv.itemSize, 2);
  // UVs are world metres (the dirt family tiles at 1.5 m), and the ring vertices carry the ring tint.
  const pos = g.attributes.position, uv = g.attributes.uv, col = g.attributes.color;
  let ringLight = 0, ringSeen = 0, edgeAlpha0 = 0, ruts = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), r = Math.hypot(x, z);
    assert.ok(Math.abs(uv.getX(i) - x) < 1e-6 && Math.abs(uv.getY(i) - z) < 1e-6, "metre UVs");
    if (y > 0) { ruts++; assert.ok(r > 6.4 && r < 8, "a rut lies on the worn ring"); continue; }
    if (Math.abs(r - 7) < 1e-6) { ringSeen++; if (col.getZ(i) > 1.15) ringLight++; }
    if (Math.abs(r - 9.8) < 1e-6 && col.getW(i) === 0) edgeAlpha0++;
  }
  assert.equal(ringSeen, PLAZA.segments);
  assert.ok(ringLight >= PLAZA.segments * 0.9, "ring vertices lighter: " + ringLight);
  assert.equal(edgeAlpha0, PLAZA.segments, "the outer ring is fully transparent");
  assert.equal(ruts, 6 * 17 * 3, "rut vertices");
  const m = plazaMaterial();
  assert.ok(m.vertexColors && m.transparent && m.polygonOffset, "vertex tints over the dirt maps, blended at the edge");
  assert.equal(m.userData.recipe, "dirt");
  assert.ok(m.map && m.normalMap && m.roughnessMap, "the dirt family's three maps");
  assert.equal(m.color.getHexString(), "8a6a45");
  assert.equal(kit.mat("#8a6a45", "dirt").vertexColors, false, "the shared cached material is untouched");
});

test("in the scene: two clearings, a plaza mesh, advisors on boards and poles that walk the cycle and dip, no bob", () => {
  const scene = new THREE.Scene();
  const records = [
    { id: "c", part: "castle", p: [0, 0, -40], ry: 0 }, { id: "h1", part: "house", p: [12, 0, -24], ry: 0 },
    { id: "h2", part: "house", p: [-12, 0, -24], ry: 0 }, { id: "f", part: "farm field", p: [-6, 0, -34], ry: 0 },
    { id: "f2", part: "farm field", p: [6, 0, -34], ry: 0 },
  ];
  const SIZES = { castle: [16, 15.3, 16], house: [7.84, 6.92, 7.35], "farm field": [12.2, 1.9, 8.2] };
  const room = { records: () => records, on() {} };
  const kingdom = new KingdomScene({ scene, room, sizeOf: (r) => SIZES[r.part] });
  assert.equal(scene.userData.fieldClearings, undefined);
  kingdom.setEnabled(true);
  const clear = scene.userData.fieldClearings;
  assert.deepEqual(clear.get("kingdom-plaza"), { x: 0, z: 0, r: 9, k: 1, b: 1 }, "pressed flat and bare of stubs inside");
  assert.deepEqual(clear.get("kingdom-plaza-rim"), { x: 0, z: 0, r: 10, k: 0.6, b: 0 }, "trampled stubs at the rim");
  // The field sends the bare factor to the grass with the clearing.
  const field = new Field({ scene, tier: "quest", quality: "low" });
  field.renderer = { toneMappingExposure: 1, getPixelRatio: () => 1 };
  field.update(1 / 60, 0, new THREE.Vector3());
  const slots = field.shared.uClear.value.map((v, i) => [v.z, v.w, field.shared.uClearBare.value[i]]).filter((s) => s[0] > 0);
  assert.deepEqual(slots.sort(), [[10, 0.6, 0], [9, 1, 1]]);
  field.dispose();
  assert.equal(kingdom.plaza.rotation.x, 0, "the geometry already lies in XZ");
  assert.equal(kingdom.plaza.position.y, 0.01);
  assert.equal(kingdom.plaza.castShadow, false);
  assert.equal(kingdom.plaza.receiveShadow, true);
  assert.equal(kingdom.advisors.length, ADVISORS.length);
  for (const a of kingdom.advisors) {
    assert.ok(a.body.userData.rig, a.def.id + " has a rig");
    const sign = a.root.children.find((c) => c.name === "sign");
    assert.ok(sign, a.def.id + " carries a sign");
    assert.equal(count(sign), 3, "the sign is three draws: oak, iron, the lettered panel");
    assert.equal(a.board.name, "name-board");
    assert.equal(a.board.position.y, 2.05, "the board hangs at the old plate height");
    assert.equal(a.plate.userData.text, a.def.name);
    assert.ok(a.plate.parent, "the panel kept its own mesh for the emissive flash");
  }
  const look = kingdom.lookInfo();
  assert.deepEqual(look.advisors.map((a) => a.hat), ["straw", "crown", "helm"], "builder in straw, steward crowned, marshal in a helm");
  assert.equal(look.plaza.ruts, 6);
  assert.equal(look.villagers.rigged, 10);
  assert.equal(look.clearings.length, 2);
  // First frame places the advisors; walking the player 3 m makes them follow on the cycle, dipping, never rising.
  const head = { p: [0, 1.6, 0], yaw: 0 };
  kingdom.update(1 / 60, 0, head);
  const builder = kingdom.advisors[0];
  assert.equal(builder.walk, 0);
  assert.equal(builder.root.position.y, 0);
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  assert.ok(Math.abs(wrap(builder.root.rotation.y - Math.atan2(0 - builder.pos.x, 0 - builder.pos.z))) < 1e-9, "placed: faces the player");
  assert.equal(kingdom.plaza.renderOrder, -1, "the plaza draws first among transparents so the aim ring and ground glows blend over it");
  head.p = [0, 1.6, -3];
  let minY = 0, dipped = 0, frames = new Set(), facedTravel = 0;
  for (let i = 0; i < 120; i++) {
    kingdom.update(1 / 60, i / 60, head);
    minY = Math.min(minY, builder.root.position.y);
    assert.ok(builder.root.position.y <= 0, "no bob above the ground");
    if (builder.root.position.y < 0) dipped++;
    if (builder.moving) {
      frames.add(walkPose(builder.walk).frame);
      // Walking toward a slot that moved 3 m along -z: faces the way it walks (yaw pi), not the player beside it.
      if (i > 20 && Math.abs(wrap(builder.root.rotation.y - Math.PI)) < 0.05) facedTravel++;
    }
  }
  assert.ok(builder.walk > 1, "walked more than a cycle: " + builder.walk);
  assert.ok(dipped > 10 && Math.abs(minY + walkPose(0.1).dip) < 1e-6, `dips to -${walkPose(0.1).dip.toFixed(3)} on the apart frames`);
  assert.deepEqual([...frames].sort(), [0, 1, 2, 3], "all four frames shown");
  assert.ok(facedTravel > 20, "faced the travel direction while walking: " + facedTravel);
  for (let i = 0; i < 240; i++) kingdom.update(1 / 60, 2 + i / 60, head);
  assert.equal(builder.moving, false);
  assert.equal(builder.root.position.y, 0, "standing: no dip");
  assert.equal(builder.body.userData.rig.legs[0].rotation.x, 0, "standing: legs straight");
  assert.ok(Math.abs(wrap(builder.root.rotation.y - Math.atan2(head.p[0] - builder.pos.x, head.p[2] - builder.pos.z))) < 1e-6, "standing: turned back to face the player");
  // Villagers: homes and food make a population; they walk the same cycle and never float.
  assert.ok(kingdom.population >= 2, "population " + kingdom.population);
  let vWalked = false;
  for (let i = 0; i < 600; i++) {
    kingdom.update(1 / 60, 6 + i / 60, head);
    for (const v of kingdom.villagers) {
      if (!v.active) continue;
      assert.ok(v.body.position.y <= 0 && v.body.position.y >= -0.08, "villager y " + v.body.position.y);
      if (v.walk > 0.5) vWalked = true;
    }
  }
  assert.ok(vWalked, "a villager walked");
  kingdom.speak("builder");
  kingdom.update(1 / 60, 20, head);
  assert.ok(builder.talk > 0);
  kingdom.setEnabled(false);
  assert.equal(clear.has("kingdom-plaza") || clear.has("kingdom-plaza-rim"), false, "clearings removed");
  kingdom.dispose();
  assert.equal(kingdom.root.parent, null);
});

test("stall valance and farm furrows: the awning's stripes hang a valance from its front edge; eight dirt furrows between the rows", () => {
  const stall = builders["market stall"]({});
  const valance = []; stall.traverse((x) => { if (x.name === "valance") valance.push(x); });
  assert.equal(valance.length, 6);
  assert.ok(valance.every((v) => v.position.z > 0.7 && v.position.y > 2.6 && v.position.y < 2.9), "along the front edge");
  assert.equal(valance.filter((v) => v.userData.tint).length, 3, "the coloured stripes recolour with the awning");
  const ms = measure(stall), meta = getMeta("market stall");
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(ms.size[i] - meta.size[i]) <= Math.max(0.05, meta.size[i] * 0.12), `stall axis ${i}: ${ms.size[i]}`);
  const farm = builders["farm field"]({});
  const furrows = []; farm.traverse((x) => { if (x.name === "furrow") furrows.push(x); });
  assert.equal(furrows.length, 8);
  assert.ok(furrows.every((f) => f.material.userData.kind === "dirt"));
  const rows = farm.children.filter((c) => c.isMesh && c.material.userData.kind === "fabric" && c.userData.tint).map((c) => c.position.z).sort((a, b) => a - b);
  for (const f of furrows) assert.ok(rows.some((z) => Math.abs(f.position.z - (z + 0.4375)) < 1e-6), "a furrow lies between two rows");
  const soil = farm.children.find((c) => c.isMesh && c.position.y === 0.05);
  assert.equal(soil.material.userData.kind, "dirt", "the soil slab is dirt");
  assert.equal(kit.physOf("dirt"), "matte");
});
