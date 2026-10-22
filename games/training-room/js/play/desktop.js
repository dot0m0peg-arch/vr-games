// Flat-screen controls. DesktopControls: pointer-lock mouse look, WASD/arrows, app keys and
// virtual hands. TouchControls: phone drag-to-look, on-screen joystick, follow-the-headset camera.
// Yaw lives on the rig (rotation.y), pitch on the camera (rotation.x); the camera sits at eye height.
import * as THREE from "../../vendor/three.module.min.js";
import { Emitter } from "../util/emitter.js";

const DEG = Math.PI / 180;
const EYE = 1.6;
const PITCH_LIMIT = 85 * DEG;
const APP_KEYS = new Set(["v", "m", "enter", "e", "z", "escape", "q", "t", "f", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
const MOVE_CODES = {
  KeyW: "forward", ArrowUp: "forward", KeyS: "back", ArrowDown: "back",
  KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
};
const HAND_OFFSET = { left: new THREE.Vector3(-0.28, -0.28, -0.5), right: new THREE.Vector3(0.28, -0.28, -0.5) };
// Grip -Z points forward and 35 degrees up, so an upright tool (grip r [-90, 0, 0]) is held out in front.
const HAND_TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 35 * DEG);
const TOKENS = { bg: "#101412", text: "#eef1e9", muted: "#a7b0a4", accent: "#d5fb6a", line: "#596057", panel: "rgba(25, 39, 27, 0.6)" };

const clampPitch = (v) => Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, v));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// True when keyboard focus is somewhere the user types (keys must not drive the game then).
export function isTypingTarget(el) {
  if (!el || typeof el !== "object") return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = String(el.type || "text").toLowerCase();
  return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"].includes(type);
}

function keyName(event) {
  if (/^Digit[1-9]$/.test(event.code || "")) return event.code.slice(5);
  return String(event.key || "").toLowerCase();
}

export class DesktopControls extends Emitter {
  constructor({ camera, rig, dom }) {
    super();
    this.camera = camera;
    this.rig = rig;
    this.dom = dom;
    this.sensitivity = 0.0022; // radians per pixel
    this.speed = 2.5; // m/s
    this.sprint = 2.5; // Shift multiplier
    this.eyeHeight = EYE;
    this._mouseLook = true;
    this._enabled = false;
    this._move = new Set();
    this._shift = false;
    this._appDown = new Set();
    this._drag = null;
    this._camQ = new THREE.Quaternion();
    this._camP = new THREE.Vector3();
    this._camS = new THREE.Vector3();
    this._onKeyDown = (e) => this._key(e, true);
    this._onKeyUp = (e) => this._key(e, false);
    this._onBlur = () => this._releaseKeys();
    this._onMouseDown = (e) => this._mouseDown(e);
    this._onMouseMove = (e) => this._mouseMove(e);
    this._onMouseUp = () => (this._drag = null);
    this._onClick = () => {
      if (this.mouseLook && !this.locked) this.lock();
    };
    this._onLockChange = () => this.emit("lock", { locked: this.locked });
  }

  get enabled() {
    return this._enabled;
  }

  // false while another mode owns the mouse (e.g. desktop marker drawing): releases pointer lock;
  // no lock on click, drag-look or swing until set back to true.
  get mouseLook() {
    return this._mouseLook;
  }

  set mouseLook(on) {
    this._mouseLook = !!on;
    this._drag = null;
    if (!on) this.unlock();
  }

  get locked() {
    return typeof document !== "undefined" && !!this.dom && document.pointerLockElement === this.dom;
  }

  enable() {
    if (this._enabled) return;
    this._enabled = true;
    this.camera.position.set(0, this.eyeHeight, 0);
    this.camera.rotation.set(clampPitch(this.camera.rotation.x), 0, 0);
    if (typeof window === "undefined") return;
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("blur", this._onBlur);
    document.addEventListener("mousemove", this._onMouseMove);
    document.addEventListener("mouseup", this._onMouseUp);
    document.addEventListener("pointerlockchange", this._onLockChange);
    this.dom?.addEventListener("mousedown", this._onMouseDown);
    this.dom?.addEventListener("click", this._onClick);
  }

  disable() {
    if (!this._enabled) return;
    this._releaseKeys();
    this._enabled = false;
    this._drag = null;
    this.unlock();
    if (typeof window === "undefined") return;
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("blur", this._onBlur);
    document.removeEventListener("mousemove", this._onMouseMove);
    document.removeEventListener("mouseup", this._onMouseUp);
    document.removeEventListener("pointerlockchange", this._onLockChange);
    this.dom?.removeEventListener("mousedown", this._onMouseDown);
    this.dom?.removeEventListener("click", this._onClick);
  }

