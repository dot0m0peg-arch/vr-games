// combat parts: catalog metadata (pure data, see ARCHITECTURE.md).
// Upright tools (handle along +Y) use grip r [-90, 0, 0]: the head points along the fist (grip -Z)
// and the blade/face built toward +X ends up on the back-of-hand side (grip +X).
export const metas = [
  // ---------------------------------------------------------------- hand weapons
  {
    name: "axe", aliases: ["hatchet", "wood axe"], category: "combat",
    desc: "one-handed wood axe", size: [0.25, 0.745, 0.052], color: "#8d959b",
    holdable: true, grip: { p: [0, 0.18, 0], r: [-90, 0, 0] }, tip: [0.17, 0.66, 0],
  },
  {
    name: "battle axe", aliases: ["war axe", "double axe"], category: "combat",
    desc: "double-bladed two-handed battle axe", size: [0.52, 1.145, 0.06], color: "#9aa2a8",
    holdable: true, grip: { p: [0, 0.3, 0], r: [-90, 0, 0] }, tip: [0.26, 0.93, 0],
  },
  {
    name: "sword", aliases: ["longsword", "broadsword"], category: "combat",
    desc: "steel longsword with crossguard", size: [0.28, 1.05, 0.04], color: "#cfd5d0",
    holdable: true, grip: { p: [0, 0.14, 0], r: [-90, 0, 0] }, tip: [0, 1.05, 0],
  },
  {
    name: "katana", aliases: ["samurai sword"], category: "combat",
    desc: "curved samurai sword", size: [0.084, 1.02, 0.067], color: "#d9ddd8",
    holdable: true, grip: { p: [0, 0.14, 0], r: [-90, 0, 0] }, tip: [-0.041, 1.02, 0],
  },
  {
    name: "dagger", aliases: ["knife", "combat knife"], category: "combat",
    desc: "short double-edged dagger", size: [0.09, 0.35, 0.03], color: "#cfd5d0",
    holdable: true, grip: { p: [0, 0.075, 0], r: [-90, 0, 0] }, tip: [0, 0.35, 0],
  },
  {
    name: "spear", aliases: ["lance", "javelin"], category: "combat",
    desc: "long wooden spear with steel head", size: [0.065, 2.0, 0.065], color: "#cfd5d0",
    holdable: true, grip: { p: [0, 0.75, 0], r: [-90, 0, 0] }, tip: [0, 2.0, 0],
  },
  {
    name: "war hammer", aliases: ["hammer", "sledgehammer", "sledge hammer"], category: "combat",
    desc: "heavy two-handed war hammer", size: [0.25, 0.96, 0.124], color: "#7d858b",
    holdable: true, grip: { p: [0, 0.25, 0], r: [-90, 0, 0] }, tip: [0.125, 0.9, 0],
  },
  {
    name: "mace", aliases: ["morning star", "spiked mace"], category: "combat",
    desc: "spiked iron mace", size: [0.2, 0.69, 0.2], color: "#5b6166",
    holdable: true, grip: { p: [0, 0.13, 0], r: [-90, 0, 0] }, tip: [0.1, 0.585, 0],
  },
  {
    name: "staff", aliases: ["quarterstaff", "bo staff"], category: "combat",
    desc: "wooden fighting staff", size: [0.046, 1.8, 0.046], color: "#9a6a3c",
    holdable: true, grip: { p: [0, 0.65, 0], r: [-90, 0, 0] }, tip: [0, 1.8, 0],
  },
  {
    name: "baseball bat", aliases: ["bat"], category: "combat",
    desc: "wooden baseball bat", size: [0.065, 0.84, 0.067], color: "#d8b07a",
    holdable: true, grip: { p: [0, 0.12, 0], r: [-90, 0, 0] }, tip: [0, 0.76, 0],
  },
  {
    name: "wooden sword", aliases: ["practice sword", "training sword", "bokken"], category: "combat",
    desc: "wooden practice sword, safe for sparring", size: [0.16, 0.95, 0.044], color: "#c89f68",
    holdable: true, grip: { p: [0, 0.12, 0], r: [-90, 0, 0] }, tip: [0, 0.95, 0],
  },
  {
    name: "halberd", aliases: ["polearm", "poleaxe"], category: "combat",
    desc: "polearm with axe blade, hook and spike", size: [0.275, 2.0, 0.044], color: "#c9cfca",
    holdable: true, grip: { p: [0, 0.72, 0], r: [-90, 0, 0] }, tip: [0, 2.0, 0],
  },
  // Bow: the stave bulges toward +X (riser), string on -X. r [-90, 90, 0] keeps the limbs along the
  // fist and turns local +X toward the knuckles (grip -Y), so arrows leave forward and the string
  // sits on the archer's side.
  {
    name: "bow", aliases: ["longbow"], category: "combat",
    desc: "wooden longbow", size: [0.15, 1.49, 0.03], color: "#a8733c",
    holdable: true, grip: { p: [0.055, 0.75, 0], r: [-90, 90, 0] },
  },
  {
    name: "arrow", aliases: ["bow arrow"], category: "combat",
    desc: "feathered arrow", size: [0.032, 0.8, 0.035], color: "#c8202f",
    holdable: true, grip: { p: [0, 0.3, 0], r: [-90, 0, 0] }, tip: [0, 0.8, 0],
  },
  // Crossbow: front (+Z) is the shooting direction. r [125, 0, 180] runs the pistol grip up the fist
  // and tilts the bolt between the knuckles and the thumb, roughly along a Quest pointing ray.
  {
    name: "crossbow", aliases: ["arbalest"], category: "combat",
    desc: "loaded crossbow", size: [0.62, 0.165, 0.82], color: "#8f5f36",
    holdable: true, grip: { p: [0, 0.06, -0.13], r: [125, 0, 180] }, tip: [0, 0.155, 0.38],
  },
  // Shield: face toward +Z, handle bar on the back at local x = +0.1. r [-90, 90, 0] maps the face
  // normal (+Z) to grip +X, which points out of the back of a right hand; local +Y (shield top) runs
  // up the fist (grip -Z) and local -X runs toward the elbow (grip +Y), so the shield's center sits
  // 10 cm up the forearm from the fist. A left hand mirrors this (approximate).
  {
    name: "shield", aliases: ["round shield", "buckler"], category: "combat",
    desc: "round wooden shield with iron rim", size: [0.626, 0.626, 0.144], color: "#2f5f9e",
    holdable: true, grip: { p: [0.1, 0.313, -0.055], r: [-90, 90, 0] },
  },
  // ---------------------------------------------------------------- training gear
  {
    name: "training dummy", aliases: ["dummy", "practice dummy", "wooden dummy"], category: "combat",
    desc: "straw training dummy on a post", size: [0.7, 1.82, 0.5], color: "#d6b25e",
    hittable: true,
  },
  {
    name: "archery target", aliases: ["target", "bullseye"], category: "combat",
    desc: "ring target on a tripod stand", size: [1.2, 1.61, 0.71], color: "#f1efe8",
    hittable: true,
  },
  {
    name: "punching bag", aliases: ["heavy bag", "boxing bag"], category: "combat",
    desc: "heavy bag hanging from a steel frame", size: [0.62, 2.2, 0.8], color: "#9c2b27",
    hittable: true,
  },
  {
    name: "gong", aliases: ["gong target", "steel target"], category: "combat",
    desc: "bronze gong target on a stand, rings when hit", size: [1.0, 1.56, 0.56], color: "#c08a3e",
    hittable: true,
  },
  {
    name: "kettlebell", aliases: ["kettle bell"], category: "combat",
    desc: "iron kettlebell weight", size: [0.22, 0.282, 0.22], color: "#2f3335",
    holdable: true, grip: { p: [0, 0.268, 0], r: [0, 90, 0] },
  },
  {
    name: "dumbbell", aliases: ["hand weight", "free weight"], category: "combat",
    desc: "hex dumbbell weight", size: [0.34, 0.104, 0.12], color: "#26292b",
    holdable: true, grip: { p: [0, 0.052, 0], r: [0, 90, 0] },
  },
  {
    name: "cannonball", aliases: ["cannon ball"], category: "combat",
    desc: "iron cannonball you can throw", size: [0.16, 0.16, 0.16], color: "#3a3e41",
    holdable: true, grip: { p: [0, 0.08, 0], r: [0, 0, 0] },
  },
  // ---------------------------------------------------------------- yard props
  {
    name: "crate", aliases: ["wooden crate", "box", "supply crate"], category: "combat",
    desc: "sturdy wooden supply crate", size: [0.9, 0.9, 0.9], color: "#b98c55",
    surface: 0.9, surfaceSize: [0.86, 0.86],
  },
  {
    name: "barrel", aliases: ["wooden barrel", "keg"], category: "combat",
    desc: "wooden barrel with iron hoops", size: [0.6, 0.9, 0.6], color: "#9a6a3e",
    surface: 0.9, surfaceSize: [0.46, 0.46],
  },
  {
    name: "weapon rack", aliases: ["armory rack", "sword rack"], category: "combat",
    desc: "wooden rack displaying swords, axe and hammer", size: [1.32, 1.375, 0.5], color: "#7a5230",
  },
  {
    name: "suit of armor", aliases: ["suit of armour", "knight armor", "armor stand"], category: "combat",
    desc: "knight's plate armor on a stand holding a sword", size: [0.64, 1.95, 0.5], color: "#8e1f26",
  },
  {
    name: "sandbags", aliases: ["sandbag", "sandbag wall", "sandbag barrier"], category: "combat",
    desc: "stacked sandbag cover wall", size: [1.62, 0.6, 0.56], color: "#b39b6e",
  },
  {
    name: "tire", aliases: ["tyre", "tire stack"], category: "combat",
    desc: "stack of three old tires", size: [0.83, 0.6, 0.83], color: "#232526",
  },
  {
    name: "traffic cone", aliases: ["cone", "safety cone"], category: "combat",
    desc: "orange traffic cone", size: [0.36, 0.7, 0.36], color: "#f26a1b",
  },
  {
    name: "hurdle", aliases: ["jump hurdle"], category: "combat",
    desc: "track hurdle to jump over", size: [1.0, 0.84, 0.47], color: "#1d1f20",
  },
  {
    name: "barricade", aliases: ["spiked barricade", "spike barricade", "cheval de frise"], category: "combat",
    desc: "log with crossed sharpened stakes", size: [1.8, 1.06, 1.06], color: "#c79a5e",
  },
  {
    name: "boxing ring", aliases: ["ring", "fighting ring"], category: "combat",
    desc: "6 m boxing ring with ropes and corner posts", size: [6.0, 1.6, 6.0], color: "#3a6ea5",
    surface: 0.32, surfaceSize: [5.6, 5.6],
  },
  {
    name: "obstacle wall", aliases: ["climbing wall"], category: "combat",
    desc: "wooden obstacle wall with holds and a rope", size: [2.44, 2.2, 1.0], color: "#a8784a",
  },
  {
    name: "cannon", aliases: ["artillery", "field cannon"], category: "combat",
    desc: "iron field cannon on a wheeled carriage", size: [0.96, 1.02, 2.24], color: "#34383b",
  },
  {
    name: "catapult", aliases: ["mangonel", "siege engine"], category: "combat",
    desc: "wooden catapult loaded with a stone", size: [1.28, 1.21, 1.91], color: "#8f5f36",
  },
];
