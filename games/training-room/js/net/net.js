// Laptop bridge client: shared room (join + server-sent events), ops, poses, model commands,
// Whisper transcription, parts bin and shared screen frames. See ARCHITECTURE.md "Bridge HTTP API".
// Events: op, state, users, poses, fx, share, say, parts, rejoined, status
// ("connecting" | "online" | "offline" | "auth").
import { Emitter } from "../util/emitter.js";

const TIMEOUTS = { request: 8000, command: 30000, transcribe: 30000, probe: 2500, offline: 10000 };
const POSE_MS = 1000 / 15;
const SSE_EVENTS = ["op", "state", "users", "poses", "fx", "share", "say", "parts"];
const CLOSED = 2; // EventSource.CLOSED

function netError(code, message, status = 0, body = null) {
  const err = new Error(message || code);
  err.code = code;
  err.status = status;
  err.body = body;
  return err;
}

function codeForStatus(status, body) {
  if (typeof body?.error === "string" && body.error) return body.error;
  if (status === 401) return "auth";
  if (status === 410) return "gone";
  if (status === 404) return "not-found";
  if (status === 504) return "timeout";
  return `http-${status}`;
}

const defaultFetch = () => (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);

// One HTTP call with timeout → { status, headers, body (parsed JSON | text | null) }.
async function call(fetchImpl, url, { method = "GET", key = null, json, body, type, timeout = TIMEOUTS.request, keepalive = false } = {}) {
  if (!fetchImpl) throw netError("offline", "fetch is not available");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const headers = {};
  if (key) headers["x-room-key"] = key;
  let payload;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(json);
  } else if (body !== undefined && body !== null) {
    headers["content-type"] = type || body.type || "application/octet-stream";
    payload = body;
  }
  try {
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body: payload, credentials: "include", signal: controller.signal, keepalive });
    } catch (err) {
      if (controller.signal.aborted) throw netError("timeout", `No answer from the laptop within ${Math.round(timeout / 1000)} s.`);
      throw netError("offline", `Can't reach the laptop bridge (${err?.message || err}).`);
    }
    let text = "";
    try {
      text = await res.text(); // always drain (also 204) so the connection is released
    } catch (err) {
      if (controller.signal.aborted) throw netError("timeout", `The laptop stopped answering after ${Math.round(timeout / 1000)} s.`);
      throw netError("offline", `The connection to the laptop dropped (${err?.message || err}).`);
    }
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, ok: res.ok, headers: res.headers, body: parsed, json: !!text && typeof parsed === "object" };
  } finally {
    clearTimeout(timer);
  }
}

export class Net extends Emitter {
  // base: absolute API base URL ending in "/" (e.g. new URL("api/", location.href).href).
  // key: room key sent as x-room-key (and ?k= on event streams) when the cookie is not enough.
  constructor({ base, key = null, EventSourceImpl = globalThis.EventSource, fetchImpl = null, timeouts = {} } = {}) {
    super();
    if (!base) throw new Error("Net needs the bridge API base URL");
    this.base = String(base).endsWith("/") ? String(base) : `${base}/`;
    this.key = key || null;
    this.timeouts = { ...TIMEOUTS, ...timeouts };
    this._fetch = fetchImpl || defaultFetch();
    this._ES = EventSourceImpl || null;
    this._user = null;
    this._profile = null; // { name, device, color } for re-joins
    this._users = [];
    this._seq = 0;
    this._status = "offline";
    this._left = false;
    this._es = null;
    this._errorSince = 0;
    this._offlineTimer = 0;
    this._recoverTimer = 0;
    this._recoverTries = 0;
    this._rejoining = null;
    this._pose = null;
    this._poseBusy = false;
    this._poseAt = -Infinity;
    this._poseTimer = 0;
  }

