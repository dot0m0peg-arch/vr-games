// kingdom parts: catalog metadata (pure data, see ARCHITECTURE.md). Used most in Kingdom mode,
// but they are ordinary parts and can be summoned in any mode.
export const metas = [
  {
    name: "castle", aliases: ["castle keep", "fortress", "palace", "citadel", "stronghold"], category: "kingdom",
    desc: "stone castle keep with four corner towers and a gate", size: [16, 15.3, 16], color: "#a39d90",
  },
  {
    name: "farm field", aliases: ["farm", "field of wheat", "wheat field", "crop field", "crops", "farmland"], category: "kingdom",
    desc: "fenced 12 by 8 m wheat field with furrows and a scarecrow", size: [12.2, 1.9, 8.2], color: "#d9b850",
  },
  {
    name: "market stall", aliases: ["market", "stall", "shop", "merchant stall", "trading post"], category: "kingdom",
    desc: "wooden market stall with striped awning and goods", size: [3.4, 2.9, 2.65], color: "#c4473a",
  },
  {
    name: "blacksmith", aliases: ["smithy", "forge", "blacksmith shop"], category: "kingdom",
    desc: "open blacksmith forge with anvil and chimney", size: [5.4, 5.6, 4.4], color: "#6e6a62",
  },
  {
    name: "chapel", aliases: ["church", "temple", "monastery"], category: "kingdom",
    desc: "small stone chapel with bell tower", size: [6.4, 11.2, 10.4], color: "#cfc6b2",
  },
  {
    name: "tavern", aliases: ["inn", "pub", "alehouse"], category: "kingdom",
    desc: "two-story timber-framed tavern with hanging sign", size: [8.4, 7.6, 6.6], color: "#e8dcc0",
  },
  {
    name: "peasant", aliases: ["villager", "serf", "farmer", "worker", "commoner"], category: "kingdom",
    desc: "a villager in a tunic who wanders about", size: [0.62, 1.72, 0.52], color: "#8a6b3f", behavior: "walk",
  },
];
