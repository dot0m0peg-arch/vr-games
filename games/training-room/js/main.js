// Training Room bootstrap: renderer, field, parts, voice, XR/desktop/phone input, laptop bridge.
import * as THREE from "../vendor/three.module.min.js";
import { detectDevice, apiBase, isRemoteBridge, PARAMS, WAKE_WORDS, loadJSON, saveJSON } from "./config.js";
import { UI } from "./ui/ui.js";
import { Hud } from "./ui/hud.js";
import { Field } from "./world/field.js";
import { Phaser } from "./world/phase.js";
import { SceneObjects } from "./world/objects.js";
import * as build from "./parts/build/index.js";
import { buildBlueprint } from "./parts/build/blueprint.js";
import { allMeta, registerMeta } from "./parts/meta/index.js";
import { loadRemoteParts } from "./parts/remote.js";
import { XR } from "./xr/xr.js";
import { Interact } from "./play/interact.js";
import { DesktopControls, TouchControls } from "./play/desktop.js";
import { Voice } from "./voice/voice.js";
import { speak, cancelSpeech, canSpeak } from "./voice/speak.js";
import { Net } from "./net/net.js";
import { Avatars } from "./net/avatars.js";
import { Share } from "./net/share.js";
import { Room } from "./room.js";
import { Runner } from "./runner.js";
import { makeId } from "./util/ids.js";

const STATE_KEY = "training-room:standalone-state";
const KEY_KEY = "training-room:room-key";
const NAME_KEY = "training-room:name";

const device = detectDevice();
const ui = new UI({ device });
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
  return { p: tmpPos.toArray(), q: tmpQuat.toArray(), yaw: Math.atan2(-tmpDir.x, -tmpDir.z) };
}

function localHand(hand) {
  const out = handCache[hand];
  if (xr.presenting) return xr.handPose(hand, out);
  return desktop.handPose(hand, out);
}

function getHand(user, hand) {
  if (user === me.id) return localHand(hand);
  return avatars.handPose(user, hand);
}

function playerPose() {
  const head = headPose();
  const hands = {};
  for (const hand of ["left", "right"]) {
    const pose = localHand(hand);
    hands[hand] = pose ? { p: pose.p.toArray(), q: pose.q.toArray() } : null;
  }
  return { user: me.id, ...head, hands };
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
const objects = new SceneObjects({ scene, room, build, phaser, getHand, share: { textureFor: (stream) => share?.textureFor(stream) || null } });
const thrownByMe = new Set();

function send(op) {
  op.uid = op.uid || makeId("u");
  op.by = me.id;
  if (op.fly) thrownByMe.add(op.id);
  room.apply(op, { local: true });
  if (net?.connected) {
    net.sendOp(op).catch((err) => {
      console.warn("[net] op failed", err);
      ui.toast("The laptop did not accept that change.", "warn");
    });
  }
}

objects.on("landed", ({ id, p, ry }) => {
  if (!thrownByMe.delete(id)) return;
  send({ t: "set", id, patch: { p, ry } });
});

let saveTimer = 0;
room.on("change", (op) => {
  ui.setObjects(room.records());
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

// ---------- commands, replies ----------
const runner = new Runner({ room, send, getNet: () => net, getPlayer: actingPose, getUser: () => me.id, settings });
let summonHandle = null;
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
    voice.setSpeaking(true);
    speak(text).finally(() => voice.setSpeaking(false));
  }
});
runner.on("parts-changed", () => ui.setParts(allMeta()));

// ---------- voice ----------
const voice = new Voice({ wakeWords: WAKE_WORDS });
let talking = false;
voice.on("state", (state) => {
  talking = state.listening;
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
  runner.run(voice.mode === "wake" && wakeMatched ? rest : text, { source: "voice" });
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
  xr.setLaser("right", true, 6);
});
xr.on("end", () => {
  hud.setVisible(false);
  hud.attachTo(null);
  interact.releaseAll();
  camera.position.set(0, 1.6, 0);
  camera.quaternion.identity();
  ui.showLaunchAgain("Left VR. Your room is still here.");
});
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
  if (name === "trigger" && pressed) {
    if (xr.rayFrom(hand, raycaster) && hud.click(raycaster)) return;
    if (xr.rayFrom(hand, raycaster)) flipPointed(raycaster);
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
});

