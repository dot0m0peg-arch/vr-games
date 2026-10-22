// office parts: builders keyed by meta name (see ARCHITECTURE.md).
import { kit } from "./kit.js";
import { makeCanvas, canvasTexture } from "../../util/text.js";

const { THREE, box, cyl, sphere, cone, torus, capsule, plane, lathe, extrude, group, textPanel, mat, finish, DEG } = kit;

const INK = "#1b2a4a";
const MARKER_FONT = "\"Segoe Print\", \"Bradley Hand\", \"Comic Sans MS\", \"Chalkboard SE\", Arial, Helvetica, sans-serif";

// Common trim materials (cached by kit.mat).
const charcoal = () => mat("#2b302c", "plastic");
const blackPlastic = () => mat("#161917", "plastic");
const steel = () => mat("#c9cdc6", "metal");
const chrome = () => mat("#dfe3dc", "plastic");
const lime = () => mat("#d5fb6a", "glow");

// Orientation helpers: a primitive whose axis is local +Y, stretched from point a to point b.
const UP = new THREE.Vector3(0, 1, 0);
function span(a, b) {
  const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const length = dir.length();
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  return { length, p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], r: [e.x / DEG, e.y / DEG, e.z / DEG] };
}
function rod(a, b, radius, material, o = {}) {
  const s = span(a, b);
  return cyl([radius, radius, s.length], material, { seg: 10, ...o, p: s.p, r: s.r });
}
function beam(a, b, [w, d], material, o = {}) {
  const s = span(a, b);
  return box([w, s.length, d], material, { ...o, p: s.p, r: s.r });
}

// Glossy black "off" face shared by every screen.
const SCREEN_OFF = new THREE.MeshStandardMaterial({ color: "#050706", roughness: 0.16, metalness: 0.3 });
SCREEN_OFF.userData.shared = true;
SCREEN_OFF.userData.kind = "plastic";

// A +Z facing display plane (standard UVs, not mirrored) with a setScreen(texture | null) hook.
function screenFace(size, o, idle = SCREEN_OFF) {
  const face = plane(size, idle, o);
  face.name = "screen";
  let live = null;
  const setScreen = (texture) => {
    if (texture) {
      if (!live) {
        live = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
        live.userData.shared = true; // the stream texture belongs to the share module, never dispose it here
      } else if (live.map !== texture) {
        live.map = texture;
        live.needsUpdate = true;
      }
      face.material = live;
    } else {
      face.material = idle;
      live?.dispose();
      live = null;
    }
  };
  return { face, setScreen };
}

