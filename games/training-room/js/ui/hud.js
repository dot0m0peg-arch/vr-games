// VR HUD from canvas textures: a wrist panel on the left grip, captions that lazily follow the
// head, and a floating menu (mic mode, undo, clear, time, parts bin, exit). Emits "action" { name, value }.
import * as THREE from "../../vendor/three.module.min.js";
import { Emitter } from "../util/emitter.js";
import { makeCanvas, canvasTexture, roundRect, wrapLines, FONT } from "../util/text.js";
import { allMeta } from "../parts/meta/index.js";

const C = {
  bg: "rgba(16, 20, 18, 0.92)", solid: "#101412", text: "#eef1e9", muted: "#a7b0a4", accent: "#d5fb6a",
  line: "#596057", panel: "#19271b", hover: "#26392a", danger: "#ff6a5c", dangerFill: "#c8352a", warn: "#ffc857",
};
const TIMES = ["day", "sunset", "night", "dawn"];
const TIME_LABEL = { day: "Day", sunset: "Sunset", night: "Night", dawn: "Dawn" };
const CATEGORIES = ["structures", "nature", "office", "leisure", "combat", "custom"];
const ORDER = 20; // HUD draws after the world
const CAPTION_SECS = 6;
const FADE_SECS = 0.6;
const REDRAW_SECS = 0.1;
const PER_PAGE = 12;

// Panel sizes: meters and canvas pixels.
const WRIST = { w: 0.16, h: 0.1, px: 512, py: 320 };
const CAPTION = { w: 1.0, h: 0.28, px: 1024, py: 288, dist: 1.6, drop: 0.32 };
const MENU = { w: 0.64, h: 0.48, px: 1024, py: 768, dist: 1.0 };
const MENU_CAPTION_SCALE = MENU.dist / CAPTION.dist;

const titleCase = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function hudMaterial(map) {
  return new THREE.MeshBasicMaterial({ map, transparent: true, depthTest: true, depthWrite: false, toneMapped: false, fog: false });
}

function panel(spec) {
  const canvas = makeCanvas(spec.px, spec.py);
  const texture = canvasTexture(canvas);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(spec.w, spec.h), hudMaterial(texture));
  mesh.renderOrder = ORDER;
  mesh.frustumCulled = false;
  return { canvas, ctx: canvas.getContext("2d"), texture, mesh };
}

export class Hud extends Emitter {
  constructor({ scene, camera }) {
    super();
    this.scene = scene;
    this.camera = camera;
    this._visible = true;
    this._grip = null;
    this._mic = { mode: "push", listening: false };
    this._level = 0;
    this._levelShown = 0;
    this._heard = { text: "", interim: false }; // last heard, kept on the wrist
    this._cap = { toast: "", heard: null, reply: null }; // what the caption shows until it fades
    this._conn = { state: "standalone", model: null };
    this._time = "day";
    this._menuOpen = false;
    this._page = "main";
    this._partsPage = 0;
    this._category = "all";
    this._buttons = [];
    this._hoverId = null;
    this._confirmClear = 0;
    this._capAge = Infinity;
    this._capYaw = 0;
    this._capFollow = false;
    this._dirty = { wrist: true, caption: false, menu: true };
    this._sinceDraw = { wrist: 1, caption: 1 };
    this._head = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._hits = [];

    // Wrist panel: on top of the left wrist, tilted up and back toward the eyes.
    this.wrist = panel(WRIST);
    this.wristGroup = new THREE.Group();
    this.wristGroup.name = "hud-wrist";
    this.wristGroup.position.set(0, 0.035, 0.085);
    this.wristGroup.rotation.set(-0.85, 0, 0);
    this.wristGroup.add(this.wrist.mesh);
    const barGeo = new THREE.PlaneGeometry(0.136, 0.006).translate(0.068, 0, 0);
    this.levelBar = new THREE.Mesh(barGeo, new THREE.MeshBasicMaterial({ color: C.accent, toneMapped: false, fog: false, depthWrite: false, transparent: true }));
    this.levelBar.position.set(-0.068, -WRIST.h / 2 + 0.008, 0.0015);
    this.levelBar.renderOrder = ORDER + 1;
    this.levelBar.scale.x = 0.001;
    this.wristGroup.add(this.levelBar);

    // Captions and menu live in world space.
    this.caption = panel(CAPTION);
    this.caption.mesh.name = "hud-captions";
    this.caption.mesh.rotation.order = "YXZ";
    this.caption.mesh.visible = false;
    scene.add(this.caption.mesh);

    this.menu = panel(MENU);
    this.menu.mesh.name = "hud-menu";
    this.menu.mesh.visible = false;
    scene.add(this.menu.mesh);
    this.cursor = new THREE.Mesh(new THREE.CircleGeometry(0.007, 20), new THREE.MeshBasicMaterial({ color: C.accent, toneMapped: false, fog: false, depthWrite: false, transparent: true }));
    this.cursor.renderOrder = ORDER + 1;
    this.cursor.visible = false;
    this.menu.mesh.add(this.cursor);

    this._drawWrist();
  }

