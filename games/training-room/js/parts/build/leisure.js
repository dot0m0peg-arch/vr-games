// leisure parts: builders keyed by meta name (see ARCHITECTURE.md).
import { kit } from "./kit.js";
import { makeCanvas, canvasTexture, roundRect, hasCanvas, FONT } from "../../util/text.js";

const { THREE, box, cyl, sphere, torus, capsule, plane, lathe, extrude, group, textPanel, mat, finish, DEG } = kit;

const charcoal = () => mat("#2b302c", "plastic");
const blackPlastic = () => mat("#161917", "plastic");
const steel = () => mat("#c9cdc6", "metal");
const chrome = () => mat("#dfe3dc", "plastic");
const lime = () => mat("#d5fb6a", "glow");

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

// Materials with canvas textures are shared across instances and never disposed by kit.disposeObject.
function sharedTextureMaterial(canvas, fallback, extra = {}) {
  if (!canvas) return mat(fallback, "plastic");
  const material = new THREE.MeshStandardMaterial({ map: canvasTexture(canvas), roughness: 0.55, ...extra });
  material.userData.shared = true;
  material.userData.kind = "plastic";
  return material;
}

const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });
HIDDEN.userData.shared = true;
// Wireframe lathe reads as a hoop net (its own copy of the cloth material, so it stays textured and never casts).
const NET = mat("#f4f4f0", "fabric").clone();
NET.wireframe = true;
NET.userData.shared = true;

// ---------------------------------------------------------------- playing cards
// Card code: rank (A23456789TJQK) + suit (SHDC), e.g. "AS", "TH".
const CARD_W = 0.063;
const CARD_D = 0.088;
const TEX_W = 160;
const TEX_H = 224;
const CARD_RE = /^[A2-9TJQK][SHDC]$/;
const RED = "#c8202f";
const BLACK = "#16181a";