// ---------- desktop & phone input ----------
desktop.on("key", ({ key, down, repeat }) => {
  if (repeat) return;
  if (key === "v") return down ? talkDown() : talkUp();
  if (!down) return;
  if (key === "m") toggleMute();
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
ui.on("enter-vr", async () => {
  try {
    await unlockAudio();
    await xr.enter();
  } catch (err) {
    ui.toast(err.message || "Could not start VR.", "error");
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
  touch.setFollow(on && target ? () => avatars.headPose(target.id) : null);
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
ui.on("settings", (next) => {
  field.setQuality(next.quality || "high");
  if (next.wake && voice.mode === "push") setMicMode("wake");
  if (!next.wake && voice.mode === "wake") setMicMode("push");
});

function actingPoseFor(userId) {
  const head = avatars.headPose(userId);
  if (!head) return playerPose();
  return { user: userId, p: head.p, yaw: head.yaw, hands: { left: null, right: null } };
}

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
  room.load(joined.state);
  setUsers(joined.users || []);
  share = new Share({ net });
  share.on("ended", () => ui.setShare({ active: false }));
  runner.modelAvailable = !!bridgeInfo.model?.available;
  if (bridgeInfo.stt?.available) voice.setTranscriber((blob) => net.transcribe(blob));
  ui.setConnection({ state: "online", model: bridgeInfo.model, stt: bridgeInfo.stt, url: joinUrl(), users: lastUsers });
  hud.setConnection?.({ state: "online", model: bridgeInfo.model });
  if (device === "desktop") ui.showJoinQR(joinUrl());
  loadRemoteParts(net, { registerMeta, registerBuilder: build.registerBuilder, buildBlueprint })
    .then(({ count, errors }) => {
      ui.setParts(allMeta());
      if (errors?.length) console.warn("[parts] laptop parts bin issues", errors);
      if (count) ui.toast(`Loaded ${count} parts from the laptop parts bin.`);
    })
    .catch((err) => console.warn("[parts] could not load the laptop parts bin", err));
  return true;
}

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
  ui.setFollowAvailable(!!headsetUser());
}

function wireNet(client) {
  client.on("op", ({ seq, op }) => room.apply(op, { seq }));
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
  });
  client.on("status", (status) => {
    if (status === "offline") ui.setConnection({ state: "offline" });
    if (status === "online") ui.setConnection({ state: "online", model: bridgeInfo?.model, stt: bridgeInfo?.stt, url: joinUrl(), users: lastUsers });
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
  runner.exec([
    { do: "spawn", what: { part: "whiteboard" }, place: { rel: "at", p: [0, 0, -5] }, text: "Training Room\n\nSay or type:\n\"AI, spawn a villa to my left\"\n\"AI, spawn an axe in my hand\"\n\"AI, spawn a deck of playing cards on a card table\"\n\nHold A/X (VR) or V (desktop) to talk. Y or M mutes the mic." },
  ], { label: "welcome" });
  runner.history.length = 0;
}

async function start() {
  ui.setLoading("Growing the grass…");
  ui.setParts(allMeta());
  ui.setMic({ mode: voice.mode, listening: false, engine: voice.engine });
  phaser.precompile?.(renderer, camera);
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

// ---------- frame loop ----------
const clock = new THREE.Clock();
const headWorld = new THREE.Vector3();
let poseTimer = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  if (xr.presenting) xr.update(dt);
  else if (touch.enabled) touch.update(dt);
  else if (desktop.enabled) desktop.update(dt);

  camera.getWorldPosition(headWorld);
  field.update(dt, t, headWorld);
  interact.update(dt, { left: localHand("left"), right: localHand("right") });
  objects.update(dt, t);
  avatars.update(dt);
  phaser.update(dt);
  hud.update(dt);

  if (xr.presenting && xr.rayFrom("right", raycaster)) {
    if (!hud.hover(raycaster)) objects.setHighlight(interact.held("right") ? null : objects.pick(raycaster)?.id || null);
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
window.trainingRoom = { THREE, scene, camera, rig, renderer, room, runner, objects, voice, ui, hud, xr, field, interact, get net() { return net; }, get me() { return me; }, playerPose };
