// dot3d particles: effects come from real causes and behave physically.
// A contact on the bus (point, normal, impulse, relative velocity, materials and the surfaces struck) spawns sparks, dust,
// chips or straw wisps at the actual contact point; count and speed scale with the impulse, velocity is inherited, everything
// falls under gravity, drags, bounces off the ground (or settles), cools and fades. Each burst is randomized from a seedable
// PRNG, so nothing is a canned sprite. Rate emitters (a campfire's embers and smoke) run through the same pools and feel the
// field's wind. Simulation lives in typed arrays on the CPU (deterministic, testable in Node). Rendering is instanced:
//   glow  : one additive ShaderMaterial draw (sparks stretched along velocity, shimmer motes, embers)
//   dust  : one normal-blended ShaderMaterial draw (rotated billboards: dust puffs, smoke)
//   chips : one lit InstancedMesh (MeshStandardMaterial) so chips, flecks and straw wisps take scene light and shadows
// Pooled at a fixed capacity; when full, slots are recycled round-robin (the oldest spawn).
// Units: 1 unit = 1 m, impulse in N*s. Works with three r159 (global) and r185 (ESM): the THREE namespace is passed in.
// Claude (Command) / fable-builder, Oct 25 2026; step 6 kinds, rules, wind and emitters (LOOK-BIBLE.md section 7) Oct 26 2026.

import { makeVfxTextures } from './vfx-textures.js';

// Effect table. count = min(max, round((base + perImpulse * impulse^0.7) * scale)).
// speed is m/s at impulse 1, multiplied by clamp(sqrt(impulse), 0.5, speedCap or 2.5). life/size are [min, max] ranges.
// ramp: color+alpha at t = 0, 0.5, 1 of life. coneBias: how much the spray hugs the contact normal.
// shape (chips layer): the instanced box's proportions, scaled by size. wind: how much of the field's wind the kind feels.
export const EFFECTS = {
  sparks: {
    layer: 'glow', texture: 1, count: { base: 6, perImpulse: 10, max: 60 }, speed: [1.2, 4.0], coneBias: 0.7,
    gravity: -9.8, drag: 0.8, bounce: 0.45, friction: 0.35, life: [0.4, 1.0], size: [0.012, 0.03],
    stretch: 0.035, inherit: 0.6, collides: true, rests: true, restSpeed: 0.25, linger: 0.12, fadeFrac: 0.35,
    ramp: [[1.0, 0.97, 0.82, 1], [1.0, 0.55, 0.12, 1], [0.45, 0.05, 0.01, 0]],
  },
  dust: {
    layer: 'dust', texture: 0, count: { base: 3, perImpulse: 4, max: 24 }, speed: [0.5, 1.4], coneBias: 0.9,
    gravity: -0.5, drag: 2.2, bounce: 0, friction: 0.6, life: [0.9, 1.9], size: [0.05, 0.11], growth: 1.6,
    spin: 1.5, inherit: 0.35, collides: true, rests: false, groundFade: 0.7, jitter: 0.015,
    ramp: [[0.64, 0.6, 0.54, 0], [0.6, 0.56, 0.5, 0.5], [0.55, 0.52, 0.48, 0]],
  },
  chips: {
    layer: 'chips', shape: [1, 0.4, 0.7], count: { base: 3, perImpulse: 5, max: 30 }, speed: [1.0, 3.5], coneBias: 0.55,
    gravity: -9.8, drag: 0.15, bounce: 0.35, friction: 0.45, life: [2.0, 3.0], size: [0.007, 0.018],
    spin: 25, inherit: 0.7, collides: true, rests: true, restSpeed: 0.12, linger: 4.0, fadeFrac: 0.12,
    color: [0.55, 0.45, 0.35],
  },
  shimmer: {
    layer: 'glow', texture: 0, count: { base: 8, perImpulse: 10, max: 48 }, speed: [0.15, 0.5], coneBias: 0.3,
    gravity: 0.35, drag: 0.8, bounce: 0, friction: 0, life: [0.8, 1.6], size: [0.015, 0.04],
    stretch: 0, inherit: 0.2, collides: false, rests: false, radius: 0.15,
    ramp: [[0.55, 0.9, 1.0, 0], [0.85, 1.0, 1.0, 1], [1.0, 1.0, 1.0, 0]],
  },
  // Straw wisps: flat 20-60 mm cards thrown off a dummy or a hay bale, slow to fall, that land and lie on the ground 6 s.
  wisps: {
    // speedCap: straw is light, so a harder hit throws more wisps, not much faster ones (the launch speed multiplier stops at 1.3).
    layer: 'chips', shape: [1, 0.08, 0.35], count: { base: 4, perImpulse: 6, max: 24 }, speed: [0.5, 1.4], speedCap: 1.3, coneBias: 0.5,
    gravity: -2.0, drag: 1.5, bounce: 0.1, friction: 0.5, life: [1.5, 3.0], size: [0.02, 0.06],
    spin: 8, inherit: 0.5, collides: true, rests: true, restSpeed: 0.3, linger: 6.0, fadeFrac: 0.15, wind: 0.6,
    colorRange: [[0.788, 0.647, 0.353], [0.549, 0.435, 0.212]],   // #c9a55a to #8c6f36
  },
  // Embers off a fire: buoyant, drift with the wind, cool from white-gold through orange to dark. Spawned by rate.
  ember: {
    layer: 'glow', texture: 0, count: { base: 1, perImpulse: 0, max: 24 }, speed: [0.15, 0.45], coneBias: 0.8,
    gravity: 0.8, drag: 1.2, bounce: 0, friction: 0, life: [1.2, 2.4], size: [0.008, 0.02],
    stretch: 0.01, inherit: 0, collides: false, rests: false, radius: 0.12, wind: 0.3,
    ramp: [[1.0, 0.945, 0.784, 1], [1.0, 0.353, 0.102, 1], [0.25, 0.05, 0.01, 0]],   // #fff1c8 -> #ff5a1a -> dark
  },
  // Smoke: a dust-layer puff that rises about 0.6 m/s, grows from 150 to 600 mm and peaks at alpha 0.35.
  smoke: {
    layer: 'dust', texture: 0, count: { base: 1, perImpulse: 0, max: 12 }, speed: [0.4, 0.6], coneBias: 1.6,
    gravity: 0.55, drag: 0.9, bounce: 0, friction: 0, life: [2.5, 4.0], size: [0.12, 0.18], growth: 3.0,
    spin: 0.6, inherit: 0, collides: false, rests: false, radius: 0.08, wind: 0.5,
    color: [0.424, 0.404, 0.384],                                                       // #6c6762
    ramp: [[1, 1, 1, 0], [1, 1, 1, 0.35], [1, 1, 1, 0]],
  },
};
const KIND_NAMES = Object.keys(EFFECTS);
const KIND_IDS = Object.fromEntries(KIND_NAMES.map((k, i) => [k, i]));
const KIND_DEFS = KIND_NAMES.map((k) => EFFECTS[k]);

