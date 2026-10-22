// Shared laptop screen / phone camera on in-world screens. The sharer uploads JPEG frames to the
// bridge (≤ 8 fps, one upload in flight); viewers fetch the newest frame per "share" event and show
// it on a THREE.Texture per stream. Events: started (stream), frame (stream), ended (stream, { local }).
import * as THREE from "../../vendor/three.module.min.js";
import { Emitter } from "../util/emitter.js";
import { randomString } from "../util/ids.js";
import { makeCanvas } from "../util/text.js";

const MAX_WIDTH = 1280;
const FPS = 8;
const QUALITY = 0.6;

function friendly(err, kind) {
  const name = err?.name || "";
  if (name === "NotAllowedError" || name === "AbortError") return kind === "screen" ? "Screen sharing was cancelled." : "Camera access was cancelled or blocked.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera found.";
  if (name === "NotReadableError") return "The camera is busy in another app.";
  return err?.message || "Sharing failed.";
}

export class Share extends Emitter {
  constructor({ net }) {
    super();
    this.net = net;
    this._media = null;
    this._kind = null;
    this._stream = null;
    this._video = null;
    this._canvas = null;
    this._timer = 0;
    this._uploading = false;
    this._sent = 0;
    this._viewers = new Map(); // stream → { texture, latest, shown, busy, bitmap }
  }

  get active() {
    return !!this._media;
  }

  get kind() {
    return this._kind;
  }

  // Id of this device's outgoing stream (null when not sharing).
  get stream() {
    return this._stream;
  }

  get framesSent() {
    return this._sent;
  }

  // kind: "screen" (getDisplayMedia) | "camera" (back camera). → stream id
  async start(kind = "screen") {
    if (kind !== "screen" && kind !== "camera") throw new Error(`Unknown share kind "${kind}".`);
    const devices = globalThis.navigator?.mediaDevices;
    if (kind === "screen" && !devices?.getDisplayMedia) throw new Error("Screen sharing is not supported in this browser.");
    if (kind === "camera" && !devices?.getUserMedia) throw new Error("Camera sharing needs a secure page (https) and a camera.");
    if (this._media) this.stop();
    let media;
    try {
      media = kind === "screen"
        ? await devices.getDisplayMedia({ video: { frameRate: 10 }, audio: false })
        : await devices.getUserMedia({ video: { facingMode: "environment", width: 1280 }, audio: false });
    } catch (err) {
      throw new Error(friendly(err, kind));
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.srcObject = media;
    try {
      await video.play();
    } catch (err) {
      for (const track of media.getTracks()) track.stop();
      throw new Error(friendly(err, kind));
    }
    const stream = `s${randomString(8)}`;
    this._media = media;
    this._kind = kind;
    this._stream = stream;
    this._video = video;
    this._sent = 0;
    this._canvas = this._canvas || document.createElement("canvas");
    // The browser's own "Stop sharing" button (or unplugging the camera) ends the track.
    for (const track of media.getVideoTracks()) track.addEventListener("ended", () => this._media === media && this.stop());
    this._timer = setInterval(() => this._capture(stream), 1000 / FPS);
    this._capture(stream);
    this.emit("started", stream);
    return stream;
  }

  stop() {
    const media = this._media;
    if (!media) return;
    const stream = this._stream;
    this._media = null;
    this._kind = null;
    this._stream = null;
    clearInterval(this._timer);
    this._timer = 0;
    for (const track of media.getTracks()) track.stop();
    if (this._video) {
      this._video.pause();
      this._video.srcObject = null;
      this._video = null;
    }
    try {
      Promise.resolve(this.net.stopShare(stream)).catch((err) => console.warn("[share] stop failed", err));
    } catch (err) {
      console.warn("[share] stop failed", err);
    }
    this.emit("ended", stream, { local: true });
  }

  async _capture(stream) {
    if (this._uploading || this._stream !== stream) return;
    const video = this._video;
    const w0 = video?.videoWidth || 0;
    const h0 = video?.videoHeight || 0;
    if (!w0 || !h0) return;
    const scale = Math.min(1, MAX_WIDTH / w0);
    const w = Math.max(2, Math.round(w0 * scale));
    const h = Math.max(2, Math.round(h0 * scale));
    const canvas = this._canvas;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    this._uploading = true;
    try {
      canvas.getContext("2d").drawImage(video, 0, 0, w, h);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
      if (blob && this._stream === stream) {
        await this.net.postFrame(stream, blob);
        this._sent++;
      }
    } catch (err) {
      console.warn("[share] frame upload failed", err?.message || err);
    } finally {
      this._uploading = false;
    }
  }

  // ---------- viewer side ----------

  // Feed every net "share" event here: { stream, user, active, n }.
  handle(event) {
    const stream = event?.stream;
    if (!stream || typeof stream !== "string") return;
    if (event.active === false) {
      const viewer = this._viewers.get(stream);
      if (viewer) viewer.ended = true;
      this.emit("ended", stream, { local: false });
      return;
    }
    const viewer = this._viewer(stream);
    viewer.ended = false;
    const n = Number(event.n) || 0;
    if (n > viewer.latest) viewer.latest = n;
    if (!viewer.busy) this._pull(stream, viewer);
  }

  // Texture for a stream (black until the first frame). Screen parts call setScreen(texture).
  textureFor(stream) {
    if (!stream) return null;
    return this._viewer(stream).texture;
  }

  dispose() {
    this.stop();
    for (const viewer of this._viewers.values()) {
      viewer.disposed = true;
      viewer.bitmap?.close?.();
      viewer.texture.dispose();
    }
    this._viewers.clear();
  }

  _viewer(stream) {
    let viewer = this._viewers.get(stream);
    if (!viewer) {
      const black = makeCanvas(2, 2);
      if (black) {
        const ctx = black.getContext("2d");
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, 2, 2);
      }
      const texture = black ? new THREE.Texture(black) : new THREE.Texture();
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      texture.name = `share:${stream}`;
      if (black) texture.needsUpdate = true;
      viewer = { stream, texture, latest: 0, shown: 0, busy: false, ended: false, disposed: false, bitmap: null, w: 2, h: 2 };
      this._viewers.set(stream, viewer);
    }
    return viewer;
  }

