// WebXR session, controllers mapped by handedness, button edges, locomotion (smooth move,
// snap turn around the head, teleport arc) and haptics. Events: "start", "end",
// "button" { hand, name, pressed }, "teleport" { p, from }, "turn" { angle },
// "connected" / "disconnected" { hand, isHand }.
import * as THREE from "../../vendor/three.module.min.js";
import { Emitter } from "../util/emitter.js";
import { makeControllerModel, makeLaser, makeHandProxy } from "./hands.js";

const HANDS = ["left", "right"];
// xr-standard gamepad mapping: event name and button index (A/X = 4, B/Y = 5).
const BUTTON_NAMES = ["trigger", "squeeze", "stick", "a", "b"];
const BUTTON_INDEX = [0, 1, 3, 4, 5];
const PRESS = 0.5;
const RELEASE = 0.35;
const SLOTS = 4; // three.js assigns input sources to controller slots in connection order
const ARC_POINTS = 30;
const ARC_SPEED = 12; // m/s launch speed: about 6 m when level, 15 m (clamped) at 45 degrees
const GRAVITY = 9.8;
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const SELECT_EVENTS = { selectstart: ["trigger", true], selectend: ["trigger", false], squeezestart: ["squeeze", true], squeezeend: ["squeeze", false] };

const DEFAULTS = {
  smoothSpeed: 2.2, // m/s
  sprint: 2.5, // multiplier while sprint is toggled (left stick click)
  sprintAutoOff: true, // sprint ends when the left stick returns to centre after moving
  snapTurn: 30, // degrees
  snapCooldown: 0.25, // seconds
  deadzone: 0.15,
  teleportMax: 15, // meters
  eyeHeight: 1.6, // used only when the device has no local-floor space
  locomotion: true,
  teleport: true,
  models: true,
};

function friendlyError(err) {
  const name = err?.name || "";
  if (name === "SecurityError") return new Error("The browser blocked VR here. Open the game over HTTPS and press Enter VR again.");
  if (name === "NotSupportedError") return new Error("This browser or headset cannot start immersive VR.");
  if (name === "InvalidStateError") return new Error("VR is already running somewhere else. Close it and try again.");
  if (name === "NotAllowedError") return new Error("VR permission was denied. Allow it in the browser and try again.");
  return new Error(`Could not start VR${err?.message ? `: ${err.message}` : "."}`);
}

export class XR extends Emitter {
  constructor({ renderer, scene, camera, rig, options = {} }) {
    super();
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.rig = rig || camera?.parent || scene;
    this.options = options; // read live, so callers may flip options.locomotion at runtime
    this.session = null;
    this.referenceSpaceType = null;
    this._presenting = false;
    this._floorOffset = 0;
    this._sprint = false;
    this._sprintMoved = false;
    this._snapArmed = true;
    this._snapCooldown = 0;
    this._aiming = false;
    this._target = new THREE.Vector3();
    this._targetValid = false;
    this._teleportFx = null;
    this._pending = null;
    this._onEnd = () => this._handleEnd();

    // Temporaries (no per-frame allocation).
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._q1 = new THREE.Quaternion();
    this._m1 = new THREE.Matrix4();
    this._s1 = new THREE.Vector3();

    // Raw three.js controller slots (connection order) live in the rig so locomotion moves them.
    this.slots = [];
    for (let i = 0; i < SLOTS; i++) {
      const slot = { index: i, ray: renderer.xr.getController(i), grip: renderer.xr.getControllerGrip(i), inputSource: null };
      slot.ray.name = `xr-ray-${i}`;
      slot.grip.name = `xr-grip-${i}`;
      this.rig.add(slot.ray, slot.grip);
      slot.ray.addEventListener("connected", (event) => this._onConnected(slot, event.data));
      slot.ray.addEventListener("disconnected", () => this._onDisconnected(slot));
      for (const type of Object.keys(SELECT_EVENTS)) {
        slot.ray.addEventListener(type, () => this._onSelectEvent(slot, type));
      }
      this.slots.push(slot);
    }

    // Stable per-hand groups that mirror whichever slot currently has that handedness, so things
    // attached to xr.hands.left.grip (HUD, models) never end up on the wrong hand.
    this.hands = {};
    for (const handedness of HANDS) this.hands[handedness] = this._makeHand(handedness);
  }

