// Training Room bootstrap: renderer, field, parts, voice, XR/desktop/phone input, laptop bridge.
import * as THREE from "../vendor/three.module.min.js";
import { detectDevice, apiBase, isRemoteBridge, PARAMS, WAKE_WORDS, loadJSON, saveJSON } from "./config.js";
import { UI } from "./ui/ui.js";
import { Hud } from "./ui/hud.js";
import { Field } from "./world/field.js";
import { Phaser, warmUp } from "./world/phase.js";
import { SceneObjects } from "./world/objects.js";
import * as build from "./parts/build/index.js";
import { buildBlueprint } from "./parts/build/blueprint.js";
import { allMeta, registerMeta } from "./parts/meta/index.js";
import { loadRemoteParts } from "./parts/remote.js";
import { XR } from "./xr/xr.js";
import { Interact } from "./play/interact.js";
import { DesktopControls, TouchControls } from "./play/desktop.js";
import { Draw } from "./play/draw.js";
import { inkMaterial, haloMaterial } from "./parts/build/sketch.js";
import { Voice } from "./voice/voice.js";
import { speak, cancelSpeech, canSpeak, setSpeechSource } from "./voice/speak.js";
import { Net } from "./net/net.js";
import { Avatars } from "./net/avatars.js";
import { Share } from "./net/share.js";
import { Room } from "./room.js";
import { Runner } from "./runner.js";
import { makeId } from "./util/ids.js";
import { runSelfTest, summarize } from "./selftest.js";
import { KingdomScene } from "./world/kingdom.js";
import { ADVISOR_WORDS } from "./core/kingdom.js";

const STATE_KEY = "training-room:standalone-state";
const KEY_KEY = "training-room:room-key";
const NAME_KEY = "training-room:name";

const device = detectDevice();
const ui = new UI({ device });
// ?mode=kingdom opens Kingdom mode (and remembers it); ?mode=training turns it off.
if (PARAMS.get("mode") === "kingdom") ui.setSettings({ kingdom: true });
else if (PARAMS.get("mode") === "training") ui.setSettings({ kingdom: false });
const settings = () => ({ hand: "right", quality: device === "desktop" ? "high" : "low", speak: true, wake: false, fast: false, ...ui.settings });

// ---------- renderer, scene, player rig ----------
const stage = document.getElementById("tr-stage") || document.body;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, device === "phone" ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.xr.enabled = true;
renderer.domElement.id = "tr-canvas";
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 4000);
const rig = new THREE.Group();
rig.name = "player-rig";
camera.position.set(0, 1.6, 0);
rig.add(camera);
scene.add(rig);

const field = new Field({ scene, renderer, quality: settings().quality });
const phaser = new Phaser({ scene });
const room = new Room();
const avatars = new Avatars({ scene, localUser: () => me.id });
let net = null;
let share = null;
let me = { id: "local", name: loadJSON(NAME_KEY, defaultName()), device };
let bridgeInfo = null;

const xr = new XR({ renderer, scene, camera, rig });
const desktop = new DesktopControls({ camera, rig, dom: renderer.domElement });
const touch = new TouchControls({ camera, rig, dom: renderer.domElement });
const hud = new Hud({ scene, camera });
hud.setVisible(false);

// ---------- poses ----------
const tmpPos = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const handCache = { left: { p: new THREE.Vector3(), q: new THREE.Quaternion() }, right: { p: new THREE.Vector3(), q: new THREE.Quaternion() } };

function headPose() {
  camera.getWorldPosition(tmpPos);
  camera.getWorldDirection(tmpDir);
  camera.getWorldQuaternion(tmpQuat);
  return { p: tmpPos.toArray(), q: tmpQuat.toArray(), yaw: Math.atan2(-tmpDir.x, -tmpDir.z), pitch: Math.asin(Math.max(-1, Math.min(1, tmpDir.y))) };
}

function localHand(hand) {
  const out = handCache[hand];
  if (xr.presenting) return xr.handPose(hand, out);
  return desktop.handPose(hand, out);
}

function getHand(user, hand) {
  if (user === me.id) return interact.applySwing(hand, localHand(hand));
  return avatars.handPose(user, hand);
}

