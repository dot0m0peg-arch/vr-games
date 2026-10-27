// Magic marker sketch helpers (ARCHITECTURE.md "Magic marker"): stroke cleanup, projection to the
// drawing plane, ASCII art for text-only models and an offline shape guess used without the model.
// Pure module: no window, document or three.js. Strokes are { c, w, pts: [x, y, z, ...] } in
// drawing-local meters (x right, y up, z toward the drawer).

export const STROKE_DEFAULTS = { color: "#9b6bff", width: 0.012 };

const finite = Number.isFinite;
const ok = (v) => finite(v) && Math.abs(v) <= 1e9; // a usable coordinate (meters)
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const r4 = (n) => Math.round(n * 1e4) / 1e4 || 0;
const DEG = 180 / Math.PI;

// Shape analysis tuning (normalized drawing: longest side = 1).
const RING = 64; // resampled points per stroke
const K = 3; // corner window, in samples
const CORNER_DEG = 55; // turning angle that counts as a corner
const SHARP_DEG = 100; // star tips, triangle points
const DOT = 0.04; // strokes smaller than this are details (eyes, dots), not structure

// ---------- input cleanup ----------

const isList = (v) => Array.isArray(v) || ArrayBuffer.isView(v);
const ptsOf = (s) => (isList(s) ? s : s && isList(s.pts) ? s.pts : null);
const listOf = (v) => (Array.isArray(v) ? v : []);

// Flat [x, y, z, ...] → new flat array of usable triples (drops NaN, absurd and partial points).
function cleanFlat(flat) {
  const out = [];
  if (!isList(flat)) return out;
  for (let i = 0; i + 2 < flat.length; i += 3) {
    const x = flat[i];
    const y = flat[i + 1];
    const z = flat[i + 2];
    if (ok(x) && ok(y) && ok(z)) out.push(x, y, z);
  }
  return out;
}

// [[x, y], ...] → new list of usable 2D points.
function clean2d(line) {
  const out = [];
  if (!Array.isArray(line)) return out;
  for (const p of line) if (p && ok(p[0]) && ok(p[1])) out.push([p[0], p[1]]);
  return out;
}

function flatLength(p) {
  let len = 0;
  for (let i = 3; i < p.length; i += 3) len += Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2], p[i + 2] - p[i - 1]);
  return len;
}

// ---------- 3D stroke helpers ----------

// Squared distance from point i to segment a-b (flat xyz array).
function segDist2(p, i, a, b) {
  const ax = p[a * 3];
  const ay = p[a * 3 + 1];
  const az = p[a * 3 + 2];
  const dx = p[b * 3] - ax;
  const dy = p[b * 3 + 1] - ay;
  const dz = p[b * 3 + 2] - az;
  const px = p[i * 3] - ax;
  const py = p[i * 3 + 1] - ay;
  const pz = p[i * 3 + 2] - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  const t = len2 > 0 ? clamp((px * dx + py * dy + pz * dz) / len2, 0, 1) : 0;
  const ex = px - dx * t;
  const ey = py - dy * t;
  const ez = pz - dz * t;
  return ex * ex + ey * ey + ez * ez;
}

// Ramer–Douglas–Peucker in 3D; keeps both endpoints. → new flat array.
export function simplifyStroke(flatPts, epsilon = 0.004) {
  const p = cleanFlat(flatPts);
  const n = p.length / 3;
  if (n <= 2) return p;
  const eps = finite(epsilon) && epsilon > 0 ? epsilon : 0;
  const eps2 = eps * eps;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop();
    const a = stack.pop();
    let best = -1;
    let bestD = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(p, i, a, b);
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best > 0 && bestD > eps2) {
      keep[best] = 1;
      stack.push(a, best, best, b);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  return out;
}

