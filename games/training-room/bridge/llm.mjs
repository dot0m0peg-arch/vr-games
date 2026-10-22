// Local model brain: turns a spoken command into intents (ARCHITECTURE "Intents") through Ollama
// (/api/chat with a JSON schema) or any OpenAI-compatible server (LM Studio, llama.cpp, Ollama /v1).
// Model output is data only: it is parsed, filtered to known intents and clamped, never executed.
import { matchPart } from "../js/core/lexicon.js";
import { normalizeBp } from "./parts-bin.mjs";

export const DOS = ["spawn", "remove", "move", "scale", "color", "hold", "drop", "write", "deal", "shuffle", "flip", "undo", "clear", "time", "say", "list"];
const DO_ALIASES = {
  create: "spawn", summon: "spawn", add: "spawn", make: "spawn", place: "spawn", build: "spawn", give: "spawn", conjure: "spawn",
  delete: "remove", destroy: "remove", despawn: "remove", erase: "remove", banish: "remove",
  put: "move", bring: "move", relocate: "move", resize: "scale", grow: "scale", shrink: "scale",
  paint: "color", recolor: "color", colour: "color", tint: "color", grab: "hold", pick: "hold", take: "hold",
  release: "drop", letgo: "drop", note: "write", label: "write", reply: "say", answer: "say", speak: "say",
  environment: "time", sky: "time", reset: "clear",
};
const RELS = ["front", "left", "right", "behind", "here", "feet", "hand", "on", "next", "above", "far", "at"];
const REL_ALIASES = {
  "in front": "front", forward: "front", ahead: "front", before: "front", back: "behind", "behind me": "behind",
  "on top": "on", onto: "on", top: "on", upon: "on", beside: "next", "next to": "next", near: "next", nearby: "next", by: "next",
  over: "above", "in hand": "hand", hands: "hand", held: "hand", "at feet": "feet", ground: "feet", away: "far", distance: "far", there: "front",
};
const REFS = ["it", "last", "all", "held"];
const REF_ALIASES = { that: "it", this: "it", them: "all", those: "all", these: "all", everything: "all", previous: "last" };
const TIMES = { day: "day", noon: "day", morning: "dawn", dawn: "dawn", sunrise: "dawn", sunset: "sunset", evening: "sunset", dusk: "sunset", night: "night", midnight: "night" };
const SHAPES = ["box", "sphere", "cylinder", "cone", "capsule", "torus"];
const MATS = ["matte", "wood", "metal", "glass", "glow", "stone", "fabric", "plastic"];
export const MAX_INTENTS = 30;

// ---------- JSON schema for structured output ----------
// Property order matters to grammar-constrained decoders (required first, then listed order).
export function intentSchema() {
  const num = { type: "number" };
  const str = { type: "string" };
  const vec3 = { type: "array", items: num, minItems: 3, maxItems: 3 };
  const hand = { type: "string", enum: ["left", "right"] };
  const target = {
    type: "object",
    properties: { ref: { type: "string", enum: REFS }, part: str, which: str, id: str, batch: { type: "integer" } },
  };
  const primitive = {
    type: "object",
    properties: { shape: { type: "string", enum: SHAPES }, p: vec3, s: vec3, color: str, mat: { type: "string", enum: MATS }, r: vec3 },
    required: ["shape", "p", "s", "color", "mat"],
  };
  const blueprint = {
    type: "object",
    properties: { name: str, desc: str, holdable: { type: "boolean" }, parts: { type: "array", items: primitive, minItems: 1, maxItems: 40 } },
    required: ["name", "desc", "holdable", "parts"],
  };
  const intent = {
    type: "object",
    properties: {
      do: { type: "string", enum: DOS },
      target,
      what: { type: "object", properties: { part: str, custom: blueprint, label: str } },
      count: { type: "integer" },
      place: {
        type: "object",
        properties: { rel: { type: "string", enum: RELS }, hand, dist: num, side: { type: "string", enum: ["left", "right", "front", "behind"] }, ref: target, p: vec3 },
        required: ["rel"],
      },
      color: str,
      scale: num,
      factor: num,
      text: str,
      hand,
      value: { type: "string", enum: ["day", "sunset", "night", "dawn"] },
    },
    required: ["do"],
  };
  return {
    type: "object",
    properties: { intents: { type: "array", items: intent, maxItems: MAX_INTENTS }, say: str },
    required: ["intents", "say"],
  };
}