  // Must run inside a user gesture (click).
  lock() {
    if (!this._enabled || !this.dom?.requestPointerLock) return;
    try {
      this.dom.requestPointerLock()?.catch?.(() => {});
    } catch {
      // Pointer lock unavailable (iframe sandbox): drag-to-look still works.
    }
  }

  unlock() {
    if (this.locked) document.exitPointerLock?.();
  }

  _key(event, down) {
    const code = event.code || "";
    const key = keyName(event);
    if (!down) {
      this._move.delete(MOVE_CODES[code]);
      if (key === "shift") this._shift = false;
      if (this._appDown.delete(key)) this.emit("key", { key, down: false, repeat: false });
      return;
    }
    if (isTypingTarget(event.target) || isTypingTarget(typeof document !== "undefined" ? document.activeElement : null)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    this._shift = event.shiftKey;
    const move = MOVE_CODES[code];
    if (move) {
      this._move.add(move);
      if (code.startsWith("Arrow")) event.preventDefault?.();
      return;
    }
    if (!APP_KEYS.has(key)) return;
    // Enter on a focused button/link activates it; do not also open the command box.
    const tag = String(event.target?.tagName || "").toUpperCase();
    if (key === "enter" && (tag === "BUTTON" || tag === "A" || tag === "SUMMARY")) return;
    this._appDown.add(key);
    this.emit("key", { key, down: true, repeat: !!event.repeat });
  }

  // Releases held app keys (e.g. V push-to-talk) and movement when focus leaves or controls turn off.
  _releaseKeys() {
    for (const key of this._appDown) this.emit("key", { key, down: false, repeat: false });
    this._appDown.clear();
    this._move.clear();
    this._shift = false;
  }

  _mouseDown(event) {
    if (event.button !== 0 || !this.mouseLook) return;
    if (this.locked) {
      this.emit("swing", { hand: "right" });
      return;
    }
    this._drag = { x: event.clientX, y: event.clientY };
  }

  _mouseMove(event) {
    let dx = 0;
    let dy = 0;
    if (this.locked) {
      dx = event.movementX || 0;
      dy = event.movementY || 0;
    } else if (this._drag && event.buttons & 1 && this.mouseLook) {
      dx = event.clientX - this._drag.x;
      dy = event.clientY - this._drag.y;
      this._drag.x = event.clientX;
      this._drag.y = event.clientY;
    } else {
      return;
    }
    this.look(Math.max(-200, Math.min(200, dx)), Math.max(-200, Math.min(200, dy)));
  }

  // Applies a mouse delta in pixels.
  look(dx, dy) {
    this.rig.rotation.y -= dx * this.sensitivity;
    this.camera.rotation.x = clampPitch(this.camera.rotation.x - dy * this.sensitivity);
  }

  update(dt = 0) {
    if (!this._enabled || !this._move.size) return;
    let f = 0;
    let r = 0;
    if (this._move.has("forward")) f += 1;
    if (this._move.has("back")) f -= 1;
    if (this._move.has("right")) r += 1;
    if (this._move.has("left")) r -= 1;
    if (!f && !r) return;
    const len = Math.hypot(f, r);
    const step = (this.speed * (this._shift ? this.sprint : 1) * dt) / len;
    const yaw = this.rig.rotation.y;
    this.rig.position.x += (-Math.sin(yaw) * f + Math.cos(yaw) * r) * step;
    this.rig.position.z += (-Math.cos(yaw) * f - Math.sin(yaw) * r) * step;
  }

  // Virtual hand in front of the camera; works whether or not these controls are enabled.
  handPose(hand, out = { p: new THREE.Vector3(), q: new THREE.Quaternion() }) {
    const offset = HAND_OFFSET[hand];
    if (!offset) return null;
    this.camera.updateWorldMatrix(true, false);
    this.camera.matrixWorld.decompose(this._camP, this._camQ, this._camS);
    out.p.copy(offset).applyQuaternion(this._camQ).add(this._camP);
    out.q.copy(this._camQ).multiply(HAND_TILT);
    return out;
  }
}

export class TouchControls extends Emitter {
  constructor({ camera, rig, dom }) {
    super();
    this.camera = camera;
    this.rig = rig;
    this.dom = dom;
    this.lookSpeed = 0.005; // radians per pixel
    this.speed = 2.2; // m/s at full stick
    this.eyeHeight = EYE;
    this._enabled = false;
    this._look = null;
    this._stick = { x: 0, y: 0, id: null };
    this._follow = null;
    this._followSnap = true;
    this._joystick = null;
    this._prevTouchAction = "";
    this._fq = new THREE.Quaternion();
    this._fv = new THREE.Vector3();
    this._onDown = (e) => this._pointerDown(e);
    this._onMove = (e) => this._pointerMove(e);
    this._onUp = (e) => this._pointerUp(e);
  }

