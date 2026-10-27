// office parts: catalog metadata (pure data, see ARCHITECTURE.md).
export const metas = [
  {
    name: "desk", aliases: ["office desk", "work desk", "computer desk"], category: "office",
    desc: "office desk with a drawer pedestal", size: [1.6, 0.76, 0.8], color: "#8a6a4a",
    surface: 0.76, surfaceSize: [1.56, 0.76],
  },
  {
    name: "office chair", aliases: ["swivel chair", "desk chair", "computer chair"], category: "office",
    desc: "padded swivel office chair on casters", size: [0.6, 1.1, 0.64], color: "#34393f",
  },
  {
    name: "chair", aliases: ["wooden chair", "seat"], category: "office",
    desc: "simple wooden chair", size: [0.45, 0.9, 0.45], color: "#9a6a3e",
  },
  {
    name: "monitor", aliases: ["computer monitor", "computer screen"], category: "office",
    desc: "desktop computer monitor, can show a shared screen", size: [0.6, 0.48, 0.18], color: "#1d2220",
    screen: true,
  },
  {
    name: "screen", aliases: ["big screen", "tv", "television", "display", "projector screen", "tv screen", "flat screen"],
    category: "office", desc: "big 16:9 display on a floor stand for screen sharing", size: [2.0, 1.92, 0.6],
    color: "#1b1f1d", screen: true,
  },
  {
    name: "whiteboard", aliases: ["white board", "dry erase board", "marker board"], category: "office",
    desc: "rolling whiteboard you can write on", size: [1.82, 1.9, 0.56], color: "#9ea5a0", writable: true,
  },
  {
    name: "sticky note", aliases: ["note", "post it", "post-it note", "post-it", "memo", "sticky"], category: "office",
    desc: "big yellow sticky note on a wire stand, writable", size: [0.3, 0.38, 0.1], color: "#f7e463",
    holdable: true, grip: { p: [0, 0.05, 0], r: [-90, 0, 0] }, writable: true,
  },
  {
    name: "easel", aliases: ["flip chart", "flipchart", "flip board"], category: "office",
    desc: "flip chart paper pad on a tripod, writable", size: [0.74, 1.77, 0.73], color: "#6b4c32", writable: true,
  },
  {
    name: "floor lamp", aliases: ["lamp", "standing lamp"], category: "office",
    desc: "tall floor lamp with a glowing shade", size: [0.43, 1.7, 0.43], color: "#f3dca2",
  },
  {
    name: "desk lamp", aliases: ["reading lamp", "table lamp"], category: "office",
    desc: "small jointed desk lamp", size: [0.15, 0.37, 0.26], color: "#33473c",
    holdable: true, grip: { p: [0, 0.15, -0.098], r: [-90, 180, 0] },
  },
  {
    name: "couch", aliases: ["sofa", "settee"], category: "office",
    desc: "three seat fabric couch with pillows", size: [2.0, 0.85, 0.88], color: "#3f5f5a",
  },
  {
    name: "armchair", aliases: ["lounge chair", "recliner", "arm chair"], category: "office",
    desc: "comfy leather armchair", size: [0.95, 0.85, 0.88], color: "#7a4b32",
  },
  {
    name: "bookshelf", aliases: ["bookcase", "shelf", "book shelf"], category: "office",
    desc: "tall bookshelf full of colorful books", size: [0.9, 1.8, 0.32], color: "#7b5536",
  },
  {
    name: "potted plant", aliases: ["plant", "houseplant", "office plant", "house plant"], category: "office",
    desc: "leafy office plant in a ceramic pot", size: [0.53, 1.21, 0.53], color: "#d9d4c7",
  },
  {
    name: "laptop", aliases: ["notebook computer", "macbook", "laptop computer"], category: "office",
    desc: "open laptop computer", size: [0.34, 0.23, 0.32], color: "#b8bdb7",
    holdable: true, grip: { p: [0, 0.008, 0.08], r: [0, 0, 0] }, screen: true,
  },
  {
    name: "filing cabinet", aliases: ["file cabinet", "cabinet", "file drawers"], category: "office",
    desc: "four drawer metal filing cabinet", size: [0.46, 1.32, 0.64], color: "#8b938c",
  },
  {
    name: "conference table", aliases: ["meeting table", "boardroom table"], category: "office",
    desc: "long rounded meeting table for a team", size: [3.6, 0.76, 1.4], color: "#6e4b33",
    surface: 0.76, surfaceSize: [3.4, 1.3],
  },
  {
    name: "coffee table", aliases: ["low table"], category: "office",
    desc: "low wooden coffee table with a shelf", size: [1.1, 0.42, 0.6], color: "#8f6640",
    surface: 0.42, surfaceSize: [1.05, 0.55],
  },
  {
    name: "coffee mug", aliases: ["mug", "coffee cup", "cup"], category: "office",
    desc: "ceramic coffee mug", size: [0.127, 0.095, 0.084], color: "#eeebe3",
    holdable: true, grip: { p: [0.056, 0.05, 0], r: [0, 0, 0] },
  },
  {
    name: "lectern", aliases: ["speaker stand"], category: "office",
    desc: "wooden lectern with a microphone", size: [0.7, 1.28, 0.55], color: "#5e4330",
  },
  {
    name: "trash can", aliases: ["bin", "garbage can", "wastebasket", "trash bin", "waste bin"], category: "office",
    desc: "office trash can", size: [0.32, 0.39, 0.32], color: "#3d4a40",
  },
  {
    name: "water cooler", aliases: ["water dispenser"], category: "office",
    desc: "office water cooler with a big bottle", size: [0.36, 1.37, 0.36], color: "#e6e9e3",
  },
  {
    name: "rug", aliases: ["carpet", "area rug"], category: "office",
    desc: "flat patterned area rug", size: [2.4, 0.02, 1.6], color: "#8c3b32",
  },
  {
    name: "marker", aliases: ["magic marker", "crayon", "purple crayon", "chalk", "felt tip", "marker pen"], category: "office",
    desc: "fat magic marker: hold it and pull the trigger to draw glowing lines in the air", size: [0.031, 0.16, 0.031],
    color: "#9b6bff", holdable: true, marker: true, grip: { p: [0, 0.05, 0], r: [-90, 0, 0] }, tip: [0, 0.16, 0],
  },
];
