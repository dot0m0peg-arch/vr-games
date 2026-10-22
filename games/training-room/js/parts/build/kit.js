// Builder toolkit for the parts bin: cached materials/geometries and positioned primitives.
// Conventions (see SPEC): meters, +Y up, every part's origin is the bottom-center of its
// bounding box (so y = 0 sits on the grass), and its front faces +Z.
import * as THREE from "../../../vendor/three.module.min.js";
import { drawText, canvasTexture, updateTextTexture } from "../../util/text.js";

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

// Cached MeshStandardMaterial by color + kind. Do not mutate the returned material.
export function mat(color = "#cccccc", kind = "matte") {
  const key = `${color}|${kind}`;
  let material = materials.get(key);
  if (!material) {
    const preset = KINDS[kind] || KINDS.matte;
    material = new THREE.MeshStandardMaterial({ color, ...preset });
    if (kind === "glow") material.emissive = new THREE.Color(color);
    material.userData.kind = kind;
    material.userData.shared = true;
    materials.set(key, material);
  }
  return material;
}

function geo(key, make) {
  let geometry = geometries.get(key);
  if (!geometry) {
    geometry = make();
    geometry.userData.shared = true;
    geometries.set(key, geometry);
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

function mesh(geometry, material, o) {
  return place(new THREE.Mesh(geometry, material), o);
}

// Box centered at o.p with full size [w, h, d].
export function box([w, h, d], material, o = {}) {
  return mesh(geo(`box:${r3(w)},${r3(h)},${r3(d)}`, () => new THREE.BoxGeometry(w, h, d)), material, o);
}

// Cylinder centered at o.p, axis along local Y. size = [radiusTop, radiusBottom, height].
export function cyl([rt, rb, h], material, o = {}) {
  const seg = o.seg || 16;
  return mesh(geo(`cyl:${r3(rt)},${r3(rb)},${r3(h)},${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg)), material, o);
}

export function sphere(radius, material, o = {}) {
  const seg = o.seg || 16;
  return mesh(geo(`sph:${r3(radius)},${seg}`, () => new THREE.SphereGeometry(radius, seg, Math.max(6, seg * 0.75 | 0))), material, o);
}

// Cone centered at o.p (half below, half above), apex toward +Y. size = [radius, height].
export function cone([radius, h], material, o = {}) {
  const seg = o.seg || 16;
  return mesh(geo(`cone:${r3(radius)},${r3(h)},${seg}`, () => new THREE.ConeGeometry(radius, h, seg)), material, o);
}

// Torus in the local XY plane. size = [radius, tube].
export function torus([radius, tube], material, o = {}) {
  const seg = o.seg || 24;
  return mesh(geo(`tor:${r3(radius)},${r3(tube)},${seg}`, () => new THREE.TorusGeometry(radius, tube, 8, seg)), material, o);
}

// Capsule centered at o.p, axis along Y. size = [radius, straightLength].
export function capsule([radius, length], material, o = {}) {
  return mesh(geo(`cap:${r3(radius)},${r3(length)}`, () => new THREE.CapsuleGeometry(radius, length, 4, 12)), material, o);
}

// Plane facing +Z, centered at o.p. size = [w, h].
export function plane([w, h], material, o = {}) {
  return mesh(geo(`pla:${r3(w)},${r3(h)}`, () => new THREE.PlaneGeometry(w, h)), material, o);
}

// Lathe around Y from [[radius, y], ...] profile points.
export function lathe(points, material, o = {}) {
  const key = `lat:${points.map((p) => p.map(r3).join(",")).join(";")}:${o.seg || 20}`;
  return mesh(geo(key, () => new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), o.seg || 20)), material, o);
}

// Extrudes a 2D outline [[x, y], ...] (drawn in the XY plane) by depth along +Z, then centers depth on z = 0.
export function extrude(outline, depth, material, o = {}) {
  const key = `ext:${outline.map((p) => p.map(r3).join(",")).join(";")}:${r3(depth)}:${o.bevel ? 1 : 0}`;
  const geometry = geo(key, () => {
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: !!o.bevel, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 1 });
    g.translate(0, 0, -depth / 2);
    return g;
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
    return g;
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
  const material = new THREE.MeshStandardMaterial({
    color: texture ? "#ffffff" : options.bg || "#ffffff",
    map: texture,
    roughness: 0.9,
    transparent: !options.bg,
  });
  const panel = place(new THREE.Mesh(new THREE.PlaneGeometry(w, h), material), o);
  panel.userData.text = textOptions.text || "";
  panel.userData.setText = (text) => {
    panel.userData.text = text;
    textOptions.text = text;
    if (texture) updateTextTexture(texture, textOptions);
  };
  return panel;
}

// Final step for every builder: names the root and records its kind for debugging.
export function finish(root, name) {
  root.name = name;
  root.userData.part = name;
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

export const kit = { THREE, mat, box, cyl, sphere, cone, torus, capsule, plane, lathe, extrude, prism, group, textPanel, place, finish, measure, mergeStatic, disposeObject, DEG };
export default kit;
