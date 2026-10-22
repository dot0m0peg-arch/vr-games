// Built-in rule parser: spoken/typed command → intents (ARCHITECTURE.md "Intents").
// The local model produces the same intents; this parser handles common commands instantly
// and reports low confidence when the runner should ask the model instead.
import { normalizeText, singularize, matchPart, matchColor } from "./lexicon.js";
import { stripWake } from "./wake.js";

// ---------- vocabulary ----------

const SIZE_WORDS = {
  big: 2, large: 2, tall: 2, huge: 3, giant: 3, gigantic: 3, enormous: 3, massive: 3,
  humongous: 3, colossal: 3, jumbo: 3, titanic: 3, mega: 3, small: 0.5, little: 0.5, short: 0.5,
  tiny: 0.3, mini: 0.3, miniature: 0.3, teeny: 0.3, itty: 0.3, medium: 1, normal: 1, regular: 1,
};
// Relative factors for "make it bigger" style commands.
const FACTOR_WORDS = {
  bigger: 1.5, larger: 1.5, taller: 1.5, wider: 1.5, higher: 1.5, big: 1.5, large: 1.5, tall: 1.5, longer: 1.5,
  huge: 3, giant: 3, gigantic: 3, enormous: 3, massive: 3, humongous: 3, colossal: 3, jumbo: 3,
  smaller: 0.67, small: 0.67, shorter: 0.67, little: 0.67, littler: 0.67, narrower: 0.67, tiny: 0.3, mini: 0.3, miniature: 0.3,
};
const FILLER_ADJ = new Set([
  "new", "nice", "cool", "simple", "basic", "standard", "plain", "another", "more", "extra", "good", "real",
  "proper", "brand", "fresh", "very", "really", "super", "pretty", "kind", "sort", "of", "awesome", "fancy",
  "old", "beautiful", "little", "lovely", "great", "random", "same", "other", "one", "1", "single",
]);
const BOUNDARY = new Set([
  "to", "on", "onto", "in", "into", "at", "next", "beside", "besides", "near", "by", "behind", "above", "over",
  "under", "below", "here", "there", "ahead", "far", "close", "closer", "nearby", "left", "right", "front", "before",
  "atop", "upon", "with", "that", "which", "from", "for", "and", "then", "around", "toward", "towards", "away",
  "inside", "between", "up", "down", "off", "out", "as", "times", "please", "now", "so", "beneath", "overhead",
  "forward", "forwards", "back", "alongside", "across", "is", "are", "colored", "coloured", "painted", "saying",
  "bigger", "smaller", "larger", "taller", "shorter", "wider", "disappear", "vanish", "go", "say", "says", "using",
]);
const ARTICLES = new Set(["a", "an", "some", "another", "any"]);
// Words that end an unknown noun phrase (pronouns and generic nouns are references, not names).
const NOUN_STOP = new Set([
  "it", "them", "its", "they", "thing", "things", "stuff", "object", "objects", "item", "items", "everything",
  "something", "anything", "all", "both", "each", "every", "last", "latest", "newest", "previous", "me", "you",
  "us", "myself", "yourself", "everyone", "everybody", "what", "whatever", "i'm", "i", "one", "where", "size", "what's",
]);
const DEFINITE = new Set(["the", "my", "that", "this", "those", "these", "your", "our", "its"]);
const ORDINALS = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const UNITS = {
  meter: 1, meters: 1, metre: 1, metres: 1, m: 1, meter_: 1, feet: 0.3048, foot: 0.3048, ft: 0.3048, yard: 0.9144,
  yards: 0.9144, yd: 0.9144, yds: 0.9144, step: 0.75, steps: 0.75, pace: 0.75, paces: 0.75, inch: 0.0254, inches: 0.0254,
  centimeter: 0.01, centimeters: 0.01, centimetre: 0.01, centimetres: 0.01, cm: 0.01, kilometer: 1000, kilometers: 1000, km: 1000,
};
const TIME_WORDS = {
  day: "day", daytime: "day", "day time": "day", daylight: "day", noon: "day", midday: "day", "high noon": "day",
  "broad daylight": "day", afternoon: "day", morning: "dawn", dawn: "dawn", sunrise: "dawn", "sun rise": "dawn",
  daybreak: "dawn", "early morning": "dawn", sunset: "sunset", "sun set": "sunset", dusk: "sunset", evening: "sunset",
  sundown: "sunset", twilight: "sunset", "golden hour": "sunset", night: "night", nighttime: "night",
  "night time": "night", midnight: "night", dark: "night", "dark out": "night", nightfall: "night",
};
const TIME_RE = new RegExp(
  "^(?:(?:make|set|turn|change|switch|put|go|let|bring)(?: it| the time| the sky| the world| things| everything)?(?: to| into| back to| over to| on)?"
  + "|it's|its|it is|time for|time to|set time to|switch to|go to|skip to|fast forward to)?\\s*(?:the |a |an )?("
  + Object.keys(TIME_WORDS).sort((a, b) => b.length - a.length).join("|")
  + ")(?: time| mode| please| now| again)?$",
);
const LIST_RE = /^(?:help|help me|commands|options|what can (?:you|i) (?:do|say|spawn|summon|make|build|create)|what do you have|what have you got|what (?:parts|things|objects|items|stuff) (?:do you have|are there|can (?:you|i) (?:spawn|summon|make|build|create))|(?:list|show)(?: me)?(?: all)?(?: of)?(?: the| your)?(?: available)?(?: parts| things| objects| items| commands| stuff)?(?: bin)?(?: you have| available)?|parts(?: list| bin)?|what(?:'s| is) in the parts bin|what can you summon)$/;
// "the board" is a whiteboard, not the room; "the thing" is one object.
const CLEAR_RE = /^(?:(?:clear|reset|wipe|empty|clean)(?: up| out)?(?: (?:everything|all|it all|everything out|(?:the )?whole thing|(?:the )?(?:whole )?(?:field|room|area|world|scene|space|map|place)))?|start (?:over|fresh|again)|reset everything|remove all objects|delete all objects)$/;
const UNDO_RE = /^(?:undo|undo that|undo it|undo the last (?:thing|command|step|action|1)|undo last|take that back|take it back|revert|revert that|go back|oops)(?: (\d+)(?: times| steps| things| commands| actions)?)?$/;
const UNDO_N_RE = /^undo (?:the )?(?:last )?(\d+)(?: times| steps| things| commands| actions)?$/;

// Verb phrases, longest first. cls decides the handler.
const VERB_LIST = [
  ["can i have", "give"], ["can i get", "give"], ["could i have", "give"], ["could i get", "give"], ["may i have", "give"],
  ["let me have", "give"], ["let me hold", "hold"], ["i'd like", "give"], ["i would like", "give"], ["i need", "give"],
  ["i want", "give"], ["give me", "give"], ["get me", "give"], ["hand me", "give"], ["pass me", "give"], ["toss me", "give"],
  ["throw me", "give"], ["bring me", "give"], ["fetch me", "give"], ["grab me", "give"], ["give", "give"],
  ["make me", "spawn"], ["build me", "spawn"], ["create me", "spawn"], ["summon me", "spawn"], ["conjure me", "spawn"],
  ["spawn me", "spawn"], ["spawn in", "spawn"], ["conjure up", "spawn"], ["whip up", "spawn"], ["set up", "spawn"],
  ["drop in", "spawn"], ["show me", "spawn"], ["put up", "spawn"],
  ["get rid of", "remove"], ["take away", "remove"], ["throw away", "remove"], ["throw out", "remove"], ["clean up", "remove"],
  ["clear out", "remove"], ["clear away", "remove"], ["put away", "remove"],
  ["pick up", "hold"], ["grab", "hold"], ["take", "hold"], ["hold", "hold"], ["equip", "hold"], ["wield", "hold"], ["pick", "hold"],
  ["let go of", "drop"], ["let it go", "drop"], ["let go", "drop"], ["put down", "drop"], ["set down", "drop"],
  ["lay down", "drop"], ["release", "drop"], ["unequip", "drop"], ["drop", "drop"],
  ["turn over", "flip"], ["flip over", "flip"], ["flip", "flip"], ["reveal", "flip"],
  ["shuffle", "shuffle"], ["deal", "deal"],
  ["remove", "remove"], ["delete", "remove"], ["destroy", "remove"], ["despawn", "remove"], ["erase", "remove"],
  ["banish", "remove"], ["vanish", "remove"], ["dismiss", "remove"], ["unsummon", "remove"], ["eliminate", "remove"],
  ["obliterate", "remove"], ["kill", "remove"], ["clear", "remove"], ["nuke", "remove"], ["zap", "remove"], ["disintegrate", "remove"],
  ["scale", "scale"], ["resize", "scale"], ["grow", "scale"], ["shrink", "scale"], ["enlarge", "scale"], ["double", "scale"],
  ["triple", "scale"], ["quadruple", "scale"], ["halve", "scale"], ["embiggen", "scale"], ["expand", "scale"],
  ["paint", "color"], ["color", "color"], ["colour", "color"], ["dye", "color"], ["tint", "color"], ["recolor", "color"],
  ["recolour", "color"], ["turn", "turn"], ["change", "change"], ["set", "set"],
  ["move", "move"], ["shift", "move"], ["slide", "move"], ["push", "move"], ["pull", "move"], ["carry", "move"],
  ["relocate", "move"], ["teleport", "move"], ["send", "move"], ["drag", "move"], ["position", "move"], ["reposition", "move"],
  ["bring", "bring"], ["put", "put"], ["place", "put"], ["stick", "put"], ["make", "make"],
  ["spawn", "spawn"], ["spawned", "spawn"], ["spawning", "spawn"], ["spawns", "spawn"], ["summon", "spawn"], ["create", "spawn"],
  ["build", "spawn"], ["conjure", "spawn"], ["add", "spawn"], ["generate", "spawn"], ["produce", "spawn"], ["construct", "spawn"],
  ["materialize", "spawn"], ["materialise", "spawn"], ["fetch", "spawn"], ["plant", "spawn"], ["erect", "spawn"],
  ["craft", "spawn"], ["manifest", "spawn"], ["render", "spawn"], ["insert", "spawn"], ["deploy", "spawn"],
  ["instantiate", "spawn"], ["get", "give"], ["say", "say"], ["speak", "say"], ["announce", "say"],
].map(([phrase, cls]) => ({ words: phrase.split(" "), cls })).sort((a, b) => b.words.length - a.words.length);

const LEAD_FILLERS = [
  "please", "can you", "could you", "would you", "will you", "can u", "i want you to", "i'd like you to",
  "i would like you to", "i need you to", "go ahead and", "now", "and", "then", "also", "just", "quickly", "okay", "ok",
  "oh", "um", "uh", "hey", "so", "kindly", "try to", "try and", "let's", "lets", "let us", "i want to", "i'd like to",
  "i would like to", "you can", "you should", "yo", "alright", "actually", "hmm", "ai", "after that", "no", "nope",
  "nah", "wrong", "oops no",
].map((p) => p.split(" ")).sort((a, b) => b.length - a.length);
const TRAIL_FILLERS = [
  "please", "for me", "now", "thanks", "thank you", "right now", "real quick", "quickly", "as well", "too",
  "if you can", "if you could", "okay", "ok", "for us", "again", "thank you very much", "pls",
].map((p) => p.split(" ")).sort((a, b) => b.length - a.length);

const WRITE_LEAD_RE = /^(?:(?:please|can you|could you|would you|will you|go ahead and|now|and|then|also|just|ai)[\s,]+)*/i;
const NOTE_RE = /^(?:(?:take|make|leave|jot down|write down|write)\s+(?:a|an|me a|myself a)\s+(?:quick\s+|new\s+|short\s+)?(?:sticky\s+note|note|memo|reminder|post[- ]?it(?:\s+note)?)|(?:note|memo|reminder|remember)(?=\s*[:\-–—,]|\s|$))(?:\s+(?:that\s+says|which\s+says|saying|that\s+reads|reading|to\s+self|to\s+myself|that|about))?\s*[:,\-–—]?\s*([\s\S]*)$/i;
const WRITE_RE = /^(?:write|jot|scribble|type)(?:\s+down)?\s+([\s\S]+)$/i;
const SAY_TEXT_RE = /^(?:make|have|set|change|let)\s+(?:the|that|this|my|it)\s*([\s\S]*?)\s+(?:say|says|read|reads|show|display)\s+([\s\S]+)$/i;
const TEXT_INTRO_RE = /\s(?:(?:that|which)\s+(?:says|reads|said)|saying|with\s+the\s+(?:text|words?)|with\s+text|that\s+has\s+written)[\s:,]+|\s*:\s+/i;
const GREEDY_RE = /^(?:(?:please|can you|could you|would you|will you|go ahead and|now|and|then|also|just|ai)[\s,]+)*(?:write|jot|scribble|type|note|memo|remember|reminder|say|speak|announce|(?:take|make|leave)\s+(?:a\s+)?(?:quick\s+)?note)\b/i;
const SEP_RE = /\s*(?:[,;!?]+|\.(?=\s|$)|\band then\b|\bthen\b|\bafter that\b|\band\b(?!\s+a\s+half\b))\s*/gi;

// ---------- small helpers ----------

const isNum = (w) => w !== undefined && /^\d+(\.\d+)?$/.test(w);
const r3 = (n) => Math.round(n * 1000) / 1000;

// Matches a token pattern ("to|on my|the? left") at words[i]; "?" marks optional tokens,
// "#" matches a number. → end index or -1.
const patternCache = new Map();
function seq(words, i, pattern) {
  let toks = patternCache.get(pattern);
  if (!toks) {
    toks = pattern.split(" ").map((t) => {
      const opt = t.endsWith("?");
      return { opt, alts: (opt ? t.slice(0, -1) : t).split("|") };
    });
    patternCache.set(pattern, toks);
  }
  const go = (k, j) => {
    if (k === toks.length) return j;
    const t = toks[k];
    const w = words[j];
    if (j < words.length && (t.alts.includes(w) || (t.alts.includes("#") && isNum(w)))) {
      const r = go(k + 1, j + 1);
      if (r >= 0) return r;
    }
    return t.opt ? go(k + 1, j) : -1;
  };
  return go(0, i);
}

function startsWithAt(words, i, phrase) {
  for (let k = 0; k < phrase.length; k++) if (words[i + k] !== phrase[k]) return false;
  return true;
}

function stripFillers(words) {
  let w = words;
  let changed = true;
  while (changed && w.length) {
    changed = false;
    for (const f of LEAD_FILLERS) {
      if (w.length >= f.length && startsWithAt(w, 0, f)) {
        w = w.slice(f.length);
        changed = true;
        break;
      }
    }
  }
  changed = true;
  while (changed && w.length) {
    changed = false;
    for (const f of TRAIL_FILLERS) {
      if (w.length >= f.length && startsWithAt(w, w.length - f.length, f)) {
        w = w.slice(0, w.length - f.length);
        changed = true;
        break;
      }
    }
  }
  return w;
}

function cleanPayload(text) {
  return String(text || "")
    .trim()
    .replace(/^[\s:,\-–—]+/, "")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/\.+$/, "")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .trim()
    .slice(0, 2000);
}

// Raw text after the first n word tokens (keeps the payload's original case and punctuation).
function rawAfterWords(raw, n) {
  const re = /[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*/gu;
  let end = 0;
  let count = 0;
  for (const m of raw.matchAll(re)) {
    if (count === n) break;
    end = m.index + m[0].length;
    count++;
  }
  return raw.slice(end);
}

function colorAt(words, i) {
  if (i >= words.length) return null;
  if (i + 1 < words.length) {
    const two = matchColor(`${words[i]} ${words[i + 1]}`);
    if (two) return { color: two, end: i + 2 };
  }
  const one = matchColor(words[i]);
  return one ? { color: one, end: i + 1 } : null;
}

function metaByName(st, name) {
  return st.metas.find((m) => m && m.name === name);
}

// ---------- nouns and targets ----------

// Scans for a catalog phrase starting at k, allowing color/size/filler words before it.
// → { known, part?, label, phrase?, end, color, scale, descriptors, plural, score } | null
function findNoun(w, k, st, { guess = false } = {}) {
  const descriptors = [];
  let color = null;
  let scale = null;
  let lastModifier = null;
  let p = k;
  while (p < w.length) {
    const m = matchPart(w, st.metas, { start: p, anchored: true });
    const word = w[p];
    const isModifier = !!colorAt(w, p) || word in SIZE_WORDS || FILLER_ADJ.has(word);
    // "orange crate": a modifier that is also a part name loses to a part right after it.
    if (m && !(isModifier && m.end === p + 1 && matchPart(w, st.metas, { start: p + 1, anchored: true }))) {
      const last = w[m.end - 1];
      const plural = m.score < 1 && last !== singularize(last);
      const label = descriptors.length ? `${descriptors.join(" ")} ${m.phrase}` : null;
      return { known: true, part: m.name, phrase: m.phrase, label, start: p, end: m.end, color, scale, descriptors, plural, score: m.score };
    }
    if (BOUNDARY.has(word) || NOUN_STOP.has(word) || isNum(word)) break;
    const c = colorAt(w, p);
    if (c) {
      lastModifier = { words: w.slice(p, c.end), color, scale };
      color = c.color;
      p = c.end;
      continue;
    }
    if (word in SIZE_WORDS) {
      lastModifier = { words: [word], color, scale };
      if (SIZE_WORDS[word] !== 1) scale = SIZE_WORDS[word];
      p++;
      continue;
    }
    // An article after other words ends the phrase. "hide the crate": before a part, those words were a verb.
    if ((DEFINITE.has(word) || ARTICLES.has(word)) && descriptors.length) {
      if (findNoun(w, p + 1, st)?.known) return null;
      break;
    }
    if (FILLER_ADJ.has(word) || DEFINITE.has(word) || ARTICLES.has(word)) {
      p++;
      continue;
    }
    descriptors.push(word);
    p++;
  }
  // "an orange", "a giant": the last modifier was the noun after all.
  if (!descriptors.length && lastModifier) {
    descriptors.push(...lastModifier.words);
    color = lastModifier.color;
    scale = lastModifier.scale;
  }
  if (!descriptors.length) return null;
  const words = [...descriptors];
  const last = words[words.length - 1];
  const plural = last !== singularize(last);
  words[words.length - 1] = singularize(last);
  const label = words.join(" ");
  if (guess && words.length <= 3) {
    const meta = headNounPart(words[words.length - 1], st);
    if (meta) return { known: true, part: meta.name, phrase: label, label, start: k, end: p, color, scale, descriptors, plural, score: 0.5, guessed: true };
  }
  return { known: false, label, end: p, color, scale, descriptors, plural, score: 0 };
}

// "a table" → the smallest catalog part whose name ends in "table" (card table, coffee table, ...).
function headNounPart(head, st) {
  let best = null;
  let bestSize = Infinity;
  for (const meta of st.metas) {
    const phrases = [meta.name, ...(meta.aliases || [])].map((x) => normalizeText(x).split(" "));
    if (!phrases.some((ws) => ws.length > 1 && singularize(ws[ws.length - 1]) === head)) continue;
    const size = Array.isArray(meta.size) ? Math.max(meta.size[0], meta.size[2]) : 1;
    if (size < bestSize) {
      best = meta;
      bestSize = size;
    }
  }
  return best;
}

const HELD = [
  "what i'm holding", "what i am holding", "whatever i'm holding", "whatever i am holding", "the thing i'm holding",
  "the thing in my hand", "what's in my hand", "what is in my hand", "my held item", "what i'm carrying", "what i have",
  "the thing i am holding", "what i'm holding in my left|right hand",
];
const ALL_REFS = [
  "everything", "every thing", "all of it", "all of them", "it all", "them all", "all of that", "all the things|objects|stuff",
  "all things|objects|stuff", "the whole lot", "all", "everything here", "every object",
];
const LAST_REFS = ["the last|latest|newest|previous 1|thing|object|item|one", "the most recent 1|thing|object|item|one", "last 1|thing", "the last"];
const IT_REFS = ["that|this|the 1|thing|object|item", "it", "that", "this", "them", "those", "these", "there", "the 1"];

function pronounTarget(ref, st) {
  if (ref === "it" && st.lastSpawn >= 0) return { batch: st.lastSpawn };
  return { ref };
}

// Parses an object reference. → { target, end, article, known, noun, pronoun } | null
function parseTarget(w, i, st) {
  if (i >= w.length) return null;
  let e;
  for (const pat of HELD) if ((e = seq(w, i, pat)) >= 0) return { target: { ref: "held" }, end: e, pronoun: true };
  if ((e = seq(w, i, "all|every|each|both of? the|my|those|these?")) >= 0 && e < w.length) {
    const n = findNoun(w, e, st);
    if (n) return { target: { part: n.known ? n.part : n.label, which: "all" }, end: n.end, article: "all", known: n.known, noun: n };
  }
  for (const pat of ALL_REFS) if ((e = seq(w, i, pat)) >= 0) return { target: { ref: "all" }, end: e, pronoun: true };
  for (const pat of LAST_REFS.slice(0, 3)) if ((e = seq(w, i, pat)) >= 0) return { target: { ref: "last" }, end: e, pronoun: true };
  let k = i;
  let article = null;
  let which = null;
  if (DEFINITE.has(w[k]) || ARTICLES.has(w[k])) {
    article = w[k];
    k++;
  }
  if (w[k] in ORDINALS) {
    which = ORDINALS[w[k]];
    k++;
  } else if (["last", "latest", "newest"].includes(w[k]) && k + 1 < w.length && !["1", "thing", "object", "item", "one"].includes(w[k + 1])) {
    which = "last";
    k++;
  } else if (["nearest", "closest"].includes(w[k])) {
    which = "nearest";
    k++;
  }
  const n = findNoun(w, k, st);
  if (n && !(n.known === false && ["that", "this", "those", "these", "it", "them", "there"].includes(article) && n.descriptors.length === 1 && n.descriptors[0] === "1")) {
    let end = n.end;
    if (which === null && isNum(w[end]) && !(w[end + 1] in UNITS) && !["times", "x", "percent", "more"].includes(w[end + 1])
      && Number.isInteger(Number(w[end]))) {
      which = Number(w[end]);
      end++;
    } else if (which === null && (w[end] === "number" || w[end] === "no") && isNum(w[end + 1])) {
      which = Number(w[end + 1]);
      end += 2;
    }
    if (which === null) which = n.plural && (!article || ["the", "those", "these", "my", "all"].includes(article)) ? "all" : "nearest";
    return { target: { part: n.known ? n.part : n.label, which }, end, article, known: n.known, noun: n };
  }
  for (const pat of LAST_REFS) if ((e = seq(w, i, pat)) >= 0) return { target: { ref: "last" }, end: e, pronoun: true };
  for (const pat of IT_REFS) if ((e = seq(w, i, pat)) >= 0) return { target: pronounTarget("it", st), end: e, pronoun: true };
  return null;
}

// Target for a placement reference: indefinite parts may be spawned when missing.
function refOf(t) {
  const target = { ...t.target };
  if (target.part && ARTICLES.has(t.article)) {
    target.which = "nearest";
    target.spawnIfMissing = true;
  }
  return target;
}

// ---------- placement ----------

const RIGHT_INTENSIFIED = new Set(["here", "next", "in", "behind", "above", "there", "beside", "by", "on", "at", "under", "over", "before", "away", "ahead", "into", "onto", "near"]);
const SELF = "me|you|us|myself|yourself";

function sideTail(w, end, st, rel) {
  // "... left of me" → rel, "... left of the villa" → next to the villa on that side.
  if (w[end] !== "of") return { place: { rel }, end };
  const self = seq(w, end + 1, SELF);
  if (self >= 0) return { place: { rel }, end: self };
  const t = parseTarget(w, end + 1, st);
  if (t) return { place: { rel: "next", side: rel === "front" ? "front" : rel, ref: refOf(t) }, end: t.end };
  return { place: { rel }, end };
}

function parseDirection(w, i, st) {
  let e;
  if ((e = seq(w, i, "to|on|at|towards|toward|over|off|onto the|my|your? left|right hand? side?")) >= 0
    || (e = seq(w, i, "left|right|leftward|leftwards|rightward|rightwards side?")) >= 0) {
    const rel = w.slice(i, e).some((x) => x.startsWith("left")) ? "left" : "right";
    return sideTail(w, e, st, rel);
  }
  if ((e = seq(w, i, "in front|frontwards")) >= 0) {
    if (w[e] === "of" && seq(w, e + 1, SELF) < 0) {
      const t = parseTarget(w, e + 1, st);
      if (t) return { place: { rel: "next", side: "front", ref: refOf(t) }, end: t.end };
    }
    const self = seq(w, e, `of ${SELF}`);
    return { place: { rel: "front" }, end: self >= 0 ? self : e };
  }
  if ((e = seq(w, i, "in|out the? front")) >= 0 || (e = seq(w, i, `straight? ahead of? ${SELF}?`)) >= 0
    || (e = seq(w, i, `before ${SELF}`)) >= 0 || (e = seq(w, i, "forward|forwards|front|out")) >= 0) {
    return { place: { rel: "front" }, end: e };
  }
  if ((e = seq(w, i, "behind")) >= 0) {
    const self = seq(w, e, SELF);
    if (self >= 0) return { place: { rel: "behind" }, end: self };
    const t = e < w.length ? parseTarget(w, e, st) : null;
    if (t && t.target.ref !== "all" && t.target.ref !== "held") return { place: { rel: "next", side: "behind", ref: refOf(t) }, end: t.end };
    return { place: { rel: "behind" }, end: e };
  }
  if ((e = seq(w, i, `in back of ${SELF}?`)) >= 0 || (e = seq(w, i, "at|to my back")) >= 0 || (e = seq(w, i, "back|backwards|backward")) >= 0) {
    return { place: { rel: "behind" }, end: e };
  }
  if ((e = seq(w, i, "above|over my head")) >= 0 || (e = seq(w, i, `above|over ${SELF}`)) >= 0
    || (e = seq(w, i, "overhead|above|floating|aloft")) >= 0 || (e = seq(w, i, "up? in|into the air|sky")) >= 0
    || (e = seq(w, i, "up high|there")) >= 0 || (e = seq(w, i, "up")) >= 0) {
    return { place: { rel: "above" }, end: e };
  }
  if ((e = seq(w, i, "far away|off|out")) >= 0 || (e = seq(w, i, "in the distance")) >= 0 || (e = seq(w, i, "way out|over there?")) >= 0
    || (e = seq(w, i, `far from ${SELF}`)) >= 0 || (e = seq(w, i, "further|farther away?")) >= 0
    || (e = seq(w, i, "a long way away|off?")) >= 0 || (e = seq(w, i, "far|away")) >= 0) {
    return { place: { rel: "far" }, end: e };
  }
  return null;
}

function parsePlacement(w, i, st) {
  if (i >= w.length) return null;
  if (w[i] === "right" && RIGHT_INTENSIFIED.has(w[i + 1])) {
    const inner = parsePlacement(w, i + 1, st);
    if (inner) return inner;
  }
  let e;
  // Hands.
  if (((e = seq(w, i, "in|into|to|inside|with|using my|your|the? left|right? hand|hands|palm|grip|fist")) >= 0
    || (e = seq(w, i, "left|right hand")) >= 0) && w[e] !== "side") {
    const side = w.slice(i, e).find((x) => x === "left" || x === "right");
    return { place: { rel: "hand", hand: side || st.hand }, end: e };
  }
  // Distances: "5 meters to my left", "10 feet away", "3 m".
  if (isNum(w[i]) && w[i + 1] in UNITS) {
    const dist = r3(Number(w[i]) * UNITS[w[i + 1]]);
    let k = i + 2;
    if (["away", "off", "out"].includes(w[k]) && w[k + 1] === "to") k++;
    // "N away" is a distance only: "to my left 20 meters away" keeps the left (finishPlace defaults to front).
    const from = seq(w, k, `away|out from ${SELF}`);
    if (from >= 0) return { place: { dist }, end: from };
    if (w[k] === "away" || w[k] === "out" || w[k] === "off") return { place: { dist }, end: k + 1 };
    const dir = parseDirection(w, k, st);
    if (dir && dir.place.rel !== "far" && dir.place.rel !== "next") return { place: { rel: dir.place.rel, dist }, end: dir.end };
    return { place: { dist }, end: k };
  }
  // Near the player.
  if ((e = seq(w, i, `next to|by ${SELF}`)) >= 0 || (e = seq(w, i, `beside|besides|alongside|by ${SELF}`)) >= 0
    || (e = seq(w, i, "by|at my side")) >= 0) {
    return { place: { rel: "left", dist: 1 }, end: e };
  }
  if ((e = seq(w, i, `at|by|near|on|to|around my feet|foot`)) >= 0 || (e = seq(w, i, `under|below|beneath ${SELF}`)) >= 0) {
    return { place: { rel: "feet" }, end: e };
  }
  if ((e = seq(w, i, "over|near|to|around? here")) >= 0 || (e = seq(w, i, `to|towards|toward ${SELF}`)) >= 0
    || (e = seq(w, i, `over to ${SELF}`)) >= 0 || (e = seq(w, i, "my|this way")) >= 0 || (e = seq(w, i, "within reach")) >= 0
    || (w[i] === "over" && i === w.length - 1 && (e = i + 1))) {
    return { place: { rel: "here" }, end: e };
  }
  if ((e = seq(w, i, `closer|nearer to? ${SELF}?`)) >= 0 || (e = seq(w, i, `near|close to? ${SELF}`)) >= 0
    || (e = seq(w, i, "close|near by")) >= 0 || (e = seq(w, i, "nearby")) >= 0) {
    return { place: { rel: "front", dist: 1.5 }, end: e };
  }
  // "near the desk" relates to an object (handled below); bare "close"/"near" relate to the player.
  if ((w[i] === "close" || w[i] === "near") && !parseTarget(w, w[i + 1] === "to" ? i + 2 : i + 1, st)) {
    return { place: { rel: "front", dist: 1.5 }, end: w[i + 1] === "to" ? i + 2 : i + 1 };
  }
  if ((e = seq(w, i, "on the ground|floor|grass")) >= 0) return { place: null, end: e };
  if ((e = seq(w, i, "over|out there")) >= 0 || (e = seq(w, i, "there")) >= 0) return { place: { rel: "front", dist: 6 }, end: e };
  // Relations to other objects.
  for (const pat of ["on|upon top of", "on to", "up on|onto", "top of", "on|onto|atop|upon"]) {
    if ((e = seq(w, i, pat)) < 0) continue;
    const t = parseTarget(w, e, st);
    if (t && t.target.ref !== "all" && t.target.ref !== "held") return { place: { rel: "on", ref: refOf(t) }, end: t.end };
  }
  if ((e = seq(w, i, "right? next to")) >= 0 || (e = seq(w, i, "beside|besides|alongside|near|by|around|adjacent|nextto to?")) >= 0
    || (e = seq(w, i, "close to")) >= 0 || (e = seq(w, i, "next")) >= 0) {
    const t = parseTarget(w, e, st);
    if (t && t.target.ref !== "all" && t.target.ref !== "held") return { place: { rel: "next", ref: refOf(t) }, end: t.end };
  }
  return parseDirection(w, i, st);
}

function mergePlace(a, b) {
  if (!b) return a;
  if (!a) return { ...b };
  const dirs = ["left", "right", "front", "behind"];
  if (!b.rel) return { ...a, dist: b.dist };
  if (!a.rel) return { ...b, dist: b.dist ?? a.dist };
  if (a.rel === "far" && dirs.includes(b.rel)) return { rel: b.rel, dist: b.dist ?? a.dist ?? 25 };
  if (b.rel === "far" && dirs.includes(a.rel)) return { rel: a.rel, dist: a.dist ?? 25 };
  if (b.rel === "front" && b.dist === 1.5 && dirs.includes(a.rel)) return { rel: a.rel, dist: 1.5 };
  return { ...b };
}

function finishPlace(place) {
  if (!place) return null;
  if (!place.rel) return { rel: "front", ...place };
  return place;
}

function pickHand(st, wanted) {
  const hand = wanted || st.hand;
  if (!wanted && st.handsUsed.has(hand)) {
    const other = hand === "left" ? "right" : "left";
    if (!st.handsUsed.has(other)) {
      st.handsUsed.add(other);
      return other;
    }
  }
  st.handsUsed.add(hand);
  return hand;
}

// ---------- sizes and colors after the noun ----------

function sizePhraseAt(w, p) {
  let e;
  if ((e = seq(w, p, "twice|double as big|large|tall|high")) >= 0 || (e = seq(w, p, "twice|double the size|height")) >= 0
    || (e = seq(w, p, "double size|sized")) >= 0) return { factor: 2, end: e };
  if ((e = seq(w, p, "triple size|sized")) >= 0 || (e = seq(w, p, "triple the size")) >= 0) return { factor: 3, end: e };
  if ((e = seq(w, p, "half as big|large|tall")) >= 0 || (e = seq(w, p, "half the? size|sized|height")) >= 0) return { factor: 0.5, end: e };
  if ((e = seq(w, p, "# times smaller")) >= 0) return { factor: r3(1 / Math.max(1, Number(w[p]))), end: e };
  if ((e = seq(w, p, "# times as? big|bigger|large|larger|taller")) >= 0 || (e = seq(w, p, "# times the? size")) >= 0
    || (e = seq(w, p, "# x|times")) >= 0) {
    return { factor: Number(w[p]), end: e };
  }
  if ((e = seq(w, p, "# percent bigger|larger")) >= 0) return { factor: r3(1 + Number(w[p]) / 100), end: e };
  if ((e = seq(w, p, "# percent smaller")) >= 0) return { factor: r3(Math.max(0.05, 1 - Number(w[p]) / 100)), end: e };
  return null;
}

// Relative factor for scale commands ("bigger", "a bit smaller", "3 times bigger").
function factorPhraseAt(w, p) {
  let e;
  const fixed = sizePhraseAt(w, p);
  if (fixed) return fixed;
  if ((e = seq(w, p, "much|way|far bigger|larger|taller")) >= 0 || (e = seq(w, p, "a? lot|lots bigger|larger|taller")) >= 0) return { factor: 2, end: e };
  if ((e = seq(w, p, "much|way|far smaller|shorter|tinier")) >= 0 || (e = seq(w, p, "a? lot|lots smaller|shorter|tinier")) >= 0) return { factor: 0.5, end: e };
  if ((e = seq(w, p, "a? bit|little|tad|touch|slightly bigger|larger|taller")) >= 0 || (e = seq(w, p, "slightly bigger|larger|taller")) >= 0) return { factor: 1.2, end: e };
  if ((e = seq(w, p, "a? bit|little|tad|touch smaller|shorter")) >= 0 || (e = seq(w, p, "slightly smaller|shorter")) >= 0) return { factor: 0.8, end: e };
  if ((e = seq(w, p, "really|very|super|extra? huge|giant|gigantic|enormous|massive|humongous|colossal|jumbo")) >= 0) return { factor: 3, end: e };
  if ((e = seq(w, p, "really|very|super|extra? tiny|mini|miniature")) >= 0) return { factor: 0.3, end: e };
  if ((e = seq(w, p, "even|really|very? bigger|larger|taller|wider|higher|longer|big|large|tall")) >= 0) return { factor: 1.5, end: e };
  if ((e = seq(w, p, "even|really|very? smaller|shorter|little|littler|small|narrower")) >= 0) return { factor: 0.67, end: e };
  return null;
}

function colorPhraseAt(w, p) {
  let e;
  if ((e = seq(w, p, "in|to|into|with|colored|coloured|painted|of|all the? color|colour?")) >= 0 && e < w.length) {
    const c = colorAt(w, e);
    if (c) return { color: c.color, end: seq(w, c.end, "color|colour|colored|coloured") >= 0 ? c.end + 1 : c.end };
  }
  const c = colorAt(w, p);
  if (c) return { color: c.color, end: seq(w, c.end, "color|colour|colored|coloured") >= 0 ? c.end + 1 : c.end };
  return null;
}

const SKIP_TAIL = new Set(["please", "now", "thanks", "too", "also", "again", "real", "quick", "for", "me", "us", "ok", "okay", "will", "you"]);

// Reads trailing placement/size/color phrases. → { place, scale, color, leftovers }
function readTail(w, p, st, { scale = null, color = null } = {}) {
  let place = null;
  const leftovers = [];
  while (p < w.length) {
    const pl = parsePlacement(w, p, st);
    if (pl) {
      place = mergePlace(place, pl.place);
      p = pl.end;
      continue;
    }
    const sz = sizePhraseAt(w, p);
    if (sz) {
      scale = sz.factor;
      p = sz.end;
      continue;
    }
    if (w[p] in SIZE_WORDS) {
      if (SIZE_WORDS[w[p]] !== 1) scale = SIZE_WORDS[w[p]];
      p++;
      continue;
    }
    const c = colorPhraseAt(w, p);
    if (c) {
      color = c.color;
      p = c.end;
      continue;
    }
    if (SKIP_TAIL.has(w[p]) || FILLER_ADJ.has(w[p])) {
      p++;
      continue;
    }
    leftovers.push(w[p]);
    p++;
  }
  return { place: finishPlace(place), scale, color, leftovers };
}

// ---------- clause handlers ----------
// Each returns { intents, conf, unknown? } or null when the words do not fit.

const CONF_OK = 0.9;
const CONF_PARTIAL = 0.6;
const CONF_GUESS = 0.7;
const CONF_UNKNOWN = 0.35;

function isIndefinite(w, k) {
  return ARTICLES.has(w[k]) || (isNum(w[k]) && !(w[k + 1] in UNITS));
}

function spawnClause(w, k, st, { autoHand = false, text } = {}) {
  let p = k;
  let count = 1;
  let explicit = false;
  let some = false;
  if (w[p] === "the" || w[p] === "me") p++;
  if (ARTICLES.has(w[p])) {
    some = w[p] === "some";
    p++;
  }
  if (isNum(w[p]) && !(w[p + 1] in UNITS)) {
    count = Number(w[p]);
    explicit = true;
    p++;
  }
  if (w[p] === "more") p++;
  if (w[p] === "pair" && w[p + 1] === "of" && !matchPart(w, st.metas, { start: p, anchored: true })) {
    count = 2;
    explicit = true;
    p += 2;
  }
  const noun = findNoun(w, p, st, { guess: true });
  if (!noun) return null;
  if (some && !explicit && noun.plural) count = 3;
  // "five cards": a count on a plural alias ("cards" = deck of cards) means singles ("card").
  if (explicit && count > 1 && noun.known && noun.score === 1) {
    const words = noun.phrase.split(" ");
    const last = words[words.length - 1];
    words[words.length - 1] = singularize(last);
    const single = last !== words[words.length - 1] ? matchPart(words, st.metas, { start: 0, anchored: true }) : null;
    if (single && single.score === 1 && single.end === words.length) noun.part = single.name;
  }
  const tail = readTail(w, noun.end, st, { scale: noun.scale, color: noun.color });
  const intent = { do: "spawn", what: noun.known ? { part: noun.part } : { label: noun.label } };
  if (noun.known && noun.label) intent.what.label = noun.label;
  const n = Math.min(30, Math.max(1, Math.round(count)));
  if (n > 1) intent.count = n;
  let place = tail.place;
  if (place?.rel === "hand") place = { rel: "hand", hand: pickHand(st, place.hand === st.hand && !w.includes(st.hand) ? null : place.hand) };
  if (!place && autoHand && noun.known && metaByName(st, noun.part)?.holdable) place = { rel: "hand", hand: pickHand(st) };
  if (place) intent.place = place;
  if (tail.color) intent.color = tail.color;
  if (tail.scale && tail.scale !== 1) intent.scale = tail.scale;
  if (text) intent.text = text;
  if (!noun.known) return { intents: [intent], conf: CONF_UNKNOWN, unknown: [noun.label] };
  const clean = !noun.label && !tail.leftovers.length;
  // A typo match ("vilal") is a guess: the model may know better, and the player is told.
  const fuzzy = noun.score < 0.95 && !noun.guessed;
  if (fuzzy) st.say.push(`I took "${noun.phrase}" to mean ${/^[aeiou]/.test(noun.part) ? "an" : "a"} ${noun.part}.`);
  return { intents: [intent], conf: !clean ? CONF_PARTIAL : fuzzy ? CONF_GUESS : CONF_OK };
}

function withSpawnIfMissing(target) {
  return target.part ? { ...target, spawnIfMissing: true } : target;
}

function targetOrIt(w, k, st) {
  const t = parseTarget(w, k, st);
  if (t) return t;
  return { target: pronounTarget("it", st), end: k, implicit: true };
}

// "the crate on the left" / "the tree behind me": a side relative to the player narrows a part target.
function withSide(target, place) {
  return target.part && place && !place.ref && ["left", "right", "front", "behind"].includes(place.rel) ? { ...target, side: place.rel } : target;
}

function holdClause(w, k, st, { text } = {}) {
  if (isIndefinite(w, k)) return spawnClause(w, k, st, { autoHand: true, text });
  const t = parseTarget(w, k, st);
  if (!t) return null;
  let p = t.end;
  if (w[p] === "up") p++;
  const tail = readTail(w, p, st);
  const wanted = tail.place?.rel === "hand" && w.slice(p).some((x) => x === "left" || x === "right") ? tail.place.hand : null;
  const intent = { do: "hold", target: withSpawnIfMissing(withSide(t.target, tail.place)), hand: pickHand(st, wanted) };
  const clean = !tail.leftovers.length && (!tail.place || tail.place.rel === "hand");
  return { intents: [intent], conf: clean ? CONF_OK : CONF_PARTIAL };
}

function dropClause(w, k, st) {
  if (isIndefinite(w, k)) return spawnClause(w, k, st);
  const intent = { do: "drop" };
  let p = k;
  let leftovers = 0;
  while (p < w.length) {
    let e;
    if ((e = seq(w, p, "everything|all|both|it|that|this|them|whatever|those|these")) >= 0 || (e = seq(w, p, "what|whatever i'm holding")) >= 0
      || (e = seq(w, p, "what|whatever i am holding")) >= 0 || (e = seq(w, p, "what's in my left|right? hand")) >= 0
      || (e = seq(w, p, "what is in my left|right? hand")) >= 0) {
      const side = w.slice(p, e).find((x) => x === "left" || x === "right");
      if (side) intent.hand = side;
      p = e;
      continue;
    }
    if ((e = seq(w, p, "from|in|out of? my|the? left|right hand?")) >= 0 || (e = seq(w, p, "my|the left|right 1|hand")) >= 0
      || (e = seq(w, p, "left|right hand?")) >= 0) {
      intent.hand = w.slice(p, e).includes("left") ? "left" : "right";
      p = e;
      continue;
    }
    if ((e = seq(w, p, "of|from my? hand|hands")) >= 0 || (e = seq(w, p, "go|down|of|on the? ground|floor?")) >= 0) {
      p = e;
      continue;
    }
    const t = parseTarget(w, p, st);
    if (t && t.target.part) {
      intent.target = t.target;
      p = t.end;
      continue;
    }
    if (!SKIP_TAIL.has(w[p])) leftovers++;
    p++;
  }
  return { intents: [intent], conf: leftovers ? CONF_PARTIAL : CONF_OK };
}

function removeClause(w, k, st) {
  if (k >= w.length) return { intents: [{ do: "remove", target: pronounTarget("it", st) }], conf: CONF_GUESS };
  const t = parseTarget(w, k, st);
  if (!t) return null;
  const tail = readTail(w, t.end, st);
  return { intents: [{ do: "remove", target: withSide(t.target, tail.place) }], conf: tail.leftovers.length || t.known === false ? CONF_PARTIAL : CONF_OK };
}

function moveClause(w, k, st, { defaultPlace = null, spawnIfMissing = false } = {}) {
  const t = targetOrIt(w, k, st);
  let p = t.end;
  if (w[p] === "over" && p + 1 < w.length) p++;
  const tail = readTail(w, p, st);
  const place = tail.place || defaultPlace;
  if (place?.rel === "hand") {
    return { intents: [{ do: "hold", target: withSpawnIfMissing(t.target), hand: pickHand(st, place.hand) }], conf: CONF_OK };
  }
  const target = spawnIfMissing ? withSpawnIfMissing(t.target) : t.target;
  const intent = { do: "move", target, place: place || { rel: "front" } };
  const clean = !!place && !tail.leftovers.length && t.known !== false;
  return { intents: [intent], conf: clean ? CONF_OK : CONF_PARTIAL };
}

function scaleClause(w, k, st, verb) {
  const BASE = { grow: 1.5, enlarge: 1.5, embiggen: 1.5, expand: 1.5, shrink: 0.67, double: 2, triple: 3, quadruple: 4, halve: 0.5 };
  let factor = BASE[verb] ?? null;
  // "shrink"/"down" turn "by 2" into half size and "by 20 percent" into 80%.
  let down = verb === "shrink" || verb === "halve";
  let p = k;
  let e;
  if ((e = seq(w, p, "the? size|height of")) >= 0) p = e;
  if (w[p] === "up") {
    factor = 1.5;
    down = false;
    p++;
  } else if (w[p] === "down") {
    factor = 0.67;
    down = true;
    p++;
  }
  const t = targetOrIt(w, p, st);
  p = t.end;
  const leftovers = [];
  while (p < w.length) {
    if (w[p] === "up") {
      factor = 1.5;
      down = false;
      p++;
    } else if (w[p] === "down") {
      factor = 0.67;
      down = true;
      p++;
    } else if ((e = seq(w, p, "by|to a? half")) >= 0) {
      factor = verb === "grow" || verb === "enlarge" || verb === "expand" ? 1.5 : 0.5;
      p = e;
    } else if ((e = seq(w, p, "by|to # percent")) >= 0) {
      const n = Number(w[p + 1]) / 100;
      factor = r3(w[p] === "to" ? Math.max(0.05, n) : down ? Math.max(0.05, 1 - n) : 1 + n);
      p = e;
    } else if ((e = seq(w, p, "by|to|x # times|x?")) >= 0 && isNum(w[p + 1])) {
      const n = Number(w[p + 1]);
      factor = down && n > 1 ? r3(1 / n) : n;
      p = e;
    } else {
      const f = factorPhraseAt(w, p);
      if (f) {
        factor = f.factor;
        p = f.end;
      } else {
        if (!SKIP_TAIL.has(w[p])) leftovers.push(w[p]);
        p++;
      }
    }
  }
  if (!factor || !(factor > 0)) return null;
  return { intents: [{ do: "scale", target: t.target, factor: r3(factor) }], conf: leftovers.length ? CONF_PARTIAL : CONF_OK };
}

function colorClause(w, k, st) {
  let p = k;
  let e;
  if ((e = seq(w, p, "the color|colour of")) >= 0) p = e;
  const t = targetOrIt(w, p, st);
  const tail = readTail(w, t.end, st);
  const color = tail.color || (t.noun && t.noun.color) || null;
  if (!color) return null;
  return { intents: [{ do: "color", target: withSide(t.target, tail.place), color }], conf: tail.leftovers.length ? CONF_PARTIAL : CONF_OK };
}

// "make the crate red" / "make it bigger" / "make it disappear" / "make a crate".
function makeClause(w, k, st, opts) {
  if (isIndefinite(w, k) || w[k] === "me") return spawnClause(w, k, st, opts);
  const t = parseTarget(w, k, st);
  if (t) {
    const p = t.end;
    let e;
    if ((e = seq(w, p, "disappear|vanish|go|leave|poof away?")) >= 0) return { intents: [{ do: "remove", target: t.target }], conf: CONF_OK };
    const f = factorPhraseAt(w, p);
    if (f) return { intents: [{ do: "scale", target: t.target, factor: r3(f.factor) }], conf: f.end === w.length ? CONF_OK : CONF_PARTIAL };
    const c = colorPhraseAt(w, p);
    if (c) return { intents: [{ do: "color", target: t.target, color: c.color }], conf: c.end === w.length ? CONF_OK : CONF_PARTIAL };
    if (p === w.length && t.noun && !t.noun.known && t.noun.color) return { intents: [{ do: "color", target: t.target, color: t.noun.color }], conf: CONF_PARTIAL };
    if (p === w.length && t.noun?.known && !t.pronoun && t.article !== "the") return spawnClause(w, k, st, opts);
    return null;
  }
  return spawnClause(w, k, st, opts);
}

function flipClause(w, k, st) {
  let p = k;
  let e;
  if (p >= w.length || (w[p] === "over" && p === w.length - 1)) return { intents: [{ do: "flip" }], conf: CONF_OK };
  if ((e = seq(w, p, "all|both? the|my|those|these|our? playing? cards")) >= 0) {
    return { intents: [{ do: "flip", target: { part: "playing card", which: "all" } }], conf: seq(w, e, "over|up|down") >= 0 || e === w.length ? CONF_OK : CONF_PARTIAL };
  }
  if ((e = seq(w, p, "the|my|that|this|a? playing? card")) >= 0) {
    return { intents: [{ do: "flip", target: { part: "playing card", which: "nearest" } }], conf: CONF_OK };
  }
  const t = parseTarget(w, p, st);
  if (!t) return null;
  return { intents: [{ do: "flip", target: t.target }], conf: CONF_OK };
}

function shuffleClause(w, k, st) {
  if (k >= w.length) return { intents: [{ do: "shuffle" }], conf: CONF_OK };
  if (seq(w, k, "the|my|that|this? cards|deck|pack|it up?") === w.length) return { intents: [{ do: "shuffle" }], conf: CONF_OK };
  const t = parseTarget(w, k, st);
  if (!t) return { intents: [{ do: "shuffle" }], conf: CONF_PARTIAL };
  return { intents: [{ do: "shuffle", target: t.target }], conf: CONF_OK };
}

function dealClause(w, k, st) {
  let p = k;
  let count = null;
  let e;
  if (["me", "us", "out", "everyone", "everybody"].includes(w[p])) p++;
  if (isNum(w[p])) {
    count = Number(w[p]);
    p++;
  } else if ((e = seq(w, p, "a|an|1 hand")) >= 0) {
    count = 5;
    p = e;
  } else if ((e = seq(w, p, "a|an|1 single? playing? card")) >= 0) {
    count = 1;
    p = e;
  } else if (w[p] === "some") {
    count = 5;
    p++;
  }
  if (w[p] === "more") p++;
  if (w[p] === "playing") p++;
  if (w[p] === "cards" || w[p] === "card") p++;
  const intent = { do: "deal", count: Math.min(52, Math.max(1, Math.round(count ?? 5))) };
  let leftovers = 0;
  while (p < w.length) {
    if ((e = seq(w, p, "from|off|out of? the|my|that? deck|pack|cards")) >= 0) {
      p = e;
      continue;
    }
    if ((e = seq(w, p, "from|off|out of?")) >= 0) {
      const t = parseTarget(w, e, st);
      if (t) {
        intent.target = t.target;
        p = t.end;
        continue;
      }
    }
    if ((e = seq(w, p, "to|for me|us|everyone|everybody|each|all|players")) >= 0) {
      p = e;
      continue;
    }
    const pl = parsePlacement(w, p, st);
    if (pl) {
      if (pl.place) intent.place = finishPlace(pl.place);
      p = pl.end;
      continue;
    }
    if (!SKIP_TAIL.has(w[p])) leftovers++;
    p++;
  }
  return { intents: [intent], conf: leftovers ? CONF_PARTIAL : CONF_OK };
}

// "turn the crate green" / "turn the cards over".
function turnClause(w, k, st) {
  const t = parseTarget(w, k, st);
  if (t && w[t.end] === "over") return flipClause(w.slice(0, t.end), k, st);
  return colorClause(w, k, st);
}

// "change the color of the crate to red" / "change it to blue".
function changeClause(w, k, st) {
  return colorClause(w, k, st);
}

// "set the crate on the desk" / "set the color of the crate to red" / "set it down".
function setClause(w, k, st) {
  if (seq(w, k, "the color|colour of") >= 0) return colorClause(w, k, st);
  const t = parseTarget(w, k, st);
  if (t && w[t.end] === "down") return dropClause(w, k, st);
  return moveClause(w, k, st, { spawnIfMissing: true });
}

function putClause(w, k, st, opts) {
  if (isIndefinite(w, k)) return spawnClause(w, k, st, opts);
  const t = parseTarget(w, k, st);
  if (!t) return spawnClause(w, k, st, opts);
  if (w[t.end] === "down") return dropClause(w, k, st);
  if (w[t.end] === "away" && t.end === w.length - 1) return { intents: [{ do: "remove", target: t.target }], conf: CONF_OK };
  return moveClause(w, k, st, { spawnIfMissing: true });
}

function bringClause(w, k, st, opts) {
  if (isIndefinite(w, k)) return spawnClause(w, k, st, opts);
  const t = parseTarget(w, k, st);
  if (!t) return spawnClause(w, k, st, opts);
  return moveClause(w, k, st, { defaultPlace: { rel: "here" }, spawnIfMissing: true });
}

// "give me an axe" spawns into a hand; "give me the sword" holds an existing one.
function giveClause(w, k, st, opts) {
  const t = isIndefinite(w, k) ? null : parseTarget(w, k, st);
  if (!t || (t.noun && !DEFINITE.has(w[k]))) return spawnClause(w, k, st, { ...opts, autoHand: true });
  return holdClause(w, k, st, opts);
}

function dispatch(cls, w, k, st, opts) {
  switch (cls) {
    case "spawn": return spawnClause(w, k, st, opts);
    case "give": return giveClause(w, k, st, opts);
    case "hold": return holdClause(w, k, st, opts);
    case "drop": return dropClause(w, k, st);
    case "remove": return removeClause(w, k, st);
    case "move": return moveClause(w, k, st);
    case "bring": return bringClause(w, k, st, opts);
    case "put": return putClause(w, k, st, opts);
    case "scale": return scaleClause(w, k, st, w[k - 1]);
    case "color": return colorClause(w, k, st);
    case "turn": return turnClause(w, k, st);
    case "change": return changeClause(w, k, st);
    case "set": return setClause(w, k, st);
    case "make": return makeClause(w, k, st, opts);
    case "flip": return flipClause(w, k, st);
    case "shuffle": return shuffleClause(w, k, st);
    case "deal": return dealClause(w, k, st);
    default: return null;
  }
}

function parseWords(w, st, opts) {
  const joined = w.join(" ");
  let m;
  if ((m = joined.match(UNDO_RE)) || (m = joined.match(UNDO_N_RE))) {
    const count = Math.min(20, Math.max(1, Number(m[1] || 1)));
    return { intents: [count > 1 ? { do: "undo", count } : { do: "undo" }], conf: CONF_OK, cls: null };
  }
  if (CLEAR_RE.test(joined)) return { intents: [{ do: "clear" }], conf: CONF_OK, cls: null };
  if (LIST_RE.test(joined)) return { intents: [{ do: "list" }], conf: CONF_OK, cls: null };
  if ((m = joined.match(TIME_RE))) return { intents: [{ do: "time", value: TIME_WORDS[m[1]] }], conf: CONF_OK, cls: null };
  const marker = markerClause(w, st);
  if (marker) return { ...marker, cls: null };

  for (const verb of VERB_LIST) {
    if (!startsWithAt(w, 0, verb.words)) continue;
    const k = verb.words.length;
    const res = dispatch(verb.cls, w, k, st, opts);
    if (res) {
      const spawned = res.intents.some((i) => i.do === "spawn");
      res.cls = spawned && verb.cls !== "give" ? "spawn" : verb.cls === "give" ? "give" : verb.cls;
      return res;
    }
    if (verb.cls === "say") return null;
  }
  // No verb: continue the previous clause's verb ("spawn a desk and a chair"), or treat a bare
  // object as a spawn. A clause that spawned continues as "spawn" whatever its verb was.
  if (st.lastCls) {
    const res = dispatch(st.lastCls, w, 0, st, opts);
    if (res) {
      res.cls = st.lastCls;
      return res;
    }
  }
  const res = spawnClause(w, 0, st, opts);
  if (res && res.intents[0].what.part) {
    res.conf = Math.min(res.conf, CONF_GUESS);
    res.cls = "spawn";
    return res;
  }
  return null;
}

// ---------- raw-text commands (writing keeps the original case) ----------

function noteIntent(text, st) {
  const meta = metaByName(st, "sticky note") || st.metas.find((x) => x?.writable && x?.holdable) || st.metas.find((x) => x?.writable);
  if (!meta) return { do: "write", text };
  const intent = { do: "spawn", what: { part: meta.name } };
  if (text) intent.text = text;
  return intent;
}

function writeIntent(rest, st) {
  let payload = rest;
  let target = null;
  const pron = ["it", "that", "there", "this", "them"];
  const pre = rest.match(/^(?:on|onto|in|into)\s+(?:(?:the|a|an|my|this|that)\s+)?([\s\S]+)$/i);
  if (pre) {
    const words = normalizeText(pre[1]).split(" ").filter(Boolean);
    if (pron.includes(words[0])) {
      target = pronounTarget("it", st);
      payload = rawAfterWords(pre[1], 1);
    } else {
      const pm = matchPart(words, st.metas, { start: 0, anchored: true });
      if (pm) {
        target = { part: pm.name, which: "nearest" };
        payload = rawAfterWords(pre[1], pm.end);
      }
    }
  }
  if (!target) {
    const hits = [...rest.matchAll(/\s(?:on|onto|in|into|to)\s/gi)];
    for (let h = hits.length - 1; h >= 0; h--) {
      const tail = rest.slice(hits[h].index + hits[h][0].length);
      let words = normalizeText(tail).split(" ").filter(Boolean);
      if (words.length > 1 && (DEFINITE.has(words[0]) || ARTICLES.has(words[0]))) words = words.slice(1);
      if (words.length === 1 && pron.includes(words[0])) {
        target = pronounTarget("it", st);
      } else {
        const pm = words.length ? matchPart(words, st.metas, { start: 0, anchored: true }) : null;
        if (pm && pm.end === words.length) target = { part: pm.name, which: "nearest" };
      }
      if (target) {
        payload = rest.slice(0, hits[h].index);
        break;
      }
    }
  }
  const intent = { do: "write", text: cleanPayload(payload) };
  if (target) intent.target = target;
  return intent;
}

function rawClause(raw, st) {
  const s = raw.replace(WRITE_LEAD_RE, "").trim();
  let m;
  if ((m = s.match(SAY_TEXT_RE))) {
    const words = normalizeText(m[1]).split(" ").filter(Boolean);
    const pm = words.length ? matchPart(words, st.metas, { start: 0, anchored: true }) : null;
    const target = pm ? { part: pm.name, which: "nearest" } : pronounTarget("it", st);
    if (pm || !words.length) return { intents: [{ do: "write", target, text: cleanPayload(m[2]) }], conf: CONF_OK };
  }
  if ((m = s.match(/^(?:say|speak|announce)\s+([\s\S]+)$/i))) {
    return { intents: [{ do: "say", text: cleanPayload(m[1]).slice(0, 500) }], conf: 0.85 };
  }
  if ((m = s.match(NOTE_RE))) {
    const text = cleanPayload(m[1]);
    return { intents: [noteIntent(text, st)], conf: text ? CONF_OK : CONF_PARTIAL };
  }
  if ((m = s.match(WRITE_RE))) {
    const intent = writeIntent(m[1], st);
    return { intents: [intent], conf: intent.text ? CONF_OK : CONF_PARTIAL };
  }
  return null;
}

// ---------- clause splitting ----------

function splitClauses(body, st) {
  const andPhrases = [];
  for (const meta of st.metas) {
    for (const phrase of [meta?.name, ...(meta?.aliases || [])]) {
      const norm = normalizeText(phrase || "");
      if (norm.includes(" and ")) andPhrases.push(norm);
    }
  }
  const pieces = [];
  let last = 0;
  let prevSep = "";
  const greedy = (piece) => {
    const stripped = stripWake(piece, st.wakeWords);
    const text = stripped.matched ? stripped.rest : piece;
    return GREEDY_RE.test(text.trim()) || TEXT_INTRO_RE.test(` ${text}`) || SAY_TEXT_RE.test(text.replace(WRITE_LEAD_RE, "").trim());
  };
  // Whisper's commas: "spawn a villa, to my left" and "spawn three, uh, crates" are one clause.
  const push = (piece) => {
    const w = clauseWords(piece);
    if (!w.length) return;
    const prev = pieces.length && /^[\s,;.]+$/.test(prevSep) ? clauseWords(pieces[pieces.length - 1]) : null;
    const dangling = prev && isNum(prev[prev.length - 1]) && !stripWake(piece, st.wakeWords).matched
      && !VERB_LIST.some((v) => startsWithAt(w, 0, v.words));
    if (prev && (isTailPiece(w) || dangling)) pieces[pieces.length - 1] += ` ${piece}`;
    else pieces.push(piece);
  };
  for (const m of body.matchAll(SEP_RE)) {
    if (/\band\b/i.test(m[0]) && andPhrases.length) {
      const around = normalizeText(body.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40));
      if (andPhrases.some((phrase) => around.includes(phrase))) continue;
    }
    const piece = body.slice(last, m.index);
    if (/\band\b/i.test(m[0]) && /\bbetween\s+(?:\S+\s+){0,3}\S+\s*$/i.test(piece)) continue;
    if (greedy(piece)) {
      pieces.push(body.slice(last));
      return pieces.map((x) => x.trim()).filter(Boolean);
    }
    push(piece);
    prevSep = m[0];
    last = m.index + m[0].length;
  }
  push(body.slice(last));
  return pieces.map((x) => x.trim()).filter(Boolean);
}

const TAIL_START = new Set([
  "to", "on", "onto", "in", "into", "at", "next", "beside", "near", "nearby", "by", "behind", "above", "over", "under",
  "below", "beneath", "here", "there", "ahead", "far", "close", "closer", "left", "right", "front", "inside", "between",
  "away", "atop", "upon", "toward", "towards", "alongside", "across", "overhead", "forward",
]);

const clauseWords = (piece) => stripFillers(normalizeText(piece).split(" ").filter(Boolean));

// A verbless continuation (clause words): placement, hand, distance or "the one ...".
function isTailPiece(w) {
  if (!w.length) return false;
  if (TAIL_START.has(w[0])) return true;
  if (isNum(w[0]) && w[1] in UNITS) return true;
  return DEFINITE.has(w[0]) && w[1] === "1";
}

function addResult(res, st) {
  for (const intent of res.intents) {
    st.intents.push(intent);
    if (intent.do === "spawn") st.lastSpawn = st.intents.length - 1;
  }
  st.confs.push(res.conf);
  if (res.unknown) st.unknown.push(...res.unknown);
  if (res.cls !== undefined) st.lastCls = res.cls;
}

function parsePiece(piece, st) {
  let raw = piece.trim();
  const wake = stripWake(raw, st.wakeWords);
  if (wake.matched) raw = wake.rest;
  if (!raw) return;
  const direct = rawClause(raw, st);
  if (direct) {
    addResult(direct, st);
    return;
  }
  let text;
  const intro = TEXT_INTRO_RE.exec(` ${raw}`);
  if (intro) {
    text = cleanPayload(` ${raw}`.slice(intro.index + intro[0].length)) || undefined;
    raw = ` ${raw}`.slice(0, intro.index);
  }
  const words = stripFillers(normalizeText(raw).split(" ").filter(Boolean).map((x) => (x === "note:" ? "note" : x)));
  if (!words.length) return;
  const res = parseWords(words, st, { text });
  if (res) addResult(res, st);
  else st.confs.push(0.2);
}

// ---------- magic marker (ARCHITECTURE.md "Magic marker") ----------

const DRAWING_RE = "(?:(?:the|my|that|this) )?(?:drawing|sketch|doodle|scribble|picture|lines)";
const SELF_DRAWING = `(?:it|this|that|${DRAWING_RE})`;
const BEHAVIORS = {
  fly: "fly", flying: "fly", soar: "fly", swim: "swim", swimming: "swim", walk: "walk", walking: "walk", run: "walk",
  running: "walk", hop: "hop", hopping: "hop", jump: "hop", jumping: "hop", roll: "roll", rolling: "roll", spin: "spin",
  spinning: "spin", rotate: "spin", float: "float", floating: "float", hover: "float", levitate: "float", bounce: "bounce",
  bouncing: "bounce", sway: "sway", swaying: "sway", dance: "sway", dancing: "sway", wiggle: "sway", wobble: "sway",
};
const SPEEDS = { fast: 2, faster: 2, quickly: 2, quick: 2, slow: 0.5, slowly: 0.5, slower: 0.5 };
const GUESS_RE = /^(?:what(?:'s| is) (?:this|that|it|my drawing)(?: supposed to be)?|what do you think (?:this|that|it) is|what do you think i drew|what did i (?:just )?draw|what am i drawing|guess what (?:this|that|it) is|guess what i(?: just)? drew|guess what i'm drawing|(?:can you|do you) (?:tell|know) what (?:this|that|it) is|what do you see|what does (?:this|that|it) look like|guess|can you guess)$/;
// Bare "it's ..." needs "a/an" so chat like "that's awesome" or "it's too big" is not a correction.
const CORRECT_RE = /^(?:(?:(?:it|that|this)(?:'s| is| was) (?:supposed|meant) to be|(?:it|that|this) should be|i drew|i meant|make it be) (?:actually |really )?(?:a |an )?|(?:it's|it is|that's|that is|this is) (?:actually |really |obviously |clearly )?(?:a|an) )(.+)$/;
// "it's not a fish (it's a gun)": the negated part alone means nothing to do.
const NOT_RE = /^(?:it|that|this)(?:'s not| is not| isn't) (?:a|an) .+?(?: (?:but |it's |it is |that's |that is |this is |it should be |i drew |i meant )+(?:actually )?(?:a |an )?(.+))?$/;
const REALIZE_RE = new RegExp(`^(?:(?:make|bring|turn) ${SELF_DRAWING} (?:real|alive|to life|come alive|come to life)|${SELF_DRAWING} come (?:alive|to life)|come (?:alive|to life)|realize(?: ${SELF_DRAWING})?)(?: as (?:a |an )?(.+))?$`);
const HINT_RE = new RegExp(`^(?:make|turn) ${SELF_DRAWING} (?:into )?(?:a|an) (.+)$`);
const ERASE_RE = new RegExp(`^(?:(?:erase|wipe|clear|delete|remove|rub out|scrub) ${DRAWING_RE}(?:e?s)?|wipe(?: it| that| this)?)$`);
const ERASE_ALL_RE = /^(?:erase|wipe|clear|delete|remove|rub out|scrub)(?: out)? (?:all|every|each)(?: of)?(?: the| my)? (?:drawing|sketch|doodle|scribble)(?:e?s)?$/;
// "wipe the whiteboard", "erase the writing on the board": clears text, keeps the object.
const WIPE_TEXT_RE = /^(?:clear|wipe|erase|clean|reset|rub out|scrub)(?: off| down)? (?:(?:the )?(?:text|writing|words) (?:on|from|off) )?(?:the |my |that |this )?(.+?)(?: text| writing)?(?: clean| off| down)?$/;
const STOP_RE = /^(?:stop moving|stop it|make it stop|freeze|stay still|stand still|hold still|stop)$/;
const HINT_TAIL = new Set(["1", "one", "shade", "tone", "hue", "size", "color", "colour"]);

// Behavior words from w[p] to the end ("swim", "fly around fast", "stop moving") → behavior or null.
function behaviorTail(w, p) {
  if (w[p] === "stop") return p + 1 === w.length || (w[p + 1] === "moving" && p + 2 === w.length) ? "none" : null;
  const kind = BEHAVIORS[w[p]];
  if (!kind) return null;
  p++;
  if (w[p] === "around") p++;
  const speed = SPEEDS[w[p]];
  if (speed) p++;
  if (p !== w.length) return null;
  return speed ? { kind, speed } : kind;
}

const correctLabel = (label) => label.replace(/ not (?:a |an )?.*$/, "").trim();

// → { intents, conf } for marker phrases, or null.
function markerClause(w, st) {
  const j = w.join(" ");
  let m;
  if (GUESS_RE.test(j)) return { intents: [{ do: "guess" }], conf: CONF_OK };
  if ((m = j.match(REALIZE_RE))) return { intents: [m[1] ? { do: "realize", hint: m[1] } : { do: "realize" }], conf: CONF_OK };
  if ((m = j.match(HINT_RE))) {
    const rest = m[1].split(" ");
    const phrase = factorPhraseAt(rest, 0) || colorPhraseAt(rest, 0);
    // "make it a bit bigger" / "make it a red color" are not hints; "make it a red fish" is.
    if (!phrase || (phrase.end < rest.length && !HINT_TAIL.has(rest[phrase.end]))) return { intents: [{ do: "realize", hint: m[1] }], conf: CONF_OK };
  }
  if (ERASE_RE.test(j)) return { intents: [{ do: "erase" }], conf: CONF_OK };
  if (ERASE_ALL_RE.test(j)) return { intents: [{ do: "erase", target: { part: "drawing", which: "all" } }], conf: CONF_OK };
  if ((m = j.match(WIPE_TEXT_RE))) {
    // Empty text wipes the board; things that hold no writing ("clear the desk") are removed below.
    if (m[1] === "board") return { intents: [{ do: "write", text: "" }], conf: CONF_OK };
    const words = m[1].split(" ");
    const pm = matchPart(words, st.metas, { start: 0, anchored: true });
    if (pm && pm.end === words.length && metaByName(st, pm.name)?.writable) {
      return { intents: [{ do: "write", target: { part: pm.name, which: "nearest" }, text: "" }], conf: CONF_OK };
    }
  }
  if (STOP_RE.test(j)) return { intents: [{ do: "animate", target: pronounTarget("it", st), behavior: "none" }], conf: CONF_OK };
  if ((m = j.match(NOT_RE))) return { intents: m[1] ? [{ do: "correct", label: correctLabel(m[1]) }] : [], conf: CONF_OK };
  if ((m = j.match(CORRECT_RE)) && !m[1].startsWith("not ")) return { intents: [{ do: "correct", label: correctLabel(m[1]) }], conf: CONF_OK };
  // "make it fly", "make the fish swim fast", "let the dog walk", "make the bird stop".
  if (["make", "let", "have"].includes(w[0])) {
    for (let p = 2; p < w.length; p++) {
      const behavior = behaviorTail(w, p);
      if (!behavior) continue;
      const t = parseTarget(w.slice(0, p), 1, st);
      if (t && t.end === p) return { intents: [{ do: "animate", target: t.target, behavior }], conf: CONF_OK };
    }
  }
  return null;
}

// ---------- entry point ----------

export function parseCommand(text, { metas = [], wakeRequired = false, wakeWords, hand = "right" } = {}) {
  const raw = String(text ?? "").trim();
  const wake = stripWake(raw, wakeWords);
  const out = { intents: [], say: "", confidence: 0, unknown: [], wake: wake.matched, text: "" };
  if (wakeRequired && !wake.matched) {
    out.text = normalizeText(raw);
    return out;
  }
  const body = wake.matched ? wake.rest : raw;
  out.text = normalizeText(body);
  const st = {
    metas: Array.isArray(metas) ? metas.filter(Boolean) : [],
    hand: hand === "left" ? "left" : "right",
    wakeWords,
    intents: [],
    confs: [],
    unknown: [],
    say: [],
    lastCls: null,
    lastSpawn: -1,
    handsUsed: new Set(),
  };
  for (const piece of splitClauses(body, st)) parsePiece(piece, st);
  out.intents = st.intents;
  out.unknown = [...new Set(st.unknown)];
  out.say = [...new Set(st.say)].join(" ");
  out.confidence = st.intents.length ? Math.min(...st.confs) : 0;
  return out;
}
