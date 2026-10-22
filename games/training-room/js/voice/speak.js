// Spoken replies (play on the Bluetooth speakers when they are the output device). With a speech
// source set (the laptop voice through the bridge) the reply is that audio; otherwise, or when the
// source fails, the browser's speech synthesis says it. Every call cancels what is already speaking.

const PREFERRED = /Google US English|Samantha|Aria|Jenny|Guy|Zira|Daniel|Karen|Serena|Alex/i;
let chosenVoice = null;
let current = null; // { finish, timer }
let source = null; // (text) → Promise<Blob>

const hasSynth = () => typeof globalThis.speechSynthesis !== "undefined" && typeof globalThis.SpeechSynthesisUtterance === "function";
const hasAudio = () => typeof globalThis.Audio === "function" && typeof globalThis.URL?.createObjectURL === "function";

// fn(text) → Promise<Blob> of audio (e.g. (text) => net.tts(text)), or null for the browser voice only.
export function setSpeechSource(fn) {
  source = typeof fn === "function" ? fn : null;
}

export function canSpeak() {
  return (!!source && hasAudio()) || hasSynth();
}

export function isSpeaking() {
  if (current) return true;
  try {
    return hasSynth() && (globalThis.speechSynthesis.speaking || globalThis.speechSynthesis.pending);
  } catch {
    return false;
  }
}

function notify(fn, ...args) {
  try {
    fn?.(...args);
  } catch (err) {
    console.error("[speak] callback failed", err);
  }
}

// Best English voice: local en-US first (works offline), then any en-US, then any English.
function pickVoice(lang) {
  let voices = [];
  try {
    voices = globalThis.speechSynthesis.getVoices() || [];
  } catch {
    voices = [];
  }
  if (!voices.length) return null;
  if (chosenVoice && voices.includes(chosenVoice) && chosenVoice.lang?.startsWith(lang.slice(0, 2))) return chosenVoice;
  const want = lang.toLowerCase().replace("_", "-");
  const norm = (v) => String(v.lang || "").toLowerCase().replace("_", "-");
  const exact = voices.filter((v) => norm(v) === want);
  const english = voices.filter((v) => norm(v).startsWith(want.slice(0, 2)));
  chosenVoice =
    exact.find((v) => v.localService && PREFERRED.test(v.name)) ||
    exact.find((v) => PREFERRED.test(v.name)) ||
    exact.find((v) => v.localService) ||
    exact[0] ||
    english.find((v) => v.localService) ||
    english[0] ||
    null;
  return chosenVoice;
}

// Splits long replies into sentence-sized pieces (Chrome cuts single utterances off after ~15 s).
function chunks(text, max = 200) {
  const out = [];
  for (const sentence of text.match(/[^.!?;]+[.!?;]*\s*/g) || [text]) {
    let piece = sentence.trim();
    while (piece.length > max) {
      const cut = piece.lastIndexOf(" ", max);
      const at = cut > 40 ? cut : max;
      out.push(piece.slice(0, at));
      piece = piece.slice(at).trim();
    }
    if (piece) out.push(piece);
  }
  return out;
}

// → Promise<boolean>: true when it finished speaking, false when cancelled, failed or timed out.
export function speak(text, options = {}) {
  cancelSpeech();
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  if (line && source && hasAudio()) return speakAudio(line, options);
  return speakSynth(line, options);
}

