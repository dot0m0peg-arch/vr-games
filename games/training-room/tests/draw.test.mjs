// Magic marker drawing input (js/play/draw.js) and the "drawing"/"doodle" builders, in Node.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../vendor/three.module.min.js";
import { Room } from "../js/room.js";
import { Draw } from "../js/play/draw.js";
import { buildObject, metaOfRecord, sizeOfRecord } from "../js/parts/build/index.js";
import { measure } from "../js/parts/build/kit.js";
import { getMeta } from "../js/parts/meta/index.js";
import { STROKE_DEFAULTS, sketchBounds } from "../js/core/sketch.js";

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

function setup(user = "u1") {
  const room = new Room();
  const scene = new THREE.Scene();
  const ops = [];
  let n = 0;
  const who = { user };
  const draw = new Draw({
    scene, room, getUser: () => who.user, newId: (prefix) => `${prefix}${++n}`,
    send: (op) => {
      ops.push(op);
      room.apply(op);
    },
  });
  return { room, scene, ops, draw, who };
}

// World point for drawing-local (x, y, z) in a frame at p facing yaw ry.
function world(p, ry, x, y, z = 0) {
  return V(p[0] + Math.cos(ry) * x + Math.sin(ry) * z, p[1] + y, p[2] - Math.sin(ry) * x + Math.cos(ry) * z);
}

// Strokes local points (x, y) from `from` to `to` in 1 cm steps.
function strokeLocal(draw, key, p, ry, from, to, steps = 20) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    draw.move(key, world(p, ry, from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t));
  }
}

const pointsOf = (pts) => Array.from({ length: pts.length / 3 }, (_, i) => pts.slice(i * 3, i * 3 + 3));

test("begin/move/end makes one add op with drawing-local points for several yaws", () => {
  for (const ry of [0, Math.PI / 2, -Math.PI / 3, Math.PI, 2.5]) {
    const { draw, ops } = setup();
    const p = [1.5, 1.3, -2];
    draw.begin("right", V(...p), ry);
    assert.equal(draw.drawing("right"), true);
    strokeLocal(draw, "right", p, ry, [0, 0], [0.3, 0]);
    strokeLocal(draw, "right", p, ry, [0.3, 0], [0.3, 0.2]);
    const id = draw.end("right");
    assert.equal(draw.drawing("right"), false);
    assert.equal(ops.length, 1);
    const op = ops[0];
    assert.equal(op.t, "add");
    assert.equal(op.obj.id, id);
    assert.equal(op.obj.part, "drawing");
    assert.equal(op.obj.label, "drawing");
    assert.equal(op.obj.by, "u1");
    assert.equal(op.obj.s, 1);
    assert.ok(near(op.obj.ry, ry, 1e-9));
    assert.deepEqual(op.obj.p, p);
    assert.ok(op.obj.t > 0);
    const [stroke] = op.obj.data.strokes;
    assert.equal(op.obj.data.strokes.length, 1);
    assert.equal(stroke.c, STROKE_DEFAULTS.color);
    assert.equal(stroke.w, STROKE_DEFAULTS.width);
    const pts = pointsOf(stroke.pts);
    assert.deepEqual(pts[0], [0, 0, 0], `ry ${ry}: starts at the frame origin`);
    const last = pts[pts.length - 1];
    assert.ok(near(last[0], 0.3, 0.006) && near(last[1], 0.2, 0.006) && near(last[2], 0, 0.006), `ry ${ry}: ends at ${last}`);
    // The corner is kept by the simplifier, everything lies in the drawing plane, on the 5 mm grid.
    assert.ok(pts.some(([x, y]) => near(x, 0.3, 0.011) && near(y, 0, 0.011)), `ry ${ry}: corner`);
    for (const v of stroke.pts) assert.ok(near(v / 0.005, Math.round(v / 0.005), 1e-6), `on grid: ${v}`);
    for (const [, , z] of pts) assert.ok(Math.abs(z) <= 0.005);
    assert.ok(pts.length <= 6, `simplified: ${pts.length} points`);
  }
});

