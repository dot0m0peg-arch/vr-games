// Pure fit math for real models standing in for catalog parts (LOOK-BIBLE.md section 5, build order step 7).
// No three.js here: the browser loader (models.js) and the Node manifest tool (tools/manifest-check.mjs) share these
// rules so what the tool accepts is exactly what the game shows. 1 unit = 1 m, +Y up, catalog origin at the bottom
// centre, front toward +Z (kit.js convention). Claude (Command), Oct 26 2026.

// Axis rule: the model's largest bbox axis is scaled to the catalog's largest axis; the other two must then land
// within 15% of the catalog size (the bible's rule) or within 30 mm, whichever is wider (the catalog's own
// tests/parts.test.mjs uses a 50 mm floor at 12% for the sculpts; thin blades would otherwise fail on millimetres).
export const AXIS_TOLERANCE = 0.15;
export const AXIS_FLOOR_M = 0.03;
export const BASE_TOLERANCE_M = 0.01;

// Triangle caps by what the part is (section 5): held 6,000; yard prop 12,000; building 40,000 (castle 60,000); tree 4,000.
export function defaultCap(meta) {
  const name = String(meta?.name || "").toLowerCase();
  if (name === "castle") return 60000;
  if (/\btree\b/.test(name)) return 4000;
  if (meta?.holdable) return 6000;
  const size = meta?.size || [1, 1, 1];
  if (Math.max(...size) >= 5) return 40000;
  return 12000;
}

const DEG = Math.PI / 180;

// Rotation matrix (3x3, row-major) from manifest `rotate` degrees applied in X, Y, Z order (three's default Euler).
export function rotationMatrix([rx = 0, ry = 0, rz = 0] = []) {
  const a = rx * DEG, b = ry * DEG, c = rz * DEG;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // The matrix THREE.Euler order "XYZ" produces (Matrix4.makeRotationFromEuler), element for element.
  return [
    cb * cc, -cb * sc, sb,
    sa * sb * cc + ca * sc, -sa * sb * sc + ca * cc, -sa * cb,
    -ca * sb * cc + sa * sc, ca * sb * sc + sa * cc, ca * cb,
  ];
}

export function applyMatrix(m, [x, y, z]) {
  return [m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z];
}

// The eight corners of a box, for re-measuring after a rotation.
export function corners(min, max) {
  const out = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}

export function boundsOf(points) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let i = 0; i < 3; i++) { if (p[i] < min[i]) min[i] = p[i]; if (p[i] > max[i]) max[i] = p[i]; }
  return { min, max };
}

// Measures a rotated box: bounds of the source box's corners after `rotate`.
export function rotatedBounds(min, max, rotate) {
  const m = rotationMatrix(rotate || [0, 0, 0]);
  return boundsOf(corners(min, max).map((c) => applyMatrix(m, c)));
}

