// Bridge settings: data folder location, config.json defaults and validation, room key.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULTS = {
  roomName: "Training Room",
  port: 8787,
  httpPort: 8788,
  roomKey: "",
  provider: "ollama",
  ollamaUrl: "http://127.0.0.1:11434",
  openaiUrl: "http://127.0.0.1:1234/v1",
  openaiKey: "",
  model: "",
  visionModel: "",
  think: false,
  numCtx: 8192,
  sttKind: "whisper.cpp",
  sttUrl: "http://127.0.0.1:8080/inference",
  sttModel: "whisper-1",
  sttLanguage: "en",
  sttPrompt: "AI, spawn a villa to my left, an axe in my hand, a deck of playing cards on a card table, training dummy, whiteboard, make it real, undo.",
  ttsKind: "none",
  ttsUrl: "",
  ttsVoice: "af_heart",
  ttsModel: "kokoro",
  partsDirs: [],
  allowOrigins: ["https://dot0m0peg-arch.github.io"],
};

export const HELP = "Training Room bridge settings. Restart the bridge after editing. roomName: room name the bridge reports to devices; port: HTTPS port for the headset/phone on your network; httpPort: plain HTTP on this laptop only (also for adb reverse); roomKey: code other devices need (delete it to get a new one); provider: \"ollama\" or \"openai\" (LM Studio or any OpenAI-compatible server at openaiUrl); ollamaUrl: Ollama's address; openaiUrl: the OpenAI-compatible server's address (LM Studio: http://127.0.0.1:1234/v1); openaiKey: bearer key for provider \"openai\" (\"\" for none); model: \"\" picks an installed model automatically (names with \"coder\", then \"qwen\"); visionModel: \"\" picks an installed vision model (llava, qwen2.5vl, gemma3 and others) that looks at magic-marker drawings, else the text model reads them as ASCII art; think: false turns hidden reasoning off for faster answers, true on, null leaves the model default; numCtx: model context size in tokens, 2048-262144 (lower uses less memory; the bridge shortens its prompt to fit); sttKind: \"whisper.cpp\" (whisper-server at sttUrl), \"openai\" (an /v1/audio/transcriptions URL) or \"none\"; sttModel: model name sent to an \"openai\" transcription server; sttLanguage: language code such as \"en\" (\"\" sends none, so the server's own setting applies); sttPrompt: words that help Whisper spell commands and part names (\"\" turns it off); ttsKind: \"none\" (the headset's own browser voice), \"piper\" (piper1-gpl HTTP server at ttsUrl, default http://127.0.0.1:5000) or \"openai\" (Kokoro-FastAPI, speaches or any /v1/audio/speech URL, default http://127.0.0.1:8880/v1/audio/speech) speaks the AI's replies with a laptop voice; ttsVoice/ttsModel: voice and model for \"openai\"; partsDirs: extra folders with parts (blueprint .json, .glb/.gltf, .js; relative paths start in the data folder); allowOrigins: web pages allowed to call this bridge from another site.";

// Room key alphabet without look-alikes (no I, O, 0, 1).
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const KEY_LENGTH = 10; // 32^10 ≈ 10^15 keys; shorter stored keys still work

export function generateRoomKey(length = KEY_LENGTH) {
  let out = "";
  for (let i = 0; i < length; i++) out += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
  return out;
}

export function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.TRAINING_ROOM_DATA) return path.resolve(env.TRAINING_ROOM_DATA);
  if (platform === "win32") return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "dot-training-room");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "dot-training-room");
}

export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const isPort = (v) => Number.isInteger(v) && v >= 0 && v <= 65535;
const cleanUrl = (v) => {
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    return /^https?:$/.test(new URL(v.trim()).protocol) ? v.trim().replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
};

