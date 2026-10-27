// Headset check: measures on the real device what the cloud tests cannot (mic, Whisper and the
// laptop voice through the bridge, browser speech, WebXR frame rate in a busy scene, controllers)
// and posts a report to the laptop bridge: POST api/report { kind: "headset", report }.
//
// Two taps. A mic permission prompt can outlast a click's user activation, and a prompt inside VR
// drops you out of it, so:
//   phase "prepare" (tap 1, flat page): environment, bridge, mic + Whisper, browser speech, laptop voice.
//   phase "vr" (tap 2): requestSession runs before any await (still inside the tap's activation),
//   then 1 s settle + 10 s measured in a temporary stress scene, automatic exit, report posted.
// Every step records its failure in the report; runSelfTest never throws.
import * as THREE from "../vendor/three.module.min.js";
import { kit } from "./parts/build/kit.js";
import { makeCanvas, canvasTexture, roundRect, FONT } from "./util/text.js";
import { Net } from "./net/net.js";
import { concatFloat32, resampleLinear, encodeWav } from "./voice/wav.js";
import { getMeta } from "./parts/meta/index.js";

export const REPORT_VERSION = 1;
export const SETTLE_SECONDS = 1;
export const MEASURE_SECONDS = 10;
const MIC_SECONDS = 1.5;
const VOICES_WAIT_MS = 1500;
const POST_TIMEOUT_MS = 8000;
const STT_RATE = 16000;
const TABLE_TOP = getMeta("card table")?.surface ?? 0.76; // the deck sits on the card table

// Frame-rate verdict: Quest Browser runs WebXR at 72 Hz (90/120 when chosen).
export const FPS_PASS = { avg: 65, p5: 50, dropRatio: 0.05 };
export const FPS_WARN = { avg: 45 };

// Exact report schema ("?" = optional key). Types: boolean, number, string, null, array, or a nested shape.
export const REPORT_SHAPE = {
  version: "number", at: "string", ua: "string", device: "string", secureContext: "boolean",
  xr: {
    api: "boolean", supported: "boolean", sessionStarted: "boolean", sessionEnded: "boolean", "error?": "string",
    fps: { avg: "number", p5: "number", frames: "number", seconds: "number", droppedOver20ms: "number" },
    referenceSpace: "string|null", inputs: "array",
  },
  mic: { permission: "string", audioWorklet: "boolean", mediaRecorder: { supported: "boolean", opus: "boolean" }, peakLevel: "number", "error?": "string" },
  speech: { recognition: "boolean", synthesisVoices: "number" },
  bridge: { reachable: "boolean", auth: "boolean", model: "string|null", stt: "boolean", tts: "boolean" },
  whisper: { tried: "boolean", ok: "boolean", text: "string", ms: "number", "error?": "string" },
  tts: { tried: "boolean", ok: "boolean", ms: "number" },
  scene: { objects: "number", drawCalls: "number", triangles: "number" },
};
const INPUT_SHAPE = { handedness: "string", profiles: "array", buttons: "number" };
export const MIC_PERMISSIONS = ["granted", "denied", "unavailable", "error", "skipped"];

// Stress scene: [part, meters forward, meters right, extra]. Centers 3-12 m in front of the player.
const LAYOUT = [
  ["villa", 12, 0],
  ["training dummy", 4.5, -3.6], ["training dummy", 4.5, -2.4], ["training dummy", 4.5, -1.2],
  ["training dummy", 4.5, 1.2], ["training dummy", 4.5, 2.4], ["training dummy", 4.5, 3.6],
  ["card table", 3, -2.4],
  ["deck of cards", 3, -2.4, { y: TABLE_TOP }],
  ["whiteboard", 3, 2.6, { text: "Headset check" }],
  ["tree", 6, -8], ["tree", 6, 8], ["tree", 8.5, -8], ["tree", 8.5, 8],
  ["campfire", 3, 0],
];

const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;
const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const errText = (err) => clean(err?.message ? `${err.name && err.name !== "Error" ? `${err.name}: ` : ""}${err.message}` : err) || "unknown error";

// Resolves to the promise's value, or `fallback` after ms (a hung browser API must not stall the check).
function within(promise, ms, fallback) {
  let timer = 0;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), ms)))]).finally(() => clearTimeout(timer));
}

// ---------- pure helpers (Node-tested) ----------

