// structures parts: builders keyed by meta name (see ARCHITECTURE.md).
// Origin is the bottom-center of each part's bounding box and fronts face +Z.
import { kit } from "./kit.js";

const { THREE, box, cyl, sphere, cone, torus, capsule, lathe, extrude, prism, group, mat, finish, DEG } = kit;

const C = {
  trim: "#f3eee0", white: "#f5f3ee", stone: "#bdb6a6", darkStone: "#8e887c", wood: "#8a5f3b",
  darkWood: "#5a3c25", plank: "#a97d52", glass: "#3d5667", terracotta: "#b9552f", slate: "#4b4e55",
  leaf: "#4d7c3a", darkLeaf: "#2f5130", gold: "#d9b45b", lamp: "#ffe4a3", water: "#4fa7c4",
  brick: "#9c4a35", dark: "#2a2622", iron: "#30332f", accent: "#d5fb6a",
};

const UP = new THREE.Vector3(0, 1, 0);
const DIR = new THREE.Vector3();

// Builds a mesh whose local +Y runs from point a to point b (beams, rails, braces, limbs).
function between(make, a, b, o = {}) {
  DIR.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = DIR.length() + (o.extra || 0);
  const m = make(len, { tint: o.tint, p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] });
  m.quaternion.setFromUnitVectors(UP, DIR.normalize());
  return m;
}
const beam = (a, b, w, d, material, o = {}) => between((len, oo) => box([w, len, d], material, oo), a, b, o);
const rod = (a, b, r, material, o = {}) => between((len, oo) => cyl([r, r, len], material, { seg: o.seg || 8, ...oo }), a, b, o);
const limb = (a, b, r, material, o = {}) => between((len, oo) => capsule([r, len], material, oo), a, b, o);

// Two slabs meeting at a ridge along X; eaves at z ± span/2 plus overhang.
function gableRoof(parent, { span, rise, len, y, x = 0, z = 0, over = 0.3, thick = 0.12, material, ridge }) {
  const a = Math.atan2(rise, span / 2);
  const slope = Math.hypot(span / 2, rise) + over;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  for (const s of [1, -1]) {
    // Slab bottom sits on the roof line so gable walls below never share a plane with the top.
    const cz = s * (ca * slope / 2 + sa * thick / 2);
    const cy = rise - sa * slope / 2 + ca * thick / 2;
    parent.add(box([len, thick, slope], material, { p: [x, y + cy, z + cz], r: [s * a / DEG, 0, 0] }));
  }
  if (ridge) parent.add(box([len + 0.04, thick * 1.3, thick * 2.4], ridge, { p: [x, y + rise + thick, z] }));
}

// Four sloped slabs over a w (X) by d (Z) footprint with equal pitch; a pyramid when w == d.
function hipRoof(parent, { w, d, rise, y, x = 0, z = 0, over = 0.3, thick = 0.1, material }) {
  const W = w + over * 2;
  const D = d + over * 2;
  const s = Math.hypot(D / 2, rise);
  const tilt = -(90 - Math.atan2(rise, D / 2) / DEG);
  const ridge = W - D;
  const front = ridge > 0.02 ? [[-W / 2, 0], [W / 2, 0], [ridge / 2, s], [-ridge / 2, s]] : [[-W / 2, 0], [W / 2, 0], [0, s]];
  const side = [[-D / 2, 0], [D / 2, 0], [0, s]];
  for (const k of [1, -1]) {
    parent.add(group([extrude(front, thick, material, { r: [tilt, 0, 0] })], { p: [x, y, z + k * D / 2], r: [0, k > 0 ? 0 : 180, 0] }));
    parent.add(group([extrude(side, thick, material, { r: [tilt, 0, 0] })], { p: [x + k * W / 2, y, z], r: [0, k * 90, 0] }));
  }
  return ridge;
}

// Rectangular window on a wall: origin at the wall surface, window center; faces local +Z.
function windowUnit(w, h, p, ry = 0, o = {}) {
  const f = 0.09;
  const frame = mat(o.frame || C.trim, "plastic");
  const g = group([
    box([w + f * 2, h + f * 2, 0.08], frame, { p: [0, 0, 0.04] }),
    box([w, h, 0.1], mat(o.pane || C.glass, "plastic"), { p: [0, 0, 0.05] }),
  ], { p, r: [0, ry, 0] });
  if (o.mullion) g.add(box([0.05, h, 0.12], frame, { p: [0, 0, 0.06] }));
  if (o.cross) g.add(box([w, 0.05, 0.12], frame, { p: [0, 0, 0.06] }));
  if (o.sill) g.add(box([w + f * 2 + 0.1, 0.07, 0.17], frame, { p: [0, -h / 2 - f - 0.035, 0.085] }));
  if (o.shutters) {
    const sm = mat(o.shutters, "wood");
    for (const s of [-1, 1]) g.add(box([w / 2 + 0.04, h + 0.12, 0.05], sm, { p: [s * (w * 0.75 + f + 0.07), 0, 0.025] }));
  }
  return g;
}

// Round-topped slab (doors, arched windows): origin at bottom center, depth centered on z = 0.
function archBox(w, h, d, material, p = [0, 0, 0], tint = false) {
  const r = w / 2;
  return group([
    box([w, h - r, d], material, { p: [0, (h - r) / 2, 0], tint }),
    cyl([r, r, d], material, { p: [0, h - r, 0], r: [90, 0, 0], seg: 16, tint }),
  ], { p });
}

// Arched French window: origin at the wall surface, bottom center.
function archWindow(w, h, p, ry = 0) {
  return group([
    archBox(w + 0.18, h + 0.09, 0.08, mat(C.trim, "plastic"), [0, 0, 0.04]),
    archBox(w, h, 0.1, mat(C.glass, "plastic"), [0, 0, 0.05]),
  ], { p, r: [0, ry, 0] });
}

function cypress(x, z, h = 5.2) {
  return group([
    cyl([0.12, 0.16, 0.6], mat(C.darkWood, "wood"), { p: [0, 0.3, 0], seg: 8 }),
    lathe([[0.001, 0.25], [0.42, 0.7], [0.55, 1.6], [0.5, h * 0.55], [0.3, h * 0.85], [0.001, h]], mat(C.darkLeaf, "leaf"), { seg: 10 }),
  ], { p: [x, 0, z] });
}

function pot(x, y, z, scale = 1) {
  return lathe([[0.001, 0], [0.22, 0], [0.3, 0.42], [0.34, 0.46], [0.001, 0.46]].map(([r, h]) => [r * scale, h * scale]), mat("#b86b3f", "matte"), { p: [x, y, z], seg: 12 });
}

