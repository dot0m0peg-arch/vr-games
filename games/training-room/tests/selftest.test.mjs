// Headset check: report schema, frame statistics, stress-scene layout and the result rows.
import test from "node:test";
import assert from "node:assert/strict";
import { newReport, frameStats, stressRecords, validateReport, summarize, REPORT_VERSION, MEASURE_SECONDS } from "../js/selftest.js";
import { getMeta } from "../js/parts/meta/index.js";

const statusOf = (rows, name) => rows.find((row) => row.name === name)?.status;

// A finished headset run: everything works.
function goodReport() {
  const r = newReport({ at: "2026-10-22T12:00:00.000Z", ua: "Mozilla/5.0 (X11; Linux x86_64; Quest 3) OculusBrowser/40.0", device: "headset", secureContext: true });
  Object.assign(r.xr, {
    api: true, supported: true, sessionStarted: true, sessionEnded: true, referenceSpace: "local-floor",
    fps: { avg: 71.9, p5: 68.2, frames: 720, seconds: 10, droppedOver20ms: 2 },
    inputs: [
      { handedness: "left", profiles: ["meta-quest-touch-plus", "generic-trigger-squeeze-thumbstick"], buttons: 7 },
      { handedness: "right", profiles: ["meta-quest-touch-plus", "generic-trigger-squeeze-thumbstick"], buttons: 7 },
    ],
  });
  Object.assign(r.mic, { permission: "granted", audioWorklet: true, mediaRecorder: { supported: true, opus: true }, peakLevel: 0.41 });
  r.speech = { recognition: false, synthesisVoices: 0 };
  r.bridge = { reachable: true, auth: true, model: "qwen3.5:4b", stt: true, tts: true };
  r.whisper = { tried: true, ok: true, text: "AI, spawn a crate", ms: 640 };
  r.tts = { tried: true, ok: true, ms: 380 };
  r.scene = { objects: 15, drawCalls: 140, triangles: 420000 };
  return r;
}

test("a new report matches the schema exactly and survives JSON", () => {
  const r = newReport({ device: "desktop" });
  assert.equal(r.version, REPORT_VERSION);
  assert.deepEqual(validateReport(r), []);
  assert.deepEqual(validateReport(JSON.parse(JSON.stringify(goodReport()))), []);
  assert.deepEqual(Object.keys(r), ["version", "at", "ua", "device", "secureContext", "xr", "mic", "speech", "bridge", "whisper", "tts", "scene"]);
});

test("validateReport names extra, missing and mistyped keys", () => {
  const r = goodReport();
  r.extra = 1;
  delete r.tts.ms;
  r.xr.fps.avg = "fast";
  r.xr.inputs.push({ handedness: "left", profiles: "x", buttons: 1 });
  const problems = validateReport(r);
  assert.ok(problems.includes("extra is not in the schema"), problems.join("; "));
  assert.ok(problems.includes("tts.ms is missing"), problems.join("; "));
  assert.ok(problems.includes("xr.fps.avg should be number"), problems.join("; "));
  const optional = goodReport();
  optional.xr.error = "VR ended early";
  optional.mic.error = "audio stayed suspended";
  optional.whisper.error = "no-stt";
  assert.deepEqual(validateReport(optional), []);
  const badInput = goodReport();
  badInput.xr.inputs[0].profiles = "meta";
  assert.deepEqual(validateReport(badInput), ["xr.inputs[0].profiles should be array"]);
  const badPermission = goodReport();
  badPermission.mic.permission = "maybe";
  assert.equal(validateReport(badPermission).length, 1);
  assert.deepEqual(validateReport(null), ["report is not an object"]);
});

test("frameStats: steady 72 Hz with two hitches", () => {
  const times = [];
  let t = 1000;
  for (let i = 0; i <= 720; i++) {
    times.push(t);
    t += i === 100 || i === 400 ? 41.6 : 1000 / 72;
  }
  const fps = frameStats(times);
  assert.equal(fps.frames, 721);
  assert.equal(fps.droppedOver20ms, 2);
  assert.ok(fps.avg > 71 && fps.avg < 72, String(fps.avg));
  assert.ok(Math.abs(fps.p5 - 72) < 0.5, String(fps.p5)); // 2 slow frames are under 5%
  assert.ok(Math.abs(fps.seconds - 10.03) < 0.05, String(fps.seconds));
});

