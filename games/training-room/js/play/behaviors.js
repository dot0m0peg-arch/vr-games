// Play behaviors by kind of item, for everything in the room (built-in parts, the laptop catalog and
// AI mashups alike):
//   containers (meta.container): reach in and take a piece out, put it back, tip or throw the
//     container to spill its pieces ("box of popcorn", "bag of chips", "bucket of marbles");
//   floppy things (play/floppy.js): rubber chickens, plush toys, eels and fish dangle and flop;
//   guns (play/guns.js): the trigger fires.
// main.js wires it: interact hooks (take/drop), the trigger and click, typed and spoken commands
// (prepareCommand), fx from other players, recoil on the hand pose and update() every frame.
import * as THREE from "../../vendor/three.module.min.js";
import { Emitter } from "../util/emitter.js";
import { makeId } from "../util/ids.js";
import { fillOf, fillSlots, inCavity, capacity } from "../core/fill.js";
import { matchPart, singularize } from "../core/lexicon.js";
import { allMeta, getMeta } from "../parts/meta/index.js";
import { Floppy } from "./floppy.js";
import { Guns } from "./guns.js";
import { Sfx } from "./sfx.js";

const SPILL_TILT = 0.3; // container up·worldUp below this pours
const SPILL_RATE = 45; // pieces per second when upside down
const SPILL_FRAME = 3; // most pieces spilled per frame (each is a network op)
const FILL_SYNC = 0.15; // seconds between fill-count updates while pouring
const PENDING_FILL = 20000; // ms a typed "bag of marbles" waits for its bag to appear
const PIECE = 0.04; // meters: catalog things used as pieces are shrunk to about this
const DROP_MAX = 0.15; // meters: only things this small go back into a container

// Container words → container part, and snack words → piece part.
const CONTAINERS = [
  [/^(box|boxes|carton|cartons|crate|crates|case|cases|bin|bins|chest|chests|tin|tins)$/, "snack box"],
  [/^(bag|bags|sack|sacks|pouch|pouches|packet|packets)$/, "snack bag"],
  [/^(bucket|buckets|pail|pails|tub|tubs|barrel|barrels|jar|jars|can|cans|cup|cups|pot|pots|vase|vases|glass|glasses)$/, "snack bucket"],
  [/^(bowl|bowls|basket|baskets|dish|dishes|plate|plates|tray|trays|platter|platters|handful)$/, "snack bowl"],
];
const SNACKS = [
  [/^(popcorn|pop corn|popcorns|popped corn|kernels?)$/, "popcorn piece"],
  [/^(chips|crisps|potato chips|potato crisps|tortilla chips|chip)$/, "potato chip"],
  [/^(fries|french fries|fry|chips and fries|freedom fries)$/, "french fry"],
  [/^(candy|candies|sweets|lollies|treats|hard candy|hard candies|bonbons)$/, "candy"],
  [/^(gumballs?|gum balls?|gum|bubble gum)$/, "gumball"],
  [/^(jelly ?beans?|beans)$/, "jelly bean"],
];
const CONTAINER_WORDS = "box|boxes|carton|cartons|crate|crates|case|cases|bin|bins|chest|chests|tin|tins|bag|bags|sack|sacks|pouch|pouches|packet|packets|bucket|buckets|pail|pails|tub|tubs|barrel|barrels|jar|jars|can|cans|cup|cups|pot|pots|vase|vases|glass|glasses|bowl|bowls|basket|baskets|dish|dishes|plate|plates|tray|trays|platter|platters|handful";
const STOP = "in|on|at|next|near|by|to|for|here|there|over|under|behind|beside|please|and|then|with|onto|into|from|right|left|front|back|beneath|above|below|around|inside";
const CONTAINER_OF = new RegExp(`\\b(${CONTAINER_WORDS})\\s+(?:full\\s+)?of\\s+((?:(?!(?:${STOP})\\b)[a-z][a-z'-]*\\s*){1,3})`, "i");
// "a glass of water" is a drink, not a glass full of little water things.
const LIQUID = /^(water|milk|juice|soda|pop|coffee|tea|lemonade|beer|wine|soup|sauce|gravy|oil|paint|slime|lava|cocoa|hot chocolate|smoothie|punch|ice water|sand|dirt|mud|air|nothing)\b/;
const SPAWN_VERB = /\b(spawn|make|give|get|create|bring|summon|conjure|add|drop|put|place|want|need|have|grab me|hand me)\b/;

