// Real models for catalog parts (LOOK-BIBLE.md section 5, build order step 7). The builder in ./index.js still makes the
// family sculpt first, synchronously: it stays the collider source (physics never changes with a model swap) and the
// fallback look. This module then loads the part's GLB named in assets/models/MANIFEST.json, fits it to the catalog
// size with the shared rules in ./model-fit.js (largest axis to size, the other two within the tolerance, base at
// y = 0, handle on the catalog grip point), and swaps it in under the sculpt's wrapper. One GLB is fetched and parsed
// once; every object made from it shares the geometry and materials (marked shared so disposing one object keeps the
// others). A model that is missing, unreadable or does not fit leaves the sculpt in place with one console warning per
// file, never an error. Nothing here runs in Node unless a test configures it. Claude (Command), Oct 26 2026.
import { THREE, kit } from "./kit.js";
import { rotatedBounds, fitToCatalog, fittedBounds } from "./model-fit.js";

export const MANIFEST_URL = new URL("../../../assets/models/MANIFEST.json", import.meta.url).href;

const state = {
  enabled: typeof document !== "undefined" && typeof fetch === "function",
  manifest: null, manifestPromise: null, manifestUrl: MANIFEST_URL, manifestError: null,
  loader: null,                       // (url) => Promise<THREE.Object3D>; the GLTFLoader scene in the browser
  cache: new Map(),                   // file -> Promise<{ root, bounds, triangles }>
  warned: new Set(),
  stats: { requests: 0, noModel: 0, loads: 0, swapped: 0, skipped: [], fallbacks: [], warnings: 0 },
};

// Tests and probes: turn the loader on or off, hand it a manifest object or URL, or a loader function.
export function configureModels({ enabled, manifest, manifestUrl, loader } = {}) {
  if (enabled !== undefined) state.enabled = !!enabled;
  if (manifest !== undefined) { state.manifest = normalizeManifest(manifest); state.manifestPromise = Promise.resolve(state.manifest); state.manifestError = null; }
  if (manifestUrl !== undefined) { state.manifestUrl = manifestUrl; state.manifest = null; state.manifestPromise = null; state.manifestError = null; }
  if (loader !== undefined) state.loader = loader;
  state.cache.clear();
  state.warned.clear();
  return state;
}

export function resetModelStats() {
  state.stats = { requests: 0, noModel: 0, loads: 0, swapped: 0, skipped: [], fallbacks: [], warnings: 0 };
}

export function modelStats() {
  return { ...state.stats, enabled: state.enabled, manifestLoaded: !!state.manifest, manifestError: state.manifestError, cached: [...state.cache.keys()] };
}

function normalizeManifest(raw) {
  const models = new Map();
  for (const e of raw?.models || []) if (e?.part && e.status === "active" && e.file) models.set(String(e.part).toLowerCase(), e);
  return { raw, models, base: raw?.base ?? null };
}

// The manifest, fetched once. A manifest that fails to load disables models for the session with one warning.
export function modelsReady() {
  if (!state.enabled) return Promise.resolve(null);
  if (!state.manifestPromise) {
    state.manifestPromise = fetch(state.manifestUrl, { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((raw) => (state.manifest = normalizeManifest(raw)))
      .catch((err) => { state.manifestError = String(err?.message || err); warnOnce("manifest", `[models] no model manifest (${state.manifestError}); sculpts only`); state.manifest = normalizeManifest(null); return state.manifest; });
  }
  return state.manifestPromise;
}

// The active manifest entry for a catalog part, once the manifest is loaded (null before that, and for sculpt-only parts).
export function modelFor(part) {
  return state.manifest?.models.get(String(part || "").toLowerCase()) ?? null;
}

function warnOnce(key, text) {
  if (state.warned.has(key)) return;
  state.warned.add(key);
  state.stats.warnings++;
  console.warn(text);
}

function fileUrl(entry) {
  const base = state.manifest?.base ? new URL(state.manifest.base, state.manifestUrl).href : new URL("./", state.manifestUrl).href;
  return new URL(entry.file, base).href;
}

async function defaultLoader(url) {
  const { GLTFLoader } = await import("../../../vendor/addons/loaders/GLTFLoader.js");
  const gltf = await new GLTFLoader().loadAsync(url);
  return gltf.scene;
}

// Loads and measures one GLB once. The root is kept as the shared source; each object gets a clone that shares
// geometry and materials. Bounds come from the geometry boxes through the node transforms (what the Node tool measures).
function load(entry) {
  const key = entry.file;
  if (!state.cache.has(key)) {
    const url = fileUrl(entry);
    state.stats.loads++;
    const p = (state.loader || defaultLoader)(url).then((root) => {
      if (!root || !root.isObject3D) throw new Error("loader returned no scene");
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      if (box.isEmpty()) throw new Error("empty scene");
      let triangles = 0;
      root.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const g = o.geometry;
        triangles += g.index ? g.index.count / 3 : (g.attributes.position?.count ?? 0) / 3;
        g.userData.shared = true;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) { m.userData.shared = true; m.userData.model = true; m.userData.kind ??= "model"; }
      });
      return { root, bounds: { min: box.min.toArray(), max: box.max.toArray() }, triangles: Math.round(triangles) };
    });
    p.catch(() => {});
    state.cache.set(key, p);
  }
  return state.cache.get(key);
}

