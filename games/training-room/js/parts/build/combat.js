// combat parts: builders keyed by meta name (see ARCHITECTURE.md).
// Weapons are built upright: handle along +Y, striking end on top, edges/faces toward +X and the
// flat side toward +Z so they read from the front. Origin = bottom-center; props face +Z.
import { kit } from "./kit.js";
import { metas } from "../meta/combat.js";

const { THREE, box, cyl, sphere, cone, torus, capsule, lathe, extrude, group, mat, finish, DEG } = kit;

const COLORS = Object.fromEntries(metas.map((m) => [m.name, m.color]));
// Primary (tinted) material: record color, else the catalog color.
const tint = (opts, name, kind) => mat(opts?.color || COLORS[name] || "#888888", kind);

// Shared palette. The "metal" kind only shines with an environment map, so polished "plastic" in
// light/dark grays stands in for steel and iron (reads well under plain sun + sky light).
const WOOD = mat("#8f5f36", "wood");
const WOOD_LIGHT = mat("#c69a62", "wood");
const WOOD_DARK = mat("#5a3a20", "wood");
const STEEL = mat("#c9cec8", "plastic");
const STEEL_EDGE = mat("#f2f4ef", "plastic");
const IRON = mat("#55595c", "plastic");
const DARK = mat("#2a2c2e", "plastic");
const BRASS = mat("#c9a04a", "plastic");
const LEATHER = mat("#4a2e1c", "fabric");
const ROPE = mat("#c9b081", "fabric");
const STRAW = mat("#d9b866", "fabric");
const THREAD = mat("#2b241c", "fabric");
const WHITE = mat("#f1efe8", "plastic");
const BLACK = mat("#1d1f20", "plastic");
const RED = mat("#c8202f", "plastic");
const BLUE = mat("#2a64b0", "plastic");
const GOLD = mat("#f2c230", "plastic");
const LIME = mat("#d5fb6a", "plastic");
const LIME_GLOW = mat("#d5fb6a", "glow");
const STONE = mat("#8d918c", "stone");

// ---------------------------------------------------------------- helpers
const UP = new THREE.Vector3(0, 1, 0);
const tmpDir = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const r4 = (n) => Math.round(n * 10000) / 10000;

// Center, length and Euler (degrees) for a Y-axis primitive spanning a → b.
function span(a, b) {
  tmpDir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const length = tmpDir.length();
  tmpQ.setFromUnitVectors(UP, tmpDir.normalize());
  tmpE.setFromQuaternion(tmpQ);
  return { length, p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], r: [tmpE.x / DEG, tmpE.y / DEG, tmpE.z / DEG] };
}
function rod(a, b, radius, material, o = {}) {
  const s = span(a, b);
  return cyl([radius, radius, s.length], material, { seg: 8, ...o, p: s.p, r: s.r });
}
function beam(a, b, [w, d], material, o = {}) {
  const s = span(a, b);
  return box([w, s.length, d], material, { ...o, p: s.p, r: s.r });
}
// Cone whose base sits at `from` and apex points along unit `dir`.
function spike(from, dir, radius, length, material, o = {}) {
  const tip = [from[0] + dir[0] * length, from[1] + dir[1] * length, from[2] + dir[2] * length];
  const s = span(from, tip);
  return cone([radius, length], material, { seg: 6, ...o, p: s.p, r: s.r });
}
// Thin open band hugging a lathe surface from (r0, y0) to (r1, y1).
function band(r0, y0, r1, y1, material, o = {}) {
  return lathe([[r0, y0], [r1, y1]], material, { seg: 16, ...o });
}
// Nested builder output used as decoration: its tint flags must not follow the parent's color.
function untinted(object) {
  object.traverse((child) => { delete child.userData.tint; });
  return object;
}
// Points of an arc around (cx, cy) from angle a0 to a1 (degrees).
function arc(cx, cy, radius, a0, a1, steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = (a0 + ((a1 - a0) * i) / steps) * DEG;
    out.push([r4(cx + radius * Math.cos(a)), r4(cy + radius * Math.sin(a))]);
  }
  return out;
}
// Disc facing +Z (cylinder axis turned to Z).
function disc(radius, thickness, material, o = {}) {
  return cyl([radius, radius, thickness], material, { seg: 24, ...o, r: [90, 0, 0] });
}
// Torus in the XZ plane (a hoop around a vertical axis).
function hoop(radius, tube, material, o = {}) {
  return torus([radius, tube], material, { seg: 20, ...o, r: [90, 0, 0] });
}
// Small seeded jitter so stacked props are not perfectly regular (same on every client).
function jitter(seed) {
  let a = (seed >>> 0) || 1;
  return (amount) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1) * amount;
  };
}

// ---------------------------------------------------------------- outlines (built once)
const AXE_BODY = [[0.02, 0.632], [0.045, 0.625], [0.075, 0.61], [0.1, 0.592], [0.13, 0.575], [0.13, 0.738], [0.09, 0.725], [0.05, 0.712], [0.02, 0.706]];
const AXE_EDGE = [[0.127, 0.576], [0.15, 0.565], [0.162, 0.59], [0.169, 0.625], [0.171, 0.66], [0.168, 0.7], [0.16, 0.745], [0.127, 0.738]];

// Battle axe crescent around (0.07, 0.93): body to r 0.165, bright edge band 0.158..0.19.
const BAXE_BODY = [[0.025, 0.875], [0.09, 0.86], [0.14, 0.83], ...arc(0.07, 0.93, 0.165, -50, 50, 8), [0.14, 1.03], [0.09, 1.0], [0.025, 0.985]];
const BAXE_EDGE = [...arc(0.07, 0.93, 0.19, -50, 50, 8), ...arc(0.07, 0.93, 0.158, 50, -50, 8)];

const SWORD_BLADE = [[-0.026, 0.25], [0.026, 0.25], [0.021, 0.92], [0, 1.05], [-0.021, 0.92]];
const DAGGER_BLADE = [[-0.017, 0.134], [0.017, 0.134], [0.015, 0.25], [0.009, 0.31], [0, 0.35], [-0.009, 0.31], [-0.015, 0.25]];
const WOOD_BLADE = [[-0.024, 0.24], [0.024, 0.24], [0.022, 0.86], [0.012, 0.93], [0, 0.95], [-0.012, 0.93], [-0.022, 0.86]];
const SPEAR_HEAD = [[0, 1.8], [0.022, 1.84], [0.032, 1.875], [0.028, 1.91], [0.014, 1.96], [0, 2.0], [-0.014, 1.96], [-0.028, 1.91], [-0.032, 1.875], [-0.022, 1.84]];
const BROADHEAD = [[0, 0.735], [0.012, 0.752], [0.009, 0.772], [0, 0.8], [-0.009, 0.772], [-0.012, 0.752]];
const VANE = [[0, 0], [0.02, 0.025], [0.02, 0.1], [0, 0.125]];
const HALBERD_BLADE = [[0.012, 1.66], [0.012, 1.83], [0.07, 1.815], [0.13, 1.86], [0.155, 1.79], [0.15, 1.71], [0.13, 1.62], [0.07, 1.66]];
const HALBERD_HOOK = [[-0.012, 1.75], [-0.012, 1.81], [-0.06, 1.8], [-0.12, 1.84], [-0.085, 1.78], [-0.05, 1.765]];
const HALBERD_SPIKE = [[0, 1.8], [0.018, 1.84], [0.01, 1.92], [0, 2.0], [-0.01, 1.92], [-0.018, 1.84]];

