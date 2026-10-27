// The endless grassy field: ground, wind-blown grass and flowers that wrap around the player,
// sky dome with sun/moon/stars, distant hills and trees, fog, lights and time of day.
// Everything heavy runs on the GPU; per frame the CPU only updates a few uniforms.
import * as THREE from "../../vendor/three.module.min.js";
import { rng } from "../util/ids.js";
import { makeEnvironmentScene, revisionOf } from "../dot3d/look.js";
import { tierBudget } from "../dot3d/tiers.js";
import { LocalLights, createDawnMist } from "./local-lights.js";

const DEG = Math.PI / 180;
const GROUND_SIZE = 4000;
const SKY_RADIUS = 1500;
const TRANSITION = 3;
const noRaycast = () => {};

const QUALITY = {
  high: { blades: 60000, patch: 36, flowers: 3200, clumps: 26000, clumpPatch: 110 },
  low: { blades: 20000, patch: 24, flowers: 1400, clumps: 9000, clumpPatch: 72 },
};

// az: degrees clockwise from -Z (straight ahead at spawn), el: degrees above the horizon.
// Horizon doubles as the fog color so the ground melts into the sky.
// envI: the preset's environment-map strength on lit parts; exposure: the tone-mapping exposure (LOOK-BIBLE.md section 6).
// De-cartoon grade (Oct 26, Connor's verdict, LOOK-BIBLE.md section 3a): the sky and haze lose their crayon saturation,
// the hemisphere fill and environment light drop to about half so the sun's shadows actually read, the sun comes up a
// little to keep the lit side where it was. Directions, fog distances and the night preset's structure are unchanged.
const PRESETS = {
  day: {
    fogColor: "#cfd8dd", mist: 0,
    zenith: "#4d7fb8", horizon: "#cfd8dd", below: "#6e7a50",
    // Three-quarter front light (az 60, el 40): the old az 140 lit the yard from behind the player, so every shadow fell
    // behind its object and the whole field read flat. Now each part has a lit side, a shaded side and a shadow you see.
    sun: { az: 60, el: 40 }, sunColor: "#fff0d8", sunI: 3.3, sunVis: 1, glow: 0.45,
    hemiSky: "#c4d3e2", hemiGround: "#4c5730", hemiI: 0.55,
    fogNear: 60, fogFar: 1900, stars: 0, moon: 0, envI: 0.55, exposure: 0.95,
  },
  sunset: {
    fogColor: "#dca27a", mist: 0,
    zenith: "#3d5a8a", horizon: "#e6b48a", below: "#7d6f4f",
    sun: { az: 28, el: 5 }, sunColor: "#ffb36b", sunI: 2.5, sunVis: 1, glow: 1.1,
    hemiSky: "#9aa4c6", hemiGround: "#5a4c28", hemiI: 0.5,
    fogNear: 50, fogFar: 1700, stars: 0.05, moon: 0, envI: 0.5, exposure: 0.9,
  },
  night: {
    fogColor: "#1b2a4b", mist: 0,
    zenith: "#050b1e", horizon: "#1b2a4b", below: "#16223a",
    sun: { az: -24, el: 32 }, sunColor: "#a9c1ff", sunI: 0.5, sunVis: 0, glow: 0.12,
    hemiSky: "#4a68a8", hemiGround: "#22342b", hemiI: 0.45,
    fogNear: 30, fogFar: 1300, stars: 1, moon: 1, envI: 0.3, exposure: 1.15,
  },
  dawn: {
    fogColor: "#d3aab4", mist: 0.03,
    zenith: "#4b5189", horizon: "#e6afbc", below: "#746c7c",
    sun: { az: -38, el: 7 }, sunColor: "#ffc6c0", sunI: 2.2, sunVis: 1, glow: 0.9,
    hemiSky: "#aba2cf", hemiGround: "#524f33", hemiI: 0.5,
    fogNear: 50, fogFar: 1700, stars: 0.12, moon: 0, envI: 0.45, exposure: 0.95,
  },
};

const COLOR_KEYS = ["zenith", "horizon", "below", "sunColor", "hemiSky", "hemiGround", "fogColor"];
const SCALAR_KEYS = ["sunI", "sunVis", "glow", "hemiI", "fogNear", "fogFar", "stars", "moon", "envI", "exposure", "mist"];

function sunVector(az, el, out = new THREE.Vector3()) {
  return out.set(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), -Math.cos(az * DEG) * Math.cos(el * DEG)).normalize();
}

// Mutable time-of-day state (interpolated between presets).
function makeState() {
  return {
    zenith: new THREE.Color(), horizon: new THREE.Color(), below: new THREE.Color(),
    sunDir: new THREE.Vector3(0, 1, 0), sunColor: new THREE.Color(), sunI: 1, sunVis: 1, glow: 1,
    hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), fogColor: new THREE.Color(), mist: 0, hemiI: 1,
    fogNear: 50, fogFar: 1800, stars: 0, moon: 0, envI: 1, exposure: 1,
  };
}

function stateFromPreset(preset, out = makeState()) {
  for (const key of COLOR_KEYS) out[key].set(preset[key]);
  sunVector(preset.sun.az, preset.sun.el, out.sunDir);
  for (const key of SCALAR_KEYS) out[key] = preset[key];
  return out;
}

function copyState(from, out) {
  for (const key of COLOR_KEYS) out[key].copy(from[key]);
  out.sunDir.copy(from.sunDir);
  for (const key of SCALAR_KEYS) out[key] = from[key];
  return out;
}

function lerpState(a, b, k, out) {
  for (const key of COLOR_KEYS) out[key].copy(a[key]).lerp(b[key], k);
  out.sunDir.copy(a.sunDir).lerp(b.sunDir, k);
  if (out.sunDir.lengthSq() < 1e-6) out.sunDir.copy(b.sunDir);
  out.sunDir.normalize();
  for (const key of SCALAR_KEYS) out[key] = a[key] + (b[key] - a[key]) * k;
  return out;
}

// Shadow box per tier (LOOK-BIBLE.md section 10): map size from the tier budget, radius in metres around the player.
const SHADOW_RADIUS = { quest: 14, tablet: 14, laptop: 22 };

// Four environment maps, one per preset, baked through PMREM from the field's own sky colors (no HDR download, no hue
// drift): dome gradient zenith/horizon/below plus the sun as a hot spot, so metals and glazes get real reflections.
function bakeEnvironments(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const maps = {};
  for (const [name, p] of Object.entries(PRESETS)) {
    const sun = new THREE.Color(p.sunColor).multiplyScalar(p.sunVis ? 1 : 0.2);
    const envScene = makeEnvironmentScene(THREE, { sky: p.zenith, horizon: p.horizon, ground: p.below, sun, sunDir: sunVector(p.sun.az, p.sun.el).toArray(), panels: false });
    maps[name] = pmrem.fromScene(envScene, 0.04);
    envScene.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }
  pmrem.dispose();
  return maps;
}

const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

// ---------- shared GLSL ----------

// Wraps a world xz position into the patch centered on the player (endless tiling, no CPU work).
const WRAP_GLSL = /* glsl */ `
vec2 wrapAround(vec2 base, vec2 center, float period) {
  vec2 rel = base - center;
  rel -= period * floor(rel / period + 0.5);
  return rel;
}`;

