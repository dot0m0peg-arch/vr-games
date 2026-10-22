// Built-in rule parser: spoken/typed command → intents (ARCHITECTURE.md "Intents").
// The local model produces the same intents; this parser handles common commands instantly
// and reports low confidence when the runner should ask the model instead.
import { normalizeText, singularize, matchPart, matchColor, parseNumber } from "./lexicon.js";
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
const CLEAR_RE = /^(?:(?:clear|reset|wipe|empty|clean)(?: up| out)?(?: (?:everything|all|it all|it|everything out|(?:the )?(?:whole )?(?:field|room|area|world|scene|space|map|place|thing|board)))?|start (?:over|fresh|again)|reset everything|remove all objects|delete all objects)$/;
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
  "i would like to", "you can", "you should", "yo", "alright", "actually", "hmm", "ai", "after that",
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
      if (w.length > f.length && startsWithAt(w, 0, f)) {
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
      if (w.length > f.length && startsWithAt(w, w.length - f.length, f)) {
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
function findNoun(w, k, st) {
  const descriptors = [];
  let color = null;
  let scale = null;
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
    if (BOUNDARY.has(word) || isNum(word)) break;
    const c = colorAt(w, p);
    if (c) {
      color = c.color;
      p = c.end;
      continue;
    }
    if (word in SIZE_WORDS) {
      if (SIZE_WORDS[word] !== 1) scale = SIZE_WORDS[word];
      p++;
      continue;
    }
    if (FILLER_ADJ.has(word) || DEFINITE.has(word) || ARTICLES.has(word)) {
      p++;
      continue;
    }
    descriptors.push(word);
    p++;
  }
  if (!descriptors.length) return null;
  const words = [...descriptors];
  const last = words[words.length - 1];
  const plural = last !== singularize(last);
  words[words.length - 1] = singularize(last);
  return { known: false, label: words.join(" "), end: p, color, scale, descriptors, plural, score: 0 };
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
const LAST_REFS = ["the last|latest|newest|previous|most recent 1|thing|object|item|one", "last 1|thing", "the last"];
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
    if (which === null && isNum(w[end]) && !(w[end + 1] in UNITS) && Number.isInteger(Number(w[end]))) {
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
    const from = seq(w, k, `away|out from ${SELF}`);
    if (from >= 0) return { place: { rel: "front", dist }, end: from };
    if (w[k] === "away" || w[k] === "out" || w[k] === "off") return { place: { rel: "front", dist }, end: k + 1 };
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
  if ((e = seq(w, p, "# times as? big|bigger|large|larger|taller|the size|size")) >= 0 || (e = seq(w, p, "# x|times")) >= 0) {
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
  if ((e = seq(w, p, "much|way|far|lots|a? lot bigger|larger|taller")) >= 0) return { factor: 2, end: e };
  if ((e = seq(w, p, "much|way|far|lots|a? lot smaller|shorter|tinier")) >= 0) return { factor: 0.5, end: e };
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
