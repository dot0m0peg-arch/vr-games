// Kingdom mode rules: advisors you address by title, and a realm report computed from the room.
// Pure (no window, document or three.js) so tests and the bridge can import it.
import { stripWake } from "./wake.js";
import { normalizeText } from "./lexicon.js";

// Each advisor answers to several titles. The first title is how replies are signed.
export const ADVISORS = [
  {
    id: "builder", title: "Builder", name: "Master Builder", topic: "advice",
    words: ["builder", "master builder", "architect", "mason", "foreman", "carpenter"],
    tunic: "#9a6a3a", hat: "hood",
    acks: ["As you command, my liege.", "It shall be built.", "My masons are on it.", "Right away, sire."],
  },
  {
    id: "steward", title: "Steward", name: "Lord Steward", topic: "all",
    words: ["steward", "lord steward", "treasurer", "chancellor", "chamberlain", "reeve"],
    tunic: "#2f5a8a", hat: "crown",
    acks: ["Very good, my liege.", "I shall see it done.", "Noted in the ledger, sire.", "At once, my liege."],
  },
  {
    id: "marshal", title: "Marshal", name: "Marshal of the Realm", topic: "defense",
    words: ["marshal", "general", "commander", "captain", "knight"],
    tunic: "#7a1f2b", hat: "helm",
    acks: ["By your order, sire.", "The men will see to it.", "Consider it done, my liege.", "Aye, sire."],
  },
];

// Addressing the whole council goes to the steward.
const COUNCIL_WORDS = ["advisor", "advisors", "my advisor", "my advisors", "council", "my council"];

export const ADVISOR_WORDS = [...new Set([...ADVISORS.flatMap((a) => a.words), ...COUNCIL_WORDS])];

export function getAdvisor(id) {
  return ADVISORS.find((a) => a.id === id) || null;
}

// "Builder, put a house here" → { advisor, rest }. Without an advisor title: { advisor: null, rest: text }.
export function addressAdvisor(text) {
  for (const advisor of ADVISORS) {
    const hit = stripWake(text, advisor.words);
    if (hit.matched) return { advisor, rest: hit.rest };
  }
  const council = stripWake(text, COUNCIL_WORDS);
  if (council.matched) return { advisor: ADVISORS[1], rest: council.rest };
  return { advisor: null, rest: String(text ?? "").trim() };
}

// What each part adds to the realm. Parts not listed add nothing.
export const WORTH = {
  castle: { homes: 20, food: 0, gold: 6, defense: 15, faith: 0 },
  house: { homes: 6 }, cabin: { homes: 4 }, villa: { homes: 10, gold: 2 }, tent: { homes: 2 }, tavern: { homes: 4, gold: 5 },
  "farm field": { food: 10 }, windmill: { food: 8 }, barn: { food: 4 }, "hay bale": { food: 1 }, well: { food: 2 },
  pond: { food: 2 }, "market stall": { food: 2, gold: 6 }, blacksmith: { gold: 4, defense: 2 },
  wall: { defense: 3 }, tower: { defense: 4 }, barricade: { defense: 1 }, sandbags: { defense: 1 }, catapult: { defense: 5 },
  cannon: { defense: 5 }, "weapon rack": { defense: 1 }, "suit of armor": { defense: 1 },
  chapel: { faith: 10 }, statue: { faith: 2 }, fountain: { faith: 1, food: 1 }, flag: { faith: 1 },
};

// → { homes, food, gold, defense, faith, buildings, peasants, castle }
export function kingdomStats(records) {
  const out = { homes: 0, food: 0, gold: 0, defense: 0, faith: 0, buildings: 0, peasants: 0, castle: false };
  for (const r of records || []) {
    if (!r || r.attach) continue;
    if (r.part === "peasant") {
      out.peasants++;
      continue;
    }
    const worth = WORTH[r.part];
    if (!worth) continue;
    out.buildings++;
    if (r.part === "castle") out.castle = true;
    for (const key of ["homes", "food", "gold", "defense", "faith"]) out[key] += worth[key] || 0;
  }
  return out;
}

