// Remaster step 11 (LOOK-BIBLE.md section 5, long tail): every built-in part and every alias builds with lit family
// materials and its base on the ground, boxes are chamfered, wide round primitives have 24 segments, and lathe and
// extrusion normals crease at 35 degrees. Claude (Command), Oct 26 2026.
import test from "node:test";
import assert from "node:assert/strict";
import { allMeta, getMeta } from "../js/parts/meta/index.js";
import { matchPart } from "../js/core/lexicon.js";
import { buildObject, hasBuilder } from "../js/parts/build/index.js";
import { kit, THREE, mat, box, cyl, lathe, extrude, measure, bevelFor, segmentsFor, creaseNormals, BEVEL, ROUND, CREASE_DEG } from "../js/parts/build/kit.js";

const metas = allMeta();
// Emissive and transparent kinds are flat by design (a lamp's glass, a screen's glow); every lit surface carries the family maps.
const FLAT_OK = new Set(["glass", "glow"]);
const build = (name) => buildObject({ id: "t", part: name, label: name, p: [0, 0, 0], ry: 0, s: 1, data: {} });
const triangles = (root) => {
  let n = 0;
  root.traverse((o) => { if (o.isMesh && o.geometry) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  return Math.round(n);
};

test("the catalog has its 139 built-in parts and every alias resolves to a built part", () => {
  assert.equal(metas.length, 139, `built-in parts: ${metas.length}`);
  let aliases = 0;
  for (const meta of metas) {
    assert.ok(hasBuilder(meta.name), `no builder: ${meta.name}`);
    assert.equal(getMeta(meta.name)?.name, meta.name);
    // aliases resolve through the lexicon (what "spawn a hatchet" uses), to the catalog name getMeta and the builder know
    for (const alias of meta.aliases || []) {
      aliases++;
      const hit = matchPart(alias, metas, { anchored: true });
      assert.equal(hit?.name, meta.name, `alias "${alias}" of ${meta.name} matched ${hit?.name}`);
      assert.equal(hit.score, 1, `alias "${alias}" is an exact phrase`);
      assert.ok(hasBuilder(getMeta(hit.name).name), `alias "${alias}" reaches a builder`);
    }
  }
  assert.ok(aliases >= 139, `aliases: ${aliases}`);
});

let total = 0;
for (const meta of metas) {
  test(`"${meta.name}" builds lit with family maps and its base within 10 mm of the ground`, () => {
    const object = build(meta.name);
    assert.ok(!object.userData.meta.placeholder, "fell back to placeholder");
    const inner = object.userData.inner;
    const flat = [];
    inner.traverse((o) => {
      if (!o.isMesh || o.userData.phaseHelper) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m || !m.isMeshStandardMaterial || m.visible === false || m.wireframe) continue;
        if (FLAT_OK.has(m.userData?.kind)) continue;
        if (!m.map || (m.userData?.recipe && (!m.normalMap || !m.roughnessMap))) flat.push(`${o.name || "mesh"} (${m.userData?.kind ?? "no kind"})`);
      }
    });
    assert.deepEqual(flat, [], `${meta.name}: flat lit materials`);
    const { min } = measure(inner);
    // within 10 mm of the ground (yard parts like rocks, logs and the pond sink exactly 10 mm into the grass by design)
    assert.ok(Math.abs(min[1]) <= 0.01 + 1e-6, `${meta.name}: base at y=${min[1].toFixed(4)}, expected within 10 mm of 0`);
    total += triangles(inner);
  });
}

test("all built-in parts together stay under 400k triangles after the chamfers", () => {
  assert.ok(total > 50000 && total < 400000, `${total} triangles over ${metas.length} parts`);
});

test("bevelFor: 6-12 mm from the thinnest side, none on sheets, o.bevel wins", () => {
  assert.equal(bevelFor([0.1, 0.1, 0.1]), 0.008);
  assert.equal(bevelFor([2, 2, 2]), BEVEL.max);
  assert.equal(bevelFor([0.02, 0.5, 0.5]), BEVEL.min);
  assert.equal(bevelFor([0.015, 0.5, 0.5]), 0, "a 15 mm board keeps square edges");
  assert.equal(bevelFor([0.004, 0.3, 0.2]), 0, "a sheet keeps square edges");
  assert.equal(bevelFor([1, 1, 1], { bevel: 0 }), 0);
  assert.equal(bevelFor([1, 1, 1], { bevel: 0.02 }), 0.02);
});