export const CHIP_COLORS = { wood: [0.55, 0.38, 0.2], stone: [0.5, 0.5, 0.47], paint: [0.92, 0.9, 0.86], metal: [0.6, 0.6, 0.62], grass: [0.435, 0.604, 0.227] };  // grass #6f9a3a
export const DUST_TINTS = { wood: [1.05, 0.95, 0.75], stone: [0.9, 0.9, 0.9], soft: [1.0, 0.98, 0.95], paint: [1.1, 1.1, 1.08],
  straw: [1.35, 1.22, 0.86], grass: [0.99, 1.05, 0.65] };   // straw #d9c48a and grass #9fa868, as multipliers on the dust ramp
export const WISP_COLORS = EFFECTS.wisps.colorRange;
const METAL_SURFACES = new Set(['metal', 'steel', 'iron', 'gold']);
const STONE_SURFACES = new Set(['stone', 'rock', 'blocks', 'ceramic']);

// Default material rules: contact event -> [[kind, scale, extra], ...]. Below 0.15 N*s nothing spawns; below 0.8 N*s only dust
// (and straw wisps or grass flecks from 0.5).
// Materials are the physics bridge's (metal, wood, stone, soft, paint); surfaces, when the core tagged them, are the look
// families the colliders were built from (steel, iron, plank, bark, rock, straw, grass, hand...). striker says which side hit.
//   landing on grass (either side grass, >= 0.5)  -> green-tan dust x0.7 + 2-8 grass flecks (chips, #6f9a3a); nothing else
//   anything on straw (>= 0.5)                      -> straw wisps + dust x0.4 tinted straw; the straw side spawns nothing else
//   metal on metal -> sparks x1.2, metal on stone -> sparks; metal on wood, straw or soft things -> no sparks
//   wood  -> chips (wood colour) + dust (tan)        stone -> chips (grey) + dust
//   soft  -> dust only                               paint -> light flecks + a little dust
//   unknown / missing materials -> a little dust
//   blunt striker (bat, staff, hammer: a held part with no edge) -> everything x0.7
export function defaultRules(e) {
  const impulse = +e.impulse || 0;
  if (impulse < 0.15) return [];
  const mats = Array.isArray(e.materials) ? e.materials.map((m) => String(m || 'unknown')) : ['unknown', 'unknown'];
  const surf = Array.isArray(e.surfaces) ? e.surfaces.map((s, i) => String(s || mats[i] || 'unknown')) : mats.slice();
  const k = e.blunt ? 0.7 : 1;
  // Section 7 puts chips, flecks and sparks at 0.8 N*s and up; below that a touch raises only dust (a crate rocking on its
  // corners, a sword set down). Straw and grass answer from 0.5 N*s, as their rows say.
  const hard = impulse >= 0.8;
  const has = (m) => mats.includes(m);
  const out = [];
  const add = (kind, scale, extra) => {
    if (!(scale > 0)) return;
    const prev = out.find((r) => r[0] === kind);
    if (prev) { prev[1] += scale; if (extra) Object.assign(prev[2], extra); } else out.push([kind, scale, extra || {}]);
  };
  if (surf.includes('grass')) {
    if (impulse < 0.5) return [];
    add('dust', 0.7 * k, { tint: DUST_TINTS.grass });
    add('chips', 0.3 * k, { color: CHIP_COLORS.grass, size: [0.015, 0.03] });
    return out;
  }
  const straw = surf.map((s) => s === 'straw' && impulse >= 0.5);
  const anyStraw = straw[0] || straw[1];
  if (anyStraw) { add('wisps', 1.0 * k); add('dust', 0.4 * k, { tint: DUST_TINTS.straw }); }
  // Metal by the physics material or by the look surface: the kit gives a sword blade a light `plastic` body (a 1.5 kg sword)
  // under a `steel` surface, and it is the steel that sparks.
  const metal = mats.map((m, i) => m === 'metal' || METAL_SURFACES.has(surf[i]));
  if (metal[0] || metal[1]) {
    // Sparks need something hard: metal on metal (x1.2) or metal on stone (x1.0). Wood, straw and soft things take the
    // blow without a spark (section 7: steel on wood is chips and a gash; steel on stone is sparks and a scuff).
    const both = metal[0] && metal[1];
    const stone = (!metal[0] && (mats[0] === 'stone' || STONE_SURFACES.has(surf[0]))) || (!metal[1] && (mats[1] === 'stone' || STONE_SURFACES.has(surf[1])));
    if (hard) add('sparks', (both ? 1.2 : stone ? 1.0 : 0) * k);
  }
  // Chips only from a real hit; two wooden things knocking (a crate rocking on a crate) shed a quarter of what an edge or a
  // stone takes out of wood, or the stack behind one axe throw sheds hundreds.
  const woodOnWood = mats[0] === 'wood' && mats[1] === 'wood';
  const c = hard ? k * (woodOnWood ? 0.25 : 1) : 0;
  for (let i = 0; i < mats.length; i++) {
    const m = mats[i];
    if (straw[i]) continue;
    if (m === 'wood') { add('chips', 1.0 * c, { color: CHIP_COLORS.wood }); add('dust', 0.6 * k, { tint: DUST_TINTS.wood }); }
    else if (m === 'stone') { add('chips', 0.8 * c, { color: CHIP_COLORS.stone }); add('dust', 1.0 * k, { tint: DUST_TINTS.stone }); }
    else if (m === 'soft') { add('dust', 0.8 * k, { tint: DUST_TINTS.soft }); }
    else if (m === 'paint') { add('chips', 0.4 * c, { color: CHIP_COLORS.paint }); add('dust', 0.5 * k, { tint: DUST_TINTS.paint }); }
    else if (!metal[i]) { add('dust', 0.3 * k); }
  }
  // Two identical soft/wood/stone materials would double up; keep the sum sane.
  for (const r of out) r[1] = Math.min(r[1], 1.6);
  return out;
}

