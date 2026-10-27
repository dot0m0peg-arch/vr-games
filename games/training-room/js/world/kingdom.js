// Kingdom mode in the world: three advisors who walk beside the player, villagers who wander
// between the buildings, and a dirt square at the center. Everything here is local decoration:
// nothing is sent to the bridge, so every device can choose its own mode.
// Step 12 (LOOK-BIBLE.md section 11, Claude (Command), Oct 26 2026): the plaza is trodden dirt with a worn ring,
// a damp edge that fades into the grass and six cart ruts, in one mesh; the figures walk on a two-frame-per-step
// cycle instead of bobbing; the name plates are oak boards hung from a sign pole. Rules, slots, counts and speeds
// are unchanged.
import * as THREE from "../../vendor/three.module.min.js";
import { kit } from "../parts/build/kit.js";
import { figure, nameBoard, poseFigure, WALK } from "../parts/build/kingdom.js";
import { ADVISORS, WORTH, kingdomStats } from "../core/kingdom.js";
import { setClearing, removeClearing } from "./field.js";

const MAX_VILLAGERS = 10;
const PLAZA_RADIUS = 9;
const ADVISOR_DIST = 2.6;
// Slot angles (degrees) from the player's facing: builder left, steward right, marshal behind
// the steward. Wide enough that they never stand where the player points to build.
const SLOTS = { builder: -70, steward: 70, marshal: 115 };
const TUNICS = ["#8a6b3f", "#6d7f4a", "#7b5b8a", "#a4573c", "#4f6f86", "#9a8a5a"];
// How the advisors dress (section 11): the Master Builder in linen with a straw hat, the Lord Steward in a deep red
// wool robe under his crown, the Marshal in steel-blue with a helm. Their rules in js/core/kingdom.js are untouched.
const ADVISOR_LOOK = {
  builder: { tunic: "#9a6a3a", hat: "straw" },
  steward: { tunic: "#7a1f2b", hat: "crown", robe: true, wool: true },
  marshal: { tunic: "#4f6f86", hat: "helm" },
};

// The plaza: base dirt #8a6a45, the worn ring 6-8 m in #9c7d57, the damp edge in #6e5436 fading out over 9-9.8 m
// (section 4). Colours are per-vertex multipliers on the dirt family's detail map; alpha makes the soft grass edge.
export const PLAZA = {
  radius: PLAZA_RADIUS, edge: 9.8, segments: 48,
  rings: [1.5, 3, 4.5, 5.5, 6, 6.5, 7, 7.5, 8.2, 8.8, 9, 9.4, 9.8],
  tint: { base: [1, 1, 1], ring: [1.13, 1.18, 1.26], damp: [0.8, 0.79, 0.78] },
  // Cart ruts: six arcs on the worn ring, in pairs 1.2 m apart (a cart's two wheels), as [radius, from deg, to deg]
  // (x = cos, z = sin). Two pairs sit in the capture's view to the left and right of the yard, one behind the spawn.
  ruts: [[6.6, 196, 236], [7.8, 198, 234], [6.6, 300, 340], [7.8, 302, 338], [6.6, 70, 115], [7.8, 72, 112]],
  rutWidth: 0.14, rutTint: [0.66, 0.63, 0.6], rutLift: 0.003,
  // The grass: pressed flat inside the disc (strength 1) and bare of stubs inside 0.85 of it (so the dirt and the ring
  // show), a trampled band of stubs at the rim (strength 0.6 out to 10 m). [key, radius, strength, bare]
  clearings: [["kingdom-plaza", PLAZA_RADIUS, 1, 1], ["kingdom-plaza-rim", PLAZA_RADIUS + 1, 0.6, 0]],
};

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

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => c1.map((v, i) => lerp(v, c2[i], t));

// Colour multiplier and alpha of the plaza at radius r (metres from the centre).
export function plazaTint(r) {
  const { base, ring, damp } = PLAZA.tint;
  let c;
  if (r < 5.5) c = base;
  else if (r < 6) c = mix(base, ring, (r - 5.5) / 0.5);
  else if (r <= 7.5) c = ring;
  else if (r < 8.2) c = mix(ring, base, (r - 7.5) / 0.7);
  else if (r < 8.8) c = mix(base, damp, (r - 8.2) / 0.6);
  else c = damp;
  const a = r <= PLAZA.radius ? 1 : Math.max(0, 1 - (r - PLAZA.radius) / (PLAZA.edge - PLAZA.radius));
  return [c[0], c[1], c[2], a];
}

