// Builder toolkit for the parts bin: cached materials/geometries and positioned primitives.
// Conventions (see SPEC): meters, +Y up, every part's origin is the bottom-center of its
// bounding box (so y = 0 sits on the grass), and its front faces +Z.
import * as THREE from "../../../vendor/three.module.min.js";
import { drawText, canvasTexture, updateTextTexture } from "../../util/text.js";
import { createMaterials } from "../../dot3d/materials.js";
import { detectTier, tierBudget } from "../../dot3d/tiers.js";

export { THREE };

const DEG = Math.PI / 180;
const materials = new Map();
const geometries = new Map();

const KINDS = {
  matte: { roughness: 0.9, metalness: 0 },
  plastic: { roughness: 0.45, metalness: 0 },
  wood: { roughness: 0.82, metalness: 0 },
  stone: { roughness: 1, metalness: 0 },
  fabric: { roughness: 1, metalness: 0 },
  metal: { roughness: 0.35, metalness: 0.85 },
  gold: { roughness: 0.3, metalness: 1 },
  glass: { roughness: 0.08, metalness: 0, transparent: true, opacity: 0.35, depthWrite: false },
  glow: { roughness: 0.6, metalness: 0, emissiveIntensity: 1.6 },
  leaf: { roughness: 0.95, metalness: 0, side: THREE.DoubleSide },
};