  _makeHand(handedness) {
    const ray = new THREE.Group();
    const grip = new THREE.Group();
    ray.name = `hand-ray-${handedness}`;
    grip.name = `hand-grip-${handedness}`;
    ray.visible = false;
    grip.visible = false;
    this.rig.add(ray, grip);
    const model = makeControllerModel(handedness);
    const handModel = makeHandProxy(handedness);
    handModel.visible = false;
    grip.add(model, handModel);
    const laser = makeLaser();
    laser.visible = false;
    ray.add(laser);
    return {
      handedness, ray, grip, connected: false, gamepad: null, inputSource: null, model, handModel, laser,
      slot: -1, isHand: false, buttons: { trigger: false, squeeze: false, stick: false, a: false, b: false },
    };
  }

  get presenting() {
    return this._presenting;
  }

  get sprinting() {
    return this._sprint;
  }

  async isSupported() {
    try {
      const xr = typeof navigator !== "undefined" ? navigator.xr : null;
      if (!xr?.isSessionSupported) return false;
      return !!(await xr.isSessionSupported("immersive-vr"));
    } catch {
      return false;
    }
  }

  // Must be called from a user gesture (button click). Throws an Error with a friendly message.
  async enter() {
    if (this.session) return this.session;
    if (!this._pending) this._pending = this._enter().finally(() => (this._pending = null));
    return this._pending;
  }

  async _enter() {
    const xr = typeof navigator !== "undefined" ? navigator.xr : null;
    if (!xr?.requestSession) throw new Error("VR needs a WebXR browser, such as the Meta Quest Browser, on an HTTPS page.");
    let session;
    try {
      session = await xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking", "layers"] });
    } catch (err) {
      throw friendlyError(err);
    }
    try {
      await this._useSession(session);
    } catch (err) {
      console.warn("[xr] session setup failed", err);
      this.session = null;
      this._presenting = false;
      try {
        await session.end();
      } catch {
        // Already ended.
      }
      throw new Error("VR started but the game could not attach to it. Reload the page and try again.");
    }
    return session;
  }

  async _useSession(session) {
    const xrm = this.renderer.xr;
    // Devices without local-floor fall back to "local" with the eye height added to the rig.
    let type = "local-floor";
    try {
      await session.requestReferenceSpace("local-floor");
    } catch {
      type = "local";
    }
    this.referenceSpaceType = type;
    xrm.setReferenceSpaceType(type);
    xrm.setFoveation?.(1);
    this.session = session;
    await xrm.setSession(session);
    xrm.setFoveation?.(1);
    this._floorOffset = type === "local" ? this.options.eyeHeight ?? DEFAULTS.eyeHeight : 0;
    this.rig.position.y += this._floorOffset;
    session.addEventListener("end", this._onEnd);
    this._presenting = true;
    this.emit("start", { session, referenceSpace: type });
  }

  async exit() {
    const session = this.session;
    if (!session) return;
    try {
      await session.end();
    } catch {
      // Ending twice is harmless.
    }
  }

  _handleEnd() {
    if (!this.session) return;
    this.session.removeEventListener("end", this._onEnd);
    for (const name of HANDS) this._releaseButtons(this.hands[name]);
    for (const name of HANDS) this._unbind(this.hands[name]);
    for (const slot of this.slots) slot.inputSource = null;
    this.rig.position.y -= this._floorOffset;
    this._floorOffset = 0;
    this._setAiming(false);
    this._sprint = false;
    this.session = null;
    const was = this._presenting;
    this._presenting = false;
    if (was) this.emit("end");
  }

  // ---------- controller mapping ----------

  _isController(source) {
    return !!source && !source.hand && !!source.gamepad;
  }

  _onConnected(slot, source) {
    slot.inputSource = source || null;
    const handedness = source?.handedness;
    if (handedness !== "left" && handedness !== "right") return;
    const hand = this.hands[handedness];
    const current = hand.connected ? this.slots[hand.slot]?.inputSource : null;
    // Keep a controller over a tracked hand of the same side when both are reported.
    if (current && hand.slot !== slot.index && this._isController(current) && !this._isController(source)) return;
    this._bind(hand, slot);
  }

