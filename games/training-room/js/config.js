// Runtime configuration: device detection, bridge location, wake words, stored settings.
export const PARAMS = new URLSearchParams(location.search);

export const WAKE_WORDS = ["ai", "a.i.", "a i", "hey ai", "okay ai", "ok ai", "eh i", "ay"];
export const ACCENT = "#d5fb6a";

// "headset" | "phone" | "desktop" (override with ?device=phone for testing).
export function detectDevice() {
  const forced = PARAMS.get("device");
  if (["headset", "phone", "desktop", "laptop"].includes(forced)) return forced === "laptop" ? "desktop" : forced;
  const ua = navigator.userAgent || "";
  if (/OculusBrowser|Quest|Pico|Wolvic|MobileVR|HTC Vive/i.test(ua)) return "headset";
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  if (/Android|iPhone|iPod|Mobile/i.test(ua) || (coarse && /iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "phone";
  return "desktop";
}

// API base of the laptop bridge. Same origin when the game is served by the bridge;
// ?bridge=https://192.168.1.20:8787 points a GitHub Pages copy at a laptop instead.
export function apiBase() {
  const remote = PARAMS.get("bridge");
  if (remote) {
    try {
      return new URL("vr-games/games/training-room/api/", remote.endsWith("/") ? remote : `${remote}/`).href;
    } catch {
      console.warn("[config] ignoring invalid ?bridge=", remote);
    }
  }
  return new URL("api/", location.href).href;
}

export function isRemoteBridge() {
  return !!PARAMS.get("bridge");
}

export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or storage full: settings simply do not persist.
  }
}