// ---------- look (remaster steps 2 and 3, LOOK-BIBLE.md section 4) ----------
// Every lit kind carries a dot3d recipe's normal and roughness maps plus a neutral detail map under the part's own color:
// material.color stays the catalog hex ("make it red", the tests and the tint path read it) while the surface has grain,
// pits and glints that answer the key light and the environment map. `tile` is metres per texture repeat over the
// metre-scaled UVs the primitives below carry, so a 14 m villa wall gets seven plaster repeats and a mug a fraction of one.
// Step 3 (Oct 26): the kinds are the bible's material families. The ten original kinds keep their names and their
// physics (matte, plastic, wood, stone, fabric, metal, gold, glass, glow, leaf); the new look kinds (plank, bark, rock,
// ceramic, straw, leather, felt, paper, steel, iron, gloss) each name the physics material they are made of in `phys`
// (the collider density, friction and restitution table in js/dot3d/physics.js reads userData.phys through
// js/physics/colliders.js). The `metal` kind splits by the color's luminance: dark hexes (below 0.35) are iron, light
// ones brushed steel, as the bible says.
const FAMILIES = {
  matte: { recipe: "plaster", tile: 0.6, roughness: 1, normalScale: 0.6 },
  plastic: { recipe: "paint", tile: 0.5, roughness: 1.4, normalScale: 0.5 }, // moulded and painted things: a faint flake under a satin finish (the shader clamps roughness to 1)
  gloss: { recipe: "paint", tile: 0.5, roughness: 0.45, metalness: 0.3, normalScale: 0.3, phys: "plastic" }, // a screen that is off
  wood: { recipe: "wood", tile: 1.0, roughness: 1 }, // oak: handles, posts, racks, furniture
  plank: { recipe: "plank", tile: 1.2, roughness: 1, phys: "wood" }, // weathered boards: crates, barrels, fences, sheds, stalls, shields
  bark: { recipe: "bark", tile: 0.8, roughness: 1, normalScale: 1.2, phys: "wood" }, // trunks, logs, stumps
  stone: { recipe: "blocks", tile: 1.5, roughness: 1, normalScale: 1.0 }, // dressed stone with mortar: walls, castle, well, pillars
  rock: { recipe: "rock", tile: 0.75, roughness: 1, normalScale: 1.1, phys: "stone" }, // boulders, rocks, pebbles, carved stone
  ceramic: { recipe: "ceramic", tile: 0.2, roughness: 1, normalScale: 0.5, phys: "stone" }, // glazed mugs, bowls, pots
  fabric: { recipe: "cloth", tile: 0.35, roughness: 1 }, // linen and canvas: tents, awnings, flags, tunics, sacks
  straw: { recipe: "straw", tile: 0.5, roughness: 1, normalScale: 1.2, phys: "fabric" }, // the dummy body, hay, thatch, straw hats
  leather: { recipe: "leather", tile: 0.3, roughness: 1, phys: "fabric" }, // grips, straps, belts, balls
  felt: { recipe: "carpet", tile: 0.5, roughness: 1, normalScale: 0.5, phys: "fabric" }, // table tops, board rims, rugs
  paper: { recipe: "paper", tile: 0.1, roughness: 1, normalScale: 0.5, phys: "fabric" }, // cards, notes, books, boards
  steel: { recipe: "metal", tile: 0.4, roughness: 0.85, metalness: 1, phys: "metal" }, // blades, spear heads, armor, rims
  iron: { recipe: "iron", tile: 0.6, roughness: 1, metalness: 0.9, phys: "metal" }, // axe heads, hoops, hinges, lamp posts, kettlebells
  dirt: { recipe: "dirt", tile: 1.5, roughness: 1, normalScale: 1.0, phys: "matte" }, // trodden ground: the Kingdom plaza, farm soil and furrows (step 12)
  gold: { recipe: "metal", tile: 0.4, roughness: 0.9, metalness: 1 },
  leaf: { recipe: "leaf", tile: 0.6, roughness: 1, side: THREE.DoubleSide },
};
const METAL_SPLIT = 0.35;
const lumColor = new THREE.Color();
// Luminance of a color in sRGB terms (what a hex "looks like"), 0..1.
function luminance(color) {
  try { lumColor.set(color); } catch { return 0.5; }
  const c = lumColor.clone().convertLinearToSRGB();
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}
function familyOf(kind, color) {
  if (kind === "metal") return luminance(color) < METAL_SPLIT ? FAMILIES.iron : FAMILIES.steel;
  return FAMILIES[kind] || (KINDS[kind] ? null : FAMILIES.matte);
}
// The physics material a kind is made of (the look kinds alias one of the original ten; anything else names itself).
export function physOf(kind) {
  return FAMILIES[kind]?.phys ?? kind;
}
// Detail maps sit at this sRGB level on average (about 0.75 linear): seams and cracks keep their full depth below it,
// highlights are soft-clipped into the headroom above it, so no texel clips and the color still reads as the catalog hex.
const DETAIL_MEAN = 225;
const LOOK = {
  // Procedural texture size by tier (256 on Quest and the tablet, 512 on the laptop); tiny in Node, where nothing is drawn.
  size: typeof document === "undefined" ? 32 : tierBudget(detectTier()).textureSize,
  anisotropy: 4,
};
let library = null;
const details = new Map(); // recipe -> { map, normalMap, roughnessMap } (base, repeat 1)
const tiled = new Map(); // recipe@tile -> clones with repeat 1/tile

function recipeTextures(recipe) {
  let d = details.get(recipe);
  if (d) return d;
  if (!library) library = createMaterials(THREE, { size: LOOK.size, seed: 7, anisotropy: LOOK.anisotropy });
  const base = library.get(recipe);
  const src = base.map.image;
  const data = src.data, n = data.length / 4;
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += data[i * 4 + c];
  for (let c = 0; c < 3; c++) mean[c] = Math.max(1, mean[c] / n);
  const head = 255 / DETAIL_MEAN - 1; // headroom above the mean, as a ratio
  const out = new Uint8Array(data.length);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const r = data[i * 4 + c] / mean[c];
      const k = r <= 1 ? r : 1 + head * (1 - Math.exp(-(r - 1) / head));
      out[i * 4 + c] = Math.min(255, Math.round(DETAIL_MEAN * k));
    }
    out[i * 4 + 3] = 255;
  }
  const map = new THREE.DataTexture(out, src.width, src.height, THREE.RGBAFormat);
  map.colorSpace = THREE.SRGBColorSpace;
  for (const t of [map]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = LOOK.anisotropy;
    t.needsUpdate = true;
  }
  d = { map, normalMap: base.normalMap, roughnessMap: base.roughnessMap };
  details.set(recipe, d);
  return d;
}

