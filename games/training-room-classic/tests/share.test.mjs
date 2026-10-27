// Share viewer side in Node: frames become textures; ended streams no screen shows are freed.
import test from "node:test";
import assert from "node:assert/strict";
import { Share } from "../js/net/share.js";

test("prune frees ended streams that no screen shows and keeps the rest", async () => {
  const closed = [];
  const bitmap = (n) => ({ width: 1280, height: 720, close: () => closed.push(n) });
  let decoded = 0;
  globalThis.createImageBitmap = async () => bitmap(++decoded);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, blob: async () => ({}), headers: { get: () => null } });
  try {
    const share = new Share({ net: { frameUrl: (stream, n) => `/f/${stream}/${n}` } });
    const textures = {};
    for (const stream of ["shown", "gone", "live"]) {
      textures[stream] = share.textureFor(stream);
      share.handle({ stream, active: true, n: 1 });
    }
    await new Promise((r) => setTimeout(r, 10)); // frames fetched and shown
    const disposed = [];
    for (const [stream, texture] of Object.entries(textures)) texture.addEventListener("dispose", () => disposed.push(stream));
    share.handle({ stream: "shown", active: false });
    share.handle({ stream: "gone", active: false });
    share.prune(new Set(["shown"]));
    assert.deepEqual(disposed, ["gone"], "only the ended stream without a screen is freed");
    assert.equal(closed.length, 1, "its last frame is closed");
    assert.equal(share.textureFor("shown"), textures.shown, "an ended stream on a screen keeps its last frame");
    assert.equal(share.textureFor("live"), textures.live, "a live stream is never pruned");
    assert.notEqual(share.textureFor("gone"), textures.gone, "a later screen gets a fresh (black) texture");
    share.prune(new Set());
    assert.deepEqual(disposed.sort(), ["gone", "shown"]);
  } finally {
    delete globalThis.createImageBitmap;
    globalThis.fetch = realFetch;
  }
});
