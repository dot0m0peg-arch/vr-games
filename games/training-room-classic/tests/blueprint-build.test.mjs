// Blueprint rendering: primitive lists from the model or the laptop parts bin become meshes.
import test from "node:test";
import assert from "node:assert/strict";
import { buildBlueprint, toHex } from "../js/parts/build/blueprint.js";
import { measure } from "../js/parts/build/kit.js";

const near = (actual, expected, eps = 0.01) => Math.abs(actual - expected) <= eps;
const meshesOf = (object) => {
  const list = [];
  object.traverse((child) => { if (child.isMesh) list.push(child); });
  return list;
};

const SNOWMAN = {
  name: "Snowman",
  parts: [
    { shape: "sphere", p: [0, 0.4, 0], s: [0.8, 0.8, 0.8], color: "white", mat: "matte" },
    { shape: "sphere", p: [0, 1.0, 0], s: [0.5, 0.5, 0.5], color: "#ffffff" },
    { shape: "cone", p: [0, 1.0, 0.35], s: [0.08, 0.3, 0.08], r: [90, 0, 0], color: "orange", mat: "plastic" },
  ],
};

test("3-part blueprint builds with the expected bounding box", () => {
  const object = buildBlueprint(SNOWMAN);
  assert.ok(object, "built");
  assert.equal(object.name, "snowman");
  assert.equal(meshesOf(object).length, 3);
  const { size, min, max } = measure(object);
  assert.ok(near(size[0], 0.8), `width ${size[0]}`);
  assert.ok(near(min[1], 0) && near(max[1], 1.25), `height ${min[1]}..${max[1]}`);
  // The nose (cone rotated 90° about X) points along +Z: 0.35 + 0.15.
  assert.ok(near(max[2], 0.5), `nose tip z ${max[2]}`);
  assert.ok(near(min[2], -0.4), `back z ${min[2]}`);
});

test("no re-centering: positions are used as given", () => {
  const object = buildBlueprint({ parts: [{ shape: "box", p: [5, 2, -3], s: [1, 2, 1], color: "#123456" }] });
  const { min, max } = measure(object);
  assert.deepEqual(min.map((n) => +n.toFixed(3)), [4.5, 1, -3.5]);
  assert.deepEqual(max.map((n) => +n.toFixed(3)), [5.5, 3, -2.5]);
  assert.equal(object.name, "custom");
});

test("each shape fits its bounding size", () => {
  for (const shape of ["box", "sphere", "cylinder", "cone", "capsule", "torus"]) {
    for (const s of [[0.4, 1.2, 0.4], [1, 0.3, 0.6], [0.5, 0.5, 0.5]]) {
      const object = buildBlueprint({ parts: [{ shape, p: [0, 0, 0], s, color: "red" }] });
      const { size } = measure(object);
      for (let i = 0; i < 3; i++) assert.ok(near(size[i], s[i], s[i] * 0.03 + 0.002), `${shape} ${s} axis ${i}: ${size[i]}`);
    }
  }
});

test("torus lies flat in the XZ plane (thickness along Y)", () => {
  const ring = buildBlueprint({ parts: [{ shape: "torus", p: [0, 0.05, 0], s: [1, 0.1, 1], color: "gold", mat: "gold" }] });
  const { size } = measure(ring);
  assert.ok(near(size[0], 1) && near(size[2], 1), `ring diameter ${size}`);
  assert.ok(near(size[1], 0.1), `ring thickness ${size[1]}`);
  // Rotated 90° about X it stands up like a wheel facing +Z.
  const wheel = buildBlueprint({ parts: [{ shape: "torus", p: [0, 0.5, 0], s: [1, 0.1, 1], r: [90, 0, 0], color: "black" }] });
  const w = measure(wheel).size;
  assert.ok(near(w[0], 1) && near(w[1], 1) && near(w[2], 0.1), `wheel ${w}`);
});