function playerPose() {
  const head = headPose();
  const hands = {};
  for (const hand of ["left", "right"]) {
    const pose = localHand(hand);
    hands[hand] = pose ? { p: pose.p.toArray(), q: pose.q.toArray() } : null;
  }
  const pose = { user: me.id, ...head, hands };
  // "over there" lands where the right hand (or the view) points at the ground; in Kingdom mode
  // "right here" does too (place.js).
  const aim = aimPoint();
  if (aim) pose.aim = aim;
  if (settings().kingdom) pose.aimHere = true;
  return pose;
}

// The ground spot under the right-hand laser (VR) or the view center (flat screen), so "put a bed
// right there" lands where the player points.
const aimRay = new THREE.Raycaster();
const AIM_RANGE = 120;
function aimPoint() {
  let origin;
  let dir;
  if (xr.presenting) {
    if (!xr.rayFrom("right", aimRay)) return null;
    origin = aimRay.ray.origin;
    dir = aimRay.ray.direction;
  } else {
    camera.getWorldPosition(aimRay.ray.origin);
    camera.getWorldDirection(aimRay.ray.direction);
    origin = aimRay.ray.origin;
    dir = aimRay.ray.direction;
  }
  if (dir.y > -0.02) return null;
  const k = -origin.y / dir.y;
  const x = origin.x + dir.x * k;
  const z = origin.z + dir.z * k;
  if (Math.hypot(x - origin.x, z - origin.z) > AIM_RANGE) return null;
  return [Math.round(x * 1000) / 1000, 0, Math.round(z * 1000) / 1000];
}

// The phone (and a laptop in follow mode) acts for the headset player: "in my hand" means their hand.
let following = false;
function headsetUser() {
  return net?.connected ? lastUsers.find((u) => u.device === "headset" && u.id !== me.id) : null;
}
function actingPose() {
  const target = headsetUser();
  if (target && (device === "phone" || following)) {
    const head = avatars.headPose(target.id);
    if (head) {
      const hands = {};
      for (const hand of ["left", "right"]) {
        const pose = avatars.handPose(target.id, hand);
        hands[hand] = pose ? { p: pose.p.toArray(), q: pose.q.toArray() } : null;
      }
      return { user: target.id, p: head.p, yaw: head.yaw, hands };
    }
  }
  return playerPose();
}

// ---------- room → objects ----------
const kingdom = new KingdomScene({ scene, room, sizeOf: (record) => build.sizeOfRecord(record) });
const objects = new SceneObjects({ scene, room, build, phaser, getHand, share: { textureFor: (stream) => share?.textureFor(stream) || null, prune: (shown) => share?.prune(shown) } });
const thrownByMe = new Set();

function send(op) {
  op.uid = op.uid || makeId("u");
  op.by = me.id;
  if (op.fly) thrownByMe.add(op.id);
  room.apply(op, { local: true });
  if (net?.connected) sendToBridge(op, 1);
}

// Ops are idempotent (same id and uid), so a timed-out send is retried once before warning.
function sendToBridge(op, retries) {
  net.sendOp(op).catch((err) => {
    if (err.code === "timeout" && retries > 0) return sendToBridge(op, retries - 1);
    console.warn("[net] op failed", err);
    ui.toast(err.code === "timeout" ? "The laptop is slow to answer; that change may not have reached it." : "The laptop did not accept that change.", "warn");
  });
}

objects.on("landed", ({ id, p, ry }) => {
  if (!thrownByMe.delete(id)) return;
  send({ t: "set", id, patch: { p, ry } });
});

let saveTimer = 0;
room.on("change", (op) => {
  ui.setObjects(room.records());
  if (!op?.transient) updateDrawingAvailable();
  if (!net?.connected && !op?.transient) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveJSON(STATE_KEY, room.snapshot()), 600);
  }
});
room.on("env", (time) => {
  field.setTime(time || "day", { instant: !time });
  ui.setTime(time || "day");
  hud.setTime?.(time || "day");
});

const interact = new Interact({
  objects,
  room,
  getUser: () => me.id,
  metaOf: (record) => build.metaOfRecord(record),
  send,
  fx: (fx) => net?.connected && net.sendFx(fx),
});
interact.on("haptic", ({ hand, intensity }) => xr.haptic(hand, intensity, 50));

// ---------- magic marker ----------
// Strokes go through the runner's history so "undo" takes back the last stroke.
const draw = new Draw({ scene, room, send: (op) => runner.sendTracked([op], "stroke"), getUser: () => me.id, newId: makeId });
const penDown = { left: false, right: false };
const tipWorld = new THREE.Vector3();
let markerInHand = false;

