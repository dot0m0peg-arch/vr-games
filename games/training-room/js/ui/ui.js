// DOM UI: launch screen, desktop overlay, phone companion and the side drawer (menu).
// Emits: enter-vr, play-flat, command (text), talk-down, talk-up, mic-mode (mode), undo, clear,
// spawn (part), remove (id), share ("screen"|"camera"|"stop"), follow (bool), room-key (key),
// time (value), settings (settings).
import { Emitter } from "../util/emitter.js";
import qrcode from "../../vendor/qrcode.mjs";

const SETTINGS_KEY = "training-room:settings";
const RECENT_KEY = "training-room:recent-parts";
const TAB_KEY = "training-room:drawer-tab";
const CATEGORIES = ["structures", "nature", "office", "leisure", "combat", "custom"];
const POPULAR = ["villa", "axe", "card table", "deck of cards", "training dummy", "whiteboard", "campfire", "desk", "sword", "tree"];
const TIMES = [["dawn", "Dawn"], ["day", "Day"], ["sunset", "Sunset"], ["night", "Night"]];
const TABS = [["parts", "Parts bin"], ["objects", "Objects"], ["people", "People"], ["settings", "Settings"]];
const QUIET_MS = 12000;

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7M3.5 3.5l17 17"/></svg>',
  headset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 9.5A2.5 2.5 0 0 1 5.5 7h13A2.5 2.5 0 0 1 21 9.5v5a2.5 2.5 0 0 1-2.5 2.5h-3.2l-1.8-2.4h-3l-1.8 2.4H5.5A2.5 2.5 0 0 1 3 14.5Z"/></svg>',
  desktop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M5 6h14v9H5zM2.5 18.5h19"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/></svg>',
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: the setting lasts for this visit only.
  }
}

function isTyping(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !["checkbox", "radio", "button", "submit", "range"].includes(el.type);
}

const titleCase = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());

function modelName(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.available ? model.name || "local model" : "";
}

const SEG = (attr, items, label) =>
  `<div class="tr-seg" role="group" aria-label="${label}">${items.map(([v, t]) => `<button type="button" data-${attr}="${v}" aria-pressed="false">${t}</button>`).join("")}</div>`;

const TICKER = `
  <div class="tr-ticker tr-empty" data-ref="ticker">
    <p class="tr-heard" data-ref="heard"></p>
    <p class="tr-reply" aria-live="polite"><span class="tr-badge" data-ref="badge" hidden></span><span data-ref="reply"></span></p>
  </div>`;

const CMD = (extra) => `
  <form class="tr-cmdbar" data-ref="form" autocomplete="off">
    ${extra.before || ""}
    <input class="tr-input" data-ref="input" type="text" enterkeyhint="send" autocomplete="off" spellcheck="false" placeholder="${extra.placeholder}" aria-label="Command">
    <button type="submit" class="tr-btn">Send</button>
    ${extra.after || ""}
  </form>`;

const CONN = `<button type="button" class="tr-chip tr-conn" data-ref="conn" data-state="standalone"><span class="tr-dot" aria-hidden="true"></span><span data-ref="connText">Standalone · built-in parser</span></button>`;

const DESKTOP = `
  <div class="tr-top">
    ${CONN}
    <div class="tr-top-actions">
      ${SEG("mode", [["push", "PUSH-TO-TALK"], ["wake", "WAKE “AI…”"], ["off", "MUTE"]], "Microphone mode")}
      <button type="button" class="tr-btn" data-ref="share" aria-pressed="false">Share screen</button>
      <button type="button" class="tr-btn" data-ref="menu" aria-expanded="false" aria-controls="tr-drawer">Menu</button>
    </div>
  </div>
  <div class="tr-crosshair" aria-hidden="true"></div>
  <div class="tr-dock">
    ${TICKER}
    ${CMD({
      placeholder: "Type a command… (Enter)",
      before: `<button type="button" class="tr-talk" data-ref="talk" aria-label="Hold to talk (or hold V)"><span class="tr-talk-icon" data-ref="talkIcon">${ICON.mic}</span><span class="tr-talk-label" data-ref="talkLabel">Hold to talk</span></button>`,
      after: '<button type="button" class="tr-btn" data-ref="undo">Undo</button>',
    })}
    <p class="tr-keys">Click the field to look · WASD move · hold V talk · M mute · E grab · Z undo · Esc frees the mouse</p>
  </div>`;

