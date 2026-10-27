#!/usr/bin/env node
// Checks assets/models/MANIFEST.json against the files and the catalog, in Node, without three's GLTFLoader
// (LOOK-BIBLE.md build order step 7). For every model: the GLB header and chunks parse, the bounds come from the
// POSITION accessors' min/max carried through the node matrices, the fit obeys js/parts/build/model-fit.js (the
// same rules the game applies), the base sits within 10 mm of y = 0, the triangles are under the part's cap, the
// textures are self-contained and at most 2048 px, and the sha256 matches. Exit 0 only when every entry is right.
//
//   node tools/manifest-check.mjs [--manifest assets/models/MANIFEST.json] [--report <json>] [--write]
//       --write fills sha256, triangles, textures and the fitted size in, and marks entries that do not fit rejected.
//   node tools/manifest-check.mjs --scan <folder> [--scan-out <json>]
//       Reads a free-model folder (<item>.glb + <item>.part.json) and says which catalog part each one could stand
//       in for, its triangles and the rotate that fits best. Nothing is copied or written to the manifest.
// Claude (Command), Oct 26 2026.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as THREE from "../vendor/three.module.min.js";
import { allMeta, getMeta } from "../js/parts/meta/index.js";
import { rotatedBounds, fitToCatalog, fittedBounds, defaultCap, suggestRotate, BASE_TOLERANCE_M, MAX_TOLERANCE_M } from "../js/parts/build/model-fit.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const game = path.resolve(here, "..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf("--" + k); return i < 0 ? d : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true; };

export const TEXTURE_MAX_PX = 2048;        // laptop tier; Quest downscales to 1024 at the tier pass (section 10)
// meshy-community: Meshy's free community catalog. Owner, Oct 26 2026 11:56 AM (Claude Duet transmitter): "These are all
// licensed. ... it's a catalog that tells you you can use any of it in a paid game. Don't ... verify and test that each one
// is individually." So the catalog is the licence record and there is no per-model check. Command's own decision, not
// the owner's words: no attribution line is generated for these, since no per-model licence text was read.
export const LICENSES = ["CC0", "CC-BY-4.0", "owner", "meshy-community"];
export const STATUSES = ["active", "awaiting-owner", "rejected"];
const DECODER_EXTENSIONS = ["KHR_draco_mesh_compression", "EXT_meshopt_compression"];

// ---------- GLB parsing ----------

export function parseGLB(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB (bad magic)");
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`glTF version ${version}, expected 2`);
  const length = view.getUint32(8, true);
  if (length > bytes.byteLength) throw new Error(`header says ${length} bytes, file has ${bytes.byteLength}`);
  let offset = 12, json = null, bin = null;
  while (offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true), chunkType = view.getUint32(offset + 4, true);
    const chunk = bytes.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (chunkType === 0x004e4942 && !bin) bin = chunk;
    offset += 8 + chunkLength;
  }
  if (!json) throw new Error("no JSON chunk");
  return { json, bin };
}

const COMPONENT = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function accessorBytes(json, bin, accessor) {
  const bv = json.bufferViews?.[accessor.bufferView];
  if (!bv || !bin) return null;
  const [Type, width] = COMPONENT[accessor.componentType] || [];
  if (!Type) return null;
  const n = SIZE[accessor.type] || 1;
  const stride = bv.byteStride || n * width;
  const start = (bv.byteOffset || 0) + (accessor.byteOffset || 0);
  return { Type, width, n, stride, start };
}

// min/max of a POSITION accessor: from the JSON (required by the spec) or, failing that, read from the buffer.
function accessorBounds(json, bin, accessor) {
  if (Array.isArray(accessor.min) && Array.isArray(accessor.max) && accessor.min.length === 3) return { min: accessor.min.map(Number), max: accessor.max.map(Number) };
  const a = accessorBytes(json, bin, accessor);
  if (!a || a.n !== 3) throw new Error("POSITION accessor without min/max and unreadable buffer");
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const read = { 5120: (o) => dv.getInt8(o), 5121: (o) => dv.getUint8(o), 5122: (o) => dv.getInt16(o, true), 5123: (o) => dv.getUint16(o, true), 5125: (o) => dv.getUint32(o, true), 5126: (o) => dv.getFloat32(o, true) }[accessor.componentType];
  for (let i = 0; i < accessor.count; i++) for (let k = 0; k < 3; k++) {
    const v = read(a.start + i * a.stride + k * a.width);
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
  }
  return { min, max };
}

function nodeMatrix(node) {
  const m = new THREE.Matrix4();
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return m.fromArray(node.matrix);
  const t = node.translation || [0, 0, 0], r = node.rotation || [0, 0, 0, 1], s = node.scale || [1, 1, 1];
  return m.compose(new THREE.Vector3(...t), new THREE.Quaternion(...r), new THREE.Vector3(...s));
}

