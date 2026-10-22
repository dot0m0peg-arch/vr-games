// Remote players: a tinted head with a dark visor and lime rim, two hand proxies (or a floating
// laptop/phone icon for players without tracked hands), a name tag and a mic glyph while talking.
// Poses arrive at ~15 Hz; update() eases toward the latest one so motion looks continuous.
import * as THREE from "../../vendor/three.module.min.js";
import { makeCanvas, roundRect, canvasTexture, FONT } from "../util/text.js";

const SMOOTH = 0.1; // seconds (time constant of the easing toward the latest pose)
const SNAP_DIST = 4; // meters: teleports jump instead of sliding
const TAG_W = 512;
const TAG_H = 128;
const TAG_SIZE = [0.46, 0.115];
const COLORS = { bg: "#101412", text: "#eef1e9", muted: "#a7b0a4", accent: "#d5fb6a", line: "#596057", panel: "#19271b" };
const DEVICE_LABEL = { headset: "headset", laptop: "laptop", desktop: "laptop", phone: "phone" };

// Box with rounded edges: vertices of a subdivided box pushed onto spheres around an inner box,
// with matching smooth normals.
function roundedBox(w, h, d, r, seg = 3) {
  const geometry = new THREE.BoxGeometry(w, h, d, seg * 2, seg * 2, seg * 2);
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const hx = w / 2 - r;
  const hy = h / 2 - r;
  const hz = d / 2 - r;
  const v = new THREE.Vector3();
  const inner = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    inner.set(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
    v.sub(inner);
    if (v.lengthSq() < 1e-12) v.fromBufferAttribute(nor, i);
    v.normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
    v.multiplyScalar(r).add(inner);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  geometry.computeBoundingSphere();
  return geometry;
}

let shared = null;
function resources() {
  if (shared) return shared;
  const lime = new THREE.MeshBasicMaterial({ color: COLORS.accent });
  const dark = new THREE.MeshStandardMaterial({ color: "#0b0f0d", roughness: 0.25, metalness: 0.6 });
  const panel = new THREE.MeshStandardMaterial({ color: COLORS.panel, roughness: 0.6, metalness: 0.2 });
  const shadow = new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.22, depthWrite: false });
  const shadowGeo = new THREE.CircleGeometry(0.28, 20);
  shadowGeo.rotateX(-Math.PI / 2);
  shared = {
    lime,
    dark,
    panel,
    shadow,
    head: roundedBox(0.2, 0.22, 0.24, 0.06, 3),
    visor: roundedBox(0.17, 0.075, 0.03, 0.012, 1),
    rim: roundedBox(0.186, 0.091, 0.022, 0.016, 1),
    hand: roundedBox(0.075, 0.035, 0.1, 0.015, 2),
    knuckle: new THREE.SphereGeometry(0.012, 8, 6),
    shadowGeo,
    laptopBase: new THREE.BoxGeometry(0.3, 0.014, 0.2),
    laptopLid: new THREE.BoxGeometry(0.3, 0.2, 0.01),
    phoneBody: new THREE.BoxGeometry(0.075, 0.15, 0.01),
    screenSmall: new THREE.PlaneGeometry(0.063, 0.13),
    screenLarge: new THREE.PlaneGeometry(0.27, 0.17),
    logo: new THREE.PlaneGeometry(0.05, 0.05),
    lens: new THREE.PlaneGeometry(0.016, 0.016),
  };
  return shared;
}

function mesh(geometry, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  return m;
}

function deviceIcon(kind, res) {
  const g = new THREE.Group();
  g.name = `device-${kind}`;
  if (kind === "phone") {
    g.add(mesh(res.phoneBody, res.panel));
    g.add(mesh(res.screenSmall, res.lime, 0, 0, 0.0055));
    const lens = mesh(res.lens, res.lime, -0.018, 0.055, -0.0055); // back camera, seen by others
    lens.rotation.y = Math.PI;
    g.add(lens);
  } else {
    g.add(mesh(res.laptopBase, res.panel, 0, 0, 0));
    const lid = new THREE.Group();
    lid.position.set(0, 0.007, -0.1);
    lid.rotation.x = -0.25; // opened ~105°
    lid.add(mesh(res.laptopLid, res.panel, 0, 0.1, 0));
    lid.add(mesh(res.screenLarge, res.lime, 0, 0.1, 0.0055));
    const logo = mesh(res.logo, res.lime, 0, 0.1, -0.0055); // lid back, seen by others
    logo.rotation.y = Math.PI;
    lid.add(logo);
    g.add(lid);
  }
  return g;
}