export function newReport({ at = new Date().toISOString(), ua = "", device = "desktop", secureContext = false } = {}) {
  return {
    version: REPORT_VERSION, at, ua, device, secureContext,
    xr: {
      api: false, supported: false, sessionStarted: false, sessionEnded: false,
      fps: { avg: 0, p5: 0, frames: 0, seconds: 0, droppedOver20ms: 0 }, referenceSpace: null, inputs: [],
    },
    mic: { permission: "skipped", audioWorklet: false, mediaRecorder: { supported: false, opus: false }, peakLevel: 0 },
    speech: { recognition: false, synthesisVoices: 0 },
    bridge: { reachable: false, auth: false, model: null, stt: false, tts: false },
    whisper: { tried: false, ok: false, text: "", ms: 0 },
    tts: { tried: false, ok: false, ms: 0 },
    scene: { objects: 0, drawCalls: 0, triangles: 0 },
  };
}

// Animation-frame timestamps (ms) → { avg, p5, frames, seconds, droppedOver20ms }. avg is frames per
// second over the window, p5 the frame rate the slowest 5% of frames fall below (nearest rank).
export function frameStats(times) {
  const n = Array.isArray(times) ? times.length : 0;
  if (n < 2) return { avg: 0, p5: 0, frames: n, seconds: 0, droppedOver20ms: 0 };
  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push(times[i] - times[i - 1]);
  const ms = times[n - 1] - times[0];
  const sorted = gaps.slice().sort((a, b) => a - b);
  const slow = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
  return {
    avg: ms > 0 ? round((gaps.length * 1000) / ms, 1) : 0,
    p5: slow > 0 ? round(1000 / slow, 1) : 0,
    frames: n,
    seconds: round(ms / 1000, 2),
    droppedOver20ms: gaps.filter((gap) => gap > 20).length,
  };
}

// Room-style records for the stress scene, facing the player at origin with yaw (three.js rotation.y).
export function stressRecords(origin = [0, 0, 0], yaw = 0) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return LAYOUT.map(([part, forward, right, extra = {}], i) => {
    const x = origin[0] + fx * forward + rx * right;
    const z = origin[2] + fz * forward + rz * right;
    const record = { id: `selftest-${i + 1}`, part, label: part, p: [x, extra.y || 0, z], ry: Math.atan2(origin[0] - x, origin[2] - z), s: 1, data: {} };
    if (extra.text) record.text = extra.text;
    return record;
  });
}

function typeOk(value, type) {
  return String(type).split("|").some((t) => (t === "null" ? value === null : t === "array" ? Array.isArray(value) : typeof value === t && (t !== "number" || Number.isFinite(value))));
}