test("bad parts are skipped and bad fields fall back", () => {
  const object = buildBlueprint({
    name: "mixed",
    parts: [
      null, 42, "box", {},
      { shape: "pyramid", p: [0, 0, 0], s: [1, 1, 1], color: "red" },
      { shape: "box", p: [0, "x", 0], s: [1, 1, 1], color: "red" },
      { shape: "box", p: [0, 0, 0], s: [1, -1, 1], color: "red" },
      { shape: "box", p: [0, 0, 0], s: [1, NaN, 1], color: "red" },
      { shape: "box", p: [0, 0], s: [1, 1, 1], color: "red" },
      { shape: "box", p: [0, 1e9, 0], s: [1, 1, 1], color: "red" },
      { shape: "BOX", p: [0, 0.5, 0], s: [1, 1, 1], color: "not-a-color", mat: "unobtainium", r: "spin" },
      { shape: "cube", p: [0, 1.5, 0], s: 1, color: "Light Blue", mat: "Metal" },
    ],
  });
  const meshes = meshesOf(object);
  assert.equal(meshes.length, 2);
  assert.equal(object.userData.parts, 2);
  assert.equal(meshes[0].material.userData.kind, "matte");
  assert.equal("#" + meshes[0].material.color.getHexString(), "#cccccc");
  assert.equal(meshes[1].material.userData.kind, "metal");
  assert.equal("#" + meshes[1].material.color.getHexString(), "#add8e6");
  assert.deepEqual(meshes[0].rotation.toArray().slice(0, 3), [0, 0, 0]);
});

test("empty or invalid blueprints return null and never throw", () => {
  for (const bp of [undefined, null, 0, "dragon", [], {}, { parts: [] }, { parts: "box" }, { parts: [null, { shape: "box" }] }]) {
    assert.equal(buildBlueprint(bp), null, JSON.stringify(bp));
  }
  assert.doesNotThrow(() => buildBlueprint({ parts: [{ shape: "torus", p: [0, 0, 0], s: [1e-9, 1e9, 1], color: {} }] }, { color: 7 }));
});

test("caps at 96 parts", () => {
  const parts = Array.from({ length: 150 }, (_, i) => ({ shape: "box", p: [i * 0.1, 0.05, 0], s: [0.1, 0.1, 0.1], color: "#808080" }));
  const object = buildBlueprint({ parts });
  assert.equal(meshesOf(object).length, 96);
});

test("primary color is tinted and opts.color recolors it", () => {
  const bp = {
    parts: [
      { shape: "box", p: [0, 0.5, 0], s: [1, 1, 1], color: "#8b4513", mat: "wood" },
      { shape: "box", p: [0, 1.5, 0], s: [0.5, 1, 0.5], color: "#8b4513", mat: "wood" },
      { shape: "torus", p: [0, 2.05, 0], s: [0.6, 0.1, 0.6], color: "#8b4513", mat: "metal" },
      { shape: "sphere", p: [0, 2.3, 0], s: [0.3, 0.3, 0.3], color: "yellow", mat: "glow" },
    ],
  };
  const plain = buildBlueprint(bp);
  const tinted = meshesOf(plain).filter((m) => m.userData.tint);
  assert.equal(tinted.length, 3);
  assert.equal("#" + tinted[0].material.color.getHexString(), "#8b4513");

  const red = buildBlueprint(bp, { color: "#ff0000" });
  const meshes = meshesOf(red);
  for (const m of meshes.filter((x) => x.userData.tint)) assert.equal("#" + m.material.color.getHexString(), "#ff0000");
  const kinds = meshes.filter((x) => x.userData.tint).map((m) => m.material.userData.kind);
  assert.deepEqual(kinds, ["wood", "wood", "metal"], "tint keeps each part's material kind");
  const glow = meshes.find((x) => !x.userData.tint);
  assert.equal("#" + glow.material.color.getHexString(), "#ffff00");
});

test("ties for primary color go to the larger volume", () => {
  const object = buildBlueprint({
    parts: [
      { shape: "box", p: [0, 0.05, 0], s: [0.1, 0.1, 0.1], color: "red" },
      { shape: "box", p: [0, 1, 0], s: [2, 2, 2], color: "blue" },
    ],
  });
  const tinted = meshesOf(object).filter((m) => m.userData.tint);
  assert.equal(tinted.length, 1);
  assert.equal("#" + tinted[0].material.color.getHexString(), "#0000ff");
});

test("color parsing", () => {
  assert.equal(toHex("#ABC"), "#aabbcc");
  assert.equal(toHex("#d5fb6a"), "#d5fb6a");
  assert.equal(toHex("forest green"), "#228b22");
  assert.equal(toHex(0xff8800), "#ff8800");
  assert.equal(toHex("blurple"), null);
  assert.equal(toHex(undefined), null);
});

test("geometry is shared between builds (unit shapes are cached)", () => {
  const a = buildBlueprint({ parts: [{ shape: "cylinder", p: [0, 0.5, 0], s: [0.2, 1, 0.2], color: "gray" }] });
  const b = buildBlueprint({ parts: [{ shape: "cylinder", p: [0, 1, 0], s: [0.5, 2, 0.5], color: "gray" }] });
  assert.equal(meshesOf(a)[0].geometry, meshesOf(b)[0].geometry);
  assert.ok(meshesOf(a)[0].geometry.userData.shared);
});
