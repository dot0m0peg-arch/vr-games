// Grab, hold, throw and weapon hits for the local player's hands (VR controllers or the desktop
// virtual hands). Events: "grab" { hand, id, distance }, "release" { hand, id, thrown },
// "hit" { hand, id, power, speed }, "haptic" { hand, intensity }, "swing" { hand }.
//
// Desktop swing: swing(hand) runs a 0.25 s chop. Hit tests apply it internally; for visuals the
// app applies it to the local hand pose used to position held objects:
//   getHand(me, hand) → interact.applySwing(hand, localHand(hand))
// while interact.update() keeps receiving the raw hand poses.
import * as THREE from "../../vendor/three.module.min.js";
import { Emitter } from "../util/emitter.js";

const HANDS = ["left", "right"];
const NEAR = 0.2; // meters from the hand for a direct grab
const RAY_MAX = 12; // meters for a distance grab
const MAX_GRAB_SIZE = 3; // non-holdables bigger than this are never grabbable
const HOLDABLE_BIAS = 0.08; // ranking penalty for non-holdables in direct grabs
const PALM_GAP = 0.12; // distance grabs land this far in front of the palm
const THROW_MIN = 1.2; // m/s
const THROW_MAX = 25; // m/s
const HISTORY = 16; // hand samples kept per hand
const VEL_WINDOW = 0.1; // seconds of history used for the throw velocity
const HIT_MIN = 1.5; // tip speed m/s
const HIT_PAD = 0.05;
const HIT_COOLDOWN = 0.25; // seconds per target per hand
const SWING_TIME = 0.25;
const SURFACE_REACH = 1.5; // max drop height onto a surface (meters)
const ANIM_SLACK = 1.5; // behaviors (swim, fly, walk) move the mesh around the record pose
const DEG = Math.PI / 180;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const AXES = ["x", "y", "z"];
const ZERO = new THREE.Vector3();

const round = (n, step = 1e4) => Math.round(n * step) / step;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function setVec(out, v) {
  if (!v) return out.set(0, 0, 0);
  if (v.isVector3) return out.copy(v);
  if (Array.isArray(v)) return out.set(+v[0] || 0, +v[1] || 0, +v[2] || 0);
  return out.set(+v.x || 0, +v.y || 0, +v.z || 0);
}

function setQuat(out, q) {
  if (!q) return out.identity();
  if (q.isQuaternion) return out.copy(q);
  if (Array.isArray(q)) return out.set(+q[0] || 0, +q[1] || 0, +q[2] || 0, Number.isFinite(+q[3]) ? +q[3] : 1);
  return out.set(+q.x || 0, +q.y || 0, +q.z || 0, Number.isFinite(+q.w) ? +q.w : 1);
}

// Yaw (record ry) of a world rotation: where the object's front (+Z) points on the ground plane.
function yawOf(q, tmp) {
  const f = tmp.set(0, 0, 1).applyQuaternion(q);
  if (Math.hypot(f.x, f.z) > 0.2) return Math.atan2(f.x, f.z);
  const x = tmp.set(1, 0, 0).applyQuaternion(q);
  return Math.atan2(-x.z, x.x);
}