// Rounds every coordinate to the step (5 mm by default). → new flat array.
export function quantize(flatPts, step = 0.005) {
  const s = finite(step) && step > 0 ? step : 0.005;
  const p = cleanFlat(flatPts);
  for (let i = 0; i < p.length; i++) p[i] = Math.round(Math.round(p[i] / s) * s * 1e9) / 1e9 || 0;
  return p;
}

export function sketchBounds(strokes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let count = 0;
  for (const s of listOf(strokes)) {
    const p = ptsOf(s);
    if (!p) continue;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const x = p[i];
      const y = p[i + 1];
      const z = p[i + 2];
      if (!ok(x) || !ok(y) || !ok(z)) continue;
      count++;
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }
  }
  if (!count) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

// Simplifies progressively (doubling epsilon) until the total is ≤ maxPoints; drops the shortest
// strokes only when that is not enough. Empty strokes are dropped. → new stroke list.
export function limitStrokes(strokes, maxPoints = 6000) {
  const max = finite(maxPoints) ? Math.max(0, Math.floor(maxPoints)) : 6000;
  const src = [];
  for (const s of listOf(strokes)) {
    const pts = cleanFlat(ptsOf(s));
    if (pts.length) src.push({ s, pts });
  }
  const total = (list) => list.reduce((n, p) => n + p.length / 3, 0);
  let cur = src.map((e) => e.pts);
  for (let eps = 0.002; total(cur) > max && eps <= 2; eps *= 2) cur = src.map((e) => simplifyStroke(e.pts, eps));
  const alive = cur.map(() => true);
  if (total(cur) > max) {
    let sum = total(cur);
    const order = cur.map((p, i) => ({ i, len: flatLength(p) })).sort((a, b) => a.len - b.len || b.i - a.i);
    for (const { i } of order) {
      if (sum <= max) break;
      alive[i] = false;
      sum -= cur[i].length / 3;
    }
  }
  const out = [];
  src.forEach((e, i) => {
    if (!alive[i]) return;
    out.push(isList(e.s) ? cur[i] : { ...e.s, pts: cur[i] });
  });
  return out;
}

// ---------- drawing plane ----------

// Drops z and normalizes so the longest side spans [0, 1] (centered, y up).
export function projectStrokesWithAspect(strokes) {
  const raw = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of listOf(strokes)) {
    const p = cleanFlat(ptsOf(s));
    if (!p.length) continue;
    raw.push(p);
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
    }
  }
  if (!raw.length) return { lines: [], aspect: 1, width: 0, height: 0 };
  const width = maxX - minX;
  const height = maxY - minY;
  const scale = Math.max(width, height) || 1;
  const ox = (1 - width / scale) / 2;
  const oy = (1 - height / scale) / 2;
  const lines = raw.map((p) => {
    const line = [];
    for (let i = 0; i < p.length; i += 3) line.push([r4((p[i] - minX) / scale + ox), r4((p[i + 1] - minY) / scale + oy)]);
    return line;
  });
  return { lines, aspect: aspectOf(width, height), width: r4(width), height: r4(height) };
}

export function projectStrokes(strokes) {
  return projectStrokesWithAspect(strokes).lines;
}

function aspectOf(w, h) {
  if (!(h > 1e-9)) return w > 1e-9 ? 100 : 1;
  return Math.round(clamp(w / h, 0.01, 100) * 1000) / 1000;
}

