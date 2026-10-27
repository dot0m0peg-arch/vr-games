// "Phase in" effect for summoned objects, the AI "thinking" indicator and small particle bursts.
//
// Reveal space: the effect works in the OBJECT-LOCAL height of the root passed to phaseIn/phaseOut.
// Every patched material gets uPhaseInv = inverse(root.matrixWorld) (refreshed each frame), so a
// fragment's local height is (uPhaseInv * worldPos).y. The reveal therefore stays glued to the
// object while it moves, turns or sits in a hand (a held axe reveals from handle butt to head).
//
// Materials: each distinct mesh material is swapped for a clone patched with onBeforeCompile
// (programs shared through customProgramCacheKey) and restored when the effect ends. One clone per
// shader variant is kept alive (never rendered) so its GPU program survives for the next spawn;
// precompile() warms the common variants up front, warmUp() the other first-use programs.
//
// Sizing (LOOK-BIBLE.md section 7, "Materialize, in full"): duration, seam band, mote total, ring, dust settle and
// the seam light all follow the part's world height and footprint through materializeSpec(). With a dot3d particle
// system attached (attach()), the motes are `shimmer` bursts spawned on the seam's perimeter; without one (Node
// tests, non-physics mode) the original rising sparkles stay. Claude (Command), step 5, Oct 26 2026.
import * as THREE from "../../vendor/three.module.min.js";
import { rng } from "../util/ids.js";
import { setClearing, removeClearing } from "./field.js";

const OUT_DURATION = 0.7;
const SCAN_STEP = 0.016; // meters between scanlines
const RING_PULSE = 0.35; // seconds, ground ring
const MOTE_INTERVAL = 0.05; // seconds between shimmer bursts
const MOTES_PER_UNIT_SCALE = 18; // shimmer count at impulse 1 and scale 1 (EFFECTS.shimmer: 8 + 10 * 1^0.7)
const DUST_PER_UNIT_SCALE = 7; // dust count at impulse 1 and scale 1 (EFFECTS.dust: 3 + 4 * 1^0.7)
const SETTLE_DELAY = 0.3; // seconds after the seam clears the top
const MOTE_TINT = [1.0, 0.902, 0.722]; // #ffe6b8 over the shimmer ramp
const GRASS_TINT = [0.624, 0.659, 0.408]; // #9fa868, the ground under the yard
const UP = { x: 0, y: 1, z: 0 };
const DOWN = { x: 0, y: -1, z: 0 };
const noRaycast = () => {};

const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const easeIn = (k) => k * k * k;
const clamp01 = (k) => (k < 0 ? 0 : k > 1 ? 1 : k);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// The bible's materialize numbers for a part `height` m tall with a footprint of `area` m^2.
// mug (0.1 m) 1.2 s / 50 mm seam / 12 motes / no ring; dummy (1.82 m) 1.22 s / 95 mm; villa (9.04 m, ~10 m^2) 2.08 s /
// 250 mm / 400 motes / ring / dust settle; castle (15.3 m) caps at 2.6 s. Quest halves any mote total above 100.
// In hand: 0.9 s, motes only (no ring, no dust).
export function materializeSpec(height, area, { tier = "laptop", inHand = false } = {}) {
  const h = Math.max(0, +height || 0);
  const a = Math.max(0, +area || 0);
  let motes = Math.round(clamp(12 + 40 * a, 12, 400));
  if (tier === "quest" && motes > 100) motes = Math.round(motes / 2);
  return {
    duration: inHand ? 0.9 : clamp(1.0 + 0.12 * h, 1.2, 2.6),
    band: clamp(0.04 + 0.03 * h, 0.05, 0.25),
    lightIntensity: clamp(1.5 * h, 2, 10),
    lightDistance: Math.max(1, 2 * h),
    motes,
    ring: !inHand && a >= 0.1,
    dust: !inHand && h >= 3 ? Math.round(clamp(12 + 2 * (h - 3), 12, 24)) : 0,
  };
}

// ---------- bounds ----------

const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _box = new THREE.Box3();

// Bounding box of `root`'s visible meshes in root-local coordinates (helpers are skipped).
export function localBox(root, target = new THREE.Box3()) {
  target.makeEmpty();
  root.updateWorldMatrix(true, true);
  _inv.copy(root.matrixWorld).invert();
  const visit = (object) => {
    if (object.userData?.phaseHelper) return;
    if (object !== root && !object.visible) return;
    const geometry = object.geometry;
    if (geometry && (object.isMesh || object.isPoints || object.isLine)) {
      if (object.isInstancedMesh || object.isSkinnedMesh) {
        if (object.boundingBox === null) object.computeBoundingBox();
        _box.copy(object.boundingBox);
      } else {
        if (geometry.boundingBox === null) geometry.computeBoundingBox();
        _box.copy(geometry.boundingBox);
      }
      if (!_box.isEmpty()) {
        _m.multiplyMatrices(_inv, object.matrixWorld);
        target.union(_box.applyMatrix4(_m));
      }
    }
    for (const child of object.children) visit(child);
  };
  visit(root);
  return target;
}

// ---------- shader patches ----------

const PHASE_DECL = /* glsl */ `
uniform mat4 uPhaseInv;
uniform float uReveal;
uniform float uBand;
uniform vec3 uPhaseColor;
uniform float uScan;
uniform float uScanFreq;
varying vec3 vPhasePos;`;

const PHASE_VERTEX = /* glsl */ `
{
  vec4 phaseWorld = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    phaseWorld = batchingMatrix * phaseWorld;
  #endif
  #ifdef USE_INSTANCING
    phaseWorld = instanceMatrix * phaseWorld;
  #endif
  phaseWorld = modelMatrix * phaseWorld;
  vPhasePos = (uPhaseInv * phaseWorld).xyz;
}`;

