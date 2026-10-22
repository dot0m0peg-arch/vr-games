// Playing card helpers. Cards are two-letter codes: rank (A23456789TJQK) + suit (SHDC), e.g. "TH".
export const RANKS = "A23456789TJQK";
export const SUITS = "SHDC";

const RANK_NAMES = {
  A: "ace", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine",
  T: "ten", J: "jack", Q: "queen", K: "king",
};
const SUIT_NAMES = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };

// 52 codes in suit-then-rank order: AS 2S … KS AH … KC.
export function newDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push(rank + suit);
  return deck;
}

// Fisher-Yates on a copy; rng() returns [0, 1).
export function shuffle(list, rng = Math.random) {
  const out = [...(list || [])];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)) % (i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

export function isCard(code) {
  return typeof code === "string" && code.length === 2 && RANKS.includes(code[0].toUpperCase()) && SUITS.includes(code[1].toUpperCase());
}

// "TH" → "ten of hearts"; unknown codes → "card".
export function cardName(code) {
  if (!isCard(code)) return "card";
  const rank = code[0].toUpperCase();
  const suit = code[1].toUpperCase();
  return `${RANK_NAMES[rank]} of ${SUIT_NAMES[suit]}`;
}
