// dot3d decals: pooled instanced quads stuck to surfaces (scuffs, skid marks, scorch, exposed chips, gashes, trodden grass,
// contact blobs). Each decal is oriented to the surface normal, pushed ~2 mm along it, drawn with polygonOffset and no
// depth write so it never z-fights. One draw call for all decals (four textures plus a radial falloff, selected per instance).
// Driven by the bus: 'contact' above a threshold leaves a mark by what struck what (LOOK-BIBLE.md section 7): a scuff scaled
// with the impulse (scorch for heavy metal-on-metal), a `gash` along the blade's edge when an edged metal striker hits wood,
// a `press` of trodden grass under a landing, only a faint `dent` on straw (never a cut), and nothing from a blunt weapon
// under 4 N*s; 'bite' (a blade
// that stuck) cuts a 120 mm gash; 'decal' adds exactly what the game asks. Oldest decal is recycled when the pool is full.
// track()/untrack() keep a `blob` (soft dark ellipse) under a held or flying part, outside the round-robin, until released.
// Works with three r159 (global) and r185 (ESM): the THREE namespace is passed in.
// Claude (Command) / fable-builder, Oct 25 2026; step 6 kinds and rules Oct 26 2026.

import { makeVfxTextures } from './vfx-textures.js';

// tex: 0 scuff, 1 scorch, 2 chip, 3 gash, 4 radial falloff computed in the shader (glow, blob)
const KINDS = {
  scuff:  { tex: 0, aspect: 1.6, color: [0.14, 0.13, 0.12], opacity: 0.75 },
  skid:   { tex: 0, aspect: 3.5, color: [0.08, 0.08, 0.08], opacity: 0.85 },
  scorch: { tex: 1, aspect: 1.0, color: [1.0, 1.0, 1.0],    opacity: 0.95 },  // texture carries its own colour
  chip:   { tex: 2, aspect: 1.0, color: [0.78, 0.72, 0.62], opacity: 0.85 },
  glow:   { tex: 4, aspect: 1.0, color: [1.0, 0.61, 0.24], opacity: 0.24 },
  gash:   { tex: 3, aspect: 8.0, color: [1.0, 1.0, 1.0],    opacity: 0.9 },   // a blade's cut: long axis along the edge; texture carries its colour
  press:  { tex: 0, aspect: 1.3, color: [0.17, 0.2, 0.09],  opacity: 0.5 },   // grass trodden flat by a landing
  dent:   { tex: 0, aspect: 1.2, color: [0.45, 0.36, 0.2],  opacity: 0.35 },  // straw pressed in where it was struck: faint, never a cut
  blob:   { tex: 4, aspect: 1.0, color: [0.02, 0.02, 0.03], opacity: 0.35 },  // contact shadow under a held or flying part
};
const KIND_LIST = Object.keys(KINDS);

const CONTACT_THRESHOLD = 0.8;   // N*s: below this a hit leaves no mark
const BLUNT_THRESHOLD = 4.0;     // N*s: a bat, staff or mace marks only above this (section 7)
const SCORCH_THRESHOLD = 40.0;   // metal on metal at or above this scorches (a heavy crash, not a dropped ball)
const BITE_GASH = 0.12;          // m: the gash a stuck blade leaves at its entry
const WOODISH = new Set(['wood', 'plank', 'bark']);
const METALISH = new Set(['metal', 'steel', 'iron', 'gold']);
export const DECAL_RULES = { CONTACT_THRESHOLD, BLUNT_THRESHOLD, SCORCH_THRESHOLD, BITE_GASH };

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

const VERT = `
attribute vec3 aPos; attribute vec4 aQuat; attribute vec2 aSize; attribute vec4 aColor; attribute float aTex;
varying vec2 vUv; varying vec4 vColor; varying float vTex;
vec3 rotateQ(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
void main() {
  vUv = uv; vColor = aColor; vTex = aTex;
  vec3 world = aPos + rotateQ(aQuat, vec3(position.xy * aSize, 0.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
}`;
const FRAG = `
uniform sampler2D map0; uniform sampler2D map1; uniform sampler2D map2; uniform sampler2D map3;
varying vec2 vUv; varying vec4 vColor; varying float vTex;
void main() {
  vec4 t0 = texture2D(map0, vUv); vec4 t1 = texture2D(map1, vUv); vec4 t2 = texture2D(map2, vUv); vec4 t3 = texture2D(map3, vUv);
  vec4 t = mix(mix(t0, t1, step(0.5, vTex)), t2, step(1.5, vTex));
  t = mix(t, t3, step(2.5, vTex));
  if (vTex > 3.5) t = vec4(1.0, 1.0, 1.0, pow(max(0.0, 1.0 - length(vUv * 2.0 - 1.0)), 2.0));
  gl_FragColor = vec4(vColor.rgb * t.rgb, t.a * vColor.a);
}`;