function checkShape(value, shape, path, problems) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${path || "report"} is not an object`);
    return;
  }
  const keys = new Set(Object.keys(shape).map((k) => k.replace(/\?$/, "")));
  for (const key of Object.keys(value)) if (!keys.has(key)) problems.push(`${path}${key} is not in the schema`);
  for (const [raw, type] of Object.entries(shape)) {
    const optional = raw.endsWith("?");
    const key = raw.replace(/\?$/, "");
    if (!(key in value)) {
      if (!optional) problems.push(`${path}${key} is missing`);
      continue;
    }
    if (typeof type === "object") checkShape(value[key], type, `${path}${key}.`, problems);
    else if (!typeOk(value[key], type)) problems.push(`${path}${key} should be ${type}`);
  }
}

// Problems with a report (empty array = matches the schema exactly).
export function validateReport(report) {
  const problems = [];
  checkShape(report, REPORT_SHAPE, "", problems);
  if (problems.length) return problems;
  if (report.version !== REPORT_VERSION) problems.push(`version should be ${REPORT_VERSION}`);
  if (!MIC_PERMISSIONS.includes(report.mic.permission)) problems.push(`mic.permission should be one of ${MIC_PERMISSIONS.join(", ")}`);
  if (report.mic.peakLevel < 0 || report.mic.peakLevel > 1) problems.push("mic.peakLevel should be 0..1");
  report.xr.inputs.forEach((input, i) => checkShape(input, INPUT_SHAPE, `xr.inputs[${i}].`, problems));
  return problems;
}

const fmtCount = (n) => (n >= 1e6 ? `${round(n / 1e6, 1)} M` : n >= 1e3 ? `${round(n / 1e3, 1)} k` : String(n));

// Report → rows [{ name, status: "pass" | "fail" | "warn" | "skip", detail }] for the result panel.
export function summarize(report) {
  const r = report || newReport();
  const { xr, mic, speech, bridge, whisper, tts, scene } = r;
  const headset = r.device === "headset";
  const linked = bridge.reachable && bridge.auth;
  const rows = [];
  const row = (name, status, detail) => rows.push({ name, status, detail });

  row("Secure page (https)", r.secureContext ? "pass" : "fail", r.secureContext ? "Secure page." : "Not a secure page: the mic and VR need the bridge's https address.");

  if (xr.supported) row("WebXR", "pass", "Immersive VR is available.");
  else if (!xr.api) row("WebXR", headset ? "fail" : "skip", "No WebXR in this browser." + (headset ? "" : " Only needed on the headset."));
  else row("WebXR", headset ? "fail" : "skip", "WebXR is here, but this device cannot start immersive VR.");

  if (xr.error) row("VR session", "fail", xr.error);
  else if (xr.sessionStarted && xr.sessionEnded) row("VR session", "pass", `Entered VR and left it automatically (${xr.referenceSpace || "unknown"} space).`);
  else if (xr.sessionStarted) row("VR session", "fail", "VR did not end cleanly.");
  else row("VR session", "skip", xr.supported ? "Not run yet: tap Start VR test." : "No immersive VR on this device.");

  const notRun = xr.supported ? null : "No immersive VR on this device.";
  if (!xr.sessionStarted) row("Frame rate", "skip", notRun || "Measured in the VR test.");
  else {
    const fps = xr.fps;
    const drops = fps.frames ? fps.droppedOver20ms / fps.frames : 1;
    const detail = `${fps.avg} fps average, ${fps.p5} fps in the slowest 5%, ${fps.droppedOver20ms} of ${fps.frames} frames over 20 ms in ${fps.seconds} s. Scene: ${scene.objects} objects, ${scene.drawCalls} draw calls, ${fmtCount(scene.triangles)} triangles.`;
    let status = "fail";
    if (fps.frames >= 10 && fps.avg >= FPS_PASS.avg && fps.p5 >= FPS_PASS.p5 && drops <= FPS_PASS.dropRatio) status = "pass";
    else if (fps.frames >= 10 && fps.avg >= FPS_WARN.avg) status = "warn";
    row("Frame rate", status, fps.frames >= 10 ? detail : `Too few frames measured (${fps.frames}).`);
  }

  if (!xr.sessionStarted) row("Controllers", "skip", notRun || "Seen in the VR test.");
  else {
    const pads = xr.inputs.filter((input) => input.buttons > 0);
    const sides = new Set(pads.map((input) => input.handedness));
    const profile = pads[0]?.profiles?.[0] || "";
    if (sides.has("left") && sides.has("right")) row("Controllers", "pass", `Left and right controllers${profile ? ` (${profile})` : ""}.`);
    else if (!xr.inputs.length) row("Controllers", "warn", "No controllers or hands seen during the test.");
    else if (!pads.length) row("Controllers", "warn", "Only hand tracking seen: pick up the controllers for the talk and menu buttons.");
    else row("Controllers", "warn", `Only the ${[...sides].join(" and ")} controller was seen.`);
  }

  if (mic.permission === "granted") {
    const level = mic.peakLevel.toFixed(2);
    if (mic.peakLevel >= 0.02) row("Microphone", "pass", `Mic works (peak level ${level}).`);
    else if (mic.peakLevel > 0) row("Microphone", "warn", `Mic is very quiet (peak level ${level}). Speak during the check.`);
    else row("Microphone", "fail", `The mic sent pure silence${mic.error ? ` (${mic.error})` : ""}. Check that it is not muted.`);
  } else if (mic.permission === "skipped") row("Microphone", "skip", "The game's mic is off (turn it on to test it).");
  else if (mic.permission === "denied") row("Microphone", "fail", "Microphone permission was denied: allow it in the browser's site settings.");
  else row("Microphone", "fail", mic.error || "No microphone access here.");

  if (whisper.tried && whisper.ok && whisper.text) row("Whisper on the laptop", "pass", `Heard “${whisper.text}” in ${whisper.ms} ms.`);
  else if (whisper.tried && whisper.ok) row("Whisper on the laptop", "warn", `Answered in ${whisper.ms} ms but heard no words. Say “AI, spawn a crate” during the check.`);
  else if (whisper.tried) row("Whisper on the laptop", "fail", `Failed: ${whisper.error || "no answer"}.`);
  else if (!linked) row("Whisper on the laptop", "skip", "Needs the laptop bridge.");
  else if (!bridge.stt) row("Whisper on the laptop", "warn", "Whisper is not running on the laptop: headset voice commands need it.");
  else row("Whisper on the laptop", "skip", "Needs the microphone.");

  if (speech.recognition) row("Browser speech recognition", "pass", "Available in this browser.");
  else if (whisper.ok) row("Browser speech recognition", "skip", "Not in this browser; Whisper on the laptop listens instead.");
  else row("Browser speech recognition", "warn", "Not in this browser: voice needs Whisper on the laptop.");

  if (speech.synthesisVoices > 0) row("Browser voices", "pass", `${speech.synthesisVoices} speech voices.`);
  else if (tts.ok) row("Browser voices", "skip", "None here; the laptop voice speaks instead.");
  else row("Browser voices", "warn", "No speech voices: replies show as captions only.");

  if (linked) row("Laptop bridge", "pass", "Connected.");
  else if (bridge.reachable) row("Laptop bridge", "fail", "Found, but the room key is missing or wrong.");
  else row("Laptop bridge", "warn", "Not found: standalone mode.");

  if (!linked) row("Local model", "skip", "Needs the laptop bridge.");
  else if (bridge.model) row("Local model", "pass", bridge.model);
  else row("Local model", "warn", "No local model found: the built-in parser answers.");

  if (tts.tried) row("Laptop voice", tts.ok ? "pass" : "fail", tts.ok ? `Audio in ${tts.ms} ms.` : "The laptop voice did not answer.");
  else row("Laptop voice", "skip", linked ? "Off on the laptop (optional)." : "Needs the laptop bridge.");

  const post = r.post;
  if (post) {
    if (post.posted) row("Report sent to the laptop", "pass", "Saved in the bridge's reports folder.");
    else if (post.error === "no-bridge") row("Report sent to the laptop", "skip", "No laptop bridge: use Copy report.");
    else row("Report sent to the laptop", "fail", `Not saved (${post.error}). Use Copy report.`);
  }
  return rows;
}

// ---------- browser steps ----------

async function guard(name, fn, onError) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[selftest] ${name} failed`, err);
    onError?.(err);
    return null;
  }
}

