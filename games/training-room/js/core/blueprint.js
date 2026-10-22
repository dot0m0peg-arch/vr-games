// Sanitizes model-made or parts-bin blueprints (primitive lists, see ARCHITECTURE.md "Blueprint").
// Accepts loose model output and returns a clamped, re-centered blueprint with its size.
import { matchColor } from "./lexicon.js";

export const SHAPES = ["box", "sphere", "cylinder", "cone", "capsule", "torus"];
export const MATS = ["matte", "wood", "metal", "glass", "glow", "stone", "fabric", "plastic"];
export const MAX_PARTS = 96;

const SHAPE_ALIASES = {
  box: "box", cube: "box", cuboid: "box", block: "box", rect: "box", rectangle: "box", brick: "box", plane: "box", slab: "box",
  sphere: "sphere", ball: "sphere", orb: "sphere", globe: "sphere", ellipsoid: "sphere", dome: "sphere",
  cylinder: "cylinder", cyl: "cylinder", tube: "cylinder", pipe: "cylinder", rod: "cylinder", pole: "cylinder", disc: "cylinder", disk: "cylinder", column: "cylinder",
  cone: "cone", pyramid: "cone", spike: "cone",
  capsule: "capsule", pill: "capsule",
  torus: "torus", ring: "torus", donut: "torus", doughnut: "torus",
};
const MAT_ALIASES = {
  matte: "matte", default: "matte", standard: "matte", paint: "matte", painted: "matte",
  wood: "wood", wooden: "wood", timber: "wood",
  metal: "metal", metallic: "metal", steel: "metal", iron: "metal", chrome: "metal", gold: "metal", silver: "metal",
  glass: "glass", transparent: "glass", crystal: "glass", ice: "glass", water: "glass",
  glow: "glow", glowing: "glow", emissive: "glow", light: "glow", neon: "glow", fire: "glow",
  stone: "stone", rock: "stone", concrete: "stone", marble: "stone", brick: "stone",
  fabric: "fabric", cloth: "fabric", leather: "fabric", cotton: "fabric",
  plastic: "plastic", rubber: "plastic", shiny: "plastic", glossy: "plastic",
};

