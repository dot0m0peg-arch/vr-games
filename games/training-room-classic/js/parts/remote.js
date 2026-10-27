// Registers the laptop parts bin (GET api/parts) with the catalog and builders:
// "blueprint" (primitive JSON), "gltf" (.glb/.gltf models) and "module" (JS with build(THREE, opts)).
// Failures are collected per part and never thrown.
import * as THREE from "../../vendor/three.module.min.js";

const CONCURRENCY = 4;
const META_SKIP = new Set(["kind", "url", "blueprint", "file", "stamp", "build"]);
const MODULE_META = ["name", "aliases", "category", "desc", "size", "color", "holdable", "grip", "tip", "surface", "surfaceSize", "hittable", "writable", "deck", "screen"];

const validSize = (size) => Array.isArray(size) && size.length === 3 && size.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
const round3 = (n) => Math.round(n * 1000) / 1000;

function metaFrom(entry, extra = {}) {
  const meta = {};
  for (const [key, value] of Object.entries(entry || {})) if (!META_SKIP.has(key) && value !== undefined && value !== null) meta[key] = value;
  Object.assign(meta, extra);
  meta.name = String(meta.name || "").trim().toLowerCase();
  meta.category = meta.category || "custom";
  meta.source = "laptop";
  return meta;
}

// Parts-bin files are shared (never disposed when one spawned copy is removed).
function markShared(object) {
  object.traverse((child) => {
    if (child.geometry) child.geometry.userData.shared = true;
    const list = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
    for (const m of list) m.userData.shared = true;
  });
}

let gltfModules = null;
function gltfTools() {
  // Vendored addons import bare "three" (resolved by index.html's import map), so load on demand.
  gltfModules = gltfModules || Promise.all([
    import("../../vendor/addons/loaders/GLTFLoader.js"),
    import("../../vendor/addons/utils/SkeletonUtils.js"),
  ]).then(([loader, skeleton]) => ({ GLTFLoader: loader.GLTFLoader, clone: skeleton.clone }));
  gltfModules.catch(() => {
    gltfModules = null;
  });
  return gltfModules;
}

async function loadBlueprint(entry, { registerMeta, registerBuilder, buildBlueprint }) {
  const bp = entry.blueprint;
  if (!bp || !Array.isArray(bp.parts) || !bp.parts.length) throw new Error("blueprint has no parts");
  const size = validSize(entry.size) ? entry.size : validSize(bp.size) ? bp.size : null;
  const meta = metaFrom(entry, size ? { size } : {});
  registerMeta(meta);
  registerBuilder(meta.name, (opts) => buildBlueprint(bp, opts));
  return meta;
}

async function loadGltf(entry, base, { registerMeta, registerBuilder }) {
  if (!entry.url) throw new Error("model has no url");
  const { GLTFLoader, clone } = await gltfTools();
  const gltf = await new GLTFLoader().loadAsync(new URL(entry.url, base).href);
  const scene = gltf.scene || gltf.scenes?.[0];
  if (!scene) throw new Error("model has no scene");
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  if (box.isEmpty()) throw new Error("model has no visible geometry");
  const raw = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // Uniform scale so the model fits the declared size (keeps the owner's proportions).
  let scale = 1;
  if (validSize(entry.size)) {
    const ratios = [entry.size[0] / raw.x, entry.size[1] / raw.y, entry.size[2] / raw.z].filter((r) => Number.isFinite(r) && r > 0);
    if (ratios.length) scale = Math.min(...ratios);
  }
  const fit = new THREE.Group();
  fit.name = "fit";
  fit.add(scene);
  fit.scale.setScalar(scale);
  fit.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale); // bottom-center origin
  const template = new THREE.Group();
  template.name = entry.name;
  template.add(fit);
  template.updateMatrixWorld(true);
  markShared(template);
  const size = [round3(raw.x * scale), round3(raw.y * scale), round3(raw.z * scale)].map((n) => Math.max(0.01, n));
  const meta = metaFrom(entry, { size });
  registerMeta(meta);
  registerBuilder(meta.name, () => {
    const copy = clone(template);
    copy.userData.part = meta.name;
    return copy;
  });
  return meta;
}

async function loadModule(entry, base, { registerMeta, registerBuilder }) {
  if (!entry.url) throw new Error("module has no url");
  const mod = await import(/* @vite-ignore */ new URL(entry.url, base).href);
  const def = mod?.default;
  if (!def || typeof def.build !== "function") throw new Error("module needs `export default { name, size, build(THREE, opts) }`");
  const fromModule = {};
  for (const key of MODULE_META) if (def[key] !== undefined) fromModule[key] = def[key];
  // The manifest name wins (the bridge's model knows the part by it); the module's own fields
  // override the bridge's generic defaults.
  const name = entry.name || def.name;
  const meta = metaFrom({ ...entry, ...fromModule }, { name });
  if (Array.isArray(entry.aliases) && Array.isArray(def.aliases)) meta.aliases = [...new Set([...entry.aliases, ...def.aliases])];
  if (!validSize(meta.size)) {
    const probe = def.build(THREE, { color: meta.color, data: {}, text: "", seed: 1 });
    probe.updateMatrixWorld(true);
    const s = new THREE.Box3().setFromObject(probe).getSize(new THREE.Vector3());
    meta.size = [s.x, s.y, s.z].map((n) => Math.max(0.01, round3(n || 0)));
  }
  registerMeta(meta);
  registerBuilder(meta.name, (opts) => def.build(THREE, opts));
  return meta;
}

// → { count, errors: [{ name, kind, error }] }
export async function loadRemoteParts(net, { registerMeta, registerBuilder, buildBlueprint } = {}) {
  const errors = [];
  let count = 0;
  let manifest;
  try {
    manifest = await net.parts();
  } catch (err) {
    return { count, errors: [{ name: "*", kind: "manifest", error: err?.message || String(err) }] };
  }
  const entries = Array.isArray(manifest?.parts) ? manifest.parts : [];
  const base = net.base || globalThis.location?.href;
  const hooks = { registerMeta, registerBuilder, buildBlueprint };
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      try {
        if (!entry || typeof entry !== "object" || !entry.name) throw new Error("entry without a name");
        if (entry.kind === "blueprint") await loadBlueprint(entry, hooks);
        else if (entry.kind === "gltf") await loadGltf(entry, base, hooks);
        else if (entry.kind === "module") await loadModule(entry, base, hooks);
        else throw new Error(`unknown kind "${entry.kind}"`);
        count++;
      } catch (err) {
        errors.push({ name: entry?.name || "?", kind: entry?.kind || "?", error: err?.message || String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  return { count, errors };
}