// What flies when a blade sticks (bus 'bite': point, normal, dir, impulse, material, surface): 8-14 straw wisps out of
// straw, 8-14 chips out of wood. r in [0,1) picks the count. -> [[kind, opts], ...]
export function biteRules(e, r = 0.5) {
  if (!e || !e.point) return [];
  const count = 8 + Math.round(Math.max(0, Math.min(0.999, r)) * 6);
  const base = { point: e.point, normal: e.normal || { x: 0, y: 1, z: 0 }, impulse: Math.max(1, +e.impulse || 1), count };
  if (e.surface === 'straw' || e.material === 'soft') return [['wisps', base]];
  return [['chips', { ...base, color: CHIP_COLORS.wood }]];
}

// mulberry32
function makePrng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Piecewise-linear ramp over 3 stops.
function rampAt(ramp, t, out) {
  const seg = t < 0.5 ? 0 : 1;
  const f = seg === 0 ? t * 2 : (t - 0.5) * 2;
  const a = ramp[seg], b = ramp[seg + 1];
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
  out[3] = a[3] + (b[3] - a[3]) * f;
}

// Unit quad: position (x,y in [-0.5,0.5]) + uv, instanced.
function makeQuadGeometry(THREE) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}
function addInstanced(THREE, g, name, n, itemSize) {
  const attr = new THREE.InstancedBufferAttribute(new Float32Array(n * itemSize), itemSize);
  if (THREE.DynamicDrawUsage !== undefined) attr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute(name, attr);
  return attr;
}

