// Blueprint sanitizing: loose model output → clamped, re-centered primitive lists.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBlueprint, holdGrip, SHAPES, MATS, MAX_PARTS, slug } from "../js/core/blueprint.js";
import { COLORS } from "../js/core/lexicon.js";

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

test("constants", () => {
  assert.deepEqual(SHAPES, ["box", "sphere", "cylinder", "cone", "capsule", "torus"]);
  assert.deepEqual(MATS, ["matte", "wood", "metal", "glass", "glow", "stone", "fabric", "plastic"]);
  assert.equal(MAX_PARTS, 96);
});

test("accepts loose model output", () => {
  const { ok, blueprint, error } = normalizeBlueprint({
    name: "Dragon Statue!",
    aliases: ["Dragon", "dragon statue", 5],
    description: "a stone dragon",
    parts: [
      { type: "cube", position: ["0", "0.5", "0"], size: [2, "1", 1], color: "red", material: "stone" },
      { shape: "ball", pos: { x: 0, y: 1.5, z: 0 }, scale: 1, colour: "#00FF00" },
      { shape: "cylinder", p: "0, 2.5, 0", s: [0.2, 1, 0.2], rotation: [0, 0, 90], mat: "neon" },
      { shape: "teapot", p: [0, 0, 0], s: [1, 1, 1] },
      "garbage",
    ],
  });
  assert.equal(ok, true, error);
  assert.equal(blueprint.name, "dragon statue");
  assert.deepEqual(blueprint.aliases, ["dragon", "5"]);
  assert.equal(blueprint.desc, "a stone dragon");
  assert.equal(blueprint.parts.length, 3, "unknown shapes and garbage dropped");
  const [box, ball, rod] = blueprint.parts;
  assert.equal(box.shape, "box");
  assert.equal(box.color, COLORS.red);
  assert.equal(box.mat, "stone");
  assert.equal(ball.shape, "sphere");
  assert.deepEqual(ball.s, [1, 1, 1], "uniform scale number");
  assert.equal(ball.color, "#00ff00");
  assert.equal(ball.mat, "matte", "missing material defaults to matte");
  assert.equal(rod.mat, "glow");
  assert.deepEqual(rod.r, [0, 0, 90]);
  assert.equal(slug(blueprint.name), "dragon-statue");
});

test("re-centers to bottom-center and measures rotated bounds", () => {
  const { blueprint } = normalizeBlueprint({
    name: "pole",
    parts: [{ shape: "box", p: [5, 3, -2], s: [0.2, 2, 0.2], r: [0, 0, 90] }],
  });
  const [part] = blueprint.parts;
  // Rotated 90° about Z, the 2 m tall box lies along X.
  assert.ok(near(blueprint.size[0], 2), `width ${blueprint.size[0]}`);
  assert.ok(near(blueprint.size[1], 0.2), `height ${blueprint.size[1]}`);
  assert.ok(near(blueprint.size[2], 0.2));
  assert.ok(near(part.p[0], 0) && near(part.p[2], 0), "x/z centered");
  assert.ok(near(part.p[1], 0.1), "bottom at y = 0");
  const stack = normalizeBlueprint({
    parts: [
      { shape: "box", p: [0, -1, 0], s: [1, 1, 1] },
      { shape: "box", p: [3, 4, 0], s: [1, 1, 1] },
    ],
  }).blueprint;
  assert.deepEqual(stack.size, [4, 6, 1]);
  assert.ok(near(stack.parts[0].p[1], 0.5));
  assert.ok(near(stack.parts[0].p[0], -1.5) && near(stack.parts[1].p[0], 1.5));
  assert.equal(stack.name, "custom part");
  const spun = normalizeBlueprint({ parts: [{ shape: "box", s: [2, 1, 1], r: [0, 45, 0] }] }).blueprint;
  assert.ok(near(spun.size[0], (2 + 1) / Math.SQRT2), "45° yaw widens the footprint");
});

test("clamps sizes, positions, angles and part count", () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ shape: "box", p: [i * 0.01, 0, 0], s: [0.1, 0.1, 0.1] }));
  const { blueprint } = normalizeBlueprint({ name: "x", parts: many });
  assert.equal(blueprint.parts.length, 96);
  const huge = normalizeBlueprint({ parts: [{ shape: "box", p: [1e6, 0, 0], s: [1000, -5, 0], r: [720, -450, 30] }] }).blueprint;
  assert.deepEqual(huge.parts[0].s, [60, 5, 0.01]);
  assert.deepEqual(huge.parts[0].r, [0, -90, 30]);
  assert.ok(Math.abs(huge.parts[0].p[0]) <= 100);
});

test("holdable only when small; without a grip it is held by its shape", () => {
  const small = normalizeBlueprint({ holdable: true, parts: [{ shape: "cylinder", s: [0.1, 1, 0.1] }] }).blueprint;
  assert.equal(small.holdable, true);
  assert.deepEqual(small.grip, { p: [0, 0.15, 0], r: [-90, 0, 0] }, "tall: like the built-in tools, handle at the bottom");
  const cup = normalizeBlueprint({ holdable: true, parts: [{ shape: "cylinder", s: [0.08, 0.1, 0.08] }] }).blueprint;
  assert.deepEqual(cup.grip, { p: [0, 0.05, 0], r: [0, 0, 0] }, "small: by the middle");
  const gun = normalizeBlueprint({ holdable: true, parts: [{ shape: "box", p: [0, 0.1, 0], s: [0.05, 0.2, 0.6] }] }).blueprint;
  assert.deepEqual(gun.grip, { p: [0, 0.06, -0.15], r: [125, 0, 180] }, "long along z: aimed like the crossbow");
  assert.deepEqual(holdGrip([0.6, 0.1, 0.2]), { p: [0, 0.05, 0], r: [0, 0, 0] }, "wide: by the middle");
  const big = normalizeBlueprint({ holdable: true, parts: [{ shape: "box", s: [3, 1, 1] }] }).blueprint;
  assert.equal(big.holdable, false);
  const notAsked = normalizeBlueprint({ parts: [{ shape: "box", s: [0.1, 0.1, 0.1] }] }).blueprint;
  assert.equal(notAsked.holdable, false);
  const custom = normalizeBlueprint({ holdable: true, grip: { p: [0, 1, 0], r: [-90, 0, 0] }, parts: [{ shape: "box", p: [0, 1, 0], s: [0.1, 1, 0.1] }] }).blueprint;
  assert.deepEqual(custom.grip.r, [-90, 0, 0]);
  assert.ok(near(custom.grip.p[1], 0.5), "grip shifts with the re-centering");
});

test("rejects unusable input", () => {
  for (const bad of [null, 5, "nope", "{bad json", {}, { parts: [] }, { parts: [{ shape: "teapot" }] }, { parts: "box" }]) {
    const r = normalizeBlueprint(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.blueprint, null);
    assert.equal(typeof r.error, "string");
  }
  const fromJson = normalizeBlueprint(JSON.stringify({ name: "cube", parts: [{ shape: "box" }] }));
  assert.equal(fromJson.ok, true);
  assert.deepEqual(fromJson.blueprint.size, [0.5, 0.5, 0.5]);
  const fromArray = normalizeBlueprint([{ shape: "sphere", s: 2 }]);
  assert.equal(fromArray.ok, true);
});
