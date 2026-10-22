// Room records -> 3D objects: build, phase in/out, hand attachment, throws, wobble on hits,
// behaviors ("make it fly"), blob shadows, hover highlight and picking.
import * as THREE from "../../vendor/three.module.min.js";
import { Emitter } from "../util/emitter.js";
import { kit } from "../parts/build/kit.js";
import { textTexture, updateTextTexture } from "../util/text.js";
import { localBox } from "./phase.js";
import { setClearing, removeClearing } from "./field.js";

const DEG = Math.PI / 180;
const TWEEN = 0.25;
const CLEAR_OUT = 0.4;
const GRAVITY = 9.81;
const UP = new THREE.Vector3(0, 1, 0);
const ACCENT = new THREE.Color("#d5fb6a");
const BEHAVIORS = new Set(["swim", "fly", "walk", "hop", "roll", "spin", "float", "bounce", "sway"]);
const noRaycast = () => {};
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

function hashString(text = "") {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

function yawOf(q) {
  const v = _yawV.set(0, 0, 1).applyQuaternion(q);
  return Math.atan2(v.x, v.z);
}
const _yawV = new THREE.Vector3();

// Geometry that decides whether a record must be rebuilt when its data changes.
function shapeKey(record) {
  const d = record.data;
  if (!d) return "";
  if (d.blueprint) return JSON.stringify(d.blueprint);
  if (d.strokes) return JSON.stringify(d.strokes);
  return "";
}

// ---------- blob shadows (one instanced draw call for all objects) ----------

let shadowTexture = null;
function blobTexture() {
  if (shadowTexture || typeof document === "undefined") return shadowTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.75)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  shadowTexture = new THREE.CanvasTexture(canvas);
  return shadowTexture;
}