function imageSize(bytes) {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20), mime: "image/png" };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let i = 2;
    while (i + 9 < bytes.length && bytes[i] === 0xff) {
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: dv.getUint16(i + 7), h: dv.getUint16(i + 5), mime: "image/jpeg" };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + dv.getUint16(i + 2);
    }
    return { w: null, h: null, mime: "image/jpeg" };
  }
  if (bytes.length >= 30 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = String.fromCharCode(...bytes.subarray(12, 16));
    if (tag === "VP8 ") return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff, mime: "image/webp" };
    if (tag === "VP8L") { const b = dv.getUint32(21, true); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, mime: "image/webp" }; }
    if (tag === "VP8X") return { w: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1, h: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1, mime: "image/webp" };
  }
  return { w: null, h: null, mime: "unknown" };
}

// Everything the manifest check needs from one GLB, without decoding geometry: bounds of the default scene in model
// space, the triangle count of every mesh instance, image sizes, and what the file needs that the game cannot give it.
export function inspectGLB(buffer) {
  const { json, bin } = parseGLB(buffer);
  const problems = [];
  for (const ext of json.extensionsRequired || []) {
    if (DECODER_EXTENSIONS.includes(ext)) problems.push(`needs ${ext}; the game vendors no decoder`);
    // Quantized positions are integers the loader dequantizes; this tool measures raw accessor values, so its verdict would differ.
    if (ext === "KHR_mesh_quantization") problems.push("uses KHR_mesh_quantization; re-export with float positions so the tool and the game measure the same model");
  }
  const sceneIndex = json.scene ?? 0;
  const scene = json.scenes?.[sceneIndex];
  if (!scene) problems.push("no scene");
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let triangles = 0, meshInstances = 0, primitives = 0;
  const v = new THREE.Vector3();
  const visit = (index, parent, depth) => {
    if (depth > 64) throw new Error("node graph too deep (cycle?)");
    const node = json.nodes?.[index];
    if (!node) return;
    const world = parent.clone().multiply(nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh];
      for (const prim of mesh?.primitives || []) {
        primitives++;
        const mode = prim.mode ?? 4;
        const count = prim.indices !== undefined ? json.accessors[prim.indices].count : json.accessors[prim.attributes?.POSITION]?.count ?? 0;
        if (mode === 4) triangles += Math.floor(count / 3);
        else if (mode === 5 || mode === 6) triangles += Math.max(0, count - 2);
        if (prim.attributes?.POSITION === undefined) continue;
        const b = accessorBounds(json, bin, json.accessors[prim.attributes.POSITION]);
        for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
          v.set(x, y, z).applyMatrix4(world);
          for (const [k, c] of [["x", 0], ["y", 1], ["z", 2]]) { if (v[k] < min[c]) min[c] = v[k]; if (v[k] > max[c]) max[c] = v[k]; }
        }
      }
      meshInstances++;
    }
    for (const child of node.children || []) visit(child, world, depth + 1);
  };
  for (const root of scene?.nodes || []) visit(root, new THREE.Matrix4(), 0);
  if (!Number.isFinite(min[0])) problems.push("no mesh with positions in the default scene");
  const textures = [];
  for (const image of json.images || []) {
    if (image.uri !== undefined) { problems.push(`external image ${String(image.uri).slice(0, 60)}; the GLB must be self-contained`); continue; }
    const bv = json.bufferViews?.[image.bufferView];
    if (!bv || !bin) { textures.push({ w: null, h: null, mime: image.mimeType || "unknown", bytes: 0 }); continue; }
    const bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    textures.push({ ...imageSize(bytes), bytes: bv.byteLength });
  }
  return {
    generator: json.asset?.generator || null, bounds: { min, max }, triangles, meshInstances, primitives, textures,
    materials: json.materials?.length || 0, animations: json.animations?.length || 0, skins: json.skins?.length || 0, problems,
  };
}

export const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

// ---------- the manifest ----------