  // GET base/hello with a short timeout. Never throws. → { bridge, auth, info }
  static async probe(base, key = null, { fetchImpl = null, timeout = TIMEOUTS.probe } = {}) {
    const root = String(base).endsWith("/") ? String(base) : `${base}/`;
    try {
      const res = await call(fetchImpl || defaultFetch(), `${root}hello`, { key, timeout });
      const info = res.json ? res.body : null;
      if (!res.ok || !info || info.bridge !== true) return { bridge: false, auth: false, info: null };
      return { bridge: true, auth: !!info.auth, info };
    } catch {
      return { bridge: false, auth: false, info: null };
    }
  }

  get user() {
    return this._user;
  }

  get users() {
    return this._users;
  }

  get seq() {
    return this._seq;
  }

  get status() {
    return this._status;
  }

  // Joined and not left. Stays true through short network drops (status tells "online"/"offline").
  get connected() {
    return !!this._user && !this._left;
  }

  get online() {
    return this.connected && this._status === "online";
  }

  async join({ name, device, color } = {}) {
    if (this._left) throw netError("left", "This connection was closed; create a new Net.");
    this._profile = { name, device, color };
    this._setStatus("connecting");
    let result;
    try {
      result = await this._json("join", { method: "POST", json: { name, device, color } });
    } catch (err) {
      this._setStatus(err.code === "auth" ? "auth" : "offline");
      throw err;
    }
    this._accept(result);
    this._openEvents();
    return result;
  }

  // ---------- room traffic ----------

  // → { seq }. A 410 (the bridge forgot us: restart or timeout) re-joins once and retries.
  async sendOp(op) {
    const id = this._requireUser();
    try {
      return await this._json("op", { method: "POST", json: { user: id, op } });
    } catch (err) {
      if (err.status !== 410 || this._left) throw err;
      await this._gone(id);
      return this._json("op", { method: "POST", json: { user: this._requireUser(), op } });
    }
  }

  // Latest pose wins; at most 15 per second and one request in flight.
  sendPose(pose) {
    if (!this.connected) return;
    this._pose = pose;
    if (this._poseBusy || this._poseTimer) return;
    const wait = this._poseAt + POSE_MS - Date.now();
    if (wait > 0) {
      this._poseTimer = setTimeout(() => {
        this._poseTimer = 0;
        this._flushPose();
      }, wait);
      return;
    }
    this._flushPose();
  }

  _flushPose() {
    const pose = this._pose;
    if (!pose || !this.connected || this._poseBusy) return;
    const id = this._user.id;
    this._pose = null;
    this._poseBusy = true;
    this._poseAt = Date.now();
    this._send("pose", { method: "POST", json: { user: id, pose }, timeout: 4000 })
      .catch((err) => {
        if (err.status === 410) this._gone(id).catch(() => {});
      })
      .finally(() => {
        this._poseBusy = false;
        if (this._pose) this.sendPose(this._pose);
      });
  }

  // Fire-and-forget helpers resolve to true/false and never reject.
  sendFx(fx) {
    return this._fire("fx", { fx });
  }

  sendSay(text) {
    return this._fire("say", { text: String(text ?? "").slice(0, 500) });
  }

  async _fire(route, extra) {
    if (!this.connected) return false;
    const id = this._user.id;
    try {
      await this._send(route, { method: "POST", json: { user: id, ...extra } });
      return true;
    } catch (err) {
      if (err.status === 410) this._gone(id).catch(() => {});
      else console.warn(`[net] ${route} failed:`, err.message);
      return false;
    }
  }

  // ---------- model, speech, parts ----------

  // → { intents, say, source, model, ms }. Errors carry .code: no-model | bad-output | timeout | offline | auth …
  async command(text, ctx = {}) {
    const result = await this._json("command", {
      method: "POST",
      json: { user: this._user?.id || null, text, ctx },
      timeout: this.timeouts.command,
    });
    if (!result || typeof result !== "object" || !Array.isArray(result.intents)) throw netError("bad-output", "The local model answered with something that is not a command.");
    return result;
  }

  // blob: audio/wav → { text, ms }
  async transcribe(blob) {
    const result = await this._json("transcribe", { method: "POST", body: blob, type: "audio/wav", timeout: this.timeouts.transcribe });
    return { ...result, text: typeof result?.text === "string" ? result.text : "" };
  }

