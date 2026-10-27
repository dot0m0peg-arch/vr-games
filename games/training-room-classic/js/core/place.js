// Turns a placement intent ("to my left", "on the card table") into an absolute pose.
// Yaw convention (ARCHITECTURE.md): forward = [-sin θ, 0, -cos θ], right = [cos θ, 0, -sin θ].

const GAP = 0.3;
const STEP = 0.5;
const MAX_STEPS = 40;
const DEFAULT_HEAD = [0, 1.6, 0];

// "+ 0" turns -0 into 0 so results compare cleanly.
export function forwardOf(yaw = 0) {
  return [-Math.sin(yaw) + 0, 0, -Math.cos(yaw) + 0];
}

export function rightOf(yaw = 0) {
  return [Math.cos(yaw) + 0, 0, -Math.sin(yaw) + 0];
}

// Yaw that turns an object at `from` (front = local +Z) toward `to`.
export function faceYaw(from, to) {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return 0;
  return Math.atan2(dx, dz);
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const r4 = (n) => Math.round(n * 10000) / 10000;
const round3 = (p) => [r3(p[0]) + 0, r3(p[1]) + 0, r3(p[2]) + 0];

// Rotates a local xz offset by yaw (three.js rotation.y).
function rotY(x, z, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

function defaultSizeOf(ctx) {
  return (record) => {
    const meta = ctx.metaOf?.(record.part);
    const size = record.data?.blueprint?.size || meta?.size || [0.8, 0.8, 0.8];
    const s = record.s || 1;
    return [size[0] * s, size[1] * s, size[2] * s];
  };
}

function nameMatches(record, name) {
  const n = String(name || "").toLowerCase();
  return record.part === n || String(record.label || "").toLowerCase() === n;
}

// Finds the record a placement ref points at ({ id } | { batch } | { ref } | { part, which }).
export function findRef(ref, ctx) {
  if (!ref) return null;
  const records = ctx.records || [];
  if (ref.id) return records.find((r) => r.id === ref.id) || null;
  if (ref.batch !== undefined) return (ctx.batch || [])[ref.batch] || null;
  if (ref.ref === "it" || ref.ref === "last") return records[records.length - 1] || null;
  if (ref.part) {
    const head = ctx.player?.p || DEFAULT_HEAD;
    const matches = records.filter((r) => nameMatches(r, ref.part));
    if (!matches.length) return null;
    if (ref.which === "last") return matches[matches.length - 1];
    if (Number.isInteger(ref.which)) return matches[ref.which - 1] || null;
    let best = null;
    let bestD = Infinity;
    for (const r of matches) {
      const d = Math.hypot(r.p[0] - head[0], r.p[2] - head[2]);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  }
  return null;
}

function radiusOf(size) {
  return 0.5 * Math.max(size[0], size[2]);
}

// Ground records whose footprint circles the new object must not overlap.
function obstacles(ctx, sizeOf) {
  const exclude = ctx.exclude instanceof Set ? ctx.exclude : new Set(ctx.exclude || []);
  const out = [];
  for (const r of ctx.records || []) {
    if (!r || r.attach || r.onto || exclude.has(r.id) || !Array.isArray(r.p)) continue;
    if ((r.p[1] || 0) > 0.3) continue;
    out.push({ x: r.p[0], z: r.p[2], r: radiusOf(sizeOf(r)) });
  }
  return out;
}

// Pushes p along dir (unit xz) until its footprint clears every obstacle.
function avoid(p, dir, radius, list) {
  const blocked = () => list.some((o) => Math.hypot(p[0] - o.x, p[2] - o.z) < radius + o.r - 1e-6);
  for (let i = 0; i < MAX_STEPS && blocked(); i++) {
    p[0] += dir[0] * STEP;
    p[2] += dir[2] * STEP;
  }
  return p;
}

function surfaceTop(ref, meta, refSize) {
  const s = ref.s || 1;
  if (meta && typeof meta.surface === "number") return ref.p[1] + meta.surface * s;
  return ref.p[1] + refSize[1];
}

// Picks a free spot on top of `ref` (surface frame), avoiding records already placed onto it.
function surfaceSpot(ref, size, ctx, sizeOf, exclude) {
  const meta = ref.data?.blueprint ? null : ctx.metaOf?.(ref.part);
  const refSize = sizeOf(ref);
  const s = ref.s || 1;
  const area = meta?.surfaceSize ? [meta.surfaceSize[0] * s, meta.surfaceSize[1] * s] : [refSize[0] * 0.9, refSize[2] * 0.9];
  const top = surfaceTop(ref, meta, refSize);
  const ry = ref.ry || 0;
  const occupied = [];
  for (const r of ctx.records || []) {
    if (!r || r.onto !== ref.id || exclude.has(r.id)) continue;
    const [lx, lz] = rotY(r.p[0] - ref.p[0], r.p[2] - ref.p[2], -ry);
    const a = (r.ry || 0) - ry;
    const rs = sizeOf(r);
    const hx = (Math.abs(Math.cos(a)) * rs[0] + Math.abs(Math.sin(a)) * rs[2]) / 2;
    const hz = (Math.abs(Math.sin(a)) * rs[0] + Math.abs(Math.cos(a)) * rs[2]) / 2;
    occupied.push({ x: lx, z: lz, hx, hz, top: r.p[1] + rs[1] });
  }
  const hx = size[0] / 2;
  const hz = size[2] / 2;
  const free = (x, z) => occupied.every((o) => Math.abs(x - o.x) >= hx + o.hx - 1e-6 || Math.abs(z - o.z) >= hz + o.hz - 1e-6);
  let spot = null;
  if (free(0, 0)) spot = [0, 0];
  else {
    const sx = size[0] + 0.04;
    const sz = size[2] + 0.04;
    const nx = Math.max(0, Math.floor((area[0] / 2 - hx) / sx));
    const nz = Math.max(0, Math.floor((area[1] / 2 - hz) / sz));
    const head = ctx.player?.p || DEFAULT_HEAD;
    const [px, pz] = rotY(head[0] - ref.p[0], head[2] - ref.p[2], -ry);
    const candidates = [];
    for (let i = -nx; i <= nx; i++) for (let j = -nz; j <= nz; j++) {
      if (candidates.length > 400) break;
      const x = i * sx;
      const z = j * sz;
      candidates.push({ x, z, d: Math.hypot(x, z), toward: Math.hypot(x - px, z - pz) });
    }
    candidates.sort((a, b) => a.d - b.d || a.toward - b.toward);
    for (const c of candidates) {
      if (free(c.x, c.z)) {
        spot = [c.x, c.z];
        break;
      }
    }
  }
  let y = top;
  if (!spot) {
    // Surface full: stack on the tallest thing at the center.
    spot = [0, 0];
    for (const o of occupied) if (Math.abs(o.x) < o.hx + hx && Math.abs(o.z) < o.hz + hz) y = Math.max(y, o.top);
  }
  const [wx, wz] = rotY(spot[0], spot[1], ry);
  return { p: [ref.p[0] + wx, y, ref.p[2] + wz], ry };
}

// Half extent of a (possibly rotated) record footprint along unit xz direction u.
function extentAlong(record, size, u) {
  const ry = record.ry || 0;
  const ax = [Math.cos(ry), -Math.sin(ry)];
  const az = [Math.sin(ry), Math.cos(ry)];
  return (Math.abs(u[0] * ax[0] + u[2] * ax[1]) * size[0] + Math.abs(u[0] * az[0] + u[2] * az[1]) * size[2]) / 2;
}

function handPose(player, hand) {
  const h = player?.hands?.[hand];
  return h && Array.isArray(h.p) ? h.p : null;
}

// A pointed-at ground spot within reach, or null.
const AIM_RANGE = 150;
function aimPoint(aim, head) {
  if (!Array.isArray(aim) || aim.length < 3 || !aim.every(Number.isFinite)) return null;
  return Math.hypot(aim[0] - head[0], aim[2] - head[2]) <= AIM_RANGE ? aim : null;
}

// → { p, ry, attach?, onto? }. See ARCHITECTURE.md "Placement".
export function resolvePlacement(place, ctx = {}) {
  const pl = place && typeof place === "object" ? place : {};
  const player = ctx.player || {};
  const head = Array.isArray(player.p) ? player.p : DEFAULT_HEAD;
  const yaw = player.yaw || 0;
  const size = Array.isArray(ctx.size) ? ctx.size : [1, 1, 1];
  const radius = radiusOf(size);
  const sizeOf = ctx.sizeOf || defaultSizeOf(ctx);
  const exclude = ctx.exclude instanceof Set ? ctx.exclude : new Set(ctx.exclude || []);
  const fwd = forwardOf(yaw);
  const right = rightOf(yaw);
  const userDist = typeof pl.dist === "number" && Number.isFinite(pl.dist) && pl.dist > 0 ? Math.min(pl.dist, 2000) : null;
  const rel = pl.rel || "front";

  // Kingdom mode sends the ground point under the player's pointer ("build a house right here").
  const aim = aimPoint(player.aim, head);
  if (aim && (rel === "here" || (rel === "front" && pl.point === true))) {
    const dx = aim[0] - head[0];
    const dz = aim[2] - head[2];
    const len = Math.hypot(dx, dz);
    const dir = len > 0.05 ? [dx / len, 0, dz / len] : fwd;
    const need = radius + GAP;
    const p = len < need ? [head[0] + dir[0] * need, 0, head[2] + dir[2] * need] : [aim[0], 0, aim[2]];
    avoid(p, dir, radius, obstacles({ ...ctx, exclude }, sizeOf));
    return { p: round3(p), ry: r4(faceYaw(p, head)) };
  }

  const ground = (dir, dist) => {
    const p = [head[0] + dir[0] * dist, 0, head[2] + dir[2] * dist];
    avoid(p, dir, radius, obstacles({ ...ctx, exclude }, sizeOf));
    return { p: round3(p), ry: r4(faceYaw(p, head)) };
  };
  const clearance = (d) => Math.max(d, radius + GAP);
  const directional = (dir) => ground(dir, clearance(userDist ?? Math.max(1.4, radius + 1.0)));

  switch (rel) {
    case "left":
      return directional([-right[0], 0, -right[2]]);
    case "right":
      return directional(right);
    case "behind":
      return directional([-fwd[0], 0, -fwd[2]]);
    case "far":
      return ground(fwd, clearance(userDist ?? Math.max(20, radius + 10)));
    case "here":
    case "feet":
      return ground(fwd, clearance(userDist ?? 0.7));
    case "above": {
      // "above the desk": over the ref's top (dist = gap), else over the player's line of sight.
      const over = findRef(pl.ref, ctx);
      if (over && !exclude.has(over.id)) {
        const p = [over.p[0], over.p[1] + sizeOf(over)[1] + (userDist ?? 1), over.p[2]];
        return { p: round3(p), ry: r4(faceYaw(p, head)) };
      }
      const d = userDist ?? 1.5;
      const p = [head[0] + fwd[0] * d, head[1] + 1.2, head[2] + fwd[2] * d];
      return { p: round3(p), ry: r4(faceYaw(p, head)) };
    }
    case "hand": {
      const hand = pl.hand === "left" || pl.hand === "right" ? pl.hand : ctx.hand === "left" ? "left" : "right";
      const hp = handPose(player, hand);
      const p = hp ? [...hp] : [head[0] + fwd[0] * 0.4, head[1] - 0.3, head[2] + fwd[2] * 0.4];
      return { p: round3(p), ry: r4(yaw), attach: { user: player.user, hand, grip: "snap" } };
    }
    case "at": {
      if (Array.isArray(pl.p) && pl.p.length === 3 && pl.p.every(Number.isFinite)) {
        const p = [pl.p[0], Math.max(0, pl.p[1]), pl.p[2]];
        const ry = typeof pl.ry === "number" && Number.isFinite(pl.ry) ? pl.ry : faceYaw(p, head);
        return { p: round3(p), ry: r4(ry) };
      }
      return directional(fwd);
    }
    case "on": {
      const ref = findRef(pl.ref, ctx);
      if (!ref || exclude.has(ref.id)) return directional(fwd);
      const spot = surfaceSpot(ref, size, ctx, sizeOf, exclude);
      return { p: round3(spot.p), ry: r4(spot.ry), onto: ref.id };
    }
    case "next": {
      const ref = findRef(pl.ref, ctx);
      if (!ref || exclude.has(ref.id)) return directional([-right[0], 0, -right[2]]);
      let vx = ref.p[0] - head[0];
      let vz = ref.p[2] - head[2];
      const len = Math.hypot(vx, vz);
      if (len < 0.05) {
        vx = fwd[0];
        vz = fwd[2];
      } else {
        vx /= len;
        vz /= len;
      }
      const sides = { left: [vz, 0, -vx], right: [-vz, 0, vx], front: [-vx, 0, -vz], behind: [vx, 0, vz] };
      const u = sides[pl.side] || sides.left;
      const refSize = sizeOf(ref);
      // "20 meters to the left of the crate": dist is center to center, never closer than touching.
      const off = Math.max(userDist ?? 0, extentAlong(ref, refSize, u) + GAP + radius);
      const raised = (ref.p[1] || 0) > 0.05 && ref.onto;
      const p = [ref.p[0] + u[0] * off, raised ? ref.p[1] : 0, ref.p[2] + u[2] * off];
      // The reference itself is cleared by its box extent above; its footprint circle would over-push.
      if (!raised) avoid(p, u, radius, obstacles({ ...ctx, exclude: new Set([...exclude, ref.id]) }, sizeOf));
      const out = { p: round3(p), ry: r4(faceYaw(p, head)) };
      if (raised) out.onto = ref.onto;
      return out;
    }
    case "front":
    default:
      return directional(fwd);
  }
}