// A persistent glow attached to an emitter, separate from the short-lived contact pool.
export function createGroundGlow(THREE, { size = 3, color = '#ffcf8a' } = {}) {
  const material = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, opacity: { value: KINDS.glow.opacity } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform vec3 color; uniform float opacity; varying vec2 vUv;
      void main(){ float a=pow(max(0.,1.-length(vUv*2.-1.)),2.); gl_FragColor=vec4(color,opacity*a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  mesh.name = 'emitter-ground-glow'; mesh.rotation.x = -Math.PI / 2;
  mesh.userData.phaseHelper = true; mesh.raycast = () => {};
  return mesh;
}

// The mark a contact leaves, from LOOK-BIBLE.md section 7, or null. e: the bus 'contact' event (point, normal, impulse,
// materials, and when the physics core annotated it: surfaces, striker, edge {dir}, blunt). Exported so a test can read the
// rule without a pool.
export function contactDecal(e) {
  if (!e || !(e.impulse >= CONTACT_THRESHOLD)) return null;
  const mats = Array.isArray(e.materials) ? e.materials : [];
  const surf = Array.isArray(e.surfaces) ? e.surfaces : mats;
  const striker = e.striker === 1 ? 1 : 0, struck = 1 - striker;
  if (e.blunt && e.impulse < BLUNT_THRESHOLD) return null;                   // a bat has to land hard to scuff
  const r = Math.sqrt(e.impulse);
  if (surf[striker] === 'straw') return null;                                // a thrown hay bale leaves nothing on what it hits
  if (surf[struck] === 'straw') {
    // Straw is never cut or scuffed (section 7); the blow presses the stalks in, a faint darker patch the step-4 rig check
    // reads as "a mark on the straw" (tests/physics-rig.test.mjs). Opacity tops out at 0.35 x 0.6.
    return { kind: 'dent', point: e.point, normal: e.normal, size: clamp(0.04 + 0.03 * r, 0.05, 0.2), opacity: 0.6 };
  }
  if (surf[struck] === 'grass') {
    // Trodden grass under a landing: a soft dark-green press, bigger for a heavier landing.
    return { kind: 'press', point: e.point, normal: e.normal, size: clamp(0.08 + 0.05 * r, 0.1, 0.45), opacity: clamp(0.4 + 0.1 * r, 0.4, 0.9) };
  }
  const metalStriker = METALISH.has(String(mats[striker])) || METALISH.has(String(surf[striker]));
  const woodStruck = WOODISH.has(String(mats[struck])) || WOODISH.has(String(surf[struck]));
  if (metalStriker && woodStruck && e.edge && e.edge.dir && !e.blunt) {
    // The blade bit: a slit along the edge direction, 60 to 220 mm, longer for a harder hit.
    return { kind: 'gash', point: e.point, normal: e.normal, along: e.edge.dir, size: clamp(0.06 + 0.035 * r, 0.06, 0.22), opacity: 0.9 };
  }
  const metalCount = mats.filter((m) => m === 'metal').length;
  const kind = (metalCount >= 2 && e.impulse >= SCORCH_THRESHOLD) ? 'scorch' : 'scuff';
  // Marks grow with the square root of the impulse: a dropped steel ball leaves a ~0.1 m scuff, a crash ~0.3 m.
  const size = clamp(0.04 + 0.03 * r, 0.05, 0.3) * (kind === 'scorch' ? 0.7 : 1);
  return { kind, point: e.point, normal: e.normal, size, opacity: clamp(0.35 + 0.1 * r, 0.35, 0.9) };
}

// The mark a blade leaves where it stuck (bus 'bite': point, normal, dir, surface, material), or null for straw.
export function biteDecal(e) {
  if (!e || !e.point) return null;
  if (e.surface === 'straw') return null;
  const woodish = WOODISH.has(String(e.surface)) || WOODISH.has(String(e.material));
  if (!woodish) return null;
  return { kind: 'gash', point: e.point, normal: e.normal, along: e.dir, size: BITE_GASH, opacity: 0.9 };
}

export function createDecals(THREE, { scene, bus = null, maxDecals = 64, textures = null, seed = 1, fadeAfter = 30 } = {}) {
  const N = Math.max(1, maxDecals | 0);
  const rnd = makePrng(seed);
  const tex = textures || makeVfxTextures(THREE);
  const fadeTime = Math.max(0.5, fadeAfter * 0.2);

  const geom = new THREE.InstancedBufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geom.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const inst = (name, itemSize) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(N * itemSize), itemSize);
    if (THREE.DynamicDrawUsage !== undefined) a.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute(name, a);
    return a;
  };
  const aPos = inst('aPos', 3), aQuat = inst('aQuat', 4), aSize = inst('aSize', 2), aColor = inst('aColor', 4), aTex = inst('aTex', 1);
  geom.instanceCount = N;   // dead slots have size 0 (degenerate), so the whole pool is one draw

  const mat = new THREE.ShaderMaterial({
    uniforms: { map0: { value: tex.scuff }, map1: { value: tex.scorch }, map2: { value: tex.chip }, map3: { value: tex.gash || tex.scuff } },
    vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'dot3d-decals'; mesh.frustumCulled = false; mesh.renderOrder = 5;
  if (scene) scene.add(mesh);

  // pool state
  const age = new Float32Array(N), opacity = new Float32Array(N), alive = new Uint8Array(N);
  const sizeW = new Float32Array(N), sizeH = new Float32Array(N);
  const tracked = new Uint8Array(N);          // 1: a slot track() owns; the round-robin and the fade skip it
  const tracks = new Map();                   // key -> slot
  const maxTracked = Math.max(1, Math.floor(N / 4));
  let cursor = 0, count = 0;

  const zAxis = new THREE.Vector3(0, 0, 1), xAxis = new THREE.Vector3(1, 0, 0), yAxis = new THREE.Vector3(0, 1, 0);
  const nrm = new THREE.Vector3(), tan = new THREE.Vector3(), bx = new THREE.Vector3(), by = new THREE.Vector3();
  const q = new THREE.Quaternion(), qz = new THREE.Quaternion();

  // Writes one slot. along (optional, world direction): the quad's long axis (local +x, the texture's u) is turned onto
  // that direction projected on the surface; otherwise `rotation` spins it (random by default).
  function write(i, opts, def) {
    const p = opts.point || { x: 0, y: 0, z: 0 };
    nrm.set(+(opts.normal && opts.normal.x) || 0, +(opts.normal && opts.normal.y) || 0, +(opts.normal && opts.normal.z) || 0);
    if (nrm.lengthSq() < 1e-12) nrm.set(0, 1, 0);
    nrm.normalize();
    const size = Math.max(0.005, +opts.size || 0.15);
    q.setFromUnitVectors(zAxis, nrm);
    let rotation;
    const a = opts.along;
    if (a && Number.isFinite(+a.x) && Number.isFinite(+a.y) && Number.isFinite(+a.z)) {
      tan.set(+a.x, +a.y, +a.z).addScaledVector(nrm, -tan.dot(nrm));
      if (tan.lengthSq() > 1e-10) {
        tan.normalize();
        bx.copy(xAxis).applyQuaternion(q); by.copy(yAxis).applyQuaternion(q);
        rotation = Math.atan2(tan.dot(by), tan.dot(bx));
      } else rotation = rnd() * Math.PI * 2;   // the edge went straight in: no direction on the surface
    } else rotation = opts.rotation === undefined ? rnd() * Math.PI * 2 : +opts.rotation;
    qz.setFromAxisAngle(zAxis, rotation);
    q.multiply(qz);
    const vary = opts.exact ? 1 : 0.9 + 0.2 * rnd();
    opacity[i] = clamp(opts.opacity === undefined ? 1 : +opts.opacity, 0, 1) * def.opacity;
    aPos.array[i * 3] = (+p.x || 0) + nrm.x * 0.002;
    aPos.array[i * 3 + 1] = (+p.y || 0) + nrm.y * 0.002;
    aPos.array[i * 3 + 2] = (+p.z || 0) + nrm.z * 0.002;
    aQuat.array[i * 4] = q.x; aQuat.array[i * 4 + 1] = q.y; aQuat.array[i * 4 + 2] = q.z; aQuat.array[i * 4 + 3] = q.w;
    sizeW[i] = (opts.sizeW !== undefined ? +opts.sizeW : size) * (opts.exact ? 1 : 0.9 + 0.2 * rnd());
    sizeH[i] = (opts.sizeH !== undefined ? +opts.sizeH : size / (opts.aspect || def.aspect)) * (opts.exact ? 1 : 0.9 + 0.2 * rnd());
    aSize.array[i * 2] = sizeW[i]; aSize.array[i * 2 + 1] = sizeH[i];
    const c = opts.color || def.color;
    aColor.array[i * 4] = c[0] * vary; aColor.array[i * 4 + 1] = c[1] * vary; aColor.array[i * 4 + 2] = c[2] * vary;
    aColor.array[i * 4 + 3] = opacity[i];
    aTex.array[i] = def.tex;
    aPos.needsUpdate = aQuat.needsUpdate = aSize.needsUpdate = aColor.needsUpdate = aTex.needsUpdate = true;
  }
  function clearSlot(i) {
    if (alive[i]) count--;
    alive[i] = 0;
    aSize.array[i * 2] = 0; aSize.array[i * 2 + 1] = 0; aColor.array[i * 4 + 3] = 0;
    aSize.needsUpdate = aColor.needsUpdate = true;
  }

  // add({ point, normal, size = 0.15, kind = 'scuff', rotation | along, opacity = 1, color, aspect }) -> pool index
  function add(opts = {}) {
    const def = KINDS[opts.kind] || KINDS.scuff;
    let i = cursor;
    for (let n = 0; n < N && tracked[i]; n++) i = (i + 1) % N;   // skip the slots blobs hold
    cursor = (i + 1) % N;                                        // round-robin = oldest first (decals die in order)
    if (tracked[i]) return -1;                                   // cannot happen below maxTracked; kept as a guard
    if (!alive[i]) count++;
    alive[i] = 1; age[i] = 0;
    write(i, opts, def);
    return i;
  }

  // track(key, { point, normal, sizeW, sizeH, rotation, opacity, kind = 'blob' }): keep one decal under a moving thing,
  // rewritten each call, never aged or recycled, until untrack(key). Returns the slot, or -1 when the tracked share
  // (a quarter of the pool) is full.
  function track(key, opts = {}) {
    let i = tracks.get(key);
    if (i === undefined) {
      if (tracks.size >= maxTracked) return -1;
      // Take the highest free slot, else the highest untracked one (its mark is lost: a blob under a swung sword matters more).
      i = -1;
      for (let k = N - 1; k >= 0; k--) if (!tracked[k] && !alive[k]) { i = k; break; }
      if (i < 0) for (let k = N - 1; k >= 0; k--) if (!tracked[k]) { i = k; break; }
      if (i < 0) return -1;
      if (!alive[i]) count++;
      alive[i] = 1; tracked[i] = 1; tracks.set(key, i);
    }
    age[i] = 0;
    write(i, { exact: true, rotation: 0, ...opts }, KINDS[opts.kind] || KINDS.blob);
    return i;
  }
  function untrack(key) {
    const i = tracks.get(key);
    if (i === undefined) return false;
    tracks.delete(key); tracked[i] = 0;
    clearSlot(i);
    return true;
  }

  function update(dt) {
    dt = Math.max(0, +dt || 0);
    let changed = false;
    for (let i = 0; i < N; i++) {
      if (!alive[i] || tracked[i]) continue;
      age[i] += dt;
      if (age[i] <= fadeAfter) continue;
      const f = 1 - (age[i] - fadeAfter) / fadeTime;
      if (f <= 0) {
        alive[i] = 0; count--;
        aSize.array[i * 2] = 0; aSize.array[i * 2 + 1] = 0; aColor.array[i * 4 + 3] = 0;
      } else aColor.array[i * 4 + 3] = opacity[i] * f;
      changed = true;
    }
    if (changed) { aColor.needsUpdate = true; aSize.needsUpdate = true; }
    mesh.visible = count > 0;
  }

  const stats = { contacts: 0, marks: 0, bites: 0, byKind: Object.fromEntries(KIND_LIST.map((k) => [k, 0])) };
  const offs = [];
  if (bus) {
    offs.push(bus.on('contact', (e) => {
      stats.contacts++;
      const d = contactDecal(e);
      if (!d) return;
      stats.marks++; stats.byKind[d.kind]++;
      add(d);
    }));
    offs.push(bus.on('bite', (e) => {
      stats.bites++;
      const d = biteDecal(e);
      if (!d) return;
      stats.marks++; stats.byKind[d.kind]++;
      add(d);
    }));
    offs.push(bus.on('decal', (e) => { if (e) { stats.byKind[KINDS[e.kind] ? e.kind : 'scuff']++; add(e); } }));
  }

  function dispose() {
    for (const off of offs) off && off();
    offs.length = 0;
    if (scene) scene.remove(mesh);
    geom.dispose(); mat.dispose();
    if (!textures) for (const t of Object.values(tex)) t.dispose();
    alive.fill(0); tracked.fill(0); tracks.clear(); count = 0;
  }

  return {
    add, track, untrack, update, dispose,
    count: () => count,
    tracked: () => tracks.size,
    stats: () => ({ ...stats, byKind: { ...stats.byKind } }),
    mesh, kinds: KIND_LIST,
    state: { age, alive, tracked, capacity: N, attributes: { aPos, aQuat, aSize, aColor, aTex } },
  };
}
