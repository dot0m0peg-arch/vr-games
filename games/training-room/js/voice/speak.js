// Spoken replies through the browser's speech synthesis (plays on the Bluetooth speakers when
// they are the output device). Every call cancels what is already speaking.

const PREFERRED = /Google US English|Samantha|Aria|Jenny|Guy|Zira|Daniel|Karen|Serena|Alex/i;
let chosenVoice = null;
let current = null; // { finish, timer }

export function canSpeak() {
  return typeof globalThis.speechSynthesis !== "undefined" && typeof globalThis.SpeechSynthesisUtterance === "function";
}

export function isSpeaking() {
  if (current) return true;
  try {
    return canSpeak() && (globalThis.speechSynthesis.speaking || globalThis.speechSynthesis.pending);
  } catch {
    return false;
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
export function speak(text, { rate = 1.05, pitch = 1, volume = 1, lang = "en-US", onstart, onend } = {}) {
  cancelSpeech();
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!line || !canSpeak()) {
    try {
      onend?.(false);
    } catch (err) {
      console.error("[speak] onend failed", err);
    }
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
      try {
        onend?.(ok);
      } catch (err) {
        console.error("[speak] onend failed", err);
      }
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
        try {
          onstart?.();
        } catch (err) {
          console.error("[speak] onstart failed", err);
        }
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

export function cancelSpeech() {
  const entry = current;
  current = null;
  if (entry) entry.finish(false);
  else if (canSpeak()) {
    try {
      if (globalThis.speechSynthesis.speaking || globalThis.speechSynthesis.pending) globalThis.speechSynthesis.cancel();
    } catch {
      // Nothing to cancel.
    }
  }
}

// Voices load asynchronously in Chrome; refresh the cached choice when the list changes.
if (canSpeak()) {
  try {
    globalThis.speechSynthesis.addEventListener?.("voiceschanged", () => {
      chosenVoice = null;
    });
  } catch {
    // Older engines without events.
  }
}
