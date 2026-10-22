// Magic marker input (ARCHITECTURE.md "Magic marker"): pen motion (VR marker tip, desktop drawing
// sheet, phone sketch import) → "drawing" records. The live stroke is drawn locally every frame;
// the room gets one op per finished stroke.
import * as THREE from "../../vendor/three.module.min.js";
import { Emitter } from "../util/emitter.js";
import { makeCanvas } from "../util/text.js";
import { LIMITS } from "../core/room-state.js";
import {
  STROKE_DEFAULTS, simplifyStroke, quantize, limitStrokes, projectStrokes, asciiArt, sketchStats,
} from "../core/sketch.js";
import { RADIAL, inkColor, initNormal } from "../parts/build/sketch.js";

const MAX_LIVE = 2000; // points per stroke
const MIN_STEP = 0.006; // meters between stored points
const SMOOTH = 0.6; // weight of the newest pen sample (light smoothing)
const SIMPLIFY = 0.0025;
const GRID = 0.005;
const MAX_POINTS = 6000;
const JOIN_DIST = 2;
const JOIN_MS = 60000;
const RANGE = 15;
const SHEET_W = 2.4;
const SHEET_H = 1.5;
const SHEET_DIST = 2.5;
const HEX = /^#[0-9a-f]{6}$/i;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const finite = Number.isFinite;

const COS = Float32Array.from({ length: RADIAL }, (_, k) => Math.cos((k / RADIAL) * Math.PI * 2));
const SIN = Float32Array.from({ length: RADIAL }, (_, k) => Math.sin((k / RADIAL) * Math.PI * 2));

// Scratch (no per-frame allocation).
const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _n = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _ndc = new THREE.Vector2();
const _color = new THREE.Color();
const okPoint = (v) => !!v && finite(v.x) && finite(v.y) && finite(v.z);

// Marks [start, end) of an attribute for upload, reusing one range object (three clears the list
// after each upload).
function markDirty(attr, range, start, end) {
  if (!attr.updateRanges.length) {
    range.start = start;
    range.count = end - start;
    attr.updateRanges.push(range);
  } else {
    const from = Math.min(range.start, start);
    range.count = Math.max(range.start + range.count, end) - from;
    range.start = from;
  }
  attr.needsUpdate = true;
}