function markerHeld(hand) {
  const id = interact.held(hand);
  const record = id && room.get(id);
  return record && build.metaOfRecord(record).marker ? record : null;
}

function markerTip(hand, out) {
  const record = markerHeld(hand);
  const object = record && objects.get(record.id);
  const tip = record && build.metaOfRecord(record).tip;
  if (!object || !tip) return null;
  object.updateMatrixWorld(true);
  return (object.userData.inner || object).localToWorld(out.fromArray(tip));
}

// Drawings face the person drawing them.
function faceYawFrom(point) {
  camera.getWorldPosition(tmpPos);
  return Math.atan2(tmpPos.x - point.x, tmpPos.z - point.z);
}

function setMarkerMode(on) {
  draw.setPlaneMode(on, { camera, dom: renderer.domElement });
  desktop.mouseLook = !on;
  if (on) desktop.unlock();
  ui.setMarker({ on, color: draw.color });
}

function giveMarker() {
  runner.exec([{ do: "spawn", what: { part: "marker" }, place: { rel: "hand", hand: settings().hand || "right" } }], { label: "marker" });
}

function updateDrawingAvailable() {
  const available = !!draw.latestDrawing(me.id, playerPose());
  ui.setDrawingAvailable(available);
  hud.setDrawingAvailable?.(available);
}

// ---------- commands, replies ----------
const runner = new Runner({ room, send, getNet: () => net, getPlayer: actingPose, getUser: () => me.id, settings, getDraw: () => draw });
let summonHandle = null;
let speakSeq = 0;
runner.on("thinking", () => {
  const pose = playerPose();
  const ahead = new THREE.Vector3(pose.p[0] - Math.sin(pose.yaw) * 2.2, 0, pose.p[2] - Math.cos(pose.yaw) * 2.2);
  summonHandle?.stop();
  summonHandle = phaser.summon(ahead, 0.9);
  ui.setReply("Thinking…", { source: "model" });
  hud.setReply("Thinking…", { source: "model" });
});
runner.on("done", () => {
  summonHandle?.stop();
  summonHandle = null;
});
runner.on("reply", ({ text, source, speak: spoken }) => {
  ui.setReply(text, { source });
  hud.setReply(text, { source });
  if (net?.connected) net.sendSay(text);
  if (spoken && settings().speak && canSpeak()) {
    // Only the latest reply clears "speaking": a newer reply cancels the older one first.
    const n = ++speakSeq;
    voice.setSpeaking(true);
    speak(text).finally(() => {
      if (n === speakSeq) voice.setSpeaking(false);
    });
  }
});
runner.on("parts-changed", () => ui.setParts(allMeta()));
runner.on("designing", ({ name }) => {
  ui.setReply(`Designing ${name}…`, { source: "model" });
  hud.setReply(`Designing ${name}…`, { source: "model" });
});
runner.on("ignored", ({ text }) => {
  ui.setReply(`Heard "${text}" (not a request).`, { source: "system" });
  hud.setReply(`Heard "${text}"`, { source: "system" });
});
runner.on("advisor", ({ id }) => kingdom.speak(id));

// ---------- voice ----------
// Phones release the mic right after each utterance: an open Bluetooth mic keeps the headset in
// low-quality call mode. Headset and laptop keep it warm for 30 s so the next press is instant.
const voice = new Voice({ wakeWords: WAKE_WORDS, idleReleaseMs: device === "phone" ? 1200 : 30000 });
let talking = false;
voice.on("state", (state) => {
  talking = !!state.talking;
  ui.setMic(state);
  hud.setMic(state);
});
voice.on("level", (v) => {
  ui.setLevel(v);
  hud.setLevel(v);
});
voice.on("interim", (text) => {
  ui.setHeard(text, { interim: true });
  hud.setHeard(text, { interim: true });
});
voice.on("final", ({ text, rest, wakeMatched }) => {
  ui.setHeard(text);
  hud.setHeard(text);
  // Kingdom mode keeps the advisor's title ("Builder, …") so the runner knows who was addressed.
  runner.run(voice.mode === "wake" && wakeMatched && !settings().kingdom ? rest : text, { source: "voice" });
});
voice.on("error", (message) => {
  ui.toast(message, "warn");
  hud.toast(message);
});
voice.on("blocked", () => {
  const hint = xr.presenting ? "Mic is off. Press Y to turn it on." : "Mic is off. Turn it on with the mic switch (M).";
  ui.toast(hint, "warn");
  hud.toast(hint);
});

