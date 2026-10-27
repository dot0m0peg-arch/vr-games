// Floppy things: a rubber chicken dangles and swings from the hand, an eel or a fish flops when it is
// carried or thrown. A chain of points runs along the object's longest axis and lags behind its
// rigid pose (Verlet + a soft pull back to the rest shape); the meshes are bent along the chain.
// Only objects that are held, flying or settling are simulated; the rest keep their built meshes.
import * as THREE from "../../vendor/three.module.min.js";

const NODES = 7;
const STEP = 1 / 90;
const MAX_STEPS = 4;
const DAMPING = 0.985;
const GRAVITY = new THREE.Vector3(0, -9.81, 0);
const SETTLE = 1.2; // seconds of simulation after the object comes to rest
const MAX_VERTICES = 60000;

// Names that make anything floppy (mashups included: a "rubber shark" flops like the chicken).
const VERY = /\b(rubber|plush|plushie|stuffed|squishy|floppy|squeaky|jelly|jello|noodle|spaghetti|rope|scarf|towel|blanket|sock|snake|eel|worm|tentacle|octopus|squid|jellyfish|sausage|hot dog|slinky|ribbon|streamer|cape|flag|whip|chain|necklace|garland|boa|tongue|hose|cable|leash|wet)\b/;
const SOME = /\b(fish|shark|dolphin|whale|seal|otter|salmon|trout|tuna|carp|cod|bass|catfish|eelpout|lizard|gecko|salamander|newt|ferret|weasel|cat|kitten|dog|puppy|rabbit|bunny|lobster|shrimp|crayfish|caterpillar|slug|banana|bacon|tortilla|pancake|pizza slice|leaf|feather|bird|chicken|duck|goose)\b/;

