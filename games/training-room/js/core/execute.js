// Intents → absolute room ops. Plans against a private copy of the room state so later intents in
// the same command see earlier ones ("spawn a card table and put a deck of cards on it").
import { applyOp, snapshot, TIMES } from "./room-state.js";
import { resolvePlacement, forwardOf, rightOf, faceYaw } from "./place.js";
import { normalizeBlueprint, slug } from "./blueprint.js";
import { newDeck, shuffle, cardName, isCard, RANKS, SUITS } from "./cards.js";
import { matchColor, matchPart, normalizeText, singularize } from "./lexicon.js";

const PLACEHOLDER = { name: "thing", size: [0.8, 0.8, 0.8], placeholder: true };
const MAX_COUNT = 30;
const NEAR_REF = 10;
const WRITE_RANGE = 15;
const FLIP_RANGE = 3;
const TIME_ALIASES = { daytime: "day", noon: "day", midday: "day", morning: "dawn", sunrise: "dawn", evening: "sunset", dusk: "sunset", midnight: "night", nighttime: "night" };
const CATEGORY_ORDER = ["structures", "nature", "office", "leisure", "combat", "custom"];
const BEHAVIOR_KINDS = ["swim", "fly", "walk", "hop", "roll", "spin", "float", "bounce", "sway", "none"];
const DRAWING_RANGE = 15;
// Magic marker intents that need the model; the runner handles them before planning.
const RUNNER_INTENTS = new Set(["realize", "guess", "correct"]);

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const r3 = (n) => Math.round(n * 1000) / 1000;
const an = (word) => (/^[aeiou]/i.test(String(word)) ? "an" : "a");
const lower = (v) => String(v ?? "").trim().toLowerCase();

