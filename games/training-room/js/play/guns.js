// Guns that fire: the trigger (VR) or a left click (desktop) shoots along the aim ray. Bullets knock
// small things flying, wobble big things, spill containers and score on training dummies. Works for
// the built-in pistol and for every catalog gun by name ("semi automatic pistol", "laser blaster",
// "pistol axe" mashups...). Other players see the tracer and hear the shot through fx messages.
import * as THREE from "../../vendor/three.module.min.js";
import { Emitter } from "../util/emitter.js";

const RANGE = 80;
const KNOCK_MAX = 2.5; // meters: bigger things only wobble
const BLAST_RADIUS = 2.5;

const GUN = /\b(pistol|pistols|handgun|revolver|gun|guns|rifle|shotgun|smg|uzi|carbine|musket|blaster|derringer|magnum|raygun|minigun|gatling|flintlock|blunderbuss|sniper|ak ?47|m16|ar ?15|glock|luger|colt|nerf|bazooka|rpg|launcher|cannon|phaser|six ?shooter|firearm)\b/;
const NOT_GUN = /\b(shrimp|safe|rack|holster|case|cabinet|gunboat|gunship|ship|tank|turret|range|target|stand|display|mount|tower|truck|boat|car|jet|plane|helicopter|statue|sculpture|cake|cookie|sticker|poster|book|painting|toy box|crab|fish|ball|cannonball|cannon ball)\b/;

// → { style, auto, pellets, spread, power, rate, muzzle } or null.
export function gunOf(meta, record) {
  if (!meta || meta.fixed) return null;
  const words = `${meta.name || ""} ${record?.label || ""}`.toLowerCase().replace(/[-_]/g, " ");
  if (!meta.gun && (!GUN.test(words) || NOT_GUN.test(words))) return null;
  const gun = { style: "bullet", auto: false, pellets: 1, spread: 0.004, power: 1, rate: 7, muzzle: meta.gun?.muzzle || null };
  if (/\b(laser|ray ?gun|raygun|blaster|phaser|plasma|space)\b/.test(words)) Object.assign(gun, { style: "laser", rate: 6 });
  if (/\b(water|squirt|super soaker)\b/.test(words)) Object.assign(gun, { style: "water", power: 0.25, auto: true, rate: 12, spread: 0.02 });
  if (/\b(nerf|foam|dart|toy|cap gun)\b/.test(words)) Object.assign(gun, { power: 0.4 });
  if (/\b(shotgun|blunderbuss|scattergun)\b/.test(words)) Object.assign(gun, { pellets: 8, spread: 0.06, rate: 1.5 });
  if (/\b(smg|uzi|submachine|machine ?gun|minigun|gatling|assault|tommy|ak ?47|m16|ar ?15|full auto|fully automatic)\b/.test(words)) Object.assign(gun, { auto: true, rate: 12, spread: 0.012 });
  if (/\b(sniper|musket|flintlock|hunting rifle|elephant)\b/.test(words)) Object.assign(gun, { power: 1.8, rate: 1.2, spread: 0 });
  if (/\b(bazooka|rpg|rocket|grenade launcher|launcher|cannon)\b/.test(words)) Object.assign(gun, { style: "boom", power: 2.5, rate: 0.8, spread: 0 });
  return gun;
}

const COLORS = { bullet: "#ffd27a", laser: "#4cf3ff", water: "#7cc8ff", boom: "#ff8a3d" };
const LIFE = { bullet: 0.09, laser: 0.22, water: 0.25, boom: 0.3 };

export class Guns extends Emitter {
  // send(op), fx(payload): network; floppy (optional) for pokes; onSpill(containerId, dir, share).
  constructor({ scene, objects, room, send, fx, getUser, metaOf, interact, phaser, sfx, floppy, canKnock } = {}) {
    super();
    this.scene = scene;
    this.objects = objects;
    this.room = room;
    this.send = send;
    this.fx = fx || (() => {});
    this.getUser = getUser;
    this.metaOf = metaOf;
    this.interact = interact;
    this.phaser = phaser;
    this.sfx = sfx;
    this.floppy = floppy;
    this.canKnock = canKnock || (() => true);
    this.onSpill = null;
    this.down = { left: false, right: false };
    this.cool = { left: 0, right: 0 };
    this.kick = { left: 0, right: 0 };
    this._gunCache = new Map();
    this._effects = [];
    this._decals = [];
    this._ray = new THREE.Raycaster();
    this._box = new THREE.Box3();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._hits = [];
    this._pose = { left: { p: new THREE.Vector3(), q: new THREE.Quaternion() }, right: { p: new THREE.Vector3(), q: new THREE.Quaternion() } };
    this._unit = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    this._flash = new THREE.SphereGeometry(1, 8, 6);
    this._decal = new THREE.CircleGeometry(1, 12).rotateX(-Math.PI / 2);
    this._mats = new Map();
  }