function drawSuit(ctx, suit, x, y, size, flip = false) {
  ctx.save();
  ctx.translate(x, y);
  if (flip) ctx.rotate(Math.PI);
  ctx.scale(size / 100, size / 100);
  ctx.beginPath();
  if (suit === "D") {
    ctx.moveTo(0, -50);
    ctx.lineTo(36, 0);
    ctx.lineTo(0, 50);
    ctx.lineTo(-36, 0);
    ctx.closePath();
  } else if (suit === "H") {
    ctx.moveTo(0, 46);
    ctx.bezierCurveTo(-30, 20, -50, 0, -50, -20);
    ctx.bezierCurveTo(-50, -45, -15, -50, 0, -25);
    ctx.bezierCurveTo(15, -50, 50, -45, 50, -20);
    ctx.bezierCurveTo(50, 0, 30, 20, 0, 46);
  } else if (suit === "S") {
    ctx.moveTo(0, -48);
    ctx.bezierCurveTo(30, -20, 50, -5, 50, 14);
    ctx.bezierCurveTo(50, 36, 18, 40, 5, 22);
    ctx.lineTo(15, 48);
    ctx.lineTo(-15, 48);
    ctx.lineTo(-5, 22);
    ctx.bezierCurveTo(-18, 40, -50, 36, -50, 14);
    ctx.bezierCurveTo(-50, -5, -30, -20, 0, -48);
  } else {
    for (const [cx, cy] of [[0, -24], [-24, 10], [24, 10]]) {
      ctx.moveTo(cx + 22, cy);
      ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    }
    ctx.moveTo(0, 0);
    ctx.lineTo(15, 48);
    ctx.lineTo(-15, 48);
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
}

const L = 0.18;
const M = 0.5;
const R = 0.82;
const PIPS = {
  2: [[M, 0], [M, 1]],
  3: [[M, 0], [M, 0.5], [M, 1]],
  4: [[L, 0], [R, 0], [L, 1], [R, 1]],
  5: [[L, 0], [R, 0], [M, 0.5], [L, 1], [R, 1]],
  6: [[L, 0], [R, 0], [L, 0.5], [R, 0.5], [L, 1], [R, 1]],
  7: [[L, 0], [R, 0], [M, 0.25], [L, 0.5], [R, 0.5], [L, 1], [R, 1]],
  8: [[L, 0], [R, 0], [M, 0.25], [L, 0.5], [R, 0.5], [M, 0.75], [L, 1], [R, 1]],
  9: [[L, 0], [R, 0], [L, 1 / 3], [R, 1 / 3], [M, 0.5], [L, 2 / 3], [R, 2 / 3], [L, 1], [R, 1]],
  10: [[L, 0], [R, 0], [M, 1 / 6], [L, 1 / 3], [R, 1 / 3], [L, 2 / 3], [R, 2 / 3], [M, 5 / 6], [L, 1], [R, 1]],
};

function cardBase(ctx) {
  ctx.clearRect(0, 0, TEX_W, TEX_H);
  ctx.fillStyle = "#fbfaf6";
  roundRect(ctx, 1, 1, TEX_W - 2, TEX_H - 2, 12);
  ctx.fill();
  ctx.strokeStyle = "#cfcabc";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawFace(ctx, code) {
  const rank = code[0];
  const suit = code[1];
  const color = suit === "H" || suit === "D" ? RED : BLACK;
  const label = rank === "T" ? "10" : rank;
  cardBase(ctx);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const flip of [false, true]) {
    ctx.save();
    if (flip) {
      ctx.translate(TEX_W, TEX_H);
      ctx.rotate(Math.PI);
    }
    ctx.font = `700 ${label.length > 1 ? 26 : 30}px ${FONT}`;
    ctx.fillText(label, 21, 9);
    drawSuit(ctx, suit, 21, 52, 18);
    ctx.restore();
  }
  if (rank === "A") {
    drawSuit(ctx, suit, TEX_W / 2, TEX_H / 2, suit === "S" ? 84 : 70);
  } else if ("JQK".includes(rank)) {
    ctx.fillStyle = "#f2eddc";
    ctx.fillRect(38, 34, 84, 156);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(38, 34, 84, 156);
    ctx.fillStyle = "#d5fb6a";
    ctx.fillRect(42, 104, 76, 16);
    ctx.fillStyle = color;
    ctx.font = `700 64px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.fillText(rank, TEX_W / 2, TEX_H / 2 + 3);
    drawSuit(ctx, suit, 54, 50, 22);
    drawSuit(ctx, suit, 106, 174, 22, true);
  } else {
    const n = rank === "T" ? 10 : Number(rank);
    for (const [fx, fy] of PIPS[n]) drawSuit(ctx, suit, 40 + fx * 80, 42 + fy * 140, 26, fy > 0.5);
  }
}

function drawBack(ctx, accent) {
  cardBase(ctx);
  ctx.save();
  ctx.fillStyle = "#101412";
  roundRect(ctx, 9, 9, TEX_W - 18, TEX_H - 18, 8);
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.32;
  ctx.lineWidth = 2;
  for (let d = -TEX_H; d < TEX_W + TEX_H; d += 16) {
    ctx.beginPath();
    ctx.moveTo(d, 0);
    ctx.lineTo(d + TEX_H, TEX_H);
    ctx.moveTo(d, 0);
    ctx.lineTo(d - TEX_H, TEX_H);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  roundRect(ctx, 16, 16, TEX_W - 32, TEX_H - 32, 6);
  ctx.stroke();
  ctx.fillStyle = "#101412";
  ctx.beginPath();
  ctx.arc(TEX_W / 2, TEX_H / 2, 30, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(TEX_W / 2, TEX_H / 2 - 24);
  ctx.lineTo(TEX_W / 2 + 17, TEX_H / 2);
  ctx.lineTo(TEX_W / 2, TEX_H / 2 + 24);
  ctx.lineTo(TEX_W / 2 - 17, TEX_H / 2);
  ctx.closePath();
  ctx.fill();
}

const faceCache = new Map();
const backCache = new Map();

function faceMaterial(code) {
  let material = faceCache.get(code);
  if (!material) {
    const canvas = makeCanvas(TEX_W, TEX_H);
    if (canvas) drawFace(canvas.getContext("2d"), code);
    material = sharedTextureMaterial(canvas, "#fbfaf6");
    faceCache.set(code, material);
  }
  return material;
}

function backMaterial(accent) {
  let material = backCache.get(accent);
  if (!material) {
    const canvas = makeCanvas(TEX_W, TEX_H);
    if (canvas) drawBack(canvas.getContext("2d"), accent);
    material = sharedTextureMaterial(canvas, "#22302a");
    backCache.set(accent, material);
  }
  return material;
}

const cardCode = (code) => {
  const c = String(code || "").toUpperCase().replace(/^10/, "T");
  return CARD_RE.test(c) ? c : null;
};

// ---------------------------------------------------------------- dice, chess, chips textures
// Transparent pip decals (alpha-tested) so the tinted die body color shows through.
const pipCache = new Map();
const PIP_SPOTS = {
  1: [[0.5, 0.5]],
  2: [[0.25, 0.25], [0.75, 0.75]],
  3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
  4: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]],
  5: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]],
  6: [[0.25, 0.22], [0.25, 0.5], [0.25, 0.78], [0.75, 0.22], [0.75, 0.5], [0.75, 0.78]],
};
function pipMaterials(ink) {
  if (pipCache.has(ink)) return pipCache.get(ink);
  let list = null;
  if (hasCanvas()) {
    list = [null];
    for (let n = 1; n <= 6; n++) {
      const canvas = makeCanvas(64, 64);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = n === 1 && ink !== "#f4f1ea" ? "#c8202f" : ink;
      for (const [x, y] of PIP_SPOTS[n]) {
        ctx.beginPath();
        ctx.arc(x * 64, y * 64, n === 1 ? 9 : 6.5, 0, Math.PI * 2);
        ctx.fill();
      }
      list.push(sharedTextureMaterial(canvas, ink, { alphaTest: 0.5 }));
    }
  }
  pipCache.set(ink, list);
  return list;
}

function luminance(hex) {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

// faces: [+x, -x, +y, -y, +z, -z] pip counts (opposite faces sum to 7).
function die(faces, body, pips, o) {
  const s = 0.03;
  const e = s / 2 + 0.0004;
  const children = [box([s, s, s], body, { p: [0, s / 2, 0], tint: true })];
  if (pips) {
    const spots = [
      [[e, s / 2, 0], [0, 90, 0]], [[-e, s / 2, 0], [0, -90, 0]],
      [[0, s + 0.0004, 0], [-90, 0, 0]], [[0, -0.0004, 0], [90, 0, 0]],
      [[0, s / 2, e], [0, 0, 0]], [[0, s / 2, -e], [0, 180, 0]],
    ];
    spots.forEach(([p, r], i) => children.push(plane([0.027, 0.027], pips[faces[i]], { p, r })));
  }
  return group(children, o);
}

let chessMaterial = null;
function chessTop() {
  if (chessMaterial) return chessMaterial;
  const canvas = makeCanvas(256, 256);
  if (canvas) {
    const ctx = canvas.getContext("2d");
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        ctx.fillStyle = (i + j) % 2 ? "#5f7f4f" : "#ece6cf";
        ctx.fillRect(i * 32, j * 32, 32, 32);
      }
    }
  }
  chessMaterial = sharedTextureMaterial(canvas, "#d9c9a3", { roughness: 0.5 });
  return chessMaterial;
}

const CHIP_H = 0.0035;
const chipCache = new Map();
// Side decal for an n-chip stack: thin seams and staggered white edge spots.
function chipOverlay(n) {
  if (chipCache.has(n)) return chipCache.get(n);
  let material = null;
  const canvas = makeCanvas(128, n * 12);
  if (canvas) {
    const ctx = canvas.getContext("2d");
    for (let k = 0; k < n; k++) {
      const top = k * 12;
      ctx.fillStyle = "#0d0f0e";
      ctx.fillRect(0, top, 128, 1);
      ctx.fillStyle = "#f4f1e8";
      const offset = (k * 37) % 21;
      for (let i = -1; i < 6; i++) ctx.fillRect(offset + i * 21.33, top + 3, 9, 7);
    }
    const side = sharedTextureMaterial(canvas, "#ffffff", { alphaTest: 0.5 });
    material = [side, HIDDEN, HIDDEN];
  }
  chipCache.set(n, material);
  return material;
}

function chipStack(n, color, tint, x, z) {
  const h = n * CHIP_H;
  const bodyMat = mat(color, "plastic");
  const parts = [
    cyl([0.02, 0.02, h], bodyMat, { p: [x, h / 2, z], seg: 18, tint }),
    cyl([0.0135, 0.0135, 0.0008], mat("#f4f1e8", "plastic"), { p: [x, h + 0.0004, z], seg: 18 }),
  ];
  const overlay = chipOverlay(n);
  if (overlay) {
    const decal = cyl([0.02, 0.02, h], bodyMat, { p: [x, h / 2, z], seg: 18, s: [1.012, 1, 1.012] });
    decal.material = overlay;
    parts.push(decal);
  }
  return parts;
}

// ---------------------------------------------------------------- chess pieces (lathe profiles, meters)
const PIECES = {
  pawn: [[0, 0], [0.0135, 0], [0.0135, 0.004], [0.01, 0.007], [0.0065, 0.018], [0.0095, 0.021], [0.0065, 0.023], [0.0085, 0.026],
    [0.0095, 0.03], [0.0085, 0.034], [0.005, 0.037], [0, 0.038]],
  rook: [[0, 0], [0.0145, 0], [0.0145, 0.004], [0.011, 0.008], [0.009, 0.03], [0.0125, 0.032], [0.0125, 0.044], [0.008, 0.044],
    [0.008, 0.04], [0, 0.04]],
  bishop: [[0, 0], [0.0145, 0], [0.0145, 0.004], [0.0105, 0.008], [0.0065, 0.032], [0.0105, 0.034], [0.0065, 0.037], [0.0085, 0.042],
    [0.009, 0.047], [0.007, 0.053], [0.003, 0.057], [0.0035, 0.059], [0, 0.061]],
  queen: [[0, 0], [0.016, 0], [0.016, 0.005], [0.0115, 0.009], [0.007, 0.04], [0.0115, 0.043], [0.0075, 0.046], [0.0095, 0.055],
    [0.0115, 0.06], [0.008, 0.061], [0.0045, 0.064], [0.0045, 0.066], [0, 0.068]],
  king: [[0, 0], [0.016, 0], [0.016, 0.005], [0.0115, 0.009], [0.0075, 0.042], [0.0115, 0.045], [0.008, 0.048], [0.0105, 0.058],
    [0.0105, 0.06], [0, 0.061]],
  knight: [[0, 0], [0.0145, 0], [0.0145, 0.004], [0.0105, 0.008], [0.009, 0.016], [0, 0.016]],
};

function chessPiece(type, material, file, rank) {
  const p = [-0.175 + file * 0.05, 0.025, 0.175 - (rank - 1) * 0.05];
  const facing = rank <= 2 ? 180 : 0; // white sits at +Z and faces -Z
  const parts = [lathe(PIECES[type], material, { seg: 10 })];
  if (type === "king") {
    parts.push(
      box([0.004, 0.016, 0.004], material, { p: [0, 0.068, 0] }),
      box([0.012, 0.004, 0.004], material, { p: [0, 0.07, 0] }),
    );
  } else if (type === "knight") {
    parts.push(
      box([0.011, 0.034, 0.016], material, { p: [0, 0.03, -0.002], r: [-14, 0, 0] }),
      box([0.01, 0.011, 0.022], material, { p: [0, 0.04, 0.009], r: [12, 0, 0] }),
    );
  }
  return parts.length === 1 ? setPose(parts[0], p, facing) : group(parts, { p, r: [0, facing, 0] });
}
function setPose(object, p, ry) {
  object.position.set(p[0], p[1], p[2]);
  object.rotation.set(0, ry * DEG, 0);
  return object;
}

// ---------------------------------------------------------------- soccer ball panels
const PHI = (1 + Math.sqrt(5)) / 2;
const ICOSA = [[0, 1, PHI], [0, 1, -PHI], [0, -1, PHI], [0, -1, -PHI], [1, PHI, 0], [1, -PHI, 0], [-1, PHI, 0], [-1, -PHI, 0],
  [PHI, 0, 1], [PHI, 0, -1], [-PHI, 0, 1], [-PHI, 0, -1]].map((v) => {
  const l = Math.hypot(...v);
  return v.map((n) => n / l);
});

export const builders = {
  "card table": (opts) => {
    const felt = mat(opts.color || "#2f6b3a", "felt");
    const wood = mat("#3a2a1d", "wood");
    const rail = mat("#151816", "plastic");
    const line = mat("#d8c27a", "matte");
    const parts = [
      box([1.0, 0.04, 1.0], wood, { p: [0, 0.72, 0] }),
      box([0.88, 0.022, 0.88], felt, { p: [0, 0.749, 0], tint: true }),
      box([0.9, 0.08, 0.9], wood, { p: [0, 0.66, 0] }),
      box([1.0, 0.04, 0.06], rail, { p: [0, 0.76, 0.47] }),
      box([1.0, 0.04, 0.06], rail, { p: [0, 0.76, -0.47] }),
      box([0.06, 0.04, 0.88], rail, { p: [0.47, 0.76, 0] }),
      box([0.06, 0.04, 0.88], rail, { p: [-0.47, 0.76, 0] }),
      box([0.66, 0.002, 0.008], line, { p: [0, 0.7605, 0.33] }),
      box([0.66, 0.002, 0.008], line, { p: [0, 0.7605, -0.33] }),
      box([0.008, 0.002, 0.66], line, { p: [0.33, 0.7605, 0] }),
      box([0.008, 0.002, 0.66], line, { p: [-0.33, 0.7605, 0] }),
    ];
    for (const x of [-0.42, 0.42]) {
      for (const z of [-0.42, 0.42]) parts.push(cyl([0.026, 0.018, 0.62], wood, { p: [x, 0.31, z], seg: 10 }));
    }
    return finish(group(parts), "card table");
  },

  "deck of cards": (opts) => {
    const back = backMaterial(opts.color || "#d5fb6a");
    const stack = box([CARD_W, 0.017, CARD_D], mat("#ecebe4", "paper"), { p: [0, 0.0085, 0] });
    const top = plane([CARD_W - 0.001, CARD_D - 0.001], back, { p: [0, 0.0173, 0], r: [-90, 0, 0] });
    const root = group([stack, top]);
    // data.cards: remaining card codes (missing = full deck). Height follows the count; empty hides the deck.
    root.userData.setDeck = (data = {}) => {
      const count = Array.isArray(data.cards) ? data.cards.length : 52;
      const visible = count > 0;
      const h = Math.max(0.002, (0.017 * count) / 52);
      stack.visible = visible;
      top.visible = visible;
      stack.scale.y = h / 0.017;
      stack.position.y = h / 2;
      top.position.y = h + 0.0003;
    };
    root.userData.setDeck(opts.data || {});
    return finish(root, "deck of cards");
  },

  "playing card": (opts) => {
    const back = backMaterial(opts.color || "#d5fb6a");
    const top = plane([CARD_W, CARD_D], back, { p: [0, 0.0017, 0], r: [-90, 0, 0] });
    const bottom = plane([CARD_W, CARD_D], back, { p: [0, 0.0003, 0], r: [90, 0, 0] });
    const root = group([box([CARD_W, 0.001, CARD_D], mat("#f4f2ea", "paper"), { p: [0, 0.001, 0] }), top, bottom]);
    // data: { card: "TH", faceUp }; the hidden side always shows the other face.
    root.userData.setDeck = (data = {}) => {
      const face = faceMaterial(cardCode(data.card) || "AS");
      const faceUp = data.faceUp === undefined ? true : !!data.faceUp;
      top.material = faceUp ? face : back;
      bottom.material = faceUp ? back : face;
    };
    root.userData.setDeck(opts.data || {});
    return finish(root, "playing card");
  },

  "dice": (opts) => {
    const color = opts.color || "#f4f1ea";
    const body = mat(color, "plastic");
    const pips = pipMaterials(luminance(color) < 0.35 ? "#f4f1ea" : "#16181a");
    return finish(group([
      die([3, 4, 6, 1, 5, 2], body, pips, { p: [-0.021, 0, 0.0], r: [0, -8, 0] }),
      die([6, 1, 3, 4, 2, 5], body, pips, { p: [0.021, 0, 0.0], r: [0, 28, 0] }),
    ]), "dice");
  },

  "chess board": (opts) => {
    const wood = mat(opts.color || "#5a3b25", "wood");
    const ivory = mat("#efe6d2", "plastic");
    const ebony = mat("#2a2522", "plastic");
    const parts = [
      box([0.45, 0.025, 0.45], wood, { p: [0, 0.0125, 0], tint: true }),
      plane([0.4, 0.4], chessTop(), { p: [0, 0.0253, 0], r: [-90, 0, 0] }),
    ];
    // A quiet Italian-game middlegame: [type, file 0-7, rank 1-8]
    const white = [["king", 6, 1], ["rook", 5, 1], ["queen", 4, 2], ["bishop", 2, 4], ["knight", 5, 3], ["pawn", 4, 4], ["pawn", 5, 2], ["pawn", 6, 2]];
    const black = [["king", 6, 8], ["rook", 5, 8], ["queen", 3, 8], ["bishop", 1, 4], ["knight", 2, 6], ["pawn", 4, 5], ["pawn", 5, 7], ["pawn", 6, 7]];
    for (const [type, f, r] of white) parts.push(chessPiece(type, ivory, f, r));
    for (const [type, f, r] of black) parts.push(chessPiece(type, ebony, f, r));
    return finish(group(parts), "chess board");
  },

  "poker chips": (opts) => finish(group([
    ...chipStack(12, opts.color || "#b8322b", true, -0.022, 0.012),
    ...chipStack(8, "#2f5fb3", false, 0.022, 0.012),
    ...chipStack(5, "#1d1f1e", false, 0, -0.026),
  ]), "poker chips"),

  "ball": (opts) => {
    const skin = mat(opts.color || "#f2f2ee", "leather", "plastic");
    const patch = mat("#1a1c1b", "leather", "plastic");
    const parts = [sphere(0.11, skin, { p: [0, 0.11, 0], seg: 20, tint: true })];
    for (const d of ICOSA) {
      const s = span([0, 0, 0], d);
      parts.push(cyl([0.033, 0.033, 0.012], patch, { p: [d[0] * 0.104, 0.11 + d[1] * 0.104, d[2] * 0.104], r: s.r, seg: 5 }));
    }
    return finish(group(parts), "ball");
  },

  "basketball": (opts) => {
    const skin = mat(opts.color || "#d4692a", "leather", "matte");
    const seam = mat("#1a1c1b", "leather", "matte");
    return finish(group([
      sphere(0.12, skin, { p: [0, 0.12, 0], seg: 20, tint: true }),
      torus([0.1205, 0.0022], seam, { p: [0, 0.12, 0], r: [90, 0, 0], seg: 24 }),
      torus([0.1205, 0.0022], seam, { p: [0, 0.12, 0], seg: 24 }),
      torus([0.094, 0.0022], seam, { p: [0, 0.12, 0.075], seg: 20 }),
      torus([0.094, 0.0022], seam, { p: [0, 0.12, -0.075], seg: 20 }),
    ]), "basketball");
  },

  "basketball hoop": (opts) => {
    const frame = mat(opts.color || "#334039", "plastic");
    const orange = mat("#e0532b", "plastic");
    const board = mat("#f4f6f1", "plastic");
    const z = 0.085; // re-centers the bounding box on the origin
    const rimZ = 0.495 + z;
    const parts = [
      box([0.7, 0.18, 0.9], frame, { p: [0, 0.09, -0.45 + z], tint: true }),
      box([0.6, 0.02, 0.8], charcoal(), { p: [0, 0.19, -0.45 + z] }),
      cyl([0.05, 0.05, 3.32], frame, { p: [0, 1.84, -0.4 + z], seg: 12, tint: true }),
      box([0.05, 0.05, 0.48], frame, { p: [0, 3.15, -0.16 + z], tint: true }),
      box([0.05, 0.05, 0.48], frame, { p: [0, 3.45, -0.16 + z], tint: true }),
      box([1.1, 0.75, 0.04], board, { p: [0, 3.3, 0.1 + z] }),
      box([1.1, 0.03, 0.044], frame, { p: [0, 3.66, 0.1 + z], tint: true }),
      box([1.1, 0.03, 0.044], frame, { p: [0, 2.94, 0.1 + z], tint: true }),
      box([0.03, 0.75, 0.044], frame, { p: [-0.535, 3.3, 0.1 + z], tint: true }),
      box([0.03, 0.75, 0.044], frame, { p: [0.535, 3.3, 0.1 + z], tint: true }),
      box([0.45, 0.022, 0.006], orange, { p: [0, 3.39, 0.123 + z] }),
      box([0.45, 0.022, 0.006], orange, { p: [0, 3.06, 0.123 + z] }),
      box([0.022, 0.33, 0.006], orange, { p: [-0.214, 3.225, 0.123 + z] }),
      box([0.022, 0.33, 0.006], orange, { p: [0.214, 3.225, 0.123 + z] }),
      box([0.12, 0.04, 0.16], orange, { p: [0, 3.035, 0.19 + z] }),
      torus([0.225, 0.009], orange, { p: [0, 3.05, rimZ], r: [90, 0, 0], seg: 24 }),
      lathe([[0.225, 0], [0.17, -0.22], [0.13, -0.42]], NET, { p: [0, 3.05, rimZ], seg: 12 }),
    ];
    return finish(group(parts), "basketball hoop");
  },

  "bench": (opts) => {
    const wood = mat(opts.color || "#8a5a35", "wood");
    const iron = mat("#2a2d2b", "iron", "plastic");
    // Cast iron side frame, profile in (z, y); extruded 4 cm across x.
    const side = [[0.3, 0], [0.23, 0], [0.21, 0.37], [-0.17, 0.37], [-0.22, 0], [-0.29, 0], [-0.26, 0.42], [-0.37, 0.86],
      [-0.31, 0.88], [-0.21, 0.45], [0.26, 0.42]];
    const parts = [];
    for (const x of [-0.7, 0.7]) {
      parts.push(
        extrude(side, 0.04, iron, { p: [x, 0, 0], r: [0, -90, 0] }),
        box([0.045, 0.03, 0.54], iron, { p: [x, 0.67, 0.0] }),
        box([0.04, 0.24, 0.04], iron, { p: [x, 0.55, 0.24] }),
      );
    }
    for (const z of [0.21, 0.115, 0.02, -0.075, -0.17]) parts.push(box([1.6, 0.03, 0.075], wood, { p: [0, 0.437, z], tint: true }));
    const lean = Math.atan2(0.08, 0.33) / DEG;
    for (const t of [0.25, 0.55, 0.85]) {
      parts.push(box([1.6, 0.075, 0.025], wood, { p: [0, 0.5 + 0.33 * t, -0.2 - 0.08 * t], r: [-lean, 0, 0], tint: true }));
    }
    return finish(group([group(parts, { p: [0, 0, 0.035] })]), "bench");
  },

  "picnic table": (opts) => {
    const wood = mat(opts.color || "#9b6b43", "wood");
    const parts = [];
    for (const z of [-0.28, -0.14, 0, 0.14, 0.28]) parts.push(box([1.8, 0.04, 0.135], wood, { p: [0, 0.74, z], tint: true }));
    for (const z of [-0.7, -0.56, 0.56, 0.7]) parts.push(box([1.8, 0.04, 0.13], wood, { p: [0, 0.45, z], tint: true }));
    for (const x of [-0.62, 0.62]) {
      parts.push(
        beam([x, 0.026, 0.66], [x, 0.7, 0.15], [0.06, 0.09], wood, { tint: true }),
        beam([x, 0.026, -0.66], [x, 0.7, -0.15], [0.06, 0.09], wood, { tint: true }),
        box([0.06, 0.08, 1.56], wood, { p: [x, 0.39, 0], tint: true }),
        box([0.06, 0.06, 0.7], wood, { p: [x, 0.69, 0], tint: true }),
      );
    }
    return finish(group(parts), "picnic table");
  },

  "grill": (opts) => {
    const enamel = mat(opts.color || "#1d1f1e", "plastic");
    const handle = mat("#6b4a2e", "wood");
    const z = 0.129; // the open lid hangs behind the bowl; shift so the bounding box is centered
    const coal = new THREE.MeshStandardMaterial({ color: "#ff7a2a", emissive: "#ff5a1a", emissiveIntensity: 1.4, roughness: 0.9 });
    coal.userData.kind = "glow";
    const parts = [
      lathe([[0, 0], [0.1, 0.012], [0.18, 0.05], [0.225, 0.11], [0.24, 0.18], [0.232, 0.18], [0.217, 0.115], [0.173, 0.058],
        [0.097, 0.022], [0, 0.012]], enamel, { p: [0, 0.6, z], seg: 20, tint: true }),
      cyl([0.15, 0.15, 0.02], coal, { p: [0, 0.67, z], seg: 16 }),
      torus([0.215, 0.004], steel(), { p: [0, 0.765, z], r: [90, 0, 0], seg: 24 }),
      capsule([0.012, 0.08], mat("#8a4a2e", "plastic"), { p: [-0.04, 0.78, 0.05 + z], r: [0, 0, 90] }),
      capsule([0.012, 0.08], mat("#8a4a2e", "plastic"), { p: [-0.04, 0.78, 0.09 + z], r: [0, 0, 90] }),
      cyl([0.042, 0.042, 0.014], mat("#5a3a26", "plastic"), { p: [0.08, 0.775, -0.05 + z], seg: 14 }),
      cyl([0.1, 0.1, 0.012], charcoal(), { p: [0, 0.56, z], seg: 14 }),
      torus([0.231, 0.006], steel(), { p: [0, 0.25, z], r: [90, 0, 0], seg: 24 }),
      group([
        lathe([[0.24, 0], [0.232, 0.07], [0.2, 0.14], [0.13, 0.2], [0, 0.22], [0, 0.21], [0.125, 0.19], [0.192, 0.135],
          [0.222, 0.068], [0.23, 0], [0.24, 0]], enamel, { p: [0, 0, 0.24], seg: 20, tint: true }),
        lathe([[0, 0.205], [0.12, 0.186], [0.188, 0.132], [0.218, 0.066], [0.226, 0.004]], mat("#8d928d", "plastic"), { p: [0, 0, 0.24], seg: 20 }),
        box([0.1, 0.022, 0.03], handle, { p: [0, 0.235, 0.24] }),
        cyl([0.022, 0.022, 0.012], chrome(), { p: [0.08, 0.214, 0.24], seg: 10 }),
      ], { p: [0, 0.78, -0.24 + z], r: [-100, 0, 0] }),
    ];
    for (const x of [-0.12, -0.06, 0, 0.06, 0.12]) {
      parts.push(box([0.005, 0.005, 2 * Math.sqrt(0.215 ** 2 - x * x)], steel(), { p: [x, 0.765, z] }));
    }
    for (const [i, a] of [[0, 30], [1, 110], [2, 200], [3, 290]]) {
      const r = 0.06 + (i % 2) * 0.04;
      parts.push(sphere(0.024, mat("#2a2422", "matte"), { p: [Math.sin(a * DEG) * r, 0.685, Math.cos(a * DEG) * r + z], seg: 5 }));
    }
    for (const side of [-1, 1]) parts.push(box([0.05, 0.02, 0.1], handle, { p: [side * 0.26, 0.74, z] }));
    for (const a of [0, 120, 240]) {
      const s = Math.sin(a * DEG);
      const c = Math.cos(a * DEG);
      const footY = a ? 0.05 : 0;
      parts.push(rod([s * 0.16, 0.64, c * 0.16 + z], [s * 0.27, footY, c * 0.27 + z], 0.012, steel()));
      if (a) parts.push(cyl([0.05, 0.05, 0.025], blackPlastic(), { p: [s * 0.27, 0.05, c * 0.27 + z], r: [0, 0, 90], seg: 14 }));
    }
    const root = group(parts);
    const phase = (opts.seed || 0) % 100;
    root.userData.update = (dt, t) => {
      coal.emissiveIntensity = 1.25 + 0.3 * Math.sin(t * 6.3 + phase) * Math.sin(t * 2.7 + phase * 0.3);
    };
    return finish(root, "grill");
  },

  "guitar": (opts) => {
    const top = mat(opts.color || "#d9a45b", "wood");
    const sides = mat("#6b3f1f", "wood");
    const dark = mat("#2a1a10", "wood");
    const string = mat("#e8e2cf", "plastic");
    const parts = [
      cyl([0.19, 0.19, 0.095], sides, { p: [0, 0.19, -0.0025], r: [90, 0, 0], seg: 24 }),
      cyl([0.145, 0.145, 0.095], sides, { p: [0, 0.42, -0.0025], r: [90, 0, 0], seg: 20 }),
      cyl([0.19, 0.19, 0.006], top, { p: [0, 0.19, 0.048], r: [90, 0, 0], seg: 24, tint: true }),
      cyl([0.145, 0.145, 0.006], top, { p: [0, 0.42, 0.048], r: [90, 0, 0], seg: 20, tint: true }),
      cyl([0.043, 0.043, 0.002], mat("#120d0a", "matte"), { p: [0, 0.38, 0.0515], r: [90, 0, 0], seg: 18 }),
      torus([0.05, 0.004], dark, { p: [0, 0.38, 0.051], seg: 24 }),
      box([0.12, 0.018, 0.008], dark, { p: [0, 0.14, 0.055] }),
      box([0.05, 0.33, 0.025], mat("#7a4a26", "wood"), { p: [0, 0.71, 0.035] }),
      box([0.048, 0.33, 0.006], dark, { p: [0, 0.71, 0.0505] }),
      box([0.07, 0.16, 0.018], dark, { p: [0, 0.95, 0.03], r: [-8, 0, 0] }),
    ];
    for (const y of [0.62, 0.7, 0.78, 0.86]) parts.push(box([0.048, 0.003, 0.002], chrome(), { p: [0, y, 0.0545] }));
    for (const y of [0.9, 0.95, 1.0]) parts.push(cyl([0.004, 0.004, 0.11], chrome(), { p: [0, y, 0.025], r: [0, 0, 90], seg: 6 }));
    for (let i = 0; i < 6; i++) parts.push(box([0.0012, 0.735, 0.0012], string, { p: [-0.0125 + i * 0.005, 0.5075, 0.0575] }));
    return finish(group(parts), "guitar");
  },

  "boombox": (opts) => {
    const shell = mat(opts.color || "#2f3431", "plastic");
    const grille = mat("#151816", "fabric");
    const parts = [
      box([0.5, 0.24, 0.13], shell, { p: [0, 0.12, 0], tint: true }),
      box([0.13, 0.08, 0.006], blackPlastic(), { p: [0, 0.145, 0.066] }),
      box([0.08, 0.03, 0.004], mat("#4a5550", "glass"), { p: [0, 0.15, 0.07] }),
      box([0.1, 0.012, 0.004], lime(), { p: [0, 0.075, 0.067] }),
      box([0.36, 0.022, 0.035], chrome(), { p: [0, 0.3, 0] }),
    ];
    for (const side of [-1, 1]) {
      parts.push(
        cyl([0.075, 0.075, 0.008], grille, { p: [side * 0.15, 0.115, 0.067], r: [90, 0, 0], seg: 20 }),
        torus([0.078, 0.006], chrome(), { p: [side * 0.15, 0.115, 0.069], seg: 24 }),
        cyl([0.022, 0.032, 0.012], charcoal(), { p: [side * 0.15, 0.115, 0.074], r: [90, 0, 0], seg: 12 }),
        box([0.02, 0.05, 0.03], shell, { p: [side * 0.17, 0.265, 0], tint: true }),
      );
    }
    ["#d5fb6a", "#e0645a", "#eef1e9", "#eef1e9", "#7fc8ff"].forEach((color, i) => {
      parts.push(box([0.024, 0.012, 0.02], mat(color, "plastic"), { p: [-0.07 + i * 0.035, 0.246, 0.03] }));
    });
    return finish(group(parts), "boombox");
  },

  "trophy": (opts) => {
    // The field has had an environment map since the look pipeline landed, so real gold reads as gold now.
    const gold = mat(opts.color || "#d4a72c", "gold", "plastic");
    const plinth = mat("#2a2622", "stone");
    const plaque = textPanel([0.1, 0.03], {
      width: 256, height: 77, text: opts.text || "CHAMPION", size: 28, weight: "700", color: "#2a2216", bg: "#e2c25a",
      padding: 8, align: "center", valign: "middle", maxLines: 2, lineHeight: 1.2,
    }, { p: [0, 0.025, 0.0605] });
    const root = group([
      box([0.16, 0.05, 0.12], plinth, { p: [0, 0.025, 0] }),
      box([0.12, 0.04, 0.09], plinth, { p: [0, 0.07, 0] }),
      plaque,
      lathe([[0, 0.09], [0.03, 0.09], [0.03, 0.1], [0.012, 0.11], [0.009, 0.15], [0.018, 0.16], [0.01, 0.172], [0, 0.172]],
        gold, { seg: 16, tint: true }),
      lathe([[0, 0.17], [0.02, 0.172], [0.045, 0.19], [0.062, 0.22], [0.07, 0.26], [0.072, 0.3], [0.066, 0.3], [0.064, 0.262],
        [0.056, 0.224], [0.04, 0.196], [0.018, 0.182], [0, 0.18]], gold, { seg: 20, tint: true }),
      torus([0.027, 0.005], gold, { p: [-0.084, 0.255, 0], seg: 16, tint: true }),
      torus([0.027, 0.005], gold, { p: [0.084, 0.255, 0], seg: 16, tint: true }),
    ]);
    root.userData.setText = (text) => plaque.userData.setText(text);
    return finish(root, "trophy");
  },

  "hammock": (opts) => {
    const fabric = mat(opts.color || "#d9643a", "fabric");
    const stand = mat("#3a403c", "plastic");
    const wood = mat("#8a5a35", "wood");
    const rope = mat("#e8dcc0", "matte");
    // Sagging bed: parabola from the spreader bars (y 1.0) down to y 0.55, 3.5 cm thick, 0.85 m wide.
    const upper = [];
    for (let i = 0; i <= 14; i++) {
      const x = -1.05 + (2.1 * i) / 14;
      upper.push([x, 0.55 + 0.45 * (x / 1.05) ** 2]);
    }
    const outline = [...upper, ...upper.slice().reverse().map(([x, y]) => [x, y - 0.035])];
    const parts = [
      extrude(outline, 0.85, fabric, { tint: true }),
      box([2.6, 0.06, 0.08], stand, { p: [0, 0.07, 0] }),
      box([0.3, 0.1, 0.5], mat("#efe6d2", "fabric"), { p: [-0.74, 0.83, 0], r: [0, 0, -31] }),
    ];
    for (const side of [-1, 1]) {
      parts.push(
        box([0.08, 0.05, 0.9], stand, { p: [side * 1.0, 0.025, 0] }),
        beam([side * 0.96, 0.07, 0], [side * 1.36, 1.36, 0], [0.06, 0.06], stand),
        torus([0.025, 0.006], steel(), { p: [side * 1.36, 1.36, 0], seg: 12 }),
        cyl([0.016, 0.016, 0.92], wood, { p: [side * 1.05, 1.0, 0], r: [90, 0, 0], seg: 8 }),
        rod([side * 1.05, 1.0, 0.42], [side * 1.36, 1.34, 0], 0.005, rope, { seg: 5 }),
        rod([side * 1.05, 1.0, -0.42], [side * 1.36, 1.34, 0], 0.005, rope, { seg: 5 }),
        rod([side * 1.05, 1.0, 0], [side * 1.36, 1.34, 0], 0.005, rope, { seg: 5 }),
      );
    }
    return finish(group(parts), "hammock");
  },
};
