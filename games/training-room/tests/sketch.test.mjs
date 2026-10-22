// Magic marker sketch helpers: stroke cleanup, projection, ASCII art and the offline shape guess.
import test from "node:test";
import assert from "node:assert/strict";
import {
  STROKE_DEFAULTS, simplifyStroke, quantize, sketchBounds, projectStrokes, projectStrokesWithAspect, asciiArt,
  sketchStats, classifySketch, limitStrokes, resampleLine,
} from "../js/core/sketch.js";

// ---------- synthetic drawings ----------

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

// Unit-square polyline → a hand-drawn stroke: points every 4 mm, jitter, depth wobble.
function stroke(poly, { size = 0.5, x0 = -0.2, y0 = 1.1, noise = 0.002, rand = lcg(1) } = {}) {
  const pts = [];
  const jitter = () => (rand() - 0.5) * 2 * noise;
  for (let i = 0; i < poly.length - 1; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[i + 1];
    const n = Math.max(1, Math.ceil((Math.hypot(bx - ax, by - ay) * size) / 0.004));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      pts.push(x0 + (ax + (bx - ax) * t) * size + jitter(), y0 + (ay + (by - ay) * t) * size + jitter(), jitter());
    }
  }
  const [lx, ly] = poly[poly.length - 1];
  pts.push(x0 + lx * size, y0 + ly * size, 0);
  return { c: STROKE_DEFAULTS.color, w: STROKE_DEFAULTS.width, pts };
}

const arc = (cx, cy, rx, ry = rx, n = 80, a0 = 0, turns = 1) => Array.from({ length: n + 1 }, (_, i) => {
  const a = a0 + (i / n) * Math.PI * 2 * turns;
  return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
});

const SHAPES = {
  circle: [arc(0.5, 0.5, 0.5)],
  ellipse: [arc(0.5, 0.5, 0.5, 0.36)],
  circleOvershoot: [arc(0.5, 0.5, 0.5, 0.5, 90, 0.3, 1.12)],
  square: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  squareFromSide: [[[0.5, 1], [0, 1], [0, 0], [1, 0], [1, 1], [0.5, 1]]],
  rectangle: [[[0, 0], [1, 0], [1, 0.5], [0, 0.5], [0, 0]]],
  triangle: [[[0, 0], [1, 0], [0.5, 0.85], [0, 0]]],
  houseTwoStrokes: [[[0, 0], [1, 0], [1, 0.7], [0, 0.7], [0, 0]], [[-0.1, 0.7], [0.5, 1.2], [1.1, 0.7], [-0.1, 0.7]]],
  houseCaretRoof: [[[0, 0], [1, 0], [1, 0.7], [0, 0.7], [0, 0]], [[-0.05, 0.7], [0.5, 1.15], [1.05, 0.7]]],
  houseLineRoof: [[[0, 0], [1, 0], [1, 0.7], [0, 0.7], [0, 0]], [[0, 0.7], [0.5, 1.15]], [[1, 0.7], [0.52, 1.14]]],
  houseOneStroke: [[[0, 0], [1, 0], [1, 0.7], [0.5, 1.2], [0, 0.7], [0, 0]]],
  houseWithDoor: [
    [[0, 0], [1, 0], [1, 0.7], [0, 0.7], [0, 0]], [[-0.1, 0.7], [0.5, 1.2], [1.1, 0.7], [-0.1, 0.7]],
    [[0.4, 0], [0.4, 0.35], [0.6, 0.35], [0.6, 0]],
  ],
  line: [[[0, 0], [1, 0.05]]],
  pentagram: [Array.from({ length: 6 }, (_, i) => {
    const a = Math.PI / 2 + i * ((4 * Math.PI) / 5);
    return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)];
  })],
  pentagramTwice: [Array.from({ length: 11 }, (_, i) => {
    const a = Math.PI / 2 + i * ((4 * Math.PI) / 5);
    return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)];
  })],
  starOutline: [Array.from({ length: 11 }, (_, i) => {
    const a = Math.PI / 2 + i * (Math.PI / 5);
    const r = i % 2 ? 0.2 : 0.5;
    return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)];
  })],
  spiral: [Array.from({ length: 200 }, (_, i) => {
    const t = i / 199;
    const a = t * Math.PI * 6;
    const r = 0.05 + 0.45 * t;
    return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)];
  })],
  stickFigure: [arc(0.5, 0.85, 0.15, 0.15, 40), [[0.5, 0.7], [0.5, 0.3]], [[0.2, 0.55], [0.8, 0.55]], [[0.3, 0], [0.5, 0.3], [0.7, 0]]],
  diamond: [[[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5], [0.5, 0]]],
  sun: [arc(0.5, 0.5, 0.2), ...Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return [[0.5 + 0.28 * Math.cos(a), 0.5 + 0.28 * Math.sin(a)], [0.5 + 0.45 * Math.cos(a), 0.5 + 0.45 * Math.sin(a)]];
  })],
  face: [arc(0.5, 0.5, 0.5), arc(0.33, 0.65, 0.05, 0.05, 12), arc(0.67, 0.65, 0.05, 0.05, 12), arc(0.5, 0.35, 0.22, 0.12, 20, Math.PI * 1.1, 0.4)],
  zigzag: [Array.from({ length: 9 }, (_, i) => [i / 8, i % 2 ? 0.3 : 0])],
  vee: [[[0, 1], [0.5, 0], [1, 1]]],
  twoCircles: [arc(0.25, 0.5, 0.2), arc(0.75, 0.5, 0.2)],
};