// ---------- prompt ----------
const JOB = `You turn a spoken command from a VR player into JSON intents for "Training Room": a huge, flat, grassy field (virtual office, combat practice yard and think tank) where things appear when the player asks. Reply with JSON only: {"intents":[...],"say":"..."}.

INTENTS ("do" first; ? = optional)
spawn {do:"spawn", what:{part:"<catalog name>"} or {custom:BLUEPRINT,label:"<name>"}, count?:1-20, place?:PLACE, color?:"red" or "#rrggbb", scale?:number, text?:"<text on boards/notes/signs>"}
remove {do:"remove", target:TARGET}
move {do:"move", target:TARGET, place:PLACE}
scale {do:"scale", target:TARGET, factor:number} (2 = twice as big, 0.5 = half)
color {do:"color", target:TARGET, color:"<color>"}
hold {do:"hold", target:TARGET, hand:"left"|"right"}
drop {do:"drop", hand?:"left"|"right"}
write {do:"write", target?:TARGET, text:"<text>"}
deal {do:"deal", target?:TARGET, count:number}  shuffle {do:"shuffle", target?:TARGET}  flip {do:"flip", target?:TARGET}
undo {do:"undo", count?:number}  clear {do:"clear"} (removes everything)  list {do:"list"} (says what is around)
time {do:"time", value:"day"|"sunset"|"night"|"dawn"}
say {do:"say", text:"<answer>"} (questions, ideas, chat)

TARGET = {ref:"it"|"last"|"all"|"held"} or {part:"<name>", which?:"nearest"|"last"|"all"|"<n>"} or {id:"<id listed in the scene>"}
PLACE = {rel, hand?, dist?, side?, ref?, p?}
  rel: front|left|right|behind|far (relative to where the player looks), here, feet, hand (in the player's hand), on (on top of ref), next (beside ref; side = left|right|front|behind), above (over ref or the player), at (world point p:[x,y,z]).
  dist: meters from the player. ref: TARGET, or {batch:n} = the n-th intent (0-based) of this same reply, which must be an earlier spawn.
BLUEPRINT = {name:"<lowercase name>", desc:"<short description>", holdable:true|false, parts:[{shape, p:[x,y,z], s:[w,h,d], color:"#rrggbb", mat, r?:[rx,ry,rz]}]}
  shape: box|sphere|cylinder|cone|capsule|torus. mat: matte|wood|metal|glass|glow|stone|fabric|plastic.
  p = center of the shape in meters (y up, ground at y=0, the front faces +z). s = bounding size in meters. r = rotation in degrees (cylinder/cone/capsule stand along y).

RULES
- Use catalog names exactly as written below. Only design a custom BLUEPRINT when nothing in the catalog fits.
- Blueprints: 3 to 40 primitives, realistic real-world dimensions in meters, the lowest point at y=0, a recognizable silhouette, sensible colors. holdable only for things under 2 m that a hand can hold.
- One spawn intent per kind of object asked for; use count for several of the same thing.
- "on a X" or "on the X" when no X is in the scene: spawn X first, then the object with place {rel:"on", ref:{batch:0}} (the index of the X spawn).
- "in my hand" means place {rel:"hand"}; "in my left hand" means place {rel:"hand", hand:"left"}.
- Refer to existing things with TARGET. Never invent ids: only use ids listed in the scene.
- Questions, ideas and brainstorming (think tank): answer in "say" (or a say intent) in one or two short sentences, no markdown.
- Ignore the wake word ("AI", "hey AI"). If the command is unclear, return no intents and ask briefly in "say".
- "say" is spoken aloud: one short friendly sentence.
- Respond with JSON only.`;

const r2 = (n) => Math.round(n * 100) / 100;
const fmtSize = (size) => (Array.isArray(size) && size.length === 3 ? size.map((n) => (n >= 10 ? Math.round(n) : n >= 1 ? Math.round(n * 10) / 10 : r2(n))).join("x") : "");

export function catalogText(metas) {
  const groups = new Map();
  for (const meta of metas) {
    const category = meta.category || "custom";
    if (!groups.has(category)) groups.set(category, []);
    const aliases = (meta.aliases || []).slice(0, 2);
    const size = fmtSize(meta.size);
    const flags = [meta.holdable ? "holdable" : "", meta.surface !== undefined ? "surface" : "", meta.writable ? "writable" : "", meta.deck ? "cards" : ""].filter(Boolean);
    let line = `- ${meta.name}`;
    if (aliases.length) line += ` (${aliases.join(", ")})`;
    if (size) line += ` ${size}`;
    if (meta.desc) line += `: ${String(meta.desc).slice(0, 90)}`;
    if (flags.length) line += ` [${flags.join(", ")}]`;
    groups.get(category).push(line);
  }
  const order = ["structures", "nature", "office", "leisure", "combat", "custom"];
  const names = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 99 * (order.indexOf(a) < 0)) - (order.indexOf(b) + 99 * (order.indexOf(b) < 0)));
  return names.map((name) => `${name}:\n${groups.get(name).join("\n")}`).join("\n");
}