test("frameStats: the slowest 5% sets p5, and short input gives zeros", () => {
  const times = [0];
  for (let i = 1; i <= 100; i++) times.push(times[i - 1] + (i <= 10 ? 50 : 10));
  const fps = frameStats(times);
  assert.equal(fps.p5, 20); // 10% of frames at 50 ms
  assert.equal(fps.droppedOver20ms, 10);
  assert.deepEqual(frameStats([]), { avg: 0, p5: 0, frames: 0, seconds: 0, droppedOver20ms: 0 });
  assert.deepEqual(frameStats([5]), { avg: 0, p5: 0, frames: 1, seconds: 0, droppedOver20ms: 0 });
  assert.equal(frameStats(null).frames, 0);
});

test("stress scene: catalog parts 3-12 m in front, facing the player", () => {
  for (const [origin, yaw] of [[[0, 0, 0], 0], [[4, 0, -2], Math.PI / 2], [[-3, 0, 7], -2.4]]) {
    const records = stressRecords(origin, yaw);
    assert.equal(records.length, 15);
    const count = (part) => records.filter((r) => r.part === part).length;
    assert.equal(count("villa"), 1);
    assert.equal(count("training dummy"), 6);
    assert.equal(count("card table"), 1);
    assert.equal(count("deck of cards"), 1);
    assert.equal(count("whiteboard"), 1);
    assert.equal(count("tree"), 4);
    assert.equal(count("campfire"), 1);
    assert.equal(new Set(records.map((r) => r.id)).size, 15);
    const forward = [-Math.sin(yaw), -Math.cos(yaw)];
    for (const r of records) {
      assert.ok(getMeta(r.part), `${r.part} is a catalog part`);
      assert.deepEqual(Object.keys(r).filter((k) => k !== "text"), ["id", "part", "label", "p", "ry", "s", "data"]);
      const dx = r.p[0] - origin[0];
      const dz = r.p[2] - origin[2];
      const dist = Math.hypot(dx, dz);
      assert.ok(dist >= 3 - 1e-9 && dist <= 12, `${r.part} at ${dist.toFixed(2)} m`);
      assert.ok(dx * forward[0] + dz * forward[1] >= 3 - 1e-9, `${r.part} is in front`);
      // Fronts face local +Z: ry = atan2(P.x - O.x, P.z - O.z) points at the player.
      assert.ok(Math.abs(Math.atan2(Math.sin(r.ry - Math.atan2(-dx, -dz)), Math.cos(r.ry - Math.atan2(-dx, -dz)))) < 1e-9);
    }
    const table = records.find((r) => r.part === "card table");
    const deck = records.find((r) => r.part === "deck of cards");
    assert.equal(deck.p[1], getMeta("card table").surface);
    assert.ok(Math.hypot(deck.p[0] - table.p[0], deck.p[2] - table.p[2]) < 1e-9);
    assert.equal(records.find((r) => r.part === "whiteboard").text, "Headset check");
  }
});

test("summarize: a good headset run passes every row", () => {
  const rows = summarize(goodReport());
  for (const row of rows) {
    assert.ok(["pass", "fail", "warn", "skip"].includes(row.status));
    assert.equal(typeof row.name, "string");
    assert.equal(typeof row.detail, "string");
  }
  const notPass = rows.filter((row) => row.status !== "pass" && row.status !== "skip");
  assert.deepEqual(notPass, []);
  assert.equal(statusOf(rows, "Frame rate"), "pass");
  assert.match(rows.find((row) => row.name === "Frame rate").detail, /71\.9 fps average.*15 objects, 140 draw calls, 420 k triangles/);
  assert.equal(statusOf(rows, "Controllers"), "pass");
  assert.match(rows.find((row) => row.name === "Whisper on the laptop").detail, /AI, spawn a crate/);
  assert.equal(statusOf(rows, "Browser speech recognition"), "skip"); // Whisper covers it
  assert.equal(statusOf(rows, "Browser voices"), "skip"); // the laptop voice covers it
  assert.equal(statusOf(rows, "Local model"), "pass");
  assert.equal(rows.some((row) => row.name === "Report sent to the laptop"), false);
});

test("summarize: frame-rate thresholds", () => {
  const at = (avg, p5, dropped, frames = 700) => {
    const r = goodReport();
    r.xr.fps = { avg, p5, frames, seconds: 10, droppedOver20ms: dropped };
    return statusOf(summarize(r), "Frame rate");
  };
  assert.equal(at(72, 70, 0), "pass");
  assert.equal(at(72, 40, 0), "warn"); // hitches
  assert.equal(at(72, 70, 60), "warn"); // > 5% dropped
  assert.equal(at(55, 50, 10), "warn");
  assert.equal(at(30, 25, 300), "fail");
  assert.equal(at(72, 70, 0, 5), "fail"); // too few frames
});