// The runner's path: simplify + 5 mm grid + point cap, then project and classify with stats.
function guess(polys, opts = {}) {
  const rand = lcg(opts.seed ?? 1);
  const strokes = polys.map((p) => stroke(p, { ...opts, rand }));
  const clean = limitStrokes(strokes.map((s) => ({ ...s, pts: quantize(simplifyStroke(s.pts)) })));
  return classifySketch(projectStrokes(clean), sketchStats(clean));
}

const EXPECT = {
  circle: ["ball", "ball", "bounce"],
  ellipse: ["ball", "ball", "bounce"],
  circleOvershoot: ["ball", "ball", "bounce"],
  square: ["crate", "crate", "none"],
  squareFromSide: ["crate", "crate", "none"],
  rectangle: ["crate", "crate", "none"],
  triangle: ["tent", "tent", "none"],
  houseTwoStrokes: ["house", "house", "none"],
  houseCaretRoof: ["house", "house", "none"],
  houseLineRoof: ["house", "house", "none"],
  houseOneStroke: ["house", "house", "none"],
  houseWithDoor: ["house", "house", "none"],
  line: ["staff", "staff", "float"],
  pentagram: ["star", null, "spin"],
  pentagramTwice: ["star", null, "spin"],
  starOutline: ["star", null, "spin"],
  spiral: ["spiral", null, "spin"],
  stickFigure: ["person", null, "walk"],
  diamond: ["kite", null, "fly"],
  sun: ["sun", null, "float"],
  face: ["face", null, "bounce"],
};

// ---------- tests ----------

test("stroke defaults", () => {
  assert.deepEqual(STROKE_DEFAULTS, { color: "#9b6bff", width: 0.012 });
});