const DRAGON = {
  name: "dragon statue", desc: "stone dragon statue on a plinth", holdable: false,
  parts: [
    { shape: "box", p: [0, 0.25, 0], s: [1.6, 0.5, 1.2], color: "#8a8a84", mat: "stone" },
    { shape: "capsule", p: [0, 1, 0], s: [0.5, 1.1, 0.5], color: "#5d7a58", mat: "stone", r: [90, 0, 0] },
    { shape: "cylinder", p: [0, 1.4, 0.5], s: [0.22, 0.6, 0.22], color: "#5d7a58", mat: "stone", r: [35, 0, 0] },
    { shape: "box", p: [0, 1.72, 0.72], s: [0.28, 0.24, 0.45], color: "#5d7a58", mat: "stone" },
    { shape: "cone", p: [-0.08, 1.92, 0.6], s: [0.06, 0.2, 0.06], color: "#d8d2c0", mat: "stone", r: [-30, 0, 0] },
    { shape: "cone", p: [0.08, 1.92, 0.6], s: [0.06, 0.2, 0.06], color: "#d8d2c0", mat: "stone", r: [-30, 0, 0] },
    { shape: "sphere", p: [-0.1, 1.77, 0.95], s: [0.05, 0.05, 0.05], color: "#ffcc33", mat: "glow" },
    { shape: "sphere", p: [0.1, 1.77, 0.95], s: [0.05, 0.05, 0.05], color: "#ffcc33", mat: "glow" },
    { shape: "box", p: [-0.55, 1.4, -0.05], s: [0.8, 0.04, 0.6], color: "#4a6646", mat: "stone", r: [0, 0, -25] },
    { shape: "box", p: [0.55, 1.4, -0.05], s: [0.8, 0.04, 0.6], color: "#4a6646", mat: "stone", r: [0, 0, 25] },
    { shape: "cone", p: [0, 0.8, -0.85], s: [0.2, 0.8, 0.2], color: "#5d7a58", mat: "stone", r: [-70, 0, 0] },
    { shape: "cylinder", p: [-0.18, 0.62, 0.3], s: [0.14, 0.25, 0.14], color: "#5d7a58", mat: "stone" },
    { shape: "cylinder", p: [0.18, 0.62, 0.3], s: [0.14, 0.25, 0.14], color: "#5d7a58", mat: "stone" },
    { shape: "cylinder", p: [-0.18, 0.62, -0.3], s: [0.14, 0.25, 0.14], color: "#5d7a58", mat: "stone" },
    { shape: "cylinder", p: [0.18, 0.62, -0.3], s: [0.14, 0.25, 0.14], color: "#5d7a58", mat: "stone" },
  ],
};

const EMPTY = "Player: at (0, 0) facing yaw 0; right hand: empty; left hand: empty.\nScene: nothing nearby.";
// Few-shot pairs (user text, assistant JSON). Part names here must exist in the built-in catalog.
export const EXAMPLES = [
  [`${EMPTY}\nCommand: "spawn a villa to my left"`, { intents: [{ do: "spawn", what: { part: "villa" }, place: { rel: "left" } }], say: "A villa, on your left." }],
  [`${EMPTY}\nCommand: "AI spawn an axe in my hand"`, { intents: [{ do: "spawn", what: { part: "axe" }, place: { rel: "hand" } }], say: "Axe in your hand." }],
  [`${EMPTY}\nCommand: "spawn a deck of playing cards on a card table"`, {
    intents: [
      { do: "spawn", what: { part: "card table" }, place: { rel: "front", dist: 1.5 } },
      { do: "spawn", what: { part: "deck of cards" }, place: { rel: "on", ref: { batch: 0 } } },
    ],
    say: "A card table with a deck of cards.",
  }],
  [`${EMPTY}\nCommand: "spawn three training dummies in front of me"`, { intents: [{ do: "spawn", what: { part: "training dummy" }, count: 3, place: { rel: "front", dist: 4 } }], say: "Three training dummies." }],
  [`${EMPTY}\nCommand: "make it night"`, { intents: [{ do: "time", value: "night" }], say: "Night falls." }],
  [`${EMPTY}\nCommand: "summon a dragon statue over there"`, { intents: [{ do: "spawn", what: { custom: DRAGON, label: "dragon statue" }, place: { rel: "front", dist: 6 } }], say: "A stone dragon statue." }],
  [`Player: at (2, -3) facing yaw 0.5; right hand: empty; left hand: empty.\nScene: villa id o1a 14 m left; tree id o2b 8 m front.\nCommand: "remove the villa"`, { intents: [{ do: "remove", target: { part: "villa" } }], say: "The villa is gone." }],
  [`Player: at (0, 0) facing yaw 0; right hand: empty; left hand: empty.\nScene: whiteboard id o3c 3 m front.\nCommand: "write Q3 goals on the whiteboard"`, { intents: [{ do: "write", target: { part: "whiteboard" }, text: "Q3 goals" }], say: "Written on the whiteboard." }],
  [`${EMPTY}\nCommand: "give me a red sword in my left hand"`, { intents: [{ do: "spawn", what: { part: "sword" }, place: { rel: "hand", hand: "left" }, color: "red" }], say: "A red sword, left hand." }],
  [`Player: at (0, 0) facing yaw 0; right hand: empty; left hand: empty.\nScene: crate id o4d 2 m front.\nCommand: "make it twice as big and paint it blue"`, {
    intents: [{ do: "scale", target: { ref: "it" }, factor: 2 }, { do: "color", target: { ref: "it" }, color: "blue" }],
    say: "Bigger and blue.",
  }],
  [`${EMPTY}\nCommand: "what should we call our new product"`, { intents: [], say: "How about Meadow: simple, calm and easy to remember?" }],
];

