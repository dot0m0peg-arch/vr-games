// Laptop parts bin: blueprint JSON, glTF models and owner-written part modules from local folders.
// Modules are never imported in Node (the browser runs them); only their sidecar metadata is read.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Emitter } from "../js/util/emitter.js";
import { normalizeBlueprint, slug } from "../js/core/blueprint.js";
import { safeSegments, mimeOf } from "./static.mjs";

export const FILE_TYPES = new Set(["glb", "gltf", "bin", "png", "jpg", "jpeg", "webp", "ktx2", "js", "mjs", "json"]);
const MAX_JSON = 2 * 1024 * 1024;
const MAX_CATALOG_JSON = 32 * 1024 * 1024; // *.catalog.json: big checked batches rather than thousands of files

export const PARTS_README = `Training Room laptop parts bin
==============================

Drop files into this folder (or add folders to "partsDirs" in config.json). The bridge rescans
every few seconds; reload the game to pick up new parts. Spoken names are the file names
(lowercase, "-" and "_" become spaces) unless the file says otherwise.

1. Blueprints: <name>.json
   { "name": "dragon statue", "aliases": ["dragon"], "desc": "stone dragon on a plinth",
     "holdable": false,
     "parts": [ { "shape": "box", "p": [0, 0.25, 0], "s": [1.2, 0.5, 1.2], "r": [0, 0, 0],
                  "color": "#777777", "mat": "stone" }, ... ] }
   shape: box | sphere | cylinder | cone | capsule | torus
   p: center in meters (y up, ground at 0), s: bounding size in meters, r: rotation in degrees
   mat: matte | wood | metal | glass | glow | stone | fabric | plastic
   Designs the AI makes are saved to the generated/ subfolder in this format.
   Many in one file: { "category": "zombie stuff", "parts": [ <blueprint>, <blueprint>, ... ] }
   (or a plain list [ <blueprint>, ... ]). Every entry needs its own "name". This is the format a
   chat thread can write in bulk: see PARTS-PROMPT.md next to the game.

2. Models: <name>.glb or <name>.gltf (+ its .bin and textures next to it)
   Optional sidecar <name>.part.json:
   { "aliases": ["my sword"], "size": [0.2, 1.1, 0.05], "holdable": true,
     "grip": { "p": [0, 0.2, 0], "r": [-90, 0, 0] }, "category": "combat", "desc": "my sword" }
   Model origin should be bottom-center, front facing +Z, units in meters.

3. Code parts: <name>.js or <name>.mjs exporting
   export default { name, aliases, size, holdable, desc, build(THREE, opts) { return object3D; } }
   These run as code in the game's browser tab, so only put your own trusted code here.
   The bridge reads metadata from an optional <name>.part.json sidecar.
   Files whose names start with "_" (shared helpers, textures) are served but not listed as parts.
`;

