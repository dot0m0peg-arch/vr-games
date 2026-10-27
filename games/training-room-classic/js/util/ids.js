// Short unique ids for room objects, ops and users. Works in browsers and Node 20+.
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
let counter = 0;

export function randomString(length = 6) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function makeId(prefix = "o") {
  counter = (counter + 1) % 1296;
  return prefix + Date.now().toString(36).slice(-5) + counter.toString(36).padStart(2, "0") + randomString(3);
}

// Seedable PRNG (mulberry32) so shuffles can be replayed from a seed.
export function rng(seed = Math.floor(Math.random() * 2 ** 32)) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.seed = seed;
  return next;
}