export const builders = {
  villa(o) {
    const stucco = mat(o.color || "#efe2c6", "matte");
    const trim = mat(C.trim, "stone");
    const roof = mat(C.terracotta, "matte");
    const paving = mat("#d9ccb1", "stone");
    const shutter = "#5d8a68";
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));

    // Terrace, steps, low front walls with potted lemon trees.
    add(box([14, 0.3, 4.9], paving, { p: [0, 0.15, 3.05] }));
    add(box([3, 0.15, 0.5], paving, { p: [0, 0.075, 5.75] }));
    for (const s of [-1, 1]) {
      add(box([5.5, 0.45, 0.25], stucco, { p: [s * 4.25, 0.525, 5.375], tint: true }));
      add(pot(s * 1.75, 0.75, 5.375, 1.1));
      add(sphere(0.48, mat("#4f7f36", "leaf"), { p: [s * 1.75, 1.62, 5.375], seg: 10 }));
    }
    // Pool with coping, two loungers, umbrella table.
    add(box([4.0, 0.06, 2.4], mat("#efe9db", "stone"), { p: [4.4, 0.33, 2.6] }));
    add(box([3.6, 0.04, 2.0], mat(C.water, "plastic"), { p: [4.4, 0.37, 2.6] }));
    for (const x of [3.4, 5.4]) {
      add(box([0.62, 0.22, 1.5], mat(C.white, "fabric"), { p: [x, 0.41, 4.6] }));
      add(box([0.62, 0.08, 0.6], mat(C.white, "fabric"), { p: [x, 0.62, 4.0], r: [35, 0, 0] }));
    }
    add(cyl([0.5, 0.5, 0.05], trim, { p: [-4.6, 1.02, 3.2], seg: 12 }));
    add(cyl([0.05, 0.05, 2.3], mat(C.iron, "plastic"), { p: [-4.6, 1.45, 3.2], seg: 6 }));
    add(cone([1.3, 0.55], mat("#e9e1cf", "fabric"), { p: [-4.6, 2.75, 3.2], seg: 8 }));
    add(cyl([0.06, 0.25, 0.7], mat(C.iron, "plastic"), { p: [-4.6, 0.65, 3.2], seg: 8 }));
    add(cypress(-6.4, -0.05), cypress(6.45, -0.05));

    // Main block: walls, floor band, cornice, hip roof, chimney.
    add(box([9, 6.6, 6.2], stucco, { p: [0, 3.3, -2.5], tint: true }));
    add(box([9.14, 0.18, 6.34], trim, { p: [0, 3.3, -2.5] }));
    add(box([9.24, 0.25, 6.44], trim, { p: [0, 6.5, -2.5] }));
    const ridge = hipRoof(root, { w: 9, d: 6.2, rise: 1.7, y: 6.62, z: -2.5, over: 0.35, thick: 0.12, material: roof });
    add(box([ridge + 0.2, 0.14, 0.24], mat("#9e4426", "matte"), { p: [0, 8.33, -2.5] }));
    add(box([0.6, 1.5, 0.6], stucco, { p: [2.4, 7.9, -3.6], tint: true }));
    add(box([0.8, 0.12, 0.8], roof, { p: [2.4, 8.71, -3.6] }));

    // Porch columns carrying the front balcony.
    const column = [[0.001, 0], [0.2, 0], [0.2, 0.12], [0.15, 0.2], [0.14, 2.6], [0.19, 2.78], [0.24, 2.94], [0.001, 2.94]];
    for (const x of [-2.05, -1.05, 1.05, 2.05]) add(lathe(column, trim, { p: [x, 0.3, 2.75], seg: 12 }));
    add(box([4.6, 0.2, 2.4], trim, { p: [0, 3.35, 1.8] }));
    const baluster = mat(C.white, "stone");
    for (let i = 0; i < 9; i++) add(cyl([0.045, 0.065, 0.8], baluster, { p: [-2.0 + i * 0.5, 3.85, 2.88], seg: 6 }));
    for (const s of [-1, 1]) {
      for (const z of [1.0, 1.6, 2.2]) add(cyl([0.045, 0.065, 0.8], baluster, { p: [s * 2.2, 3.85, z], seg: 6 }));
      add(box([0.16, 0.1, 2.4], baluster, { p: [s * 2.22, 4.3, 1.8] }));
    }
    add(box([4.6, 0.1, 0.16], baluster, { p: [0, 4.3, 2.88] }));
    add(archWindow(1.2, 2.2, [0, 3.45, 0.6]));

    // Arched front door with lanterns.
    add(archBox(1.75, 2.75, 0.08, trim, [0, 0.3, 0.64]));
    add(archBox(1.4, 2.55, 0.12, mat("#6b4428", "wood"), [0, 0.3, 0.66]));
    add(box([0.03, 2.2, 0.13], mat("#3f2716", "wood"), { p: [0, 1.4, 0.67] }));
    for (const s of [-1, 1]) {
      add(sphere(0.045, mat(C.gold, "gold"), { p: [s * 0.13, 1.35, 0.74], seg: 8 }));
      add(box([0.16, 0.26, 0.16], mat(C.lamp, "glow"), { p: [s * 1.25, 2.35, 0.7] }));
    }

    // Front windows with shutters; side and back windows.
    for (const s of [-1, 1]) {
      add(windowUnit(1.1, 1.4, [s * 3.2, 1.75, 0.6], 0, { sill: true, mullion: true, shutters: shutter }));
      add(windowUnit(1.1, 1.4, [s * 3.2, 4.85, 0.6], 0, { sill: true, mullion: true, shutters: shutter }));
      add(windowUnit(1.0, 1.3, [s * 2.5, 1.75, -5.6], 180));
      add(windowUnit(1.0, 1.3, [s * 2.5, 4.85, -5.6], 180));
    }
    for (const z of [-1.4, -3.9]) add(windowUnit(1.0, 1.3, [4.5, 4.85, z], 90, { sill: true }));
    for (const y of [1.75, 4.85]) add(windowUnit(1.0, 1.3, [-4.5, y, -0.8], -90, { sill: true }));

    // Belvedere tower with arched openings and pyramid roof.
    add(box([2.4, 7.6, 2.4], stucco, { p: [-5.6, 3.8, -3.2], tint: true }));
    add(box([2.6, 0.2, 2.6], trim, { p: [-5.6, 7.5, -3.2] }));
    hipRoof(root, { w: 2.4, d: 2.4, rise: 1.4, y: 7.6, x: -5.6, z: -3.2, over: 0.25, thick: 0.1, material: roof });
    const opening = mat("#2c2723", "matte");
    add(archBox(1.0, 1.3, 0.06, opening, [-5.6, 5.9, -1.98]));
    add(group([archBox(1.0, 1.3, 0.06, opening)], { p: [-6.82, 5.9, -3.2], r: [0, -90, 0] }));
    add(windowUnit(0.7, 1.0, [-5.6, 1.9, -2.0], 0));
    add(windowUnit(0.7, 1.0, [-5.6, 4.2, -2.0], 0));
    add(windowUnit(0.7, 1.0, [-6.8, 3.0, -3.2], -90));

    // One-story wing with roof terrace.
    add(box([2.6, 3.6, 4.6], stucco, { p: [5.7, 1.8, -2.7], tint: true }));
    add(box([2.8, 0.18, 4.8], trim, { p: [5.7, 3.55, -2.7] }));
    add(box([2.5, 0.46, 0.14], stucco, { p: [5.75, 3.87, -0.47], tint: true }));
    add(box([0.14, 0.46, 4.6], stucco, { p: [6.93, 3.87, -2.7], tint: true }));
    add(box([2.5, 0.46, 0.14], stucco, { p: [5.75, 3.87, -4.93], tint: true }));
    add(pot(5.6, 3.64, -1.3, 0.9));
    add(sphere(0.38, mat("#5d8f3c", "leaf"), { p: [5.6, 4.32, -1.3], seg: 10 }));
    for (const x of [5.05, 6.35]) add(archWindow(0.85, 2.0, [x, 0.4, -0.4]));
    return finish(root, "villa");
  },

  house(o) {
    const body = mat(o.color || "#c3d5e2", "matte");
    const trim = mat(C.white, "plastic");
    const roofM = mat("#7c3b2f", "matte");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(box([7.2, 0.45, 6.2], mat(C.darkStone, "stone"), { p: [0, 0.225, 0] }));
    add(box([7, 3.2, 6], body, { p: [0, 2.05, 0], tint: true }));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(box([0.16, 3.2, 0.16], trim, { p: [sx * 3.47, 2.05, sz * 2.97] }));
    add(prism([6, 2.3, 7], body, { p: [0, 3.65, 0], r: [0, 90, 0], tint: true }));
    add(box([7.1, 0.14, 6.1], trim, { p: [0, 3.65, 0] }));
    gableRoof(root, { span: 6, rise: 2.3, len: 7.8, y: 3.65, over: 0.45, thick: 0.14, material: roofM, ridge: mat("#5e2b22", "matte") });
    add(box([0.6, 2.4, 0.6], mat(C.brick, "stone"), { p: [2.2, 5.6, -1.2] }));
    add(box([0.76, 0.12, 0.76], mat(C.darkStone, "stone"), { p: [2.2, 6.86, -1.2] }));
    // Door, step and little awning.
    add(box([1.3, 2.4, 0.08], trim, { p: [0, 1.65, 3.04] }));
    add(box([1.0, 2.2, 0.12], mat("#a3372f", "wood"), { p: [0, 1.55, 3.06] }));
    add(box([0.6, 0.5, 0.13], mat(C.glass, "plastic"), { p: [0, 2.2, 3.07] }));
    add(sphere(0.05, mat(C.gold, "gold"), { p: [0.36, 1.5, 3.14], seg: 8 }));
    add(box([1.8, 0.45, 0.8], mat(C.stone, "stone"), { p: [0, 0.225, 3.4] }));
    add(box([1.9, 0.1, 1.0], roofM, { p: [0, 3.05, 3.5], r: [14, 0, 0] }));
    for (const s of [-1, 1]) add(beam([s * 0.85, 2.7, 3.04], [s * 0.85, 2.98, 3.85], 0.06, 0.06, trim));
    // Windows with shutters and flower boxes; side, gable and back windows.
    for (const s of [-1, 1]) {
      add(windowUnit(1.1, 1.3, [s * 2.05, 2.05, 3.0], 0, { mullion: true, cross: true, shutters: "#2f4a66" }));
      add(box([1.3, 0.2, 0.24], mat("#7a5232", "wood"), { p: [s * 2.05, 1.18, 3.12] }));
      add(box([1.2, 0.12, 0.16], mat("#d0507a", "leaf"), { p: [s * 2.05, 1.32, 3.12] }));
      add(windowUnit(1.0, 1.2, [s * 3.5, 2.05, 0], s * 90, { sill: true, mullion: true }));
      add(windowUnit(0.9, 1.1, [s * 2.0, 2.05, -3.0], 180));
      add(cyl([0.42, 0.42, 0.08], trim, { p: [s * 3.5, 4.6, 0], r: [0, 0, 90], seg: 16 }));
      add(cyl([0.32, 0.32, 0.1], mat(C.glass, "plastic"), { p: [s * 3.5, 4.6, 0], r: [0, 0, 90], seg: 16 }));
    }
    return finish(root, "house");
  },

  cabin(o) {
    const logM = mat(o.color || "#8b5a33", "wood");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    const r = 0.19;
    const step = 0.38;
    const W = 5.2;
    const D = 4.4;
    for (let i = 0; i < 7; i++) {
      for (const s of [-1, 1]) {
        add(cyl([r, r, W + 0.6], logM, { p: [0, r + i * step, s * D / 2], r: [0, 0, 90], seg: 8, tint: true }));
        if (i < 6) add(cyl([r, r, D + 0.6], logM, { p: [s * W / 2, r + i * step + step / 2, 0], r: [90, 0, 0], seg: 8, tint: true }));
      }
    }
    const top = r * 2 + 6 * step;
    add(box([W, top, D], mat("#5e3d22", "wood"), { p: [0, top / 2, 0] }));
    add(prism([D + 0.4, 1.7, W], mat("#9a7048", "wood"), { p: [0, top, 0], r: [0, 90, 0] }));
    gableRoof(root, { span: D + 0.4, rise: 1.7, len: W + 1.2, y: top, over: 0.5, thick: 0.14, material: mat("#4a4038", "wood"), ridge: mat("#3a322b", "wood") });
    add(box([0.7, 2.6, 0.7], mat("#8f8a80", "stone"), { p: [1.6, top + 1.0, -0.9] }));
    add(box([0.84, 0.14, 0.84], mat("#6f6a62", "stone"), { p: [1.6, top + 2.35, -0.9] }));
    // Door, windows, porch deck, firewood.
    const front = D / 2 + r;
    add(box([1.2, 2.15, 0.08], mat(C.darkWood, "wood"), { p: [-0.9, 1.15, front + 0.02] }));
    add(box([0.95, 1.95, 0.1], mat("#b07a45", "wood"), { p: [-0.9, 1.05, front + 0.05] }));
    add(sphere(0.05, mat(C.iron, "plastic"), { p: [-0.6, 1.1, front + 0.12], seg: 8 }));
    add(windowUnit(0.9, 0.8, [1.3, 1.5, front], 0, { frame: C.darkWood, mullion: true, cross: true, sill: true }));
    add(windowUnit(0.8, 0.7, [W / 2 + r, 1.5, 0], 90, { frame: C.darkWood, cross: true }));
    add(box([W + 0.6, 0.16, 1.1], mat("#7a5434", "wood"), { p: [0, 0.08, front + 0.55] }));
    for (const [x, y, z] of [[1.9, 0.26, 2.95], [2.3, 0.26, 2.95], [2.1, 0.44, 2.95]]) {
      add(cyl([0.1, 0.1, 0.7], mat("#a0703f", "wood"), { p: [x, y, z - 0.1], r: [90, 0, 0], seg: 8 }));
    }
    return finish(root, "cabin");
  },

  tower(o) {
    const woodM = mat(o.color || "#8a6440", "wood");
    const dark = mat(C.darkWood, "wood");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    const B = 1.7;
    const T = 1.25;
    const H = 7;
    const legAt = (sx, sz, y) => [sx * (B + (T - B) * y / H), y, sz * (B + (T - B) * y / H)];
    const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
    for (const [sx, sz] of corners) add(beam(legAt(sx, sz, 0), legAt(sx, sz, H), 0.22, 0.22, woodM, { tint: true }));
    for (let i = 0; i < 4; i++) {
      const [ax, az] = corners[i];
      const [bx, bz] = corners[(i + 1) % 4];
      const n = ax === bx ? [ax * 0.14, 0, 0] : [0, 0, az * 0.14];
      const at = (sx, sz, y) => legAt(sx, sz, y).map((v, k) => v + n[k]);
      for (const [y0, y1] of [[0.5, 3.5], [3.7, 6.6]]) {
        add(beam(at(ax, az, y0), at(bx, bz, y1), 0.08, 0.05, dark));
        add(beam(at(bx, bz, y0), at(ax, az, y1), 0.08, 0.05, dark));
      }
      add(beam(at(ax, az, 3.6), at(bx, bz, 3.6), 0.1, 0.06, dark));
    }
    add(box([3.0, 0.16, 3.0], woodM, { p: [0, H, 0], tint: true }));
    add(box([3.0, 0.9, 0.08], woodM, { p: [0, H + 0.53, -1.46], tint: true }));
    for (const s of [-1, 1]) {
      add(box([0.08, 0.9, 3.0], woodM, { p: [s * 1.46, H + 0.53, 0], tint: true }));
      add(box([1.0, 0.9, 0.08], woodM, { p: [s * 1.0, H + 0.53, 1.46], tint: true }));
    }
    for (const [sx, sz] of corners) add(box([0.12, 1.92, 0.12], dark, { p: [sx * 1.42, H + 1.04, sz * 1.42] }));
    hipRoof(root, { w: 2.84, d: 2.84, rise: 1.0, y: H + 2.0, over: 0.28, thick: 0.1, material: mat("#5a4636", "wood") });
    // Ladder up the front.
    const bottom = 2.0;
    const topZ = 1.45;
    const topY = H + 0.9;
    for (const s of [-1, 1]) add(beam([s * 0.25, 0.02, bottom], [s * 0.25, topY, topZ], 0.07, 0.09, dark));
    for (let i = 0; i < 14; i++) {
      const y = 0.35 + i * 0.48;
      add(cyl([0.025, 0.025, 0.5], woodM, { p: [0, y, bottom + (topZ - bottom) * y / topY], r: [0, 0, 90], seg: 6 }));
    }
    return finish(root, "tower");
  },

  wall(o) {
    const stone = mat(o.color || "#9c978c", "stone");
    const dark = mat("#7e796f", "stone");
    const light = mat("#b2aca0", "stone");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(box([6.1, 0.3, 1.1], dark, { p: [0, 0.15, 0] }));
    add(box([6, 2.1, 1], stone, { p: [0, 1.35, 0], tint: true }));
    add(box([6.08, 0.1, 1.06], dark, { p: [0, 2.45, 0] }));
    for (let i = 0; i < 5; i++) add(box([0.7, 0.55, 1], stone, { p: [-2.6 + i * 1.3, 2.775, 0], tint: true }));
    for (const x of [-1.3, 1.3]) add(box([0.08, 0.32, 0.02], mat(C.dark, "matte"), { p: [x, 2.78, 0.505] }));
    const blocks = [[-2.3, 0.75, 0.9, 0.4], [-0.9, 1.15, 1.1, 0.42], [0.6, 0.65, 0.8, 0.36], [1.9, 1.45, 1.0, 0.4],
      [-1.8, 1.95, 0.8, 0.34], [0.3, 2.0, 0.9, 0.3], [2.4, 0.75, 0.7, 0.36], [-0.3, 1.55, 0.6, 0.32]];
    blocks.forEach(([x, y, w, h], i) => add(box([w, h, 0.04], i % 2 ? light : dark, { p: [x, y, 0.51] })));
    blocks.slice(0, 4).forEach(([x, y, w, h], i) => add(box([w, h, 0.04], i % 2 ? dark : light, { p: [-x, y + 0.2, -0.51] })));
    return finish(root, "wall");
  },

  fence(o) {
    const paint = mat(o.color || "#f1efe8", "wood");
    const root = group();
    const picket = [[-0.04, 0], [0.04, 0], [0.04, 0.92], [0, 1.0], [-0.04, 0.92]];
    for (let i = 0; i < 19; i++) root.add(extrude(picket, 0.022, paint, { p: [-1.8 + i * 0.2, 0, 0.012], tint: true }));
    for (const y of [0.25, 0.75]) root.add(box([3.96, 0.08, 0.035], paint, { p: [0, y, -0.018], tint: true }));
    for (const s of [-1, 1]) {
      root.add(box([0.1, 1.06, 0.1], paint, { p: [s * 1.96, 0.53, 0], tint: true }));
      root.add(box([0.13, 0.04, 0.13], mat("#d9d6cc", "wood"), { p: [s * 1.96, 1.08, 0] }));
    }
    return finish(root, "fence");
  },

  stairs(o) {
    const body = mat(o.color || "#9a7552", "wood");
    const tread = mat("#c7a27a", "wood");
    const root = group();
    const n = 10;
    const rise = 0.2;
    const run = 0.3;
    const L = n * run;
    const outline = [[L / 2, 0]];
    for (let i = 0; i < n; i++) outline.push([L / 2 - i * run, (i + 1) * rise], [L / 2 - (i + 1) * run, (i + 1) * rise]);
    outline.push([-L / 2, 0]);
    root.add(extrude(outline, 1.3, body, { r: [0, -90, 0], tint: true }));
    for (let i = 0; i < n; i++) root.add(box([1.36, 0.035, run + 0.03], tread, { p: [0, (i + 1) * rise + 0.0175, L / 2 - i * run - run / 2 + 0.015] }));
    const cheek = [[L / 2, 0], [L / 2, rise + 0.12], [-L / 2 + run, n * rise + 0.12], [-L / 2, n * rise + 0.12], [-L / 2, 0]];
    for (const s of [-1, 1]) root.add(extrude(cheek, 0.08, mat("#6e5236", "wood"), { p: [s * 0.69, 0, 0], r: [0, -90, 0] }));
    return finish(root, "stairs");
  },

  ramp(o) {
    const body = mat(o.color || "#c08f52", "wood");
    const root = group();
    const a = Math.atan2(1, 4) / DEG;
    root.add(extrude([[2, 0], [-2, 1], [-2, 0]], 2, body, { r: [0, -90, 0], tint: true }));
    const yAt = (z) => (2 - z) / 4;
    for (const s of [-1, 1]) root.add(beam([s * 1.0, 0.04, 1.96], [s * 1.0, 1.0, -2.0], 0.07, 0.07, mat("#8d9298", "plastic")));
    root.add(box([2.0, 0.02, 0.3], mat("#8d9298", "plastic"), { p: [0, yAt(1.82) + 0.01, 1.82], r: [a, 0, 0] }));
    for (const z of [1.0, 0.0, -1.0]) root.add(box([1.85, 0.014, 0.16], mat("#2d302d", "matte"), { p: [0, yAt(z) + 0.008, z], r: [a, 0, 0] }));
    return finish(root, "ramp");
  },

  pillar(o) {
    const marble = mat(o.color || "#ece8df", "stone");
    const root = group();
    root.add(box([0.9, 0.18, 0.9], marble, { p: [0, 0.09, 0], tint: true }));
    root.add(lathe([[0.001, 0.18], [0.38, 0.18], [0.38, 0.26], [0.32, 0.3], [0.34, 0.36], [0.3, 0.42], [0.29, 1.4],
      [0.26, 3.36], [0.28, 3.4], [0.25, 3.46], [0.3, 3.54], [0.37, 3.7], [0.001, 3.7]], marble, { seg: 16, tint: true }));
    root.add(box([0.86, 0.16, 0.86], marble, { p: [0, 3.78, 0], tint: true }));
    return finish(root, "pillar");
  },

  arch(o) {
    const stone = mat(o.color || "#b7ae9c", "stone");
    const alt = mat("#a39a88", "stone");
    const key = mat("#cfc6b2", "stone");
    const root = group();
    const r1 = 1.1;
    const r2 = 1.8;
    const spring = 2.35;
    const n = 9;
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const odd = (i + (s > 0 ? 1 : 0)) % 2;
        root.add(box([0.7, 0.74, 1], odd ? alt : stone, { p: [s * 1.45, 0.37 + i * 0.74, 0], tint: !odd }));
      }
      root.add(box([0.86, 0.13, 1.1], key, { p: [s * 1.45, 2.285, 0] }));
    }
    const half = (180 / n / 2 - 0.7) * DEG;
    const wedge = (ra, rb) => [[ra * Math.cos(-half), ra * Math.sin(-half)], [rb * Math.cos(-half), rb * Math.sin(-half)],
      [rb * Math.cos(half), rb * Math.sin(half)], [ra * Math.cos(half), ra * Math.sin(half)]];
    for (let i = 0; i < n; i++) {
      const isKey = i === (n - 1) / 2;
      const material = isKey ? key : i % 2 ? alt : stone;
      root.add(extrude(isKey ? wedge(r1 - 0.04, r2 + 0.12) : wedge(r1, r2), isKey ? 1.12 : 1, material,
        { p: [0, spring, 0], r: [0, 0, (i + 0.5) * 180 / n], tint: !isKey && !(i % 2) }));
    }
    root.add(sphere(0.26, mat("#4b7a34", "leaf"), { p: [-1.52, 0.26, 0.45], s: [1, 1, 0.5], seg: 10 }));
    root.add(sphere(0.2, mat("#5d8f3c", "leaf"), { p: [-1.5, 0.72, 0.48], s: [1, 1.4, 0.4], seg: 10 }));
    return finish(root, "arch");
  },

  footbridge(o) {
    const deck = mat(o.color || "#9b6b40", "wood");
    const dark = mat("#6a4527", "wood");
    const root = group();
    const L = 6;
    const H = 0.55;
    const n = 8;
    const yAt = (z) => 0.09 + H * (1 - (2 * z / L) ** 2);
    for (let i = 0; i < n; i++) {
      const z0 = -L / 2 + i * L / n;
      const z1 = z0 + L / n;
      root.add(beam([0, yAt(z0), z0], [0, yAt(z1), z1], 1.8, 0.1, deck, { tint: true, extra: 0.04 }));
    }
    for (const s of [-1, 1]) root.add(box([2.0, 0.12, 0.3], mat("#8e887c", "stone"), { p: [0, 0.06, s * 2.95] }));
    const posts = [-2.4, -1.2, 0, 1.2, 2.4];
    for (const s of [-1, 1]) {
      for (const z of posts) root.add(box([0.1, 0.97, 0.1], dark, { p: [s * 0.86, yAt(z) + 0.465, z] }));
      for (let i = 0; i < posts.length - 1; i++) {
        root.add(beam([s * 0.86, yAt(posts[i]) + 0.92, posts[i]], [s * 0.86, yAt(posts[i + 1]) + 0.92, posts[i + 1]], 0.08, 0.07, deck, { tint: true, extra: 0.08 }));
      }
    }
    return finish(root, "footbridge");
  },

  tent(o) {
    const fabric = mat(o.color || "#e07a2e", "fabric");
    const light = mat("#f2d7b0", "fabric");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(box([2.3, 0.02, 2.5], mat("#3d4a3a", "fabric"), { p: [0, 0.01, 0] }));
    add(prism([2.2, 1.4, 2.3], fabric, { p: [0, 0.02, 0], tint: true }));
    add(extrude([[-0.5, 0], [0.5, 0], [0, 1.0]], 0.02, mat("#2b2420", "fabric"), { p: [0, 0.02, 1.16] }));
    for (const s of [-1, 1]) add(rod([s * 0.56, 0.06, 1.18], [s * 0.1, 0.92, 1.18], 0.05, light));
    add(box([0.18, 0.04, 2.4], light, { p: [0, 1.42, 0] }));
    for (const s of [-1, 1]) add(cyl([0.018, 0.018, 0.16], mat(C.iron, "plastic"), { p: [0, 1.48, s * 1.12], seg: 6 }));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        add(rod([sx * 0.74, 0.48, sz * 0.7], [sx * 1.18, 0.04, sz * 0.7], 0.008, mat("#e8e3d4", "fabric"), { seg: 4 }));
        add(cyl([0.015, 0.015, 0.12], mat("#9aa0a6", "metal"), { p: [sx * 1.18, 0.05, sz * 0.7], seg: 6 }));
      }
    }
    return finish(root, "tent");
  },

  flag(o) {
    const cloth = mat(o.color || "#c8382e", "fabric");
    const root = group();
    const px = -0.68;
    root.add(box([0.3, 0.15, 0.3], mat(C.stone, "stone"), { p: [px, 0.075, 0] }));
    root.add(cyl([0.035, 0.05, 4.85], mat("#c9ccd0", "plastic"), { p: [px, 2.5, 0], seg: 8 }));
    root.add(sphere(0.07, mat(C.gold, "gold"), { p: [px, 4.97, 0], seg: 10 }));
    // Cloth: a hinged chain of strips; update() swings the hinges for a cheap wave.
    const hinges = [];
    let parent = root;
    const sw = 0.35;
    for (let i = 0; i < 4; i++) {
      const hinge = group([box([sw, 0.9, 0.02], cloth, { p: [sw / 2, 0, 0], tint: true })], { p: i ? [sw, 0, 0] : [px + 0.04, 4.4, 0] });
      if (i === 1) hinge.add(cyl([0.15, 0.15, 0.03], mat(C.accent, "fabric"), { p: [sw / 2, 0, 0], r: [90, 0, 0], seg: 14 }));
      parent.add(hinge);
      hinges.push(hinge);
      parent = hinge;
    }
    const phase = ((o.seed || 0) % 628) / 100;
    root.userData.update = (dt, t) => {
      for (let i = 0; i < hinges.length; i++) hinges[i].rotation.y = Math.sin(t * 2.6 - i * 0.9 + phase) * (0.1 + i * 0.07);
    };
    return finish(root, "flag");
  },

  "lamp post"(o) {
    const iron = mat(o.color || "#2f3b33", "plastic");
    const root = group();
    root.add(lathe([[0.001, 0], [0.22, 0], [0.22, 0.08], [0.16, 0.14], [0.14, 0.4], [0.09, 0.5], [0.001, 0.5]], iron, { seg: 12, tint: true }));
    root.add(cyl([0.045, 0.06, 2.6], iron, { p: [0, 1.8, 0], seg: 10, tint: true }));
    root.add(cyl([0.08, 0.08, 0.06], iron, { p: [0, 2.4, 0], seg: 10, tint: true }));
    root.add(box([0.5, 0.04, 0.04], iron, { p: [0, 2.9, 0], tint: true }));
    root.add(cyl([0.12, 0.08, 0.06], iron, { p: [0, 3.13, 0], seg: 6, tint: true }));
    root.add(cyl([0.16, 0.11, 0.38], mat(C.lamp, "glow"), { p: [0, 3.35, 0], seg: 6 }));
    root.add(cone([0.22, 0.18], iron, { p: [0, 3.63, 0], seg: 6, tint: true }));
    root.add(sphere(0.035, iron, { p: [0, 3.75, 0], seg: 8, tint: true }));
    return finish(root, "lamp post");
  },

  fountain(o) {
    const stone = mat(o.color || "#cdc5b3", "stone");
    const sheet = mat("#a9e1f2", "glass");
    const root = group();
    root.add(lathe([[0.001, 0], [1.6, 0], [1.62, 0.1], [1.56, 0.48], [1.62, 0.52], [1.62, 0.58], [1.42, 0.58], [1.42, 0.2], [0.001, 0.2]], stone, { seg: 20, tint: true }));
    root.add(cyl([1.42, 1.42, 0.06], mat(C.water, "plastic"), { p: [0, 0.43, 0], seg: 20 }));
    root.add(lathe([[0.4, 0.2], [0.36, 0.3], [0.2, 0.45], [0.15, 0.8], [0.13, 1.15], [0.22, 1.25], [0.001, 1.25]], stone, { seg: 12, tint: true }));
    root.add(lathe([[0.15, 1.2], [0.45, 1.3], [0.72, 1.42], [0.78, 1.5], [0.7, 1.52], [0.62, 1.44], [0.001, 1.44]], stone, { seg: 16, tint: true }));
    root.add(cyl([0.74, 0.82, 1.0], sheet, { p: [0, 0.96, 0], seg: 16 }));
    root.add(lathe([[0.06, 1.44], [0.1, 1.55], [0.05, 1.7], [0.09, 1.8], [0.001, 1.86]], stone, { seg: 10, tint: true }));
    const jet = cone([0.07, 0.45], mat("#d8f4fb", "plastic"), { p: [0, 2.06, 0], seg: 8 });
    root.add(jet);
    const ripples = [0, 1].map(() => torus([0.5, 0.015], mat("#e3f6fb", "plastic"), { p: [0, 0.465, 0], r: [90, 0, 0], seg: 16 }));
    ripples.forEach((m) => root.add(m));
    root.userData.update = (dt, t) => {
      jet.scale.y = 1 + Math.sin(t * 7) * 0.08;
      for (let i = 0; i < ripples.length; i++) {
        const k = (t * 0.45 + i * 0.5) % 1;
        ripples[i].scale.set(0.6 + k * 1.9, 0.6 + k * 1.9, 1);
      }
    };
    return finish(root, "fountain");
  },

  gazebo(o) {
    const paint = mat(o.color || "#f2efe6", "wood");
    const roofM = mat("#5b6b5e", "matte");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(cyl([2.0, 2.05, 0.3], mat("#9a7a58", "wood"), { p: [0, 0.15, 0], seg: 16 }));
    add(box([1.2, 0.15, 0.45], mat(C.stone, "stone"), { p: [0, 0.075, 2.05] }));
    const R = 1.72;
    for (let i = 0; i < 8; i++) {
      const a = (22.5 + 45 * i) * DEG;
      add(cyl([0.07, 0.07, 2.4], paint, { p: [R * Math.sin(a), 1.5, R * Math.cos(a)], seg: 8, tint: true }));
    }
    const mid = R * Math.cos(22.5 * DEG);
    for (let i = 1; i < 8; i++) {
      const a = 45 * i;
      const p = [mid * Math.sin(a * DEG), 0, mid * Math.cos(a * DEG)];
      add(box([1.2, 0.08, 0.08], paint, { p: [p[0], 1.05, p[2]], r: [0, a, 0], tint: true }));
      add(box([1.2, 0.58, 0.03], paint, { p: [p[0], 0.68, p[2]], r: [0, a, 0], tint: true }));
    }
    add(cyl([1.9, 1.9, 0.18], paint, { p: [0, 2.79, 0], seg: 16, tint: true }));
    add(cone([2.25, 1.3], roofM, { p: [0, 3.53, 0], seg: 16 }));
    add(cyl([0.26, 0.26, 0.3], paint, { p: [0, 4.12, 0], seg: 8, tint: true }));
    add(cone([0.36, 0.3], roofM, { p: [0, 4.42, 0], seg: 8 }));
    add(sphere(0.06, mat(C.gold, "gold"), { p: [0, 4.6, 0], seg: 8 }));
    add(sphere(0.13, mat(C.lamp, "glow"), { p: [0, 2.48, 0], seg: 10 }));
    return finish(root, "gazebo");
  },

  shed(o) {
    const wood = mat(o.color || "#7d5b3c", "wood");
    const trim = mat("#e9e4d6", "wood");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(box([3.0, 0.1, 2.4], mat("#a9a59c", "stone"), { p: [0, 0.05, 0] }));
    add(box([2.8, 2.0, 2.2], wood, { p: [0, 1.1, 0], tint: true }));
    add(prism([2.2, 0.75, 2.8], wood, { p: [0, 2.1, 0], r: [0, 90, 0], tint: true }));
    gableRoof(root, { span: 2.2, rise: 0.75, len: 3.1, y: 2.1, over: 0.25, thick: 0.08, material: mat("#4a4f55", "matte"), ridge: mat("#3a3e43", "matte") });
    for (const x of [-1.35, -0.95, 0.95, 1.35]) add(box([0.06, 2.0, 0.03], mat("#5f4329", "wood"), { p: [x, 1.1, 1.11] }));
    for (const s of [-1, 1]) {
      add(box([0.62, 1.8, 0.06], trim, { p: [s * 0.33, 1.02, 1.12] }));
      add(beam([s * 0.6, 0.25, 1.16], [s * 0.06, 1.75, 1.16], 0.07, 0.03, mat("#b8b2a2", "wood")));
      add(box([0.04, 0.16, 0.04], mat(C.iron, "plastic"), { p: [s * 0.08, 1.05, 1.18] }));
    }
    add(windowUnit(0.6, 0.5, [1.4, 1.45, 0], 90, { frame: "#e9e4d6", cross: true }));
    add(rod([-1.48, 0.12, 0.5], [-1.43, 1.5, 0.35], 0.025, mat("#a0703f", "wood")));
    add(box([0.22, 0.3, 0.03], mat("#8b9096", "metal"), { p: [-1.49, 0.2, 0.52], r: [0, 90, 0] }));
    return finish(root, "shed");
  },

  stage(o) {
    const skirt = mat(o.color || "#7a1f2b", "fabric");
    const deck = mat("#5b4632", "wood");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(box([5.9, 0.68, 3.5], skirt, { p: [0, 0.34, -0.2], tint: true }));
    add(box([6, 0.12, 3.6], deck, { p: [0, 0.74, -0.2] }));
    for (let i = 1; i < 6; i++) add(box([6, 0.006, 0.02], mat("#3e2f21", "wood"), { p: [0, 0.803, -2.0 + i * 0.6] }));
    add(box([6.0, 0.04, 0.04], mat(C.accent, "glow"), { p: [0, 0.78, 1.6] }));
    add(box([1.6, 0.27, 0.4], deck, { p: [0, 0.135, 1.8] }));
    add(box([1.6, 0.53, 0.2], deck, { p: [0, 0.265, 1.7] }));
    for (const x of [-2.4, -0.9, 0.9, 2.4]) add(sphere(0.07, mat(C.lamp, "glow"), { p: [x, 0.8, 1.45], s: [1, 0.6, 1], seg: 8 }));
    return finish(root, "stage");
  },

  portal(o) {
    const ringM = mat(o.color || "#6d7481", "plastic");
    const glowA = mat(C.accent, "glow");
    const glowB = mat("#47e0ff", "glow");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    const R = 1.55;
    const cy = 2.05;
    add(box([3.7, 0.4, 1.0], mat("#3b403b", "stone"), { p: [0, 0.2, 0] }));
    for (const s of [-1, 1]) add(box([0.5, 0.5, 0.7], mat("#4a504a", "stone"), { p: [s * 1.1, 0.6, 0] }));
    add(torus([R, 0.2], ringM, { p: [0, cy, 0], seg: 32, tint: true }));
    add(torus([R - 0.22, 0.04], glowA, { p: [0, cy, 0], seg: 32 }));
    for (const a of [-135, -90, -45, 0, 45, 90, 135]) {
      const rad = a * DEG;
      add(box([0.22, 0.26, 0.48], glowA, { p: [(R + 0.04) * Math.sin(rad), cy + (R + 0.04) * Math.cos(rad), 0], r: [0, 0, -a] }));
    }
    add(cyl([R - 0.19, R - 0.19, 0.03], mat("#1b6f86", "glow"), { p: [0, cy, 0], r: [90, 0, 0], seg: 32 }));
    const swirl = group([], { p: [0, cy, 0] });
    for (let k = 0; k < 10; k++) {
      const a = k * 0.95;
      const rr = 0.18 + k * 0.12;
      swirl.add(sphere(0.045 + k * 0.004, glowB, { p: [rr * Math.cos(a), rr * Math.sin(a), 0], seg: 8 }));
    }
    add(swirl);
    const rings = [0.55, 0.95].map((r) => torus([r, 0.02], glowB, { p: [0, cy, 0], seg: 20 }));
    rings.forEach((m) => add(m));
    root.userData.update = (dt, t) => {
      swirl.rotation.z = -t * 1.4;
      for (let i = 0; i < rings.length; i++) rings[i].scale.setScalar(1 + Math.sin(t * 3 + i * 1.7) * 0.07);
    };
    return finish(root, "portal");
  },

  statue(o) {
    const bronze = mat(o.color || "#6f9a83", "stone");
    const plinth = mat("#d2cbbb", "stone");
    const darkP = mat("#b3ab99", "stone");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(box([1.6, 0.25, 1.6], darkP, { p: [0, 0.125, 0] }));
    add(box([1.25, 1.1, 1.25], plinth, { p: [0, 0.8, 0] }));
    add(box([1.45, 0.15, 1.45], darkP, { p: [0, 1.425, 0] }));
    add(box([0.6, 0.28, 0.02], mat(C.gold, "gold"), { p: [0, 0.85, 0.635] }));
    const b = (m) => ((m.userData.tint = true), m);
    for (const s of [-1, 1]) {
      add(b(box([0.15, 0.08, 0.28], bronze, { p: [s * 0.2, 1.54, 0.06] })));
      add(b(limb([s * 0.13, 2.45, 0], [s * 0.2, 1.64, 0.02], 0.085, bronze)));
    }
    add(b(box([0.38, 0.22, 0.24], bronze, { p: [0, 2.5, 0] })));
    add(b(cyl([0.25, 0.17, 0.72], bronze, { p: [0, 2.92, 0], seg: 10 })));
    add(b(sphere(0.14, bronze, { p: [0, 3.44, 0.01], seg: 12 })));
    add(b(limb([0.28, 3.18, 0], [0.46, 3.6, 0.04], 0.065, bronze)));
    add(b(limb([0.46, 3.6, 0.04], [0.52, 3.98, 0.08], 0.058, bronze)));
    add(b(cone([0.07, 0.22], bronze, { p: [0.52, 4.08, 0.08], r: [180, 0, 0], seg: 8 })));
    add(cone([0.075, 0.26], mat("#ff9a3c", "glow"), { p: [0.52, 4.32, 0.08], seg: 8 }));
    add(b(limb([-0.28, 3.18, 0], [-0.42, 2.82, 0.1], 0.065, bronze)));
    add(b(limb([-0.42, 2.82, 0.1], [-0.4, 2.62, 0.3], 0.058, bronze)));
    add(b(cyl([0.32, 0.32, 0.05], bronze, { p: [-0.4, 2.72, 0.38], r: [90, 0, 0], seg: 16 })));
    add(b(sphere(0.07, bronze, { p: [-0.4, 2.72, 0.41], seg: 8 })));
    add(b(extrude([[-0.24, 0], [0.24, 0], [0.36, -1.25], [-0.36, -1.25]], 0.04, bronze, { p: [0, 3.22, -0.2], r: [8, 0, 0] })));
    return finish(root, "statue");
  },

  well(o) {
    const stone = mat(o.color || "#a8a195", "stone");
    const wood = mat("#7a5434", "wood");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(lathe([[0.001, 0], [0.8, 0], [0.82, 0.06], [0.8, 0.76], [0.84, 0.8], [0.84, 0.9], [0.6, 0.9], [0.6, 0.3], [0.001, 0.3]], stone, { seg: 14, tint: true }));
    add(cyl([0.6, 0.6, 0.04], mat("#1f3f55", "plastic"), { p: [0, 0.55, 0], seg: 14 }));
    for (const s of [-1, 1]) add(box([0.12, 1.45, 0.12], wood, { p: [s * 0.72, 1.6, 0] }));
    gableRoof(root, { span: 1.3, rise: 0.5, len: 1.9, y: 2.3, over: 0.2, thick: 0.06, material: mat("#6b4b33", "wood"), ridge: mat("#4f3624", "wood") });
    add(cyl([0.05, 0.05, 1.5], wood, { p: [0, 1.95, 0], r: [0, 0, 90], seg: 8 }));
    add(cyl([0.012, 0.012, 0.5], mat("#c9b48a", "fabric"), { p: [0, 1.66, 0], seg: 4 }));
    add(cyl([0.14, 0.11, 0.22], mat("#8b8f94", "metal"), { p: [0, 1.32, 0], seg: 10 }));
    add(box([0.04, 0.26, 0.04], wood, { p: [0.82, 1.84, 0] }));
    add(cyl([0.025, 0.025, 0.16], wood, { p: [0.9, 1.72, 0], r: [0, 0, 90], seg: 6 }));
    return finish(root, "well");
  },

  windmill(o) {
    const body = mat(o.color || "#ece6d8", "matte");
    const capM = mat("#5a4a3e", "wood");
    const sailM = mat("#efe9dc", "fabric");
    const spar = mat("#6e4f35", "wood");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(lathe([[0.001, 0], [1.5, 0], [1.5, 0.3], [1.38, 0.36], [1.0, 6.0], [0.001, 6.0]], body, { seg: 16, tint: true }));
    add(lathe([[1.12, 5.9], [1.12, 6.25], [0.92, 6.85], [0.5, 7.2], [0.001, 7.3]], capM, { seg: 14 }));
    add(archBox(0.8, 1.7, 0.12, mat("#6b4428", "wood"), [0, 0.02, 1.44]));
    for (const y of [3.0, 4.6]) {
      const r = 1.5 - (0.5 * (y - 0.36)) / 5.64;
      add(windowUnit(0.42, 0.55, [0, y, r - 0.04], 0, { frame: "#5a4a3e" }));
    }
    add(cyl([0.16, 0.2, 0.6], capM, { p: [0, 6.4, 1.15], r: [90, 0, 0], seg: 10 }));
    const rotor = group([sphere(0.2, capM, { seg: 10 })], { p: [0, 6.4, 1.52], r: [0, 0, 45] });
    for (let i = 0; i < 4; i++) {
      rotor.add(group([
        box([0.12, 3.5, 0.1], spar, { p: [0, 1.95, 0] }),
        box([0.85, 2.8, 0.03], sailM, { p: [0.5, 2.25, -0.04] }),
      ], { r: [0, 0, i * 90] }));
    }
    add(rotor);
    const start = ((o.seed || 0) % 90) * DEG;
    root.userData.update = (dt, t) => {
      rotor.rotation.z = Math.PI / 4 + start - t * 0.7;
    };
    return finish(root, "windmill");
  },

  barn(o) {
    const red = mat(o.color || "#a33a2c", "matte");
    const white = mat(C.white, "wood");
    const roofM = mat("#4a4d52", "matte");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(box([8, 4, 10], red, { p: [0, 2, 0], tint: true }));
    add(extrude([[-4, 0], [-3.05, 1.8], [0, 2.95], [3.05, 1.8], [4, 0]], 10, red, { p: [0, 4, 0], tint: true }));
    const pts = [[-4.45, 3.85], [-3.3, 5.95], [0, 7.15], [3.3, 5.95], [4.45, 3.85]];
    for (let i = 0; i < 4; i++) add(beam([pts[i][0], pts[i][1], 0], [pts[i + 1][0], pts[i + 1][1], 0], 0.14, 10.6, roofM, { extra: 0.12 }));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(box([0.18, 4, 0.18], white, { p: [sx * 3.96, 2, sz * 4.96] }));
    // Big sliding doors with white X bracing, hayloft door above.
    add(box([3.4, 3.4, 0.08], white, { p: [0, 1.7, 5.02] }));
    add(box([3.0, 3.1, 0.1], mat("#8a2d22", "wood"), { p: [0, 1.6, 5.04] }));
    add(beam([-1.4, 0.15, 5.1], [1.4, 3.05, 5.1], 0.16, 0.04, white));
    add(beam([1.4, 0.15, 5.1], [-1.4, 3.05, 5.1], 0.16, 0.04, white));
    add(box([2.0, 2.6, 0.08], white, { p: [0, 1.3, -5.02] }));
    add(beam([-0.9, 0.1, -5.07], [0.9, 2.5, -5.07], 0.14, 0.04, white));
    add(beam([0.9, 0.1, -5.07], [-0.9, 2.5, -5.07], 0.14, 0.04, white));
    add(box([1.5, 1.3, 0.08], white, { p: [0, 5.2, 5.02] }));
    add(box([1.2, 1.05, 0.1], mat("#8a2d22", "wood"), { p: [0, 5.15, 5.04] }));
    for (const s of [-1, 1]) {
      for (const z of [-2.5, 2.0]) add(windowUnit(0.9, 0.9, [s * 4, 2.4, z], s * 90, { frame: C.white, cross: true }));
    }
    // Ridge cupola.
    add(box([1.0, 0.8, 1.0], white, { p: [0, 7.4, 0] }));
    add(box([0.7, 0.4, 1.02], mat(C.dark, "matte"), { p: [0, 7.45, 0] }));
    hipRoof(root, { w: 1.0, d: 1.0, rise: 0.55, y: 7.8, over: 0.12, thick: 0.06, material: roofM });
    return finish(root, "barn");
  },

  lighthouse(o) {
    const red = mat(o.color || "#c0392b", "matte");
    const white = mat(C.white, "matte");
    const dark = mat("#2e3436", "plastic");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(lathe([[0.001, 0], [1.5, 0], [1.5, 0.6], [1.3, 0.7], [0.001, 0.7]], mat("#8e887c", "stone"), { seg: 16 }));
    const bands = 5;
    const h = 8.3 / bands;
    for (let i = 0; i < bands; i++) {
      const r0 = 1.1 - i * 0.08;
      add(cyl([r0 - 0.08, r0, h], i % 2 ? white : red, { p: [0, 0.7 + h * (i + 0.5), 0], seg: 16, tint: !(i % 2) }));
    }
    add(cyl([1.05, 1.05, 0.15], dark, { p: [0, 9.075, 0], seg: 16 }));
    add(torus([0.98, 0.03], dark, { p: [0, 9.65, 0], r: [90, 0, 0], seg: 20 }));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      add(cyl([0.025, 0.025, 0.5], dark, { p: [Math.sin(a) * 0.98, 9.4, Math.cos(a) * 0.98], seg: 4 }));
    }
    add(cyl([0.55, 0.55, 0.95], mat("#fff2b0", "glow"), { p: [0, 9.63, 0], seg: 12 }));
    add(cone([0.72, 0.75], red, { p: [0, 10.48, 0], seg: 16, tint: true }));
    add(sphere(0.1, dark, { p: [0, 10.9, 0], seg: 8 }));
    add(archBox(0.7, 1.5, 0.1, mat("#3b3f44", "wood"), [0, 0.7, 1.06]));
    for (const [y, a] of [[3.3, 0], [5.0, 120], [6.6, 240]]) {
      const r = 1.1 - ((y - 0.7) / 8.3) * 0.4;
      add(box([0.28, 0.45, 0.06], mat(C.glass, "plastic"), { p: [Math.sin(a * DEG) * r, y, Math.cos(a * DEG) * r], r: [0, a, 0] }));
    }
    return finish(root, "lighthouse");
  },
};