// Katana: blade curves back toward the spine (-X) with the edge on +X; wavy hamon along the edge.
const KATANA = (() => {
  const y0 = 0.3;
  const y1 = 0.955;
  const tipY = 1.02;
  const center = (y) => -0.03 * ((y - y0) / (tipY - y0)) ** 2;
  const width = (y) => 0.031 - 0.007 * ((y - y0) / (y1 - y0));
  const edge = [];
  const spine = [];
  const hamon = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n;
    edge.push([r4(center(y) + width(y) / 2), r4(y)]);
    spine.push([r4(center(y) - width(y) / 2), r4(y)]);
    hamon.push([r4(center(y) + width(y) / 2 - 0.007 - 0.0022 * Math.sin(i * 1.7)), r4(y)]);
  }
  const tip = [r4(center(tipY) - 0.011), tipY];
  const kissaki = [[r4(center(0.99) + 0.009), 0.99], [r4(center(1.008) + 0.002), 1.008]];
  const blade = [...edge, ...kissaki, tip, ...spine.reverse()];
  const temper = [...edge, ...kissaki, tip, [r4(center(0.985) - 0.002), 0.985], ...hamon.reverse()];
  return { blade, temper, tip };
})();

// Longbow stave: parabolic arc bulging to +X, thick at the riser and thin at the tips.
const BOW = (() => {
  const half = 0.74;
  const sag = 0.12;
  const outer = [];
  const inner = [];
  const n = 16;
  for (let i = 0; i <= n; i++) {
    const y = -half + (2 * half * i) / n;
    const k = (y / half) ** 2;
    const x = sag * (1 - k);
    const t = 0.034 - 0.022 * Math.sqrt(k);
    outer.push([r4(x + t / 2), r4(y + 0.75)]);
    inner.push([r4(x - t / 2), r4(y + 0.75)]);
  }
  return [...outer, ...inner.reverse()];
})();

// Crossbow prod: horizontal crescent, tips swept back (outline y becomes world -Z after r [-90,0,0]).
const PROD = (() => {
  const half = 0.31;
  const front = [];
  const back = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const x = -half + (2 * half * i) / n;
    const k = (x / half) ** 2;
    const y = 0.075 * k;
    const t = 0.028 - 0.014 * Math.sqrt(k);
    front.push([r4(x), r4(y - t / 2)]);
    back.push([r4(x), r4(y + t / 2)]);
  }
  return [...front, ...back.reverse()];
})();

// ---------------------------------------------------------------- hand weapons
function axe(opts) {
  const head = tint(opts, "axe", "plastic");
  return finish(group([
    lathe([[0, 0], [0.024, 0], [0.026, 0.016], [0.02, 0.045], [0.0172, 0.25], [0.0165, 0.5], [0.0185, 0.69], [0.016, 0.722], [0, 0.722]], WOOD, { seg: 10 }),
    cyl([0.0205, 0.0205, 0.16], LEATHER, { p: [0, 0.18, 0], seg: 10 }),
    box([0.105, 0.074, 0.042], head, { p: [-0.0275, 0.669, 0], tint: true }),
    extrude(AXE_BODY, 0.028, head, { tint: true }),
    extrude(AXE_EDGE, 0.012, STEEL_EDGE),
  ]), "axe");
}

function battleAxe(opts) {
  const head = tint(opts, "battle axe", "plastic");
  const parts = [
    cyl([0.016, 0.022, 0.045], IRON, { p: [0, 0.0225, 0], seg: 10 }),
    lathe([[0, 0.04], [0.019, 0.04], [0.018, 0.4], [0.0185, 0.85], [0.017, 1.0], [0, 1.0]], WOOD_DARK, { seg: 10 }),
    cyl([0.0205, 0.0205, 0.3], LEATHER, { p: [0, 0.3, 0], seg: 10 }),
    cyl([0.03, 0.03, 0.17], IRON, { p: [0, 0.93, 0], seg: 12 }),
    cone([0.02, 0.13], STEEL, { p: [0, 1.08, 0], seg: 8 }),
  ];
  for (const ry of [0, 180]) {
    parts.push(extrude(BAXE_BODY, 0.014, head, { r: [0, ry, 0], tint: true }));
    parts.push(extrude(BAXE_EDGE, 0.007, STEEL_EDGE, { r: [0, ry, 0] }));
  }
  return finish(group(parts), "battle axe");
}

function sword(opts) {
  return finish(group([
    cyl([0.03, 0.03, 0.022], BRASS, { p: [0, 0.03, 0], r: [90, 0, 0], seg: 14 }),
    cyl([0.016, 0.017, 0.17], LEATHER, { p: [0, 0.14, 0], seg: 10 }),
    cyl([0.019, 0.019, 0.012], BRASS, { p: [0, 0.058, 0], seg: 10 }),
    cyl([0.019, 0.019, 0.012], BRASS, { p: [0, 0.222, 0], seg: 10 }),
    box([0.24, 0.026, 0.03], BRASS, { p: [0, 0.24, 0] }),
    sphere(0.02, BRASS, { p: [-0.12, 0.24, 0], seg: 8 }),
    sphere(0.02, BRASS, { p: [0.12, 0.24, 0], seg: 8 }),
    box([0.062, 0.026, 0.014], BRASS, { p: [0, 0.262, 0] }),
    extrude(SWORD_BLADE, 0.007, tint(opts, "sword", "plastic"), { tint: true }),
    box([0.009, 0.56, 0.0078], IRON, { p: [0, 0.57, 0] }),
  ]), "sword");
}

function katana(opts) {
  const parts = [
    cyl([0.017, 0.017, 0.014], IRON, { p: [0, 0.007, 0], seg: 10 }),
    cyl([0.0155, 0.017, 0.26], BLACK, { p: [0, 0.144, 0], seg: 10 }),
    cyl([0.042, 0.042, 0.008], DARK, { p: [0, 0.278, 0], seg: 12, s: [1, 1, 0.8] }),
    box([0.034, 0.024, 0.012], BRASS, { p: [0, 0.294, 0] }),
    extrude(KATANA.blade, 0.0065, tint(opts, "katana", "plastic"), { tint: true }),
    extrude(KATANA.temper, 0.0069, STEEL_EDGE),
  ];
  // Rayskin diamonds showing through the black wrap, front and back.
  for (let i = 0; i < 4; i++) {
    for (const z of [0.0155, -0.0155]) parts.push(box([0.011, 0.011, 0.004], WHITE, { p: [0, 0.05 + i * 0.058, z], r: [0, 0, 45] }));
  }
  return finish(group(parts), "katana");
}