test("summarize: prepare phase on the headset waits for the VR test", () => {
  const r = goodReport();
  Object.assign(r.xr, { sessionStarted: false, sessionEnded: false, fps: frameStats([]), referenceSpace: null, inputs: [] });
  const rows = summarize(r);
  assert.equal(statusOf(rows, "VR session"), "skip");
  assert.match(rows.find((row) => row.name === "VR session").detail, /Start VR test/);
  assert.equal(statusOf(rows, "Frame rate"), "skip");
  assert.equal(statusOf(rows, "Controllers"), "skip");
});

test("summarize: failures name the problem", () => {
  const r = goodReport();
  r.secureContext = false;
  r.xr.error = "VR ended after 4.2 s, before the 10 s test finished.";
  r.xr.inputs = [{ handedness: "right", profiles: ["generic-hand"], buttons: 0 }];
  r.mic.permission = "denied";
  r.whisper = { tried: true, ok: false, text: "", ms: 30000, error: "timeout" };
  r.bridge.stt = false;
  r.tts = { tried: true, ok: false, ms: 25000 };
  const rows = summarize(r);
  assert.equal(statusOf(rows, "Secure page (https)"), "fail");
  assert.equal(statusOf(rows, "VR session"), "fail");
  assert.match(rows.find((row) => row.name === "VR session").detail, /4\.2 s/);
  assert.equal(statusOf(rows, "Controllers"), "warn");
  assert.equal(statusOf(rows, "Microphone"), "fail");
  assert.equal(statusOf(rows, "Whisper on the laptop"), "fail");
  assert.match(rows.find((row) => row.name === "Whisper on the laptop").detail, /timeout/);
  assert.equal(statusOf(rows, "Laptop voice"), "fail");
});

test("summarize: mic levels, missing Whisper and standalone devices", () => {
  const quiet = goodReport();
  quiet.mic.peakLevel = 0.005;
  quiet.whisper = { tried: true, ok: true, text: "", ms: 500 };
  let rows = summarize(quiet);
  assert.equal(statusOf(rows, "Microphone"), "warn");
  assert.equal(statusOf(rows, "Whisper on the laptop"), "warn");
  quiet.mic.peakLevel = 0;
  assert.equal(statusOf(summarize(quiet), "Microphone"), "fail");

  const noStt = goodReport();
  noStt.bridge.stt = false;
  noStt.whisper = { tried: false, ok: false, text: "", ms: 0 };
  rows = summarize(noStt);
  assert.equal(statusOf(rows, "Whisper on the laptop"), "warn");
  assert.equal(statusOf(rows, "Browser speech recognition"), "warn");

  const laptop = newReport({ device: "desktop", secureContext: true });
  laptop.speech = { recognition: true, synthesisVoices: 12 };
  laptop.mic.permission = "skipped";
  rows = summarize(laptop);
  assert.equal(statusOf(rows, "WebXR"), "skip");
  assert.equal(statusOf(rows, "VR session"), "skip");
  assert.equal(statusOf(rows, "Microphone"), "skip");
  assert.equal(statusOf(rows, "Laptop bridge"), "warn");
  assert.equal(statusOf(rows, "Local model"), "skip");
  assert.equal(statusOf(rows, "Laptop voice"), "skip");
  assert.match(rows.find((row) => row.name === "Frame rate").detail, /No immersive VR/);
  assert.equal(statusOf(rows, "Browser speech recognition"), "pass");
  assert.equal(statusOf(rows, "Browser voices"), "pass");

  const headsetNoXr = newReport({ device: "headset", secureContext: true });
  assert.equal(statusOf(summarize(headsetNoXr), "WebXR"), "fail");
  const locked = newReport({ device: "headset" });
  locked.bridge.reachable = true;
  assert.equal(statusOf(summarize(locked), "Laptop bridge"), "fail");
});

test("summarize: the laptop's answer to the report post", () => {
  const withPost = (post) => {
    const r = goodReport();
    Object.defineProperty(r, "post", { value: post, enumerable: false });
    assert.deepEqual(validateReport(JSON.parse(JSON.stringify(r))), []);
    return summarize(r).find((row) => row.name === "Report sent to the laptop");
  };
  assert.equal(withPost({ posted: true, saved: "C:\\reports\\headset.json" }).status, "pass");
  assert.equal(withPost({ posted: false, error: "no-bridge" }).status, "skip");
  assert.equal(withPost({ posted: false, error: "not-found" }).status, "fail");
});

test("the measured window is 10 seconds", () => {
  assert.equal(MEASURE_SECONDS, 10);
});