const GLOW_VERT = `
attribute vec3 aPos; attribute vec3 aStretch; attribute float aSize; attribute vec4 aColor; attribute float aTex;
varying vec2 vUv; varying vec4 vColor; varying float vTex;
void main() {
  vUv = uv; vColor = aColor; vTex = aTex;
  vec4 center = modelViewMatrix * vec4(aPos, 1.0);
  vec3 sv = (modelViewMatrix * vec4(aStretch, 0.0)).xyz;
  float sl = length(sv.xy);
  float has = step(1e-5, sl);
  vec2 ax = mix(vec2(1.0, 0.0), sv.xy / max(sl, 1e-5), has);
  vec2 ay = vec2(-ax.y, ax.x);
  vec2 off = ax * position.x * (aSize + sl) + ay * position.y * aSize;
  gl_Position = projectionMatrix * vec4(center.xyz + vec3(off, 0.0), 1.0);
}`;
const GLOW_FRAG = `
uniform sampler2D map0; uniform sampler2D map1;
varying vec2 vUv; varying vec4 vColor; varying float vTex;
void main() {
  vec4 t = mix(texture2D(map0, vUv), texture2D(map1, vUv), vTex);
  gl_FragColor = vec4(vColor.rgb * t.rgb * t.a * vColor.a, t.a * vColor.a);
}`;
const DUST_VERT = `
attribute vec3 aPos; attribute float aSize; attribute float aRot; attribute vec4 aColor;
varying vec2 vUv; varying vec4 vColor;
void main() {
  vUv = uv; vColor = aColor;
  vec4 center = modelViewMatrix * vec4(aPos, 1.0);
  float c = cos(aRot), s = sin(aRot);
  vec2 p = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aSize;
  gl_Position = projectionMatrix * vec4(center.xyz + vec3(p, 0.0), 1.0);
}`;
const DUST_FRAG = `
uniform sampler2D map0;
varying vec2 vUv; varying vec4 vColor;
void main() {
  vec4 t = texture2D(map0, vUv);
  gl_FragColor = vec4(vColor.rgb * t.rgb, t.a * vColor.a);
}`;