// Segment a→b against an axis-aligned box (slab test).
export function segmentHitsBox(a, b, box) {
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const k = AXES[i];
    const d = b[k] - a[k];
    const min = box.min[k];
    const max = box.max[k];
    if (Math.abs(d) < 1e-9) {
      if (a[k] < min || a[k] > max) return false;
      continue;
    }
    let ta = (min - a[k]) / d;
    let tb = (max - a[k]) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

// Chop arc in grip space: wind up (0 → +45°), strike (+45° → -80°), recover (→ 0).
function swingAngle(u) {
  if (u < 0.2) {
    const k = u / 0.2;
    return 45 * DEG * (1 - (1 - k) * (1 - k));
  }
  if (u < 0.7) {
    const k = (u - 0.2) / 0.5;
    return (45 - 125 * k * k) * DEG;
  }
  const k = (u - 0.7) / 0.3;
  return -80 * DEG * (1 - k) * (1 - k);
}

export class Interact extends Emitter {
  constructor({ objects, room, getUser, metaOf, send, fx }) {
    super();
    this.objects = objects;
    this.room = room;
    this.getUser = getUser || (() => "local");
    this.metaOf = metaOf || (() => ({}));
    this.send = send || (() => {});
    this.fx = fx || (() => {});
    this._time = 0;
    this._metaCache = new Map();
    this._hittables = [];
    this._hitRefresh = 0;
    this._hands = {};
    for (const hand of HANDS) {
      this._hands[hand] = {
        held: null,
        hist: new Float64Array(HISTORY * 4), // [t, x, y, z] ring buffer
        histHead: 0,
        histCount: 0,
        pose: { p: new THREE.Vector3(), q: new THREE.Quaternion() },
        hasPose: false,
        tip: new THREE.Vector3(),
        prevTip: new THREE.Vector3(),
        tipVel: new THREE.Vector3(),
        tipValid: false,
        tipFor: null,
        swing: -1,
        swingQ: new THREE.Quaternion(),
        cool: new Map(),
      };
    }
    // Temporaries.
    this._box = new THREE.Box3();
    this._box2 = new THREE.Box3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._euler = new THREE.Euler();
    this._vel = new THREE.Vector3();
    this._radius = 0;
    this._wp = { p: new THREE.Vector3(), q: new THREE.Quaternion(), ry: 0 };
    this._wpOut = { p: new THREE.Vector3(), q: new THREE.Quaternion() }; // filled by SceneObjects.worldPose
  }

  get state() {
    return this.room?.state || { objects: {}, order: [] };
  }

  // ---------- meta, size, bounds ----------

  _meta(record) {
    const cached = this._metaCache.get(record.id);
    if (cached && cached.part === record.part && cached.data === record.data) return cached.meta;
    const meta = this.metaOf(record) || {};
    this._metaCache.set(record.id, { part: record.part, data: record.data, meta });
    if (this._metaCache.size > 2 * this.state.order.length + 64) this._pruneMeta();
    return meta;
  }

  _pruneMeta() {
    const objects = this.state.objects;
    for (const id of this._metaCache.keys()) if (!objects[id]) this._metaCache.delete(id);
  }

  _size(record, meta, out) {
    const size = Array.isArray(meta.size) ? meta.size : [0.8, 0.8, 0.8];
    const s = record.s || 1;
    return out.set(size[0] * s, size[1] * s, size[2] * s);
  }

  // Grabbable: holdable, or at most 3 m on every axis and not heavy. Drawings stay where drawn.
  grabbable(record) {
    if (!record || record.part === "drawing") return false;
    const meta = this._meta(record);
    if (meta.holdable) return true;
    if (meta.heavy || meta.fixed) return false;
    const size = this._size(record, meta, this._v3);
    return Math.max(size.x, size.y, size.z) <= MAX_GRAB_SIZE;
  }

  _canGrab(record, me) {
    if (!record) return false;
    if (record.attach && record.attach.user !== me) return false;
    return this.grabbable(record);
  }

  // Generous bounding sphere (current world pose + meta size, with slack for animated behaviors)
  // → center in out, radius in this._radius. Used to skip exact bounds for far-away records.
  _roughSphere(record, out) {
    const meta = this._meta(record);
    const size = Array.isArray(meta.size) ? meta.size : [0.8, 0.8, 0.8];
    const s = record.s || 1;
    const pose = this._worldPose(record);
    this._radius = 0.5 * s * Math.hypot(size[0], size[1], size[2]) + ANIM_SLACK;
    return out.set(pose.p.x, pose.p.y + (size[1] * s) / 2, pose.p.z);
  }

  // World AABB of a record: objects.bounds(id) when available, else from the record pose and size.
  _bounds(record, out) {
    const b = this.objects?.bounds?.(record.id, out);
    if (b && b.min && b.max) {
      if (b !== out) {
        setVec(out.min, b.min);
        setVec(out.max, b.max);
      }
      if (!out.isEmpty()) return out;
    }
    const meta = this._meta(record);
    const size = this._size(record, meta, this._v3);
    const pose = this._worldPose(record);
    const c = Math.abs(Math.cos(pose.ry));
    const s = Math.abs(Math.sin(pose.ry));
    const hx = (c * size.x + s * size.z) / 2;
    const hz = (s * size.x + c * size.z) / 2;
    out.min.set(pose.p.x - hx, pose.p.y, pose.p.z - hz);
    out.max.set(pose.p.x + hx, pose.p.y + size.y, pose.p.z + hz);
    return out;
  }

  // Current world pose { p: Vector3, q: Quaternion, ry } (reuses internal temporaries).
  _worldPose(record) {
    const out = this._wp;
    const wp = this.objects?.worldPose?.(record.id, this._wpOut);
    if (wp && wp.p) {
      setVec(out.p, wp.p);
      if (wp.q) setQuat(out.q, wp.q);
      else out.q.setFromAxisAngle(this._v2.set(0, 1, 0), Number(wp.ry) || 0);
      out.ry = Number.isFinite(wp.ry) ? wp.ry : yawOf(out.q, this._v2);
      return out;
    }
    setVec(out.p, record.p);
    out.ry = Number(record.ry) || 0;
    out.q.setFromAxisAngle(this._v2.set(0, 1, 0), out.ry);
    return out;
  }

  // ---------- holding ----------

  held(hand) {
    const st = this._hands[hand];
    if (!st) return null;
    const me = this.getUser();
    const objects = this.state.objects;
    const current = st.held && objects[st.held];
    if (current?.attach && current.attach.user === me && current.attach.hand === hand) return st.held;
    // Things put in the hand by voice ("spawn an axe in my hand") or by the network.
    st.held = null;
    for (const id of this.state.order) {
      const attach = objects[id]?.attach;
      if (attach && attach.user === me && attach.hand === hand) {
        st.held = id;
        break;
      }
    }
    return st.held;
  }

  // → id | null. point/quat: world hand pose; raycaster (optional) for distance grabs.
  grab(hand, { point, quat, raycaster = null } = {}) {
    const st = this._hands[hand];
    if (!st || !point) return null;
    if (this.held(hand)) return null;
    const me = this.getUser();
    const p = setVec(this._v1, point);
    const handQ = setQuat(this._q1, quat);
    const { objects, order } = this.state;

    let best = null;
    let bestD = Infinity;
    let bestVol = Infinity;
    for (const id of order) {
      const record = objects[id];
      if (!this._canGrab(record, me)) continue;
      if (!record.attach && this._roughSphere(record, this._v2).distanceTo(p) - this._radius > NEAR) continue;
      const box = this._bounds(record, this._box);
      const dist = box.distanceToPoint(p);
      if (dist > NEAR) continue;
      // Small holdables win near-ties against the furniture they sit on.
      const d = dist + (this._meta(record).holdable ? 0 : HOLDABLE_BIAS);
      const size = box.getSize(this._v2);
      const vol = size.x * size.y * size.z;
      if (d < bestD - 1e-4 || (Math.abs(d - bestD) <= 1e-4 && vol < bestVol)) {
        best = record;
        bestD = d;
        bestVol = vol;
      }
    }
    let distance = false;
    if (!best && raycaster?.ray) {
      best = this._rayCandidate(raycaster, me);
      distance = !!best;
    }
    if (!best) return null;

    const meta = this._meta(best);
    const attach = { user: me, hand, grip: meta.grip ? "snap" : "keep" };
    if (!meta.grip) attach.rel = distance ? this._palmRel(hand, best, meta, handQ) : this._keepRel(best, p, handQ);
    const patch = { attach };
    if (best.onto) patch.onto = null; // lifted off whatever it stood on
    this.send({ t: "set", id: best.id, patch, transient: false });
    st.held = best.id;
    st.tipValid = false;
    st.swing = -1;
    this.emit("grab", { hand, id: best.id, distance });
    return best.id;
  }

  // First grabbable along the ray within 12 m; an ungrabbable thing hit first blocks the ray.
  _rayCandidate(raycaster, me) {
    const { objects, order } = this.state;
    let blocker = Infinity;
    const hit = this.objects?.pick?.(raycaster, { holdableOnly: false });
    const hitId = typeof hit === "string" ? hit : hit?.id;
    const hitDist = typeof hit?.distance === "number" ? hit.distance : null;
    if (hitId) {
      const record = objects[hitId];
      if (this._canGrab(record, me) && (hitDist === null || hitDist <= RAY_MAX)) return record;
      if (hitDist !== null) blocker = hitDist;
    }
    const origin = raycaster.ray.origin;
    let best = null;
    let bestD = Infinity;
    for (const id of order) {
      const record = objects[id];
      if (!this._canGrab(record, me)) continue;
      if (!record.attach) {
        // Cheap bounding-sphere reject before asking SceneObjects for exact bounds.
        const center = this._roughSphere(record, this._v2);
        const r = this._radius;
        if (raycaster.ray.distanceSqToPoint(center) > r * r || center.distanceTo(origin) > RAY_MAX + r) continue;
      }
      const box = this._bounds(record, this._box);
      const point = raycaster.ray.intersectBox(box, this._v3);
      if (!point) continue;
      const d = point.distanceTo(origin);
      if (d <= RAY_MAX && d < blocker + 0.1 && d < bestD) {
        best = record;
        bestD = d;
      }
    }
    return best;
  }

  // "keep" grip: the object stays exactly where it is relative to the hand.
  _keepRel(record, handP, handQ) {
    const pose = this._worldPose(record);
    const inv = this._q2.copy(handQ).invert();
    const rp = this._v2.copy(pose.p).sub(handP).applyQuaternion(inv);
    const rq = inv.multiply(pose.q).normalize();
    return { p: [round(rp.x), round(rp.y), round(rp.z)], q: [round(rq.x), round(rq.y), round(rq.z), round(rq.w)] };
  }

  // Distance grab: the object's center lands in front of the palm (-X right hand, +X left hand),
  // keeping its current world orientation.
  _palmRel(hand, record, meta, handQ) {
    const pose = this._worldPose(record);
    const size = this._size(record, meta, this._v3);
    const gap = Math.max(PALM_GAP, 0.04 + Math.max(size.x, size.y, size.z) / 2);
    const rq = this._q2.copy(handQ).invert().multiply(pose.q).normalize();
    const center = this._v2.set(0, size.y / 2, 0).applyQuaternion(rq);
    const side = hand === "left" ? 1 : -1;
    const rp = [side * gap - center.x, -center.y, -center.z];
    return { p: rp.map((n) => round(n)), q: [round(rq.x), round(rq.y), round(rq.z), round(rq.w)] };
  }

  // → id | null. velocity: world m/s (Vector3 or [x, y, z]); measured from the hand when omitted.
  release(hand, { velocity } = {}) {
    const st = this._hands[hand];
    if (!st) return null;
    const id = this.held(hand);
    if (!id) return null;
    const record = this.state.objects[id];
    const meta = this._meta(record);
    const vel = velocity ? setVec(this._vel, velocity) : this.handVelocity(hand, this._vel);
    if (vel.length() > THROW_MAX) vel.setLength(THROW_MAX);
    const pose = this._heldPose(record, meta, hand);
    const p = [round(pose.p.x, 1e3), round(pose.p.y, 1e3), round(pose.p.z, 1e3)];
    const ry = round(pose.ry);
    st.held = null;
    st.tipValid = false;
    st.swing = -1;

    const speed = vel.length();
    if (speed > THROW_MIN) {
      const patch = { attach: null, p, ry };
      if (record.onto) patch.onto = null;
      const spin = round(clamp(speed * 1.2, 0, 12) * (vel.x - vel.z >= 0 ? 1 : -1), 100);
      this.send({ t: "set", id, patch, fly: { vel: [round(vel.x, 100), round(vel.y, 100), round(vel.z, 100)], spin } });
      this.emit("release", { hand, id, thrown: true });
      return id;
    }
    const surface = this._surfaceBelow(record, pose.p);
    if (surface) {
      this.send({ t: "set", id, patch: { attach: null, p: [p[0], round(surface.top, 1e3), p[2]], ry, onto: surface.id } });
    } else {
      const patch = { attach: null, p, ry };
      if (record.onto) patch.onto = null;
      this.send({ t: "set", id, patch, fly: { vel: [0, 0, 0], spin: 0 } });
    }
    this.emit("release", { hand, id, thrown: false });
    return id;
  }

  releaseAll() {
    const released = [];
    for (const hand of HANDS) {
      const id = this.release(hand, { velocity: ZERO });
      if (id) released.push(id);
    }
    return released;
  }

  // Forget hand motion (call after teleport/snap turn so it is not mistaken for a throw).
  resetMotion(hand) {
    for (const name of hand ? [hand] : HANDS) {
      const st = this._hands[name];
      if (!st) continue;
      st.histCount = 0;
      st.tipValid = false;
    }
  }

  // World pose of a held object: objects.worldPose when available, else hand pose + attach.
  _heldPose(record, meta, hand) {
    const st = this._hands[hand];
    if (this.objects?.worldPose?.(record.id, this._wpOut) || !st.hasPose) return this._worldPose(record);
    const out = this._wp;
    const attach = record.attach || {};
    if (attach.grip === "keep" && attach.rel) {
      setQuat(this._q2, attach.rel.q);
      out.q.copy(st.pose.q).multiply(this._q2);
      out.p.copy(setVec(this._v2, attach.rel.p).applyQuaternion(st.pose.q)).add(st.pose.p);
    } else {
      const grip = this._grip(meta);
      const gq = this._q2.setFromEuler(this._euler.set(grip.r[0] * DEG, grip.r[1] * DEG, grip.r[2] * DEG));
      out.q.copy(st.pose.q).multiply(gq);
      const s = record.s || 1;
      out.p.set(-grip.p[0] * s, -grip.p[1] * s, -grip.p[2] * s).applyQuaternion(out.q).add(st.pose.p);
    }
    out.ry = yawOf(out.q, this._v2);
    return out;
  }

  _grip(meta) {
    if (meta.grip?.p && meta.grip?.r) return meta.grip;
    const h = Array.isArray(meta.size) ? meta.size[1] : 0;
    return { p: [0, h / 2, 0], r: [0, 0, 0] };
  }

  // Highest surface whose top is below p (within reach) and whose usable top contains p in x/z.
  _surfaceBelow(record, p) {
    const { objects, order } = this.state;
    let best = null;
    for (const id of order) {
      if (id === record.id) continue;
      const other = objects[id];
      if (!other || other.attach) continue;
      const meta = this._meta(other);
      if (meta.surface === undefined || !Array.isArray(meta.surfaceSize)) continue;
      const s = other.s || 1;
      const top = other.p[1] + meta.surface * s;
      if (top > p.y + 0.02 || p.y - top > SURFACE_REACH) continue;
      const ry = Number(other.ry) || 0;
      const dx = p.x - other.p[0];
      const dz = p.z - other.p[2];
      const c = Math.cos(ry);
      const sn = Math.sin(ry);
      const lx = dx * c - dz * sn;
      const lz = dx * sn + dz * c;
      if (Math.abs(lx) > (meta.surfaceSize[0] * s) / 2 || Math.abs(lz) > (meta.surfaceSize[1] * s) / 2) continue;
      if (!best || top > best.top) best = { id, top };
    }
    return best;
  }

  // ---------- hand motion ----------

  _pushHistory(st, p) {
    const h = st.hist;
    if (st.histCount > 0) {
      const last = ((st.histHead - 1 + HISTORY) % HISTORY) * 4;
      const dx = p.x - h[last + 1];
      const dy = p.y - h[last + 2];
      const dz = p.z - h[last + 3];
      if (dx * dx + dy * dy + dz * dz > 1) st.histCount = 0; // teleport: not a throw
    }
    const i = st.histHead * 4;
    h[i] = this._time;
    h[i + 1] = p.x;
    h[i + 2] = p.y;
    h[i + 3] = p.z;
    st.histHead = (st.histHead + 1) % HISTORY;
    st.histCount = Math.min(HISTORY, st.histCount + 1);
  }

  // Average hand velocity over the last ~100 ms of samples.
  handVelocity(hand, out = new THREE.Vector3()) {
    out.set(0, 0, 0);
    const st = this._hands[hand];
    if (!st || st.histCount < 2) return out;
    const h = st.hist;
    const newest = ((st.histHead - 1 + HISTORY) % HISTORY) * 4;
    let oldest = newest;
    for (let n = 1; n < st.histCount; n++) {
      const i = ((st.histHead - 1 - n + 2 * HISTORY) % HISTORY) * 4;
      oldest = i;
      if (h[newest] - h[i] >= VEL_WINDOW) break;
    }
    const dt = h[newest] - h[oldest];
    if (dt < 1e-3) return out;
    return out.set((h[newest + 1] - h[oldest + 1]) / dt, (h[newest + 2] - h[oldest + 2]) / dt, (h[newest + 3] - h[oldest + 3]) / dt);
  }

  // ---------- desktop swing ----------

  // Starts a quick chop with whatever this hand holds. → boolean
  swing(hand) {
    const st = this._hands[hand];
    if (!st || !this.held(hand)) return false;
    st.swing = 0;
    this.emit("swing", { hand });
    return true;
  }

  get swinging() {
    return this._hands.left.swing >= 0 || this._hands.right.swing >= 0;
  }

  // Grip-space rotation to multiply into the hand quaternion while a swing runs. → Quaternion | null
  swingOffset(hand) {
    const st = this._hands[hand];
    if (!st || st.swing < 0) return null;
    return st.swingQ.setFromAxisAngle(X_AXIS, swingAngle(clamp(st.swing / SWING_TIME, 0, 1)));
  }

  // Applies the swing to a { p, q } pose in place (no-op without a swing). → pose
  applySwing(hand, pose) {
    const offset = this.swingOffset(hand);
    if (offset && pose?.q?.isQuaternion) pose.q.multiply(offset);
    return pose;
  }

  // ---------- per frame ----------

  // poses: { left: { p, q } | null, right: { p, q } | null } raw world hand poses.
  update(dt = 0, poses = {}) {
    if (!(dt >= 0)) dt = 0;
    this._time += dt;
    this._hitRefresh -= dt;
    for (const hand of HANDS) {
      const st = this._hands[hand];
      if (st.swing >= 0) {
        st.swing += dt;
        if (st.swing >= SWING_TIME) st.swing = -1;
      }
      const pose = poses?.[hand];
      if (!pose || !pose.p) {
        st.hasPose = false;
        st.tipValid = false;
        continue;
      }
      setVec(st.pose.p, pose.p);
      setQuat(st.pose.q, pose.q);
      st.hasPose = true;
      this._pushHistory(st, st.pose.p);

      const id = this.held(hand);
      const record = id ? this.state.objects[id] : null;
      const meta = record ? this._meta(record) : null;
      if (!meta?.tip || meta.marker) {
        st.tipValid = false;
        continue;
      }
      this.applySwing(hand, st.pose);
      this._tipWorld(record, meta, st.pose, st.tip);
      if (st.tipValid && st.tipFor === id && dt > 0) {
        const dist = st.tip.distanceTo(st.prevTip);
        if (dist < 2.5) {
          st.tipVel.subVectors(st.tip, st.prevTip).divideScalar(dt);
          const speed = dist / dt;
          if (speed > HIT_MIN) this._hitTest(hand, id, st, speed);
        }
      }
      st.prevTip.copy(st.tip);
      st.tipValid = true;
      st.tipFor = id;
    }
  }

  // Tip of a held weapon in world space for the given (already swung) hand pose.
  _tipWorld(record, meta, pose, out) {
    const s = record.s || 1;
    const v = this._v1.set(meta.tip[0] * s, meta.tip[1] * s, meta.tip[2] * s);
    const attach = record.attach;
    if (attach?.grip === "keep" && attach.rel) {
      v.applyQuaternion(setQuat(this._q2, attach.rel.q)).add(setVec(this._v2, attach.rel.p));
    } else {
      const grip = this._grip(meta);
      v.x -= grip.p[0] * s;
      v.y -= grip.p[1] * s;
      v.z -= grip.p[2] * s;
      v.applyQuaternion(this._q2.setFromEuler(this._euler.set(grip.r[0] * DEG, grip.r[1] * DEG, grip.r[2] * DEG)));
    }
    return out.copy(v).applyQuaternion(pose.q).add(pose.p);
  }

  _refreshHittables() {
    this._hittables.length = 0;
    const { objects, order } = this.state;
    for (const id of order) {
      const record = objects[id];
      if (record && this._meta(record).hittable) this._hittables.push(id);
    }
    this._hitRefresh = 0.3;
  }

  _hitTest(hand, heldId, st, speed) {
    if (this._hitRefresh <= 0) this._refreshHittables();
    const objects = this.state.objects;
    for (let i = 0; i < this._hittables.length; i++) {
      const id = this._hittables[i];
      const record = objects[id];
      if (!record || id === heldId || record.attach) continue;
      const box = this._bounds(record, this._box2).expandByScalar(HIT_PAD);
      if (box.containsPoint(st.prevTip)) continue; // only entering counts
      if (!segmentHitsBox(st.prevTip, st.tip, box)) continue;
      const last = st.cool.get(id);
      if (last !== undefined && this._time - last < HIT_COOLDOWN) continue;
      st.cool.set(id, this._time);
      const power = clamp(speed / 6, 0.2, 1);
      const dir = st.tipVel.clone().normalize();
      try {
        this.objects?.hit?.(id, power, dir);
      } catch (err) {
        console.warn("[interact] hit failed", err);
      }
      this.fx({ kind: "hit", id, power });
      this.emit("haptic", { hand, intensity: power });
      this.emit("hit", { hand, id, power, speed });
    }
  }
}