// Wind displacement for a point at world xz, height fraction h (0 root, 1 tip) of a stalk `len` tall.
const WIND_GLSL = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWind;
vec3 windOffset(vec2 wp, float h, float len, float seed, out float gust) {
  float wave = dot(wp, uWindDir) * 0.22 - uTime * 1.35;
  gust = sin(wave) * 0.5 + 0.5;
  gust = gust * gust * (0.6 + 0.4 * sin(wave * 0.37 + 1.7));
  float sway = sin(uTime * 2.3 + wp.x * 0.83 + wp.y * 0.61 + seed * 6.2831) * 0.6
             + sin(uTime * 3.9 + wp.x * 2.1 - wp.y * 1.7 + seed * 3.1) * 0.25;
  float bend = (uWind * (0.25 + 0.95 * gust) + sway * 0.18) * h * h * len;
  vec2 side = vec2(-uWindDir.y, uWindDir.x) * sway * 0.12 * h * h * len;
  vec2 d = uWindDir * bend + side;
  float drop = dot(d, d) / max(len, 0.05) * 0.5;
  return vec3(d.x, -drop, d.y);
}`;

// Grass/flower lighting: same units as three's Lambert (BRDF / PI) so it matches lit objects.
const LIGHT_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHemiSky;
uniform vec3 uHemiGround;
// Split so the fragment can shade the sun's share by the key-light shadow map and leave the sky's share alone.
void fieldLightSplit(vec3 albedo, vec3 n, float occlusion, float translucency, vec3 viewDir, out vec3 ambient, out vec3 direct) {
  float hemiK = n.y * 0.5 + 0.5;
  ambient = albedo * mix(uHemiGround, uHemiSky, hemiK) * occlusion * 0.3183099;
  float ndl = max(dot(n, uSunDir), 0.0);
  float back = pow(max(dot(viewDir, -uSunDir), 0.0), 4.0) * translucency;
  direct = albedo * uSunColor * (ndl * (0.55 + 0.45 * occlusion) + back * 0.9) * 0.3183099;
}
vec3 fieldLight(vec3 albedo, vec3 n, float occlusion, float translucency, vec3 viewDir) {
  vec3 ambient, direct;
  fieldLightSplit(albedo, n, occlusion, translucency, viewDir, ambient, direct);
  return ambient + direct;
}`;

const FOG_UNIFORMS = () => THREE.UniformsUtils.clone(THREE.UniformsLib.fog);

// Shadow receive for the field's own shaders (grass, clumps, flowers): three's shadow-map chunks, driven by the field sun.
// The blade geometry has no normal attribute, so the chunk's normal bias is zero; the sun's bias handles the rest.
const SHADOW_VERTEX_PARS = /* glsl */ `
  #ifdef FIELD_SHADOWS
    #include <shadowmap_pars_vertex>
  #endif`;
const SHADOW_VERTEX = /* glsl */ `
  #ifdef FIELD_SHADOWS
    vec4 worldPosition = vec4(world, 1.0);
    #include <shadowmap_vertex>
  #endif`;
const SHADOW_FRAGMENT_PARS = /* glsl */ `
  #include <packing>
  #ifdef FIELD_SHADOWS
    uniform bool receiveShadow; // the renderer uploads it per object; built-in materials get the declaration from lights_pars_begin
    #include <shadowmap_pars_fragment>
    #include <shadowmask_pars_fragment>
  #endif`;
const SHADOW_FRAGMENT = /* glsl */ `
  float shade = 1.0;
  #ifdef FIELD_SHADOWS
    shade = getShadowMask();
  #endif`;
const shadowUniforms = (on) => (on ? THREE.UniformsUtils.clone(THREE.UniformsLib.lights) : {});

// ---------- clearings: grass and flowers flatten and lean away under objects ----------
// Other modules register circles on scene.userData (no direct reference to the Field needed);
// the Field sends the MAX_CLEARINGS nearest to the player to the GPU every frame.
const MAX_CLEARINGS = 12;
const CLEARINGS_KEY = "fieldClearings";

// strength presses the grass flat (0..1). bare (0..1, step 12) also strips the pressed stubs away inside 0.85 of the
// radius, fading out at the radius, so trodden dirt (the Kingdom plaza) shows the ground instead of a green stubble.
export function setClearing(scene, key, x, z, radius, strength = 1, bare = 0) {
  if (!scene) return;
  let map = scene.userData[CLEARINGS_KEY];
  if (!map) map = scene.userData[CLEARINGS_KEY] = new Map();
  let c = map.get(key);
  if (!c) map.set(key, (c = { x: 0, z: 0, r: 0, k: 0, b: 0 }));
  c.x = x;
  c.z = z;
  c.r = radius;
  c.k = strength;
  c.b = bare;
}

export function removeClearing(scene, key) {
  scene?.userData[CLEARINGS_KEY]?.delete(key);
}

const CLEARING_GLSL = /* glsl */ `
uniform vec4 uClear[${MAX_CLEARINGS}];
uniform float uClearBare[${MAX_CLEARINGS}];
// How bare the ground is at wp (0..1): full inside 0.85 of a bare clearing's radius, gone at the radius.
float clearingBare(vec2 wp) {
  float bare = 0.0;
  for (int i = 0; i < ${MAX_CLEARINGS}; i++) {
    vec4 c = uClear[i];
    if (c.w <= 0.0 || uClearBare[i] <= 0.0) continue;
    float dist = length(wp - c.xy);
    bare = max(bare, uClearBare[i] * (1.0 - smoothstep(c.z * 0.85, c.z, dist)));
  }
  return bare;
}
// Returns press strength (0..1); writes the push-away direction.
float clearing(vec2 wp, out vec2 away) {
  float press = 0.0;
  away = vec2(0.0);
  for (int i = 0; i < ${MAX_CLEARINGS}; i++) {
    vec4 c = uClear[i];
    if (c.w <= 0.0) continue;
    vec2 d = wp - c.xy;
    float dist = length(d);
    float k = (1.0 - smoothstep(c.z * 0.7, c.z + 0.35, dist)) * c.w;
    if (k > press) {
      press = k;
      away = d / max(dist, 1e-3);
    }
  }
  return press;
}`;

// ---------- grass ----------

function bladeGeometry() {
  // 7 vertices, 5 triangles; x across the blade (-0.5..0.5), y along it (0..1).
  const rows = [[0, 1], [0.38, 0.86], [0.72, 0.58]];
  const pos = [];
  for (const [y, w] of rows) pos.push(-0.5 * w, y, 0, 0.5 * w, y, 0);
  pos.push(0, 1, 0);
  const index = [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6];
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setIndex(index);
  return geometry;
}