const PHONE = `
  <div class="tr-top">
    ${CONN}
    <div class="tr-top-actions">
      <button type="button" class="tr-chip tr-follow" data-ref="follow" aria-pressed="false" hidden>Follow headset</button>
    </div>
  </div>
  <section class="tr-panel" data-ref="panel" aria-label="Companion controls">
    ${TICKER}
    ${CMD({ placeholder: "Type a command…" })}
    <div class="tr-quick" data-ref="quick" role="group" aria-label="Quick parts"></div>
    <div class="tr-talkrow">
      <button type="button" class="tr-switch" role="switch" aria-checked="true" data-ref="mute" aria-label="Microphone"><span class="tr-switch-track" aria-hidden="true"><span class="tr-switch-knob"></span></span><span class="tr-switch-label" data-ref="muteLabel">Mic on</span></button>
      <button type="button" class="tr-talk tr-talk-big" data-ref="talk"><span class="tr-talk-icon" data-ref="talkIcon">${ICON.mic}</span><span class="tr-talk-label" data-ref="talkLabel">Hold to talk</span></button>
    </div>
    <div class="tr-row3">
      <button type="button" class="tr-btn" data-ref="undo">Undo</button>
      <button type="button" class="tr-btn" data-ref="share" aria-pressed="false">Share camera</button>
      <button type="button" class="tr-btn" data-ref="menu" aria-expanded="false" aria-controls="tr-drawer">Menu</button>
    </div>
  </section>`;

const DRAWER = `
  <aside class="tr-drawer" id="tr-drawer" data-ref="drawer" aria-label="Menu" inert>
    <div class="tr-drawer-head">
      <div class="tr-tabs" role="tablist" aria-label="Menu sections" data-ref="tabs">
        ${TABS.map(([id, label]) => `<button type="button" role="tab" id="tr-tab-${id}" aria-controls="tr-pane-${id}" aria-selected="false" tabindex="-1" data-tab="${id}">${label}<span class="tr-count" data-count="${id}"></span></button>`).join("")}
      </div>
      <button type="button" class="tr-btn tr-close" data-ref="close" aria-label="Close menu">✕</button>
    </div>
    <div class="tr-pane" role="tabpanel" id="tr-pane-parts" aria-labelledby="tr-tab-parts" data-pane="parts" hidden>
      <input class="tr-input tr-search" data-ref="search" type="search" placeholder="Search parts" aria-label="Search parts" autocomplete="off" spellcheck="false">
      <div class="tr-cats" data-ref="cats" role="group" aria-label="Categories"></div>
      <p class="tr-note">Tap a part to summon it in front of you.</p>
      <div class="tr-grid" data-ref="parts"></div>
    </div>
    <div class="tr-pane" role="tabpanel" id="tr-pane-objects" aria-labelledby="tr-tab-objects" data-pane="objects" hidden>
      <div class="tr-pane-head"><p data-ref="objNote">Nothing summoned yet.</p><button type="button" class="tr-btn tr-danger" data-ref="clear">Clear all</button></div>
      <ul class="tr-list" data-ref="objects"></ul>
      <p class="tr-note">Undo brings removed things back.</p>
    </div>
    <div class="tr-pane" role="tabpanel" id="tr-pane-people" aria-labelledby="tr-tab-people" data-pane="people" hidden>
      <section class="tr-join" data-ref="join" hidden>
        <h3>Join from your phone</h3>
        <canvas data-ref="qr" width="232" height="232" role="img" aria-label="QR code with the join address"></canvas>
        <p>Scan with the phone camera, or open:</p>
        <p class="tr-url" data-ref="joinUrl"></p>
      </section>
      <ul class="tr-list" data-ref="people"></ul>
      <p class="tr-note" data-ref="peopleNote">Only you. Run the laptop bridge to play together.</p>
    </div>
    <div class="tr-pane" role="tabpanel" id="tr-pane-settings" aria-labelledby="tr-tab-settings" data-pane="settings" hidden>
      <fieldset>
        <legend>Voice</legend>
        <label class="tr-check"><input type="checkbox" data-set="wake"><span>Wake word: say “AI, …” without holding a button</span></label>
        <label class="tr-check"><input type="checkbox" data-set="speak"><span>Speak replies out loud</span></label>
        <p class="tr-note" data-ref="engineNote"></p>
      </fieldset>
      <fieldset><legend>Main hand</legend>${SEG("hand", [["left", "Left"], ["right", "Right"]], "Main hand")}</fieldset>
      <fieldset><legend>Grass quality</legend>${SEG("quality", [["low", "Low"], ["high", "High"]], "Grass quality")}</fieldset>
      <fieldset><legend>Time of day</legend>${SEG("time", TIMES, "Time of day")}</fieldset>
    </div>
  </aside>`;

