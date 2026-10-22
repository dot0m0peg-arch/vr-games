// Shared room for the laptop bridge: users and presence, ops with sequence numbers, poses at 15 Hz,
// server-sent events with per-client queues, shared screen/camera frames, and room.json persistence.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Emitter } from "../js/util/emitter.js";
import { makeId } from "../js/util/ids.js";
import { createState, applyOp, validateOp, snapshot, loadState } from "../js/core/room-state.js";

export const PALETTE = ["#d5fb6a", "#6ad5fb", "#fb8f6a", "#c48bfb", "#fbd66a", "#6afba8", "#fb6aa5", "#f4f1ea"];
export const DEVICES = ["headset", "laptop", "phone", "desktop"];
const DEFAULT_NAMES = { headset: "Headset", laptop: "Laptop", phone: "Phone", desktop: "Laptop" };
const RING_SIZE = 1000; // ops kept for SSE replay (Last-Event-ID / since)
const QUEUE_LIMIT = 600; // queued SSE messages before a slow client is disconnected
const MAX_STREAMS = 16;

export class BridgeError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

// validateOp may return true/false, { ok, error }, an error string or throw; normalize all of them.
export function checkOp(op) {
  if (!op || typeof op !== "object" || Array.isArray(op)) return { ok: false, error: "op must be an object" };
  let result;
  try {
    result = validateOp(op);
  } catch (err) {
    return { ok: false, error: err?.message || "invalid op" };
  }
  if (result === true || result === undefined || result === null) return { ok: true };
  if (result === false) return { ok: false, error: "invalid op" };
  if (typeof result === "string") return { ok: false, error: result };
  if (typeof result === "object") {
    const ok = "ok" in result ? !!result.ok : "valid" in result ? !!result.valid : !result.error;
    return { ok, error: ok ? undefined : String(result.error || result.reason || "invalid op") };
  }
  return { ok: !!result };
}

const finite = (n) => typeof n === "number" && Number.isFinite(n);
const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(finite);
const clean = (text, max) => String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

function cleanHand(hand) {
  if (!hand || typeof hand !== "object" || !vec(hand.p, 3)) return null;
  const out = { p: hand.p };
  if (vec(hand.q, 4)) out.q = hand.q;
  return out;
}

// Keeps a pose small and well formed; extra primitive fields (talking, device, …) pass through.
export function cleanPose(pose) {
  if (!pose || typeof pose !== "object" || !vec(pose.p, 3)) return null;
  const out = {};
  for (const [key, value] of Object.entries(pose)) {
    if (key === "p" || key === "hands" || key === "user") continue;
    if (typeof value === "boolean" || finite(value) || (typeof value === "string" && value.length <= 64)) out[key] = value;
  }
  out.p = pose.p;
  out.yaw = finite(pose.yaw) ? pose.yaw : 0;
  out.hands = { left: cleanHand(pose.hands?.left), right: cleanHand(pose.hands?.right) };
  return out;
}