function nameFromFile(file) {
  return path.basename(file).replace(/\.(part\.json|json|glb|gltf|mjs|js)$/i, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

const finite = (n) => typeof n === "number" && Number.isFinite(n);

function cleanMeta(raw = {}) {
  const out = {};
  if (typeof raw.name === "string" && raw.name.trim()) out.name = raw.name.trim().toLowerCase().slice(0, 48);
  if (Array.isArray(raw.aliases)) out.aliases = raw.aliases.filter((a) => typeof a === "string" && a.trim()).map((a) => a.trim().toLowerCase().slice(0, 48)).slice(0, 12);
  if (typeof raw.desc === "string") out.desc = raw.desc.trim().slice(0, 160);
  if (typeof raw.category === "string" && /^[a-z]{2,20}$/.test(raw.category)) out.category = raw.category;
  if (Array.isArray(raw.size) && raw.size.length === 3 && raw.size.every((n) => finite(n) && n > 0 && n <= 200)) out.size = raw.size;
  if (typeof raw.holdable === "boolean") out.holdable = raw.holdable;
  if (raw.grip && Array.isArray(raw.grip.p) && raw.grip.p.length === 3 && raw.grip.p.every(finite)) {
    out.grip = { p: raw.grip.p, r: Array.isArray(raw.grip.r) && raw.grip.r.length === 3 && raw.grip.r.every(finite) ? raw.grip.r : [0, 0, 0] };
  }
  if (typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color)) out.color = raw.color;
  return out;
}

// normalizeBlueprint returns { ok, blueprint, error }; tolerate a bare blueprint too.
export function normalizeBp(input) {
  try {
    const result = normalizeBlueprint(input);
    if (result && typeof result === "object" && "ok" in result) {
      return result.ok && result.blueprint ? { ok: true, blueprint: result.blueprint } : { ok: false, error: String(result.error || "invalid blueprint") };
    }
    if (result && Array.isArray(result.parts)) return { ok: true, blueprint: result };
    return { ok: false, error: "invalid blueprint" };
  } catch (err) {
    return { ok: false, error: err?.message || "invalid blueprint" };
  }
}

// [bp, …], { blueprints | things | items: [bp, …] } or { parts: [bp, …] } where every entry has
// its own parts. Entries of a batch are indexed: kept on the laptop and sent only when asked for.
function batchOf(raw) {
  const isBp = (v) => v && typeof v === "object" && !Array.isArray(v) && Array.isArray(v.parts);
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.blueprints) ? raw.blueprints : Array.isArray(raw?.things) ? raw.things : Array.isArray(raw?.items) ? raw.items
      : Array.isArray(raw?.parts) && raw.parts.length && raw.parts.every(isBp) ? raw.parts : null;
  return list && list.length && list.some(isBp) ? list : null;
}