export class UI extends Emitter {
  constructor({ device = "desktop" } = {}) {
    super();
    this.device = ["desktop", "phone", "headset"].includes(device) ? device : "desktop";
    this.layout = this.device === "phone" ? "phone" : "desktop";
    this._settings = {
      wake: false,
      hand: "right",
      quality: this.device === "desktop" ? "high" : "low",
      speak: true,
      ...pick(loadJSON(SETTINGS_KEY, {})),
    };
    this._mic = { mode: "push", listening: false, engine: "none" };
    this._lastMode = this._settings.wake ? "wake" : "push";
    this._launch = { xr: false, bridge: { state: "none", info: null }, voice: { engine: "none" } };
    this._launchReady = false;
    this._launchVisible = true;
    this._loading = false;
    this._conn = { state: "standalone" };
    this._users = [];
    this._metas = [];
    this._records = [];
    this._objSig = "";
    this._dirty = new Set();
    this._category = "all";
    this._recent = loadJSON(RECENT_KEY, []).filter((n) => typeof n === "string").slice(0, 8);
    this._tab = TABS.some(([id]) => id === loadJSON(TAB_KEY, "")) ? loadJSON(TAB_KEY, "") : "parts";
    this._drawerOpen = false;
    this._share = null;
    this._level = 0;
    this._talkHeld = false;
    this._talkByKey = false;
    this._time = "day";
    this._quietTimer = 0;

    const body = document.body;
    body.classList.add(`tr-${this.layout}`);
    body.dataset.device = this.device;

    this._buildLaunch();
    this._buildApp();
    this._toasts = document.createElement("div");
    this._toasts.className = "tr-toasts";
    this._toasts.setAttribute("aria-live", "polite");
    body.appendChild(this._toasts);
    this._wireGlobal();
    this._renderSettings();
    this._renderQuick();
  }

  // ---------- launch ----------

