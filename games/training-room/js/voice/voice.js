// Voice input: push-to-talk, an always-listening "AI …" wake mode, and a hard mute that really
// releases the microphone (tracks stopped, audio graph closed, recognition aborted).
// Engines: "bridge" records PCM and sends a 16 kHz WAV to the laptop's Whisper (works in Quest
// Browser); "browser" uses SpeechRecognition (desktop/Android Chrome) when there is no bridge.
// Events: state, level (0..1), interim (text), final ({ text, wakeMatched, rest, engine, via }),
// error (message), blocked, wake (bare wake word heard), ignored ({ text } without wake word).
import { Emitter } from "../util/emitter.js";
import { stripWake as defaultStripWake, DEFAULT_WAKE_WORDS } from "../core/wake.js";
import { rms, concatFloat32, resampleLinear, encodeWav } from "./wav.js";

export const MIC_MODES = ["off", "push", "wake"];

const STT_RATE = 16000;
const CHUNK = 1024; // samples per worklet message (~21 ms at 48 kHz)
const RING_SEC = 0.8; // recent audio kept for pre-roll
const PUSH_PREROLL = 0.15;
const PUSH_MAX_SEC = 30;
const LEVEL_MS = 66; // ~15 Hz meter updates
const ARM_MS = 6000; // "AI" alone arms the next utterance for this long
const VAD = { minStart: 0.02, factor: 3, startSec: 0.12, endSec: 0.7, maxSec: 10, preroll: 0.3, minVoiced: 0.2 };
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
const FATAL_RECOGNITION = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"]);

const MSG = {
  didntCatch: "Didn't catch that",
  silent: "The mic is sending pure silence. On Android, check that Mic access is on in Quick settings.",
  permission: "Microphone permission is blocked. Allow the microphone for this site in the browser's site settings, then turn the mic back on.",
  insecure: "The microphone needs a secure page (https or localhost). Open the game from the laptop bridge's https address.",
  noMic: "No microphone found. Switch on or reconnect your Bluetooth headset mic, then try again.",
  busy: "The microphone is busy or failed to start. Close other apps using it and try again.",
  noEngine: "Voice needs the laptop bridge (Whisper) or a browser with speech recognition such as Chrome. You can type commands instead.",
  noBrowserSpeech: "Speech recognition is not available in this browser. Connect the laptop bridge for voice, or type commands.",
  network: "Browser speech recognition needs an internet connection. Connect the laptop bridge for offline voice.",
  holdLonger: "Hold the talk button while you speak.",
  disconnected: "The microphone disconnected (Bluetooth?). Press talk to reconnect.",
  tooLong: "Talk limit is 30 seconds; sending what I heard.",
};

const WORKLET = `
class TrMicTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = (options && options.processorOptions && options.processorOptions.size) || ${CHUNK};
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this.size - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if (this.n === this.size) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("tr-mic-tap", TrMicTap);
`;
let workletUrl = null;

const now = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const hasWords = (text) => /[\p{L}\p{N}]/u.test(text);

function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Already stopped.
    }
  }
}

// Autoplay policy can keep a new AudioContext suspended until the next user gesture.
function resumeOnGesture(ctx) {
  const target = globalThis.window;
  if (!target?.addEventListener) return;
  const events = ["pointerdown", "keydown", "touchend"];
  const resume = () => {
    for (const type of events) target.removeEventListener(type, resume, true);
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  };
  for (const type of events) target.addEventListener(type, resume, true);
}

function cancelled() {
  return Object.assign(new Error("microphone request cancelled"), { name: "CancelledError", cancelled: true });
}

function sttMessage(err) {
  const code = err?.code || "";
  if (code === "no-stt") return "The laptop's speech-to-text (Whisper) is not running.";
  if (code === "timeout" || code === "stt-timeout") return "Speech-to-text took too long. Try a shorter command.";
  if (code === "offline") return "Can't reach the laptop for speech-to-text.";
  return `Speech-to-text failed (${code || err?.message || "unknown error"}).`;
}