let fallbackCounter = 0;
function fallbackId(prefix = "o") {
  fallbackCounter = (fallbackCounter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36).slice(-5)}${fallbackCounter.toString(36)}`;
}

function cleanLabel(v) {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

// Part id for unknown things: must pass room-state's part check.
function partId(label) {
  const id = lower(label).replace(/[^\p{L}\p{N} :'_.-]+/gu, " ").replace(/\s+/g, " ").trim().replace(/^[^\p{L}\p{N}]+/u, "").slice(0, 80);
  return id || "thing";
}

function blueprintMeta(bp) {
  return { name: bp.name, size: bp.size || [1, 1, 1], holdable: !!bp.holdable && Math.max(...(bp.size || [1, 1, 1])) <= 2, grip: bp.grip, category: "custom" };
}

function listSummary(metas) {
  const groups = new Map();
  for (const meta of metas || []) {
    if (!meta?.name) continue;
    const cat = meta.category || "custom";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(meta.name);
  }
  if (!groups.size) return "I can summon things from the parts bin. Try: spawn a villa to my left, or give me an axe.";
  const cats = [...groups.keys()].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const total = [...groups.values()].reduce((n, list) => n + list.length, 0);
  const parts = cats.map((cat) => `${cat[0].toUpperCase()}${cat.slice(1)}: ${groups.get(cat).slice(0, 3).join(", ")}`);
  return `I can summon ${total} parts. ${parts.join(". ")}. Try: spawn a villa to my left.`;
}

export function planIntents(intents, ctx = {}) {
  const out = { ops: [], say: [], errors: [], undo: 0, focus: null };
  const list = Array.isArray(intents) ? intents.filter((i) => i && typeof i === "object") : [];
  const user = ctx.user || ctx.player?.user || "u0";
  const player = { p: [0, 1.6, 0], yaw: 0, hands: {}, ...(ctx.player || {}), user };
  const head = player.p;
  const yaw = player.yaw || 0;
  const defaultHand = ctx.hand === "left" ? "left" : "right";
  const rng = typeof ctx.rng === "function" ? ctx.rng : Math.random;
  const newId = typeof ctx.newId === "function" ? ctx.newId : fallbackId;
  const now = typeof ctx.now === "function" ? ctx.now : Date.now;
  const metas = Array.isArray(ctx.metas) ? ctx.metas : [];
  const work = snapshot(ctx.state);
  if (!work.objects || !Array.isArray(work.order)) {
    work.objects = {};
    work.order = [];
  }
  const batch = []; // intent index → record ids it created
  const spawnIntents = []; // intent indexes of spawn intents, in order
  const touched = [];

  // ---------- helpers ----------
  const metaOfPart = (part) => {
    const meta = ctx.metaOf?.(part) || metas.find((m) => m?.name === part);
    return meta && !meta.placeholder ? meta : null;
  };
  const metaFor = (record) => {
    if (record?.data?.blueprint) return blueprintMeta(record.data.blueprint);
    return ctx.metaOf?.(record.part) || metas.find((m) => m?.name === record.part) || PLACEHOLDER;
  };
  const sizeOf = (record) => {
    if (ctx.sizeOf) {
      const size = ctx.sizeOf(record);
      if (Array.isArray(size) && size.length === 3) return size;
    }
    const size = metaFor(record).size || PLACEHOLDER.size;
    const s = record.s || 1;
    return [size[0] * s, size[1] * s, size[2] * s];
  };
  const records = () => work.order.map((id) => work.objects[id]).filter(Boolean);
  const say = (text) => out.say.push(text);
  const fail = (text) => {
    out.errors.push(text);
    out.say.push(text);
  };
  const emit = (op) => {
    op.uid = newId("u");
    op.by = user;
    applyOp(work, op);
    out.ops.push(op);
    return op;
  };
  const touch = (id) => {
    touched.push(id);
    out.focus = id;
  };
  const distXZ = (p) => Math.hypot(p[0] - head[0], p[2] - head[2]);

  // Canonical part name for a name or alias ("deck of playing cards" → "deck of cards").
  const resolvePart = (name) => {
    const n = lower(name);
    if (!n) return null;
    if (metaOfPart(n)) return n;
    const words = normalizeText(n).split(" ").filter(Boolean);
    const m = matchPart(words, metas, { start: 0, anchored: true });
    if (m && m.end === words.length && metaOfPart(m.name)) return m.name;
    return null;
  };

  const recordMatches = (record, name) => {
    const n = lower(name);
    const canonical = resolvePart(n);
    const label = lower(record.label);
    return record.part === n || (canonical && record.part === canonical) || label === n
      || record.part === `custom:${slug(n)}` || (label && singularize(label) === singularize(n));
  };
  // "the table" finds a "card table" when nothing is called just "table".
  const recordMatchesLoosely = (record, name) => {
    const tail = normalizeText(name).split(" ").filter(Boolean).map(singularize).join(" ");
    if (!tail) return false;
    const words = (s) => normalizeText(s || "").split(" ").filter(Boolean).map(singularize).join(" ");
    return [record.part, record.label].some((s) => {
      const w = words(s);
      return w === tail || w.endsWith(` ${tail}`);
    });
  };

  const nearest = (list) => {
    let best = null;
    let bestD = Infinity;
    for (const r of list) {
      const d = distXZ(r.p);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best;
  };

  const lastRecord = () => {
    for (let i = touched.length - 1; i >= 0; i--) if (work.objects[touched[i]]) return work.objects[touched[i]];
    const all = records();
    for (let i = all.length - 1; i >= 0; i--) if (all[i].by === user) return all[i];
    return all[all.length - 1] || null;
  };

  const batchIds = (n) => {
    if (Array.isArray(batch[n]) && batch[n].length) return batch[n];
    const idx = spawnIntents[n];
    return idx !== undefined && Array.isArray(batch[idx]) ? batch[idx] : [];
  };

  function resolveTargets(target) {
    if (!target || typeof target !== "object") return [];
    if (target.id) return work.objects[target.id] ? [work.objects[target.id]] : [];
    if (target.batch !== undefined) return batchIds(target.batch).map((id) => work.objects[id]).filter(Boolean);
    if (target.ref === "all") return records();
    if (target.ref === "held") return records().filter((r) => r.attach && r.attach.user === user);
    if (target.ref === "it" || target.ref === "last") {
      const r = lastRecord();
      return r ? [r] : [];
    }
    if (target.part) {
      let matches = records().filter((r) => recordMatches(r, target.part));
      if (!matches.length) matches = records().filter((r) => recordMatchesLoosely(r, target.part));
      if (!matches.length) return [];
      const which = target.which ?? "nearest";
      if (which === "all") return matches;
      if (which === "last") return [matches[matches.length - 1]];
      if (Number.isInteger(which)) return matches[which - 1] ? [matches[which - 1]] : [];
      return [nearest(matches)];
    }
    return [];
  }

  function describe(target) {
    if (!target) return "that";
    if (target.part) return `${an(target.part)} ${target.part}`;
    if (target.ref === "held") return "anything in your hands";
    return "anything to use for that";
  }

  function notFound(target) {
    if (target?.ref === "held") return fail("You're not holding anything.");
    if (target?.ref === "all") return fail("The field is already empty.");
    return fail(`I can't find ${describe(target)}.`);
  }

  function descendants(id) {
    const out2 = [];
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length) {
      const parent = queue.shift();
      for (const r of records()) {
        if (r.onto === parent && !seen.has(r.id)) {
          seen.add(r.id);
          out2.push(r);
          queue.push(r.id);
        }
      }
    }
    return out2;
  }

  function handPos(hand) {
    const h = player.hands?.[hand];
    if (h && Array.isArray(h.p)) return [...h.p];
    const f = forwardOf(yaw);
    const r = rightOf(yaw);
    const side = hand === "left" ? -0.2 : 0.2;
    return [head[0] + f[0] * 0.5 + r[0] * side, Math.max(0.3, head[1] - 0.5), head[2] + f[2] * 0.5 + r[2] * side];
  }

  const placeCtx = (size, exclude = []) => ({
    player,
    size,
    records: records(),
    sizeOf,
    metaOf: (part) => ctx.metaOf?.(part) || metas.find((m) => m?.name === part),
    batch: batch.map((ids) => (ids && ids.length ? work.objects[ids[0]] : undefined)),
    hand: defaultHand,
    exclude: new Set(exclude),
  });

  // Highest surface under (x, z) at or below y, for dropped things.
  function landing(x, z, y, skip) {
    let best = null;
    for (const r of records()) {
      if (skip.has(r.id) || r.attach) continue;
      const meta = metaFor(r);
      if (typeof meta.surface !== "number") continue;
      const s = r.s || 1;
      const area = meta.surfaceSize || [meta.size[0], meta.size[2]];
      const c = Math.cos(-(r.ry || 0));
      const sn = Math.sin(-(r.ry || 0));
      const dx = x - r.p[0];
      const dz = z - r.p[2];
      const lx = dx * c + dz * sn;
      const lz = -dx * sn + dz * c;
      if (Math.abs(lx) > (area[0] * s) / 2 || Math.abs(lz) > (area[1] * s) / 2) continue;
      const top = r.p[1] + meta.surface * s;
      if (top <= y + 0.05 && (!best || top > best.top)) best = { top, id: r.id };
    }
    return best;
  }

  function dropRecord(record) {
    const hp = handPos(record.attach?.hand || defaultHand);
    const skip = new Set([record.id, ...descendants(record.id).map((r) => r.id)]);
    const land = landing(hp[0], hp[2], hp[1], skip);
    const patch = { attach: null, p: [r3(hp[0]), land ? r3(land.top) : 0, r3(hp[2])] };
    if (land) patch.onto = land.id;
    emit({ t: "set", id: record.id, patch });
    touch(record.id);
  }

  function dropHand(hand, keepId) {
    for (const r of records()) if (r.attach && r.attach.user === user && r.attach.hand === hand && r.id !== keepId) dropRecord(r);
  }

  // Finds (or spawns) the record a placement ref points at. → record | null
  function resolveRef(ref, index) {
    if (!ref || typeof ref !== "object") return null;
    if (ref.batch !== undefined) {
      const ids = batchIds(ref.batch);
      return ids.length ? work.objects[ids[0]] : null;
    }
    if (ref.id || ref.ref) return resolveTargets(ref)[0] || null;
    if (!ref.part) return null;
    let found = resolveTargets({ part: ref.part, which: ref.which || "nearest" })[0] || null;
    if (found && ref.spawnIfMissing && distXZ(found.p) > NEAR_REF) found = null;
    if (found) return found;
    const part = resolvePart(ref.part);
    if (!part) {
      fail(`I can't find ${an(ref.part)} ${ref.part}, so I put it in front of you.`);
      return null;
    }
    const ids = spawnRecords({ what: { part } }, index, { rel: "front" }, { trackBatch: false });
    return ids.length ? work.objects[ids[0]] : null;
  }

  // Replaces part refs by ids (spawning missing ones) so place.js sees concrete records.
  function concretePlace(place, index, exclude = []) {
    const pl = place && typeof place === "object" ? { ...place } : { rel: "front" };
    if (!pl.rel) pl.rel = "front";
    if ((pl.rel === "on" || pl.rel === "next") && pl.ref) {
      const ref = resolveRef(pl.ref, index);
      if (!ref || exclude.includes(ref.id)) return { rel: "front", ...(pl.dist ? { dist: pl.dist } : {}) };
      pl.ref = { id: ref.id };
    }
    return pl;
  }

  function cardCode() {
    return RANKS[Math.floor(rng() * RANKS.length) % RANKS.length] + SUITS[Math.floor(rng() * SUITS.length) % SUITS.length];
  }

  // Creates the records of one spawn. → ids
  function spawnRecords(intent, index, placeOverride, { trackBatch = true } = {}) {
    const what = intent.what && typeof intent.what === "object" ? intent.what : {};
    let part;
    let label;
    let meta;
    let data;
    if (what.custom) {
      const res = normalizeBlueprint(what.custom);
      if (res.ok) {
        label = cleanLabel(what.label || res.blueprint.name) || res.blueprint.name;
        part = `custom:${slug(label)}`.slice(0, 80);
        data = { blueprint: res.blueprint };
        meta = blueprintMeta(res.blueprint);
      } else {
        out.errors.push(`blueprint rejected: ${res.error}`);
      }
    }
    if (!part) {
      const name = resolvePart(what.part) || resolvePart(what.label);
      if (name) {
        part = name;
        meta = metaOfPart(name);
        label = cleanLabel(what.label) || name;
      } else {
        label = cleanLabel(what.label || what.part || "thing") || "thing";
        part = partId(label);
        data = { unknown: true };
        meta = PLACEHOLDER;
        say(`I don't have ${an(label)} ${label} in the parts bin yet.`);
      }
    }
    const count = clamp(Math.round(Number(intent.count) || 1), 1, MAX_COUNT);
    const s = r3(clamp(Number(intent.scale) > 0 ? Number(intent.scale) : 1, 0.05, 20));
    let color = null;
    if (intent.color) {
      color = matchColor(intent.color);
      if (!color) say(`I don't know the color ${intent.color}.`);
    }
    const text = typeof intent.text === "string" && intent.text.trim() ? intent.text.trim().slice(0, 2000) : null;
    const size = (meta.size || PLACEHOLDER.size).map((n) => n * s);
    const place = concretePlace(placeOverride || intent.place, index);
    const ids = [];

    const build = (pose) => {
      const record = { id: newId("o"), part, label, p: pose.p, ry: pose.ry ?? 0, s };
      if (color) record.color = color;
      if (text) record.text = text;
      let recordData = data ? JSON.parse(JSON.stringify(data)) : undefined;
      if (meta.deck) recordData = { ...(recordData || {}), cards: shuffle(newDeck(), rng), faceUp: false };
      else if (part === "playing card") recordData = { ...(recordData || {}), card: cardCode(), faceUp: true };
      if (recordData) record.data = recordData;
      if (pose.attach) record.attach = pose.attach;
      if (pose.onto) record.onto = pose.onto;
      record.by = user;
      record.t = now();
      emit({ t: "add", obj: record });
      ids.push(record.id);
      touch(record.id);
    };

    if (place.rel === "hand") {
      const first = place.hand === "left" || place.hand === "right" ? place.hand : defaultHand;
      const hands = count >= 2 ? [first, first === "left" ? "right" : "left"] : [first];
      if (!meta.holdable) {
        say(`The ${label} is too big to hold, so I put it in front of you.`);
        return spawnRecords(intent, index, { rel: "front" }, { trackBatch });
      }
      for (const hand of hands) {
        dropHand(hand);
        build(resolvePlacement({ rel: "hand", hand }, placeCtx(size)));
      }
      if (count > hands.length) {
        const rest = spawnRecords({ ...intent, count: count - hands.length }, index, { rel: "front" }, { trackBatch: false });
        ids.push(...rest);
      }
    } else if (count > 1 && !["on", "at"].includes(place.rel)) {
      const spacing = size[0] + 0.3;
      const group = [count * spacing - 0.3, size[1], Math.max(size[2], 0.01)];
      const center = resolvePlacement(place, placeCtx(group));
      const ax = [Math.cos(center.ry), -Math.sin(center.ry)];
      for (let i = 0; i < count; i++) {
        const off = (i - (count - 1) / 2) * spacing;
        build({ p: [r3(center.p[0] + ax[0] * off), center.p[1], r3(center.p[2] + ax[1] * off)], ry: center.ry, onto: center.onto });
      }
    } else {
      for (let i = 0; i < count; i++) build(resolvePlacement(place, placeCtx(size)));
    }
    if (trackBatch) batch[index] = [...(batch[index] || []), ...ids];
    return ids;
  }

  // ---------- intent handlers ----------

  function spawn(intent, index) {
    spawnIntents.push(index);
    batch[index] = batch[index] || [];
    spawnRecords(intent, index);
  }

  function remove(intent) {
    const targets = resolveTargets(intent.target);
    if (!targets.length) return notFound(intent.target);
    const ids = new Set(targets.map((r) => r.id));
    const orphans = [];
    for (const r of targets) for (const kid of records()) if (kid.onto === r.id && !ids.has(kid.id)) orphans.push(kid);
    emit({ t: "del", ids: [...ids] });
    // Things that sat on removed objects fall to the grass.
    for (const kid of orphans) {
      if (!work.objects[kid.id]) continue;
      const dy = -kid.p[1];
      for (const r of [kid, ...descendants(kid.id)]) emit({ t: "set", id: r.id, patch: { p: [r.p[0], r3(Math.max(0, r.p[1] + dy)), r.p[2]] } });
    }
  }

  function moveRecord(record, place, index) {
    const kids = descendants(record.id);
    const exclude = [record.id, ...kids.map((r) => r.id)];
    const pl = concretePlace(place, index, exclude);
    if (pl.rel === "hand") return holdRecord(record, pl.hand);
    const res = resolvePlacement(pl, placeCtx(sizeOf(record), exclude));
    const old = { p: [...record.p], ry: record.ry || 0 };
    const patch = { p: res.p, ry: res.ry };
    if (res.onto) patch.onto = res.onto;
    else if (record.onto) patch.onto = null;
    if (record.attach) patch.attach = null;
    emit({ t: "set", id: record.id, patch });
    touch(record.id);
    const dRy = res.ry - old.ry;
    const c = Math.cos(dRy);
    const s = Math.sin(dRy);
    for (const kid of kids) {
      const ox = kid.p[0] - old.p[0];
      const oz = kid.p[2] - old.p[2];
      const p = [r3(res.p[0] + ox * c + oz * s), r3(kid.p[1] + res.p[1] - old.p[1]), r3(res.p[2] - ox * s + oz * c)];
      emit({ t: "set", id: kid.id, patch: { p, ry: r3((kid.ry || 0) + dRy) } });
    }
  }

  function move(intent, index) {
    const targets = resolveTargets(intent.target);
    if (!targets.length) {
      const part = intent.target?.spawnIfMissing ? resolvePart(intent.target.part) : null;
      if (part) return spawn({ do: "spawn", what: { part }, place: intent.place }, index);
      return notFound(intent.target);
    }
    for (const record of targets) moveRecord(record, intent.place || { rel: "front" }, index);
  }

  function scale(intent) {
    const factor = Number(intent.factor);
    if (!(factor > 0) || !Number.isFinite(factor)) return fail("I need a size factor like bigger, smaller or twice as big.");
    const targets = resolveTargets(intent.target);
    if (!targets.length) return notFound(intent.target);
    for (const record of targets) {
      const meta = metaFor(record);
      const oldS = record.s || 1;
      const newS = r3(clamp(oldS * factor, 0.05, 20));
      const height = typeof meta.surface === "number" ? meta.surface : (meta.size || PLACEHOLDER.size)[1];
      const dy = height * (newS - oldS);
      const kids = descendants(record.id);
      emit({ t: "set", id: record.id, patch: { s: newS } });
      touch(record.id);
      if (Math.abs(dy) > 1e-6) for (const kid of kids) emit({ t: "set", id: kid.id, patch: { p: [kid.p[0], r3(kid.p[1] + dy), kid.p[2]] } });
    }
  }

  function color(intent) {
    const hex = matchColor(intent.color);
    if (!hex) return fail(`I don't know the color ${intent.color ?? ""}.`.replace(" .", "."));
    const targets = resolveTargets(intent.target);
    if (!targets.length) return notFound(intent.target);
    for (const record of targets) {
      emit({ t: "set", id: record.id, patch: { color: hex } });
      touch(record.id);
    }
  }

  function holdRecord(record, hand) {
    const h = hand === "left" || hand === "right" ? hand : defaultHand;
    if (!metaFor(record).holdable) return say(`The ${record.label || record.part} is too big to hold.`);
    dropHand(h, record.id);
    const patch = { attach: { user, hand: h, grip: "snap" }, p: handPos(h).map(r3) };
    if (record.onto) patch.onto = null;
    emit({ t: "set", id: record.id, patch });
    touch(record.id);
  }

  function hold(intent, index) {
    const hand = intent.hand === "left" || intent.hand === "right" ? intent.hand : defaultHand;
    const targets = resolveTargets(intent.target);
    if (!targets.length) {
      const part = intent.target?.part ? resolvePart(intent.target.part) : null;
      if (part) return spawn({ do: "spawn", what: { part }, place: { rel: "hand", hand } }, index);
      return notFound(intent.target);
    }
    holdRecord(targets[0], hand);
  }

  function drop(intent) {
    let held = records().filter((r) => r.attach && r.attach.user === user);
    if (intent.hand === "left" || intent.hand === "right") held = held.filter((r) => r.attach.hand === intent.hand);
    if (intent.target && intent.target.ref !== "it" && intent.target.ref !== "all") {
      const wanted = new Set(resolveTargets({ ...intent.target, which: "all" }).map((r) => r.id));
      held = held.filter((r) => wanted.has(r.id));
    }
    if (!held.length) return say("You're not holding anything.");
    for (const record of held) dropRecord(record);
  }

  function noteRecord(text, place, index) {
    const meta = metaOfPart("sticky note") || metas.find((m) => m?.writable && m?.holdable) || metas.find((m) => m?.writable);
    const part = meta ? meta.name : "sticky note";
    spawnRecords({ what: { part, label: meta ? undefined : "sticky note" }, text }, index, place, { trackBatch: true });
  }

  function write(intent, index) {
    const text = String(intent.text ?? "").trim().slice(0, 2000);
    if (!text) return fail("What should I write?");
    let target = null;
    if (intent.target) {
      target = resolveTargets(intent.target)[0] || null;
      if (!target) {
        say(`I can't find ${describe(intent.target)}, so I wrote it on a sticky note.`);
        return noteRecord(text, { rel: "front" }, index);
      }
    } else {
      const writable = records().filter((r) => metaFor(r).writable && distXZ(r.p) <= WRITE_RANGE);
      target = nearest(writable);
    }
    if (!target) return noteRecord(text, { rel: "front" }, index);
    if (!metaFor(target).writable) {
      say(`The ${target.label || target.part} can't hold writing, so I added a sticky note next to it.`);
      return noteRecord(text, { rel: "next", ref: { id: target.id } }, index);
    }
    emit({ t: "set", id: target.id, patch: { text } });
    touch(target.id);
  }

  const isDeck = (r) => !!(r && (metaFor(r).deck || Array.isArray(r.data?.cards)));
  const isCardRecord = (r) => !!(r && (r.part === "playing card" || isCard(r.data?.card)));

  function surfaceNear(point, range) {
    let best = null;
    let bestD = Infinity;
    for (const r of records()) {
      if (r.attach || typeof metaFor(r).surface !== "number") continue;
      const d = Math.hypot(r.p[0] - point[0], r.p[2] - point[2]);
      if (d <= range && d < bestD) {
        best = r;
        bestD = d;
      }
    }
    return best;
  }

  function deal(intent, index) {
    let n = clamp(Math.round(Number(intent.count) || 5), 1, 52);
    let deck = null;
    if (intent.target) {
      const found = resolveTargets(intent.target);
      deck = found.find(isDeck) || null;
      if (!deck && found.length) return fail(`The ${found[0].label || found[0].part} isn't a deck of cards.`);
    } else {
      deck = nearest(records().filter(isDeck));
    }
    if (!deck) {
      if (!metaOfPart("deck of cards")) return fail("There's no deck of cards here.");
      const place = intent.place || (surfaceNear(head, 3) ? { rel: "on", ref: { id: surfaceNear(head, 3).id } } : { rel: "front" });
      const ids = spawnRecords({ what: { part: "deck of cards" } }, index, place, { trackBatch: false });
      deck = ids.length ? work.objects[ids[0]] : null;
      if (!deck) return fail("I couldn't make a deck of cards.");
    }
    const cards = Array.isArray(deck.data?.cards) ? deck.data.cards.filter(isCard) : [];
    if (!cards.length) return fail("The deck is empty. Say shuffle after collecting the cards, or spawn a new deck.");
    if (cards.length < n) {
      say(`Only ${cards.length} card${cards.length === 1 ? "" : "s"} left.`);
      n = cards.length;
    }
    const dealt = cards.slice(0, n);
    emit({ t: "set", id: deck.id, patch: { data: { ...deck.data, cards: cards.slice(n) } } });

    let surface = null;
    if (intent.place?.ref) surface = resolveRef(intent.place.ref, index);
    else if (deck.onto && work.objects[deck.onto]) surface = work.objects[deck.onto];
    else if (!deck.attach) surface = surfaceNear(deck.p, 2.5);
    let center;
    let y;
    let onto = null;
    if (surface && typeof metaFor(surface).surface === "number") {
      const meta = metaFor(surface);
      const s = surface.s || 1;
      const area = (meta.surfaceSize || [meta.size[0], meta.size[2]]).map((v) => v * s);
      const tx = head[0] - surface.p[0];
      const tz = head[2] - surface.p[2];
      const len = Math.hypot(tx, tz) || 1;
      const shift = Math.min(0.3, Math.min(area[0], area[1]) * 0.28);
      center = [surface.p[0] + (tx / len) * shift, 0, surface.p[2] + (tz / len) * shift];
      y = surface.p[1] + meta.surface * s;
      onto = surface.id;
    } else if (!deck.attach && distXZ(deck.p) <= 3) {
      const tx = head[0] - deck.p[0];
      const tz = head[2] - deck.p[2];
      const len = Math.hypot(tx, tz) || 1;
      center = [deck.p[0] + (tx / len) * 0.25, 0, deck.p[2] + (tz / len) * 0.25];
      y = deck.p[1];
    } else {
      const f = forwardOf(yaw);
      center = [head[0] + f[0] * 0.8, 0, head[2] + f[2] * 0.8];
      y = 0;
    }
    const vx = center[0] - head[0];
    const vz = center[2] - head[2];
    const vlen = Math.hypot(vx, vz) || 1;
    const across = [-vz / vlen, vx / vlen];
    let spacing = 0.075;
    if (onto) {
      const meta = metaFor(surface);
      const width = Math.min(...(meta.surfaceSize || [meta.size[0], meta.size[2]])) * (surface.s || 1) * 0.9;
      if (n * spacing > width) spacing = Math.max(0.012, width / n);
    }
    const cardMeta = metaOfPart("playing card");
    dealt.forEach((code, i) => {
      const off = (i - (n - 1) / 2) * spacing;
      const p = [r3(center[0] + across[0] * off), r3(y + 0.001 + i * 0.0005), r3(center[2] + across[1] * off)];
      const record = { id: newId("o"), part: cardMeta ? cardMeta.name : "playing card", label: cardName(code), p, ry: r3(faceYaw(p, head)), s: 1, data: { card: code, faceUp: true } };
      if (onto) record.onto = onto;
      record.by = user;
      record.t = now();
      emit({ t: "add", obj: record });
      touch(record.id);
    });
  }

  function shuffleDeck(intent) {
    const deck = intent.target ? resolveTargets(intent.target).find(isDeck) : nearest(records().filter(isDeck));
    if (!deck) return fail("There's no deck to shuffle.");
    const cards = Array.isArray(deck.data?.cards) ? deck.data.cards : [];
    emit({ t: "set", id: deck.id, patch: { data: { ...deck.data, cards: shuffle(cards, rng) } } });
    touch(deck.id);
  }

  function flip(intent) {
    let targets;
    if (intent.target) {
      targets = resolveTargets(intent.target).filter((r) => isCardRecord(r) || isDeck(r));
      if (!targets.length) {
        const any = resolveTargets(intent.target).length;
        return fail(any ? "I can only flip cards." : `I can't find ${describe(intent.target)}.`);
      }
    } else {
      targets = records().filter((r) => isCardRecord(r) && distXZ(r.p) <= FLIP_RANGE);
      if (!targets.length) targets = records().filter((r) => isDeck(r) && distXZ(r.p) <= FLIP_RANGE);
      if (!targets.length) return fail("There are no cards near you.");
    }
    for (const record of targets) {
      const data = { ...(record.data || {}), faceUp: !record.data?.faceUp };
      emit({ t: "set", id: record.id, patch: { data } });
    }
  }

  // Magic marker: { kind, speed } in record.data.behavior; "none" removes it.
  function animate(intent) {
    const raw = intent.behavior;
    const kind = lower(typeof raw === "object" && raw ? raw.kind : raw);
    if (!BEHAVIOR_KINDS.includes(kind)) return fail(`I don't know how to make things ${kind || "do that"}.`);
    const speed = r3(clamp(Number(typeof raw === "object" && raw ? raw.speed : 1) || 1, 0.1, 5));
    const targets = resolveTargets(intent.target || { ref: "it" });
    if (!targets.length) return notFound(intent.target);
    for (const record of targets) {
      const data = { ...(record.data || {}) };
      if (kind === "none") {
        if (!data.behavior) continue;
        delete data.behavior;
      } else {
        data.behavior = { kind, speed };
      }
      emit({ t: "set", id: record.id, patch: { data: Object.keys(data).length ? data : null } });
      touch(record.id);
    }
  }

  // Default: this user's latest drawing within range, else the nearest drawing.
  function erase(intent) {
    let targets;
    if (intent.target) targets = resolveTargets(intent.target);
    else {
      const drawings = records().filter((r) => r.part === "drawing" && distXZ(r.p) <= DRAWING_RANGE);
      const mine = drawings.filter((r) => r.by === user);
      const pick = mine[mine.length - 1] || nearest(drawings);
      targets = pick ? [pick] : [];
    }
    if (!targets.length) return fail(intent.target ? `I can't find ${describe(intent.target)}.` : "There's no drawing to erase.");
    emit({ t: "del", ids: targets.map((r) => r.id) });
  }

  function time(intent) {
    const value = lower(intent.value ?? intent.time);
    const t = TIMES.includes(value) ? value : TIME_ALIASES[value];
    if (!t) return fail(`I can't set the time to ${value || "that"}.`);
    emit({ t: "env", time: t });
  }

  const handlers = {
    spawn, remove, move, scale, color, hold, drop, write, deal,
    shuffle: shuffleDeck,
    flip,
    time,
    clear: () => emit({ t: "clear" }),
    undo: (intent) => {
      out.undo += clamp(Math.round(Number(intent.count) || 1), 1, 20);
    },
    say: (intent) => {
      const text = String(intent.text ?? "").trim().slice(0, 500);
      if (text) say(text);
    },
    list: () => say(listSummary(metas)),
    animate,
    erase,
  };

  list.forEach((intent, index) => {
    const handler = handlers[intent.do];
    if (RUNNER_INTENTS.has(intent.do)) {
      out.errors.push(`"${intent.do}" needs the model and is handled by the runner`);
      return;
    }
    if (!handler) {
      out.errors.push(`unknown intent "${String(intent.do).slice(0, 20)}"`);
      return;
    }
    try {
      handler(intent, index);
    } catch (err) {
      out.errors.push(`${intent.do} failed: ${err?.message || err}`);
    }
  });
  return out;
}
