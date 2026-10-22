// PCM helpers used by push-to-talk: WAV header, sample conversion, resampling, trimming.
import test from "node:test";
import assert from "node:assert/strict";
import { rms, resampleLinear, encodeWav, concatFloat32, trimSilence, wavInfo } from "../js/voice/wav.js";

const ascii = (view, offset) => String.fromCharCode(...new Uint8Array(view.buffer, offset, 4));

test("encodeWav writes a canonical 16-bit mono PCM header", () => {
  const samples = new Float32Array(100);
  const buffer = encodeWav(samples, 16000);
  assert.ok(buffer instanceof ArrayBuffer);
  assert.equal(buffer.byteLength, 44 + 200);
  const view = new DataView(buffer);
  assert.equal(ascii(view, 0), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + 200);
  assert.equal(ascii(view, 8), "WAVE");
  assert.equal(ascii(view, 12), "fmt ");
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1, "PCM");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000, "byte rate");
  assert.equal(view.getUint16(32, true), 2, "block align");
  assert.equal(view.getUint16(34, true), 16, "bits");
  assert.equal(ascii(view, 36), "data");
  assert.equal(view.getUint32(40, true), 200);
  assert.deepEqual(wavInfo(buffer), { format: 1, channels: 1, sampleRate: 16000, bits: 16, dataBytes: 200, frames: 100 });
});

test("encodeWav converts and clips samples", () => {
  const buffer = encodeWav(Float32Array.from([0, 1, -1, 0.5, -0.5, 2, -3, NaN]), 8000);
  const view = new DataView(buffer);
  const at = (i) => view.getInt16(44 + i * 2, true);
  assert.equal(at(0), 0);
  assert.equal(at(1), 32767);
  assert.equal(at(2), -32768);
  assert.equal(at(3), Math.round(0.5 * 32767));
  assert.equal(at(4), -16384);
  assert.equal(at(5), 32767, "clipped high");
  assert.equal(at(6), -32768, "clipped low");
  assert.equal(at(7), 0, "NaN becomes silence");
});

test("encodeWav handles empty input and rejects bad rates", () => {
  const buffer = encodeWav(new Float32Array(0), 16000);
  assert.equal(buffer.byteLength, 44);
  assert.equal(wavInfo(buffer).frames, 0);
  assert.throws(() => encodeWav(new Float32Array(4), 0), RangeError);
  assert.equal(wavInfo(new ArrayBuffer(10)), null);
  assert.equal(wavInfo(new TextEncoder().encode("x".repeat(64)).buffer), null);
});

test("rms and concatFloat32", () => {
  assert.equal(rms(new Float32Array(0)), 0);
  assert.equal(rms(Float32Array.from([0.5, -0.5, 0.5, -0.5])), 0.5);
  const sine = new Float32Array(48000);
  for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
  assert.ok(Math.abs(rms(sine) - Math.SQRT1_2) < 1e-3);
  const joined = concatFloat32([Float32Array.from([1, 2]), new Float32Array(0), Float32Array.from([3])]);
  assert.deepEqual([...joined], [1, 2, 3]);
  assert.equal(concatFloat32([]).length, 0);
});

test("resampleLinear output lengths", () => {
  assert.equal(resampleLinear(new Float32Array(48000), 48000, 16000).length, 16000);
  assert.equal(resampleLinear(new Float32Array(44100), 44100, 16000).length, 16000);
  assert.equal(resampleLinear(new Float32Array(441), 44100, 16000).length, 160);
  assert.equal(resampleLinear(new Float32Array(8000), 8000, 16000).length, 16000);
  assert.equal(resampleLinear(new Float32Array(0), 48000, 16000).length, 0);
  const same = Float32Array.from([0.1, 0.2]);
  const copy = resampleLinear(same, 16000, 16000);
  assert.deepEqual([...copy], [...same]);
  assert.notEqual(copy, same, "returns a copy");
  assert.throws(() => resampleLinear(same, 0, 16000), RangeError);
});

test("resampleLinear keeps DC and low tones, interpolates upsampling", () => {
  const dc = new Float32Array(4800).fill(0.25);
  for (const v of resampleLinear(dc, 48000, 16000)) assert.ok(Math.abs(v - 0.25) < 1e-6);

  // 200 Hz tone survives 48k → 16k with nearly the same amplitude and phase.
  const n = 4800;
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) tone[i] = 0.8 * Math.sin((2 * Math.PI * 200 * i) / 48000);
  const down = resampleLinear(tone, 48000, 16000);
  for (let i = 10; i < down.length - 10; i++) {
    const expected = 0.8 * Math.sin((2 * Math.PI * 200 * i) / 16000);
    assert.ok(Math.abs(down[i] - expected) < 0.01, `sample ${i}: ${down[i]} vs ${expected}`);
  }

  // A 7 kHz tone at 48 kHz is attenuated by the box filter instead of passing at full level.
  const high = new Float32Array(n);
  for (let i = 0; i < n; i++) high[i] = Math.sin((2 * Math.PI * 7000 * i) / 48000);
  assert.ok(rms(resampleLinear(high, 48000, 16000)) < rms(high) * 0.75);

  const up = resampleLinear(Float32Array.from([0, 1, 0]), 8000, 16000);
  assert.equal(up.length, 6);
  assert.deepEqual([...up].map((v) => Math.round(v * 100) / 100), [0, 0.5, 1, 0.5, 0, 0]);
});

test("trimSilence keeps the voiced part with padding", () => {
  const rate = 16000;
  const audio = new Float32Array(rate); // 1 s
  for (let i = 8000; i < 9600; i++) audio[i] = 0.3 * Math.sin(i / 3); // 0.5 s → 0.6 s
  const trimmed = trimSilence(audio, rate, 0.01, { padSec: 0.1 });
  assert.ok(trimmed.length >= 1600 && trimmed.length <= 1600 + 2 * 1600 + 640, `length ${trimmed.length}`);
  assert.ok(rms(trimmed) > rms(audio));
  assert.equal(trimSilence(new Float32Array(rate), rate, 0.01).length, 0);
});