// → { stiffness } or null. stiffness: per-step pull back to the rest shape (lower = floppier).
export function floppyOf(meta, record) {
  if (!meta) return null;
  if (meta.floppy) return { stiffness: Number(meta.floppy.stiffness) || 0.05 };
  if (meta.fixed || meta.heavy || meta.gun || meta.container) return null;
  const size = Array.isArray(meta.size) ? meta.size : [1, 1, 1];
  const s = record?.s || 1;
  const longest = Math.max(...size) * s;
  if (longest > 2.5 || longest < 0.08) return null;
  const words = `${meta.name || ""} ${record?.label || ""}`.toLowerCase();
  if (VERY.test(words)) return { stiffness: 0.012 };
  if (SOME.test(words) || meta.behavior === "swim") return { stiffness: 0.04 };
  return null;
}

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _n3 = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Floppy {
  // objects: SceneObjects. getHand(user, hand) → { p, q } world hand pose.
  constructor({ objects, getHand = () => null } = {}) {
    this.objects = objects;
    this.getHand = getHand;
    this.sims = new WeakMap();
    this.active = new Set();
  }

  // Shoves the chain (a bullet, a punch). point/dir in world space.
  poke(id, point, dir, strength = 1) {
    const entry = this.objects.entries.get(id);
    const sim = entry && this._sim(entry);
    if (!sim || sim.failed) return;
    this._ensureNodes(entry, sim);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < NODES; i++) {
      const d = sim.x[i].distanceTo(point);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    for (let i = 0; i < NODES; i++) {
      const k = Math.max(0, 1 - Math.abs(i - best) / 3) * strength * 0.012;
      sim.prev[i].addScaledVector(dir, -k);
    }
    sim.settle = SETTLE;
  }

  update(dt) {
    if (!(dt > 0)) return;
    for (const entry of this.objects.entries.values()) {
      const moving = entry.attach || entry.fly || entry.tween;
      let sim = this.sims.get(entry);
      if (!sim) {
        if (!moving) continue;
        sim = this._sim(entry);
        if (!sim) continue;
      }
      if (sim.failed) continue;
      if (moving) sim.settle = SETTLE;
      else sim.settle -= dt;
      if (sim.settle <= 0 && sim.asleep) continue;
      this._step(entry, sim, dt);
    }
  }

  _sim(entry) {
    let sim = this.sims.get(entry);
    if (sim) return sim;
    const how = floppyOf(entry.meta, entry.record);
    if (!how) {
      this.sims.set(entry, { failed: true });
      return null;
    }
    sim = { failed: false, stiffness: how.stiffness, prepared: false, asleep: true, settle: 0, x: null, prev: null, anchor: -1, attachKey: "" };
    this.sims.set(entry, sim);
    return sim;
  }

  // Bakes per-vertex chain coordinates (lazily, the first time the object moves).
  _prepare(entry, sim) {
    sim.prepared = true;
    const inner = entry.inner;
    inner.updateWorldMatrix(true, true);
    _inv.copy(inner.matrixWorld).invert();
    const meshes = [];
    const box = new THREE.Box3();
    let total = 0;
    inner.traverse((object) => {
      if (!object.isMesh || object.isInstancedMesh || object.isSkinnedMesh || !object.geometry?.attributes?.position) return;
      total += object.geometry.attributes.position.count;
      meshes.push(object);
    });
    if (!meshes.length || total > MAX_VERTICES) {
      sim.failed = true;
      return;
    }
    for (const mesh of meshes) {
      if (mesh.geometry.userData.shared) {
        // Cached primitives are shared between objects: bend a private copy.
        mesh.geometry = mesh.geometry.clone();
        mesh.geometry.userData = {};
      }
      const toInner = new THREE.Matrix4().multiplyMatrices(_inv, mesh.matrixWorld);
      const pos = mesh.geometry.attributes.position;
      const normal = mesh.geometry.attributes.normal;
      const rest = new Float32Array(pos.count * 3);
      const restN = normal ? new Float32Array(pos.count * 3) : null;
      _n3.getNormalMatrix(toInner);
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(toInner);
        rest[i * 3] = _v.x;
        rest[i * 3 + 1] = _v.y;
        rest[i * 3 + 2] = _v.z;
        box.expandByPoint(_v);
        if (restN) {
          _v.fromBufferAttribute(normal, i).applyMatrix3(_n3).normalize();
          restN[i * 3] = _v.x;
          restN[i * 3 + 1] = _v.y;
          restN[i * 3 + 2] = _v.z;
        }
      }
      mesh.frustumCulled = false;
      sim.meshes = sim.meshes || [];
      sim.meshes.push({ mesh, rest, restN, fromInner: toInner.clone().invert(), normalFromInner: new THREE.Matrix3().getNormalMatrix(toInner.clone().invert()) });
    }
    const size = box.getSize(new THREE.Vector3());
    const axis = size.x >= size.y && size.x >= size.z ? 0 : size.z >= size.y ? 2 : 1;
    const lo = box.min.getComponent(axis);
    const len = Math.max(1e-4, size.getComponent(axis));
    const center = box.getCenter(new THREE.Vector3());
    sim.axis = axis;
    sim.axisDir = new THREE.Vector3().setComponent(axis, 1);
    sim.rest = [];
    for (let i = 0; i < NODES; i++) sim.rest.push(center.clone().setComponent(axis, lo + (len * i) / (NODES - 1)));
    for (const m of sim.meshes) {
      const count = m.rest.length / 3;
      m.t = new Float32Array(count);
      for (let i = 0; i < count; i++) m.t[i] = Math.min(NODES - 1.0001, Math.max(0, ((m.rest[i * 3 + axis] - lo) / len) * (NODES - 1)));
    }
    sim.x = sim.rest.map(() => new THREE.Vector3());
    sim.prev = sim.rest.map(() => new THREE.Vector3());
    sim.target = sim.rest.map(() => new THREE.Vector3());
    sim.local = sim.rest.map(() => new THREE.Vector3());
    sim.quats = sim.rest.map(() => new THREE.Quaternion());
    sim.started = false;
  }

  _ensureNodes(entry, sim) {
    if (!sim.prepared) this._prepare(entry, sim);
    if (sim.failed) return;
    entry.inner.updateWorldMatrix(true, false);
    for (let i = 0; i < NODES; i++) sim.target[i].copy(sim.rest[i]).applyMatrix4(entry.inner.matrixWorld);
    if (!sim.started) {
      for (let i = 0; i < NODES; i++) {
        sim.x[i].copy(sim.target[i]);
        sim.prev[i].copy(sim.target[i]);
      }
      sim.started = true;
    }
  }

  _step(entry, sim, dt) {
    this._ensureNodes(entry, sim);
    if (sim.failed) return;
    const { x, prev, target } = sim;
    // Teleports, rebuilds and snaps: start over from the rigid pose.
    let far = 0;
    for (let i = 0; i < NODES; i++) far = Math.max(far, x[i].distanceTo(target[i]));
    if (far > 1.5) {
      for (let i = 0; i < NODES; i++) {
        x[i].copy(target[i]);
        prev[i].copy(target[i]);
      }
    }
    // The node nearest the hand follows it exactly; the rest hang off it.
    const attach = entry.attach;
    const key = attach ? `${attach.user}:${attach.hand}:${attach.grip}` : "";
    if (key !== sim.attachKey) {
      sim.attachKey = key;
      sim.anchor = -1;
      if (attach) {
        const grip = entry.meta.grip?.p;
        const hand = attach.grip === "snap" && grip ? _c.fromArray(grip).applyMatrix4(entry.inner.matrixWorld) : this.getHand(attach.user, attach.hand)?.p;
        if (hand) {
          let best = Infinity;
          for (let i = 0; i < NODES; i++) {
            const d = target[i].distanceTo(hand);
            if (d < best) {
              best = d;
              sim.anchor = i;
            }
          }
        }
      }
    }
    const steps = Math.min(MAX_STEPS, Math.max(1, Math.round(dt / STEP)));
    const h = dt / steps;
    const moving = !!(attach || entry.fly || entry.tween);
    // Once it lies still, gravity fades and the shape firms up so it comes to rest exactly as built.
    const settling = moving ? 1 : Math.max(0, sim.settle / SETTLE);
    const pull = Math.max(1 - Math.pow(1 - sim.stiffness, (h / STEP) * (moving ? 1 : 3)), settling > 0 ? 0 : 0.25);
    const fall = h * h * settling;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < NODES; i++) {
        if (i === sim.anchor) {
          x[i].copy(target[i]);
          prev[i].copy(target[i]);
          continue;
        }
        _v.subVectors(x[i], prev[i]).multiplyScalar(DAMPING);
        prev[i].copy(x[i]);
        x[i].add(_v).addScaledVector(GRAVITY, fall);
        x[i].lerp(target[i], pull);
      }
      // Keep the segment lengths (the anchor does not move).
      for (let iter = 0; iter < 2; iter++) {
        for (let i = 0; i < NODES - 1; i++) {
          const a = x[i];
          const b = x[i + 1];
          const rest = target[i].distanceTo(target[i + 1]);
          _v.subVectors(b, a);
          const d = _v.length();
          if (d < 1e-6) continue;
          const wa = i === sim.anchor ? 0 : 1;
          const wb = i + 1 === sim.anchor ? 0 : 1;
          if (!wa && !wb) continue;
          const corr = (d - rest) / d / (wa + wb);
          a.addScaledVector(_v, corr * wa);
          b.addScaledVector(_v, -corr * wb);
        }
      }
      for (let i = 0; i < NODES; i++) if (x[i].y < 0.005) x[i].y = 0.005;
    }
    let offset = 0;
    for (let i = 0; i < NODES; i++) offset = Math.max(offset, x[i].distanceTo(target[i]));
    if (sim.settle <= 0 && offset < 0.002) {
      this._restore(sim);
      sim.started = false;
      return;
    }
    this._deform(entry, sim);
  }

  _deform(entry, sim) {
    _inv.copy(entry.inner.matrixWorld).invert();
    const { local, quats, rest, axisDir } = sim;
    for (let i = 0; i < NODES; i++) local[i].copy(sim.x[i]).applyMatrix4(_inv);
    for (let i = 0; i < NODES; i++) {
      const a = local[Math.max(0, i - 1)];
      const b = local[Math.min(NODES - 1, i + 1)];
      _v.subVectors(b, a);
      if (_v.lengthSq() < 1e-10) quats[i].identity();
      else quats[i].setFromUnitVectors(axisDir, _v.normalize());
    }
    for (const m of sim.meshes) {
      const pos = m.mesh.geometry.attributes.position;
      const nor = m.mesh.geometry.attributes.normal;
      const arr = pos.array;
      const narr = nor && m.restN ? nor.array : null;
      const e = m.fromInner.elements;
      const ne = m.normalFromInner.elements;
      const count = m.t.length;
      for (let i = 0; i < count; i++) {
        const t = m.t[i];
        const k = t | 0;
        const f = t - k;
        // Rest and bent chain points at this vertex, and the blended bend rotation.
        const r0 = rest[k];
        const r1 = rest[k + 1];
        const c0x = r0.x + (r1.x - r0.x) * f;
        const c0y = r0.y + (r1.y - r0.y) * f;
        const c0z = r0.z + (r1.z - r0.z) * f;
        const l0 = local[k];
        const l1 = local[k + 1];
        _q.copy(quats[k]).slerp(quats[k + 1], f);
        const j = i * 3;
        _v.set(m.rest[j] - c0x, m.rest[j + 1] - c0y, m.rest[j + 2] - c0z).applyQuaternion(_q);
        const px = _v.x + l0.x + (l1.x - l0.x) * f;
        const py = _v.y + l0.y + (l1.y - l0.y) * f;
        const pz = _v.z + l0.z + (l1.z - l0.z) * f;
        arr[j] = e[0] * px + e[4] * py + e[8] * pz + e[12];
        arr[j + 1] = e[1] * px + e[5] * py + e[9] * pz + e[13];
        arr[j + 2] = e[2] * px + e[6] * py + e[10] * pz + e[14];
        if (narr) {
          _v2.set(m.restN[j], m.restN[j + 1], m.restN[j + 2]).applyQuaternion(_q);
          const nx = ne[0] * _v2.x + ne[3] * _v2.y + ne[6] * _v2.z;
          const ny = ne[1] * _v2.x + ne[4] * _v2.y + ne[7] * _v2.z;
          const nz = ne[2] * _v2.x + ne[5] * _v2.y + ne[8] * _v2.z;
          const len = Math.hypot(nx, ny, nz) || 1;
          narr[j] = nx / len;
          narr[j + 1] = ny / len;
          narr[j + 2] = nz / len;
        }
      }
      pos.needsUpdate = true;
      if (narr) nor.needsUpdate = true;
    }
    sim.asleep = false;
  }

  // Puts the built shape back exactly.
  _restore(sim) {
    if (sim.asleep) return;
    for (const m of sim.meshes) {
      const pos = m.mesh.geometry.attributes.position;
      const nor = m.mesh.geometry.attributes.normal;
      const e = m.fromInner;
      for (let i = 0; i < m.t.length; i++) {
        _v.set(m.rest[i * 3], m.rest[i * 3 + 1], m.rest[i * 3 + 2]).applyMatrix4(e);
        pos.setXYZ(i, _v.x, _v.y, _v.z);
        if (nor && m.restN) {
          _v.set(m.restN[i * 3], m.restN[i * 3 + 1], m.restN[i * 3 + 2]).applyMatrix3(m.normalFromInner).normalize();
          nor.setXYZ(i, _v.x, _v.y, _v.z);
        }
      }
      pos.needsUpdate = true;
      if (nor) nor.needsUpdate = true;
    }
    sim.asleep = true;
  }
}