// Rows of "#" (ink) and "." (empty), top row = top of the drawing. Cells are taken as twice as
// tall as wide, so a square drawing fills about cols = 2 * rows.
export function asciiArt(lines2d, cols = 40, rows = 20) {
  const C = finite(cols) ? clamp(Math.round(cols), 1, 400) : 40;
  const R = finite(rows) ? clamp(Math.round(rows), 1, 200) : 20;
  const grid = new Uint8Array(C * R);
  const lines = listOf(lines2d).map(clean2d).filter((l) => l.length);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const l of lines) {
    for (const [x, y] of l) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (lines.length) {
    const w = maxX - minX;
    const h = maxY - minY;
    let sx = Math.min(w > 0 ? (C - 1) / w : Infinity, h > 0 ? (2 * (R - 1)) / h : Infinity);
    if (!finite(sx)) sx = 0;
    const sy = sx / 2;
    const ox = (C - 1 - w * sx) / 2;
    const oy = (R - 1 - h * sy) / 2;
    const col = (x) => clamp(Math.round(ox + (x - minX) * sx), 0, C - 1);
    const row = (y) => clamp(Math.round(oy + (maxY - y) * sy), 0, R - 1);
    for (const l of lines) {
      let c0 = col(l[0][0]);
      let r0 = row(l[0][1]);
      grid[r0 * C + c0] = 1;
      for (let i = 1; i < l.length; i++) {
        const c1 = col(l[i][0]);
        const r1 = row(l[i][1]);
        plotLine(grid, C, c0, r0, c1, r1);
        c0 = c1;
        r0 = r1;
      }
    }
  }
  const out = [];
  for (let r = 0; r < R; r++) {
    let s = "";
    for (let c = 0; c < C; c++) s += grid[r * C + c] ? "#" : ".";
    out.push(s);
  }
  return out.join("\n");
}

// Bresenham.
function plotLine(grid, C, x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    grid[y0 * C + x0] = 1;
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

export function sketchStats(strokes) {
  let count = 0;
  let points = 0;
  for (const s of listOf(strokes)) {
    const n = cleanFlat(ptsOf(s)).length / 3;
    if (!n) continue;
    count++;
    points += n;
  }
  const { lines, aspect, width, height } = projectStrokesWithAspect(strokes);
  // Normalized: the drawing's longest side is 1, so 12% of the drawing size is 0.12.
  let closed = 0;
  for (const l of lines) {
    if (l.length < 3) continue;
    const box = boxOf(l);
    const gap = dist(l[0], l[l.length - 1]);
    if (box.ext >= 0.05 && gap <= 0.12 && gap <= 0.3 * box.ext) closed++;
  }
  return { strokes: count, points, closed, aspect, width, height };
}

// ---------- 2D geometry ----------

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function boxOf(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return { minX, minY, maxX, maxY, w, h, ext: Math.max(w, h), cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i], pts[i - 1]);
  return len;
}