test("box: chamfered, exact bounds, outward normals, metre UVs; sheets and pictures stay plain boxes", () => {
  const wood = mat("#8a6440", "plank");
  const m = box([0.5, 0.3, 0.2], wood);
  const g = m.geometry;
  assert.equal(g.userData.bevel, 0.012);
  assert.equal(g.index.count / 3, 44, "6 faces + 12 strips + 8 corners");
  assert.equal(g.attributes.position.count, 96);
  g.computeBoundingBox();
  const size = g.boundingBox.getSize(new THREE.Vector3()).toArray();
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(size[i] - [0.5, 0.3, 0.2][i]) < 1e-6, `bounds ${size}`);
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const dot = p.getX(i) * n.getX(i) + p.getY(i) * n.getY(i) + p.getZ(i) * n.getZ(i);
    assert.ok(Number.isFinite(dot) && dot > 0, `vertex ${i} normal points inward or is NaN`);
    const len = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
    assert.ok(Math.abs(len - 1) < 1e-6, `vertex ${i} normal length ${len}`);
    assert.ok(Number.isFinite(uv.getX(i)) && Number.isFinite(uv.getY(i)));
  }
  // every triangle winds outward: its geometric normal agrees with the stored normal
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cb = new THREE.Vector3(), ab = new THREE.Vector3();
  for (let t = 0; t < g.index.count; t += 3) {
    const [i, j, k] = [g.index.getX(t), g.index.getX(t + 1), g.index.getX(t + 2)];
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, j); c.fromBufferAttribute(p, k);
    cb.subVectors(c, b); ab.subVectors(a, b); cb.cross(ab);
    assert.ok(cb.lengthSq() > 1e-12, `degenerate triangle ${t / 3}`);
    assert.ok(cb.x * n.getX(i) + cb.y * n.getY(i) + cb.z * n.getZ(i) > 0, `triangle ${t / 3} winds inward`);
  }
  assert.equal(g.groups.length, 6, "BoxGeometry group order kept");
  // UVs are metres: the +x face spans 0.2 m in u (z) and 0.3 m in v (y), minus the bevel on each side
  const face = g.groups[0];
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (let k = face.start; k < face.start + 6; k++) { const i = g.index.getX(k); umin = Math.min(umin, uv.getX(i)); umax = Math.max(umax, uv.getX(i)); vmin = Math.min(vmin, uv.getY(i)); vmax = Math.max(vmax, uv.getY(i)); }
  assert.ok(Math.abs(umax - umin - (0.2 - 0.024)) < 1e-6 && Math.abs(vmax - vmin - (0.3 - 0.024)) < 1e-6, `face uv span ${umax - umin} x ${vmax - vmin}`);
  // the same size is one cached geometry
  assert.equal(box([0.5, 0.3, 0.2], mat("#333333", "metal")).geometry, g);
  // a sheet, an opt-out and a picture material keep the plain 12-triangle box
  assert.equal(box([0.5, 0.3, 0.004], wood).geometry.type, "BoxGeometry");
  assert.equal(box([0.5, 0.3, 0.2], wood, { bevel: 0 }).geometry.type, "BoxGeometry");
  const picture = new THREE.MeshStandardMaterial({ map: new THREE.DataTexture(new Uint8Array(4), 1, 1) });
  assert.equal(box([0.5, 0.3, 0.2], picture).geometry.type, "BoxGeometry");
  assert.equal(box([0.5, 0.3, 0.2], picture).geometry.index.count / 3, 12);
});

test("round primitives: 24 segments past 0.1 m radius, deliberate facets kept, small ones unchanged", () => {
  assert.equal(segmentsFor(0.2, undefined), ROUND.segments);
  assert.equal(segmentsFor(0.05, undefined), 16);
  assert.equal(segmentsFor(0.2, 10), 24);
  assert.equal(segmentsFor(0.2, 6), 6, "a hexagonal lantern stays hexagonal");
  assert.equal(segmentsFor(0.05, 10), 10);
  const wood = mat("#8a6440", "wood");
  assert.equal(cyl([0.2, 0.2, 1], wood).geometry.parameters.radialSegments, 24);
  assert.equal(cyl([0.3, 0.3, 0.2], wood, { seg: 12 }).geometry.parameters.radialSegments, 24);
  assert.equal(cyl([0.05, 0.05, 1], wood, { seg: 10 }).geometry.parameters.radialSegments, 10);
  assert.equal(cyl([0.16, 0.16, 1], wood, { seg: 6 }).geometry.parameters.radialSegments, 6);
});