// Swaps the part's sculpt for its model when one is listed and fits. Returns a promise of
// { swapped, part, file?, reason?, fit?, triangles? }; never rejects. `inner` is the sculpt root under `wrapper`.
// hooks: parts whose builder keeps mesh references (text, cards, screens) keep their sculpt; a model for those needs
// its own design (manifest `skipped` reason, no warning).
// rig: a part split for a physics rig (the training dummy on its post) takes a model only when its manifest entry
// says where to cut it (`rig.split`, catalog metres up from the ground, step 8): the model's triangles above that
// plane go into the live `rig:swing` group the physics side poses, the rest stay planted. The rig's pivot, bodies and
// colliders are the sculpt's and do not move. Without `rig.split` the sculpt stays (skipped, no warning).
export async function attachModel(wrapper, { meta, record, inner, hooks = {}, rig = null } = {}) {
  if (!state.enabled) return { swapped: false, reason: "models off" };
  state.stats.requests++;
  await modelsReady();
  const part = String(record?.part || meta?.name || "").toLowerCase();
  const entry = modelFor(part);
  if (!entry) { state.stats.noModel++; return { swapped: false, part, reason: "no model listed" }; }
  const blockers = [];
  if (Object.keys(hooks).length) blockers.push(`part keeps mesh references (${Object.keys(hooks).join(", ")})`);
  const swing = rig ? inner?.children.find((c) => c.name === "rig:swing") ?? null : null;
  const splitY = Number.isFinite(entry.rig?.split) ? +entry.rig.split : null;
  if (rig && swing && splitY === null) blockers.push("part is split for a physics rig (no rig.split in the manifest)");
  if (blockers.length) { state.stats.skipped.push({ part, file: entry.file, reason: blockers.join("; ") }); return { swapped: false, part, file: entry.file, reason: blockers.join("; ") }; }
  let loaded;
  try { loaded = await load(entry); }
  catch (err) { return fallback(part, entry, `${err?.message || err}`); }
  const rotate = entry.rotate || [0, 0, 0];
  const rotated = rotatedBounds(loaded.bounds.min, loaded.bounds.max, rotate);
  const fit = fitToCatalog(rotated, meta.size, { grip: meta.holdable ? meta.grip?.p : null, handle: entry.handle || null, offset: entry.offset || [0, 0, 0], tolerance: entry.tolerance || null });
  if (!fit.ok) return fallback(part, entry, "does not fit: " + fit.reasons.join("; "));
  if (!inner || inner.parent !== wrapper || wrapper.userData.destroyed) return { swapped: false, part, file: entry.file, reason: "object gone before its model loaded" };

  const root = new THREE.Group();
  root.name = `${inner.name || part}:model`;
  root.userData.model = { part, file: entry.file, fit: { scale: fit.scale, size: fit.size, translate: fit.translate }, triangles: loaded.triangles, bounds: fittedBounds(rotated, fit) };
  const instance = loaded.root.clone();
  const DEG = Math.PI / 180;
  root.rotation.set(rotate[0] * DEG, rotate[1] * DEG, rotate[2] * DEG, "XYZ");
  root.scale.setScalar(fit.scale);
  root.position.fromArray(fit.translate);
  root.add(instance);
  const override = entry.material ? kit.mat(record?.color || meta.color || "#cccccc", entry.material) : null;
  let largest = null, largestCount = -1;
  instance.traverse((o) => {
    if (!o.isMesh) return;
    o.userData.model = true;
    o.castShadow = true;
    o.receiveShadow = true;
    if (override) { o.material = override; o.userData.tint = true; }
    else {
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m?.transparent) o.castShadow = false;
      const n = o.geometry?.index ? o.geometry.index.count : o.geometry?.attributes?.position?.count ?? 0;
      if (n > largestCount) { largestCount = n; largest = o; }
    }
  });
  if (largest) largest.userData.tint = true;   // "make it red" recolors the body of a textured model (objects.js tints it)

  // The sculpt steps aside (kept for the fallback and for anyone who wants the proxy back); the model takes its place.
  // A rigged part keeps its live swing group under inner: the sculpt's swing meshes go into a stash the restore puts back.
  const sculpt = new THREE.Group();
  sculpt.name = `${inner.name || part}:sculpt`;
  for (const child of [...inner.children]) if (child !== swing) sculpt.add(child);
  if (swing) {
    const stash = new THREE.Group();
    stash.name = "rig:swing";
    for (const child of [...swing.children]) stash.add(child);
    sculpt.add(stash);
  }
  inner.add(root);
  if (swing) root.userData.model.split = splitModel(root, inner, swing, splitY, rig.pivot);
  wrapper.userData.sculpt = sculpt;
  wrapper.userData.model = root.userData.model;
  state.stats.swapped++;
  return { swapped: true, part, file: entry.file, fit: root.userData.model.fit, triangles: loaded.triangles, split: root.userData.model.split };
}