  _buildLaunch() {
    const $ = (id) => document.getElementById(id);
    this.launch = {
      root: $("tr-launch"), msg: $("tr-launch-msg"), enter: $("tr-enter-vr"), play: $("tr-play"),
      loading: $("tr-loading"), xr: $("tr-st-xr"), bridge: $("tr-st-bridge"), voice: $("tr-st-voice"),
      keyForm: $("tr-key-form"), keyInput: $("tr-key-input"),
    };
    const l = this.launch;
    l.play.textContent = this.layout === "phone" ? "Open phone companion" : "Play on this screen";
    if (this.layout === "phone") l.play.parentElement.prepend(l.play);
    l.enter.addEventListener("click", () => this.emit("enter-vr"));
    l.play.addEventListener("click", () => this.emit("play-flat"));
    l.keyForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const key = l.keyInput.value.trim().toUpperCase();
      if (!key) return;
      l.bridge.textContent = "Checking the key…";
      this.emit("room-key", key);
    });
  }

  showLaunch({ xr = false, bridge = { state: "none", info: null }, voice = { engine: "none" } } = {}) {
    this._launch = { xr: !!xr, bridge: { state: bridge?.state || "none", info: bridge?.info || null }, voice: { engine: voice?.engine || "none" } };
    this._launchReady = true;
    const l = this.launch;
    l.xr.textContent = xrText(this._launch.xr, this.device);
    this._renderBridge(this._launch.bridge);
    l.voice.textContent = voiceText(this._launch.voice.engine);
    l.enter.classList.toggle("primary", this._launch.xr);
    l.play.classList.toggle("primary", !this._launch.xr);
    this._syncLaunchButtons();
    this._setLaunchVisible(true);
  }

  hideLaunch() {
    this.launch.msg.hidden = true;
    this._setLaunchVisible(false);
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  }

  showLaunchAgain(message) {
    const l = this.launch;
    l.msg.hidden = !message;
    l.msg.textContent = message || "";
    this.showLaunch(this._launch);
    (this._launch.xr ? l.enter : l.play).focus({ preventScroll: true });
  }

  setLoading(text) {
    const l = this.launch;
    this._loading = !!text;
    l.loading.hidden = !text;
    l.loading.textContent = text || "";
    this._syncLaunchButtons();
  }

  _syncLaunchButtons() {
    const ready = this._launchReady && !this._loading;
    this.launch.enter.disabled = !ready || !this._launch.xr;
    this.launch.play.disabled = !ready;
  }

  _setLaunchVisible(visible) {
    this._launchVisible = visible;
    this.launch.root.hidden = !visible;
    this.app.hidden = visible;
    document.body.classList.toggle("tr-in-launch", visible);
    document.body.classList.toggle("tr-playing", !visible);
    if (visible) {
      this._closeDrawer(false);
      this._talkEnd();
      if (document.pointerLockElement) document.exitPointerLock?.();
    }
  }

  _renderBridge({ state, info }) {
    const l = this.launch;
    l.keyForm.hidden = state !== "needs-key";
    l.bridge.textContent = bridgeText(state, info);
  }

  // ---------- app shell ----------

  _buildApp() {
    this.app = document.getElementById("tr-app");
    this.app.innerHTML = (this.layout === "phone" ? PHONE : DESKTOP) + DRAWER;
    this.refs = {};
    for (const node of this.app.querySelectorAll("[data-ref]")) this.refs[node.dataset.ref] = node;
    const r = this.refs;

    r.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = r.input.value.trim();
      r.input.value = "";
      r.input.blur();
      if (text) this.emit("command", text);
    });
    r.undo.addEventListener("click", () => this.emit("undo"));
    r.share.addEventListener("click", () => this.emit("share", this._share ? "stop" : this.layout === "phone" ? "camera" : "screen"));
    r.menu.addEventListener("click", () => (this._drawerOpen ? this._closeDrawer() : this._openDrawer()));
    r.conn.addEventListener("click", () => this._openDrawer("people"));
    r.close.addEventListener("click", () => this._closeDrawer());
    this._wireTalk(r.talk);

    if (this.layout === "desktop") {
      this.app.querySelector('.tr-top [aria-label="Microphone mode"]').addEventListener("click", (event) => {
        const mode = event.target.closest("[data-mode]")?.dataset.mode;
        if (!mode) return;
        if (mode === "off" && this._mic.mode === "off") this.emit("mic-mode", this._lastMode);
        else this._pickMode(mode);
      });
    } else {
      r.mute.addEventListener("click", () => this.emit("mic-mode", this._mic.mode === "off" ? this._lastMode : "off"));
      r.follow.addEventListener("click", () => this.emit("follow", r.follow.getAttribute("aria-pressed") !== "true"));
      r.quick.addEventListener("click", (event) => {
        const name = event.target.closest("[data-part]")?.dataset.part;
        if (name) this._spawn(name);
      });
      if (typeof ResizeObserver === "function") {
        new ResizeObserver(() => this._measurePanel()).observe(r.panel);
      }
      window.addEventListener("resize", () => this._measurePanel());
    }

    // Drawer: tabs (arrow keys move between them), parts, objects, settings.
    r.tabs.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-tab]")?.dataset.tab;
      if (tab) this._selectTab(tab);
    });
    r.tabs.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const ids = TABS.map(([id]) => id);
      let i = ids.indexOf(this._tab);
      if (event.key === "ArrowLeft") i = (i + ids.length - 1) % ids.length;
      else if (event.key === "ArrowRight") i = (i + 1) % ids.length;
      else i = event.key === "Home" ? 0 : ids.length - 1;
      this._selectTab(ids[i]);
      r.tabs.querySelector(`[data-tab="${ids[i]}"]`).focus();
    });
    r.search.addEventListener("input", () => this._renderParts());
    r.cats.addEventListener("click", (event) => {
      const cat = event.target.closest("[data-cat]")?.dataset.cat;
      if (!cat) return;
      this._category = cat;
      this._renderParts();
    });
    r.parts.addEventListener("click", (event) => {
      const name = event.target.closest("[data-part]")?.dataset.part;
      if (name) this._spawn(name);
    });
    r.objects.addEventListener("click", (event) => {
      const id = event.target.closest("[data-remove]")?.dataset.remove;
      if (id) this.emit("remove", id);
    });
    r.clear.addEventListener("click", () => this.emit("clear"));
    const settingsPane = this.app.querySelector('[data-pane="settings"]');
    settingsPane.addEventListener("change", (event) => {
      const key = event.target.dataset?.set;
      if (key) this._changeSetting(key, event.target.checked);
    });
    settingsPane.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.hand) this._changeSetting("hand", button.dataset.hand);
      else if (button.dataset.quality) this._changeSetting("quality", button.dataset.quality);
      else if (button.dataset.time) this.emit("time", button.dataset.time);
    });
    this._selectTab(this._tab, false);
  }

  _wireTalk(button) {
    button.addEventListener("pointerdown", (event) => {
      if (event.button > 0) return;
      event.preventDefault();
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // Capture is optional.
      }
      this._talkStart();
    });
    for (const type of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"]) {
      button.addEventListener(type, () => {
        if (!this._talkByKey) this._talkEnd();
      });
    }
    button.addEventListener("contextmenu", (event) => event.preventDefault());
    button.addEventListener("keydown", (event) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      if (event.repeat || this._talkHeld) return;
      this._talkByKey = true;
      this._talkStart();
    });
    button.addEventListener("keyup", (event) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      this._talkEnd();
    });
    button.addEventListener("blur", () => this._talkEnd());
  }

  _talkStart() {
    if (this._talkHeld) return;
    this._talkHeld = true;
    this.refs.talk.classList.add("tr-held");
    this.emit("talk-down");
  }

  _talkEnd() {
    this._talkByKey = false;
    if (!this._talkHeld) return;
    this._talkHeld = false;
    this.refs.talk.classList.remove("tr-held");
    this.emit("talk-up");
  }

  _wireGlobal() {
    window.addEventListener("keydown", (event) => this._onKey(event));
    window.addEventListener("keyup", (event) => {
      if (event.code === "Space" && this._talkByKey) this._talkEnd();
    });
    window.addEventListener("blur", () => this._talkEnd());
    document.addEventListener("pointerlockchange", () => {
      document.body.classList.toggle("tr-locked", !!document.pointerLockElement);
    });
  }

  _onKey(event) {
    if (this._launchVisible) return;
    const active = document.activeElement;
    if (event.key === "Escape") {
      if (isTyping(active) && this.app.contains(active)) {
        active.blur();
        event.preventDefault();
      } else if (this._drawerOpen) {
        this._closeDrawer();
        event.preventDefault();
      }
      return;
    }
    if (isTyping(active) || event.ctrlKey || event.metaKey || event.altKey) return;
    const tag = event.target?.tagName;
    if (["BUTTON", "A", "SUMMARY", "SELECT"].includes(tag)) return;
    if (event.key === "Enter" && this.layout === "desktop") {
      event.preventDefault();
      if (document.pointerLockElement) document.exitPointerLock?.();
      this.refs.input.focus();
    } else if (event.code === "Space" && this.layout === "phone") {
      event.preventDefault();
      if (event.repeat || this._talkHeld) return;
      this._talkByKey = true;
      this._talkStart();
    }
  }

  // Phone: publish the bottom panel size so the 3D view and the joystick sit above it.
  _measurePanel() {
    const rect = this.refs.panel?.getBoundingClientRect();
    if (!rect) return;
    const root = document.documentElement.style;
    const side = rect.top < 8 && rect.width < window.innerWidth - 8;
    root.setProperty("--tr-panel-h", `${side ? 0 : Math.round(window.innerHeight - rect.top)}px`);
    root.setProperty("--tr-panel-w", `${side ? Math.round(rect.width) : 0}px`);
  }

  // ---------- drawer ----------

  _openDrawer(tab) {
    if (tab) this._selectTab(tab, false);
    this._drawerOpen = true;
    const { drawer, menu } = this.refs;
    drawer.inert = false;
    drawer.classList.add("tr-open");
    document.body.classList.add("tr-drawer-open");
    menu.setAttribute("aria-expanded", "true");
    if (document.pointerLockElement) document.exitPointerLock?.();
    this._renderTab(this._tab);
    drawer.querySelector(`[data-tab="${this._tab}"]`).focus({ preventScroll: true });
  }

  _closeDrawer(restoreFocus = true) {
    if (!this._drawerOpen) return;
    this._drawerOpen = false;
    const { drawer, menu } = this.refs;
    const hadFocus = drawer.contains(document.activeElement);
    drawer.classList.remove("tr-open");
    drawer.inert = true;
    document.body.classList.remove("tr-drawer-open");
    menu.setAttribute("aria-expanded", "false");
    if (hadFocus && restoreFocus) menu.focus({ preventScroll: true });
  }

  _selectTab(tab, persist = true) {
    this._tab = tab;
    if (persist) saveJSON(TAB_KEY, tab);
    for (const button of this.refs.tabs.querySelectorAll("[data-tab]")) {
      const on = button.dataset.tab === tab;
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
    }
    for (const pane of this.app.querySelectorAll("[data-pane]")) pane.hidden = pane.dataset.pane !== tab;
    this._renderTab(tab);
  }

  _renderTab(tab) {
    if (!this._dirty.has(tab) && tab !== "parts") return;
    this._dirty.delete(tab);
    if (tab === "parts") this._renderParts();
    else if (tab === "objects") this._renderObjects();
    else if (tab === "people") this._renderPeople();
  }

  _visible(tab) {
    return this._drawerOpen && this._tab === tab;
  }

  _spawn(name) {
    this._recent = [name, ...this._recent.filter((n) => n !== name)].slice(0, 8);
    saveJSON(RECENT_KEY, this._recent);
    this._renderQuick();
    this.emit("spawn", name);
  }

  _pickMode(mode) {
    if (mode === "push" || mode === "wake") this._rememberMode(mode);
    this.emit("mic-mode", mode);
  }

  _rememberMode(mode) {
    this._lastMode = mode;
    if (this._settings.wake !== (mode === "wake")) {
      this._settings.wake = mode === "wake";
      saveJSON(SETTINGS_KEY, this._settings);
      this._renderSettings();
    }
  }

  _changeSetting(key, value) {
    this._settings[key] = value;
    if (key === "wake") this._lastMode = value ? "wake" : "push";
    saveJSON(SETTINGS_KEY, this._settings);
    this._renderSettings();
    this.emit("settings", this.settings);
  }

  // ---------- public state setters ----------

  setMic({ mode = "push", listening = false, engine = "none" } = {}) {
    this._mic = { mode, listening: !!listening, engine };
    if (mode === "push" || mode === "wake") this._lastMode = mode;
    const r = this.refs;
    const off = mode === "off";
    document.body.classList.toggle("tr-muted", off);
    document.body.classList.toggle("tr-listening", !!listening && !off);
    r.talkIcon.innerHTML = off ? ICON.micOff : ICON.mic;
    r.talkLabel.textContent = off ? "Mic off" : listening ? "Listening…" : mode === "wake" ? "Say “AI, …” or hold" : "Hold to talk";
    if (this.layout === "desktop") {
      for (const button of this.app.querySelectorAll(".tr-top [data-mode]")) {
        button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
        if (button.dataset.mode === "off") button.textContent = off ? "MUTED" : "MUTE";
      }
    } else {
      r.mute.setAttribute("aria-checked", String(!off));
      r.muteLabel.textContent = off ? "Mic off" : "Mic on";
    }
    if (listening && !off && !r.heard.textContent) this._setHeardText("Listening…", true);
    r.engineNote.textContent = `Voice engine: ${voiceText(engine)}`;
    if (this._launchReady) this.launch.voice.textContent = voiceText(engine);
  }

  setLevel(v) {
    const level = Math.max(0, Math.min(1, Number(v) || 0));
    if (Math.abs(level - this._level) < 0.02 && level !== 0) return;
    this._level = level;
    this.refs.talk.style.setProperty("--lvl", level.toFixed(2));
  }

  setHeard(text, { interim = false } = {}) {
    this._setHeardText(text ? `“${text}”` : "", interim);
  }

  _setHeardText(text, interim) {
    const heard = this.refs.heard;
    heard.textContent = text;
    heard.classList.toggle("tr-interim", !!interim);
    this._wake();
  }

  setReply(text, { source = "model" } = {}) {
    const { reply, badge } = this.refs;
    reply.textContent = text || "";
    const label = sourceLabel(source);
    badge.hidden = !label;
    badge.textContent = label;
    badge.dataset.source = String(source || "").split(":")[0];
    badge.title = String(source || "").startsWith("model:") ? `Answered by ${String(source).slice(6)}` : "";
    this._wake();
  }

  // Ticker dims after a quiet spell and lights up again on new text.
  _wake() {
    const { ticker, heard, reply } = this.refs;
    ticker.classList.toggle("tr-empty", !heard.textContent && !reply.textContent);
    ticker.classList.remove("tr-quiet");
    clearTimeout(this._quietTimer);
    this._quietTimer = setTimeout(() => ticker.classList.add("tr-quiet"), QUIET_MS);
  }

  toast(text, kind = "info") {
    if (!text) return;
    const node = document.createElement("div");
    node.className = `tr-toast tr-toast-${kind}`;
    node.textContent = text;
    this._toasts.appendChild(node);
    while (this._toasts.children.length > 3) this._toasts.firstElementChild.remove();
    setTimeout(() => {
      node.classList.add("tr-out");
      setTimeout(() => node.remove(), 300);
    }, kind === "error" ? 7000 : 4500);
  }

  setConnection({ state = "standalone", model, stt, url, users } = {}) {
    this._conn = { state, model, stt, url };
    const { conn, connText } = this.refs;
    conn.dataset.state = state;
    connText.textContent = connLabel(state, model, this._users);
    conn.title = state === "online" && stt?.available ? "Voice: Whisper on the laptop" : "";
    if (users) this.setUsers(users);
    else this._markDirty("people");
    if (state === "online") {
      this._launch.bridge = { state: "online", info: { ...(this._launch.bridge.info || {}), model, stt } };
      this._renderBridge(this._launch.bridge);
    } else if (state === "connecting") {
      this._renderBridge({ state: "connecting" });
    } else if (state === "offline") {
      this._renderBridge({ state: "offline" });
    } else {
      this._renderBridge(this._launch.bridge);
    }
  }

  setUsers(users) {
    this._users = Array.isArray(users) ? users : [];
    this.refs.connText.textContent = connLabel(this._conn.state, this._conn.model, this._users);
    const count = this.app.querySelector('[data-count="people"]');
    const online = this._users.filter((u) => u.online !== false).length;
    count.textContent = online > 1 ? ` ${online}` : "";
    this._markDirty("people");
  }

  setObjects(records) {
    const list = Array.isArray(records) ? records : [];
    let sig = "";
    for (const r of list) sig += `${r.id}|${r.label || r.part}|${r.attach ? 1 : 0};`;
    if (sig === this._objSig) return;
    this._objSig = sig;
    this._records = list;
    this.app.querySelector('[data-count="objects"]').textContent = list.length ? ` ${list.length}` : "";
    this._markDirty("objects");
  }

  setParts(metas) {
    this._metas = (Array.isArray(metas) ? metas : []).slice().sort((a, b) => a.name.localeCompare(b.name));
    this.refs.search.placeholder = `Search ${this._metas.length} parts`;
    this._renderCats();
    this._renderQuick();
    this._markDirty("parts");
  }

  setShare({ active = false, kind = null } = {}) {
    this._share = active ? kind || "screen" : null;
    const share = this.refs.share;
    share.setAttribute("aria-pressed", String(!!active));
    share.textContent = active ? (this.layout === "phone" ? "Stop camera" : "Stop sharing") : this.layout === "phone" ? "Share camera" : "Share screen";
  }

  showJoinQR(url) {
    const { join, qr, joinUrl } = this.refs;
    join.hidden = !url || this.layout !== "desktop";
    if (join.hidden) return;
    joinUrl.textContent = url;
    try {
      drawQR(qr, url);
      qr.hidden = false;
    } catch (err) {
      console.warn("[ui] could not draw the QR code", err);
      qr.hidden = true;
    }
  }

  setFollowAvailable(available) {
    if (this.refs.follow) this.refs.follow.hidden = !available;
  }

  setFollow(on) {
    this.refs.follow?.setAttribute("aria-pressed", String(!!on));
  }

  setTime(time) {
    this._time = time || "day";
    for (const button of this.app.querySelectorAll("[data-time]")) button.setAttribute("aria-pressed", String(button.dataset.time === this._time));
  }

  setSettings(settings) {
    Object.assign(this._settings, pick(settings || {}));
    if (this._mic.mode === "off") this._lastMode = this._settings.wake ? "wake" : "push";
    saveJSON(SETTINGS_KEY, this._settings);
    this._renderSettings();
  }

  get settings() {
    return { ...this._settings };
  }

  // ---------- rendering ----------

  _markDirty(tab) {
    this._dirty.add(tab);
    if (this._visible(tab)) this._renderTab(tab);
  }

  _renderSettings() {
    const pane = this.app.querySelector('[data-pane="settings"]');
    for (const input of pane.querySelectorAll("[data-set]")) input.checked = !!this._settings[input.dataset.set];
    for (const button of pane.querySelectorAll("[data-hand]")) button.setAttribute("aria-pressed", String(button.dataset.hand === this._settings.hand));
    for (const button of pane.querySelectorAll("[data-quality]")) button.setAttribute("aria-pressed", String(button.dataset.quality === this._settings.quality));
    this.setTime(this._time);
  }

  _renderCats() {
    const present = CATEGORIES.filter((c) => this._metas.some((m) => (m.category || "custom") === c));
    if (this._category !== "all" && !present.includes(this._category)) this._category = "all";
    const cats = this.refs.cats;
    cats.replaceChildren(...["all", ...present].map((c) => button("tr-chip", { "data-cat": c, "aria-pressed": String(c === this._category) }, c === "all" ? "All" : titleCase(c))));
  }

  _renderParts() {
    this._dirty.delete("parts");
    for (const chip of this.refs.cats.querySelectorAll("[data-cat]")) chip.setAttribute("aria-pressed", String(chip.dataset.cat === this._category));
    const q = this.refs.search.value.trim().toLowerCase();
    const items = this._metas.filter((m) => {
      if (this._category !== "all" && (m.category || "custom") !== this._category) return false;
      if (!q) return true;
      return m.name.includes(q) || (m.aliases || []).some((a) => a.includes(q)) || String(m.desc || "").toLowerCase().includes(q);
    });
    const nodes = items.map((m) => {
      const node = button("tr-part", { "data-part": m.name, title: m.desc || "" });
      node.append(span("tr-part-name", titleCase(m.name)), span("tr-part-cat", m.holdable ? `${m.category || "custom"} · holdable` : m.category || "custom"));
      return node;
    });
    if (!nodes.length) nodes.push(para("tr-note", this._metas.length ? "No part matches. Try saying it anyway: the local model can build new things." : "Loading parts…"));
    this.refs.parts.replaceChildren(...nodes);
  }

  _renderQuick() {
    const quick = this.refs.quick;
    if (!quick) return;
    const known = new Set(this._metas.map((m) => m.name));
    const names = [...new Set([...this._recent, ...POPULAR])].filter((n) => !known.size || known.has(n)).slice(0, 10);
    quick.replaceChildren(...names.map((n) => button("tr-chip", { "data-part": n, "aria-label": `Summon ${n}` }, n)));
  }

  _renderObjects() {
    const records = this._records;
    this.refs.objNote.textContent = records.length ? `${records.length} thing${records.length === 1 ? "" : "s"} on the field` : "Nothing summoned yet.";
    this.refs.clear.disabled = !records.length;
    const items = [];
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      const name = titleCase(r.label || r.part);
      const sub = [r.label && r.label !== r.part ? r.part : "", r.attach ? `held (${r.attach.hand || "hand"})` : ""].filter(Boolean).join(" · ");
      const li = document.createElement("li");
      const text = document.createElement("div");
      text.append(span("tr-li-name", name));
      if (sub) text.append(span("tr-li-sub", sub));
      li.append(text, button("tr-btn tr-btn-small", { "data-remove": r.id, "aria-label": `Remove ${name}` }, "Remove"));
      items.push(li);
    }
    this.refs.objects.replaceChildren(...items);
  }

  _renderPeople() {
    const users = this._users;
    const items = users.map((u) => {
      const li = document.createElement("li");
      const icon = span("tr-device");
      icon.innerHTML = ICON[u.device] || ICON.desktop;
      icon.style.color = /^#[0-9a-f]{6}$/i.test(u.color || "") ? u.color : "";
      const text = document.createElement("div");
      text.append(span("tr-li-name", u.name || "Player"), span("tr-li-sub", `${deviceName(u.device)} · ${u.online === false ? "away" : "online"}`));
      li.append(icon, text);
      return li;
    });
    this.refs.people.replaceChildren(...items);
    const online = this._conn.state === "online";
    this.refs.peopleNote.textContent = online
      ? users.length > 1 ? "Everyone here shares one field." : "Only this device so far. Open the laptop address on the headset or phone to join."
      : this._conn.state === "offline" ? "The laptop connection dropped. Things you do now stay on this device." : "Only you. Run the laptop bridge to play together.";
  }
}

