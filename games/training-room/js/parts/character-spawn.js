// Resolve library character names on demand and provide a small edit surface for spoken traits.
import { normalizeBlueprint } from "../core/blueprint.js";

const REQUEST = /^(?:(?:ai|hey ai)[\s,]+)?(?:spawn|summon|create|generate|conjure|make|build|give me|get me|i want|can i get|put|place|add)\b/i;

// Returns null when no named library creature appears in the command.
export async function resolveCharacter(net, command) {
  if (!net?.connected || !net.character || !REQUEST.test(command)) return null;
  let match;
  try {
    match = await net.character(command);
  } catch (err) {
    if (err.code !== "character-not-found" && err.code !== "not-found")
      console.warn("[character] catalog lookup failed", err);
    return null;
  }
  const raw = match?.blueprint;
  const normal = normalizeBlueprint(raw);
  if (!normal.ok) return null;
  const base = normal.blueprint;
  let blueprint = base;
  // Example edit: "spawn a goblin with a freckle" places a small dark facial decal.
  // The underlying archetype stays reusable without this cosmetic detail.
  if (/\bfreckle(s|d)?\b/i.test(command)) {
    const count = /\bfreckles\b/i.test(command) ? 5 : 1;
    const [width, height, depth] = base.size;
    const extra = Array.from({ length: count }, (_, i) => ({
      shape: "sphere",
      p: [width * (0.15 + (i % 3) * 0.1), height * (0.84 + Math.floor(i / 3) * 0.03), depth * 0.47],
      s: [0.023, 0.023, 0.022],
      color: "#714a35",
      mat: "matte",
    }));
    const edited = normalizeBlueprint({ ...base, name: base.name + (count === 1 ? " with a freckle" : " with freckles"), parts: [...base.parts, ...extra] });
    if (edited.ok) blueprint = edited.blueprint;
  }
  return { name: base.name, blueprint, baseBlueprint: base, group: match.group };
}
