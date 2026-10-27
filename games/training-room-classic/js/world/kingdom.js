// Kingdom mode in the world: three advisors who walk beside the player, villagers who wander
// between the buildings, and a dirt square at the center. Everything here is local decoration:
// nothing is sent to the bridge, so every device can choose its own mode.
import * as THREE from "../../vendor/three.module.min.js";
import { kit } from "../parts/build/kit.js";
import { figure } from "../parts/build/kingdom.js";
import { ADVISORS, WORTH, kingdomStats } from "../core/kingdom.js";
import { setClearing, removeClearing } from "./field.js";

const MAX_VILLAGERS = 10;
const PLAZA_RADIUS = 9;
const ADVISOR_DIST = 2.6;
// Slot angles (degrees) from the player's facing: builder left, steward right, marshal behind
// the steward. Wide enough that they never stand where the player points to build.
const SLOTS = { builder: -70, steward: 70, marshal: 115 };
const TUNICS = ["#8a6b3f", "#6d7f4a", "#7b5b8a", "#a4573c", "#4f6f86", "#9a8a5a"];

function rand(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function makeAdvisor(def) {
  const root = new THREE.Group();
  root.name = `advisor:${def.id}`;
  const body = figure({ tunic: def.tunic, hat: def.hat, robe: def.id === "steward", tint: false });
  kit.mergeStatic(body);
  root.add(body);
  const plate = kit.textPanel([1.1, 0.24], { text: def.name, size: 54, align: "center", valign: "middle", bg: "#14110d", color: "#f3e3b5" }, { p: [0, 2.05, 0] });
  root.add(plate);
  return { def, root, body, plate, pos: new THREE.Vector3(), target: new THREE.Vector3(), talk: 0, walk: 0, placed: false };
}

export class KingdomScene {
  constructor({ scene, room, sizeOf }) {
    this.scene = scene;
    this.room = room;
    this.sizeOf = sizeOf;
    this.enabled = false;
    this.root = new THREE.Group();
    this.root.name = "kingdom";
    this.root.visible = false;
    scene.add(this.root);

    const dirt = new THREE.MeshStandardMaterial({ color: "#8a6a45", roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.plaza = new THREE.Mesh(new THREE.CircleGeometry(PLAZA_RADIUS, 40), dirt);
    this.plaza.rotation.x = -Math.PI / 2;
    this.plaza.position.y = 0.01;
    this.plaza.name = "kingdom-plaza";
    this.root.add(this.plaza);

    // Ring on the ground where "here" lands.
    this.aim = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.75, 32), new THREE.MeshBasicMaterial({ color: "#f3d36b", transparent: true, opacity: 0.75, depthWrite: false }));
    this.aim.rotation.x = -Math.PI / 2;
    this.aim.position.y = 0.03;
    this.aim.visible = false;
    this.aim.name = "kingdom-aim";
    this.root.add(this.aim);

    this.advisors = ADVISORS.map(makeAdvisor);
    for (const a of this.advisors) this.root.add(a.root);
    this.bodyYaw = 0;

    this.villagers = [];
    for (let i = 0; i < MAX_VILLAGERS; i++) {
      const r = rand(i * 7919 + 13);
      const body = figure({ tunic: TUNICS[i % TUNICS.length], hat: r() < 0.5 ? "straw" : null, hair: r() < 0.5 ? "#4a3220" : "#a07a4a", tint: false });
      kit.mergeStatic(body);
      body.visible = false;
      this.root.add(body);
      this.villagers.push({ body, rnd: r, from: null, to: null, wait: r() * 3, speed: 0.9 + r() * 0.5, active: false });
    }
    this.stops = [];
    this.population = 0;
    this._dirty = true;
    room.on?.("change", () => {
      this._dirty = true;
    });
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.root.visible = this.enabled;
    if (this.enabled) setClearing(this.scene, "kingdom-plaza", 0, 0, PLAZA_RADIUS, 1);
    else removeClearing(this.scene, "kingdom-plaza");
    for (const a of this.advisors) a.placed = false;
    this._dirty = true;
  }

  setAim(point) {
    this.aim.visible = !!point;
    if (point) this.aim.position.set(point[0], 0.03, point[2]);
  }

  // An advisor answers: they nod and their name plate lights up for a moment.
  speak(id) {
    const a = this.advisors.find((x) => x.def.id === id);
    if (a) a.talk = 2.5;
  }

  // Door spots in front of every building that counts toward the realm.
  _refresh() {
    this._dirty = false;
    const records = this.room.records ? this.room.records() : [];
    const stops = [];
    for (const r of records) {
      if (!r || r.attach || !WORTH[r.part] || !Array.isArray(r.p)) continue;
      const size = this.sizeOf ? this.sizeOf(r) : [4, 4, 4];
      const ry = r.ry || 0;
      const out = size[2] / 2 + 1.2;
      stops.push(new THREE.Vector3(r.p[0] + Math.sin(ry) * out, 0, r.p[2] + Math.cos(ry) * out));
    }
    if (stops.length) stops.push(new THREE.Vector3(0, 0, 0));
    this.stops = stops;
    const stats = kingdomStats(records);
    this.population = stops.length > 1 ? Math.min(MAX_VILLAGERS, Math.floor(Math.min(stats.homes, stats.food || stats.homes) / 3)) : 0;
    for (let i = 0; i < this.villagers.length; i++) {
      const v = this.villagers[i];
      const on = i < this.population;
      if (on && !v.active) {
        v.from = this.stops[Math.floor(v.rnd() * this.stops.length)].clone();
        v.to = null;
        v.body.position.copy(v.from);
      }
      v.active = on;
      v.body.visible = on;
    }
  }

  update(dt, t, head) {
    if (!this.enabled) return;
    if (this._dirty) this._refresh();
    this._updateAdvisors(dt, t, head);
    this._updateVillagers(dt, t);
  }

  _updateAdvisors(dt, t, head) {
    if (!head) return;
    // Advisors keep their places unless the player turns well away, so glances do not make them shuffle.
    if (Math.abs(wrapAngle(head.yaw - this.bodyYaw)) > Math.PI / 3) this.bodyYaw = head.yaw;
    const hx = head.p[0];
    const hz = head.p[2];
    for (const a of this.advisors) {
      const ang = this.bodyYaw - (SLOTS[a.def.id] || 0) * Math.PI / 180;
      a.target.set(hx - Math.sin(ang) * ADVISOR_DIST, 0, hz - Math.cos(ang) * ADVISOR_DIST);
      const dx = a.target.x - a.pos.x;
      const dz = a.target.z - a.pos.z;
      const dist = Math.hypot(dx, dz);
      if (!a.placed || dist > 30) {
        a.pos.copy(a.target);
        a.placed = true;
      } else if (dist > 0.6) {
        const speed = dist > 8 ? 6 : 1.8;
        const step = Math.min(dist, speed * dt);
        a.pos.x += (dx / dist) * step;
        a.pos.z += (dz / dist) * step;
        a.walk += dt * speed * 3.2;
      }
      const moving = dist > 0.6;
      a.root.position.set(a.pos.x, moving ? Math.abs(Math.sin(a.walk)) * 0.05 : 0, a.pos.z);
      a.root.rotation.y = Math.atan2(hx - a.pos.x, hz - a.pos.z);
      a.talk = Math.max(0, a.talk - dt);
      a.body.rotation.x = a.talk > 0 ? Math.sin(t * 9) * 0.06 : 0;
      a.plate.material.emissive?.set(a.talk > 0 ? "#6b5520" : "#000000");
    }
  }

  _updateVillagers(dt, t) {
    if (this.stops.length < 2) return;
    for (const v of this.villagers) {
      if (!v.active) continue;
      if (v.wait > 0) {
        v.wait -= dt;
        v.body.position.y = 0;
        continue;
      }
      if (!v.to) {
        v.to = this.stops[Math.floor(v.rnd() * this.stops.length)].clone();
        v.to.x += (v.rnd() - 0.5) * 2;
        v.to.z += (v.rnd() - 0.5) * 2;
      }
      const p = v.body.position;
      const dx = v.to.x - p.x;
      const dz = v.to.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.2) {
        v.to = null;
        v.wait = 2 + v.rnd() * 5;
        continue;
      }
      const step = Math.min(dist, v.speed * dt);
      p.x += (dx / dist) * step;
      p.z += (dz / dist) * step;
      p.y = Math.abs(Math.sin(t * 7 * v.speed)) * 0.04;
      v.body.rotation.y = Math.atan2(dx, dz);
    }
  }

  dispose() {
    removeClearing(this.scene, "kingdom-plaza");
    this.root.removeFromParent();
  }
}