  async parts() {
    const manifest = await this._json("parts");
    return manifest && Array.isArray(manifest.parts) ? manifest : { parts: [] };
  }

  async saveBlueprint(blueprint) {
    return this._json("parts/save", { method: "POST", json: { blueprint } });
  }

  // ---------- shared screen / camera frames ----------

  async postFrame(stream, blob) {
    const id = this._requireUser();
    try {
      await this._send(`share/${encodeURIComponent(stream)}?user=${encodeURIComponent(id)}`, { method: "POST", body: blob, type: blob?.type || "image/jpeg" });
      return true;
    } catch (err) {
      if (err.status === 410) this._gone(id).catch(() => {});
      throw err;
    }
  }

  frameUrl(stream, n = 0) {
    const key = this.key ? `&k=${encodeURIComponent(this.key)}` : "";
    return `${this.base}share/${encodeURIComponent(stream)}?n=${encodeURIComponent(n)}${key}`;
  }

  async stopShare(stream) {
    await this._send(`share/${encodeURIComponent(stream)}/stop`, { method: "POST", json: { user: this._user?.id || null } });
    return true;
  }

  // Leaves the room (works from pagehide via sendBeacon) and closes the event stream.
  leave() {
    if (this._left) return;
    this._left = true;
    this._closeEvents();
    clearTimeout(this._offlineTimer);
    clearTimeout(this._recoverTimer);
    clearTimeout(this._poseTimer);
    this._pose = null;
    const user = this._user;
    if (!user) return;
    const url = `${this.base}leave${this.key ? `?k=${encodeURIComponent(this.key)}` : ""}`;
    const body = JSON.stringify({ user: user.id });
    let sent = false;
    try {
      // text/plain keeps the beacon a "simple" request (no CORS preflight); the bridge reads JSON anyway.
      const beacon = globalThis.navigator?.sendBeacon;
      if (typeof beacon === "function") sent = beacon.call(globalThis.navigator, url, new Blob([body], { type: "text/plain;charset=UTF-8" }));
    } catch {
      sent = false;
    }
    if (!sent && this._fetch) {
      this._fetch(url, { method: "POST", body, credentials: "include", keepalive: true, headers: { "content-type": "text/plain;charset=UTF-8" } }).catch(() => {});
    }
  }

  // ---------- internals ----------

  _requireUser() {
    if (!this.connected) throw netError("offline", "Not connected to the laptop bridge.");
    return this._user.id;
  }

  async _send(route, options = {}) {
    const res = await call(this._fetch, this.base + route, { key: this.key, timeout: this.timeouts.request, ...options });
    if (!res.ok) {
      const code = codeForStatus(res.status, res.json ? res.body : null);
      if (res.status === 401) this._setStatus("auth");
      const detail = res.json && (res.body.detail || res.body.error);
      throw netError(code, `The laptop bridge answered ${res.status}${detail ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}.`, res.status, res.json ? res.body : null);
    }
    return res;
  }

  async _json(route, options = {}) {
    const res = await this._send(route, options);
    if (res.status === 204) return {};
    if (!res.json) throw netError("bad-output", `The laptop bridge sent an unexpected answer for ${route}.`, res.status);
    return res.body;
  }

  _accept(result) {
    if (!result?.user?.id) throw netError("bad-output", "The laptop bridge did not return a user.");
    this._user = result.user;
    this._users = Array.isArray(result.users) ? result.users : [];
    this._seq = Number.isInteger(result.seq) ? result.seq : 0;
    this._recoverTries = 0;
  }

  // The bridge does not know user `id` any more. Re-join unless that already happened.
  _gone(id) {
    if (this._user && this._user.id !== id) return Promise.resolve(); // already re-joined
    return this._rejoin();
  }