function dagger(opts) {
  return finish(group([
    sphere(0.016, BRASS, { p: [0, 0.016, 0], seg: 10 }),
    cyl([0.012, 0.013, 0.095], LEATHER, { p: [0, 0.078, 0], seg: 10 }),
    box([0.09, 0.016, 0.018], BRASS, { p: [0, 0.128, 0] }),
    extrude(DAGGER_BLADE, 0.0055, tint(opts, "dagger", "plastic"), { tint: true }),
    box([0.004, 0.13, 0.0062], IRON, { p: [0, 0.205, 0] }),
  ]), "dagger");
}

function spear(opts) {
  return finish(group([
    cyl([0.017, 0.011, 0.06], IRON, { p: [0, 0.03, 0], seg: 10 }),
    cyl([0.0155, 0.017, 1.69], WOOD, { p: [0, 0.905, 0], seg: 10 }),
    cyl([0.0185, 0.0185, 0.2], LEATHER, { p: [0, 0.75, 0], seg: 10 }),
    cyl([0.018, 0.032, 0.09], RED, { p: [0, 1.69, 0], seg: 10 }),
    cyl([0.0195, 0.0195, 0.04], ROPE, { p: [0, 1.745, 0], seg: 10 }),
    cyl([0.011, 0.018, 0.06], IRON, { p: [0, 1.79, 0], seg: 10 }),
    extrude(SPEAR_HEAD, 0.008, tint(opts, "spear", "plastic"), { tint: true }),
    cyl([0.002, 0.0065, 0.17], STEEL, { p: [0, 1.895, 0], seg: 6 }),
  ]), "spear");
}

function warHammer(opts) {
  const head = tint(opts, "war hammer", "plastic");
  return finish(group([
    lathe([[0, 0], [0.022, 0], [0.024, 0.02], [0.02, 0.05], [0.018, 0.5], [0.02, 0.85], [0.021, 0.9], [0, 0.9]], WOOD_DARK, { seg: 10 }),
    cyl([0.0215, 0.0215, 0.26], LEATHER, { p: [0, 0.25, 0], seg: 10 }),
    box([0.008, 0.16, 0.046], IRON, { p: [0, 0.78, 0] }),
    cyl([0.055, 0.055, 0.2], head, { p: [0, 0.9, 0], r: [0, 0, 90], seg: 8, tint: true }),
    cyl([0.062, 0.062, 0.025], IRON, { p: [-0.1125, 0.9, 0], r: [0, 0, 90], seg: 8 }),
    cyl([0.062, 0.062, 0.025], IRON, { p: [0.1125, 0.9, 0], r: [0, 0, 90], seg: 8 }),
    cyl([0.058, 0.058, 0.012], IRON, { p: [-0.035, 0.9, 0], r: [0, 0, 90], seg: 8 }),
    cyl([0.058, 0.058, 0.012], IRON, { p: [0.035, 0.9, 0], r: [0, 0, 90], seg: 8 }),
  ]), "war hammer");
}

const MACE_DIRS = (() => {
  const dirs = [[0, 1, 0]];
  const ring = (lat, count, offset) => {
    for (let i = 0; i < count; i++) {
      const a = (offset + (360 * i) / count) * DEG;
      const c = Math.cos(lat * DEG);
      dirs.push([c * Math.cos(a), Math.sin(lat * DEG), c * Math.sin(a)]);
    }
  };
  ring(0, 6, 0);
  ring(50, 3, 30);
  ring(-45, 3, 30);
  return dirs;
})();

function mace(opts) {
  const head = tint(opts, "mace", "plastic");
  const c = [0, 0.585, 0];
  const parts = [
    sphere(0.022, IRON, { p: [0, 0.022, 0], seg: 10 }),
    cyl([0.015, 0.015, 0.46], WOOD_DARK, { p: [0, 0.26, 0], seg: 10 }),
    cyl([0.0185, 0.0185, 0.18], LEATHER, { p: [0, 0.13, 0], seg: 10 }),
    cyl([0.024, 0.018, 0.06], IRON, { p: [0, 0.5, 0], seg: 10 }),
    sphere(0.062, head, { p: c, seg: 12, tint: true }),
  ];
  for (const d of MACE_DIRS) parts.push(spike([c[0] + d[0] * 0.052, c[1] + d[1] * 0.052, c[2] + d[2] * 0.052], d, 0.017, 0.048, STEEL));
  return finish(group(parts), "mace");
}

function staff(opts) {
  const wood = tint(opts, "staff", "wood");
  return finish(group([
    lathe([[0, 0], [0.019, 0], [0.0205, 0.03], [0.0195, 0.9], [0.0205, 1.77], [0.019, 1.8], [0, 1.8]], wood, { seg: 10, tint: true }),
    cyl([0.023, 0.023, 0.07], IRON, { p: [0, 0.036, 0], seg: 10 }),
    cyl([0.023, 0.023, 0.07], IRON, { p: [0, 1.764, 0], seg: 10 }),
    cyl([0.0225, 0.0225, 0.22], LEATHER, { p: [0, 0.65, 0], seg: 10 }),
    cyl([0.0225, 0.0225, 0.22], LEATHER, { p: [0, 1.15, 0], seg: 10 }),
  ]), "staff");
}

function baseballBat(opts) {
  return finish(group([
    cyl([0.028, 0.032, 0.022], BLACK, { p: [0, 0.011, 0], seg: 14 }),
    lathe([[0, 0.02], [0.014, 0.02], [0.0125, 0.06], [0.013, 0.22], [0.016, 0.36], [0.024, 0.5], [0.031, 0.62], [0.0335, 0.72], [0.0335, 0.8], [0.03, 0.826], [0.018, 0.838], [0, 0.84]], tint(opts, "baseball bat", "wood"), { seg: 14, tint: true }),
    cyl([0.0142, 0.0142, 0.17], BLACK, { p: [0, 0.115, 0], seg: 10 }),
    box([0.026, 0.07, 0.004], LIME, { p: [0, 0.6, 0.0305] }),
  ]), "baseball bat");
}

function woodenSword(opts) {
  return finish(group([
    cyl([0.022, 0.022, 0.03], WOOD_DARK, { p: [0, 0.015, 0], seg: 10 }),
    cyl([0.017, 0.017, 0.18], LEATHER, { p: [0, 0.12, 0], seg: 10 }),
    box([0.16, 0.03, 0.036], WOOD_DARK, { p: [0, 0.225, 0] }),
    extrude(WOOD_BLADE, 0.018, tint(opts, "wooden sword", "wood"), { tint: true }),
  ]), "wooden sword");
}

function halberd(opts) {
  const steel = tint(opts, "halberd", "plastic");
  return finish(group([
    cyl([0.016, 0.02, 0.04], IRON, { p: [0, 0.02, 0], seg: 10 }),
    cyl([0.016, 0.0175, 1.68], WOOD_DARK, { p: [0, 0.88, 0], seg: 10 }),
    cyl([0.0195, 0.0195, 0.24], LEATHER, { p: [0, 0.72, 0], seg: 10 }),
    box([0.008, 0.26, 0.04], IRON, { p: [0, 1.62, 0] }),
    cyl([0.022, 0.022, 0.2], IRON, { p: [0, 1.75, 0], seg: 10 }),
    extrude(HALBERD_BLADE, 0.01, steel, { tint: true }),
    extrude(HALBERD_HOOK, 0.012, IRON),
    extrude(HALBERD_SPIKE, 0.012, steel, { tint: true }),
  ]), "halberd");
}