// The recipe's three maps tiled at `tile` metres per repeat (clones share the image and its GPU upload).
function textures(recipe, tile) {
  const key = `${recipe}@${tile}`;
  let t = tiled.get(key);
  if (!t) {
    const d = recipeTextures(recipe);
    const clone = (x) => {
      const y = x.clone();
      y.repeat.set(1 / tile, 1 / tile);
      y.needsUpdate = true;
      return y;
    };
    t = { map: clone(d.map), normalMap: clone(d.normalMap), roughnessMap: clone(d.roughnessMap) };
    tiled.set(key, t);
  }
  return t;
}

// Bakes every family's textures now (about a second on the laptop at 512 px) so the first spawn in VR does not hitch.
export function warmMaterials() {
  for (const kind of Object.keys(FAMILIES)) mat("#cccccc", kind);
  mat("#333333", "metal");
  return lookInfo();
}

export function lookInfo() {
  return { textureSize: LOOK.size, recipes: [...details.keys()], families: Object.keys(FAMILIES), detailMean: DETAIL_MEAN };
}

// Cached MeshStandardMaterial by color + kind (glass is a MeshPhysicalMaterial, a subclass). Do not mutate the returned material.
// `phys` names the physics material (density, friction, restitution, what a blade bites) when it is not the kind's own:
// a sword blade looks like steel and keeps the plastic physics every passed physics step was measured with. The tint path
// (js/world/objects.js) passes the original material's kind and phys, so a recolored part keeps both.
export function mat(color = "#cccccc", kind = "matte", phys = physOf(kind)) {
  const key = `${color}|${kind}|${phys}`;
  let material = materials.get(key);
  if (!material) {
    const preset = KINDS[kind] || KINDS.matte;
    const family = familyOf(kind, color);
    if (family) {
      const { recipe, tile, normalScale, phys: _phys, ...params } = family;
      material = new THREE.MeshStandardMaterial({ color, metalness: 0, ...params, ...textures(recipe, tile) });
      if (normalScale !== undefined) material.normalScale.set(normalScale, normalScale);
      material.userData.recipe = recipe;
    } else if (kind === "glass") {
      material = new THREE.MeshPhysicalMaterial({ color, ...preset, ior: 1.5 });
    } else material = new THREE.MeshStandardMaterial({ color, ...preset });
    if (kind === "glow") material.emissive = new THREE.Color(color);
    material.userData.kind = kind;
    material.userData.phys = phys;
    material.userData.shared = true;
    materials.set(key, material);
  }
  return material;
}

// Scales a geometry's UVs so 1 uv unit = 1 m (per index group when `scales` is a list, e.g. the six box faces).
function metreUVs(geometry, scales) {
  const uv = geometry.attributes.uv;
  if (!uv) return geometry;
  if (!Array.isArray(scales[0])) {
    const [su, sv] = scales;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  } else {
    const index = geometry.index;
    const done = new Uint8Array(uv.count);
    geometry.groups.forEach((g, gi) => {
      const [su, sv] = scales[Math.min(gi, scales.length - 1)];
      for (let k = g.start; k < g.start + g.count; k++) {
        const v = index.getX(k);
        if (done[v]) continue;
        done[v] = 1;
        uv.setXY(v, uv.getX(v) * su, uv.getY(v) * sv);
      }
    });
  }
  uv.needsUpdate = true;
  return geometry;
}