// The single most useful next build, as { part, why }.
export function kingdomAdvice(stats) {
  if (!stats.castle) return { part: "castle", why: "A realm needs a seat. Build a castle." };
  if (stats.homes < 12) return { part: "house", why: "We need homes for more peasants. Build houses." };
  if (stats.food < stats.homes) return { part: "farm field", why: `We house ${stats.homes} but can feed only ${stats.food}. Build farm fields.` };
  if (stats.defense < stats.homes / 2) return { part: "wall", why: "Our defenses are thin. Build walls and towers." };
  if (stats.gold < stats.homes / 3) return { part: "market stall", why: "The treasury is light. Build market stalls or a tavern." };
  if (stats.faith < 1 && stats.homes >= 16) return { part: "chapel", why: "The people ask for a chapel." };
  return { part: "house", why: "The realm prospers. Grow it with more houses and farms." };
}

const QUERY_TOPICS = [
  ["people", /\b(peasants|people|villagers|population|subjects|homes|housing)\b/],
  ["food", /\b(food|harvest|granary|grain|stores|farms?|hungry|starving)\b/],
  ["gold", /\b(gold|treasury|coffers|money|taxes|trade|income)\b/],
  ["defense", /\b(defen[cs]es?|army|soldiers|walls|military|safe|protected|enemies|attack)\b/],
  ["faith", /\b(faith|church|chapel|god|prayer|morale)\b/],
  ["advice", /\b(what (should|do|shall) (we|i) build|what next|what do (we|i) need|suggest|advice|advise)\b/],
  ["all", /\b(kingdom|realm|report|status|how (are|is) (we|things|it going)|state of)\b/],
];
const QUESTION = /^(how|what|what's|whats|is|are|do|does|give|tell|report|status|any|should|shall|advise|suggest|state)\b/;

// A spoken question about the realm → topic, else null.
export function kingdomQuery(text) {
  const t = normalizeText(text).replace(/[?.!]/g, "").trim();
  if (!t || !QUESTION.test(t)) return null;
  for (const [topic, re] of QUERY_TOPICS) if (re.test(t)) return topic;
  return null;
}

// Spoken report for a topic. advisor (optional) picks the default topic for "report".
export function kingdomReport(stats, topic = "all") {
  const advice = kingdomAdvice(stats);
  const people = Math.min(stats.homes, stats.food || 0) || 0;
  switch (topic) {
    case "people":
      return `We have homes for ${stats.homes} and food for ${stats.food}, so ${people} peasants live here.`;
    case "food":
      return stats.food >= stats.homes
        ? `The stores are full. We grow food for ${stats.food} and house ${stats.homes}.`
        : `We grow food for only ${stats.food} of ${stats.homes}. Build farm fields.`;
    case "gold":
      return `The treasury earns ${stats.gold} gold a day. ${stats.gold < stats.homes / 3 ? "Market stalls and a tavern would help." : "Trade is good."}`;
    case "defense":
      return stats.defense < stats.homes / 2
        ? `Our defense stands at ${stats.defense}. That is thin for ${stats.homes} homes. Build walls and towers.`
        : `Our defense stands at ${stats.defense}. The realm is safe.`;
    case "faith":
      return stats.faith ? `Faith stands at ${stats.faith}.` : "There is no chapel. The people would welcome one.";
    case "advice":
      return advice.why;
    case "all":
    default:
      if (!stats.buildings) return "The realm is empty land, my liege. Point and say: build a castle here.";
      return `${people} peasants, ${stats.homes} homes, food for ${stats.food}, ${stats.gold} gold a day, defense ${stats.defense}. ${advice.why}`;
  }
}

// Picks an acknowledgement that varies but repeats for the same seed (tests stay deterministic).
export function advisorAck(advisor, seed = 0) {
  const list = advisor?.acks || ["As you command."];
  return list[Math.abs(Math.floor(seed)) % list.length];
}
