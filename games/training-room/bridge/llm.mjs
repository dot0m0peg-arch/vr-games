// Local model brain: turns a spoken command into intents (ARCHITECTURE "Intents") through Ollama
// (/api/chat with a JSON schema) or any OpenAI-compatible server (LM Studio, llama.cpp, Ollama /v1),
// and guesses what a magic-marker drawing shows (a vision model looks at the image; otherwise the
// text model reads it as ASCII art). Model output is data only: it is parsed, filtered and clamped,
// never executed.
import { matchPart, singularize, normalizeText } from "../js/core/lexicon.js";
import { normalizeBp } from "./parts-bin.mjs";

export const DOS = ["spawn", "remove", "move", "scale", "color", "hold", "drop", "write", "deal", "shuffle", "flip", "undo", "clear", "time", "say", "list", "animate", "realize", "guess", "correct"];
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
// One command never needs more; small models otherwise repeat the same intent until the limit.
export const MAX_INTENTS = 10;

// Answer length per call: a command (things it lacks are designed by their own call), a drawing's guess, one design.
export const ANSWER_TOKENS = { command: 900, interpret: 2200, design: 1800 };
// A design is one thing on the spot: enough shapes to be recognizable, few enough to arrive fast.
export const DESIGN_PARTS = 24;

// ---------- JSON schema for structured output ----------
// Property order matters to grammar-constrained decoders (required first, then listed order).
function blueprintSchema() {
  const num = { type: "number" };
  const str = { type: "string" };
  const vec3 = { type: "array", items: num, minItems: 3, maxItems: 3 };
  const primitive = {
    type: "object",
    properties: { shape: { type: "string", enum: SHAPES }, p: vec3, s: vec3, color: str, mat: { type: "string", enum: MATS }, r: vec3 },
    required: ["shape", "p", "s", "color", "mat"],
  };
  return {
    type: "object",
    properties: { name: str, desc: str, holdable: { type: "boolean" }, parts: { type: "array", items: primitive, minItems: 1, maxItems: 40 } },
    required: ["name", "desc", "holdable", "parts"],
  };
}

// One object designed on the spot: a blueprint plus the line the AI says about it.
export function designSchema() {
  const bp = blueprintSchema();
  bp.properties.parts = { ...bp.properties.parts, maxItems: DESIGN_PARTS };
  return { type: "object", properties: { ...bp.properties, say: { type: "string" } }, required: [...bp.required, "say"] };
}