function normalsByPosition(g) {
  const p = g.attributes.position, n = g.attributes.normal, buckets = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(5)},${p.getY(i).toFixed(5)},${p.getZ(i).toFixed(5)}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push([n.getX(i), n.getY(i), n.getZ(i)]);
  }
  return buckets;
}

test("lathe: a 90-degree rim stays creased and a curved belly shades smooth", () => {
  assert.equal(CREASE_DEG, 35);
  const clay = mat("#c8b090", "ceramic");
  // a cup: flat bottom, then a vertical wall: the corner at (r 0.05, y 0) is a 90-degree crease
  const cup = lathe([[0, 0], [0.05, 0], [0.05, 0.1]], clay, { seg: 24 });
  assert.equal(cup.geometry.index, null, "creased normals are non-indexed");
  let creased = 0;
  for (const [k, list] of normalsByPosition(cup.geometry)) {
    const [, y] = k.split(",").map(Number);
    if (Math.abs(y) > 1e-6) continue;
    const r = Math.hypot(+k.split(",")[0], +k.split(",")[2]);
    if (Math.abs(r - 0.05) > 1e-4) continue;
    creased++;
    for (const nn of list) assert.ok(Math.abs(nn[1]) > 0.99 || Math.abs(nn[1]) < 0.01, `rim vertex blended: ${nn}`);
    assert.ok(list.some((nn) => nn[1] < -0.99) && list.some((nn) => Math.abs(nn[1]) < 0.01), `rim has both the bottom and the wall normal: ${JSON.stringify(list)}`);
  }
  assert.ok(creased >= 24, `rim vertices checked: ${creased}`);
  // a belly: a profile along a circular arc, 20 degrees between faces, blends to one normal per position
  const arc = [];
  for (let i = 0; i <= 9; i++) { const t = -Math.PI / 2 + (i / 9) * Math.PI; arc.push([0.05 + 0.03 * Math.cos(t), 0.05 + 0.05 * Math.sin(t)]); }
  const belly = lathe(arc, clay, { seg: 24 });
  let shared = 0;
  for (const [, list] of normalsByPosition(belly.geometry)) {
    if (list.length < 2) continue;
    shared++;
    for (const nn of list) for (let c = 0; c < 3; c++) assert.ok(Math.abs(nn[c] - list[0][c]) < 1e-5, `belly vertex has split normals: ${JSON.stringify(list)}`);
  }
  assert.ok(shared >= 24 * 8, `smooth belly positions: ${shared}`);
});

test("extrude: a rounded outline shades smooth across its curve and stays crisp at the faces", () => {
  const steel = mat("#b0b4b8", "metal");
  // a disc outline: 36 edges of 10 degrees each, all blended; the front and back faces meet the rim at 90 degrees
  const outline = [];
  for (let i = 0; i < 36; i++) outline.push([0.1 * Math.cos((i / 36) * Math.PI * 2), 0.1 * Math.sin((i / 36) * Math.PI * 2)]);
  const disc = extrude(outline, 0.02, steel);
  let rim = 0, blendedBad = 0;
  for (const [k, list] of normalsByPosition(disc.geometry)) {
    const [x, y, z] = k.split(",").map(Number);
    if (Math.abs(Math.hypot(x, y) - 0.1) > 1e-4) continue;
    rim++;
    const side = list.filter((nn) => Math.abs(nn[2]) < 0.01);
    const face = list.filter((nn) => Math.abs(nn[2]) > 0.99);
    if (side.length + face.length !== list.length) blendedBad++;
    if (side.length > 1) for (const nn of side) for (let c = 0; c < 2; c++) if (Math.abs(nn[c] - side[0][c]) > 1e-5) blendedBad++;
  }
  assert.ok(rim >= 72, `rim positions: ${rim}`);
  assert.equal(blendedBad, 0, "rim normals: smooth around the curve, creased against the faces");
});

test("creaseNormals keeps a flat quad flat and leaves no NaN", () => {
  const g = creaseNormals(new THREE.PlaneGeometry(1, 1));
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) assert.deepEqual([n.getX(i), n.getY(i), n.getZ(i)], [0, 0, 1]);
  assert.ok(kit.creaseNormals === creaseNormals && kit.BEVEL === BEVEL);
});
