// Speech to text through a local server: whisper.cpp's whisper-server (/inference) or any
// OpenAI-compatible /v1/audio/transcriptions endpoint. Requests are serialized because
// whisper-server handles one at a time.

const PROBE_MS = 60000;
const TIMEOUT_MS = 30000;
// Whole-transcript hallucinations Whisper produces for silence or noise.
const HALLUCINATIONS = new Set(["you", "thank you", "thanks for watching", "thank you for watching", "bye", "subtitles by the amara org community", "please subscribe"]);

// Removes "[BLANK_AUDIO]", "(music)", "*coughs*" style tags and collapses whitespace.
export function cleanTranscript(text, prompt = "") {
  let out = String(text || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\*[^*]*\*/g, " ")
    .replace(/[♪♫]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bare = out.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  if (!bare || HALLUCINATIONS.has(bare)) return "";
  // Whisper sometimes echoes the biasing prompt for silent clips.
  const promptBare = String(prompt || "").toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  if (promptBare && bare === promptBare) return "";
  return out;
}

export function isWav(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 44 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE";
}

export class SpeechToText {
  constructor(config = {}, { log = console, fetchImpl = globalThis.fetch } = {}) {
    this.log = log;
    this.fetch = fetchImpl;
    this.configure(config);
    this.available = false;
    this.lastProbe = 0;
    this.detail = "";
    this.timer = null;
    this.queue = Promise.resolve();
  }

  configure(config) {
    this.kind = ["whisper.cpp", "openai", "none"].includes(config.sttKind) ? config.sttKind : "whisper.cpp";
    this.url = String(config.sttUrl || "http://127.0.0.1:8080/inference");
    this.model = String(config.sttModel || "whisper-1");
    this.language = config.sttLanguage === undefined ? "en" : String(config.sttLanguage || "");
    this.prompt = String(config.sttPrompt || "");
  }

  status() {
    return { available: this.available, kind: this.kind, url: this.kind === "none" ? null : this.url, detail: this.detail || undefined };
  }

  // GET the server's base URL; any HTTP response means it is up.
  async probe() {
    this.lastProbe = Date.now();
    if (this.kind === "none") {
      this.available = false;
      this.detail = "speech to text is off (sttKind: none)";
      return false;
    }
    try {
      const base = new URL("/", this.url).href;
      const res = await this.fetch(base, { signal: AbortSignal.timeout(2500) });
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

  // wav: Buffer with a 16 kHz mono PCM16 WAV file. Returns { text, ms }.
  // Throws { status, body } errors the server sends back as JSON.
  transcribe(wav, { signal } = {}) {
    const run = this.queue.then(() => this.transcribeNow(wav, signal));
    this.queue = run.catch(() => {});
    return run;
  }

  async transcribeNow(wav, signal) {
    if (!this.available && Date.now() - this.lastProbe > 3000) await this.probe();
    if (!this.available) throw httpError(503, { error: "no-stt", detail: this.detail || `speech to text is not available (${this.kind})` });
    const started = Date.now();
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
    form.append("response_format", "json");
    if (this.kind === "openai") {
      form.append("model", this.model);
      if (this.language) form.append("language", this.language);
      if (this.prompt) form.append("prompt", this.prompt);
    } else {
      form.append("temperature", "0.0");
      if (this.language) form.append("language", this.language);
      if (this.prompt) form.append("prompt", this.prompt);
    }
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await this.fetch(this.url, { method: "POST", body: form, signal: combined });
    } catch (err) {
      if (timeout.aborted) throw httpError(504, { error: "stt-timeout", detail: `no answer from ${this.url} within ${TIMEOUT_MS / 1000} s` });
      if (signal?.aborted) throw httpError(499, { error: "aborted" });
      this.available = false;
      this.detail = `not reachable at ${this.url} (${err.cause?.code || err.message})`;
      throw httpError(503, { error: "no-stt", detail: this.detail });
    }
    const raw = await res.text();
    if (!res.ok) throw httpError(502, { error: "stt-failed", detail: `${res.status} ${raw.slice(0, 300)}` });
    let text = "";
    try {
      const json = JSON.parse(raw);
      text = typeof json.text === "string" ? json.text : Array.isArray(json.segments) ? json.segments.map((s) => s.text || "").join(" ") : "";
    } catch {
      text = raw; // response_format text
    }
    return { text: cleanTranscript(text, this.prompt), ms: Date.now() - started };
  }
}

function httpError(status, body) {
  const err = new Error(body.error);
  err.status = status;
  err.body = body;
  return err;
}