// Merges user values over defaults, replacing anything malformed. Returns { config, problems }.
export function sanitizeConfig(raw = {}) {
  const problems = [];
  const c = {};
  // value: the cleaned user value, or null/undefined when missing or invalid.
  const take = (key, value) => {
    if (value === null || value === undefined) {
      if (raw[key] !== undefined && raw[key] !== "") problems.push(key);
      c[key] = Array.isArray(DEFAULTS[key]) ? [...DEFAULTS[key]] : DEFAULTS[key];
    } else {
      c[key] = value;
    }
  };
  const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : null);
  take("roomName", str(raw.roomName, 40) || null);
  take("port", isPort(raw.port) ? raw.port : null);
  take("httpPort", isPort(raw.httpPort) ? raw.httpPort : null);
  take("roomKey", typeof raw.roomKey === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(raw.roomKey.trim()) ? raw.roomKey.trim().toUpperCase() : null);
  take("provider", raw.provider === "openai" || raw.provider === "ollama" ? raw.provider : null);
  take("ollamaUrl", cleanUrl(raw.ollamaUrl));
  take("openaiUrl", cleanUrl(raw.openaiUrl));
  take("openaiKey", str(raw.openaiKey, 400));
  take("model", str(raw.model, 200));
  take("visionModel", str(raw.visionModel, 200));
  take("think", typeof raw.think === "boolean" || raw.think === undefined ? raw.think : undefined);
  if (raw.think === null) {
    problems.splice(problems.indexOf("think"), 1);
    c.think = null; // null = leave the model's own default
  }
  take("numCtx", Number.isInteger(raw.numCtx) && raw.numCtx >= 2048 && raw.numCtx <= 262144 ? raw.numCtx : null);
  take("sttKind", ["whisper.cpp", "openai", "none"].includes(raw.sttKind) ? raw.sttKind : null);
  take("sttUrl", cleanUrl(raw.sttUrl));
  take("sttModel", str(raw.sttModel, 200) || null);
  take("sttLanguage", typeof raw.sttLanguage === "string" && /^[a-z-]{0,8}$/i.test(raw.sttLanguage.trim()) ? raw.sttLanguage.trim() : null);
  take("sttPrompt", str(raw.sttPrompt, 400));
  take("ttsKind", ["none", "piper", "openai"].includes(raw.ttsKind) ? raw.ttsKind : null);
  take("ttsUrl", cleanUrl(raw.ttsUrl)); // "" = the default URL for ttsKind
  take("ttsVoice", str(raw.ttsVoice, 100) || null);
  take("ttsModel", str(raw.ttsModel, 200) || null);
  take("partsDirs", Array.isArray(raw.partsDirs) ? raw.partsDirs.filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim()) : null);
  take("allowOrigins", Array.isArray(raw.allowOrigins)
    ? raw.allowOrigins.map((o) => (typeof o === "string" ? o.trim().replace(/\/+$/, "") : "")).filter((o) => /^https?:\/\/[^/\s]+$/.test(o))
    : null);
  return { config: c, problems };
}

// mkdir/writeFile modes only apply to new paths: also tighten ones made by older versions.
function tighten(target, mode) {
  if (process.platform === "win32") return; // the profile folder's ACLs already protect it
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Not ours to change (e.g. a shared folder); keep going.
  }
}

// Reads <dataDir>/config.json (creating it on first run, adding new keys and a room key).
// A file that is not valid JSON is left untouched and defaults are used for this run.
export function loadConfig(dataDir, { log = console } = {}) {
  const file = path.join(dataDir, "config.json");
  // Owner-only: config.json holds the room key (and maybe openaiKey), room.json the room.
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let raw = {};
  let exists = fs.existsSync(file);
  tighten(dataDir, 0o700);
  if (exists) tighten(file, 0o600);
  let broken = false;
  if (exists) {
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
    } catch (err) {
      broken = true;
      log.warn?.(`[config] ${file} is not valid JSON (${err.message}). Using defaults this time; fix or delete the file.`);
      raw = {};
    }
  }
  const { config, problems } = sanitizeConfig(raw);
  for (const key of problems) log.warn?.(`[config] ignoring invalid "${key}" in ${file}; using ${JSON.stringify(config[key])}`);
  let changed = !exists;
  if (!config.roomKey) {
    config.roomKey = generateRoomKey();
    changed = true;
  }
  for (const key of Object.keys(DEFAULTS)) if (!(key in raw)) changed = true;
  if (changed && !broken) {
    const out = { _help: HELP };
    for (const key of Object.keys(DEFAULTS)) out[key] = key in raw && !problems.includes(key) ? raw[key] : config[key];
    out.roomKey = config.roomKey;
    for (const [key, value] of Object.entries(raw)) if (!(key in out)) out[key] = value;
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  }
  return { config, file, created: !exists, broken };
}
