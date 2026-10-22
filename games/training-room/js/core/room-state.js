// Shared room state: records + environment, mutated only through ops (see ARCHITECTURE.md).
// Used by the browser room and the Node bridge, so it stays pure and JSON-only.

export const TIMES = ["day", "sunset", "night", "dawn"];
export const LIMITS = { pos: 5000, minScale: 0.02, maxScale: 50, label: 80, text: 2000, data: 65536, ids: 500 };

const ID_RE = /^[a-z0-9:_-]{1,40}$/;
const PART_RE = /^[\p{L}\p{N}][\p{L}\p{N} :'_.-]{0,79}$/u;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const PATCH_KEYS = ["p", "ry", "s", "color", "text", "data", "attach", "onto", "label"];
const NULLABLE = new Set(["color", "text", "data", "attach", "onto"]);

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

export function createState() {
  return { objects: {}, order: [], env: { time: "day" }, seq: 0 };
}

function setKey(record, key, value) {
  if (value === null && NULLABLE.has(key)) delete record[key];
  else if (value !== undefined && value !== null) record[key] = clone(value);
}

// Mutates state. → { changed, events }.
export function applyOp(state, op) {
  const events = [];
  if (!state || !op || typeof op !== "object") return { changed: false, events };
  switch (op.t) {
    case "add": {
      const obj = op.obj;
      if (!obj || typeof obj.id !== "string") break;
      const record = clone(obj);
      const existed = !!state.objects[record.id];
      state.objects[record.id] = record;
      if (!existed) {
        const at = Number.isInteger(op.at) ? Math.max(0, Math.min(op.at, state.order.length)) : state.order.length;
        state.order.splice(at, 0, record.id);
        events.push({ type: "add", id: record.id, record, op });
      } else {
        events.push({ type: "update", id: record.id, record, patch: clone(obj), prev: null, op });
      }
      break;
    }
    case "set": {
      const record = state.objects[op.id];
      if (!record) break;
      const patch = op.patch && typeof op.patch === "object" ? op.patch : {};
      const prev = {};
      let touched = false;
      for (const key of PATCH_KEYS) {
        if (!(key in patch) || patch[key] === undefined) continue;
        prev[key] = record[key] === undefined ? null : clone(record[key]);
        setKey(record, key, patch[key]);
        touched = true;
      }
      if (touched || op.fly) events.push({ type: "update", id: record.id, record, patch, prev, op });
      break;
    }
    case "del": {
      const ids = new Set((Array.isArray(op.ids) ? op.ids : []).filter((id) => state.objects[id]));
      if (!ids.size) break;
      for (const id of ids) {
        const record = state.objects[id];
        delete state.objects[id];
        events.push({ type: "remove", id, record, op });
      }
      state.order = state.order.filter((id) => !ids.has(id));
      for (const id of state.order) {
        const record = state.objects[id];
        if (record && record.onto && ids.has(record.onto)) {
          const prev = { onto: record.onto };
          delete record.onto;
          events.push({ type: "update", id, record, patch: { onto: null }, prev, op });
        }
      }
      break;
    }
    case "clear": {
      state.objects = {};
      state.order = [];
      events.push({ type: "clear", op });
      break;
    }
    case "env": {
      if (!TIMES.includes(op.time)) break;
      const prev = state.env?.time;
      state.env = { ...(state.env || {}), time: op.time };
      events.push({ type: "env", prev, op });
      break;
    }
    default:
      break;
  }
  return { changed: events.length > 0, events };
}

// Ops that undo `op` against the CURRENT state (call before applying `op`).
export function invertOp(state, op) {
  if (!state || !op) return [];
  switch (op.t) {
    case "add": {
      const id = op.obj?.id;
      if (!id) return [];
      const old = state.objects[id];
      if (old) return [{ t: "add", obj: clone(old), at: state.order.indexOf(id) }];
      return [{ t: "del", ids: [id] }];
    }
    case "set": {
      const record = state.objects[op.id];
      if (!record) return [];
      const patch = {};
      for (const key of PATCH_KEYS) {
        if (!op.patch || !(key in op.patch) || op.patch[key] === undefined) continue;
        patch[key] = record[key] === undefined ? null : clone(record[key]);
      }
      return Object.keys(patch).length ? [{ t: "set", id: op.id, patch }] : [];
    }
    case "del": {
      const ids = new Set((Array.isArray(op.ids) ? op.ids : []).filter((id) => state.objects[id]));
      if (!ids.size) return [];
      const adds = [];
      const links = [];
      state.order.forEach((id, index) => {
        const record = state.objects[id];
        if (!record) return;
        if (ids.has(id)) adds.push({ t: "add", obj: clone(record), at: index });
        else if (record.onto && ids.has(record.onto)) links.push({ t: "set", id, patch: { onto: record.onto } });
      });
      return [...adds, ...links];
    }
    case "clear":
      return state.order.filter((id) => state.objects[id]).map((id, index) => ({ t: "add", obj: clone(state.objects[id]), at: index }));
    case "env":
      return [{ t: "env", time: state.env?.time || "day" }];
    default:
      return [];
  }
}

export function snapshot(state) {
  return JSON.parse(JSON.stringify(state || createState()));
}

// Builds a valid state from saved JSON (string or object); invalid records are skipped.
export function loadState(json) {
  let input = json;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return createState();
    }
  }
  const state = createState();
  if (!input || typeof input !== "object") return state;
  const objects = input.objects && typeof input.objects === "object" && !Array.isArray(input.objects) ? input.objects : {};
  const order = Array.isArray(input.order) ? input.order : [];
  const seen = new Set();
  const push = (id) => {
    if (seen.has(id) || !Object.prototype.hasOwnProperty.call(objects, id)) return;
    seen.add(id);
    const result = validateRecord(objects[id]);
    if (!result.ok || result.record.id !== id) return;
    state.objects[id] = result.record;
    state.order.push(id);
  };
  for (const id of order) if (typeof id === "string") push(id);
  for (const id of Object.keys(objects)) push(id);
  for (const id of state.order) {
    const record = state.objects[id];
    if (record.onto && !state.objects[record.onto]) delete record.onto;
  }
  if (TIMES.includes(input.env?.time)) state.env.time = input.env.time;
  if (Number.isInteger(input.seq) && input.seq >= 0) state.seq = input.seq;
  return state;
}