// Cached geometry by key. Family materials get the metre-UV variant (so their tiling is in metres); a material that
// brings its own picture (a card face, a target, a screen) keeps the 0..1 UVs it was drawn for.
function geo(key, make, scales = null, material = null) {
  const metres = scales && !(material?.map && !material.userData?.recipe);
  const k = metres ? key + "|m" : key;
  let geometry = geometries.get(k);
  if (!geometry) {
    geometry = make();
    if (metres) metreUVs(geometry, scales);
    geometry.userData.shared = true;
    geometries.set(k, geometry);
  }
  return geometry;
}

const r3 = (n) => Math.round(n * 1000) / 1000;

// Applies {p, r (degrees XYZ), s (number|[x,y,z]), tint, name} to an Object3D.
export function place(object, o = {}) {
  if (o.p) object.position.set(o.p[0], o.p[1], o.p[2]);
  if (o.r) object.rotation.set(o.r[0] * DEG, o.r[1] * DEG, o.r[2] * DEG);
  if (o.s !== undefined) {
    if (Array.isArray(o.s)) object.scale.set(o.s[0], o.s[1], o.s[2]);
    else object.scale.setScalar(o.s);
  }
  if (o.name) object.name = o.name;
  if (o.tint) object.userData.tint = true; // recolored by "make it red" style commands
  return object;
}

// Every primitive casts and receives the field's key-light shadow (glass and glow do not cast: a window is not a slab).
function mesh(geometry, material, o) {
  const m = new THREE.Mesh(geometry, material);
  const kind = material?.userData?.kind;
  m.castShadow = kind !== "glass" && kind !== "glow";
  m.receiveShadow = true;
  return place(m, o);
}

const TAU = Math.PI * 2;

// ---------- long tail (remaster step 11, LOOK-BIBLE.md section 5) ----------
// Every box gets a 6-12 mm chamfer so its edges catch the key light and the environment instead of reading as a flat
// block; wide round things get 24 segments; lathes and extrusions get smooth normals within 35 degrees and crisp ones
// past it (a mug's rim stays a rim, its belly stops faceting). Colliders read bounding boxes: chamfers and creases leave
// them exact; raising a 10, 14 or 18-segment round to 24 adds the 90-degree vertex those lacked, so a few wide bounding
// boxes grow a little (the dummy's straw body by 6.5 mm, the barrel by 9 mm, a tree canopy by 15 cm); every physics
// test passes unchanged.
export const BEVEL = { ratio: 0.08, min: 0.006, max: 0.012, keep: 3 }; // bevel = clamp(ratio * thinnest side); none when the thinnest side is under keep * bevel
export const ROUND = { radius: 0.1, segments: 24, facets: 8 }; // at radius > 0.1 m at least 24 segments; an explicit seg of 8 or fewer is a deliberate faceted shape (hexagonal lantern, octagonal post) and stays
export const CREASE_DEG = 35;

// The chamfer a box of this size gets (0 = none). `o.bevel` sets it outright (0 opts out).
export function bevelFor([w, h, d], o = {}) {
  if (o.bevel !== undefined) return Math.max(0, +o.bevel || 0);
  const thin = Math.min(w, h, d);
  const b = Math.min(BEVEL.max, Math.max(BEVEL.min, thin * BEVEL.ratio));
  return thin < BEVEL.keep * b ? 0 : b;
}

// Radial segments for a round primitive: the bible's 24 at radius > 0.1 m, the caller's deliberate facet count below 9.
export function segmentsFor(radius, explicit, fallback = 16) {
  if (explicit && explicit <= ROUND.facets) return explicit;
  const seg = explicit || fallback;
  return radius > ROUND.radius ? Math.max(seg, ROUND.segments) : seg;
}