// Kingdom mode: advisors appear and their titles work as wake words.
function applyKingdom(on) {
  kingdom.setEnabled(on);
  voice.wakeWords = on ? [...WAKE_WORDS, ...ADVISOR_WORDS] : WAKE_WORDS;
  if (xr.presenting) xr.setLaser("right", true, on ? 40 : 6);
}

let lastMicMode = "push";
function setMicMode(mode) {
  if (mode !== "off") lastMicMode = mode;
  cancelSpeech();
  voice.setMode(mode);
}
function toggleMute() {
  setMicMode(voice.mode === "off" ? lastMicMode : "off");
}
function talkDown() {
  cancelSpeech();
  voice.pressTalk();
}
function talkUp() {
  voice.releaseTalk();
}

// ---------- XR input ----------
const raycaster = new THREE.Raycaster();
xr.on("start", () => {
  ui.hideLaunch();
  desktop.disable();
  touch.disable();
  hud.setVisible(true);
  hud.attachTo(xr.hands.left.grip);
  xr.setLaser("right", true, settings().kingdom ? 40 : 6);
});
xr.on("end", () => {
  hud.setVisible(false);
  hud.attachTo(null);
  interact.releaseAll();
  camera.position.set(0, 1.6, 0);
  camera.quaternion.identity();
  ui.showLaunchAgain(selfTesting ? null : "Left VR. Your room is still here.");
});
xr.on("turn", () => interact.resetMotion());
xr.on("teleport", () => interact.resetMotion());
xr.on("button", ({ hand, name, pressed }) => {
  if (name === "a") return pressed ? talkDown() : talkUp();
  if (name === "b" && pressed) return hand === "left" ? toggleMute() : hud.toggleMenu();
  if (name === "squeeze") {
    const pose = xr.handPose(hand);
    if (!pose) return;
    if (pressed) {
      const hasRay = xr.rayFrom(hand, raycaster);
      const id = interact.grab(hand, { point: pose.p, quat: pose.q, raycaster: hasRay ? raycaster : null });
      if (id) xr.haptic(hand, 0.3, 30);
    } else {
      interact.release(hand);
    }
    return;
  }
  if (name === "trigger") {
    if (pressed && xr.rayFrom(hand, raycaster) && hud.click(raycaster)) return;
    if (markerHeld(hand)) {
      if (pressed) {
        const tip = markerTip(hand, tipWorld);
        if (tip) {
          draw.begin(hand, tip, faceYawFrom(tip));
          penDown[hand] = true;
        }
      } else if (penDown[hand]) {
        penDown[hand] = false;
        draw.end(hand);
      }
      return;
    }
    if (pressed && xr.rayFrom(hand, raycaster)) flipPointed(raycaster);
  }
});

function flipPointed(ray) {
  const hit = objects.pick(ray);
  const record = hit && room.get(hit.id);
  if (record?.part === "playing card") {
    send({ t: "set", id: record.id, patch: { data: { ...record.data, faceUp: !record.data?.faceUp } } });
  }
}

hud.on("action", ({ name, value }) => {
  if (name === "mic-mode") setMicMode(value);
  else if (name === "undo") runner.undo();
  else if (name === "clear") runner.exec([{ do: "clear" }], { label: "clear" });
  else if (name === "time") runner.exec([{ do: "time", value }], { label: "time" });
  else if (name === "spawn") runner.exec([{ do: "spawn", what: { part: value }, place: { rel: "front" } }], { label: value });
  else if (name === "exit-vr") xr.exit();
  else if (name === "marker") giveMarker();
  else if (name === "realize" || name === "guess") runner.markerFlow({ do: name });
  else if (name === "erase") runner.exec([{ do: "erase" }], { label: "erase" });
});

// ---------- desktop & phone input ----------
desktop.on("key", ({ key, down, repeat }) => {
  if (repeat) return;
  if (key === "v") return down ? talkDown() : talkUp();
  if (!down) return;
  if (key === "m") toggleMute();
  else if (key === "f") setMarkerMode(!draw.planeMode);
  else if (key === "escape" && draw.planeMode) setMarkerMode(false);
  else if (key === "z") runner.undo();
  else if (key === "e") desktopGrab();
  else if (key === "q") desktopThrow();
});
desktop.on("swing", () => interact.swing("right"));

