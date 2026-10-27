// Model loader and manifest (LOOK-BIBLE.md build order step 7): the shared fit rules, the Node GLB inspector behind
// tools/manifest-check.mjs, and the sculpt-to-model swap through buildObject with an injected loader. No files outside
// the candidate are read; the GLBs are built in the test. Claude (Command), Oct 26 2026.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as THREE from "../vendor/three.module.min.js";
import { fitToCatalog, rotatedBounds, fittedBounds, defaultCap, suggestRotate, rotationMatrix, applyMatrix } from "../js/parts/build/model-fit.js";
import { configureModels, attachModel, modelStats, resetModelStats, restoreSculpt, modelFor, modelsReady } from "../js/parts/build/models.js";
import { buildObject, setPhysicsColliders } from "../js/parts/build/index.js";
import { getMeta } from "../js/parts/meta/index.js";
import { measure } from "../js/parts/build/kit.js";
import { parseGLB, inspectGLB, sha256, checkEntry, checkManifest } from "../tools/manifest-check.mjs";

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} ${a} vs ${b} (eps ${eps})`);
const SWORD = getMeta("sword"), CRATE = getMeta("crate");

// ---------- fit math ----------

test("rotationMatrix [0,0,90] turns +X into +Y (three's XYZ Euler)", () => {
  const p = applyMatrix(rotationMatrix([0, 0, 90]), [1, 0, 0]);
  near(p[0], 0, 1e-9); near(p[1], 1, 1e-9); near(p[2], 0, 1e-9);
  const e = new THREE.Euler(0, 0, Math.PI / 2, "XYZ");
  const q = new THREE.Vector3(0.3, 0.7, -0.2).applyEuler(e);
  const r = applyMatrix(rotationMatrix([0, 0, 90]), [0.3, 0.7, -0.2]);
  near(q.x, r[0], 1e-9); near(q.y, r[1], 1e-9); near(q.z, r[2], 1e-9);
});

test("a blade lying along X fits the sword once rotated upright; the base lands on the ground", () => {
  const min = [-1, -0.25, -0.04], max = [1, 0.25, 0.04];
  const flat = fitToCatalog(rotatedBounds(min, max, [0, 0, 0]), SWORD.size);
  assert.equal(flat.ok, false);
  assert.match(flat.reasons.join(" "), /largest axis is x/);
  const b = rotatedBounds(min, max, [0, 0, 90]);
  const fit = fitToCatalog(b, SWORD.size);
  assert.equal(fit.ok, true, fit.reasons.join("; "));
  near(fit.scale, 0.525, 1e-9);
  near(fit.size[0], 0.2625, 1e-9); near(fit.size[1], 1.05, 1e-9); near(fit.size[2], 0.042, 1e-9);
  const out = fittedBounds(b, fit);
  near(out.min[1], 0, 1e-9, "base"); near((out.min[0] + out.max[0]) / 2, 0, 1e-9, "centred x"); near((out.min[2] + out.max[2]) / 2, 0, 1e-9, "centred z");
  assert.deepEqual(suggestRotate(min, max, SWORD.size)[0].rotate, [0, 0, 90]);
});

test("the other two axes must land within 15% (or 30 mm); a cube is not a sword", () => {
  const fit = fitToCatalog({ min: [0, 0, 0], max: [1, 1, 1] }, SWORD.size);
  assert.equal(fit.ok, false);
  assert.ok(fit.reasons.some((r) => /axis x fits to 1\.050/.test(r)), fit.reasons.join("; "));
  // 0.9 m crate: a 1 m cube scales to 0.9 and fits; a 1 x 1 x 1.5 box misses z by 0.45 m
  assert.equal(fitToCatalog({ min: [0, 0, 0], max: [1, 1, 1] }, CRATE.size).ok, true);
  // the crate's three axes tie, so the box scales by its own largest (z) and its x and y come out 0.3 m short
  const long = fitToCatalog({ min: [0, 0, 0], max: [1, 1, 1.5] }, CRATE.size);
  assert.equal(long.ok, false);
  assert.equal(long.catalogAxis, 2);
  assert.match(long.reasons.join(" "), /axis x fits to 0\.600/);
  // no tie on the sword: a blade lying along x is still told to set rotate
  assert.match(fitToCatalog({ min: [0, 0, 0], max: [1.5, 0.3, 0.04] }, SWORD.size).reasons.join(" "), /largest axis is x/);
  // thin axis: 30 mm floor lets a 0.06 m thick blade stand in for the 0.04 m catalog sword
  const thick = fitToCatalog({ min: [-0.14, 0, -0.03], max: [0.14, 1.05, 0.03] }, SWORD.size);
  assert.equal(thick.ok, true, thick.reasons.join("; "));
  const tooThick = fitToCatalog({ min: [-0.14, 0, -0.04], max: [0.14, 1.05, 0.04] }, SWORD.size);
  assert.equal(tooThick.ok, false);
});

test("step 8: a per-entry tolerance widens one minor axis with the reason recorded; tied catalog axes follow the model", () => {
  const thickGuard = { min: [-0.14, 0, -0.043], max: [0.14, 1.05, 0.043] };          // an 86 mm deep crossguard on the 40 mm sword slab
  assert.equal(fitToCatalog(thickGuard, SWORD.size).ok, false);
  const widened = fitToCatalog(thickGuard, SWORD.size, { tolerance: [0, 0, 0.05] });
  assert.equal(widened.ok, true, widened.reasons.join("; "));
  near(widened.tolerances[2], 0.05, 1e-9);
  // never narrows the rule's own floor, never touches the largest axis, capped at MAX_TOLERANCE_M
  assert.equal(fitToCatalog({ min: [-0.14, 0, -0.03], max: [0.14, 1.05, 0.03] }, SWORD.size, { tolerance: [0, 0, 0.001] }).ok, true);
  assert.equal(fitToCatalog({ min: [0, 0, 0], max: [1, 1, 5] }, CRATE.size, { tolerance: [0, 0, 9] }).ok, false);
  const wide = fitToCatalog({ min: [0, 0, 0], max: [1, 1, 1.2] }, CRATE.size, { tolerance: [0, 0, 9] });
  assert.equal(wide.ok, false, "a box 150 mm short on x and y against the 0.9 m crate: the tolerance is capped at 120 mm");
  // the 1.57 m scarecrow on the 0.7 m dummy slot stays rejected whatever the entry asks for
  const DUMMY = getMeta("training dummy");
  assert.equal(fitToCatalog({ min: [-0.784, 0, -0.43], max: [0.784, 1.82, 0.43] }, DUMMY.size, { tolerance: [1, 0, 1] }).ok, false);
  // the catalog shield is 0.626 x 0.626 x 0.144: a disc whose y is a hair larger than its x scales by y, not "set rotate"
  const SHIELD = getMeta("shield");
  const disc = { min: [-0.3, 0, -0.054], max: [0.3, 0.6004, 0.054] };
  const plain = fitToCatalog(disc, SHIELD.size);
  assert.equal(plain.catalogAxis, 1);
  assert.ok(!plain.reasons.some((r) => /set rotate/.test(r)), plain.reasons.join("; "));
  assert.equal(plain.ok, false, "113 mm deep against 144 mm is 1 mm over the 30 mm floor");
  const f = fitToCatalog(disc, SHIELD.size, { tolerance: [0, 0, 0.035] });
  assert.equal(f.ok, true, f.reasons.join("; "));
  near(f.size[1], 0.626, 1e-9);
  near(f.size[0], 0.6254, 1e-3);
});

test("handle alignment moves the fitted model so the handle sits on the catalog grip point", () => {
  const b = { min: [-0.14, 0, -0.02], max: [0.14, 1.05, 0.02] };
  const fit = fitToCatalog(b, SWORD.size, { grip: SWORD.grip.p, handle: [0, 0.05, 0] });
  near(fit.translate[1], 0.09, 1e-9);
  near(fittedBounds(b, fit).min[1], 0.09, 1e-9);
  const nudged = fitToCatalog(b, SWORD.size, { offset: [0.01, 0, -0.02] });
  near(nudged.translate[0], 0.01, 1e-9); near(nudged.translate[2], -0.02, 1e-9);
});

test("triangle caps follow section 5", () => {
  assert.equal(defaultCap(getMeta("sword")), 6000);
  assert.equal(defaultCap(getMeta("crate")), 12000);
  assert.equal(defaultCap(getMeta("castle")), 60000);
  assert.equal(defaultCap(getMeta("villa")), 40000);
  assert.equal(defaultCap(getMeta("tree")), 4000);
  assert.equal(defaultCap(getMeta("pine tree")), 4000);
});

// ---------- a GLB built here, inspected without GLTFLoader ----------

function makeGLB({ min = [-0.5, 0, -0.5], max = [0.5, 1, 0.5], nodeScale = [1, 1, 1], indices = [0, 1, 2], extensionsRequired, image, omitMinMax = false, mode } = {}) {
  const positions = new Float32Array([min[0], min[1], min[2], max[0], max[1], max[2], min[0], max[1], min[2]]);
  const idx = indices ? new Uint16Array(indices) : null;
  const parts = [positions.buffer];
  if (idx) parts.push(idx.buffer);
  if (image) parts.push(image.buffer);
  let bin = Buffer.concat(parts.map((b) => Buffer.from(b)));
  while (bin.length % 4) bin = Buffer.concat([bin, Buffer.from([0])]);
  const bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }];
  const accessors = [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", ...(omitMinMax ? {} : { min, max }) }];
  const primitive = { attributes: { POSITION: 0 }, ...(mode !== undefined ? { mode } : {}) };
  let offset = positions.byteLength;
  if (idx) { bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: idx.byteLength }); accessors.push({ bufferView: 1, componentType: 5123, count: idx.length, type: "SCALAR" }); primitive.indices = 1; offset += idx.byteLength; }
  const json = { asset: { version: "2.0", generator: "models.test" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, scale: nodeScale }], meshes: [{ primitives: [primitive] }], accessors, bufferViews, buffers: [{ byteLength: bin.length }] };
  if (image) { bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: image.byteLength }); json.images = [{ bufferView: bufferViews.length - 1, mimeType: "image/png" }]; }
  if (extensionsRequired) json.extensionsRequired = extensionsRequired;
  let js = Buffer.from(JSON.stringify(json));
  while (js.length % 4) js = Buffer.concat([js, Buffer.from(" ")]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(js.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(bin.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, c1, js, c2, bin]);
}

const pngHeader = (w, h) => { const b = Buffer.alloc(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

test("inspectGLB: bounds through the node scale, triangles by mode, image sizes, decoder extensions", () => {
  const info = inspectGLB(makeGLB({ nodeScale: [2, 2, 2], image: pngHeader(1024, 512) }));
  assert.deepEqual(info.bounds.min.map((n) => +n.toFixed(6)), [-1, 0, -1]);
  assert.deepEqual(info.bounds.max.map((n) => +n.toFixed(6)), [1, 2, 1]);
  assert.equal(info.triangles, 1);
  assert.deepEqual(info.textures.map((t) => [t.w, t.h, t.mime]), [[1024, 512, "image/png"]]);
  assert.deepEqual(info.problems, []);
  assert.equal(inspectGLB(makeGLB({ indices: [0, 1, 2, 0, 2, 1] })).triangles, 2);
  assert.equal(inspectGLB(makeGLB({ indices: null, mode: 5 })).triangles, 1);
  assert.equal(inspectGLB(makeGLB({ omitMinMax: true })).bounds.max[1], 1, "min/max read from the buffer when the JSON lacks them");
  assert.match(inspectGLB(makeGLB({ extensionsRequired: ["KHR_draco_mesh_compression"] })).problems.join(" "), /draco/);
  assert.throws(() => parseGLB(Buffer.from("not a glb at all, just text that is long enough")), /magic/);
  assert.throws(() => parseGLB(makeGLB().subarray(0, 40)), /header says/);
});

test("checkEntry: fit, base, sha256 and triangles against the manifest; missing and mis-filed entries fail", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-models-"));
  try {
    const glb = makeGLB();                       // a 1 m cube: scales to the 0.9 m crate
    fs.writeFileSync(path.join(dir, "crate.glb"), glb);
    const entry = { part: "crate", file: "crate.glb", status: "active", license: "CC0", source: "test" };
    const first = checkEntry(entry, { dir, write: true });
    assert.deepEqual(first.failures, []);
    assert.equal(entry.sha256, sha256(glb));
    assert.equal(entry.triangles, 1);
    assert.equal(entry.cap, 12000);
    near(entry.size[0], 0.9, 1e-6);
    const second = checkEntry(entry, { dir });
    assert.equal(second.ok, true, second.failures.join("; "));
    near(second.fit.baseY, 0, 1e-6);
    assert.equal(checkEntry({ ...entry, sha256: "0".repeat(64) }, { dir }).failures.some((f) => /sha256 differs/.test(f)), true);
    assert.equal(checkEntry({ ...entry, triangles: 7 }, { dir }).failures.some((f) => /triangles 7/.test(f)), true);
    assert.equal(checkEntry({ ...entry, file: "nope.glb" }, { dir }).failures.some((f) => /missing file/.test(f)), true);
    assert.equal(checkEntry({ ...entry, cap: 0 }, { dir }).failures.some((f) => /over the 0 cap/.test(f)), true);
    assert.equal(checkEntry({ ...entry, license: "CC-BY-NC" }, { dir }).failures.some((f) => /license/.test(f)), true);
    assert.equal(checkEntry({ ...entry, license: "meshy-community" }, { dir }).ok, true, "the Meshy free catalog is a licence (owner Oct 26)");
    // step 8: tolerance needs its reason; rig.split is a height inside the part
    assert.equal(checkEntry({ ...entry, tolerance: [0, 0, 0.05] }, { dir }).failures.some((f) => /fitNote/.test(f)), true);
    assert.equal(checkEntry({ ...entry, tolerance: [0, 0, 0.05], fitNote: "a thicker guard than the sculpt" }, { dir }).ok, true);
    assert.equal(checkEntry({ ...entry, tolerance: [0, 0, 0.5], fitNote: "a thicker guard than the sculpt" }, { dir }).failures.some((f) => /tolerance must be/.test(f)), true);
    assert.equal(checkEntry({ ...entry, rig: { split: 5 } }, { dir }).failures.some((f) => /rig\.split/.test(f)), true);
    assert.equal(checkEntry({ ...entry, rig: { split: 0.5 } }, { dir }).ok, true);
    assert.equal(checkEntry({ part: "sword", status: "awaiting-owner", file: "x.glb" }, { dir }).failures.some((f) => /no file/.test(f)), true);
    assert.equal(checkEntry({ part: "sword", status: "awaiting-owner", file: null }, { dir }).ok, true);
    assert.equal(checkEntry({ part: "not a part", status: "awaiting-owner", file: null }, { dir }).ok, false);
    // the same cube offered as a sword does not fit: --write marks it rejected, a plain check fails it
    fs.writeFileSync(path.join(dir, "sword.glb"), glb);
    const sword = { part: "sword", file: "sword.glb", status: "active", license: "CC0", source: "test" };
    assert.equal(checkEntry({ ...sword }, { dir }).failures.some((f) => /does not fit/.test(f)), true);
    checkEntry(sword, { dir, write: true });
    assert.equal(sword.status, "rejected");
    assert.match(sword.rejected, /axis/);
    fs.writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify({ version: 1, models: [entry, sword, { part: "shield", status: "awaiting-owner", file: null }] }));
    const report = checkManifest(path.join(dir, "MANIFEST.json"));
    assert.equal(report.ok, true, report.failures.join("; "));
    assert.deepEqual(report.summary, { entries: 3, active: 1, awaitingOwner: 1, rejected: 1, triangles: 1 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- the swap through buildObject, with an injected loader ----------

const rec = (id, part, extra = {}) => ({ id, part, label: part, p: [0, 0, 0], ry: 0, s: 1, data: {}, ...extra });
const boxScene = (w, h, d, { y = h / 2, materials = 1 } = {}) => {
  const g = new THREE.Group();
  for (let i = 0; i < materials; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: 0x808080 }));
    m.position.set(i * 0.0, y, 0);
    g.add(m);
  }
  return g;
};
const MANIFEST = { version: 1, models: [
  { part: "crate", file: "crate.glb", status: "active", license: "CC0", source: "test" },
  { part: "sword", file: "saber.glb", status: "active", license: "CC0", source: "test", rotate: [0, 0, 90], handle: [0, 0.05, 0] },
  { part: "barrel", file: "missing.glb", status: "active", license: "CC0", source: "test" },
  { part: "hay bale", file: "long.glb", status: "active", license: "CC0", source: "test" },
  { part: "whiteboard", file: "crate.glb", status: "active", license: "CC0", source: "test" },
  { part: "training dummy", file: "crate.glb", status: "active", license: "CC0", source: "test" },
  { part: "chair", file: "crate.glb", status: "rejected", rejected: "test", license: "CC0", source: "test" },
] };
const loads = [];
const fakeLoader = async (url) => {
  loads.push(url);
  if (url.endsWith("crate.glb")) return boxScene(1, 1, 1);
  if (url.endsWith("saber.glb")) return boxScene(2, 0.5, 0.08, { y: 0 });        // a blade lying along X, centred
  if (url.endsWith("long.glb")) return boxScene(1, 1, 3);                         // never fits the hay bale
  throw new Error("HTTP 404");
};
const warnings = [];
const realWarn = console.warn;

test.before(() => { console.warn = (...a) => warnings.push(a.join(" ")); });
test.after(() => { console.warn = realWarn; configureModels({ enabled: false, manifest: null, loader: null }); });

test("without a browser the builder leaves the sculpt and reports models off", async () => {
  configureModels({ enabled: false, manifest: null, loader: null });
  const w = buildObject(rec("c0", "crate"));
  assert.deepEqual(await w.userData.modelPending, { swapped: false, reason: "models off" });
  assert.equal(w.userData.sculpt, undefined);
});

test("a listed model replaces the sculpt at catalog size, on the ground, with the colliders of the sculpt", async () => {
  configureModels({ enabled: true, manifest: MANIFEST, loader: fakeLoader });
  resetModelStats(); loads.length = 0; warnings.length = 0;
  setPhysicsColliders(true);
  const plain = buildObject(rec("c1", "crate"));
  const before = JSON.stringify(plain.userData.physicsShapes);
  const sculptMeshes = plain.userData.inner.children.length;
  const r = await plain.userData.modelPending;
  assert.equal(r.swapped, true, r.reason);
  near(r.fit.scale, 0.9, 1e-9);
  assert.equal(JSON.stringify(plain.userData.physicsShapes), before, "colliders unchanged by the swap");
  assert.equal(plain.userData.inner.children.length, 1);
  assert.equal(plain.userData.inner.children[0].name, "crate:model");
  assert.equal(plain.userData.sculpt.children.length, sculptMeshes);
  const m = measure(plain.userData.inner);
  for (let i = 0; i < 3; i++) near(m.size[i], 0.9, 1e-6, "size " + "xyz"[i]);
  near(m.min[1], 0, 1e-6, "base");
  assert.equal(plain.userData.model.triangles, 12);
  const mesh = plain.userData.inner.children[0].children[0].children[0];
  assert.equal(mesh.castShadow, true);
  assert.equal(mesh.userData.tint, true, "the body mesh takes the color tint");
  assert.equal(mesh.material.userData.shared, true);
  assert.equal(mesh.geometry.userData.shared, true);
  // a second crate shares the parsed file: one load, two swaps, one geometry object
  const twin = buildObject(rec("c2", "crate"));
  assert.equal((await twin.userData.modelPending).swapped, true);
  assert.equal(loads.filter((u) => u.endsWith("crate.glb")).length, 1);
  assert.equal(twin.userData.inner.children[0].children[0].children[0].geometry, mesh.geometry);
  assert.equal(modelStats().swapped, 2);
  assert.equal(restoreSculpt(twin), true);
  assert.equal(twin.userData.inner.children.length, sculptMeshes);
  assert.equal(twin.userData.sculpt, undefined);
  setPhysicsColliders(false);
});

test("a holdable model is turned upright and its handle lands on the catalog grip", async () => {
  configureModels({ enabled: true, manifest: MANIFEST, loader: fakeLoader });
  const w = buildObject(rec("s1", "sword"));
  const r = await w.userData.modelPending;
  assert.equal(r.swapped, true, r.reason);
  near(r.fit.scale, 0.525, 1e-9);
  near(r.fit.translate[1], 0.615, 1e-9);
  const m = measure(w.userData.inner);
  near(m.size[0], 0.2625, 1e-6); near(m.size[1], 1.05, 1e-6); near(m.size[2], 0.042, 1e-6);
  near(m.min[1], 0.09, 1e-6, "base raised so the handle (0.05 up the model) sits at grip y 0.14");
  near((m.min[0] + m.max[0]) / 2, 0, 1e-6);
  assert.deepEqual(w.userData.meta.grip.p, [0, 0.14, 0], "catalog grip untouched");
});

test("missing, unfitting, hooked and rigged parts keep the sculpt; one warning per file, none for design skips", async () => {
  configureModels({ enabled: true, manifest: MANIFEST, loader: fakeLoader });
  resetModelStats(); warnings.length = 0;
  const b1 = buildObject(rec("b1", "barrel")), b2 = buildObject(rec("b2", "barrel"));
  const r1 = await b1.userData.modelPending, r2 = await b2.userData.modelPending;
  assert.equal(r1.swapped, false); assert.match(r1.reason, /404/);
  assert.equal(r2.swapped, false);
  assert.equal(b1.userData.sculpt, undefined, "sculpt still in place");
  assert.ok(b1.userData.inner.children.length > 0);
  const hay = await buildObject(rec("h1", "hay bale")).userData.modelPending;
  assert.equal(hay.swapped, false); assert.match(hay.reason, /does not fit/);
  const board = await buildObject(rec("w1", "whiteboard", { text: "hi" })).userData.modelPending;
  assert.equal(board.swapped, false); assert.match(board.reason, /mesh references/);
  setPhysicsColliders(true);
  const dummy = await buildObject(rec("d1", "training dummy")).userData.modelPending;
  setPhysicsColliders(false);
  assert.equal(dummy.swapped, false); assert.match(dummy.reason, /physics rig/);
  const chair = await buildObject(rec("ch1", "chair")).userData.modelPending;
  assert.equal(chair.reason, "no model listed", "rejected entries are never loaded");
  assert.equal(modelFor("chair"), null);
  const s = modelStats();
  assert.equal(s.fallbacks.length, 3, JSON.stringify(s.fallbacks));
  assert.equal(s.skipped.length, 2, JSON.stringify(s.skipped));
  assert.equal(s.warnings, 2, warnings.join(" | "));
  assert.equal(warnings.filter((t) => /missing\.glb/.test(t)).length, 1, "one warning for the missing file, not one per object");
  assert.ok(warnings.every((t) => /the sculpt stays/.test(t)), warnings.join(" | "));
});

test("step 8: a rigged part takes a model cut at rig.split; the top joins the live swing group, the base stays planted", async () => {
  const manifest = { version: 1, models: [{ part: "training dummy", file: "tall.glb", status: "active", license: "meshy-community", source: "test", rig: { split: 0.7 } }] };
  configureModels({ enabled: true, manifest, loader: async (url) => { if (url.endsWith("tall.glb")) return boxScene(0.7, 1.82, 0.5); throw new Error("HTTP 404"); } });
  resetModelStats(); warnings.length = 0;
  setPhysicsColliders(true);
  const w = buildObject(rec("d2", "training dummy"));
  const swing = w.userData.inner.children.find((c) => c.name === "rig:swing");
  assert.ok(swing, "the sculpt was split for its rig");
  const sculptSwing = swing.children.length;
  assert.ok(sculptSwing >= 1);
  const r = await w.userData.modelPending;
  setPhysicsColliders(false);
  assert.equal(r.swapped, true, r.reason);
  // a box 1.82 m tall: each side face has one triangle with its centroid above 0.7 and one below; the lid is up, the floor down
  assert.deepEqual(r.split, { y: 0.7, upper: 6, lower: 6 });
  const tops = swing.children.filter((c) => c.userData.model);
  assert.equal(tops.length, 1, "one model mesh in the swing group");
  assert.equal(swing.children.length, 1, "the sculpt's swing meshes moved to the stash");
  assert.equal(tops[0].geometry.index.count, 18);
  assert.notEqual(tops[0].geometry.userData.shared, true, "each half owns its geometry and is disposed with the object");
  const root = w.userData.inner.children.find((c) => c.name.endsWith(":model"));
  const lows = []; root.traverse((o) => { if (o.isMesh) lows.push(o); });
  assert.equal(lows.length, 1); assert.equal(lows[0].geometry.index.count, 18);
  assert.notEqual(lows[0].geometry.attributes.position, tops[0].geometry.attributes.position, "copies, so disposing one object never touches the cached file or the other half");
  assert.deepEqual([...lows[0].geometry.attributes.position.array.slice(0, 6)], [...tops[0].geometry.attributes.position.array.slice(0, 6)]);
  const m = measure(w.userData.inner);
  near(m.size[1], 1.82, 1e-6); near(m.min[1], 0, 1e-6); near(m.size[0], 0.7, 1e-6);
  // the top follows the swing group: lean it and the model's upper half moves, the base does not
  const before = new THREE.Vector3(); tops[0].getWorldPosition(before);
  swing.rotation.z = 1.0; w.updateMatrixWorld(true);
  const after = new THREE.Vector3(); tops[0].getWorldPosition(after);
  assert.ok(before.distanceTo(after) > 0.05, `the model's top swings with the group (${before.distanceTo(after).toFixed(3)} m; its origin sits 90 mm under the 1.0 m pivot)`);
  const lowBefore = new THREE.Vector3(); lows[0].getWorldPosition(lowBefore);
  assert.ok(Math.abs(lowBefore.x) < 1e-9, "the base is where it was");
  swing.rotation.z = 0;
  assert.equal(modelStats().skipped.length, 0);
  assert.equal(warnings.length, 0, warnings.join(" | "));
  // and back: the sculpt's swing meshes return to the live group, the model halves leave
  assert.equal(restoreSculpt(w), true);
  assert.equal(swing.children.length, sculptSwing);
  assert.ok(swing.children.every((c) => !c.userData.model));
  assert.ok(!w.userData.inner.children.some((c) => c.name.endsWith(":model")));
  assert.equal(w.userData.sculpt, undefined);
});

