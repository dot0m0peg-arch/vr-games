// The remaster capture spots and fixed scene (js/capture.js): six named spots the before/after sheet reuses, and a
// scene of real catalog records that the room state accepts and that stays inside what the spots look at.
// Claude (Command), Oct 26 2026.
import test from "node:test";
import assert from "node:assert/strict";
import { SPOTS, captureScene } from "../js/capture.js";
import { loadState } from "../js/core/room-state.js";
import { getMeta } from "../js/parts/meta/index.js";

test("six fixed spots with unique names, numeric positions and a known time of day", () => {
  assert.equal(SPOTS.length, 6);
  assert.equal(new Set(SPOTS.map((s) => s.name)).size, 6);
  for (const s of SPOTS) {
    assert.match(s.name, /^[a-z0-9-]+$/, s.name);
    assert.equal(s.position.length, 3);
    assert.equal(s.target.length, 3);
    assert.ok([...s.position, ...s.target].every(Number.isFinite), s.name);
    assert.ok(s.fov >= 40 && s.fov <= 90, s.name + " fov");
    assert.ok(["day", "sunset", "night", "dawn"].includes(s.time), s.name + " time");
    assert.ok(typeof s.shows === "string" && s.shows.length > 20, s.name + " says what it shows");
  }
  assert.equal(SPOTS.filter((s) => s.kingdom).length, 1, "one Kingdom shot");
  assert.equal(SPOTS.filter((s) => s.time !== "day").length, 1, "one shot at another time of day");
});

test("the fixed scene loads as room state: built-in parts only, on the ground or on a table", () => {
  const scene = captureScene();
  const state = loadState(scene);
  assert.ok(state.order.length >= 24, "a lived-in yard");
  assert.equal(state.order.length, Object.keys(state.objects).length);
  assert.equal(state.env.time, "day");
  for (const id of state.order) {
    const r = state.objects[id];
    assert.ok(r, id + " survived loadState");
    assert.ok(getMeta(r.part) || r.data?.blueprint, id + ": " + r.part + " is a catalog part or a blueprint");
    if (r.onto) {
      assert.ok(state.objects[r.onto], id + " sits on a record that exists");
      assert.ok(r.p[1] > 0.5, id + " sits at the table top");
    } else assert.ok(r.p[1] <= 0.03 || r.part === "crate", id + " stands on the ground");
  }
  assert.deepEqual(scene.order.filter((id) => scene.objects[id].part === "crate").map((id) => scene.objects[id].p[1]), [0, 0.9, 1.8], "crates stacked flush");
});

test("every spot looks at something in the scene", () => {
  const scene = captureScene();
  const records = Object.values(scene.objects);
  for (const s of SPOTS) {
    const near = records.filter((r) => Math.hypot(r.p[0] - s.target[0], r.p[2] - s.target[2]) < (s.name === "sunset-horizon" ? 80 : 6));
    assert.ok(near.length >= 1, s.name + " looks at nothing");
  }
});
