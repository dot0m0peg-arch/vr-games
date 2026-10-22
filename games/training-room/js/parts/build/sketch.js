// Magic marker parts (ARCHITECTURE.md "Magic marker"): "drawing" = glowing crayon lines in the air,
// "doodle" = the same drawing made solid. Not in the catalog. Origin = the drawing frame origin
// (record p), not bottom-center. Strokes are drawing-local meters (x right, y up, z toward the drawer).
import { kit, THREE } from "./kit.js";
import { STROKE_DEFAULTS, limitStrokes } from "../../core/sketch.js";

export const RADIAL = 6; // tube sides
const MAX_TRIS = 38000; // whole drawing
const MAX_POINTS = 6000;
const SUB_LEN = 0.012; // Catmull-Rom subdivision step (meters)
const MAX_SUB = 3;
const DEPTH = 0.06; // doodle cut-out thickness
const CLOSE_GAP = 0.12; // closed stroke: ends within 12% of the drawing size
const MAX_OUTLINE = 160; // points per extruded outline
const HEX = /^#[0-9a-f]{6}$/i;

const COS = Float32Array.from({ length: RADIAL }, (_, k) => Math.cos((k / RADIAL) * Math.PI * 2));
const SIN = Float32Array.from({ length: RADIAL }, (_, k) => Math.sin((k / RADIAL) * Math.PI * 2));
const C60 = 0.5;
const S60 = Math.sqrt(3) / 2;

// Unlit glowing ink (vertex colors carry the stroke color and its bright core).
let inkMat = null;
function inkMaterial() {
  if (!inkMat) {
    inkMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    inkMat.userData = { shared: true, kind: "glow" };
  }
  return inkMat;
}

let haloMat = null;
function haloMaterial() {
  if (!haloMat) {
    haloMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    haloMat.userData = { shared: true, kind: "glow" };
  }
  return haloMat;
}

let paintMat = null;
function paintMaterial() {
  if (!paintMat) {
    paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 });
    paintMat.userData = { shared: true, kind: "plastic" };
  }
  return paintMat;
}

// Glowing crayon shading: k = how much the surface faces the drawing normal (±Z), 0..1.
// Edges are deep color, the core facing the viewer is brighter and slightly whitened.
// Linear rgb in, written to out[o..].
export function inkColor(rgb, k, out, o) {
  const k2 = k * k;
  const white = 0.12 * k2 * k2;
  const bright = (0.62 + 0.4 * k) * (1 - white);
  out[o] = rgb[0] * bright + white;
  out[o + 1] = rgb[1] * bright + white;
  out[o + 2] = rgb[2] * bright + white;
}

// Additive halo: strongest where it faces the viewer, fading to nothing at its rim.
function haloColor(rgb, k, out, o) {
  const a = 0.22 * k * k * k;
  out[o] = rgb[0] * a;
  out[o + 1] = rgb[1] * a;
  out[o + 2] = rgb[2] * a;
}

const okNum = (v) => Number.isFinite(v) && Math.abs(v) <= 1000;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const rgbOf = (hex) => new THREE.Color(hex).toArray();

// data.strokes → [{ line: Vector3[], w, c }] (bad points dropped, repeats merged). Never throws.
function parseStrokes(strokes) {
  const out = [];
  for (const s of Array.isArray(strokes) ? strokes : []) {
    const pts = s && (Array.isArray(s.pts) || ArrayBuffer.isView(s.pts)) ? s.pts : null;
    if (!pts) continue;
    const line = [];
    for (let i = 0; i + 2 < pts.length; i += 3) {
      const x = pts[i];
      const y = pts[i + 1];
      const z = pts[i + 2];
      if (!okNum(x) || !okNum(y) || !okNum(z)) continue;
      const prev = line[line.length - 1];
      if (prev && Math.abs(prev.x - x) + Math.abs(prev.y - y) + Math.abs(prev.z - z) < 1e-5) continue;
      line.push(new THREE.Vector3(x, y, z));
    }
    if (!line.length) continue;
    const w = clamp(Number(s.w) || STROKE_DEFAULTS.width, 0.002, 0.1);
    const c = typeof s.c === "string" && HEX.test(s.c) ? s.c.toLowerCase() : STROKE_DEFAULTS.color;
    out.push({ line, w, c });
  }
  return out;
}