export class Voice extends Emitter {
  // transcribe: async (Blob audio/wav) => { text }. getUserMedia, AudioContextImpl and
  // SpeechRecognitionImpl (null = none) are injectable for tests.
  constructor({
    transcribe = null,
    wakeWords = DEFAULT_WAKE_WORDS,
    lang = "en-US",
    stripWake = defaultStripWake,
    idleReleaseMs = 30000,
    tailMs = 300,
    minRms = 0.003,
    getUserMedia = null,
    AudioContextImpl = null,
    SpeechRecognitionImpl = undefined,
  } = {}) {
    super();
    this.wakeWords = wakeWords;
    this.lang = lang;
    this.idleReleaseMs = idleReleaseMs;
    this.tailMs = tailMs;
    this.minRms = minRms;
    this._transcribe = typeof transcribe === "function" ? transcribe : null;
    this._stripWake = stripWake;
    this._getUserMedia = getUserMedia;
    this._AudioContext = AudioContextImpl;
    this._SRImpl = SpeechRecognitionImpl;
    this._mode = "push";
    this._disposed = false;
    this._gen = 0; // bumped by hard mute: in-flight transcriptions are discarded
    // push-to-talk
    this._pressed = false;
    this._press = 0;
    this._rec = null; // { chunks, samples, rate, released, result }
    this._sessions = new Set(); // browser push sessions still finishing
    this._bsession = null;
    // microphone graph
    this._stream = null;
    this._ctx = null;
    this._source = null;
    this._tap = null;
    this._sink = null;
    this._rate = 48000;
    this._micGen = 0;
    this._opening = null;
    this._idleTimer = 0;
    this._ring = [];
    this._ringSamples = 0;
    this._level = 0;
    this._levelAt = 0;
    // wake mode
    this._vad = { floor: -1, above: 0, below: 0, voiced: 0, active: false, th: 0, chunks: null, samples: 0 };
    this._armedUntil = 0;
    this._wakeActive = false;
    this._wakeRec = null;
    this._wakeTimer = 0;
    this._wakeErrors = 0;
    this._wakeHeard = false;
    this._wakeSpeech = false;
    this._wakeChain = Promise.resolve();
    this._wakePending = 0;
    this._wakeErrorAt = -Infinity;
    this._browserBroken = false;
    this._busy = 0;
    this._speaking = false;
    this._speakHold = 0;
  }

  // ---------- public state ----------

  get mode() {
    return this._mode;
  }

  get engine() {
    if (this._transcribe) return "bridge";
    if (this._SR() && !this._browserBroken) return "browser";
    return "none";
  }

  get level() {
    return this._level;
  }

  // Capturing for commands: push held (or in its tail), or wake mode actively listening.
  get listening() {
    if (this._mode === "off" || this._disposed) return false;
    if (this._pressed || this._rec || this._bsession) return true;
    if (this._mode !== "wake") return false;
    return this.engine === "bridge" ? this.micOpen : this._wakeActive;
  }

  // The player is speaking a command right now (for the avatar mic glyph).
  get talking() {
    return this._mode !== "off" && (this._pressed || !!this._rec || !!this._bsession || this._vad.active || this._wakeSpeech);
  }

  // True while a MediaStreamTrack from getUserMedia is live (browser mic indicator on).
  get micOpen() {
    return !!this._stream && this._stream.getTracks().some((track) => track.readyState === "live");
  }

  get busy() {
    return this._busy > 0;
  }

  get state() {
    return {
      mode: this._mode,
      listening: this.listening,
      engine: this.engine,
      talking: this.talking,
      busy: this._busy > 0,
      micOpen: this.micOpen,
      armed: this._armedUntil > now(),
    };
  }

  setMode(mode) {
    if (!MIC_MODES.includes(mode)) throw new Error(`unknown mic mode "${mode}"`);
    if (this._disposed) return;
    const prev = this._mode;
    if (mode === prev) {
      this._emitState();
      return;
    }
    this._mode = mode;
    if (mode === "off") {
      this._hardMute();
    } else {
      this._cancelPush();
      if (prev === "wake") this._stopWake();
      if (mode === "wake") this._startWake();
      else this._scheduleIdle();
    }
    this._emitState();
  }