function bow(opts) {
  const dx = -0.0655;
  return finish(group([
    extrude(BOW, 0.026, tint(opts, "bow", "wood"), { tint: true }),
    box([0.044, 0.15, 0.03], LEATHER, { p: [0.12, 0.75, 0] }),
    cyl([0.0016, 0.0016, 1.445], mat("#efe9d8", "fabric"), { p: [0.004, 0.75, 0], seg: 4 }),
    sphere(0.009, BLACK, { p: [0.002, 0.016, 0], seg: 8 }),
    sphere(0.009, BLACK, { p: [0.002, 1.484, 0], seg: 8 }),
  ], { p: [dx, 0, 0] }), "bow");
}

function arrow(opts) {
  const fletch = tint(opts, "arrow", "fabric");
  const parts = [
    cyl([0.006, 0.006, 0.02], BLACK, { p: [0, 0.01, 0], seg: 8 }),
    cyl([0.0045, 0.0045, 0.72], WOOD_LIGHT, { p: [0, 0.38, 0], seg: 6 }),
    cyl([0.006, 0.0045, 0.03], IRON, { p: [0, 0.73, 0], seg: 8 }),
    extrude(BROADHEAD, 0.003, STEEL),
  ];
  for (const ry of [0, 120, 240]) parts.push(extrude(VANE, 0.0015, fletch, { p: [0, 0.035, 0], r: [0, ry, 0], tint: true }));
  return finish(group(parts), "arrow");
}

function crossbow(opts) {
  const wood = tint(opts, "crossbow", "wood");
  return finish(group([
    box([0.046, 0.046, 0.74], wood, { p: [0, 0.125, 0.02], tint: true }),
    box([0.05, 0.1, 0.2], wood, { p: [0, 0.1, -0.32], tint: true }),
    box([0.04, 0.11, 0.05], wood, { p: [0, 0.06, -0.13], r: [-18, 0, 0], tint: true }),
    box([0.008, 0.04, 0.012], IRON, { p: [0, 0.085, -0.07] }),
    box([0.03, 0.02, 0.05], IRON, { p: [0, 0.155, -0.03] }),
    box([0.06, 0.05, 0.05], IRON, { p: [0, 0.13, 0.37] }),
    extrude(PROD, 0.022, WOOD_DARK, { p: [0, 0.135, 0.385], r: [-90, 0, 0] }),
    rod([-0.305, 0.14, 0.31], [0, 0.155, -0.02], 0.0016, ROPE, { seg: 4 }),
    rod([0.305, 0.14, 0.31], [0, 0.155, -0.02], 0.0016, ROPE, { seg: 4 }),
    cyl([0.004, 0.004, 0.36], WOOD_LIGHT, { p: [0, 0.155, 0.17], r: [90, 0, 0], seg: 6 }),
    cone([0.008, 0.03], STEEL, { p: [0, 0.155, 0.365], r: [90, 0, 0], seg: 6 }),
  ]), "crossbow");
}

function shield(opts) {
  const paint = tint(opts, "shield", "wood");
  const cy = 0.313;
  const parts = [
    disc(0.3, 0.025, paint, { p: [0, cy, 0], seg: 28, tint: true }),
    disc(0.205, 0.029, mat("#e9dfc8", "wood"), { p: [0, cy, 0], seg: 28 }),
    disc(0.165, 0.033, paint, { p: [0, cy, 0], seg: 28, tint: true }),
    disc(0.298, 0.004, WOOD, { p: [0, cy, -0.0165], seg: 28 }),
    torus([0.3, 0.013], IRON, { p: [0, cy, 0], seg: 28 }),
    lathe([[0.085, 0], [0.085, 0.01], [0.07, 0.03], [0.045, 0.05], [0, 0.058]], STEEL, { p: [0, cy, 0.0165], r: [90, 0, 0], seg: 16 }),
    box([0.5, 0.05, 0.012], WOOD_DARK, { p: [0, cy, -0.0185] }),
    cyl([0.014, 0.014, 0.14], LEATHER, { p: [0.1, cy, -0.055], seg: 8 }),
    box([0.022, 0.02, 0.045], IRON, { p: [0.1, cy + 0.065, -0.035] }),
    box([0.022, 0.02, 0.045], IRON, { p: [0.1, cy - 0.065, -0.035] }),
    box([0.03, 0.17, 0.008], LEATHER, { p: [-0.1, cy, -0.05] }),
    box([0.03, 0.012, 0.04], LEATHER, { p: [-0.1, cy + 0.08, -0.032] }),
    box([0.03, 0.012, 0.04], LEATHER, { p: [-0.1, cy - 0.08, -0.032] }),
  ];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    parts.push(sphere(0.008, IRON, { p: [Math.cos(a) * 0.27, cy + Math.sin(a) * 0.27, 0.0125], seg: 6 }));
  }
  return finish(group(parts), "shield");
}

// ---------------------------------------------------------------- training gear
function trainingDummy(opts) {
  const straw = tint(opts, "training dummy", "fabric");
  const face = 0.128;
  const parts = [
    cyl([0.24, 0.25, 0.08], WOOD_DARK, { p: [0, 0.04, 0], seg: 16 }),
    cyl([0.045, 0.05, 1.0], WOOD, { p: [0, 0.55, 0], seg: 10 }),
    lathe([[0, 0.94], [0.15, 0.95], [0.185, 1.02], [0.2, 1.18], [0.19, 1.34], [0.16, 1.43], [0.07, 1.47], [0, 1.475]], straw, { seg: 14, tint: true }),
    hoop(0.19, 0.012, ROPE, { p: [0, 1.04, 0], seg: 16 }),
    hoop(0.188, 0.012, ROPE, { p: [0, 1.35, 0], seg: 16 }),
    disc(0.075, 0.012, RED, { p: [0, 1.2, 0.196] }),
    disc(0.035, 0.016, WHITE, { p: [0, 1.2, 0.197] }),
    cyl([0.025, 0.025, 0.7], WOOD, { p: [0, 1.3, 0], r: [0, 0, 90], seg: 8 }),
    cyl([0.045, 0.045, 0.14], straw, { p: [-0.27, 1.3, 0], r: [0, 0, 90], seg: 10, tint: true }),
    cyl([0.045, 0.045, 0.14], straw, { p: [0.27, 1.3, 0], r: [0, 0, 90], seg: 10, tint: true }),
    cyl([0.03, 0.035, 0.07], WOOD, { p: [0, 1.49, 0], seg: 8 }),
    sphere(0.13, mat("#c2a476", "fabric"), { p: [0, 1.645, 0], s: [1, 1.05, 1], seg: 14 }),
    cone([0.045, 0.06], straw, { p: [0, 1.79, 0], seg: 8, tint: true }),
    box([0.07, 0.008, 0.004], THREAD, { p: [0, 1.6, face - 0.002] }),
  ];
  // Stitched X eyes.
  for (const x of [-0.045, 0.045]) {
    for (const rz of [45, -45]) parts.push(box([0.04, 0.007, 0.004], THREAD, { p: [x, 1.67, face - 0.008], r: [-8, 0, rz] }));
  }
  return finish(group(parts), "training dummy");
}