function describePlayer(player, held = []) {
  const p = Array.isArray(player?.p) ? player.p : [0, 0, 0];
  const yaw = typeof player?.yaw === "number" && Number.isFinite(player.yaw) ? player.yaw : 0;
  const hand = (side) => held.filter((h) => h.hand === side).map((h) => h.label).join(", ") || "empty";
  return `Player: at (${r2(p[0])}, ${r2(p[2])}) facing yaw ${r2(yaw)}; right hand: ${hand("right")}; left hand: ${hand("left")}.`;
}

// summarize() items → "villa id o1a 14 m left; deck of cards id o2b 2 m front on o3c".
export function formatScene(items) {
  if (!Array.isArray(items)) return "";
  return items.map((item) => {
    if (!item || typeof item !== "object") return "";
    const label = String(item.label || item.part || "thing").slice(0, 60);
    let line = label;
    if (item.part && item.part !== label) line += ` (${item.part})`;
    if (item.id) line += ` id ${item.id}`;
    if (Number.isFinite(item.dist)) line += ` ${item.dist} m`;
    if (item.dir) line += ` ${item.dir}`;
    if (item.on) line += ` on ${item.on}`;
    if (item.held) line += ` held in ${item.held} hand`;
    if (item.text) line += ` text ${JSON.stringify(String(item.text).slice(0, 40))}`;
    return line;
  }).filter(Boolean).join("; ");
}

function sceneText(scene) {
  if (Array.isArray(scene)) scene = formatScene(scene);
  if (scene === undefined || scene === null || scene === "") return "nothing nearby.";
  const text = typeof scene === "string" ? scene : JSON.stringify(scene);
  return text.length > 4000 ? `${text.slice(0, 4000)} …` : text;
}

// messages: static system prompt (cache friendly), few-shot pairs, then the live request.
export function buildPrompt({ text, player, scene, held = [], metas = [], extraParts = [], catalog } = {}) {
  const system = `${JOB}\n\nCATALOG (name (aliases) size WxHxD meters: description)\n${catalog || catalogText(metas)}`;
  const messages = [{ role: "system", content: system }];
  for (const [user, assistant] of EXAMPLES) {
    messages.push({ role: "user", content: user });
    messages.push({ role: "assistant", content: JSON.stringify(assistant) });
  }
  const known = new Set(metas.map((m) => m.name));
  const extra = (extraParts || []).filter((n) => typeof n === "string" && n && !known.has(n.toLowerCase())).slice(0, 60);
  let live = `${describePlayer(player, held)}\nScene: ${sceneText(scene)}`;
  if (extra.length) live += `\nAlso available parts: ${extra.join(", ")}.`;
  live += `\nCommand: ${JSON.stringify(String(text || "").slice(0, 500))}`;
  messages.push({ role: "user", content: live });
  return messages;
}

// ---------- parsing model output ----------
function firstBalanced(text) {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

// Strips thinking tags and code fences, then parses; falls back to the first {...} block.
export function extractJSON(raw) {
  let text = String(raw ?? "");
  text = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "").replace(/<\/?(think|thinking|reasoning)>/gi, "");
  const fence = text.match(/```[a-zA-Z]*\s*([\s\S]*?)```/);
  if (fence) text = fence[1];
  text = text.trim();
  try {
    return JSON.parse(text);
  } catch {
    const block = firstBalanced(text);
    if (block !== undefined) return block;
    throw new Error("no JSON object in the model output");
  }
}