async function checkEnv(report) {
  const { detectDevice } = await import("./config.js");
  report.device = detectDevice();
  report.ua = globalThis.navigator?.userAgent || "";
  report.secureContext = !!globalThis.isSecureContext;
  const xr = globalThis.navigator?.xr;
  report.xr.api = !!xr;
  if (xr?.isSessionSupported) report.xr.supported = !!(await within(xr.isSessionSupported("immersive-vr"), 3000, false));
}

async function checkBridge(report, net) {
  let base = net?.base;
  if (!base) base = (await import("./config.js")).apiBase();
  const probe = await Net.probe(base, net?.key || null);
  const info = probe.info || {};
  report.bridge = {
    reachable: !!probe.bridge,
    auth: !!probe.auth,
    model: info.model?.available ? String(info.model.name || "local model") : null,
    stt: !!info.stt?.available,
    tts: !!info.tts?.available,
  };
}

// Opens the mic with the game's processing, records MIC_SECONDS → { samples, rate } (or null).
async function checkMic(report, voice, say) {
  const mic = report.mic;
  mic.audioWorklet = typeof globalThis.AudioWorkletNode === "function";
  const MR = globalThis.MediaRecorder;
  mic.mediaRecorder = { supported: typeof MR === "function", opus: typeof MR?.isTypeSupported === "function" && !!MR.isTypeSupported("audio/webm;codecs=opus") };
  if (voice?.mode === "off") {
    mic.permission = "skipped";
    return null;
  }
  const devices = globalThis.navigator?.mediaDevices;
  if (!devices?.getUserMedia) {
    mic.permission = "unavailable";
    mic.error = "getUserMedia is not available (the page must be https)";
    return null;
  }
  say("Allow the microphone if asked…");
  let stream;
  try {
    stream = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    mic.permission = err?.name === "NotAllowedError" || err?.name === "SecurityError" ? "denied" : "error";
    mic.error = errText(err);
    return null;
  }
  mic.permission = "granted";
  say("Listening… say “AI, spawn a crate”.");
  try {
    return await record(stream, mic);
  } catch (err) {
    mic.error = errText(err);
    return null;
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}

// Peak level from an AnalyserNode; the PCM itself through a ScriptProcessorNode (works everywhere).
async function record(stream, mic) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) throw new Error("Web Audio is not available");
  const ctx = new Ctx();
  try {
    if (ctx.state === "suspended") await within(ctx.resume(), 1000, null);
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const chunks = [];
    const tap = ctx.createScriptProcessor(4096, 1, 1);
    tap.onaudioprocess = (event) => chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    const mute = ctx.createGain(); // silent sink keeps the tap pulled without echoing the mic
    mute.gain.value = 0;
    source.connect(tap);
    tap.connect(mute);
    mute.connect(ctx.destination);
    const buffer = new Float32Array(analyser.fftSize);
    let peak = 0;
    const end = now() + MIC_SECONDS * 1000;
    while (now() < end) {
      analyser.getFloatTimeDomainData(buffer);
      for (let i = 0; i < buffer.length; i++) peak = Math.max(peak, Math.abs(buffer[i]));
      await sleep(30);
    }
    tap.onaudioprocess = null;
    source.disconnect();
    tap.disconnect();
    mic.peakLevel = round(Math.min(1, peak), 3);
    if (ctx.state !== "running") mic.error = `audio stayed ${ctx.state}`;
    return { samples: concatFloat32(chunks), rate: ctx.sampleRate };
  } finally {
    ctx.close().catch(() => {});
  }
}

