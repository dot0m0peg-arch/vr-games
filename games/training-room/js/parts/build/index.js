// Builds the 3D object for a room record from the parts bin (built-in, laptop, or AI blueprint).
import { colliderShapes } from "../../physics/colliders.js";
import { rigFor, buildRig, keepMeshes } from "../../physics/rig.js";
let physicsColliders=false;
export function setPhysicsColliders(enabled){physicsColliders=!!enabled;}
import { kit, THREE } from "./kit.js";
import { builders as structures } from "./structures.js";
import { builders as nature } from "./nature.js";
import { builders as office } from "./office.js";
import { builders as leisure } from "./leisure.js";
import { builders as combat } from "./combat.js";
import { builders as kingdom } from "./kingdom.js";
import { builders as sketch } from "./sketch.js";
import { builders as props } from "./props.js";
import { buildBlueprint } from "./blueprint.js";
import { attachModel } from "./models.js";
import { getMeta } from "../meta/index.js";
import { sketchBounds } from "../../core/sketch.js";

const registry = new Map(Object.entries({ ...structures, ...nature, ...office, ...leisure, ...combat, ...kingdom, ...sketch, ...props }));

export function registerBuilder(name, fn) {
  registry.set(String(name).toLowerCase(), fn);
}

export function hasBuilder(name) {
  return registry.has(String(name).toLowerCase());
}

// Meta for a record, including AI blueprints and marker drawings that are not in the catalog.
export function metaOfRecord(record) {
  if (record.part === "drawing" || record.part === "doodle") {
    // Origin is the drawing frame (record p), not bottom-center. Drawings never move; doodles up to 3 m can.
    const size = sketchBounds(record.data?.strokes).size.map((n) => Math.max(0.05, n));
    return {
      name: record.part, aliases: [], category: "custom", desc: "marker drawing", size,
      fixed: record.part === "drawing" || Math.max(...size) > 3, origin: "frame",
    };
  }
  const meta = getMeta(record.part);
  if (meta) return meta;
  const bp = record.data?.blueprint;
  if (bp) {
    return {
      name: record.part, aliases: [], category: "custom", desc: bp.desc || "", size: bp.size || [1, 1, 1],
      holdable: !!bp.holdable && Math.max(...(bp.size || [1, 1, 1])) <= 2, grip: bp.grip, rig: bp.rig, edge: bp.edge, edges: bp.edges,
    };
  }
  return { name: record.part, aliases: [], category: "custom", size: [0.8, 0.8, 0.8], placeholder: true };
}

export function sizeOfRecord(record) {
  const size = metaOfRecord(record).size || [1, 1, 1];
  const s = record.s || 1;
  return [size[0] * s, size[1] * s, size[2] * s];
}

// Unknown parts become a labelled "mystery crate" so the player still sees something truthful.
function placeholder(record) {
  const crate = kit.group([
    kit.box([0.8, 0.8, 0.8], kit.mat("#3b4a3c", "plastic"), { p: [0, 0.4, 0], tint: true }),
    kit.box([0.82, 0.06, 0.82], kit.mat("#d5fb6a", "glow"), { p: [0, 0.8, 0] }),
    kit.textPanel([0.7, 0.35], { text: record.label || record.part, size: 44, align: "center", valign: "middle", bg: "#101412", color: "#d5fb6a" }, { p: [0, 0.45, 0.41] }),
  ]);
  return kit.finish(crate, record.part);
}

// Returns a wrapper Group positioned from the record. wrapper.userData:
// { id, record, meta, inner, hooks: { update?, setText?, setDeck?, setScreen? } }
export function buildObject(record) {
  const meta = metaOfRecord(record);
  const opts = { color: record.color || meta.color, data: record.data || {}, text: record.text || "", seed: hashSeed(record.id), buildPart };
  let inner;
  try {
    const builder = registry.get(record.part);
    if (builder) inner = builder(opts);
    else if (record.data?.blueprint) inner = buildBlueprint(record.data.blueprint, opts);
  } catch (err) {
    console.error(`[parts] failed to build ${record.part}`, err);
  }
  if (!inner) inner = placeholder(record);
  const wrapper = new THREE.Group();
  wrapper.name = `obj:${record.id}`;
  wrapper.add(inner);
  const hooks = {};
  for (const key of ["update", "setText", "setDeck", "setScreen", "setFill"]) {
    if (typeof inner.userData[key] === "function") hooks[key] = inner.userData[key];
  }
  const physicsShapes = physicsColliders ? colliderShapes(inner) : null;
  // A rigged part (training dummy on its post) is split at its pivot before any merge: the swing meshes get their own group.
  const physicsRig = physicsShapes ? buildRig(inner, physicsShapes, rigFor(record.part, meta)) : null;
  // Parts whose hooks keep references to individual meshes are left as built.
  if (!Object.keys(hooks).length && record.part !== "drawing") {
    if (physicsRig) { kit.mergeStatic(physicsRig.swing); keepMeshes(physicsRig.swing); }
    kit.mergeStatic(inner);
  }
  wrapper.userData = { id: record.id, record, meta, inner, hooks, physicsShapes, physicsRig };
  if (record.text && hooks.setText) hooks.setText(record.text);
  if (record.data && hooks.setDeck && (meta.deck || record.data.cards || record.data.card)) hooks.setDeck(record.data);
  // Model first, sculpt fallback (LOOK-BIBLE.md step 7): the sculpt above is the collider source and the look until the
  // part's GLB (assets/models/MANIFEST.json) arrives and fits; models.js swaps it in and js/world/objects.js re-measures.
  // Only built-in catalog parts have models; blueprints, drawings and placeholders keep what they built.
  if (!meta.placeholder && meta.category !== "custom" && registry.has(record.part)) {
    wrapper.userData.modelPending = attachModel(wrapper, { meta, record, inner, hooks, rig: physicsRig ? rigFor(record.part, meta) : null });
  }
  return wrapper;
}

// A part's mesh on its own (no wrapper), for containers drawing the pieces inside them.
function buildPart(part, color) {
  const name = String(part || "").toLowerCase();
  const builder = registry.get(name);
  let inner = null;
  try {
    if (builder) inner = builder({ color: color || getMeta(name)?.color, data: {}, text: "", seed: 1, buildPart });
  } catch (err) {
    console.error(`[parts] failed to build ${name}`, err);
  }
  if (inner && !Object.keys(inner.userData).some((k) => typeof inner.userData[k] === "function")) kit.mergeStatic(inner);
  return inner;
}

function hashSeed(text = "") {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
