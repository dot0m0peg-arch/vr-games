// Voice microphone lifecycle with fake getUserMedia / AudioContext: mute and mode switches while
// the mic is still opening must neither leave it deaf nor leave it open.
import test from "node:test";
import assert from "node:assert/strict";
import { Voice } from "../js/voice/voice.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

class FakeTrack {
  constructor() {
    this.readyState = "live";
  }
  stop() {
    this.readyState = "ended";
  }
  addEventListener() {}
}

class FakeStream {
  constructor() {
    this.tracks = [new FakeTrack()];
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

// resumeGate: a deferred that holds ctx.resume() pending; resumeStarted resolves once it is called.
function makeCtx({ state = "running", resumeGate = null } = {}) {
  const made = [];
  const resumeStarted = deferred();
  const node = () => ({ connect() {}, disconnect() {} });
  class FakeCtx {
    constructor() {
      this.state = state;
      this.sampleRate = 48000;
      this.destination = {};
      made.push(this);
    }
    createMediaStreamSource() {
      return node();
    }
    createGain() {
      return { ...node(), gain: { value: 1 } };
    }
    createScriptProcessor() {
      return { ...node(), onaudioprocess: null };
    }
    resume() {
      resumeStarted.resolve();
      const done = () => {
        if (this.state !== "closed") this.state = "running";
      };
      return resumeGate ? resumeGate.promise.then(done) : Promise.resolve(done());
    }
    close() {
      this.state = "closed";
      return Promise.resolve();
    }
  }
  return { FakeCtx, made, resumeStarted };
}

// getUserMedia stays pending until the test resolves it (a slow Bluetooth mic or a permission prompt).
function setup({ ctx = makeCtx(), idleReleaseMs = 30000 } = {}) {
  const pending = [];
  const streams = [];
  const voice = new Voice({
    transcribe: async () => ({ text: "AI, spawn a crate" }),
    getUserMedia: () => {
      const d = deferred();
      pending.push(d);
      return d.promise;
    },
    AudioContextImpl: ctx.FakeCtx,
    SpeechRecognitionImpl: null,
    idleReleaseMs,
  });
  const errors = [];
  voice.on("error", (message) => errors.push(message));
  const grant = () => {
    for (const d of pending.splice(0)) {
      const stream = new FakeStream();
      streams.push(stream);
      d.resolve(stream);
    }
  };
  return { voice, errors, grant, streams, ctx };
}

const liveTracks = (streams) => streams.filter((s) => s.tracks.some((t) => t.readyState === "live")).length;

test("wake → off while the mic is opening releases it", async () => {
  const { voice, errors, grant, streams } = setup();
  voice.setMode("wake");
  voice.setMode("off");
  grant();
  await sleep(10);
  assert.equal(voice.mode, "off");
  assert.equal(voice.micOpen, false);
  assert.equal(liveTracks(streams), 0);
  assert.deepEqual(errors, []);
});

test("wake → off → wake while the mic is opening ends up listening", async () => {
  const { voice, errors, grant, streams } = setup();
  voice.setMode("wake");
  voice.setMode("off");
  voice.setMode("wake");
  grant();
  await sleep(10);
  assert.deepEqual([voice.mode, voice.micOpen, voice.listening], ["wake", true, true]);
  assert.equal(liveTracks(streams), 1, "only the newest stream stays live");
  assert.equal(voice._opening, null);
  assert.deepEqual(errors, []);

  // Impatient presses: wake/off/wake/off/wake.
  const b = setup();
  for (const mode of ["wake", "off", "wake", "off", "wake"]) b.voice.setMode(mode);
  b.grant();
  await sleep(10);
  assert.deepEqual([b.voice.mode, b.voice.micOpen, b.voice.listening], ["wake", true, true]);
  assert.equal(liveTracks(b.streams), 1);
});

test("prepare → off → push, then hold talk while the mic is opening starts recording", async () => {
  const { voice, errors, grant } = setup();
  voice.prepare();
  voice.setMode("off");
  voice.setMode("push");
  const pressed = voice.pressTalk();
  grant();
  assert.equal(await pressed, true);
  assert.ok(voice._rec, "recording");
  assert.equal(voice.micOpen, true);
  assert.deepEqual(errors, []);
});

test("mute while the AudioContext is resuming closes the mic", async () => {
  for (const [label, mute] of [
    ["setMode off", (v) => v.setMode("off")],
    ["dispose", (v) => v.dispose()],
  ]) {
    const gate = deferred();
    const ctx = makeCtx({ state: "suspended", resumeGate: gate });
    const { voice, errors, grant, streams } = setup({ ctx });
    voice.setMode("wake");
    grant();
    await ctx.resumeStarted.promise;
    mute(voice);
    gate.resolve();
    await sleep(10);
    assert.equal(voice.micOpen, false, label);
    assert.equal(liveTracks(streams), 0, `${label}: track stopped`);
    assert.equal(ctx.made[0].state, "closed", `${label}: context closed`);
    assert.deepEqual(errors, [], label);
  }

  // Push press muted during resume: no recording, mic closed.
  const gate = deferred();
  const ctx = makeCtx({ state: "suspended", resumeGate: gate });
  const { voice, grant, streams } = setup({ ctx });
  const pressed = voice.pressTalk();
  grant();
  await ctx.resumeStarted.promise;
  voice.setMode("off");
  gate.resolve();
  assert.equal(await pressed, false);
  assert.equal(voice.micOpen, false);
  assert.equal(liveTracks(streams), 0);
});

test("wake → push while the mic is opening still releases it after the idle window", async () => {
  const { voice, grant, streams } = setup({ idleReleaseMs: 30 });
  voice.setMode("wake");
  voice.setMode("push");
  grant();
  await sleep(5);
  assert.equal(voice.micOpen, true, "opened");
  await sleep(80);
  assert.equal(voice.mode, "push");
  assert.equal(voice.micOpen, false, "released after idleReleaseMs");
  assert.equal(liveTracks(streams), 0);

  // Staying in wake keeps it open.
  const b = setup({ idleReleaseMs: 30 });
  b.voice.setMode("wake");
  b.grant();
  await sleep(80);
  assert.deepEqual([b.voice.mode, b.voice.micOpen], ["wake", true]);
});
