// The built-in library: thousands of everyday things as blueprints, one JSON file per category in
// this folder ({ "category": "kitchen", "parts": [blueprint, …] }, see ARCHITECTURE.md "Library").
// The game and the bridge load it at start. It comes after the hand-built catalog: an entry never
// replaces a built-in part or alias. Pure data handling (no three.js), shared by browser and Node.
import { normalizeBlueprint } from "../../core/blueprint.js";

export const LIBRARY_FILES = [
  "kitchen", "food", "furniture", "household", "tools", "weapons", "vehicles", "animals",
  "sports", "music", "tech", "buildings", "nature", "fantasy", "scifi", "toys",
  "clothing", "school", "outdoors", "science", "survival", "party", "industrial", "street",
];

// Names and aliases already in use (the catalog before the library).
export function takenNames(metas) {
  const taken = new Set();
  for (const meta of metas || []) {
    if (meta?.name) taken.add(String(meta.name).toLowerCase());
    for (const alias of meta?.aliases || []) taken.add(String(alias).toLowerCase());
  }
  return taken;
}

// One category file → { parts: [{ meta, blueprint }], errors }. Adds the names it uses to taken.
export function readLibraryFile(doc, file, taken = new Set()) {
  const parts = [];
  const errors = [];
  const list = Array.isArray(doc?.parts) ? doc.parts : null;
  if (!list) return { parts, errors: [`${file}: needs a "parts" list`] };
  const category = String(doc.category || file).trim().toLowerCase().slice(0, 32) || file;
  for (const raw of list) {
    const res = normalizeBlueprint(raw);
    if (!res.ok) {
      errors.push(`${file}: "${raw?.name ?? "?"}": ${res.error}`);
      continue;
    }
    const bp = res.blueprint;
    // Small things can be picked up unless the entry says otherwise (a phone, an apple, a mug).
    if (raw.holdable === undefined && Math.max(...bp.size) <= 0.5) bp.holdable = true;
    if (taken.has(bp.name)) {
      errors.push(`${file}: "${bp.name}" is already taken`);
      continue;
    }
    taken.add(bp.name);
    bp.aliases = bp.aliases.filter((alias) => !taken.has(alias));
    for (const alias of bp.aliases) taken.add(alias);
    const meta = { name: bp.name, aliases: bp.aliases, desc: bp.desc, size: bp.size, holdable: bp.holdable, grip: bp.grip, category, source: "library" };
    parts.push({ meta, blueprint: bp });
  }
  return { parts, errors };
}

// read(file) → the parsed JSON of <file>.json (fetch in the browser, fs in Node). Never throws.
export async function loadLibrary(read, { taken = new Set(), files = LIBRARY_FILES } = {}) {
  const docs = await Promise.all(files.map((file) => Promise.resolve()
    .then(() => read(file))
    .then((doc) => ({ file, doc }), (err) => ({ file, err }))));
  const parts = [];
  const errors = [];
  for (const { file, doc, err } of docs) {
    if (err) {
      errors.push(`${file}: ${err?.message || err}`);
      continue;
    }
    const out = readLibraryFile(doc, file, taken);
    parts.push(...out.parts);
    errors.push(...out.errors);
  }
  return { parts, errors };
}