function desktopGrab() {
  if (interact.held("right")) {
    interact.release("right", { velocity: new THREE.Vector3() });
    return;
  }
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const pose = localHand("right");
  interact.grab("right", { point: pose.p, quat: pose.q, raycaster });
}

function desktopThrow() {
  if (!interact.held("right")) return;
  camera.getWorldDirection(tmpDir);
  interact.release("right", { velocity: tmpDir.clone().multiplyScalar(9).add(new THREE.Vector3(0, 2.5, 0)) });
}

// ---------- UI events ----------
// Ask for the mic on the flat page first: a permission prompt inside VR would drop you out of it.
let micAsked = false;
ui.on("enter-vr", async () => {
  await unlockAudio();
  let justAsked = false;
  if (!micAsked && voice.mode !== "off") {
    micAsked = true;
    justAsked = await voice.prepare();
  }
  try {
    await xr.enter();
  } catch (err) {
    ui.toast(justAsked ? "Microphone ready. Press Enter VR again." : err.message || "Could not start VR.", justAsked ? "info" : "error");
  }
});
ui.on("play-flat", async () => {
  await unlockAudio();
  ui.hideLaunch();
  if (device === "phone") touch.enable();
  else desktop.enable();
});
ui.on("command", (text) => runner.run(text, { source: "typed" }));
ui.on("talk-down", talkDown);
ui.on("talk-up", talkUp);
ui.on("mic-mode", setMicMode);
ui.on("undo", () => runner.undo());
ui.on("clear", () => runner.exec([{ do: "clear" }], { label: "clear" }));
ui.on("spawn", (name) => runner.exec([{ do: "spawn", what: { part: name }, place: { rel: "front" } }], { label: name }));
ui.on("remove", (id) => runner.exec([{ do: "remove", target: { id } }], { label: "remove" }));
ui.on("time", (value) => runner.exec([{ do: "time", value }], { label: "time" }));
ui.on("follow", (on) => {
  following = !!on;
  const target = headsetUser();
  // Resolve the headset player every frame: they may rejoin with a new id.
  touch.setFollow(on && target ? () => {
    const current = headsetUser();
    return current ? avatars.headPose(current.id) : null;
  } : null);
  ui.setFollow(following && !!target);
});
ui.on("share", async (kind) => {
  if (!share) return ui.toast("Sharing needs the laptop bridge.", "warn");
  if (kind === "stop") return share.stop();
  try {
    const stream = await share.start(kind);
    const target = headsetUser();
    const pose = target ? actingPoseFor(target.id) : playerPose();
    runner.exec([{ do: "spawn", what: { part: "screen" }, place: { rel: "front", dist: 3 } }], {
      label: "share",
      player: pose,
      decorate: (op) => {
        if (op.t === "add") op.obj.data = { ...(op.obj.data || {}), stream };
      },
    });
    ui.setShare({ active: true, kind });
  } catch (err) {
    ui.toast(err.message || "Sharing was cancelled.", "warn");
  }
});
ui.on("room-key", (key) => connectBridge(String(key || "").trim().toUpperCase()));
ui.on("marker", (on) => setMarkerMode(!!on));
ui.on("marker-color", (hex) => {
  draw.setColor(hex);
  ui.setMarker({ color: draw.color });
});
ui.on("realize", () => runner.markerFlow({ do: "realize" }));
ui.on("guess", () => runner.markerFlow({ do: "guess" }));
ui.on("erase", () => runner.exec([{ do: "erase" }], { label: "erase" }));
ui.on("undo-stroke", () => runner.undo());
// Phone sketch pad: the sketch appears in front of whoever the phone acts for.
ui.on("sketch", ({ lines, aspect, color, realize }) => {
  if (color) draw.setColor(color);
  const id = draw.importSketch({ lines, aspect, color }, { pose: actingPose() });
  if (id && realize) runner.markerFlow({ do: "realize", target: { id } });
  else if (id) ui.toast("Sketch sent. Say \"make it real\" when you're ready.");
});
ui.on("settings", (next) => {
  field.setQuality(next.quality || "high");
  if (!!next.kingdom !== kingdom.enabled) applyKingdom(!!next.kingdom);
  if (next.wake && voice.mode === "push") setMicMode("wake");
  if (!next.wake && voice.mode === "wake") setMicMode("push");
});