// Strokes that fit the triangle budget: simplified (shared limitStrokes) when too dense.
// trisPer(points, strokes) estimates the cost. → { list, sub } (sub = Catmull-Rom steps per segment).
function budgeted(strokes, trisPer, reserve = 0) {
  let list = parseStrokes(strokes);
  const count = (l) => l.reduce((n, s) => n + s.line.length, 0);
  let points = count(list);
  if (points > MAX_POINTS) {
    list = parseStrokes(limitStrokes(strokes, MAX_POINTS));
    points = count(list);
  }
  const budget = MAX_TRIS - reserve;
  if (trisPer(points, list.length) > budget) {
    // Largest point count that fits, then let limitStrokes simplify down to it.
    let max = points;
    while (max > list.length && trisPer(max, list.length) > budget) max = Math.floor(max * 0.9);
    list = parseStrokes(limitStrokes(strokes, max));
    points = count(list);
  }
  const segs = Math.max(1, points - list.length);
  const perSegment = trisPer(points + 1, list.length) - trisPer(points, list.length);
  const spare = (budget - trisPer(points, list.length)) / perSegment;
  const sub = clamp(Math.floor(1 + spare / segs), 1, MAX_SUB);
  return { list, sub };
}

// Sharp turn (> ~50°) at point i: segments touching it stay straight so corners do not bulge.
function isCorner(line, i) {
  if (i <= 0 || i >= line.length - 1) return false;
  _a.subVectors(line[i], line[i - 1]).normalize();
  _d.subVectors(line[i + 1], line[i]).normalize();
  return _a.dot(_d) < 0.64;
}

// Centripetal Catmull-Rom through the points, `sub` steps at most per segment (short ones fewer).
function smoothLine(line, sub) {
  if (line.length < 3 || sub <= 1) return line;
  const curve = new THREE.CatmullRomCurve3(line, false, "centripetal");
  const last = line.length - 1;
  const out = [line[0]];
  let corner = false;
  for (let i = 0; i < last; i++) {
    const next = isCorner(line, i + 1);
    const straight = corner || next;
    corner = next;
    const n = straight ? 1 : Math.min(sub, Math.max(1, Math.ceil(line[i].distanceTo(line[i + 1]) / SUB_LEN)));
    for (let k = 1; k < n; k++) out.push(curve.getPoint((i + k / n) / last, new THREE.Vector3()));
    out.push(line[i + 1]);
  }
  return out;
}

// ---------- tube mesh builder ----------

const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _a = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);
const _x = new THREE.Vector3(1, 0, 0);

// Any unit vector perpendicular to t, preferring the drawing plane (so B ends up along ±Z).
export function initNormal(t, out) {
  out.crossVectors(Math.abs(t.z) < 0.99 ? _z : _x, t);
  return out.normalize();
}

// shade(rgb, facing, out, o) colors the vertex from how much it faces ±Z; null = flat color.
function pushVertex(buf, x, y, z, nx, ny, nz, rgb, shade) {
  const o = buf.v * 3;
  buf.pos[o] = x;
  buf.pos[o + 1] = y;
  buf.pos[o + 2] = z;
  buf.nor[o] = nx;
  buf.nor[o + 1] = ny;
  buf.nor[o + 2] = nz;
  if (shade) shade(rgb, Math.abs(nz), buf.col, o);
  else {
    buf.col[o] = rgb[0];
    buf.col[o + 1] = rgb[1];
    buf.col[o + 2] = rgb[2];
  }
  return buf.v++;
}

