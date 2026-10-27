// Containers that hold grabbable pieces (a box of popcorn, a bag of chips). Pure math shared by the
// builders (where the pieces are drawn) and play/behaviors.js (which piece comes out of the hand).
//
// meta.container: { floor, rim, bottom: [hw, hd], top: [hw, hd], fill: "popcorn piece", max }
//   floor/rim: inner bottom and top-edge heights (meters, part local, origin bottom-center);
//   bottom/top: inner half-width (x) and half-depth (z) at the floor and at the rim.
// record.data.fill: { part, n, s } — what is inside, how many, and the pieces' scale. Missing = full
// of meta.container.fill at scale 1.

const MOUND = 0.55; // a full container heaps this many piece-heights over the rim

// Half extents of the cavity at height y (linear between floor and rim).
export function cavityAt(c, y) {
  const k = c.rim > c.floor ? Math.min(1, Math.max(0, (y - c.floor) / (c.rim - c.floor))) : 1;
  return [c.bottom[0] + (c.top[0] - c.bottom[0]) * k, c.bottom[1] + (c.top[1] - c.bottom[1]) * k];
}

function hash(seed, i) {
  let h = (seed ^ Math.imul(i + 1, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
}

// Grid of piece positions in one layer at height y.
function layer(c, y, piece) {
  const [hw, hd] = cavityAt(c, y);
  const cols = Math.max(1, Math.floor((2 * hw) / piece));
  const rows = Math.max(1, Math.floor((2 * hd) / piece));
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      out.push([(q - (cols - 1) / 2) * ((2 * hw - piece) / Math.max(1, cols - 1) || 0), (r - (rows - 1) / 2) * ((2 * hd - piece) / Math.max(1, rows - 1) || 0)]);
    }
  }
  return out;
}

// How many pieces of this size make the container look full (capped by c.max).
export function capacity(c, piece) {
  const p = Math.max(0.005, piece);
  const step = p * 0.8;
  let total = 0;
  for (let y = c.floor + p / 2; y <= c.rim + p * MOUND; y += step) total += layer(c, y, p).length;
  return Math.max(1, Math.min(c.max || 60, total));
}

// Piece slots, bottom first: [[x, y, z, rx, ry, rz], ...] (radians). The last slot is the top of
// the heap: the next piece taken out.
export function fillSlots(c, piece, n, seed = 1) {
  const p = Math.max(0.005, piece);
  const step = p * 0.8;
  const slots = [];
  for (let y = c.floor + p / 2; y <= c.rim + p * MOUND; y += step) {
    const cells = layer(c, y, p);
    const [hw, hd] = cavityAt(c, y);
    for (const [x, z] of cells) {
      const k = slots.length;
      // The mound over the rim rounds off toward the edges.
      const edge = Math.max(Math.abs(x) / Math.max(hw, 1e-3), Math.abs(z) / Math.max(hd, 1e-3));
      const drop = y > c.rim ? edge * p * 0.6 : 0;
      slots.push([
        x + (hash(seed, k) - 0.5) * p * 0.35,
        y - drop + (hash(seed + 3, k) - 0.5) * p * 0.2,
        z + (hash(seed + 7, k) - 0.5) * p * 0.35,
        hash(seed + 11, k) * Math.PI * 2, hash(seed + 13, k) * Math.PI * 2, hash(seed + 17, k) * Math.PI * 2,
      ]);
    }
  }
  const full = capacity(c, p);
  // The top `full` slots make a full container (deep containers get a false bottom); taking pieces
  // removes them from the top while the rest of the heap sinks toward the real floor.
  const top = slots.slice(Math.max(0, slots.length - full));
  const out = top.slice(0, Math.max(0, Math.min(n, top.length)));
  if (out.length && out.length < full) {
    const gap = Math.max(0, top[0][1] - (c.floor + p / 2));
    const shift = gap * (1 - out.length / full);
    for (const s of out) s[1] -= shift;
  }
  return out;
}

// Normalized fill of a container record: { part, n, s } with n clamped to capacity.
export function fillOf(meta, record, pieceSize) {
  const c = meta?.container;
  if (!c) return null;
  const d = record?.data?.fill || {};
  const part = typeof d.part === "string" && d.part ? d.part : c.fill;
  const s = Number.isFinite(d.s) && d.s > 0 ? d.s : 1;
  const cap = capacity(c, (pieceSize || 0.03) * s);
  const n = Number.isFinite(d.n) ? Math.max(0, Math.min(cap, Math.round(d.n))) : cap;
  return { part, n, s, cap };
}

// Is a point (part-local, origin bottom-center, unscaled) inside the cavity or just above the heap?
export function inCavity(c, local, margin = 0) {
  if (local[1] < c.floor - margin || local[1] > c.rim + 0.08 + margin) return false;
  const [hw, hd] = cavityAt(c, Math.min(local[1], c.rim));
  return Math.abs(local[0]) <= hw + margin && Math.abs(local[2]) <= hd + margin;
}