  // Switches between the laptop's Whisper (fn) and browser recognition (null) while running.
  setTranscriber(fn) {
    const before = this.engine;
    this._transcribe = typeof fn === "function" ? fn : null;
    if (this.engine !== before && !this._disposed) {
      this._cancelPush();
      if (this._mode === "wake") {
        this._stopWake();
        this._startWake();
      } else if (before === "bridge") {
        this._releaseMic();
      }
    }
    this._emitState();
  }

  // TTS playing: wake mode ignores what it hears (the AI's own voice), plus a short tail after.
  setSpeaking(on) {
    const was = this._speaking;
    this._speaking = !!on;
    if (was && !on) this._speakHold = now() + 400;
    if (on && this._vad.active) {
      this._resetVad();
      this._emitState();
    }
  }

  // Optional: ask for mic permission early (e.g. on the Enter VR click) so the first press is instant.
  async prepare() {
    if (this._mode === "off" || this._disposed || this.engine !== "bridge") return false;
    try {
      await this._openMic();
      this._scheduleIdle();
      this._emitState();
      return true;
    } catch (err) {
      this._micError(err);
      return false;
    }
  }

  async pressTalk() {
    if (this._disposed) return false;
    if (this._mode === "off") {
      this.emit("blocked", { mode: "off" });
      return false;
    }
    if (this._pressed) return true;
    const engine = this.engine;
    if (engine === "none") {
      this.emit("error", MSG.noEngine);
      return false;
    }
    this._pressed = true;
    const press = ++this._press;
    clearTimeout(this._idleTimer);
    if (this._rec?.released) this._finishPush(this._rec); // pressed again during the tail: send it now

    if (engine === "browser") {
      if (this._mode === "wake") {
        // Recognition is already running; holding talk makes the next phrase a command without "AI".
        this._armedUntil = Infinity;
      } else {
        if (this._bsession) this._endBrowserPush(this._bsession);
        this._startBrowserPush();
      }
      this._emitState();
      return true;
    }

    this._emitState();
    try {
      await this._openMic();
    } catch (err) {
      if (press === this._press) this._pressed = false;
      this._micError(err);
      this._emitState();
      return false;
    }
    if (press !== this._press || this._mode === "off") return false;
    if (!this._pressed) {
      this.emit("error", MSG.holdLonger);
      this._scheduleIdle();
      this._emitState();
      return false;
    }
    this._resetVad();
    const chunks = this._ringTail(PUSH_PREROLL);
    let samples = 0;
    for (const chunk of chunks) samples += chunk.length;
    this._rec = { chunks, samples, rate: this._rate, released: false, result: null };
    this._emitState();
    return true;
  }

  // Resolves after the tail and the transcription (or browser recognition) have finished.
  async releaseTalk() {
    if (!this._pressed) return;
    this._pressed = false;
    if (this._armedUntil === Infinity) {
      this._armedUntil = now() + 4000;
      this._emitState();
      return;
    }
    const session = this._bsession;
    if (session && !session.released) {
      session.released = true;
      this._emitState();
      await sleep(this.tailMs);
      this._stopBrowserPush(session);
      return session.promise;
    }
    const rec = this._rec;
    this._emitState();
    if (!rec) return; // let go while the mic was still starting (handled in pressTalk)
    rec.released = true;
    await sleep(this.tailMs); // people let go of the button before the last word ends
    return this._finishPush(rec);
  }

  dispose() {
    if (this._disposed) return;
    this._hardMute();
    this._mode = "off";
    this._disposed = true;
    this._handlers.clear();
  }

  // ---------- push-to-talk ----------

  _finishPush(rec) {
    if (!rec) return Promise.resolve();
    if (this._rec !== rec) return rec.result || Promise.resolve();
    this._rec = null;
    this._emitState();
    this._scheduleIdle();
    rec.result = this._transcribeAudio(concatFloat32(rec.chunks), rec.rate, "push");
    return rec.result;
  }