test("a second stroke near the open drawing joins it with a set op; far or late strokes start new ones", () => {
  const { draw, ops, room } = setup();
  const p = [0, 1.4, -2];
  draw.begin("right", V(...p), 0);
  strokeLocal(draw, "right", p, 0, [0, 0], [0.2, 0]);
  const id = draw.end("right");

  // Within 2 m of the frame origin: appended to the same drawing, in its frame (yaw ignored).
  draw.begin("left", world(p, 0, 0.5, 0.5), 1.2);
  strokeLocal(draw, "left", p, 0, [0.5, 0.5], [0.5, 0.8]);
  assert.equal(draw.end("left"), id);
  assert.equal(ops.length, 2);
  assert.equal(ops[1].t, "set");
  assert.equal(ops[1].id, id);
  const strokes = room.get(id).data.strokes;
  assert.equal(strokes.length, 2);
  assert.deepEqual(pointsOf(strokes[1].pts)[0], [0.5, 0.5, 0]);

  // More than 2 m away: a new drawing framed at the new point.
  draw.begin("right", V(3, 1.4, -2), 0.4);
  strokeLocal(draw, "right", [3, 1.4, -2], 0.4, [0, 0], [0.1, 0.1]);
  const far = draw.end("right");
  assert.notEqual(far, id);
  assert.equal(ops[2].t, "add");
  assert.deepEqual(ops[2].obj.p, [3, 1.4, -2]);

  // A minute after the last stroke the old drawing is closed.
  const now = Date.now;
  try {
    Date.now = () => now() + 61000;
    draw.begin("right", world(p, 0, 0.1, 0.1), 0);
    strokeLocal(draw, "right", p, 0, [0.1, 0.1], [0.2, 0.2]);
    const late = draw.end("right");
    assert.ok(late !== id && late !== far);
    assert.equal(ops[3].t, "add");
  } finally {
    Date.now = now;
  }
});

test("other users' drawings are never joined; an erased drawing is re-added in its frame", () => {
  const { draw, ops, room, who } = setup("u1");
  draw.begin("right", V(0, 1.4, -2), 0);
  strokeLocal(draw, "right", [0, 1.4, -2], 0, [0, 0], [0.2, 0]);
  const id = draw.end("right");
  who.user = "u2";
  draw.begin("right", V(0.1, 1.4, -2), 0);
  strokeLocal(draw, "right", [0.1, 1.4, -2], 0, [0, 0], [0.2, 0]);
  assert.notEqual(draw.end("right"), id);
  assert.equal(ops[1].t, "add");

  // Erased while drawing: the stroke still lands, as a new drawing with the same frame.
  who.user = "u1";
  draw.begin("right", V(0.2, 1.5, -2), 0);
  room.apply({ t: "del", ids: [id] });
  strokeLocal(draw, "right", [0, 1.4, -2], 0, [0.2, 0.1], [0.3, 0.1]);
  const again = draw.end("right");
  assert.notEqual(again, id);
  assert.equal(ops[2].t, "add");
  assert.deepEqual(ops[2].obj.p, [0, 1.4, -2]);
});

test("points closer than 6 mm are skipped; cancel drops the stroke; the live mesh is hidden after end", () => {
  const { draw, ops, scene } = setup();
  draw.begin("mouse", V(0, 1.5, -2), 0);
  const live = scene.getObjectByName("draw:live:mouse");
  assert.ok(live && live.visible);
  // 1 mm steps along a 12 cm arc: about 20 stored points, never closer than 6 mm.
  for (let i = 1; i <= 120; i++) {
    const a = (i / 1000) / 0.2;
    draw.move("mouse", V(0.2 * Math.sin(a), 1.5 + 0.2 * (1 - Math.cos(a)), -2));
  }
  const pen = draw.pens.get("mouse");
  assert.ok(pen.n >= 15 && pen.n <= 21, `stored ${pen.n} points`);
  for (let i = 1; i < pen.n; i++) {
    const d = Math.hypot(pen.pts[i * 3] - pen.pts[i * 3 - 3], pen.pts[i * 3 + 1] - pen.pts[i * 3 - 2], pen.pts[i * 3 + 2] - pen.pts[i * 3 - 1]);
    assert.ok(d >= 0.006 - 1e-6, `gap ${d}`);
  }
  assert.equal(live.geometry.drawRange.count, (pen.n - 1) * 6 * 6);
  draw.cancel("mouse");
  assert.equal(draw.drawing("mouse"), false);
  assert.equal(live.visible, false);
  assert.equal(draw.end("mouse"), null);
  assert.equal(ops.length, 0);

  draw.begin("mouse", V(0, 1.5, -2), 0);
  draw.move("mouse", V(0.05, 1.5, -2));
  draw.end("mouse");
  assert.equal(live.visible, false);
  assert.equal(ops.length, 1);
});