// One ring of RADIAL vertices around p: radius rr, pushed `along` the tangent; normal = radial * nr + t * nt.
function pushRing(buf, p, t, n, b, rr, along, nr, nt, rgb, shade) {
  const start = buf.v;
  for (let k = 0; k < RADIAL; k++) {
    _d.copy(n).multiplyScalar(COS[k]).addScaledVector(b, SIN[k]);
    pushVertex(buf, p.x + _d.x * rr + t.x * along, p.y + _d.y * rr + t.y * along, p.z + _d.z * rr + t.z * along,
      _d.x * nr + t.x * nt, _d.y * nr + t.y * nt, _d.z * nr + t.z * nt, rgb, shade);
  }
  return start;
}

function tri(buf, a, b, c) {
  buf.idx[buf.i++] = a;
  buf.idx[buf.i++] = b;
  buf.idx[buf.i++] = c;
}

// Quads between ring a and the next ring c along the tangent (outward, counter-clockwise).
function stitch(buf, a, c) {
  for (let k = 0; k < RADIAL; k++) {
    const k1 = (k + 1) % RADIAL;
    tri(buf, a + k, a + k1, c + k);
    tri(buf, a + k1, c + k1, c + k);
  }
}

// Tube along line (Vector3[]), parallel-transport frames, rounded ends (capRing) or cone ends.
// shade: vertex color function (inkColor, haloColor) or null for the flat stroke color.
function addTube(buf, { line, radius, rgb, shade, capRing }) {
  let pts = line;
  if (pts.length === 1) {
    // A dot: a short capsule.
    const p = pts[0];
    pts = [p.clone().addScaledVector(_x, -radius * 0.3), p.clone().addScaledVector(_x, radius * 0.3)];
  }
  const n = pts.length;
  let prev = -1;
  _t.copy(_x);
  for (let i = 0; i < n; i++) {
    const t = _a.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]);
    if (t.lengthSq() >= 1e-14) _t.copy(t).normalize();
    if (i === 0) initNormal(_t, _n);
    else {
      _n.addScaledVector(_t, -_n.dot(_t));
      if (_n.lengthSq() < 1e-10) initNormal(_t, _n);
      _n.normalize();
    }
    _b.crossVectors(_t, _n);
    const p = pts[i];
    if (i === 0) {
      // Start cap: tip, then (optionally) a ring at 60° latitude, then the first full ring.
      const tip = pushVertex(buf, p.x - _t.x * radius, p.y - _t.y * radius, p.z - _t.z * radius, -_t.x, -_t.y, -_t.z, rgb, shade);
      const first = capRing ? pushRing(buf, p, _t, _n, _b, radius * C60, -radius * S60, C60, -S60, rgb, shade) : -1;
      prev = pushRing(buf, p, _t, _n, _b, radius, 0, 1, 0, rgb, shade);
      const fan = capRing ? first : prev;
      for (let k = 0; k < RADIAL; k++) tri(buf, tip, fan + ((k + 1) % RADIAL), fan + k);
      if (capRing) stitch(buf, first, prev);
      continue;
    }
    const ring = pushRing(buf, p, _t, _n, _b, radius, 0, 1, 0, rgb, shade);
    stitch(buf, prev, ring);
    prev = ring;
  }
  // End cap.
  const p = pts[n - 1];
  let last = prev;
  if (capRing) {
    last = pushRing(buf, p, _t, _n, _b, radius * C60, radius * S60, C60, S60, rgb, shade);
    stitch(buf, prev, last);
  }
  const tip = pushVertex(buf, p.x + _t.x * radius, p.y + _t.y * radius, p.z + _t.z * radius, _t.x, _t.y, _t.z, rgb, shade);
  for (let k = 0; k < RADIAL; k++) tri(buf, last + k, last + ((k + 1) % RADIAL), tip);
}