test("step 8: a model landing on a dummy that is already leaning is placed against the swing's rest frame, not its live pose", async () => {
  const manifest = { version: 1, models: [{ part: "training dummy", file: "tall.glb", status: "active", license: "meshy-community", source: "test", rig: { split: 0.7 } }] };
  configureModels({ enabled: true, manifest, loader: async () => boxScene(0.7, 1.82, 0.5) });
  setPhysicsColliders(true);
  const w = buildObject(rec("d3", "training dummy"));
  const swing = w.userData.inner.children.find((c) => c.name === "rig:swing");
  swing.rotation.z = 0.6;                       // knocked back before its file arrived
  w.updateMatrixWorld(true);
  const r = await w.userData.modelPending;
  setPhysicsColliders(false);
  assert.equal(r.swapped, true, r.reason);
  const top = swing.children.find((c) => c.userData.model);
  swing.rotation.z = 0;                         // back at rest: the top must sit exactly where the file put it
  w.updateMatrixWorld(true);
  const p = new THREE.Vector3(); top.getWorldPosition(p);
  near(p.x, 0, 1e-6, "rest x"); near(p.y, 0.91, 1e-6, "rest y (the box's centre)"); near(p.z, 0, 1e-6, "rest z");
  const q = new THREE.Quaternion(); top.getWorldQuaternion(q);
  near(Math.abs(q.w), 1, 1e-6, "no baked lean");
  // and when the group leans again, the top goes with it
  swing.rotation.z = 0.6; w.updateMatrixWorld(true);
  const p2 = new THREE.Vector3(); top.getWorldPosition(p2);
  assert.ok(p.distanceTo(p2) > 0.04, "follows the swing");
});

test("a manifest that cannot be fetched disables models for the session with one warning", async () => {
  configureModels({ enabled: true, manifestUrl: "http://127.0.0.1:9/none/MANIFEST.json", loader: fakeLoader });
  resetModelStats(); warnings.length = 0;
  const r = await attachModel(new THREE.Group(), { meta: CRATE, record: rec("x", "crate"), inner: new THREE.Group() });
  assert.equal(r.swapped, false);
  assert.equal(r.reason, "no model listed");
  assert.equal(modelStats().manifestLoaded, true);
  assert.ok(modelStats().manifestError, "error recorded");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no model manifest/);
  assert.equal(await modelsReady(), (await modelsReady()), "fetched once");
});