function grassMaterial(uniforms, { clumps = false, shadows = false } = {}) {
  const defines = clumps ? { CLUMPS: 1 } : {};
  if (shadows) defines.FIELD_SHADOWS = 1;
  return new THREE.ShaderMaterial({
    name: clumps ? "field-clumps" : "field-grass",
    uniforms: { ...uniforms, ...shadowUniforms(shadows) },
    defines,
    lights: shadows,
    side: THREE.DoubleSide,
    fog: true,
    vertexShader: /* glsl */ `
      attribute vec4 aBlade; // x, z, yaw, height
      attribute vec4 aShape; // width, curl, dryness, seed
      uniform vec3 uPlayer;
      uniform float uPatch;
      uniform float uFadeStart;
      uniform float uInner;
      uniform vec3 uRoot;
      uniform vec3 uTip;
      uniform vec3 uDry;
      varying vec3 vAmbient;
      varying vec3 vDirect;
      ${WRAP_GLSL}
      ${WIND_GLSL}
      ${LIGHT_GLSL}
      ${CLEARING_GLSL}
      #include <fog_pars_vertex>
      ${SHADOW_VERTEX_PARS}
      void main() {
        vec2 rel = wrapAround(aBlade.xy, uPlayer.xz, uPatch);
        float d = length(rel) / (uPatch * 0.5);
        float fade = 1.0 - smoothstep(uFadeStart, 1.0, d);
        #ifdef CLUMPS
          fade *= smoothstep(uInner, uInner + 0.12, d);
        #endif
        vec2 wp = uPlayer.xz + rel;
        float h = position.y;
        vec2 away;
        float press = clearing(wp, away);
        float len = aBlade.w * fade * (1.0 - 0.82 * press) * (1.0 - 0.92 * clearingBare(wp));
        float width = aShape.x * (0.35 + 0.65 * fade);
        float c = cos(aBlade.z);
        float s = sin(aBlade.z);
        vec3 local = vec3(position.x * width, h * len, aShape.y * h * h * len);
        vec3 p = vec3(local.x * c + local.z * s, local.y, -local.x * s + local.z * c);
        float gust;
        p += windOffset(wp, h, len, aShape.w, gust) * (1.0 - press);
        p.xz += away * press * h * h * aBlade.w * 0.9;
        vec3 world = vec3(wp.x + p.x, p.y, wp.y + p.z);
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;

        vec3 tip = mix(uTip, uDry, aShape.z);
        vec3 albedo = mix(uRoot, tip, smoothstep(0.0, 1.0, h)) * (0.85 + 0.3 * aShape.w);
        albedo *= 1.0 + gust * 0.12 * h;
        vec3 bladeN = vec3(s, 0.0, c);
        bladeN *= sign(dot(bladeN.xz, uSunDir.xz) + 1e-4); // both faces lit like the sunny side (same for both eyes)
        vec3 n = normalize(mix(bladeN, vec3(0.0, 1.0, 0.0), 0.62));
        vec3 viewDir = normalize(world - cameraPosition);
        float occlusion = mix(0.32, 1.0, h);
        fieldLightSplit(albedo, n, occlusion, h * 0.6, viewDir, vAmbient, vDirect);
        #include <fog_vertex>
        ${SHADOW_VERTEX}
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vAmbient;
      varying vec3 vDirect;
      #include <common>
      #include <fog_pars_fragment>
      ${SHADOW_FRAGMENT_PARS}
      void main() {
        ${SHADOW_FRAGMENT}
        gl_FragColor = vec4(vAmbient + vDirect * shade, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

function makeGrass(count, patch, seed, { clumps = false } = {}) {
  const random = rng(seed);
  const geometry = clumps ? clumpGeometry() : bladeGeometry();
  const blade = new Float32Array(count * 4);
  const shape = new Float32Array(count * 4);
  // A few tall tufts and denser patches make it read as a meadow, not a carpet.
  for (let i = 0; i < count; i++) {
    const x = (random() - 0.5) * patch;
    const z = (random() - 0.5) * patch;
    const tuft = Math.sin(x * 0.31 + 1.3) * Math.sin(z * 0.27 + 0.4) + Math.sin(x * 0.11 - z * 0.13) * 0.6;
    const tall = clumps ? 0.3 + random() * 0.26 : 0.22 + random() * 0.26 + Math.max(0, tuft) * 0.16;
    blade[i * 4] = x;
    blade[i * 4 + 1] = z;
    blade[i * 4 + 2] = random() * Math.PI * 2;
    blade[i * 4 + 3] = tall;
    shape[i * 4] = clumps ? 0.3 + random() * 0.16 : 0.035 + random() * 0.03;
    shape[i * 4 + 1] = (random() - 0.5) * 0.7;
    shape[i * 4 + 2] = Math.pow(random(), 2.2) * (0.6 + 0.4 * Math.max(0, -tuft));
    shape[i * 4 + 3] = random();
  }
  geometry.setAttribute("aBlade", new THREE.InstancedBufferAttribute(blade, 4));
  geometry.setAttribute("aShape", new THREE.InstancedBufferAttribute(shape, 4));
  geometry.instanceCount = count;
  return geometry;
}

// Far ring "clumps": a 3-blade tuft per instance, cheap stand-ins for distant blades.
function clumpGeometry() {
  const pos = [];
  const index = [];
  for (const [x, lean, w, h] of [[-0.28, -0.35, 0.22, 0.8], [0.02, 0.08, 0.26, 1], [0.3, 0.4, 0.2, 0.72]]) {
    const i = pos.length / 3;
    pos.push(x - w / 2, 0, 0, x + w / 2, 0, 0, x + lean, h, 0);
    index.push(i, i + 1, i + 2);
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setIndex(index);
  return geometry;
}

// ---------- flowers ----------

function blossomGeometry() {
  // 5-petal fan facing up; vertex 0 is the center.
  const pos = [0, 0, 0];
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = i % 2 === 0 ? 1 : 0.62;
    pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
  }
  const index = [];
  for (let i = 0; i < n; i++) index.push(0, 1 + ((i + 1) % n), 1 + i);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setIndex(index);
  return geometry;
}

const FLOWER_COLORS = ["#f6f3ea", "#f3d34a", "#f3d34a", "#b79ef2", "#c58ef0", "#f2a3c9", "#93b9f6", "#e8805a", "#ffd166"];

function makeFlowers(count, patch, seed) {
  const random = rng(seed);
  const geometry = blossomGeometry();
  const a = new Float32Array(count * 4);
  const b = new Float32Array(count * 4);
  const color = new THREE.Color();
  const clusters = Math.max(8, Math.round(count / 26));
  const centers = [];
  for (let i = 0; i < clusters; i++) centers.push([(random() - 0.5) * patch, (random() - 0.5) * patch, FLOWER_COLORS[Math.floor(random() * FLOWER_COLORS.length)]]);
  for (let i = 0; i < count; i++) {
    const [cx, cz, hex] = centers[Math.floor(random() * clusters)];
    const r = Math.sqrt(random()) * 2.4;
    const t = random() * Math.PI * 2;
    a[i * 4] = cx + Math.cos(t) * r;
    a[i * 4 + 1] = cz + Math.sin(t) * r;
    a[i * 4 + 2] = random() * Math.PI * 2;
    a[i * 4 + 3] = 0.3 + random() * 0.26;
    color.set(random() < 0.12 ? FLOWER_COLORS[Math.floor(random() * FLOWER_COLORS.length)] : hex);
    b[i * 4] = color.r;
    b[i * 4 + 1] = color.g;
    b[i * 4 + 2] = color.b;
    b[i * 4 + 3] = random();
  }
  geometry.setAttribute("aBlade", new THREE.InstancedBufferAttribute(a, 4));
  geometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(b, 4));
  geometry.instanceCount = count;
  return geometry;
}

function flowerMaterial(uniforms, { shadows = false } = {}) {
  return new THREE.ShaderMaterial({
    name: "field-flowers",
    uniforms: { ...uniforms, ...shadowUniforms(shadows) },
    defines: shadows ? { FIELD_SHADOWS: 1 } : {},
    lights: shadows,
    side: THREE.DoubleSide,
    fog: true,
    vertexShader: /* glsl */ `
      attribute vec4 aBlade; // x, z, yaw, stem height
      attribute vec4 aTint;  // rgb (linear), seed
      uniform vec3 uPlayer;
      uniform float uPatch;
      uniform float uFadeStart;
      varying vec3 vAmbient;
      varying vec3 vDirect;
      ${WRAP_GLSL}
      ${WIND_GLSL}
      ${LIGHT_GLSL}
      ${CLEARING_GLSL}
      #include <fog_pars_vertex>
      ${SHADOW_VERTEX_PARS}
      void main() {
        vec2 rel = wrapAround(aBlade.xy, uPlayer.xz, uPatch);
        float d = length(rel) / (uPatch * 0.5);
        vec2 wp = uPlayer.xz + rel;
        vec2 away;
        float fade = (1.0 - smoothstep(uFadeStart, 1.0, d)) * (1.0 - clearing(wp, away));
        float size = 0.07 * fade * (0.75 + 0.5 * aTint.w);
        float c = cos(aBlade.z);
        float s = sin(aBlade.z);
        vec3 local = position * size;
        local.y += local.x * 0.35;
        vec3 p = vec3(local.x * c + local.z * s, local.y + aBlade.w * fade, -local.x * s + local.z * c);
        float gust;
        p += windOffset(wp, 1.0, aBlade.w * fade, aTint.w, gust);
        vec3 world = vec3(wp.x + p.x, p.y, wp.y + p.z);
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        bool center = dot(position, position) < 0.001;
        vec3 albedo = center ? vec3(0.95, 0.62, 0.08) : aTint.rgb;
        vec3 viewDir = normalize(world - cameraPosition);
        fieldLightSplit(albedo, vec3(0.0, 1.0, 0.0), 1.0, 0.5, viewDir, vAmbient, vDirect);
        vAmbient *= 1.15;
        vDirect *= 1.15;
        #include <fog_vertex>
        ${SHADOW_VERTEX}
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vAmbient;
      varying vec3 vDirect;
      #include <common>
      #include <fog_pars_fragment>
      ${SHADOW_FRAGMENT_PARS}
      void main() {
        ${SHADOW_FRAGMENT}
        gl_FragColor = vec4(vAmbient + vDirect * shade, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

// ---------- ground ----------

function groundTexture(renderer) {
  if (typeof document === "undefined") return null;
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const random = rng(77);
  // De-cartoon grade (section 3a): meadow ground in olive and straw tones, no crayon green under the blades.
  ctx.fillStyle = "#55653a";
  ctx.fillRect(0, 0, size, size);
  // Seamless: everything near an edge is also drawn wrapped.
  const wrapped = (x, y, r, draw) => {
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        if (x + ox + r < 0 || x + ox - r > size || y + oy + r < 0 || y + oy - r > size) continue;
        draw(x + ox, y + oy);
      }
    }
  };
  const blotch = ["#4b5f31", "#5f7340", "#58703a", "#6a7c46", "#4f6633", "#75844a"];
  for (let i = 0; i < 260; i++) {
    const x = random() * size;
    const y = random() * size;
    const r = 10 + random() * 46;
    ctx.globalAlpha = 0.18 + random() * 0.2;
    ctx.fillStyle = blotch[Math.floor(random() * blotch.length)];
    wrapped(x, y, r, (px, py) => {
      ctx.beginPath();
      ctx.ellipse(px, py, r, r * (0.6 + random() * 0.4), random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  const strokes = ["#3a4d27", "#45592c", "#687f3f", "#7d944b", "#8fa257", "#a3a862", "#3f5a2a"];
  ctx.lineCap = "round";
  for (let i = 0; i < 9000; i++) {
    const x = random() * size;
    const y = random() * size;
    const len = 3 + random() * 9;
    const a = random() * Math.PI * 2;
    ctx.globalAlpha = 0.35 + random() * 0.45;
    ctx.strokeStyle = strokes[Math.floor(random() * strokes.length)];
    ctx.lineWidth = 0.8 + random() * 1.6;
    wrapped(x, y, len, (px, py) => {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len);
      ctx.stroke();
    });
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 4);
  return texture;
}

// Polar disc with small triangles near the player and big ones far away: no huge triangles
// straddling the near plane (they crack when clipped) and only ~1k triangles in total.
function groundGeometry() {
  const radii = [0, 0.75, 1.5, 3, 6, 12, 24, 48, 96, 192, 384, 768, 1400, GROUND_SIZE / 2];
  const seg = 48;
  const pos = [0, 0, 0];
  const index = [];
  for (let j = 1; j < radii.length; j++) {
    for (let i = 0; i < seg; i++) {
      const a = ((i + (j % 2) * 0.5) / seg) * Math.PI * 2;
      pos.push(Math.cos(a) * radii[j], 0, -Math.sin(a) * radii[j]);
    }
  }
  for (let i = 0; i < seg; i++) index.push(0, 1 + i, 1 + ((i + 1) % seg));
  for (let j = 1; j < radii.length - 1; j++) {
    const a0 = 1 + (j - 1) * seg;
    const b0 = a0 + seg;
    const odd = j % 2 === 1;
    for (let i = 0; i < seg; i++) {
      const a = a0 + i;
      const a1 = a0 + ((i + 1) % seg);
      const b = b0 + i;
      const b1 = b0 + ((i + 1) % seg);
      const bp = b0 + ((i + seg - 1) % seg);
      if (odd) index.push(a, b, b1, a, b1, a1);
      else index.push(a, bp, b, a, b, a1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const n = pos.length / 3;
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(n * 3).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  const uv = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    uv[k * 2] = pos[k * 3] / 7;
    uv[k * 2 + 1] = -pos[k * 3 + 2] / 7;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

function makeGround(texture, uniforms) {
  const geometry = groundGeometry();
  let material;
  if (texture) {
    material = new THREE.MeshLambertMaterial({ color: "#ffffff", map: texture });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vGroundXZ;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvGroundXZ = (modelMatrix * vec4(transformed, 1.0)).xz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vGroundXZ;\nuniform float uTile;\nuniform float uNearR;\nuniform vec3 uGroundNear;\nuniform vec3 uGroundFar;")
        .replace(
          "#include <map_fragment>",
          /* glsl */ `
          vec3 g1 = texture2D(map, vGroundXZ / uTile).rgb;
          vec3 g2 = texture2D(map, vGroundXZ / (uTile * 9.7) + vec2(0.37, 0.61)).rgb;
          vec3 g3 = texture2D(map, vGroundXZ / (uTile * 61.0) + vec2(0.13, 0.29)).rgb;
          vec3 g = g1 * (0.55 + 0.45 * g2.g / 0.16) * (0.7 + 0.3 * g3.g / 0.16);
          float far = smoothstep(uNearR * 0.55, uNearR * 1.15, distance(vGroundXZ, cameraPosition.xz));
          diffuseColor.rgb *= g * mix(uGroundNear, uGroundFar, far);`,
        );
    };
    material.customProgramCacheKey = () => "field-ground";
  } else {
    // Node / no canvas: vertex-colored plane.
    const random = rng(5);
    const colors = [];
    const color = new THREE.Color();
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      color.setRGB(0.18 + random() * 0.05, 0.36 + random() * 0.08, 0.12 + random() * 0.04);
      colors.push(color.r, color.g, color.b);
    }
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    material = new THREE.MeshLambertMaterial({ vertexColors: true });
  }
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "field-ground";
  mesh.renderOrder = 5; // after grass and objects, so early depth rejects hidden ground pixels
  return mesh;
}

// ---------- sky ----------

function makeSky(uniforms) {
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 48, 24);
  const material = new THREE.ShaderMaterial({
    name: "field-sky",
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: false, // horizon must match the fog color exactly (fog is mixed after tone mapping)
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uBelow;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSunVis;
      uniform float uGlow;
      uniform vec3 uMoonDir;
      uniform float uMoon;
      varying vec3 vDir;
      #include <common>
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.48));
        col = mix(col, uBelow, smoothstep(0.0, -0.18, h));
        float c = max(dot(d, uSunDir), 0.0);
        float lowSun = 1.0 - smoothstep(0.05, 0.45, uSunDir.y);
        vec2 sd = normalize(uSunDir.xz + 1e-5);
        vec2 dd = normalize(d.xz + 1e-5);
        float band = exp(-abs(h) * 9.0) * pow(max(dot(sd, dd), 0.0), 2.5) * lowSun;
        col += uSunColor * (pow(c, 7.0) * 0.28 + pow(c, 90.0) * 0.55) * uGlow;
        col = mix(col, uSunColor * mix(col, vec3(1.0), 0.5) * 1.15, band * 0.55 * uGlow * smoothstep(-0.03, 0.02, h));
        float disk = smoothstep(0.99955, 0.99972, c) * uSunVis * smoothstep(-0.02, 0.01, h);
        col = mix(col, uSunColor * 2.6 + 0.4, disk);
        float m = max(dot(d, uMoonDir), 0.0);
        float moonDisk = smoothstep(0.99962, 0.99976, m);
        col += vec3(0.32, 0.38, 0.55) * pow(m, 40.0) * 0.25 * uMoon;
        col = mix(col, vec3(0.92, 0.94, 1.0), moonDisk * uMoon);
        col += (rand(gl_FragCoord.xy) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "field-sky";
  mesh.renderOrder = 10; // last opaque: only pixels nothing else covered run the sky shader
  mesh.frustumCulled = false;
  return mesh;
}

function makeStars(uniforms) {
  const random = rng(31);
  const count = 1400;
  const pos = new Float32Array(count * 3);
  const info = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const y = 0.06 + Math.pow(random(), 0.8) * 0.94;
    const a = random() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    pos[i * 3] = Math.cos(a) * r * SKY_RADIUS * 0.95;
    pos[i * 3 + 1] = y * SKY_RADIUS * 0.95;
    pos[i * 3 + 2] = Math.sin(a) * r * SKY_RADIUS * 0.95;
    info[i * 2] = 1.2 + Math.pow(random(), 6) * 2.6;
    info[i * 2 + 1] = random() * 6.2831;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("aInfo", new THREE.BufferAttribute(info, 2));
  const material = new THREE.ShaderMaterial({
    name: "field-stars",
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    vertexShader: /* glsl */ `
      attribute vec2 aInfo;
      uniform float uTime;
      uniform float uStars;
      uniform float uPixel;
      varying float vAlpha;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = aInfo.x * uPixel;
        vAlpha = uStars * (0.65 + 0.35 * sin(uTime * (1.3 + aInfo.y * 0.3) + aInfo.y * 7.0)) * smoothstep(0.0, 120.0, position.y);
      }`,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.1, length(q)) * vAlpha;
        gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * a, a);
        #include <colorspace_fragment>
      }`,
  });
  const points = new THREE.Points(geometry, material);
  points.name = "field-stars";
  points.renderOrder = -9;
  points.frustumCulled = false;
  return points;
}

// ---------- distant hills and trees ----------

// Same function on CPU (hill mesh) and GPU (trees standing on the hills). theta = atan2(z, x).
function hillHeight(theta, r) {
  const near = 22 + 13 * Math.sin(3 * theta + 1.1) + 9 * Math.sin(7 * theta + 2.3) + 5 * Math.sin(13 * theta + 0.7) + 3 * Math.sin(29 * theta + 4.1);
  const far = 95 + 40 * Math.sin(2 * theta + 0.4) + 26 * Math.sin(5 * theta + 3.3) + 12 * Math.sin(11 * theta + 1.9);
  const bump = smooth(470, 640, r) * (1 - 0.35 * smooth(760, 900, r));
  return Math.max(7, near) * bump + far * smooth(900, 1250, r);
}
function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
const HILL_GLSL = /* glsl */ `
float hillHeight(float theta, float r) {
  float near = 22.0 + 13.0 * sin(3.0 * theta + 1.1) + 9.0 * sin(7.0 * theta + 2.3) + 5.0 * sin(13.0 * theta + 0.7) + 3.0 * sin(29.0 * theta + 4.1);
  float far = 95.0 + 40.0 * sin(2.0 * theta + 0.4) + 26.0 * sin(5.0 * theta + 3.3) + 12.0 * sin(11.0 * theta + 1.9);
  float bump = smoothstep(470.0, 640.0, r) * (1.0 - 0.35 * smoothstep(760.0, 900.0, r));
  return max(7.0, near) * bump + far * smoothstep(900.0, 1250.0, r);
}`;

function makeHills() {
  const radii = [440, 500, 560, 620, 680, 740, 800, 860, 930, 1000, 1080, 1160, 1250, 1350];
  const seg = 128;
  const random = rng(19);
  const pos = [];
  const colors = [];
  const color = new THREE.Color();
  const lush = new THREE.Color("#4f7d2f");
  const dry = new THREE.Color("#7f9a45");
  const ridge = new THREE.Color("#55745a");
  for (let j = 0; j < radii.length; j++) {
    for (let i = 0; i <= seg; i++) {
      const theta = (i / seg) * Math.PI * 2;
      const jitter = j > 0 && j < radii.length - 1 ? (random() - 0.5) * 30 : 0;
      const r = radii[j] + jitter;
      const y = hillHeight(theta, r) + (j > 0 ? (random() - 0.5) * 4 : 0);
      pos.push(Math.cos(theta) * r, Math.max(0, y) - (j === 0 ? 0.5 : 0), Math.sin(theta) * r);
      color.copy(lush).lerp(dry, random() * 0.6).lerp(ridge, smooth(860, 1200, r));
      colors.push(color.r, color.g, color.b);
    }
  }
  const index = [];
  for (let j = 0; j < radii.length - 1; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      const b = a + seg + 1;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "field-hills";
  mesh.frustumCulled = false;
  return mesh;
}

function mergeParts(parts) {
  // parts: [{ geometry (non-indexed or indexed), color }]
  const pos = [];
  const nrm = [];
  const col = [];
  const color = new THREE.Color();
  for (const { geometry, color: hex } of parts) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    g.computeVertexNormals();
    color.set(hex);
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i], p[i + 1], p[i + 2]);
      nrm.push(n[i], n[i + 1], n[i + 2]);
      col.push(color.r, color.g, color.b);
    }
    if (g !== geometry) g.dispose();
    geometry.dispose();
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  return geometry;
}

function treeGeometry(kind) {
  if (kind === "pine") {
    const trunk = new THREE.CylinderGeometry(0.25, 0.35, 3, 5).translate(0, 1.5, 0);
    const c1 = new THREE.ConeGeometry(2.6, 5, 7).translate(0, 4.5, 0);
    const c2 = new THREE.ConeGeometry(2, 4.2, 7).translate(0, 7.2, 0);
    const c3 = new THREE.ConeGeometry(1.3, 3.4, 7).translate(0, 9.6, 0);
    return mergeParts([{ geometry: trunk, color: "#5a4029" }, { geometry: c1, color: "#2c5a32" }, { geometry: c2, color: "#336639" }, { geometry: c3, color: "#3b7040" }]);
  }
  const trunk = new THREE.CylinderGeometry(0.3, 0.45, 4, 5).translate(0, 2, 0);
  const crown = new THREE.IcosahedronGeometry(3.2, 0).scale(1, 0.85, 1).translate(0, 6.2, 0);
  const crown2 = new THREE.IcosahedronGeometry(2.2, 0).translate(1.4, 7.6, 0.6);
  return mergeParts([{ geometry: trunk, color: "#5e4630" }, { geometry: crown, color: "#4b7f2e" }, { geometry: crown2, color: "#5a8d36" }]);
}

function makeTrees(kind, count, seed, uniforms) {
  const random = rng(seed);
  const geometry = treeGeometry(kind);
  const data = new Float32Array(count * 4);
  const tint = new Float32Array(count);
  const groves = 46;
  const centers = [];
  for (let i = 0; i < groves; i++) centers.push([(random() - 0.5) * 1400, (random() - 0.5) * 1400]);
  for (let i = 0; i < count; i++) {
    const [cx, cz] = centers[Math.floor(random() * groves)];
    const r = Math.sqrt(random()) * 45;
    const a = random() * Math.PI * 2;
    data[i * 4] = cx + Math.cos(a) * r;
    data[i * 4 + 1] = cz + Math.sin(a) * r;
    data[i * 4 + 2] = random() * Math.PI * 2;
    data[i * 4 + 3] = 0.8 + random() * 0.9;
    tint[i] = random();
  }
  geometry.setAttribute("aTree", new THREE.InstancedBufferAttribute(data, 4));
  geometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 1));
  geometry.instanceCount = count;
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute vec4 aTree;
        attribute float aTint;
        uniform vec3 uPlayer;
        ${WRAP_GLSL}
        ${HILL_GLSL}`,
      )
      .replace(
        "#include <color_vertex>",
        "#include <color_vertex>\nvColor.rgb *= 0.82 + 0.36 * aTint;",
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `
        vec2 rel = wrapAround(aTree.xy, uPlayer.xz, 1400.0);
        float dist = length(rel);
        float k = aTree.w * smoothstep(170.0, 240.0, dist) * (1.0 - smoothstep(1150.0, 1300.0, dist));
        float cy = cos(aTree.z);
        float sy = sin(aTree.z);
        vec3 transformed = position * k;
        transformed = vec3(transformed.x * cy + transformed.z * sy, transformed.y, -transformed.x * sy + transformed.z * cy);
        float ground = hillHeight(atan(rel.y, rel.x), dist);
        transformed += vec3(uPlayer.x + rel.x, ground - 0.5, uPlayer.z + rel.y);`,
      )
      .replace(
        "#include <beginnormal_vertex>",
        "vec3 objectNormal = vec3(normal.x * cos(aTree.z) + normal.z * sin(aTree.z), normal.y, -normal.x * sin(aTree.z) + normal.z * cos(aTree.z));",
      );
  };
  material.customProgramCacheKey = () => "field-trees";
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `field-trees-${kind}`;
  mesh.frustumCulled = false;
  return mesh;
}

// ---------- clouds: low-poly puffs drifting overhead (one draw call) ----------

function cloudGeometry() {
  const random = rng(23);
  const parts = [];
  const puffs = [[0, 0, 0, 1], [1.1, -0.15, 0.2, 0.75], [-1.05, -0.2, -0.1, 0.8], [0.45, 0.35, -0.35, 0.7], [-0.4, 0.3, 0.4, 0.65], [1.9, -0.35, -0.2, 0.5], [-1.8, -0.35, 0.25, 0.5]];
  for (const [x, y, z, r] of puffs) {
    const g = new THREE.IcosahedronGeometry(r, 0);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      // Flat-ish bottoms read as clouds, not balls.
      pos.setY(i, Math.max(pos.getY(i), -r * 0.35) * 0.72);
      pos.setX(i, pos.getX(i) * (1 + random() * 0.08));
    }
    g.translate(x, y, z);
    parts.push({ geometry: g, color: "#ffffff" });
  }
  const geometry = mergeParts(parts);
  // Shade the undersides a little.
  const pos = geometry.attributes.position;
  const col = geometry.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const k = 0.78 + 0.22 * Math.min(1, Math.max(0, (pos.getY(i) + 0.4) / 0.9));
    col.setXYZ(i, k, k, Math.min(1, k * 1.04));
  }
  return geometry;
}

function makeClouds(uniforms) {
  const random = rng(29);
  const count = 34;
  const geometry = cloudGeometry();
  const data = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    data[i * 4] = (random() - 0.5) * 2600;
    data[i * 4 + 1] = (random() - 0.5) * 2600;
    data[i * 4 + 2] = 230 + random() * 170;
    data[i * 4 + 3] = 26 + random() * 34;
  }
  geometry.setAttribute("aCloud", new THREE.InstancedBufferAttribute(data, 4));
  geometry.instanceCount = count;
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: "#ffffff", emissiveIntensity: 0.3 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute vec4 aCloud;
        uniform vec3 uPlayer;
        uniform float uTime;
        uniform vec2 uWindDir;
        ${WRAP_GLSL}`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `
        vec2 rel = wrapAround(aCloud.xy + uWindDir * uTime * 2.5, uPlayer.xz, 2600.0);
        float k = aCloud.w * (1.0 - smoothstep(1050.0, 1280.0, length(rel)));
        vec3 transformed = position * vec3(k, k * 0.8, k) + vec3(uPlayer.x + rel.x, aCloud.z, uPlayer.z + rel.y);`,
      );
  };
  material.customProgramCacheKey = () => "field-clouds";
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "field-clouds";
  mesh.frustumCulled = false;
  return mesh;
}

// ---------- Field ----------

const _right = new THREE.Vector3();
const _upL = new THREE.Vector3();
const _center = new THREE.Vector3();

export class Field {
  // tier: quest | tablet | laptop (js/dot3d/tiers.js) sizes the shadow map and box; grassShadows: the field's own shaders
  // sample the shadow map too (the first cut in the bible's Quest fps pass, so it is a switch).
  constructor({ scene, renderer = null, quality = "high", tier = "laptop", grassShadows = true } = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.quality = QUALITY[quality] ? quality : "high";
    this.tier = tier;
    this.budget = tierBudget(tier);
    this.shadow = { mapSize: this.budget.shadowMapSize, radius: SHADOW_RADIUS[tier] ?? SHADOW_RADIUS.laptop };
    this.grassShadows = !!grassShadows;
    this._time = "day";
    this._envTime = null;
    this.group = new THREE.Group();
    this.group.name = "field";
    this.localLights = new LocalLights(scene, this.budget.pointLights);
    this.mist = createDawnMist(); this.group.add(this.mist.group);
    this.scenery = new THREE.Group(); // follows the player's head: sky and stars
    this.scenery.name = "field-scenery";
    this.group.add(this.scenery);

    this.state = stateFromPreset(PRESETS.day);
    this.from = makeState();
    this.to = stateFromPreset(PRESETS.day);
    this.blend = 1;

    this.prevFog = scene.fog;
    this.fog = new THREE.Fog(this.state.horizon.clone(), this.state.fogNear, this.state.fogFar);
    scene.fog = this.fog;

    // Uniforms shared by grass, flowers, ground and trees (same objects, so one write updates all).
    const shared = {
      uTime: { value: 0 },
      uPlayer: { value: new THREE.Vector3() },
      uWindDir: { value: new THREE.Vector2(0.8, 0.6).normalize() },
      uWind: { value: 0.32 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uHemiSky: { value: new THREE.Color() },
      uHemiGround: { value: new THREE.Color() },
      uClear: { value: Array.from({ length: MAX_CLEARINGS }, () => new THREE.Vector4()) },
      uClearBare: { value: new Array(MAX_CLEARINGS).fill(0) },
    };
    this.shared = shared;
    this._near = Array.from({ length: MAX_CLEARINGS }, () => ({ c: null, d: Infinity }));
    // Grass hues after the de-cartoon grade (section 3a): olive tips and straw-coloured dry blades, no crayon green.
    this.colors = { root: new THREE.Color("#25391b"), tip: new THREE.Color("#789643"), dry: new THREE.Color("#a9a263") };

    this.hemi = new THREE.HemisphereLight("#cfe4ff", "#6f8a3c", 1);
    this.hemi.name = "field-hemi";
    // The sun is the shadowed key light (LOOK-BIBLE.md section 6): an orthographic shadow box of the tier's radius that
    // follows the player's head on the ground plane in whole shadow-texel steps, so shadow edges do not swim as he walks.
    this.sun = new THREE.DirectionalLight("#ffffff", 2);
    this.sun.name = "field-sun";
    this.sun.castShadow = true;
    {
      const s = this.sun.shadow, r = this.shadow.radius;
      s.mapSize.set(this.shadow.mapSize, this.shadow.mapSize);
      Object.assign(s.camera, { left: -r, right: r, top: r, bottom: -r, near: r * 0.5, far: r * 5 });
      s.camera.updateProjectionMatrix();
      s.bias = -0.0004;
      s.normalBias = 0.02;
      s.radius = 3;
    }
    if (renderer?.shadowMap) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = revisionOf(THREE) >= 180 ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    }
    this.group.add(this.hemi, this.sun, this.sun.target);

    this.texture = groundTexture(renderer);
    this.groundUniforms = {
      uTile: { value: 7 },
      uNearR: { value: QUALITY[this.quality].patch / 2 },
      uGroundNear: { value: new THREE.Color("#ffffff") },
      uGroundFar: { value: new THREE.Color("#ffffff") },
    };
    this.ground = makeGround(this.texture, this.groundUniforms);
    this.ground.receiveShadow = true;
    this.group.add(this.ground);

    // One environment map per preset; scene.environment swaps at the crossfade midpoint, its intensity follows the state.
    this.envMaps = renderer ? bakeEnvironments(renderer) : null;

    this.skyUniforms = {
      uZenith: { value: this.state.zenith },
      uHorizon: { value: this.state.horizon },
      uBelow: { value: this.state.below },
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uSunVis: { value: 1 },
      uGlow: { value: 1 },
      uMoonDir: { value: new THREE.Vector3() },
      uMoon: { value: 0 },
    };
    this.sky = makeSky(this.skyUniforms);
    this.starUniforms = { uTime: shared.uTime, uStars: { value: 0 }, uPixel: { value: 1 } };
    this.stars = makeStars(this.starUniforms);
    this.hills = makeHills();
    this.scenery.add(this.sky, this.stars);
    this.group.add(this.hills);

    this.trees = [makeTrees("pine", 170, 3, { uPlayer: shared.uPlayer }), makeTrees("round", 150, 4, { uPlayer: shared.uPlayer })];
    this.group.add(...this.trees);
    this.clouds = makeClouds({ uPlayer: shared.uPlayer, uTime: shared.uTime, uWindDir: shared.uWindDir });
    this.group.add(this.clouds);

    this.grass = null;
    this.clumps = null;
    this.flowers = null;
    this._buildGrass();

    for (const object of [this.sky, this.stars, this.hills, this.clouds, ...this.trees]) object.raycast = noRaycast;
    scene.add(this.group);
    this._apply();
  }

  // How dark it is, 0..1, from the blended sun strength: day 0, sunset 0.29, dawn 0.42, night 1. Night-only local
  // lights (the forge) follow it through the three-second crossfade (step 12).
  night() {
    const sunI = this.state?.sunI ?? PRESETS.day.sunI;
    return 1 - Math.min(1, Math.max(0, (sunI - PRESETS.night.sunI) / (PRESETS.day.sunI - PRESETS.night.sunI)));
  }

  get time() {
    return this._time;
  }

  setTime(time, { instant = false } = {}) {
    if (!PRESETS[time]) return;
    this._time = time;
    stateFromPreset(PRESETS[time], this.to);
    if (instant) {
      copyState(this.to, this.state);
      this.blend = 1;
      this._apply();
      return;
    }
    copyState(this.state, this.from);
    this.blend = 0;
  }

  setQuality(quality) {
    if (!QUALITY[quality] || quality === this.quality) return;
    this.quality = quality;
    this._buildGrass();
  }

  update(dt, t, playerPos) {
    const u = this.shared;
    u.uTime.value = t;
    if (playerPos) u.uPlayer.value.copy(playerPos);
    const p = u.uPlayer.value;
    this.scenery.position.copy(p);
    this.ground.position.set(p.x, 0, p.z);
    this.hills.position.set(p.x, 0, p.z);
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / TRANSITION);
      lerpState(this.from, this.to, ease(this.blend), this.state);
      this._apply();
    }
    this._followShadow(p);
    this._updateClearings(p);
    this.localLights.update(p, t, this.night());
    this.mist.update(this.scene);
    // Gentle breathing of the wind strength.
    u.uWind.value = 0.3 + 0.08 * Math.sin(t * 0.21) + 0.05 * Math.sin(t * 0.53 + 1.3);
    const pixel = this.renderer?.getPixelRatio?.() || 1;
    this.starUniforms.uPixel.value = pixel;
  }

  // Nearest registered clearings to the player -> uClear (allocation free).
  _updateClearings(p) {
    const near = this._near;
    for (const slot of near) {
      slot.c = null;
      slot.d = Infinity;
    }
    const map = this.scene.userData[CLEARINGS_KEY];
    if (map) {
      for (const c of map.values()) {
        if (!(c.k > 0) || !(c.r > 0)) continue;
        const d = Math.hypot(c.x - p.x, c.z - p.z) - c.r;
        if (d > 40 || d >= near[MAX_CLEARINGS - 1].d) continue;
        let i = MAX_CLEARINGS - 1;
        while (i > 0 && near[i - 1].d > d) {
          near[i].c = near[i - 1].c;
          near[i].d = near[i - 1].d;
          i--;
        }
        near[i].c = c;
        near[i].d = d;
      }
    }
    const out = this.shared.uClear.value;
    const bare = this.shared.uClearBare.value;
    for (let i = 0; i < MAX_CLEARINGS; i++) {
      const c = near[i].c;
      if (c) out[i].set(c.x, c.z, c.r, Math.min(1, c.k));
      else out[i].set(0, 0, 0, 0);
      bare[i] = c && c.b > 0 ? Math.min(1, c.b) : 0;
    }
  }

  // Moves the sun's shadow box with the player: the box center is the head's ground point snapped to whole texels in the
  // light's own axes (three's lookAt basis: z toward the sun, x = up cross z, y = z cross x), the light sits 3 radii out.
  _followShadow(p) {
    const dir = this.state.sunDir;
    const lowSun = Math.max(0, 1 - Math.abs(dir.y) / .2);
    const r = this.shadow.radius * (1 + .4 * lowSun);
    const cam = this.sun.shadow.camera;
    if (cam.right !== r) { Object.assign(cam, { left: -r, right: r, top: r, bottom: -r }); cam.updateProjectionMatrix(); }
    const texel = (2 * r) / this.sun.shadow.mapSize.width;
    _right.set(0, 1, 0).cross(dir);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _upL.crossVectors(dir, _right);
    _center.set(p.x, 0, p.z);
    const cx = Math.round(_center.dot(_right) / texel) * texel;
    const cy = Math.round(_center.dot(_upL) / texel) * texel;
    const cz = _center.dot(dir);
    _center.set(0, 0, 0).addScaledVector(_right, cx).addScaledVector(_upL, cy).addScaledVector(dir, cz);
    this.sun.target.position.copy(_center);
    this.sun.position.copy(_center).addScaledVector(dir, r * 3);
  }

  // Pushes the interpolated time-of-day state into lights, fog, exposure, environment and uniforms.
  _apply() {
    const s = this.state;
    const u = this.shared;
    u.uSunDir.value.copy(s.sunDir);
    u.uSunColor.value.copy(s.sunColor).multiplyScalar(s.sunI);
    u.uHemiSky.value.copy(s.hemiSky).multiplyScalar(s.hemiI);
    u.uHemiGround.value.copy(s.hemiGround).multiplyScalar(s.hemiI);
    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunI;
    this._followShadow(u.uPlayer.value);
    if (this.renderer) this.renderer.toneMappingExposure = s.exposure;
    if (this.envMaps) {
      if (this.blend >= 0.5 && this._envTime !== this._time) {
        this._envTime = this._time;
        this.scene.environment = this.envMaps[this._time].texture;
      }
      if ("environmentIntensity" in this.scene) this.scene.environmentIntensity = s.envI;
    }
    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiI;
    this.fog.color.copy(s.fogColor);
    this.mist.uniforms.density.value = s.mist; this.mist.group.visible = s.mist > .0001;
    this.fog.near = s.fogNear;
    this.fog.far = s.fogFar;
    this.skyUniforms.uSunVis.value = s.sunVis;
    this.skyUniforms.uGlow.value = s.glow;
    this.skyUniforms.uMoon.value = s.moon;
    this.skyUniforms.uMoonDir.value.copy(s.sunDir);
    this.starUniforms.uStars.value = s.stars;
    // Clouds glow faintly with the sky color (bright by day, dim blue at night).
    this.clouds.material.emissive.copy(s.horizon).lerp(s.zenith, 0.3);
    this.clouds.material.emissiveIntensity = 0.32 + 0.1 * s.glow;
    this.stars.visible = s.stars > 0.01;
    // Ground under the blades reads darker; beyond the grass it takes the average blade color.
    this.groundUniforms.uGroundNear.value.setRGB(0.78, 0.8, 0.72);
    this.groundUniforms.uGroundFar.value.setRGB(1.12, 1.12, 0.98);
  }

  _buildGrass() {
    for (const mesh of [this.grass, this.clumps, this.flowers]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    const q = QUALITY[this.quality];
    const base = this.shared;
    const grassUniforms = {
      ...base,
      ...FOG_UNIFORMS(),
      uPatch: { value: q.patch },
      uFadeStart: { value: 0.72 },
      uInner: { value: 0 },
      uRoot: { value: this.colors.root },
      uTip: { value: this.colors.tip },
      uDry: { value: this.colors.dry },
    };
    const shadows = this.grassShadows;
    this.grass = new THREE.Mesh(makeGrass(q.blades, q.patch, 11), grassMaterial(grassUniforms, { shadows }));
    this.grass.name = "field-grass";
    const clumpUniforms = { ...grassUniforms, ...FOG_UNIFORMS(), uPatch: { value: q.clumpPatch }, uFadeStart: { value: 0.6 }, uInner: { value: (q.patch * 0.36) / (q.clumpPatch * 0.5) } };
    this.clumps = new THREE.Mesh(makeGrass(q.clumps, q.clumpPatch, 13, { clumps: true }), grassMaterial(clumpUniforms, { clumps: true, shadows }));
    this.clumps.name = "field-clumps";
    const flowerUniforms = { ...base, ...FOG_UNIFORMS(), uPatch: { value: q.patch * 1.25 }, uFadeStart: { value: 0.7 } };
    this.flowers = new THREE.Mesh(makeFlowers(q.flowers, q.patch * 1.25, 17), flowerMaterial(flowerUniforms, { shadows }));
    this.flowers.name = "field-flowers";
    for (const mesh of [this.grass, this.clumps, this.flowers]) {
      mesh.frustumCulled = false; // wrapped in the vertex shader, bounds are meaningless
      mesh.raycast = noRaycast;
      mesh.receiveShadow = shadows;
      this.group.add(mesh);
    }
    this.groundUniforms.uNearR.value = q.patch / 2;
  }

  // Switches the grass shaders' shadow receive (rebuilds the grass); the ground keeps receiving either way.
  setGrassShadows(on) {
    if (!!on === this.grassShadows) return;
    this.grassShadows = !!on;
    this._buildGrass();
  }

  dispose() {
    this.localLights.dispose(); this.mist.dispose();
    this.scene.remove(this.group);
    if (this.scene.fog === this.fog) this.scene.fog = this.prevFog || null;
    this.group.traverse((object) => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
    this.texture?.dispose();
    if (this.envMaps) {
      for (const target of Object.values(this.envMaps)) {
        if (this.scene.environment === target.texture) this.scene.environment = null;
        target.dispose();
      }
      this.envMaps = null;
    }
    this.sun.shadow?.dispose?.();
    this.sun.dispose?.();
    this.hemi.dispose?.();
  }
}

export const TIMES_OF_DAY = Object.keys(PRESETS);
