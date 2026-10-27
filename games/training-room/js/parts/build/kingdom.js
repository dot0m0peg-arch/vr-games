// kingdom parts: builders keyed by meta name (see ARCHITECTURE.md).
// Origin is the bottom-center of each part's bounding box and fronts face +Z.
// Step 12 (LOOK-BIBLE.md section 11, Claude (Command), Oct 26 2026): the figure has a limb rig for the Kingdom walk
// cycle, straw and felt hats, a steel helm and a wool robe; the tavern and blacksmith breathe chimney smoke, the forge
// glows at night, the stall's awning has a valance, the farm has dirt furrows, and name boards hang from an oak pole.
import { kit } from "./kit.js";

const { THREE, box, cyl, sphere, cone, capsule, prism, torus, group, mat, finish, textPanel, DEG } = kit;

const C = {
  stone: "#a39d90", darkStone: "#7d786e", wood: "#7a5434", darkWood: "#4f3624", plank: "#a97d52",
  thatch: "#c9a55a", roof: "#5d4a3a", slate: "#4b4e55", iron: "#30332f", ember: "#ff7a2a",
  skin: "#d8a77c", cloth: "#e9e2cf", gold: "#d9b45b", wheat: "#d9b850", soil: "#6b4a2b", furrow: "#4a3321", banner: "#7a1f2b",
  steel: "#8b8f94", felt: "#3b2e25", board: "#6b4a2e", letters: "#f3e3b5",
};

// Crenellated parapet on a rectangle of half sizes hx, hz at height y.
function merlons(add, hx, hz, y, material, step = 1.2, size = 0.6) {
  for (let x = -hx + size / 2; x <= hx - size / 2 + 1e-6; x += step) {
    for (const s of [-1, 1]) add(box([size, size, size], material, { p: [x, y + size / 2, s * (hz - size / 2)] }));
  }
  for (let z = -hz + size / 2 + step; z <= hz - size / 2 - step + 1e-6; z += step) {
    for (const s of [-1, 1]) add(box([size, size, size], material, { p: [s * (hx - size / 2), y + size / 2, z] }));
  }
}

// ---------- the walk cycle (LOOK-BIBLE.md section 11) ----------
// Two frames per step: a cycle of two steps holds four poses (legs apart, legs passing, apart the other way, passing),
// legs swinging 25 degrees and arms 15 the other way. The feet stay level (the shoe counter-rotates on the leg) and
// the hips drop by what the swung legs lose in height (foot: hip to shoe centre), so both soles stay on the ground
// instead of the old 4 cm bob. phase is in cycles; stride is one cycle in metres.
export const WALK = { legDeg: 25, armDeg: 15, stride: 1.3, hip: 0.8, foot: 0.76, shoulder: 1.33 };
export const REST_POSE = Object.freeze({ frame: 1, swing: 0, legL: 0, legR: 0, armL: 0, armR: 0, dip: 0 });

export function walkPose(phase) {
  if (!Number.isFinite(phase)) return REST_POSE;
  const frame = ((Math.floor(phase * 4) % 4) + 4) % 4;
  const swing = frame === 0 ? 1 : frame === 2 ? -1 : 0;
  const leg = swing * WALK.legDeg * DEG, arm = -swing * WALK.armDeg * DEG;
  return { frame, swing, legL: leg, legR: -leg, armL: arm, armR: -arm, dip: swing ? WALK.foot * (1 - Math.cos(leg)) : 0 };
}

// Applies a pose to a figure built with { animate: true }; phase null means standing. Returns the pose (dip 0 for a
// robed figure, whose legs are hidden) or null for a figure without a rig.
export function poseFigure(root, phase) {
  const rig = root?.userData?.rig;
  if (!rig) return null;
  const pose = phase === null || phase === undefined ? REST_POSE : walkPose(phase);
  rig.legs[0].rotation.x = pose.legL;
  rig.legs[1].rotation.x = pose.legR;
  if (rig.shoes) { rig.shoes[0].rotation.x = -pose.legL; rig.shoes[1].rotation.x = -pose.legR; }
  rig.arms[0].rotation.x = pose.armL;
  rig.arms[1].rotation.x = pose.armR;
  return rig.legless ? { ...pose, dip: 0 } : pose;
}