  get enabled() {
    return this._enabled;
  }

  get following() {
    return !!this._follow;
  }

  // Current joystick deflection, x right / y down in [-1, 1].
  get stick() {
    return this._stick;
  }

  enable() {
    if (this._enabled) return;
    this._enabled = true;
    this.camera.position.set(0, this.eyeHeight, 0);
    this.camera.rotation.set(clampPitch(this.camera.rotation.x), 0, 0);
    if (typeof document === "undefined" || !this.dom) return;
    this._prevTouchAction = this.dom.style.touchAction;
    this.dom.style.touchAction = "none";
    this.dom.addEventListener("pointerdown", this._onDown);
    this.dom.addEventListener("pointermove", this._onMove);
    this.dom.addEventListener("pointerup", this._onUp);
    this.dom.addEventListener("pointercancel", this._onUp);
    this._ensureJoystick();
    this._joystick.base.style.display = "block";
    this._styleJoystick();
  }

  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this._look = null;
    this._resetStick();
    if (typeof document === "undefined" || !this.dom) return;
    this.dom.style.touchAction = this._prevTouchAction;
    this.dom.removeEventListener("pointerdown", this._onDown);
    this.dom.removeEventListener("pointermove", this._onMove);
    this.dom.removeEventListener("pointerup", this._onUp);
    this.dom.removeEventListener("pointercancel", this._onUp);
    if (this._joystick) this._joystick.base.style.display = "none";
  }

  // getPose() → { p: [x, y, z], yaw, q? } of the headset player's head, or null to return control.
  setFollow(getPose) {
    const wasFollowing = !!this._follow;
    this._follow = typeof getPose === "function" ? getPose : null;
    if (wasFollowing && !this._follow) this.rig.position.y = 0; // back on the ground for walking
    this._followSnap = true;
    this._look = null;
    this._resetStick();
    this._styleJoystick();
    this.emit("follow", { on: !!this._follow });
  }

  update(dt = 0) {
    if (this._follow) {
      this._updateFollow(dt);
      return;
    }
    if (!this._enabled) return;
    const { x, y } = this._stick;
    const mag = Math.hypot(x, y);
    if (mag < 0.12) return;
    const scale = (Math.min(1, mag) - 0.12) / 0.88 / mag;
    const f = -y * scale;
    const r = x * scale;
    const yaw = this.rig.rotation.y;
    const step = this.speed * dt;
    this.rig.position.x += (-Math.sin(yaw) * f + Math.cos(yaw) * r) * step;
    this.rig.position.z += (-Math.cos(yaw) * f - Math.sin(yaw) * r) * step;
  }

  // Third-person camera 2.2 m behind and 0.6 m above the followed head, looking where it looks.
  _updateFollow(dt) {
    let pose = null;
    try {
      pose = this._follow();
    } catch {
      pose = null;
    }
    const p = pose?.p;
    if (!p) return;
    const hx = Array.isArray(p) ? p[0] : p.x;
    const hy = Array.isArray(p) ? p[1] : p.y;
    const hz = Array.isArray(p) ? p[2] : p.z;
    if (!Number.isFinite(hx) || !Number.isFinite(hy) || !Number.isFinite(hz)) return;
    const yaw = Number.isFinite(pose.yaw) ? pose.yaw : 0;
    // Gaze direction: from q when given (includes pitch), else level along yaw.
    const gaze = this._fv.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    const q = pose.q;
    if (q && (Array.isArray(q) ? q.length === 4 : q.isQuaternion)) {
      if (Array.isArray(q)) this._fq.fromArray(q);
      else this._fq.copy(q);
      gaze.set(0, 0, -1).applyQuaternion(this._fq);
      gaze.y = Math.max(-0.7, Math.min(0.5, gaze.y));
    }
    const camX = hx + Math.sin(yaw) * 2.2;
    const camY = hy + 0.6;
    const camZ = hz + Math.cos(yaw) * 2.2;
    const lookX = hx + gaze.x * 4;
    const lookY = hy + gaze.y * 4;
    const lookZ = hz + gaze.z * 4;
    const pitch = clampPitch(Math.atan2(lookY - camY, Math.hypot(lookX - camX, lookZ - camZ)));
    const k = this._followSnap ? 1 : 1 - Math.exp(-dt * 5);
    this._followSnap = false;
    const eye = this.camera.position.y;
    this.rig.position.x += (camX - this.rig.position.x) * k;
    this.rig.position.y += (camY - eye - this.rig.position.y) * k;
    this.rig.position.z += (camZ - this.rig.position.z) * k;
    this.rig.rotation.y += wrapAngle(yaw - this.rig.rotation.y) * k;
    this.camera.rotation.x += (pitch - this.camera.rotation.x) * k;
  }

