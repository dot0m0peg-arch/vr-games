// nature parts: catalog metadata (pure data, see ARCHITECTURE.md).
export const metas = [
  {
    name: "tree", aliases: ["oak", "oak tree"], category: "nature",
    desc: "leafy oak tree", size: [4.35, 6.0, 4.35], color: "#4f8a3a",
  },
  {
    name: "pine tree", aliases: ["pine", "fir tree", "christmas tree"], category: "nature",
    desc: "tall conical pine tree", size: [2.76, 5.9, 2.84], color: "#2f5d3a",
  },
  {
    name: "palm tree", aliases: ["palm"], category: "nature",
    desc: "tropical palm tree with coconuts", size: [4.32, 5.85, 4.06], color: "#5c9a3c",
  },
  {
    name: "bush", aliases: ["shrub", "hedge"], category: "nature",
    desc: "round leafy bush with red berries", size: [1.7, 1.13, 1.51], color: "#4a7f38",
  },
  {
    name: "rock", aliases: ["stone"], category: "nature",
    desc: "knee-high gray rock", size: [1.02, 0.62, 0.85], color: "#8f8d86",
  },
  {
    name: "boulder", aliases: ["big rock"], category: "nature",
    desc: "large mossy boulder", size: [3.04, 1.72, 2.65], color: "#878580",
  },
  {
    name: "pebble", aliases: ["throwing stone"], category: "nature",
    desc: "small stone that fits in a hand", size: [0.12, 0.07, 0.09], color: "#9a958b",
    holdable: true, grip: { p: [0, 0.035, 0], r: [0, 0, 0] },
  },
  {
    name: "flowers", aliases: ["flower bed", "flower patch"], category: "nature",
    desc: "patch of colorful flowers", size: [1.33, 0.54, 0.96], color: "#e86aa6",
  },
  {
    name: "campfire", aliases: ["bonfire", "fire pit"], category: "nature",
    desc: "crackling campfire in a stone ring", size: [1.22, 0.79, 1.19], color: "#ff7a1a",
  },
  {
    name: "pond", aliases: ["pool of water", "small pond"], category: "nature",
    desc: "small flat pond with lily pads", size: [3.23, 0.14, 2.6], color: "#3d7f99",
  },
  {
    name: "log", aliases: ["fallen log"], category: "nature",
    desc: "fallen tree log, can be sat on", size: [2.26, 0.67, 0.56], color: "#6b4a30",
    surface: 0.5, surfaceSize: [1.8, 0.3],
  },
  {
    name: "stump", aliases: ["tree stump"], category: "nature",
    desc: "tree stump with a flat top", size: [0.88, 0.51, 0.88], color: "#6b4a30",
    surface: 0.49, surfaceSize: [0.5, 0.5],
  },
  {
    name: "mushroom", aliases: ["giant mushroom", "toadstool"], category: "nature",
    desc: "giant red toadstool with white spots", size: [1.4, 1.84, 1.4], color: "#d23a30",
  },
  {
    name: "hay bale", aliases: ["haystack", "hay"], category: "nature",
    desc: "rectangular hay bale with twine", size: [1.2, 0.82, 0.81], color: "#d9b65a",
    surface: 0.72, surfaceSize: [1.1, 0.7],
  },
  {
    name: "cactus", aliases: ["saguaro"], category: "nature",
    desc: "tall saguaro cactus with two arms", size: [1.14, 2.38, 0.45], color: "#4f8a4a",
  },
  {
    name: "crystal", aliases: ["crystal cluster", "magic crystal"], category: "nature",
    desc: "cluster of glowing purple crystals", size: [1.17, 1.59, 1.03], color: "#a98bff",
  },
  {
    name: "birch tree", aliases: ["birch"], category: "nature",
    desc: "slender white birch tree", size: [2.6, 6.18, 2.6], color: "#8fbf4a",
  },
  {
    name: "dead tree", aliases: ["bare tree", "spooky tree"], category: "nature",
    desc: "leafless dead tree with twisted branches", size: [2.4, 4.74, 2.4], color: "#5d5045",
  },
  {
    name: "stick", aliases: ["walking stick", "tree branch", "branch"], category: "nature",
    desc: "wooden stick to poke or swing", size: [0.15, 1.2, 0.06], color: "#8a6340",
    holdable: true, grip: { p: [0, 0.3, 0], r: [-90, 0, 0] }, tip: [0, 1.2, 0],
  },
];