// Lowercase words, apostrophes kept: how indexed names are looked up in a spoken command.
const words = (text) => String(text || "").toLowerCase().replace(/[^a-z0-9' -]+/g, " ").split(/[\s-]+/).filter(Boolean);

export class PartsBin extends Emitter {
  // dirs[0] is the primary folder (generated/ designs are saved there).
  constructor({ dirs, roomKey = "", scanMs = 10000, log = console } = {}) {
    super();
    this.dirs = [...new Set((dirs || []).map((d) => path.resolve(d)))];
    this.primary = this.dirs[0];
    this.scanMs = scanMs;
    this.log = log;
    this.entries = [];
    this.index = new Map(); // indexed (batch) name or alias -> entry
    this.cache = new Map(); // file path -> { stamp, result }
    this.warned = new Set();
    this.signature = "";
    this.timer = null;
    this.watchers = [];
    this.scanning = null;
    // Capability segment: parts file URLs work without cookies (cross-origin import(), glTF subresources).
    this.cap = crypto.createHmac("sha256", String(roomKey || "parts")).update("parts-file").digest("hex").slice(0, 16);
  }

  ensurePrimary() {
    if (!this.primary) return;
    fs.mkdirSync(path.join(this.primary, "generated"), { recursive: true });
    const readme = path.join(this.primary, "README.txt");
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, PARTS_README.replace(/\n/g, process.platform === "win32" ? "\r\n" : "\n"));
  }

  async start() {
    await this.scan();
    this.timer = setInterval(() => this.scan().catch((err) => this.log.warn?.(`[parts] scan failed: ${err.message}`)), this.scanMs);
    this.timer.unref?.();
    let pending = null;
    const kick = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        this.scan().catch(() => {});
      }, 300);
      pending.unref?.();
    };
    for (const dir of this.dirs) {
      for (const sub of [dir, path.join(dir, "generated")]) {
        try {
          const watcher = fs.watch(sub, { persistent: false }, kick);
          watcher.on("error", () => {});
          this.watchers.push(watcher);
        } catch {
          // fs.watch is optional; the interval scan covers it.
        }
      }
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  async scan() {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  async doScan() {
    const entries = [];
    const seen = new Map(); // name -> index in entries
    const live = new Set();
    const read = []; // { file, found } in scan order
    for (let index = 0; index < this.dirs.length; index++) {
      const dir = this.dirs[index];
      for (const sub of ["", "generated"]) {
        const folder = sub ? path.join(dir, sub) : dir;
        let names;
        try {
          names = (await fsp.readdir(folder, { withFileTypes: true })).filter((d) => d.isFile() || d.isSymbolicLink()).map((d) => d.name).sort();
        } catch {
          continue;
        }
        const set = new Set(names.map((n) => n.toLowerCase()));
        for (const name of names) {
          const lower = name.toLowerCase();
          // Dot files, sidecars and "_helper.js"-style support files are not parts.
          if (lower.startsWith(".") || lower.startsWith("_") || lower.endsWith(".part.json")) continue;
          const ext = path.extname(lower).slice(1);
          if (!["json", "glb", "gltf", "js", "mjs"].includes(ext)) continue;
          const file = path.join(folder, name);
          live.add(file);
          const found = await this.readEntry(file, ext, set, index, sub ? `${sub}/${name}` : name);
          read.push({ file, found });
        }
      }
    }
    // Nothing changed on disk (the usual rescan): skip rebuilding a big bin's lists and index.
    const filesKey = read.map(({ file }) => `${file}\n${this.cache.get(file)?.stamp ?? ""}`).join("\n");
    if (filesKey === this.filesKey) return { count: this.entries.length, changed: false };
    this.filesKey = filesKey;
    for (const { file, found } of read) {
      for (const entry of Array.isArray(found) ? found : found ? [found] : []) {
        if (seen.has(entry.name)) {
          // A real model replaces a primitive blueprint of the same name, wherever each was found
          // (free or owner-made models in an extra partsDirs folder upgrade the items they match).
          const at = seen.get(entry.name);
          if (entry.kind === "gltf" && entries[at].kind === "blueprint") {
            entries[at] = entry;
            continue;
          }
          this.warnOnce(`dup:${file}:${entry.name}`, `[parts] ${file}: "${entry.name}" already exists in the parts bin; skipped`);
          continue;
        }
        seen.set(entry.name, entries.length);
        entries.push(entry);
      }
    }
    for (const key of this.cache.keys()) if (!live.has(key)) this.cache.delete(key);
    const index = new Map();
    for (const entry of entries) {
      if (!entry.indexed) continue;
      for (const key of [entry.name, ...(entry.aliases || [])].map((k) => words(k).join(" "))) if (key && !index.has(key)) index.set(key, entry);
    }
    this.index = index;
    const signature = JSON.stringify(entries.filter((e) => !e.indexed).map((e) => [e.name, e.kind, e.stamp]).concat([[index.size, [...new Set(entries.filter((e) => e.indexed).map((e) => e.stamp))]]]));
    const changed = signature !== this.signature;
    this.signature = signature;
    this.entries = entries;
    if (changed) this.emit("change", entries);
    return { count: entries.length, changed };
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log.warn?.(message);
  }

  async readSidecar(file, names) {
    const base = path.basename(file).replace(/\.(glb|gltf|js|mjs)$/i, "");
    const sidecarName = `${base}.part.json`;
    if (!names.has(sidecarName.toLowerCase())) return {};
    const sidecar = path.join(path.dirname(file), sidecarName);
    try {
      const raw = JSON.parse(await fsp.readFile(sidecar, "utf8"));
      return cleanMeta(raw);
    } catch (err) {
      this.warnOnce(`side:${sidecar}`, `[parts] ${sidecar}: ${err.message}; ignored`);
      return {};
    }
  }

  async readEntry(file, ext, names, index, rel) {
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      return null;
    }
    // Sidecar changes must refresh models/modules, so include its mtime in the cache key.
    let sideStamp = 0;
    if (ext !== "json") {
      const base = path.basename(file).replace(/\.(glb|gltf|js|mjs)$/i, "");
      try {
        sideStamp = (await fsp.stat(path.join(path.dirname(file), `${base}.part.json`))).mtimeMs;
      } catch {
        sideStamp = 0;
      }
    }
    const stamp = `${stat.mtimeMs}:${stat.size}:${sideStamp}`;
    const cached = this.cache.get(file);
    if (cached && cached.stamp === stamp) return cached.result;
    let result = null;
    const url = this.fileUrl(index, rel);
    if (ext === "json") {
      result = await this.readBlueprint(file, stat);
    } else {
      const meta = await this.readSidecar(file, names);
      const kind = ext === "glb" || ext === "gltf" ? "gltf" : "module";
      result = {
        category: "custom",
        aliases: [],
        desc: kind === "gltf" ? "model from the laptop parts bin" : "part from the laptop parts bin",
        holdable: false,
        ...meta,
        name: meta.name || nameFromFile(file),
        kind,
        url,
        file: rel,
      };
      if (!result.name) result = null;
    }
    for (const entry of Array.isArray(result) ? result : result ? [result] : []) entry.stamp = stamp;
    this.cache.set(file, { stamp, result });
    return result;
  }

  async readBlueprint(file, stat) {
    const maxBytes = file.toLowerCase().endsWith(".catalog.json") ? MAX_CATALOG_JSON : MAX_JSON;
    if (stat.size > maxBytes) {
      this.warnOnce(`big:${file}:${stat.mtimeMs}`, `[parts] ${file}: larger than ${Math.round(maxBytes / 1048576)} MB; skipped`);
      return null;
    }
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(file, "utf8"));
    } catch (err) {
      this.warnOnce(`json:${file}:${stat.mtimeMs}`, `[parts] ${file}: not valid JSON (${err.message}); skipped`);
      return null;
    }
    // Many things in one file (a free chat's batch, or a library file): every entry is a blueprint.
    const batch = batchOf(raw);
    if (batch) {
      const category = typeof raw.category === "string" && raw.category.trim() ? raw.category.trim().toLowerCase().slice(0, 32) : "custom";
      const out = [];
      batch.forEach((item, i) => {
        if (!item?.name) {
          this.warnOnce(`bp:${file}:${stat.mtimeMs}:${i}`, `[parts] ${file}: entry ${i + 1} has no name; skipped`);
          return;
        }
        const entry = this.blueprintEntry(item, { category });
        if (entry) out.push({ ...entry, indexed: true });
        else this.warnOnce(`bp:${file}:${stat.mtimeMs}:${i}`, `[parts] ${file}: "${item.name}" is not a valid blueprint; skipped`);
      });
      return out;
    }
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.parts)) {
      this.warnOnce(`bp:${file}:${stat.mtimeMs}`, `[parts] ${file}: not a blueprint (needs a "parts" list); skipped`);
      return null;
    }
    if (!raw.name) raw.name = nameFromFile(file);
    const entry = this.blueprintEntry(raw);
    if (!entry) this.warnOnce(`bp:${file}:${stat.mtimeMs}`, `[parts] ${file}: invalid blueprint (${normalizeBp(raw).error}); skipped`);
    return entry;
  }

  blueprintEntry(raw, { category = "custom" } = {}) {
    const normalized = normalizeBp(raw);
    if (!normalized.ok) return null;
    const bp = normalized.blueprint;
    const meta = cleanMeta({ ...raw, ...bp });
    if (!meta.name) return null;
    return {
      category,
      aliases: [],
      desc: "design from the laptop parts bin",
      holdable: false,
      ...meta,
      size: Array.isArray(bp.size) ? bp.size : meta.size,
      kind: "blueprint",
      blueprint: bp,
    };
  }

  // Path below the API base; segments stay "/"-separated so glTF relative URIs resolve.
  fileUrl(index, rel) {
    return `parts/file/${this.cap}/${index}/${rel.split("/").map(encodeURIComponent).join("/")}`;
  }

  // apiBase: absolute API URL (e.g. "https://192.168.1.5:8787/vr-games/games/training-room/api/"),
  // so file URLs work whichever base the client resolves them against.
  // Indexed (batch) entries stay out: thousands of them would not fit a headset; see resolve().
  manifest(apiBase = "") {
    return {
      indexed: this.index.size ? this.indexedCount : 0,
      parts: this.entries.filter((e) => !e.indexed).map(({ name, aliases, category, desc, size, holdable, grip, kind, url, blueprint, color }) => {
        const part = { name, aliases: aliases || [], category: category || "custom", desc: desc || "", size: size || null, holdable: !!holdable, kind };
        if (grip) part.grip = grip;
        if (color) part.color = color;
        if (url) part.url = apiBase + url;
        if (blueprint) part.blueprint = blueprint;
        return part;
      }),
    };
  }

  // Catalog entries for the model prompt and name matching.
  metas() {
    return this.entries.map(({ name, aliases, category, desc, size, holdable, grip, indexed }) => ({
      name, aliases: aliases || [], category: category || "custom", desc: desc || "", size: size || [1, 1, 1], holdable: !!holdable, grip, source: "laptop",
      ...(indexed ? { indexed: true } : {}),
    }));
  }

  get count() {
    return this.entries.length;
  }

  get indexedCount() {
    return this.entries.reduce((n, e) => n + (e.indexed ? 1 : 0), 0);
  }

  // An indexed thing by exact name or alias, or the longest name found in a spoken command
  // ("AI, give me a flare pistol please" → "flare pistol"). → part with its blueprint, or null.
  resolve({ name = "", text = "" } = {}) {
    const out = (entry) => entry && {
      name: entry.name, aliases: entry.aliases || [], category: entry.category || "custom", desc: entry.desc || "",
      size: entry.size, holdable: !!entry.holdable, grip: entry.grip, blueprint: entry.blueprint,
    };
    if (name) return out(this.index.get(words(name).join(" "))) || null;
    const list = words(text).slice(0, 60);
    for (let len = Math.min(8, list.length); len >= 1; len--) {
      for (let i = 0; i + len <= list.length; i++) {
        const hit = this.index.get(list.slice(i, i + len).join(" "));
        if (hit) return out(hit);
      }
    }
    return null;
  }

  // True when a parts/file path starts with this bin's capability segment (no room key needed).
  hasCap(rawRest) {
    return String(rawRest || "").split("/")[0] === this.cap;
  }

  // "<cap>/<dir index>/<path>" (or "<dir index>/<path>" when the caller is authenticated).
  // Returns { file, stat, type } or null. Never resolves outside the parts folders.
  async resolveFile(rawRest) {
    const segments = safeSegments(rawRest);
    if (!segments || segments.length < 2) return null;
    if (segments[0] === this.cap) segments.shift();
    if (!/^\d{1,3}$/.test(segments[0])) return null;
    const dir = this.dirs[Number(segments[0])];
    const rest = segments.slice(1);
    if (!dir || !rest.length) return null;
    const ext = path.extname(rest[rest.length - 1]).slice(1).toLowerCase();
    if (!FILE_TYPES.has(ext)) return null;
    const target = path.resolve(dir, ...rest);
    const inside = (root, p) => {
      const rel = path.relative(root, p);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    };
    if (!inside(dir, target)) return null;
    try {
      const [realDir, real] = await Promise.all([fsp.realpath(dir), fsp.realpath(target)]);
      if (!inside(realDir, real)) return null;
      const stat = await fsp.stat(real);
      if (!stat.isFile()) return null;
      return { file: real, stat, type: mimeOf(real) };
    } catch {
      return null;
    }
  }

  // Saves a blueprint to <primary>/generated/<slug>.json without overwriting. Returns { name, file, existing }.
  async save(input) {
    const normalized = normalizeBp(input);
    if (!normalized.ok) return { error: normalized.error };
    const bp = { ...normalized.blueprint };
    let name = String(bp.name || "").trim().toLowerCase().slice(0, 48) || "custom part";
    const existing = this.entries.find((e) => e.name === name);
    if (existing?.kind === "blueprint" && JSON.stringify(existing.blueprint.parts) === JSON.stringify(bp.parts)) {
      return { name, file: null, existing: true };
    }
    if (existing) {
      // "robot 2" taken while "robot" exists → "robot 3", not "robot 2 2".
      const taken = (n) => this.entries.some((e) => e.name === n);
      const numbered = name.match(/^(.*) (\d+)$/);
      const base = numbered && taken(numbered[1]) ? numbered[1] : name;
      let n = 2;
      while (taken(`${base} ${n}`)) n++;
      name = `${base} ${n}`;
    }
    bp.name = name;
    const folder = path.join(this.primary, "generated");
    await fsp.mkdir(folder, { recursive: true });
    const base = slug(name);
    const body = JSON.stringify(bp, null, 2) + "\n";
    for (let n = 1; n < 1000; n++) {
      const file = path.join(folder, n === 1 ? `${base}.json` : `${base}-${n}.json`);
      try {
        await fsp.writeFile(file, body, { flag: "wx" });
        await this.scan();
        return { name, file, existing: false };
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
    }
    throw new Error("too many saved designs with this name");
  }
}
