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
import { Behaviors } from "./play/behaviors.js";
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
import { applyLook } from "./dot3d/look.js";
import { detectTier, tierBudget } from "./dot3d/tiers.js";
import { warmMaterials, lookInfo } from "./parts/build/kit.js";

const PHYSICS_MODE = PARAMS.get("mode") === "physics";
const STATE_KEY = PHYSICS_MODE ? "training-room:physics-candidate-state" : "training-room:standalone-state";
let physics = null, physicsEffects = null;
build.setPhysicsColliders(PHYSICS_MODE);
// ?capture=1: the fixed scene and six camera spots of js/capture.js for the remaster before/after sheet (no bridge, no saved room).
const CAPTURE_MODE = PARAMS.get("capture") === "1";
let captureRig = null;
const KEY_KEY = "training-room:room-key";
const NAME_KEY = "training-room:name";

const device = detectDevice();
const ui = new UI({ device });
// ?mode=kingdom opens Kingdom mode (and remembers it); ?mode=training turns it off.
if (PARAMS.get("mode") === "kingdom") ui.setSettings({ kingdom: true });
else if (PHYSICS_MODE || PARAMS.get("mode") === "training") ui.setSettings({ kingdom: false });
const settings = () => ({ hand: "right", quality: device === "desktop" ? "high" : "low", speak: true, wake: false, fast: false, ...ui.settings });

// ---------- renderer, scene, player rig ----------
const stage = document.getElementById("tr-stage") || document.body;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.domElement.id = "tr-canvas";
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// dot3d look (LOOK-BIBLE.md section 6): sRGB output, AgX tone mapping and the tier's pixel-ratio cap (quest 1, tablet 1.5,
// laptop 2; ?tier= overrides). The field owns the shadowed sun, the sky fill, the fog and the four environment maps, so
// applyLook adds no light, fog or environment here (its zero fill is dropped).
const tier = detectTier({ override: device === "phone" ? "tablet" : undefined });
const look = applyLook(THREE, renderer, scene, { tier, toneMapping: "agx", exposure: 1, keyLight: false, environment: false, fillIntensity: 0 });
scene.remove(look.fill);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 4000);
const rig = new THREE.Group();
rig.name = "player-rig";
camera.position.set(0, 1.6, 0);
rig.add(camera);
scene.add(rig);

const field = new Field({ scene, renderer, quality: settings().quality, tier });
// prepare: the field's dawn-mist shader patch, so a reveal's clones compile to the programs precompile() warmed.
const phaser = new Phaser({ scene, prepare: (root) => field.mist.update(root) });
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

// scriptedHands: {left?: {p, q}, right?: {p, q}} set by the local acceptance probe (window.trainingPhysics().scriptHands) so a
// headless check can swing a sword; null means the real controllers. A scripted hand missing from the set is a hand that is not
// tracked, as with a controller put down.
let scriptedHands = null;
function localHand(hand) {
  const out = handCache[hand];
  if (scriptedHands) {
    const s = scriptedHands[hand];
    if (!s) return null;
    out.p.set(+s.p.x || 0, +s.p.y || 0, +s.p.z || 0);
    out.q.set(+s.q.x || 0, +s.q.y || 0, +s.q.z || 0, s.q.w === undefined ? 1 : +s.q.w).normalize();
    return out;
  }
  if (xr.presenting) return xr.handPose(hand, out);
  return desktop.handPose(hand, out);
}

// Finger input for the physics hands: trigger and squeeze values and whether the thumb rests on the stick or face
// buttons (xr-standard gamepad). Tracked hands and the desktop fall back to the button edges and the hold state.
function fingerInput(hand) {
  const src = xr.presenting ? xr.hands[hand] : null;
  const gp = src?.inputSource?.gamepad;
  if (gp?.buttons?.length) {
    const val = (i) => { const b = gp.buttons[i]; return b ? (b.value > 0 ? b.value : b.pressed ? 1 : 0) : 0; };
    return { trigger: val(0), squeeze: val(1), thumb: [3, 4, 5].some((i) => gp.buttons[i]?.touched || gp.buttons[i]?.pressed) };
  }
  const held = !!interact.held(hand);
  return { trigger: src?.buttons.trigger || held ? 1 : 0, squeeze: src?.buttons.squeeze || held ? 1 : 0, thumb: held };
}