// Evenly spaced points along a 2D polyline (by arc length), endpoints included.
export function resampleLine(points2d, n = 32) {
  const pts = clean2d(points2d);
  const count = finite(n) ? clamp(Math.round(n), 1, 4096) : 32;
  if (!pts.length) return [];
  const total = pathLength(pts);
  if (count === 1 || pts.length === 1 || !(total > 0)) return Array.from({ length: count }, () => [pts[0][0], pts[0][1]]);
  const out = [];
  let j = 1;
  let before = 0; // path length up to pts[j - 1]
  let seg = dist(pts[0], pts[1]);
  for (let k = 0; k < count; k++) {
    const d = (total * k) / (count - 1);
    while (j < pts.length - 1 && before + seg < d) {
      before += seg;
      j++;
      seg = dist(pts[j - 1], pts[j]);
    }
    const t = seg > 0 ? clamp((d - before) / seg, 0, 1) : 0;
    const a = pts[j - 1];
    const b = pts[j];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// N points evenly spaced around a closed loop (the closing segment included, no duplicate end).
const resampleRing = (pts, n) => resampleLine([...pts, pts[0]], n + 1).slice(0, n);

function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

// Signed turning angle (degrees) at i between the chords from i-k and to i+k.
function turnAt(P, i, k, cyclic) {
  const n = P.length;
  let a = i - k;
  let b = i + k;
  if (cyclic) {
    a = (a + n) % n;
    b %= n;
  } else if (a < 0 || b >= n) return 0;
  const ax = P[i][0] - P[a][0];
  const ay = P[i][1] - P[a][1];
  const bx = P[b][0] - P[i][0];
  const by = P[b][1] - P[i][1];
  if ((!ax && !ay) || (!bx && !by)) return 0;
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * DEG;
}

// Local maxima of |turn| above min degrees (non-maximum suppression within ±K).
function findCorners(turns, cyclic, min = CORNER_DEG) {
  const n = turns.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = Math.abs(turns[i]);
    if (t < min) continue;
    let peak = true;
    for (let d = -K; d <= K && peak; d++) {
      if (!d) continue;
      let j = i + d;
      if (cyclic) j = (j + n) % n;
      else if (j < 0 || j >= n) continue;
      const u = Math.abs(turns[j]);
      if (u > t || (u === t && j < i)) peak = false;
    }
    if (peak) out.push(i);
  }
  return out;
}

function segDist2d(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1) : 0;
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

// Largest distance of the samples from the polygon through the corner samples.
function polygonDeviation(P, corners, cyclic) {
  let worst = 0;
  const m = corners.length;
  const spans = cyclic ? m : m - 1;
  for (let c = 0; c < spans; c++) {
    const i0 = corners[c];
    const i1 = corners[(c + 1) % m];
    const a = P[i0];
    const b = P[i1];
    for (let i = i0; i !== i1; i = (i + 1) % P.length) worst = Math.max(worst, segDist2d(P[i], a, b));
  }
  return worst;
}

// Radius spread around the box center, with the box stretched to a square (ellipses read round).
function roundness(ring, box) {
  const w = Math.max(box.w, 0.05 * box.ext) / 2;
  const h = Math.max(box.h, 0.05 * box.ext) / 2;
  let sum = 0;
  let sum2 = 0;
  for (const [x, y] of ring) {
    const r = Math.hypot((x - box.cx) / w, (y - box.cy) / h);
    sum += r;
    sum2 += r * r;
  }
  const mean = sum / ring.length;
  return mean > 0 ? Math.sqrt(Math.max(0, sum2 / ring.length - mean * mean)) / mean : 1;
}

// Closed loop (ends meet, or the tail overshoots the start)? → the loop's points or null.
function closeLoop(pts, box, len) {
  if (pts.length < 4 || len < 1.95 * box.ext) return null;
  const thr = 0.2 * box.ext;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (dist(first, last) <= thr) return pts;
  let best = { d: Infinity, cut: null };
  let run = 0;
  for (let i = pts.length - 2; i > 0 && run < 0.4 * len; i--) {
    run += dist(pts[i], pts[i + 1]);
    const d = dist(pts[i], first);
    if (d < best.d) best = { d, cut: () => pts.slice(0, i + 1) };
  }
  run = 0;
  for (let i = 1; i < pts.length - 1 && run < 0.4 * len; i++) {
    run += dist(pts[i], pts[i - 1]);
    const d = dist(pts[i], last);
    if (d < best.d) best = { d, cut: () => pts.slice(i) };
  }
  return best.d <= thr ? best.cut() : null;
}

// Corner-preserving smoothing of hand jitter (2D RDP); small strokes get a finer tolerance so
// circles do not turn into polygons.
function smooth2d(pts, box, tol) {
  const flat = [];
  for (const [x, y] of pts) flat.push(x, y, 0);
  const s = simplifyStroke(flat, Math.min(tol, 0.025 * box.ext));
  const out = [];
  for (let i = 0; i < s.length; i += 3) out.push([s[i], s[i + 1]]);
  return out;
}

// Per-stroke features in normalized drawing coordinates.
function analyze(raw, tol = 0.01) {
  const box = boxOf(raw);
  const pts = smooth2d(raw, box, tol);
  const len = pathLength(pts);
  const info = { pts, box, len, dot: box.ext < DOT || pts.length < 2, closed: false, corners: [], turns: [], sharp: 0, P: null, cv: 1 };
  if (info.dot) return info;
  const loop = closeLoop(pts, box, len);
  if (loop) {
    const ring = resampleRing(loop, RING);
    if (Math.abs(signedArea(ring)) >= 0.05 * box.ext * box.ext) {
      info.closed = true;
      info.P = ring;
      info.cv = roundness(ring, box);
    }
  }
  // Open strokes: about one sample per 2% of the drawing, so jitter on short lines is not a corner.
  if (!info.closed) info.P = resampleLine(pts, clamp(Math.round(len / 0.02), 16, RING));
  info.turns = info.P.map((_, i) => turnAt(info.P, i, K, info.closed));
  info.corners = findCorners(info.turns, info.closed);
  info.sharp = info.corners.filter((i) => Math.abs(info.turns[i]) >= SHARP_DEG).length;
  return info;
}

const isRound = (s, cv = 0.15) => s.closed && s.corners.length <= 2 && !s.sharp && s.cv < cv;

// ---------- single-stroke shapes ----------

const result = (guess, part, confidence, behavior, shape) => ({ guess, part, confidence: Math.round(confidence * 100) / 100, behavior, shape });

function classifyClosed(s) {
  const { P, corners, turns, box } = s;
  const m = corners.length;
  const ext = box.ext;
  if (s.sharp >= 5 && s.sharp <= 12 && isStar(s)) return result("star", null, 0.6, "spin", "star");
  if (m <= 2 && !s.sharp && s.cv < 0.12) {
    const aspect = box.w / Math.max(box.h, 1e-9);
    const elongated = aspect > 1.5 || aspect < 1 / 1.5;
    const conf = elongated ? 0.4 : s.cv < 0.06 ? 0.7 : 0.5;
    return result("ball", "ball", conf, "bounce", elongated ? "ellipse" : "circle");
  }
  // A house outline: its eaves turn gently, so look again with softer corners.
  const soft = m === 5 ? corners : findCorners(turns, true, 30);
  if (soft.length === 5 && polygonDeviation(P, soft, true) <= 0.1 * ext && isHouseOutline(soft.map((i) => P[i]), box)) {
    return result("house", "house", 0.5, "none", "house");
  }
  if (m < 3 || m > 4 || polygonDeviation(P, corners, true) > 0.1 * ext) return null;
  const C = corners.map((i) => P[i]);
  if (m === 3) {
    const byY = [...C].sort((a, b) => b[1] - a[1]);
    const up = byY[0][1] - Math.max(byY[1][1], byY[2][1]) >= 0.5 * box.h && Math.abs(byY[1][1] - byY[2][1]) <= 0.3 * box.h;
    return result("tent", "tent", up ? 0.5 : 0.35, "none", "triangle");
  }
  // Edges near 45° read as a diamond (a kite); axis-aligned ones as a box.
  let tilt = 0;
  let right = 0;
  for (let c = 0; c < 4; c++) {
    const a = C[c];
    const b = C[(c + 1) % 4];
    const ang = Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]) * DEG) % 90;
    tilt += Math.min(ang, 90 - ang) / 4;
    right += Math.abs(Math.abs(turns[corners[c]]) - 90) / 4;
  }
  if (tilt > 30) return result("kite", null, 0.35, "fly", "diamond");
  const aspect = box.w / Math.max(box.h, 1e-9);
  const square = aspect > 0.7 && aspect < 1.4;
  const conf = tilt < 20 && right < 30 ? (square ? 0.6 : 0.45) : 0.35;
  return result("crate", "crate", conf, "none", square ? "square" : "rectangle");
}

