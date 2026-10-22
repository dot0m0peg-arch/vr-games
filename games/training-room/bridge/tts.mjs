// Text to speech through a local server, so the AI's replies play with a laptop voice on every
// device (Quest Browser may have no speechSynthesis voice). Kinds: "piper" (piper1-gpl HTTP
// server: POST / with JSON { text } → WAV) or "openai" (Kokoro-FastAPI, speaches or any
// OpenAI-compatible /v1/audio/speech URL). Requests are serialized: one voice at a time.

export const TTS_KINDS = ["none", "piper", "openai"];
export const TTS_URLS = { piper: "http://127.0.0.1:5000", openai: "http://127.0.0.1:8880/v1/audio/speech" };
export const MAX_TTS_TEXT = 400;
const PROBE_MS = 60000;
const MAX_AUDIO = 16 * 1024 * 1024;

const trimSlash = (url) => String(url || "").replace(/\/+$/, "");

// Spoken text: no control characters, single spaces, at most MAX_TTS_TEXT characters.
export function cleanSpeech(text) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TTS_TEXT).trimEnd();
}

export class TextToSpeech {
  constructor(config = {}, { log = console, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    this.log = log;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.timer = null;
    this.queue = Promise.resolve();
    this.configure(config);
  }

  configure(config) {
    this.kind = TTS_KINDS.includes(config.ttsKind) ? config.ttsKind : "none";
    this.url = this.kind === "none" ? null : trimSlash(config.ttsUrl || TTS_URLS[this.kind]);
    this.voice = String(config.ttsVoice || "af_heart");
    this.model = String(config.ttsModel || "kokoro");
    this.piperTarget = null; // the piper URL that answered last time
    this.available = false;
    this.lastProbe = 0;
    this.detail = "";
  }

  status() {
    return { available: this.available, kind: this.kind, url: this.url, detail: this.detail || undefined };
  }

  // GET the server's root; any HTTP response means it is up.
  async probe() {
    this.lastProbe = Date.now();
    if (this.kind === "none") {
      this.available = false;
      this.detail = "the laptop voice is off (ttsKind: none)";
      return false;
    }
    try {
      const res = await this.fetch(new URL("/", this.url).href, { signal: AbortSignal.timeout(2500) });
      await res.arrayBuffer().catch(() => {});
      this.available = true;
      this.detail = "";
    } catch (err) {
      this.available = false;
      this.detail = `not reachable at ${this.url} (${err.cause?.code || err.name || err.message})`;
    }
    return this.available;
  }

  start() {
    this.timer = setInterval(() => this.probe().catch(() => {}), PROBE_MS);
    this.timer.unref?.();
    return this.probe();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // → { audio: Buffer, type, ms }. Throws errors with .status/.body:
  // 503 no-tts (off or unreachable), 504 tts-timeout, 502 tts-failed, 400 no-text, 499 aborted.
  synthesize(text, { signal } = {}) {
    const run = this.queue.then(() => this.synthesizeNow(text, signal));
    this.queue = run.catch(() => {});
    return run;
  }

  async synthesizeNow(text, signal) {
    const line = cleanSpeech(text);
    if (!line) throw httpError(400, { error: "no-text" });
    if (signal?.aborted) throw httpError(499, { error: "aborted" });
    if (this.kind !== "none" && !this.available && Date.now() - this.lastProbe > 3000) await this.probe();
    if (!this.available) throw httpError(503, { error: "no-tts", detail: this.detail || `the laptop voice is not available (${this.kind})` });
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const post = (url, body) => this.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: combined });
    let res;
    try {
      if (this.kind === "openai") {
        res = await post(this.url, { model: this.model, input: line, voice: this.voice, response_format: "wav" });
      } else {
        // piper1-gpl answers POST /; other piper HTTP wrappers use /synthesize.
        const targets = this.piperTarget ? [this.piperTarget] : /\/synthesize$/i.test(this.url) ? [this.url] : [`${this.url}/`, `${this.url}/synthesize`];
        for (let i = 0; i < targets.length; i++) {
          res = await post(targets[i], { text: line });
          const missing = res.status === 404 || res.status === 405;
          if (!missing || i === targets.length - 1) {
            this.piperTarget = res.ok ? targets[i] : missing ? null : this.piperTarget;
            break;
          }
          await res.arrayBuffer().catch(() => {});
        }
      }
    } catch (err) {
      if (timeout.aborted) throw httpError(504, { error: "tts-timeout", detail: `no audio from ${this.url} within ${this.timeoutMs / 1000} s` });
      if (signal?.aborted) throw httpError(499, { error: "aborted" });
      this.available = false;
      this.detail = `not reachable at ${this.url} (${err.cause?.code || err.message})`;
      throw httpError(503, { error: "no-tts", detail: this.detail });
    }
    let audio;
    try {
      audio = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (timeout.aborted) throw httpError(504, { error: "tts-timeout", detail: `no audio from ${this.url} within ${this.timeoutMs / 1000} s` });
      if (signal?.aborted) throw httpError(499, { error: "aborted" });
      throw httpError(502, { error: "tts-failed", detail: err.message });
    }
    if (!res.ok) throw httpError(502, { error: "tts-failed", detail: `${res.status} ${audio.toString("utf8", 0, 300)}` });
    let type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!type || type === "application/octet-stream") type = audio.toString("ascii", 0, 4) === "RIFF" ? "audio/wav" : "audio/mpeg";
    if (!audio.length || audio.length > MAX_AUDIO || !/^audio\//.test(type)) {
      throw httpError(502, { error: "tts-failed", detail: `expected audio, got ${type || "nothing"} (${audio.length} bytes): ${audio.toString("utf8", 0, 160)}` });
    }
    return { audio, type, ms: Date.now() - started };
  }
}

function httpError(status, body) {
  const err = new Error(body.error);
  err.status = status;
  err.body = body;
  return err;
}