// ---------- normalizing intents ----------
const finite = (n) => typeof n === "number" && Number.isFinite(n);
const toNumber = (n) => (finite(n) ? n : typeof n === "string" && n.trim() && Number.isFinite(Number(n)) ? Number(n) : undefined);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const cleanStr = (s, max) => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const word = (s) => cleanStr(String(s ?? ""), 60).toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ").replace(/^(a|an|the|some|my)\s+/, "");

export function createMatcher(metas, extraNames = []) {
  const exact = new Map();
  for (const meta of metas) {
    for (const phrase of [meta.name, ...(meta.aliases || [])]) {
      const key = String(phrase).toLowerCase();
      if (!exact.has(key)) exact.set(key, meta.name);
    }
  }
  for (const name of extraNames) if (typeof name === "string" && name) exact.set(name.toLowerCase(), name.toLowerCase());
  // Returns { name, exact } or null.
  return (raw) => {
    const text = word(raw);
    if (!text) return null;
    if (exact.has(text)) return { name: exact.get(text), exact: true };
    const singular = text.replace(/ies$/, "y").replace(/(ch|sh|x|ss)es$/, "$1").replace(/([^s])s$/, "$1");
    if (exact.has(singular)) return { name: exact.get(singular), exact: true };
    let hit = null;
    try {
      hit = matchPart(text, metas);
    } catch {
      hit = null;
    }
    const name = typeof hit === "string" ? hit : hit?.name || hit?.meta?.name || null;
    return name ? { name, exact: false } : null;
  };
}

function normTarget(raw, match, sceneNames) {
  let t = raw;
  if (typeof t === "string") {
    const w = word(t);
    t = REFS.includes(w) || REF_ALIASES[w] ? { ref: w } : { part: w };
  }
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  if (typeof t.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(t.id)) return { id: t.id };
  const ref = typeof t.ref === "string" ? word(t.ref) : "";
  if (REFS.includes(ref)) return { ref };
  if (REF_ALIASES[ref]) return { ref: REF_ALIASES[ref] };
  const rawPart = typeof t.part === "string" ? word(t.part) : typeof t.name === "string" ? word(t.name) : ref;
  if (!rawPart) return null;
  // Custom parts already on the field win over fuzzy catalog matches ("dragon statue" ≠ "statue").
  const hit = sceneNames.has(rawPart) ? { name: rawPart } : match(rawPart);
  const out = { part: hit ? hit.name : rawPart };
  const which = typeof t.which === "string" ? word(t.which) : t.which;
  if (["nearest", "last", "all"].includes(which)) out.which = which;
  else if (toNumber(which) !== undefined && toNumber(which) >= 1) out.which = Math.min(99, Math.round(toNumber(which)));
  return out;
}

function vec3(v, lim) {
  if (!Array.isArray(v) || v.length !== 3) return undefined;
  const nums = v.map(toNumber);
  return nums.every((n) => n !== undefined) ? nums.map((n) => r2(clamp(n, -lim, lim))) : undefined;
}

function normPlace(raw, match, sceneNames, batchMap, index) {
  let pl = raw;
  if (typeof pl === "string") pl = { rel: pl };
  if (!pl || typeof pl !== "object" || Array.isArray(pl)) return undefined;
  let rel = word(pl.rel || "").replace(/^(to the|to my|my|the)\s+/, "");
  rel = RELS.includes(rel) ? rel : REL_ALIASES[rel];
  if (!rel) return undefined;
  const out = { rel };
  const hand = word(pl.hand || "");
  if (hand === "left" || hand === "right") out.hand = hand;
  const dist = toNumber(pl.dist);
  if (dist !== undefined) out.dist = r2(clamp(dist, 0, 300));
  const side = word(pl.side || "");
  if (["left", "right", "front", "behind"].includes(side)) out.side = side;
  if (pl.ref !== undefined && pl.ref !== null) {
    const batch = toNumber(pl.ref?.batch);
    if (batch !== undefined) {
      const mapped = batchMap.get(Math.round(batch));
      if (mapped !== undefined && mapped < index) out.ref = { batch: mapped };
    } else {
      const target = normTarget(pl.ref, match, sceneNames);
      if (target) out.ref = target;
    }
  }
  const p = vec3(pl.p, 1000);
  if (p) out.p = p;
  if (rel === "at" && !out.p) return undefined;
  return out;
}