// ---------- network sanitizing ----------

class Invalid extends Error {}
const fail = (message) => {
  throw new Invalid(message);
};

const isId = (v) => typeof v === "string" && ID_RE.test(v);
function id(v, what) {
  if (!isId(v)) fail(`bad ${what}`);
  return v;
}
function finite(v, what) {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`bad ${what}`);
  return v;
}
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function vec(v, n, lim, what) {
  if (!Array.isArray(v) || v.length !== n) fail(`bad ${what}`);
  return v.map((x) => clampNum(finite(x, what), -lim, lim));
}
function yaw(v) {
  const r = finite(v, "ry");
  if (Math.abs(r) <= Math.PI) return r;
  const wrapped = ((((r + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return wrapped;
}
function cleanString(v, max, what, { keepNewlines = false, stripTags = false } = {}) {
  if (typeof v !== "string") fail(`bad ${what}`);
  let s = keepNewlines ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "") : v.replace(/[\u0000-\u001f\u007f]/g, " ");
  if (stripTags) s = s.replace(/[<>]/g, "");
  return s.trim().slice(0, max);
}
function color(v) {
  if (typeof v !== "string" || !COLOR_RE.test(v.trim().toLowerCase())) fail("bad color");
  return v.trim().toLowerCase();
}
function part(v) {
  if (typeof v !== "string") fail("bad part");
  const p = v.trim().toLowerCase();
  if (!PART_RE.test(p)) fail("bad part");
  return p;
}
function data(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("bad data");
  let text;
  try {
    text = JSON.stringify(v);
  } catch {
    fail("bad data");
  }
  if (typeof text !== "string" || text.length > LIMITS.data) fail("data too large");
  return JSON.parse(text);
}
function attach(v) {
  if (!v || typeof v !== "object") fail("bad attach");
  const out = { user: id(v.user, "attach user"), hand: v.hand === "left" ? "left" : v.hand === "right" ? "right" : fail("bad hand") };
  out.grip = v.grip === "keep" ? "keep" : "snap";
  if (v.rel !== undefined && v.rel !== null) {
    if (typeof v.rel !== "object") fail("bad attach rel");
    out.rel = { p: vec(v.rel.p, 3, 10, "attach rel p"), q: vec(v.rel.q, 4, 1, "attach rel q") };
  }
  return out;
}

function recordOf(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("bad record");
  const r = { id: id(v.id, "id"), part: part(v.part) };
  r.label = v.label === undefined || v.label === null ? r.part : cleanString(v.label, LIMITS.label, "label", { stripTags: true }) || r.part;
  r.p = vec(v.p, 3, LIMITS.pos, "p");
  r.ry = v.ry === undefined ? 0 : yaw(v.ry);
  r.s = v.s === undefined ? 1 : clampNum(finite(v.s, "s"), LIMITS.minScale, LIMITS.maxScale);
  if (v.color !== undefined && v.color !== null) r.color = color(v.color);
  if (v.text !== undefined && v.text !== null) r.text = cleanString(v.text, LIMITS.text, "text", { keepNewlines: true });
  if (v.data !== undefined && v.data !== null) r.data = data(v.data);
  if (v.attach !== undefined && v.attach !== null) r.attach = attach(v.attach);
  if (v.onto !== undefined && v.onto !== null) r.onto = id(v.onto, "onto");
  if (v.by !== undefined && v.by !== null) r.by = id(v.by, "by");
  if (v.t !== undefined && v.t !== null) r.t = clampNum(finite(v.t, "t"), 0, 1e13);
  return r;
}

export function validateRecord(record) {
  try {
    return { ok: true, record: recordOf(record), error: null };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, record: null, error: err.message };
    throw err;
  }
}

function patchOf(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("bad patch");
  const out = {};
  if (v.p !== undefined && v.p !== null) out.p = vec(v.p, 3, LIMITS.pos, "p");
  if (v.ry !== undefined && v.ry !== null) out.ry = yaw(v.ry);
  if (v.s !== undefined && v.s !== null) out.s = clampNum(finite(v.s, "s"), LIMITS.minScale, LIMITS.maxScale);
  if (v.label !== undefined && v.label !== null) out.label = cleanString(v.label, LIMITS.label, "label", { stripTags: true });
  if (v.color !== undefined) out.color = v.color === null ? null : color(v.color);
  if (v.text !== undefined) out.text = v.text === null ? null : cleanString(v.text, LIMITS.text, "text", { keepNewlines: true });
  if (v.data !== undefined) out.data = v.data === null ? null : data(v.data);
  if (v.attach !== undefined) out.attach = v.attach === null ? null : attach(v.attach);
  if (v.onto !== undefined) out.onto = v.onto === null ? null : id(v.onto, "onto");
  return out;
}

function opOf(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail("op must be an object");
  let out;
  switch (v.t) {
    case "add":
      out = { t: "add", obj: recordOf(v.obj) };
      if (v.at !== undefined && v.at !== null) {
        if (!Number.isInteger(v.at) || v.at < 0) fail("bad at");
        out.at = Math.min(v.at, 100000);
      }
      break;
    case "set": {
      out = { t: "set", id: id(v.id, "id"), patch: patchOf(v.patch ?? {}) };
      if (v.fly !== undefined && v.fly !== null) {
        if (typeof v.fly !== "object") fail("bad fly");
        out.fly = { vel: vec(v.fly.vel, 3, 100, "fly vel"), spin: v.fly.spin === undefined ? 0 : clampNum(finite(v.fly.spin, "fly spin"), -100, 100) };
      }
      if (!Object.keys(out.patch).length && !out.fly) fail("empty patch");
      break;
    }
    case "del": {
      if (!Array.isArray(v.ids) || !v.ids.length || v.ids.length > LIMITS.ids) fail("bad ids");
      out = { t: "del", ids: [...new Set(v.ids.map((x) => id(x, "id")))] };
      break;
    }
    case "clear":
      out = { t: "clear" };
      break;
    case "env":
      if (!TIMES.includes(v.time)) fail("bad time");
      out = { t: "env", time: v.time };
      break;
    default:
      fail("unknown op type");
  }
  if (v.uid !== undefined && v.uid !== null) out.uid = id(v.uid, "uid");
  if (v.by !== undefined && v.by !== null) out.by = id(v.by, "by");
  if (v.transient === true) out.transient = true;
  return out;
}

// Strict sanitizer for ops from the network. → { ok, op, error }.
export function validateOp(op) {
  try {
    return { ok: true, op: opOf(op), error: null };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, op: null, error: err.message };
    return { ok: false, op: null, error: "invalid op" };
  }
}

// ---------- model prompt summary ----------

const DIRS = ["front", "front-right", "right", "behind-right", "behind", "behind-left", "left", "front-left"];

// Compact scene list for the model: nearest first, at most 40.
export function summarize(state, player) {
  const head = player?.p || [0, 1.6, 0];
  const yawAngle = player?.yaw || 0;
  const fx = -Math.sin(yawAngle);
  const fz = -Math.cos(yawAngle);
  const rx = Math.cos(yawAngle);
  const rz = -Math.sin(yawAngle);
  const out = [];
  for (const rid of state?.order || []) {
    const r = state.objects[rid];
    if (!r || !Array.isArray(r.p)) continue;
    const dx = r.p[0] - head[0];
    const dz = r.p[2] - head[2];
    const dist = Math.hypot(dx, dz);
    const deg = (Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) * 180) / Math.PI;
    const sector = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
    const item = { id: r.id, part: r.part, label: r.label || r.part, dist: Math.round(dist * 10) / 10, dir: DIRS[sector] };
    if (r.onto) item.on = r.onto;
    if (r.attach) item.held = r.attach.hand;
    if (r.text) item.text = String(r.text).slice(0, 40);
    out.push(item);
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, 40);
}