let phraseSet = null;
let phraseCount = -1;
function knownPhrase(phrase) {
  const metas = allMeta();
  if (!phraseSet || phraseCount !== metas.length) {
    phraseSet = new Set();
    for (const m of metas) for (const p of [m.name, ...(m.aliases || [])]) phraseSet.add(String(p).toLowerCase());
    phraseCount = metas.length;
  }
  return phraseSet.has(phrase);
}

// The piece part (and scale) for snack words or any catalog thing: "popcorn", "marbles", "frogs".
export function pieceFor(words, metas = allMeta()) {
  const text = String(words || "").trim().toLowerCase();
  for (const [re, part] of SNACKS) if (re.test(text)) return { part, s: 1 };
  const exact = getMeta(text) || getMeta(singularize(text));
  const match = exact ? { name: exact.name } : matchPart(text, metas);
  const meta = match && getMeta(match.name);
  if (!meta) return null;
  if (meta.piece) return { part: meta.name, s: 1 };
  const longest = Math.max(...(meta.size || [1, 1, 1]));
  const s = Math.max(0.02, Math.min(1, PIECE / Math.max(1e-3, longest)));
  if (longest * s > 0.15) return null;
  return { part: meta.name, s: Math.round(s * 1000) / 1000 };
}

// Rewrites "a bag of marbles" into a part the parser knows ("a snack bag") and says what goes in it.
// → { text, fill: { container, part, s, label } | null }
export function rewriteCommand(text, metas) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  const m = CONTAINER_OF.exec(lower);
  if (m) {
    const word = m[1];
    const filler = m[2].trim().replace(/^(some|the|a|an)\s+/, "");
    if (LIQUID.test(filler)) return { text: raw, fill: null };
    const phrase = `${word} of ${filler}`;
    const singularPhrase = `${singularize(word)} of ${filler}`;
    if (!knownPhrase(phrase) && !knownPhrase(singularPhrase) && !knownPhrase(`${word} full of ${filler}`)) {
      const piece = pieceFor(filler, metas);
      if (piece) {
        let container = CONTAINERS.find(([re]) => re.test(word))?.[1] || "snack box";
        if (piece.part === "popcorn piece" && container === "snack box") container = "popcorn box";
        const plural = singularize(word) !== word;
        const start = m.index;
        const end = start + m[0].trimEnd().length;
        const out = raw.slice(0, start) + container + (plural ? (/(x|ch|s)$/.test(container) ? "es" : "s") : "") + raw.slice(end);
        return { text: out, fill: { container, part: piece.part, s: piece.s, label: `${singularize(word)} of ${filler}`.slice(0, 80) } };
      }
    }
    return { text: raw, fill: null };
  }
  // "spawn popcorn": a box of it, not one kernel-shaped blob.
  if (SPAWN_VERB.test(lower) && /\bpopcorn\b/.test(lower) && !/\bpopcorn\s+(box|boxes|piece|pieces|kernel|kernels|bucket|bag|carton|tub|machine)\b/.test(lower) && !/\bof\s+popcorn\b/.test(lower)) {
    return { text: raw.replace(/\bpopcorn\b/i, "box of popcorn"), fill: null };
  }
  return { text: raw, fill: null };
}

export class Behaviors extends Emitter {
  // send(op): local apply + network; fx(payload): network fx; getHand(user, hand) → world pose;
  // isThrownByMe(id): this client threw it (owns its landing).
  constructor({ scene, room, objects, interact, send, fx, getUser, metaOf, getHand, phaser, isThrownByMe, head } = {}) {
    super();
    this.scene = scene;
    this.room = room;
    this.objects = objects;
    this.interact = interact;
    this.send = send;
    this.getUser = getUser || (() => "local");
    this.metaOf = metaOf || ((record) => getMeta(record.part) || {});
    this.isThrownByMe = isThrownByMe || (() => false);
    this.sfx = new Sfx();
    if (head) this.sfx.listener = head;
    this.floppy = new Floppy({ objects, getHand: getHand || (() => null) });
    this.guns = new Guns({ scene, objects, room, send, fx, getUser: this.getUser, metaOf: this.metaOf, interact, phaser, sfx: this.sfx, floppy: this.floppy });
    this.guns.onSpill = (id, dir, share) => this.spill(id, { share, push: dir });
    this.guns.on("haptic", (event) => this.emit("haptic", event));
    this.fx = fx || (() => {});
    this.pending = null;
    this.spilled = new Map(); // piece id → piece record data (to clear data.fly when it lands)
    this.flying = new Set(); // containers I threw that are in the air
    this.pour = new Map(); // container id → { acc, sent, n, timer }
    this._prev = new Map(); // container id → last world position (for pouring velocity)
    this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._offs = [];
    if (room?.on) this._offs.push(room.on("add", (record) => this._onAdd(record)));
    if (objects?.on) this._offs.push(objects.on("landed", (event) => this._onLanded(event)));
    if (interact?.on) this._offs.push(interact.on("grab", ({ id }) => this._onGrab(id)));
  }

