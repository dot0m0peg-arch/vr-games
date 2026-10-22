// Builds model/laptop blueprints (primitive lists) into meshes. See ARCHITECTURE.md "Blueprint".
// Rendering only: input is validated defensively but never re-centered (js/core/blueprint.js
// normalizes). Geometries are cached unit shapes scaled to each part's bounding size.
import { kit } from "./kit.js";

const { THREE, box, sphere, cyl, cone, capsule, torus, group, mat, finish } = kit;

const MAX_PARTS = 96;
const MIN_SIZE = 0.005;
const MAX_SIZE = 100;
const MAX_POS = 1000;
const FALLBACK_COLOR = "#cccccc";

const SHAPE_ALIASES = {
  box: "box", cube: "box", block: "box",
  sphere: "sphere", ball: "sphere",
  cylinder: "cylinder", cyl: "cylinder", tube: "cylinder",
  cone: "cone",
  capsule: "capsule", pill: "capsule",
  torus: "torus", ring: "torus", donut: "torus",
};
const MATS = new Set(["matte", "plastic", "wood", "stone", "fabric", "metal", "gold", "glass", "glow", "leaf"]);
const NAMES = THREE.Color.NAMES || {};
const scratchColor = new THREE.Color();

const finite = (n) => typeof n === "number" && Number.isFinite(n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const quantize = (n, step) => Math.round(n / step) * step;

// "#rrggbb" | "#rgb" | CSS name ("light blue" ok) | 0xrrggbb → "#rrggbb", or null when unknown.
export function toHex(color) {
  if (finite(color) && color >= 0 && color <= 0xffffff) return "#" + scratchColor.setHex(color).getHexString();
  if (typeof color !== "string") return null;
  const text = color.trim().toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(text)) {
    if (text.length === 7) return text;
    return "#" + text.slice(1).split("").map((c) => c + c).join("");
  }
  const name = text.replace(/[\s_-]+/g, "");
  if (Object.prototype.hasOwnProperty.call(NAMES, name)) return "#" + scratchColor.setHex(NAMES[name]).getHexString();
  return null;
}

function vec3(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const v = [Number(value[0]), Number(value[1]), Number(value[2])];
  return v.every(finite) ? v : null;
}

function sizeOf(value) {
  if (finite(value) && value > 0) value = [value, value, value];
  const v = vec3(value);
  if (!v || v.some((n) => n <= 0)) return null;
  return v.map((n) => clamp(n, MIN_SIZE, MAX_SIZE));
}

// Returns a clean part { shape, p, s, r, color, mat } or null when unusable.
function cleanPart(part) {
  if (!part || typeof part !== "object") return null;
  const shape = SHAPE_ALIASES[String(part.shape || "").trim().toLowerCase()];
  if (!shape) return null;
  const p = vec3(part.p);
  const s = sizeOf(part.s);
  if (!p || !s || p.some((n) => Math.abs(n) > MAX_POS)) return null;
  const r = vec3(part.r) || [0, 0, 0];
  const kind = String(part.mat || "").trim().toLowerCase();
  return { shape, p, s, r: r.map((n) => n % 360), color: toHex(part.color) || FALLBACK_COLOR, mat: MATS.has(kind) ? kind : "matte" };
}

// The tinted color: most parts, ties broken by total volume, then by first appearance.
function primaryColor(parts) {
  const stats = new Map();
  for (const part of parts) {
    const entry = stats.get(part.color) || { count: 0, volume: 0 };
    entry.count += 1;
    entry.volume += part.s[0] * part.s[1] * part.s[2];
    stats.set(part.color, entry);
  }
  let best = null;
  for (const [color, entry] of stats) {
    if (!best || entry.count > best.count || (entry.count === best.count && entry.volume > best.volume)) best = { color, ...entry };
  }
  return best?.color;
}

function makeMesh(part, material) {
  const { shape, p, r, s } = part;
  const o = { p, r };
  if (shape === "box") return box([1, 1, 1], material, { ...o, s });
  if (shape === "sphere") return sphere(0.5, material, { ...o, s, seg: 16 });
  if (shape === "cylinder") return cyl([0.5, 0.5, 1], material, { ...o, s, seg: 16 });
  if (shape === "cone") return cone([0.5, 1], material, { ...o, s, seg: 16 });
  if (shape === "capsule") {
    // Unit capsule (radius 0.5) whose straight length keeps the end caps round, then fitted to s.
    const width = (s[0] + s[2]) / 2;
    const length = clamp(quantize(s[1] / width - 1, 0.25), 0, 8);
    return capsule([0.5, length], material, { ...o, s: [s[0], s[1] / (1 + length), s[2]] });
  }
  // Torus: outer diameter 1 in the XY plane, laid into XZ by the inner mesh; the wrapper scales it.
  const width = Math.min(s[0], s[2]);
  const tube = clamp(quantize(s[1] / width / 2, 0.025), 0.025, 0.45);
  const ring = torus([0.5 - tube, tube], material, { r: [90, 0, 0], seg: 24 });
  return group([ring], { ...o, s: [s[0], s[1] / (2 * tube), s[2]] });
}

// bp: { name, parts: [...] }. opts.color recolors the primary color. Returns a Group or null.
export function buildBlueprint(bp, opts = {}) {
  try {
    if (!bp || typeof bp !== "object" || !Array.isArray(bp.parts)) return null;
    const parts = [];
    for (const raw of bp.parts) {
      const part = cleanPart(raw);
      if (part) parts.push(part);
      if (parts.length >= MAX_PARTS) break;
    }
    if (!parts.length) return null;
    const primary = primaryColor(parts);
    const tintHex = toHex(opts?.color);
    const root = group();
    for (const part of parts) {
      const tinted = part.color === primary;
      const mesh = makeMesh(part, mat(tinted && tintHex ? tintHex : part.color, part.mat));
      if (tinted) {
        mesh.userData.tint = true;
        mesh.traverse((child) => { if (child.isMesh) child.userData.tint = true; });
      }
      root.add(mesh);
    }
    const name = typeof bp.name === "string" && bp.name.trim() ? bp.name.trim().toLowerCase().slice(0, 60) : "custom";
    root.userData.parts = parts.length;
    return finish(root, name);
  } catch (err) {
    console.error("[parts] blueprint build failed", err);
    return null;
  }
}