test("pen color and width apply to new strokes; bad values are ignored", () => {
  const { draw, ops } = setup();
  draw.setColor("#FF8800");
  draw.setColor("red");
  draw.setWidth(0.02);
  draw.setWidth(NaN);
  assert.equal(draw.color, "#ff8800");
  assert.equal(draw.width, 0.02);
  draw.begin("right", V(0, 1, -1), 0);
  draw.move("right", V(0.1, 1, -1));
  draw.end("right");
  assert.equal(ops[0].obj.data.strokes[0].c, "#ff8800");
  assert.equal(ops[0].obj.data.strokes[0].w, 0.02);
});

test("a joined drawing stays under the room data limit (simplified when it grows)", () => {
  const { draw, room } = setup();
  const p = [0, 1.5, -2];
  let id;
  for (let s = 0; s < 40; s++) {
    draw.begin("right", world(p, 0, -0.5, s * 0.02 - 0.4), 0);
    for (let i = 1; i <= 200; i++) draw.move("right", world(p, 0, -0.5 + i * 0.005, s * 0.02 - 0.4 + 0.05 * Math.sin(i * 0.7)));
    id = draw.end("right");
  }
  const record = room.get(id);
  assert.ok(record, "drawing exists");
  const json = JSON.stringify(record.data);
  assert.ok(json.length <= 65536, `data ${json.length} chars`);
  assert.ok(record.data.strokes.length >= 30, `kept ${record.data.strokes.length} strokes`);
});

test("importSketch: longest side 2 m, y flipped, standing 2 m in front of the pose and facing it", () => {
  const { draw, ops } = setup();
  // Two horizontal lines on a 2:1 canvas: top (v = 0) and bottom (v = 1).
  const id = draw.importSketch({ lines: [[[0, 0], [1, 0]], [[0, 1], [1, 1]]], aspect: 2, color: "#22aaff" }, { pose: { p: [1, 1.6, 2], yaw: Math.PI / 2 } });
  assert.ok(id);
  const obj = ops[0].obj;
  assert.equal(obj.id, id);
  assert.equal(obj.part, "drawing");
  assert.ok(near(obj.p[0], -1) && near(obj.p[1], 1.4) && near(obj.p[2], 2), `p ${obj.p}`);
  assert.ok(near(obj.ry, Math.PI / 2), `ry ${obj.ry}`);
  const [top, bottom] = obj.data.strokes.map((s) => pointsOf(s.pts));
  assert.equal(obj.data.strokes[0].c, "#22aaff");
  assert.deepEqual(top[0], [-1, 0.5, 0]);
  assert.deepEqual(top[top.length - 1], [1, 0.5, 0]);
  assert.deepEqual(bottom[0], [-1, -0.5, 0]);
  const size = sketchBounds(obj.data.strokes).size;
  assert.ok(near(size[0], 2) && near(size[1], 1), `size ${size}`);
  // Canvas left (u = 0) is on the viewer's left: the viewer looks along -X, so left is +Z.
  const left = world(obj.p, obj.ry, top[0][0], top[0][1]);
  assert.ok(near(left.x, -1) && near(left.z, 3) && near(left.y, 1.9), `left end ${left.toArray()}`);

  // A tall sketch is 2 m tall and still clears the ground; empty sketches add nothing.
  draw.importSketch({ lines: [[[0.5, 0], [0.5, 1]]], aspect: 0.5 }, { pose: { p: [0, 1.2, 0], yaw: 0 } });
  const tall = ops[1].obj;
  assert.ok(near(sketchBounds(tall.data.strokes).size[1], 2));
  assert.ok(tall.p[1] - 1 >= 0.04, `bottom at ${tall.p[1] - 1}`);
  assert.equal(draw.importSketch({ lines: [] }, { pose: { p: [0, 1.6, 0], yaw: 0 } }), null);
  assert.equal(ops.length, 2);
});

