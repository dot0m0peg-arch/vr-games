// PCM helpers for push-to-talk audio: level, resampling, WAV encoding. Pure (no DOM, no three.js),
// so the bridge and Node tests can import it.

// Root mean square of a Float32 sample block (0 for empty input).
export function rms(samples) {
  const n = samples?.length || 0;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / n);
}

// Joins Float32 chunks into one Float32Array.
export function concatFloat32(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// Linear-interpolation resampler. When downsampling, a moving-average (box) filter as wide as the
// rate ratio runs first so content above the new Nyquist frequency does not alias into speech.
export function resampleLinear(input, fromRate, toRate) {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError("sample rates must be positive");
  const n = input.length;
  if (fromRate === toRate) return Float32Array.from(input);
  const outLength = Math.max(0, Math.round((n * toRate) / fromRate));
  const out = new Float32Array(outLength);
  if (!n || !outLength) return out;
  const ratio = fromRate / toRate;
  let src = input;
  const width = Math.round(ratio);
  if (ratio > 1 && width > 1) {
    // Centered moving average of `width` samples (edges average what exists).
    src = new Float32Array(n);
    const half = Math.floor(width / 2);
    let sum = 0;
    let lo = 0;
    let hi = -1;
    for (let i = 0; i < n; i++) {
      const wantLo = Math.max(0, i - half);
      const wantHi = Math.min(n - 1, i - half + width - 1);
      while (hi < wantHi) sum += input[++hi];
      while (lo < wantLo) sum -= input[lo++];
      src[i] = sum / (hi - lo + 1);
    }
  }
  const last = n - 1;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.min(last, Math.floor(pos));
    const i1 = Math.min(last, i0 + 1);
    const frac = pos - i0;
    out[i] = src[i0] + (src[i1] - src[i0]) * frac;
  }
  return out;
}

// RIFF/WAVE, PCM 16-bit little-endian, mono. Samples outside [-1, 1] are clipped.
export function encodeWav(samples, sampleRate) {
  const rate = Math.round(sampleRate);
  if (!(rate > 0)) throw new RangeError("sampleRate must be positive");
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, n * 2, true);
  let offset = 44;
  for (let i = 0; i < n; i++) {
    let s = samples[i];
    if (!(s === s)) s = 0; // NaN → silence
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    view.setInt16(offset, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
    offset += 2;
  }
  return buffer;
}

// Reads a canonical WAV header → { sampleRate, channels, bits, format, dataBytes, frames } or null.
export function wavInfo(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bits: view.getUint16(offset + 22, true),
      };
    } else if (id === "data" && fmt) {
      const dataBytes = Math.min(size, bytes.length - offset - 8);
      return { ...fmt, dataBytes, frames: Math.floor(dataBytes / ((fmt.bits / 8) * fmt.channels || 1)) };
    }
    offset += 8 + size + (size & 1);
  }
  return null;
}

// Cuts leading/trailing silence (frames of `frameSec` whose RMS stays under threshold), keeping
// `padSec` around the voiced part. Returns a subarray view; empty when nothing is voiced.
export function trimSilence(samples, sampleRate, threshold = 0.01, { padSec = 0.15, frameSec = 0.02 } = {}) {
  const frame = Math.max(1, Math.round(sampleRate * frameSec));
  const frames = Math.ceil(samples.length / frame);
  let first = -1;
  let last = -1;
  for (let f = 0; f < frames; f++) {
    if (rms(samples.subarray(f * frame, Math.min(samples.length, (f + 1) * frame))) > threshold) {
      if (first < 0) first = f;
      last = f;
    }
  }
  if (first < 0) return samples.subarray(0, 0);
  const pad = Math.round(sampleRate * padSec);
  const start = Math.max(0, first * frame - pad);
  const end = Math.min(samples.length, (last + 1) * frame + pad);
  return samples.subarray(start, end);
}
