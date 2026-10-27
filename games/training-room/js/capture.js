// Fixed-spot captures for the remaster before/after sheet (scratch/remaster-3d/REMASTER-BAR.md).
// ?capture=1 loads this fixed scene instead of the saved room, hides the launch panel and exposes the six
// camera spots on window.__dot3d for tools/capture.mjs, so the "before" and "after" shots are framed the same.
// The spot names are the ones LOOK-BIBLE.md refers to. Pure data plus one install function; Node tests import it.
// Claude (Command), Oct 26 2026.
import { createCaptureRig } from "./dot3d/capture.js";

const DEG = Math.PI / 180;
// Lying flat on the ground: the part's +Y (blade, handle) turned onto -Z.
const FLAT = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

// The six spots. position/target are world metres with the player rig at the origin; fov is vertical degrees.
// time: a field preset (day, sunset, night, dawn); kingdom: Kingdom mode on for that shot;
// bodyYaw: degrees the advisors' formation is turned from the camera's yaw (so one stands in frame).
export const SPOTS = [
  { name: "field-overview", position: [0, 1.7, 2.5], target: [0.4, 1.0, -6], fov: 70, time: "day",
    shows: "the yard from the spawn: stone wall, dummy, crates, rack, table, trees and the villa; grass, flowers, sky and hills" },
  { name: "dummy-and-sword", position: [0.3, 1.55, -2.0], target: [1.2, 0.6, -3.8], fov: 60, time: "day",
    shows: "the training dummy at arm's length with the sword, axe and shield on the ground: materials up close" },
  { name: "wall-crates-rack", position: [0.6, 1.5, -2.0], target: [-2.0, 1.0, -5.6], fov: 65, time: "day",
    shows: "the stone wall weapons hit, the crate stack, barrel, hay bale and weapon rack: grounding and shadows" },
  { name: "table-small-things", position: [2.75, 1.15, -1.55], target: [3.05, 0.78, -2.5], fov: 50, time: "day",
    shows: "the card table with the deck, mug and chess board, the chair: the small things the player picks up" },
  { name: "kingdom-plaza", position: [0, 1.6, 0], target: [-3, 1.0, -8], fov: 80, time: "day", kingdom: true, bodyYaw: -32,
    shows: "Kingdom mode: the dirt plaza, an advisor beside the player, the market stall, house, farm and castle beyond" },
  { name: "sunset-horizon", position: [0, 1.6, 0], target: [32, 6, -100], fov: 70, time: "sunset",
    shows: "the field at sunset toward the sun: sky gradient, glow, fog, hills, the lamp post and house against the light" },
];

// The fixed scene: real catalog records at rest, every part a built-in one, so the same room builds before and after.
export function captureScene() {
  const objects = {};
  const order = [];
  const add = (id, part, p, extra = {}) => {
    objects[id] = { id, part, label: part, p, ry: 0, s: 1, ...extra };
    order.push(id);
  };
  add("wall", "physics wall", [0, 0, -7], { data: { blueprint: { name: "physics wall", size: [5, 3, 0.1], parts: [{ shape: "box", p: [0, 1.5, 0], s: [5, 3, 0.1], mat: "stone", color: "#818b91" }] } } });
  add("dummy", "training dummy", [1.6, 0, -4.2]);
  add("rack", "weapon rack", [-2.6, 0, -5.6]);
  add("crate-a", "crate", [-1.6, 0, -3.6]);
  add("crate-b", "crate", [-1.6, 0.9, -3.6], { ry: 0.12 });
  add("crate-c", "crate", [-1.6, 1.8, -3.6], { ry: -0.08 });
  add("barrel", "barrel", [-2.5, 0, -3.0]);
  add("hay", "hay bale", [-4.4, 0, -5.8], { ry: 0.5 });
  add("sword", "sword", [0.5, 0.03, -3.0], { ry: 0.3, data: { physicsPose: FLAT } });
  add("axe", "axe", [0.0, 0.03, -3.45], { ry: -0.6, data: { physicsPose: FLAT } });
  add("shield", "shield", [1.0, 0.03, -3.3], { ry: 0.9, data: { physicsPose: FLAT } });
  add("table", "card table", [3.0, 0, -2.4]);
  add("cards", "deck of cards", [2.72, 0.76, -2.3], { ry: 0.4, onto: "table" });
  add("mug", "coffee mug", [3.28, 0.76, -2.2], { onto: "table" });
  add("chess", "chess board", [3.05, 0.76, -2.55], { ry: -0.2, onto: "table" });
  add("chair", "chair", [3.0, 0, -1.45], { ry: Math.PI });
  add("bench", "bench", [5.5, 0, -4.2], { ry: -0.4 });
  add("campfire", "campfire", [4.5, 0, -6.5]);
  add("target", "archery target", [6.5, 0, -9], { ry: -0.3 });
  add("lamp", "lamp post", [-4, 0, -2]);
  add("board", "whiteboard", [-5.5, 0, -7.5], { ry: 0.5, text: "Training Room\nbefore / after" });
  add("oak", "tree", [8, 0, -13]);
  add("pine", "pine tree", [-8, 0, -14]);
  add("stall", "market stall", [-10, 0, -10], { ry: 0.8 });
  add("villa", "villa", [-16, 0, -24], { ry: 0.4 });
  add("house", "house", [12, 0, -24], { ry: -0.3 });
  add("farm", "farm field", [-6, 0, -34]);
  add("castle", "castle", [0, 0, -62]);
  return { objects, order, env: { time: "day" } };
}