function archeryTarget(opts) {
  const boss = group([
    cyl([0.6, 0.6, 0.12], STRAW, { r: [90, 0, 0], seg: 32 }),
    disc(0.555, 0.004, tint(opts, "archery target", "plastic"), { p: [0, 0, 0.062], seg: 32, tint: true }),
    disc(0.445, 0.004, BLACK, { p: [0, 0, 0.064], seg: 32 }),
    disc(0.335, 0.004, BLUE, { p: [0, 0, 0.066], seg: 28 }),
    disc(0.225, 0.004, RED, { p: [0, 0, 0.068], seg: 24 }),
    disc(0.115, 0.004, GOLD, { p: [0, 0, 0.07], seg: 20 }),
  ], { p: [0, 1.0, 0.13], r: [-12, 0, 0] });
  return finish(group([
    boss,
    rod([-0.42, 0, 0.3], [-0.36, 1.42, -0.04], 0.025, WOOD),
    rod([0.42, 0, 0.3], [0.36, 1.42, -0.04], 0.025, WOOD),
    rod([0, 0, -0.36], [0, 1.44, -0.05], 0.025, WOOD),
    box([0.9, 0.04, 0.1], WOOD_DARK, { p: [0, 0.395, 0.245] }),
    box([0.8, 0.05, 0.05], WOOD_DARK, { p: [0, 1.4, -0.05] }),
  ]), "archery target");
}

function punchingBag(opts) {
  const frame = mat("#33373a", "plastic");
  const bz = 0.12;
  const parts = [
    box([0.06, 0.06, 0.8], frame, { p: [-0.28, 0.03, -0.02] }),
    box([0.06, 0.06, 0.8], frame, { p: [0.28, 0.03, -0.02] }),
    box([0.62, 0.06, 0.08], frame, { p: [0, 0.03, -0.32] }),
    box([0.08, 2.14, 0.08], frame, { p: [0, 1.13, -0.32] }),
    box([0.07, 0.07, 0.52], frame, { p: [0, 2.165, -0.08] }),
    beam([0, 1.86, -0.3], [0, 2.14, -0.03], [0.05, 0.05], frame),
    rod([0, 2.13, bz], [0, 2.02, bz], 0.008, IRON),
    sphere(0.02, IRON, { p: [0, 2.0, bz], seg: 8 }),
    lathe([[0, 0.47], [0.13, 0.474], [0.165, 0.5], [0.172, 0.55], [0.172, 1.5], [0.165, 1.55], [0.13, 1.582], [0, 1.586]], tint(opts, "punching bag", "plastic"), { p: [0, 0, bz], seg: 16, tint: true }),
    band(0.174, 0.6, 0.174, 0.64, BLACK, { p: [0, 0, bz] }),
    band(0.174, 1.41, 0.174, 1.45, BLACK, { p: [0, 0, bz] }),
    band(0.174, 0.99, 0.174, 1.07, LIME, { p: [0, 0, bz] }),
  ];
  for (const deg of [90, 210, 330]) {
    const a = deg * DEG;
    parts.push(rod([0, 1.99, bz], [Math.cos(a) * 0.115, 1.58, bz + Math.sin(a) * 0.115], 0.005, IRON, { seg: 4 }));
  }
  return finish(group(parts), "punching bag");
}

function gong(opts) {
  const bronze = tint(opts, "gong", "plastic");
  const wood = WOOD_DARK;
  return finish(group([
    rod([-0.46, 0, 0.25], [-0.43, 1.52, 0], 0.03, wood),
    rod([-0.46, 0, -0.25], [-0.43, 1.52, 0], 0.03, wood),
    rod([0.46, 0, 0.25], [0.43, 1.52, 0], 0.03, wood),
    rod([0.46, 0, -0.25], [0.43, 1.52, 0], 0.03, wood),
    cyl([0.035, 0.035, 1.0], wood, { p: [0, 1.52, 0], r: [0, 0, 90], seg: 10 }),
    box([0.84, 0.05, 0.05], wood, { p: [0, 0.35, 0] }),
    disc(0.27, 0.02, bronze, { p: [0, 0.98, 0], seg: 28, tint: true }),
    torus([0.27, 0.016], bronze, { p: [0, 0.98, 0], seg: 28, tint: true }),
    sphere(0.07, BRASS, { p: [0, 0.98, 0.006], s: [1, 1, 0.35], seg: 14 }),
    torus([0.15, 0.004], DARK, { p: [0, 0.98, 0.011], seg: 18 }),
    rod([-0.12, 1.21, 0], [-0.2, 1.5, 0], 0.006, ROPE, { seg: 4 }),
    rod([0.12, 1.21, 0], [0.2, 1.5, 0], 0.006, ROPE, { seg: 4 }),
  ]), "gong");
}

// Kettlebell bell: a sphere of radius 0.11 centered at y 0.1, flattened at the base.
const KETTLEBELL = (() => {
  const pts = [[0, 0], [0.06, 0]];
  for (let a = -55; a <= 90; a += 14.5) pts.push([r4(Math.max(0, 0.11 * Math.cos(a * DEG))), r4(0.1 + 0.11 * Math.sin(a * DEG))]);
  pts[pts.length - 1][0] = 0;
  return pts;
})();
function kettlebell(opts) {
  return finish(group([
    lathe(KETTLEBELL, tint(opts, "kettlebell", "plastic"), { seg: 16, tint: true }),
    torus([0.068, 0.014], IRON, { p: [0, 0.2, 0], seg: 20 }),
    disc(0.024, 0.006, LIME, { p: [0, 0.1, 0.108], seg: 14 }),
  ]), "kettlebell");
}

function dumbbell(opts) {
  const rubber = tint(opts, "dumbbell", "plastic");
  const y = 0.052;
  return finish(group([
    cyl([0.016, 0.016, 0.16], STEEL, { p: [0, y, 0], r: [0, 0, 90], seg: 10 }),
    cyl([0.025, 0.025, 0.02], IRON, { p: [-0.08, y, 0], r: [0, 0, 90], seg: 10 }),
    cyl([0.025, 0.025, 0.02], IRON, { p: [0.08, y, 0], r: [0, 0, 90], seg: 10 }),
    cyl([0.06, 0.06, 0.08], rubber, { p: [-0.13, y, 0], r: [0, 0, 90], seg: 6, tint: true }),
    cyl([0.06, 0.06, 0.08], rubber, { p: [0.13, y, 0], r: [0, 0, 90], seg: 6, tint: true }),
  ]), "dumbbell");
}

function cannonball(opts) {
  return finish(group([sphere(0.08, tint(opts, "cannonball", "plastic"), { p: [0, 0.08, 0], seg: 14, tint: true })]), "cannonball");
}