export function checkEntry(entry, { dir, write = false }) {
  const result = { part: entry.part, file: entry.file ?? null, status: entry.status, ok: true, failures: [], notes: [] };
  const fail = (s) => { result.ok = false; result.failures.push(s); };
  const meta = getMeta(entry.part);
  if (!meta) fail(`"${entry.part}" is not a catalog part`);
  if (!STATUSES.includes(entry.status)) fail(`status "${entry.status}" (expected ${STATUSES.join(", ")})`);
  if (entry.status === "awaiting-owner") {
    if (entry.file) fail("awaiting-owner entries carry no file");
    return result;
  }
  if (!entry.file) {
    // A rejected stand-in is recorded without copying its file in; the reason is the record.
    if (entry.status === "rejected") { if (!entry.rejected) fail("rejected without a reason"); return result; }
    fail("no file"); return result;
  }
  if (!LICENSES.includes(entry.license)) fail(`license "${entry.license}" (expected ${LICENSES.join(", ")})`);
  if (!entry.source) fail("no source (URL or the owner's export folder)");
  const file = path.join(dir, entry.file);
  if (!fs.existsSync(file)) { fail(`missing file ${entry.file}`); return result; }
  const buffer = fs.readFileSync(file);
  let info;
  try { info = inspectGLB(buffer); } catch (err) { fail(`unreadable: ${err.message}`); return result; }
  for (const p of info.problems) fail(p);
  const hash = sha256(buffer);
  result.sha256 = hash; result.bytes = buffer.byteLength; result.triangles = info.triangles; result.textures = info.textures;
  result.generator = info.generator; result.animations = info.animations; result.skins = info.skins; result.sourceBounds = info.bounds;
  if (!meta) return result;
  const cap = entry.cap ?? defaultCap(meta);
  result.cap = cap;
  if (info.triangles > cap) fail(`${info.triangles} triangles over the ${cap} cap`);
  for (const t of info.textures) if (t.w > TEXTURE_MAX_PX || t.h > TEXTURE_MAX_PX) fail(`texture ${t.w}x${t.h} over ${TEXTURE_MAX_PX} px`);
  if (info.textures.some((t) => t.w > 1024 || t.h > 1024)) result.notes.push("texture over 1024 px: downscale on Quest at the tier pass");
  // Step 8: a per-entry tolerance (metres per axis) for a real shape that differs from its sculpt box, with the reason
  // written down; and rig.split for a rigged part (where models.js cuts the model for the swing group).
  if (entry.tolerance !== undefined && entry.tolerance !== null) {
    const t = entry.tolerance;
    if (!Array.isArray(t) || t.length !== 3 || !t.every((n) => Number.isFinite(n) && n >= 0 && n <= MAX_TOLERANCE_M)) fail(`tolerance must be three metres in 0..${MAX_TOLERANCE_M}`);
    if (typeof entry.fitNote !== "string" || entry.fitNote.length < 8) fail("tolerance needs a fitNote saying why the shape differs from the sculpt");
  }
  if (entry.rig !== undefined && entry.rig !== null) {
    if (!Number.isFinite(entry.rig.split) || entry.rig.split <= 0 || entry.rig.split >= meta.size[1]) fail(`rig.split must be a height in metres between 0 and ${meta.size[1]}`);
  }
  const rotated = rotatedBounds(info.bounds.min, info.bounds.max, entry.rotate || [0, 0, 0]);
  const fit = fitToCatalog(rotated, meta.size, { grip: meta.holdable ? meta.grip?.p : null, handle: entry.handle || null, offset: entry.offset || [0, 0, 0], tolerance: Array.isArray(entry.tolerance) ? entry.tolerance : null });
  const fitted = fittedBounds(rotated, fit);
  result.fit = { ok: fit.ok, scale: +fit.scale.toFixed(5), size: fit.size.map((n) => +n.toFixed(4)), translate: fit.translate.map((n) => +n.toFixed(4)), baseY: +fitted.min[1].toFixed(4), reasons: fit.reasons, tolerances: fit.tolerances?.map((n) => +n.toFixed(3)) };
  if (entry.status === "rejected") {
    if (!entry.rejected) fail("rejected without a reason");
    if (fit.ok && info.problems.length === 0 && info.triangles <= cap) result.notes.push("rejected but fits now");
    return result;
  }
  if (!fit.ok) {
    if (write) { entry.status = "rejected"; entry.rejected = fit.reasons.join("; "); result.notes.push("marked rejected"); }
    else fail(`does not fit: ${fit.reasons.join("; ")}`);
  }
  if (!entry.handle && Math.abs(fitted.min[1]) > BASE_TOLERANCE_M) fail(`base at y = ${fitted.min[1].toFixed(4)} m, not within ${BASE_TOLERANCE_M} m of the ground`);
  if (entry.material && typeof entry.material !== "string") fail("material override must be a kit kind name");
  if (write) { entry.sha256 = hash; entry.triangles = info.triangles; entry.textures = info.textures.map((t) => ({ w: t.w, h: t.h })); entry.size = result.fit.size; entry.cap = cap; }
  else {
    if (entry.sha256 !== hash) fail(`sha256 ${entry.sha256 ? "differs" : "missing"} (file ${hash.slice(0, 12)}...)`);
    if (entry.triangles !== info.triangles) fail(`triangles ${entry.triangles} in the manifest, ${info.triangles} in the file`);
  }
  return result;
}