  // Hooks for Interact.
  interactHooks() {
    return { take: (record, opts) => this.take(record, opts), drop: (record, opts) => this.drop(record, opts) };
  }

  // Typed or spoken command → text for the runner (and what to fill the next container with).
  prepareCommand(text) {
    const { text: out, fill } = rewriteCommand(text);
    if (fill) this.pending = { ...fill, until: Date.now() + PENDING_FILL };
    return out;
  }

  update(dt) {
    const me = this.getUser();
    for (const [id, entry] of this.objects.entries || []) {
      if (!entry.meta?.container) continue;
      const mine = entry.attach?.user === me || (entry.fly && this.isThrownByMe(id));
      if (entry.fly && this.isThrownByMe(id)) this.flying.add(id);
      if (!mine) {
        this._prev.delete(id);
        continue;
      }
      this._pourStep(entry, dt);
    }
    for (const [id, pour] of this.pour) {
      pour.timer -= dt;
      if (pour.timer <= 0 && pour.n !== pour.sent) this._syncFill(id, pour);
      if (pour.timer < -2) this.pour.delete(id);
    }
    this.floppy.update(dt);
    this.guns.update(dt);
  }

  // ---------- containers ----------

  _container(record) {
    const meta = record && this.metaOf(record);
    if (!meta?.container) return null;
    const pieceMeta = this.metaOf({ part: (record.data?.fill?.part) || meta.container.fill });
    const pieceSize = Math.max(...(pieceMeta?.size || [0.03, 0.03, 0.03]));
    const fill = fillOf(meta, record, pieceSize);
    const pour = this.pour.get(record.id);
    if (pour) fill.n = Math.min(fill.n, pour.n);
    return { meta, c: meta.container, fill, pieceSize, pieceMeta };
  }

  // Part-local point (unscaled, origin bottom-center) of a world point.
  _local(id, world, out) {
    const entry = this.objects.entries?.get(id);
    if (!entry) return null;
    entry.inner.updateWorldMatrix(true, false);
    return entry.inner.worldToLocal(out.copy(world));
  }

  unlockAudio() {
    this.sfx.unlock();
  }

  // Interact hook: grabbing a container with the hand in (or aimed into) its opening takes a piece.
  take(record, { hand, point, raycaster, distance } = {}) {
    const info = this._container(record);
    if (!info || info.fill.n <= 0) return null;
    let inside = false;
    if (!distance && point) {
      const local = this._local(record.id, point, this._v);
      inside = !!local && inCavity(info.c, local.toArray(), 0.03);
    } else if (raycaster?.ray) {
      const entry = this.objects.entries?.get(record.id);
      const hits = entry ? raycaster.intersectObject(entry.inner, true) : [];
      const local = hits[0] && this._local(record.id, hits[0].point, this._v);
      inside = !!local && inCavity(info.c, local.toArray(), 0.004);
    }
    if (!inside) return null;
    return this._takePiece(record, info, hand);
  }

  _slotWorld(record, info, index, out) {
    const entry = this.objects.entries?.get(record.id);
    const slots = fillSlots(info.c, info.pieceSize * info.fill.s, info.fill.n, entry?.inner?.userData?.fillSeed ?? 1);
    const slot = slots[Math.max(0, Math.min(slots.length - 1, index ?? slots.length - 1))] || [0, info.c.rim, 0];
    out.set(slot[0], slot[1], slot[2]);
    if (entry) {
      entry.inner.updateWorldMatrix(true, false);
      entry.inner.localToWorld(out);
    }
    return out;
  }

  _pieceRecord(container, info, at, extra = {}) {
    const s = Math.max(0.02, Math.round(info.fill.s * (container.s || 1) * 1000) / 1000);
    const height = (info.pieceMeta?.size?.[1] || 0.03) * s;
    const record = {
      id: makeId("o"),
      part: info.fill.part,
      label: info.pieceMeta?.name || info.fill.part,
      p: [r3(at.x), r3(Math.max(0, at.y - height / 2)), r3(at.z)],
      ry: r3(Math.random() * Math.PI * 2),
      s,
      data: { spawn: "instant", ...extra },
      by: this.getUser(),
      t: Date.now(),
    };
    if (info.fill.color) record.color = info.fill.color;
    return record;
  }

