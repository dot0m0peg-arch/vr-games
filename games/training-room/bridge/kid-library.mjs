// On-demand family-friendly extras. Index only in memory; checked batch JSON read per hit.
// Separate from eager parts and the 80k character library to preserve existing inventories.
import fs from "node:fs/promises";
import path from "node:path";

const keyOf = (s) => String(s || "").toLowerCase().normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ").trim();

export class KidLibrary {
  constructor(partsRoot) {
    this.dir = path.join(partsRoot, "kid-library");
    this.stamp = "";
    this.byName = new Map();
    this.cache = new Map();
    this.count = 0;
  }
  async refresh() {
    const indexFile = path.join(this.dir, "index.json");
    let s;
    try { s = await fs.stat(indexFile); } catch { return false; }
    const stamp = s.mtimeMs + ":" + s.size;
    if (this.stamp === stamp) return true;
    const index = JSON.parse(await fs.readFile(indexFile, "utf8"));
    const names = new Map();
    const entries = Array.isArray(index.entries) ? index.entries : [];
    for (const e of entries) {
      if (!e || typeof e.name !== "string" || !/^batch-\d{4}\.json$/.test(e.file) ||
          !Number.isInteger(e.slot) || e.slot < 0 || e.slot >= 2500 ||
          !/^[a-z]{2,20}$/.test(e.group || "")) continue;
      for (const name of [e.name, ...(Array.isArray(e.aliases) ? e.aliases : [])]) {
        const key = keyOf(name);
        if (key && !names.has(key)) names.set(key, e);
      }
    }
    this.byName = names;
    this.count = entries.length;
    this.stamp = stamp;
    this.cache.clear();
    return true;
  }
  async resolve(query) {
    if (!(await this.refresh())) return null;
    const words = keyOf(query).split(" ").filter(Boolean);
    let hit;
    for (let width = Math.min(9, words.length); width > 0 && !hit; width--) {
      for (let offset = 0; offset + width <= words.length; offset++) {
        hit = this.byName.get(words.slice(offset, offset + width).join(" "));
        if (hit) break;
      }
    }
    if (!hit) return null;
    let records = this.cache.get(hit.file);
    if (!records) {
      const data = JSON.parse(await fs.readFile(path.join(this.dir, hit.file), "utf8"));
      records = data.blueprints;
      if (!Array.isArray(records) || records.length > 2500) return null;
      this.cache.set(hit.file, records);
      if (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
    }
    const blueprint = records[hit.slot];
    if (!blueprint || blueprint.name !== hit.name) return null;
    return { name: blueprint.name, group: hit.group, blueprint };
  }
}