  _pointerDown(event) {
    if (this._follow || this._look) return;
    this._look = { id: event.pointerId, x: event.clientX, y: event.clientY };
    try {
      this.dom.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is optional.
    }
  }

  _pointerMove(event) {
    const look = this._look;
    if (!look || look.id !== event.pointerId || this._follow) return;
    const dx = event.clientX - look.x;
    const dy = event.clientY - look.y;
    look.x = event.clientX;
    look.y = event.clientY;
    // Grab-the-world feel: drag right turns the view left.
    this.rig.rotation.y += dx * this.lookSpeed;
    this.camera.rotation.x = clampPitch(this.camera.rotation.x + dy * this.lookSpeed);
  }

  _pointerUp(event) {
    if (this._look?.id === event.pointerId) this._look = null;
  }

  // ---------- on-screen joystick (bottom-left, clear of the talk button) ----------

  _ensureJoystick() {
    if (this._joystick || typeof document === "undefined") return;
    const base = document.createElement("div");
    base.className = "tr-joystick";
    base.setAttribute("role", "slider");
    base.setAttribute("aria-label", "Walk: drag to move");
    Object.assign(base.style, {
      position: "fixed",
      left: "var(--tr-joystick-left, calc(16px + env(safe-area-inset-left, 0px)))",
      bottom: "var(--tr-joystick-bottom, calc(16px + env(safe-area-inset-bottom, 0px)))",
      width: "var(--tr-joystick-size, 112px)",
      height: "var(--tr-joystick-size, 112px)",
      borderRadius: "50%",
      border: `2px solid ${TOKENS.line}`,
      background: TOKENS.panel,
      boxSizing: "border-box",
      touchAction: "none",
      userSelect: "none",
      webkitUserSelect: "none",
      zIndex: "20",
      display: "none",
      transition: "opacity 0.2s",
    });
    const label = document.createElement("span");
    label.textContent = "WALK";
    Object.assign(label.style, {
      position: "absolute", left: "0", right: "0", top: "6px", textAlign: "center",
      font: "700 10px Arial, Helvetica, sans-serif", letterSpacing: "0.12em", color: TOKENS.muted, pointerEvents: "none",
    });
    const knob = document.createElement("div");
    Object.assign(knob.style, {
      position: "absolute", left: "50%", top: "50%", width: "46px", height: "46px", margin: "-23px 0 0 -23px",
      borderRadius: "50%", background: TOKENS.accent, opacity: "0.9", boxShadow: `0 0 0 3px ${TOKENS.bg}`,
      pointerEvents: "none", transform: "translate(0px, 0px)",
    });
    base.append(label, knob);
    document.body.appendChild(base);
    const move = (event) => {
      if (this._stick.id !== event.pointerId) return;
      const rect = base.getBoundingClientRect();
      const radius = rect.width / 2 - 12;
      let dx = event.clientX - (rect.left + rect.width / 2);
      let dy = event.clientY - (rect.top + rect.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > radius) {
        dx *= radius / len;
        dy *= radius / len;
      }
      this._stick.x = dx / radius;
      this._stick.y = dy / radius;
      knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
      event.preventDefault();
    };
    const end = (event) => {
      if (this._stick.id === event.pointerId) this._resetStick();
    };
    base.addEventListener("pointerdown", (event) => {
      if (!this._enabled || this._follow || this._stick.id !== null) return;
      this._stick.id = event.pointerId;
      try {
        base.setPointerCapture(event.pointerId);
      } catch {
        // Capture is optional.
      }
      move(event);
    });
    base.addEventListener("pointermove", move);
    base.addEventListener("pointerup", end);
    base.addEventListener("pointercancel", end);
    base.addEventListener("contextmenu", (event) => event.preventDefault());
    this._joystick = { base, knob };
  }

  _resetStick() {
    this._stick.x = 0;
    this._stick.y = 0;
    this._stick.id = null;
    if (this._joystick) this._joystick.knob.style.transform = "translate(0px, 0px)";
  }

  _styleJoystick() {
    if (!this._joystick) return;
    this._joystick.base.style.opacity = this._follow ? "0.35" : "1";
    this._joystick.base.style.pointerEvents = this._follow ? "none" : "auto";
  }
}