// Writes the queued tubes ({ line, radius, rgb, shade, capRing }) into one preallocated mesh.
function tubeMesh(jobs, material, name) {
  let verts = 0;
  let index = 0;
  for (const job of jobs) {
    const rings = Math.max(2, job.line.length) + (job.capRing ? 2 : 0);
    verts += rings * RADIAL + 2;
    index += ((rings - 1) * 2 + 2) * RADIAL * 3;
  }
  const buf = {
    pos: new Float32Array(verts * 3), nor: new Float32Array(verts * 3), col: new Float32Array(verts * 3),
    idx: verts > 65535 ? new Uint32Array(index) : new Uint16Array(index), v: 0, i: 0,
  };
  for (const job of jobs) addTube(buf, job);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(buf.pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(buf.nor, 3));
  g.setAttribute("color", new THREE.BufferAttribute(buf.col, 3));
  g.setIndex(new THREE.BufferAttribute(buf.idx, 1));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, material);
  mesh.name = name;
  return mesh;
}

// Triangles of a tube: 2R per segment, plus per stroke two caps (3R each with a cap ring, R without).
const tubeTris = (capRing) => (points, strokes) => 2 * RADIAL * (points - strokes) + strokes * RADIAL * (capRing ? 6 : 2);

function empty(name) {
  const root = new THREE.Group();
  root.visible = false;
  return kit.finish(root, name);
}

// ---------- doodle helpers (2D in the drawing plane) ----------

function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  return a / 2;
}

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function box2(line) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let z = 0;
  for (const p of line) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    z += p.z / line.length;
  }
  return { minX, minY, maxX, maxY, ext: Math.max(maxX - minX, maxY - minY), z };
}

// Closed stroke: ends meet (within 12% of the drawing size), not a speck, encloses some area.
function isClosed(line, box, ext) {
  if (line.length < 4 || box.ext < 0.05 * ext) return false;
  const gap = Math.hypot(line[0].x - line[line.length - 1].x, line[0].y - line[line.length - 1].y);
  return gap <= CLOSE_GAP * ext && gap <= 0.3 * box.ext && Math.abs(signedArea(line)) >= 0.02 * box.ext * box.ext;
}

// Outline for extrusion: ≤ MAX_OUTLINE points, no repeated closing point. → Vector2[]
function outline2d(line) {
  const stride = Math.ceil(line.length / MAX_OUTLINE);
  const out = [];
  for (let i = 0; i < line.length; i += stride) out.push(new THREE.Vector2(line[i].x, line[i].y));
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 3 && Math.abs(first.x - last.x) + Math.abs(first.y - last.y) < 1e-4) out.pop();
  return out;
}