  _cancelPush() {
    this._pressed = false;
    this._press++;
    this._rec = null;
    if (this._armedUntil === Infinity) this._armedUntil = 0;
    for (const session of [...this._sessions]) {
      session.cancelled = true;
      this._endBrowserPush(session);
    }
  }

  // Audio → WAV → transcribe(). via "push" (always a command) or "wake" (needs the wake word).
  async _transcribeAudio(audio, rate, via) {
    const push = via === "push";
    const level = rms(audio);
    if (audio.length / rate < 0.25 || level < this.minRms) {
      if (push) this.emit("error", level === 0 && audio.length / rate >= 0.25 ? MSG.silent : MSG.didntCatch);
      return;
    }
    const fn = this._transcribe;
    if (!fn) {
      if (push) this.emit("error", MSG.noEngine);
      return;
    }
    const gen = this._gen;
    const pcm = rate === STT_RATE ? audio : resampleLinear(audio, rate, STT_RATE);
    const blob = new Blob([encodeWav(pcm, STT_RATE)], { type: "audio/wav" });
    this._busy++;
    this._emitState();
    let text = "";
    try {
      const result = await fn(blob);
      text = clean(result?.text);
    } catch (err) {
      if (gen === this._gen && (push || now() - this._wakeErrorAt > 15000)) {
        if (!push) this._wakeErrorAt = now();
        this.emit("error", sttMessage(err));
      }
      return;
    } finally {
      this._busy--;
      this._emitState();
    }
    if (gen !== this._gen || this._mode === "off" || this._disposed) return; // muted meanwhile
    if (!hasWords(text)) {
      if (push) this.emit("error", MSG.didntCatch);
      return;
    }
    if (push) this._emitFinal(text, "bridge", "push");
    else if (this._mode === "wake") this._handleWakeText(text, "bridge");
  }

  _emitFinal(text, engine, via) {
    const wake = this._stripWake(text, this.wakeWords);
    this.emit("final", { text, wakeMatched: wake.matched, rest: wake.matched ? wake.rest : text, engine, via });
  }

  // ---------- browser SpeechRecognition push-to-talk ----------

  _SR() {
    if (this._SRImpl !== undefined) return this._SRImpl;
    return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
  }

  _newRecognition(continuous) {
    const SR = this._SR();
    const rec = new SR();
    rec.lang = this.lang;
    rec.continuous = continuous;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    return rec;
  }