function normColor(value) {
  const text = cleanStr(value, 32).toLowerCase();
  return /^(#[0-9a-f]{3}|#[0-9a-f]{6}|[a-z][a-z -]{1,30})$/.test(text) ? text : undefined;
}

// Raw model JSON → { intents, say } with only known actions, catalog names and clamped numbers.
// sceneNames: part names/labels present in the room (custom parts the catalog does not know).
export function normalizeOutput(raw, { metas = [], extraNames = [], sceneNames = new Set(), match = createMatcher(metas, extraNames) } = {}) {
  let list = [];
  let say = "";
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === "object") {
    if (Array.isArray(raw.intents)) list = raw.intents;
    else if (raw.intents && typeof raw.intents === "object") list = [raw.intents];
    else if (typeof raw.do === "string") list = [raw];
    say = cleanStr(raw.say, 400);
  }
  const intents = [];
  const batchMap = new Map(); // original index -> output index (for place.ref.batch)
  for (let i = 0; i < list.length && intents.length < MAX_INTENTS; i++) {
    const intent = normIntent(list[i], { match, sceneNames, batchMap, index: intents.length });
    if (!intent) continue;
    batchMap.set(i, intents.length);
    intents.push(intent);
  }
  return { intents, say };
}

function normIntent(item, { match, sceneNames, batchMap, index }) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  let action = word(item.do || item.action || item.intent || "").replace(/\s+/g, "");
  action = DOS.includes(action) ? action : DO_ALIASES[action];
  if (!action) return null;
  const out = { do: action };
  const target = () => normTarget(item.target ?? item.ref ?? item.part ?? null, match, sceneNames);
  const count = (lo, hi) => {
    const n = toNumber(item.count);
    return n === undefined ? undefined : clamp(Math.round(n), lo, hi);
  };
  switch (action) {
    case "spawn": {
      const what = normWhat(item, match);
      if (!what) return null;
      out.what = what;
      const n = count(1, 20);
      if (n !== undefined && n > 1) out.count = n;
      const place = normPlace(item.place ?? item.where, match, sceneNames, batchMap, index);
      if (place) out.place = place;
      const color = normColor(item.color);
      if (color) out.color = color;
      const scale = toNumber(item.scale ?? item.size);
      if (scale !== undefined && scale > 0) out.scale = r2(clamp(scale, 0.05, 20));
      const text = cleanStr(item.text, 500);
      if (text) out.text = text;
      return out;
    }
    case "remove":
    case "shuffle":
    case "flip": {
      const t = target();
      if (t) out.target = t;
      else if (action === "remove") return null;
      return out;
    }
    case "move": {
      const t = target();
      const place = normPlace(item.place ?? item.where, match, sceneNames, batchMap, index);
      if (!t || !place) return null;
      return { ...out, target: t, place };
    }
    case "scale": {
      const t = target() || { ref: "it" };
      const factor = toNumber(item.factor ?? item.scale);
      if (factor === undefined || factor <= 0) return null;
      return { ...out, target: t, factor: r2(clamp(factor, 0.05, 20)) };
    }
    case "color": {
      const t = target() || { ref: "it" };
      const color = normColor(item.color ?? item.value);
      return color ? { ...out, target: t, color } : null;
    }
    case "hold": {
      const t = target();
      if (!t) return null;
      out.target = t;
      const hand = word(item.hand || "");
      if (hand === "left" || hand === "right") out.hand = hand;
      return out;
    }
    case "drop": {
      const hand = word(item.hand || "");
      if (hand === "left" || hand === "right") out.hand = hand;
      return out;
    }
    case "write": {
      const text = cleanStr(item.text ?? item.value, 500);
      if (!text) return null;
      const t = item.target !== undefined ? target() : null;
      if (t) out.target = t;
      out.text = text;
      return out;
    }
    case "deal": {
      const t = item.target !== undefined ? target() : null;
      if (t) out.target = t;
      out.count = count(1, 52) ?? 5;
      return out;
    }
    case "undo": {
      const n = count(1, 20);
      if (n !== undefined) out.count = n;
      return out;
    }
    case "time": {
      const value = TIMES[word(item.value ?? item.time ?? "")];
      return value ? { ...out, value } : null;
    }
    case "say": {
      const text = cleanStr(item.text ?? item.value, 400);
      return text ? { ...out, text } : null;
    }
    default:
      return out; // clear, list
  }
}