// One BufferGeometry in the XZ plane (y up): a fan of rings with per-vertex RGBA, plus the six rut strips lifted
// 3 mm so they draw over the disc. UVs are world metres, as every kit primitive's are, so the dirt tiles at 1.5 m.
export function plazaGeometry({ seed = 11 } = {}) {
  const rnd = rand(seed);
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const push = (x, y, z, c) => {
    pos.push(x, y, z); nor.push(0, 1, 0); uv.push(x, z); col.push(c[0], c[1], c[2], c[3]);
    return pos.length / 3 - 1;
  };
  const n = PLAZA.segments;
  const center = push(0, 0, 0, plazaTint(0));
  const ringStart = [];
  PLAZA.rings.forEach((r, ri) => {
    ringStart.push(pos.length / 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const t = plazaTint(r);
      const v = 1 + (rnd() - 0.5) * 0.08; // a little grain so the bands are not perfect circles
      push(Math.cos(a) * r, 0, Math.sin(a) * r, [t[0] * v, t[1] * v, t[2] * v, t[3]]);
    }
  });
  for (let i = 0; i < n; i++) idx.push(center, ringStart[0] + ((i + 1) % n), ringStart[0] + i);
  for (let ri = 0; ri + 1 < PLAZA.rings.length; ri++) {
    const a = ringStart[ri], b = ringStart[ri + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(a + i, b + j, b + i);
      idx.push(a + i, a + j, b + j);
    }
  }
  const ringTriangles = idx.length / 3;
  // Ruts: three columns across (edges faint, middle dark) and a sine fade along the arc.
  const across = [[-0.5, 0.25], [0, 1], [0.5, 0.25]];
  const along = 16;
  for (const [r, d0, d1] of PLAZA.ruts) {
    const rows = [];
    for (let k = 0; k <= along; k++) {
      const f = k / along;
      const a = lerp(d0, d1, f) * Math.PI / 180;
      const fade = Math.sin(f * Math.PI) * 0.85;
      const row = [];
      for (const [w, ka] of across) {
        const rr = r + w * PLAZA.rutWidth;
        const c = PLAZA.rutTint;
        row.push(push(Math.cos(a) * rr, PLAZA.rutLift, Math.sin(a) * rr, [c[0], c[1], c[2], fade * ka]));
      }
      rows.push(row);
    }
    for (let k = 0; k < along; k++) {
      for (let c = 0; c < 2; c++) {
        const a = rows[k][c], b = rows[k][c + 1], cc = rows[k + 1][c], d = rows[k + 1][c + 1];
        idx.push(a, d, b);
        idx.push(a, cc, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  g.userData.plaza = { rings: PLAZA.rings.length, ruts: PLAZA.ruts.length, triangles: idx.length / 3, ringTriangles, vertices: pos.length / 3 };
  return g;
}

// The plaza material: the dirt family's maps under the catalog hex, with the vertex tints and the alpha edge.
// A clone, so the shared cached material stays untouched; the maps are shared GPU uploads.
export function plazaMaterial() {
  const base = kit.mat("#8a6a45", "dirt");
  const m = base.clone();
  m.vertexColors = true;
  m.transparent = true;
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  m.userData = { ...base.userData, shared: true, plaza: true };
  return m;
}

function makeAdvisor(def) {
  const root = new THREE.Group();
  root.name = `advisor:${def.id}`;
  const look = ADVISOR_LOOK[def.id] || {};
  const body = figure({ tunic: look.tunic || def.tunic, hat: look.hat || def.hat, robe: !!look.robe, wool: !!look.wool, tint: false, animate: true });
  kit.mergeStatic(body);
  root.add(body);
  // The sign: an oak pole up the back, an arm over the head, the board on its chains at the old plate's height.
  // Merged into three draws (oak, iron, the lettered panel, which keeps its own material for the flash).
  const oak = kit.mat("#6b4a2e", "wood");
  const board = nameBoard(def.name);
  board.position.set(0, 2.05, 0);
  board.name = "name-board";
  const sign = kit.group([
    kit.cyl([0.02, 0.02, 1.5], oak, { p: [0, 1.55, -0.22], seg: 8 }),
    kit.box([0.03, 0.03, 0.44], oak, { p: [0, 2.31, 0.0] }),
    board,
  ]);
  sign.name = "sign";
  kit.mergeStatic(sign);
  root.add(sign);
  const plate = board.userData.board.panel;
  return { def, root, body, board, plate, pos: new THREE.Vector3(), target: new THREE.Vector3(), talk: 0, walk: 0, moving: false, placed: false, yaw: 0 };
}

// Turns yaw toward target by at most step radians (the short way round).
function turnToward(yaw, target, step) {
  const d = wrapAngle(target - yaw);
  return Math.abs(d) <= step ? target : yaw + Math.sign(d) * step;
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

    this.plaza = new THREE.Mesh(plazaGeometry(), plazaMaterial());
    this.plaza.position.y = 0.01;
    this.plaza.receiveShadow = true;
    this.plaza.castShadow = false;
    // Transparent (the alpha edge), so it joins three's sorted transparent pass; drawn first there (renderOrder -1) so
    // the aim ring, the lamp and fire ground glows and every other depthWrite:false overlay blend on top of it instead
    // of being painted over by its depth write.
    this.plaza.renderOrder = -1;
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
      const hatRoll = r();
      const body = figure({ tunic: TUNICS[i % TUNICS.length], hat: hatRoll < 0.4 ? "straw" : hatRoll < 0.65 ? "felt" : null, hair: r() < 0.5 ? "#4a3220" : "#a07a4a", tint: false, animate: true });
      kit.mergeStatic(body);
      body.visible = false;
      this.root.add(body);
      this.villagers.push({ body, rnd: r, from: null, to: null, wait: r() * 3, speed: 0.9 + r() * 0.5, walk: 0, active: false });
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
    for (const [key, radius, strength, bare] of PLAZA.clearings) {
      if (this.enabled) setClearing(this.scene, key, 0, 0, radius, strength, bare);
      else removeClearing(this.scene, key);
    }
    for (const a of this.advisors) a.placed = false;
    this._dirty = true;
  }

  setAim(point) {
    this.aim.visible = !!point;
    if (point) this.aim.position.set(point[0], 0.03, point[2]);
  }

  // An advisor answers: they nod and their name board lights up for a moment.
  speak(id) {
    const a = this.advisors.find((x) => x.def.id === id);
    if (a) a.talk = 2.5;
  }

  // What the skin did, for the capture report and the step check.
  lookInfo() {
    const plaza = this.plaza.geometry.userData.plaza;
    const m = this.plaza.material;
    const meshes = (o) => { let n = 0; o.traverse((x) => { if (x.isMesh) n++; }); return n; };
    return {
      plaza: { ...plaza, radius: PLAZA.radius, edge: PLAZA.edge, vertexColors: !!m.vertexColors, transparent: !!m.transparent,
        recipe: m.userData?.recipe || null, textured: !!(m.map && m.normalMap && m.roughnessMap), y: this.plaza.position.y },
      clearings: PLAZA.clearings.map(([key, radius, strength, bare]) => ({ key, radius, strength, bare })),
      advisors: this.advisors.map((a) => ({ id: a.def.id, hat: (ADVISOR_LOOK[a.def.id] || {}).hat || a.def.hat, rig: !!a.body.userData.rig,
        board: a.board.userData.board.size, meshes: meshes(a.root), walk: +a.walk.toFixed(3), moving: a.moving, y: +a.root.position.y.toFixed(4) })),
      villagers: { max: MAX_VILLAGERS, active: this.villagers.filter((v) => v.active).length, rigged: this.villagers.filter((v) => !!v.body.userData.rig).length,
        meshesEach: meshes(this.villagers[0].body) },
      walk: { ...WALK },
    };
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
        v.walk = 0;
        poseFigure(v.body, null);
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
      let dist = Math.hypot(dx, dz);
      // Facing: the player while standing, the way they are walking while they walk (no sideways slide), turning
      // at 8 rad/s; a fresh placement snaps to face the player.
      let faceYaw = Math.atan2(hx - a.pos.x, hz - a.pos.z);
      if (!a.placed || dist > 30) {
        a.pos.copy(a.target);
        a.placed = true;
        dist = 0; // placed, not walking: a standing pose on the first frame
        a.yaw = faceYaw = Math.atan2(hx - a.pos.x, hz - a.pos.z);
      } else if (dist > 0.6) {
        const speed = dist > 8 ? 6 : 1.8;
        const step = Math.min(dist, speed * dt);
        a.pos.x += (dx / dist) * step;
        a.pos.z += (dz / dist) * step;
        a.walk += step / WALK.stride;
        faceYaw = Math.atan2(dx, dz);
      }
      a.moving = dist > 0.6;
      a.yaw = turnToward(a.yaw, faceYaw, 8 * dt);
      const pose = poseFigure(a.body, a.moving ? a.walk : null);
      a.root.position.set(a.pos.x, pose?.dip ? -pose.dip : 0, a.pos.z);
      a.root.rotation.y = a.yaw;
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
        poseFigure(v.body, null);
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
      v.walk += step / WALK.stride;
      const pose = poseFigure(v.body, v.walk);
      p.y = pose?.dip ? -pose.dip : 0;
      v.body.rotation.y = Math.atan2(dx, dz);
    }
  }

  dispose() {
    for (const [key] of PLAZA.clearings) removeClearing(this.scene, key);
    this.root.removeFromParent();
  }
}