const round = (n, k = 1000) => Math.round(n * k) / k;
const wrapDeg = (n) => {
  const d = ((n % 360) + 360) % 360;
  return d > 180 ? d - 360 : d;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim().replace(/(m|cm|deg|°)$/i, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// [x,y,z] | {x,y,z} | "1, 2, 3" | number (uniform when allowed) → [x,y,z] or null.
function vec3(v, { uniform = false } = {}) {
  if (v === undefined || v === null) return null;
  if (uniform) {
    const n = num(v);
    if (n !== null) return [n, n, n];
  }
  let arr = null;
  if (Array.isArray(v)) arr = v;
  else if (typeof v === "string") arr = v.split(/[\s,;]+/).filter(Boolean);
  else if (typeof v === "object") {
    if ("x" in v || "y" in v || "z" in v) arr = [v.x ?? 0, v.y ?? 0, v.z ?? 0];
    else if ("w" in v || "h" in v || "d" in v) arr = [v.w ?? 0, v.h ?? 0, v.d ?? 0];
    else if ("width" in v || "height" in v || "depth" in v) arr = [v.width ?? 0, v.height ?? 0, v.depth ?? 0];
  }
  if (!arr || arr.length < 3) {
    if (arr && arr.length === 1 && uniform) {
      const n = num(arr[0]);
      return n === null ? null : [n, n, n];
    }
    return null;
  }
  const out = arr.slice(0, 3).map(num);
  return out.every((n) => n !== null) ? out : null;
}

function pick(obj, keys) {
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  return undefined;
}

function cleanText(v, max) {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// Lowercase catalog-style name: letters, digits, spaces, apostrophes, hyphens.
export function blueprintName(v) {
  const name = String(v ?? "").toLowerCase().replace(/[^\p{L}\p{N} '-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  return name.replace(/^[^\p{L}\p{N}]+/u, "");
}

export function slug(v) {
  return blueprintName(v).replace(/['\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "thing";
}

function color(v) {
  if (v === undefined || v === null || v === "") return null;
  return matchColor(String(v)) || null;
}

function normalizePart(raw) {
  if (!raw || typeof raw !== "object") return null;
  const shapeName = String(pick(raw, ["shape", "type", "kind", "primitive", "geometry"]) ?? "box").toLowerCase().trim();
  const shape = SHAPE_ALIASES[shapeName] || (SHAPES.includes(shapeName) ? shapeName : null);
  if (!shape) return null;
  const p = vec3(pick(raw, ["p", "position", "pos", "center", "centre", "at", "offset"])) || [0, 0, 0];
  let s = vec3(pick(raw, ["s", "size", "scale", "dims", "dimensions", "extent", "extents"]), { uniform: true });
  if (!s) {
    const radius = num(pick(raw, ["radius", "r_"]));
    const height = num(pick(raw, ["height", "h"]));
    if (radius !== null) s = [radius * 2, height ?? radius * 2, radius * 2];
  }
  if (!s) s = [0.5, 0.5, 0.5];
  const r = vec3(pick(raw, ["r", "rotation", "rot", "angles", "euler"])) || [0, 0, 0];
  const matName = String(pick(raw, ["mat", "material", "finish", "surface"]) ?? "matte").toLowerCase().trim();
  const part = {
    shape,
    p: p.map((n) => round(clamp(n, -100, 100))),
    s: s.map((n) => round(clamp(Math.abs(n), 0.01, 60))),
    r: r.map((n) => round(wrapDeg(n), 100)),
    color: color(pick(raw, ["color", "colour", "c", "hex", "fill"])) || "#a7b0a4",
    mat: MAT_ALIASES[matName] || (MATS.includes(matName) ? matName : "matte"),
  };
  return part;
}

// Rotates v by Euler XYZ degrees (three.js order "XYZ": R = Rx · Ry · Rz).
function rotate([x, y, z], [rx, ry, rz]) {
  const a = (rx * Math.PI) / 180;
  const b = (ry * Math.PI) / 180;
  const c = (rz * Math.PI) / 180;
  // Rz
  let x1 = x * Math.cos(c) - y * Math.sin(c);
  let y1 = x * Math.sin(c) + y * Math.cos(c);
  let z1 = z;
  // Ry
  const x2 = x1 * Math.cos(b) + z1 * Math.sin(b);
  const z2 = -x1 * Math.sin(b) + z1 * Math.cos(b);
  x1 = x2;
  z1 = z2;
  // Rx
  const y3 = y1 * Math.cos(a) - z1 * Math.sin(a);
  const z3 = y1 * Math.sin(a) + z1 * Math.cos(a);
  return [x1, y3, z3];
}

// Conservative world bounds of one primitive: its bounding box corners, rotated.
function partBounds(part, min, max) {
  const [hx, hy, hz] = part.s.map((n) => n / 2);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const c = rotate([sx * hx, sy * hy, sz * hz], part.r);
    for (let i = 0; i < 3; i++) {
      const v = c[i] + part.p[i];
      if (v < min[i]) min[i] = v;
      if (v > max[i]) max[i] = v;
    }
  }
}

export function normalizeBlueprint(bp) {
  let input = bp;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return { ok: false, blueprint: null, error: "blueprint is not valid JSON" };
    }
  }
  if (Array.isArray(input)) input = { parts: input };
  if (!input || typeof input !== "object") return { ok: false, blueprint: null, error: "blueprint must be an object" };
  const rawParts = pick(input, ["parts", "primitives", "shapes", "children", "pieces", "meshes"]);
  if (!Array.isArray(rawParts) || !rawParts.length) return { ok: false, blueprint: null, error: "blueprint has no parts" };
  const parts = [];
  for (const raw of rawParts) {
    if (parts.length >= MAX_PARTS) break;
    const part = normalizePart(raw);
    if (part) parts.push(part);
  }
  if (!parts.length) return { ok: false, blueprint: null, error: "blueprint has no valid parts" };

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) partBounds(part, min, max);
  const shift = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
  for (const part of parts) part.p = part.p.map((n, i) => round(n + shift[i]));
  const size = [0, 1, 2].map((i) => round(Math.max(0.01, max[i] - min[i])));

  const name = blueprintName(pick(input, ["name", "title", "label", "id"])) || "custom part";
  const aliases = [...new Set((Array.isArray(input.aliases) ? input.aliases : [])
    .map(blueprintName).filter((a) => a && a !== name))].slice(0, 8);
  const holdable = !!input.holdable && Math.max(...size) <= 2;
  let grip = { p: [0, round(size[1] / 2), 0], r: [0, 0, 0] };
  if (input.grip && typeof input.grip === "object") {
    const gp = vec3(input.grip.p ?? input.grip.position);
    const gr = vec3(input.grip.r ?? input.grip.rotation);
    if (gp) grip = { p: gp.map((n, i) => round(clamp(n + shift[i], -10, 10))), r: grip.r };
    if (gr) grip.r = gr.map((n) => round(wrapDeg(n), 100));
  }
  const blueprint = {
    name,
    aliases,
    desc: cleanText(pick(input, ["desc", "description", "summary"]), 160),
    holdable,
    grip,
    size,
    parts,
  };
  return { ok: true, blueprint, error: null };
}