function keepMeshes(object) {
  object.traverse((o) => { if (o.isMesh) o.userData.keep = true; });
  return object;
}

// A standing person (feet at y = 0, faces +Z). Shared by the peasant part and Kingdom mode advisors and villagers.
// animate: true leaves the two legs and two arms as pivoted groups (hip at 0.8 m, shoulder at 1.33 m) that
// mergeStatic keeps apart, so poseFigure can swing them; false (the catalog peasant) merges as before.
// wool: the robe and tunic in the felt family (the Lord Steward's deep red); hat: straw | felt | hood | crown | helm.
export function figure({ tunic = "#8a6b3f", trousers = "#4f4234", hair = "#4a3220", hat = null, robe = false, wool = false, tint = true, animate = false } = {}) {
  const root = group();
  const add = (...list) => list.forEach((m) => root.add(m));
  const body = mat(tunic, wool ? "felt" : "fabric");
  const legs = mat(trousers, "fabric");
  const skin = mat(C.skin, "matte");
  const shoe = mat("#3a2a1c", "leather");
  const rig = { legs: [], shoes: [], arms: [] };
  if (robe) {
    add(cyl([0.2, 0.3, 1.0], body, { p: [0, 0.5, 0], seg: 12, tint }));
  } else {
    for (const s of [-1, 1]) {
      const leg = group([], { p: [s * 0.1, WALK.hip, 0], name: s < 0 ? "leg-left" : "leg-right" });
      leg.add(capsule([0.07, 0.62], legs, { p: [0, 0.4 - WALK.hip, 0] }));
      // The shoe pivots on its own centre, under the leg, so the walk can keep it level.
      const foot = group([box([0.13, 0.08, 0.22], shoe, { p: [0, 0, 0] })], { p: [0, -WALK.foot, 0], name: "shoe" });
      leg.add(foot);
      if (animate) keepMeshes(leg);
      rig.legs.push(leg);
      rig.shoes.push(foot);
      add(leg);
    }
  }
  add(capsule([0.17, 0.42], body, { p: [0, 1.1, 0], tint }));
  add(box([0.36, 0.06, 0.3], mat("#5a3c25", "leather"), { p: [0, 0.93, 0] }));
  for (const s of [-1, 1]) {
    const arm = group([], { p: [s * 0.25, WALK.shoulder, 0.02], name: s < 0 ? "arm-left" : "arm-right" });
    arm.add(capsule([0.055, 0.5], body, { p: [0, 1.08 - WALK.shoulder, 0], r: [0, 0, s * 8], tint }));
    arm.add(sphere(0.06, skin, { p: [s * 0.02, 0.78 - WALK.shoulder, 0.01], seg: 8 }));
    if (animate) keepMeshes(arm);
    rig.arms.push(arm);
    add(arm);
  }
  add(sphere(0.13, skin, { p: [0, 1.5, 0], seg: 12 }));
  add(sphere(0.135, mat(hair, "matte"), { p: [0, 1.55, -0.03], seg: 12 }));
  for (const s of [-1, 1]) add(sphere(0.018, mat("#1d1712", "matte"), { p: [s * 0.045, 1.52, 0.12], seg: 6 }));
  if (hat === "crown") {
    add(cyl([0.14, 0.14, 0.08], mat(C.gold, "gold"), { p: [0, 1.66, 0], seg: 12 }));
  } else if (hat === "hood") {
    add(cone([0.15, 0.22], mat(tunic, "fabric"), { p: [0, 1.7, -0.02], seg: 10 }));
  } else if (hat === "straw") {
    add(cyl([0.26, 0.26, 0.02], mat(C.thatch, "straw"), { p: [0, 1.63, 0], seg: 14 }));
    add(cyl([0.1, 0.13, 0.07], mat(C.thatch, "straw"), { p: [0, 1.67, 0], seg: 10 }));
  } else if (hat === "felt") {
    add(cyl([0.2, 0.2, 0.015], mat(C.felt, "felt"), { p: [0, 1.62, 0], seg: 14 }));
    add(cyl([0.11, 0.13, 0.09], mat(C.felt, "felt"), { p: [0, 1.665, 0], seg: 12 }));
  } else if (hat === "helm") {
    // A steel skull cap with a brim and a nasal bar.
    const steel = mat(C.steel, "steel");
    add(sphere(0.15, steel, { p: [0, 1.56, 0], seg: 12 }));
    add(cyl([0.17, 0.17, 0.02], steel, { p: [0, 1.53, 0], seg: 14 }));
    add(box([0.02, 0.12, 0.02], steel, { p: [0, 1.47, 0.14] }));
  }
  if (animate && rig.legs.length === 2) root.userData.rig = rig;
  else if (animate) root.userData.rig = { legs: [group(), group()], shoes: null, arms: rig.arms, legless: true }; // a robe hides the legs; the arms still swing, no dip
  return root;
}