async function checkWhisper(report, net, audio, say) {
  const whisper = report.whisper;
  if (!audio || !net?.connected || !report.bridge.stt) return;
  whisper.tried = true;
  if (!audio.samples.length) {
    whisper.error = "no audio was captured";
    return;
  }
  say("Sending the recording to Whisper on the laptop…");
  const start = now();
  try {
    const pcm = resampleLinear(audio.samples, audio.rate, STT_RATE);
    const result = await net.transcribe(new Blob([encodeWav(pcm, STT_RATE)], { type: "audio/wav" }));
    whisper.ok = true;
    whisper.text = clean(result?.text);
  } catch (err) {
    whisper.ok = false;
    whisper.error = err?.code || errText(err);
  }
  whisper.ms = Math.round(now() - start);
}

async function checkSpeech(report) {
  report.speech.recognition = !!(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);
  const synth = globalThis.speechSynthesis;
  if (!synth?.getVoices) return;
  let voices = synth.getVoices();
  if (!voices.length) {
    // Chrome fills the list asynchronously; Quest Browser may never have any.
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        synth.removeEventListener?.("voiceschanged", done);
        resolve();
      };
      const timer = setTimeout(done, VOICES_WAIT_MS);
      synth.addEventListener?.("voiceschanged", done);
    });
    voices = synth.getVoices();
  }
  report.speech.synthesisVoices = voices.length;
}

async function checkTts(report, net, say) {
  if (!net || !report.bridge.tts) return;
  report.tts.tried = true;
  say("Asking the laptop voice for a test phrase…");
  const start = now();
  try {
    const blob = await net.tts("Headset check");
    report.tts.ok = !!(blob && blob.size > 0);
  } catch {
    report.tts.ok = false;
  }
  report.tts.ms = Math.round(now() - start);
}

// ---------- VR stress run ----------

function buildStress({ scene, rig, build }) {
  const yaw = rig?.rotation?.y || 0;
  const origin = rig ? [rig.position.x, 0, rig.position.z] : [0, 0, 0];
  const group = new THREE.Group();
  group.name = "selftest-stress";
  const objects = [];
  for (const record of stressRecords(origin, yaw)) {
    try {
      const object = build.buildObject(record);
      object.position.fromArray(record.p);
      object.rotation.y = record.ry;
      object.scale.setScalar(record.s);
      group.add(object);
      objects.push(object);
    } catch (err) {
      console.warn(`[selftest] could not build ${record.part}`, err);
    }
  }
  scene.add(group);
  return {
    objects,
    update(dt, t) {
      for (const object of objects) {
        const fn = object.userData.hooks?.update;
        if (!fn) continue;
        try {
          fn(dt, t);
        } catch {
          object.userData.hooks.update = null;
        }
      }
    },
    dispose() {
      group.removeFromParent();
      for (const object of objects) kit.disposeObject(object);
    },
  };
}