function patchVertex(shader) {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${PHASE_DECL}`)
    .replace("#include <project_vertex>", `#include <project_vertex>\n${PHASE_VERTEX}`);
}

// Solid materials: hide above the reveal height, glow in a band just below it.
function patchSolid(shader) {
  patchVertex(shader);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${PHASE_DECL}`)
    .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (vPhasePos.y > uReveal) discard;")
    .replace(
      "#include <opaque_fragment>",
      /* glsl */ `{
        float phaseD = uReveal - vPhasePos.y;
        float phaseBand = 1.0 - smoothstep(0.0, uBand, phaseD);
        float phaseCore = 1.0 - smoothstep(0.0, uBand * 0.18, phaseD);
        float phaseLine = vPhasePos.y * uScanFreq - uScan * 9.0;
        float phaseAA = 1.0 - smoothstep(0.8, 2.2, fwidth(phaseLine)); // fade lines that would alias far away
        float phaseScan = (0.5 + 0.5 * sin(phaseLine)) * phaseAA * (1.0 - smoothstep(uBand, uBand * 5.0, phaseD));
        outgoingLight = mix(outgoingLight, uPhaseColor * 1.25, phaseBand * phaseBand * 0.92) + uPhaseColor * (phaseScan * 0.2 + phaseCore * 1.6);
      }
      #include <opaque_fragment>`,
    );
}

// Hologram shell: shows only ABOVE the reveal height (the part still being summoned).
function patchShell(shader) {
  patchVertex(shader);
  shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vShellView;").replace("#include <project_vertex>", "#include <project_vertex>\nvShellView = mvPosition.xyz;");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${PHASE_DECL}\nuniform float uShell;\nuniform float uGrid;\nvarying vec3 vShellView;`)
    .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (vPhasePos.y < uReveal) discard;")
    .replace(
      "#include <opaque_fragment>",
      /* glsl */ `{
        vec3 g = abs(fract(vPhasePos / uGrid) - 0.5);
        vec3 fw = max(fwidth(vPhasePos / uGrid), vec3(1e-4));
        vec3 lines = 1.0 - smoothstep(fw * 0.5, fw * 1.5, 0.5 - g);
        float grid = max(max(lines.x, lines.y), lines.z);
        vec3 n = normalize(cross(dFdx(vShellView), dFdy(vShellView)));
        float rim = pow(1.0 - abs(dot(n, normalize(-vShellView))), 2.0);
        float scanLine = vPhasePos.y * uScanFreq * 0.25 - uScan * 6.0;
        float scan = (0.5 + 0.5 * sin(scanLine)) * (1.0 - smoothstep(0.8, 2.2, fwidth(scanLine)));
        float edge = 1.0 - smoothstep(0.0, uBand * 2.5, vPhasePos.y - uReveal);
        // Normal blending: overlapping shells converge to the accent instead of burning to white.
        float a = (0.06 + grid * 0.55 + rim * 0.3 + scan * 0.05 + edge * 0.5) * uShell;
        outgoingLight = uPhaseColor * (1.0 + edge * 0.7 + grid * 0.3);
        diffuseColor.a = clamp(a, 0.0, 0.85);
      }
      #include <opaque_fragment>`,
    );
}

// Approximate shader-variant key (what changes the compiled program) for the keep-alive cache.
// Only used before precompile() has seen the renderer; after that keepers are keyed by the real program.
function variantKey(prefix, material, object) {
  return [
    prefix, material.type, material.side, !!material.map, !!material.emissiveMap, !!material.normalMap, !!material.alphaMap,
    !!material.vertexColors, !!material.flatShading, !!material.transparent, material.toneMapped, !!object?.isInstancedMesh, !!object?.isSkinnedMesh,
    material.alphaTest > 0, !!material.alphaHash, !!material.roughnessMap, !!material.metalnessMap, !!material.aoMap,
  ].join("|");
}

function stripTextures(material) {
  for (const key of Object.keys(material)) {
    if (material[key]?.isTexture) material[key] = null;
  }
}

const canPatch = (material) => material && !material.isShaderMaterial && !material.isRawShaderMaterial && !material.isPointsMaterial && !material.isLineBasicMaterial && !material.isSpriteMaterial;

// ---------- particles (PointsMaterial patched: correct point size in WebXR stereo too) ----------

function sparkGeometry(count, seed) {
  const random = rng(seed);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = random();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
  return geometry;
}