// Five corners: two bottom corners level, walls straight up, the roof apex between the eaves.
function isHouseOutline(C, box) {
  const byY = [...C].sort((a, b) => a[1] - b[1]);
  const [b1, b2, e1, e2, apex] = byY;
  const [bl, br] = b1[0] < b2[0] ? [b1, b2] : [b2, b1];
  const [el, er] = e1[0] < e2[0] ? [e1, e2] : [e2, e1];
  const tol = 0.18 * box.ext;
  return Math.abs(b1[1] - b2[1]) <= tol && Math.abs(el[0] - bl[0]) <= tol && Math.abs(er[0] - br[0]) <= tol
    && apex[0] > el[0] && apex[0] < er[0] && apex[1] - Math.max(el[1], er[1]) >= 0.12 * box.h
    && Math.min(el[1], er[1]) - Math.max(bl[1], br[1]) >= 0.2 * box.h;
}

// Five or more sharp tips turning the same way, all near the outside, about equally far out and
// spread evenly all the way around (a scribble that happens to close is not a star).
function isStar(s) {
  const { P, corners, turns } = s;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of P) {
    cx += x / P.length;
    cy += y / P.length;
  }
  const radius = (p) => Math.hypot(p[0] - cx, p[1] - cy);
  let maxR = 0;
  for (const p of P) maxR = Math.max(maxR, radius(p));
  // Tips traced twice count once.
  const tips = [];
  for (const i of corners) {
    if (Math.abs(turns[i]) < SHARP_DEG || radius(P[i]) < 0.7 * maxR) continue;
    if (!tips.some((j) => dist(P[i], P[j]) < 0.15 * maxR)) tips.push(i);
  }
  if (tips.length < 5 || corners.length > 4 * tips.length + 2) return false;
  const sign = Math.sign(turns[tips[0]]);
  if (tips.some((i) => Math.sign(turns[i]) !== sign)) return false;
  const r = tips.map((i) => radius(P[i]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  if (r.some((v) => Math.abs(v - mean) > 0.25 * mean)) return false;
  const angles = tips.map((i) => Math.atan2(P[i][1] - cy, P[i][0] - cx)).sort((a, b) => a - b);
  let big = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  let small = big;
  for (let i = 1; i < angles.length; i++) {
    big = Math.max(big, angles[i] - angles[i - 1]);
    small = Math.min(small, angles[i] - angles[i - 1]);
  }
  return big < 130 / DEG && big <= 3 * small;
}

// Open and close to its chord (deviation, not path length, so jitter does not matter).
function isStraight(s) {
  if (s.closed) return false;
  const a = s.pts[0];
  const b = s.pts[s.pts.length - 1];
  const chord = dist(a, b);
  if (chord < 0.75 * s.len) return false;
  let dev = 0;
  for (const p of s.pts) dev = Math.max(dev, segDist2d(p, a, b));
  return dev <= 0.06 * chord;
}

function classifyOpen(s, scale) {
  if (isStraight(s)) {
    // Long lines read as a staff; a short dash is a weaker guess. scale: meters per unit, if known.
    const meters = scale * dist(s.pts[0], s.pts[s.pts.length - 1]);
    const conf = !scale ? 0.5 : meters >= 0.6 ? 0.6 : meters < 0.25 ? 0.35 : 0.5;
    return result("staff", "staff", conf, "float", "line");
  }
  if (isSpiral(s)) return result("spiral", null, 0.55, "spin", "spiral");
  return null;
}

// Turns one way at least 1.5 times with the radius steadily growing (or shrinking).
function isSpiral(s) {
  const P = resampleLine(s.pts, 96);
  let turn = 0;
  let abs = 0;
  for (let i = 1; i < P.length - 1; i++) {
    const ax = P[i][0] - P[i - 1][0];
    const ay = P[i][1] - P[i - 1][1];
    const bx = P[i + 1][0] - P[i][0];
    const by = P[i + 1][1] - P[i][1];
    const t = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    turn += t;
    abs += Math.abs(t);
  }
  if (Math.abs(turn) < 3 * Math.PI || Math.abs(turn) < 0.6 * abs) return false;
  // Radius about the center of the stroke's box versus progress along the stroke.
  const box = boxOf(P);
  const n = P.length;
  let mr = 0;
  const r = P.map((p) => {
    const d = Math.hypot(p[0] - box.cx, p[1] - box.cy);
    mr += d / n;
    return d;
  });
  const mi = (n - 1) / 2;
  let cov = 0;
  let vi = 0;
  let vr = 0;
  for (let i = 0; i < n; i++) {
    cov += (i - mi) * (r[i] - mr);
    vi += (i - mi) ** 2;
    vr += (r[i] - mr) ** 2;
  }
  return vr > 0 && Math.abs(cov / Math.sqrt(vi * vr)) >= 0.7;
}

function classifySingle(s, scale) {
  return s.closed ? classifyClosed(s) : classifyOpen(s, scale);
}

// ---------- multi-stroke scenes ----------

const inside = (box, outer, margin = 0.1 * outer.ext) => box.minX >= outer.minX - margin && box.maxX <= outer.maxX + margin
  && box.minY >= outer.minY - margin && box.maxY <= outer.maxY + margin;

function isBox(s) {
  if (!s.closed || s.corners.length !== 4) return false;
  return polygonDeviation(s.P, s.corners, true) <= 0.1 * s.box.ext;
}

const topEnd = (s) => (s.pts[0][1] > s.pts[s.pts.length - 1][1] ? s.pts[0] : s.pts[s.pts.length - 1]);
const lowEnd = (s) => (s.pts[0][1] > s.pts[s.pts.length - 1][1] ? s.pts[s.pts.length - 1] : s.pts[0]);

// A roof: closed triangle, an open "^", or two straight lines meeting at the top.
function roofBoxes(sig) {
  const out = [];
  for (const s of sig) {
    if (s.closed && s.corners.length === 3 && polygonDeviation(s.P, s.corners, true) <= 0.1 * s.box.ext) out.push(s.box);
    if (!s.closed && s.corners.length === 1) {
      const apex = s.P[s.corners[0]];
      const ends = [s.P[0], s.P[s.P.length - 1]];
      const fit = polygonDeviation(s.P, [0, s.corners[0], s.P.length - 1], false) <= 0.1 * s.box.ext;
      if (fit && apex[1] - Math.max(ends[0][1], ends[1][1]) >= 0.15 * s.box.w && (apex[0] - ends[0][0]) * (apex[0] - ends[1][0]) < 0) out.push(s.box);
    }
  }
  const lines = sig.filter(isStraight);
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const ti = topEnd(lines[i]);
      const tj = topEnd(lines[j]);
      const span = Math.max(lines[i].box.ext, lines[j].box.ext);
      const slopes = (ti[0] - lowEnd(lines[i])[0]) * (tj[0] - lowEnd(lines[j])[0]) < 0;
      if (slopes && dist(ti, tj) <= 0.25 * span) out.push(boxOf([...lines[i].pts, ...lines[j].pts]));
    }
  }
  return out;
}