export function checkManifest(manifestPath, { write = false } = {}) {
  const dir = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const results = [], failures = [];
  if (manifest.version !== 1) failures.push(`manifest version ${manifest.version}, expected 1`);
  if (!Array.isArray(manifest.models)) failures.push("manifest.models is not a list");
  const seen = new Set();
  for (const entry of manifest.models || []) {
    if (seen.has(entry.part)) failures.push(`part "${entry.part}" listed twice`);
    seen.add(entry.part);
    const r = checkEntry(entry, { dir, write });
    results.push(r);
    for (const f of r.failures) failures.push(`${entry.part}: ${f}`);
  }
  if (write) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const count = (s) => (manifest.models || []).filter((e) => e.status === s).length;
  return { manifest: manifestPath, ok: failures.length === 0, failures, results,
    summary: { entries: (manifest.models || []).length, active: count("active"), awaitingOwner: count("awaiting-owner"), rejected: count("rejected"),
      triangles: results.reduce((s, r) => s + (r.status === "active" ? r.triangles || 0 : 0), 0) } };
}

// ---------- scan a free-model folder ----------

export function scanFolder(dir) {
  const aliases = new Map();
  for (const m of allMeta()) { aliases.set(m.name, m); for (const a of m.aliases || []) aliases.set(a, m); }
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".glb")).sort()) {
    const item = f.slice(0, -4);
    let part = null;
    try { part = JSON.parse(fs.readFileSync(path.join(dir, item + ".part.json"), "utf8")); } catch {}
    const names = [part?.name, ...(part?.aliases || []), item.replace(/-/g, " ")].filter(Boolean).map((n) => String(n).toLowerCase());
    const meta = names.map((n) => aliases.get(n)).find(Boolean) || null;
    const row = { item, file: f, bytes: fs.statSync(path.join(dir, f)).size, names, catalogPart: meta?.name || null };
    try {
      const info = inspectGLB(fs.readFileSync(path.join(dir, f)));
      row.triangles = info.triangles; row.textures = info.textures.map((t) => `${t.w}x${t.h}`); row.problems = info.problems;
      row.sourceSize = [0, 1, 2].map((i) => +(info.bounds.max[i] - info.bounds.min[i]).toFixed(3));
      if (meta) {
        const best = suggestRotate(info.bounds.min, info.bounds.max, meta.size)[0];
        row.catalogSize = meta.size; row.cap = defaultCap(meta); row.rotate = best.rotate; row.fittedSize = best.size; row.fits = best.ok && info.triangles <= row.cap && info.problems.length === 0;
        row.fitProblems = fitToCatalog(rotatedBounds(info.bounds.min, info.bounds.max, best.rotate), meta.size).reasons;
      }
    } catch (err) { row.error = err.message; }
    rows.push(row);
  }
  return rows;
}

function main() {
  const scan = opt("scan", null);
  if (scan) {
    const rows = scanFolder(path.resolve(scan));
    for (const r of rows) {
      const fit = r.catalogPart ? `${r.fits ? "FITS" : "no"} ${r.catalogPart} rotate ${JSON.stringify(r.rotate)} -> ${JSON.stringify(r.fittedSize)} vs ${JSON.stringify(r.catalogSize)}${r.fitProblems?.length ? " | " + r.fitProblems.join("; ") : ""}` : "no catalog part";
      console.log(`${r.item.padEnd(28)} ${String(r.triangles ?? "?").padStart(7)} tris  ${(r.textures || []).join(",").padEnd(22)} ${fit}${r.error ? " | " + r.error : ""}`);
    }
    const out = opt("scan-out", null);
    if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(rows, null, 2));
    console.log(JSON.stringify({ scanned: rows.length, fits: rows.filter((r) => r.fits).map((r) => `${r.item}->${r.catalogPart}`) }));
    return;
  }
  const manifestPath = path.resolve(game, opt("manifest", "assets/models/MANIFEST.json"));
  const report = checkManifest(manifestPath, { write: opt("write", false) === true });
  const out = opt("report", null);
  if (out) fs.writeFileSync(path.resolve(out), JSON.stringify(report, null, 2));
  for (const r of report.results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.part.padEnd(18)} ${r.status.padEnd(15)} ${r.file ?? "-"}${r.triangles !== undefined ? ` ${r.triangles} tris` : ""}${r.fit ? ` size ${JSON.stringify(r.fit.size)} base ${r.fit.baseY}` : ""}${r.failures.length ? " | " + r.failures.join("; ") : ""}${r.notes.length ? " | " + r.notes.join("; ") : ""}`);
  console.log(JSON.stringify({ ok: report.ok, ...report.summary, failures: report.failures }));
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