  _rejoin() {
    if (this._rejoining) return this._rejoining;
    this._rejoining = (async () => {
      const old = this._user;
      this._closeEvents();
      this._setStatus("connecting");
      if (old) this._send("leave", { method: "POST", json: { user: old.id }, timeout: 3000 }).catch(() => {});
      const profile = { ...(this._profile || {}), color: old?.color || this._profile?.color };
      let result;
      try {
        result = await this._json("join", { method: "POST", json: profile });
      } catch (err) {
        // Keep trying in the background (the event stream is closed until a join works).
        if (!this._left) {
          this._armOffline();
          this._scheduleRecover();
        }
        throw err;
      }
      if (this._left) return result;
      this._accept(result);
      this._openEvents();
      this.emit("rejoined", result);
      this.emit("users", this._users);
      return result;
    })().finally(() => {
      this._rejoining = null;
    });
    return this._rejoining;
  }

  _setStatus(status) {
    if (this._status === status) return;
    this._status = status;
    this.emit("status", status);
  }

  _openEvents() {
    this._closeEvents();
    if (this._left || !this._user) return;
    if (!this._ES) {
      console.warn("[net] EventSource is not available; live updates are off");
      return;
    }
    let url = `${this.base}events?user=${encodeURIComponent(this._user.id)}`;
    if (this.key) url += `&k=${encodeURIComponent(this.key)}`;
    if (this._seq) url += `&since=${this._seq}`;
    const es = new this._ES(url, { withCredentials: true });
    this._es = es;
    es.onopen = () => {
      if (this._es !== es) return;
      this._errorSince = 0;
      clearTimeout(this._offlineTimer);
      this._recoverTries = 0;
      this._setStatus("online");
    };
    es.onerror = () => {
      if (this._es === es) this._eventsError(es);
    };
    for (const type of SSE_EVENTS) es.addEventListener(type, (event) => this._onEvent(es, type, event));
    this._armOffline(); // cleared by onopen
  }

  _closeEvents() {
    const es = this._es;
    this._es = null;
    if (es) {
      es.onopen = es.onerror = null;
      try {
        es.close();
      } catch {
        // Already closed.
      }
    }
  }

  _onEvent(es, type, event) {
    if (this._es !== es) return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (type === "op" || type === "state") {
      if (Number.isInteger(data?.seq) && (type === "state" || data.seq > this._seq)) this._seq = data.seq;
    } else if (type === "users") {
      if (Array.isArray(data)) this._users = data;
    }
    this.emit(type, data);
  }

  // After `offline` ms of errors without a working stream, report "offline".
  _armOffline() {
    this._errorSince = this._errorSince || Date.now();
    clearTimeout(this._offlineTimer);
    const wait = Math.max(0, this._errorSince + this.timeouts.offline - Date.now());
    this._offlineTimer = setTimeout(() => {
      if (this._errorSince && !this._left && this._status !== "auth") this._setStatus("offline");
    }, wait);
  }

  _eventsError(es) {
    if (!this._errorSince) this._armOffline();
    if (es.readyState !== CLOSED) return; // the browser reconnects by itself (Last-Event-ID)
    // The bridge refused the stream: unknown user (laptop restarted or we slept), bad key, or an error page.
    this._closeEvents();
    this._scheduleRecover();
  }

  _scheduleRecover() {
    if (this._recoverTimer || this._left) return;
    const delay = Math.min(15000, 500 * 2 ** this._recoverTries);
    this._recoverTimer = setTimeout(() => {
      this._recoverTimer = 0;
      this._recoverTries++;
      this._recover();
    }, delay);
  }

  async _recover() {
    if (this._left) return;
    const probe = await Net.probe(this.base, this.key, { fetchImpl: this._fetch, timeout: this.timeouts.probe });
    if (this._left || this._es) return;
    if (!probe.bridge) {
      this._scheduleRecover();
      return;
    }
    if (!probe.auth) {
      this._setStatus("auth");
      this._scheduleRecover();
      return;
    }
    try {
      await this._rejoin();
    } catch (err) {
      if (err.code === "auth") this._setStatus("auth");
      if (!this._es) this._scheduleRecover();
    }
  }
}