// ---------------------------------------------------------------- yard props
function crate(opts) {
  const boards = tint(opts, "crate", "wood");
  const frame = WOOD_DARK;
  const e = 0.415;
  const t = 0.07;
  const parts = [box([0.84, 0.84, 0.84], boards, { p: [0, 0.45, 0], tint: true })];
  for (const y of [0.035, 0.865]) {
    for (const z of [-e, e]) parts.push(box([0.9, t, t], frame, { p: [0, y, z] }));
    for (const x of [-e, e]) parts.push(box([t, t, 0.76], frame, { p: [x, y, 0] }));
  }
  for (const x of [-e, e]) for (const z of [-e, e]) parts.push(box([t, 0.76, t], frame, { p: [x, 0.45, z] }));
  for (const z of [-0.43, 0.43]) parts.push(box([0.07, 1.0, 0.02], frame, { p: [0, 0.45, z], r: [0, 0, z > 0 ? 45 : -45] }));
  for (const x of [-0.43, 0.43]) parts.push(box([0.02, 1.0, 0.07], frame, { p: [x, 0.45, 0], r: [x > 0 ? 45 : -45, 0, 0] }));
  return finish(group(parts), "crate");
}

function barrel(opts) {
  const staves = tint(opts, "barrel", "wood");
  const hoopAt = (y0, y1, r0, r1) => band(r0 + 0.004, y0, r1 + 0.004, y1, IRON, { seg: 18 });
  return finish(group([
    lathe([[0, 0.02], [0.24, 0.02], [0.24, 0], [0.255, 0], [0.285, 0.2], [0.3, 0.45], [0.285, 0.7], [0.255, 0.9], [0.24, 0.9], [0.24, 0.88], [0, 0.88]], staves, { seg: 18, tint: true }),
    hoopAt(0.05, 0.09, 0.2625, 0.268),
    hoopAt(0.22, 0.27, 0.2865, 0.29),
    hoopAt(0.63, 0.68, 0.29, 0.2865),
    hoopAt(0.81, 0.85, 0.268, 0.2625),
    cyl([0.026, 0.026, 0.02], WOOD_DARK, { p: [0, 0.45, 0.298], r: [90, 0, 0], seg: 10 }),
    box([0.46, 0.004, 0.012], WOOD_DARK, { p: [0, 0.882, 0.09] }),
    box([0.46, 0.004, 0.012], WOOD_DARK, { p: [0, 0.882, -0.09] }),
  ]), "barrel");
}

function weaponRack(opts) {
  const wood = tint(opts, "weapon rack", "wood");
  const lean = (object, x) => {
    untinted(object);
    object.position.set(x, 0.18, 0.04);
    object.rotation.x = -4 * DEG;
    return object;
  };
  const parts = [
    box([0.08, 0.06, 0.5], wood, { p: [-0.62, 0.03, 0], tint: true }),
    box([0.08, 0.06, 0.5], wood, { p: [0.62, 0.03, 0], tint: true }),
    box([0.07, 1.25, 0.07], wood, { p: [-0.62, 0.685, -0.05], tint: true }),
    box([0.07, 1.25, 0.07], wood, { p: [0.62, 0.685, -0.05], tint: true }),
    sphere(0.045, WOOD_DARK, { p: [-0.62, 1.33, -0.05], seg: 10 }),
    sphere(0.045, WOOD_DARK, { p: [0.62, 1.33, -0.05], seg: 10 }),
    box([1.17, 0.06, 0.2], WOOD_DARK, { p: [0, 0.15, 0.02] }),
    box([1.17, 0.07, 0.02], wood, { p: [0, 0.2, 0.11], tint: true }),
    box([1.17, 0.07, 0.06], wood, { p: [0, 0.98, -0.07], tint: true }),
    box([1.17, 0.03, 0.02], wood, { p: [0, 0.98, 0.06], tint: true }),
    box([1.17, 0.05, 0.05], wood, { p: [0, 0.55, -0.07], tint: true }),
    lean(sword({}), -0.48),
    lean(axe({}), -0.24),
    lean(katana({}), 0),
    lean(warHammer({}), 0.24),
    lean(woodenSword({}), 0.48),
  ];
  return finish(group(parts), "weapon rack");
}

function suitOfArmor(opts) {
  const cloth = tint(opts, "suit of armor", "fabric");
  const plate = STEEL;
  const blade = untinted(sword({}));
  blade.position.set(0, 1.17, 0.2);
  blade.rotation.z = Math.PI;
  const parts = [
    box([0.6, 0.12, 0.5], STONE, { p: [0, 0.06, 0] }),
    blade,
  ];
  for (const s of [-1, 1]) {
    const x = s * 0.1;
    parts.push(
      box([0.09, 0.05, 0.2], plate, { p: [x, 0.145, 0.03] }),
      cyl([0.055, 0.048, 0.4], plate, { p: [x, 0.36, 0], seg: 12 }),
      sphere(0.06, plate, { p: [x, 0.575, 0.012], seg: 10 }),
      cyl([0.072, 0.06, 0.3], plate, { p: [x, 0.76, 0], seg: 12 }),
      sphere(0.09, plate, { p: [s * 0.22, 1.4, 0], s: [1.1, 0.8, 1], seg: 12 }),
      cyl([0.045, 0.045, 0.26], plate, { p: [s * 0.25, 1.24, 0], seg: 10 }),
      rod([s * 0.25, 1.1, 0], [s * 0.06, 1.0, 0.17], 0.04, plate, { seg: 10 }),
      box([0.07, 0.075, 0.09], IRON, { p: [s * 0.045, 1.0, 0.2] }),
    );
  }
  parts.push(
    cyl([0.17, 0.205, 0.16], plate, { p: [0, 0.94, 0], seg: 14, s: [1, 1, 0.85] }),
    lathe([[0, 0.99], [0.17, 1.0], [0.19, 1.15], [0.2, 1.3], [0.17, 1.42], [0.08, 1.46], [0, 1.47]], plate, { seg: 14, s: [1, 1, 0.78] }),
    box([0.22, 0.42, 0.012], cloth, { p: [0, 0.91, 0.168], tint: true }),
    box([0.04, 0.3, 0.014], LIME, { p: [0, 0.94, 0.17] }),
    cyl([0.07, 0.09, 0.08], plate, { p: [0, 1.5, 0], seg: 12 }),
    lathe([[0.1, 1.53], [0.115, 1.6], [0.115, 1.69], [0.1, 1.76], [0.06, 1.81], [0, 1.825]], plate, { seg: 14 }),
    box([0.15, 0.014, 0.04], BLACK, { p: [0, 1.665, 0.1] }),
    sphere(0.06, cloth, { p: [0, 1.87, -0.03], s: [0.6, 1.35, 1.25], seg: 10, tint: true }),
  );
  return finish(group(parts), "suit of armor");
}