function sparkMaterial(color, kind, uniforms) {
  const material = new THREE.PointsMaterial({
    color, size: kind === "burst" ? 0.06 : 0.045, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute vec4 aSeed;
        uniform vec3 uCenter;
        uniform vec3 uSize;
        uniform float uLife;
        uniform float uTime;
        varying float vAlpha;`,
      )
      .replace(
        "#include <begin_vertex>",
        kind === "burst"
          ? /* glsl */ `
          float k = uLife;
          float a = aSeed.x * 6.2831;
          float up = aSeed.y * 2.0 - 0.6;
          vec3 dir = normalize(vec3(cos(a), up, sin(a)));
          float reach = uSize.x * (0.6 + 0.8 * aSeed.z);
          float out_ = 1.0 - pow(1.0 - k, 3.0);
          vec3 transformed = uCenter + dir * reach * out_ + vec3(0.0, -0.6 * k * k, 0.0);
          vAlpha = (1.0 - k) * (1.0 - k) * (0.6 + 0.4 * aSeed.w);`
          : /* glsl */ `
          float cycle = fract(aSeed.w + uTime * (0.35 + 0.45 * aSeed.z));
          float ang = aSeed.x * 6.2831 + uTime * (aSeed.y - 0.5);
          float rad = 0.55 + 0.25 * aSeed.y;
          vec3 transformed = uCenter + vec3(cos(ang) * uSize.x * rad, cycle * uSize.y * 1.25, sin(ang) * uSize.z * rad);
          vAlpha = sin(cycle * 3.14159) * uLife;`,
      )
      .replace("gl_PointSize = size;", "gl_PointSize = size * (0.6 + 0.8 * aSeed.z);");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vAlpha;")
      .replace("#include <alphatest_fragment>", "diffuseColor.a *= smoothstep(0.5, 0.05, length(gl_PointCoord - 0.5)) * vAlpha;\n#include <alphatest_fragment>");
  };
  material.customProgramCacheKey = () => `phase-spark-${kind}`;
  return material;
}

// ---------- decals (ShaderMaterial; no lights or textures) ----------

function decalMaterial(kind, uniforms) {
  const common = {
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: kind === "column" ? THREE.DoubleSide : THREE.FrontSide,
    polygonOffset: kind !== "column",
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  };
  const vertexShader = /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const head = /* glsl */ `
    uniform vec3 uColor;
    uniform float uAlpha;
    uniform float uTime;
    uniform float uProgress;
    varying vec2 vUv;
    float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }`;
  const tail = /* glsl */ `
    gl_FragColor = vec4(uColor * a, a);
    #include <colorspace_fragment>`;
  if (kind === "ring") {
    return new THREE.ShaderMaterial({
      ...common,
      name: "phase-ring",
      vertexShader,
      fragmentShader: `${head}
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float radius = mix(0.25, 1.0, 1.0 - pow(1.0 - uProgress, 2.0));
        float ring = exp(-pow((r - radius) / 0.05, 2.0));
        float inner = exp(-pow((r - radius * 0.72) / 0.025, 2.0)) * 0.5;
        float fill = (1.0 - smoothstep(0.0, radius, r)) * 0.12;
        float a = (ring + inner + fill) * uAlpha * (1.0 - smoothstep(0.98, 1.0, r));
        ${tail}
      }`,
    });
  }
  if (kind === "rune") {
    return new THREE.ShaderMaterial({
      ...common,
      name: "phase-rune",
      vertexShader,
      fragmentShader: `${head}
      void main() {
        vec2 q = vUv - 0.5;
        float r = length(q) * 2.0;
        float ang = atan(q.y, q.x) / 6.2831 + 0.5;
        float aw = fwidth(r) * 1.5;
        float outer = 1.0 - smoothstep(0.0, 0.012 + aw, abs(r - 0.94));
        float mid = 1.0 - smoothstep(0.0, 0.008 + aw, abs(r - 0.7));
        float a1 = fract(ang + uTime * 0.06);
        float cell = floor(a1 * 28.0);
        float u = fract(a1 * 28.0);
        float v = (r - 0.73) / 0.18;
        float bits = hash(cell + 3.0);
        float glyph = 0.0;
        if (v > 0.0 && v < 1.0 && u > 0.18 && u < 0.82) {
          float col = floor((u - 0.18) / 0.64 * 3.0);
          float row = floor(v * 3.0);
          float bit = mod(floor(bits * 512.0 / pow(2.0, row * 3.0 + col)), 2.0);
          vec2 f = vec2(fract((u - 0.18) / 0.64 * 3.0), fract(v * 3.0));
          float inset = step(0.18, f.x) * step(f.x, 0.82) * step(0.18, f.y) * step(f.y, 0.82);
          glyph = bit * inset;
        }
        float a2 = fract(ang - uTime * 0.11);
        float dashes = step(0.5, fract(a2 * 40.0)) * (1.0 - smoothstep(0.0, 0.01 + aw, abs(r - 0.56)));
        float glow = (1.0 - smoothstep(0.0, 1.0, r)) * 0.18;
        float pulse = 0.78 + 0.22 * sin(uTime * 4.0);
        float a = (outer + mid * 0.8 + glyph * 0.85 + dashes * 0.7 + glow) * uAlpha * pulse * (1.0 - smoothstep(0.97, 1.0, r));
        ${tail}
      }`,
    });
  }
  // column: open cylinder, uv.y = height fraction
  return new THREE.ShaderMaterial({
    ...common,
    name: "phase-column",
    vertexShader,
    fragmentShader: `${head}
    void main() {
      float h = vUv.y;
      float stripes = 0.5 + 0.5 * sin(h * 26.0 - uTime * 5.0);
      float pulse = 0.75 + 0.25 * sin(uTime * 4.0 + 1.0);
      float a = pow(1.0 - h, 1.6) * (0.16 + 0.12 * stripes) * uAlpha * pulse * smoothstep(0.0, 0.04, h);
      ${tail}
    }`,
  });
}

// ---------- Phaser ----------

export class Phaser {
  // color: the summon rune, column and hit bursts (the AI "thinking" accent). bandColor: the materialize seam, shell,
  // ring and seam light (bible: warm white-gold). particles/tier/lightCap/activeLights/groundTint can also come later
  // through attach(), once the dot3d particle system exists.
  // prepare(root): the scene's own per-material shader patch (the field's dawn mist), applied to originals before they
  // are cloned and to the clones right away, so a reveal's programs carry the same key as precompile() warmed.
  constructor({ scene, color = "#d5fb6a", bandColor = "#ffd9a0", particles = null, tier = "laptop", lightCap = Infinity, activeLights = () => 0, groundTint = null, prepare = null } = {}) {
    this.scene = scene;
    this.color = new THREE.Color(color);
    this.bandColor = new THREE.Color(bandColor);
    this.particles = particles;
    this.tier = tier;
    this.lightCap = lightCap;
    this.activeLights = activeLights;
    this.groundTint = groundTint || (() => GRASS_TINT);
    this.prepare = prepare;
    this.time = 0;
    this.jobs = new Map(); // root Object3D -> job
    this.summons = new Set();
    this.summonCount = 0;
    this.bursts = [];
    this.freeBursts = [];
    this.settles = []; // pending dust puffs (tall parts settle 0.3 s after the seam clears the top)
    this.log = []; // the last 50 finished reveals: what the capture check and the headset self-test read
    this.lightJob = null;
    this.keepers = new Map(); // variant key -> material kept alive so its GPU program survives
    this.group = new THREE.Group();
    this.group.name = "phase-fx";
    scene.add(this.group);
    // One seam light for the whole effect (it rides the newest reveal). Always in the scene so the lit programs
    // are compiled with it once; idle at intensity 0. It is only switched off when a tier's point-light cap is full.
    this.light = new THREE.PointLight(this.bandColor, 0, 1, 2);
    this.light.name = "phase-seam-light";
    this.light.userData.phaseHelper = true;
    this.light.castShadow = false;
    this.light.raycast = noRaycast;
    scene.add(this.light);

    const flat = new THREE.PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    const column = new THREE.CylinderGeometry(1, 1, 1, 32, 1, true);
    column.translate(0, 0.5, 0);
    this.geo = { flat, column, sparks: sparkGeometry(48, 7), burst: sparkGeometry(28, 9) };
    for (const g of Object.values(this.geo)) g.userData.shared = true;
    this._tmp = { v: new THREE.Vector3(), v2: new THREE.Vector3(), p: new THREE.Vector3(), s: new THREE.Vector3(), q: new THREE.Quaternion(), box: new THREE.Box3() };
  }

  // Wires in the dot3d particle system (motes and dust) and the tier's point-light cap once they exist.
  attach({ particles = this.particles, tier = this.tier, lightCap = this.lightCap, activeLights = this.activeLights, groundTint = this.groundTint, prepare = this.prepare } = {}) {
    this.particles = particles;
    this.tier = tier;
    this.lightCap = lightCap;
    this.activeLights = activeLights;
    this.groundTint = groundTint;
    this.prepare = prepare;
  }

  isPhasing(object) {
    return this.jobs.has(object);
  }

  // Ends an effect immediately (originals restored, promise resolved).
  cancel(object) {
    const job = this.jobs.get(object);
    if (job) this._finish(job);
  }

  // duration defaults to the bible's formula for the part's height (0.9 s in hand); inHand: motes only.
  phaseIn(object, { duration, inHand = false } = {}) {
    return this._start(object, 1, duration, { inHand });
  }

  phaseOut(object, { duration = OUT_DURATION, inHand = false } = {}) {
    return this._start(object, -1, duration, { inHand });
  }

  // For the model loader (build order step 7): a sculpt proxy swapped for its GLB while the reveal runs is re-patched
  // at the same reveal height, so the band hides the swap. Returns false when the object is not phasing.
  rebind(object) {
    const job = this.jobs.get(object);
    if (!job) return false;
    const reveal = job.uniforms.uReveal.value;
    this._unbind(job);
    localBox(object, job.box);
    this._bind(job);
    // The new box may be taller or shorter: keep the seam where it is (in meters) and let the timing continue.
    const { box, spec, worldScale: scale } = job;
    const band = spec.band / scale;
    const lo = box.min.y - 0.02 / scale;
    const hi = box.max.y + band * 1.2;
    const fraction = clamp01((reveal - lo) / Math.max(1e-6, hi - lo));
    const k = clamp01(job.t / job.duration);
    const eased = job.dir > 0 ? easeOut(k) : 1 - easeIn(k);
    // start may leave [0, 1] here (a taller model needs a lower fraction for the same height); the reveal itself stays bounded.
    job.start = job.dir > 0 ? (eased < 0.999 ? (fraction - eased) / (1 - eased) : fraction) : eased > 0.001 ? fraction / eased : fraction;
    this._step(job, 0);
    return true;
  }

  _start(object, dir, duration, { inHand = false, silent = false } = {}) {
    let fraction = dir > 0 ? 0 : 1;
    const running = this.jobs.get(object);
    if (running) {
      fraction = running.fraction;
      this._finish(running);
    }
    const box = localBox(object, new THREE.Box3());
    if (box.isEmpty()) return Promise.resolve();
    object.matrixWorld.decompose(this._tmp.v, this._tmp.q, this._tmp.s);
    const scale = Math.max(1e-4, (Math.abs(this._tmp.s.x) + Math.abs(this._tmp.s.y) + Math.abs(this._tmp.s.z)) / 3);
    const height = (box.max.y - box.min.y) * scale;
    const area = (box.max.x - box.min.x) * scale * ((box.max.z - box.min.z) * scale);
    const spec = materializeSpec(height, area, { tier: this.tier, inHand });
    if (duration === undefined) duration = dir > 0 ? spec.duration : OUT_DURATION;
    if (!(duration > 0)) return Promise.resolve();

    const uniforms = {
      uPhaseInv: { value: new THREE.Matrix4() },
      uReveal: { value: box.min.y - 1 },
      uBand: { value: spec.band / scale },
      uPhaseColor: { value: this.bandColor },
      uScan: { value: this.time },
      uScanFreq: { value: (Math.PI * 2) / SCAN_STEP },
      uShell: { value: 0 },
      uGrid: { value: 0.1 },
    };
    const job = {
      object, dir, duration, t: 0, fraction, start: fraction, box, uniforms, spec, inHand, silent, height, area,
      swaps: [], clones: new Map(), pops: [], shells: [], shellMaterial: null, ring: null, sparks: null, sparkUniforms: null,
      resolve: null, promise: null, worldScale: scale, frames: 0, motes: 0, moteDebt: 0, lastBurst: -1, seed: (object.id * 2654435761) >>> 0,
      topAt: null, light: false,
    };
    job.promise = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this._bind(job);

    // Ground ring: only parts with a real footprint, only on the way in (bible: a mug gets no ring; phase-out has none).
    if (spec.ring && dir > 0) {
      job.ring = new THREE.Mesh(this.geo.flat, decalMaterial("ring", { uColor: { value: this.bandColor }, uAlpha: { value: 0 }, uTime: { value: 0 }, uProgress: { value: 0 } }));
      job.ring.renderOrder = 2;
    }
    // Rising sparkles: only without a particle system (then the motes are dot3d shimmer bursts on the seam).
    if (!this.particles) {
      job.sparkUniforms = { uCenter: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector3(1, 1, 1) }, uLife: { value: 0 }, uTime: { value: 0 } };
      job.sparks = new THREE.Points(this.geo.sparks, sparkMaterial(this.bandColor, "rise", job.sparkUniforms));
    }
    for (const helper of [job.ring, job.sparks]) {
      if (!helper) continue;
      helper.userData.phaseHelper = true;
      helper.frustumCulled = false;
      helper.raycast = noRaycast;
      this.group.add(helper);
    }
    // Seam light: the newest reveal drives it; off when the tier's point-light cap is already full.
    let lit = true;
    try {
      lit = this.activeLights() < this.lightCap;
    } catch {
      lit = true;
    }
    job.light = lit;
    this.lightJob = job;
    this.light.visible = lit;
    this.light.intensity = 0;

    this.jobs.set(object, job);
    this._step(job, 0);
    return job.promise;
  }

  // Swaps every patchable material under the job's object for a patched clone and attaches the hologram shells.
  _bind(job) {
    const { object, uniforms } = job;
    this.prepare?.(object); // originals first: a clone's program key is derived from its original's
    const cloneOf = (material, mesh) => {
      let clone = job.clones.get(material);
      if (!clone) {
        clone = material.clone();
        clone.userData = { phaseClone: true, key: variantKey("solid", material, mesh) };
        // Closures capture only what they need, so kept-alive clones do not pin the original.
        const before = material.onBeforeCompile;
        const programKey = `phase:${material.type}:${material.customProgramCacheKey()}`;
        clone.onBeforeCompile = (shader, renderer) => {
          before.call(clone, shader, renderer);
          Object.assign(shader.uniforms, uniforms);
          patchSolid(shader);
        };
        clone.customProgramCacheKey = () => programKey;
        job.clones.set(material, clone);
      }
      return clone;
    };
    object.traverse((child) => {
      if (child.userData?.phaseHelper) return;
      if (!child.isMesh && !child.isPoints && !child.isLine && !child.isSprite) return;
      const list = Array.isArray(child.material) ? child.material : [child.material];
      if (child.isMesh && list.every(canPatch)) {
        const original = child.material;
        const clone = Array.isArray(original) ? original.map((m) => cloneOf(m, child)) : cloneOf(original, child);
        child.material = clone;
        job.swaps.push({ mesh: child, original, clone });
        if (!child.isSkinnedMesh) this._addShell(job, child);
      } else {
        // Unpatchable (custom shaders, points, sprites): simply appear when the reveal passes them.
        const own = localBox(child, this._tmp.box);
        const offset = this._tmp.v.setFromMatrixPosition(child.matrixWorld);
        object.worldToLocal(offset);
        job.pops.push({ object: child, y: own.isEmpty() ? offset.y : offset.y + own.min.y, visible: child.visible });
      }
    });
    this.prepare?.(object); // then the clones, so their key is final before the first draw
  }

  // Restores the original materials and removes the shells; retires the clones (their programs stay cached).
  _unbind(job) {
    for (const { mesh, original, clone } of job.swaps) {
      if (mesh.material === clone) mesh.material = original;
      else if (Array.isArray(mesh.material) && Array.isArray(clone)) {
        mesh.material = mesh.material.map((m, i) => (m === clone[i] ? original[i] : m));
      }
    }
    for (const pop of job.pops) pop.object.visible = pop.visible;
    for (const shell of job.shells) shell.removeFromParent();
    for (const [original, clone] of job.clones) this._retire(clone, clone.userData.key || variantKey("solid", original));
    if (job.shellMaterial) this._retire(job.shellMaterial, "shell");
    job.swaps = [];
    job.pops = [];
    job.shells = [];
    job.clones = new Map();
    job.shellMaterial = null;
  }

  _addShell(job, mesh) {
    let material = job.shellMaterial;
    if (!material) {
      material = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, depthWrite: false, toneMapped: false, fog: false });
      const uniforms = job.uniforms;
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        patchShell(shader);
      };
      material.customProgramCacheKey = () => "phase-shell";
      material.userData = { phaseClone: true };
      job.shellMaterial = material;
    }
    let shell;
    if (mesh.isInstancedMesh) {
      shell = new THREE.InstancedMesh(mesh.geometry, material, mesh.count);
      shell.instanceMatrix = mesh.instanceMatrix;
      shell.count = mesh.count;
    } else {
      shell = new THREE.Mesh(mesh.geometry, material);
    }
    shell.userData.phaseHelper = true;
    shell.raycast = noRaycast;
    shell.frustumCulled = mesh.frustumCulled;
    shell.renderOrder = 1;
    mesh.add(shell);
    job.shells.push(shell);
  }

  _step(job, dt) {
    job.t += dt;
    if (dt > 0) job.frames++;
    const k = clamp01(job.t / job.duration);
    const { object, box, uniforms, spec } = job;
    object.updateWorldMatrix(true, false);
    uniforms.uPhaseInv.value.copy(object.matrixWorld).invert();
    object.matrixWorld.decompose(this._tmp.v, this._tmp.q, this._tmp.s);
    const scale = Math.max(1e-4, (Math.abs(this._tmp.s.x) + Math.abs(this._tmp.s.y) + Math.abs(this._tmp.s.z)) / 3);
    job.worldScale = scale;
    const band = spec.band / scale;
    const lo = box.min.y - 0.02 / scale;
    const hi = box.max.y + band * 1.2;
    if (job.dir > 0) job.fraction = job.start + (1 - job.start) * easeOut(k);
    else job.fraction = job.start * (1 - easeIn(k));
    const reveal = lo + (hi - lo) * job.fraction;
    uniforms.uReveal.value = reveal;
    uniforms.uBand.value = band;
    uniforms.uScan.value = this.time;
    uniforms.uScanFreq.value = (Math.PI * 2 * scale) / SCAN_STEP;
    const height = Math.max(0.05, (box.max.y - box.min.y) * scale);
    uniforms.uGrid.value = Math.min(0.5, Math.max(0.05, height / 14)) / scale;
    uniforms.uShell.value = job.dir > 0 ? smooth(0, 0.08, k) * (1 - smooth(0.7, 1, k)) * 0.9 : (1 - k) * 0.7;
    for (const pop of job.pops) pop.object.visible = pop.visible && reveal >= pop.y;

    // World-space helpers follow the object's current bottom center; the seam light and motes ride the reveal height.
    const center = this._tmp.v.set((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2).applyMatrix4(object.matrixWorld);
    const footprint = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * scale;
    const seamY = clamp(reveal, box.min.y, box.max.y);
    const seam = this._tmp.v2.set((box.min.x + box.max.x) / 2, seamY, (box.min.z + box.max.z) / 2).applyMatrix4(object.matrixWorld);
    if (job.ring) {
      // Footprint plus 0.2 m all round, one 0.35 s pulse at opacity 0.6.
      const rt = clamp01(job.t / RING_PULSE);
      job.ring.position.set(center.x, center.y + 0.02, center.z);
      job.ring.scale.setScalar(footprint + 0.4);
      const ringU = job.ring.material.uniforms;
      ringU.uProgress.value = rt;
      ringU.uAlpha.value = smooth(0, 0.15, rt) * (1 - smooth(0.5, 1, rt)) * 0.6;
      ringU.uTime.value = this.time;
      job.ring.visible = rt < 1;
    }
    if (job.sparks) {
      const ringK = job.dir > 0 ? k : 1 - k;
      const sparkU = job.sparkUniforms;
      sparkU.uCenter.value.copy(center);
      sparkU.uSize.value.set(Math.max(0.25, (box.max.x - box.min.x) * scale), height, Math.max(0.25, (box.max.z - box.min.z) * scale));
      sparkU.uLife.value = job.dir > 0 ? smooth(0, 0.1, k) * (1 - smooth(0.75, 1, k)) : (1 - k) * Math.min(1, ringK * 4 + 0.3);
      sparkU.uTime.value = this.time;
    }
    if (this.lightJob === job && job.light) {
      const envelope = job.dir > 0 ? smooth(0, 0.08, k) * (1 - smooth(0.85, 1, k)) : 1 - k;
      this.light.position.copy(seam);
      this.light.intensity = spec.lightIntensity * envelope;
      this.light.distance = spec.lightDistance;
    }
    if (this.particles && spec.motes > 0 && (dt > 0 || k >= 1)) this._motes(job, dt, seamY, k >= 1);
    // Tall parts settle: a dust puff at the base 0.3 s after the seam clears the top.
    if (job.dir > 0 && spec.dust > 0 && job.topAt === null && reveal >= box.max.y) {
      job.topAt = this.time;
      this.settles.push({ at: this.time + SETTLE_DELAY, point: center.clone(), radius: footprint / 2, count: spec.dust });
    }
    if (k >= 1) this._finish(job);
  }

  // Shimmer motes on the seam: the total over the effect is spec.motes, released in bursts at most every 50 ms,
  // each mote on the footprint's perimeter at the reveal height (a villa shows a rising rectangle of light, a mug a
  // pinch of sparks). Motes rise on the way in and are thrown downward on the way out.
  _motes(job, dt, seamY, flush = false) {
    job.moteDebt += (job.spec.motes / job.duration) * Math.min(dt, Math.max(0, job.duration - (job.t - dt)));
    if (!flush && job.lastBurst >= 0 && this.time - job.lastBurst < MOTE_INTERVAL) return;
    const n = Math.min(48, flush ? Math.round(job.moteDebt) : Math.floor(job.moteDebt)); // the last frame releases what is owed
    if (n <= 0) return;
    job.lastBurst = this.time;
    job.moteDebt -= n;
    const { box, object } = job;
    const w = box.max.x - box.min.x;
    const d = box.max.z - box.min.z;
    const perimeter = 2 * (w + d) || 1;
    const normal = job.dir > 0 ? UP : DOWN;
    const p = this._tmp.p;
    for (let i = 0; i < n; i++) {
      job.seed = (Math.imul(job.seed, 1664525) + 1013904223) >>> 0;
      const u = (job.seed / 4294967296) * perimeter;
      if (u < w) p.set(box.min.x + u, seamY, box.min.z);
      else if (u < w + d) p.set(box.max.x, seamY, box.min.z + (u - w));
      else if (u < 2 * w + d) p.set(box.max.x - (u - w - d), seamY, box.max.z);
      else p.set(box.min.x, seamY, box.max.z - (u - 2 * w - d));
      p.applyMatrix4(object.matrixWorld);
      job.motes += this.particles.burst("shimmer", { point: { x: p.x, y: p.y, z: p.z }, normal, impulse: 1, scale: 1 / MOTES_PER_UNIT_SCALE, radius: 0.015, tint: MOTE_TINT });
    }
  }

  // Restores original materials, removes helpers, logs the reveal and resolves the promise.
  _finish(job) {
    if (!this.jobs.has(job.object)) return;
    this.jobs.delete(job.object);
    this._unbind(job);
    for (const helper of [job.ring, job.sparks]) {
      if (!helper) continue;
      helper.removeFromParent();
      this._retire(helper.material, helper.material.name || helper.material.type + (helper.isPoints ? "-rise" : ""));
    }
    if (this.lightJob === job) {
      this.light.intensity = 0;
      this.lightJob = null;
      for (const other of this.jobs.values()) if (other.light) this.lightJob = other;
    }
    if (!job.silent) {
      this.log.push({
        name: job.object.name || "", dir: job.dir, inHand: job.inHand, height: +job.height.toFixed(3), area: +job.area.toFixed(3),
        duration: +job.duration.toFixed(4), seconds: +job.t.toFixed(4), frames: job.frames, motes: job.motes, plannedMotes: job.spec.motes,
        band: job.spec.band, ring: !!job.ring, dust: job.spec.dust, light: job.light, lightIntensity: job.light ? job.spec.lightIntensity : 0,
      });
      if (this.log.length > 50) this.log.shift();
    }
    job.resolve();
  }

  // Keeps the first material of each variant alive (its GPU program stays cached); disposes the rest.
  // With the renderer known, the variant is the compiled program itself and never-drawn materials
  // (nothing compiled) are not kept, so they cannot block a real keeper.
  _retire(material, key) {
    const props = this.renderer?.properties;
    if (props) {
      const program = props.get(material).currentProgram;
      if (!program) {
        material.dispose();
        return;
      }
      key = program.cacheKey;
    }
    if (!this.keepers.has(key)) {
      stripTextures(material);
      this.keepers.set(key, material);
    } else if (this.keepers.get(key) !== material) {
      material.dispose();
    }
  }

  summon(position, radius = 1) {
    const uniforms = { uColor: { value: this.color }, uAlpha: { value: 0 }, uTime: { value: this.time }, uProgress: { value: 0 } };
    const rune = new THREE.Mesh(this.geo.flat, decalMaterial("rune", uniforms));
    const column = new THREE.Mesh(this.geo.column, decalMaterial("column", uniforms));
    const group = new THREE.Group();
    group.name = "phase-summon";
    group.add(rune, column);
    rune.renderOrder = 2;
    column.renderOrder = 3;
    for (const object of [group, rune, column]) {
      object.userData.phaseHelper = true;
      object.raycast = noRaycast;
      object.frustumCulled = false;
    }
    const state = { group, rune, column, uniforms, alpha: 0, target: 1, fade: 0.25, radius: 1, key: `summon:${++this.summonCount}` };
    const apply = () => {
      rune.scale.set(state.radius * 2, 1, state.radius * 2);
      column.scale.set(state.radius * 0.55, 2.4, state.radius * 0.55);
    };
    group.position.copy(position);
    group.position.y += 0.02;
    state.radius = Math.max(0.2, radius);
    apply();
    this.group.add(group);
    this.summons.add(state);
    return {
      setPosition: (v) => {
        group.position.set(v.x, v.y + 0.02, v.z);
      },
      setRadius: (r) => {
        state.radius = Math.max(0.2, r);
        apply();
      },
      stop: () => {
        state.target = 0;
        state.fade = 0.3;
      },
    };
  }

  _takeBurst() {
    let burst = this.freeBursts.pop();
    if (!burst) {
      const uniforms = { uCenter: { value: new THREE.Vector3() }, uSize: { value: new THREE.Vector3() }, uLife: { value: 0 }, uTime: { value: 0 } };
      const points = new THREE.Points(this.geo.burst, sparkMaterial(this.color, "burst", uniforms));
      points.userData.phaseHelper = true;
      points.frustumCulled = false;
      points.raycast = noRaycast;
      burst = { points, uniforms, t: 0, life: 0.6 };
    }
    return burst;
  }

  burst(position, radius = 0.5) {
    const burst = this._takeBurst();
    burst.t = 0;
    burst.life = 0.45 + Math.min(0.4, radius * 0.3);
    burst.uniforms.uCenter.value.copy(position);
    burst.uniforms.uSize.value.set(Math.max(0.1, radius), 0, 0);
    burst.uniforms.uLife.value = 0;
    this.group.add(burst.points);
    this.bursts.push(burst);
    return burst;
  }

  update(dt) {
    this.time += dt;
    for (const job of this.jobs.values()) this._step(job, dt); // finishing deletes the current entry: safe
    for (let i = this.settles.length - 1; i >= 0; i--) {
      const settle = this.settles[i];
      if (this.time < settle.at) continue;
      this.settles.splice(i, 1);
      this.particles?.burst("dust", { point: settle.point, normal: UP, impulse: 1, scale: settle.count / DUST_PER_UNIT_SCALE, radius: settle.radius, tint: this.groundTint(settle.point) });
    }
    for (const state of this.summons) {
      const speed = dt / state.fade;
      state.alpha = state.target > state.alpha ? Math.min(state.target, state.alpha + speed) : Math.max(state.target, state.alpha - speed);
      state.uniforms.uAlpha.value = state.alpha;
      state.uniforms.uTime.value = this.time;
      const pos = state.group.position;
      setClearing(this.scene, state.key, pos.x, pos.z, state.radius * 1.05, state.alpha);
      if (state.target === 0 && state.alpha <= 0) {
        removeClearing(this.scene, state.key);
        state.group.removeFromParent();
        this._retire(state.rune.material, "rune");
        this._retire(state.column.material, "column");
        this.summons.delete(state);
      }
    }
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const burst = this.bursts[i];
      burst.t += dt;
      burst.uniforms.uLife.value = clamp01(burst.t / burst.life);
      if (burst.t >= burst.life) {
        burst.points.removeFromParent();
        this.bursts.splice(i, 1);
        if (this.freeBursts.length < 12) this.freeBursts.push(burst);
        else burst.points.material.dispose();
      }
    }
  }

  // Warms the GPU programs used by the effect (and the common plain part materials) so the first
  // summon on Quest does not hitch. Call after the Field exists (its lights and fog are part of
  // every lit program). The materials compiled here are kept alive, so the programs stay cached.
  precompile(renderer, camera) {
    if (!renderer?.compile || !camera) return Promise.resolve();
    this.renderer = renderer; // from now on _retire keys keepers by the compiled program
    const stage = new THREE.Scene();
    const geometry = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    texture.needsUpdate = true;
    const variants = [
      new THREE.MeshStandardMaterial(),
      new THREE.MeshStandardMaterial({ side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ map: texture }),
      new THREE.MeshStandardMaterial({ map: texture, normalMap: texture, roughnessMap: texture }), // the dot3d recipe materials
      new THREE.MeshStandardMaterial({ map: texture, normalMap: texture, roughnessMap: texture, side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ map: texture, transparent: true }),
      new THREE.MeshStandardMaterial({ transparent: true, depthWrite: false }),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
      new THREE.MeshLambertMaterial(),
    ];
    const root = new THREE.Group();
    variants.forEach((material, i) => {
      root.add(new THREE.Mesh(geometry, material));
      const key = `plain:${i}`;
      if (!this.keepers.has(key)) this.keepers.set(key, material.clone());
      stage.add(new THREE.Mesh(geometry, this.keepers.get(key)));
    });
    stage.add(root);
    this._start(root, 1, 1, { silent: true }); // throwaway job: creates every patched material and helper
    const job = this.jobs.get(root);
    if (job) for (const helper of [job.ring, job.sparks]) if (helper) stage.add(helper);
    for (const kind of ["ring", "rune", "column"]) {
      if (!this.keepers.has(kind)) this.keepers.set(kind, decalMaterial(kind, { uColor: { value: kind === "ring" ? this.bandColor : this.color }, uAlpha: { value: 0 }, uTime: { value: 0 }, uProgress: { value: 0 } }));
      stage.add(new THREE.Mesh(kind === "column" ? this.geo.column : this.geo.flat, this.keepers.get(kind)));
    }
    const burst = this._takeBurst();
    stage.add(burst.points);
    this.prepare?.(stage); // the stand-ins get the scene's per-material patch, as the real parts have
    try {
      renderer.compile(stage, camera, this.scene);
    } catch (err) {
      console.warn("[phase] precompile failed", err);
    }
    if (job) this._finish(job);
    // The warmed plain/rune/column keepers are keyed by their compiled program too, so _retire finds them.
    const props = renderer.properties;
    for (const [key, material] of props ? [...this.keepers] : []) {
      const program = props.get(material).currentProgram;
      if (!program || key === program.cacheKey) continue;
      this.keepers.delete(key);
      if (this.keepers.has(program.cacheKey)) material.dispose();
      else this.keepers.set(program.cacheKey, material);
    }
    burst.points.removeFromParent();
    this.freeBursts.push(burst);
    stage.clear();
    for (const material of variants) material.dispose();
    for (const material of this.keepers.values()) stripTextures(material);
    geometry.dispose();
    texture.dispose();
    return Promise.resolve();
  }

  dispose() {
    for (const job of [...this.jobs.values()]) this._finish(job);
    for (const state of this.summons) {
      removeClearing(this.scene, state.key);
      state.group.removeFromParent();
      state.rune.material.dispose();
      state.column.material.dispose();
    }
    this.summons.clear();
    for (const burst of [...this.bursts, ...this.freeBursts]) {
      burst.points.removeFromParent();
      burst.points.material.dispose();
    }
    this.bursts = [];
    this.freeBursts = [];
    this.settles = [];
    this.lightJob = null;
    for (const material of this.keepers.values()) material.dispose();
    this.keepers.clear();
    for (const geometry of Object.values(this.geo)) geometry.dispose();
    this.group.removeFromParent();
    this.light.removeFromParent();
  }
}