test("latestDrawing prefers this user's most recent drawing within 15 m, else the nearest", () => {
  const { draw, room } = setup();
  const add = (id, p, by, t) => room.apply({ t: "add", obj: { id, part: "drawing", label: "drawing", p, ry: 0, s: 1, data: { strokes: [] }, by, t } });
  add("o1", [2, 1, 0], "u2", 100);
  add("o2", [8, 1, 0], "u1", 200);
  add("o3", [10, 1, 0], "u1", 150);
  add("o4", [30, 1, 0], "u1", 999);
  room.apply({ t: "add", obj: { id: "o5", part: "crate", label: "crate", p: [0, 0, 0], ry: 0, s: 1, by: "u1", t: 1000 } });
  const pose = { p: [0, 1.6, 0], yaw: 0 };
  assert.equal(draw.latestDrawing("u1", pose).id, "o2");
  assert.equal(draw.latestDrawing("u3", pose).id, "o1");
  assert.equal(draw.latestDrawing("u1", { p: [40, 1.6, 0] }).id, "o4");
  assert.equal(draw.latestDrawing("u1", { p: [0, 1.6, 100] }), null);
});

test("snapshot, ASCII and stats wrappers", () => {
  const { draw } = setup();
  const record = { data: { strokes: [{ c: "#9b6bff", w: 0.012, pts: [0, 0, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0, 0, 0, 0] }] } };
  assert.equal(draw.snapshotPNG(record), null, "no canvas in Node");
  const ascii = draw.asciiFor(record);
  assert.equal(ascii.split("\n").length, 20);
  assert.ok(ascii.includes("#"));
  const stats = draw.statsFor(record);
  assert.equal(stats.strokes, 1);
  assert.equal(stats.closed, 1);
});

test("desktop sheet: appears 2.5 m ahead facing the camera; left-drag draws on it", () => {
  const { draw, ops, scene } = setup();
  const camera = new THREE.PerspectiveCamera(70, 800 / 600, 0.05, 100);
  camera.position.set(1, 1.6, 1);
  camera.rotation.set(0, 0.6, 0, "YXZ");
  const dom = new EventTarget();
  dom.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  const seen = [];
  draw.on("plane", (on) => seen.push(on));
  draw.setPlaneMode(true, { camera, dom });
  assert.equal(draw.planeMode, true);
  const sheet = scene.getObjectByName("draw:sheet");
  assert.ok(sheet);
  const fwd = V(-Math.sin(0.6), 0, -Math.cos(0.6));
  assert.ok(sheet.position.clone().setY(0).distanceTo(V(1, 0, 1).addScaledVector(fwd, 2.5)) < 1e-6);
  assert.ok(near(sheet.rotation.y, 0.6));
  const pointer = (type, x, y, button = 0) => dom.dispatchEvent(Object.assign(new Event(type), { clientX: x, clientY: y, button, pointerId: 7, isPrimary: true }));
  pointer("pointerdown", 400, 300, 2); // right button: ignored
  assert.equal(draw.drawing("mouse"), false);
  pointer("pointerdown", 400, 300);
  assert.equal(draw.drawing("mouse"), true);
  for (let i = 1; i <= 20; i++) pointer("pointermove", 400 + i * 5, 300 - i * 2);
  pointer("pointerup", 500, 260);
  assert.equal(ops.length, 1);
  const obj = ops[0].obj;
  assert.ok(near(obj.ry, 0.6), `faces the camera: ${obj.ry}`);
  const pts = pointsOf(obj.data.strokes[0].pts);
  assert.ok(pts.every(([, , z]) => Math.abs(z) <= 0.005), "flat on the sheet");
  const last = pts[pts.length - 1];
  assert.ok(last[0] > 0.2 && last[1] > 0.05, `drawn right and up: ${last}`);
  draw.setPlaneMode(false);
  assert.equal(draw.planeMode, false);
  assert.equal(scene.getObjectByName("draw:sheet"), undefined);
  assert.deepEqual(seen, [true, false]);
  pointer("pointerdown", 400, 300);
  assert.equal(draw.drawing("mouse"), false, "listeners removed");
  draw.dispose();
});

// ---------- builders and meta ----------

// A fish: closed body, open tail, eye dot.
const FISH = [
  { c: "#9b6bff", w: 0.012, pts: (() => {
    const out = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      out.push(0.3 * Math.cos(a), 0.15 * Math.sin(a), 0);
    }
    return out;
  })() },
  { c: "#9b6bff", w: 0.012, pts: [0.3, 0, 0, 0.5, 0.15, 0, 0.5, -0.15, 0, 0.3, 0, 0] },
  { c: "#9b6bff", w: 0.012, pts: [-0.18, 0.04, 0] },
];

