// Synthesized sound effects (no audio files): gunshots, lasers, booms, squeaks, pops. Quiet no-ops
// where Web Audio is missing (Node tests) or the page has not been touched yet.
export class Sfx {
  constructor() {
    this.ctx = null;
    this.noise = null;
    this.listener = null; // () => { p: Vector3 } head position for distance falloff
  }

  _ctx() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume?.().catch?.(() => {});
      return this.ctx;
    }
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    try {
      this.ctx = new Ctx();
    } catch {
      return null;
    }
    const length = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return this.ctx;
  }

  // Call inside a click or tap so later sounds (from controller buttons) are allowed to play.
  unlock() {
    this._ctx();
  }

  // Volume for a sound at world position p (1 at the head, fading over ~25 m).
  _gain(p, base) {
    const head = this.listener?.();
    if (!p || !head) return base;
    const d = Math.hypot(p.x - head.x, p.y - head.y, p.z - head.z);
    return base / (1 + d * 0.15);
  }

  _out(volume) {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    gain.connect(ctx.destination);
    return gain;
  }

  _noiseBurst(out, { at, length, from, to, q = 0.7, type = "lowpass", attack = 0.002 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, at);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + length);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(1, at + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length);
    src.connect(filter).connect(env).connect(out);
    src.start(at, Math.random() * 0.5);
    src.stop(at + length + 0.05);
  }

  _tone(out, { at, length, from, to, type = "sine", volume = 1 }) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), at + length);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(volume, at + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + length + 0.05);
  }

  // style: "bullet" | "laser" | "water" | "boom"
  shot(style = "bullet", p = null) {
    const ctx = this._ctx();
    if (!ctx) return;
    const at = ctx.currentTime;
    if (style === "laser") {
      const out = this._out(this._gain(p, 0.35));
      this._tone(out, { at, length: 0.22, from: 1800, to: 220, type: "sawtooth", volume: 0.6 });
      this._tone(out, { at, length: 0.18, from: 2600, to: 400, type: "square", volume: 0.25 });
    } else if (style === "water") {
      const out = this._out(this._gain(p, 0.3));
      this._noiseBurst(out, { at, length: 0.18, from: 3000, to: 1200, type: "bandpass", q: 1.5, attack: 0.01 });
    } else if (style === "boom") {
      const out = this._out(this._gain(p, 1));
      this._noiseBurst(out, { at, length: 1.2, from: 900, to: 40, q: 0.5 });
      this._tone(out, { at, length: 0.9, from: 90, to: 30, volume: 0.9 });
    } else {
      const out = this._out(this._gain(p, 0.8));
      this._noiseBurst(out, { at, length: 0.09, from: 9000, to: 1500, q: 0.4, type: "highpass" });
      this._noiseBurst(out, { at, length: 0.35, from: 2400, to: 90, q: 0.8 });
      this._tone(out, { at, length: 0.16, from: 160, to: 45, volume: 0.8 });
    }
  }

  // A physics contact at p: a clang (metal), knock (wood), thud (stone, glass) or thump (anything else), louder and
  // longer with the impulse (N*s). materials: the two sides of the contact, as the physics world names them.
  hit(p = null, { impulse = 1, materials = [] } = {}) {
    const ctx = this._ctx();
    if (!ctx) return;
    const at = ctx.currentTime;
    const k = Math.min(1, 0.15 + 0.2 * Math.sqrt(Math.max(0, impulse)));
    const has = (m) => Array.isArray(materials) && materials.includes(m);
    if (has("metal") || has("gold")) {
      const out = this._out(this._gain(p, 0.45 * k));
      const ring = has("soft") || has("rubber") || has("flesh") ? 0.08 : 0.2 + 0.12 * k;
      this._noiseBurst(out, { at, length: 0.03, from: 6000, to: 2000, type: "highpass", q: 0.5 });
      this._tone(out, { at, length: ring, from: 2300, to: 2200, type: "triangle", volume: 0.5 });
      this._tone(out, { at, length: ring * 0.7, from: 3400, to: 3300, volume: 0.25 });
    } else if (has("wood")) {
      const out = this._out(this._gain(p, 0.5 * k));
      this._noiseBurst(out, { at, length: 0.06 + 0.04 * k, from: 1400, to: 250, q: 0.9 });
      this._tone(out, { at, length: 0.09, from: 220, to: 120, volume: 0.6 });
    } else if (has("stone") || has("glass")) {
      const out = this._out(this._gain(p, 0.5 * k));
      this._noiseBurst(out, { at, length: 0.08 + 0.05 * k, from: 900, to: 150, q: 0.6 });
      this._tone(out, { at, length: 0.12, from: 120, to: 55, volume: 0.7 });
    } else {
      const out = this._out(this._gain(p, 0.3 * k));
      this._noiseBurst(out, { at, length: 0.07 + 0.04 * k, from: 500, to: 120, q: 0.5, attack: 0.006 });
    }
  }

  // Bullet hitting something: a short thwack.
  impact(p = null) {
    const ctx = this._ctx();
    if (!ctx) return;
    const out = this._out(this._gain(p, 0.25));
    this._noiseBurst(out, { at: ctx.currentTime, length: 0.07, from: 2500, to: 300, q: 1 });
  }

  // Rubber chicken: a rising and falling rubbery squawk.
  squeak(p = null, long = false) {
    const ctx = this._ctx();
    if (!ctx) return;
    const at = ctx.currentTime;
    const out = this._out(this._gain(p, 0.3));
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1400;
    filter.Q.value = 2.5;
    filter.connect(out);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const length = long ? 0.75 : 0.32;
    const base = 520 + Math.random() * 160;
    osc.frequency.setValueAtTime(base, at);
    osc.frequency.linearRampToValueAtTime(base * 2.3, at + length * 0.3);
    osc.frequency.linearRampToValueAtTime(base * 1.5, at + length * 0.7);
    osc.frequency.linearRampToValueAtTime(base * 0.9, at + length);
    const vib = ctx.createOscillator();
    vib.frequency.value = 28;
    const vibGain = ctx.createGain();
    vibGain.gain.value = 40;
    vib.connect(vibGain).connect(osc.frequency);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(1, at + 0.02);
    env.gain.setValueAtTime(1, at + length * 0.8);
    env.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(env).connect(filter);
    osc.start(at);
    vib.start(at);
    osc.stop(at + length + 0.05);
    vib.stop(at + length + 0.05);
  }

  // Popcorn and other pieces spilling: a few soft ticks.
  pops(p = null, count = 3) {
    const ctx = this._ctx();
    if (!ctx) return;
    const out = this._out(this._gain(p, 0.12));
    for (let i = 0; i < Math.min(6, count); i++) {
      this._noiseBurst(out, { at: ctx.currentTime + i * (0.02 + Math.random() * 0.05), length: 0.03, from: 4000, to: 1500, type: "bandpass", q: 2 });
    }
  }
}