// ---------- first-use warm-up ----------

// Compiles the programs that would otherwise link in the frame that first draws them. compile()
// visits invisible objects too, so one pass over `scene` covers the hidden HUD, controller models,
// lasers, night stars and the teleport arc. `extras` are materials (or detached objects) not in the
// scene yet, such as the marker ink and halo. A material is compiled with the scene's lights and fog
// on two stand-in meshes, with normals (built parts, finished drawings) and without (procedural
// strokes such as the live marker pen), or on a sprite for a SpriteMaterial. The materials must stay
// alive afterwards (shared ones do), or three releases their programs again. Call once at start,
// after precompile().
export function warmUp(renderer, scene, camera, extras = []) {
  if (!renderer?.compile || !scene || !camera) return;
  const lit = new THREE.PlaneGeometry(0.01, 0.01);
  const bare = new THREE.BufferGeometry().setAttribute("position", lit.attributes.position);
  const stage = new THREE.Scene();
  try {
    renderer.compile(scene, camera);
    for (const item of extras) {
      if (item?.isSpriteMaterial) stage.add(new THREE.Sprite(item));
      else if (item?.isMaterial) stage.add(new THREE.Mesh(lit, item), new THREE.Mesh(bare, item));
      else if (item?.isObject3D) renderer.compile(item, camera, scene);
    }
    if (stage.children.length) renderer.compile(stage, camera, scene);
  } catch (err) {
    console.warn("[phase] warm-up failed", err);
  }
  stage.clear();
  lit.dispose();
  bare.dispose();
}