  _takePiece(container, info, hand) {
    const at = this._slotWorld(container, info, null, this._v2);
    const piece = this._pieceRecord(container, info, at);
    this.send({ t: "add", obj: piece });
    this._setFill(container, info.fill.n - 1);
    this.sfx.pops(at, 1);
    return this.room.get(piece.id) || null;
  }

  _setFill(container, n) {
    const record = this.room.get(container.id);
    if (!record) return;
    const info = this._container(record);
    if (!info) return;
    const fill = { part: info.fill.part, n: Math.max(0, Math.min(info.fill.cap, n)) };
    if (info.fill.s !== 1) fill.s = info.fill.s;
    const old = record.data?.fill;
    if (old?.color) fill.color = old.color;
    this.pour.delete(container.id);
    this.send({ t: "set", id: container.id, patch: { data: { ...(record.data || {}), fill } } });
  }

  // Interact hook: a small thing released gently inside a container goes in (same kind of piece,
  // or anything small into an empty one).
  drop(record, { p } = {}) {
    const meta = this.metaOf(record);
    if (!record || meta.container || !p) return false;
    const size = Array.isArray(meta.size) ? meta.size : [1, 1, 1];
    if (Math.max(...size) * (record.s || 1) > DROP_MAX) return false;
    for (const other of this.room.records()) {
      if (other.id === record.id) continue;
      const info = this._container(other);
      if (!info) continue;
      const local = this._local(other.id, p, this._v);
      if (!local || !inCavity(info.c, local.toArray(), 0.03)) continue;
      const same = info.fill.part === record.part;
      if (!same && info.fill.n > 0) continue;
      const s = Math.round(((record.s || 1) / (other.s || 1)) * 1000) / 1000;
      const cap = capacity(info.c, Math.max(...(size)) * s);
      const n = same ? info.fill.n : 0;
      if (n >= cap) continue;
      this.send({ t: "del", ids: [record.id] });
      const fill = { part: record.part, n: n + 1 };
      if (!same && s !== 1) fill.s = s;
      else if (same && info.fill.s !== 1) fill.s = info.fill.s;
      if (record.color) fill.color = record.color;
      this.pour.delete(other.id);
      this.send({ t: "set", id: other.id, patch: { data: { ...(other.data || {}), fill } } });
      this.sfx.pops(p, 1);
      return true;
    }
    return false;
  }