export function intentSchema() {
  const num = { type: "number" };
  const str = { type: "string" };
  const vec3 = { type: "array", items: num, minItems: 3, maxItems: 3 };
  const hand = { type: "string", enum: ["left", "right"] };
  const target = {
    type: "object",
    properties: { ref: { type: "string", enum: REFS }, part: str, which: str, id: str, batch: { type: "integer" } },
  };
  const intent = {
    type: "object",
    properties: {
      do: { type: "string", enum: DOS },
      target,
      what: { type: "object", properties: { part: str, label: str } },
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
      behavior: { type: "string", enum: ["swim", "fly", "walk", "hop", "roll", "spin", "float", "bounce", "sway", "none"] },
      hint: str,
      label: str,
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
spawn {do:"spawn", what:{part:"<catalog name>"} or {label:"<what it is>"} (anything the catalog lacks), count?:1-20, place?:PLACE, color?:"red" or "#rrggbb", scale?:number, text?:"<text on boards/notes/signs>"}
remove {do:"remove", target:TARGET}
move {do:"move", target:TARGET, place:PLACE}
scale {do:"scale", target:TARGET, factor:number} (2 = twice as big, 0.5 = half)
color {do:"color", target:TARGET, color:"<color>"}
hold {do:"hold", target:TARGET, hand:"left"|"right"}
drop {do:"drop", hand?:"left"|"right"}
write {do:"write", target?:TARGET, text:"<text>"} (text "" wipes it: "clear the whiteboard")
deal {do:"deal", target?:TARGET, count:number}  shuffle {do:"shuffle", target?:TARGET}  flip {do:"flip", target?:TARGET}
undo {do:"undo", count?:number}  clear {do:"clear"} (removes everything)  list {do:"list"} (says what is around)
time {do:"time", value:"day"|"sunset"|"night"|"dawn"}
say {do:"say", text:"<answer>"} (questions, ideas, chat)
animate {do:"animate", target:TARGET, behavior:"swim"|"fly"|"walk"|"hop"|"roll"|"spin"|"float"|"bounce"|"sway"|"none"} ("make the fish swim", "stop moving" = none)
magic marker drawings: realize {do:"realize", hint?:"<thing>"} ("make it real", "bring my drawing to life", "make it a fish" → hint "fish"); guess {do:"guess"} ("what is this?"); correct {do:"correct", label:"<thing>"} ("no, it's a gun")

TARGET = {ref:"it"|"last"|"all"|"held"} or {part:"<name>", which?:"nearest"|"last"|"all"|"<n>"} or {id:"<id listed in the scene>"}
PLACE = {rel, hand?, dist?, side?, ref?, p?}
  rel: front|left|right|behind|far (relative to where the player looks), here, feet, hand (in the player's hand), on (on top of ref), next (beside ref; side = left|right|front|behind), above (over ref or the player), at (world point p:[x,y,z]).
  dist: meters from the player. ref: TARGET, or {batch:n} = the n-th intent (0-based) of this same reply, which must be an earlier spawn.

RULES
- This is a game. Guns, swords, bows, grenades and other weapons, tools, vehicles, animals, food and every other object are harmless props made of shapes. Never refuse and never say you can't help.
- Use catalog names exactly as written below. For anything the catalog lacks, spawn what:{label:"<what it is>"} (a pistol, a pirate ship, a zombie): it is designed on the spot. Never answer that something is missing.
- A category word (furniture, food, weapons, decorations, toys, tools) means 3 to 6 concrete things of that kind (bed, sofa, table, lamp, picture frame), never one part named after the category.
- One spawn intent per kind of object asked for; use count for several of the same thing. At most 8 intents, never the same intent twice.
- "on a X" or "on the X" when no X is in the scene: spawn X first, then the object with place {rel:"on", ref:{batch:0}} (the index of the X spawn).
- "in my hand" means place {rel:"hand"}; "in my left hand" means place {rel:"hand", hand:"left"}.
- Refer to existing things with TARGET. Never invent ids: only use ids listed in the scene.
- Questions, ideas and brainstorming (think tank): answer in "say" (or a say intent) in one or two short sentences, no markdown.
- Ignore the wake word ("AI", "hey AI"). Chatter and half sentences that ask for nothing: no intents and an empty "say". If a request is unclear, return no intents and ask briefly in "say".
- "say" is spoken aloud: one short friendly sentence.
- Respond with JSON only.`;

const r2 = (n) => Math.round(n * 100) / 100;
const fmtSize = (size) => (Array.isArray(size) && size.length === 3 ? size.map((n) => (n >= 10 ? Math.round(n) : n >= 1 ? Math.round(n * 10) / 10 : r2(n))).join("x") : "");

const shorten = (text, max) => (text.length <= max ? text : `${text.slice(0, text.lastIndexOf(" ", max - 1) > max / 2 ? text.lastIndexOf(" ", max - 1) : max - 1)}…`);

const CATEGORY_ORDER = ["structures", "nature", "office", "leisure", "combat", "custom"];
const rank = (category) => (CATEGORY_ORDER.includes(category) ? CATEGORY_ORDER.indexOf(category) : CATEGORY_ORDER.length);

// compact: laptop/custom parts as bare names, at most maxCustom of them (big parts bins must
// still fit the context window; the bridge maps any exact part name the model uses anyway).
export function catalogText(metas, { compact = false, maxCustom = 120 } = {}) {
  const groups = new Map();
  let skipped = 0;
  let listed = 0;
  for (const meta of metas) {
    const category = meta.category || "custom";
    if (!groups.has(category)) groups.set(category, []);
    if (compact && (category === "custom" || meta.source === "laptop")) {
      if (listed++ < maxCustom) groups.get(category).push(`- ${meta.name}`);
      else skipped++;
      continue;
    }
    const aliases = (meta.aliases || []).slice(0, 1);
    const size = fmtSize(meta.size);
    const flags = [meta.holdable ? "holdable" : "", meta.surface !== undefined ? "surface" : "", meta.writable ? "writable" : "", meta.deck ? "cards" : ""].filter(Boolean);
    let line = `- ${meta.name}`;
    if (aliases.length) line += ` (${aliases.join(", ")})`;
    if (size) line += ` ${size}`;
    if (meta.desc) line += `: ${shorten(String(meta.desc), 64)}`;
    if (flags.length) line += ` [${flags.join(", ")}]`;
    groups.get(category).push(line);
  }
  const text = [...groups.keys()].sort((a, b) => rank(a) - rank(b)).filter((name) => groups.get(name).length).map((name) => `${name}:\n${groups.get(name).join("\n")}`).join("\n");
  return skipped ? `${text}\n(and ${skipped} more saved parts: use the name the player says)` : text;
}

const EMPTY = "Player: at (0, 0) facing yaw 0; hands empty.\nScene: nothing nearby.";
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
  [`${EMPTY}\nCommand: "AI give me a machine gun and put a dragon statue over there"`, {
    intents: [
      { do: "spawn", what: { label: "machine gun" }, place: { rel: "hand" } },
      { do: "spawn", what: { label: "dragon statue" }, place: { rel: "front", dist: 6 } },
    ],
    say: "A machine gun for you and a dragon statue over there.",
  }],
  [`Player: at (2, -3) facing yaw 0.5; hands empty.\nScene: villa id o1a 14 m left; tree id o2b 8 m front.\nCommand: "remove the villa"`, { intents: [{ do: "remove", target: { part: "villa" } }], say: "The villa is gone." }],
  [`Player: at (0, 0) facing yaw 0; hands empty.\nScene: whiteboard id o3c 3 m front.\nCommand: "write Q3 goals on the whiteboard"`, { intents: [{ do: "write", target: { part: "whiteboard" }, text: "Q3 goals" }], say: "Written on the whiteboard." }],
  [`${EMPTY}\nCommand: "give me a red sword in my left hand"`, { intents: [{ do: "spawn", what: { part: "sword" }, place: { rel: "hand", hand: "left" }, color: "red" }], say: "A red sword, left hand." }],
  [`Player: at (0, 0) facing yaw 0; hands empty.\nScene: crate id o4d 2 m front.\nCommand: "make it twice as big and paint it blue"`, {
    intents: [{ do: "scale", target: { ref: "it" }, factor: 2 }, { do: "color", target: { ref: "it" }, color: "blue" }],
    say: "Bigger and blue.",
  }],
  [`${EMPTY}\nCommand: "what should we call our new product"`, { intents: [], say: "How about Meadow: simple, calm and easy to remember?" }],
];

function describePlayer(player, held = []) {
  const p = Array.isArray(player?.p) ? player.p : [0, 0, 0];
  const yaw = typeof player?.yaw === "number" && Number.isFinite(player.yaw) ? player.yaw : 0;
  const hand = (side) => held.filter((h) => h.hand === side).map((h) => h.label).join(", ") || "empty";
  const hands = held.length ? `right hand: ${hand("right")}; left hand: ${hand("left")}` : "hands empty";
  return `Player: at (${r2(p[0])}, ${r2(p[2])}) facing yaw ${r2(yaw)}; ${hands}.`;
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

function sceneText(scene, max = 3000) {
  if (Array.isArray(scene)) scene = formatScene(scene);
  if (scene === undefined || scene === null || scene === "") return "nothing nearby.";
  const text = typeof scene === "string" ? scene : JSON.stringify(scene);
  return text.length > max ? `${text.slice(0, max)} …` : text;
}

// Rough token estimate (JSON-heavy English averages a bit over 3 characters per token).
const tokens = (messages) => Math.ceil(messages.reduce((n, m) => n + m.content.length + 8, 0) / 3.2);
// Few-shot examples dropped first when the prompt would not fit (the first three are kept).
const DROP_ORDER = [10, 9, 8, 7, 6, 3, 4, 5];

// messages: static system prompt (cache friendly), few-shot pairs, then the live request.
// numCtx: the model context; about 2200 tokens stay free for the answer.
export function buildPrompt({ text, player, scene, held = [], metas = [], extraParts = [], catalog, numCtx = 8192 } = {}) {
  const known = new Set(metas.map((m) => m.name));
  const extra = (extraParts || []).filter((n) => typeof n === "string" && n && !known.has(n.toLowerCase())).slice(0, 60);
  const command = `\nCommand: ${JSON.stringify(String(text || "").slice(0, 500))}`;
  const liveText = (sceneMax) => {
    let live = `${describePlayer(player, held)}\nScene: ${sceneText(scene, sceneMax)}`;
    if (extra.length) live += `\nAlso available parts: ${extra.join(", ")}.`;
    return live + command;
  };
  const build = (catalogString, examples, sceneMax) => {
    const messages = [{ role: "system", content: `${JOB}\n\nCATALOG (name (alias) size WxHxD meters: description)\n${catalogString}` }];
    for (const [user, assistant] of examples) {
      messages.push({ role: "user", content: user });
      messages.push({ role: "assistant", content: JSON.stringify(assistant) });
    }
    messages.push({ role: "user", content: liveText(sceneMax) });
    return messages;
  };
  const budget = Math.max(2048, numCtx - 2200);
  let catalogString = catalog || catalogText(metas);
  let examples = EXAMPLES;
  let messages = build(catalogString, examples, 3000);
  if (tokens(messages) <= budget) return messages;
  catalogString = catalogText(metas, { compact: true });
  messages = build(catalogString, examples, 3000);
  for (const index of DROP_ORDER) {
    if (tokens(messages) <= budget) return messages;
    examples = examples.filter((pair) => pair !== EXAMPLES[index]);
    messages = build(catalogString, examples, 3000);
  }
  return tokens(messages) <= budget ? messages : build(catalogString, examples, 800);
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
    const words = text.split(" ");
    const singular = [...words.slice(0, -1), singularize(words[words.length - 1])].join(" ");
    if (exact.has(singular)) return { name: exact.get(singular), exact: true };
    let hit = null;
    try {
      hit = matchPart(text, metas);
    } catch {
      hit = null;
    }
    const name = typeof hit === "string" ? hit : hit?.name || hit?.meta?.name || null;
    if (!name) return null;
    // A match that covers every spoken word is as good as exact ("battle axes", "pine trees").
    let total = words.length;
    try {
      total = normalizeText(text).split(" ").filter(Boolean).length;
    } catch {
      // keep the plain word count
    }
    const whole = typeof hit === "object" && hit.start === 0 && hit.end === total && hit.score >= 0.95;
    // head: the part name ends on the last word ("big red ball" → ball, but not "tree house" → tree).
    const head = typeof hit === "object" && hit.end === total && hit.score >= 0.9;
    return { name, exact: whole, head };
  };
}

// batchMap/index: given for intent targets, so { batch: n } can name a part spawned earlier in this command.
function normTarget(raw, match, sceneNames, batchMap, index) {
  let t = raw;
  if (typeof t === "number") t = { batch: t };
  if (typeof t === "string") {
    const w = word(t);
    t = REFS.includes(w) || REF_ALIASES[w] ? { ref: w } : { part: w };
  }
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  if (typeof t.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(t.id)) return { id: t.id };
  if (batchMap && toNumber(t.batch) !== undefined) {
    const mapped = batchMap.get(Math.round(toNumber(t.batch)));
    return mapped !== undefined && mapped < index ? { batch: mapped } : null;
  }
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
  const phrase = word(pl.rel || "").replace(/^(to the|to my|my|the)\s+/, "");
  // "left side", "behind the player": fall back to the first placement word in the phrase.
  const rel = RELS.includes(phrase) ? phrase : REL_ALIASES[phrase] || phrase.split(" ").map((w) => (RELS.includes(w) ? w : REL_ALIASES[w])).find(Boolean);
  if (!rel) return undefined;
  const out = { rel };
  const hand = word(pl.hand || "");
  if (hand === "left" || hand === "right") out.hand = hand;
  const dist = toNumber(pl.dist);
  if (dist !== undefined) out.dist = r2(clamp(dist, 0, 300));
  const side = word(pl.side || "");
  if (["left", "right", "front", "behind"].includes(side)) out.side = side;
  if (pl.ref !== undefined && pl.ref !== null) {
    const batch = toNumber(typeof pl.ref === "number" ? pl.ref : pl.ref?.batch);
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
  // A small model stuck in a loop repeats one intent many times: a run of three or more identical
  // intents counts once (two in a row may be meant: "undo, undo").
  const repeatOf = new Map(); // index -> first index of its run
  for (let i = 0; i < list.length;) {
    const key = JSON.stringify(list[i]);
    let j = i + 1;
    while (j < list.length && JSON.stringify(list[j]) === key) j++;
    if (j - i >= 3) for (let k = i + 1; k < j; k++) repeatOf.set(k, i);
    i = j;
  }
  for (let i = 0; i < list.length && intents.length < MAX_INTENTS; i++) {
    if (repeatOf.has(i)) {
      if (batchMap.has(repeatOf.get(i))) batchMap.set(i, batchMap.get(repeatOf.get(i)));
      continue;
    }
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
  const target = () => normTarget(item.target ?? item.ref ?? item.part ?? null, match, sceneNames, batchMap, index);
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
      // Empty text wipes a board or note.
      const text = cleanStr(item.text ?? item.value, 500) || "";
      if (!text && item.target === undefined) return null;
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
    case "animate": {
      const kind = word(item.behavior?.kind ?? item.behavior ?? item.value ?? "");
      if (!BEHAVIORS.includes(kind) && kind !== "none") return null;
      const t = target();
      return { ...out, target: t || { ref: "it" }, behavior: kind };
    }
    case "realize": {
      const hint = cleanStr(item.hint ?? item.label ?? item.value, 48);
      return hint ? { ...out, hint } : out;
    }
    case "correct": {
      const label = cleanStr(item.label ?? item.hint ?? item.value, 48);
      return label ? { ...out, label } : null;
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
  // A label alone is something the catalog lacks: it is designed, so "dragon statue" is not a statue.
  const labelOnly = what.part == null && what.name == null;
  // Fuzzy or unknown: keep the spoken name as the label so "dragon statue" is not just "statue".
  if (hit && !labelOnly) return { part: hit.name, label: label || raw };
  return { part: raw, label: label || raw };
}

// ---------- magic marker: a drawing becomes a real thing ----------
export const BEHAVIORS = ["swim", "fly", "walk", "hop", "roll", "spin", "float", "bounce", "sway", "none"];
const BEHAVIOR_ALIASES = {
  swimming: "swim", swims: "swim", flying: "fly", flies: "fly", flap: "fly", flapping: "fly", glide: "fly", gliding: "fly",
  walking: "walk", walks: "walk", run: "walk", running: "walk", runs: "walk", crawl: "walk", crawling: "walk", trot: "walk",
  hopping: "hop", hops: "hop", jump: "hop", jumping: "hop", jumps: "hop", rolling: "roll", rolls: "roll", drive: "roll", driving: "roll",
  spinning: "spin", spins: "spin", rotate: "spin", rotating: "spin", turn: "spin", floating: "float", floats: "float", hover: "float",
  hovering: "float", drift: "float", drifting: "float", bouncing: "bounce", bounces: "bounce", swaying: "sway", sways: "sway",
  wave: "sway", waving: "sway", wiggle: "sway", still: "none", static: "none", idle: "none", nothing: "none", stand: "none", sit: "none",
};
// Vision model names; used only when the server cannot report capabilities (Ollama /api/show).
export const VISION_NAME = /vl|vision|llava|gemma3|gemma4|minicpm-v|moondream|qwen2\.5vl|qwen3-vl|llama3\.2-vision/i;
// When several vision models are installed: the ones that read sketches best first.
const VISION_RANK = [/qwen[\d.]*-?vl/i, /gemma[34]/i, /minicpm-v/i, /llama3\.2-vision/i, /llava/i];

export function interpretSchema() {
  const str = { type: "string" };
  return {
    type: "object",
    properties: {
      guess: str,
      confidence: { type: "number" },
      part: str,
      blueprint: blueprintSchema(),
      behavior: { type: "string", enum: BEHAVIORS },
      say: str,
    },
    required: ["guess", "confidence", "part", "behavior", "say"],
  };
}

const SNAIL = {
  name: "snail", desc: "garden snail with a brown shell", holdable: false,
  parts: [
    { shape: "capsule", p: [0, 0.08, 0], s: [0.16, 0.6, 0.18], color: "#c9b48a", mat: "matte", r: [0, 0, 90] },
    { shape: "sphere", p: [-0.05, 0.28, 0], s: [0.36, 0.36, 0.16], color: "#a0522d", mat: "matte" },
    { shape: "cylinder", p: [0.26, 0.24, 0.04], s: [0.02, 0.14, 0.02], color: "#c9b48a", mat: "matte" },
    { shape: "cylinder", p: [0.26, 0.24, -0.04], s: [0.02, 0.14, 0.02], color: "#c9b48a", mat: "matte" },
  ],
};

const MARKER_JOB = `A player in a VR sandbox drew something in the air with a magic marker, like Harold and the Purple Crayon or ChalkZone. Look at the drawing and guess honestly what it depicts — do not flatter bad drawings: if it looks like a fish, say fish. Then make it real.
Reply with JSON only: {"guess":"...","confidence":0.5,"part":"...","blueprint":{...},"behavior":"...","say":"..."}

FIELDS
guess: what the drawing shows, a short noun phrase ("house", "rocket", "smiling sun").
confidence: 0 to 1, how sure you are.
part: the exact catalog name when a catalog part matches the guess well, else "".
blueprint: only when part is "": a BLUEPRINT of the guess. Size the primitives so the object's width and height roughly match the drawing size in meters, ground at y=0.
behavior: what that thing would naturally do: swim|fly|walk|hop|roll|spin|float|bounce|sway|none (fish swim, birds fly, dogs walk, frogs hop, cars roll, balls bounce, clouds float, trees sway, houses none).
say: one short, warm, funny line naming the guess, spoken aloud (e.g. "That's clearly a fish. Go on, little fish!").

BLUEPRINT = {name:"<lowercase name>", desc:"<short description>", holdable:true|false, parts:[{shape, p:[x,y,z], s:[w,h,d], color:"#rrggbb", mat, r?:[rx,ry,rz]}]}
  shape: box|sphere|cylinder|cone|capsule|torus. mat: matte|wood|metal|glass|glow|stone|fabric|plastic.
  p = center of the shape in meters (y up, ground at y=0, the front faces +z). s = bounding size in meters. r = rotation in degrees (cylinder/cone/capsule stand along y).
  3 to 40 primitives, a recognizable silhouette, sensible colors.

RULES
- Judge the drawing as drawn: name what it most looks like, even when the player probably meant something else. Air sketches are rough, so read the overall shape rather than single wobbly lines.
- If the player's words name a thing ("a fish", "make it a fish", "it's a gun"), skip guessing and build that thing (confidence 1).
- Use catalog names exactly as written below. Only design a BLUEPRINT when nothing in the catalog fits.
- Respond with JSON only.

EXAMPLE ANSWERS
${JSON.stringify({ guess: "ball", confidence: 0.8, part: "ball", behavior: "bounce", say: "A ball! Boing, boing, boing." })}
${JSON.stringify({ guess: "snail", confidence: 0.6, part: "", blueprint: SNAIL, behavior: "walk", say: "A snail! Take your time, little buddy." })}`;

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

// stats: sketchStats() → "3 strokes, 240 points, 1 closed shape, aspect 1.5 (width / height)".
function statsText(stats) {
  if (!stats || typeof stats !== "object") return "";
  const out = [];
  const n = (v) => (finite(v) && v >= 0 ? Math.round(v) : undefined);
  if (n(stats.strokes) !== undefined) out.push(plural(n(stats.strokes), "stroke"));
  if (n(stats.points) !== undefined) out.push(plural(n(stats.points), "point"));
  if (typeof stats.closed === "boolean") out.push(stats.closed ? "a closed outline" : "open lines");
  else if (n(stats.closed) !== undefined) out.push(plural(n(stats.closed), "closed shape"));
  if (finite(stats.aspect) && stats.aspect > 0) out.push(`aspect ${r2(stats.aspect)} (width / height)`);
  return out.join(", ");
}

// messages for one drawing: static system prompt with the catalog, then the drawing.
// vision: the drawing goes along as an image (attachImage); otherwise as ASCII art in the text.
export function buildInterpretPrompt({ ascii = "", stats = {}, size = null, hint = "", extraParts = [], metas = [], catalog, vision = false, numCtx = 8192 } = {}) {
  const known = new Set(metas.map((m) => m.name));
  const extra = (extraParts || []).filter((n) => typeof n === "string" && n && !known.has(n.toLowerCase())).slice(0, 60);
  const w = Array.isArray(size) && finite(size[0]) ? size[0] : stats?.width;
  const h = Array.isArray(size) && finite(size[1]) ? size[1] : stats?.height;
  const lines = [];
  if (vision) lines.push("The drawing is in the attached image (drawn in the air, seen from the front).");
  else lines.push("The drawing as ASCII art (drawn in the air, seen from the front; # is ink, dots and spaces are empty):", "```", String(ascii).replace(/`/g, "'"), "```");
  const facts = statsText(stats);
  lines.push(`Size: ${finite(w) && finite(h) ? `about ${r2(w)} m wide and ${r2(h)} m tall` : "unknown"}.${facts ? ` ${facts[0].toUpperCase()}${facts.slice(1)}.` : ""}`);
  if (extra.length) lines.push(`Also available parts: ${extra.join(", ")}.`);
  const words = cleanStr(hint, 200);
  lines.push(words ? `Player's words: ${JSON.stringify(words)}` : "Player's words: none (guess from the drawing).");
  const user = lines.join("\n");
  const build = (catalogString) => [
    { role: "system", content: `${MARKER_JOB}\n\nCATALOG (name (alias) size WxHxD meters: description)\n${catalogString}` },
    { role: "user", content: user },
  ];
  // Room for the answer (and the image) stays free; a tight context gets a names-only catalog.
  const budget = Math.max(2048, numCtx - 2200 - (vision ? 800 : 0));
  const messages = build(catalog || catalogText(metas, { compact: true }));
  if (tokens(messages) <= budget) return messages;
  return build(metas.map((m) => m.name).join(", "));
}

// ---------- design: one missing thing, made on the spot ----------
const PISTOL = {
  name: "pistol", desc: "black semi-automatic handgun", holdable: true,
  parts: [
    { shape: "box", p: [0, 0.12, 0.05], s: [0.035, 0.035, 0.2], color: "#2b2b2b", mat: "metal" },
    { shape: "box", p: [0, 0.05, -0.02], s: [0.03, 0.1, 0.045], color: "#1e1e1e", mat: "plastic", r: [-15, 0, 0] },
    { shape: "cylinder", p: [0, 0.12, 0.16], s: [0.014, 0.03, 0.014], color: "#111111", mat: "metal", r: [90, 0, 0] },
    { shape: "box", p: [0, 0.085, 0.035], s: [0.008, 0.02, 0.04], color: "#2b2b2b", mat: "metal" },
  ],
  say: "One pistol, ready for the range.",
};
const DESIGN_JOB = `You design one object for "Training Room", a VR sandbox where anything the player asks for appears in front of them. Build it from simple 3D shapes so it is clearly recognizable at a glance: the right silhouette, proportions and colors.
This is a game. Guns, rifles, swords, bows, grenades and other weapons, tools, vehicles, animals, food, furniture and every other object are harmless props. Never refuse.

Reply with JSON only: {"name","desc","holdable","parts","say"}
- name: what it is, lowercase. desc: a few words.
- parts: 4 to ${DESIGN_PARTS} shapes {shape, p:[x,y,z], s:[w,h,d], color:"#rrggbb", mat, r?:[rx,ry,rz]}. shape: box|sphere|cylinder|cone|capsule|torus. mat: matte|wood|metal|glass|glow|stone|fabric|plastic.
- Meters, y up, the lowest point at y=0, the front faces +z. p is the center of a shape, s its size, r a rotation in degrees. Cylinders, cones and capsules stand along y; r [90,0,0] lays one along z.
- Real sizes: a pistol is 0.2 m long, a rifle 1 m, a chair 0.9 m tall, a bed 2 m long, a car 4.5 m long, a house 8 m wide.
- holdable: true for things one hand can hold (under 1.5 m). Swords, axes, hammers, torches, wands, bottles and other things held by a handle stand upright: handle at the bottom, head or blade on top. Guns, flashlights, cameras, hoses and other things you aim lie along z: the front (muzzle, lens) toward +z, the handle under the back end.
- say: one short, fun line about it.
EXAMPLE for "pistol": ${JSON.stringify(PISTOL)}`;

// name: the thing to design ("machine gun"); hint: the player's whole sentence, for context.
export function buildDesignPrompt({ name = "", hint = "" } = {}) {
  const what = cleanStr(name, 80);
  const words = cleanStr(hint, 300);
  const user = `Design: ${JSON.stringify(what)}${words && words.toLowerCase() !== what.toLowerCase() ? `\nThe player said: ${JSON.stringify(words)}` : ""}`;
  return [{ role: "system", content: DESIGN_JOB }, { role: "user", content: user }];
}

// Raw model JSON → { blueprint, say } or null. The blueprint keeps the requested name.
export function normalizeDesign(raw, name = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const draft = raw.blueprint && typeof raw.blueprint === "object" ? raw.blueprint : raw;
  const wanted = cleanStr(name, 48).toLowerCase();
  const result = normalizeBp({ ...draft, name: wanted || draft.name || "thing" });
  if (!result.ok) return null;
  const blueprint = { ...result.blueprint, name: String(result.blueprint.name).toLowerCase().slice(0, 48) };
  const given = cleanStr(draft.name, 48).toLowerCase();
  if (given && given !== blueprint.name && !blueprint.aliases.includes(given)) blueprint.aliases = [...blueprint.aliases, given].slice(0, 8);
  let say = cleanStr(raw.say, 200).replace(/\s+/g, " ");
  if (!say) say = `${withArticle(blueprint.name)[0].toUpperCase()}${withArticle(blueprint.name).slice(1)}, made just for you.`;
  return { blueprint, say };
}

// The drawing as an image on the user message, in the provider's format.
export function attachImage(message, dataUrl, provider = "ollama") {
  const url = String(dataUrl || "");
  if (provider === "openai") return { role: message.role, content: [{ type: "text", text: message.content }, { type: "image_url", image_url: { url } }] };
  return { ...message, images: [url.slice(url.indexOf(",") + 1)] };
}

export function pickVisionModel(names, textModel = null) {
  const list = names.filter((n) => typeof n === "string" && n && !NOT_CHAT.test(n));
  if (textModel && list.includes(textModel)) return textModel; // one model for both: nothing extra to load
  for (const re of VISION_RANK) {
    const hit = list.find((n) => re.test(n));
    if (hit) return hit;
  }
  return list[0] || null;
}

const withArticle = (noun) => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;

// Raw model JSON → { guess, confidence, part, blueprint?, behavior, say } or null when unusable.
// part is a catalog name (exact, or the guess's head noun) or ""; blueprint only when part is "".
export function normalizeInterpret(raw, { metas = [], extraNames = [], match = createMatcher(metas, extraNames) } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let guess = word(raw.guess ?? raw.label ?? raw.name ?? raw.what ?? "");
  let part = "";
  const rawPart = typeof raw.part === "string" ? word(raw.part) : "";
  if (rawPart && !["none", "null", "n/a", "custom", "blueprint"].includes(rawPart)) {
    const hit = match(rawPart);
    if (hit && (hit.exact || hit.head)) part = hit.name;
  }
  if (!part && guess) {
    const hit = match(guess);
    if (hit?.exact) part = hit.name;
  }
  let blueprint;
  const draft = raw.blueprint ?? raw.custom;
  if (!part && draft && typeof draft === "object") {
    const result = normalizeBp({ ...draft, name: draft.name || guess || "doodle" });
    if (result.ok) blueprint = { ...result.blueprint, name: String(result.blueprint.name).toLowerCase().slice(0, 48) };
  }
  if (!guess) guess = part || blueprint?.name || "";
  if (!guess) return null;
  let confidence = toNumber(raw.confidence);
  if (confidence === undefined) confidence = 0.5;
  else if (confidence > 1 && confidence <= 100) confidence /= 100; // "85" meant 85 %
  confidence = r2(clamp(confidence, 0, 1));
  const kind = word(raw.behavior ?? raw.behaviour ?? raw.motion ?? "").replace(/\s+/g, "");
  const behavior = BEHAVIORS.includes(kind) ? kind : BEHAVIOR_ALIASES[kind] || "none";
  let say = cleanStr(raw.say ?? raw.text, 400).replace(/\s+/g, " ");
  if (!say) say = `That looks like ${withArticle(guess)}!`;
  say = shorten(say, 160);
  const out = { guess, confidence, part };
  if (blueprint) out.blueprint = blueprint;
  out.behavior = behavior;
  out.say = say;
  return out;
}

// ---------- model servers ----------
const NOT_CHAT = /(embed|bge-|minilm|rerank|whisper|tts|clip|e5-|gte-)/i;
const SHOW_CACHE_MS = 10 * 60000;

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
// Messages may carry images: Ollama `images: [base64]`, OpenAI-compatible `image_url` content parts.
export async function callModel({ provider = "ollama", url, model, messages, schema = intentSchema(), schemaName = "intents", temperature = 0.1, think = false, numCtx = 8192, numPredict = 0, apiKey = "", signal, fetchImpl = globalThis.fetch }) {
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
    body = { model, messages, temperature, stream: false, response_format: { type: "json_schema", json_schema: { name: schemaName, schema, strict: false } } };
    if (numPredict > 0) body.max_tokens = numPredict;
    if (think === false) body.reasoning_effort = "none";
  } else {
    path = "/api/chat";
    body = { model, messages, stream: false, format: schema, options: { temperature, num_ctx: numCtx, ...(numPredict > 0 ? { num_predict: numPredict } : {}) }, keep_alive: "30m" };
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
  // timeoutMs: text model calls; visionTimeoutMs: calls with a drawing image (vision models are slower).
  constructor(config = {}, { log = console, fetchImpl = globalThis.fetch, timeoutMs = 25000, visionTimeoutMs = 45000, cacheMs = 60000 } = {}) {
    this.log = log;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.visionTimeoutMs = visionTimeoutMs;
    this.cacheMs = cacheMs;
    this.configure(config);
  }

  configure(config) {
    this.provider = config.provider === "openai" ? "openai" : "ollama";
    this.url = trimSlash(this.provider === "openai" ? config.openaiUrl || "http://127.0.0.1:1234/v1" : config.ollamaUrl || "http://127.0.0.1:11434");
    this.preferred = String(config.model || "").trim();
    this.visionPreferred = String(config.visionModel || "").trim();
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
    this.vision = null; // vision model for drawings, or null
    this.showCache = new Map(); // model name → { caps, at, ttl } from /api/show
    this.noVision = new Map(); // model name → time until which it is not tried with images again
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
      await this.detectVision();
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
      this.vision = null;
      const label = this.provider === "openai" ? "OpenAI-compatible server" : "Ollama";
      this.detail = `${label} not reachable at ${this.url} (${err.cause?.code || err.name || err.message})`;
    }
    this.checkedAt = Date.now();
    return this.status();
  }

  // Picks the vision model: config.visionModel, else an installed model whose capabilities include
  // "vision" (Ollama /api/show), else (no capability info) a model whose name looks like one.
  async detectVision() {
    if (this.visionPreferred) {
      this.vision = pickModel(this.models, this.visionPreferred);
      return this.vision;
    }
    const names = this.models.filter((n) => !NOT_CHAT.test(n) && !(this.noVision.get(n) > Date.now()));
    const flags = await Promise.all(names.map(async (name) => {
      const caps = this.provider === "ollama" ? await this.capabilities(name) : null;
      return caps ? caps.includes("vision") : VISION_NAME.test(name);
    }));
    this.vision = pickVisionModel(names.filter((_, i) => flags[i]), this.name);
    return this.vision;
  }

  // Ollama /api/show → ["completion", "vision", …], or null when the server cannot say.
  // Cached per model for 10 minutes (failures for cacheMs).
  async capabilities(name) {
    const hit = this.showCache.get(name);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.caps;
    let caps = null;
    try {
      const res = await this.fetch(`${this.url}/api/show`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(3000),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json && typeof json === "object") {
        if (Array.isArray(json.capabilities)) caps = json.capabilities.map((c) => String(c).toLowerCase());
        else if (json.projector_info || (json.details?.families || []).some((f) => /clip|mllama/i.test(f))) caps = ["completion", "vision"];
      }
    } catch {
      caps = null;
    }
    this.showCache.set(name, { caps, at: Date.now(), ttl: caps ? SHOW_CACHE_MS : this.cacheMs });
    return caps;
  }

  // One model call with the bridge's timeout and error mapping → { parsed, content, model }.
  // Throws errors with .status/.body: 503 no-model, 502 model-error/bad-output, 504 timeout, 499 aborted.
  async ask({ model = this.name, messages, schema, schemaName, temperature, numPredict = 0, timeoutMs = this.timeoutMs, signal }) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let out;
    try {
      out = await callModel({
        provider: this.provider, url: this.url, model, messages, schema, schemaName, temperature, think: this.think, numCtx: this.numCtx, numPredict,
        apiKey: this.apiKey, signal: combined, fetchImpl: this.fetch,
      });
    } catch (err) {
      if (err.status) {
        if (err.body?.error === "no-model") this.checkedAt = 0;
        throw err;
      }
      if (timeout.aborted) throw upstreamError(504, { error: "timeout", detail: `the model took longer than ${timeoutMs / 1000} s` });
      if (signal?.aborted) throw upstreamError(499, { error: "aborted" });
      this.available = false;
      this.checkedAt = 0;
      this.detail = `not reachable at ${this.url} (${err.cause?.code || err.message})`;
      throw upstreamError(503, { error: "no-model", detail: this.detail });
    }
    try {
      return { parsed: extractJSON(out.content), content: out.content, model: out.model };
    } catch {
      throw upstreamError(502, { error: "bad-output", raw: String(out.content).slice(0, 500) });
    }
  }

  // Full command round trip. ctx: { player, scene, parts }, held: [{ hand, label }], metas: catalog.
  // Returns { intents, say, source, model, ms }; throws errors with .status/.body.
  async command({ text, ctx = {}, held = [], scene, metas = [], catalog, sceneNames = new Set(), match, signal } = {}) {
    const started = Date.now();
    await this.refresh();
    if (!this.available && Date.now() - this.checkedAt > 3000) await this.refresh(true);
    if (!this.available) throw upstreamError(503, { error: "no-model", detail: this.detail });
    const extraParts = Array.isArray(ctx.parts) ? ctx.parts.filter((n) => typeof n === "string") : [];
    const messages = buildPrompt({ text, player: ctx.player, scene: scene ?? ctx.scene, held, metas, extraParts, catalog, numCtx: this.numCtx });
    const out = await this.ask({ messages, numPredict: ANSWER_TOKENS.command, signal });
    const parsed = out.parsed;
    const usable = parsed && typeof parsed === "object" && (Array.isArray(parsed) || Array.isArray(parsed.intents) || typeof parsed.say === "string" || typeof parsed.do === "string" || (parsed.intents && typeof parsed.intents === "object"));
    if (!usable) throw upstreamError(502, { error: "bad-output", raw: String(out.content).slice(0, 500) });
    const matcher = extraParts.length || !match ? createMatcher(metas, extraParts) : match;
    const { intents, say } = normalizeOutput(parsed, { metas, sceneNames, match: matcher });
    return { intents, say, source: "model", model: out.model, ms: Date.now() - started };
  }

  // Magic marker round trip: what does the drawing show, and how does it come alive?
  // image: PNG data URL for a vision model; ascii/stats/size: the drawing as text for any model.
  // hint: the player's words ("make it a fish"). parts: extra part names the client knows.
  // Returns { guess, confidence, part, blueprint?, behavior, say, source, model, vision, ms }.
  async interpret({ image = null, ascii = "", stats = {}, size = null, hint = "", parts = [], metas = [], catalog, match, signal } = {}) {
    const started = Date.now();
    await this.refresh();
    if (!this.available && Date.now() - this.checkedAt > 3000) await this.refresh(true);
    if (!this.available) throw upstreamError(503, { error: "no-model", detail: this.detail });
    const extraParts = (Array.isArray(parts) ? parts : []).filter((n) => typeof n === "string" && n).slice(0, 200);
    const matcher = extraParts.length || !match ? createMatcher(metas, extraParts) : match;
    const hasAscii = typeof ascii === "string" && /\S/.test(ascii);
    const run = async (visionName) => {
      let messages = buildInterpretPrompt({ ascii, stats, size, hint, extraParts, metas, catalog, vision: !!visionName, numCtx: this.numCtx });
      if (visionName) messages = [messages[0], attachImage(messages[1], image, this.provider)];
      const out = await this.ask({
        model: visionName || this.name, messages, schema: interpretSchema(), schemaName: "interpret", temperature: 0.3, numPredict: ANSWER_TOKENS.interpret,
        timeoutMs: visionName ? this.visionTimeoutMs : this.timeoutMs, signal,
      });
      const result = normalizeInterpret(out.parsed, { match: matcher });
      if (!result) throw upstreamError(502, { error: "bad-output", raw: String(out.content).slice(0, 500) });
      return { ...result, source: "model", model: out.model, vision: !!visionName, ms: Date.now() - started };
    };
    const visionName = image ? this.vision : null;
    if (visionName) {
      try {
        return await run(visionName);
      } catch (err) {
        // A vision model that vanished or refuses images (a name-based guess): read the ASCII art instead.
        const code = err.body?.error;
        if (!hasAscii || (code !== "no-model" && code !== "model-error")) throw err;
        this.log.warn?.(`[model] ${visionName} could not look at the drawing (${err.body?.detail || code}); reading it as ASCII art`);
        if (code === "model-error") this.noVision.set(visionName, Date.now() + SHOW_CACHE_MS);
        this.vision = null;
        this.checkedAt = 0;
        if (code === "no-model") {
          await this.refresh(true);
          if (!this.available) throw upstreamError(503, { error: "no-model", detail: this.detail });
        }
      }
    }
    if (!hasAscii) throw upstreamError(400, { error: "no-sketch", detail: image ? "no vision model is installed and the drawing has no ASCII art" : "send image or ascii" });
    return run(null);
  }

  // One missing thing designed on the spot ("give me a machine gun" and the catalog has none).
  // Returns { blueprint, say, source, model, ms }; throws errors with .status/.body.
  async design({ name = "", hint = "", signal } = {}) {
    const started = Date.now();
    if (!cleanStr(name, 80)) throw upstreamError(400, { error: "no-name", detail: "send the name of the thing to design" });
    await this.refresh();
    if (!this.available && Date.now() - this.checkedAt > 3000) await this.refresh(true);
    if (!this.available) throw upstreamError(503, { error: "no-model", detail: this.detail });
    const out = await this.ask({
      messages: buildDesignPrompt({ name, hint }), schema: designSchema(), schemaName: "design", temperature: 0.4,
      numPredict: ANSWER_TOKENS.design, signal,
    });
    const result = normalizeDesign(out.parsed, name);
    if (!result) throw upstreamError(502, { error: "bad-output", raw: String(out.content).slice(0, 500) });
    return { ...result, source: "model", model: out.model, ms: Date.now() - started };
  }
}