// Laptop idle screen: a little code editor drawn once and shared.
let laptopIdle = null;
function laptopScreenMaterial() {
  if (laptopIdle) return laptopIdle;
  const canvas = makeCanvas(256, 160);
  if (!canvas) return (laptopIdle = mat("#18221b", "glow"));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#101412";
  ctx.fillRect(0, 0, 256, 160);
  ctx.fillStyle = "#19271b";
  ctx.fillRect(0, 0, 256, 14);
  ctx.fillRect(0, 14, 44, 146);
  for (const [i, c] of ["#e0645a", "#e8c05a", "#7cc46b"].entries()) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(9 + i * 10, 7, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#596057";
  for (let y = 22; y < 150; y += 12) ctx.fillRect(8, y, 26, 4);
  const rows = [[0, 70, 0], [10, 96, 1], [10, 58, 2], [20, 120, 3], [20, 84, 1], [10, 34, 2], [0, 18, 2], [0, 0, 0],
    [0, 88, 0], [10, 110, 3], [20, 64, 1], [10, 40, 2], [0, 18, 2]];
  const colors = ["#d5fb6a", "#eef1e9", "#a7b0a4", "#7fc8ff"];
  rows.forEach(([indent, length, color], i) => {
    if (!length) return;
    ctx.fillStyle = colors[color];
    ctx.fillRect(54 + indent, 22 + i * 10, length, 5);
  });
  ctx.fillStyle = "#d5fb6a";
  ctx.fillRect(54, 22 + rows.length * 10, 6, 7);
  laptopIdle = new THREE.MeshBasicMaterial({ map: canvasTexture(canvas) });
  laptopIdle.userData.shared = true;
  return laptopIdle;
}

// Upholstered seating: couch (3 seats) and armchair (1 seat) share one recipe.
function sofa(width, seats, fabric, extras = []) {
  const legs = mat("#3a2a1d", "wood");
  const inner = width - 0.4;
  const cw = inner / seats - 0.012;
  const parts = [
    box([width - 0.04, 0.2, 0.86], fabric, { p: [0, 0.2, 0], tint: true }),
    box([inner, 0.55, 0.2], fabric, { p: [0, 0.575, -0.33], tint: true }),
  ];
  for (const side of [-1, 1]) {
    const x = side * (width / 2 - 0.1);
    parts.push(
      box([0.2, 0.48, 0.88], fabric, { p: [x, 0.34, 0], tint: true }),
      cyl([0.1, 0.1, 0.88], fabric, { p: [x, 0.58, 0], r: [90, 0, 0], tint: true }),
      cyl([0.024, 0.018, 0.1], legs, { p: [side * (width / 2 - 0.08), 0.05, 0.36], seg: 8 }),
      cyl([0.024, 0.018, 0.1], legs, { p: [side * (width / 2 - 0.08), 0.05, -0.36], seg: 8 }),
    );
  }
  for (let i = 0; i < seats; i++) {
    const x = -inner / 2 + (i + 0.5) * (inner / seats);
    parts.push(
      box([cw, 0.13, 0.62], fabric, { p: [x, 0.365, 0.11], tint: true }),
      box([cw, 0.4, 0.14], fabric, { p: [x, 0.62, -0.17], r: [-10, 0, 0], tint: true }),
    );
  }
  return group([...parts, ...extras]);
}

// Book spines for one shelf compartment, left to right. Each entry: [width, height] or "lean"/"stack" markers.
const SHELF_ROWS = [
  { y: 0.08, books: [[0.055, 0.3], [0.045, 0.28], [0.06, 0.31], [0.04, 0.26], [0.05, 0.29], [0.055, 0.3]], stack: 3 },
  { y: 0.4425, books: [[0.035, 0.24], [0.04, 0.26], [0.03, 0.22], [0.045, 0.25], [0.035, 0.24]], lean: true, vase: true },
  { y: 0.7925, globe: true, books: [[0.04, 0.25], [0.035, 0.23], [0.05, 0.26], [0.03, 0.22], [0.04, 0.24]], right: true },
  { y: 1.1425, books: [[0.03, 0.23], [0.04, 0.25], [0.035, 0.24], [0.045, 0.26]], stack: 2, box: true },
  { y: 1.4725, books: [[0.04, 0.24], [0.03, 0.22], [0.045, 0.25], [0.035, 0.23], [0.05, 0.26], [0.04, 0.24]], lean: true },
];
const BOOK_COLORS = ["#a8443a", "#2f5d8a", "#d1a23a", "#3f7a4a", "#6b4b7a", "#e2ddd0", "#22313b", "#c8643c", "#8aa37a", "#d5fb6a"];

function books(seed) {
  const out = [];
  let n = (seed >>> 0) % BOOK_COLORS.length;
  const bookMat = () => mat(BOOK_COLORS[n++ % BOOK_COLORS.length], "matte");
  for (const row of SHELF_ROWS) {
    const total = row.books.reduce((sum, [w]) => sum + w + 0.004, 0);
    let x = row.right ? 0.395 - total : -0.395;
    for (const [w, h] of row.books) {
      out.push(box([w, h, 0.21], bookMat(), { p: [x + w / 2, row.y + h / 2, 0.0] }));
      x += w + 0.004;
    }
    if (row.lean) out.push(box([0.04, 0.24, 0.2], bookMat(), { p: [x + 0.06, row.y + 0.12, 0], r: [0, 0, 20] }));
    if (row.stack) {
      for (let i = 0; i < row.stack; i++) {
        out.push(box([0.24 - i * 0.02, 0.04, 0.19 - i * 0.01], bookMat(), { p: [0.24, row.y + 0.02 + i * 0.04, 0], r: [0, i * 6, 0] }));
      }
    }
    if (row.vase) {
      out.push(lathe([[0, 0], [0.05, 0], [0.065, 0.06], [0.045, 0.15], [0.03, 0.17], [0.038, 0.18], [0, 0.18]],
        mat("#2f6f6a", "plastic"), { p: [0.31, row.y, 0], seg: 12 }));
    }
    if (row.globe) {
      out.push(
        cyl([0.05, 0.06, 0.02], mat("#3a2a1d", "wood"), { p: [-0.29, row.y + 0.01, 0], seg: 12 }),
        cyl([0.008, 0.008, 0.06], mat("#c9a24a", "gold"), { p: [-0.29, row.y + 0.05, 0], seg: 6 }),
        sphere(0.085, mat("#3a78a8", "plastic"), { p: [-0.29, row.y + 0.165, 0], seg: 14 }),
      );
    }
    if (row.box) out.push(box([0.16, 0.12, 0.2], mat("#e2ddd0", "matte"), { p: [-0.11, row.y + 0.06, 0] }));
  }
  return out;
}

// Fiddle-leaf style leaf: base at (0, 0), tip at (0, 0.3), drawn in the XY plane.
const LEAF = [[0, 0], [0.045, 0.03], [0.078, 0.1], [0.08, 0.17], [0.056, 0.24], [0, 0.3], [-0.056, 0.24], [-0.08, 0.17],
  [-0.078, 0.1], [-0.045, 0.03]];
// Spiral of leaves up the trunk (golden angle): [height, azimuth deg, tilt deg, scale]
const LEAVES = Array.from({ length: 16 }, (_, i) => {
  const k = i / 15;
  return [0.46 + k * 0.52, (i * 137.5) % 360, 78 - k * 62, 0.8 + 0.25 * Math.sin(k * Math.PI)];
});

export const builders = {
  "desk": (opts) => {
    const top = mat(opts.color || "#8a6a4a", "wood");
    const body = charcoal();
    const front = mat("#3a423c", "plastic");
    const parts = [
      box([1.6, 0.04, 0.8], top, { p: [0, 0.74, 0], tint: true }),
      box([1.58, 0.012, 0.012], mat("#5d4631", "wood"), { p: [0, 0.716, 0.39] }),
      box([0.44, 0.7, 0.7], body, { p: [0.56, 0.37, -0.03] }),
      box([0.04, 0.72, 0.74], body, { p: [-0.77, 0.36, 0] }),
      box([1.06, 0.34, 0.02], body, { p: [-0.21, 0.52, -0.33] }),
      box([0.4, 0.02, 0.02], mat("#141614", "plastic"), { p: [0.56, 0.01, 0.31] }),
    ];
    for (const y of [0.13, 0.355, 0.58]) {
      parts.push(
        box([0.41, 0.205, 0.02], front, { p: [0.56, y + 0.0, 0.33] }),
        box([0.14, 0.014, 0.018], steel(), { p: [0.56, y + 0.065, 0.349] }),
      );
    }
    // cable grommet and a lime status strip on the pedestal
    parts.push(
      cyl([0.03, 0.03, 0.004], blackPlastic(), { p: [-0.6, 0.761, -0.3], seg: 12 }),
      box([0.008, 0.6, 0.004], lime(), { p: [0.345, 0.37, 0.322] }),
    );
    return finish(group(parts), "desk");
  },

  "office chair": (opts) => {
    const fabric = mat(opts.color || "#34393f", "fabric");
    const black = blackPlastic();
    const parts = [];
    for (let i = 0; i < 5; i++) {
      const a = i * 72;
      const s = Math.sin(a * DEG);
      const c = Math.cos(a * DEG);
      parts.push(
        box([0.045, 0.035, 0.27], black, { p: [s * 0.14, 0.072, c * 0.14], r: [0, a, 0] }),
        sphere(0.03, black, { p: [s * 0.27, 0.03, c * 0.27], seg: 8 }),
      );
    }
    parts.push(
      cyl([0.04, 0.05, 0.05], black, { p: [0, 0.08, 0], seg: 12 }),
      cyl([0.03, 0.03, 0.1], black, { p: [0, 0.15, 0], seg: 12 }),
      cyl([0.021, 0.021, 0.2], steel(), { p: [0, 0.28, 0], seg: 10 }),
      box([0.22, 0.04, 0.22], black, { p: [0, 0.37, 0] }),
      box([0.5, 0.09, 0.48], fabric, { p: [0, 0.43, 0.02], tint: true }),
      beam([0, 0.36, -0.08], [0, 0.66, -0.27], [0.06, 0.03], black),
      box([0.46, 0.56, 0.07], fabric, { p: [0, 0.82, -0.26], r: [-8, 0, 0], tint: true }),
      box([0.3, 0.12, 0.02], mat("#2a2e33", "fabric"), { p: [0, 0.7, -0.198], r: [-8, 0, 0] }),
    );
    for (const side of [-1, 1]) {
      parts.push(
        box([0.12, 0.024, 0.05], black, { p: [side * 0.22, 0.395, -0.02] }),
        box([0.035, 0.22, 0.05], black, { p: [side * 0.268, 0.51, -0.02] }),
        box([0.06, 0.03, 0.26], black, { p: [side * 0.268, 0.63, 0.0] }),
      );
    }
    return finish(group(parts), "office chair");
  },

  "chair": (opts) => {
    const wood = mat(opts.color || "#9a6a3e", "wood");
    const parts = [
      box([0.45, 0.035, 0.45], wood, { p: [0, 0.4475, 0], tint: true }),
      box([0.42, 0.08, 0.03], wood, { p: [0, 0.85, -0.2], tint: true }),
      box([0.38, 0.03, 0.025], wood, { p: [0, 0.6, -0.2], tint: true }),
      box([0.34, 0.025, 0.025], wood, { p: [0, 0.15, 0.19], tint: true }),
    ];
    for (const side of [-1, 1]) {
      parts.push(
        box([0.04, 0.43, 0.04], wood, { p: [side * 0.19, 0.215, 0.19], tint: true }),
        box([0.04, 0.9, 0.04], wood, { p: [side * 0.19, 0.45, -0.2], tint: true }),
        box([0.025, 0.025, 0.36], wood, { p: [side * 0.19, 0.15, 0], tint: true }),
      );
    }
    for (const x of [-0.09, 0, 0.09]) parts.push(box([0.03, 0.22, 0.02], wood, { p: [x, 0.72, -0.2], tint: true }));
    return finish(group(parts), "chair");
  },

  "monitor": (opts) => {
    const shell = mat(opts.color || "#1d2220", "plastic");
    const { face, setScreen } = screenFace([0.564, 0.317], { p: [0, 0.306, 0.0095] });
    const root = group([
      box([0.26, 0.016, 0.18], shell, { p: [0, 0.008, 0], tint: true }),
      box([0.05, 0.26, 0.025], shell, { p: [0, 0.14, -0.045], tint: true }),
      box([0.3, 0.2, 0.03], shell, { p: [0, 0.3, -0.03], tint: true }),
      box([0.6, 0.36, 0.028], shell, { p: [0, 0.3, -0.005], tint: true }),
      face,
      box([0.012, 0.004, 0.004], lime(), { p: [0.255, 0.131, 0.01] }),
    ]);
    root.userData.setScreen = setScreen;
    return finish(root, "monitor");
  },

  "screen": (opts) => {
    const frame = mat(opts.color || "#1b1f1d", "plastic");
    const dark = charcoal();
    const { face, setScreen } = screenFace([1.92, 1.08], { p: [0, 1.32, 0.031] });
    const root = group([
      box([1.0, 0.05, 0.6], dark, { p: [0, 0.025, 0] }),
      box([0.9, 0.012, 0.5], mat("#3a423c", "plastic"), { p: [0, 0.056, 0] }),
      box([0.07, 1.2, 0.05], frame, { p: [-0.32, 0.65, -0.07], tint: true }),
      box([0.07, 1.2, 0.05], frame, { p: [0.32, 0.65, -0.07], tint: true }),
      box([0.72, 0.3, 0.04], dark, { p: [0, 1.25, -0.05] }),
      box([2.0, 1.16, 0.06], frame, { p: [0, 1.32, 0], tint: true }),
      face,
      box([0.03, 0.008, 0.004], lime(), { p: [0.9, 0.756, 0.031] }),
      box([0.16, 0.02, 0.03], blackPlastic(), { p: [0, 1.91, 0.012] }),
    ]);
    root.userData.setScreen = setScreen;
    return finish(root, "screen");
  },

  "whiteboard": (opts) => {
    const frame = mat(opts.color || "#9ea5a0", "plastic");
    const trim = mat("#b9beba", "plastic");
    const panel = textPanel([1.68, 1.02], {
      width: 1024, height: 622, text: opts.text || "", size: 60, weight: "700", color: INK, bg: "#f4f6f1",
      padding: 44, lineHeight: 1.18, font: MARKER_FONT,
    }, { p: [0, 1.32, 0.0155] });
    const parts = [
      box([1.72, 1.06, 0.03], mat("#f4f6f1", "plastic"), { p: [0, 1.32, 0] }),
      panel,
      box([1.76, 0.03, 0.04], trim, { p: [0, 1.865, 0] }),
      box([1.76, 0.03, 0.04], trim, { p: [0, 0.775, 0] }),
      box([1.72, 0.03, 0.03], frame, { p: [0, 0.35, 0], tint: true }),
      box([0.9, 0.02, 0.07], trim, { p: [0, 0.75, 0.045] }),
      box([0.12, 0.03, 0.05], mat("#2b302c", "fabric"), { p: [0.3, 0.775, 0.045] }),
    ];
    [[-0.3, "#1b2a4a"], [-0.16, "#b8322b"], [-0.02, "#1f6f43"]].forEach(([x, color]) => {
      parts.push(cyl([0.009, 0.009, 0.12], mat(color, "plastic"), { p: [x, 0.769, 0.045], r: [0, 0, 90], seg: 8 }));
    });
    for (const side of [-1, 1]) {
      parts.push(
        box([0.04, 1.81, 0.04], frame, { p: [side * 0.88, 0.995, 0], tint: true }),
        box([0.04, 0.04, 0.5], frame, { p: [side * 0.88, 0.07, 0], tint: true }),
        sphere(0.03, blackPlastic(), { p: [side * 0.88, 0.03, 0.25], seg: 8 }),
        sphere(0.03, blackPlastic(), { p: [side * 0.88, 0.03, -0.25], seg: 8 }),
      );
    }
    const root = group(parts);
    root.userData.setText = (text) => panel.userData.setText(text);
    return finish(root, "whiteboard");
  },

  "sticky note": (opts) => {
    const paper = mat(opts.color || "#f7e463", "matte");
    const panel = textPanel([0.29, 0.29], {
      width: 256, height: 256, text: opts.text || "", size: 38, weight: "700", color: "#24304a", bg: null,
      padding: 18, align: "center", valign: "middle", lineHeight: 1.15, font: MARKER_FONT,
    }, { p: [0, 0.23, 0.0026] });
    const root = group([
      cyl([0.045, 0.05, 0.014], charcoal(), { p: [0, 0.007, 0], seg: 14 }),
      cyl([0.0035, 0.0035, 0.07], steel(), { p: [0, 0.048, 0], seg: 6 }),
      box([0.05, 0.02, 0.012], chrome(), { p: [0, 0.084, 0] }),
      box([0.3, 0.3, 0.004], paper, { p: [0, 0.23, 0], tint: true }),
      box([0.3, 0.045, 0.0045], mat("#000000", "glass"), { p: [0, 0.3575, 0] }),
      panel,
    ]);
    root.userData.setText = (text) => panel.userData.setText(text);
    return finish(root, "sticky note");
  },

  "easel": (opts) => {
    const legs = mat(opts.color || "#6b4c32", "wood");
    const panel = textPanel([0.64, 0.84], {
      width: 512, height: 672, text: opts.text || "", size: 48, weight: "700", color: "#1f3a7a", bg: "#fbfaf4",
      padding: 30, lineHeight: 1.18, font: MARKER_FONT,
    }, { p: [0, 1.28, 0.042] });
    // The front legs and pad tilt back together around their floor contact.
    const front = group([
      box([0.035, 1.76, 0.035], legs, { p: [-0.3, 0.88, 0], tint: true }),
      box([0.035, 1.76, 0.035], legs, { p: [0.3, 0.88, 0], tint: true }),
      box([0.7, 0.96, 0.02], charcoal(), { p: [0, 1.27, 0.02] }),
      box([0.67, 0.9, 0.012], mat("#f4f2ea", "matte"), { p: [0, 1.28, 0.034] }),
      panel,
      box([0.74, 0.05, 0.05], charcoal(), { p: [0, 1.745, 0.03] }),
      cyl([0.022, 0.022, 0.66], mat("#f4f2ea", "matte"), { p: [0, 1.75, -0.02], r: [0, 0, 90], seg: 10 }),
      box([0.72, 0.03, 0.08], legs, { p: [0, 0.78, 0.06], tint: true }),
      cyl([0.008, 0.008, 0.11], mat("#1f3a7a", "plastic"), { p: [-0.12, 0.8, 0.06], r: [0, 0, 90], seg: 8 }),
      cyl([0.008, 0.008, 0.11], mat("#b8322b", "plastic"), { p: [0.05, 0.8, 0.06], r: [0, 0, 90], seg: 8 }),
    ], { p: [0, 0, 0.2], r: [-7, 0, 0] });
    const root = group([group([
      front,
      beam([0, 0.0, -0.5], [0, 1.6, 0.0], [0.03, 0.03], legs, { tint: true }),
      box([0.64, 0.025, 0.025], legs, { p: [0, 0.5, 0.15], tint: true }),
    ], { p: [0, 0, 0.148] })]);
    root.userData.setText = (text) => panel.userData.setText(text);
    return finish(root, "easel");
  },

  "floor lamp": (opts) => {
    const shade = mat(opts.color || "#f3dca2", "glow");
    const dark = charcoal();
    return finish(group([
      cyl([0.15, 0.16, 0.025], dark, { p: [0, 0.0125, 0], seg: 20 }),
      cyl([0.012, 0.012, 1.42], steel(), { p: [0, 0.735, 0], seg: 10 }),
      cyl([0.02, 0.02, 0.05], dark, { p: [0, 1.0, 0], seg: 10 }),
      cyl([0.03, 0.04, 0.04], dark, { p: [0, 1.42, 0], seg: 10 }),
      cyl([0.16, 0.21, 0.3], shade, { p: [0, 1.55, 0], seg: 20, tint: true }),
      torus([0.21, 0.006], dark, { p: [0, 1.4, 0], r: [90, 0, 0], seg: 28 }),
      torus([0.16, 0.006], dark, { p: [0, 1.7, 0], r: [90, 0, 0], seg: 24 }),
    ]), "floor lamp");
  },

  "desk lamp": (opts) => {
    const body = mat(opts.color || "#33473c", "plastic");
    const joint = charcoal();
    const base = [0, 0.03, -0.05];
    const elbow = [0, 0.27, -0.08];
    const head = [0, 0.33, 0.07];
    const at = (k) => [0, head[1] - k * Math.SQRT1_2, head[2] + k * Math.SQRT1_2]; // along the shade axis
    const aim = span(at(0.075), head); // cone apex points back at the joint, opening faces down-forward
    return finish(group([group([
      cyl([0.07, 0.075, 0.022], body, { p: [0, 0.011, -0.02], seg: 16, tint: true }),
      sphere(0.016, joint, { p: base, seg: 8 }),
      rod(base, elbow, 0.008, body, { tint: true }),
      sphere(0.014, joint, { p: elbow, seg: 8 }),
      rod(elbow, head, 0.007, body, { tint: true }),
      cone([0.055, 0.075], body, { p: at(0.0375), r: aim.r, seg: 14, tint: true }),
      cyl([0.05, 0.05, 0.004], mat("#fff1c4", "glow"), { p: at(0.077), r: aim.r, seg: 14 }),
      box([0.02, 0.01, 0.02], joint, { p: [0.03, 0.026, 0.03] }),
    ], { p: [0, 0, -0.033] })]), "desk lamp");
  },

  "couch": (opts) => {
    const fabric = mat(opts.color || "#3f5f5a", "fabric");
    return finish(sofa(2.0, 3, fabric, [
      box([0.36, 0.34, 0.12], mat("#d5fb6a", "fabric"), { p: [-0.62, 0.6, -0.08], r: [-14, 0, 10] }),
      box([0.36, 0.34, 0.12], mat("#e8e1cf", "fabric"), { p: [0.62, 0.6, -0.08], r: [-14, 0, -10] }),
    ]), "couch");
  },

  "armchair": (opts) => {
    const leather = mat(opts.color || "#7a4b32", "plastic");
    return finish(sofa(0.95, 1, leather), "armchair");
  },

  "bookshelf": (opts) => {
    const wood = mat(opts.color || "#7b5536", "wood");
    const parts = [
      box([0.03, 1.8, 0.32], wood, { p: [-0.435, 0.9, 0], tint: true }),
      box([0.03, 1.8, 0.32], wood, { p: [0.435, 0.9, 0], tint: true }),
      box([0.9, 0.03, 0.32], wood, { p: [0, 1.785, 0], tint: true }),
      box([0.84, 0.08, 0.31], wood, { p: [0, 0.04, 0.005], tint: true }),
      box([0.84, 1.7, 0.012], mat("#4a3424", "wood"), { p: [0, 0.9, -0.154] }),
    ];
    for (const y of [0.43, 0.78, 1.13, 1.46]) parts.push(box([0.84, 0.025, 0.3], wood, { p: [0, y, 0.005], tint: true }));
    return finish(group([...parts, ...books(opts.seed || 0)]), "bookshelf");
  },

  "potted plant": (opts) => {
    const pot = mat(opts.color || "#d9d4c7", "plastic");
    const leafA = mat("#3f8a3a", "leaf");
    const leafB = mat("#2f6f33", "leaf");
    const parts = [
      lathe([[0, 0], [0.14, 0], [0.155, 0.02], [0.19, 0.32], [0.2, 0.33], [0.2, 0.35], [0.185, 0.35], [0.178, 0.33], [0, 0.33]],
        pot, { seg: 18, tint: true }),
      cyl([0.179, 0.179, 0.01], mat("#3b2a1e", "matte"), { p: [0, 0.332, 0], seg: 18 }),
      cyl([0.012, 0.016, 0.66], mat("#6b4a2e", "wood"), { p: [0, 0.64, 0], seg: 8 }),
    ];
    LEAVES.forEach(([y, az, tilt, s], i) => {
      const leaf = extrude(LEAF, 0.006, i % 2 ? leafA : leafB, { p: [0, y, 0], r: [tilt, az, 0], s: [s, s, 1] });
      leaf.rotation.order = "YXZ"; // tilt outward first, then spin around the trunk
      parts.push(leaf);
    });
    return finish(group(parts), "potted plant");
  },

  "laptop": (opts) => {
    const shell = mat(opts.color || "#b8bdb7", "plastic");
    const { face, setScreen } = screenFace([0.31, 0.19], { p: [0, 0.118, 0.0007] }, laptopScreenMaterial());
    const lid = group([
      box([0.34, 0.225, 0.008], shell, { p: [0, 0.1125, -0.004], tint: true }),
      plane([0.33, 0.215], blackPlastic(), { p: [0, 0.1125, 0.0003] }),
      face,
      cyl([0.018, 0.018, 0.001], lime(), { p: [0, 0.12, -0.0085], r: [90, 0, 0], seg: 12 }),
    ], { p: [0, 0.016, -0.085], r: [-20, 0, 0] });
    const root = group([
      box([0.34, 0.016, 0.235], shell, { p: [0, 0.008, 0.03], tint: true }),
      box([0.29, 0.002, 0.105], mat("#1d201e", "plastic"), { p: [0, 0.0165, 0.005] }),
      box([0.1, 0.002, 0.065], mat("#9ea59d", "plastic"), { p: [0, 0.0165, 0.1] }),
      box([0.3, 0.004, 0.004], mat("#7f857e", "plastic"), { p: [0, 0.006, 0.1475] }),
      lid,
    ]);
    root.userData.setScreen = setScreen;
    return finish(root, "laptop");
  },

  "filing cabinet": (opts) => {
    const paint = mat(opts.color || "#8b938c", "plastic");
    const label = mat("#e9e6d6", "matte");
    const parts = [
      box([0.46, 1.32, 0.6], paint, { p: [0, 0.66, -0.01], tint: true }),
      box([0.44, 0.035, 0.01], mat("#20231f", "plastic"), { p: [0, 0.018, 0.29] }),
      cyl([0.012, 0.012, 0.01], chrome(), { p: [0.17, 1.27, 0.295], r: [90, 0, 0], seg: 10 }),
    ];
    for (let i = 0; i < 4; i++) {
      const y = 0.1975 + i * 0.32;
      parts.push(
        box([0.43, 0.3, 0.02], paint, { p: [0, y, 0.3], tint: true }),
        box([0.16, 0.024, 0.024], chrome(), { p: [0, y + 0.06, 0.32] }),
        box([0.08, 0.035, 0.004], label, { p: [0, y + 0.11, 0.311] }),
      );
    }
    return finish(group(parts), "filing cabinet");
  },

  "conference table": (opts) => {
    const wood = mat(opts.color || "#6e4b33", "wood");
    const dark = charcoal();
    const outline = [];
    const half = 1.1;
    const r = 0.7;
    for (let i = 0; i <= 10; i++) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI;
      outline.push([half + Math.cos(a) * r, Math.sin(a) * r]);
    }
    for (let i = 0; i <= 10; i++) {
      const a = Math.PI / 2 + (i / 10) * Math.PI;
      outline.push([-half + Math.cos(a) * r, Math.sin(a) * r]);
    }
    const parts = [
      extrude(outline, 0.05, wood, { p: [0, 0.735, 0], r: [-90, 0, 0], tint: true }),
      box([2.2, 0.004, 0.32], mat("#232825", "fabric"), { p: [0, 0.761, 0] }),
      box([2.3, 0.08, 0.06], dark, { p: [0, 0.63, 0] }),
    ];
    for (const x of [-1.15, 1.15]) {
      parts.push(
        box([0.08, 0.69, 0.86], dark, { p: [x, 0.365, 0] }),
        box([0.12, 0.02, 0.96], mat("#141614", "plastic"), { p: [x, 0.01, 0] }),
      );
    }
    for (const x of [-0.8, 0, 0.8]) parts.push(box([0.14, 0.004, 0.06], lime(), { p: [x, 0.764, 0] }));
    return finish(group(parts), "conference table");
  },

  "coffee table": (opts) => {
    const wood = mat(opts.color || "#8f6640", "wood");
    const legs = mat("#3a2a1d", "wood");
    const parts = [
      box([1.1, 0.04, 0.6], wood, { p: [0, 0.4, 0], tint: true }),
      box([0.98, 0.02, 0.5], wood, { p: [0, 0.12, 0], tint: true }),
      box([0.22, 0.012, 0.28], mat("#e2ddd0", "matte"), { p: [-0.24, 0.136, 0], r: [0, 12, 0] }),
      box([0.2, 0.012, 0.27], mat("#c8643c", "matte"), { p: [-0.2, 0.148, 0.02], r: [0, -8, 0] }),
    ];
    for (const x of [-0.5, 0.5]) {
      for (const z of [-0.24, 0.24]) parts.push(cyl([0.024, 0.014, 0.38], legs, { p: [x, 0.19, z], seg: 10 }));
    }
    return finish(group(parts), "coffee table");
  },

  "coffee mug": (opts) => {
    const glaze = mat(opts.color || "#eeebe3", "plastic");
    return finish(group([
      lathe([[0, 0], [0.038, 0], [0.041, 0.004], [0.042, 0.095], [0.037, 0.095], [0.036, 0.012], [0, 0.012]],
        glaze, { p: [-0.022, 0, 0], seg: 18, tint: true }),
      cyl([0.0425, 0.0425, 0.012], mat("#d5fb6a", "plastic"), { p: [-0.022, 0.072, 0], seg: 18 }),
      cyl([0.0365, 0.0365, 0.003], mat("#3b2416", "plastic"), { p: [-0.022, 0.08, 0], seg: 16 }),
      torus([0.024, 0.0065], glaze, { p: [0.032, 0.05, 0], seg: 16, tint: true }),
    ]), "coffee mug");
  },

  "lectern": (opts) => {
    const wood = mat(opts.color || "#5e4330", "wood");
    const dark = mat("#3a2a1d", "wood");
    // Side profile (z, y) extruded across x; front (audience side) is +Z, reading top slopes toward the speaker.
    const profile = [[-0.2, 0.06], [0.2, 0.06], [0.2, 1.1], [-0.2, 1.02]];
    const tilt = Math.atan2(0.08, 0.4) / DEG;
    const parts = [
      box([0.7, 0.06, 0.55], dark, { p: [0, 0.03, 0] }),
      extrude(profile, 0.56, wood, { r: [0, -90, 0], tint: true }),
      box([0.66, 0.03, 0.5], wood, { p: [0, 1.075, 0.0], r: [-tilt, 0, 0], tint: true }),
      box([0.44, 0.55, 0.006], dark, { p: [0, 0.5, 0.203] }),
      box([0.5, 0.02, 0.006], lime(), { p: [0, 0.86, 0.203] }),
      torus([0.06, 0.007], lime(), { p: [0, 0.68, 0.21], seg: 20 }),
      box([0.21, 0.004, 0.28], mat("#f4f6f1", "matte"), { p: [-0.06, 1.0905, -0.01], r: [-tilt, 0, 0] }),
      rod([0.22, 1.06, -0.13], [0.2, 1.24, -0.22], 0.006, charcoal()),
    ];
    const mic = span([0.2, 1.24, -0.22], [0.19, 1.27, -0.27]);
    parts.push(capsule([0.014, 0.03], blackPlastic(), { p: mic.p, r: mic.r }));
    return finish(group(parts), "lectern");
  },

  "trash can": (opts) => {
    const shell = mat(opts.color || "#3d4a40", "plastic");
    return finish(group([
      lathe([[0, 0], [0.12, 0], [0.125, 0.006], [0.155, 0.38], [0.15, 0.38], [0.147, 0.375], [0.117, 0.012], [0, 0.012]],
        shell, { seg: 18, tint: true }),
      torus([0.153, 0.007], shell, { p: [0, 0.38, 0], r: [90, 0, 0], seg: 24, tint: true }),
      sphere(0.05, mat("#f2f0e8", "matte"), { p: [0.03, 0.33, -0.02], seg: 6 }),
      sphere(0.04, mat("#e6e2d4", "matte"), { p: [-0.05, 0.35, 0.03], seg: 5 }),
    ]), "trash can");
  },

  "water cooler": (opts) => {
    const shell = mat(opts.color || "#e6e9e3", "plastic");
    return finish(group([group([
      box([0.3, 0.95, 0.3], shell, { p: [0, 0.475, 0], tint: true }),
      box([0.2, 0.22, 0.01], charcoal(), { p: [0, 0.72, 0.151] }),
      box([0.035, 0.035, 0.04], mat("#2f6fd0", "plastic"), { p: [-0.05, 0.79, 0.17] }),
      box([0.035, 0.035, 0.04], mat("#c8323a", "plastic"), { p: [0.05, 0.79, 0.17] }),
      box([0.18, 0.02, 0.06], mat("#9aa19a", "plastic"), { p: [0, 0.63, 0.18] }),
      box([0.24, 0.12, 0.004], mat("#d0d4ce", "plastic"), { p: [0, 0.3, 0.152] }),
      cyl([0.08, 0.1, 0.05], shell, { p: [0, 0.975, 0], seg: 16, tint: true }),
      cyl([0.035, 0.035, 0.22], mat("#f4f6f1", "plastic"), { p: [0.175, 0.7, 0], seg: 12 }),
      lathe([[0, 1.0], [0.03, 1.0], [0.13, 1.085], [0.132, 1.28], [0, 1.28]], mat("#4aa3df", "glass"), { seg: 16 }),
      lathe([[0.03, 0.97], [0.035, 1.03], [0.135, 1.08], [0.14, 1.32], [0.11, 1.362], [0, 1.366]], mat("#bfe3ff", "glass"), { seg: 16 }),
      torus([0.141, 0.004], mat("#bfe3ff", "glass"), { p: [0, 1.16, 0], r: [90, 0, 0], seg: 24 }),
      torus([0.141, 0.004], mat("#bfe3ff", "glass"), { p: [0, 1.24, 0], r: [90, 0, 0], seg: 24 }),
    ], { p: [-0.03, 0, -0.03] })]), "water cooler");
  },

  "rug": (opts) => {
    const field = mat(opts.color || "#8c3b32", "fabric");
    const cream = mat("#e9dcc0", "fabric");
    const navy = mat("#27384d", "fabric");
    const parts = [
      box([2.3, 0.012, 1.6], cream, { p: [0, 0.006, 0] }),
      box([2.12, 0.016, 1.42], navy, { p: [0, 0.008, 0] }),
      box([2.04, 0.018, 1.34], field, { p: [0, 0.009, 0], tint: true }),
      box([0.62, 0.02, 0.62], cream, { p: [0, 0.01, 0], r: [0, 45, 0] }),
      box([0.36, 0.021, 0.36], navy, { p: [0, 0.0105, 0], r: [0, 45, 0] }),
    ];
    for (const side of [-1, 1]) {
      parts.push(box([0.05, 0.004, 1.5], cream, { p: [side * 1.175, 0.002, 0] }));
      parts.push(box([0.6, 0.019, 0.05], cream, { p: [side * 0.62, 0.0095, 0] }));
    }
    return finish(group(parts), "rug");
  },
};