// One pen (key): its in-progress stroke and the live tube mesh, preallocated and reused.
class Pen {
  constructor(key, material) {
    this.key = key;
    this.active = false;
    this.n = 0;
    this.pts = new Float32Array(MAX_LIVE * 3);
    this.normals = new Float32Array(MAX_LIVE * 3);
    this.sm = new THREE.Vector3(); // smoothed local pen position
    this.raw = new THREE.Vector3(); // latest local pen position
    this.frame = { id: null, p: [0, 0, 0], ry: 0, s: 1 };
    this.color = STROKE_DEFAULTS.color;
    this.width = STROKE_DEFAULTS.width;
    const geometry = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(MAX_LIVE * RADIAL * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(MAX_LIVE * RADIAL * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.posRange = { start: 0, count: 0 };
    this.colRange = { start: 0, count: 0 };
    geometry.setAttribute("position", this.pos);
    geometry.setAttribute("color", this.col);
    const index = new Uint16Array((MAX_LIVE - 1) * RADIAL * 6);
    let o = 0;
    for (let i = 0; i < MAX_LIVE - 1; i++) {
      const a = i * RADIAL;
      const c = a + RADIAL;
      for (let k = 0; k < RADIAL; k++) {
        const k1 = (k + 1) % RADIAL;
        index[o++] = a + k;
        index[o++] = a + k1;
        index[o++] = c + k;
        index[o++] = a + k1;
        index[o++] = c + k1;
        index[o++] = c + k;
      }
    }
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = `draw:live:${key}`;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
  }

  start(frame, color, width) {
    this.frame = frame;
    this.color = color;
    this.width = width;
    this.n = 0;
    this.active = true;
    _color.set(color);
    this.rgb = [_color.r, _color.g, _color.b];
    this.mesh.position.fromArray(frame.p);
    this.mesh.rotation.set(0, frame.ry, 0);
    this.mesh.scale.setScalar(frame.s);
    this.mesh.geometry.setDrawRange(0, 0);
    this.pos.clearUpdateRanges();
    this.col.clearUpdateRanges();
    this.mesh.visible = true;
  }

  stop() {
    this.active = false;
    this.mesh.visible = false;
    this.mesh.geometry.setDrawRange(0, 0);
  }

  // Appends a local point and rebuilds the last two rings.
  push(x, y, z) {
    if (this.n >= MAX_LIVE) return;
    const i = this.n++;
    this.pts[i * 3] = x;
    this.pts[i * 3 + 1] = y;
    this.pts[i * 3 + 2] = z;
    if (i < 1) return;
    this._ring(i - 1);
    this._ring(i);
    const from = (i - 1) * RADIAL * 3;
    markDirty(this.pos, this.posRange, from, from + RADIAL * 6);
    markDirty(this.col, this.colRange, from, from + RADIAL * 6);
    this.mesh.geometry.setDrawRange(0, i * RADIAL * 6);
  }

  _ring(i) {
    const p = this.pts;
    const a = Math.max(0, i - 1);
    const b = Math.min(this.n - 1, i + 1);
    _t.set(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]);
    if (_t.lengthSq() < 1e-14) _t.set(1, 0, 0);
    _t.normalize();
    if (i === 0) initNormal(_t, _n);
    else {
      _n.fromArray(this.normals, (i - 1) * 3);
      _n.addScaledVector(_t, -_n.dot(_t));
      if (_n.lengthSq() < 1e-10) initNormal(_t, _n);
      _n.normalize();
    }
    _n.toArray(this.normals, i * 3);
    _b.crossVectors(_t, _n);
    const r = this.width / 2;
    const pos = this.pos.array;
    const col = this.col.array;
    _p.fromArray(p, i * 3);
    for (let k = 0; k < RADIAL; k++) {
      _d.copy(_n).multiplyScalar(COS[k]).addScaledVector(_b, SIN[k]);
      const o = (i * RADIAL + k) * 3;
      pos[o] = _p.x + _d.x * r;
      pos[o + 1] = _p.y + _d.y * r;
      pos[o + 2] = _p.z + _d.z * r;
      inkColor(this.rgb, Math.abs(_d.z), col, o);
    }
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}

export class Draw extends Emitter {
  constructor({ scene, room, send, getUser, newId }) {
    super();
    this.scene = scene;
    this.room = room;
    this.send = send;
    this.getUser = getUser;
    this.newId = newId;
    this._color = STROKE_DEFAULTS.color;
    this._width = STROKE_DEFAULTS.width;
    this.pens = new Map();
    this.lastStroke = new Map(); // drawing id → ms of our last stroke on it
    this.liveMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    this.plane = null;
    this.time = 0;
    this.live = 0; // pens with a stroke in progress
    this._onDown = (e) => this._pointerDown(e);
    this._onMove = (e) => this._pointerMove(e);
    this._onUp = (e) => this._pointerUp(e);
  }

  get color() {
    return this._color;
  }

  setColor(hex) {
    if (typeof hex === "string" && HEX.test(hex)) this._color = hex.toLowerCase();
  }

  get width() {
    return this._width;
  }

  setWidth(m) {
    if (finite(m)) this._width = clamp(m, 0.003, 0.05);
  }

  drawing(key) {
    return !!this.pens.get(key)?.active;
  }

  // Starts a stroke: joins this user's open drawing near the point, or frames a new one there.
  begin(key, worldPoint, faceYaw = 0) {
    if (!okPoint(worldPoint)) return;
    if (this.drawing(key)) this.end(key);
    let pen = this.pens.get(key);
    if (!pen) {
      pen = new Pen(key, this.liveMaterial);
      this.pens.set(key, pen);
      this.scene?.add(pen.mesh);
    }
    const open = this._openDrawing(worldPoint);
    const frame = open
      ? { id: open.id, p: [...open.p], ry: open.ry || 0, s: open.s || 1 }
      : { id: null, p: [worldPoint.x, worldPoint.y, worldPoint.z], ry: finite(faceYaw) ? faceYaw : 0, s: 1 };
    pen.start(frame, this._color, this._width);
    this.live++;
    this._toLocal(frame, worldPoint, pen.raw);
    pen.sm.copy(pen.raw);
    pen.push(pen.raw.x, pen.raw.y, pen.raw.z);
  }

  move(key, worldPoint) {
    const pen = this.pens.get(key);
    if (!pen?.active || !okPoint(worldPoint)) return;
    this._toLocal(pen.frame, worldPoint, pen.raw);
    pen.sm.lerp(pen.raw, SMOOTH);
    const i = (pen.n - 1) * 3;
    _v.set(pen.pts[i], pen.pts[i + 1], pen.pts[i + 2]);
    if (_v.distanceToSquared(pen.sm) >= MIN_STEP * MIN_STEP) pen.push(pen.sm.x, pen.sm.y, pen.sm.z);
  }

  // Finishes the stroke: one add (new drawing) or set (joined drawing) op. → drawing id or null.
  end(key) {
    const pen = this.pens.get(key);
    if (!pen?.active) return null;
    const i = (pen.n - 1) * 3;
    _v.set(pen.pts[i], pen.pts[i + 1], pen.pts[i + 2]);
    if (_v.distanceToSquared(pen.raw) >= MIN_STEP * MIN_STEP) pen.push(pen.raw.x, pen.raw.y, pen.raw.z);
    const pts = quantize(simplifyStroke(Array.from(pen.pts.subarray(0, pen.n * 3)), SIMPLIFY), GRID);
    const frame = pen.frame;
    this._stop(pen);
    if (!pts.length) return null;
    const stroke = { c: pen.color, w: pen.width, pts };
    const found = frame.id ? this.room?.get?.(frame.id) : null;
    const record = found?.part === "drawing" ? found : null;
    let id;
    if (record) {
      id = record.id;
      const data = record.data || {};
      const strokes = Array.isArray(data.strokes) ? data.strokes : [];
      this.send({ t: "set", id, patch: { data: { ...data, strokes: fitStrokes([...strokes, stroke], data) } } });
    } else {
      // New drawing (or the joined one was erased meanwhile: keep its frame).
      id = this.newId("o");
      this.send({ t: "add", obj: this._record(id, frame.p, frame.ry, [stroke]) });
    }
    this.lastStroke.set(id, Date.now());
    this.emit("stroke", { id });
    return id;
  }

  cancel(key) {
    const pen = this.pens.get(key);
    if (pen?.active) this._stop(pen);
  }

  // Phone sketch → a drawing `width` meters across (longest side), standing 2 m in front of the pose.
  importSketch({ lines, aspect, color } = {}, { pose, width = 2 } = {}) {
    const a = finite(aspect) && aspect > 0 ? clamp(aspect, 0.05, 20) : 1;
    const ink = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const line of Array.isArray(lines) ? lines : []) {
      const pts = [];
      for (const q of Array.isArray(line) ? line : []) {
        if (!q || !finite(q[0]) || !finite(q[1])) continue;
        const x = clamp(q[0], -1, 2) * a; // canvas units: height = 1
        const y = clamp(q[1], -1, 2);
        pts.push(x, y);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      if (pts.length) ink.push(pts);
    }
    if (!ink.length) return null;
    const meters = finite(width) && width > 0 ? clamp(width, 0.1, 20) : 2;
    const ext = Math.max(maxX - minX, maxY - minY);
    const scale = ext > 1e-9 ? meters / ext : 1;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const c = HEX.test(color || "") ? color.toLowerCase() : this._color;
    const strokes = ink.map((pts) => {
      const flat = [];
      for (let i = 0; i < pts.length; i += 2) flat.push((pts[i] - cx) * scale, (cy - pts[i + 1]) * scale, 0); // y down → up
      return { c, w: this._width, pts: quantize(simplifyStroke(flat, SIMPLIFY), GRID) };
    });
    const head = Array.isArray(pose?.p) && pose.p.every(finite) ? pose.p : [0, 1.6, 0];
    const yaw = finite(pose?.yaw) ? pose.yaw : 0;
    const half = ((maxY - minY) * scale) / 2;
    const p = [head[0] - Math.sin(yaw) * 2, Math.max(head[1] - 0.2, half + 0.05), head[2] - Math.cos(yaw) * 2];
    const ry = Math.atan2(head[0] - p[0], head[2] - p[2]);
    const id = this.newId("o");
    this.send({ t: "add", obj: this._record(id, p, ry, strokes) });
    this.lastStroke.set(id, Date.now());
    return id;
  }

  // The user's most recent drawing within 15 m of the pose, else the nearest drawing within 15 m.
  latestDrawing(user, pose) {
    const head = Array.isArray(pose?.p) ? pose.p : [0, 0, 0];
    let mine = null;
    let mineAt = -Infinity;
    let near = null;
    let nearD = Infinity;
    for (const r of this._drawings()) {
      const d = Math.hypot(r.p[0] - head[0], r.p[2] - head[2]);
      if (d > RANGE) continue;
      if (user && r.by === user && this._activity(r) >= mineAt) {
        mine = r;
        mineAt = this._activity(r);
      }
      if (d < nearD) {
        near = r;
        nearD = d;
      }
    }
    return mine || near;
  }

  // White PNG of the strokes in dark ink (for vision models). null without a canvas (Node).
  snapshotPNG(record, size = 384) {
    const lines = projectStrokes(record?.data?.strokes);
    if (!lines.length) return null;
    const canvas = makeCanvas(size, size);
    const ctx = canvas?.getContext("2d");
    if (!ctx) return null;
    const pad = size * 0.08;
    const span = size - pad * 2;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = "#222222";
    ctx.fillStyle = "#222222";
    ctx.lineWidth = Math.max(1.5, size / 80);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const line of lines) {
      const px = (q) => pad + q[0] * span;
      const py = (q) => pad + (1 - q[1]) * span;
      ctx.beginPath();
      if (line.length === 1) {
        ctx.arc(px(line[0]), py(line[0]), ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.moveTo(px(line[0]), py(line[0]));
      for (let i = 1; i < line.length; i++) ctx.lineTo(px(line[i]), py(line[i]));
      ctx.stroke();
    }
    return canvas.toDataURL("image/png");
  }

  asciiFor(record) {
    return asciiArt(projectStrokes(record?.data?.strokes));
  }

  statsFor(record) {
    return sketchStats(record?.data?.strokes);
  }

  // ---------- desktop drawing sheet ----------

  get planeMode() {
    return !!this.plane;
  }

  // A faint sheet 2.5 m ahead of the camera (fixed where it appeared); left-drag on dom draws on it.
  setPlaneMode(on, { camera, dom } = {}) {
    if (this.plane) {
      if (this.drawing("mouse")) this.end("mouse");
      const { sheet, dom: oldDom } = this.plane;
      oldDom?.removeEventListener("pointerdown", this._onDown);
      oldDom?.removeEventListener("pointermove", this._onMove);
      oldDom?.removeEventListener("pointerup", this._onUp);
      oldDom?.removeEventListener("pointercancel", this._onUp);
      sheet.removeFromParent();
      sheet.traverse((child) => {
        child.geometry?.dispose();
        child.material?.dispose();
      });
      this.plane = null;
    }
    if (on && camera) {
      camera.updateMatrixWorld();
      const eye = camera.getWorldPosition(new THREE.Vector3());
      const fwd = camera.getWorldDirection(new THREE.Vector3()).setY(0);
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      const center = eye.clone().addScaledVector(fwd, SHEET_DIST);
      center.y = Math.max(eye.y - 0.1, SHEET_H / 2 + 0.05);
      const ry = Math.atan2(eye.x - center.x, eye.z - center.z);
      const sheet = makeSheet();
      sheet.position.copy(center);
      sheet.rotation.set(0, ry, 0);
      sheet.updateMatrixWorld(true);
      this.scene?.add(sheet);
      const normal = new THREE.Vector3(Math.sin(ry), 0, Math.cos(ry));
      this.plane = {
        sheet, camera, dom, ry, center, right: new THREE.Vector3(Math.cos(ry), 0, -Math.sin(ry)),
        surface: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center), raycaster: new THREE.Raycaster(),
        hit: new THREE.Vector3(), pointer: null,
      };
      dom?.addEventListener("pointerdown", this._onDown);
      dom?.addEventListener("pointermove", this._onMove);
      dom?.addEventListener("pointerup", this._onUp);
      dom?.addEventListener("pointercancel", this._onUp);
    }
    this.emit("plane", this.planeMode);
  }

  // Sheet point under the pointer (screen center while pointer-locked) → plane.hit or null.
  _sheetHit(e) {
    const pl = this.plane;
    const locked = typeof document !== "undefined" && !!document.pointerLockElement;
    const rect = pl.dom.getBoundingClientRect?.();
    if (locked || !rect || !rect.width || !rect.height) _ndc.set(0, 0);
    else _ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    pl.camera.updateMatrixWorld();
    pl.raycaster.setFromCamera(_ndc, pl.camera);
    if (!pl.raycaster.ray.intersectPlane(pl.surface, pl.hit)) return null;
    _v.subVectors(pl.hit, pl.center);
    if (Math.abs(_v.dot(pl.right)) > SHEET_W / 2 || Math.abs(_v.y) > SHEET_H / 2) return null;
    return pl.hit;
  }

  _pointerDown(e) {
    if (!this.plane || e.button !== 0 || e.isPrimary === false) return;
    const hit = this._sheetHit(e);
    if (!hit) return;
    this.plane.pointer = e.pointerId;
    try {
      this.plane.dom.setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic or already-released pointer: drawing still works without capture.
    }
    this.begin("mouse", hit, this.plane.ry);
  }

  _pointerMove(e) {
    if (!this.plane || e.pointerId !== this.plane.pointer || !this.drawing("mouse")) return;
    const hit = this._sheetHit(e);
    if (hit) this.move("mouse", hit);
  }

  _pointerUp(e) {
    if (!this.plane || e.pointerId !== this.plane.pointer) return;
    this.plane.pointer = null;
    this.end("mouse");
  }

  // ---------- frame ----------

  update(dt) {
    this.time += dt || 0;
    if (this.live) this.liveMaterial.color.setScalar(0.9 + 0.1 * Math.sin(this.time * 9));
  }

  dispose() {
    this.setPlaneMode(false);
    for (const pen of this.pens.values()) pen.dispose();
    this.pens.clear();
    this.liveMaterial.dispose();
  }

  // ---------- internals ----------

  _stop(pen) {
    pen.stop();
    this.live--;
  }

  _record(id, p, ry, strokes) {
    return { id, part: "drawing", label: "drawing", p, ry, s: 1, data: { strokes: fitStrokes(strokes, {}) }, by: this.getUser(), t: Date.now() };
  }

  _drawings() {
    const list = this.room?.records?.() || [];
    return list.filter((r) => r && r.part === "drawing" && Array.isArray(r.p));
  }

  _activity(record) {
    return Math.max(this.lastStroke.get(record.id) || 0, record.t || 0);
  }

  // This user's most recently used drawing, stroked < 60 s ago, with its origin within 2 m.
  _openDrawing(point) {
    const user = this.getUser();
    const now = Date.now();
    let best = null;
    let bestAt = -Infinity;
    for (const r of this._drawings()) {
      if (r.by !== user || r.attach) continue;
      const at = this._activity(r);
      if (now - at >= JOIN_MS || at < bestAt) continue;
      if (Math.hypot(r.p[0] - point.x, r.p[1] - point.y, r.p[2] - point.z) > JOIN_DIST) continue;
      best = r;
      bestAt = at;
    }
    return best;
  }

  _toLocal(frame, w, out) {
    const dx = w.x - frame.p[0];
    const dy = w.y - frame.p[1];
    const dz = w.z - frame.p[2];
    const c = Math.cos(frame.ry);
    const s = Math.sin(frame.ry);
    const k = 1 / (frame.s || 1);
    return out.set((c * dx - s * dz) * k, dy * k, (s * dx + c * dz) * k);
  }
}

// ≤ 6000 points, and small enough for the room's data limit (simplified further when needed).
function fitStrokes(strokes, data) {
  let max = MAX_POINTS;
  let out = limitStrokes(strokes, max);
  while (max > 200 && JSON.stringify({ ...data, strokes: out }).length > LIMITS.data - 1024) {
    max = Math.floor(max * 0.8);
    out = limitStrokes(strokes, max);
  }
  return out;
}

function makeSheet() {
  const sheet = new THREE.Mesh(
    new THREE.PlaneGeometry(SHEET_W, SHEET_H),
    new THREE.MeshBasicMaterial({ color: "#eef8dc", transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
  );
  const w = SHEET_W / 2;
  const h = SHEET_H / 2;
  const border = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-w, -h, 0), new THREE.Vector3(w, -h, 0), new THREE.Vector3(w, h, 0), new THREE.Vector3(-w, h, 0)]),
    new THREE.LineBasicMaterial({ color: "#d5fb6a", transparent: true, opacity: 0.45, toneMapped: false }),
  );
  sheet.add(border);
  sheet.name = "draw:sheet";
  sheet.renderOrder = 2;
  sheet.raycast = () => {};
  border.raycast = () => {};
  return sheet;
}