  _startBrowserPush() {
    const session = { finals: [], current: "", interim: "", released: false, done: false, cancelled: false, error: null, rec: null, safety: 0, restarts: 0 };
    session.promise = new Promise((resolve) => {
      session.resolve = resolve;
    });
    this._sessions.add(session);
    this._bsession = session;
    const begin = () => {
      let rec;
      try {
        rec = this._newRecognition(false);
      } catch (err) {
        console.warn("[voice] SpeechRecognition failed to start", err);
        session.error = session.error || "start-failed";
        this._endBrowserPush(session);
        return;
      }
      session.rec = rec;
      session.current = "";
      session.interim = "";
      rec.onresult = (event) => {
        let fin = "";
        let interim = "";
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0]?.transcript || "";
          if (result.isFinal) fin += text;
          else interim += text;
        }
        session.current = fin;
        session.interim = interim;
        const live = clean([...session.finals, fin, interim].join(" "));
        if (live) this.emit("interim", live);
      };
      rec.onerror = (event) => {
        session.error = event?.error || "error";
        if (FATAL_RECOGNITION.has(session.error)) {
          this._endBrowserPush(session);
          this._recognitionError(session.error);
        }
      };
      rec.onend = () => {
        if (session.rec !== rec) return;
        const text = clean(session.current || session.interim);
        if (text) session.finals.push(text);
        session.current = "";
        session.interim = "";
        session.rec = null;
        // Chrome ends single-shot recognition after a pause; keep listening while the button is held.
        if (!session.released && !session.done && this._bsession === session && !FATAL_RECOGNITION.has(session.error) && session.restarts < 20) {
          session.restarts++;
          setTimeout(() => {
            if (!session.released && !session.done) begin();
            else this._endBrowserPush(session);
          }, session.error === "network" ? 400 : 0);
          return;
        }
        this._endBrowserPush(session);
      };
      try {
        rec.start();
      } catch (err) {
        console.warn("[voice] recognition.start failed", err);
        session.rec = null;
        session.error = session.error || "start-failed";
        this._endBrowserPush(session);
      }
    };
    begin();
  }

  _stopBrowserPush(session) {
    if (session.done) return;
    if (!session.rec) {
      this._endBrowserPush(session);
      return;
    }
    try {
      session.rec.stop();
    } catch {
      // Already stopping.
    }
    // A final result normally arrives within a second; never wait forever.
    session.safety = setTimeout(() => this._endBrowserPush(session), 3000);
  }

  _endBrowserPush(session) {
    if (session.done) return;
    session.done = true;
    clearTimeout(session.safety);
    const rec = session.rec;
    if (rec) {
      const text = clean(session.current || session.interim);
      if (text) session.finals.push(text);
      session.rec = null;
      rec.onresult = rec.onerror = rec.onend = null;
      try {
        rec.abort();
      } catch {
        // Already ended.
      }
    }
    this._sessions.delete(session);
    if (this._bsession === session) this._bsession = null;
    this._emitState();
    session.resolve();
    if (session.cancelled || this._mode === "off" || this._disposed || FATAL_RECOGNITION.has(session.error)) return;
    const text = clean(session.finals.join(" "));
    if (hasWords(text)) this._emitFinal(text, "browser", "push");
    else this.emit("error", session.error === "network" ? MSG.network : MSG.didntCatch);
  }

  _recognitionError(code) {
    if (code === "not-allowed") {
      this._permissionDenied();
    } else if (code === "service-not-allowed" || code === "language-not-supported") {
      this._browserBroken = true;
      this.emit("error", MSG.noBrowserSpeech);
      if (this._mode === "wake") this.setMode("push");
      else this._emitState();
    } else if (code === "audio-capture") {
      this.emit("error", MSG.noMic);
      if (this._mode === "wake") this.setMode("push");
    }
  }

  // ---------- wake mode ----------

  async _startWake() {
    this._wakeErrors = 0;
    this._armedUntil = 0;
    const engine = this.engine;
    if (engine === "bridge") {
      this._resetVad();
      try {
        await this._openMic();
      } catch (err) {
        this._micError(err);
        return;
      }
      clearTimeout(this._idleTimer);
      this._emitState();
    } else if (engine === "browser") {
      this._wakeActive = true;
      this._runWakeRecognition();
    } else {
      this.emit("error", MSG.noEngine);
      this.setMode("push");
    }
  }

  _stopWake() {
    this._wakeActive = false;
    clearTimeout(this._wakeTimer);
    this._wakeTimer = 0;
    const rec = this._wakeRec;
    this._wakeRec = null;
    if (rec) {
      rec.onresult = rec.onerror = rec.onend = rec.onspeechstart = rec.onspeechend = null;
      try {
        rec.abort();
      } catch {
        // Already ended.
      }
    }
    this._wakeSpeech = false;
    this._resetVad();
    if (this._armedUntil !== Infinity) this._armedUntil = 0;
  }

  _runWakeRecognition() {
    this._wakeTimer = 0;
    if (!this._wakeActive || this._mode !== "wake" || this.engine !== "browser" || this._disposed) return;
    let rec;
    try {
      rec = this._newRecognition(true);
    } catch (err) {
      console.warn("[voice] SpeechRecognition unavailable", err);
      this._recognitionError("service-not-allowed");
      return;
    }
    const startedAt = now();
    rec.onresult = (event) => {
      this._wakeErrors = 0;
      this._wakeHeard = true;
      if (this._ignoringInput() && this._armedUntil !== Infinity) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript || "";
        if (result.isFinal) this._handleWakeText(clean(text), "browser");
        else interim += text;
      }
      if (clean(interim)) this.emit("interim", clean(interim));
    };
    rec.onspeechstart = () => {
      this._wakeSpeech = true;
      this._emitState();
    };
    rec.onspeechend = () => {
      this._wakeSpeech = false;
      this._emitState();
    };
    rec.onerror = (event) => {
      const code = event?.error || "error";
      if (code === "no-speech" || code === "aborted") return;
      if (FATAL_RECOGNITION.has(code)) {
        this._recognitionError(code);
        return;
      }
      this._wakeErrors++;
      if (code === "network" && this._wakeErrors === 1) this.emit("error", MSG.network);
      if (this._wakeErrors >= 4 && !this._wakeHeard) {
        this._recognitionError("service-not-allowed");
      }
    };
    rec.onend = () => {
      if (this._wakeRec !== rec) return;
      this._wakeRec = null;
      if (this._wakeSpeech) {
        this._wakeSpeech = false;
        this._emitState();
      }
      if (!this._wakeActive || this._mode !== "wake") return;
      // Continuous recognition stops by itself now and then; restart with backoff on errors.
      const delay = this._wakeErrors ? Math.min(5000, 250 * 2 ** this._wakeErrors) : now() - startedAt < 1000 ? 400 : 100;
      this._wakeTimer = setTimeout(() => this._runWakeRecognition(), delay);
    };
    this._wakeRec = rec;
    try {
      rec.start();
    } catch (err) {
      console.warn("[voice] wake recognition failed to start", err);
      this._wakeRec = null;
      this._wakeErrors++;
      this._wakeTimer = setTimeout(() => this._runWakeRecognition(), Math.min(5000, 250 * 2 ** this._wakeErrors));
    }
  }

  // Wake-mode transcript: emit "final" only when it starts with the wake word (or follows a bare
  // "AI" / the held talk button).
  _handleWakeText(text, engine) {
    if (!text) return;
    const t = now();
    const wake = this._stripWake(text, this.wakeWords);
    if (this._armedUntil > t) {
      const rest = wake.matched ? wake.rest : text;
      if (!rest) {
        if (this._armedUntil !== Infinity) this._armedUntil = t + ARM_MS;
        return;
      }
      if (this._armedUntil !== Infinity) this._armedUntil = 0;
      this.emit("final", { text, wakeMatched: true, rest, engine, via: "wake" });
      this._emitState();
      return;
    }
    if (!wake.matched) {
      this.emit("ignored", { text });
      return;
    }
    if (!wake.rest) {
      this._armedUntil = t + ARM_MS;
      this.emit("wake", { text });
      this._emitState();
      return;
    }
    this.emit("final", { text, wakeMatched: true, rest: wake.rest, engine, via: "wake" });
  }

  _ignoringInput() {
    return this._speaking || now() < this._speakHold;
  }

  _resetVad() {
    const v = this._vad;
    v.above = 0;
    v.below = 0;
    v.voiced = 0;
    v.active = false;
    v.chunks = null;
    v.samples = 0;
  }

  // Adaptive energy VAD: noise floor follows quiet audio quickly and loud audio slowly, so a
  // steady loud room raises the bar while speech close to the mic still starts a segment.
  _vadStep(data, level) {
    const v = this._vad;
    const dt = data.length / this._rate;
    if (this._ignoringInput()) {
      if (v.active) {
        this._resetVad();
        this._emitState();
      }
      v.above = 0;
      return;
    }
    if (!v.active) {
      if (v.floor < 0) v.floor = level;
      else v.floor += (level - v.floor) * Math.min(1, dt / (level < v.floor ? 0.8 : 4));
      const threshold = Math.max(VAD.minStart, v.floor * VAD.factor);
      if (level <= threshold) {
        v.above = 0;
        return;
      }
      v.above += dt;
      if (v.above < VAD.startSec) return;
      v.active = true;
      v.th = threshold;
      v.below = 0;
      v.voiced = v.above;
      v.chunks = this._ringTail(VAD.preroll + v.above);
      v.samples = 0;
      for (const chunk of v.chunks) v.samples += chunk.length;
      this._emitState();
      return;
    }
    v.chunks.push(data);
    v.samples += data.length;
    if (level >= v.th * 0.7) {
      v.below = 0;
      v.voiced += dt;
    } else {
      v.below += dt;
    }
    if (v.below >= VAD.endSec || v.samples >= this._rate * VAD.maxSec) {
      const { chunks, voiced } = v;
      this._resetVad();
      this._emitState();
      if (voiced >= VAD.minVoiced) this._queueWake(concatFloat32(chunks));
    }
  }

  _queueWake(audio) {
    if (this._wakePending >= 2) return; // the laptop is behind; drop rather than lag further
    this._wakePending++;
    const rate = this._rate;
    const gen = this._gen;
    this._wakeChain = this._wakeChain
      .then(() => (gen === this._gen && this._mode === "wake" ? this._transcribeAudio(audio, rate, "wake") : null))
      .catch((err) => console.warn("[voice] wake transcription failed", err))
      .finally(() => {
        this._wakePending--;
      });
  }

  // ---------- microphone graph ----------

  async _openMic() {
    if (this._ctx && this.micOpen) {
      if (this._ctx.state === "suspended") {
        try {
          await this._ctx.resume();
        } catch {
          // Resumes on the next user gesture.
        }
      }
      return;
    }
    if (!this._opening) {
      if (this._ctx || this._stream) this._releaseMic(); // stale graph (tracks ended)
      const gen = this._micGen;
      this._opening = this._acquire(gen).finally(() => {
        this._opening = null;
      });
    }
    await this._opening;
    // Opened for a mode that has since become push (e.g. wake → push while starting): never leave it on.
    if (this._mode === "push" && !this._pressed && !this._rec) this._scheduleIdle();
  }

  async _acquire(gen) {
    const live = () => gen === this._micGen && this._mode !== "off" && !this._disposed;
    const getUserMedia = this._getUserMedia || ((constraints) => {
      const devices = globalThis.navigator?.mediaDevices;
      if (!devices?.getUserMedia) throw Object.assign(new Error("getUserMedia unavailable"), { name: "InsecureContextError" });
      return devices.getUserMedia(constraints);
    });
    const stream = await getUserMedia({ audio: { ...AUDIO } });
    if (!live()) {
      stopStream(stream);
      throw cancelled();
    }
    const Ctx = this._AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
    let ctx = null;
    try {
      if (!Ctx) throw Object.assign(new Error("Web Audio is not available in this browser"), { name: "NoAudioError" });
      ctx = new Ctx({ latencyHint: "interactive" });
      const source = ctx.createMediaStreamSource(stream);
      const sink = ctx.createGain(); // silent sink keeps the tap pulled without echoing the mic
      sink.gain.value = 0;
      sink.connect(ctx.destination);
      const tap = await this._makeTap(ctx);
      if (!live()) throw cancelled();
      source.connect(tap);
      tap.connect(sink);
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      if (ctx.state === "suspended") resumeOnGesture(ctx);
      this._stream = stream;
      this._ctx = ctx;
      this._source = source;
      this._tap = tap;
      this._sink = sink;
      this._rate = ctx.sampleRate;
      this._ring = [];
      this._ringSamples = 0;
    } catch (err) {
      stopStream(stream);
      if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
      throw err;
    }
    for (const track of stream.getAudioTracks()) track.addEventListener("ended", () => this._trackEnded(stream));
    this._emitState();
  }

  async _makeTap(ctx) {
    if (ctx.audioWorklet && typeof globalThis.AudioWorkletNode === "function") {
      try {
        workletUrl = workletUrl || URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
        await ctx.audioWorklet.addModule(workletUrl);
        const node = new globalThis.AudioWorkletNode(ctx, "tr-mic-tap", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { size: CHUNK },
        });
        node.port.onmessage = (event) => this._onChunk(event.data, ctx);
        return node;
      } catch (err) {
        console.warn("[voice] AudioWorklet unavailable; using ScriptProcessorNode", err);
      }
    }
    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = (event) => this._onChunk(new Float32Array(event.inputBuffer.getChannelData(0)), ctx);
    return node;
  }

  _onChunk(data, ctx) {
    if (ctx !== this._ctx || !(data instanceof Float32Array) || !data.length) return;
    this._ring.push(data);
    this._ringSamples += data.length;
    const keep = RING_SEC * this._rate;
    while (this._ring.length > 1 && this._ringSamples - this._ring[0].length >= keep) this._ringSamples -= this._ring.shift().length;
    const level = rms(data);
    this._meter(level);
    const rec = this._rec;
    if (rec) {
      rec.chunks.push(data);
      rec.samples += data.length;
      if (!rec.released && rec.samples > rec.rate * PUSH_MAX_SEC) {
        this._pressed = false;
        rec.released = true;
        this.emit("error", MSG.tooLong);
        this._finishPush(rec);
      }
      return;
    }
    if (this._mode === "wake" && this.engine === "bridge" && !this._pressed) this._vadStep(data, level);
  }

  _ringTail(seconds) {
    const want = seconds * this._rate;
    const out = [];
    let total = 0;
    for (let i = this._ring.length - 1; i >= 0 && total < want; i--) {
      out.unshift(this._ring[i]);
      total += this._ring[i].length;
    }
    return out;
  }

  // dBFS mapped to 0..1 (-60 dB → 0, -10 dB → 1), fast attack, slower release.
  _meter(value) {
    const db = 20 * Math.log10(value + 1e-9);
    const target = Math.min(1, Math.max(0, (db + 60) / 50));
    this._level = target > this._level ? target : this._level + (target - this._level) * 0.3;
    const t = now();
    if (t - this._levelAt >= LEVEL_MS) {
      this._levelAt = t;
      this.emit("level", this._level);
    }
  }

  _scheduleIdle() {
    clearTimeout(this._idleTimer);
    this._idleTimer = 0;
    if (this._mode !== "push" || !this._stream) return;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = 0;
      if (this._mode === "push" && !this._pressed && !this._rec) {
        this._releaseMic();
        this._emitState();
      }
    }, this.idleReleaseMs);
  }

  // Stops every track and closes the audio graph so the browser's mic indicator turns off.
  _releaseMic() {
    this._micGen++;
    clearTimeout(this._idleTimer);
    this._idleTimer = 0;
    const { _stream: stream, _ctx: ctx, _tap: tap, _source: source, _sink: sink } = this;
    this._stream = this._ctx = this._tap = this._source = this._sink = null;
    this._ring = [];
    this._ringSamples = 0;
    this._resetVad();
    this._vad.floor = -1;
    if (tap) {
      if (tap.port) tap.port.onmessage = null;
      tap.onaudioprocess = null;
      try {
        tap.disconnect();
      } catch {
        // Not connected.
      }
    }
    try {
      source?.disconnect();
      sink?.disconnect();
    } catch {
      // Not connected.
    }
    stopStream(stream);
    if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
    if (this._level !== 0) {
      this._level = 0;
      this.emit("level", 0);
    }
    return !!stream;
  }

  _trackEnded(stream) {
    if (this._stream !== stream) return; // we stopped it ourselves
    const wasWake = this._mode === "wake";
    this._rec = null;
    this._pressed = false;
    this._releaseMic();
    this.emit("error", MSG.disconnected);
    this._emitState();
    if (wasWake) {
      this._wakeTimer = setTimeout(() => {
        if (this._mode === "wake" && !this._stream) this._startWake();
      }, 2000);
    }
  }

  _hardMute() {
    this._gen++;
    this._cancelPush();
    this._stopWake();
    this._armedUntil = 0;
    this._releaseMic();
  }

  _permissionDenied() {
    this.emit("error", MSG.permission);
    this.setMode("off");
  }

  _micError(err) {
    if (err?.cancelled) return;
    const name = err?.name || "";
    if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
      this._permissionDenied();
      return;
    }
    if (name === "InsecureContextError") {
      this.emit("error", MSG.insecure);
      this.setMode("off");
      return;
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") this.emit("error", MSG.noMic);
    else if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") this.emit("error", MSG.busy);
    else this.emit("error", `Microphone failed: ${err?.message || name || "unknown error"}`);
    if (this._mode === "wake") this.setMode("push");
  }

  _emitState() {
    if (!this._disposed) this.emit("state", this.state);
  }
}