  _onDisconnected(slot) {
    slot.inputSource = null;
    for (const name of HANDS) {
      const hand = this.hands[name];
      if (hand.slot !== slot.index) continue;
      this._releaseButtons(hand);
      this._unbind(hand);
      this.emit("disconnected", { hand: name });
      // Another source of the same side (e.g. hand tracking while a controller sleeps) takes over.
      const next = this.slots.find((s) => s.inputSource?.handedness === name);
      if (next) this._bind(hand, next);
    }
  }

  _bind(hand, slot) {
    if (hand.connected && hand.slot !== slot.index) this._releaseButtons(hand);
    const source = slot.inputSource;
    hand.slot = slot.index;
    hand.inputSource = source;
    hand.gamepad = source?.gamepad || null;
    hand.isHand = !!source?.hand;
    hand.connected = true;
    const models = this.options.models !== false;
    hand.model.visible = models && !hand.isHand;
    hand.handModel.visible = models && hand.isHand;
    this.emit("connected", { hand: hand.handedness, isHand: hand.isHand, profiles: source?.profiles || [] });
  }

  _unbind(hand) {
    hand.connected = false;
    hand.slot = -1;
    hand.inputSource = null;
    hand.gamepad = null;
    hand.isHand = false;
    hand.ray.visible = false;
    hand.grip.visible = false;
  }

  // Buttons come from gamepad polling when there is a gamepad; otherwise (tracked hands,
  // pinch) from the session select/squeeze events, so nothing fires twice.
  _polls(hand) {
    const source = hand.inputSource;
    return !!source && !source.hand && !!source.gamepad && source.gamepad.buttons?.length > 0;
  }

  _onSelectEvent(slot, type) {
    const hand = HANDS.map((name) => this.hands[name]).find((h) => h.connected && h.slot === slot.index);
    if (!hand || this._polls(hand)) return;
    const [name, pressed] = SELECT_EVENTS[type];
    this._setButton(hand, name, pressed);
  }

  _setButton(hand, name, pressed) {
    if (hand.buttons[name] === pressed) return;
    hand.buttons[name] = pressed;
    if (name === "stick" && pressed && hand.handedness === "left") {
      this._sprint = !this._sprint;
      this._sprintMoved = false;
    }
    this.emit("button", { hand: hand.handedness, name, pressed });
  }

  _releaseButtons(hand) {
    for (const name of Object.keys(hand.buttons)) if (hand.buttons[name]) this._setButton(hand, name, false);
  }

  // ---------- per frame ----------

  update(dt = 0) {
    if (!this.session) return;
    this._snapCooldown = Math.max(0, this._snapCooldown - dt);
    for (const name of HANDS) this._syncHand(this.hands[name]);
    for (const name of HANDS) this._poll(this.hands[name]);
    if (this.options.locomotion === false) {
      this._setAiming(false);
      return;
    }
    this._smoothMove(dt);
    this._turnAndTeleport();
  }

  _syncHand(hand) {
    const slot = hand.connected ? this.slots[hand.slot] : null;
    if (!slot) {
      hand.ray.visible = false;
      hand.grip.visible = false;
      return;
    }
    hand.gamepad = hand.inputSource?.gamepad || null;
    hand.ray.position.copy(slot.ray.position);
    hand.ray.quaternion.copy(slot.ray.quaternion);
    hand.ray.visible = slot.ray.visible;
    hand.grip.position.copy(slot.grip.position);
    hand.grip.quaternion.copy(slot.grip.quaternion);
    hand.grip.visible = slot.grip.visible;
  }

  _poll(hand) {
    if (!this._polls(hand)) return;
    const buttons = hand.inputSource.gamepad.buttons;
    for (let i = 0; i < BUTTON_NAMES.length; i++) {
      const name = BUTTON_NAMES[i];
      const button = buttons[BUTTON_INDEX[i]];
      if (!button) continue;
      const value = button.value > 0 ? button.value : button.pressed ? 1 : 0;
      const down = hand.buttons[name] ? value > RELEASE : value > PRESS;
      if (down !== hand.buttons[name]) this._setButton(hand, name, down);
    }
  }

  _stick(hand, out) {
    out.set(0, 0, 0);
    if (!hand.connected || !this._polls(hand)) return out;
    const axes = hand.inputSource.gamepad.axes || [];
    const base = axes.length >= 4 ? 2 : 0;
    out.x = Number(axes[base]) || 0;
    out.y = Number(axes[base + 1]) || 0;
    return out;
  }

