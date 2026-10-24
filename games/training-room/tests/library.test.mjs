// The library loader (js/parts/library/index.js) and the laptop parts bin's batch files. The library
// content itself is checked in library-content.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLibraryFile, takenNames } from "../js/parts/library/index.js";
import { BUILTIN } from "../js/parts/meta/index.js";
import { PartsBin } from "../bridge/parts-bin.mjs";

const quiet = { log() {}, warn() {}, error() {} };

test("readLibraryFile: built-in names win, duplicates and broken entries are reported", () => {
  const taken = takenNames(BUILTIN);
  const shape = { shape: "box", p: [0, 0.1, 0], s: [0.2, 0.2, 0.2], color: "#ff0000" };
  const doc = { category: "Test", parts: [
    { name: "Toy Drum", aliases: ["drum toy", "villa"], desc: "a drum", parts: [shape, shape, shape] },
    { name: "heavy brick", holdable: false, desc: "stays put", parts: [shape, shape, shape] },
    { name: "villa", desc: "taken", parts: [shape] },
    { name: "toy drum", desc: "again", parts: [shape] },
    { name: "empty", parts: [] },
  ] };
  const { parts, errors } = readLibraryFile(doc, "test", taken);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].meta.aliases, ["drum toy"], "an alias the catalog uses is dropped");
  assert.equal(parts[0].meta.holdable, true, "small things are holdable by default");
  assert.equal(parts[1].meta.holdable, false, "unless the entry says no");
  assert.equal(parts[0].meta.category, "test");
  assert.equal(errors.length, 3);
  assert.deepEqual(readLibraryFile({ nope: 1 }, "x").errors, ['x: needs a "parts" list']);
});

test("the laptop parts bin loads a batch file (a chat's answer) entry by entry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-batch-"));
  try {
    const shape = { shape: "box", p: [0, 0.1, 0], s: [0.2, 0.2, 0.2], color: "#ff0000" };
    fs.writeFileSync(path.join(dir, "zombie-stuff.json"), JSON.stringify({ category: "zombie stuff", parts: [
      { name: "Supply Drop", desc: "crate on a parachute", parts: [shape, shape, shape] },
      { name: "boarded door", holdable: false, parts: [shape, shape] },
      { desc: "no name", parts: [shape] },
      { name: "broken", parts: [] },
    ] }));
    fs.writeFileSync(path.join(dir, "list.json"), JSON.stringify([{ name: "gas can", holdable: true, parts: [shape] }]));
    fs.writeFileSync(path.join(dir, "single.json"), JSON.stringify({ name: "lone lamp", parts: [shape, shape] }));
    fs.writeFileSync(path.join(dir, "weapons-01.catalog.json"), JSON.stringify({ blueprints: [
      { name: "flare pistol", aliases: ["signal gun"], holdable: true, parts: [shape, shape] },
      { name: "t-rex skull", parts: [shape, shape, shape] },
    ] }));
    const bin = new PartsBin({ dirs: [dir], roomKey: "K", log: quiet, scanMs: 60000 });
    await bin.scan();
    const names = bin.metas().map((m) => m.name).sort();
    assert.deepEqual(names, ["boarded door", "flare pistol", "gas can", "lone lamp", "supply drop", "t-rex skull"]);
    assert.equal(bin.metas().find((m) => m.name === "supply drop").category, "zombie stuff");
    assert.ok(bin.metas().find((m) => m.name === "flare pistol").indexed, "batch entries are indexed");
    // Batches stay on the laptop: the manifest every device downloads has only the single files.
    const manifest = bin.manifest("https://x/api/");
    assert.deepEqual(manifest.parts.map((p) => p.name), ["lone lamp"]);
    assert.equal(manifest.indexed, 5);
    assert.equal(bin.indexedCount, 5);
    // …and one is found by name, by alias or inside a spoken command.
    assert.equal(bin.resolve({ name: "Flare Pistol" }).name, "flare pistol");
    assert.equal(bin.resolve({ name: "signal gun" }).name, "flare pistol");
    assert.ok(Array.isArray(bin.resolve({ name: "flare pistol" }).blueprint.parts));
    assert.equal(bin.resolve({ text: "AI, could you give me a supply drop right there" }).name, "supply drop");
    assert.equal(bin.resolve({ text: "spawn a T-Rex skull" }).name, "t-rex skull");
    assert.equal(bin.resolve({ text: "spawn a crate" }), null);
    assert.equal(bin.resolve({ name: "lone lamp" }), null, "single files are in the manifest, not the index");
    bin.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
