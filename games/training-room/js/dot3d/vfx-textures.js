// dot3d VFX textures: every sprite and decal texture is computed here from math, as a DataTexture.
// No DOM, no canvas, no image files; works in plain Node and in the browser with any three build.
// Sprite masks (dot, spark, smoke, chip) are white with an alpha mask so instance colors tint them.
// Decal textures (scuff, scorch) carry their own dark color.
// Claude (Command) / fable-builder, Oct 25 2026.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// Small deterministic PRNG (mulberry32) so the textures are identical on every machine and run.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lattice hash -> [0,1), value noise with smooth interpolation, 3-octave fBm.
function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}
function fbm(x, y, seed) {
  return (valueNoise(x, y, seed) * 0.5 + valueNoise(x * 2.03, y * 2.03, seed + 1) * 0.3 + valueNoise(x * 4.1, y * 4.1, seed + 2) * 0.2);
}

function makeTexture(THREE, size, name, fill) {
  const data = new Uint8Array(size * size * 4);
  const out = [0, 0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // u,v in [0,1] at pixel centers; nx,ny in [-1,1]
      const u = (x + 0.5) / size, v = (y + 0.5) / size;
      fill(u, v, u * 2 - 1, v * 2 - 1, out);
      const o = (y * size + x) * 4;
      data[o] = Math.round(clamp01(out[0]) * 255);
      data[o + 1] = Math.round(clamp01(out[1]) * 255);
      data[o + 2] = Math.round(clamp01(out[2]) * 255);
      data[o + 3] = Math.round(clamp01(out[3]) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = 'vfx-' + name;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  if (THREE.SRGBColorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Returns { dot, spark, smoke, chip, scuff, scorch, gash }; each is a size x size RGBA DataTexture with needsUpdate set.
export function makeVfxTextures(THREE, { size = 64 } = {}) {
  const rnd = prng(0x5EED);

  // Soft radial dot: glow motes, generic sprites.
  const dot = makeTexture(THREE, size, 'dot', (u, v, nx, ny, o) => {
    const d2 = nx * nx + ny * ny;
    const a = d2 >= 1 ? 0 : (1 - d2) * (1 - d2);
    o[0] = o[1] = o[2] = 1; o[3] = a;
  });

  // Spark streak: travels toward +u. Bright head near the front, thin tail fading to nothing at u=0.
  const spark = makeTexture(THREE, size, 'spark', (u, v, nx, ny, o) => {
    const sigma = 0.07 + 0.22 * u;                  // thin at the tail, fatter at the head
    const across = Math.exp(-(ny * ny) / (sigma * sigma));
    const along = smooth(0, 0.45, u) * (1 - smooth(0.78, 1.0, u));
    const core = Math.exp(-(ny * ny) / 0.004) * smooth(0.3, 0.9, u) * 0.5;
    const a = clamp01(across * along + core * along);
    o[0] = 1; o[1] = 1; o[2] = 1; o[3] = a;
  });

  // Smoke / dust puff: radial falloff eroded by value noise so no two look alike when rotated.
  const smoke = makeTexture(THREE, size, 'smoke', (u, v, nx, ny, o) => {
    const r2 = nx * nx + ny * ny;
    const base = r2 >= 1 ? 0 : (1 - r2) * (1 - r2 * 0.5);
    const n = fbm(u * 5.0, v * 5.0, 11);
    const a = clamp01(base * (0.25 + 1.25 * n) * smooth(0.0, 0.35, base + (n - 0.5) * 0.4));
    o[0] = o[1] = o[2] = 1; o[3] = a;
  });

  // Chip: an irregular angular flake. Used for the chip decal and anything that wants a hard-edged shard.
  const chipPhase1 = rnd() * Math.PI * 2, chipPhase2 = rnd() * Math.PI * 2;
  const chip = makeTexture(THREE, size, 'chip', (u, v, nx, ny, o) => {
    const ang = Math.atan2(ny, nx);
    const R = 0.55 + 0.22 * Math.sin(3 * ang + chipPhase1) + 0.12 * Math.sin(7 * ang + chipPhase2);
    const r = Math.sqrt(nx * nx + ny * ny);
    const edge = 1.5 / size;                       // ~1.5 px antialias
    const a = 1 - smooth(R - edge, R + edge, r);
    const shade = 0.85 + 0.15 * fbm(u * 6, v * 6, 23);
    o[0] = o[1] = o[2] = shade; o[3] = a;
  });

  // Scuff: a smear of many short dark streaks along u, inside an elliptical footprint, grainy.
  const streaks = [];
  for (let i = 0; i < 28; i++) {
    streaks.push({ y: (rnd() * 2 - 1) * 0.75, x0: rnd() * 1.2 - 0.9, len: 0.3 + rnd() * 0.9, w: 0.025 + rnd() * 0.05, k: 0.4 + rnd() * 0.6 });
  }
  const scuff = makeTexture(THREE, size, 'scuff', (u, v, nx, ny, o) => {
    let acc = 0;
    for (const s of streaks) {
      const dy = ny - s.y;
      const inX = smooth(s.x0 - 0.05, s.x0 + 0.1, nx) * (1 - smooth(s.x0 + s.len - 0.15, s.x0 + s.len, nx));
      acc += s.k * inX * Math.exp(-(dy * dy) / (s.w * s.w));
    }
    const foot = 1 - smooth(0.55, 1.0, Math.sqrt(nx * nx * 0.7 + ny * ny * 1.4));
    const grain = 0.7 + 0.6 * fbm(u * 9, v * 9, 37);
    const a = clamp01(acc * grain) * foot;
    const dark = 0.16 - 0.08 * fbm(u * 3, v * 3, 41);
    o[0] = dark + 0.02; o[1] = dark; o[2] = dark - 0.02; o[3] = a;
  });

  // Scorch: near-black core, brown ring, noisy outer edge.
  const scorch = makeTexture(THREE, size, 'scorch', (u, v, nx, ny, o) => {
    const r = Math.sqrt(nx * nx + ny * ny);
    const n = fbm(u * 4, v * 4, 53);
    const rr = r + (n - 0.5) * 0.45;
    const a = 1 - smooth(0.3, 0.98, rr);
    const t = smooth(0.0, 0.9, rr);               // 0 at core, 1 at rim
    o[0] = 0.04 + 0.26 * t; o[1] = 0.03 + 0.16 * t; o[2] = 0.02 + 0.08 * t; o[3] = a * (0.65 + 0.35 * (1 - t));
  });

  // Gash: a blade's cut. A dark slit along u, two pixels wide at this size, with a ragged width, tapered ends and a thin
  // fringe of lifted, lighter fibre either side (LOOK-BIBLE.md section 7: "a dark 2-pixel-wide slit ... oriented along the
  // blade's edge direction"). Step 6, Oct 26 2026.
  const gash = makeTexture(THREE, size, 'gash', (u, v, nx, ny, o) => {
    const wobble = (fbm(u * 7, 0.5, 71) - 0.5) * 0.12;            // the cut wanders a little
    const dy = ny - wobble;
    const ends = smooth(0, 0.1, u) * (1 - smooth(0.9, 1.0, u));
    const width = (0.05 + 0.06 * fbm(u * 11, 0.2, 73)) * (0.6 + 0.4 * ends);   // ~2 px at 64 px
    const slit = Math.exp(-(dy * dy) / (width * width)) * ends;
    const fringe = Math.exp(-(dy * dy) / (0.09 * 0.09)) * ends * (0.35 + 0.4 * fbm(u * 9, v * 9, 79)) * 0.45;
    const a = clamp01(slit + fringe * (1 - slit));
    // dark in the cut, lifted fibre a touch lighter and warmer than the surface around it
    const k = slit / Math.max(a, 1e-4);
    o[0] = 0.08 * k + 0.42 * (1 - k); o[1] = 0.05 * k + 0.32 * (1 - k); o[2] = 0.03 * k + 0.2 * (1 - k); o[3] = a;
  });

  return { dot, spark, smoke, chip, scuff, scorch, gash };
}