function rotate(q, v) {
  // v' = q * v * q^-1 for a unit quaternion [x, y, z, w].
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

export class RoomStore extends Emitter {
  constructor({ dataDir, saveDelay = 1000, dropAfter = 20000, poseHz = 15, heartbeatMs = 15000, sweepMs = 2000, log = console } = {}) {
    super();
    this.dataDir = dataDir;
    this.file = dataDir ? path.join(dataDir, "room.json") : null;
    this.saveDelay = saveDelay;
    this.dropAfter = dropAfter;
    this.poseHz = poseHz;
    this.heartbeatMs = heartbeatMs;
    this.sweepMs = sweepMs;
    this.log = log;
    this.state = createState();
    this.seq = 0;
    this.ring = [];
    this.users = new Map();
    this.poses = new Map();
    this.posesDirty = false;
    this.clients = new Set();
    this.frames = new Map();
    this.dirty = false;
    this.saveTimer = null;
    this.saving = null;
    this.timers = [];
    this.stopped = false;
  }

  // ---------- persistence ----------
  load() {
    if (!this.file || !fs.existsSync(this.file)) return false;
    try {
      const json = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.state = loadState(json.state ?? json);
      this.seq = Number.isInteger(json.seq) && json.seq >= 0 ? json.seq : 0;
      return true;
    } catch (err) {
      const aside = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, aside);
      } catch {
        // Leave it in place; it is overwritten on the next save.
      }
      this.log.warn?.(`[room] room.json could not be read (${err.message}); starting an empty room. Old file: ${aside}`);
      this.state = createState();
      this.seq = 0;
      return false;
    }
  }

  serialize() {
    return JSON.stringify({ version: 1, seq: this.seq, savedAt: new Date().toISOString(), state: snapshot(this.state) });
  }

  scheduleSave() {
    this.dirty = true;
    if (!this.file || this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((err) => this.log.warn?.(`[room] save failed: ${err.message}`));
    }, this.saveDelay);
    this.saveTimer.unref?.();
  }

  async save() {
    if (!this.file) return;
    if (this.saving) {
      await this.saving;
      if (!this.dirty) return;
    }
    this.dirty = false;
    const body = this.serialize();
    const tmp = `${this.file}.tmp`;
    this.saving = (async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, this.file);
    })();
    try {
      await this.saving;
    } catch (err) {
      this.dirty = true;
      throw err;
    } finally {
      this.saving = null;
    }
  }

  // Synchronous save for shutdown.
  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file || !this.dirty) return false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, this.serialize());
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.dirty = false;
    return true;
  }

  // ---------- lifecycle ----------
  start() {
    const every = (ms, fn) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    every(Math.round(1000 / this.poseHz), () => this.flushPoses());
    every(this.heartbeatMs, () => {
      for (const client of this.clients) this.write(client, ": hb\n\n", null);
    });
    every(this.sweepMs, () => this.sweep());
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const client of [...this.clients]) {
      try {
        client.res.end();
      } catch {
        // Already closed.
      }
    }
    this.clients.clear();
    this.flush();
  }

  // ---------- users ----------
  publicUser(user) {
    return { id: user.id, name: user.name, device: user.device, color: user.color, lastSeen: user.lastSeen, online: user.connections > 0 };
  }

  userList() {
    return [...this.users.values()].map((user) => this.publicUser(user));
  }

  requireUser(id) {
    const user = typeof id === "string" ? this.users.get(id) : undefined;
    if (!user) throw new BridgeError(410, { error: "gone", detail: "unknown user, join again" });
    user.lastSeen = Date.now();
    return user;
  }

  join({ name, device, color } = {}) {
    const dev = DEVICES.includes(device) ? device : "desktop";
    const used = new Set([...this.users.values()].map((u) => u.color));
    const wanted = typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : null;
    const user = {
      id: makeId("u"),
      name: clean(name, 32) || DEFAULT_NAMES[dev],
      device: dev,
      color: wanted || PALETTE.find((c) => !used.has(c)) || PALETTE[this.users.size % PALETTE.length],
      lastSeen: Date.now(),
      joinedAt: Date.now(),
      joinSeq: this.seq,
      sentSeq: this.seq,
      connections: 0,
    };
    this.users.set(user.id, user);
    this.broadcast("users", this.userList());
    this.emit("join", user);
    return { user: this.publicUser(user), users: this.userList(), state: snapshot(this.state), seq: this.seq };
  }

  leave(id) {
    if (!this.users.has(id)) return false;
    this.drop(id, "left");
    return true;
  }

  drop(id, reason = "timeout") {
    const user = this.users.get(id);
    if (!user) return;
    this.users.delete(id);
    for (const client of [...this.clients]) {
      if (client.user === id) client.res.end();
    }
    this.detachHeldBy(id);
    if (this.poses.delete(id)) this.posesDirty = true;
    for (const [stream, frame] of this.frames) {
      if (frame.user === id) this.stopShare(stream, id);
    }
    this.broadcast("users", this.userList());
    this.emit("drop", user, reason);
  }

  // Users without an open event stream for dropAfter ms are removed.
  sweep(now = Date.now()) {
    for (const user of [...this.users.values()]) {
      if (user.connections === 0 && now - user.lastSeen > this.dropAfter) this.drop(user.id, "timeout");
    }
  }

  // Objects held by a user who left fall to the ground below the hand.
  detachHeldBy(id) {
    const objects = this.state?.objects || {};
    const pose = this.poses.get(id);
    for (const record of Object.values(objects)) {
      if (!record?.attach || record.attach.user !== id) continue;
      let p = vec(record.p, 3) ? [...record.p] : [0, 0, 0];
      const hand = pose?.hands?.[record.attach.hand];
      if (hand && vec(hand.p, 3)) {
        const offset = vec(record.attach.rel?.p, 3) && vec(hand.q, 4) ? rotate(hand.q, record.attach.rel.p) : [0, 0, 0];
        p = [hand.p[0] + offset[0], 0, hand.p[2] + offset[2]];
      } else if (pose) {
        p = [pose.p[0], 0, pose.p[2]];
      }
      p[1] = 0;
      try {
        this.commit({ t: "set", id: record.id, patch: { attach: null, p }, uid: makeId("b"), by: "bridge" });
      } catch (err) {
        this.log.warn?.(`[room] could not drop ${record.id}: ${err.message}`);
      }
    }
  }

  // ---------- ops ----------
  op(userId, op) {
    this.requireUser(userId);
    const check = checkOp(op);
    if (!check.ok) throw new BridgeError(400, { error: "bad-op", detail: check.error });
    op.by = userId;
    if (typeof op.uid !== "string" || !op.uid) op.uid = makeId("p");
    return { seq: this.commit(op) };
  }

  commit(op) {
    try {
      applyOp(this.state, op);
    } catch (err) {
      throw new BridgeError(400, { error: "bad-op", detail: err?.message || "op could not be applied" });
    }
    this.seq++;
    const entry = { seq: this.seq, op };
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.broadcast("op", entry, this.seq);
    if (op.transient) this.dirty = true;
    else this.scheduleSave();
    this.emit("op", entry);
    return this.seq;
  }

  // ---------- poses, fx, say ----------
  pose(userId, pose) {
    this.requireUser(userId);
    const cleaned = cleanPose(pose);
    if (!cleaned) throw new BridgeError(400, { error: "bad-pose" });
    cleaned.user = userId;
    this.poses.set(userId, cleaned);
    this.posesDirty = true;
  }

  flushPoses() {
    if (!this.posesDirty) return;
    this.posesDirty = false;
    const all = {};
    for (const [id, pose] of this.poses) if (this.users.has(id)) all[id] = pose;
    this.broadcast("poses", all);
  }

  fx(userId, fx) {
    this.requireUser(userId);
    if (!fx || typeof fx !== "object" || Array.isArray(fx)) throw new BridgeError(400, { error: "bad-fx" });
    if (JSON.stringify(fx).length > 4096) throw new BridgeError(413, { error: "too-large" });
    this.broadcast("fx", { user: userId, fx });
  }

  say(userId, text) {
    this.requireUser(userId);
    const line = clean(text, 500);
    if (!line) throw new BridgeError(400, { error: "bad-text" });
    this.broadcast("say", { user: userId, text: line });
  }

  // ---------- shared screen / camera frames ----------
  setFrame(stream, userId, data, type = "image/jpeg") {
    this.requireUser(userId);
    const previous = this.frames.get(stream);
    if (!previous && this.frames.size >= MAX_STREAMS) throw new BridgeError(429, { error: "too-many-streams" });
    const n = (previous?.n || 0) + 1;
    this.frames.set(stream, { data, type, user: userId, n, t: Date.now() });
    this.broadcast("share", { stream, user: userId, active: true, n });
    return n;
  }

  getFrame(stream) {
    return this.frames.get(stream) || null;
  }

  stopShare(stream, userId) {
    const frame = this.frames.get(stream);
    this.frames.delete(stream);
    this.broadcast("share", { stream, user: userId || frame?.user || null, active: false, n: frame?.n || 0 });
  }

  // ---------- server-sent events ----------
  // Opens an event stream. since: last op seq the client has (Last-Event-ID or ?since=).
  openEvents(userId, req, res, since = null) {
    const user = this.requireUser(userId);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.socket?.setNoDelay?.(true);
    req.socket?.setTimeout?.(0);
    const client = { user: userId, res, queue: [], blocked: false };
    this.clients.add(client);
    user.connections++;
    this.write(client, "retry: 2000\n\n", null);

    const from = Number.isInteger(since) && since >= 0 ? since : user.connections === 1 ? user.sentSeq : this.seq;
    if (from < this.seq) {
      const oldest = this.ring.length ? this.ring[0].seq : this.seq + 1;
      if (from >= oldest - 1) {
        for (const entry of this.ring) if (entry.seq > from) this.send(client, "op", entry, entry.seq);
      } else {
        this.send(client, "state", { seq: this.seq, state: snapshot(this.state) }, this.seq);
      }
    } else if (from > this.seq) {
      this.send(client, "state", { seq: this.seq, state: snapshot(this.state) }, this.seq);
    }
    this.send(client, "users", this.userList());
    const poses = {};
    for (const [id, pose] of this.poses) poses[id] = pose;
    if (Object.keys(poses).length) this.send(client, "poses", poses);
    for (const [stream, frame] of this.frames) this.send(client, "share", { stream, user: frame.user, active: true, n: frame.n });

    const close = () => {
      if (!this.clients.delete(client)) return;
      const current = this.users.get(userId);
      if (current) {
        current.connections = Math.max(0, current.connections - 1);
        current.lastSeen = Date.now();
      }
    };
    res.on("close", close);
    res.on("error", close);
    return client;
  }

  send(client, event, data, id) {
    let text = id !== undefined && id !== null ? `id: ${id}\n` : "";
    text += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.write(client, text, event);
    if (event === "op" && id) {
      const user = this.users.get(client.user);
      if (user && id > user.sentSeq) user.sentSeq = id;
    }
  }

  write(client, text, event) {
    if (client.res.writableEnded || client.res.destroyed) return;
    if (client.blocked) {
      if (event === "poses") {
        const queued = client.queue.find((item) => item.event === "poses");
        if (queued) {
          queued.text = text;
          return;
        }
      }
      if (event === null && client.queue.length) return; // skip heartbeats while backed up
      client.queue.push({ event, text });
      if (client.queue.length > QUEUE_LIMIT) {
        this.log.warn?.(`[events] client of ${client.user} is too slow; closing its stream (it will reconnect)`);
        client.res.end();
      }
      return;
    }
    if (!client.res.write(text)) {
      client.blocked = true;
      client.res.once("drain", () => this.drain(client));
    }
  }

  drain(client) {
    client.blocked = false;
    while (client.queue.length) {
      const { text } = client.queue.shift();
      if (!client.res.write(text)) {
        client.blocked = true;
        client.res.once("drain", () => this.drain(client));
        return;
      }
    }
  }

  broadcast(event, data, id) {
    for (const client of this.clients) this.send(client, event, data, id);
  }
}