  // The gun in this hand: { id, record, gun } or null.
  held(hand) {
    const id = this.interact?.held(hand);
    const record = id && this.room.get(id);
    if (!record) return null;
    const gun = this._gun(record);
    return gun ? { id, record, gun } : null;
  }

  _gun(record) {
    const key = `${record.part}|${record.label || ""}`;
    if (!this._gunCache.has(key)) this._gunCache.set(key, gunOf(this.metaOf(record), record));
    return this._gunCache.get(key);
  }

  // Trigger state from VR or a click. aim(): → THREE.Ray for the current aim (called per shot).
  trigger(hand, pressed, aim) {
    const held = this.held(hand);
    if (!held) {
      this.down[hand] = false;
      return false;
    }
    this.down[hand] = pressed ? aim : false;
    if (pressed) this.fire(hand, aim());
    return true;
  }

  // Desktop click: one shot (a three-round burst for automatics).
  click(hand, aim) {
    const held = this.held(hand);
    if (!held) return false;
    this.fire(hand, aim(), { force: true });
    if (held.gun.auto) {
      let n = 2;
      const next = () => {
        if (n-- <= 0 || !this.held(hand)) return;
        this.fire(hand, aim(), { force: true });
        setTimeout(next, 1000 / held.gun.rate);
      };
      setTimeout(next, 1000 / held.gun.rate);
    }
    return true;
  }

  update(dt) {
    for (const hand of ["left", "right"]) {
      this.cool[hand] = Math.max(0, this.cool[hand] - dt);
      this.kick[hand] = Math.max(0, this.kick[hand] - dt * 7);
      const aim = this.down[hand];
      if (!aim) continue;
      const held = this.held(hand);
      if (!held) this.down[hand] = false;
      else if (held.gun.auto && this.cool[hand] <= 0) this.fire(hand, aim());
    }
    for (let i = this._effects.length - 1; i >= 0; i--) {
      const fx = this._effects[i];
      fx.t += dt;
      const k = 1 - fx.t / fx.life;
      if (k <= 0) {
        fx.mesh.removeFromParent();
        fx.mesh.material.dispose();
        this._effects.splice(i, 1);
        continue;
      }
      fx.mesh.material.opacity = fx.opacity * k;
      if (fx.grow) fx.mesh.scale.multiplyScalar(1 + dt * fx.grow);
    }
    for (let i = this._decals.length - 1; i >= 0; i--) {
      const d = this._decals[i];
      d.t += dt;
      if (d.t > 12) d.mesh.material.opacity = Math.max(0, 0.7 * (1 - (d.t - 12) / 3));
      if (d.t > 15) {
        d.mesh.removeFromParent();
        d.mesh.material.dispose();
        this._decals.splice(i, 1);
      }
    }
  }

  // Recoil on the local hand pose used to draw held things.
  applyRecoil(hand, pose) {
    const k = this.kick[hand];
    if (!pose || !(k > 0)) return pose;
    const out = this._pose[hand];
    out.q.copy(pose.q).multiply(this._q.setFromAxisAngle(this._v.set(1, 0, 0), 0.35 * k));
    out.p.copy(pose.p).add(this._v.set(0, 0.015 * k, 0.035 * k).applyQuaternion(pose.q));
    return out;
  }

