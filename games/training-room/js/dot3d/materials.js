// dot3d PBR material library: procedural albedo, normal and roughness maps generated in JS (no downloads, no canvas),
// so every surface has real texture and responds to the environment light. Real texture sets (CC0, owner Meshy) replace
// these per game where the look bible asks. Claude (Command), Oct 25 2026.

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function makeNoise(seed) {
  const r = rng(seed), P = 256, perm = new Uint8Array(P * 2), val = new Float32Array(P);
  for (let i = 0; i < P; i++) { perm[i] = i; val[i] = r(); }
  for (let i = P - 1; i > 0; i--) { const j = (r() * (i + 1)) | 0; [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < P; i++) perm[P + i] = perm[i];
  const sm = (t) => t * t * (3 - 2 * t);
  // Tileable value noise over a period (in cells), so textures repeat without seams.
  return function noise(x, y, period) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = sm(x - xi), yf = sm(y - yi);
    const w = (a) => ((a % period) + period) % period;
    const h = (i, j) => val[perm[(perm[w(i) & 255] + w(j)) & 255]];
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}

function fbm(noise, x, y, period, octaves = 4) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++) { s += amp * noise(x * f, y * f, period * f); norm += amp; amp *= 0.5; f *= 2; }
  return s / norm;
}

// Recipes return height (0..1), albedo [r,g,b] (0..1, sRGB), roughness (0..1) for texel (u,v) in [0,1).
const RECIPES = {
  wood: { period: 4, physMaterial: 'wood', metalness: 0, normalStrength: 1.2, sample(n, u, v) {
    const plank = Math.floor(v * 4), pv = v * 4 - plank;
    const grain = fbm(n, u * 4 + plank * 7.3, pv * 40, 4, 3);
    const ring = 0.5 + 0.5 * Math.sin((u * 18 + grain * 6 + plank * 1.7) * Math.PI);
    const tone = 0.75 + 0.25 * ((plank * 0.37) % 1);
    const seam = pv < 0.025 || pv > 0.975 ? 0.45 : 1;
    const k = (0.55 + 0.3 * ring) * tone * seam;
    return { h: seam < 1 ? 0 : 0.6 + 0.2 * ring, c: [0.62 * k, 0.40 * k, 0.24 * k], r: 0.48 + 0.18 * grain }; } },
  carpet: { period: 32, physMaterial: 'soft', metalness: 0, normalStrength: 0.8, sample(n, u, v) {
    const f = n(u * 256, v * 256, 256), g = fbm(n, u * 8, v * 8, 8, 3);
    const k = 0.75 + 0.2 * f + 0.1 * g;
    return { h: f, c: [0.52 * k, 0.16 * k, 0.14 * k], r: 0.95 }; } },
  rock: { period: 8, physMaterial: 'stone', metalness: 0, normalStrength: 2.2, sample(n, u, v) {
    // Soft organic cracks along the mid-level of a second fbm, not hard value-noise cell edges.
    const g = fbm(n, u * 8, v * 8, 8, 5), cn = fbm(n, u * 6 + 17, v * 6 + 5, 6, 4);
    const cr = 1 - 0.45 * Math.max(0, 1 - Math.abs(cn - 0.5) / 0.022);
    const k = (0.45 + 0.4 * g) * cr;
    return { h: g * cr, c: [0.47 * k, 0.44 * k, 0.41 * k], r: 0.82 + 0.12 * (1 - g) }; } },
  dirt: { period: 8, physMaterial: 'soft', metalness: 0, normalStrength: 1.5, sample(n, u, v) {
    const g = fbm(n, u * 8, v * 8, 8, 5), p = n(u * 64, v * 64, 64) > 0.82 ? 0.75 : 1;
    const k = (0.5 + 0.35 * g) * p;
    return { h: g * p, c: [0.36 * k, 0.26 * k, 0.17 * k], r: 0.92 }; } },
  concrete: { period: 8, physMaterial: 'stone', metalness: 0, normalStrength: 0.9, sample(n, u, v) {
    const g = fbm(n, u * 8, v * 8, 8, 5), pit = n(u * 128, v * 128, 128) > 0.9 ? 0.7 : 1;
    const k = (0.62 + 0.18 * g) * pit;
    return { h: g * pit, c: [k, 0.98 * k, 0.95 * k], r: 0.85 }; } },
  plaster: { period: 8, physMaterial: 'stone', metalness: 0, normalStrength: 0.5, sample(n, u, v) {
    const g = fbm(n, u * 8, v * 8, 8, 4), k = 0.86 + 0.08 * g;
    return { h: g, c: [0.92 * k, 0.88 * k, 0.80 * k], r: 0.9 }; } },
  grass: { period: 16, physMaterial: 'soft', metalness: 0, normalStrength: 1.0, sample(n, u, v) {
    const g = fbm(n, u * 16, v * 16, 16, 4), b = n(u * 128, v * 128, 128);
    const k = 0.55 + 0.3 * g + 0.15 * b;
    return { h: b, c: [0.20 * k, 0.36 * k, 0.12 * k], r: 0.9 }; } },
  paint: { period: 64, physMaterial: 'paint', metalness: 0.55, normalStrength: 0.15, physical: { clearcoat: 1, clearcoatRoughness: 0.04 }, sample(n, u, v) {
    const flake = n(u * 512, v * 512, 512);
    return { h: flake, c: [0.75, 0.08, 0.06], r: 0.32 + 0.1 * flake }; } },
  metal: { period: 16, physMaterial: 'metal', metalness: 1, normalStrength: 0.3, sample(n, u, v) {
    const brush = fbm(n, u * 2, v * 128, 2, 3);
    return { h: brush, c: [0.72, 0.72, 0.74], r: 0.28 + 0.15 * brush }; } },
  // Added Oct 26 2026 for the Training Room look bible (section 4), additive. Every multiplier of u or v is a multiple of the
  // recipe's period (or an integer count per tile), so each map tiles without a seam.
  plank: { period: 6, physMaterial: 'wood', metalness: 0, normalStrength: 1.4, sample(n, u, v) {
    // Five weathered boards per tile running along u: open gaps between them, straight grain, a knot now and then,
    // each board its own grey-gold tone with silvered patches where the sun got it.
    const B = 5, board = Math.floor(v * B), bv = v * B - board;
    const gap = bv < 0.03 || bv > 0.97;
    const grain = fbm(n, u * 6 + board * 11.3, bv * 48 + board * 3.1, 6, 3);
    const streak = 0.5 + 0.5 * Math.sin((u * 26 + grain * 7 + board * 2.3) * Math.PI);
    const knot = n(u * 6 + board * 5.7, bv * 2 + 40, 6);
    const kn = knot > 0.8 ? 1 - 0.5 * Math.min(1, (knot - 0.8) / 0.08) : 1;
    const tone = 0.78 + 0.22 * ((board * 0.618 + 0.21) % 1);
    const silver = fbm(n, u * 3 + 7, v * 3 + 2, 3, 2);
    const k = (0.5 + 0.3 * streak + 0.2 * grain) * tone * kn * (gap ? 0.35 : 1);
    const warm = [0.66 * k, 0.56 * k, 0.42 * k], grey = [0.60 * k, 0.60 * k, 0.57 * k], t = Math.max(0, (silver - 0.45) * 1.6);
    return { h: cl01(gap ? 0.05 : 0.45 + 0.3 * streak * kn + 0.15 * grain), c: [mix(warm[0], grey[0], t), mix(warm[1], grey[1], t), mix(warm[2], grey[2], t)], r: 0.74 + 0.14 * grain + (gap ? 0.1 : 0) }; } },
  straw: { period: 8, physMaterial: 'soft', metalness: 0, normalStrength: 1.6, sample(n, u, v) {
    // Parallel stalks along v with a slow wobble, each rounded and its own tone; dark seams where the bundles meet and
    // the odd broken stalk end.
    const S = 40, wob = (fbm(n, u * 4, v * 4, 4, 2) - 0.5) * 0.03;
    const x = ((u + wob) * S % S + S) % S, stalk = Math.floor(x), t = x - stalk;
    const round = Math.sin(t * Math.PI);
    const tone = 0.8 + 0.2 * n(stalk + 0.5, 3.5, S);
    const seam = fbm(n, u * 8 + 3, v * 8 + 1, 8, 3);
    const dark = seam < 0.42 ? 0.55 + 0.45 * (seam / 0.42) : 1;
    const broken = n(u * 8, v * 64, 8) > 0.9 ? 0.7 : 1;
    const k = (0.55 + 0.45 * round) * tone * dark * broken;
    return { h: cl01(round * 0.8 * dark * broken), c: [0.80 * k, 0.65 * k, 0.35 * k], r: 0.9 + 0.08 * (1 - round) }; } },
  iron: { period: 8, physMaterial: 'metal', metalness: 0.9, normalStrength: 1.0, sample(n, u, v) {
    // Dark forged iron: a soft hammered surface, small pits, rust gathering in the low ground.
    const g = fbm(n, u * 8, v * 8, 8, 4), fine = n(u * 128, v * 128, 128);
    const pit = fine > 0.84 ? (fine - 0.84) / 0.16 : 0;
    const rust = Math.max(0, Math.min(1, (0.46 - g) / 0.16));
    const k = 0.9 + 0.2 * g - 0.35 * pit;
    const base = [0.23 * k, 0.24 * k, 0.25 * k], rc = [0.44 * k, 0.27 * k, 0.17 * k], t = rust * 0.85;
    return { h: cl01(0.4 + 0.6 * g - 0.5 * pit), c: [mix(base[0], rc[0], t), mix(base[1], rc[1], t), mix(base[2], rc[2], t)], r: 0.62 + 0.25 * rust + 0.15 * pit }; } },
  blocks: { period: 8, physMaterial: 'stone', metalness: 0, normalStrength: 2.2, sample(n, u, v) {
    // Running-bond ashlar at a 1.5 m tile: four courses of 0.375 m, two 0.75 m blocks per course, odd courses offset by
    // half a block; pale mortar in 12 mm joints, each block its own tone, a short chamfered arris (a wide soft bevel
    // read as upholstery in the first capture) and a tooled, pitted face with real relief.
    const C = 4, B = 2, row = Math.floor(v * C), rv = v * C - row;
    const uu = u * B + (row % 2 ? 0.5 : 0), col = Math.floor(uu), cu = uu - col;
    const d = Math.min(Math.min(cu, 1 - cu) * 0.75, Math.min(rv, 1 - rv) * 0.375); // metres to the nearest joint
    const mortar = d < 0.012, arris = Math.min(1, Math.max(0, (d - 0.012) / 0.018));
    const tone = 0.8 + 0.4 * n((col % B) + 0.5, row + 0.5, 8);
    const g = fbm(n, u * 8, v * 8, 8, 5), tool = n(u * 96, v * 96, 96), pit = tool > 0.88 ? (tool - 0.88) / 0.12 : 0;
    if (mortar) { const km = 0.88 + 0.12 * g; return { h: 0.1 + 0.1 * g, c: [0.77 * km, 0.74 * km, 0.67 * km], r: 0.97 }; }
    const k = (0.7 + 0.3 * g - 0.25 * pit) * tone;
    return { h: cl01(0.3 + 0.3 * arris + 0.35 * g - 0.3 * pit), c: [0.56 * k, 0.54 * k, 0.50 * k], r: 0.84 + 0.12 * (1 - g) + 0.04 * pit }; } },
  cloth: { period: 8, physMaterial: 'soft', metalness: 0, normalStrength: 0.9, sample(n, u, v) {
    // Plain linen weave, 64 threads per tile, the top thread alternating at every crossing; a slow tone drift and slubs.
    const T = 64, a = Math.abs(Math.sin(u * T * Math.PI)), b = Math.abs(Math.sin(v * T * Math.PI));
    const over = (Math.floor(u * T) + Math.floor(v * T)) % 2 ? a : b;
    const drift = fbm(n, u * 8, v * 8, 8, 3), slub = n(u * 16, v * 256, 16) > 0.93 ? 1.12 : 1;
    const k = (0.84 + 0.16 * over) * (0.92 + 0.08 * drift) * slub;
    return { h: cl01(over), c: [0.85 * k, 0.81 * k, 0.72 * k], r: 0.9 + 0.1 * (1 - over) }; } },
  leather: { period: 8, physMaterial: 'soft', metalness: 0, normalStrength: 1.1, sample(n, u, v) {
    // Full-grain leather: a pebbled grain, thin creases, worn patches that go lighter and smoother.
    const cell = n(u * 48, v * 48, 48), g = fbm(n, u * 8, v * 8, 8, 3), cr = fbm(n, u * 24 + 9, v * 24 + 4, 24, 3);
    const crease = Math.max(0, 1 - Math.abs(cr - 0.5) / 0.03);
    const wear = Math.max(0, (g - 0.58) / 0.42);
    const k = (0.82 + 0.18 * cell) * (1 - 0.35 * crease) * (1 + 0.25 * wear);
    return { h: cl01(0.5 + 0.35 * cell - 0.4 * crease), c: [0.36 * k, 0.24 * k, 0.16 * k], r: 0.62 - 0.15 * wear + 0.08 * cell }; } },
  ceramic: { period: 8, physMaterial: 'stone', metalness: 0, normalStrength: 0.25, sample(n, u, v) {
    // Glazed stoneware: near-flat, a glaze speckle, the odd pinhole, a slow sheen variation.
    const g = fbm(n, u * 8, v * 8, 8, 3), sp = n(u * 160, v * 160, 160);
    const speck = sp > 0.94 ? 1 : 0, pin = sp < 0.03 ? 1 : 0;
    const k = (0.97 + 0.03 * g) * (1 - 0.3 * speck);
    return { h: cl01(0.5 + 0.1 * g - 0.3 * pin), c: [0.91 * k, 0.89 * k, 0.84 * k], r: 0.17 + 0.06 * g + 0.5 * pin + 0.2 * speck }; } },
  paper: { period: 4, physMaterial: 'soft', metalness: 0, normalStrength: 0.35, sample(n, u, v) {
    // Uncoated paper: crossed fibre grain, a faint yellowing drift.
    const fa = fbm(n, u * 4, v * 180, 4, 2), fb = fbm(n, u * 180 + 2, v * 4 + 1, 4, 2);
    const fiber = 0.5 * (fa + fb), yellow = fbm(n, u * 4 + 1, v * 4 + 3, 4, 3);
    const k = 0.93 + 0.07 * fiber;
    return { h: cl01(fiber), c: [0.95 * k, (0.93 - 0.02 * yellow) * k, (0.86 - 0.06 * yellow) * k], r: 0.64 + 0.12 * fiber }; } },
  leaf: { period: 6, physMaterial: 'soft', metalness: 0, normalStrength: 0.8, sample(n, u, v) {
    // Overlapping foliage: lobes from a low noise, pale veins fanning across each lobe, dark gaps between leaves.
    const lobe = fbm(n, u * 6, v * 6, 6, 2), fine = fbm(n, u * 12 + 5, v * 12 + 2, 12, 3);
    const vein = Math.max(0, 1 - Math.abs(((lobe * 9) % 1) - 0.5) / 0.08);
    const gap = Math.max(0, 1 - Math.abs(fine - 0.5) / 0.025);
    const tone = 0.72 + 0.4 * lobe;
    const k = tone * (1 + 0.18 * vein) * (1 - 0.45 * gap);
    return { h: cl01(0.55 + 0.3 * lobe - 0.4 * gap + 0.1 * vein), c: [0.30 * k, 0.52 * k, 0.18 * k], r: 0.78 + 0.12 * (1 - lobe) }; } },
  bark: { period: 4, physMaterial: 'wood', metalness: 0, normalStrength: 2.0, sample(n, u, v) {
    // Tree bark: vertical furrows that wander a little, ridges between them, a few horizontal checks.
    const wander = fbm(n, u * 4, v * 4, 4, 2) - 0.5;
    const f = fbm(n, (u + 0.08 * wander) * 24, v * 4, 4, 4);
    const ridge = Math.pow(f, 1.4);
    const check = n(u * 8, v * 96, 8) > 0.92 ? 0.6 : 1;
    const k = (0.4 + 0.6 * ridge) * check;
    return { h: cl01(ridge * check), c: [0.40 * k, 0.32 * k, 0.25 * k], r: 0.86 + 0.1 * (1 - ridge) }; } },
};
const cl01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a, b, t) => a + (b - a) * t;