function sandbags(opts) {
  const burlap = tint(opts, "sandbags", "fabric");
  const rnd = jitter(opts?.seed || 7);
  const parts = [];
  // Bag: capsule laid along X, squashed to 0.16 tall.
  const bag = (x, y, z) => parts.push(capsule([0.13, 0.16], burlap, { p: [x, y, z], r: [rnd(3), rnd(5), 90 + rnd(3)], s: [0.62, 1, 1], tint: true }));
  for (const x of [-0.6, -0.2, 0.2, 0.6]) { bag(x, 0.08, 0.14); bag(x + rnd(0.02), 0.08, -0.14); }
  for (const x of [-0.4, 0, 0.4]) { bag(x, 0.22, 0.12); bag(x + rnd(0.02), 0.22, -0.12); }
  for (const x of [-0.6, -0.2, 0.2, 0.6]) bag(x, 0.36, 0);
  for (const x of [-0.4, 0, 0.4]) bag(x, 0.5, 0);
  return finish(group(parts), "sandbags");
}

const TIRE = [[0.21, 0.02], [0.24, 0], [0.38, 0], [0.405, 0.025], [0.41, 0.1], [0.405, 0.175], [0.38, 0.2], [0.24, 0.2], [0.21, 0.18], [0.2, 0.1], [0.21, 0.02]];
function tire(opts) {
  const rubber = tint(opts, "tire", "matte");
  const rnd = jitter(opts?.seed || 3);
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push(lathe(TIRE, rubber, { p: [rnd(0.015), i * 0.198, rnd(0.015)], seg: 20, tint: true }));
  return finish(group(parts), "tire");
}

function trafficCone(opts) {
  const radius = (y) => 0.15 - ((y - 0.06) * 0.12) / 0.63 + 0.002;
  return finish(group([
    box([0.36, 0.035, 0.36], BLACK, { p: [0, 0.0175, 0] }),
    lathe([[0.155, 0.035], [0.15, 0.06], [0.03, 0.69], [0.018, 0.7], [0, 0.7]], tint(opts, "traffic cone", "plastic"), { seg: 16, tint: true }),
    band(radius(0.27), 0.27, radius(0.35), 0.35, WHITE),
    band(radius(0.45), 0.45, radius(0.52), 0.52, WHITE),
  ]), "traffic cone");
}

function hurdle(opts) {
  const stripe = tint(opts, "hurdle", "plastic");
  const metal = mat("#b9beb8", "plastic");
  // Feet point toward the approach side (+Z) so a clipped hurdle tips away from the runner.
  const parts = [box([1.0, 0.07, 0.018], WHITE, { p: [0, 0.805, -0.215] })];
  for (const x of [-0.33, 0, 0.33]) parts.push(box([0.13, 0.072, 0.02], stripe, { p: [x, 0.805, -0.215], tint: true }));
  for (const s of [-1, 1]) {
    parts.push(
      box([0.03, 0.8, 0.03], metal, { p: [s * 0.46, 0.43, -0.2] }),
      box([0.04, 0.03, 0.46], metal, { p: [s * 0.46, 0.015, 0.01] }),
      box([0.05, 0.05, 0.08], DARK, { p: [s * 0.46, 0.025, 0.2] }),
    );
  }
  return finish(group(parts), "hurdle");
}

function barricade(opts) {
  const stake = tint(opts, "barricade", "wood");
  const profile = [[0, -0.72], [0.026, -0.6], [0.034, -0.45], [0.034, 0.45], [0.026, 0.6], [0, 0.72]];
  const parts = [cyl([0.075, 0.075, 1.8], WOOD_DARK, { p: [0, 0.52, 0], r: [0, 0, 90], seg: 8 })];
  for (const x of [-0.72, -0.24, 0.24, 0.72]) {
    parts.push(lathe(profile, stake, { p: [x, 0.52, 0], r: [45, 0, 0], seg: 7, tint: true }));
    parts.push(lathe(profile, stake, { p: [x + 0.05, 0.52, 0], r: [-45, 0, 0], seg: 7, tint: true }));
    parts.push(cyl([0.08, 0.08, 0.04], IRON, { p: [x + 0.025, 0.52, 0], r: [0, 0, 90], seg: 8 }));
  }
  return finish(group(parts), "barricade");
}

function boxingRing(opts) {
  const canvas = tint(opts, "boxing ring", "fabric");
  const post = mat("#2f3336", "plastic");
  const ropes = [mat("#2a64b0", "plastic"), WHITE, mat("#c8202f", "plastic")];
  const c = 2.86;
  const parts = [
    box([6, 0.3, 6], BLACK, { p: [0, 0.15, 0] }),
    box([5.82, 0.02, 5.82], canvas, { p: [0, 0.31, 0], tint: true }),
    box([6.0, 0.04, 0.02], LIME_GLOW, { p: [0, 0.26, 3.0] }),
    box([6.0, 0.04, 0.02], LIME_GLOW, { p: [0, 0.26, -3.0] }),
    box([0.02, 0.04, 6.0], LIME_GLOW, { p: [3.0, 0.26, 0] }),
    box([0.02, 0.04, 6.0], LIME_GLOW, { p: [-3.0, 0.26, 0] }),
  ];
  const pads = [mat("#c8202f", "fabric"), WHITE, mat("#2a64b0", "fabric"), WHITE];
  [[-c, -c], [c, -c], [c, c], [-c, c]].forEach(([x, z], i) => {
    parts.push(cyl([0.055, 0.055, 1.3], post, { p: [x, 0.95, z], seg: 10 }));
    parts.push(box([0.16, 0.92, 0.16], pads[i], { p: [x * 0.985, 1.0, z * 0.985], r: [0, 45, 0] }));
  });
  [0.72, 1.07, 1.42].forEach((y, level) => {
    const m = ropes[level];
    parts.push(cyl([0.022, 0.022, 2 * c], m, { p: [0, y, c], r: [0, 0, 90], seg: 8 }));
    parts.push(cyl([0.022, 0.022, 2 * c], m, { p: [0, y, -c], r: [0, 0, 90], seg: 8 }));
    parts.push(cyl([0.022, 0.022, 2 * c], m, { p: [c, y, 0], r: [90, 0, 0], seg: 8 }));
    parts.push(cyl([0.022, 0.022, 2 * c], m, { p: [-c, y, 0], r: [90, 0, 0], seg: 8 }));
  });
  return finish(group(parts), "boxing ring");
}