// Chamfered box: the six faces inset by the bevel, twelve 45-degree edge strips and eight corner triangles, flat shaded
// (96 vertices, 44 triangles). Indexed, grouped in BoxGeometry order (+x, -x, +y, -y, +z, -z; a strip or corner joins the
// group of its first face), with metre UVs (the two coordinates across the group's face) so the family textures tile
// straight over the bevel. The bounding box is exactly [w, h, d], so colliders and the catalog size test see the same box.
function chamferBox(w, h, d, b) {
  const half = [w / 2, h / 2, d / 2];
  // corner(s)[axis]: the corner cluster's vertex that lies on the face normal to `axis`.
  const corner = (sx, sy, sz, axis) => [sx * (half[0] - (axis === 0 ? 0 : b)), sy * (half[1] - (axis === 1 ? 0 : b)), sz * (half[2] - (axis === 2 ? 0 : b))];
  const polys = [[], [], [], [], [], []]; // per group: { verts, normal, axis }
  const faceGroup = (axis, sign) => axis * 2 + (sign > 0 ? 0 : 1);
  const push = (groupIndex, verts, normal) => {
    // winding: outward (flip when the first two edges' cross product points against the normal)
    const [a, b2, c] = verts;
    const e1 = [b2[0] - a[0], b2[1] - a[1], b2[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
    if (cx * normal[0] + cy * normal[1] + cz * normal[2] < 0) verts = verts.slice().reverse();
    polys[groupIndex].push({ verts, normal, axis: groupIndex >> 1 });
  };
  const signs = [-1, 1];
  const S = [];
  for (const sx of signs) for (const sy of signs) for (const sz of signs) S.push([sx, sy, sz]);
  // faces
  for (let axis = 0; axis < 3; axis++) for (const sign of signs) {
    const verts = S.filter((s) => s[axis] === sign).map((s) => corner(...s, axis));
    // order the four around the face: sort by angle in the face plane
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    verts.sort((p, q) => Math.atan2(p[v] * sign, p[u]) - Math.atan2(q[v] * sign, q[u]));
    const normal = [0, 0, 0]; normal[axis] = sign;
    push(faceGroup(axis, sign), verts, normal);
  }
  // edge strips: between face (a, sa) and face (c, sc), running along the third axis
  for (let a = 0; a < 3; a++) for (let c = a + 1; c < 3; c++) for (const sa of signs) for (const sc of signs) {
    const corners = S.filter((s) => s[a] === sa && s[c] === sc); // two corners, differing on the third axis
    const verts = [corner(...corners[0], a), corner(...corners[1], a), corner(...corners[1], c), corner(...corners[0], c)];
    const normal = [0, 0, 0]; normal[a] = sa * Math.SQRT1_2; normal[c] = sc * Math.SQRT1_2;
    push(faceGroup(a, sa), verts, normal);
  }
  // corner triangles
  for (const s of S) {
    const k = 1 / Math.sqrt(3);
    push(faceGroup(0, s[0]), [corner(...s, 0), corner(...s, 1), corner(...s, 2)], [s[0] * k, s[1] * k, s[2] * k]);
  }
  const position = [], normal = [], uv = [], index = [];
  const g = new THREE.BufferGeometry();
  const UV_AXES = [[2, 1], [0, 2], [0, 1]]; // BoxGeometry's (u, v) per face axis: ±x -> (z, y), ±y -> (x, z), ±z -> (x, y)
  let start = 0;
  polys.forEach((list, gi) => {
    for (const poly of list) {
      const base = position.length / 3;
      const [u, v] = UV_AXES[poly.axis];
      for (const p of poly.verts) { position.push(...p); normal.push(...poly.normal); uv.push(p[u], p[v]); }
      for (let i = 1; i + 1 < poly.verts.length; i++) index.push(base, base + i, base + i + 1);
    }
    const count = index.length - start;
    if (count) g.addGroup(start, count, gi);
    start = index.length;
  });
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.userData.bevel = b;
  return g;
}

// Recomputes normals so faces meeting under `creaseDeg` blend smooth and sharper edges stay creased (the bible's 35
// degrees). Returns a non-indexed geometry (the input is disposed when a new one is made).
export function creaseNormals(geometry, creaseDeg = CREASE_DEG) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const p = g.attributes.position;
  const n = p.count;
  const face = new Float32Array(n * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cb = new THREE.Vector3(), ab = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    cb.subVectors(c, b); ab.subVectors(a, b); cb.cross(ab);
    if (cb.lengthSq() < 1e-18) cb.set(0, 1, 0); else cb.normalize();
    for (let k = 0; k < 3; k++) { face[(i + k) * 3] = cb.x; face[(i + k) * 3 + 1] = cb.y; face[(i + k) * 3 + 2] = cb.z; }
  }
  const buckets = new Map();
  const key = (i) => `${Math.round(p.getX(i) * 1e5)},${Math.round(p.getY(i) * 1e5)},${Math.round(p.getZ(i) * 1e5)}`;
  for (let i = 0; i < n; i++) {
    const k = key(i);
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(i);
  }
  const cosCrease = Math.cos(creaseDeg * DEG);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const fx = face[i * 3], fy = face[i * 3 + 1], fz = face[i * 3 + 2];
    let sx = 0, sy = 0, sz = 0;
    for (const j of buckets.get(key(i))) {
      const gx = face[j * 3], gy = face[j * 3 + 1], gz = face[j * 3 + 2];
      if (fx * gx + fy * gy + fz * gz >= cosCrease) { sx += gx; sy += gy; sz += gz; }
    }
    const len = Math.hypot(sx, sy, sz) || 1;
    out[i * 3] = sx / len; out[i * 3 + 1] = sy / len; out[i * 3 + 2] = sz / len;
  }
  g.setAttribute("normal", new THREE.BufferAttribute(out, 3));
  if (g !== geometry) geometry.dispose();
  return g;
}

