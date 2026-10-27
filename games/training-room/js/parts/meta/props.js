// props parts: catalog metadata (pure data, see ARCHITECTURE.md). Toys and snacks with play
// behaviors (play/behaviors.js): gun.muzzle fires, floppy flops, container holds pieces (core/fill.js).
//
// Grips follow the crossbow: r [125, 0, 180] runs a pistol grip up the fist with the barrel (+Z)
// roughly along a Quest pointing ray; r [-55, 0, 0] holds a container upright; r [-145, 0, 0] holds
// the rubber chicken by the neck, head up, body hanging.
export const metas = [
  {
    name: "pistol", aliases: ["handgun", "hand gun", "gun", "nine millimeter", "9mm", "glock", "sidearm"], category: "combat",
    desc: "black semi-automatic pistol that really fires", size: [0.031, 0.135, 0.2], color: "#2b2d30",
    holdable: true, grip: { p: [0, 0.065, -0.038], r: [125, 0, 180] }, gun: { muzzle: [0, 0.112, 0.124] },
  },
  {
    name: "rubber chicken", aliases: ["rubber chicken toy", "squeaky chicken", "screaming chicken", "squawking chicken"], category: "leisure",
    desc: "floppy yellow rubber chicken that squawks", size: [0.13, 0.09, 0.49], color: "#f2c61f",
    holdable: true, grip: { p: [0, 0.04, 0.12], r: [-145, 0, 0] }, floppy: { stiffness: 0.05 }, squeak: true,
  },
  {
    name: "popcorn box", aliases: ["box of popcorn", "popcorn carton", "carton of popcorn", "popcorn bucket", "bucket of popcorn", "bag of popcorn", "tub of popcorn", "popcorn tub"], category: "leisure",
    desc: "striped box heaped with popcorn you can grab and throw", size: [0.13, 0.21, 0.091], color: "#d62828",
    holdable: true, grip: { p: [0.062, 0.08, 0], r: [-55, 0, 0] },
    container: { floor: 0.006, rim: 0.19, bottom: [0.046, 0.031], top: [0.061, 0.042], fill: "popcorn piece", max: 60 },
  },
  {
    name: "snack bag", aliases: ["bag of chips", "chip bag", "chips bag", "bag of crisps", "bag of snacks"], category: "leisure",
    desc: "open bag of potato chips", size: [0.106, 0.24, 0.059], color: "#e8742a",
    holdable: true, grip: { p: [0.05, 0.1, 0], r: [-55, 0, 0] },
    container: { floor: 0.012, rim: 0.2, bottom: [0.048, 0.025], top: [0.045, 0.023], fill: "potato chip", max: 40 },
  },
  {
    name: "snack bucket", aliases: ["bucket of fries", "fries bucket", "bucket of french fries"], category: "leisure",
    desc: "red bucket full of french fries", size: [0.176, 0.2, 0.176], color: "#c8202f",
    holdable: true, grip: { p: [0.08, 0.08, 0], r: [-55, 0, 0] },
    container: { floor: 0.006, rim: 0.17, bottom: [0.048, 0.048], top: [0.062, 0.062], fill: "french fry", max: 50 },
  },
  {
    name: "snack bowl", aliases: ["bowl of candy", "candy bowl", "bowl of candies"], category: "leisure",
    desc: "bowl heaped with wrapped candy", size: [0.23, 0.093, 0.23], color: "#3a7bd5",
    holdable: true, grip: { p: [0.1, 0.04, 0], r: [-55, 0, 0] },
    container: { floor: 0.006, rim: 0.07, bottom: [0.045, 0.045], top: [0.078, 0.078], fill: "candy", max: 50 },
  },
  {
    name: "snack box", aliases: ["box of gumballs", "gumball box", "cardboard box of treats"], category: "leisure",
    desc: "open cardboard box of gumballs", size: [0.18, 0.135, 0.195], color: "#b98d58",
    holdable: true, grip: { p: [0.09, 0.06, 0], r: [-55, 0, 0] },
    container: { floor: 0.008, rim: 0.12, bottom: [0.078, 0.053], top: [0.078, 0.053], fill: "gumball", max: 60 },
  },
  {
    name: "popcorn piece", aliases: ["popcorn kernel", "piece of popcorn", "popped kernel"], category: "leisure",
    desc: "one piece of buttery popcorn", size: [0.03, 0.027, 0.03], color: "#f6edd0",
    holdable: true, grip: { p: [0, 0.013, 0], r: [0, 0, 0] }, piece: true,
  },
  {
    name: "french fry", aliases: ["fry", "french fries", "single fry"], category: "leisure",
    desc: "one golden french fry", size: [0.011, 0.011, 0.085], color: "#f0c043",
    holdable: true, grip: { p: [0, 0.0055, 0], r: [0, 0, 0] }, piece: true,
  },
  {
    name: "potato chip", aliases: ["crisp", "potato crisp", "single chip"], category: "leisure",
    desc: "one crunchy potato chip", size: [0.048, 0.008, 0.038], color: "#e9b949",
    holdable: true, grip: { p: [0, 0.004, 0], r: [0, 0, 0] }, piece: true,
  },
  {
    name: "gumball", aliases: ["gum ball", "bubble gum ball"], category: "leisure",
    desc: "shiny round gumball", size: [0.024, 0.024, 0.024], color: "#e8384f",
    holdable: true, grip: { p: [0, 0.012, 0], r: [0, 0, 0] }, piece: true,
  },
  {
    name: "jelly bean", aliases: ["jellybean", "jelly beans"], category: "leisure",
    desc: "green jelly bean", size: [0.013, 0.013, 0.022], color: "#7cc242",
    holdable: true, grip: { p: [0, 0.0065, 0], r: [0, 0, 0] }, piece: true,
  },
  {
    name: "candy", aliases: ["wrapped candy", "piece of candy", "candies", "sweet"], category: "leisure",
    desc: "wrapped hard candy", size: [0.058, 0.022, 0.022], color: "#e04aa0",
    holdable: true, grip: { p: [0, 0.011, 0], r: [0, 0, 0] }, piece: true,
  },
];