// The fit of a model whose (already rotated) bounds are {min, max} onto a catalog size [w, h, d].
// Returns { ok, scale, size, translate, reasons } where translate (metres, after scaling) moves the base centre to
// the origin and then shifts the model so `handle` (model point in fitted space) lands on `grip` (catalog grip.p).
// `offset` is a manual nudge in metres applied last. Rejection reasons are plain sentences for the manifest.
// `tolerance` (metres per axis, step 8) widens the 15% / 30 mm rule for one entry whose real shape differs from its
// sculpt box by a guard or a head: a sword crossguard thicker than the sculpt blade slab, a spear head wider than the
// shaft. The manifest records why in `fitNote`. It never narrows the rule, never applies to the largest axis, and is
// capped at 120 mm: a body that is twice its collider (a 1.57 m scarecrow on a 0.7 m dummy slot) is still rejected,
// because the colliders stay the sculpt's and a swing would pass through the visible model.
// When the catalog's two largest axes tie (a round shield, a cube), the model's own largest axis picks which one it
// scales to, so a 0.6004 x 0.6 x 0.11 shield is not told to "set rotate".
export const MAX_TOLERANCE_M = 0.12;
export function fitToCatalog(bounds, catalogSize, { grip = null, handle = null, offset = [0, 0, 0], tolerance = null } = {}) {
  const reasons = [];
  const src = [0, 1, 2].map((i) => bounds.max[i] - bounds.min[i]);
  const target = catalogSize.map((n) => +n);
  if (!src.every((n) => Number.isFinite(n) && n > 0)) return { ok: false, scale: 1, size: src, translate: [0, 0, 0], reasons: ["empty or degenerate bounds"] };
  const axis = src.indexOf(Math.max(...src));
  const maxTarget = Math.max(...target);
  const tied = [0, 1, 2].filter((i) => maxTarget - target[i] <= Math.max(AXIS_TOLERANCE * maxTarget, AXIS_FLOOR_M));
  const catalogAxis = tied.includes(axis) ? axis : target.indexOf(maxTarget);
  const scale = target[catalogAxis] / src[axis];
  const size = src.map((n) => n * scale);
  if (axis !== catalogAxis) reasons.push(`largest axis is ${"xyz"[axis]} but the catalog's is ${"xyz"[catalogAxis]} (set rotate)`);
  const tolerances = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (i === catalogAxis) continue;
    const extra = Math.min(MAX_TOLERANCE_M, Math.max(0, +(tolerance?.[i] || 0)));
    const tol = Math.max(AXIS_TOLERANCE * target[i], AXIS_FLOOR_M, extra);
    tolerances[i] = tol;
    if (Math.abs(size[i] - target[i]) > tol) reasons.push(`axis ${"xyz"[i]} fits to ${size[i].toFixed(3)} m, catalog ${target[i]} m (tolerance ${tol.toFixed(3)})`);
  }
  // Base centre to the origin: x/z centred, min y to 0 (all in fitted metres).
  const cx = ((bounds.min[0] + bounds.max[0]) / 2) * scale;
  const cz = ((bounds.min[2] + bounds.max[2]) / 2) * scale;
  const translate = [-cx, -bounds.min[1] * scale, -cz];
  if (grip && handle) for (let i = 0; i < 3; i++) translate[i] += grip[i] - handle[i];
  for (let i = 0; i < 3; i++) translate[i] += +(offset?.[i] || 0);
  return { ok: reasons.length === 0, scale, size, translate, reasons, axis, catalogAxis, tolerances };
}

// Where the fitted model's bounds end up after fitToCatalog: used by the tool to assert the base within 10 mm of y = 0
// (for parts without a grip/handle shift) and by the loader's report.
export function fittedBounds(bounds, fit) {
  const min = [0, 1, 2].map((i) => bounds.min[i] * fit.scale + fit.translate[i]);
  const max = [0, 1, 2].map((i) => bounds.max[i] * fit.scale + fit.translate[i]);
  return { min, max };
}

// Tries the six axis permutations (as rotate triples) and returns them ordered by how well the other two axes fit.
// For the tool's --scan: a human or step 8 copies the suggestion into the manifest; nothing is applied automatically.
export const PERMUTATION_ROTATES = [[0, 0, 0], [0, 0, 90], [90, 0, 0], [0, 90, 0], [90, 90, 0], [0, 90, 90]];
export function suggestRotate(min, max, catalogSize) {
  const tried = PERMUTATION_ROTATES.map((rotate) => {
    const b = rotatedBounds(min, max, rotate);
    const f = fitToCatalog(b, catalogSize);
    const err = [0, 1, 2].filter((i) => i !== f.catalogAxis).reduce((s, i) => s + Math.abs(f.size[i] - catalogSize[i]) / catalogSize[i], 0);
    return { rotate, ok: f.ok, err, size: f.size.map((n) => +n.toFixed(3)) };
  });
  return tried.sort((a, b) => (a.ok === b.ok ? a.err - b.err : a.ok ? -1 : 1));
}
