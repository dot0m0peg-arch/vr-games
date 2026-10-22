// Parts bin catalog metadata. Pure data (no three.js) so the Node bridge and tests can import it.
// Builders with the same names live in ../build/*.js.
import { metas as structures } from "./structures.js";
import { metas as nature } from "./nature.js";
import { metas as office } from "./office.js";
import { metas as leisure } from "./leisure.js";
import { metas as combat } from "./combat.js";

export const BUILTIN = [...structures, ...nature, ...office, ...leisure, ...combat];

const registry = new Map();
for (const meta of BUILTIN) registry.set(meta.name, { ...meta, source: "builtin" });

export function allMeta() {
  return [...registry.values()];
}

export function getMeta(name) {
  return registry.get(String(name || "").toLowerCase());
}

export function partNames() {
  return [...registry.keys()];
}

// Adds or replaces an entry (laptop parts bin, saved AI blueprints). Returns the stored meta.
export function registerMeta(meta) {
  const name = String(meta.name || "").trim().toLowerCase();
  if (!name) throw new Error("part needs a name");
  const stored = {
    category: "custom",
    aliases: [],
    holdable: false,
    ...meta,
    name,
    aliases: [...new Set((meta.aliases || []).map((a) => String(a).toLowerCase()))],
  };
  registry.set(name, stored);
  return stored;
}

export function unregisterMeta(name) {
  registry.delete(String(name || "").toLowerCase());
}