  // ---------- placement ----------

  attachTo(grip) {
    this._grip = grip || null;
    this.wristGroup.removeFromParent();
    if (this._grip) this._grip.add(this.wristGroup);
    this.wristGroup.visible = this._visible && !!this._grip;
  }

  setVisible(visible) {
    this._visible = !!visible;
    this.wristGroup.visible = this._visible && !!this._grip;
    this.caption.mesh.visible = false; // update() snaps it in front again
    this.menu.mesh.visible = this._visible && this._menuOpen;
    if (!this._visible) this.toggleMenu(false);
  }

  get menuOpen() {
    return this._menuOpen;
  }

  toggleMenu(open = !this._menuOpen) {
    open = !!open;
    if (open && !this._menuOpen) {
      this._headPose();
      // Where the user looks, kept out of the floor and the sky.
      this._tmp.copy(this._dir);
      this._tmp.y = Math.max(-0.45, Math.min(0.35, this._tmp.y));
      this._tmp.normalize();
      const mesh = this.menu.mesh;
      mesh.position.copy(this._head).addScaledVector(this._tmp, MENU.dist);
      mesh.position.y = Math.max(0.5, mesh.position.y);
      mesh.lookAt(this._head);
      this._page = "main";
      this._confirmClear = 0;
      this._dirty.menu = true;
    }
    this._menuOpen = open;
    this.menu.mesh.visible = this._visible && open;
    if (!open) {
      this._hoverId = null;
      this.cursor.visible = false;
    }
    return open;
  }

  // ---------- state ----------

  setMic(state = {}) {
    this._mic = { mode: state.mode || "push", listening: !!state.listening };
    this._dirty.wrist = true;
    if (this._menuOpen) this._dirty.menu = true;
  }

  setLevel(v) {
    this._level = Math.max(0, Math.min(1, Number(v) || 0));
  }

  setHeard(text, { interim = false } = {}) {
    this._heard = { text: String(text || ""), interim: !!interim };
    this._cap.heard = this._heard;
    this._dirty.wrist = true;
    this._showCaption();
  }

  setReply(text, { source = "model" } = {}) {
    this._cap.reply = { text: String(text || ""), source: String(source || "") };
    this._showCaption();
  }

  toast(text) {
    this._cap.toast = String(text || "");
    this._showCaption();
  }

  setConnection(info = {}) {
    this._conn = { state: info.state || "standalone", model: info.model || null };
    this._dirty.wrist = true;
  }

  setTime(time) {
    this._time = TIMES.includes(time) ? time : "day";
    if (this._menuOpen) this._dirty.menu = true;
  }

  _showCaption() {
    this._capAge = 0;
    this._dirty.caption = true;
  }

  // ---------- pointing ----------

  // Highlights the button under the ray. True while the ray is on any HUD panel.
  hover(raycaster) {
    const hit = this._menuOpen ? this._hit(raycaster, this.menu.mesh) : null;
    const button = hit ? this._buttonAt(hit.uv) : null;
    const id = button?.id || null;
    if (id !== this._hoverId) {
      this._hoverId = id;
      this._dirty.menu = true;
    }
    this.cursor.visible = !!hit;
    if (hit) {
      this.cursor.position.copy(hit.point);
      this.menu.mesh.worldToLocal(this.cursor.position);
      this.cursor.position.z = 0.002;
      return true;
    }
    return !!this._hitWrist(raycaster);
  }

  // Handles a trigger click. True when the ray hit the menu (button or not) or the wrist panel.
  click(raycaster) {
    if (this._menuOpen) {
      const hit = this._hit(raycaster, this.menu.mesh);
      if (hit) {
        const button = this._buttonAt(hit.uv);
        if (button) this._press(button);
        return true;
      }
    }
    if (this._hitWrist(raycaster)) {
      this.toggleMenu();
      return true;
    }
    return false;
  }