// Concatenates non-indexed geometries (position + normal).
function mergeFlat(geometries) {
  let count = 0;
  for (const g of geometries) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  let o = 0;
  for (const g of geometries) {
    pos.set(g.attributes.position.array, o);
    nor.set(g.attributes.normal.array, o);
    o += g.attributes.position.count * 3;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}

const flatten = (line, z) => line.map((p) => new THREE.Vector3(p.x, p.y, z));

export const builders = {
  // Glowing crayon lines: one ink tube mesh for the whole drawing (colors in the vertices) and a
  // wider additive halo around it.
  drawing(opts) {
    const strokes = opts?.data?.strokes;
    const capRing = !Array.isArray(strokes) || strokes.length <= 400;
    const { list, sub } = budgeted(strokes, (p, s) => 2 * tubeTris(capRing)(p, s));
    if (!list.length) return empty("drawing");
    const ink = [];
    const halo = [];
    for (const s of list) {
      const line = smoothLine(s.line, sub);
      const rgb = rgbOf(s.c);
      ink.push({ line, radius: s.w / 2, rgb, shade: inkColor, capRing });
      halo.push({ line, radius: s.w * 1.4, rgb, shade: haloColor, capRing });
    }
    const mesh = kit.place(tubeMesh(ink, inkMaterial(), "ink"), { tint: true });
    const glow = tubeMesh(halo, haloMaterial(), "halo");
    glow.renderOrder = 1;
    return kit.finish(kit.group([mesh, glow]), "drawing");
  },

  // The drawing made solid: closed strokes → extruded cut-outs with a rounded rim, open strokes →
  // thick tubes. Strokes drawn inside a cut-out sit on both of its faces; nested cut-outs are thicker.
  doodle(opts) {
    const strokes = opts?.data?.strokes;
    const capRing = !Array.isArray(strokes) || strokes.length <= 400;
    // Reserve room for up to ~12 extruded outlines (about 4 triangles per outline point).
    const { list, sub } = budgeted(strokes, (p, s) => 2 * tubeTris(capRing)(p, s), MAX_OUTLINE * 4 * 12);
    if (!list.length) return empty("doodle");
    for (const s of list) s.box = box2(s.line);
    const ext = Math.max(box2(list.flatMap((s) => s.line)).ext, 1e-6);
    const closed = list.filter((s) => isClosed(s.line, s.box, ext));
    for (const s of closed) {
      s.closed = true;
      s.poly = outline2d(s.line);
      s.area = Math.abs(signedArea(s.poly));
    }
    // Container: the smallest larger cut-out that holds a point of the stroke.
    const holder = (s, x, y) => {
      let best = null;
      for (const c of closed) {
        if (c === s || (s.closed && c.area <= s.area) || !inPolygon(x, y, c.poly)) continue;
        if (!best || c.area < best.area) best = c;
      }
      return best;
    };
    for (const s of closed) {
      const mid = s.poly.reduce((m, p) => m.add(p), new THREE.Vector2()).divideScalar(s.poly.length);
      s.parent = holder(s, mid.x, mid.y);
    }
    const depthOf = (s) => {
      let d = DEPTH;
      for (let p = s.parent; p; p = p.parent) d += 0.02;
      return d;
    };
    const rootZ = (s) => {
      let r = s;
      while (r.parent) r = r.parent;
      return r.box.z;
    };
    const fills = new Map(); // color → geometries
    const paint = [];
    for (const s of list) {
      const rgb = rgbOf(s.c);
      if (s.closed) {
        const depth = depthOf(s);
        const z = rootZ(s);
        try {
          const g = new THREE.ExtrudeGeometry(new THREE.Shape(s.poly), { depth, bevelEnabled: false, curveSegments: 1 });
          g.deleteAttribute("uv");
          g.translate(0, 0, z - depth / 2);
          if (!fills.has(s.c)) fills.set(s.c, []);
          fills.get(s.c).push(g.index ? g.toNonIndexed() : g);
        } catch {
          // Unusable outline (self-intersecting mess): the rim alone still shows it.
        }
        const ring = flatten(smoothLine(s.line, sub), z);
        ring.push(ring[0].clone());
        paint.push({ line: ring, radius: depth / 2 + 0.004, rgb: rgb.map((v) => v * 0.45), shade: null, capRing });
        continue;
      }
      // Open stroke: thick tube; drawn on a cut-out it sits on both faces.
      const mid = s.line[s.line.length >> 1];
      const on = holder(s, mid.x, mid.y);
      const line = smoothLine(s.line, sub);
      const radius = s.w * 1.25;
      if (on) {
        const z = rootZ(on);
        const half = depthOf(on) / 2;
        paint.push({ line: flatten(line, z + half), radius, rgb, shade: null, capRing });
        paint.push({ line: flatten(line, z - half), radius, rgb, shade: null, capRing });
      } else paint.push({ line, radius, rgb, shade: null, capRing });
    }
    const parts = [];
    for (const [c, geometries] of fills) {
      const mesh = new THREE.Mesh(mergeFlat(geometries), kit.mat(c, "plastic"));
      parts.push(kit.place(mesh, { name: "fill", tint: true }));
    }
    if (paint.length) parts.push(tubeMesh(paint, paintMaterial(), "paint"));
    return kit.finish(kit.group(parts), "doodle");
  },
};
