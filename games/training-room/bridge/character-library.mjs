// On-demand character blueprints: 80k records live in parts/character-library.
// The index is small and maps normalized names to a 5,000-record chunk.
// Never preload these meshes or include 80,000 records in the LLM context.
import fs from "node:fs/promises";
import path from "node:path";

const normalize = (s) => String(s || "").toLowerCase()
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim();

export class CharacterLibrary {
  constructor(partsRoot) {
    this.dir = path.join(partsRoot, "character-library");
    this.mtime = 0;
    this.count = 0;
    this.byName = new Map();
    this.cache = new Map();
  }

  async refresh() {
    const file = path.join(this.dir, "index.json");
    let stat;
    try { stat = await fs.stat(file); } catch { return false; }
    if (this.mtime === stat.mtimeMs) return true;
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    const map = new Map();
    for (const entry of raw.entries || []) {
      if (!entry || !/^(mythical|air|land|water)$/.test(entry.group)
          || !/^(mythical|air|land|water)-\d\d\.catalog\.json$/.test(entry.file)
          || !Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot >= 5000) continue;
      for (const name of [entry.name, ...(entry.aliases || [])]) {
        const key = normalize(name);
        if (key && !map.has(key)) map.set(key, entry);
      }
    }
    this.byName = map;
    this.count = raw.entries?.length || 0;
    this.mtime = stat.mtimeMs;
    return true;
  }

  async resolve(query) {
    if (!(await this.refresh())) return null;
    const words = normalize(query).split(" ").filter(Boolean);
    // Match complete creature phrases, including Latin names and base archetypes;
    // longest match wins: "marsh goblin scout" beats "goblin".
    let found = null;
    for (let len = Math.min(8, words.length); len >= 1 && !found; len--) {
      for (let start = 0; start + len <= words.length; start++) {
        const key = words.slice(start, start + len).join(" ");
        const candidate = this.byName.get(key);
        if (candidate) { found = candidate; break; }
      }
    }
    if (!found) return null;
    let batch = this.cache.get(found.file);
    if (!batch) {
      const raw = JSON.parse(await fs.readFile(path.join(this.dir, found.file), "utf8"));
      batch = raw.blueprints;
      if (!Array.isArray(batch)) return null;
      this.cache.set(found.file, batch);
      if (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
    }
    const blueprint = batch[found.slot];
    if (!blueprint || blueprint.name !== found.name) return null;
    return { name: blueprint.name, group: found.group, blueprint };
  }
}