function hasVec(v, n) {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

const tmpEuler = new THREE.Euler(0, 0, 0, "YXZ");
const tmpQuat = new THREE.Quaternion();
const SIDES = ["left", "right"];

export class Avatars {
  // localUser: () => id of this device's user (never drawn).
  constructor({ scene, localUser = () => null }) {
    this.scene = scene;
    this.localUser = localUser;
    this.root = new THREE.Group();
    this.root.name = "avatars";
    scene?.add(this.root);
    this._entries = new Map(); // id → entry
    this._poses = new Map(); // id → latest pose (kept for users not drawn yet)
    this._users = [];
  }

  setUsers(users = []) {
    this._users = Array.isArray(users) ? users : [];
    const me = this.localUser?.();
    const keep = new Set();
    for (const user of this._users) {
      if (!user?.id || user.id === me || user.online === false) continue;
      keep.add(user.id);
      const entry = this._entries.get(user.id) || this._create(user);
      this._applyUser(entry, user);
    }
    for (const id of [...this._entries.keys()]) if (!keep.has(id)) this._remove(id);
    for (const id of [...this._poses.keys()]) if (!this._users.some((u) => u.id === id)) this._poses.delete(id);
  }

  // poses: { id: { p, q?, yaw, pitch?, hands: { left: { p, q } | null, right }, talking?, device? } }
  setPoses(poses = {}) {
    for (const [id, pose] of Object.entries(poses || {})) {
      if (!pose || !hasVec(pose.p, 3)) continue;
      this._poses.set(id, pose);
      const entry = this._entries.get(id);
      if (entry) this._target(entry, pose);
    }
  }

  update(dt = 0) {
    const k = dt > 0 ? 1 - Math.exp(-dt / SMOOTH) : 1;
    for (const entry of this._entries.values()) {
      const { target: t, cur: c } = entry;
      if (!t.has) {
        entry.group.visible = false;
        continue;
      }
      entry.group.visible = true;
      const snap = !c.has || c.p.distanceToSquared(t.p) > SNAP_DIST * SNAP_DIST;
      if (snap) {
        c.p.copy(t.p);
        c.q.copy(t.q);
        c.yaw = t.yaw;
      } else {
        c.p.lerp(t.p, k);
        c.q.slerp(t.q, k);
        c.yaw += Math.atan2(Math.sin(t.yaw - c.yaw), Math.cos(t.yaw - c.yaw)) * k;
      }
      c.has = true;
      entry.head.position.copy(c.p);
      entry.head.quaternion.copy(c.q);
      entry.tag.position.set(c.p.x, c.p.y + 0.24, c.p.z);
      entry.shadow.position.set(c.p.x, 0.012, c.p.z);
      let anyHand = false;
      for (const side of SIDES) {
        const th = t.hands[side];
        const ch = c.hands[side];
        const node = entry.hands[side];
        if (!th.on) {
          node.visible = false;
          ch.on = false;
          continue;
        }
        anyHand = true;
        if (!ch.on || snap || ch.p.distanceToSquared(th.p) > SNAP_DIST * SNAP_DIST) {
          ch.p.copy(th.p);
          ch.q.copy(th.q);
        } else {
          ch.p.lerp(th.p, k);
          ch.q.slerp(th.q, k);
        }
        ch.on = true;
        node.visible = true;
        node.position.copy(ch.p);
        node.quaternion.copy(ch.q);
      }
      // Laptop/phone players without hands: a small floating device in front of their chest.
      const icon = entry.device;
      if (icon) {
        icon.visible = !anyHand;
        if (!anyHand) {
          const fx = -Math.sin(c.yaw);
          const fz = -Math.cos(c.yaw);
          entry.bob = (entry.bob + dt * 1.6) % (Math.PI * 2);
          icon.position.set(c.p.x + fx * 0.32, c.p.y - 0.38 + Math.sin(entry.bob) * 0.015, c.p.z + fz * 0.32);
          icon.rotation.set(entry.deviceKind === "phone" ? -0.5 : 0, c.yaw, 0, "YXZ");
        }
      }
    }
  }

  // Smoothed (drawn) pose of a remote hand → out ({ p: Vector3, q: Quaternion }) or null.
  handPose(user, hand, out = { p: new THREE.Vector3(), q: new THREE.Quaternion() }) {
    const entry = this._entries.get(user);
    if (!entry) return null;
    const h = entry.cur.has && entry.cur.hands[hand]?.on ? entry.cur.hands[hand] : entry.target.hands[hand];
    if (!h?.on) return null;
    out.p.copy(h.p);
    out.q.copy(h.q);
    return out;
  }

  // Smoothed head pose → { p: [x, y, z], yaw, q: [x, y, z, w] } or null.
  headPose(user, out = null) {
    const entry = this._entries.get(user);
    if (!entry || !entry.target.has) return null;
    const src = entry.cur.has ? entry.cur : entry.target;
    const result = out || { p: [0, 0, 0], yaw: 0, q: [0, 0, 0, 1] };
    src.p.toArray(result.p);
    src.q.toArray(result.q);
    result.yaw = src.yaw;
    return result;
  }

  get count() {
    return this._entries.size;
  }

  dispose() {
    for (const id of [...this._entries.keys()]) this._remove(id);
    this.root.removeFromParent();
    this._poses.clear();
  }

  // ---------- internals ----------

  _create(user) {
    const res = resources();
    const material = new THREE.MeshStandardMaterial({ color: user.color || COLORS.accent, roughness: 0.55, metalness: 0.05 });
    const group = new THREE.Group();
    group.name = `avatar:${user.id}`;
    group.visible = false;

    const head = new THREE.Group();
    head.add(mesh(res.head, material));
    head.add(mesh(res.rim, res.lime, 0, 0.015, -0.112));
    head.add(mesh(res.visor, res.dark, 0, 0.015, -0.12));
    group.add(head);

    const hands = {};
    for (const side of SIDES) {
      const node = new THREE.Group();
      node.add(mesh(res.hand, material));
      node.add(mesh(res.knuckle, res.lime, 0, 0.012, -0.05));
      node.visible = false;
      group.add(node);
      hands[side] = node;
    }

    const shadow = mesh(res.shadowGeo, res.shadow);
    shadow.renderOrder = -1;
    group.add(shadow);

    const canvas = makeCanvas(TAG_W, TAG_H);
    const texture = canvasTexture(canvas);
    const tagMaterial = new THREE.SpriteMaterial({ map: texture, color: texture ? "#ffffff" : COLORS.bg, transparent: true, depthWrite: false });
    const tag = new THREE.Sprite(tagMaterial);
    tag.scale.set(TAG_SIZE[0], TAG_SIZE[1], 1);
    group.add(tag);

    const blank = () => ({ p: new THREE.Vector3(), q: new THREE.Quaternion(), on: false });
    const entry = {
      id: user.id,
      user,
      group,
      head,
      hands,
      shadow,
      tag,
      canvas,
      texture,
      material,
      tagMaterial,
      device: null,
      deviceKind: null,
      tagKey: "",
      talking: false,
      bob: Math.random() * Math.PI * 2,
      target: { has: false, p: new THREE.Vector3(), q: new THREE.Quaternion(), yaw: 0, hands: { left: blank(), right: blank() } },
      cur: { has: false, p: new THREE.Vector3(), q: new THREE.Quaternion(), yaw: 0, hands: { left: blank(), right: blank() } },
    };
    this.root.add(group);
    this._entries.set(user.id, entry);
    const pose = this._poses.get(user.id);
    if (pose) this._target(entry, pose);
    return entry;
  }

  _applyUser(entry, user) {
    entry.user = { ...entry.user, ...user };
    if (user.color) entry.material.color.set(user.color);
    const kind = DEVICE_LABEL[entry.pose?.device || user.device] || "headset";
    const iconKind = kind === "headset" ? null : kind;
    if (iconKind !== entry.deviceKind) {
      if (entry.device) entry.group.remove(entry.device);
      entry.device = iconKind ? deviceIcon(iconKind, resources()) : null;
      entry.deviceKind = iconKind;
      if (entry.device) {
        entry.device.visible = false;
        entry.group.add(entry.device);
      }
    }
    this._drawTag(entry);
  }

  _target(entry, pose) {
    const t = entry.target;
    entry.pose = pose;
    t.p.fromArray(pose.p);
    t.yaw = typeof pose.yaw === "number" && Number.isFinite(pose.yaw) ? pose.yaw : 0;
    if (hasVec(pose.q, 4)) {
      t.q.fromArray(pose.q).normalize();
    } else {
      const pitch = typeof pose.pitch === "number" && Number.isFinite(pose.pitch) ? pose.pitch : 0;
      tmpEuler.set(pitch, t.yaw, 0, "YXZ");
      t.q.setFromEuler(tmpEuler);
    }
    for (const side of SIDES) {
      const src = pose.hands?.[side];
      const dst = t.hands[side];
      if (src && hasVec(src.p, 3)) {
        dst.p.fromArray(src.p);
        if (hasVec(src.q, 4)) dst.q.fromArray(src.q).normalize();
        else dst.q.copy(tmpQuat.setFromEuler(tmpEuler.set(0, t.yaw, 0, "YXZ")));
        dst.on = true;
      } else {
        dst.on = false;
      }
    }
    t.has = true;
    const talking = !!pose.talking;
    const device = pose.device && pose.device !== entry.user.device ? pose.device : null;
    if (talking !== entry.talking || device) {
      entry.talking = talking;
      if (device) this._applyUser(entry, { ...entry.user, device });
      else this._drawTag(entry);
    }
  }

  _drawTag(entry) {
    const name = String(entry.user.name || "Player").slice(0, 24);
    const device = DEVICE_LABEL[entry.user.device] || "headset";
    const key = `${name}|${device}|${entry.talking ? 1 : 0}|${entry.user.color || ""}`;
    if (key === entry.tagKey) return;
    entry.tagKey = key;
    const canvas = entry.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, TAG_W, TAG_H);
    ctx.globalAlpha = 0.86;
    ctx.fillStyle = COLORS.bg;
    roundRect(ctx, 4, 4, TAG_W - 8, TAG_H - 8, 28);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 4;
    ctx.strokeStyle = entry.talking ? COLORS.accent : COLORS.line;
    roundRect(ctx, 4, 4, TAG_W - 8, TAG_H - 8, 28);
    ctx.stroke();
    // color dot
    ctx.fillStyle = entry.user.color || COLORS.accent;
    ctx.beginPath();
    ctx.arc(46, TAG_H / 2, 16, 0, Math.PI * 2);
    ctx.fill();
    const textRight = entry.talking ? TAG_W - 110 : TAG_W - 32;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    ctx.fillStyle = COLORS.text;
    ctx.font = `700 44px ${FONT}`;
    ctx.fillText(name, 80, 62, textRight - 80);
    ctx.fillStyle = COLORS.muted;
    ctx.font = `400 32px ${FONT}`;
    ctx.fillText(device, 80, 104, textRight - 80);
    if (entry.talking) drawMic(ctx, TAG_W - 70, TAG_H / 2, COLORS.accent);
    if (entry.texture) entry.texture.needsUpdate = true;
  }

  _remove(id) {
    const entry = this._entries.get(id);
    if (!entry) return;
    this._entries.delete(id);
    entry.group.removeFromParent();
    entry.material.dispose();
    entry.tagMaterial.dispose();
    entry.texture?.dispose();
  }
}

// Microphone glyph: capsule head, cradle arc and stand.
function drawMic(ctx, cx, cy, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  roundRect(ctx, cx - 13, cy - 38, 26, 48, 13);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy - 6, 24, 0.1 * Math.PI, 0.9 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy + 18);
  ctx.lineTo(cx, cy + 34);
  ctx.moveTo(cx - 14, cy + 36);
  ctx.lineTo(cx + 14, cy + 36);
  ctx.stroke();
  ctx.restore();
}

export { roundedBox };