// Cuts every mesh of the fitted model at the plane y = splitY (inner frame, catalog metres) by triangle centroid:
// the triangles above become a sibling mesh placed in the live swing group against that group's REST frame (origin at
// the rig pivot, no rotation), not its live pose, so a model landing on a dummy that is already rocking, or whose top
// has broken off, still sits where the sculpt's top sat at rest; the physics side's posing of the group then moves the
// model's top exactly as it moved the sculpt's. Each half gets its own geometry (a copy of the file's attributes with
// its own index), owned and disposed with the object like any sculpt mesh. Returns { y, upper, lower } triangle counts.
function splitModel(root, inner, swing, splitY, pivot) {
  inner.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(inner.matrixWorld).invert();
  const restInv = new THREE.Matrix4().makeTranslation(-(pivot?.[0] || 0), -(pivot?.[1] || 0), -(pivot?.[2] || 0)).multiply(inv);
  const toInner = new THREE.Matrix4();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let upper = 0, lower = 0;
  const meshes = [];
  root.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o); });
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const index = g.index ? g.index.array : null;
    const n = index ? index.length : pos.count;
    toInner.multiplyMatrices(inv, mesh.matrixWorld);
    const up = [], down = [];
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = index ? index[i] : i, i1 = index ? index[i + 1] : i + 1, i2 = index ? index[i + 2] : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(toInner);
      b.fromBufferAttribute(pos, i1).applyMatrix4(toInner);
      c.fromBufferAttribute(pos, i2).applyMatrix4(toInner);
      ((a.y + b.y + c.y) / 3 >= splitY ? up : down).push(i0, i1, i2);
    }
    if (!up.length) { lower += down.length / 3; continue; }
    const Index = pos.count > 65535 ? Uint32Array : Uint16Array;
    const part = (list) => {
      const geometry = g.clone();                // own copy of the attributes: disposed with this object, the cache untouched
      geometry.userData = {};
      geometry.setIndex(new THREE.BufferAttribute(new Index(list), 1));
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      return geometry;
    };
    const top = new THREE.Mesh(part(up), mesh.material);
    top.name = (mesh.name || "mesh") + ":swing";
    top.userData = { ...mesh.userData, model: true, swingPart: true };
    top.castShadow = mesh.castShadow; top.receiveShadow = mesh.receiveShadow;
    // local pose under the swing group at rest = restInv * (the mesh's world matrix as built under root)
    new THREE.Matrix4().multiplyMatrices(restInv, mesh.matrixWorld).decompose(top.position, top.quaternion, top.scale);
    swing.add(top);
    upper += up.length / 3;
    if (down.length) { mesh.geometry = part(down); lower += down.length / 3; }
    else mesh.removeFromParent();
  }
  return { y: splitY, upper, lower };
}

function fallback(part, entry, reason) {
  state.stats.fallbacks.push({ part, file: entry.file, reason });
  warnOnce(entry.file, `[models] ${entry.file} for "${part}": ${reason}; the sculpt stays`);
  return { swapped: false, part, file: entry.file, reason };
}

// Puts the sculpt back (a test helper and the escape hatch for a bad swap). Returns true when there was a model.
export function restoreSculpt(wrapper) {
  const inner = wrapper?.userData?.inner, sculpt = wrapper?.userData?.sculpt;
  if (!inner || !sculpt) return false;
  for (const child of [...inner.children]) if (child.name.endsWith(":model")) child.removeFromParent();
  const swing = inner.children.find((c) => c.name === "rig:swing") ?? null;
  if (swing) for (const child of [...swing.children]) if (child.userData.model) child.removeFromParent();
  for (const child of [...sculpt.children]) {
    if (child.name === "rig:swing" && swing) { for (const mesh of [...child.children]) swing.add(mesh); }
    else inner.add(child);
  }
  delete wrapper.userData.sculpt;
  delete wrapper.userData.model;
  return true;
}
