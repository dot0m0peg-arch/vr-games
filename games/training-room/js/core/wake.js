// Wake word detection at the start of a transcript ("AI, spawn a villa" → "spawn a villa").
// Works on word tokens so "aim the cannon" or "air horn" never match "ai".
export const DEFAULT_WAKE_WORDS = ["ai", "a.i.", "a i", "hey ai", "okay ai", "ok ai", "eh i", "ay"];

const LEAD_FILLERS = new Set(["hey", "hi", "hello", "okay", "ok", "yo", "oh", "um", "uh", "erm", "so", "alright", "well"]);
const TOKEN_RE = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;

function tokenize(text) {
  const out = [];
  for (const m of String(text).matchAll(TOKEN_RE)) out.push({ w: m[0].toLowerCase(), end: m.index + m[0].length });
  return out;
}

const wakeCache = new Map();
function wakeTokens(words) {
  const key = words.join("\u0001");
  let list = wakeCache.get(key);
  if (!list) {
    list = words.map((w) => tokenize(String(w).normalize("NFKC")).map((t) => t.w)).filter((t) => t.length);
    list.sort((a, b) => b.length - a.length);
    wakeCache.set(key, list);
  }
  return list;
}

// → { matched, rest } where rest is the original text after the wake word (case and punctuation
// kept, leading separators removed). Without a wake word, rest is the trimmed input.
export function stripWake(text, wakeWords = DEFAULT_WAKE_WORDS) {
  const raw = String(text ?? "").normalize("NFKC").replace(/[‘’]/g, "'");
  const tokens = tokenize(raw);
  const candidates = wakeTokens(Array.isArray(wakeWords) && wakeWords.length ? wakeWords : DEFAULT_WAKE_WORDS);
  const tryAt = (i) => {
    for (const seq of candidates) {
      if (i + seq.length > tokens.length) continue;
      let ok = true;
      for (let k = 0; k < seq.length; k++) {
        if (tokens[i + k].w !== seq[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return tokens[i + seq.length - 1].end;
    }
    return -1;
  };
  let end = tryAt(0);
  for (let i = 0; end < 0 && i < Math.min(tokens.length, 3) && LEAD_FILLERS.has(tokens[i].w); i++) end = tryAt(i + 1);
  if (end < 0) return { matched: false, rest: raw.trim() };
  const rest = raw.slice(end).replace(/^[\s,.:;!?\-–—]+/, "").trim();
  return { matched: true, rest };
}