// What the look pipeline did to the scene, for the step checks: tone mapping, shadows, environment, and how many part
// meshes carry textured materials (map + normal + roughness) versus flat ones (a MeshStandardMaterial with no map at all,
// glow and glass excepted: one is a light, the other a window).
export function lookReport(THREE, { scene, renderer, field }) {
  const tone = { [THREE.NoToneMapping]: "none", [THREE.ACESFilmicToneMapping]: "ACES", [THREE.AgXToneMapping ?? -1]: "AgX", [THREE.NeutralToneMapping ?? -2]: "Neutral" };
  let meshes = 0, textured = 0, flat = 0;
  const flatKinds = new Map(), recipes = new Map();
  scene.traverse((o) => {
    if (!o.isMesh || !o.material || o.userData.phaseHelper) return;
    let p = o.parent, part = false;
    while (p) { if (p.name?.startsWith("obj:")) { part = true; break; } p = p.parent; }
    if (!part) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m.isMeshStandardMaterial) continue;
      meshes++;
      const kind = m.userData?.kind || "?";
      if (m.map && m.normalMap && m.roughnessMap) textured++;
      else if (!m.map && !m.emissiveMap && kind !== "glow" && kind !== "glass") { flat++; flatKinds.set(kind, (flatKinds.get(kind) || 0) + 1); }
      if (m.userData?.recipe) recipes.set(m.userData.recipe, (recipes.get(m.userData.recipe) || 0) + 1);
    }
  });
  return {
    toneMapping: tone[renderer.toneMapping] ?? String(renderer.toneMapping), exposure: renderer.toneMappingExposure,
    shadowMap: !!renderer.shadowMap.enabled, sunCastsShadow: !!field?.sun?.castShadow, shadowMapSize: field?.sun?.shadow?.mapSize?.width ?? 0,
    shadowRadius: field?.shadow?.radius ?? 0, grassShadows: !!field?.grassShadows, environment: !!scene.environment,
    environmentIntensity: scene.environmentIntensity ?? null, tier: field?.tier ?? null,
    time: field.time, moonIntensity: field.sun.intensity, hemisphereIntensity: field.hemi.intensity,
    fog: field.fog.color.getHexString(THREE.SRGBColorSpace), mistDensity: field.mist.uniforms.density.value,
    localLights: [...field.localLights.entries.keys()].map(l => ({ visible: l.visible, intensity: l.intensity,
      color: l.color.getHexString(THREE.SRGBColorSpace), shadow: l.castShadow, distance: l.distance, y: l.position.y })),
    partMeshes: meshes, textured, flat, flatKinds: Object.fromEntries(flatKinds), recipes: Object.fromEntries(recipes),
  };
}

