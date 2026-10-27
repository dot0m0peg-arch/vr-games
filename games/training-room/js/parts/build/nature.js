// nature parts: builders keyed by meta name (see ARCHITECTURE.md).
// Origin is the bottom-center of each part's bounding box and fronts face +Z.
import { kit } from "./kit.js";

const { THREE, box, cyl, sphere, cone, torus, capsule, lathe, extrude, group, mat, finish, DEG } = kit;

const BARK = "#6b4a30";
const UP = new THREE.Vector3(0, 1, 0);
const DIR = new THREE.Vector3();
const TMP = new THREE.Color();

// Mesh whose local +Y runs from a to b (branches, logs, limbs).
function between(make, a, b, o = {}) {
  DIR.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = DIR.length() + (o.extra || 0);
  const m = make(len, { tint: o.tint, p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] });
  m.quaternion.setFromUnitVectors(UP, DIR.normalize());
  return m;
}
const branch = (a, b, rt, rb, material, o = {}) => between((len, oo) => cyl([rt, rb, len], material, { seg: o.seg || 7, ...oo }), a, b, o);

// Darker/lighter variant of a hex color (build time only).
function shade(hex, k) {
  return `#${TMP.set(hex).multiplyScalar(k).getHexString()}`;
}

// Leaf/stone blobs: [x, y, z, radius, sx?, sy?, sz?] spheres, optionally alternating two materials.
function blobs(parent, list, materials, o = {}) {
  list.forEach(([x, y, z, r, sx = 1, sy = 1, sz = 1, ry = 0], i) => {
    parent.add(sphere(r, materials[i % materials.length], { p: [x, y, z], s: [sx, sy, sz], r: [0, ry, 0], seg: o.seg || 10, tint: o.tint }));
  });
}

// Small quarter-turn variation so a row of trees does not look stamped.
const turn = (o) => ((o.seed || 0) % 4) * 90;