// A hanging name board (step 12): an oak board 1.1 x 0.24 m with the name in pale letters, two iron rings on its top
// edge and short chains above them. The world hangs it from the advisor's sign pole. panel.userData.setText renames it.
export function nameBoard(text) {
  const root = group();
  const oak = mat(C.board, "wood");
  const iron = mat(C.iron, "metal");
  const board = box([1.1, 0.24, 0.03], oak, { p: [0, 0, 0] });
  root.add(board);
  const panel = textPanel([1.0, 0.18], { text, size: 54, align: "center", valign: "middle", bg: null, color: C.letters }, { p: [0, 0, 0.016] });
  panel.name = "name-board-text";
  root.add(panel);
  for (const s of [-1, 1]) {
    root.add(torus([0.02, 0.004], iron, { p: [s * 0.45, 0.13, 0], seg: 12 }));
    root.add(cyl([0.004, 0.004, 0.16], iron, { p: [s * 0.45, 0.23, 0], seg: 6 }));
  }
  root.userData.board = { size: [1.1, 0.24], panel };
  return root;
}

export const builders = {
  castle(o) {
    const stone = mat(o.color || C.stone, "stone");
    const dark = mat(C.darkStone, "stone");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    // Curtain walls around a 16 m square with a gate on the front.
    const h = 7;
    for (const s of [-1, 1]) add(box([1.2, h, 13], stone, { p: [s * 7.4, h / 2, 0], tint: true }));
    add(box([13, h, 1.2], stone, { p: [0, h / 2, -7.4], tint: true }));
    for (const s of [-1, 1]) add(box([4.8, h, 1.2], stone, { p: [s * 4.1, h / 2, 7.4], tint: true }));
    add(box([3.4, 2, 1.2], stone, { p: [0, h - 1, 7.4], tint: true }));
    add(box([3.2, 5, 0.2], mat(C.darkWood, "wood"), { p: [0, 2.5, 7.0] }));
    for (let i = -3; i <= 3; i++) add(box([0.08, 4.8, 0.1], mat(C.iron, "metal"), { p: [i * 0.42, 2.6, 7.95] }));
    for (let j = 1; j <= 4; j++) add(box([3.2, 0.08, 0.1], mat(C.iron, "metal"), { p: [0, j * 1.1, 7.95] }));
    for (const s of [-1, 1]) {
      for (let x = -6.6; x <= 6.6; x += 1.4) add(box([0.7, 0.7, 0.7], dark, { p: [x, h + 0.35, s * 7.4] }));
      for (let z = -5.2; z <= 5.2; z += 1.4) add(box([0.7, 0.7, 0.7], dark, { p: [s * 7.4, h + 0.35, z] }));
    }
    // Corner towers.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      add(cyl([1.6, 1.8, 10], stone, { p: [sx * 6.2, 5, sz * 6.2], seg: 14, tint: true }));
      add(cone([2.0, 3.2], mat(C.slate, "matte"), { p: [sx * 6.2, 11.6, sz * 6.2], seg: 14 }));
    }
    // Keep in the middle with a banner.
    add(box([6.4, 11, 6.4], stone, { p: [0, 5.5, -0.8], tint: true }));
    merlons(add, 3.2, 3.2, 11, dark, 1.25, 0.6);
    for (const s of [-1, 1]) add(box([0.6, 1.4, 0.1], mat("#1d1a16", "matte"), { p: [s * 1.6, 7.5, 2.45] }));
    add(cyl([0.06, 0.06, 3.6], mat(C.wood, "wood"), { p: [0, 13.4, -0.8], seg: 6 }));
    add(box([1.6, 1.0, 0.04], mat(C.banner, "fabric"), { p: [0.82, 14.6, -0.8] }));
    return finish(root, "castle");
  },

  "farm field"(o) {
    const wheat = mat(o.color || C.wheat, "fabric");
    const soil = mat(C.soil, "dirt");
    const furrow = mat(C.furrow, "dirt");
    const wood = mat(C.wood, "wood");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(box([12, 0.1, 8], soil, { p: [0, 0.05, 0] }));
    for (let i = 0; i < 9; i++) {
      const z = -3.5 + i * 0.875;
      add(box([11.2, 0.55, 0.42], wheat, { p: [0, 0.38, z], tint: true }));
      add(box([11.2, 0.12, 0.3], mat("#e8cf6e", "fabric"), { p: [0, 0.7, z] }));
    }
    // Dark furrows between the rows, where the plough turned the soil.
    for (let i = 0; i < 8; i++) add(box([11.2, 0.03, 0.22], furrow, { p: [0, 0.115, -3.5 + 0.4375 + i * 0.875], name: "furrow" }));
    // Low split-rail fence.
    for (const s of [-1, 1]) {
      add(box([12.2, 0.08, 0.08], wood, { p: [0, 0.75, s * 4.05] }));
      add(box([0.08, 0.08, 8.2], wood, { p: [s * 6.05, 0.75, 0] }));
    }
    for (const sx of [-1, 0, 1]) for (const sz of [-1, 1]) add(box([0.12, 1.0, 0.12], wood, { p: [sx * 6.05, 0.5, sz * 4.05] }));
    // Scarecrow.
    add(box([0.08, 1.9, 0.08], wood, { p: [2.5, 0.95, 0] }));
    add(box([1.1, 0.07, 0.07], wood, { p: [2.5, 1.4, 0] }));
    add(box([0.4, 0.6, 0.22], mat("#6d5a8a", "fabric"), { p: [2.5, 1.25, 0] }));
    add(sphere(0.15, mat(C.thatch, "straw"), { p: [2.5, 1.7, 0], seg: 10 }));
    return finish(root, "farm field");
  },

  "market stall"(o) {
    const wood = mat(C.plank, "plank");
    const awning = mat(o.color || "#c4473a", "fabric");
    const cream = mat("#f1ead8", "fabric");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(box([3.0, 0.9, 1.2], wood, { p: [0, 0.45, 0.11] }));
    add(box([3.1, 0.08, 1.3], mat(C.darkWood, "wood"), { p: [0, 0.94, 0.11] }));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(box([0.1, 2.5, 0.1], wood, { p: [sx * 1.5, 1.25, sz * 0.9 - 0.39] }));
    // Striped canvas: six strips, and a valance hanging from the front edge in the same stripes.
    const tilt = 14, half = 1.05;
    const frontY = 2.62 + half * Math.sin(tilt * DEG), frontZ = -0.24 + half * Math.cos(tilt * DEG);
    for (let i = 0; i < 6; i++) {
      const m = i % 2 ? cream : awning;
      const x = -1.375 + i * 0.55;
      add(box([0.55, 0.06, 2.1], m, { p: [x, 2.62, -0.24], r: [-tilt, 0, 0], tint: i % 2 === 0 }));
      add(box([0.55, 0.14, 0.02], m, { p: [x, frontY - 0.08, frontZ + 0.01], tint: i % 2 === 0, name: "valance" }));
    }
    // Goods: apples, bread loaves, a cheese wheel, sacks.
    for (let i = 0; i < 5; i++) add(sphere(0.09, mat("#b8322b", "plastic"), { p: [-1.1 + i * 0.2, 1.06, 0.31], seg: 8 }));
    for (let i = 0; i < 3; i++) add(capsule([0.08, 0.2], mat("#c48a45", "matte"), { p: [0.1 + i * 0.25, 1.06, 0.31], r: [0, 0, 90] }));
    add(cyl([0.2, 0.2, 0.14], mat("#e9c75a", "matte"), { p: [1.0, 1.05, 0.21], seg: 14 }));
    for (const s of [-1, 1]) add(cyl([0.22, 0.28, 0.6], mat("#b79f74", "fabric"), { p: [s * 1.05, 0.3, 1.06], seg: 10 }));
    return finish(root, "market stall");
  },

  blacksmith(o) {
    const stone = mat(o.color || "#6e6a62", "stone");
    const wood = mat(C.wood, "wood");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(box([5.2, 0.2, 4.2], mat(C.darkStone, "stone"), { p: [0, 0.1, 0] }));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(box([0.2, 3, 0.2], wood, { p: [sx * 2.4, 1.6, sz * 1.9] }));
    add(prism([4.4, 1.3, 5.4], mat(C.roof, "wood"), { p: [0, 3.1, 0], r: [0, 90, 0] }));
    // Forge, chimney and glowing coals.
    add(box([1.6, 1.0, 1.4], stone, { p: [-1.4, 0.7, -1.1], tint: true }));
    add(box([1.0, 0.1, 0.8], mat(C.ember, "glow"), { p: [-1.4, 1.22, -1.0] }));
    add(box([0.9, 4.4, 0.9], stone, { p: [-1.4, 3.4, -1.5], tint: true }));
    // The forge light (10 cd, #ff8a3c) burns at night and flickers like a fire; the field's local-light rig owns it.
    const phase = ((o.seed || 0) % 100) / 10;
    const light = new THREE.PointLight("#ff8a3c", 10, 7, 2);
    light.position.set(-1.4, 1.5, -1.0);
    light.userData.fieldLight = { intensity: 10, fire: true, night: true, phase };
    root.add(light);
    // Chimney smoke, one puff a second, from the top of the stack (js/main.js syncEmitters feeds it to the particles).
    root.userData.emitters = [{ kind: "smoke", rate: 1, p: [-1.4, 5.65, -1.5], radius: 0.12, normal: [0, 1, 0], range: 40 }];
    // Anvil on a stump, a quench barrel and tools.
    add(cyl([0.3, 0.34, 0.6], mat(C.darkWood, "wood"), { p: [0.6, 0.5, 0.2], seg: 10 }));
    add(box([0.7, 0.22, 0.28], mat(C.iron, "metal"), { p: [0.6, 0.92, 0.2] }));
    add(cone([0.14, 0.3], mat(C.iron, "metal"), { p: [1.08, 0.94, 0.2], r: [0, 0, -90], seg: 8 }));
    add(cyl([0.35, 0.3, 0.8], wood, { p: [1.6, 0.6, -1.2], seg: 12 }));
    add(cyl([0.3, 0.3, 0.02], mat("#3a5a6b", "plastic"), { p: [1.6, 1.0, -1.2], seg: 12 }));
    for (let i = 0; i < 3; i++) add(box([0.05, 0.6, 0.05], mat(C.iron, "metal"), { p: [1.9 + 0, 1.8, 0.6 + i * 0.3 - 0.3] }));
    return finish(root, "blacksmith");
  },

  chapel(o) {
    const stone = mat(o.color || "#cfc6b2", "stone");
    const roof = mat(C.slate, "matte");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(box([5.6, 4.6, 8], stone, { p: [0, 2.3, -1.2], tint: true }));
    add(prism([5.6, 2.6, 8], stone, { p: [0, 4.6, -1.2], tint: true }));
    for (const s of [-1, 1]) add(box([3.3, 0.14, 8.6], roof, { p: [s * 1.45, 5.95, -1.2], r: [0, 0, s * -42] }));
    // Bell tower at the front with a spire.
    add(box([2.6, 7.4, 2.6], stone, { p: [0, 3.7, 3.9], tint: true }));
    add(box([2.0, 1.2, 2.7], mat("#1d1a16", "matte"), { p: [0, 6.3, 3.9] }));
    add(cone([0.35, 0.5], mat(C.gold, "gold"), { p: [0, 6.3, 3.9], seg: 10 }));
    add(cone([1.8, 3.4], roof, { p: [0, 9.1, 3.9], seg: 4, r: [0, 45, 0] }));
    add(box([0.08, 0.8, 0.08], mat(C.gold, "gold"), { p: [0, 11.2, 3.9] }));
    add(box([0.5, 0.08, 0.08], mat(C.gold, "gold"), { p: [0, 11.1, 3.9] }));
    add(box([1.2, 2.2, 0.1], mat(C.darkWood, "wood"), { p: [0, 1.1, 5.22] }));
    for (const s of [-1, 1]) for (let i = 0; i < 3; i++) add(box([0.1, 1.6, 0.7], mat("#5b7fb0", "glass"), { p: [s * 2.82, 2.6, -4 + i * 2.2] }));
    return finish(root, "chapel");
  },

  tavern(o) {
    const plaster = mat(o.color || "#e8dcc0", "matte");
    const timber = mat(C.darkWood, "wood");
    const root = group();
    const add = (...list) => list.forEach((m) => root.add(m));
    add(box([8, 0.3, 6], mat(C.darkStone, "stone"), { p: [0, 0.15, 0] }));
    add(box([7.6, 2.8, 5.6], mat(C.stone, "stone"), { p: [0, 1.7, 0] }));
    add(box([8.0, 2.6, 6.0], plaster, { p: [0, 4.4, 0], tint: true }));
    for (let i = -3; i <= 3; i++) add(box([0.16, 2.6, 0.08], timber, { p: [i * 1.3, 4.4, 3.04] }));
    add(box([8.0, 0.16, 0.08], timber, { p: [0, 3.15, 3.04] }));
    add(box([8.0, 0.16, 0.08], timber, { p: [0, 5.65, 3.04] }));
    add(prism([6.6, 1.9, 8.4], mat(C.thatch, "straw"), { p: [0, 5.7, 0], r: [0, 90, 0] }));
    // A stone chimney through the thatch (its top at the ridge height, so the part's size is unchanged) with smoke.
    add(box([0.7, 2.1, 0.7], mat(C.darkStone, "stone"), { p: [2.4, 6.55, -1.6], name: "chimney" }));
    root.userData.emitters = [{ kind: "smoke", rate: 1, p: [2.4, 7.62, -1.6], radius: 0.12, normal: [0, 1, 0], range: 40 }];
    add(box([1.3, 2.2, 0.1], mat(C.wood, "wood"), { p: [0, 1.4, 2.85] }));
    for (const s of [-1, 1]) add(box([1.0, 0.9, 0.1], mat("#f2c46b", "glow"), { p: [s * 2.4, 1.9, 2.82] }));
    // Hanging sign with a tankard.
    add(box([0.08, 0.08, 1.0], timber, { p: [2.0, 3.0, 3.4] }));
    add(box([0.06, 0.7, 0.8], mat(C.plank, "plank"), { p: [2.0, 2.55, 3.6], r: [0, 90, 0] }));
    add(cyl([0.14, 0.14, 0.3], mat(C.gold, "gold"), { p: [2.0, 2.55, 3.66], seg: 10 }));
    return finish(root, "tavern");
  },

  peasant(o) {
    const root = figure({ tunic: o.color || "#8a6b3f", hat: (o.seed || 0) % 2 ? "straw" : null });
    return finish(root, "peasant");
  },
};