// The source's audio through an <audio> element; any failure before playback falls back to the browser voice.
function speakAudio(line, options) {
  const { volume = 1, onstart, onend } = options;
  const fetchAudio = source;
  return new Promise((resolve) => {
    const entry = { done: false, audio: null, url: "", timer: 0 };
    const release = () => {
      clearTimeout(entry.timer);
      const audio = entry.audio;
      entry.audio = null;
      if (audio) {
        audio.onplaying = audio.onended = audio.onerror = null;
        try {
          audio.pause();
          audio.removeAttribute?.("src");
          audio.load?.(); // drops the buffered clip
        } catch {
          // Already stopped.
        }
      }
      if (entry.url) {
        try {
          globalThis.URL.revokeObjectURL(entry.url);
        } catch {
          // Already revoked.
        }
        entry.url = "";
      }
      if (current === entry) current = null;
    };
    entry.finish = (ok) => {
      if (entry.done) return;
      entry.done = true;
      release();
      notify(onend, ok);
      resolve(ok);
    };
    const fallback = (err) => {
      if (entry.done) return;
      entry.done = true;
      release();
      console.warn("[speak] laptop voice unavailable, using the browser voice:", err?.message || err);
      resolve(speakSynth(line, options));
    };
    current = entry;
    let started = false;
    entry.timer = setTimeout(() => fallback(new Error("no audio within 30 s")), 30000);
    Promise.resolve()
      .then(() => fetchAudio(line))
      .then((blob) => {
        if (entry.done) return;
        if (!blob || !(blob.size > 0)) throw new Error("no audio");
        clearTimeout(entry.timer);
        const audio = new globalThis.Audio();
        entry.audio = audio;
        entry.url = globalThis.URL.createObjectURL(blob);
        audio.preload = "auto";
        audio.volume = Math.min(1, Math.max(0, Number(volume) || 0));
        audio.onplaying = () => {
          if (started || entry.done) return;
          started = true;
          // Ceiling: the clip's length plus slack, so a stalled element never blocks the mic.
          const seconds = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 2 + line.length / 10;
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => entry.finish(false), Math.min(120000, seconds * 1000 + 3000));
          notify(onstart);
        };
        audio.onended = () => entry.finish(true);
        audio.onerror = () => (started ? entry.finish(false) : fallback(new Error("the audio could not be played")));
        entry.timer = setTimeout(() => fallback(new Error("playback did not start")), 8000);
        audio.src = entry.url;
        const playing = audio.play();
        playing?.catch?.((err) => (started ? entry.finish(false) : fallback(err)));
      })
      .catch(fallback);
  });
}

function speakSynth(line, { rate = 1.05, pitch = 1, volume = 1, lang = "en-US", onstart, onend } = {}) {
  if (!line || !hasSynth()) {
    notify(onend, false);
    return Promise.resolve(false);
  }
  const synth = globalThis.speechSynthesis;
  const pieces = chunks(line);
  return new Promise((resolve) => {
    let started = false;
    let done = false;
    const entry = {};
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(entry.timer);
      if (current === entry) current = null;
      if (!ok) {
        try {
          synth.cancel();
        } catch {
          // Already stopped.
        }
      }
      notify(onend, ok);
      resolve(ok);
    };
    entry.finish = finish;
    // Generous ceiling (~14 characters per second at rate 1) so a stuck engine never blocks the mic.
    const maxMs = Math.min(60000, 2500 + (line.length * 75) / Math.max(0.5, rate));
    entry.timer = setTimeout(() => finish(false), maxMs);
    current = entry;
    const voice = pickVoice(lang);
    pieces.forEach((piece, index) => {
      const utter = new globalThis.SpeechSynthesisUtterance(piece);
      utter.lang = voice?.lang || lang;
      if (voice) utter.voice = voice;
      utter.rate = rate;
      utter.pitch = pitch;
      utter.volume = volume;
      utter.onstart = () => {
        if (started || done) return;
        started = true;
        notify(onstart);
      };
      utter.onerror = (event) => {
        // "interrupted"/"canceled" come from cancelSpeech(); anything else is a real failure.
        if (!done && event?.error && event.error !== "interrupted" && event.error !== "canceled") console.warn("[speak]", event.error);
        finish(false);
      };
      if (index === pieces.length - 1) utter.onend = () => finish(true);
      try {
        synth.speak(utter);
      } catch (err) {
        console.warn("[speak] speak failed", err);
        finish(false);
      }
    });
    // Chrome sometimes leaves the queue paused after a cancel.
    try {
      if (synth.paused) synth.resume();
    } catch {
      // Not supported.
    }
  });
}

// Stops the reply: the laptop voice's audio element or the browser voice.
export function cancelSpeech() {
  const entry = current;
  current = null;
  if (entry) entry.finish(false);
  else if (hasSynth()) {
    try {
      if (globalThis.speechSynthesis.speaking || globalThis.speechSynthesis.pending) globalThis.speechSynthesis.cancel();
    } catch {
      // Nothing to cancel.
    }
  }
}

// Voices load asynchronously in Chrome; refresh the cached choice when the list changes.
if (hasSynth()) {
  try {
    globalThis.speechSynthesis.addEventListener?.("voiceschanged", () => {
      chosenVoice = null;
    });
  } catch {
    // Older engines without events.
  }
}