export const builders = {
  tree(o) {
    const base = o.color || "#4f8a3a";
    const leaves = [mat(base, "leaf"), mat(shade(base, 0.82), "leaf")];
    const bark = mat(BARK, "bark");
    const root = group();
    const g = group([], { r: [0, turn(o), 0] });
    g.add(lathe([[0.001, 0], [0.5, 0], [0.34, 0.2], [0.27, 0.9], [0.22, 2.9], [0.001, 2.9]], bark, { seg: 10 }));
    g.add(branch([0, 2.2, 0], [0.95, 3.4, 0.2], 0.07, 0.12, bark));
    g.add(branch([0, 2.4, 0], [-0.85, 3.5, -0.35], 0.07, 0.12, bark));
    g.add(branch([0, 2.5, 0], [0.1, 3.5, 0.95], 0.06, 0.11, bark));
    blobs(g, [
      [0, 4.2, 0, 1.55], [1.2, 3.8, 0.3, 1.1], [-1.1, 3.9, -0.4, 1.15], [0.2, 3.7, 1.15, 1.0],
      [-0.3, 3.8, -1.2, 1.0], [0.4, 4.9, -0.2, 1.1], [-0.7, 4.6, 0.6, 0.95],
    ], leaves, { tint: true });
    root.add(g);
    return finish(root, "tree");
  },

  "pine tree"(o) {
    const base = o.color || "#2f5d3a";
    const leaves = [mat(base, "leaf"), mat(shade(base, 1.18), "leaf")];
    const root = group();
    root.add(cyl([0.12, 0.2, 1.4], mat(BARK, "bark"), { p: [0, 0.7, 0], seg: 8 }));
    const tiers = [[1.4, 2.0, 1.9], [1.15, 1.9, 3.0], [0.85, 1.7, 4.1], [0.52, 1.5, 5.15]];
    tiers.forEach(([r, h, y], i) => root.add(cone([r, h], leaves[i % 2], { p: [0, y, 0], r: [0, i * 17, 0], seg: 10, tint: true })));
    return finish(root, "pine tree");
  },

  "palm tree"(o) {
    const frond = mat(o.color || "#5c9a3c", "leaf");
    const trunk = [mat("#8d6e4c", "bark"), mat("#715639", "bark")];
    const root = group();
    const pts = [[-0.48, 0.03, 0], [-0.42, 1.1, 0], [-0.31, 2.2, 0], [-0.18, 3.3, 0], [-0.09, 4.4, 0], [-0.06, 5.35, 0]];
    for (let i = 0; i < pts.length - 1; i++) {
      root.add(branch(pts[i], pts[i + 1], 0.17 - i * 0.015, 0.2 - i * 0.015, trunk[i % 2], { seg: 8, extra: 0.04 }));
    }
    const crown = [-0.06, 5.4, 0];
    const blade1 = [[0, 0], [0.25, 0.2], [0.7, 0.3], [1.2, 0.26], [1.2, -0.26], [0.7, -0.3], [0.25, -0.2]];
    const blade2 = [[0, 0.26], [0.5, 0.22], [1.15, 0], [0.5, -0.22], [0, -0.26]];
    for (let i = 0; i < 9; i++) {
      const roll = -90 + (i % 2 ? 22 : -22);
      const tip = group([extrude(blade2, 0.02, frond, { r: [roll, 0, 0], tint: true })], { p: [1.18, 0, 0], r: [0, 0, -38 - (i % 3) * 7] });
      const seg1 = group([extrude(blade1, 0.02, frond, { r: [roll, 0, 0], tint: true }), tip], { r: [0, 0, 16 - (i % 3) * 9] });
      root.add(group([seg1], { p: crown, r: [0, i * 40 + 10, 0] }));
    }
    for (const [x, z] of [[0.2, 0.12], [-0.02, 0.16], [0.14, -0.14]]) root.add(sphere(0.11, mat("#5a3d22", "wood"), { p: [crown[0] + x, 5.24, z], seg: 8 }));
    return finish(root, "palm tree");
  },

  bush(o) {
    const base = o.color || "#4a7f38";
    const root = group();
    blobs(root, [
      [0, 0.5, 0, 0.55, 1.15, 0.9, 1.05], [0.45, 0.4, 0.1, 0.4], [-0.45, 0.42, -0.05, 0.42],
      [0.1, 0.38, 0.38, 0.38], [-0.1, 0.4, -0.36, 0.4], [0.12, 0.8, -0.05, 0.33],
    ], [mat(base, "leaf"), mat(shade(base, 0.8), "leaf")], { tint: true });
    const berry = mat("#d6324a", "plastic");
    for (const [x, y, z] of [[0.3, 0.72, 0.36], [-0.35, 0.62, 0.3], [0.62, 0.5, 0.18], [-0.1, 0.92, 0.2], [0.05, 0.45, 0.74]]) {
      root.add(sphere(0.045, berry, { p: [x, y, z], seg: 6 }));
    }
    return finish(root, "bush");
  },

  rock(o) {
    const base = o.color || "#8f8d86";
    const root = group();
    blobs(root, [
      [0, 0.3, 0, 1, 0.45, 0.31, 0.38, 20], [0.24, 0.19, 0.12, 1, 0.26, 0.19, 0.24, 60], [-0.22, 0.16, -0.1, 1, 0.24, 0.16, 0.22, 10],
    ], [mat(base, "rock"), mat(shade(base, 0.85), "rock")], { seg: 7, tint: true });
    return finish(root, "rock");
  },

  boulder(o) {
    const base = o.color || "#878580";
    const root = group();
    blobs(root, [
      [0, 0.85, 0, 1, 1.15, 0.86, 1.0, 15], [0.7, 0.55, 0.35, 1, 0.65, 0.55, 0.6, 50],
      [-0.75, 0.5, -0.2, 1, 0.6, 0.5, 0.62, 80], [0.2, 0.42, -0.65, 1, 0.7, 0.42, 0.45, 30],
    ], [mat(base, "rock"), mat(shade(base, 0.86), "rock"), mat(shade(base, 1.08), "rock")], { seg: 8, tint: true });
    root.add(sphere(1, mat("#5d7d3a", "leaf"), { p: [-0.15, 1.58, 0.1], s: [0.62, 0.12, 0.5], seg: 10 }));
    root.add(sphere(1, mat("#6f8f45", "leaf"), { p: [0.55, 1.02, 0.55], s: [0.3, 0.07, 0.28], seg: 8 }));
    return finish(root, "boulder");
  },

  pebble(o) {
    const root = group();
    root.add(sphere(1, mat(o.color || "#9a958b", "rock"), { p: [0, 0.035, 0], s: [0.06, 0.035, 0.05], seg: 10, tint: true }));
    return finish(root, "pebble");
  },

  flowers(o) {
    const root = group();
    root.add(cyl([1, 1, 0.12], mat("#4a3424", "matte"), { p: [0, 0.06, 0], s: [0.68, 1, 0.48], seg: 14 }));
    blobs(root, [[-0.3, 0.12, 0.05, 0.2, 1.3, 0.5, 1], [0.25, 0.12, -0.1, 0.22, 1.3, 0.5, 1], [0.45, 0.12, 0.2, 0.15, 1.2, 0.5, 1], [-0.05, 0.12, 0.25, 0.16, 1.4, 0.5, 1]],
      [mat("#3f7a34", "leaf"), mat("#4f8c3c", "leaf")], { seg: 8 });
    const blooms = [mat(o.color || "#e86aa6", "plastic"), mat("#f2d24b", "plastic"), mat("#f4f1ea", "plastic"), mat("#9a63d6", "plastic")];
    const stem = mat("#3c6e2e", "leaf");
    const spots = [[-0.45, 0.08, 0.32], [-0.22, -0.22, 0.42], [0.02, 0.14, 0.36], [0.3, -0.12, 0.4], [0.5, 0.15, 0.3], [-0.05, -0.05, 0.27], [0.22, 0.24, 0.3], [-0.3, -0.05, 0.38]];
    spots.forEach(([x, z, h], i) => {
      root.add(cyl([0.012, 0.012, h], stem, { p: [x, h / 2 + 0.06, z], seg: 5 }));
      root.add(sphere(0.07, blooms[i % 4], { p: [x, h + 0.08, z], s: [1, 0.55, 1], seg: 8, tint: i % 4 === 0 }));
    });
    return finish(root, "flowers");
  },

  campfire(o) {
    const root = group();
    const stones = [mat("#7f7c76", "rock"), mat("#9a968e", "rock")];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      root.add(sphere(1, stones[i % 2], { p: [Math.sin(a) * 0.48, 0.07, Math.cos(a) * 0.48], s: [0.13, 0.08, 0.11], r: [0, i * 40, 0], seg: 6 }));
    }
    const wood = mat("#6e4a2c", "bark");
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      root.add(branch([Math.sin(a) * 0.4, 0.05, Math.cos(a) * 0.4], [Math.sin(a) * 0.03, 0.34, Math.cos(a) * 0.03], 0.04, 0.055, wood));
    }
    root.add(cyl([0.3, 0.32, 0.04], mat("#ff5a1f", "glow"), { p: [0, 0.03, 0], seg: 12 }));
    const orange = mat("#ff6a12", "glow");
    const amber = mat("#ff9a2e", "glow");
    const flames = [
      cone([0.15, 0.72], orange, { p: [0, 0.42, 0], seg: 6 }),
      cone([0.1, 0.5], amber, { p: [0.12, 0.31, 0.04], r: [0, 0, -12], seg: 5 }),
      cone([0.1, 0.56], amber, { p: [-0.11, 0.33, 0.05], r: [8, 0, 10], seg: 5 }),
      cone([0.09, 0.44], orange, { p: [0.02, 0.28, -0.12], r: [-12, 0, 0], seg: 5 }),
      cone([0.08, 0.4], orange, { p: [0.03, 0.27, 0.13], r: [12, 0, 0], seg: 5 }),
      cone([0.08, 0.38], mat("#ffe066", "glow"), { p: [0, 0.27, 0], seg: 5 }),
    ];
    flames.forEach((m) => root.add(m));
    const phase = ((o.seed || 0) % 100) / 10;
    const light = new THREE.PointLight("#ff9a3c", 10, 9, 2);
    light.position.y = .35; light.userData.fieldLight = { intensity: 10, fire: true, phase }; root.add(light);
    // Continuous effects while in view (LOOK-BIBLE.md section 7): embers 5/s out of the flames, smoke 2/s above them. The
    // game's frame loop feeds these to the dot3d particle emitters (js/main.js syncEmitters); p is part-local, scaled with the record.
    root.userData.emitters = [
      { kind: "ember", rate: 5, p: [0, 0.45, 0], radius: 0.14, normal: [0, 1, 0], range: 30 },
      { kind: "smoke", rate: 2, p: [0, 0.75, 0], radius: 0.08, normal: [0, 1, 0], range: 30 },
    ];
    root.userData.update = (dt, t) => {
      const u = t + phase;
      for (let i = 0; i < flames.length; i++) {
        const k = 1 + Math.sin(u * (9 + i * 2.3) + i) * 0.14 + Math.sin(u * 23 + i * 1.7) * 0.06;
        flames[i].scale.set(1 + (1 - k) * 0.5, k, 1 + (1 - k) * 0.5);
        flames[i].rotation.y = u * (0.8 + i * 0.3);
      }
    };
    return finish(root, "campfire");
  },

  pond(o) {
    const root = group();
    root.add(cyl([1, 1, 0.03], mat("#6b5a3e", "matte"), { p: [0, 0.015, 0], s: [1.6, 1, 1.3], seg: 20 }));
    root.add(cyl([1, 1, 0.06], mat(o.color || "#3d7f99", "plastic"), { p: [0, 0.03, 0], s: [1.45, 1, 1.15], seg: 20, tint: true }));
    const stones = [mat("#8a877f", "rock"), mat("#a29e95", "rock")];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.2;
      root.add(sphere(1, stones[i % 2], { p: [Math.sin(a) * 1.5, 0.05, Math.cos(a) * 1.2], s: [0.13 + (i % 3) * 0.03, 0.06, 0.1], r: [0, i * 37, 0], seg: 6 }));
    }
    const pad = mat("#4f8a3a", "leaf");
    for (const [x, z, r] of [[-0.5, 0.2, 0.18], [0.35, -0.3, 0.15], [0.6, 0.35, 0.13]]) root.add(cyl([r, r, 0.01], pad, { p: [x, 0.066, z], seg: 10 }));
    root.add(sphere(0.06, mat("#f3a6c8", "plastic"), { p: [-0.5, 0.09, 0.2], s: [1, 0.6, 1], seg: 8 }));
    const ripple = torus([0.3, 0.012], mat("#bfe3ee", "plastic"), { p: [0.1, 0.064, -0.05], r: [90, 0, 0], seg: 24 });
    root.add(ripple);
    root.userData.update = (dt, t) => {
      const k = (t * 0.35) % 1;
      ripple.scale.set(1 + k * 2.6, 1 + k * 2.2, 1);
    };
    return finish(root, "pond");
  },

  log(o) {
    const bark = mat(o.color || "#6b4a30", "bark");
    const ring = mat("#c9a26b", "wood");
    const root = group();
    root.add(cyl([0.24, 0.26, 2.2], bark, { p: [0, 0.25, 0], r: [0, 0, 90], seg: 10, tint: true }));
    for (const s of [-1, 1]) {
      root.add(cyl([0.21, 0.21, 0.02], ring, { p: [s * 1.105, 0.25, 0], r: [0, 0, 90], seg: 10 }));
      root.add(torus([0.11, 0.012], mat("#9c7646", "wood"), { p: [s * 1.116, 0.25, 0], r: [0, 90, 0], seg: 16 }));
    }
    root.add(branch([0.35, 0.42, 0.05], [0.55, 0.62, 0.15], 0.04, 0.06, bark));
    root.add(sphere(1, mat("#5f8a3a", "leaf"), { p: [-0.4, 0.46, 0], s: [0.45, 0.06, 0.2], seg: 10 }));
    root.add(cyl([0.02, 0.025, 0.08], mat("#efe6d0", "matte"), { p: [0.75, 0.08, 0.24], seg: 6 }));
    root.add(sphere(0.06, mat("#c4673c", "matte"), { p: [0.75, 0.12, 0.24], s: [1, 0.55, 1], seg: 8 }));
    return finish(root, "log");
  },

  stump(o) {
    const bark = mat(o.color || "#6b4a30", "bark");
    const root = group();
    root.add(lathe([[0.001, 0], [0.42, 0], [0.33, 0.1], [0.3, 0.3], [0.29, 0.47], [0.001, 0.47]], bark, { seg: 10, tint: true }));
    root.add(cyl([0.27, 0.27, 0.04], mat("#d1ab74", "wood"), { p: [0, 0.47, 0], seg: 12 }));
    for (const r of [0.18, 0.09]) root.add(torus([r, 0.008], mat("#a5814e", "wood"), { p: [0, 0.49, 0], r: [90, 0, 0], seg: 16 }));
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.5;
      root.add(branch([Math.sin(a) * 0.24, 0.12, Math.cos(a) * 0.24], [Math.sin(a) * 0.46, 0.075, Math.cos(a) * 0.46], 0.035, 0.065, bark));
    }
    root.add(sphere(1, mat("#5f8a3a", "leaf"), { p: [-0.18, 0.12, 0.26], s: [0.16, 0.08, 0.1], seg: 8 }));
    return finish(root, "stump");
  },

  mushroom(o) {
    const capM = mat(o.color || "#d23a30", "plastic");
    const cream = mat("#efe6d0", "matte");
    const root = group();
    root.add(lathe([[0.001, 0], [0.26, 0], [0.2, 0.15], [0.16, 0.8], [0.18, 1.22], [0.001, 1.22]], cream, { seg: 12 }));
    root.add(cyl([0.22, 0.27, 0.07], cream, { p: [0, 0.95, 0], seg: 12 }));
    root.add(cyl([0.68, 0.68, 0.02], mat("#e2d3b4", "matte"), { p: [0, 1.17, 0], seg: 20 }));
    const a = 0.7;
    const b = 0.62;
    const y0 = 1.18;
    const prof = [90, 70, 50, 30, 15, 0].map((d) => [Math.max(0.001, a * Math.sin(d * DEG)), y0 + b * Math.cos(d * DEG)]);
    root.add(lathe(prof, capM, { seg: 20, tint: true }));
    const white = mat("#fbf8f0", "matte");
    const n = new THREE.Vector3();
    for (const [phi, theta] of [[25, 20], [48, 95], [55, 200], [40, 290], [62, 340], [10, 150], [66, 140]]) {
      const ph = phi * DEG;
      const th = theta * DEG;
      const p = [a * Math.sin(ph) * Math.sin(th), y0 + b * Math.cos(ph), a * Math.sin(ph) * Math.cos(th)];
      const spot = sphere(0.085, white, { p, s: [1, 0.35, 1], seg: 8 });
      n.set(p[0] / (a * a), (p[1] - y0) / (b * b), p[2] / (a * a)).normalize();
      spot.quaternion.setFromUnitVectors(UP, n);
      root.add(spot);
    }
    return finish(root, "mushroom");
  },

  "hay bale"(o) {
    const hay = mat(o.color || "#d9b65a", "straw");
    const root = group();
    root.add(box([1.2, 0.72, 0.8], hay, { p: [0, 0.36, 0], tint: true }));
    const flake = mat("#c29d45", "straw");
    for (const x of [-0.42, -0.14, 0.14, 0.42]) {
      root.add(box([0.02, 0.7, 0.81], flake, { p: [x, 0.36, 0] }));
    }
    const twine = mat("#7d5b2a", "fabric");
    for (const x of [-0.3, 0.3]) root.add(box([0.03, 0.735, 0.815], twine, { p: [x, 0.3675, 0] }));
    const straw = mat("#ecd389", "straw");
    for (const [x, z, rz, rx] of [[-0.45, 0.2, 25, 0], [0.2, -0.25, -30, 10], [0.5, 0.1, 15, -20], [-0.1, 0.3, -20, 25], [0.35, -0.3, 35, 0]]) {
      root.add(box([0.015, 0.16, 0.015], straw, { p: [x, 0.74, z], r: [rx, 0, rz] }));
    }
    return finish(root, "hay bale");
  },

  cactus(o) {
    const green = mat(o.color || "#4f8a4a", "matte");
    const root = group();
    root.add(capsule([0.22, 1.9], green, { p: [0, 1.17, 0], tint: true }));
    root.add(capsule([0.13, 0.32], green, { p: [0.3, 1.0, 0], r: [0, 0, 90], tint: true }));
    root.add(capsule([0.13, 0.5], green, { p: [0.46, 1.25, 0], tint: true }));
    root.add(capsule([0.12, 0.28], green, { p: [-0.28, 0.75, 0], r: [0, 0, 90], tint: true }));
    root.add(capsule([0.12, 0.42], green, { p: [-0.43, 0.97, 0], tint: true }));
    const rib = mat(shade(o.color || "#4f8a4a", 0.78), "matte");
    for (const a of [0, 120, 240]) {
      const rad = a * DEG;
      root.add(box([0.03, 1.7, 0.03], rib, { p: [Math.sin(rad) * 0.215, 1.15, Math.cos(rad) * 0.215], r: [0, a, 0] }));
    }
    for (const [x, y, z] of [[0.05, 2.33, 0.04], [-0.07, 2.3, -0.05], [0.46, 1.62, 0.02]]) root.add(sphere(0.05, mat("#f06aa0", "plastic"), { p: [x, y, z], seg: 8 }));
    return finish(root, "cactus");
  },

  crystal(o) {
    const crystalM = mat(o.color || "#a98bff", "plastic");
    const core = mat("#7d5cff", "glow");
    const root = group();
    root.add(sphere(1, mat("#6d6a73", "rock"), { p: [0, 0.18, 0], s: [0.55, 0.18, 0.48], seg: 8 }));
    const shards = [[0, 0, 0.13, 1.1, 0, 0, true], [0.24, 0.1, 0.1, 0.7, 0, -22, false], [-0.22, 0.05, 0.1, 0.8, 12, 20, false],
      [0.05, -0.24, 0.09, 0.6, -20, 5, false], [-0.1, 0.24, 0.08, 0.5, 22, -10, false]];
    for (const [x, z, r, h, rx, rz, glow] of shards) {
      const m = glow ? core : crystalM;
      root.add(group([
        cyl([r, r, h], m, { p: [0, h / 2, 0], seg: 6, tint: !glow }),
        cone([r, r * 2.4], m, { p: [0, h + r * 1.2, 0], seg: 6, tint: !glow }),
      ], { p: [x, 0.18, z], r: [rx, 0, rz] }));
    }
    return finish(root, "crystal");
  },

  "birch tree"(o) {
    const base = o.color || "#8fbf4a";
    const white = mat("#ece9e1", "wood");
    const dark = mat("#2e2b28", "matte");
    const root = group();
    const g = group([], { r: [0, turn(o), 0] });
    g.add(cyl([0.1, 0.17, 5.0], white, { p: [0, 2.5, 0], seg: 8 }));
    for (const [y, a] of [[0.6, 0], [1.3, 110], [2.0, 230], [2.7, 40], [3.4, 170], [4.1, 300]]) {
      const r = 0.16 - y * 0.012;
      g.add(box([0.12, 0.04, 0.02], dark, { p: [Math.sin(a * DEG) * r, y, Math.cos(a * DEG) * r], r: [0, a, 0] }));
    }
    g.add(branch([0, 3.0, 0], [0.55, 3.9, 0.1], 0.03, 0.05, white));
    g.add(branch([0, 3.4, 0], [-0.5, 4.2, -0.15], 0.03, 0.05, white));
    blobs(g, [[0, 4.95, 0, 0.95, 1, 1.3, 1], [0.62, 4.15, 0.15, 0.75, 1, 1.3, 1], [-0.6, 4.35, -0.2, 0.78, 1, 1.3, 1], [0.1, 3.85, -0.6, 0.68, 1, 1.25, 1], [-0.15, 3.95, 0.62, 0.7, 1, 1.3, 1], [0.2, 3.3, 0.1, 0.55, 1, 1.2, 1]],
      [mat(base, "leaf"), mat(shade(base, 0.82), "leaf")], { tint: true });
    root.add(g);
    return finish(root, "birch tree");
  },

  "dead tree"(o) {
    const wood = mat(o.color || "#5d5045", "wood");
    const root = group();
    const g = group([], { r: [0, turn(o), 0] });
    g.add(lathe([[0.001, 0], [0.42, 0], [0.28, 0.25], [0.22, 1.2], [0.16, 2.6], [0.001, 2.6]], wood, { seg: 8, tint: true }));
    const limbs = [
      [[0, 2.2, 0], [1.0, 3.3, 0.2], 0.06, 0.12], [[0, 2.4, 0], [-0.9, 3.5, -0.3], 0.06, 0.12], [[0, 2.5, 0], [0.15, 4.0, -0.2], 0.05, 0.12],
      [[0, 1.6, 0], [-0.3, 2.4, 0.75], 0.05, 0.09], [[0, 1.9, 0], [0.35, 2.7, -0.8], 0.04, 0.08], [[1.0, 3.3, 0.2], [1.25, 3.85, 0.05], 0.025, 0.05], [[1.0, 3.3, 0.2], [1.1, 4.1, 0.55], 0.025, 0.05],
      [[-0.9, 3.5, -0.3], [-1.2, 3.85, -0.5], 0.025, 0.05], [[-0.9, 3.5, -0.3], [-0.85, 4.3, -0.1], 0.025, 0.05], [[0.15, 4.0, -0.2], [0.4, 4.7, -0.3], 0.02, 0.045],
      [[0.15, 4.0, -0.2], [-0.25, 4.6, 0.1], 0.02, 0.045], [[-0.3, 2.4, 0.75], [-0.5, 3.0, 1.05], 0.02, 0.045], [[0.35, 2.7, -0.8], [0.5, 3.2, -1.1], 0.02, 0.04],
    ];
    for (const [a, b, rt, rb] of limbs) g.add(branch(a, b, rt, rb, wood, { tint: true, extra: 0.04 }));
    root.add(g);
    return finish(root, "dead tree");
  },

  stick(o) {
    const wood = mat(o.color || "#8a6340", "wood");
    const root = group();
    root.add(cyl([0.022, 0.03, 1.2], wood, { p: [0, 0.6, 0], seg: 7, tint: true }));
    root.add(branch([0.01, 0.78, 0], [0.07, 0.88, 0.01], 0.008, 0.014, wood, { seg: 5 }));
    root.add(branch([-0.01, 0.45, 0], [-0.06, 0.52, -0.02], 0.008, 0.013, wood, { seg: 5 }));
    root.add(sphere(0.032, mat("#6a4a2e", "wood"), { p: [0, 0.32, 0.005], s: [1, 1.4, 1], seg: 6 }));
    return finish(root, "stick");
  },
};