function shadowMaterial() {
  // Black blob; per-instance opacity rides in the (otherwise unused) Y scale of the instance matrix.
  const material = new THREE.MeshBasicMaterial({
    color: "#000000", alphaMap: blobTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vBlob;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n#ifdef USE_INSTANCING\n  vBlob = length(instanceMatrix[1].xyz);\n#else\n  vBlob = 1.0;\n#endif");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vBlob;")
      .replace("#include <alphamap_fragment>", "#include <alphamap_fragment>\ndiffuseColor.a *= vBlob;");
  };
  material.customProgramCacheKey = () => "blob-shadow";
  return material;
}

// ---------- SceneObjects ----------

export class SceneObjects extends Emitter {
  constructor({ scene, room, build, phaser, getHand, share = null }) {
    super();
    this.scene = scene;
    this.room = room;
    this.build = build;
    this.phaser = phaser;
    this.getHand = getHand || (() => null);
    this.share = share;
    this.entries = new Map();
    this.dying = new Set();
    this.frame = 0;
    this.highlightId = null;
    this.screenTimer = 0;
    this._hits = [];
    this._surfaces = [];
    this._t = {
      v: new THREE.Vector3(), v2: new THREE.Vector3(), v3: new THREE.Vector3(), q: new THREE.Quaternion(), q2: new THREE.Quaternion(),
      e: new THREE.Euler(), m: new THREE.Matrix4(), s: new THREE.Vector3(), box: new THREE.Box3(), color: new THREE.Color(),
    };

    this.shadowGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.shadowMaterial = shadowMaterial();
    this.shadows = null;
    this._ensureShadows(64);

    this._offs = [];
    if (room?.on) {
      this._offs.push(
        room.on("add", (record, op) => this._onAdd(record, op)),
        room.on("update", (record, patch, op) => this._onUpdate(record, patch || {}, op || {})),
        room.on("remove", (record) => this._onRemove(record)),
        room.on("clear", () => this._onClear()),
        room.on("load", (state) => this._onLoad(state)),
      );
      if (room.state) this._onLoad(room.state);
    }
  }

  // ---------- public API ----------

  get(id) {
    return this.entries.get(id)?.wrapper;
  }

  ids() {
    return [...this.entries.keys()];
  }

  update(dt, t = 0) {
    this.frame++;
    const now = Date.now() / 1000;
    // Surfaces (tables, crates...) things can land or rest on, gathered once per frame.
    const surfaces = this._surfaces;
    surfaces.length = 0;
    for (const entry of this.entries.values()) if (entry.meta.surface !== undefined && !entry.attach) surfaces.push(entry);
    for (const entry of this.entries.values()) this._updateEntry(entry, dt, t, now);
    for (const entry of this.dying) this._updateEntry(entry, dt, t, now);
    this.screenTimer += dt;
    if (this.screenTimer > 0.5) {
      this.screenTimer = 0;
      for (const entry of this.entries.values()) if (entry.screenStream) this._refreshScreen(entry);
    }
    this._updateShadows(dt);
  }

  // Nearest object hit by the ray. Helpers (shells, shadows, labels) are never hit.
  pick(raycaster, { holdableOnly = false } = {}) {
    let best = null;
    const hits = this._hits;
    for (const entry of this.entries.values()) {
      if (holdableOnly && !entry.meta.holdable) continue;
      const box = this._bounds(entry);
      const enter = raycaster.ray.intersectBox(box, this._t.v);
      if (!enter) continue;
      const boxDistance = box.containsPoint(raycaster.ray.origin) ? 0 : raycaster.ray.origin.distanceTo(enter);
      if (boxDistance > raycaster.far || (best && boxDistance > best.distance)) continue;
      hits.length = 0;
      raycaster.intersectObject(entry.inner, true, hits);
      const hit = hits[0];
      if (hit && (!best || hit.distance < best.distance)) best = { id: entry.id, point: hit.point, distance: hit.distance };
    }
    hits.length = 0;
    return best;
  }

  // Object whose world bounding box is closest to `point` (0 when inside), within maxDist.
  nearest(point, maxDist = Infinity, { holdableOnly = false } = {}) {
    let best = null;
    for (const entry of this.entries.values()) {
      if (holdableOnly && !entry.meta.holdable) continue;
      const distance = this._bounds(entry).distanceToPoint(point);
      if (distance <= maxDist && (!best || distance < best.distance)) best = { id: entry.id, distance };
    }
    return best;
  }

  hit(id, power = 1, dir = null) {
    const entry = this.entries.get(id);
    if (!entry) return 0;
    const t = this._t;
    const axis = t.v;
    if (dir && (dir.x || dir.z)) axis.set(dir.z, 0, -dir.x).normalize();
    else {
      const a = Math.random() * Math.PI * 2;
      axis.set(Math.cos(a), 0, Math.sin(a));
    }
    // Wobble axis lives in the wrapper's local frame (the inner object rotates around its base).
    axis.applyQuaternion(t.q.copy(entry.wrapper.quaternion).invert());
    const w = entry.wobble;
    if (Math.abs(w.angle) < 0.05) w.axis.copy(axis);
    w.vel += clamp(power, 0, 3) * 2.2 * Math.sign(w.axis.dot(axis) || 1);
    entry.innerDirty = true;
    if (entry.meta.hittable) {
      entry.hits++;
      this._updateLabel(entry);
    }
    const box = this._bounds(entry);
    const center = box.getCenter(t.v2);
    center.y = box.min.y + (box.max.y - box.min.y) * 0.65;
    this.phaser?.burst?.(center, 0.25 + 0.2 * clamp(power, 0, 2));
    this.emit("hit", { id, hits: entry.hits, power });
    return entry.hits;
  }

  bounds(id, out = new THREE.Box3()) {
    const entry = this.entries.get(id);
    if (!entry) return out.makeEmpty();
    return out.copy(this._bounds(entry));
  }

  worldPose(id, out = { p: new THREE.Vector3(), q: new THREE.Quaternion() }) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    entry.wrapper.updateWorldMatrix(true, false);
    entry.wrapper.matrixWorld.decompose(out.p, out.q, this._t.s);
    return out;
  }

  setHighlight(id) {
    id = id || null;
    if (id === this.highlightId) return;
    const old = this.entries.get(this.highlightId);
    if (old) this._unhighlight(old);
    this.highlightId = id;
    const entry = this.entries.get(id);
    if (entry && !entry.phasing) this._highlight(entry);
  }

  dispose() {
    for (const off of this._offs) off();
    for (const entry of [...this.entries.values(), ...this.dying]) this._destroy(entry);
    this.entries.clear();
    this.dying.clear();
    this.shadows?.removeFromParent();
    this.shadows?.dispose();
    this.shadowGeometry.dispose();
    this.shadowMaterial.dispose();
  }

  // ---------- room events ----------

  _onAdd(record, op, { phase = true } = {}) {
    if (!record?.id) return;
    const existing = this.entries.get(record.id);
    if (existing) {
      // Re-adding a known id (undo, resync): treat every field as changed.
      const patch = { ...record };
      for (const key of ["color", "text", "data", "attach", "onto"]) if (!(key in patch)) patch[key] = null;
      this._onUpdate(record, patch, op || {});
      return;
    }
    const entry = this._create(record);
    if (!entry) return;
    if (phase && this.phaser?.phaseIn) {
      entry.phasing = true;
      entry.appear = 0;
      this.phaser.phaseIn(entry.wrapper).then(() => this._afterPhase(entry));
    } else {
      entry.appear = 1;
    }
  }

  _onUpdate(record, patch, op) {
    const entry = this.entries.get(record?.id);
    if (!entry) return;
    entry.record = record;
    if (patch.part !== undefined && patch.part !== entry.part) {
      this._rebuild(entry);
      return;
    }
    if ("data" in patch && !entry.hooks.setDeck && !entry.meta.screen && shapeKey(record) !== entry.shapeKey) {
      this._rebuild(entry);
      return;
    }

    if ("attach" in patch) {
      if (record.attach) this._attach(entry, record.attach);
      else entry.attach = null;
    }

    const moved = patch.p !== undefined || patch.ry !== undefined || patch.s !== undefined;
    if (op.fly) {
      entry.tween = null;
      if (patch.p) entry.wrapper.position.fromArray(record.p);
      if (patch.s !== undefined) entry.wrapper.scale.setScalar(record.s || 1);
      this._startFlight(entry, op.fly);
    } else if (!entry.attach && (moved || ("attach" in patch && !record.attach))) {
      entry.fly = null;
      if (op.transient) {
        entry.tween = null;
        this._applyRecordPose(entry);
      } else {
        this._tweenToRecord(entry, TWEEN);
      }
    }
    entry.bFrame = -1;
    if (patch.s !== undefined) this._measure(entry);

    if ("color" in patch) this._withMaterials(entry, () => this._applyColor(entry));
    if ("text" in patch && entry.hooks.setText) entry.hooks.setText(record.text ?? "");
    if ("data" in patch) {
      const data = record.data || {};
      if (entry.hooks.setDeck) {
        this._withMaterials(entry, () => {
          entry.hooks.setDeck(data);
          this._measure(entry);
        });
      }
      if (entry.meta.screen) {
        entry.screenStream = data.stream || null;
        entry.screenTexture = undefined;
        this._refreshScreen(entry);
      }
      this._setBehavior(entry, data.behavior);
    }
  }

  _onRemove(record) {
    const entry = this.entries.get(record?.id);
    if (!entry) return;
    this._retire(entry, 0.7);
  }

  _onClear() {
    for (const entry of [...this.entries.values()]) this._retire(entry, CLEAR_OUT);
  }

  _onLoad(state) {
    for (const entry of [...this.entries.values(), ...this.dying]) this._destroy(entry);
    this.entries.clear();
    this.dying.clear();
    for (const id of state?.order || []) {
      const record = state.objects?.[id];
      if (record) this._onAdd(record, null, { phase: false });
    }
  }

  // ---------- entries ----------

  _create(record) {
    let wrapper;
    try {
      wrapper = this.build.buildObject(record);
    } catch (err) {
      console.error(`[objects] could not build ${record.part}`, err);
      return null;
    }
    const { meta = {}, inner, hooks = {} } = wrapper.userData;
    const entry = {
      id: record.id, part: record.part, record, wrapper, inner: inner || wrapper, meta, hooks,
      restBox: new THREE.Box3(), worldBox: new THREE.Box3(), bFrame: -1, footprint: 1, height: 1,
      innerRest: { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3(1, 1, 1) },
      tints: new Map(), hl: null, hlCache: new Map(), phasing: false, deferred: [], appear: 1,
      tween: null, fly: null, attach: null, gripP: new THREE.Vector3(), gripQ: new THREE.Quaternion(), relP: new THREE.Vector3(), relQ: new THREE.Quaternion(),
      wobble: { axis: new THREE.Vector3(1, 0, 0), angle: 0, vel: 0 }, innerDirty: false,
      behavior: null, lastBehavior: null, behaveBlend: 0, seed: hashString(record.id), hits: 0, label: null, labelTexture: null,
      shapeKey: shapeKey(record), screenStream: null, screenTexture: undefined, removing: false, fade: 1, fadeSpeed: 0,
    };
    const innerObject = entry.inner;
    entry.innerRest.p.copy(innerObject.position);
    entry.innerRest.q.copy(innerObject.quaternion);
    entry.innerRest.s.copy(innerObject.scale);
    wrapper.traverse((child) => {
      if (child.isMesh && child.userData.tint) entry.tints.set(child, child.material);
    });
    this._applyRecordPose(entry);
    if (record.attach) {
      this._attach(entry, record.attach);
      this._applyAttach(entry);
    }
    this.scene.add(wrapper);
    this._measure(entry);
    if (record.color) this._applyColor(entry);
    if (meta.screen && record.data?.stream) {
      entry.screenStream = record.data.stream;
      this._refreshScreen(entry);
    }
    this._setBehavior(entry, record.data?.behavior);
    if (meta.hittable) this._updateLabel(entry);
    this.entries.set(record.id, entry);
    return entry;
  }

  // Bounds of the inner object in its own (rest) frame.
  _measure(entry) {
    const inner = entry.inner;
    localBox(inner, entry.restBox);
    if (entry.restBox.isEmpty()) entry.restBox.set(new THREE.Vector3(-0.2, 0, -0.2), new THREE.Vector3(0.2, 0.4, 0.2));
    const size = entry.restBox.getSize(this._t.v);
    const s = entry.record.s || 1;
    entry.footprint = Math.max(size.x, size.z) * s;
    entry.height = size.y * s;
    entry.bFrame = -1;
  }

  _rebuild(entry) {
    const { wrapper } = entry;
    const keep = { p: wrapper.position.clone(), q: wrapper.quaternion.clone(), s: wrapper.scale.clone() };
    const hits = entry.hits;
    const wasHighlighted = this.highlightId === entry.id;
    this._destroy(entry);
    this.entries.delete(entry.id);
    const fresh = this._create(entry.record);
    if (!fresh) return;
    fresh.hits = hits;
    if (fresh.label) this._updateLabel(fresh);
    if (!fresh.attach) {
      fresh.wrapper.position.copy(keep.p);
      fresh.wrapper.quaternion.copy(keep.q);
      fresh.wrapper.scale.copy(keep.s);
      this._tweenToRecord(fresh, TWEEN);
    }
    if (wasHighlighted) this._highlight(fresh);
  }

  // Starts the phase-out; the object leaves the lookup immediately but keeps animating until gone.
  _retire(entry, duration) {
    if (this.highlightId === entry.id) this.setHighlight(null);
    this.entries.delete(entry.id);
    entry.removing = true;
    entry.attach = null;
    entry.fadeSpeed = 1 / Math.max(0.05, duration);
    this.dying.add(entry);
    entry.hooks.setScreen?.(null);
    const done = () => {
      this.dying.delete(entry);
      this._destroy(entry);
    };
    if (this.phaser?.phaseOut) this.phaser.phaseOut(entry.wrapper, { duration }).then(done, done);
    else done();
  }

  _destroy(entry) {
    if (entry.destroyed) return;
    entry.destroyed = true;
    if (entry.hl) this._unhighlight(entry);
    this.phaser?.cancel?.(entry.wrapper);
    this._unclear(entry);
    entry.hooks.setScreen?.(null);
    entry.wrapper.removeFromParent();
    // Recolored meshes no longer reference their built material: dispose it with the rest.
    for (const [mesh, original] of entry.tints) {
      if (mesh.material === original) continue;
      for (const m of Array.isArray(original) ? original : [original]) if (!m.userData?.shared) m.dispose();
    }
    kit.disposeObject(entry.wrapper);
    for (const material of entry.hlCache.values()) material.dispose();
    entry.hlCache.clear();
    if (entry.label) {
      entry.label.removeFromParent();
      entry.label.material.dispose();
      entry.labelTexture?.dispose();
      entry.label = null;
    }
  }

  _afterPhase(entry) {
    if (!entry.phasing) return;
    entry.phasing = false;
    if (entry.removing || entry.destroyed) return;
    const jobs = entry.deferred.splice(0);
    for (const fn of jobs) fn();
    if (this.highlightId === entry.id && !entry.hl) this._highlight(entry);
  }

  // Material swaps (color, card faces, screens) wait for the phase-in and keep the highlight.
  _withMaterials(entry, fn) {
    if (entry.phasing) {
      entry.deferred.push(fn);
      return;
    }
    const lit = !!entry.hl;
    if (lit) this._unhighlight(entry);
    fn();
    if (lit) this._highlight(entry);
  }

  // ---------- poses ----------

  _applyRecordPose(entry) {
    const { wrapper, record } = entry;
    wrapper.position.fromArray(record.p || [0, 0, 0]);
    wrapper.quaternion.setFromAxisAngle(UP, record.ry || 0);
    wrapper.scale.setScalar(record.s || 1);
    entry.bFrame = -1;
  }

  _tweenToRecord(entry, duration) {
    const { record } = entry;
    this._tweenTo(entry, record.p || [0, 0, 0], record.ry || 0, record.s || 1, duration);
  }

  _tweenTo(entry, p, ry, s, duration) {
    const { wrapper } = entry;
    const tween = entry.tween || { p0: new THREE.Vector3(), q0: new THREE.Quaternion(), s0: new THREE.Vector3(), p1: new THREE.Vector3(), q1: new THREE.Quaternion(), s1: new THREE.Vector3() };
    tween.t = 0;
    tween.duration = duration;
    tween.p0.copy(wrapper.position);
    tween.q0.copy(wrapper.quaternion);
    tween.s0.copy(wrapper.scale);
    tween.p1.fromArray(p);
    tween.q1.setFromAxisAngle(UP, ry);
    tween.s1.setScalar(s);
    entry.tween = tween;
  }

  _stepTween(entry, dt) {
    const tween = entry.tween;
    tween.t += dt;
    const k = easeInOut(clamp(tween.t / tween.duration, 0, 1));
    const { wrapper } = entry;
    wrapper.position.lerpVectors(tween.p0, tween.p1, k);
    wrapper.quaternion.slerpQuaternions(tween.q0, tween.q1, k);
    wrapper.scale.lerpVectors(tween.s0, tween.s1, k);
    if (tween.t >= tween.duration) entry.tween = null;
    entry.bFrame = -1;
  }

  _attach(entry, attach) {
    entry.attach = attach;
    entry.tween = null;
    entry.fly = null;
    if (attach.grip === "keep" && attach.rel) {
      entry.relP.fromArray(attach.rel.p);
      entry.relQ.fromArray(attach.rel.q).normalize();
      entry.attachMode = "keep";
    } else {
      const meta = entry.meta;
      const h = meta.size?.[1] ?? 0.5;
      const grip = meta.grip || { p: [0, h / 2, 0], r: [0, 0, 0] };
      entry.gripP.fromArray(grip.p || [0, h / 2, 0]);
      const r = grip.r || [0, 0, 0];
      entry.gripQ.setFromEuler(this._t.e.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, "XYZ"));
      entry.attachMode = "snap";
    }
  }

  // object = hand * R(grip.r) * T(-grip.p * s)   or   object = hand * rel
  _applyAttach(entry) {
    const attach = entry.attach;
    const pose = this.getHand(attach.user, attach.hand);
    if (!pose?.p || !pose?.q) return;
    const { wrapper } = entry;
    const s = entry.record.s || 1;
    wrapper.scale.setScalar(s);
    if (entry.attachMode === "keep") {
      wrapper.quaternion.multiplyQuaternions(pose.q, entry.relQ);
      wrapper.position.copy(entry.relP).applyQuaternion(pose.q).add(pose.p);
    } else {
      wrapper.quaternion.multiplyQuaternions(pose.q, entry.gripQ);
      const offset = this._t.v.copy(entry.gripP).multiplyScalar(s).applyQuaternion(wrapper.quaternion);
      wrapper.position.copy(pose.p).sub(offset);
    }
    entry.bFrame = -1;
  }

  // ---------- throws ----------

  _startFlight(entry, fly) {
    const vel = new THREE.Vector3().fromArray(fly.vel || [0, 0, 0]);
    const spin = Number(fly.spin) || 0;
    // Tumble axis: perpendicular to the horizontal travel direction, nudged by the id so it varies.
    const axis = new THREE.Vector3(vel.z, 0, -vel.x);
    if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0);
    axis.normalize();
    axis.y += (entry.seed - 0.5) * 0.6;
    axis.normalize();
    entry.fly = { vel, axis, spin, bounces: 0, t: 0 };
    entry.attach = null;
  }

  _stepFlight(entry, dt) {
    const fly = entry.fly;
    const { wrapper } = entry;
    const t = this._t;
    fly.t += dt;
    fly.vel.y -= GRAVITY * dt;
    wrapper.position.addScaledVector(fly.vel, dt);
    if (fly.spin) {
      // Tumble around the object's middle, not its base.
      const inner = entry.inner;
      const center = entry.restBox.getCenter(t.v2).multiply(inner.scale).applyQuaternion(inner.quaternion).add(inner.position);
      center.multiply(wrapper.scale).applyQuaternion(wrapper.quaternion).add(wrapper.position);
      t.q.setFromAxisAngle(fly.axis, fly.spin * dt);
      wrapper.quaternion.premultiply(t.q);
      wrapper.position.sub(center).applyQuaternion(t.q).add(center);
    }
    entry.bFrame = -1;
    const box = this._bounds(entry);
    const bottom = box.min.y;
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const support = this._support(entry, cx, cz, bottom + Math.max(0.05, -fly.vel.y * dt * 2));
    if (fly.vel.y < 0 && bottom <= support) {
      wrapper.position.y += support - bottom;
      const impact = -fly.vel.y;
      if (impact > 2.2 && fly.bounces < 2) {
        fly.bounces++;
        fly.vel.y = impact * 0.3;
        fly.vel.x *= 0.55;
        fly.vel.z *= 0.55;
        fly.spin *= 0.45;
      } else {
        this._land(entry, support);
      }
    } else if (fly.t > 8 || wrapper.position.y < -50) {
      this._land(entry, 0);
    }
  }

  _land(entry, support) {
    const { wrapper } = entry;
    entry.fly = null;
    const ry = yawOf(wrapper.quaternion);
    const s = entry.record.s || 1;
    // Upright rest pose centered where the tumbling object came down.
    const box = this._bounds(entry);
    const rest = entry.restBox;
    const ox = ((rest.min.x + rest.max.x) / 2) * s;
    const oz = ((rest.min.z + rest.max.z) / 2) * s;
    const x = (box.min.x + box.max.x) / 2 - (ox * Math.cos(ry) + oz * Math.sin(ry));
    const z = (box.min.z + box.max.z) / 2 - (-ox * Math.sin(ry) + oz * Math.cos(ry));
    const y = support - rest.min.y * s;
    const p = [round(x), round(y), round(z)];
    // Settle upright locally; the thrower turns this into the resting record pose.
    this._tweenTo(entry, p, ry, s, 0.18);
    this.emit("landed", { id: entry.id, p, ry });
  }

  // Highest surface top (meta.surface) under x,z that is not above maxY; ground is 0.
  _support(entry, x, z, maxY) {
    let best = 0;
    for (const other of this._surfaces) {
      if (other === entry || other.attach || other.removing) continue;
      const surface = other.meta.surface;
      const r = other.record;
      const s = r.s || 1;
      const top = other.wrapper.position.y + surface * s;
      if (top > maxY || top <= best) continue;
      const size = other.meta.surfaceSize || [other.meta.size?.[0] || 1, other.meta.size?.[2] || 1];
      const ry = r.ry || 0;
      const dx = x - other.wrapper.position.x;
      const dz = z - other.wrapper.position.z;
      const lx = dx * Math.cos(ry) - dz * Math.sin(ry);
      const lz = dx * Math.sin(ry) + dz * Math.cos(ry);
      if (Math.abs(lx) <= (size[0] * s) / 2 + 0.02 && Math.abs(lz) <= (size[1] * s) / 2 + 0.02) best = top;
    }
    return best;
  }

  // ---------- per frame ----------

  _updateEntry(entry, dt, t, now) {
    // Finished phases are noticed here too, so a frame never waits for the promise microtask.
    if (entry.phasing && this.phaser?.isPhasing && !this.phaser.isPhasing(entry.wrapper)) this._afterPhase(entry);
    if (entry.attach) this._applyAttach(entry);
    else if (entry.fly) this._stepFlight(entry, dt);
    else if (entry.tween) this._stepTween(entry, dt);
    if (entry.removing) entry.fade = Math.max(0, entry.fade - dt * entry.fadeSpeed);
    else if (entry.appear < 1) entry.appear = Math.min(1, entry.appear + dt / 1.2);
    this._stepInner(entry, dt, now);
    if (entry.hooks.update) {
      try {
        entry.hooks.update(dt, t);
      } catch (err) {
        console.error(`[objects] ${entry.part} update failed`, err);
        entry.hooks.update = null;
      }
    }
    if (entry.label) {
      const box = this._bounds(entry);
      entry.label.position.set((box.min.x + box.max.x) / 2, box.max.y + 0.22, (box.min.z + box.max.z) / 2);
      entry.label.visible = !entry.phasing && !entry.removing;
    }
  }

  // Inner transform = rest * behavior * wobble (rotation around the base).
  _stepInner(entry, dt, now) {
    const w = entry.wobble;
    const active = w.vel !== 0 || w.angle !== 0;
    if (active) {
      // Damped spring; sub-stepped so a long frame cannot blow it up.
      const steps = Math.max(1, Math.ceil(dt / 0.008));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        w.vel += (-70 * w.angle - 5.5 * w.vel) * h;
        w.angle = clamp(w.angle + w.vel * h, -0.45, 0.45);
      }
      if (Math.abs(w.angle) < 1e-4 && Math.abs(w.vel) < 1e-3) {
        w.angle = 0;
        w.vel = 0;
      }
    }
    // Behaviors start after the phase-in (the reveal is measured at rest) and ease in/out.
    const want = entry.behavior && !entry.attach && !entry.fly && !entry.phasing && !entry.removing ? 1 : 0;
    if (entry.behaveBlend !== want) entry.behaveBlend = want > entry.behaveBlend ? Math.min(1, entry.behaveBlend + dt / 0.6) : Math.max(0, entry.behaveBlend - dt / 0.3);
    const behave = entry.behaveBlend > 0 && (entry.behavior || entry.lastBehavior);
    if (!active && !behave && !entry.innerDirty) return;
    const inner = entry.inner;
    const t = this._t;
    inner.position.copy(entry.innerRest.p);
    inner.quaternion.copy(entry.innerRest.q);
    if (behave) {
      this._behave(entry, entry.behavior || entry.lastBehavior, now, t.v2, t.q2);
      const k = easeInOut(entry.behaveBlend);
      inner.position.addScaledVector(t.v2, k);
      inner.quaternion.premultiply(t.q.identity().slerp(t.q2, k));
    }
    if (w.angle !== 0) {
      t.q.setFromAxisAngle(w.axis, w.angle);
      inner.quaternion.premultiply(t.q);
    }
    entry.innerDirty = !!(active || behave);
    entry.bFrame = -1;
  }

  _setBehavior(entry, behavior) {
    const kind = behavior?.kind;
    if (entry.behavior) entry.lastBehavior = entry.behavior;
    entry.behavior = BEHAVIORS.has(kind) ? { kind, speed: clamp(Number(behavior.speed) || 1, 0.1, 4) } : null;
    if (entry.behavior && entry.lastBehavior?.kind !== kind) entry.behaveBlend = 0;
    entry.innerDirty = true;
  }

  // Deterministic from wall-clock time + id, so every client shows the same motion without traffic.
  _behave(entry, behavior, now, outP, outQ) {
    const { kind, speed } = behavior;
    const s = entry.record.s || 1;
    const time = now * speed + entry.seed * 100;
    const R = clamp(entry.footprint * 1.6, 0.8, 6);
    let x = 0;
    let y = 0;
    let z = 0;
    let yaw = 0;
    let pitch = 0;
    let roll = 0;
    const circle = (rate, radius = R) => {
      const a = time * rate;
      x = Math.cos(a) * radius;
      z = Math.sin(a) * radius;
      yaw = Math.atan2(-Math.sin(a), Math.cos(a)) * Math.sign(rate || 1);
      return a;
    };
    switch (kind) {
      case "spin":
        yaw = time * 1.4;
        break;
      case "float":
        y = 0.25 + 0.12 * Math.sin(time * 1.7);
        yaw = Math.sin(time * 0.4) * 0.6;
        break;
      case "bounce":
        y = Math.abs(Math.sin(time * 3.2)) * 0.4;
        break;
      case "sway":
        roll = Math.sin(time * 1.6) * 0.14;
        break;
      case "hop":
        circle(0.9 / R);
        y = Math.abs(Math.sin(time * 4.5)) * 0.3;
        break;
      case "walk":
        circle(0.7 / R);
        y = Math.abs(Math.sin(time * 7)) * 0.03;
        roll = Math.sin(time * 7) * 0.04;
        break;
      case "roll": {
        const a = circle(1 / R);
        pitch = (a * R) / Math.max(0.1, entry.height / 2);
        break;
      }
      case "swim":
        circle(0.8 / R);
        y = 0.15 + Math.sin(time * 2) * 0.08;
        yaw += Math.sin(time * 6) * 0.15;
        break;
      case "fly":
        circle(1.4 / R, R * 1.3);
        y = 1.6 + Math.sin(time * 1.3) * 0.35;
        roll = -0.35;
        break;
      default:
        break;
    }
    outQ.setFromEuler(this._t.e.set(pitch, yaw, roll, "YXZ"));
    outP.set(x / s, y / s, z / s);
    if (kind === "roll") {
      // Roll around the middle, not the base.
      const c = (entry.restBox.min.y + entry.restBox.max.y) / 2;
      const center = this._t.v3.set(0, c, 0);
      outP.add(center).sub(center.applyQuaternion(outQ));
    }
  }

  // World bounds of the (possibly animated) inner object, cached per frame.
  _bounds(entry) {
    if (entry.bFrame === this.frame) return entry.worldBox;
    entry.inner.updateWorldMatrix(true, false);
    entry.worldBox.copy(entry.restBox).applyMatrix4(entry.inner.matrixWorld);
    entry.bFrame = this.frame;
    return entry.worldBox;
  }

  // ---------- materials ----------

  _applyColor(entry) {
    const color = entry.record.color;
    for (const [mesh, original] of entry.tints) {
      if (!color) mesh.material = original;
      else if (Array.isArray(original)) mesh.material = original.map((m) => kit.mat(color, m.userData?.kind || "matte"));
      else mesh.material = kit.mat(color, original.userData?.kind || "matte");
    }
  }

  // Same shader program as the original (only uniforms differ), so hovering never compiles.
  _highlightOf(entry, material) {
    if (material.isShaderMaterial || material.userData?.phaseClone) return material;
    let clone = entry.hlCache.get(material);
    if (!clone) {
      clone = material.clone();
      clone.userData = { highlight: true };
      if (clone.emissive) {
        // Lift the object's own color (keeps detail at night) with a hint of the accent.
        const k = 1 / Math.max(0.2, material.emissiveIntensity ?? 1);
        clone.emissive = material.emissive.clone()
          .add(this._t.color.copy(material.color || ACCENT).multiplyScalar(0.28 * k))
          .add(this._t.color.copy(ACCENT).multiplyScalar(0.05 * k));
      } else if (clone.color) {
        clone.color = material.color.clone().lerp(ACCENT, 0.3);
      }
      entry.hlCache.set(material, clone);
    }
    return clone;
  }

  _highlight(entry) {
    if (entry.hl) return;
    const applied = [];
    entry.wrapper.traverse((child) => {
      if (!child.isMesh || child.userData.phaseHelper || !child.material) return;
      const from = child.material;
      const to = Array.isArray(from) ? from.map((m) => this._highlightOf(entry, m)) : this._highlightOf(entry, from);
      child.material = to;
      applied.push({ mesh: child, from, to });
    });
    entry.hl = applied;
  }

  _unhighlight(entry) {
    if (!entry.hl) return;
    for (const { mesh, from, to } of entry.hl) if (mesh.material === to) mesh.material = from;
    entry.hl = null;
  }

  _refreshScreen(entry) {
    if (!entry.hooks.setScreen) return;
    const texture = entry.screenStream ? this.share?.textureFor?.(entry.screenStream) || null : null;
    if (texture === entry.screenTexture) return;
    entry.screenTexture = texture;
    this._withMaterials(entry, () => entry.hooks.setScreen(texture));
  }

  // ---------- labels ----------

  _updateLabel(entry) {
    const options = { width: 256, height: 96, text: `Hits ${entry.hits}`, size: 46, weight: "700", color: "#d5fb6a", bg: "rgba(16,20,18,0.82)", align: "center", valign: "middle", radius: 40, padding: 12 };
    if (!entry.label) {
      const texture = textTexture(options);
      if (!texture) return;
      const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, fog: false });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(0.48, 0.18, 1);
      sprite.raycast = noRaycast;
      sprite.userData.phaseHelper = true;
      sprite.renderOrder = 4;
      sprite.name = `label:${entry.id}`;
      entry.label = sprite;
      entry.labelTexture = texture;
      this.scene.add(sprite);
      return;
    }
    updateTextTexture(entry.labelTexture, options);
  }

  // ---------- shadows ----------

  _unclear(entry) {
    removeClearing(this.scene, entry.id);
    entry.cleared = false;
  }

  _ensureShadows(capacity) {
    if (this.shadows && this.shadows.instanceMatrix.count >= capacity) return;
    const size = Math.max(64, 2 ** Math.ceil(Math.log2(capacity)));
    this.shadows?.removeFromParent();
    this.shadows?.dispose();
    const mesh = new THREE.InstancedMesh(this.shadowGeometry, this.shadowMaterial, size);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.raycast = noRaycast;
    mesh.renderOrder = 1;
    mesh.name = "blob-shadows";
    mesh.userData.phaseHelper = true;
    this.shadows = mesh;
    this.scene.add(mesh);
  }

  _updateShadows() {
    this._ensureShadows(this.entries.size + this.dying.size);
    const mesh = this.shadows;
    const t = this._t;
    let n = 0;
    const write = (entry) => {
      if (entry.attach || entry.fade <= 0) {
        if (entry.cleared) this._unclear(entry);
        return;
      }
      const box = this._bounds(entry);
      const x = (box.min.x + box.max.x) / 2;
      const z = (box.min.z + box.max.z) / 2;
      const support = this._support(entry, x, z, box.min.y + 0.05);
      const lift = Math.max(0, box.min.y - support);
      const s = entry.wrapper.scale.x || 1;
      const w0 = (entry.restBox.max.x - entry.restBox.min.x) * s;
      const d0 = (entry.restBox.max.z - entry.restBox.min.z) * s;
      // Grass parts under things standing on the ground (it grows back when they leave).
      if (support === 0 && lift < 0.3) {
        setClearing(this.scene, entry.id, x, z, Math.max(0.15, Math.hypot(w0, d0) * 0.42), entry.appear * entry.fade * (1 - lift / 0.3));
        entry.cleared = true;
      } else if (entry.cleared) {
        this._unclear(entry);
      }
      const w = Math.max(0.12, w0 * 1.3);
      const d = Math.max(0.12, d0 * 1.3);
      const big = clamp(1.1 - Math.max(w, d) / 16, 0.55, 1);
      const opacity = 0.5 * big * (1 - clamp(lift / (1.2 + Math.max(w, d) * 0.3), 0, 1)) * entry.fade * entry.appear;
      if (opacity < 0.01) return;
      t.q.setFromAxisAngle(UP, yawOf(entry.wrapper.quaternion));
      t.m.compose(t.v.set(x, support + 0.012, z), t.q, t.s.set(w * (1 + lift * 0.2), opacity, d * (1 + lift * 0.2)));
      mesh.setMatrixAt(n, t.m);
      n++;
    };
    for (const entry of this.entries.values()) write(entry);
    for (const entry of this.dying) write(entry);
    mesh.count = n;
    if (n) mesh.instanceMatrix.needsUpdate = true;
  }
}

const round = (n) => Math.round(n * 1000) / 1000;