const meshes = (object) => {
  const out = [];
  object.traverse((c) => c.isMesh && out.push(c));
  return out;
};
const trisOf = (object) => meshes(object).reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);

test("drawing builder: glowing tubes around the strokes, frame origin kept, outward faces", () => {
  const object = buildObject({ id: "d1", part: "drawing", p: [0, 0, 0], ry: 0, s: 1, data: { strokes: FISH } });
  const inner = object.userData.inner;
  assert.equal(inner.name, "drawing");
  assert.deepEqual(meshes(inner).map((m) => m.name), ["ink", "halo"], "one merged ink mesh and its halo");
  const [ink, halo] = meshes(inner);
  assert.equal(ink.material.isMeshBasicMaterial, true);
  assert.ok(ink.userData.tint && !halo.userData.tint);
  assert.equal(halo.material.blending, THREE.AdditiveBlending);
  const { min, max } = measure(ink);
  const b = sketchBounds(FISH);
  for (let i = 0; i < 2; i++) {
    assert.ok(near(min[i], b.min[i], 0.012) && near(max[i], b.max[i], 0.012), `axis ${i}: ${min[i]}..${max[i]} vs ${b.min[i]}..${b.max[i]}`);
  }
  assert.ok(max[2] - min[2] <= 0.0125, "flat");
  // Triangles face outward (agree with the vertex normals).
  const pos = ink.geometry.attributes.position;
  const nor = ink.geometry.attributes.normal;
  const idx = ink.geometry.index.array;
  const a = V(0, 0, 0);
  const e1 = V(0, 0, 0);
  const e2 = V(0, 0, 0);
  let bad = 0;
  for (let t = 0; t < idx.length; t += 3) {
    a.fromBufferAttribute(pos, idx[t]);
    e1.fromBufferAttribute(pos, idx[t + 1]).sub(a);
    e2.fromBufferAttribute(pos, idx[t + 2]).sub(a);
    const face = e1.cross(e2);
    if (face.lengthSq() < 1e-14) continue;
    const n = V(0, 0, 0);
    for (let k = 0; k < 3; k++) n.add(V(0, 0, 0).fromBufferAttribute(nor, idx[t + k]));
    if (face.dot(n) <= 0) bad++;
  }
  assert.equal(bad, 0, "inward triangles");
});

test("drawing builder: 6000 points stay under 40k triangles; bad data never throws", () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const strokes = [];
  for (let s = 0; s < 30; s++) {
    const pts = [];
    let x = rand() - 0.5;
    let y = rand() + 1;
    for (let i = 0; i < 200; i++) {
      x += (rand() - 0.5) * 0.03;
      y += (rand() - 0.5) * 0.03;
      pts.push(x, y, (rand() - 0.5) * 0.01);
    }
    strokes.push({ c: s % 2 ? "#ff3366" : "#9b6bff", w: 0.012, pts });
  }
  const object = buildObject({ id: "big", part: "drawing", p: [0, 0, 0], data: { strokes } });
  const tris = trisOf(object);
  assert.ok(tris > 5000 && tris <= 40000, `${tris} triangles`);

  for (const data of [undefined, {}, { strokes: "x" }, { strokes: [null, 3, { pts: [NaN, 1, 2] }, { pts: "abc" }] }, { strokes: [{ pts: [] }] }]) {
    for (const part of ["drawing", "doodle"]) {
      const empty = buildObject({ id: "e", part, p: [0, 0, 0], data });
      assert.equal(empty.userData.inner.name, part);
      assert.equal(meshes(empty).length, 0);
      assert.ok(!empty.userData.meta.placeholder);
    }
  }
  // A single dot is a visible blob.
  const dot = buildObject({ id: "dot", part: "drawing", p: [0, 0, 0], data: { strokes: [{ pts: [0.1, 0.2, 0], c: "#00ff00", w: 0.02 }] } });
  const { size } = measure(dot.userData.inner.getObjectByName("ink"));
  assert.ok(size.every((n) => n > 0.015 && n < 0.03), `dot ${size}`);
});