  // → true when a shot went off.
  fire(hand, ray, { force = false } = {}) {
    const held = this.held(hand);
    if (!held || !ray) return false;
    const { gun } = held;
    if (!force && this.cool[hand] > 0) return false;
    this.cool[hand] = 1 / gun.rate;
    const dir = this._v2.copy(ray.direction).normalize();
    const muzzle = this._muzzle(held, dir, new THREE.Vector3());
    let first = null;
    for (let i = 0; i < gun.pellets; i++) {
      const d = dir.clone();
      if (gun.spread) d.add(new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).multiplyScalar(gun.spread)).normalize();
      const hit = this._trace(ray.origin, d, held.id);
      const end = hit ? hit.point : ray.origin.clone().addScaledVector(d, RANGE);
      this._effect(muzzle, end, gun.style, !!hit);
      if (hit?.id) this._damage(hit, d, gun);
      else if (hit?.ground && gun.style !== "laser") this._mark(hit.point, gun.style);
      if (gun.style === "boom" && hit) this._blast(hit.point, gun);
      if (i === 0) first = { end, hit };
      if (i < 3) this.fx({ kind: "shot", style: gun.style, o: muzzle.toArray().map(r3), e: end.toArray().map(r3), hit: !!hit });
    }
    this.sfx?.shot(gun.style, muzzle);
    this.kick[hand] = Math.min(1, this.kick[hand] + (gun.style === "boom" ? 1 : gun.pellets > 1 ? 0.9 : gun.auto ? 0.35 : 0.7));
    this.emit("haptic", { hand, intensity: gun.style === "water" ? 0.2 : gun.style === "boom" ? 1 : 0.8, ms: gun.auto ? 30 : 70 });
    this.emit("shot", { hand, id: held.id, end: first?.end, hitId: first?.hit?.id || null });
    return true;
  }

  // Shots from other players: draw and play them.
  onFx(fx) {
    if (fx?.kind !== "shot" || !Array.isArray(fx.o) || !Array.isArray(fx.e)) return;
    const o = new THREE.Vector3().fromArray(fx.o.map(Number));
    const e = new THREE.Vector3().fromArray(fx.e.map(Number));
    if (![o.x, o.y, o.z, e.x, e.y, e.z].every(Number.isFinite)) return;
    const style = COLORS[fx.style] ? fx.style : "bullet";
    this._effect(o, e, style, !!fx.hit);
    this.sfx?.shot(style, o);
  }

  _muzzle(held, dir, out) {
    const entry = this.objects.entries?.get(held.id);
    if (held.gun.muzzle && entry) {
      entry.inner.updateWorldMatrix(true, false);
      return entry.inner.localToWorld(out.fromArray(held.gun.muzzle));
    }
    const box = this.objects.bounds(held.id, this._box);
    if (box.isEmpty()) return out.copy(this._ray.ray.origin);
    const c = box.getCenter(out);
    const h = box.getSize(this._v).multiplyScalar(0.5);
    return c.addScaledVector(dir, Math.abs(dir.x) * h.x + Math.abs(dir.y) * h.y + Math.abs(dir.z) * h.z);
  }

  // First thing along the ray (not the gun, not anything in my hands), or the ground.
  _trace(origin, dir, gunId) {
    const me = this.getUser();
    this._ray.set(origin, dir);
    this._ray.far = RANGE;
    let best = null;
    for (const entry of this.objects.entries?.values() || []) {
      if (entry.id === gunId || entry.removing) continue;
      const attach = entry.record?.attach;
      if (attach && attach.user === me) continue;
      const box = this.objects.bounds(entry.id, this._box);
      if (box.isEmpty()) continue;
      const enter = this._ray.ray.intersectBox(box, this._v);
      if (!enter) continue;
      const d = enter.distanceTo(origin);
      if (d > RANGE || (best && d > best.distance)) continue;
      this._hits.length = 0;
      this._ray.intersectObject(entry.inner, true, this._hits);
      const hit = this._hits.find((h) => h.object.visible !== false);
      if (hit && (!best || hit.distance < best.distance)) best = { id: entry.id, point: hit.point.clone(), distance: hit.distance };
    }
    this._hits.length = 0;
    if (dir.y < -1e-4) {
      const t = -origin.y / dir.y;
      if (t > 0 && t <= RANGE && (!best || t < best.distance)) best = { id: null, ground: true, point: origin.clone().addScaledVector(dir, t), distance: t };
    }
    return best;
  }

  _damage(hit, dir, gun) {
    const record = this.room.get(hit.id);
    if (!record) return;
    const power = gun.power;
    this.objects.hit(hit.id, Math.min(3, power), dir);
    this.fx({ kind: "hit", id: hit.id, power: Math.min(3, power) });
    this.sfx?.impact(hit.point);
    this.floppy?.poke(hit.id, hit.point, dir, power * 3);
    const meta = this.metaOf(record);
    if (meta.container) this.onSpill?.(record.id, dir, Math.min(1, 0.35 * power + 0.1));
    if (meta.squeak) this.sfx?.squeak(hit.point, false);
    this._knock(record, meta, dir, power);
  }

  // Small loose things go flying when shot.
  _knock(record, meta, dir, power) {
    if (record.attach || !this.canKnock(record)) return;
    if (this.interact && !this.interact.grabbable(record)) return;
    const size = Array.isArray(meta.size) ? meta.size : [1, 1, 1];
    const longest = Math.max(...size) * (record.s || 1);
    if (longest > KNOCK_MAX) return;
    const speed = Math.min(9, Math.max(1.2, 1.6 / Math.max(0.12, longest))) * Math.min(1.5, power);
    const vel = [dir.x * speed, Math.max(1.2, dir.y * speed + 1.6 * Math.min(1, power)), dir.z * speed];
    const pose = this.objects.worldPose?.(record.id);
    const p = pose ? [r3(pose.p.x), r3(pose.p.y), r3(pose.p.z)] : record.p;
    const patch = { p };
    if (record.onto) patch.onto = null;
    this.send({ t: "set", id: record.id, patch, fly: { vel: vel.map(r2), spin: r2((Math.random() - 0.5) * 16) } });
  }

  _blast(point, gun) {
    this.phaser?.burst?.(point, 1.2);
    for (const record of this.room.records()) {
      const pose = this.objects.worldPose?.(record.id);
      if (!pose) continue;
      const d = pose.p.distanceTo(point);
      if (d > BLAST_RADIUS) continue;
      const dir = pose.p.clone().sub(point).setY(0.6).normalize();
      const k = 1 - d / BLAST_RADIUS;
      this.objects.hit(record.id, 2 * k, dir);
      const meta = this.metaOf(record);
      if (meta.container) this.onSpill?.(record.id, dir, 1);
      this._knock(record, meta, dir, gun.power * k);
    }
  }

  _mat(color, opacity = 1) {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
    return m;
  }

  _effect(from, to, style, hit) {
    if (!this.scene) return;
    const color = COLORS[style] || COLORS.bullet;
    const length = from.distanceTo(to);
    if (length > 0.01) {
      const width = style === "laser" ? 0.006 : style === "boom" ? 0.03 : style === "water" ? 0.008 : 0.0035;
      const tracer = new THREE.Mesh(this._unit, this._mat(color, 0.9));
      tracer.position.copy(from);
      tracer.lookAt(to);
      tracer.scale.set(width, width, length);
      tracer.raycast = () => {};
      this.scene.add(tracer);
      this._effects.push({ mesh: tracer, t: 0, life: LIFE[style] || 0.1, opacity: 0.9 });
    }
    const flash = new THREE.Mesh(this._flash, this._mat(style === "water" ? "#cfe9ff" : "#fff1b8", 1));
    flash.position.copy(from);
    flash.scale.setScalar(style === "boom" ? 0.12 : 0.035);
    flash.raycast = () => {};
    this.scene.add(flash);
    this._effects.push({ mesh: flash, t: 0, life: 0.06, opacity: 1, grow: 6 });
    if (hit) this.phaser?.burst?.(to, style === "boom" ? 1 : 0.12);
  }

  _mark(point, style) {
    if (!this.scene || style === "boom") return;
    const color = style === "water" ? "#3d6f99" : "#151515";
    const decal = new THREE.Mesh(this._decal, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthWrite: false }));
    decal.position.set(point.x, 0.004, point.z);
    decal.scale.setScalar(style === "water" ? 0.06 : 0.02);
    decal.raycast = () => {};
    this.scene.add(decal);
    this._decals.push({ mesh: decal, t: 0 });
    while (this._decals.length > 40) {
      const old = this._decals.shift();
      old.mesh.removeFromParent();
      old.mesh.material.dispose();
    }
  }
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const r2 = (n) => Math.round(n * 100) / 100;