function fitFont(ctx, text, weight, size, maxWidth) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  const width = ctx.measureText(text).width;
  if (width > maxWidth) ctx.font = `${weight} ${Math.floor((size * maxWidth) / width)}px ${FONT}`;
}

// Head-locked countdown panel (a child of the camera, so it stays in view while looking around).
function countdownPanel(camera) {
  const canvas = makeCanvas(1024, 400);
  if (!canvas || !camera) return null;
  const texture = canvasTexture(canvas);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.51), material);
  mesh.name = "selftest-countdown";
  mesh.renderOrder = 999;
  mesh.frustumCulled = false;
  mesh.position.set(0, -0.1, -1.5);
  camera.add(mesh);
  const draw = (title, sub) => {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(16, 20, 18, 0.92)";
    roundRect(ctx, 0, 0, canvas.width, canvas.height, 36);
    ctx.fill();
    ctx.strokeStyle = "#d5fb6a";
    ctx.lineWidth = 6;
    roundRect(ctx, 3, 3, canvas.width - 6, canvas.height - 6, 33);
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#d5fb6a";
    fitFont(ctx, title, 700, 104, canvas.width - 80);
    ctx.fillText(title, canvas.width / 2, 145);
    ctx.fillStyle = "#eef1e9";
    fitFont(ctx, sub, 400, 60, canvas.width - 80);
    ctx.fillText(sub, canvas.width / 2, 285);
    texture.needsUpdate = true;
  };
  return {
    show(seconds) {
      draw(`Headset check… ${seconds} s`, "Look around, don't press anything");
    },
    dispose() {
      mesh.removeFromParent();
      texture.dispose();
      material.dispose();
      mesh.geometry.dispose();
    },
  };
}

// Counts XR frames for SETTLE + MEASURE seconds. Timestamps are the XR frame times that
// renderer.setAnimationLoop also receives, read through session.requestAnimationFrame so the
// game's own loop keeps running (and rendering) untouched. → { times, completed, stop, elapsed }
function measureFrames({ session, renderer, stress, panel, report }) {
  return new Promise((resolve) => {
    const times = [];
    let start = -1;
    let last = -1;
    let shown = -1;
    let elapsed = 0;
    let infoRead = false;
    let done = false;
    const finish = (completed, stop = "") => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      session.removeEventListener("end", onEnd);
      resolve({ times, completed, stop, elapsed });
    };
    const onEnd = () => finish(false, "ended");
    // Frames stop while the headset is off the head; give up a little after the planned end.
    const safety = setTimeout(() => finish(false, "stalled"), (SETTLE_SECONDS + MEASURE_SECONDS + 8) * 1000);
    session.addEventListener("end", onEnd);
    const tick = (time) => {
      if (done) return;
      if (start < 0) start = time;
      const dt = last < 0 ? 0 : Math.min(0.1, (time - last) / 1000);
      last = time;
      elapsed = (time - start) / 1000;
      stress.update(dt, elapsed);
      const left = Math.min(MEASURE_SECONDS, Math.max(1, Math.ceil(SETTLE_SECONDS + MEASURE_SECONDS - elapsed)));
      if (left !== shown) {
        shown = left;
        panel?.show(left);
      }
      if (elapsed >= SETTLE_SECONDS) times.push(time);
      if (!infoRead && elapsed >= SETTLE_SECONDS + 1) {
        infoRead = true;
        const info = renderer?.info?.render;
        if (info) report.scene = { ...report.scene, drawCalls: info.calls || 0, triangles: info.triangles || 0 };
      }
      if (elapsed >= SETTLE_SECONDS + MEASURE_SECONDS) return finish(true);
      session.requestAnimationFrame(tick);
    };
    session.requestAnimationFrame(tick);
  });
}