function actingPoseFor(userId) {
  const head = avatars.headPose(userId);
  if (!head) return playerPose();
  return { user: userId, p: head.p, yaw: head.yaw, hands: { left: null, right: null } };
}

// ---------- headset check (js/selftest.js) ----------
// Tap 1 ("prepare") runs on the flat page: mic prompt, Whisper, speech, bridge. Tap 2 ("vr") must
// reach requestSession inside its own click, so nothing is awaited before runSelfTest, which enters
// VR first, measures 10 s, exits and posts the report to the laptop.
let selfTestReport = null;
let selfTesting = false;
ui.on("selftest", async ({ phase }) => {
  if (selfTesting) return;
  selfTesting = true;
  try {
    const report = await runSelfTest({
      phase, report: selfTestReport, renderer, scene, camera, rig, xr, net, voice, build, field,
      log: (text) => ui.setSelfTestBusy(text),
    });
    selfTestReport = report;
    ui.showSelfTest(summarize(report), { canStartVR: report.xr.supported, saved: report.post?.posted ? report.post.saved : null, report });
  } catch (err) {
    ui.setSelfTestBusy(null);
    ui.toast(`The check stopped: ${err.message || err}`, "error");
  } finally {
    selfTesting = false;
  }
});

// ---------- laptop bridge ----------
let lastUsers = [];

async function connectBridge(key = null) {
  const base = apiBase();
  const roomKey = key || PARAMS.get("key") || loadJSON(KEY_KEY, null);
  ui.setConnection({ state: "connecting" });
  let probe;
  // A laptop busy with its model can miss the first short probe: ask again, waiting longer.
  for (const timeout of [2500, 8000, 15000]) {
    probe = await Net.probe(base, roomKey, { timeout });
    if (probe.bridge || !probe.timeout) break;
  }
  if (!probe.bridge) {
    ui.setConnection({ state: "standalone" });
    return false;
  }
  if (!probe.auth) {
    ui.setConnection({ state: "standalone" });
    ui.showLaunch(launchInfo({ state: "needs-key", info: probe.info }));
    if (key) ui.toast("That room key did not work.", "error");
    return false;
  }
  if (roomKey) saveJSON(KEY_KEY, roomKey);
  bridgeInfo = probe.info;
  net?.leave();
  net = new Net({ base, key: isRemoteBridge() || key ? roomKey : null });
  wireNet(net);
  const joined = await net.join({ name: me.name, device });
  me = { ...me, ...joined.user };
  placeAtSpawn();
  room.load(joined.state);
  // Undo steps from before joining belong to a different room.
  runner.history.length = 0;
  runner.lastIds = [];
  setUsers(joined.users || []);
  share = new Share({ net });
  share.on("ended", (stream, info) => {
    if (info?.local) ui.setShare({ active: false });
  });
  applyBridgeInfo(bridgeInfo);
  if (device === "desktop") ui.showJoinQR(joinUrl());
  loadLaptopParts(true);
  return true;
}

function loadLaptopParts(announce = false) {
  if (!net) return;
  loadRemoteParts(net, { registerMeta, registerBuilder: build.registerBuilder, buildBlueprint })
    .then(({ count, errors }) => {
      ui.setParts(allMeta());
      if (errors?.length) console.warn("[parts] laptop parts bin issues", errors);
      if (count && announce) ui.toast(`Loaded ${count} parts from the laptop parts bin.`);
    })
    .catch((err) => console.warn("[parts] could not load the laptop parts bin", err));
}

// Devices in one room start on different spots around the center, facing it.
function placeAtSpawn() {
  const spots = { headset: [0, 0], desktop: [2.5, 3], phone: [-2.5, 3] };
  const [x, z] = spots[device] || [0, 0];
  if (rig.position.lengthSq() > 0.01) return;
  rig.position.set(x, 0, z);
  rig.rotation.y = Math.atan2(x, z);
}

