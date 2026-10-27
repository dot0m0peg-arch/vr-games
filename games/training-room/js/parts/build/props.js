// props parts: builders keyed by meta name (see ARCHITECTURE.md). Toys and snacks that come alive in
// play/behaviors.js: a pistol that fires, a rubber chicken that flops, and containers whose pieces
// can be taken out one by one (a box of popcorn, a bag of chips). Origin = bottom-center.
import { kit } from "./kit.js";
import { metas } from "../meta/props.js";
import { fillOf, fillSlots } from "../../core/fill.js";
import { getMeta } from "../meta/index.js";

const { THREE, box, cyl, sphere, cone, torus, capsule, lathe, group, mat, finish, textPanel, mergeStatic, disposeObject, DEG } = kit;

const META = Object.fromEntries(metas.map((m) => [m.name, m]));
const tint = (opts, name, kind = "plastic") => mat(opts?.color || META[name]?.color || "#888888", kind);

const BLACK = mat("#1b1c1e", "plastic");
const GUNMETAL = mat("#3a3d40", "plastic");
const WHITE = mat("#f4f1ea", "plastic");
const RED = mat("#d62828", "plastic");
const ORANGE = mat("#f08a1c", "plastic");
const CARDBOARD = mat("#b98d58", "paper");

// Open walls are seen from inside too, so they get their own two-sided copies of the paper material (kept for the session).
const twoSided = new Map();
function wallMat(color) {
  let m = twoSided.get(color);
  if (!m) {
    m = mat(color, "paper").clone();
    m.side = THREE.DoubleSide;
    m.userData.shared = true;
    twoSided.set(color, m);
  }
  return m;
}

// Red and white vertical stripes for the popcorn carton (plain red paper in Node, where there is no canvas).
let stripeMaterial = null;
function stripes() {
  if (stripeMaterial) return stripeMaterial;
  let map = null;
  if (typeof document === "undefined") {
    stripeMaterial = mat("#d62828", "paper").clone();
    stripeMaterial.side = THREE.DoubleSide;
    stripeMaterial.userData.shared = true;
    return stripeMaterial;
  }
  {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 8;
    const ctx = canvas.getContext("2d");
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = i % 2 ? "#f4f1ea" : "#d62828";
      ctx.fillRect(i * 16, 0, 16, 8);
    }
    map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
  }
  stripeMaterial = new THREE.MeshStandardMaterial({ color: map ? "#ffffff" : "#d62828", map, roughness: 0.6, side: THREE.DoubleSide });
  stripeMaterial.userData.shared = true;
  return stripeMaterial;
}

// Open-topped tapered tube: square (seg 4) or round, centered on the origin, from y0 to y1.
function tube(rBottom, rTop, y0, y1, material, { seg = 24, square = false, depth = 1 } = {}) {
  const geometry = new THREE.CylinderGeometry(rTop, rBottom, y1 - y0, seg, 1, true);
  if (square) geometry.rotateY(Math.PI / 4);
  geometry.scale(1, 1, depth);
  geometry.translate(0, (y0 + y1) / 2, 0);
  return new THREE.Mesh(geometry, material);
}

// ---------------------------------------------------------------- filled containers

// Adds root.userData.setFill(fill): draws the pieces inside (rebuilt when the count changes).
function fillable(root, name, opts) {
  const meta = META[name];
  const c = meta.container;
  const holder = new THREE.Group();
  holder.name = "fill";
  root.add(holder);
  let key = "";
  root.userData.fillSeed = opts.seed || 1;
  root.userData.setFill = (raw) => {
    const data = { ...(opts.data || {}), fill: raw === undefined ? opts.data?.fill : raw };
    const part = (data.fill && data.fill.part) || c.fill;
    const piece = opts.buildPart?.(part, data.fill?.color);
    // Same piece size as play/behaviors.js uses, so a taken piece comes from the top of this heap.
    const size = getMeta(part)?.size || (piece ? new THREE.Box3().setFromObject(piece).getSize(new THREE.Vector3()).toArray() : [0.03, 0.03, 0.03]);
    const pieceSize = Math.max(...size);
    const fill = fillOf(meta, { data }, pieceSize);
    const next = fill ? `${fill.part}|${fill.n}|${fill.s}` : "";
    if (next === key) {
      if (piece) disposeObject(piece);
      return;
    }
    key = next;
    for (const child of [...holder.children]) {
      child.removeFromParent();
      disposeObject(child);
    }
    if (!piece || !fill?.n) {
      if (piece) disposeObject(piece);
      return;
    }
    const slots = fillSlots(c, pieceSize * fill.s, fill.n, root.userData.fillSeed);
    const pieces = new THREE.Group();
    const center = new THREE.Box3().setFromObject(piece).getCenter(new THREE.Vector3());
    for (const [x, y, z, rx, ry, rz] of slots) {
      const copy = piece.clone();
      copy.scale.setScalar(fill.s);
      copy.position.copy(center).multiplyScalar(-fill.s);
      const spot = new THREE.Group();
      spot.position.set(x, y, z);
      spot.rotation.set(rx, ry, rz);
      spot.add(copy);
      pieces.add(spot);
    }
    mergeStatic(pieces);
    holder.add(pieces);
  };
  root.userData.setFill(opts.data?.fill);
  return root;
}