  // Fetches frames one at a time, always jumping to the newest announced frame.
  async _pull(stream, viewer) {
    viewer.busy = true;
    try {
      while (viewer.latest > viewer.shown && !viewer.disposed) {
        const n = viewer.latest;
        const res = await fetch(this.net.frameUrl(stream, n), { credentials: "include" });
        if (!res.ok) {
          viewer.shown = n; // missing frame (stream stopped): wait for the next announcement
          break;
        }
        const blob = await res.blob();
        const image = await decode(blob);
        if (viewer.disposed) {
          image.close?.();
          break;
        }
        this._show(viewer, image);
        viewer.shown = Math.max(viewer.shown, Number(res.headers.get("x-frame-n")) || n);
        this.emit("frame", stream);
      }
    } catch (err) {
      console.warn("[share] frame fetch failed", err?.message || err);
    } finally {
      viewer.busy = false;
    }
  }

  _show(viewer, image) {
    const texture = viewer.texture;
    const w = image.width;
    const h = image.height;
    // Size changes need fresh GPU storage; same-size frames are re-uploaded in place.
    if (w !== viewer.w || h !== viewer.h) {
      texture.dispose();
      viewer.w = w;
      viewer.h = h;
    }
    const previous = viewer.bitmap;
    texture.image = image;
    texture.flipY = !image.close; // ImageBitmaps are flipped at decode time
    texture.needsUpdate = true;
    viewer.bitmap = image.close ? image : null;
    if (previous && previous !== image) previous.close();
  }
}

// Blob → ImageBitmap (flipped for WebGL) or, without createImageBitmap, an HTMLImageElement.
async function decode(blob) {
  if (typeof globalThis.createImageBitmap === "function") {
    try {
      return await globalThis.createImageBitmap(blob, { imageOrientation: "flipY" });
    } catch {
      // Older engines reject the options bag.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}
