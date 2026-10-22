// DOM UI: launch screen, desktop overlay, phone companion, the side drawer (menu) and the magic
// marker (desktop toolbar, phone sketch pad).
// Emits: enter-vr, play-flat, command (text), talk-down, talk-up, mic-mode (mode), undo, clear,
// spawn (part), remove (id), share ("screen"|"camera"|"stop"), follow (bool), room-key (key),
// time (value), settings (settings), marker (on), marker-color (hex), realize, guess, erase,
// undo-stroke, sketch ({ lines, aspect, color, colors, realize }), selftest ({ phase: "prepare" | "vr" }).
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
const MARKER_COLORS = [["#9b6bff", "Purple"], ["#1b1b1b", "Black"], ["#e8574b", "Red"], ["#3d7be0", "Blue"], ["#3fae5a", "Green"], ["#f4f4f4", "White"]];
const MARKER_DEFAULT = MARKER_COLORS[0][0];
const KEYS_TEXT = "Click the field to look · WASD move · hold V talk · M mute · E grab · F marker · Z undo · Esc frees the mouse";
const KEYS_MARKER = "Marker on · left-drag on the sheet to draw · hold V and say “make it real” · F puts it away";
// Sketch pad (phone): ink limits in pad pixels.
const SKETCH_MAX_POINTS = 4000;
const SKETCH_MIN_STEP2 = 2.25; // 1.5 px between kept points
const SKETCH_PAPER = "#f3f1ea";
const SKETCH_OUTSIDE = "#0b0e0c";
const CHECK_ICON = { pass: "✓", fail: "✕", warn: "!", skip: "–" };
const CHECK_WORD = { pass: "Pass", fail: "Fail", warn: "Warning", skip: "Skipped" };

