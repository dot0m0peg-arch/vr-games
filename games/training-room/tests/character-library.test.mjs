import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { CharacterLibrary } from "../bridge/character-library.mjs";
import { resolveCharacter } from "../js/parts/character-spawn.js";
import { buildBlueprint } from "../js/parts/build/blueprint.js";

const sample = (name) => ({
  name, category: "mythical", holdable: false,
  desc: "Editable goblin proxy",
  parts: [
    { shape: "capsule", p: [0, 0.8, 0], s: [0.5, 1.2, 0.5], color: "#78966e", mat: "matte" },
    { shape: "sphere", p: [0, 1.6, 0.1], s: [0.45, 0.45, 0.45], color: "#78966e", mat: "matte" },
  ],
});

test("80k library uses direct indexed lookup, longest phrase and lazy chunks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tr-creatures-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "character-library");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "mythical-00.catalog.json"),
    JSON.stringify({ blueprints: [sample("goblin"), sample("marsh goblin scout")] }));
  await fs.writeFile(path.join(folder, "index.json"), JSON.stringify({ entries: [
    { name: "goblin", aliases: [], group: "mythical", file: "mythical-00.catalog.json", slot: 0 },
    { name: "marsh goblin scout", aliases: ["swamp goblin scout"], group: "mythical", file: "mythical-00.catalog.json", slot: 1 },
  ] }));
  const lib = new CharacterLibrary(root);
  assert.equal((await lib.resolve("spawn a goblin with a freckle")).name, "goblin");
  assert.equal((await lib.resolve("summon a marsh goblin scout to my left")).name, "marsh goblin scout");
  assert.equal((await lib.resolve("give me a swamp goblin scout")).name, "marsh goblin scout");
  assert.equal(await lib.resolve("spawn a fictional potato"), null);
  assert.equal(lib.count, 2);
  assert.equal(lib.cache.size, 1);
});

test("freckle is a tiny additive primitive, not a second hardcoded goblin", async () => {
  const bp = sample("goblin");
  const net = { connected: true, character: async () => ({ group: "mythical", blueprint: bp }) };
  const changed = await resolveCharacter(net, "spawn a goblin with a freckle");
  assert.equal(changed.name, "goblin");
  assert.equal(changed.blueprint.name, "goblin with a freckle");
  assert.equal(changed.blueprint.parts.length, bp.parts.length + 1);
  assert.ok(buildBlueprint(changed.blueprint));
  const plain = await resolveCharacter(net, "spawn a goblin");
  assert.equal(plain.blueprint.name, "goblin");
  assert.equal(plain.blueprint.parts.length, bp.parts.length);
});