  _hit(raycaster, mesh) {
    if (!mesh.visible) return null;
    this._hits.length = 0;
    raycaster.intersectObject(mesh, false, this._hits);
    return this._hits[0] || null;
  }

  _hitWrist(raycaster) {
    return this.wristGroup.visible && this.wristGroup.parent ? this._hit(raycaster, this.wrist.mesh) : null;
  }

  _buttonAt(uv) {
    if (!uv) return null;
    const x = uv.x * MENU.px;
    const y = (1 - uv.y) * MENU.py;
    return this._buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) || null;
  }

  _press(button) {
    const act = (name, value) => this.emit("action", value === undefined ? { name } : { name, value });
    const [kind, value] = button.id.split(":");
    this._dirty.menu = true;
    if (kind !== "clear") this._confirmClear = 0;
    switch (kind) {
      case "mic": return act("mic-mode", value);
      case "undo": return act("undo");
      case "clear":
        if (performance.now() - this._confirmClear < 3000) {
          this._confirmClear = 0;
          return act("clear");
        }
        this._confirmClear = performance.now();
        return undefined;
      case "time": return act("time", TIMES[(TIMES.indexOf(this._time) + 1) % TIMES.length]);
      case "parts": this._page = "parts"; return undefined;
      case "back": this._page = "main"; return undefined;
      case "cat": {
        const cats = this._categories();
        this._category = cats[(cats.indexOf(this._category) + 1) % cats.length];
        this._partsPage = 0;
        return undefined;
      }
      case "prev": this._partsPage = Math.max(0, this._partsPage - 1); return undefined;
      case "next": this._partsPage += 1; return undefined;
      case "spawn":
        this.toggleMenu(false);
        return act("spawn", button.value);
      case "exit":
        this.toggleMenu(false);
        return act("exit-vr");
      case "close": this.toggleMenu(false); return undefined;
      default: return undefined;
    }
  }

  // ---------- frame update ----------

  update(dt = 0) {
    if (!this._visible) return;
    this._headPose();

    // Level bar (no texture upload).
    this._levelShown += (this._level - this._levelShown) * Math.min(1, dt * 18);
    this.levelBar.scale.x = Math.max(0.001, this._mic.mode === "off" ? 0.001 : this._levelShown);

    this._updateCaption(dt);

    // Walked away from the menu: close it.
    if (this._menuOpen && this.menu.mesh.position.distanceToSquared(this._head) > 9) this.toggleMenu(false);
    if (this._confirmClear && performance.now() - this._confirmClear > 3000) {
      this._confirmClear = 0;
      this._dirty.menu = true;
    }

    this._sinceDraw.wrist += dt;
    this._sinceDraw.caption += dt;
    if (this._dirty.wrist && this._sinceDraw.wrist >= REDRAW_SECS) this._drawWrist();
    if (this._dirty.caption && this._sinceDraw.caption >= REDRAW_SECS) this._drawCaption();
    if (this._dirty.menu && this._menuOpen) this._drawMenu();
  }

  _headPose() {
    this.camera.getWorldPosition(this._head);
    this.camera.getWorldDirection(this._dir);
  }

  _updateCaption(dt) {
    const mesh = this.caption.mesh;
    this._capAge += dt;
    const life = CAPTION_SECS + FADE_SECS;
    if (this._capAge >= life) {
      if (mesh.visible) {
        // Faded out: the next caption starts clean.
        this._cap = { toast: "", heard: null, reply: null };
      }
      mesh.visible = false;
      return;
    }
    // With the menu open, captions sit just under it at the same scale on screen.
    if (this._menuOpen) {
      const menu = this.menu.mesh;
      mesh.quaternion.copy(menu.quaternion);
      mesh.position.set(0, -(MENU.h / 2 + 0.02 + CAPTION.h * MENU_CAPTION_SCALE / 2), 0).applyQuaternion(menu.quaternion).add(menu.position);
      mesh.scale.setScalar(MENU_CAPTION_SCALE);
      this._capYaw = Math.atan2(-this._dir.x, -this._dir.z);
      this._fade(mesh);
      return;
    }
    mesh.scale.setScalar(1);

    // Lazy yaw follow: stays put for small head turns, glides after big ones.
    const yaw = Math.atan2(-this._dir.x, -this._dir.z);
    const diff = wrapAngle(yaw - this._capYaw);
    const snap = !mesh.visible;
    if (snap) {
      this._capYaw = yaw;
      this._capFollow = false;
    } else {
      if (Math.abs(diff) > 0.4) this._capFollow = true;
      if (this._capFollow) this._capYaw = wrapAngle(this._capYaw + diff * Math.min(1, dt * 4));
      if (Math.abs(diff) < 0.05) this._capFollow = false;
    }

    this._target.set(-Math.sin(this._capYaw), 0, -Math.cos(this._capYaw)).multiplyScalar(CAPTION.dist).add(this._head);
    this._target.y = this._head.y - CAPTION.drop;
    if (snap) mesh.position.copy(this._target);
    else mesh.position.lerp(this._target, Math.min(1, dt * 6));
    mesh.rotation.set(-0.2, this._capYaw, 0);
    this._fade(mesh);
  }

  _fade(mesh) {
    mesh.material.opacity = this._capAge < CAPTION_SECS ? 1 : Math.max(0, 1 - (this._capAge - CAPTION_SECS) / FADE_SECS);
    mesh.visible = true;
  }

  // ---------- drawing ----------

  _drawWrist() {
    this._dirty.wrist = false;
    this._sinceDraw.wrist = 0;
    const { ctx, texture } = this.wrist;
    const { px: W, py: H } = WRIST;
    const { mode, listening } = this._mic;
    const off = mode === "off";
    const live = listening && !off;
    background(ctx, W, H, off ? C.dangerFill : live ? C.accent : C.line, 22);

    // Mic glyph.
    const cx = 86;
    const cy = 96;
    ctx.beginPath();
    ctx.arc(cx, cy, 58, 0, Math.PI * 2);
    ctx.fillStyle = off ? C.dangerFill : live ? C.accent : C.panel;
    ctx.fill();
    drawMic(ctx, cx, cy, 70, off ? "#ffffff" : live ? C.solid : C.accent, off);

    // State.
    const [title, sub] = off
      ? ["MIC OFF", "Press Y to turn on"]
      : live
        ? ["LISTENING…", mode === "wake" ? "Speak now" : "Release to send"]
        : mode === "wake"
          ? ["SAY “AI, …”", "or hold A/X · Y mutes"]
          : ["HOLD A/X", "to talk · Y mutes"];
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillStyle = off ? C.danger : live ? C.accent : C.text;
    ctx.font = `700 40px ${FONT}`;
    ctx.fillText(ellipsize(ctx, title, W - 180), 164, 52);
    ctx.fillStyle = C.muted;
    ctx.font = `400 28px ${FONT}`;
    ctx.fillText(ellipsize(ctx, sub, W - 180), 164, 104);

    // Connection.
    ctx.fillStyle = C.line;
    ctx.fillRect(24, 168, W - 48, 2);
    const online = this._conn.state === "online";
    ctx.beginPath();
    ctx.arc(36, 199, 8, 0, Math.PI * 2);
    ctx.fillStyle = online ? C.accent : this._conn.state === "offline" ? C.danger : C.muted;
    ctx.fill();
    ctx.fillStyle = C.text;
    ctx.font = `400 28px ${FONT}`;
    ctx.fillText(ellipsize(ctx, connectionText(this._conn), W - 80), 56, 184);

    // Last heard.
    ctx.fillStyle = C.muted;
    ctx.font = `${this._heard.interim ? "italic " : ""}400 28px ${FONT}`;
    const heard = this._heard.text ? `“${this._heard.text}”` : "Nothing heard yet";
    const lines = wrapLines(ctx, heard, W - 48, 2);
    lines.forEach((line, i) => ctx.fillText(line, 24, 226 + i * 34));
    texture.needsUpdate = true;
  }

  _drawCaption() {
    this._dirty.caption = false;
    this._sinceDraw.caption = 0;
    const { ctx, texture } = this.caption;
    const { px: W, py: H } = CAPTION;
    ctx.clearRect(0, 0, W, H);
    const pad = 28;
    const rows = [];
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    const { toast, heard, reply } = this._cap;
    if (toast) {
      ctx.font = `700 32px ${FONT}`;
      rows.push({ font: ctx.font, color: C.warn, lines: wrapLines(ctx, toast, W - pad * 2, 1), lh: 40 });
    }
    if (heard?.text) {
      ctx.font = `${heard.interim ? "italic " : ""}400 34px ${FONT}`;
      rows.push({ font: ctx.font, color: C.muted, lines: wrapLines(ctx, `“${heard.text}”`, W - pad * 2, 1), lh: 44 });
    }
    const badge = sourceLabel(reply?.source || "");
    if (reply?.text) {
      ctx.font = `700 22px ${FONT}`;
      const badgeW = badge ? ctx.measureText(badge).width + 20 : 0;
      ctx.font = `400 40px ${FONT}`;
      const lines = wrapLines(ctx, reply.text, W - pad * 2 - (badgeW ? badgeW + 14 : 0), rows.length > 1 ? 2 : 3);
      rows.push({ font: ctx.font, color: C.text, lines, lh: 50, badge, badgeW });
    }
    if (!rows.length) {
      texture.needsUpdate = true;
      return;
    }
    let height = pad * 2 - 8;
    for (const row of rows) height += row.lines.length * row.lh;
    height = Math.min(H, height);
    const top = H - height; // anchored at the bottom so text grows upward
    ctx.fillStyle = C.bg;
    roundRect(ctx, 0, top, W, height, 22);
    ctx.fill();
    ctx.fillStyle = C.accent;
    ctx.fillRect(0, top + 18, 5, height - 36);
    let y = top + pad;
    for (const row of rows) {
      let x = pad;
      if (row.badge) {
        ctx.font = `700 22px ${FONT}`;
        ctx.strokeStyle = row.badge === "PARSER" ? C.muted : C.accent;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y + 8, row.badgeW, 30);
        ctx.fillText(row.badge, x + 10, y + 13);
        x += row.badgeW + 14;
      }
      ctx.font = row.font;
      ctx.fillStyle = row.color;
      for (const line of row.lines) {
        if (y + row.lh > H) break;
        ctx.fillText(line, x, y);
        y += row.lh;
      }
    }
    texture.needsUpdate = true;
  }

  _categories() {
    const metas = allMeta();
    return ["all", ...CATEGORIES.filter((c) => metas.some((m) => (m.category || "custom") === c))];
  }

  _drawMenu() {
    this._dirty.menu = false;
    const { ctx, texture } = this.menu;
    const { px: W, py: H } = MENU;
    background(ctx, W, H, C.line, 28);
    const buttons = [];
    const add = (id, x, y, w, h, label, opts = {}) => buttons.push({ id, x, y, w, h, label, ...opts });
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    if (this._page === "main") {
      heading(ctx, "TRAINING ROOM", 40, 40);
      ctx.fillStyle = C.muted;
      ctx.font = `400 28px ${FONT}`;
      ctx.fillText(ellipsize(ctx, connectionText(this._conn), 560), 40, 84);
      add("close", 804, 28, 180, 76, "Close");
      label(ctx, "MICROPHONE", 40, 140);
      const mode = this._mic.mode;
      add("mic:push", 40, 176, 304, 100, "Hold to talk", { active: mode === "push" });
      add("mic:wake", 360, 176, 304, 100, "Wake “AI…”", { active: mode === "wake" });
      add("mic:off", 680, 176, 304, 100, "Mic off", { active: mode === "off", danger: true });
      label(ctx, "FIELD", 40, 304);
      const confirming = !!this._confirmClear;
      add("undo", 40, 340, 304, 100, "Undo");
      add("clear", 360, 340, 304, 100, confirming ? "Click again to clear" : "Clear all", { danger: true, active: confirming, size: confirming ? 30 : 36 });
      add("time", 680, 340, 304, 100, `Time: ${TIME_LABEL[this._time]} ▸`);
      add("parts", 40, 464, 464, 100, "Parts bin ▸", { primary: true });
      add("exit", 520, 464, 464, 100, "Exit VR");
      ctx.fillStyle = C.muted;
      ctx.font = `400 28px ${FONT}`;
      ctx.fillText("Hold A/X: talk · Y: mic off · B: menu", 40, 610);
      ctx.fillText("Squeeze: grab · Trigger: click · Stick: move", 40, 652);
    } else {
      const cats = this._categories();
      if (!cats.includes(this._category)) this._category = "all";
      const parts = allMeta()
        .filter((m) => this._category === "all" || (m.category || "custom") === this._category)
        .sort((a, b) => a.name.localeCompare(b.name));
      const pages = Math.max(1, Math.ceil(parts.length / PER_PAGE));
      this._partsPage = Math.min(this._partsPage, pages - 1);
      heading(ctx, "PARTS BIN", 40, 40);
      add("cat", 300, 24, 420, 76, `Show: ${this._category === "all" ? "All" : titleCase(this._category)} ▸`, { size: 32 });
      add("back", 804, 24, 180, 76, "Back");
      const start = this._partsPage * PER_PAGE;
      parts.slice(start, start + PER_PAGE).forEach((m, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        add(`spawn:${i}`, 40 + col * 320, 124 + row * 128, 304, 112, titleCase(m.name), { value: m.name, size: 32 });
      });
      if (!parts.length) {
        ctx.fillStyle = C.muted;
        ctx.font = `400 30px ${FONT}`;
        ctx.fillText("No parts in this category yet.", 40, 140);
      }
      add("prev", 40, 652, 240, 92, "◂ Prev", { disabled: this._partsPage === 0 });
      add("next", 744, 652, 240, 92, "Next ▸", { disabled: this._partsPage >= pages - 1 });
      ctx.fillStyle = C.text;
      ctx.font = `400 32px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(`${this._partsPage + 1} / ${pages}`, W / 2, 682);
      ctx.textAlign = "left";
    }

    for (const b of buttons) drawButton(ctx, b, b.id === this._hoverId && !b.disabled);
    this._buttons = buttons.filter((b) => !b.disabled);
    texture.needsUpdate = true;
  }
}

// ---------- canvas helpers ----------

function background(ctx, w, h, border, radius) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C.bg;
  roundRect(ctx, 0, 0, w, h, radius);
  ctx.fill();
  ctx.strokeStyle = border;
  ctx.lineWidth = 4;
  roundRect(ctx, 2, 2, w - 4, h - 4, radius - 2);
  ctx.stroke();
}

function heading(ctx, text, x, y) {
  ctx.fillStyle = C.accent;
  ctx.font = `700 34px ${FONT}`;
  ctx.fillText(text, x, y);
}

function label(ctx, text, x, y) {
  ctx.fillStyle = C.muted;
  ctx.font = `700 26px ${FONT}`;
  ctx.fillText(text, x, y);
}

function drawButton(ctx, b, hover) {
  const fill = b.active ? (b.danger ? C.dangerFill : C.accent) : b.primary ? "#2b3f1e" : hover ? C.hover : C.panel;
  ctx.globalAlpha = b.disabled ? 0.35 : 1;
  ctx.fillStyle = fill;
  roundRect(ctx, b.x, b.y, b.w, b.h, 12);
  ctx.fill();
  ctx.lineWidth = hover ? 5 : 3;
  ctx.strokeStyle = hover ? C.accent : b.active ? fill : b.primary ? C.accent : C.line;
  roundRect(ctx, b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3, 11);
  ctx.stroke();
  ctx.fillStyle = b.active ? (b.danger ? "#ffffff" : C.solid) : b.danger ? C.danger : C.text;
  const size = b.size || 36;
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const lines = wrapLines(ctx, b.label, b.w - 24, 2);
  const lh = size * 1.15;
  let y = b.y + (b.h - lines.length * lh) / 2 + size * 0.06;
  for (const line of lines) {
    ctx.fillText(line, b.x + b.w / 2, y);
    y += lh;
  }
  ctx.textAlign = "left";
  ctx.globalAlpha = 1;
}

function drawMic(ctx, cx, cy, s, color, slashed) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.1;
  ctx.lineCap = "round";
  roundRect(ctx, cx - s * 0.17, cy - s * 0.5, s * 0.34, s * 0.62, s * 0.17);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy - 0.04 * s, s * 0.32, 0.08 * Math.PI, 0.92 * Math.PI);
  ctx.moveTo(cx, cy + s * 0.28);
  ctx.lineTo(cx, cy + s * 0.44);
  ctx.moveTo(cx - s * 0.17, cy + s * 0.44);
  ctx.lineTo(cx + s * 0.17, cy + s * 0.44);
  if (slashed) {
    ctx.moveTo(cx - s * 0.4, cy - s * 0.48);
    ctx.lineTo(cx + s * 0.4, cy + s * 0.48);
  }
  ctx.stroke();
  ctx.restore();
}

function ellipsize(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

function modelName(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.available ? model.name || "local model" : "";
}

function connectionText({ state, model }) {
  if (state === "online") return `Laptop · ${modelName(model) || "built-in parser"}`;
  if (state === "connecting") return "Connecting to laptop…";
  if (state === "offline") return "Laptop connection lost";
  return "Standalone · built-in parser";
}

function sourceLabel(source) {
  if (source === "parser") return "PARSER";
  if (source === "model" || source.startsWith("model:")) return "MODEL";
  return "";
}