// Box centered at o.p with full size [w, h, d]. Chamfered per bevelFor unless the material brings its own picture (a card
// face, a screen: the picture was drawn for the flat box) or `o.bevel` is 0.
export function box([w, h, d], material, o = {}) {
  const picture = !!(material?.map && !material.userData?.recipe);
  const b = picture ? 0 : bevelFor([w, h, d], o);
  if (b > 0) return mesh(geo(`box:${r3(w)},${r3(h)},${r3(d)},b${r3(b)}`, () => chamferBox(w, h, d, b)), material, o);
  const faces = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]]; // +x -x +y -y +z -z
  return mesh(geo(`box:${r3(w)},${r3(h)},${r3(d)}`, () => new THREE.BoxGeometry(w, h, d), faces, material), material, o);
}

// Cylinder centered at o.p, axis along local Y. size = [radiusTop, radiusBottom, height].
export function cyl([rt, rb, h], material, o = {}) {
  const r = Math.max(rt, rb);
  const seg = segmentsFor(r, o.seg, 16);
  return mesh(geo(`cyl:${r3(rt)},${r3(rb)},${r3(h)},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg), [[TAU * r, h], [2 * r, 2 * r]], material), material, o);
}

export function sphere(radius, material, o = {}) {
  const seg = segmentsFor(radius, o.seg, 16);
  return mesh(geo(`sph:${r3(radius)},${seg}`, () => new THREE.SphereGeometry(radius, seg, Math.max(6, seg * 0.75 | 0)), [TAU * radius, Math.PI * radius], material), material, o);
}

// Cone centered at o.p (half below, half above), apex toward +Y. size = [radius, height].
export function cone([radius, h], material, o = {}) {
  const seg = segmentsFor(radius, o.seg, 16);
  return mesh(geo(`cone:${r3(radius)},${r3(h)},${seg}`, () => new THREE.ConeGeometry(radius, h, seg), [[TAU * radius, h], [2 * radius, 2 * radius]], material), material, o);
}

// Torus in the local XY plane. size = [radius, tube].
export function torus([radius, tube], material, o = {}) {
  const seg = segmentsFor(radius, o.seg, 24);
  return mesh(geo(`tor:${r3(radius)},${r3(tube)},${seg}`, () => new THREE.TorusGeometry(radius, tube, 8, seg), [TAU * radius, TAU * tube], material), material, o);
}

// Capsule centered at o.p, axis along Y. size = [radius, straightLength].
export function capsule([radius, length], material, o = {}) {
  return mesh(geo(`cap:${r3(radius)},${r3(length)}`, () => new THREE.CapsuleGeometry(radius, length, 4, 12), [TAU * radius, length + Math.PI * radius], material), material, o);
}

// Plane facing +Z, centered at o.p. size = [w, h].
export function plane([w, h], material, o = {}) {
  return mesh(geo(`pla:${r3(w)},${r3(h)}`, () => new THREE.PlaneGeometry(w, h), [w, h], material), material, o);
}

// Lathe around Y from [[radius, y], ...] profile points. Normals creased at CREASE_DEG: a rim or a foot edge stays sharp,
// a belly or a neck blends smooth.
export function lathe(points, material, o = {}) {
  const maxR = Math.max(...points.map((p) => Math.abs(p[0])));
  const seg = segmentsFor(maxR, o.seg, 20);
  const key = `lat:${points.map((p) => p.map(r3).join(",")).join(";")}:${seg}`;
  const around = TAU * maxR;
  let along = 0;
  for (let i = 1; i < points.length; i++) along += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return mesh(geo(key, () => creaseNormals(new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), seg)), [around, along || 1], material), material, o);
}

// Extrudes a 2D outline [[x, y], ...] (drawn in the XY plane) by depth along +Z, then centers depth on z = 0.
// Normals creased at CREASE_DEG, so a rounded outline (a shield, a blade's belly) shades smooth and its edges stay crisp.
export function extrude(outline, depth, material, o = {}) {
  const key = `ext:${outline.map((p) => p.map(r3).join(",")).join(";")}:${r3(depth)}:${o.bevel ? 1 : 0}`;
  const geometry = geo(key, () => {
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: !!o.bevel, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 1 });
    g.translate(0, 0, -depth / 2);
    return creaseNormals(g);
  });
  return mesh(geometry, material, o);
}

// Triangular prism roof: width along X, height along Y, depth along Z; base centered at o.p.
export function prism([w, h, d], material, o = {}) {
  const key = `pri:${r3(w)},${r3(h)},${r3(d)}`;
  const geometry = geo(key, () => {
    const shape = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(0, h)]);
    const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
    g.translate(0, 0, -d / 2);
    return creaseNormals(g);
  });
  return mesh(geometry, material, o);
}

export function group(children = [], o = {}) {
  const g = new THREE.Group();
  for (const child of children) if (child) g.add(child);
  return place(g, o);
}

// Flat text panel facing +Z. text options as in util/text.js drawText (width/height in px).
// Returns a Mesh whose userData.setText(newText) redraws it. In Node it is a plain colored panel.
export function textPanel([w, h], options = {}, o = {}) {
  const pxW = options.width || Math.round(Math.min(2048, Math.max(128, w * 512)));
  const pxH = options.height || Math.round(Math.min(2048, Math.max(64, h * 512)));
  const textOptions = { width: pxW, height: pxH, ...options };
  const texture = canvasTexture(drawText(textOptions));
  // Without a canvas (Node) the panel is plain paper in its background color, so no part ever builds a flat lit material.
  const material = texture
    ? new THREE.MeshStandardMaterial({ color: "#ffffff", map: texture, roughness: 0.9, transparent: !options.bg })
    : mat(options.bg || "#ffffff", "paper");
  const panel = place(new THREE.Mesh(new THREE.PlaneGeometry(w, h), material), o);
  panel.castShadow = true;
  panel.receiveShadow = true;
  panel.userData.text = textOptions.text || "";
  panel.userData.setText = (text) => {
    panel.userData.text = text;
    textOptions.text = text;
    if (texture) updateTextTexture(texture, textOptions);
  };
  return panel;
}

// Final step for every builder: names the root, records its kind for debugging, and gives the meshes a builder made
// itself (canvas faces, nets, screens) the same shadow flags as the kit primitives: everything casts and receives,
// except glass, glow and wireframes.
export function finish(root, name) {
  root.name = name;
  root.userData.part = name;
  root.traverse((o) => {
    if (!o.isMesh || o.userData.phaseHelper) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    const kind = m?.userData?.kind;
    o.castShadow = kind !== "glass" && kind !== "glow" && !m?.wireframe && m?.visible !== false;
    o.receiveShadow = true;
  });
  return root;
}

// Merges static meshes that share a material (and tint flag) into one mesh each, so a villa
// built from 140 boxes costs a dozen draw calls instead of 140. Only for parts without hooks
// that keep references to individual meshes. Mirrored meshes and multi-material meshes stay as they are.
const mergeInverse = new THREE.Matrix4();
const mergeMatrix = new THREE.Matrix4();

export function mergeStatic(root) {
  root.updateMatrixWorld(true);
  mergeInverse.copy(root.matrixWorld).invert();
  const groups = new Map();
  root.traverse((object) => {
    if (!object.isMesh || object.isInstancedMesh || object.isSkinnedMesh || Array.isArray(object.material)) return;
    if (object.userData.keep || object.morphTargetInfluences || !object.geometry?.attributes?.position) return;
    if (object.matrixWorld.determinant() <= 0) return;
    const key = `${object.material.uuid}|${object.userData.tint ? 1 : 0}|${object.renderOrder}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(object);
  });
  let merged = 0;
  for (const meshes of groups.values()) {
    if (meshes.length < 2) continue;
    const parts = [];
    let vertices = 0;
    for (const mesh of meshes) {
      const source = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      source.applyMatrix4(mergeMatrix.multiplyMatrices(mergeInverse, mesh.matrixWorld));
      parts.push(source);
      vertices += source.attributes.position.count;
    }
    const position = new Float32Array(vertices * 3);
    const normal = new Float32Array(vertices * 3);
    const uv = new Float32Array(vertices * 2);
    let offset = 0;
    for (const part of parts) {
      const count = part.attributes.position.count;
      position.set(part.attributes.position.array.subarray(0, count * 3), offset * 3);
      if (part.attributes.normal) normal.set(part.attributes.normal.array.subarray(0, count * 3), offset * 3);
      if (part.attributes.uv) uv.set(part.attributes.uv.array.subarray(0, count * 2), offset * 2);
      offset += count;
      part.dispose();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    const first = meshes[0];
    const combined = new THREE.Mesh(geometry, first.material);
    combined.name = `${root.name || "part"}:merged`;
    combined.renderOrder = first.renderOrder;
    combined.castShadow = first.castShadow;
    combined.receiveShadow = first.receiveShadow;
    if (first.userData.tint) combined.userData.tint = true;
    for (const mesh of meshes) mesh.removeFromParent();
    root.add(combined);
    merged += meshes.length - 1;
  }
  return merged;
}

// Measures an object's bounding box size [w, h, d] (used by tests and blueprint sizing).
export function measure(object) {
  object.updateMatrixWorld(true);
  const box3 = new THREE.Box3().setFromObject(object);
  const size = box3.getSize(new THREE.Vector3());
  return { size: [size.x, size.y, size.z], min: box3.min.toArray(), max: box3.max.toArray() };
}

export function disposeObject(object) {
  object.traverse((child) => {
    if (child.geometry && !child.geometry.userData.shared) child.geometry.dispose();
    const list = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
    for (const m of list) {
      if (m.userData?.shared) continue;
      m.map?.dispose();
      m.dispose();
    }
  });
}

export const kit = { THREE, mat, physOf, box, cyl, sphere, cone, torus, capsule, plane, lathe, extrude, prism, group, textPanel, place, finish, measure, mergeStatic, disposeObject, warmMaterials, lookInfo, DEG, BEVEL, ROUND, CREASE_DEG, bevelFor, segmentsFor, creaseNormals };
export default kit;