  // Spill a share (0..1) of a container's pieces at once (shot, thrown into the ground).
  spill(id, { share = 0.4, push = null } = {}) {
    const record = this.room.get(id);
    const info = record && this._container(record);
    if (!info || info.fill.n <= 0) return 0;
    const count = Math.max(1, Math.min(info.fill.n, Math.round(info.fill.n * share), 24));
    const entry = this.objects.entries?.get(id);
    const up = this._v.set(0, 1, 0);
    if (entry) up.applyQuaternion(entry.inner.getWorldQuaternion(this._q));
    for (let i = 0; i < count; i++) {
      const vel = up.clone().multiplyScalar(2 + Math.random() * 2);
      if (push) vel.addScaledVector(push, 1.5);
      vel.add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 1.5, (Math.random() - 0.5) * 3));
      this._spillOne(record, info, info.fill.n - 1 - i, vel);
    }
    this._setFill(record, info.fill.n - count);
    this.sfx.pops(entry?.wrapper?.position, count);
    return count;
  }

  _spillOne(container, info, index, vel) {
    const at = this._slotWorld(container, info, index, new THREE.Vector3());
    const fly = { vel: [r2(vel.x), r2(vel.y), r2(vel.z)], spin: r2((Math.random() - 0.5) * 20) };
    const piece = this._pieceRecord(container, info, at, { fly });
    this.spilled.set(piece.id, true);
    this.send({ t: "add", obj: piece });
  }

  // Pouring: a tipped container I hold or threw drops pieces out of its mouth.
  _pourStep(entry, dt) {
    const id = entry.id;
    const record = this.room.get(id);
    const info = record && this._container(record);
    const pos = entry.wrapper.getWorldPosition(this._v2);
    const prev = this._prev.get(id);
    const vel = prev && dt > 0 ? pos.clone().sub(prev).divideScalar(dt) : new THREE.Vector3();
    if (vel.length() > 15) vel.setLength(15);
    this._prev.set(id, pos.clone());
    if (!info || info.fill.n <= 0) return;
    const up = this._v.set(0, 1, 0).applyQuaternion(entry.inner.getWorldQuaternion(this._q));
    if (up.y >= SPILL_TILT) return;
    let pour = this.pour.get(id);
    if (!pour) {
      pour = { acc: 0, n: info.fill.n, sent: info.fill.n, timer: FILL_SYNC };
      this.pour.set(id, pour);
    }
    pour.acc += dt * SPILL_RATE * Math.min(1, (SPILL_TILT - up.y) / 1.1);
    let count = Math.min(SPILL_FRAME, Math.floor(pour.acc), pour.n);
    pour.acc -= Math.floor(pour.acc);
    while (count-- > 0) {
      const v = up.clone().multiplyScalar(0.6).add(vel).add(new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.8));
      this._spillOne(record, { ...info, fill: { ...info.fill, n: pour.n } }, pour.n - 1, v);
      pour.n--;
      pour.timer = Math.min(pour.timer, FILL_SYNC);
    }
    if (Math.random() < 0.3) this.sfx.pops(pos, 2);
  }

  _syncFill(id, pour) {
    const record = this.room.get(id);
    pour.timer = FILL_SYNC;
    if (!record) return;
    const info = this._container({ ...record, data: { ...(record.data || {}), fill: { ...(record.data?.fill || {}), n: undefined } } });
    const fill = { part: info.fill.part, n: pour.n };
    if (info.fill.s !== 1) fill.s = info.fill.s;
    if (record.data?.fill?.color) fill.color = record.data.fill.color;
    pour.sent = pour.n;
    this.send({ t: "set", id, patch: { data: { ...(record.data || {}), fill } } });
  }

  _onAdd(record) {
    if (!record || record.by !== this.getUser()) return;
    const pending = this.pending;
    if (!pending || Date.now() > pending.until || record.part !== pending.container || record.data?.fill) return;
    const meta = this.metaOf(record);
    if (!meta.container) return;
    const fill = { part: pending.part };
    if (pending.s !== 1) fill.s = pending.s;
    const patch = { data: { ...(record.data || {}), fill } };
    if (pending.label) patch.label = pending.label;
    // After the runner's own add has gone out.
    queueMicrotask(() => {
      if (this.room.get(record.id)) this.send({ t: "set", id: record.id, patch });
    });
  }

  _onLanded({ id, p, ry }) {
    if (this.spilled.delete(id)) {
      const record = this.room.get(id);
      if (record) {
        const data = { ...(record.data || {}) };
        delete data.fly;
        this.send({ t: "set", id, patch: { p, ry, data } });
      }
      return;
    }
    const record = this.room.get(id);
    const meta = record && this.metaOf(record);
    if (meta?.squeak) this.sfx.squeak(this._v.fromArray(p), false);
    if (this.flying.delete(id) && meta?.container) this.spill(id, { share: 0.3 });
  }

  _onGrab(id) {
    const record = this.room.get(id);
    if (record && this.metaOf(record).squeak) this.sfx.squeak(this.objects.worldPose?.(id)?.p, false);
  }

  // ---------- input ----------

  // VR trigger. aim() → THREE.Ray. → true when the trigger was used here (gun or squeaky toy).
  trigger(hand, pressed, aim) {
    if (this.guns.trigger(hand, pressed, aim)) return true;
    if (!pressed) return false;
    const id = this.interact?.held(hand);
    const record = id && this.room.get(id);
    const meta = record && this.metaOf(record);
    if (meta?.squeak) {
      this.sfx.squeak(this.objects.worldPose?.(id)?.p, true);
      this.fx({ kind: "squeak", id });
      this.emit("haptic", { hand, intensity: 0.5, ms: 200 });
      return true;
    }
    return false;
  }

  // Desktop left click. → true when handled (otherwise the hand swings as before).
  click(hand, aim) {
    if (this.guns.click(hand, aim)) return true;
    const id = this.interact?.held(hand);
    const record = id && this.room.get(id);
    const meta = record && this.metaOf(record);
    if (meta?.squeak) {
      this.sfx.squeak(this.objects.worldPose?.(id)?.p, true);
      this.fx({ kind: "squeak", id });
      this.floppy.poke(id, this.objects.worldPose?.(id)?.p || this._v.set(0, 1, 0), this._v2.set(0, 1, 0), 2);
      return false; // and swing it
    }
    if (meta?.container) {
      // A flick of the wrist tosses a few out in front.
      this.spill(id, { share: 0.15 });
      return false;
    }
    return false;
  }

  applyRecoil(hand, pose) {
    return this.guns.applyRecoil(hand, pose);
  }

  onFx(fx) {
    if (fx?.kind === "shot") this.guns.onFx(fx);
    else if (fx?.kind === "squeak" && this.objects.entries?.get(fx.id)) this.sfx.squeak(this.objects.worldPose?.(fx.id)?.p, true);
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs = [];
  }
}

const r3 = (n) => Math.round(n * 1000) / 1000;
const r2 = (n) => Math.round(n * 100) / 100;