// Model, Whisper and laptop voice can start after the page loaded (or restart): re-read hello.
function applyBridgeInfo(info) {
  if (!info || !net) return;
  bridgeInfo = info;
  runner.modelAvailable = !!info.model?.available;
  runner.parserFirst = !!info.parserFirst;
  // A slow laptop model may take longer than the default request timeouts: wait a little past the bridge.
  if (info.timeouts?.model > 0) net.timeouts.command = Math.max(30000, info.timeouts.model + 5000);
  if (info.timeouts?.vision > 0) net.timeouts.interpret = Math.max(50000, Math.max(info.timeouts.vision, info.timeouts.model || 0) + 5000);
  // The headset browser may have no speech voices; the laptop can speak for it.
  setSpeechSource(info.tts?.available ? (text) => net.tts(text) : null);
  voice.setTranscriber(info.stt?.available ? (blob) => net.transcribe(blob) : null);
  ui.setConnection({ state: "online", model: info.model, stt: info.stt, url: joinUrl(), users: lastUsers });
  hud.setConnection?.({ state: "online", model: info.model });
}

async function refreshBridgeInfo() {
  if (!net?.connected) return;
  try {
    const probe = await Net.probe(apiBase(), net.key);
    if (probe.bridge && probe.auth) applyBridgeInfo(probe.info);
  } catch {
    // Offline for a moment; the next refresh or reconnect tries again.
  }
}
setInterval(refreshBridgeInfo, 30000);
// Markers whose design was lost (undo of "clear", a device that reloaded mid-design) get designed again.
setInterval(() => runner.adoptDesigns(), 15000);

function joinUrl() {
  const lan = bridgeInfo?.lan?.[0];
  if (!lan) return null;
  if (/[?&]k=/.test(lan) || !bridgeInfo.key) return lan;
  return `${lan}${lan.includes("?") ? "&" : "?"}k=${encodeURIComponent(bridgeInfo.key)}`;
}

function setUsers(users) {
  lastUsers = users;
  avatars.setUsers(users);
  ui.setUsers(users);
  const headset = headsetUser();
  ui.setFollowAvailable(!!headset);
  if (following && !headset) {
    following = false;
    touch.setFollow(null);
    ui.setFollow(false);
  }
}

function wireNet(client) {
  client.on("op", ({ seq, op }) => room.apply(op, { seq }));
  client.on("state", ({ state }) => state && room.load(state));
  client.on("parts", () => loadLaptopParts(false));
  client.on("users", setUsers);
  client.on("poses", (poses) => avatars.setPoses(poses));
  client.on("fx", ({ user, fx }) => {
    if (user !== me.id && fx?.kind === "hit" && objects.get(fx.id)) objects.hit(fx.id, fx.power || 0.5);
  });
  client.on("share", (event) => share?.handle(event));
  client.on("say", ({ user, text }) => {
    if (user === me.id) return;
    const who = lastUsers.find((u) => u.id === user)?.name || "Someone";
    hud.toast(`${who}: ${text}`);
    ui.toast(`${who}: ${text}`);
  });
  client.on("rejoined", ({ state, user }) => {
    if (user) me = { ...me, ...user };
    room.load(state);
    refreshBridgeInfo();
  });
  client.on("status", (status) => {
    if (status === "offline") ui.setConnection({ state: "offline" });
    if (status === "online") {
      ui.setConnection({ state: "online", model: bridgeInfo?.model, stt: bridgeInfo?.stt, url: joinUrl(), users: lastUsers });
      refreshBridgeInfo();
    }
  });
}

function launchInfo(bridge) {
  return { xr: xrSupported, bridge, voice: { engine: voice.engine } };
}

// ---------- startup ----------
let xrSupported = false;
let audioUnlocked = false;

async function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    if (canSpeak()) window.speechSynthesis.getVoices();
  } catch {
    // Speech is optional.
  }
}

function defaultName() {
  return device === "headset" ? "Headset" : device === "phone" ? "Phone" : "Laptop";
}

function seedWelcome() {
  if (room.records().length) return;
  if (settings().kingdom) {
    runner.exec([
      { do: "spawn", what: { part: "whiteboard" }, place: { rel: "at", p: [0, 0, -5] }, text: "Your Kingdom\n\nPoint at the ground and say:\n\"Builder, build a castle here\"\n\"Builder, build a house right here\"\n\"Steward, how is the kingdom?\"\n\"Marshal, how are our defenses?\"\n\nHold A/X (VR) or V (desktop) to talk." },
    ], { label: "welcome" });
    runner.history.length = 0;
    return;
  }
  runner.exec([
    { do: "spawn", what: { part: "whiteboard" }, place: { rel: "at", p: [0, 0, -5] }, text: "Training Room\n\nSay or type:\n\"AI, spawn a villa to my left\"\n\"AI, spawn an axe in my hand\"\n\"AI, spawn a deck of playing cards on a card table\"\n\nHold A/X (VR) or V (desktop) to talk. Y or M mutes the mic." },
  ], { label: "welcome" });
  runner.history.length = 0;
}