// ---------- helpers ----------

function pick(s) {
  const out = {};
  if (typeof s.wake === "boolean") out.wake = s.wake;
  if (s.hand === "left" || s.hand === "right") out.hand = s.hand;
  if (s.quality === "low" || s.quality === "high") out.quality = s.quality;
  if (typeof s.speak === "boolean") out.speak = s.speak;
  return out;
}

function button(cls, attrs = {}, text = "") {
  const node = document.createElement("button");
  node.type = "button";
  node.className = cls;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

function span(cls, text = "") {
  const node = document.createElement("span");
  node.className = cls;
  node.textContent = text;
  return node;
}

function para(cls, text) {
  const node = document.createElement("p");
  node.className = cls;
  node.textContent = text;
  return node;
}

function deviceName(device) {
  return device === "headset" ? "Headset" : device === "phone" ? "Phone" : "Laptop";
}

function sourceLabel(source) {
  const s = String(source || "");
  if (s === "parser") return "parser";
  if (s.startsWith("model")) return "model";
  return "";
}

function xrText(xr, device) {
  if (xr) return "WebXR VR is available. Put on the headset and press Enter VR.";
  if (typeof window !== "undefined" && !window.isSecureContext) return "VR needs a secure page (https). Open the laptop bridge’s https address.";
  if (device === "headset") return "This browser did not offer immersive VR. You can still play on this screen.";
  return "No WebXR VR in this browser. Play on this screen, or open this page in the Quest browser.";
}

function voiceText(engine) {
  if (engine === "bridge") return "Whisper on the laptop (hold to talk or wake word).";
  if (engine === "browser") return "This browser’s speech recognition.";
  if (typeof window !== "undefined" && !window.isSecureContext) return "The microphone needs https. Type commands, or use the laptop bridge address.";
  return "No speech engine here. Type commands, or run the laptop bridge for Whisper.";
}

function bridgeText(state, info) {
  if (state === "online") {
    const name = modelName(info?.model);
    return name ? `Connected to laptop: ${name}` : "Connected to laptop. No local model found, so the built-in parser answers.";
  }
  if (state === "needs-key") return "Found a laptop bridge. Enter the room key it printed.";
  if (state === "connecting") return "Looking for the laptop…";
  if (state === "offline") return "Lost the laptop connection. Retrying…";
  return "Standalone: built-in command parser, one player. See “Connect your laptop and phone” below.";
}

function connLabel(state, model, users) {
  if (state === "connecting") return "Connecting to laptop…";
  if (state === "offline") return "Laptop connection lost";
  if (state !== "online") return "Standalone · built-in parser";
  const name = modelName(model);
  const others = users.filter((u) => u.online !== false).length;
  return `Laptop · ${name || "built-in parser"}${others > 1 ? ` · ${others} here` : ""}`;
}

function drawQR(canvas, text) {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const n = code.getModuleCount();
  const quiet = 4;
  const scale = Math.max(2, Math.floor(232 / (n + quiet * 2)));
  const size = (n + quiet * 2) * scale;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#101412";
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (code.isDark(row, col)) ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
    }
  }
}