const HOLD_COLORS = ["#d5fb6a", "#f26a1b", "#2a64b0", "#c8202f", "#f2c230", "#7b4fc0"];
const HOLDS = [[-0.85, 0.45], [-0.3, 0.6], [0.35, 0.4], [0.85, 0.75], [-0.6, 1.05], [0.05, 1.15], [0.6, 1.3], [-0.25, 1.6], [0.3, 1.85], [-0.8, 1.75]];
function obstacleWall(opts) {
  const planks = tint(opts, "obstacle wall", "wood");
  const z = 0.4;
  const parts = [
    box([2.4, 2.05, 0.08], planks, { p: [0, 1.125, z], tint: true }),
    box([2.4, 0.1, 0.1], WOOD_DARK, { p: [0, 0.05, z] }),
    cyl([0.05, 0.05, 2.44], WOOD_DARK, { p: [0, 2.15, z], r: [0, 0, 90], seg: 10 }),
    cyl([0.018, 0.018, 1.75], ROPE, { p: [0.75, 1.24, z + 0.07], seg: 6 }),
    cyl([0.022, 0.022, 0.1], ROPE, { p: [0.75, 2.12, z + 0.05], r: [60, 0, 0], seg: 6 }),
  ];
  for (let i = 1; i <= 5; i++) parts.push(box([2.4, 0.012, 0.084], WOOD_DARK, { p: [0, 0.1 + i * 0.34, z] }));
  for (const y of [0.55, 0.95, 1.35]) parts.push(sphere(0.032, ROPE, { p: [0.75, y, z + 0.07], seg: 8 }));
  for (const s of [-1, 1]) {
    parts.push(
      box([0.1, 2.1, 0.1], WOOD_DARK, { p: [s * 1.12, 1.05, z - 0.09] }),
      beam([s * 0.95, 1.75, z - 0.12], [s * 0.95, 0.06, -0.44], [0.08, 0.08], WOOD_DARK),
      box([0.1, 0.08, 0.9], WOOD_DARK, { p: [s * 0.95, 0.04, -0.04] }),
    );
  }
  HOLDS.forEach(([x, y], i) => parts.push(sphere(0.045, mat(HOLD_COLORS[i % HOLD_COLORS.length], "plastic"), { p: [x, y, z + 0.045], s: [1.25, 0.85, 0.6], seg: 8 })));
  return finish(group(parts), "obstacle wall");
}

const BARREL_PROFILE = [[0, -0.06], [0.05, -0.05], [0.06, -0.02], [0.03, 0], [0.13, 0], [0.15, 0.04], [0.15, 0.3], [0.138, 0.32], [0.138, 0.55], [0.128, 0.57], [0.11, 1.28], [0.12, 1.36], [0.126, 1.44], [0.1, 1.5], [0.062, 1.5], [0.062, 1.42], [0, 1.42]];
function cannon(opts) {
  const iron = tint(opts, "cannon", "plastic");
  const wz = -0.05;
  const wy = 0.456;
  const parts = [
    cyl([0.035, 0.035, 0.96], IRON, { p: [0, wy, wz], r: [0, 0, 90], seg: 10 }),
    beam([-0.17, 0.66, 0.33], [-0.17, 0.12, -0.95], [0.06, 0.2], WOOD),
    beam([0.17, 0.66, 0.33], [0.17, 0.12, -0.95], [0.06, 0.2], WOOD),
    box([0.42, 0.12, 0.2], WOOD_DARK, { p: [0, 0.06, -0.98] }),
    box([0.34, 0.08, 0.1], WOOD_DARK, { p: [0, 0.4, -0.45] }),
    group([
      lathe(BARREL_PROFILE, iron, { p: [0, -0.5, 0], seg: 16, tint: true }),
      cyl([0.04, 0.04, 0.4], iron, { r: [0, 0, 90], seg: 10, tint: true }),
    ], { p: [0, 0.7, 0.15], r: [80, 0, 0] }),
  ];
  for (const s of [-1, 1]) {
    const x = s * 0.42;
    parts.push(
      torus([0.405, 0.04], WOOD_DARK, { p: [x, wy, wz], r: [0, 90, 0], seg: 18 }),
      torus([0.44, 0.016], IRON, { p: [x, wy, wz], r: [0, 90, 0], seg: 18 }),
      cyl([0.07, 0.07, 0.12], WOOD_DARK, { p: [x, wy, wz], r: [0, 0, 90], seg: 10 }),
    );
    for (const a of [0, 60, 120]) parts.push(box([0.03, 0.8, 0.035], WOOD, { p: [x, wy, wz], r: [a, 0, 0] }));
  }
  return finish(group(parts), "cannon");
}

function catapult(opts) {
  const wood = tint(opts, "catapult", "wood");
  const pivot = [0, 0.36, 0];
  const parts = [
    box([0.12, 0.12, 1.8], wood, { p: [-0.5, 0.24, 0], tint: true }),
    box([0.12, 0.12, 1.8], wood, { p: [0.5, 0.24, 0], tint: true }),
    box([1.12, 0.1, 0.12], wood, { p: [0, 0.24, 0.8], tint: true }),
    box([1.12, 0.1, 0.12], wood, { p: [0, 0.24, -0.8], tint: true }),
    box([1.12, 0.1, 0.12], wood, { p: [0, 0.24, 0.3], tint: true }),
    cyl([0.08, 0.08, 0.96], ROPE, { p: pivot, r: [0, 0, 90], seg: 10 }),
    cyl([0.06, 0.06, 1.04], STRAW, { p: [0, 1.15, 0.3], r: [0, 0, 90], seg: 10 }),
    beam(pivot, [0, 0.74, -0.8], [0.09, 0.09], WOOD_DARK),
    cyl([0.03, 0.03, 0.3], IRON, { p: [0, 0.32, -0.88], r: [0, 0, 90], seg: 8 }),
  ];
  for (const s of [-1, 1]) {
    const x = s * 0.5;
    parts.push(
      beam([x, 0.3, -0.12], [x, 1.18, 0.3], [0.1, 0.1], wood, { tint: true }),
      beam([x, 0.3, 0.75], [x, 1.18, 0.3], [0.1, 0.1], wood, { tint: true }),
    );
    for (const z of [-0.68, 0.68]) parts.push(cyl([0.18, 0.18, 0.08], WOOD_DARK, { p: [s * 0.6, 0.18, z], r: [0, 0, 90], seg: 12 }));
  }
  // Cup at the end of the cocked arm, with a stone.
  parts.push(group([
    lathe([[0, 0], [0.12, 0.01], [0.17, 0.09], [0.16, 0.1], [0.11, 0.035], [0, 0.03]], WOOD_DARK, { seg: 12 }),
    sphere(0.1, STONE, { p: [0, 0.12, 0], seg: 10 }),
  ], { p: [0, 0.76, -0.84] }));
  return finish(group(parts), "catapult");
}

export const builders = {
  "axe": axe,
  "battle axe": battleAxe,
  "sword": sword,
  "katana": katana,
  "dagger": dagger,
  "spear": spear,
  "war hammer": warHammer,
  "mace": mace,
  "staff": staff,
  "baseball bat": baseballBat,
  "wooden sword": woodenSword,
  "halberd": halberd,
  "bow": bow,
  "arrow": arrow,
  "crossbow": crossbow,
  "shield": shield,
  "training dummy": trainingDummy,
  "archery target": archeryTarget,
  "punching bag": punchingBag,
  "gong": gong,
  "kettlebell": kettlebell,
  "dumbbell": dumbbell,
  "cannonball": cannonball,
  "crate": crate,
  "barrel": barrel,
  "weapon rack": weaponRack,
  "suit of armor": suitOfArmor,
  "sandbags": sandbags,
  "tire": tire,
  "traffic cone": trafficCone,
  "hurdle": hurdle,
  "barricade": barricade,
  "boxing ring": boxingRing,
  "obstacle wall": obstacleWall,
  "cannon": cannon,
  "catapult": catapult,
};