let behaviors = null; // set up once interact exists (below)

function getHand(user, hand) {
  if (user === me.id) {
    const pose = interact.applySwing(hand, localHand(hand));
    return behaviors ? behaviors.applyRecoil(hand, pose) : pose;
  }
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
  if (settings().kingdom) {
    const aim = aimPoint();
    if (aim) pose.aim = aim;
  }
  return pose;
}

// Kingdom mode: the ground spot under the right-hand laser (VR) or the view center (flat screen),
// so "build a house right here" lands where the player points.
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
// A change to something just added waits for its add to reach the laptop (requests can overtake
// each other, and a piece taken out of a box is added and grabbed in the same moment).
const addsInFlight = new Map();
function sendToBridge(op, retries) {
  const ids = op.t === "set" ? [op.id] : op.t === "del" ? op.ids || [] : [];
  const before = ids.map((id) => addsInFlight.get(id)).filter(Boolean);
  if (before.length) {
    Promise.all(before).then(() => sendToBridge(op, retries));
    return;
  }
  const sent = net.sendOp(op);
  if (op.t === "add" && op.obj?.id) {
    const id = op.obj.id;
    const done = sent.then(() => {}, () => {});
    addsInFlight.set(id, done);
    done.then(() => addsInFlight.get(id) === done && addsInFlight.delete(id));
  }
  sent.catch((err) => {
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

const interactHooks = {};
const interact = new Interact({
  hooks: interactHooks,
  objects,
  room,
  getUser: () => me.id,
  metaOf: (record) => build.metaOfRecord(record),
  send,
  fx: (fx) => net?.connected && net.sendFx(fx),
});
interact.on("haptic", ({ hand, intensity }) => xr.haptic(hand, intensity, 50));

// Item behaviors: containers of pieces, floppy toys, guns that fire.
behaviors = new Behaviors({
  scene,
  room,
  objects,
  interact,
  send,
  fx: (fx) => net?.connected && net.sendFx(fx),
  getUser: () => me.id,
  metaOf: (record) => build.metaOfRecord(record),
  getHand,
  phaser,
  isThrownByMe: (id) => thrownByMe.has(id),
  head: () => camera.getWorldPosition(new THREE.Vector3()),
});
Object.assign(interactHooks, behaviors.interactHooks());
behaviors.on("haptic", ({ hand, intensity, ms }) => xr.haptic(hand, intensity, ms || 50));

// Where a gun in this hand points: the controller's laser, else straight out of the fist (the same
// direction a pistol grip puts the barrel), else the middle of the desktop screen.
const FIST_FORWARD = new THREE.Vector3(0, -0.819, -0.574);
function aimFrom(hand) {
  return () => {
    if (xr.presenting) {
      if (xr.rayFrom(hand, raycaster)) return raycaster.ray.clone();
      const pose = xr.handPose(hand);
      return pose ? new THREE.Ray(pose.p.clone(), FIST_FORWARD.clone().applyQuaternion(pose.q).normalize()) : null;
    }
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    return raycaster.ray.clone();
  };
}

// Commands go through the behaviors first ("a bag of marbles" → a snack bag filled with marbles).
function runCommand(text, opts) {
  return runner.run(behaviors.prepareCommand(text), opts);
}

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
  runCommand(voice.mode === "wake" && wakeMatched && !settings().kingdom ? rest : text, { source: "voice" });
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
    // A gun in the hand fires (and a squeaky toy squeaks) before the trigger points at the menu.
    if (behaviors.trigger(hand, pressed, aimFrom(hand))) return;
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
desktop.on("swing", () => {
  if (!behaviors.click("right", aimFrom("right"))) interact.swing("right");
});

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
ui.on("command", (text) => runCommand(text, { source: "typed" }));
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
  try {
    probe = await Net.probe(base, roomKey);
  } catch {
    probe = { bridge: false };
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
    if (user !== me.id) behaviors.onFx(fx);
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
  behaviors?.unlockAudio(); // gunshots and squeaks, started inside this click
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
  if (PHYSICS_MODE) {
    // Actual room records, built and interacted with by the normal game's controls.
    for (let i=0;i<4;i++) send({t:"add",obj:{id:`physics-crate-${i}`,part:"crate",label:"crate",p:[-.8,.9+i*.85,-3],ry:0,s:1}});
    send({t:"add",obj:{id:"physics-ball",part:"ball",label:"ball",p:[.7,1.4,-2.5],ry:0,s:1}});
    send({t:"add",obj:{id:"physics-wall",part:"physics wall",label:"physics wall",p:[0,0,-5],ry:0,s:1,data:{blueprint:{name:"physics wall",size:[5,3,.1],parts:[{shape:"box",p:[0,1.5,0],s:[5,3,.1],mat:"stone",color:"#818b91"}]}}}});
    send({t:"add",obj:{id:"physics-dummy",part:"training dummy",label:"training dummy",p:[1.6,0,-4.2],ry:0,s:1}});
    runner.history.length=0;
    return;
  }
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
  // Bake the family textures behind the loading screen, so the first spawn in VR does not hitch.
  ui.setLoading("Preparing materials…");
  warmMaterials();
  if (PHYSICS_MODE) {
    ui.setLoading("Preparing physics…");
    const {PhysicsRoom, initPhysics} = await import("./physics/sync.js");
    const {createParticles} = await import("./dot3d/particles.js");
    const {createDecals} = await import("./dot3d/decals.js");
    const {createHitEffects} = await import("./physics/hits.js");
    await initPhysics();
    // The frame loop is already running: publish physics only once its effects exist too.
    // In a shared room every body has one simulating device (js/physics/ownership.js): ours and the users list, read live.
    const room3d = new PhysicsRoom({objects,room,send,scene,getUser:()=>me.id,getUsers:()=>lastUsers});
    // Pools by tier (LOOK-BIBLE.md section 7): 600/48 Quest, 900/64 tablet, 2500/128 laptop, instead of 256/64 everywhere.
    const budget = tierBudget(tier);
    physicsEffects = {particles:createParticles(THREE,{scene,bus:room3d.bus,maxParticles:budget.maxParticles}),
      decals:createDecals(THREE,{scene,bus:room3d.bus,maxDecals:budget.maxDecals}),
      // What the player feels and hears: the controller on the striker pulses, the existing Sfx plays the material's hit.
      hits:createHitEffects({bus:room3d.bus,core:room3d.core,sfx:behaviors.sfx,haptic:(hand,intensity,ms)=>xr.haptic(hand,intensity,ms)})};
    physics = room3d;
    wireContactEffects(room3d.bus);
    // Materialize motes and dust come from the same particle system; the seam light respects the tier's point-light cap.
    phaser.attach({ particles: physicsEffects.particles, tier, lightCap: budget.pointLights,
      activeLights: () => { let n = 0; for (const light of field.localLights?.entries?.keys() ?? []) if (light.visible) n++; return n; } });
  }
  ui.setLoading("Growing the grass…");
  applyKingdom(!!settings().kingdom);
  ui.setParts(allMeta());
  ui.setMic({ mode: voice.mode, listening: false, engine: voice.engine });
  phaser.precompile?.(renderer, camera);
  // Compile first-use shaders now (HUD, controllers, teleport arc, marker ink, stars) to avoid hitches in VR.
  warmUp(renderer, scene, camera, [inkMaterial(), haloMaterial()]);
  xrSupported = await xr.isSupported().catch(() => false);
  const online = CAPTURE_MODE ? false : await connectBridge().catch((err) => {
    console.warn("[net] bridge connection failed", err);
    ui.setConnection({ state: "standalone" });
    return false;
  });
  if (CAPTURE_MODE) {
    const { installCapture } = await import("./capture.js");
    captureRig = installCapture({ THREE, camera, rig, room, field, kingdom, setKingdom: applyKingdom, afterLoad: () => physics?.sync(), renderer, scene,
      report: () => ({ physics: !!physics, quality: settings().quality, device, tier, materials: lookInfo() }) });
  } else if (!online) {
    const saved = loadJSON(STATE_KEY, null);
    if (saved) room.load(saved);
    seedWelcome();
  }
  ui.setLoading(null);
  if (CAPTURE_MODE) {
    ui.hideLaunch();
    captureRig.ready();
  } else ui.showLaunch(launchInfo({ state: online ? "online" : bridgeInfo ? "needs-key" : "none", info: bridgeInfo }));
}

// ---------- effects with causes (LOOK-BIBLE.md section 7, build order step 6) ----------
// The dot3d particles and decals answer every bus 'contact' and 'bite' on their own (js/dot3d). What needs the game's
// knowledge is wired here: the field's wind for embers and smoke, the campfire's rate emitters (a part's
// userData.emitters, part-local, on while the part is within range), a contact blob under a held or flying part (the
// blob shadows in objects.js skip parts a hand holds), the grass clearing pulse under a landing, and the straw thrown by a
// tear-off ('break' carries only the id, so the body is looked up here).
const emitterKeys = new Map(); // entry id -> emitter keys
const emitterTmp = new THREE.Vector3();
const blobBox = new THREE.Box3();
const UP_N = { x: 0, y: 1, z: 0 };
function wireContactEffects(bus) {
  bus.on("contact", (e) => {
    if (!e || !(e.impulse >= 0.5) || !Array.isArray(e.surfaces) || !Array.isArray(e.ids)) return;
    const striker = e.striker === 1 ? 1 : 0;
    if (e.surfaces[1 - striker] !== "grass") return;
    const entry = objects.entries.get(e.ids[striker]);
    if (!entry || entry.clearPulse > 0) return;
    entry.clearPulse = 0.4; entry.clearPulseLen = 0.4;   // objects.js widens the clearing 0.2 m for 0.4 s, then back
  });
  bus.on("break", ({ id }) => {
    const e = physics?.entries.get(id);
    const particles = physicsEffects?.particles;
    if (!e || !particles) return;
    const b = e.body, p = b.translation();
    let straw = false;
    for (let i = 0; i < b.numColliders(); i++) if (physics.core.contacts.surfaceOf(b.collider(i).handle) === "straw") straw = true;
    if (straw) {
      let n = 24 + Math.floor(Math.random() * 17);   // 24-40 wisps in a 0.3 m sphere
      while (n > 0) { const c = Math.min(24, n); particles.burst("wisps", { point: p, normal: UP_N, radius: 0.3, count: c, impulse: 4 }); n -= c; }
    }
    particles.burst("dust", { point: p, normal: UP_N, radius: 0.3, count: 12, impulse: 2, tint: straw ? [1.35, 1.22, 0.86] : undefined });
  });
}
function syncEmitters() {
  const particles = physicsEffects?.particles;
  if (!particles) return;
  const seen = new Set();
  for (const [id, entry] of objects.entries) {
    const list = entry.inner?.userData?.emitters;
    if (!Array.isArray(list) || !list.length || entry.removing || entry.fade <= 0) continue;
    seen.add(id);
    let keys = emitterKeys.get(id);
    if (!keys) { keys = list.map((_, i) => `${id}#${i}`); emitterKeys.set(id, keys); }
    entry.inner.updateWorldMatrix(true, false);
    const s = entry.wrapper.scale.x || 1;
    for (let i = 0; i < list.length; i++) {
      const em = list[i];
      emitterTmp.set(em.p?.[0] || 0, em.p?.[1] || 0, em.p?.[2] || 0);
      entry.inner.localToWorld(emitterTmp);
      const near = headWorld.distanceTo(emitterTmp) <= (em.range ?? 30);
      particles.emitter(keys[i], { kind: em.kind, rate: em.rate, point: { x: emitterTmp.x, y: emitterTmp.y, z: emitterTmp.z },
        normal: em.normal ? { x: em.normal[0], y: em.normal[1], z: em.normal[2] } : UP_N, radius: (em.radius || 0) * s,
        active: near && entry.appear >= 1 && !entry.phasing });
    }
  }
  for (const [id, keys] of emitterKeys) if (!seen.has(id)) { for (const k of keys) particles.removeEmitter(k); emitterKeys.delete(id); }
}
function syncBlobs() {
  const decals = physicsEffects?.decals;
  if (!physics || !decals) return;
  for (const [id, e] of physics.entries) {
    const key = "blob:" + id, prop = physics.core.props.get(id);
    if (!prop || prop.fixed || e.rig) continue;
    const entry = e.entry;
    const held = !!entry.attach || physics.holders(id).length > 0;
    const box = objects.bounds(id, blobBox);
    if (!box || box.isEmpty()) { decals.untrack(key); continue; }
    const lift = box.min.y;
    // Held parts always; a thrown part once it is high enough that the objects.js blob shadow has faded.
    if (!(held || (!e.body.isSleeping() && lift > 1.0))) { decals.untrack(key); continue; }
    const w = Math.max(0.12, (box.max.x - box.min.x) * 0.9), d = Math.max(0.12, (box.max.z - box.min.z) * 0.9);
    decals.track(key, { kind: "blob", point: { x: (box.min.x + box.max.x) / 2, y: 0.004, z: (box.min.z + box.max.z) / 2 }, normal: UP_N,
      sizeW: w, sizeH: d, rotation: 0, opacity: Math.max(0.35, 1 - Math.max(0, lift - 0.3) / 3) });
  }
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
let warmAfterLoad = true;

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
  // Lit programs depend on how many point lights are on (lamp posts, campfires arrive with the room): warm the
  // materialize programs once more on the first frame that has parts, after the field budgeted its lights.
  if (warmAfterLoad && room.records().length) {
    warmAfterLoad = false;
    phaser.precompile?.(renderer, camera);
  }
  if (kingdom.enabled) {
    const head = headPose();
    kingdom.update(dt, t, head);
    kingdom.setAim(aimPoint());
  }
  interact.update(dt, { left: localHand("left"), right: localHand("right") });
  objects.update(dt, t);
  if (physics) {
    physics.setHands({left:localHand("left"),right:localHand("right")},{left:fingerInput("left"),right:fingerInput("right")});
    physics.update(dt);
    // Embers and smoke lean with the field's wind (uWind is the grass shader's strength, about 0.3: a 1 m/s breeze).
    physicsEffects.particles.setWind(field.shared.uWindDir.value, field.shared.uWind.value * 3);
    syncEmitters();
    syncBlobs();
    physicsEffects.particles.update(dt,camera);
    physicsEffects.decals.update(dt);
  }
  behaviors.update(dt);
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
  captureRig?.frame(now);
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
window.trainingRoom = { THREE, kingdom, scene, camera, rig, renderer, room, runner, objects, voice, ui, hud, xr, field, interact, behaviors, draw, get net() { return net; }, get selfTestReport() { return selfTestReport; }, get me() { return me; }, playerPose };

// Read-only candidate inspection for the local acceptance runner.
if (PHYSICS_MODE) window.trainingPhysics = () => ({physics,physicsEffects,room,objects,interact,behaviors,fingerInput,phaser,send,tier,field,
  // The acceptance probe drives the hands itself: scriptHands({right:{p,q}}) replaces the controllers, scriptHands(null) gives them back.
  scriptHands:(poses)=>{scriptedHands=poses&&typeof poses==="object"?poses:null;},scriptedHands:()=>scriptedHands,
  emitters:()=>[...emitterKeys.entries()].map(([id,keys])=>({id,keys})),
  me:()=>me,users:()=>lastUsers,netState:()=>(net?{connected:net.connected,online:net.online,user:net.user?.id??null}:{connected:false,online:false,user:null})});