test("doodle builder: closed strokes become cut-outs, open strokes thick tubes, details on the faces", () => {
  const fish = buildObject({ id: "f", part: "doodle", p: [0, 0, 0], data: { strokes: FISH } }).userData.inner;
  assert.equal(fish.name, "doodle");
  const names = meshes(fish).map((m) => m.name).sort();
  assert.deepEqual(names, ["fill", "paint"]);
  const fill = meshes(fish).find((m) => m.name === "fill");
  assert.ok(fill.userData.tint && fill.material.isMeshStandardMaterial);
  const fb = measure(fill); // body and the closed tail triangle
  assert.ok(near(fb.size[0], 0.8, 0.02) && near(fb.size[1], 0.3, 0.02) && near(fb.size[2], 0.06, 0.002), `fill ${fb.size}`);
  // The eye dot (inside the body) shows on the front and back faces.
  const paint = meshes(fish).find((m) => m.name === "paint");
  const pos = paint.geometry.attributes.position;
  let front = 0;
  let back = 0;
  for (let i = 0; i < pos.count; i++) {
    if (Math.hypot(pos.getX(i) + 0.18, pos.getY(i) - 0.04) > 0.02) continue;
    if (pos.getZ(i) > 0.03) front++;
    if (pos.getZ(i) < -0.03) back++;
  }
  assert.ok(front > 0 && back > 0, `eye on both faces: ${front}/${back}`);

  // Only open strokes: no cut-outs.
  const lines = buildObject({ id: "l", part: "doodle", p: [0, 0, 0], data: { strokes: [{ pts: [0, 0, 0, 0.2, 0.3, 0, 0.4, 0, 0] }, { pts: [0, 0, 0, 0.4, 0.3, 0] }] } }).userData.inner;
  assert.deepEqual(meshes(lines).map((m) => m.name), ["paint"]);
  // Ends 20% of the drawing apart: open.
  const gap = { pts: [0, 0, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0, 0, 0.1, 0] };
  const c = buildObject({ id: "g", part: "doodle", p: [0, 0, 0], data: { strokes: [gap] } }).userData.inner;
  assert.deepEqual(meshes(c).map((m) => m.name), ["paint"]);
  gap.pts.splice(-3, 3, 0, 0.04, 0);
  const closed = buildObject({ id: "h", part: "doodle", p: [0, 0, 0], data: { strokes: [gap] } }).userData.inner;
  assert.deepEqual(meshes(closed).map((m) => m.name).sort(), ["fill", "paint"]);
});

test("metaOfRecord sizes drawings and doodles from their strokes", () => {
  const rec = (part, strokes, s = 1) => ({ id: "m", part, p: [0, 0, 0], s, data: { strokes } });
  const drawing = metaOfRecord(rec("drawing", FISH));
  assert.equal(drawing.category, "custom");
  assert.equal(drawing.origin, "frame");
  assert.equal(drawing.fixed, true);
  assert.ok(near(drawing.size[0], 0.8) && near(drawing.size[1], 0.3) && drawing.size[2] === 0.05, `size ${drawing.size}`);
  assert.deepEqual(metaOfRecord(rec("drawing", [])).size, [0.05, 0.05, 0.05]);
  assert.deepEqual(sizeOfRecord(rec("drawing", FISH, 2)).map((n) => Math.round(n * 100) / 100), [1.6, 0.6, 0.1]);
  assert.equal(metaOfRecord(rec("doodle", FISH)).fixed, false);
  assert.equal(metaOfRecord(rec("doodle", [{ pts: [0, 0, 0, 3.5, 0, 0] }])).fixed, true);
  // Other parts are untouched.
  assert.equal(metaOfRecord({ part: "crate" }).name, "crate");
});

test("marker catalog part: holdable pen with the nib on top", () => {
  const meta = getMeta("marker");
  assert.ok(meta && meta.marker && meta.holdable);
  assert.deepEqual(meta.tip, [0, 0.16, 0]);
  assert.deepEqual(meta.grip, { p: [0, 0.05, 0], r: [-90, 0, 0] });
  for (const alias of ["magic marker", "crayon", "purple crayon", "chalk", "felt tip", "marker pen"]) assert.ok(meta.aliases.includes(alias));
  const { max } = measure(buildObject({ id: "mk", part: "marker", p: [0, 0, 0] }).userData.inner);
  assert.ok(near(max[1], 0.16, 0.006), `nib at ${max[1]}`);
});