function findHouse(sig) {
  const bodies = sig.filter(isBox).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  if (!bodies.length) return null;
  const roofs = roofBoxes(sig);
  for (const body of bodies) {
    const b = body.box;
    for (const r of roofs) {
      const overlap = Math.min(r.maxX, b.maxX) - Math.max(r.minX, b.minX);
      if (r.cy > b.cy && Math.abs(r.minY - b.maxY) <= 0.3 * b.h + 0.05 && overlap >= 0.5 * b.w && r.w >= 0.5 * b.w) {
        return result("house", "house", 0.65, "none", "house");
      }
    }
  }
  return null;
}

// Round head on top, mostly open strokes (body, arms, legs) hanging below it.
function findPerson(sig, all) {
  const heads = sig.filter((s) => isRound(s, 0.2)).sort((a, b) => b.box.cy - a.box.cy);
  const head = heads[0];
  if (!head) return null;
  const top = Math.max(...all.map((s) => s.box.maxY));
  const bottom = Math.min(...all.map((s) => s.box.minY));
  const height = top - bottom;
  if (head.box.maxY < top - 0.1 || head.box.h > 0.45 * height || height < 2 * head.box.h) return null;
  const body = sig.filter((s) => s !== head && s.box.cy < head.box.cy && !inside(s.box, head.box, 0));
  if (!body.length || body.filter((s) => s.closed).length > 1) return null;
  const reach = Math.min(...body.map((s) => s.box.minY));
  if (reach > head.box.minY - head.box.h) return null;
  return result("person", null, body.length >= 2 ? 0.55 : 0.45, "walk", "stick figure");
}