export function createParticles(THREE, {
  scene, bus = null, maxParticles = 1500, ground = 0, seed = 1, rules = defaultRules, textures = null,
} = {}) {
  const N = Math.max(1, maxParticles | 0);
  const rnd = makePrng(seed);
  const tex = textures || makeVfxTextures(THREE);
  const groundAt = typeof ground === 'function' ? ground : () => ground;

  // --- simulation state (SoA typed arrays) ---
  const pos = new Float32Array(N * 3), vel = new Float32Array(N * 3);
  const rot = new Float32Array(N * 3), angVel = new Float32Array(N * 3);   // chips tumble, dust spins (x only)
  const age = new Float32Array(N), life = new Float32Array(N), size = new Float32Array(N);
  const colR = new Float32Array(N), colG = new Float32Array(N), colB = new Float32Array(N);  // per-particle tint
  const kind = new Uint8Array(N), alive = new Uint8Array(N), resting = new Uint8Array(N);
  const freeStack = new Int32Array(N);
  let freeTop = N;
  for (let i = 0; i < N; i++) freeStack[i] = N - 1 - i;   // pop gives 0,1,2,...
  let cursor = 0, aliveCount = 0;
  const stats = { alive: 0, spawnedTotal: 0, byKind: Object.fromEntries(KIND_NAMES.map((k) => [k, 0])), peakAlive: 0, bounces: 0, settled: 0, recycled: 0, bites: 0, emitted: 0 };
  const wind = { x: 0, z: 0 };   // m/s, set by the game from the field (setWind)

  // --- render layers ---
  const glowGeom = makeQuadGeometry(THREE);
  const glowA = {
    pos: addInstanced(THREE, glowGeom, 'aPos', N, 3), stretch: addInstanced(THREE, glowGeom, 'aStretch', N, 3),
    size: addInstanced(THREE, glowGeom, 'aSize', N, 1), color: addInstanced(THREE, glowGeom, 'aColor', N, 4),
    tex: addInstanced(THREE, glowGeom, 'aTex', N, 1),
  };
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { map0: { value: tex.dot }, map1: { value: tex.spark } },
    vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const glowMesh = new THREE.Mesh(glowGeom, glowMat);
  glowMesh.name = 'dot3d-particles-glow'; glowMesh.frustumCulled = false; glowMesh.renderOrder = 20;

  const dustGeom = makeQuadGeometry(THREE);
  const dustA = {
    pos: addInstanced(THREE, dustGeom, 'aPos', N, 3), size: addInstanced(THREE, dustGeom, 'aSize', N, 1),
    rot: addInstanced(THREE, dustGeom, 'aRot', N, 1), color: addInstanced(THREE, dustGeom, 'aColor', N, 4),
  };
  const dustMat = new THREE.ShaderMaterial({
    uniforms: { map0: { value: tex.smoke } },
    vertexShader: DUST_VERT, fragmentShader: DUST_FRAG,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending, side: THREE.DoubleSide,
  });
  const dustMesh = new THREE.Mesh(dustGeom, dustMat);
  dustMesh.name = 'dot3d-particles-dust'; dustMesh.frustumCulled = false; dustMesh.renderOrder = 19;

  // Chips layer: a unit box scaled per instance by size and the kind's shape (a chip is a flat irregular flake, a wisp a
  // flat straw card).
  const chipGeom = new THREE.BoxGeometry(1, 1, 1);
  const chipMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.0 });
  const chipMesh = new THREE.InstancedMesh(chipGeom, chipMat, N);
  chipMesh.name = 'dot3d-particles-chips'; chipMesh.frustumCulled = false;
  chipMesh.castShadow = true; chipMesh.receiveShadow = true;
  if (THREE.DynamicDrawUsage !== undefined) chipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  chipMesh.setColorAt(0, new THREE.Color(1, 1, 1));     // creates instanceColor
  if (THREE.DynamicDrawUsage !== undefined) chipMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  chipMesh.count = 0;

  glowGeom.instanceCount = 0; dustGeom.instanceCount = 0;
  if (scene) { scene.add(glowMesh); scene.add(dustMesh); scene.add(chipMesh); }

  // scratch
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e3 = new THREE.Euler();
  const v3 = new THREE.Vector3(), s3 = new THREE.Vector3();
  const col = [0, 0, 0, 0];

  function allocSlot() {
    if (freeTop > 0) return freeStack[--freeTop];
    // Full: recycle round-robin, which is the oldest spawn while the pool stays full.
    const i = cursor; cursor = (cursor + 1) % N;
    stats.recycled++;
    aliveCount--;                               // the slot's previous occupant is gone
    return i;
  }

  function spawnOne(k, def, px, py, pz, nx, ny, nz, speedMul, ivx, ivy, ivz, extra) {
    const i = allocSlot();
    alive[i] = 1; resting[i] = 0; kind[i] = k; age[i] = 0;
    life[i] = def.life[0] + (def.life[1] - def.life[0]) * rnd();
    const sz = (extra && Array.isArray(extra.size) && extra.size.length === 2) ? extra.size : def.size;
    size[i] = sz[0] + (sz[1] - sz[0]) * rnd();
    // random direction, flipped into the normal's hemisphere, pulled toward the normal by coneBias
    let dx = rnd() * 2 - 1, dy = rnd() * 2 - 1, dz = rnd() * 2 - 1;
    let dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    if (dx * nx + dy * ny + dz * nz < 0) { dx = -dx; dy = -dy; dz = -dz; }
    dx += nx * def.coneBias; dy += ny * def.coneBias; dz += nz * def.coneBias;
    dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
    const sp = (def.speed[0] + (def.speed[1] - def.speed[0]) * rnd()) * speedMul;
    const i3 = i * 3;
    vel[i3] = dx * sp + ivx * def.inherit; vel[i3 + 1] = dy * sp + ivy * def.inherit; vel[i3 + 2] = dz * sp + ivz * def.inherit;
    const radius = (extra && extra.radius !== undefined) ? extra.radius : (def.radius || 0);
    const jit = def.jitter || 0;
    if (radius > 0 || jit > 0) {
      // uniform-ish in a sphere of `radius` plus a small jitter
      const r = radius * Math.cbrt(rnd());
      pos[i3] = px + dx * r + (rnd() * 2 - 1) * jit; pos[i3 + 1] = py + dy * r + (rnd() * 2 - 1) * jit; pos[i3 + 2] = pz + dz * r + (rnd() * 2 - 1) * jit;
    } else { pos[i3] = px; pos[i3 + 1] = py; pos[i3 + 2] = pz; }
    rot[i3] = rnd() * 6.2832; rot[i3 + 1] = rnd() * 6.2832; rot[i3 + 2] = rnd() * 6.2832;
    const spin = def.spin || 0;
    angVel[i3] = (rnd() * 2 - 1) * spin; angVel[i3 + 1] = (rnd() * 2 - 1) * spin; angVel[i3 + 2] = (rnd() * 2 - 1) * spin;
    // colour: chips get a material colour (varied a little, or picked along the kind's range), others a tint multiplier
    const c = (extra && extra.color) || def.color || null;
    const t = (extra && extra.tint) || null;
    const vary = 0.85 + 0.3 * rnd();
    if (c) { colR[i] = c[0] * vary; colG[i] = c[1] * vary; colB[i] = c[2] * vary; }
    else if (def.colorRange) {
      const [a, b] = def.colorRange, f = rnd();
      colR[i] = (a[0] + (b[0] - a[0]) * f) * vary; colG[i] = (a[1] + (b[1] - a[1]) * f) * vary; colB[i] = (a[2] + (b[2] - a[2]) * f) * vary;
    }
    else if (t) { colR[i] = t[0] * vary; colG[i] = t[1] * vary; colB[i] = t[2] * vary; }
    else { colR[i] = colG[i] = colB[i] = vary; }
    aliveCount++;
    stats.spawnedTotal++; stats.byKind[KIND_NAMES[k]]++;
    if (aliveCount > stats.peakAlive) stats.peakAlive = aliveCount;
  }

  // burst(kind, { point, normal, impulse, velocity, scale, count, color, tint, radius, size }) -> number spawned.
  // count, when given, replaces the impulse formula (emitters, bites); the kind's max still caps it.
  function burst(kindName, opts = {}) {
    const k = KIND_IDS[kindName];
    if (k === undefined) return 0;
    const def = KIND_DEFS[k];
    const p = opts.point || { x: 0, y: 0, z: 0 };
    const n = opts.normal || { x: 0, y: 1, z: 0 };
    const impulse = Math.max(0, +opts.impulse || (opts.impulse === undefined ? 1 : 0));
    const scale = opts.scale === undefined ? 1 : +opts.scale;
    if (impulse <= 0 || scale <= 0) return 0;
    let count = opts.count !== undefined ? Math.round(+opts.count || 0)
      : Math.round((def.count.base + def.count.perImpulse * Math.pow(impulse, 0.7)) * scale);
    count = clamp(count, 0, def.count.max);
    if (count === 0) return 0;
    let nx = +n.x || 0, ny = +n.y || 0, nz = +n.z || 0;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-6) { nx = 0; ny = 1; nz = 0; } else { nx /= nl; ny /= nl; nz /= nl; }
    const v = opts.velocity || null;
    const ivx = v ? (+v.x || 0) : 0, ivy = v ? (+v.y || 0) : 0, ivz = v ? (+v.z || 0) : 0;
    const speedMul = clamp(Math.sqrt(impulse), 0.5, def.speedCap || 2.5);
    for (let c = 0; c < count; c++) spawnOne(k, def, +p.x || 0, +p.y || 0, +p.z || 0, nx, ny, nz, speedMul, ivx, ivy, ivz, opts);
    return count;
  }

  // Rate emitters: emitter(key, { kind, rate (per second), point, normal, radius, scale, ... burst opts }). Each update
  // spawns floor(accumulated) of its kind at its point; set() moves or retunes it, remove() stops it. A removed emitter's
  // particles finish their lives on their own.
  const emitters = new Map();
  function emitter(key, opts = {}) {
    let em = emitters.get(key);
    if (!em) { em = { key, acc: 0, opts: {}, active: true }; emitters.set(key, em); }
    Object.assign(em.opts, opts);
    em.rate = Math.max(0, +em.opts.rate || 0);
    em.active = em.opts.active !== false;
    return {
      key,
      set: (more) => emitter(key, more),
      remove: () => emitters.delete(key),
    };
  }
  function removeEmitter(key) { return emitters.delete(key); }
  function runEmitters(dt) {
    for (const em of emitters.values()) {
      if (!em.active || !(em.rate > 0) || !KIND_IDS.hasOwnProperty(em.opts.kind)) continue;
      em.acc += em.rate * dt;
      const n = Math.floor(em.acc);
      if (n <= 0) continue;
      em.acc -= n;
      const spawned = burst(em.opts.kind, { ...em.opts, count: n, impulse: em.opts.impulse === undefined ? 1 : em.opts.impulse });
      stats.emitted += spawned;
    }
  }

  function setWind(dir, speed = 1) {
    const x = +(dir && dir.x) || 0, z = +(dir && (dir.z !== undefined ? dir.z : dir.y)) || 0;
    const l = Math.hypot(x, z) || 1;
    wind.x = (x / l) * speed; wind.z = (z / l) * speed;
  }

  function step(dt) {
    for (let i = 0; i < N; i++) {
      if (!alive[i]) continue;
      const def = KIND_DEFS[kind[i]];
      age[i] += dt;
      if (age[i] >= life[i]) { alive[i] = 0; aliveCount--; freeStack[freeTop++] = i; continue; }
      if (resting[i]) continue;
      const i3 = i * 3;
      if (def.wind) { vel[i3] += wind.x * def.wind * dt; vel[i3 + 2] += wind.z * def.wind * dt; }
      const k = 1 - clamp(def.drag * dt, 0, 1);
      vel[i3] *= k; vel[i3 + 2] *= k;
      vel[i3 + 1] = (vel[i3 + 1] + def.gravity * dt) * k;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      if (def.spin) { rot[i3] += angVel[i3] * dt; rot[i3 + 1] += angVel[i3 + 1] * dt; rot[i3 + 2] += angVel[i3 + 2] * dt; }
      if (!def.collides) continue;
      const half = def.layer === 'chips' ? size[i] * (def.shape ? def.shape[1] : 0.4) * 0.5 : size[i] * 0.5;    // chip half-height, else sprite radius
      const gy = groundAt(pos[i3], pos[i3 + 2]) + half;
      if (pos[i3 + 1] < gy) {
        pos[i3 + 1] = gy;
        const vy = vel[i3 + 1];
        if (def.bounce > 0 && vy < -0.3) {
          vel[i3 + 1] = -vy * def.bounce; stats.bounces++;
        } else vel[i3 + 1] = 0;
        const f = 1 - def.friction;
        vel[i3] *= f; vel[i3 + 2] *= f;
        if (def.spin) { angVel[i3] *= 0.6; angVel[i3 + 1] *= 0.6; angVel[i3 + 2] *= 0.6; }
        const sp = Math.hypot(vel[i3], vel[i3 + 1], vel[i3 + 2]);
        if (def.rests && sp < def.restSpeed) {
          // Come to rest: lie flat, linger, then fade.
          resting[i] = 1; vel[i3] = vel[i3 + 1] = vel[i3 + 2] = 0;
          if (def.layer === 'chips') { rot[i3] = Math.round(rot[i3] / 3.1416) * 3.1416; rot[i3 + 2] = Math.round(rot[i3 + 2] / 3.1416) * 3.1416; }
          life[i] = age[i] + def.linger;
          stats.settled++;
        } else if (!def.rests && def.groundFade) {
          // Dust never bounces: it settles on the ground and fades out faster.
          life[i] = Math.min(life[i], age[i] + def.groundFade);
        }
      }
    }
  }

  function render() {
    let ng = 0, nd = 0, nc = 0;
    const gp = glowA.pos.array, gs = glowA.stretch.array, gz = glowA.size.array, gc = glowA.color.array, gt = glowA.tex.array;
    const dp = dustA.pos.array, dz = dustA.size.array, dr = dustA.rot.array, dc = dustA.color.array;
    const cm = chipMesh.instanceMatrix.array, cc = chipMesh.instanceColor.array;
    for (let i = 0; i < N; i++) {
      if (!alive[i]) continue;
      const def = KIND_DEFS[kind[i]], i3 = i * 3;
      const t = age[i] / life[i];
      if (def.layer === 'glow') {
        rampAt(def.ramp, t, col);
        let a = col[3];
        if (resting[i]) a *= clamp((life[i] - age[i]) / def.linger, 0, 1);
        const o3 = ng * 3, o4 = ng * 4;
        gp[o3] = pos[i3]; gp[o3 + 1] = pos[i3 + 1]; gp[o3 + 2] = pos[i3 + 2];
        const st = def.stretch || 0;
        gs[o3] = vel[i3] * st; gs[o3 + 1] = vel[i3 + 1] * st; gs[o3 + 2] = vel[i3 + 2] * st;
        gz[ng] = size[i];
        gc[o4] = col[0] * colR[i]; gc[o4 + 1] = col[1] * colG[i]; gc[o4 + 2] = col[2] * colB[i]; gc[o4 + 3] = a;
        gt[ng] = def.texture;
        ng++;
      } else if (def.layer === 'dust') {
        rampAt(def.ramp, t, col);
        const o3 = nd * 3, o4 = nd * 4;
        dp[o3] = pos[i3]; dp[o3 + 1] = pos[i3 + 1]; dp[o3 + 2] = pos[i3 + 2];
        dz[nd] = size[i] * (1 + (def.growth || 0) * t);
        dr[nd] = rot[i3];
        dc[o4] = col[0] * colR[i]; dc[o4 + 1] = col[1] * colG[i]; dc[o4 + 2] = col[2] * colB[i]; dc[o4 + 3] = col[3];
        nd++;
      } else {
        // chips layer: shrink away over the last fadeFrac of life instead of alpha fading (solid, lit)
        const fadeT = clamp((1 - t) / def.fadeFrac, 0, 1);
        const sc = size[i] * fadeT, sh = def.shape || [1, 0.4, 0.7];
        e3.set(rot[i3], rot[i3 + 1], rot[i3 + 2]); q.setFromEuler(e3);
        v3.set(pos[i3], pos[i3 + 1], pos[i3 + 2]); s3.set(sc * sh[0], sc * sh[1], sc * sh[2]);
        m4.compose(v3, q, s3);
        m4.toArray(cm, nc * 16);
        const o3 = nc * 3;
        cc[o3] = colR[i]; cc[o3 + 1] = colG[i]; cc[o3 + 2] = colB[i];
        nc++;
      }
    }
    glowGeom.instanceCount = ng; dustGeom.instanceCount = nd; chipMesh.count = nc;
    glowMesh.visible = ng > 0; dustMesh.visible = nd > 0; chipMesh.visible = nc > 0;
    for (const a of Object.values(glowA)) a.needsUpdate = true;
    for (const a of Object.values(dustA)) a.needsUpdate = true;
    chipMesh.instanceMatrix.needsUpdate = true;
    chipMesh.instanceColor.needsUpdate = true;
  }

  // update(dt, camera): dt in seconds, clamped to 0.1 and sub-stepped so fast chips never tunnel the ground.
  function update(dt, camera) {   // eslint-disable-line no-unused-vars  (billboarding is done in the shader)
    dt = clamp(+dt || 0, 0, 0.1);
    if (dt > 0) {
      runEmitters(dt);
      const steps = dt > 1 / 50 ? Math.ceil(dt / (1 / 60)) : 1;
      const h = dt / steps;
      for (let s = 0; s < steps; s++) step(h);
    }
    render();
    stats.alive = aliveCount;
  }

  const offs = [];
  if (bus) {
    offs.push(bus.on('contact', (e) => {
      if (!e) return;
      const list = rules(e) || [];
      for (const r of list) {
        const [kindName, scale, extra] = r;
        burst(kindName, { point: e.point, normal: e.normal, impulse: e.impulse, velocity: e.relVelocity, scale, ...(extra || {}) });
      }
    }));
    offs.push(bus.on('bite', (e) => {
      if (!e) return;
      stats.bites++;
      for (const [kindName, opts] of biteRules(e, rnd())) burst(kindName, opts);
    }));
    offs.push(bus.on('burst', (e) => { if (e && e.kind) burst(e.kind, e); }));
  }

  function dispose() {
    for (const off of offs) off && off();
    offs.length = 0;
    emitters.clear();
    if (scene) { scene.remove(glowMesh); scene.remove(dustMesh); scene.remove(chipMesh); }
    glowGeom.dispose(); dustGeom.dispose(); chipGeom.dispose();
    glowMat.dispose(); dustMat.dispose(); chipMat.dispose();
    if (chipMesh.dispose) chipMesh.dispose();
    if (!textures) for (const t of Object.values(tex)) t.dispose();
    alive.fill(0); aliveCount = 0; stats.alive = 0;
  }

  return {
    burst, update, dispose, emitter, removeEmitter, setWind,
    alive: () => aliveCount,
    emitters: () => [...emitters.keys()],
    wind: () => ({ ...wind }),
    stats: () => ({ ...stats, alive: aliveCount, byKind: { ...stats.byKind } }),
    // read-only views for tests and debugging
    layers: { glow: glowMesh, dust: dustMesh, chips: chipMesh },
    state: { pos, vel, age, life, size, kind, alive, resting, capacity: N, kinds: KIND_NAMES },
    textures: tex,
  };
}
