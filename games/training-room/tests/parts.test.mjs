// Parts bin consistency: every catalog entry has a builder whose mesh matches its declared size.
import test from "node:test";
import assert from "node:assert/strict";
import { allMeta } from "../js/parts/meta/index.js";
import { buildObject, hasBuilder } from "../js/parts/build/index.js";
import { measure } from "../js/parts/build/kit.js";

// PARTS_CATEGORY=combat,leisure limits the per-part checks while categories are being written.
const only = (process.env.PARTS_CATEGORY || "").split(",").filter(Boolean);
const metas = allMeta().filter((m) => !only.length || only.includes(m.category));
const CATEGORIES = new Set(["structures", "nature", "office", "leisure", "combat"]);

test("catalog entries are well formed and names/aliases do not collide", () => {
  const seen = new Map();
  for (const meta of metas) {
    assert.match(meta.name, /^[a-z0-9][a-z0-9 '-]*$/, `bad name ${meta.name}`);
    assert.ok(CATEGORIES.has(meta.category), `${meta.name}: category ${meta.category}`);
    assert.ok(typeof meta.desc === "string" && meta.desc.length > 3, `${meta.name}: desc`);
    assert.ok(Array.isArray(meta.size) && meta.size.length === 3 && meta.size.every((n) => n > 0), `${meta.name}: size`);
    assert.match(meta.color || "", /^#[0-9a-f]{6}$/i, `${meta.name}: color`);
    for (const phrase of [meta.name, ...(meta.aliases || [])]) {
      assert.equal(phrase, phrase.toLowerCase(), `${meta.name}: alias case ${phrase}`);
      assert.ok(!seen.has(phrase), `"${phrase}" used by both ${seen.get(phrase)} and ${meta.name}`);
      seen.set(phrase, meta.name);
    }
    if (meta.holdable) {
      assert.ok(Math.max(...meta.size) <= 2.2, `${meta.name}: holdable but too large`);
      assert.ok(meta.grip && meta.grip.p?.length === 3 && meta.grip.r?.length === 3, `${meta.name}: holdable needs grip`);
    }
    if (meta.tip) assert.equal(meta.tip.length, 3, `${meta.name}: tip`);
    if (meta.surface !== undefined) {
      assert.ok(meta.surface > 0 && meta.surface <= meta.size[1] + 0.01, `${meta.name}: surface height`);
      assert.ok(meta.surfaceSize?.length === 2, `${meta.name}: surfaceSize`);
    }
  }
});

test("every catalog entry has a builder", () => {
  for (const meta of metas) assert.ok(hasBuilder(meta.name), `missing builder for ${meta.name}`);
});

for (const meta of metas) {
  test(`builder "${meta.name}" matches its declared size and origin`, () => {
    const object = buildObject({ id: "t", part: meta.name, label: meta.name, p: [0, 0, 0], ry: 0, s: 1, data: {} });
    assert.ok(!object.userData.meta.placeholder, "fell back to placeholder");
    const { size, min, max } = measure(object.userData.inner);
    for (let i = 0; i < 3; i++) {
      const tolerance = Math.max(0.05, meta.size[i] * 0.12);
      assert.ok(Math.abs(size[i] - meta.size[i]) <= tolerance, `${meta.name}: axis ${"xyz"[i]} built ${size[i].toFixed(3)} vs meta ${meta.size[i]}`);
    }
    assert.ok(Math.abs(min[1]) <= 0.03, `${meta.name}: bottom at y=${min[1].toFixed(3)}, expected 0`);
    const cx = (min[0] + max[0]) / 2;
    const cz = (min[2] + max[2]) / 2;
    assert.ok(Math.abs(cx) <= Math.max(0.05, meta.size[0] * 0.1), `${meta.name}: off-center x ${cx.toFixed(3)}`);
    assert.ok(Math.abs(cz) <= Math.max(0.05, meta.size[2] * 0.1), `${meta.name}: off-center z ${cz.toFixed(3)}`);
  });
}

test("catalog is big enough to be fun", { skip: only.length > 0 }, () => {
  assert.ok(metas.length >= 50, `only ${metas.length} parts`);
});