test("simplifyStroke: RDP in 3D keeps endpoints and corners", () => {
  const line = [];
  for (let i = 0; i <= 100; i++) line.push(i * 0.01, 1 + i * 0.005, 0 - i * 0.002);
  assert.deepEqual(simplifyStroke(line), [0, 1, 0, 1, 1.5, -0.2], "a straight line is just its ends");
  const elbow = [];
  for (let i = 0; i <= 50; i++) elbow.push(i * 0.01, 0, 0);
  for (let i = 1; i <= 50; i++) elbow.push(0.5, i * 0.01, 0);
  const s = simplifyStroke(elbow);
  assert.equal(s.length, 9, "endpoints + the corner");
  assert.deepEqual(s.slice(3, 6), [0.5, 0, 0]);
  const depth = [0, 0, 0, 0.5, 0, 0.3, 1, 0, 0];
  assert.equal(simplifyStroke(depth).length, 9, "a bend in z alone is still a bend");
  const noisy = stroke(SHAPES.circle[0]).pts;
  const out = simplifyStroke(noisy);
  assert.ok(out.length < noisy.length / 3, `${noisy.length / 3} → ${out.length / 3} points`);
  assert.deepEqual(out.slice(0, 3), noisy.slice(0, 3));
  assert.deepEqual(out.slice(-3), noisy.slice(-3));
  assert.ok(simplifyStroke(noisy, 0.02).length < out.length, "bigger epsilon, fewer points");
  assert.equal(simplifyStroke([0, 0, 0, 1, 0, 0, 2, 0, 0], 0).length, 6, "epsilon 0 drops only exactly collinear points");
  const input = [...line];
  simplifyStroke(line);
  assert.deepEqual(line, input, "input untouched");
});

test("quantize rounds to the grid", () => {
  assert.deepEqual(quantize([0.0124, 0.0126, -0.0024, 1.23456, -0.5, 0.0025]), [0.01, 0.015, 0, 1.235, -0.5, 0.005]);
  assert.ok(Object.is(quantize([-0.001, 0, 0])[0], 0), "no negative zero");
  assert.deepEqual(quantize([0.123, 0.456, 0.789], 0.01), [0.12, 0.46, 0.79]);
  assert.deepEqual(quantize([0.123, 0.456, 0.789], -1), [0.125, 0.455, 0.79], "bad step → 5 mm");
  assert.deepEqual(quantize([1, 2, 3, NaN, 0, 0, 4, 5, 6, 7]), [1, 2, 3, 4, 5, 6], "drops invalid and partial points");
  for (const v of quantize(stroke(SHAPES.circle[0]).pts)) assert.ok(Math.abs(v / 0.005 - Math.round(v / 0.005)) < 1e-6);
});

test("sketchBounds over all strokes", () => {
  const b = sketchBounds([{ pts: [0, 0, 0, 1, 2, 0.5] }, { pts: [-1, 1, -0.5, NaN, 9, 9] }, null, { pts: null }]);
  assert.deepEqual(b, { min: [-1, 0, -0.5], max: [1, 2, 0.5], size: [2, 2, 1], center: [0, 1, 0] });
  assert.deepEqual(sketchBounds([]), { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] });
  assert.deepEqual(sketchBounds(undefined).size, [0, 0, 0]);
});

test("projection: drawing plane, longest side fits [0, 1], y up, aspect", () => {
  const rect = { pts: [0, 0, 0.1, 2, 0, 0, 2, 1, -0.1, 0, 1, 0, 0, 0, 0] };
  const p = projectStrokesWithAspect([rect]);
  assert.equal(p.aspect, 2);
  assert.equal(p.width, 2);
  assert.equal(p.height, 1);
  assert.deepEqual(p.lines, [[[0, 0.25], [1, 0.25], [1, 0.75], [0, 0.75], [0, 0.25]]], "centered, z dropped");
  assert.deepEqual(projectStrokes([rect]), p.lines);
  const tall = projectStrokesWithAspect([{ pts: [5, 5, 0, 5.5, 7, 0] }]);
  assert.equal(tall.aspect, 0.25);
  assert.deepEqual(tall.lines[0], [[0.375, 0], [0.625, 1]], "y up: the higher point has the larger y");
  assert.deepEqual(projectStrokesWithAspect([]), { lines: [], aspect: 1, width: 0, height: 0 });
  const dot = projectStrokesWithAspect([{ pts: [1, 1, 1] }]);
  assert.deepEqual(dot, { lines: [[[0.5, 0.5]]], aspect: 1, width: 0, height: 0 });
  assert.equal(projectStrokesWithAspect([{ pts: [0, 0, 0, 3, 0, 0] }]).aspect, 100, "flat line: capped aspect, no Infinity");
});