// Proves the shadows render: the frame at a spot with the sun's shadow at full strength against the same frame with the
// shadow strength at zero (a uniform, no shader recompile). Returns the share of pixels the shadow darkens and the mean
// darkening, per spot. Renders into a small offscreen target; the screen is left as it was.
export function probeShadows(THREE, { renderer, scene, camera, field, capture, spots }) {
  const w = 320, h = 180;
  const target = new THREE.WebGLRenderTarget(w, h);
  const px = new Uint8Array(w * h * 4);
  const read = () => {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, w, h, px);
    renderer.setRenderTarget(null);
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) lum[i] = px[i * 4] * 0.2126 + px[i * 4 + 1] * 0.7152 + px[i * 4 + 2] * 0.0722;
    return lum;
  };
  const shadow = field.sun.shadow;
  const was = shadow.intensity ?? 1;
  const out = [];
  const current = capture.current ?? 0;
  for (let i = 0; i < spots.length; i++) {
    capture.goto(i);
    shadow.intensity = 1;
    const lit = read();
    shadow.intensity = 0;
    const off = read();
    let darkened = 0, sum = 0;
    for (let k = 0; k < lit.length; k++) {
      const d = off[k] - lit[k];
      if (d > 6) darkened++;
      sum += Math.max(0, d);
    }
    out.push({ spot: spots[i].name, shadowFraction: +(darkened / lit.length).toFixed(4), meanDarkening: +(sum / lit.length / 255).toFixed(4) });
  }
  shadow.intensity = was;
  capture.goto(current);
  target.dispose();
  return out;
}

// Compare actual surface illumination with each point emitter switched off. Halos stay unchanged.
export function probeLocalLights(THREE, { renderer, scene, camera, field }) {
  const target = new THREE.WebGLRenderTarget(320, 180), previous = renderer.getRenderTarget();
  const pixels = new Uint8Array(320 * 180 * 4);
  const read = () => {
    renderer.setRenderTarget(target); renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, 320, 180, pixels);
    return pixels.slice();
  };
  const out = [];
  try {
    const on = read();
    for (const light of field.localLights.entries.keys()) {
      if (!light.visible) continue;
      const intensity = light.intensity;
      let off;
      try { light.intensity = 0; off = read(); } finally { light.intensity = intensity; }
      let sum = 0, changed = 0;
      for (let k = 0; k < pixels.length; k += 4) {
        const d = (on[k] - off[k]) * .2126 + (on[k + 1] - off[k + 1]) * .7152 + (on[k + 2] - off[k + 2]) * .0722;
        sum += Math.max(0, d); if (d > 1) changed++;
      }
      out.push({ kind: light.userData.fieldLight.fire ? 'fire' : 'lamp',
        meanGain: sum / (320 * 180 * 255), pixelsBrighter: changed });
    }
  } finally { renderer.setRenderTarget(previous); target.dispose(); }
  return out;
}

// Wires the rig into a running game. Returns { frame(now), ready() }: call frame from the game loop and ready
// once the launch panel is hidden, so the capture tool starts after the first frames compiled the shaders.
// ready() also hides the flat-screen command panel: the sheet is about the world, and the panel covered its bottom third.
// With renderer and scene given, report() also carries the look report and the shadow probe (the look-step checks read them).
export function installCapture({ THREE, camera, rig, room, field, kingdom, setKingdom, afterLoad = null, report = null, renderer = null, scene = null }) {
  if (rig) {
    rig.position.set(0, 0, 0);
    rig.rotation.set(0, 0, 0);
  }
  room.load(captureScene());
  afterLoad?.();
  const yawOf = (s) => Math.atan2(-(s.target[0] - s.position[0]), -(s.target[2] - s.position[2]));
  let current = 0;
  const capture = createCaptureRig(THREE, {
    camera,
    spots: SPOTS,
    onGoto: (i, s) => {
      current = i;
      field.setTime(new URLSearchParams(location.search).get("time") || s.time || "day", { instant: true });
      setKingdom(!!s.kingdom);
      // The advisors form up around the player's facing; turn the formation so one of them is in the shot.
      if (s.kingdom && kingdom) kingdom.bodyYaw = yawOf(s) + (s.bodyYaw || 0) * DEG;
    },
  });
  window.__dot3d.report = () => ({
    records: room.records().length, parts: [...new Set(room.records().map((r) => r.part))].length, time: field._time, kingdom: !!kingdom?.enabled,
    kingdomLook: kingdom?.lookInfo?.() ?? null,
    ...(report?.() || {}),
    ...(renderer && scene ? { look: lookReport(THREE, { scene, renderer, field }), localLightProbe: probeLocalLights(THREE, { renderer, scene, camera, field }), shadowProbe: probeShadows(THREE, { renderer, scene, camera, field, capture: { goto: capture.goto, get current() { return current; } }, spots: SPOTS }) } : {}),
  });
  capture.goto(0);
  return {
    frame: (now) => capture.frame(now),
    ready: () => {
      const app = document.getElementById("tr-app");
      if (app) app.hidden = true;
      setTimeout(() => { window.__dot3d.ready = true; }, 1500);
    },
  };
}
