// Edges: the parts of a weapon that bite. A blade driven edge-first into straw or wood hard enough stays stuck there
// (js/dot3d/physics.js stick): a sword or spear by its tip, an axe by its bit. Each edge is a part-local point `p`, the
// direction `dir` it bites in (unit, part-local) and the radius `r` around the point within which a contact counts as
// the edge. Blunt parts (bat, staff, hammer, mace, wooden sword) have a `tip` for the melee sweep but no edge: they
// knock, never stick. Owner, Oct 23 2026 (Codex transmitter): "If I smack a wall with my sword, it should put an axe
// mark into the wall. It should do something, or it should stick. The axe should stick maybe." Claude (Command), Oct 26 2026.

// Built-in combat parts (js/parts/meta/combat.js: handle along +Y, an axe bit built toward +X).
export const EDGES = {
  'sword':      [{ p: [0, 1.05, 0], dir: [0, 1, 0], r: .14 }],
  'katana':     [{ p: [-.041, 1.02, 0], dir: [0, 1, 0], r: .12 }],
  'dagger':     [{ p: [0, .35, 0], dir: [0, 1, 0], r: .07 }],
  'spear':      [{ p: [0, 2.0, 0], dir: [0, 1, 0], r: .12 }],
  'arrow':      [{ p: [0, .8, 0], dir: [0, 1, 0], r: .05 }],
  'halberd':    [{ p: [0, 2.0, 0], dir: [0, 1, 0], r: .12 }],
  'axe':        [{ p: [.17, .66, 0], dir: [1, 0, 0], r: .11 }],
  'battle axe': [{ p: [.26, .93, 0], dir: [1, 0, 0], r: .14 }, { p: [-.26, .93, 0], dir: [-1, 0, 0], r: .14 }],
};

const vec3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
function oneEdge(e) {
  if (!e || !vec3(e.p) || !vec3(e.dir)) return null;
  const n = Math.hypot(e.dir[0], e.dir[1], e.dir[2]);
  if (!(n > 1e-6)) return null;
  const r = +e.r > 0 ? +e.r : .1;
  return { p: [+e.p[0], +e.p[1], +e.p[2]], dir: [e.dir[0] / n, e.dir[1] / n, e.dir[2] / n], r };
}
// The edges of a record's part: an explicit meta.edges (list) or meta.edge (one), which an AI or owner blueprint can
// declare, else the built-in table; [] for a part that does not bite. `scale` is the record's scale (points and reach
// scale with it; the direction does not).
export function edgesFor(part, meta = null, scale = 1) {
  const s = +scale > 0 ? +scale : 1;
  const own = Array.isArray(meta?.edges) ? meta.edges : meta?.edge ? [meta.edge] : null;
  const list = own ?? EDGES[String(part || '').toLowerCase()] ?? [];
  const out = [];
  for (const e of list) {
    const ok = oneEdge(e);
    if (ok) out.push({ p: { x: ok.p[0] * s, y: ok.p[1] * s, z: ok.p[2] * s }, dir: { x: ok.dir[0], y: ok.dir[1], z: ok.dir[2] }, r: ok.r * s });
  }
  return out;
}
