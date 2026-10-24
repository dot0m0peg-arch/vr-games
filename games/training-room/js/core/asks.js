// What a spoken request asks for, before any model sees it: chatter that asks for nothing, and
// category words ("furniture") that mean a few concrete things.
import { getMeta } from "../parts/meta/index.js";
import { normalizeText } from "./lexicon.js";

// A category word means a few concrete things; unknown ones are designed on the spot.
export const CATEGORY_WORDS = {
  furniture: ["couch", "armchair", "coffee table", "bookshelf", "floor lamp", "rug"],
  weapons: ["sword", "axe", "bow", "spear", "shield", "mace"],
  weapon: ["sword", "axe", "bow", "spear", "shield", "mace"],
  tools: ["axe", "shovel", "hammer", "bucket", "saw"],
  decorations: ["potted plant", "rug", "floor lamp", "statue", "flowers", "picture frame"],
  toys: ["ball", "dice", "basketball", "teddy bear"],
  food: ["apple", "pizza", "sandwich"],
};
const CATEGORY_MAX_DESIGNS = 3;

// Chatter the AI should not spend a minute on ("bye bye", "but...", "a.", "my hand"): short
// fragments that are neither a question nor a request.
const ASKS = /^(what|who|why|how|when|where|which|can|could|should|would|will|is|are|am|do|does|did|tell|give|make|spawn|summon|build|put|place|show|help|explain|name|let|bring|get|create|draw|turn|move|remove|delete|clear|deal|shuffle|flip|paint|color|grow|shrink|undo|write|add|set|change|play|spin|throw)\b/;
export function isChatter(text, parsed) {
  if (parsed?.intents?.length) return false;
  const raw = String(text || "").trim();
  const words = normalizeText(raw).split(" ").filter(Boolean);
  if (!words.length) return true;
  if (/\?\s*$/.test(raw) || ASKS.test(words[0])) return false;
  return words.length <= 4;
}

// Spawn intents for a category word ("furniture") → concrete things, at most a few designs.
export function expandCategories(intents) {
  const out = [];
  for (const intent of intents) {
    const label = intent?.do === "spawn" && !intent.what?.part && !intent.what?.custom ? normalizeText(intent.what?.label || "") : "";
    const items = CATEGORY_WORDS[label];
    if (!items) {
      out.push(intent);
      continue;
    }
    let designs = 0;
    for (const name of items) {
      const known = getMeta(name);
      if (!known && designs >= CATEGORY_MAX_DESIGNS) continue;
      if (!known) designs++;
      const { count, ...rest } = intent;
      out.push({ ...rest, what: known ? { part: known.name } : { label: name } });
    }
  }
  return out;
}