// A round outline with short rays all around it: a sun.
function findSun(sig) {
  const main = [...sig].sort((a, b) => b.box.ext - a.box.ext)[0];
  if (!isRound(main) || main.box.ext < 0.25) return null;
  const others = sig.filter((s) => s !== main);
  const { cx, cy } = main.box;
  const radius = (main.box.w + main.box.h) / 4;
  const outside = others.filter((s) => Math.hypot(s.box.cx - cx, s.box.cy - cy) > 1.05 * radius);
  if (outside.length >= 4 && outside.length === others.length && outside.every((s) => !s.closed && s.box.ext <= 1.2 * radius)) {
    const angles = outside.map((s) => Math.atan2(s.box.cy - cy, s.box.cx - cx)).sort((a, b) => a - b);
    let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
    for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
    if (gap < Math.PI * 0.85) return result("sun", null, 0.5, "float", "sun");
  }
  return null;
}

// A round outline with two features above its middle (eyes) and one below (mouth).
function findFace(main, details) {
  if (!isRound(main) || details.length < 2) return null;
  const { cy } = main.box;
  const small = details.filter((s) => inside(s.box, main.box, 0) && s.box.ext <= 0.6 * main.box.ext);
  if (small.length !== details.length) return null;
  const above = small.filter((s) => s.box.cy > cy).length;
  const below = small.filter((s) => s.box.cy <= cy).length;
  return above >= 2 && below >= 1 ? result("face", null, 0.45, "bounce", "face") : null;
}