// ---------------------------------------------------------------- pieces

function popcornPiece(opts) {
  const cream = tint(opts, "popcorn piece", "matte");
  const butter = mat("#f2d36b", "matte");
  return group([
    sphere(0.0105, cream, { p: [0, 0.011, 0], seg: 8, tint: true }),
    sphere(0.0085, cream, { p: [0.009, 0.014, 0.003], seg: 8, tint: true }),
    sphere(0.008, cream, { p: [-0.008, 0.015, -0.004], seg: 8, tint: true }),
    sphere(0.0075, cream, { p: [0.002, 0.019, 0.008], seg: 8, tint: true }),
    sphere(0.005, butter, { p: [-0.002, 0.007, -0.006], seg: 6 }),
  ]);
}

export const builders = {
  pistol: (opts) => {
    const body = tint(opts, "pistol");
    const root = group([
      // Slide with serrations and sights; the muzzle is at +Z.
      box([0.03, 0.03, 0.19], body, { p: [0, 0.112, 0.022], tint: true }),
      box([0.031, 0.024, 0.004], BLACK, { p: [0, 0.112, -0.05] }),
      box([0.031, 0.024, 0.004], BLACK, { p: [0, 0.112, -0.042] }),
      box([0.031, 0.024, 0.004], BLACK, { p: [0, 0.112, -0.034] }),
      box([0.006, 0.006, 0.006], BLACK, { p: [0, 0.13, 0.108] }),
      box([0.016, 0.006, 0.006], BLACK, { p: [0, 0.13, -0.066] }),
      cyl([0.0075, 0.0075, 0.008], BLACK, { p: [0, 0.112, 0.118], r: [90, 0, 0], seg: 12 }),
      // Frame, raked grip and trigger guard.
      box([0.027, 0.02, 0.15], GUNMETAL, { p: [0, 0.088, 0.03] }),
      box([0.029, 0.1, 0.044], GUNMETAL, { p: [0, 0.05, -0.04], r: [16, 0, 0] }),
      box([0.031, 0.07, 0.03], BLACK, { p: [0, 0.052, -0.044], r: [16, 0, 0] }),
      torus([0.019, 0.003], GUNMETAL, { p: [0, 0.071, 0.014], r: [0, 90, 0], seg: 14 }),
      box([0.005, 0.02, 0.006], BLACK, { p: [0, 0.07, 0.012], r: [-12, 0, 0] }),
    ]);
    return finish(root, "pistol");
  },

  // Lies on its belly, head toward +Z, long legs trailing behind.
  "rubber chicken": (opts) => {
    const yellow = tint(opts, "rubber chicken");
    const root = group([
      sphere(0.055, yellow, { p: [0, 0.042, -0.04], s: [1, 0.72, 1.55], seg: 16, tint: true }),
      capsule([0.017, 0.13], yellow, { p: [0, 0.04, 0.1], r: [90, 0, 0], tint: true }),
      sphere(0.03, yellow, { p: [0, 0.046, 0.185], seg: 14, tint: true }),
      cone([0.012, 0.042], ORANGE, { p: [0, 0.043, 0.228], r: [90, 0, 0], seg: 10 }),
      sphere(0.009, RED, { p: [0, 0.079, 0.17], seg: 8 }),
      sphere(0.01, RED, { p: [0, 0.081, 0.186], seg: 8 }),
      sphere(0.008, RED, { p: [0, 0.077, 0.2], seg: 8 }),
      sphere(0.009, RED, { p: [0, 0.022, 0.208], s: [0.8, 1.3, 0.8], seg: 8 }),
      sphere(0.0055, BLACK, { p: [0.025, 0.055, 0.198], seg: 8 }),
      sphere(0.0055, BLACK, { p: [-0.025, 0.055, 0.198], seg: 8 }),
      sphere(0.03, yellow, { p: [0.05, 0.045, -0.03], s: [0.45, 0.6, 1.4], seg: 12, tint: true }),
      sphere(0.03, yellow, { p: [-0.05, 0.045, -0.03], s: [0.45, 0.6, 1.4], seg: 12, tint: true }),
      cone([0.022, 0.05], yellow, { p: [0, 0.055, -0.135], r: [-110, 0, 0], seg: 10, tint: true }),
      cyl([0.006, 0.006, 0.11], ORANGE, { p: [0.022, 0.02, -0.16], r: [-80, 0, 0], seg: 8 }),
      cyl([0.006, 0.006, 0.11], ORANGE, { p: [-0.022, 0.02, -0.16], r: [-80, 0, 0], seg: 8 }),
      box([0.034, 0.008, 0.03], ORANGE, { p: [0.024, 0.01, -0.222] }),
      box([0.034, 0.008, 0.03], ORANGE, { p: [-0.024, 0.01, -0.222] }),
    ]);
    return finish(root, "rubber chicken");
  },

  "popcorn box": (opts) => {
    const root = group([
      tube(0.0707, 0.0919, 0.004, 0.19, stripes(), { seg: 4, square: true, depth: 0.7 }),
      box([0.1, 0.006, 0.07], WHITE, { p: [0, 0.003, 0] }),
      textPanel([0.085, 0.032], { text: "POPCORN", size: 54, align: "center", valign: "middle", bg: "#f4f1ea", color: "#d62828" }, { p: [0, 0.14, 0.0445], r: [-3, 0, 0] }),
    ]);
    return finish(fillable(root, "popcorn box", opts), "popcorn box");
  },
  "snack bag": (opts) => {
    const body = tint(opts, "snack bag");
    const root = group([
      tube(0.075, 0.07, 0.01, 0.2, wallMat(opts?.color || META["snack bag"].color), { seg: 4, square: true, depth: 0.55 }),
      box([0.104, 0.012, 0.058], body, { p: [0, 0.006, 0], tint: true }),
      textPanel([0.08, 0.04], { text: "SNACKS", size: 48, align: "center", valign: "middle", bg: "#f2c230", color: "#7a1f12" }, { p: [0, 0.11, 0.0295] }),
    ]);
    root.children[0].userData.tint = true;
    return finish(fillable(root, "snack bag", opts), "snack bag");
  },
  "snack bucket": (opts) => {
    const body = wallMat(opts?.color || META["snack bucket"].color);
    const root = group([
      tube(0.068, 0.088, 0.006, 0.17, body),
      tube(0.0805, 0.085, 0.13, 0.15, wallMat("#f4f1ea")),
      cyl([0.068, 0.068, 0.006], WHITE, { p: [0, 0.003, 0], seg: 24 }),
    ]);
    root.children[0].userData.tint = true;
    return finish(fillable(root, "snack bucket", opts), "snack bucket");
  },
  "snack bowl": (opts) => {
    const body = wallMat(opts?.color || META["snack bowl"].color);
    const points = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * (Math.PI / 2);
      points.push([0.05 + 0.065 * Math.sin(a), 0.07 - 0.065 * Math.cos(a)]);
    }
    points.unshift([0, 0.005]);
    const shell = lathe(points, body, { seg: 28 });
    shell.userData.tint = true;
    const root = group([shell, cyl([0.05, 0.05, 0.006], body, { p: [0, 0.003, 0], seg: 24 })]);
    return finish(fillable(root, "snack bowl", opts), "snack bowl");
  },
  "snack box": (opts) => {
    const body = tint(opts, "snack box", "matte");
    const root = group([
      box([0.18, 0.008, 0.13], body, { p: [0, 0.004, 0], tint: true }),
      box([0.008, 0.12, 0.13], body, { p: [0.086, 0.06, 0], tint: true }),
      box([0.008, 0.12, 0.13], body, { p: [-0.086, 0.06, 0], tint: true }),
      box([0.18, 0.12, 0.008], body, { p: [0, 0.06, 0.061], tint: true }),
      box([0.18, 0.12, 0.008], body, { p: [0, 0.06, -0.061], tint: true }),
      box([0.18, 0.004, 0.04], CARDBOARD, { p: [0, 0.122, 0.08], r: [-35, 0, 0] }),
      box([0.18, 0.004, 0.04], CARDBOARD, { p: [0, 0.122, -0.08], r: [35, 0, 0] }),
    ]);
    return finish(fillable(root, "snack box", opts), "snack box");
  },

  "popcorn piece": (opts) => finish(popcornPiece(opts), "popcorn piece"),
  "french fry": (opts) => finish(group([box([0.011, 0.011, 0.085], tint(opts, "french fry", "matte"), { p: [0, 0.0055, 0], r: [0, 0, 0], tint: true })]), "french fry"),
  "potato chip": (opts) => finish(group([sphere(0.024, tint(opts, "potato chip", "matte"), { p: [0, 0.004, 0], s: [1, 0.16, 0.8], seg: 12, tint: true })]), "potato chip"),
  gumball: (opts) => finish(group([sphere(0.012, tint(opts, "gumball"), { p: [0, 0.012, 0], seg: 12, tint: true })]), "gumball"),
  "jelly bean": (opts) => finish(group([capsule([0.0065, 0.009], tint(opts, "jelly bean"), { p: [0, 0.0065, 0], r: [90, 0, 0], tint: true })]), "jelly bean"),
  candy: (opts) => {
    const body = tint(opts, "candy");
    return finish(group([
      sphere(0.011, body, { p: [0, 0.011, 0], s: [1.2, 1, 1], seg: 12, tint: true }),
      cone([0.008, 0.012], WHITE, { p: [0.017, 0.011, 0], r: [0, 0, 90], seg: 8 }),
      cone([0.008, 0.012], WHITE, { p: [-0.017, 0.011, 0], r: [0, 0, -90], seg: 8 }),
    ]), "candy");
  },
};


