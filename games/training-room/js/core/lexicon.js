// Word-level helpers shared by the rule parser, the executor and the bridge: text normalization,
// number words, plurals, part-name matching and color names. Pure (no DOM, no three.js).

export const COLORS = {
  red: "#d63a3a", crimson: "#b0182e", scarlet: "#e0301e", ruby: "#b3123a", maroon: "#7a1f2b",
  burgundy: "#6e1a2e", rust: "#a5492a", orange: "#f08a24", amber: "#f0a020", peach: "#f5c09a",
  coral: "#f27a64", salmon: "#f29a80", yellow: "#f2d43d", gold: "#d4af37", golden: "#d4af37",
  lime: "#d5fb6a", green: "#3fa34d", "light green": "#8fd47a", "dark green": "#1f5e2e",
  "forest green": "#2e5e30", emerald: "#2fa868", olive: "#7a7f2a", mint: "#9ee6c0",
  teal: "#1f9e94", turquoise: "#40c8b8", aqua: "#5ee0d8", cyan: "#3fd0e0",
  "sky blue": "#7cc4f2", "light blue": "#9fd0f5", blue: "#2f6fd6", "dark blue": "#1c2f7a",
  "royal blue": "#2a4fc0", sapphire: "#2a4fb0", navy: "#1f2f5c", "navy blue": "#1f2f5c",
  indigo: "#4b3fa8", purple: "#8a3fc0", violet: "#9b6ad8", lavender: "#c3b1e8", lilac: "#c8a2d8",
  plum: "#7a3a6e", magenta: "#d63ab0", pink: "#f28ab8", "hot pink": "#ff4fa3",
  brown: "#7a4f2c", "dark brown": "#4a2f1a", tan: "#c9a978", beige: "#e6d8b8", khaki: "#bdb07a",
  cream: "#f3ecd2", ivory: "#f6f1e1", white: "#f4f4f0", black: "#1b1b1b", charcoal: "#333836",
  gray: "#8a8f8a", grey: "#8a8f8a", "light gray": "#c4c8c2", "light grey": "#c4c8c2",
  "dark gray": "#45494a", "dark grey": "#45494a", silver: "#c0c4c8", bronze: "#a8713a", copper: "#b8733a",
};

const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1000 };
const EXTRA = { once: 1, single: 1, twice: 2, thrice: 3, couple: 2, few: 3, dozen: 12, half: 0.5 };

// Number value of one word ("3", "2.5", "three", "twenty", "dozen", "twice") or null.
export function parseNumber(word) {
  if (word === undefined || word === null) return null;
  const w = String(word).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(w) || /^\.\d+$/.test(w)) return Number(w);
  if (w in SMALL) return SMALL[w];
  if (w in TENS) return TENS[w];
  if (w in SCALES) return SCALES[w];
  if (w in EXTRA) return EXTRA[w];
  return null;
}

const isNumberWord = (w) => w in SMALL || w in TENS || w in SCALES;
const fmt = (n) => String(Math.round(n * 1000) / 1000);

// Turns a token list into one where number phrases are digits ("twenty five" → "25").
function convertNumbers(tokens) {
  const out = [];
  let i = 0;
  const at = (k) => tokens[k];
  while (i < tokens.length) {
    const w = at(i);
    // Fixed phrases first.
    if ((w === "a" || w === "an") && at(i + 1) === "couple") {
      out.push("2");
      i += at(i + 2) === "of" ? 3 : 2;
      continue;
    }
    if (w === "couple" && at(i + 1) === "of") {
      out.push("2");
      i += 2;
      continue;
    }
    if ((w === "a" || w === "an") && at(i + 1) === "few") {
      out.push("3");
      i += 2;
      continue;
    }
    if ((w === "a" || w === "an") && at(i + 1) === "dozen") {
      out.push("12");
      i += at(i + 2) === "of" ? 3 : 2;
      continue;
    }
    if (w === "dozen") {
      out.push("12");
      i += at(i + 1) === "of" ? 2 : 1;
      continue;
    }
    if (w === "half" && (at(i + 1) === "a" || at(i + 1) === "an")) {
      out.push("0.5");
      i += 2;
      continue;
    }
    if ((w === "a" || w === "an") && (at(i + 1) === "hundred" || at(i + 1) === "thousand")) {
      tokens = [...tokens.slice(0, i), "one", ...tokens.slice(i + 1)];
      continue;
    }
    // Number words or digits, possibly compound, possibly "and a half", possibly "N dozen".
    const digit = /^\d+(\.\d+)?$/.test(w);
    if (digit || isNumberWord(w)) {
      let total = 0;
      let current = 0;
      let j = i;
      if (digit) {
        current = Number(w);
        j = i + 1;
      } else {
        let lastKind = "";
        while (j < tokens.length) {
          const t = at(j);
          if (t in SMALL && lastKind !== "small" && lastKind !== "teen") {
            if (lastKind === "tens" && SMALL[t] >= 10) break;
            current += SMALL[t];
            lastKind = SMALL[t] >= 10 ? "teen" : "small";
          } else if (t in TENS && (lastKind === "" || lastKind === "scale")) {
            current += TENS[t];
            lastKind = "tens";
          } else if (t === "hundred" && lastKind !== "scale") {
            current = (current || 1) * 100;
            lastKind = "scale";
          } else if (t === "thousand") {
            total += (current || 1) * 1000;
            current = 0;
            lastKind = "scale";
          } else if (t === "and" && lastKind === "scale" && at(j + 1) && (isNumberWord(at(j + 1)) && !(at(j + 1) in SCALES))) {
            j++;
            continue;
          } else {
            break;
          }
          j++;
        }
      }
      let value = total + current;
      if (at(j) === "and" && (at(j + 1) === "a" || at(j + 1) === "an") && at(j + 2) === "half") {
        value += 0.5;
        j += 3;
      } else if (at(j) === "dozen") {
        value *= 12;
        j += 1;
      }
      out.push(fmt(value));
      i = j;
      continue;
    }
    out.push(w);
    i++;
  }
  return out;
}