const FLAT = {
  chrome: { physMaterial: 'metal', color: 0xf2f4f7, metalness: 1, roughness: 0.06 },
  rubber: { physMaterial: 'soft', color: 0x1b1b1d, metalness: 0, roughness: 0.88 },
  glass:  { physMaterial: 'stone', color: 0x9db6c4, metalness: 0, roughness: 0.03, physical: { transparent: true, opacity: 0.35, ior: 1.5 } },
  emissive: { physMaterial: 'soft', color: 0x111111, metalness: 0, roughness: 0.5, emissive: 0xfff0c8, emissiveIntensity: 3 },
};

export const MATERIAL_NAMES = [...Object.keys(RECIPES), ...Object.keys(FLAT)];

export function createMaterials(THREE, { size = 256, seed = 7, anisotropy = 4 } = {}) {
  const cache = new Map(), textures = [];
  const srgb = (t) => { if (THREE.SRGBColorSpace && 'colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace; return t; };
  const prep = (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.anisotropy = anisotropy; t.needsUpdate = true; textures.push(t); return t;
  };

  function bake(name) {
    const R = RECIPES[name], n = makeNoise(seed + name.length * 131 + name.charCodeAt(0));
    const N = size, height = new Float32Array(N * N);
    const albedo = new Uint8Array(N * N * 4), rough = new Uint8Array(N * N * 4), normal = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const s = R.sample(n, x / N, y / N), i = y * N + x;
      height[i] = s.h;
      albedo.set([Math.min(255, s.c[0] * 255), Math.min(255, s.c[1] * 255), Math.min(255, s.c[2] * 255), 255], i * 4);
      const rv = Math.max(0, Math.min(1, s.r)) * 255;
      rough.set([255, rv, 0, 255], i * 4); // green = roughness, as three reads it
    }
    const k = R.normalStrength * N / 64;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const h = (xx, yy) => height[((yy + N) % N) * N + ((xx + N) % N)];
      let nx = (h(x - 1, y) - h(x + 1, y)) * k, ny = (h(x, y - 1) - h(x, y + 1)) * k, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      normal.set([(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255, 255], (y * N + x) * 4);
    }
    const tex = (data) => prep(new THREE.DataTexture(data, N, N, THREE.RGBAFormat));
    return { map: srgb(tex(albedo)), normalMap: tex(normal), roughnessMap: tex(rough), height };
  }

  // One bake per material name; tints share it, re-tiled variants use clones (clones share the image and GPU upload).
  const baked = new Map();
  function texturesFor(name, repeat) {
    if (!baked.has(name)) baked.set(name, bake(name));
    const t = baked.get(name);
    if (!repeat) return t;
    const rk = `${name}@${repeat.join('x')}`;
    if (!baked.has(rk)) {
      const c = (x) => { const y = x.clone(); y.repeat.set(repeat[0], repeat[1] ?? repeat[0]); y.needsUpdate = true; textures.push(y); return y; };
      baked.set(rk, { map: c(t.map), normalMap: c(t.normalMap), roughnessMap: c(t.roughnessMap) });
    }
    return baked.get(rk);
  }

  function get(name, overrides = {}) {
    const key = name + JSON.stringify(overrides);
    if (cache.has(key)) return cache.get(key);
    let mat;
    if (RECIPES[name]) {
      const R = RECIPES[name], t = texturesFor(name, overrides.repeat);
      const params = { map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, roughness: 1, metalness: R.metalness, ...(R.physical ?? {}) };
      mat = R.physical ? new THREE.MeshPhysicalMaterial(params) : new THREE.MeshStandardMaterial(params);
      mat.userData.physMaterial = R.physMaterial;
    } else if (FLAT[name]) {
      const F = FLAT[name], { physMaterial, physical, ...p } = F;
      mat = physical ? new THREE.MeshPhysicalMaterial({ ...p, ...physical }) : new THREE.MeshStandardMaterial(p);
      mat.userData.physMaterial = physMaterial;
    } else throw new Error(`dot3d materials: unknown material "${name}"`);
    const { repeat, ...rest } = overrides;
    if (rest.color !== undefined) rest.color = new THREE.Color(rest.color);
    mat.setValues(rest);
    mat.userData.dot3dMaterial = name;
    mat.name = `dot3d:${name}`;
    cache.set(key, mat);
    return mat;
  }

  return {
    get, names: MATERIAL_NAMES,
    physMaterialOf: (m) => m?.userData?.physMaterial ?? 'stone',
    dispose() { for (const m of cache.values()) m.dispose(); for (const t of textures) t.dispose(); cache.clear(); },
  };
}