test("asciiArt draws the silhouette, top row = top of the drawing", () => {
  const rows = (lines, c, r) => asciiArt(lines, c, r).split("\n");
  const square = rows(projectStrokes([stroke(SHAPES.square[0], { noise: 0 })]));
  assert.equal(square.length, 20);
  assert.ok(square.every((r) => r.length === 40 && /^[#.]+$/.test(r)));
  const ink = square.map((r, i) => [i, r]).filter(([, r]) => r.includes("#"));
  const top = ink[0][1];
  const bottom = ink[ink.length - 1][1];
  const middle = ink[Math.floor(ink.length / 2)][1];
  assert.ok(ink.length >= 18, "a square fills the rows");
  assert.ok((top.match(/#/g) || []).length >= 36 && (bottom.match(/#/g) || []).length >= 36, "top and bottom edges");
  assert.equal((middle.match(/#/g) || []).length, 2, "two walls in the middle");
  assert.ok(middle.indexOf("#") <= 1 && middle.lastIndexOf("#") >= 38, "about 2 columns per row: square looks square");

  const tri = rows(projectStrokes([stroke(SHAPES.triangle[0], { noise: 0 })])).filter((r) => r.includes("#"));
  const width = (r) => r.lastIndexOf("#") - r.indexOf("#");
  assert.ok(width(tri[0]) <= 4 && width(tri[tri.length - 1]) >= 36, "apex on top, base at the bottom");

  const tee = rows([[[0, 1], [1, 1]], [[0.5, 1], [0.5, 0]]], 21, 11);
  assert.equal(tee[0], "#".repeat(21), "the bar of a T is the top row");
  assert.equal(tee[10], `${".".repeat(10)}#${".".repeat(10)}`);

  const flat = rows([[[0, 0], [1, 0]]], 10, 5);
  assert.deepEqual(flat, [".".repeat(10), ".".repeat(10), "#".repeat(10), ".".repeat(10), ".".repeat(10)]);
  assert.equal(asciiArt([], 4, 2), "....\n....");
  assert.equal(asciiArt(null, 3, 1), "...");
  assert.equal(asciiArt([[[NaN, 1], [2, NaN]]], 3, 1), "...");
  assert.equal(asciiArt([[[7, 7]]], 3, 3), "...\n.#.\n...", "a single point lands in the middle");
  assert.equal(asciiArt([[[0, 0], [1, 1]]]).split("\n").length, 20, "defaults 40 x 20");
});

test("sketchStats", () => {
  const strokes = [stroke(SHAPES.circle[0]), stroke([[0, -0.2], [1, -0.2]]), { pts: [] }, { pts: [NaN, 1, 2] }];
  const s = sketchStats(strokes);
  assert.equal(s.strokes, 2, "empty strokes do not count");
  assert.equal(s.points, (strokes[0].pts.length + strokes[1].pts.length) / 3);
  assert.equal(s.closed, 1, "the circle is closed, the line is not");
  assert.ok(Math.abs(s.width - 0.5) < 0.01 && Math.abs(s.height - 0.6) < 0.01, `${s.width} x ${s.height} m`);
  assert.ok(Math.abs(s.aspect - s.width / s.height) < 0.01);
  assert.equal(sketchStats([stroke([[0, 0], [0.05, 0], [0.05, 0.05], [0, 0.05], [0, 0]], { noise: 0 }), stroke([[0.2, 0], [0.8, 0.6]], { noise: 0 })]).closed, 1, "a small closed loop counts");
  assert.deepEqual(sketchStats(undefined), { strokes: 0, points: 0, closed: 0, aspect: 1, width: 0, height: 0 });
});

test("limitStrokes caps the points, keeping every stroke when it can", () => {
  const rand = lcg(4);
  const strokes = [0, 1, 2].map((k) => {
    const poly = arc(0.5, 0.5, 0.3 + k * 0.1, 0.3, 4000, k, 3);
    return { c: "#ff0000", w: 0.02, pts: poly.flatMap(([x, y]) => [x + rand() * 0.003, y + rand() * 0.003, rand() * 0.003]) };
  });
  const before = strokes.reduce((n, s) => n + s.pts.length / 3, 0);
  assert.ok(before > 12000);
  const out = limitStrokes(strokes, 6000);
  const total = out.reduce((n, s) => n + s.pts.length / 3, 0);
  assert.equal(out.length, 3);
  assert.ok(total <= 6000 && total > 300, `${before} → ${total}`);
  out.forEach((s, i) => {
    assert.equal(s.c, "#ff0000");
    assert.equal(s.w, 0.02);
    assert.deepEqual(s.pts.slice(0, 3), strokes[i].pts.slice(0, 3), "endpoints kept");
    assert.deepEqual(s.pts.slice(-3), strokes[i].pts.slice(-3));
  });
  assert.equal(strokes[0].pts.length, 12003, "input untouched");
  const few = limitStrokes(strokes, 1e6);
  assert.deepEqual(few.map((s) => s.pts.length), strokes.map((s) => s.pts.length), "under the cap: unchanged");
  assert.ok(limitStrokes(strokes, 500).reduce((n, s) => n + s.pts.length / 3, 0) <= 500);

  // Thousands of two-point dashes cannot be simplified: the shortest go.
  const dashes = Array.from({ length: 4000 }, (_, i) => ({ pts: [0, i * 0.01, 0, 0.01 + (i % 7) * 0.01, i * 0.01, 0] }));
  const kept = limitStrokes(dashes, 6000);
  assert.equal(kept.reduce((n, s) => n + s.pts.length / 3, 0), 6000);
  assert.ok(kept.every((s) => s.pts[3] > 0.015), "shortest dashes dropped first");
  assert.equal(kept.filter((s) => s.pts[3] > 0.065).length, dashes.filter((s) => s.pts[3] > 0.065).length, "longest all kept");
  assert.deepEqual(limitStrokes(dashes, 0), []);
  assert.deepEqual(limitStrokes([{ pts: [] }, { pts: [NaN, 0, 0] }, null]), [], "empty strokes are dropped");
  assert.deepEqual(limitStrokes(null), []);
});

test("resampleLine", () => {
  const r = resampleLine([[0, 0], [1, 0], [1, 1]], 5);
  assert.equal(r.length, 5);
  assert.deepEqual(r[0], [0, 0]);
  assert.deepEqual(r[4], [1, 1]);
  assert.deepEqual(r[2], [1, 0], "halfway along the path");
  assert.deepEqual(resampleLine([], 5), []);
  assert.deepEqual(resampleLine([[2, 3]], 3), [[2, 3], [2, 3], [2, 3]]);
  assert.deepEqual(resampleLine([[1, 1], [1, 1]], 2), [[1, 1], [1, 1]]);
  assert.equal(resampleLine([[0, 0], [1, 0]], NaN).length, 32);
});

test("classifySketch: synthetic drawings through the runner pipeline", () => {
  for (const [name, [g, part, behavior]] of Object.entries(EXPECT)) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = guess(SHAPES[name], { seed });
      assert.ok(r, `${name} (seed ${seed}): no guess`);
      assert.equal(r.guess, g, `${name} (seed ${seed})`);
      assert.equal(r.part, part, `${name} part`);
      assert.equal(r.behavior, behavior, `${name} behavior`);
      assert.ok(r.confidence >= 0.3 && r.confidence <= 0.8, `${name} confidence ${r.confidence}`);
    }
  }
});

test("classifySketch: size, position and input form do not matter", () => {
  for (const name of ["circle", "square", "triangle", "houseTwoStrokes", "pentagram", "stickFigure"]) {
    const want = EXPECT[name][0];
    assert.equal(guess(SHAPES[name], { size: 1.6, x0: 3, y0: -2 })?.guess, want, `${name} big`);
    assert.equal(guess(SHAPES[name], { size: 0.3, noise: 0.001 })?.guess, want, `${name} small`);
    const raw = SHAPES[name].map((p) => stroke(p));
    assert.equal(classifySketch(raw)?.guess, want, `${name}: 3D strokes and no stats`);
  }
  const tall = guess([[[0, 0], [0.5, 0], [0.5, 1], [0, 1], [0, 0]]]);
  assert.equal(tall.guess, "crate");
  assert.ok(tall.confidence < guess(SHAPES.square).confidence, "a square box is a surer crate than a tall one");
  const short = guess(SHAPES.line, { size: 0.15 });
  const long = guess(SHAPES.line, { size: 1.2 });
  assert.ok(short.confidence < long.confidence, "a long line is a surer staff");
  const down = guess([[[0, 1], [1, 1], [0.5, 0.15], [0, 1]]]);
  assert.equal(down.guess, "tent");
  assert.ok(down.confidence < guess(SHAPES.triangle).confidence, "upside-down tents are less likely");
});

test("classifySketch: honest null for things it cannot read", () => {
  const rand = lcg(9);
  const scribble = [Array.from({ length: 40 }, () => [rand(), rand()])];
  for (const [name, polys] of Object.entries({ scribble, zigzag: SHAPES.zigzag, vee: SHAPES.vee, twoCircles: SHAPES.twoCircles })) {
    for (const seed of [1, 2, 3]) assert.equal(guess(polys, { seed }), null, `${name} (seed ${seed})`);
  }
  assert.equal(guess(SHAPES.circle, { size: 0.02, noise: 0 }), null, "a 1 cm speck is too small to read");
});

test("sketch helpers never throw on empty or degenerate input", () => {
  const junk = [undefined, null, 0, "abc", {}, [], [[]], [null], [{}], [{ pts: null }], [{ pts: [] }], [{ pts: [1] }],
    [{ pts: [1, 2, 3] }], [{ pts: [NaN, NaN, NaN, 1, 2, 3] }], [{ pts: [Infinity, 0, 0, 0, 0, 0] }], [[1, 2, 3, 4, 5, 6]],
    [{ pts: new Float32Array([0, 0, 0, 1, 1, 0]) }], [{ pts: [-1e308, 0, 0, 1e308, 1, 0, 0, 1e300, 0] }], [[[1e308, 0], [-1e308, 1]]]];
  for (const j of junk) {
    const label = JSON.stringify(j);
    assert.doesNotThrow(() => {
      simplifyStroke(j);
      quantize(j);
      sketchBounds(j);
      limitStrokes(j);
      sketchStats(j);
      const lines = projectStrokes(j);
      asciiArt(lines);
      asciiArt(j);
      classifySketch(lines);
      classifySketch(j, sketchStats(j));
      resampleLine(j, 4);
    }, label);
    const stats = sketchStats(j);
    for (const v of Object.values(stats)) assert.ok(Number.isFinite(v), `${label}: ${JSON.stringify(stats)}`);
  }
  assert.deepEqual(simplifyStroke([]), []);
  assert.deepEqual(simplifyStroke([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(simplifyStroke([1, 2, NaN]), []);
  assert.deepEqual(simplifyStroke(null), []);
  assert.deepEqual(quantize(undefined), []);
  assert.equal(classifySketch([]), null);
  assert.equal(classifySketch([[[0.5, 0.5]]]), null, "one point");
  assert.equal(classifySketch([[[0.5, 0.5], [0.5, 0.5]]]), null, "zero size");
  assert.equal(classifySketch([[[NaN, 0.5], [1, NaN]]]), null);
  assert.equal(classifySketch(SHAPES.circle, {}).guess, "ball", "stats without sizes are ignored");
  assert.equal(classifySketch(SHAPES.circle, { width: NaN, height: 1 }).guess, "ball");
  const typed = projectStrokes([{ pts: new Float32Array([0, 0, 0, 1, 1, 0]) }]);
  assert.deepEqual(typed, [[[0, 0], [1, 1]]], "typed arrays work");
});