function normWhat(item, match) {
  let what = item.what ?? item.part ?? item.object ?? item.item;
  if (typeof what === "string") what = { part: what };
  if (!what || typeof what !== "object" || Array.isArray(what)) what = {};
  const custom = what.custom ?? what.blueprint ?? item.custom ?? item.blueprint;
  const label = cleanStr(what.label, 48);
  if (custom && typeof custom === "object") {
    const draft = { ...custom, name: custom.name || label || what.part || "custom part" };
    const result = normalizeBp(draft);
    if (result.ok) {
      const name = String(result.blueprint.name || draft.name).toLowerCase().slice(0, 48);
      return { custom: { ...result.blueprint, name }, label: label || name };
    }
  }
  const raw = word(what.part ?? what.name ?? label ?? "");
  if (!raw) return null;
  const hit = match(raw);
  if (hit?.exact) return label && label.toLowerCase() !== hit.name ? { part: hit.name, label } : { part: hit.name };
  // Fuzzy or unknown: keep the spoken name as the label so "dragon statue" is not just "statue".
  if (hit) return { part: hit.name, label: label || raw };
  return { part: raw, label: label || raw };
}

// ---------- model servers ----------
const NOT_CHAT = /(embed|bge-|minilm|rerank|whisper|tts|clip|e5-|gte-)/i;

export function pickModel(names, preferred = "") {
  const list = names.filter((n) => typeof n === "string" && n);
  if (preferred) {
    const want = preferred.toLowerCase();
    const found = list.find((n) => n.toLowerCase() === want || n.toLowerCase() === `${want}:latest` || n.toLowerCase().replace(/:latest$/, "") === want);
    return found || null;
  }
  const usable = list.filter((n) => !NOT_CHAT.test(n));
  return usable.find((n) => /coder/i.test(n)) || usable.find((n) => /qwen/i.test(n)) || usable[0] || null;
}

function versionBelow(version, min) {
  const a = String(version || "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  }
  return false;
}

function upstreamError(status, body) {
  const err = new Error(body.error);
  err.status = status;
  err.body = body;
  return err;
}

const trimSlash = (url) => String(url || "").replace(/\/+$/, "");

// One chat completion. Returns { content, model }. Throws errors with .status/.body.
export async function callModel({ provider = "ollama", url, model, messages, schema = intentSchema(), think = false, numCtx = 8192, apiKey = "", signal, fetchImpl = globalThis.fetch }) {
  const base = trimSlash(url);
  const post = async (path, body) => {
    const headers = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await fetchImpl(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal });
    return { res, text: await res.text() };
  };
  let body;
  let path;
  if (provider === "openai") {
    path = "/chat/completions";
    body = { model, messages, temperature: 0.1, stream: false, response_format: { type: "json_schema", json_schema: { name: "intents", schema, strict: false } } };
    if (think === false) body.reasoning_effort = "none";
  } else {
    path = "/api/chat";
    body = { model, messages, stream: false, format: schema, options: { temperature: 0.1, num_ctx: numCtx }, keep_alive: "30m" };
    if (typeof think === "boolean") body.think = think;
  }
  let { res, text } = await post(path, body);
  // Older servers or models without a thinking switch reject the field: retry once without it.
  if (res.status === 400 && /think|reasoning/i.test(text) && ("think" in body || "reasoning_effort" in body)) {
    delete body.think;
    delete body.reasoning_effort;
    ({ res, text } = await post(path, body));
  }
  if (res.status === 404) throw upstreamError(503, { error: "no-model", detail: `model "${model}" not found: ${text.slice(0, 200)}` });
  if (!res.ok) throw upstreamError(502, { error: "model-error", detail: `${res.status} ${text.slice(0, 300)}` });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw upstreamError(502, { error: "bad-output", raw: text.slice(0, 500) });
  }
  const content = provider === "openai" ? json.choices?.[0]?.message?.content : json.message?.content;
  return { content: typeof content === "string" ? content : "", model: json.model || model };
}

export class LocalModel {
  constructor(config = {}, { log = console, fetchImpl = globalThis.fetch, timeoutMs = 25000, cacheMs = 60000 } = {}) {
    this.log = log;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cacheMs = cacheMs;
    this.configure(config);
  }

  configure(config) {
    this.provider = config.provider === "openai" ? "openai" : "ollama";
    this.url = trimSlash(this.provider === "openai" ? config.openaiUrl || "http://127.0.0.1:1234/v1" : config.ollamaUrl || "http://127.0.0.1:11434");
    this.preferred = String(config.model || "").trim();
    this.think = typeof config.think === "boolean" ? config.think : null;
    this.numCtx = Number.isInteger(config.numCtx) && config.numCtx >= 2048 ? config.numCtx : 8192;
    this.apiKey = String(config.openaiKey || "");
    this.available = false;
    this.name = null;
    this.models = [];
    this.detail = "";
    this.version = null;
    this.checkedAt = 0;
    this.checking = null;
  }