async function vrPhase(opts, report, say) {
  const { renderer, scene, camera, rig, xr, build } = opts;
  const out = report.xr;
  Object.assign(out, { sessionStarted: false, sessionEnded: false, fps: frameStats([]), referenceSpace: null, inputs: [] });
  delete out.error;
  // requestSession must run inside the tap's user activation: call it before anything awaits.
  let entering;
  try {
    entering = Promise.resolve(xr.enter());
  } catch (err) {
    entering = Promise.reject(err);
  }
  entering.catch(() => {}); // awaited below
  let stress = null;
  let panel = null;
  try {
    stress = buildStress({ scene, rig, build }); // while the session starts
    report.scene = { objects: stress.objects.length, drawCalls: 0, triangles: 0 };
    say("Starting VR…");
    await entering;
    const session = xr.session;
    if (!session) throw new Error("VR did not start.");
    out.sessionStarted = true;
    out.referenceSpace = xr.referenceSpaceType || null;
    panel = countdownPanel(camera);
    panel?.show(MEASURE_SECONDS);
    say("Measuring in VR…");
    const { times, completed, stop, elapsed } = await measureFrames({ session, renderer, stress, panel, report });
    out.fps = frameStats(times);
    out.inputs = Array.from(session.inputSources || [], (source) => ({
      handedness: String(source.handedness || "none"),
      profiles: Array.from(source.profiles || [], String),
      buttons: source.gamepad?.buttons?.length || 0,
    }));
    if (!completed && stop === "ended") out.error = `VR ended after ${round(elapsed, 1)} s, before the ${MEASURE_SECONDS} s test finished.`;
    else if (!completed) out.error = `Frames stopped after ${round(elapsed, 1)} s (headset taken off?); the ${MEASURE_SECONDS} s test did not finish.`;
  } catch (err) {
    out.error = errText(err);
  } finally {
    panel?.dispose();
    if (xr.session) {
      await guard("exit", () => within(xr.exit(), 5000, null));
      for (let i = 0; i < 30 && xr.session; i++) await sleep(100);
    }
    out.sessionEnded = out.sessionStarted && !xr.session;
    stress?.dispose();
  }
  return report;
}

// POST api/report { kind: "headset", user, report } → { posted: true, saved } | { posted: false, error }.
export async function postReport(net, report) {
  if (!net?.connected) return { posted: false, error: "no-bridge" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(new URL("report", net.base), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json", ...(net.key ? { "x-room-key": net.key } : {}) },
      body: JSON.stringify({ kind: "headset", user: net.user?.id || undefined, report }),
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Empty or non-JSON answer.
    }
    if (!res.ok) return { posted: false, error: typeof body?.error === "string" ? body.error : `http-${res.status}` };
    const saved = body?.saved ?? body?.file ?? body?.path;
    return { posted: true, saved: typeof saved === "string" ? saved : true };
  } catch (err) {
    return { posted: false, error: controller.signal.aborted ? "timeout" : errText(err) };
  } finally {
    clearTimeout(timer);
  }
}

// opts: { phase: "prepare" | "vr", report (from "prepare", for "vr"), renderer, scene, camera, rig,
// xr, net, voice, build, field (unused: the game's loop keeps updating it), log (progress text) }.
// → report (schema REPORT_SHAPE). After phase "vr" the report also carries a non-enumerable
// report.post = { posted, saved | error }, so JSON.stringify(report) stays exactly the schema.
export async function runSelfTest(opts = {}) {
  const { phase = "prepare", net = null, voice = null } = opts;
  const say = (text) => {
    try {
      opts.log?.(text);
    } catch {
      // Progress text is optional.
    }
  };
  if (phase === "vr") {
    const report = opts.report ? JSON.parse(JSON.stringify(opts.report)) : newReport({ ua: globalThis.navigator?.userAgent || "", secureContext: !!globalThis.isSecureContext });
    await vrPhase(opts, report, say);
    if (!opts.report) await guard("env", () => checkEnv(report));
    say("Sending the report to the laptop…");
    const post = await postReport(net, report);
    Object.defineProperty(report, "post", { value: post, enumerable: false, configurable: true, writable: true });
    say(null);
    return report;
  }
  const report = newReport();
  say("Checking this device…");
  await guard("env", () => checkEnv(report));
  say("Looking for the laptop bridge…");
  await guard("bridge", () => checkBridge(report, net));
  const audio = await guard("mic", () => checkMic(report, voice, say), (err) => {
    report.mic.permission = "error";
    report.mic.error = errText(err);
  });
  await guard("whisper", () => checkWhisper(report, net, audio, say), (err) => {
    report.whisper.error = errText(err);
  });
  say("Checking speech…");
  await guard("speech", () => checkSpeech(report));
  await guard("tts", () => checkTts(report, net, say));
  say(null);
  return report;
}