const ICON = {
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7M3.5 3.5l17 17"/></svg>',
  headset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 9.5A2.5 2.5 0 0 1 5.5 7h13A2.5 2.5 0 0 1 21 9.5v5a2.5 2.5 0 0 1-2.5 2.5h-3.2l-1.8-2.4h-3l-1.8 2.4H5.5A2.5 2.5 0 0 1 3 14.5Z"/></svg>',
  desktop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M5 6h14v9H5zM2.5 18.5h19"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/></svg>',
  marker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="m14.5 4.5 5 5L9 20H4v-5Z"/><path d="m12 7 5 5"/></svg>',
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

const SWATCHES = (attr) =>
  `<div class="tr-swatches" role="group" aria-label="Marker color">${MARKER_COLORS.map(([hex, name]) => `<button type="button" class="tr-swatch" data-${attr}="${hex}" aria-label="${name}" aria-pressed="${hex === MARKER_DEFAULT}" title="${name}" style="--sw: ${hex}"></button>`).join("")}</div>`;

const CONN = `<button type="button" class="tr-chip tr-conn" data-ref="conn" data-state="standalone"><span class="tr-dot" aria-hidden="true"></span><span data-ref="connText">Standalone · built-in parser</span></button>`;

const DESKTOP = `
  <div class="tr-top">
    ${CONN}
    <div class="tr-top-actions">
      ${SEG("mode", [["push", "PUSH-TO-TALK"], ["wake", "WAKE “AI…”"], ["off", "MUTE"]], "Microphone mode")}
      <button type="button" class="tr-btn tr-marker" data-ref="marker" aria-pressed="false" aria-keyshortcuts="F" title="Magic marker (F)"><span class="tr-ink" aria-hidden="true"></span>Marker</button>
      <button type="button" class="tr-btn" data-ref="share" aria-pressed="false">Share screen</button>
      <button type="button" class="tr-btn" data-ref="menu" aria-expanded="false" aria-controls="tr-drawer">Menu</button>
    </div>
    <div class="tr-markerbar" data-ref="markerBar" role="group" aria-label="Magic marker" hidden>
      ${SWATCHES("color")}
      <button type="button" class="tr-btn" data-mk="undo-stroke">Undo stroke</button>
      <button type="button" class="tr-btn" data-mk="guess" disabled>What is it?</button>
      <button type="button" class="tr-btn" data-mk="erase" disabled>Erase</button>
      <button type="button" class="tr-btn tr-primary" data-mk="realize" disabled>Make it real</button>
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
    <p class="tr-keys" data-ref="keys">${KEYS_TEXT}</p>
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
    <div class="tr-row4">
      <button type="button" class="tr-btn tr-draw" data-ref="draw" aria-haspopup="dialog">${ICON.marker}Draw</button>
      <button type="button" class="tr-btn" data-ref="undo">Undo</button>
      <button type="button" class="tr-btn" data-ref="share" aria-pressed="false">Share camera</button>
      <button type="button" class="tr-btn" data-ref="menu" aria-expanded="false" aria-controls="tr-drawer">Menu</button>
    </div>
  </section>
  <div class="tr-sketch" data-ref="sketch" role="dialog" aria-modal="true" aria-labelledby="tr-sketch-title" aria-describedby="tr-sketch-hint" tabindex="-1" hidden>
    <div class="tr-sketch-top">
      <button type="button" class="tr-btn" data-sk="cancel">Cancel</button>
      <h2 class="tr-sketch-title" id="tr-sketch-title">Sketch pad</h2>
      <button type="button" class="tr-btn" data-sk="undo" disabled>Undo stroke</button>
      <button type="button" class="tr-btn" data-sk="clear" disabled>Clear</button>
    </div>
    <div class="tr-sketch-paper" data-ref="paper">
      <canvas data-ref="pad" role="img" aria-label="Drawing area: draw with one finger"></canvas>
      <p class="tr-sketch-hint" id="tr-sketch-hint">Draw anything. Make it real and the AI will guess what it is.</p>
    </div>
    <div class="tr-sketch-bottom">
      ${SWATCHES("pcolor")}
      <div class="tr-sketch-actions">
        <button type="button" class="tr-btn" data-sk="send" disabled>Send to field</button>
        <button type="button" class="tr-btn tr-primary" data-sk="real" disabled>Make it real</button>
      </div>
    </div>
  </div>`;

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
      <fieldset>
        <legend>Mode</legend>
        <label class="tr-check"><input type="checkbox" data-set="kingdom"><span>Kingdom mode: advisors, villagers and a village square. Say “Builder, build a house right here” while pointing.</span></label>
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
    this._marker = { on: false, color: MARKER_DEFAULT };
    this._drawingAvailable = false;
    // Sketch pad: strokes in frame pixels ({ c, pts: [x, y, ...] }), frame = paper size when started.
    this._sk = { open: false, strokes: [], cleared: null, cur: null, points: 0, frame: null, view: { s: 1, ox: 0, oy: 0 }, dpr: 1, rect: null, lineW: 6, raf: 0, base: null };

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
      keyForm: $("tr-key-form"), keyInput: $("tr-key-input"), kingdom: $("tr-kingdom"),
    };
    const l = this.launch;
    if (l.kingdom) {
      l.kingdom.checked = !!this._settings.kingdom;
      l.kingdom.addEventListener("change", () => this._changeSetting("kingdom", l.kingdom.checked));
    }
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
    this._buildSelfTest();
  }

  // Headset/device check in the "This device" card: tap 1 emits selftest { phase: "prepare" },
  // "Start VR test" (tap 2) emits { phase: "vr" } so requestSession runs inside that tap.
  _buildSelfTest() {
    this._checkBusy = false;
    this._checkReport = null;
    const card = this.launch.root.querySelector(".tr-status-card");
    if (!card) return;
    const label = this.device === "headset" ? "Headset check" : "Device check";
    const box = document.createElement("section");
    box.className = "tr-selftest";
    box.setAttribute("aria-label", label);
    box.innerHTML = `
      <button type="button" class="button tr-selftest-run" data-st="run" disabled>${label}</button>
      <p class="tr-selftest-note">${this.device === "headset" ? "Tests the mic, Whisper, the laptop voice and the VR frame rate, then sends a report to the laptop." : "Tests the mic, voice and laptop bridge on this device. The full check runs in the headset."}</p>
      <p class="tr-selftest-busy" data-st="busy" role="status" hidden></p>
      <div class="tr-selftest-result" data-st="result" hidden>
        <p class="tr-selftest-head" data-st="head" tabindex="-1"></p>
        <ul class="tr-selftest-rows" data-st="rows"></ul>
        <p class="tr-selftest-saved" data-st="saved" hidden></p>
        <div class="tr-selftest-actions">
          <button type="button" class="button primary" data-st="vr" hidden>Start VR test</button>
          <button type="button" class="button" data-st="copy" disabled>Copy report</button>
        </div>
        <textarea class="tr-selftest-text" data-st="text" readonly aria-label="Report" hidden></textarea>
      </div>`;
    card.appendChild(box);
    const c = {};
    for (const node of box.querySelectorAll("[data-st]")) c[node.dataset.st] = node;
    this._check = c;
    c.run.addEventListener("click", () => this.emit("selftest", { phase: "prepare" }));
    c.vr.addEventListener("click", () => this.emit("selftest", { phase: "vr" }));
    c.copy.addEventListener("click", () => this._copyReport());
  }

  // rows: [{ name, status: "pass" | "fail" | "warn" | "skip", detail }] (selftest.js summarize).
  // canStartVR shows "Start VR test"; saved: path string or true once the laptop stored the report;
  // report: the object "Copy report" copies as JSON.
  showSelfTest(rows, { canStartVR = false, saved = null, report = null } = {}) {
    const c = this._check;
    if (!c) return;
    const list = Array.isArray(rows) ? rows : [];
    const count = (status) => list.filter((row) => row.status === status).length;
    const fails = count("fail");
    const warns = count("warn");
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const vrDone = !!report?.xr?.sessionStarted;
    c.head.textContent = (fails || warns ? [fails && plural(fails, "problem"), warns && plural(warns, "warning")].filter(Boolean).join(", ") + "." : "All checks passed.") +
      (canStartVR && !vrDone ? " Next: Start VR test." : "");
    c.head.dataset.status = fails ? "fail" : warns ? "warn" : "pass";
    c.rows.replaceChildren(...list.map((row) => {
      const status = CHECK_WORD[row.status] ? row.status : "skip";
      const li = document.createElement("li");
      li.className = `tr-ck tr-ck-${status}`;
      const icon = span("tr-ck-icon", CHECK_ICON[status]);
      icon.setAttribute("aria-hidden", "true");
      const text = document.createElement("div");
      text.append(span("tr-selftest-sr", `${CHECK_WORD[status]}: `), span("tr-ck-name", row.name || ""), span("tr-ck-detail", row.detail || ""));
      li.append(icon, text);
      return li;
    }));
    c.saved.hidden = !saved;
    c.saved.textContent = typeof saved === "string" ? `Report saved on the laptop: ${saved}` : saved ? "Report saved on the laptop." : "";
    c.vr.hidden = !canStartVR;
    c.vr.textContent = vrDone ? "Run VR test again" : "Start VR test";
    this._checkReport = report;
    c.copy.disabled = !report;
    c.text.hidden = true;
    c.result.hidden = false;
    this.setSelfTestBusy(null);
    c.head.focus({ preventScroll: false });
  }

  // text: progress line while a check runs (buttons disabled); null when it is done.
  setSelfTestBusy(text) {
    const c = this._check;
    if (!c) return;
    this._checkBusy = !!text;
    c.busy.hidden = !text;
    c.busy.textContent = text || "";
    c.vr.disabled = this._checkBusy;
    this._syncLaunchButtons();
  }

  async _copyReport() {
    const c = this._check;
    if (!this._checkReport) return;
    const json = JSON.stringify(this._checkReport, null, 2);
    c.text.value = json;
    let copied = false;
    try {
      await navigator.clipboard.writeText(json);
      copied = true;
    } catch {
      // No async clipboard (http page, older browser): copy from the textarea instead.
      c.text.hidden = false;
      c.text.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
    }
    if (copied) {
      c.text.hidden = true;
      this.toast("Report copied.");
    } else {
      c.text.hidden = false;
      c.text.focus();
      c.text.select();
      this.toast("Copy the selected report text.", "warn");
    }
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
    if (this._check) this._check.run.disabled = !ready || this._checkBusy;
  }

  _setLaunchVisible(visible) {
    this._launchVisible = visible;
    this.launch.root.hidden = !visible;
    this.app.hidden = visible;
    document.body.classList.toggle("tr-in-launch", visible);
    document.body.classList.toggle("tr-playing", !visible);
    if (visible) {
      this._closeDrawer(false);
      this.closeSketch(false);
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
      this._wireSketch();
    }
    if (r.marker) {
      r.marker.addEventListener("click", () => {
        const on = !this._marker.on;
        this.setMarker({ on });
        this.emit("marker", on);
      });
      r.markerBar.addEventListener("click", (event) => {
        const b = event.target.closest("button");
        if (!b || b.disabled) return;
        if (b.dataset.color) {
          this.setMarker({ color: b.dataset.color });
          this.emit("marker-color", b.dataset.color);
        } else if (b.dataset.mk) {
          this.emit(b.dataset.mk);
        }
      });
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
    if (this._sk.open) {
      // The pad is modal: Escape cancels, Ctrl/Cmd+Z takes back a stroke, nothing reaches the game.
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeSketch();
      } else if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === "z") {
        event.preventDefault();
        this._skUndo();
      }
      return;
    }
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

  // Magic marker state: on = desktop marker mode (toolbar shown), color = ink (also the phone pad's).
  // Clicks render right away; main.js calling setMarker() afterwards is the truth.
  setMarker({ on = this._marker.on, color = this._marker.color } = {}) {
    const hex = /^#[0-9a-f]{6}$/i.test(color || "") ? color.toLowerCase() : this._marker.color;
    this._marker = { on: !!on, color: hex };
    const r = this.refs;
    const marking = this._marker.on && this.layout === "desktop";
    document.body.classList.toggle("tr-marking", marking);
    if (r.marker) {
      r.marker.setAttribute("aria-pressed", String(marking));
      r.marker.style.setProperty("--ink", hex);
      r.markerBar.hidden = !marking;
      r.keys.textContent = marking ? KEYS_MARKER : KEYS_TEXT;
    }
    for (const b of this.app.querySelectorAll("[data-color], [data-pcolor]")) b.setAttribute("aria-pressed", String((b.dataset.color || b.dataset.pcolor) === hex));
  }

  // A drawing is near enough to make real, guess or erase.
  setDrawingAvailable(available) {
    this._drawingAvailable = !!available;
    for (const b of this.app.querySelectorAll('[data-mk="realize"], [data-mk="guess"], [data-mk="erase"]')) b.disabled = !this._drawingAvailable;
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

  // ---------- sketch pad (phone) ----------

  _wireSketch() {
    const r = this.refs;
    this._skDrawCb = () => this._skDraw();
    r.draw.addEventListener("click", () => this.openSketch());
    r.sketch.addEventListener("click", (event) => {
      const b = event.target.closest("button");
      if (!b || b.disabled) return;
      const act = b.dataset.sk;
      if (b.dataset.pcolor) this.setMarker({ color: b.dataset.pcolor });
      else if (act === "cancel") this.closeSketch();
      else if (act === "undo") this._skUndo();
      else if (act === "clear") this._skClear();
      else if (act === "send" || act === "real") this._skSend(act === "real");
    });
    r.pad.addEventListener("pointerdown", (event) => this._skDown(event));
    r.pad.addEventListener("pointermove", (event) => this._skMove(event));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) r.pad.addEventListener(type, (event) => this._skUp(event));
    r.pad.addEventListener("contextmenu", (event) => event.preventDefault());
    // touch-action: none stops panning; these also stop iOS pinch and rubber-band scrolling.
    const block = (event) => event.cancelable && event.preventDefault();
    r.sketch.addEventListener("touchmove", block, { passive: false });
    r.sketch.addEventListener("gesturestart", block);
    if (typeof ResizeObserver === "function") new ResizeObserver(() => this._skLayout()).observe(r.paper);
    else window.addEventListener("resize", () => this._skLayout());
  }

  // Opens the phone sketch pad. Unsent strokes come back until they are sent or cleared.
  openSketch() {
    const r = this.refs;
    const sk = this._sk;
    if (!r.sketch || sk.open || this._launchVisible) return false;
    this._closeDrawer(false);
    this._talkEnd();
    sk.open = true;
    r.sketch.hidden = false;
    r.panel.inert = true;
    this.app.querySelector(".tr-top").inert = true;
    document.body.classList.add("tr-sketching");
    this._skLayout();
    this._skSync();
    r.sketch.focus({ preventScroll: true });
    return true;
  }

  closeSketch(restoreFocus = true) {
    const r = this.refs;
    const sk = this._sk;
    if (!sk.open) return;
    sk.open = false;
    sk.cur = null;
    cancelAnimationFrame(sk.raf);
    sk.raf = 0;
    r.sketch.hidden = true;
    r.panel.inert = false;
    this.app.querySelector(".tr-top").inert = false;
    document.body.classList.remove("tr-sketching");
    // Give the canvas memory back while playing; the strokes stay as data.
    r.pad.width = r.pad.height = 1;
    if (sk.base) sk.base.width = sk.base.height = 1;
    if (restoreFocus) r.draw.focus({ preventScroll: true });
  }

  // Sizes the canvas to its box at device resolution. The frame keeps the size the drawing started
  // at, so turning the phone letterboxes the strokes instead of stretching them.
  _skLayout() {
    const sk = this._sk;
    if (!sk.open) return;
    const rect = this.refs.paper.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w < 2 || h < 2) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const pad = this.refs.pad;
    sk.dpr = dpr;
    sk.rect = rect;
    sk.base ||= document.createElement("canvas");
    for (const c of [pad, sk.base]) {
      if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
      if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
    }
    if (!sk.frame || (!sk.strokes.length && !sk.cur && !sk.cleared)) {
      sk.frame = { w, h };
      sk.lineW = clamp(Math.min(w, h) * 0.016, 4, 9);
    }
    const s = Math.min(w / sk.frame.w, h / sk.frame.h);
    sk.view = { s, ox: (w - sk.frame.w * s) / 2, oy: (h - sk.frame.h * s) / 2 };
    this._skRebuild();
    this._skDraw();
  }

  // Frame pixels → canvas pixels.
  _skTransform(ctx) {
    const { dpr, view } = this._sk;
    ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, dpr * view.ox, dpr * view.oy);
  }

  // Base layer: paper and finished strokes. The live stroke is drawn over a copy of it each frame.
  _skRebuild() {
    const sk = this._sk;
    const ctx = sk.base.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = SKETCH_OUTSIDE;
    ctx.fillRect(0, 0, sk.base.width, sk.base.height);
    this._skTransform(ctx);
    const { w, h } = sk.frame;
    ctx.fillStyle = SKETCH_PAPER;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(16, 20, 18, 0.14)";
    for (let y = 12; y < h; y += 24) for (let x = 12; x < w; x += 24) ctx.fillRect(x - 1, y - 1, 2, 2);
    for (const stroke of sk.strokes) inkStroke(ctx, stroke, sk.lineW);
  }

  _skQueue() {
    if (!this._sk.raf) this._sk.raf = requestAnimationFrame(this._skDrawCb);
  }

  _skDraw() {
    const sk = this._sk;
    sk.raf = 0;
    if (!sk.open || !sk.base) return;
    const ctx = this.refs.pad.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(sk.base, 0, 0);
    if (sk.cur) {
      this._skTransform(ctx);
      inkStroke(ctx, sk.cur, sk.lineW);
    }
  }

  _skDown(event) {
    const sk = this._sk;
    if (!sk.open || sk.cur || !event.isPrimary || event.button > 0) return;
    event.preventDefault();
    if (sk.points >= SKETCH_MAX_POINTS) {
      this.toast("That’s a lot of ink. Send it, or undo a stroke.", "warn");
      return;
    }
    try {
      this.refs.pad.setPointerCapture(event.pointerId);
    } catch {
      // Capture is optional.
    }
    sk.rect = this.refs.pad.getBoundingClientRect();
    const c = this._marker.color;
    sk.cur = { c, light: isLight(c), pts: [], id: event.pointerId };
    this._skAdd(event);
    this.refs.sketch.classList.add("tr-has-ink");
    this._skQueue();
  }

  _skMove(event) {
    const cur = this._sk.cur;
    if (!cur || event.pointerId !== cur.id) return;
    const list = event.getCoalescedEvents?.();
    if (list?.length) for (const e of list) this._skAdd(e);
    else this._skAdd(event);
    this._skQueue();
  }

  _skUp(event) {
    const sk = this._sk;
    const cur = sk.cur;
    if (!cur || event.pointerId !== cur.id) return;
    if (event.type === "pointerup") this._skAdd(event);
    sk.cur = null;
    const p = cur.pts;
    if (p.length === 2) {
      p.push(p[0] + 0.5, p[1]); // a tap leaves a dot
      sk.points += 1;
    }
    sk.strokes.push({ c: cur.c, light: cur.light, pts: p });
    sk.cleared = null;
    const ctx = sk.base.getContext("2d");
    this._skTransform(ctx);
    inkStroke(ctx, sk.strokes[sk.strokes.length - 1], sk.lineW);
    this._skQueue();
    this._skSync();
  }

  // Adds a pointer position (frame pixels) to the live stroke, skipping jitter under 1.5 px.
  _skAdd(event) {
    const sk = this._sk;
    const { rect, view, frame } = sk;
    const x = clamp((event.clientX - rect.left - view.ox) / view.s, 0, frame.w);
    const y = clamp((event.clientY - rect.top - view.oy) / view.s, 0, frame.h);
    const p = sk.cur.pts;
    const n = p.length;
    if (n) {
      const dx = x - p[n - 2];
      const dy = y - p[n - 1];
      if (dx * dx + dy * dy < SKETCH_MIN_STEP2) return;
    }
    if (sk.points >= SKETCH_MAX_POINTS) return;
    p.push(x, y);
    sk.points += 1;
  }

  _skUndo() {
    const sk = this._sk;
    if (sk.cur) return;
    if (sk.strokes.length) {
      sk.points -= sk.strokes.pop().pts.length / 2;
    } else if (sk.cleared) {
      // Undo right after Clear brings the whole drawing back.
      sk.strokes = sk.cleared;
      sk.cleared = null;
      sk.points = sk.strokes.reduce((n, st) => n + st.pts.length / 2, 0);
    } else {
      return;
    }
    this._skRefresh();
  }

  _skClear() {
    const sk = this._sk;
    if (!sk.strokes.length || sk.cur) return;
    sk.cleared = sk.strokes;
    sk.strokes = [];
    sk.points = 0;
    this._skRefresh();
  }

  _skRefresh() {
    if (this._sk.open) {
      this._skRebuild();
      this._skQueue();
    }
    this._skSync();
  }

  _skSync() {
    const sk = this._sk;
    const has = sk.strokes.length > 0;
    this.refs.sketch.classList.toggle("tr-has-ink", has || !!sk.cur);
    for (const b of this.refs.sketch.querySelectorAll("[data-sk]")) {
      const act = b.dataset.sk;
      if (act === "undo") b.disabled = !has && !sk.cleared;
      else if (act !== "cancel") b.disabled = !has;
    }
  }

  // Normalized lines (0..1 of the frame, y down) with the frame aspect, then close the pad.
  _skSend(realize) {
    const sk = this._sk;
    if (!sk.strokes.length || sk.cur) return;
    const { w, h } = sk.frame;
    const lines = sk.strokes.map((st) => {
      const line = [];
      for (let i = 0; i < st.pts.length; i += 2) line.push([r4(clamp(st.pts[i] / w, 0, 1)), r4(clamp(st.pts[i + 1] / h, 0, 1))]);
      return line;
    });
    const colors = sk.strokes.map((st) => st.c);
    const sketch = { lines, aspect: Math.round((w / h) * 1000) / 1000, color: colors[0], colors, realize: !!realize };
    sk.strokes = [];
    sk.cleared = null;
    sk.points = 0;
    this.closeSketch();
    this.emit("sketch", sketch);
  }

  // ---------- rendering ----------

  _markDirty(tab) {
    this._dirty.add(tab);
    if (this._visible(tab)) this._renderTab(tab);
  }

  _renderSettings() {
    const pane = this.app.querySelector('[data-pane="settings"]');
    for (const input of pane.querySelectorAll("[data-set]")) input.checked = !!this._settings[input.dataset.set];
    if (this.launch?.kingdom) this.launch.kingdom.checked = !!this._settings.kingdom;
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
  if (typeof s.kingdom === "boolean") out.kingdom = s.kingdom;
  return out;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const r4 = (n) => Math.round(n * 1e4) / 1e4;

function isLight(hex) {
  const v = parseInt(String(hex).slice(1), 16);
  return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255) > 200;
}

// Smooth ink through the points (quadratic curves between midpoints); light inks get a dark rim so
// they show on the paper.
function inkStroke(ctx, stroke, width) {
  const p = stroke.pts;
  const n = p.length >> 1;
  if (!n) return;
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  for (let i = 1; i < n - 1; i++) {
    const x = p[i * 2];
    const y = p[i * 2 + 1];
    ctx.quadraticCurveTo(x, y, (x + p[i * 2 + 2]) / 2, (y + p[i * 2 + 3]) / 2);
  }
  ctx.lineTo(p[n * 2 - 2], p[n * 2 - 1]);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (stroke.light) {
    ctx.strokeStyle = "rgba(16, 20, 18, 0.55)";
    ctx.lineWidth = width + 3;
    ctx.stroke();
  }
  ctx.strokeStyle = stroke.c;
  ctx.lineWidth = width;
  ctx.stroke();
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
