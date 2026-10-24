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
export function isThing(label) {
  const words = normalizeText(String(label || "")).split(" ").filter(Boolean);
  return words.length > 0 && !words.some((w) => ABSTRACT.has(w));
}

// Spawn intents for a category word → concrete things: one for "a weapon", a few for "some
// weapons" or "furniture", at most CATEGORY_MAX_DESIGNS of them designed. Later { batch: n } refs
// follow the intents they meant (the first concrete thing stands for its category).
export function expandCategories(intents, text = "") {
  const said = ` ${normalizeText(String(text || ""))} `;
  const out = [];
  const where = []; // old intent index → new index
  for (const intent of intents) {
    const what = intent?.do === "spawn" ? intent.what || {} : null;
    const raw = what && !what.custom && !(what.part && getMeta(what.part)) ? normalizeText(what.label || what.part || "") : "";
    const items = CATEGORY_WORDS[raw];
    where.push(out.length);
    if (!items) {
      out.push(intent);
      continue;
    }
    const many = MASS.has(raw) || (intent.count || 1) > 1 || said.includes(` ${PLURALS[raw] || raw} `) || /\b(some|several|few|lots|bunch|all)\b/.test(said);
    const known = items.filter((name) => getMeta(name));
    const pick = many ? [...known, ...items.filter((name) => !getMeta(name)).slice(0, CATEGORY_MAX_DESIGNS)]
      : [known.length ? known[Math.floor(Math.random() * known.length)] : items[0]];
    const { count, ...rest } = intent;
    for (const name of pick) out.push({ ...rest, what: getMeta(name) ? { part: getMeta(name).name } : { label: name } });
  }
  const remap = (ref) => (ref && typeof ref === "object" && Number.isInteger(ref.batch) && where[ref.batch] !== undefined ? { ...ref, batch: where[ref.batch] } : ref);
  return out.map((intent) => {
    let next = intent;
    if (intent.place?.ref?.batch !== undefined) next = { ...next, place: { ...next.place, ref: remap(next.place.ref) } };
    if (intent.target?.batch !== undefined) next = { ...next, target: remap(next.target) };
    return next;
  });
}
