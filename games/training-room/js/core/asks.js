// What a spoken request asks for, before any model sees it: chatter that asks for nothing, things
// that are not objects ("give me an idea"), and category words ("furniture") that mean a few
// concrete things.
import { getMeta } from "../parts/meta/index.js";
import { normalizeText } from "./lexicon.js";

// Category word (singular, as the parser leaves it) → concrete things, catalog parts first.
export const CATEGORY_WORDS = {
  furniture: ["couch", "armchair", "coffee table", "bookshelf", "floor lamp", "rug"],
  weapon: ["sword", "axe", "bow", "spear", "shield", "mace"],
  tool: ["axe", "shovel", "hammer", "bucket", "saw"],
  decoration: ["potted plant", "rug", "floor lamp", "statue", "flowers", "picture frame"],
  toy: ["ball", "dice", "basketball", "teddy bear"],
  food: ["apple", "pizza", "sandwich"],
};
const PLURALS = { weapon: "weapons", tool: "tools", decoration: "decorations", toy: "toys" };
const MASS = new Set(["furniture", "food"]);
const CATEGORY_MAX_DESIGNS = 3;

// Chatter: every word is filler ("bye bye", "but...", "a.", "my hand", "okay cool"). Anything with
// a real word in it ("dragon", "bigger", "one more") still goes to the model.
const FILLER = new Set([
  "a", "an", "the", "and", "but", "or", "so", "um", "uh", "erm", "hmm", "mm", "oh", "ah", "huh", "eh",
  "hi", "hey", "hello", "bye", "goodbye", "thanks", "thank", "you", "ok", "okay", "yes", "yeah", "yep",
  "no", "nope", "nah", "cool", "nice", "great", "good", "awesome", "wow", "whoa", "oops", "sorry",
  "lol", "haha", "ha", "right", "sure", "well", "alright", "fine", "my", "your", "his", "her", "our",
  "their", "it", "this", "that", "hand", "hands", "i", "me", "we", "like", "just", "really", "very",
]);
export function isChatter(text, parsed) {
  if (parsed?.intents?.length) return false;
  const raw = String(text || "").trim();
  if (/\?\s*$/.test(raw)) return false;
  const words = normalizeText(raw).split(" ").filter(Boolean);
  return words.length <= 6 && words.every((w) => FILLER.has(w));
}

// Not objects: asked for in words ("give me an idea for the party", "make a wish"), never designed.
const ABSTRACT = new Set([
  "idea", "plan", "list", "wish", "hug", "reason", "name", "story", "joke", "hint", "tip", "advice",
  "suggestion", "answer", "summary", "quote", "poem", "word", "number", "example", "question",
  "minute", "moment", "second", "chance", "break", "call", "update", "report", "overview", "recap",
  "outline", "agenda", "schedule", "strategy", "slogan", "title", "description", "explanation",
  "brainstorm", "opinion", "thought", "fact", "riddle", "song", "recipe", "rundown", "breakdown",
  "pitch", "task", "reminder", "favor", "favour", "clue", "guess", "hand", "sec", "lesson", "speech",
  "definition",
]);
// The head noun decides: "an idea" is not an object, a "hand grenade" or a "name tag" is.
export function isThing(label) {
  const words = normalizeText(String(label || "")).split(" ").filter(Boolean);
  return words.length > 0 && !ABSTRACT.has(words[words.length - 1]);
}

// Spawn intents for a category word → concrete things: one for "a weapon", the number asked for
// ("two weapons"), a few for "some weapons" or "furniture", at most CATEGORY_MAX_DESIGNS of them
// designed. Later intents follow what they meant: a place on it goes to the first concrete thing,
// an edit of it ("paint them red") applies to each.
const SINGULAR = Object.fromEntries(Object.entries(PLURALS).map(([one, many]) => [many, one]));
export function expandCategories(intents, text = "") {
  const said = ` ${normalizeText(String(text || ""))} `;
  const out = [];
  const where = []; // old intent index → its new indexes
  for (const intent of intents) {
    const what = intent?.do === "spawn" ? intent.what || {} : null;
    const raw = what && !what.custom && !(what.part && getMeta(what.part)) ? normalizeText(what.label || what.part || "") : "";
    const key = CATEGORY_WORDS[raw] ? raw : SINGULAR[raw];
    if (!key) {
      where.push([out.length]);
      out.push(intent);
      continue;
    }
    const items = CATEGORY_WORDS[key];
    const asked = Number.isInteger(intent.count) && intent.count > 1 ? Math.min(intent.count, items.length) : 0;
    const many = asked > 0 || MASS.has(key) || raw !== key || said.includes(` ${PLURALS[key] || key} `);
    const known = items.filter((name) => getMeta(name));
    const designs = items.filter((name) => !getMeta(name)).slice(0, CATEGORY_MAX_DESIGNS);
    const pick = asked ? [...known, ...designs].slice(0, asked) : many ? [...known, ...designs]
      : [known.length ? known[Math.floor(Math.random() * known.length)] : items[0]];
    const { count, ...rest } = intent;
    where.push(pick.map((_, i) => out.length + i));
    for (const name of pick) out.push({ ...rest, what: getMeta(name) ? { part: getMeta(name).name } : { label: name } });
  }
  // An edit of a category ("paint them red") becomes one per concrete thing; refs then point at
  // final positions, which those copies shift.
  const targetsOf = (intent) => (intent.do !== "spawn" && Number.isInteger(intent.target?.batch) && where[intent.target.batch]) || null;
  const start = [];
  let next = 0;
  for (const intent of out) {
    start.push(next);
    next += targetsOf(intent)?.length || 1;
  }
  const final = (batch) => (where[batch] ? start[where[batch][0]] : batch);
  const remapped = [];
  for (const intent of out) {
    const ref = intent.place?.ref;
    const place = ref && Number.isInteger(ref.batch) ? { ...intent.place, ref: { ...ref, batch: final(ref.batch) } } : intent.place;
    const targets = targetsOf(intent);
    if (targets) {
      for (const i of targets) remapped.push({ ...intent, ...(place ? { place } : {}), target: { ...intent.target, batch: start[i] } });
      continue;
    }
    const target = Number.isInteger(intent.target?.batch) ? { ...intent.target, batch: final(intent.target.batch) } : intent.target;
    remapped.push({ ...intent, ...(place ? { place } : {}), ...(target ? { target } : {}) });
  }
  return remapped;
}