// Lowercase, ascii quotes, punctuation stripped (keeps decimals, in-word apostrophes, "note:"),
// number words → digits, single spaces. Articles stay.
export function normalizeText(text) {
  let s = String(text ?? "").normalize("NFKC").toLowerCase();
  s = s.replace(/[‘’‛′´`]/g, "'").replace(/[“”„″]/g, '"');
  const tokens = [];
  const re = /#[0-9a-f]{6}(?![\p{L}\p{N}])|#[0-9a-f]{3}(?![\p{L}\p{N}])|[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*:?/gu;
  for (const m of s.matchAll(re)) {
    let tok = m[0];
    if (tok[0] === "#") {
      tokens.push(tok);
      continue;
    }
    let colon = false;
    if (tok.endsWith(":")) {
      tok = tok.slice(0, -1);
      colon = true;
    }
    // Decimal points only between digits; other dots split the token ("a.i" → "a i").
    const parts = tok.split(/(?<!\d)\.|\.(?!\d)/).filter(Boolean);
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k];
      const last = k === parts.length - 1;
      tokens.push(colon && last && part === "note" ? "note:" : part);
    }
  }
  return convertNumbers(tokens).join(" ");
}

const IRREGULAR = {
  knives: "knife", wives: "wife", lives: "life", leaves: "leaf", wolves: "wolf", shelves: "shelf",
  halves: "half", loaves: "loaf", thieves: "thief", calves: "calf", elves: "elf", scarves: "scarf",
  men: "man", women: "woman", people: "person", children: "child", mice: "mouse", geese: "goose",
  feet: "foot", teeth: "tooth", oxen: "ox", cacti: "cactus", fungi: "fungus", axes: "axe",
  buses: "bus", tomatoes: "tomato", potatoes: "potato", heroes: "hero", echoes: "echo",
  torpedoes: "torpedo", volcanoes: "volcano", mangoes: "mango", dominoes: "domino",
  movies: "movie", cookies: "cookie", zombies: "zombie", pixies: "pixie", rookies: "rookie",
  calories: "calorie", goalies: "goalie", smoothies: "smoothie", ties: "tie", pies: "pie", lies: "lie",
  dies: "die", pennies: "penny", ponies: "pony", lilies: "lily", candies: "candy",
};
const INVARIANT = new Set([
  "dice", "sheep", "fish", "deer", "series", "species", "news", "chess", "glass", "grass", "moss",
  "boss", "cross", "dress", "press", "compass", "cactus", "bus", "gas", "yes", "his", "its", "this",
  "was", "has", "is", "as", "us", "plus", "status", "campus", "chassis", "axis", "lens", "pants",
  "scissors", "binoculars", "glasses", "jeans", "shorts", "goggles", "headphones", "always", "chaos",
  "physics", "less", "bonus", "virus", "octopus", "walrus", "iris", "tennis", "billiards", "darts",
]);

// Plural → singular for catalog matching ("boxes" → "box", "knives" → "knife", "dice" stays).
export function singularize(word) {
  const w = String(word ?? "").toLowerCase();
  if (w.length <= 2 || /\d/.test(w)) return w;
  if (w in IRREGULAR) return IRREGULAR[w];
  if (w === "glasses") return "glass";
  if (INVARIANT.has(w)) return w;
  if (/(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ches|shes|sses|xes|zzes)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w) && !/'s$/.test(w)) return w.slice(0, -1);
  return w;
}

// Optimal string alignment distance with early exit above `max`.
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = [];
  for (let i = 0; i < rows; i++) {
    d.push(new Array(cols).fill(0));
    d[i][0] = i;
  }
  for (let j = 0; j < cols; j++) d[0][j] = j;
  for (let i = 1; i < rows; i++) {
    let rowMin = Infinity;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

const indexCache = new WeakMap();
let lastIndex = { key: "", entries: [] };

// Phrase index per catalog. allMeta() returns a fresh array each call, so a content key
// lets repeated parses reuse the last index.
function phraseIndex(metas) {
  const list = Array.isArray(metas) ? metas : [];
  const cached = indexCache.get(list);
  if (cached && cached.length === list.length) return cached.entries;
  const key = list.map((m) => (m ? `${m.name}|${(m.aliases || []).join(",")}` : "")).join(";");
  if (key === lastIndex.key) {
    indexCache.set(list, { length: list.length, entries: lastIndex.entries });
    return lastIndex.entries;
  }
  const entries = [];
  for (const meta of list) {
    if (!meta || !meta.name) continue;
    const phrases = new Set([meta.name, ...(Array.isArray(meta.aliases) ? meta.aliases : [])]);
    for (const phrase of phrases) {
      const words = normalizeText(phrase).split(" ").filter(Boolean);
      if (!words.length) continue;
      entries.push({ name: meta.name, phrase: String(phrase).toLowerCase(), words, sing: words.map(singularize), canonical: phrase === meta.name });
    }
  }
  indexCache.set(list, { length: list.length, entries });
  lastIndex = { key, entries };
  return entries;
}

function wordScore(w, sw, e, se) {
  if (w === e) return 1;
  if (sw === se) return 0.95;
  if (/^\d/.test(w) || /^\d/.test(e)) return 0;
  if (w.length >= 5 && e.length >= 5 && editDistance(w, e, 1) <= 1) return 0.8;
  if (sw.length >= 5 && se.length >= 5 && editDistance(sw, se, 1) <= 1) return 0.75;
  return 0;
}

function scoreAt(words, sing, i, entry) {
  const n = entry.words.length;
  if (i + n > words.length) return 0;
  let score = 1;
  for (let k = 0; k < n; k++) {
    const s = wordScore(words[i + k], sing[i + k], entry.words[k], entry.sing[k]);
    if (!s) return 0;
    if (s < score) score = s;
  }
  return score;
}

// Finds the longest catalog phrase (name or alias) in `words`. Ties: better score, earlier start,
// canonical name. `anchored` only considers phrases starting exactly at `start`.
export function matchPart(words, metas, { start = 0, anchored = false } = {}) {
  const list = Array.isArray(words) ? words.map((w) => String(w).toLowerCase()) : normalizeText(words).split(" ").filter(Boolean);
  if (!list.length) return null;
  const sing = list.map(singularize);
  const entries = phraseIndex(metas);
  let best = null;
  const last = anchored ? Math.min(start, list.length - 1) : list.length - 1;
  for (let i = Math.max(0, start); i <= last; i++) {
    for (const entry of entries) {
      const n = entry.words.length;
      if (best && n < best.len) continue;
      const score = scoreAt(list, sing, i, entry);
      if (!score) continue;
      const better = !best || n > best.len || (n === best.len && (score > best.score
        || (score === best.score && (i < best.start || (i === best.start && entry.canonical && !best.canonical)))));
      if (better) best = { name: entry.name, score, start: i, end: i + n, len: n, canonical: entry.canonical };
    }
  }
  if (!best) return null;
  return { name: best.name, score: best.score, start: best.start, end: best.end, phrase: list.slice(best.start, best.end).join(" ") };
}

// Color word or phrase ("navy", "light blue", "#ff8800") → "#rrggbb" or null.
export function matchColor(word) {
  if (word === undefined || word === null) return null;
  const w = String(word).trim().toLowerCase().replace(/\s+/g, " ").replace(/^(the color|colour|color) /, "").replace(/ (colou?red)$/, "");
  if (/^#[0-9a-f]{6}$/.test(w)) return w;
  if (/^#[0-9a-f]{3}$/.test(w)) return "#" + w[1] + w[1] + w[2] + w[2] + w[3] + w[3];
  if (w in COLORS) return COLORS[w];
  const flat = w.replace(/[-_]/g, " ");
  if (flat in COLORS) return COLORS[flat];
  return null;
}
