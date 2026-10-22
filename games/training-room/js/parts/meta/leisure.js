// leisure parts: catalog metadata (pure data, see ARCHITECTURE.md).
export const metas = [
  {
    name: "card table", aliases: ["poker table", "game table"], category: "leisure",
    desc: "square green felt card table", size: [1.0, 0.78, 1.0], color: "#2f6b3a",
    surface: 0.76, surfaceSize: [0.86, 0.86],
  },
  {
    name: "deck of cards", aliases: ["deck of playing cards", "playing cards", "cards", "card deck", "deck"], category: "leisure",
    desc: "deck of 52 playing cards, can deal and shuffle", size: [0.063, 0.017, 0.088], color: "#d5fb6a",
    holdable: true, grip: { p: [0, 0.0085, 0], r: [0, 0, 0] }, deck: true,
  },
  {
    name: "playing card", aliases: ["card", "single card"], category: "leisure",
    desc: "one playing card, face up or down", size: [0.063, 0.002, 0.088], color: "#d5fb6a",
    holdable: true, grip: { p: [0, 0.001, 0], r: [0, 0, 0] },
  },
  {
    name: "dice", aliases: ["die", "pair of dice"], category: "leisure",
    desc: "pair of six sided dice", size: [0.08, 0.03, 0.04], color: "#f4f1ea",
    holdable: true, grip: { p: [0, 0.015, 0], r: [0, 0, 0] },
  },
  {
    name: "chess board", aliases: ["chessboard", "chess set", "chess"], category: "leisure",
    desc: "chess board with a game in progress", size: [0.45, 0.1, 0.45], color: "#5a3b25",
    holdable: true, grip: { p: [0, 0.0125, 0], r: [0, 0, 0] },
  },
  {
    name: "poker chips", aliases: ["chips", "chip stack", "casino chips"], category: "leisure",
    desc: "three stacks of poker chips", size: [0.084, 0.042, 0.078], color: "#b8322b",
    holdable: true, grip: { p: [0, 0.02, 0], r: [0, 0, 0] },
  },
  {
    name: "ball", aliases: ["soccer ball", "football", "beach ball"], category: "leisure",
    desc: "soccer ball you can throw or kick", size: [0.23, 0.22, 0.22], color: "#f2f2ee",
    holdable: true, grip: { p: [0, 0.11, 0], r: [0, 0, 0] },
  },
  {
    name: "basketball", aliases: ["basket ball"], category: "leisure",
    desc: "orange basketball", size: [0.245, 0.245, 0.245], color: "#d4692a",
    holdable: true, grip: { p: [0, 0.1225, 0], r: [0, 0, 0] },
  },
  {
    name: "basketball hoop", aliases: ["hoop", "basket", "basketball net", "basketball goal"], category: "leisure",
    desc: "portable basketball hoop with backboard and net", size: [1.1, 3.68, 1.63], color: "#334039",
  },
  {
    name: "bench", aliases: ["park bench"], category: "leisure",
    desc: "wooden park bench with iron sides", size: [1.6, 0.88, 0.67], color: "#8a5a35",
  },
  {
    name: "picnic table", aliases: ["picnic bench"], category: "leisure",
    desc: "wooden picnic table with attached benches", size: [1.8, 0.76, 1.56], color: "#9b6b43",
    surface: 0.76, surfaceSize: [1.75, 0.68],
  },
  {
    name: "grill", aliases: ["barbecue", "bbq", "barbeque", "kettle grill"], category: "leisure",
    desc: "kettle barbecue grill with glowing coals", size: [0.57, 1.26, 0.82], color: "#1d1f1e",
  },
  {
    name: "guitar", aliases: ["acoustic guitar"], category: "leisure",
    desc: "acoustic guitar", size: [0.38, 1.03, 0.11], color: "#d9a45b",
    holdable: true, grip: { p: [0, 0.72, 0.035], r: [-90, 0, 0] },
  },
  {
    name: "boombox", aliases: ["radio", "stereo", "boom box"], category: "leisure",
    desc: "retro boombox stereo with a handle", size: [0.5, 0.31, 0.14], color: "#2f3431",
    holdable: true, grip: { p: [0, 0.3, 0], r: [0, 90, 0] },
  },
  {
    name: "trophy", aliases: ["cup trophy", "award", "trophy cup"], category: "leisure",
    desc: "gold trophy cup with a plaque, writable", size: [0.23, 0.3, 0.144], color: "#d4a72c",
    holdable: true, grip: { p: [0, 0.13, 0], r: [0, 0, 0] }, writable: true,
  },
  {
    name: "hammock", aliases: ["hammock stand"], category: "leisure",
    desc: "fabric hammock on a steel stand", size: [2.78, 1.39, 0.9], color: "#d9643a",
  },
];