async function start() {
  ui.setLoading("Growing the grass…");
  applyKingdom(!!settings().kingdom);
  ui.setParts(allMeta());
  ui.setMic({ mode: voice.mode, listening: false, engine: voice.engine });
  phaser.precompile?.(renderer, camera);
  // Compile first-use shaders now (HUD, controllers, teleport arc, marker ink, stars) to avoid hitches in VR.
  warmUp(renderer, scene, camera, [inkMaterial(), haloMaterial()]);
  xrSupported = await xr.isSupported().catch(() => false);
  const online = await connectBridge().catch((err) => {
    console.warn("[net] bridge connection failed", err);
    ui.setConnection({ state: "standalone" });
    return false;
  });
  if (!online) {
    const saved = loadJSON(STATE_KEY, null);
    if (saved) room.load(saved);
    seedWelcome();
  }
  ui.setLoading(null);
  ui.showLaunch(launchInfo({ state: online ? "online" : bridgeInfo ? "needs-key" : "none", info: bridgeInfo }));
}

// Hover highlight: raycasting dense meshes every frame is costly on a Quest, so only re-pick when
// the laser moved a little or the room changed.
const lastHover = { origin: new THREE.Vector3(Infinity, 0, 0), dir: new THREE.Vector3(), id: null, version: -1 };
let roomVersion = 0;
room.on("change", () => roomVersion++);
function hoverPick(ray) {
  const still = ray.ray.origin.distanceToSquared(lastHover.origin) < 9e-6 && ray.ray.direction.dot(lastHover.dir) > 0.99999;
  if (still && lastHover.version === roomVersion) return lastHover.id;
  lastHover.origin.copy(ray.ray.origin);
  lastHover.dir.copy(ray.ray.direction);
  lastHover.version = roomVersion;
  lastHover.id = objects.pick(ray, { skipDrawings: true })?.id || null;
  return lastHover.id;
}

// ---------- frame loop ----------
const headWorld = new THREE.Vector3();
let poseTimer = 0;
let lastFrame = performance.now();
let t = 0;

renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;
  t += dt;
  if (xr.presenting) xr.update(dt);
  else if (touch.following || touch.enabled) touch.update(dt);
  else if (desktop.enabled) desktop.update(dt);

  camera.getWorldPosition(headWorld);
  field.update(dt, t, headWorld);
  if (kingdom.enabled) {
    const head = headPose();
    kingdom.update(dt, t, head);
    kingdom.setAim(aimPoint());
  }
  interact.update(dt, { left: localHand("left"), right: localHand("right") });
  objects.update(dt, t);
  avatars.update(dt);
  phaser.update(dt);
  hud.update(dt);
  for (const hand of ["left", "right"]) {
    if (!penDown[hand]) continue;
    const tip = markerTip(hand, tipWorld);
    if (tip) draw.move(hand, tip);
    else {
      penDown[hand] = false;
      draw.end(hand);
    }
  }
  draw.update(dt);
  const holdingMarker = xr.presenting && !!(markerHeld("left") || markerHeld("right"));
  if (holdingMarker !== markerInHand) {
    markerInHand = holdingMarker;
    hud.setMarkerHeld(holdingMarker, { color: draw.color });
  }

  if (xr.presenting && xr.rayFrom("right", raycaster)) {
    if (!hud.hover(raycaster)) objects.setHighlight(interact.held("right") ? null : hoverPick(raycaster));
  }

  poseTimer += dt;
  if (net?.connected && poseTimer > 1 / 15) {
    poseTimer = 0;
    net.sendPose({ ...playerPose(), device, talking });
  }
  renderer.render(scene, camera);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
window.addEventListener("pagehide", () => net?.leave());

start();

// Debug handle for tests and the browser console.
window.trainingRoom = { THREE, kingdom, scene, camera, rig, renderer, room, runner, objects, voice, ui, hud, xr, field, interact, draw, get net() { return net; }, get selfTestReport() { return selfTestReport; }, get me() { return me; }, playerPose };