// Offline guess from 2D polylines (projectStrokes output). Honest heuristics: no match → null.
// stats (sketchStats) adds real-world size in meters when known.
export function classifySketch(lines2d, stats) {
  let input = listOf(lines2d);
  if (input.some((l) => l && !Array.isArray(l) && isList(l.pts))) input = projectStrokes(input);
  const lines = input.map(clean2d).filter((l) => l.length);
  if (!lines.length) return null;
  const box = boxOf(lines.flat());
  if (!(box.ext > 1e-9)) return null;
  // stats gives the real size in meters: a speck under 3 cm is too small to read.
  const known = !!stats && finite(stats.width) && finite(stats.height);
  const scale = known ? Math.max(stats.width, stats.height, 0) : 0;
  if (known && scale < 0.03) return null;
  // Normalize: longest side = 1. Jitter tolerance: 5 mm (the stroke grid) when the real size is
  // known, else 1% of the drawing.
  const norm = lines.map((l) => l.map(([x, y]) => [(x - box.minX) / box.ext, (y - box.minY) / box.ext]));
  const all = norm.map((l) => analyze(l, scale ? clamp(0.005 / scale, 0.01, 0.03) : 0.01));
  const sig = all.filter((s) => !s.dot);
  if (!sig.length) return null;
  const soften = (res, k) => res && { ...res, confidence: Math.max(0.3, Math.round(res.confidence * k * 100) / 100) };
  if (sig.length === 1) return soften(classifySingle(sig[0], scale), all.length > 1 ? 0.9 : 1);
  const scene = findHouse(sig) || findPerson(sig, all) || findSun(sig);
  if (scene) return scene;
  // One big outline with details drawn inside it (a face, stripes on a ball, planks on a crate).
  const main = [...sig].sort((a, b) => b.box.ext - a.box.ext)[0];
  const rest = all.filter((s) => s !== main);
  if (main.closed && main.box.ext >= 0.85 && rest.every((s) => inside(s.box, main.box))) {
    return findFace(main, rest) || soften(classifySingle(main, scale), 0.8);
  }
  return null;
}