  _smoothMove(dt) {
    const stick = this._stick(this.hands.left, this._v1);
    const dz = this.options.deadzone ?? DEFAULTS.deadzone;
    const mag = Math.hypot(stick.x, stick.y);
    if (mag <= dz) {
      if (this._sprint && this._sprintMoved && this.options.sprintAutoOff !== false) this._sprint = false;
      return;
    }
    const scale = (Math.min(1, mag) - dz) / (1 - dz) / mag;
    const x = stick.x * scale;
    const y = stick.y * scale;
    const yaw = this.headYaw();
    const speed = (this.options.smoothSpeed ?? DEFAULTS.smoothSpeed) * (this._sprint ? this.options.sprint ?? DEFAULTS.sprint : 1);
    if (this._sprint) this._sprintMoved = true;
    // Forward [-sin, 0, -cos], right [cos, 0, -sin]; stick up is negative y.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const step = speed * dt;
    this.rig.position.x += (fx * -y + rx * x) * step;
    this.rig.position.z += (fz * -y + rz * x) * step;
  }

  _turnAndTeleport() {
    const stick = this._stick(this.hands.right, this._v2);
    const ax = Math.abs(stick.x);
    const ay = Math.abs(stick.y);
    if (this._aiming) {
      if (Math.hypot(stick.x, stick.y) < 0.3) {
        if (this._targetValid) this._teleport();
        this._setAiming(false);
      } else {
        this._aimTeleport();
      }
      return;
    }
    if (this.options.teleport !== false && stick.y < -0.7 && ay > ax && this.hands.right.connected) {
      this._setAiming(true);
      this._aimTeleport();
      return;
    }
    if (ax < 0.3) this._snapArmed = true;
    if (this._snapArmed && this._snapCooldown <= 0 && ax > 0.7 && ax > ay) {
      this.snapTurn(stick.x > 0 ? -1 : 1);
      this._snapArmed = false;
      this._snapCooldown = this.options.snapCooldown ?? DEFAULTS.snapCooldown;
    }
  }

  // ---------- head, turning, teleport ----------

