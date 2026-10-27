import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PartsBin } from "../bridge/parts-bin.mjs";

const part = (name) => ({
  name, category: "kitchen", desc: "Household equipment",
  holdable: true,
  parts: [{ shape: "box", p: [0, .1, 0], s: [.2, .2, .2], color: "#bbbbbb", mat: "metal" }],
});

test("bulk catalog bundles load, normalize, deduplicate, and preserve individual JSON support", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "training-room-household-test-"));
  const bin = new PartsBin({ dirs: [root], log: { warn() {} } });
  try {
    await fs.writeFile(path.join(root, "sample.catalog.json"), JSON.stringify({
      format: "training-room-catalog-v1",
      blueprints: [part("rice cooker"), part("leaf rake"), { name: "bad item", parts: [] }],
    }));
    await fs.writeFile(path.join(root, "solo.json"), JSON.stringify(part("door mat")));
    const scan = await bin.scan();
    assert.equal(scan.count, 3);
    assert.deepEqual(new Set(bin.entries.map(e => e.name)), new Set(["rice cooker", "leaf rake", "door mat"]));
    assert.ok(bin.entries.every(e => e.kind === "blueprint"));
    assert.ok(bin.entries.every(e => e.stamp));
    assert.ok(bin.entries.every(e => e.blueprint?.size?.every(n => n > 0)));
    assert.equal(bin.manifest().parts.length, 3);
    // Updating a batch invalidates the per-file cache and refreshes all entries.
    await fs.writeFile(path.join(root, "sample.catalog.json"), JSON.stringify({
      blueprints: [part("rice cooker"), part("rice cooker"), part("leaf rake"), part("garden trowel")],
    }));
    const updated = await bin.scan();
    assert.equal(updated.count, 4);
    assert.equal(new Set(bin.entries.map(e => e.name)).size, 4);
  } finally {
    bin.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});