  status() {
    const out = { available: this.available, name: this.name, provider: this.provider };
    if (this.detail) out.detail = this.detail;
    return out;
  }

  // Lists installed models (cached for cacheMs) and picks one.
  refresh(force = false) {
    if (!force && Date.now() - this.checkedAt < this.cacheMs) return Promise.resolve(this.status());
    if (this.checking) return this.checking;
    this.checking = this.doRefresh().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  async doRefresh() {
    const signal = AbortSignal.timeout(4000);
    try {
      const res = await this.fetch(this.provider === "openai" ? `${this.url}/models` : `${this.url}/api/tags`, {
        signal,
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.models = this.provider === "openai"
        ? (json.data || []).map((m) => m.id).filter(Boolean)
        : (json.models || []).map((m) => m.name || m.model).filter(Boolean);
      this.name = pickModel(this.models, this.preferred);
      this.available = !!this.name;
      this.detail = this.available ? "" : this.preferred
        ? `model "${this.preferred}" is not installed${this.provider === "ollama" ? ` (ollama pull ${this.preferred})` : ""}`
        : this.provider === "ollama" ? "Ollama has no models yet (try: ollama pull qwen2.5-coder:7b)" : "the server lists no models";
      if (this.available && this.provider === "ollama" && this.version === null) {
        try {
          const v = await (await this.fetch(`${this.url}/api/version`, { signal: AbortSignal.timeout(2000) })).json();
          this.version = String(v.version || "");
          if (this.version && versionBelow(this.version, "0.31.2")) {
            this.detail = `Ollama ${this.version} is old; 0.31.2+ fixes JSON output with thinking off`;
          }
        } catch {
          this.version = "";
        }
      }
    } catch (err) {
      this.available = false;
      this.name = this.preferred || null;
      const label = this.provider === "openai" ? "OpenAI-compatible server" : "Ollama";
      this.detail = `${label} not reachable at ${this.url} (${err.cause?.code || err.name || err.message})`;
    }
    this.checkedAt = Date.now();
    return this.status();
  }

  // Full command round trip. ctx: { player, scene, parts }, held: [{ hand, label }], metas: catalog.
  // Returns { intents, say, source, model, ms }; throws errors with .status/.body.
  async command({ text, ctx = {}, held = [], scene, metas = [], catalog, sceneNames = new Set(), match, signal } = {}) {
    const started = Date.now();
    await this.refresh();
    if (!this.available && Date.now() - this.checkedAt > 3000) await this.refresh(true);
    if (!this.available) throw upstreamError(503, { error: "no-model", detail: this.detail });
    const extraParts = Array.isArray(ctx.parts) ? ctx.parts.filter((n) => typeof n === "string") : [];
    const messages = buildPrompt({ text, player: ctx.player, scene: scene ?? ctx.scene, held, metas, extraParts, catalog });
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let out;
    try {
      out = await callModel({
        provider: this.provider, url: this.url, model: this.name, messages, think: this.think, numCtx: this.numCtx,
        apiKey: this.apiKey, signal: combined, fetchImpl: this.fetch,
      });
    } catch (err) {
      if (err.status) {
        if (err.body?.error === "no-model") this.checkedAt = 0;
        throw err;
      }
      if (timeout.aborted) throw upstreamError(504, { error: "timeout", detail: `the model took longer than ${this.timeoutMs / 1000} s` });
      if (signal?.aborted) throw upstreamError(499, { error: "aborted" });
      this.available = false;
      this.checkedAt = 0;
      this.detail = `not reachable at ${this.url} (${err.cause?.code || err.message})`;
      throw upstreamError(503, { error: "no-model", detail: this.detail });
    }
    let parsed;
    try {
      parsed = extractJSON(out.content);
    } catch {
      throw upstreamError(502, { error: "bad-output", raw: String(out.content).slice(0, 500) });
    }
    const usable = parsed && typeof parsed === "object" && (Array.isArray(parsed) || Array.isArray(parsed.intents) || typeof parsed.say === "string" || typeof parsed.do === "string" || (parsed.intents && typeof parsed.intents === "object"));
    if (!usable) throw upstreamError(502, { error: "bad-output", raw: String(out.content).slice(0, 500) });
    const { intents, say } = normalizeOutput(parsed, { metas, extraNames: extraParts, sceneNames, match });
    return { intents, say, source: "model", model: out.model, ms: Date.now() - started };
  }
}