  // World head position (assumes the rig is a direct child of an untransformed scene).
  headPosition(out = new THREE.Vector3()) {
    if (this.camera.parent === this.rig) return out.copy(this.camera.position).applyQuaternion(this.rig.quaternion).add(this.rig.position);
    this.camera.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.camera.matrixWorld);
  }

  headYaw() {
    const q = this._q1;
    if (this.camera.parent === this.rig) q.copy(this.rig.quaternion).multiply(this.camera.quaternion);
    else this.camera.getWorldQuaternion(q);
    const f = this._v3.set(0, 0, -1).applyQuaternion(q);
    if (Math.hypot(f.x, f.z) < 1e-3) f.set(0, 1, 0).applyQuaternion(q); // looking straight down/up
    return Math.atan2(-f.x, -f.z);
  }

  // dir: +1 turns left (counter-clockwise), -1 turns right. Rotates the rig around the head.
  snapTurn(dir, degrees = this.options.snapTurn ?? DEFAULTS.snapTurn) {
    const angle = Math.sign(dir) * degrees * DEG;
    if (!angle) return;
    const head = this.headPosition(this._v3);
    const q = this._q1.setFromAxisAngle(UP, angle);
    this.rig.position.sub(head).applyQuaternion(q).add(head);
    this.rig.quaternion.premultiply(q);
    this.emit("turn", { angle });
  }

  _setAiming(on) {
    this._aiming = on;
    if (!on) this._targetValid = false;
    if (this._teleportFx) this._teleportFx.root.visible = on;
  }

  _ensureTeleportFx() {
    if (this._teleportFx) return this._teleportFx;
    const root = new THREE.Group();
    root.name = "teleport";
    const dotMat = new THREE.MeshBasicMaterial({ color: "#d5fb6a", transparent: true, opacity: 0.85, depthWrite: false });
    const dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.018, 8, 6), dotMat, ARC_POINTS);
    dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    dots.frustumCulled = false;
    const ringMat = new THREE.MeshBasicMaterial({ color: "#d5fb6a", transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.31, 40).rotateX(-Math.PI / 2), ringMat);
    const discMat = new THREE.MeshBasicMaterial({ color: "#d5fb6a", transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.24, 32).rotateX(-Math.PI / 2), discMat);
    const target = new THREE.Group();
    target.add(ring, disc);
    root.add(dots, target);
    for (const object of [dots, ring, disc]) object.raycast = () => {};
    root.visible = false;
    this.scene.add(root);
    this._teleportFx = { root, dots, target };
    return this._teleportFx;
  }

  // Parabola from the right ray to y = 0, horizontally compressed to at most teleportMax meters.
  _aimTeleport() {
    const fx = this._ensureTeleportFx();
    const hand = this.hands.right;
    if (!hand.connected || !hand.ray.visible) {
      this._targetValid = false;
      fx.root.visible = false;
      return;
    }
    fx.root.visible = true;
    hand.ray.updateWorldMatrix(true, false);
    const m = hand.ray.matrixWorld;
    const o = this._v1.setFromMatrixPosition(m);
    const d = this._v2.set(0, 0, -1).transformDirection(m);
    const vx = d.x * ARC_SPEED;
    const vy = d.y * ARC_SPEED;
    const vz = d.z * ARC_SPEED;
    const h0 = Math.max(0, o.y);
    const tLand = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * h0)) / GRAVITY;
    const reach = Math.hypot(vx, vz) * tLand;
    const max = this.options.teleportMax ?? DEFAULTS.teleportMax;
    const k = reach > max ? max / reach : 1;
    for (let i = 0; i < ARC_POINTS; i++) {
      const t = (tLand * i) / (ARC_POINTS - 1);
      this._m1.makeTranslation(o.x + vx * t * k, Math.max(0, o.y + vy * t - 0.5 * GRAVITY * t * t), o.z + vz * t * k);
      fx.dots.setMatrixAt(i, this._m1);
    }
    fx.dots.instanceMatrix.needsUpdate = true;
    this._target.set(o.x + vx * tLand * k, 0, o.z + vz * tLand * k);
    fx.target.position.set(this._target.x, 0.01, this._target.z);
    this._targetValid = Number.isFinite(this._target.x) && Number.isFinite(this._target.z);
  }

  _teleport() {
    const head = this.headPosition(this._v3);
    const from = [head.x, head.y, head.z];
    this.rig.position.x += this._target.x - head.x;
    this.rig.position.z += this._target.z - head.z;
    this.haptic("right", 0.25, 30);
    this.emit("teleport", { p: [this._target.x, 0, this._target.z], from });
  }

  get teleportTarget() {
    return this._aiming && this._targetValid ? this._target : null;
  }

  // ---------- poses, rays, feedback ----------

  // World pose of the grip (or the ray when there is no grip pose). → out | null
  handPose(hand, out = { p: new THREE.Vector3(), q: new THREE.Quaternion() }) {
    const h = this.hands[hand];
    if (!h?.connected) return null;
    const node = h.grip.visible ? h.grip : h.ray.visible ? h.ray : null;
    if (!node) return null;
    node.updateWorldMatrix(true, false);
    node.matrixWorld.decompose(out.p, out.q, this._s1);
    return out;
  }

  // Points raycaster along the hand's target ray (origin, -Z). → boolean
  rayFrom(hand, raycaster) {
    const h = this.hands[hand];
    if (!h?.connected || !h.ray.visible || !raycaster) return false;
    h.ray.updateWorldMatrix(true, false);
    const m = h.ray.matrixWorld;
    raycaster.ray.origin.setFromMatrixPosition(m);
    raycaster.ray.direction.set(0, 0, -1).transformDirection(m);
    raycaster.camera = this.camera;
    return true;
  }

  haptic(hand, intensity = 0.5, ms = 60) {
    const gamepad = this.hands[hand]?.inputSource?.gamepad;
    if (!gamepad) return false;
    const value = Math.min(1, Math.max(0, Number(intensity) || 0));
    const duration = Math.max(1, Number(ms) || 0);
    try {
      const actuator = gamepad.hapticActuators?.[0];
      if (actuator?.pulse) {
        actuator.pulse(value, duration)?.catch?.(() => {});
        return true;
      }
      if (gamepad.vibrationActuator?.playEffect) {
        gamepad.vibrationActuator.playEffect("dual-rumble", { duration, strongMagnitude: value, weakMagnitude: value })?.catch?.(() => {});
        return true;
      }
    } catch {
      // Haptics are optional.
    }
    return false;
  }

  setLaser(hand, visible, length = 5) {
    const h = this.hands[hand];
    if (!h) return;
    h.laser.visible = !!visible;
    h.laser.userData.setLength(length);
  }
}
