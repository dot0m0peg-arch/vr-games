#!/usr/bin/env node
// Training Room laptop bridge (Node.js 20+, no npm packages).
//
// Serves the game to your headset, phone and laptop, keeps them in one shared room, sends voice
// commands to a local model (Ollama or any OpenAI-compatible server such as LM Studio), forwards
// push-to-talk audio to a local Whisper server and serves your laptop parts bin.
//
// Start:
//   node server.mjs                      (from this folder; on Windows double-click start-bridge.cmd)
//   node server.mjs --open               also open the game in this laptop's browser
//
// Options (all optional; permanent settings live in config.json in the data folder):
//   --port <n>         HTTPS port for the headset/phone on your network (default 8787)
//   --http-port <n>    plain HTTP port on this laptop only, also used with adb reverse (default 8788)
//   --no-https         skip HTTPS (only this laptop, or a USB headset through adb reverse, can join)
//   --data <dir>       data folder (default %APPDATA%\dot-training-room on Windows,
//                      ~/.config/dot-training-room elsewhere; env TRAINING_ROOM_DATA also works)
//   --parts <dir>      main parts-bin folder (default <data>/parts; AI designs go to its generated/)
//   --model <name>     model to use, e.g. qwen2.5-coder:7b (default: picked from installed models)
//   --ollama <url>     Ollama address (default http://127.0.0.1:11434)
//   --open             open the laptop URL in the default browser
//   --verbose          log every request, including poses, frames and files
//   --help             show this help
//
// Joining:
//   Laptop:  http://localhost:8788/?k=KEY
//   Headset/phone on the same Wi-Fi: https://<laptop-ip>:8787/?k=KEY (or scan the QR code). The
//            certificate is self-signed: accept the browser warning once ("Advanced" → "Proceed").
//   Headset over USB without the warning: adb reverse tcp:8788 tcp:8788, then open
//            http://localhost:8788/?k=KEY in Quest Browser.
//   Windows asks whether Node.js may use the network the first time: allow Private networks.
//
// Local AI (optional; the game falls back to its built-in command parser):
//   Model:  install Ollama, then e.g. `ollama pull qwen2.5-coder:7b`. For LM Studio set
//           "provider": "openai" and "openaiUrl": "http://127.0.0.1:1234/v1" in config.json.
//   Voice:  run whisper.cpp's server, e.g. `whisper-server -m ggml-base.en.bin --port 8080`
//           (or set "sttKind": "openai" and "sttUrl" to an /v1/audio/transcriptions endpoint).
//
// Data folder contents: config.json (settings and room key), key.pem/cert.pem (HTTPS certificate,
// regenerated when your network address changes), room.json (the saved room), parts/ (your parts
// bin; see parts/README.txt). Nothing is written into the game's repository.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { allMeta } from "../js/parts/meta/index.js";
import { summarize } from "../js/core/room-state.js";
import { qrcode } from "../vendor/qrcode.mjs";
import { ensureCert, lanIPs } from "./cert.mjs";
import { createStatic, REPO_ROOT } from "./static.mjs";
import { RoomStore, BridgeError } from "./store.mjs";
import { PartsBin } from "./parts-bin.mjs";
import { LocalModel, catalogText, createMatcher } from "./llm.mjs";
import { SpeechToText, isWav } from "./stt.mjs";
import { loadConfig, defaultDataDir, isInside } from "./config.mjs";

export const VERSION = "1.0.0";
export const GAME_PATH = "/vr-games/games/training-room/";
const API_PREFIXES = [`${GAME_PATH}api/`, "/api/"];
const LIMITS = { json: 256 * 1024, frame: 4 * 1024 * 1024, audio: 8 * 1024 * 1024 };
const COOKIE_DAYS = 30;
// Calls that would flood the console; logged only with --verbose.
const QUIET = /^(pose|share\/[^/]+|parts\/file\/.*)$/;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

// ---------- small helpers ----------
function sendJSON(res, status, body, headers = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function noContent(res) {
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new BridgeError(413, { error: "too-large", limit }));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new BridgeError(413, { error: "too-large", limit }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

async function readJSON(req, limit = LIMITS.json) {
  const body = await readBody(req, limit);
  if (!body.length) return {};
  try {
    const json = JSON.parse(body.toString("utf8"));
    if (!json || typeof json !== "object") throw new Error("not an object");
    return json;
  } catch {
    throw new BridgeError(400, { error: "bad-json" });
  }
}

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    try {
      out[key] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      out[key] = part.slice(at + 1).trim();
    }
  }
  return out;
}

const time = () => new Date().toTimeString().slice(0, 8);

// Terminal QR code with half blocks; light modules are drawn, so it reads on dark terminals.
export function renderQR(text, { quiet = 2, ansi = false } = {}) {
  const qr = qrcode(0, "L");
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const light = (r, c) => r < 0 || c < 0 || r >= count || c >= count || !qr.isDark(r, c);
  const lines = [];
  for (let r = -quiet; r < count + quiet; r += 2) {
    let line = "";
    for (let c = -quiet; c < count + quiet; c++) {
      const top = light(r, c);
      const bottom = r + 1 < count + quiet ? light(r + 1, c) : false;
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(ansi ? `\x1b[97;40m${line}\x1b[0m` : line);
  }
  return lines.join("\n");
}

function openBrowser(url) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => console.log(`Open ${url} in your browser.`));
    child.unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

// ---------- the bridge ----------
// options: { dataDir, port, httpPort, https, partsDir, model, ollamaUrl, verbose, quiet, log,
//            root, host, store: { RoomStore options }, scanMs, modelTimeoutMs, fetchImpl, configOverrides }
export async function createBridge(options = {}) {
  const log = options.log || console;
  const dataDir = path.resolve(options.dataDir || defaultDataDir());
  if (isInside(REPO_ROOT, dataDir)) throw new Error(`The data folder ${dataDir} is inside the game repository; choose a folder outside it (--data).`);
  const { config, file: configFile } = loadConfig(dataDir, { log });
  Object.assign(config, options.configOverrides || {});
  if (options.port !== undefined) config.port = options.port;
  if (options.httpPort !== undefined) config.httpPort = options.httpPort;
  if (options.model) config.model = options.model;
  if (options.ollamaUrl) config.ollamaUrl = String(options.ollamaUrl).replace(/\/+$/, "");
  const useHttps = options.https !== false;
  const verbose = !!options.verbose;

  let partsPrimary = path.resolve(options.partsDir || path.join(dataDir, "parts"));
  const extraDirs = config.partsDirs.map((d) => path.resolve(dataDir, d));
  if (isInside(REPO_ROOT, partsPrimary)) {
    log.warn?.(`[parts] ${partsPrimary} is inside the repository; it is read, but new designs are saved to ${path.join(dataDir, "parts")}`);
    extraDirs.unshift(partsPrimary);
    partsPrimary = path.join(dataDir, "parts");
  }

  const store = new RoomStore({ dataDir, log, ...(options.store || {}) });
  const loaded = store.load();
  const bin = new PartsBin({ dirs: [partsPrimary, ...extraDirs], roomKey: config.roomKey, log, scanMs: options.scanMs || 10000 });
  bin.ensurePrimary();
  const model = new LocalModel(config, { log, fetchImpl: options.fetchImpl, timeoutMs: options.modelTimeoutMs || 25000 });
  const stt = new SpeechToText(config, { log, fetchImpl: options.fetchImpl });
  const statics = createStatic({ root: options.root || REPO_ROOT });
  const servers = [];
  const failures = new Map(); // ip -> { count, until } for wrong room keys
  let ports = { https: null, http: null };

  // Catalog for the model (built-in parts plus the laptop parts bin), rebuilt when the bin changes.
  let catalog = null;
  const getCatalog = () => {
    if (catalog) return catalog;
    const byName = new Map(allMeta().map((m) => [m.name, m]));
    for (const meta of bin.metas()) byName.set(meta.name, meta);
    const metas = [...byName.values()];
    catalog = { metas, text: catalogText(metas), match: createMatcher(metas) };
    return catalog;
  };
  bin.on("change", () => {
    catalog = null;
    store.broadcast("parts", { count: bin.count });
  });

  // ---------- auth ----------
  const keyDigest = () => crypto.createHash("sha256").update(config.roomKey.toUpperCase()).digest();
  const keyMatches = (candidate) => {
    if (typeof candidate !== "string" || !candidate.trim() || candidate.length > 128) return false;
    const digest = crypto.createHash("sha256").update(candidate.trim().toUpperCase()).digest();
    return crypto.timingSafeEqual(digest, keyDigest());
  };
  const isAuthed = (req, url) => {
    const cookie = parseCookies(req.headers.cookie).tr_key;
    return keyMatches(cookie) || keyMatches(req.headers["x-room-key"]) || keyMatches(url.searchParams.get("k"));
  };
  const throttled = (ip) => {
    const entry = failures.get(ip);
    return !!entry && entry.until > Date.now();
  };
  const noteFailure = (ip) => {
    const now = Date.now();
    const entry = failures.get(ip) || { count: 0, first: now, until: 0 };
    if (now - entry.first > 60000) Object.assign(entry, { count: 0, first: now });
    entry.count++;
    if (entry.count >= 30) entry.until = now + 60000;
    failures.set(ip, entry);
    if (failures.size > 1000) failures.delete(failures.keys().next().value);
  };

  const corsAllowed = (origin) => !!origin && origin !== "null" && (config.allowOrigins.includes(origin) || LOCAL_ORIGIN.test(origin));

  const lanUrls = () => (ports.https ? lanIPs().map((ip) => `https://${ip}:${ports.https}/`) : []);
  const laptopUrl = () => (ports.http ? `http://localhost:${ports.http}/` : ports.https ? `https://localhost:${ports.https}/` : null);
  const withKey = (url) => `${url}?k=${encodeURIComponent(config.roomKey)}`;

  // ---------- API ----------
  const userOf = (req, url, body) => body?.user || url.searchParams.get("user") || req.headers["x-user-id"] || null;

  async function api(req, res, route, url, ctx) {
    const method = req.method === "HEAD" ? "GET" : req.method;
    if (route === "hello" && method === "GET") {
      const authed = isAuthed(req, url);
      model.refresh().catch(() => {});
      const stt0 = stt.status();
      const body = {
        bridge: true,
        auth: authed,
        version: VERSION,
        name: config.roomName,
        model: authed ? model.status() : { available: model.available, name: model.name, provider: model.provider },
        stt: authed ? stt0 : { available: stt0.available, kind: stt0.kind },
        parts: { count: bin.count },
        lan: lanUrls(),
      };
      if (authed) {
        body.key = config.roomKey;
        body.laptop = laptopUrl();
      }
      return sendJSON(res, 200, body);
    }

    const parts = route.split("/");
    const isFile = parts[0] === "parts" && parts[1] === "file" && method === "GET";
    let fileHit = null;
    if (isFile) fileHit = await bin.resolveFile(route.slice("parts/file/".length));
    if (!(fileHit?.capOk) && !isAuthed(req, url)) {
      if (throttled(ctx.ip)) return sendJSON(res, 429, { error: "slow-down" });
      noteFailure(ctx.ip);
      return sendJSON(res, 401, { error: "auth" });
    }

    if (isFile) {
      if (!fileHit) return sendJSON(res, 404, { error: "not-found" });
      const etag = `W/"${fileHit.stat.size.toString(16)}-${Math.floor(fileHit.stat.mtimeMs).toString(16)}"`;
      const headers = { "content-type": fileHit.type, "cache-control": "no-cache", etag };
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(200, { ...headers, "content-length": fileHit.stat.size });
      if (req.method === "HEAD") return res.end();
      return new Promise((done) => {
        const stream = fs.createReadStream(fileHit.file);
        stream.on("error", () => {
          res.destroy();
          done();
        });
        res.on("close", () => {
          stream.destroy();
          done();
        });
        stream.pipe(res);
      });
    }

    switch (`${method} ${route}`) {
      case "POST join": {
        const body = await readJSON(req);
        const result = store.join({ name: body.name, device: body.device, color: body.color });
        ctx.note = `${result.user.name} (${result.user.device}) joined`;
        return sendJSON(res, 200, result);
      }
      case "GET events": {
        const lastId = Number(req.headers["last-event-id"] ?? url.searchParams.get("since"));
        store.openEvents(url.searchParams.get("user"), req, res, Number.isInteger(lastId) ? lastId : null);
        return;
      }
      case "POST op": {
        const body = await readJSON(req);
        return sendJSON(res, 200, store.op(body.user, body.op));
      }
      case "POST pose": {
        const body = await readJSON(req);
        store.pose(body.user, body.pose);
        return noContent(res);
      }
      case "POST fx": {
        const body = await readJSON(req);
        store.fx(body.user, body.fx);
        return noContent(res);
      }
      case "POST say": {
        const body = await readJSON(req);
        store.say(body.user, body.text);
        return noContent(res);
      }
      case "POST leave": {
        const body = await readJSON(req);
        if (typeof body.user === "string") store.leave(body.user);
        return noContent(res);
      }
      case "POST command":
        return command(req, res, ctx);
      case "POST transcribe":
        return transcribe(req, res, ctx);
      case "GET parts":
        return sendJSON(res, 200, bin.manifest());
      case "POST parts/save": {
        const body = await readJSON(req);
        const saved = await bin.save(body.blueprint ?? body);
        if (saved.error) return sendJSON(res, 400, { error: "bad-blueprint", detail: saved.error });
        catalog = null;
        ctx.note = saved.existing ? `"${saved.name}" already saved` : `saved "${saved.name}"`;
        return sendJSON(res, 200, { name: saved.name });
      }
      default:
        break;
    }

    if (parts[0] === "share" && /^[A-Za-z0-9_-]{1,32}$/.test(parts[1] || "")) {
      const stream = parts[1];
      if (parts.length === 2 && method === "POST") {
        const type = String(req.headers["content-type"] || "image/jpeg").split(";")[0].trim().toLowerCase();
        if (!/^image\/(jpeg|png|webp)$/.test(type)) return sendJSON(res, 415, { error: "unsupported-type" });
        const data = await readBody(req, LIMITS.frame);
        if (!data.length) return sendJSON(res, 400, { error: "empty" });
        store.setFrame(stream, userOf(req, url), data, type);
        return noContent(res);
      }
      if (parts.length === 2 && method === "GET") {
        const frame = store.getFrame(stream);
        if (!frame) return sendJSON(res, 404, { error: "no-frame" });
        res.writeHead(200, { "content-type": frame.type, "cache-control": "no-store", "content-length": frame.data.length, "x-frame-n": String(frame.n) });
        return res.end(req.method === "HEAD" ? undefined : frame.data);
      }
      if (parts.length === 3 && parts[2] === "stop" && method === "POST") {
        const body = await readJSON(req).catch(() => ({}));
        store.stopShare(stream, userOf(req, url, body));
        return noContent(res);
      }
    }
    return sendJSON(res, 404, { error: "not-found" });
  }

  async function command(req, res, ctx) {
    const body = await readJSON(req);
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 500) : "";
    if (!text) return sendJSON(res, 400, { error: "no-text" });
    const context = body.ctx && typeof body.ctx === "object" ? body.ctx : {};
    const player = context.player && typeof context.player === "object" ? context.player : {};
    const userId = typeof player.user === "string" ? player.user : typeof body.user === "string" ? body.user : null;
    const caller = typeof body.user === "string" ? store.users.get(body.user) : null;
    if (caller) caller.lastSeen = Date.now();
    const held = [];
    const sceneNames = new Set();
    for (const record of Object.values(store.state.objects || {})) {
      if (record.part) sceneNames.add(String(record.part).toLowerCase());
      if (record.label) sceneNames.add(String(record.label).toLowerCase());
      if (userId && record.attach?.user === userId) held.push({ hand: record.attach.hand, label: record.label || record.part });
    }
    let scene;
    try {
      scene = summarize(store.state, player);
    } catch {
      scene = context.scene;
    }
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    const { metas, text: catalogString, match } = getCatalog();
    ctx.note = JSON.stringify(text.slice(0, 80));
    const result = await model.command({ text, ctx: context, held, scene, metas, catalog: catalogString, sceneNames, match, signal: abort.signal });
    ctx.note += ` → ${result.intents.map((i) => i.do + (i.what?.part ? ` ${i.what.part}` : i.what?.custom ? ` ${i.what.custom.name}` : "")).join(", ") || "no intents"} (${result.model}, ${result.ms} ms)`;
    return sendJSON(res, 200, result);
  }

  async function transcribe(req, res, ctx) {
    const type = String(req.headers["content-type"] || "audio/wav").split(";")[0].trim().toLowerCase();
    if (!/^(audio\/(wav|x-wav|wave|vnd\.wave)|application\/octet-stream)$/.test(type)) return sendJSON(res, 415, { error: "unsupported-type", detail: "send audio/wav" });
    const audio = await readBody(req, LIMITS.audio);
    if (!isWav(audio)) return sendJSON(res, 400, { error: "bad-audio", detail: "expected a WAV file" });
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    const result = await stt.transcribe(audio, { signal: abort.signal });
    ctx.note = `${(audio.length / 32000).toFixed(1)} s → ${JSON.stringify(result.text.slice(0, 80))} (${result.ms} ms)`;
    return sendJSON(res, 200, result);
  }

  // ---------- request handler ----------
  async function handle(req, res) {
    const started = Date.now();
    const rawPath = String(req.url || "/").split("?")[0] || "/";
    let url;
    try {
      url = new URL(req.url || "/", "http://bridge.invalid");
    } catch {
      return sendJSON(res, 400, { error: "bad-url" });
    }
    const origin = req.headers.origin;
    const cors = corsAllowed(origin);
    if (cors) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (!cors) {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(204, {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-room-key, x-user-id, last-event-id",
        "access-control-allow-private-network": "true",
        "access-control-max-age": "600",
      });
      return res.end();
    }

    const prefix = API_PREFIXES.find((p) => rawPath.startsWith(p));
    if (prefix) {
      const route = rawPath.slice(prefix.length).replace(/\/+$/, "");
      const ctx = { ip: req.socket.remoteAddress || "?", note: "" };
      const quiet = QUIET.test(route) || route === "events";
      res.on("finish", () => {
        if (verbose || (!quiet && !options.quiet)) log.log?.(`${time()} ${req.method} /api/${route} ${res.statusCode} ${Date.now() - started}ms${ctx.note ? ` ${ctx.note}` : ""}`);
      });
      if (route === "events" && !options.quiet) {
        const user = store.users.get(url.searchParams.get("user"));
        if (user) log.log?.(`${time()} events open for ${user.name} (${user.device})`);
      }
      try {
        await api(req, res, route, url, ctx);
      } catch (err) {
        const status = err.status || 500;
        const body = err.body || { error: "server", detail: err.message };
        if (status === 500) log.error?.(`[bridge] ${req.method} ${rawPath} failed:`, err);
        if (status === 413) res.setHeader("connection", "close");
        sendJSON(res, status, body);
        if (status === 413) req.resume();
      }
      return;
    }

    if (verbose) res.on("finish", () => log.log?.(`${time()} ${req.method} ${rawPath} ${res.statusCode}`));
    // ?k=KEY on any page: remember the key in a cookie, then drop it from the address bar.
    if ((req.method === "GET" || req.method === "HEAD") && url.searchParams.has("k")) {
      const key = url.searchParams.get("k");
      url.searchParams.delete("k");
      const rest = url.searchParams.toString();
      const location = (rawPath === "/" ? GAME_PATH : rawPath) + (rest ? `?${rest}` : "");
      const headers = { location, "cache-control": "no-store" };
      if (keyMatches(key)) {
        const secure = req.socket.encrypted ? "; Secure" : "";
        headers["set-cookie"] = `tr_key=${encodeURIComponent(config.roomKey)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86400}${secure}`;
      }
      res.writeHead(302, headers);
      return res.end();
    }
    if (rawPath === "/") {
      res.writeHead(302, { location: GAME_PATH + (url.search || ""), "cache-control": "no-store" });
      return res.end();
    }
    await statics.serve(req, res, rawPath, url.search || "");
  }

  const handler = (req, res) => {
    handle(req, res).catch((err) => {
      log.error?.("[bridge] request failed:", err);
      try {
        if (!res.headersSent) sendJSON(res, 500, { error: "server", detail: err.message });
        else res.destroy();
      } catch {
        // Nothing more to do.
      }
    });
  };

  function listen(server, port, host) {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(server.address().port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
  }

  let cert = null;
  async function start() {
    await bin.start();
    store.start();
    const probes = Promise.all([model.refresh(true), stt.start()]);
    const problems = [];
    if (useHttps) {
      cert = ensureCert(dataDir);
      const server = https.createServer({ key: cert.key, cert: cert.cert }, handler);
      server.on("clientError", (err, socket) => socket.destroy());
      try {
        ports.https = await listen(server, config.port, options.host || "0.0.0.0");
        servers.push(server);
      } catch (err) {
        problems.push(`HTTPS port ${config.port}: ${err.code === "EADDRINUSE" ? "already in use (is another bridge running? change \"port\" in config.json)" : err.message}`);
      }
    }
    const plain = http.createServer(handler);
    plain.on("clientError", (err, socket) => socket.destroy());
    try {
      ports.http = await listen(plain, config.httpPort, "127.0.0.1");
      servers.push(plain);
    } catch (err) {
      problems.push(`HTTP port ${config.httpPort}: ${err.code === "EADDRINUSE" ? "already in use (change \"httpPort\" in config.json)" : err.message}`);
    }
    for (const server of servers) {
      server.keepAliveTimeout = 65000;
      server.headersTimeout = 70000;
      server.requestTimeout = 0; // event streams stay open
    }
    await probes;
    if (!servers.length) {
      await stop();
      throw new Error(`The bridge could not listen: ${problems.join("; ")}`);
    }
    return { ports: { ...ports }, problems, loaded };
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    store.stop();
    bin.stop();
    stt.stop();
    await Promise.all(servers.map((server) => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    })));
  }

  function printStartup({ problems = [] } = {}) {
    const out = [];
    const line = "─".repeat(64);
    out.push("", line, "  DOT / GAMES · TRAINING ROOM · laptop bridge " + VERSION, line);
    out.push(`  Room key:  ${config.roomKey}`);
    const lan = lanUrls();
    if (lan.length) {
      out.push("  Headset / phone (same Wi-Fi; accept the certificate warning once):");
      for (const url of lan) out.push(`    ${withKey(url)}`);
    } else if (useHttps && !ports.https) {
      out.push("  HTTPS is not running, so only this laptop can join.");
    } else if (!useHttps) {
      out.push("  HTTPS is off (--no-https): only this laptop or a USB headset (adb reverse) can join.");
    } else {
      out.push("  No network address found: connect the laptop to Wi-Fi, then restart the bridge.");
    }
    if (ports.http) out.push(`  This laptop:  ${withKey(laptopUrl())}`);
    if (lan.length) {
      out.push("", "  Scan with the phone (or type the headset URL above):");
      out.push(renderQR(withKey(lan[0]), { ansi: !!process.stdout.isTTY }).split("\n").map((l) => `    ${l}`).join("\n"));
    }
    out.push("");
    const m = model.status();
    if (m.available) out.push(`  Model:  ${m.name} via ${m.provider === "openai" ? `OpenAI-compatible server ${model.url}` : `Ollama ${model.url}`}${m.detail ? ` (${m.detail})` : ""}`);
    else out.push(`  Model:  ${m.detail || "not available"}. Commands use the built-in parser until a model is ready.`);
    const s = stt.status();
    if (s.available) out.push(`  Voice:  ${s.kind} at ${s.url}`);
    else out.push(`  Voice:  ${s.detail || "not available"}. Headset voice needs a Whisper server; typing and browser speech still work.`);
    out.push(`  Parts:  ${bin.count} in ${partsPrimary}${extraDirs.length ? ` (+${extraDirs.length} more folder${extraDirs.length > 1 ? "s" : ""})` : ""}`);
    out.push(`  Data:   ${dataDir} (settings: ${path.basename(configFile)})`);
    for (const problem of problems) out.push(`  Problem: ${problem}`);
    out.push("");
    out.push("  Windows: when asked, allow Node.js on Private networks (not Public).");
    if (ports.http) out.push(`  USB headset: adb reverse tcp:${ports.http} tcp:${ports.http} then open ${withKey(`http://localhost:${ports.http}/`)} in the headset.`);
    out.push("  Stop with Ctrl+C.", line, "");
    log.log?.(out.join("\n"));
  }

  return {
    start,
    stop,
    printStartup,
    config,
    dataDir,
    store,
    bin,
    model,
    stt,
    get ports() {
      return { ...ports };
    },
    get cert() {
      return cert;
    },
    laptopUrl: () => (laptopUrl() ? withKey(laptopUrl()) : null),
    lanUrls,
    handler,
  };
}

// ---------- command line ----------
const USAGE = `Usage: node server.mjs [--port 8787] [--http-port 8788] [--no-https] [--data <dir>]
                      [--parts <dir>] [--model <name>] [--ollama <url>] [--open] [--verbose]`;

export async function main(argv = process.argv.slice(2)) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    console.error(`Training Room bridge needs Node.js 20 or newer (this is ${process.versions.node}). Get it from https://nodejs.org`);
    process.exitCode = 1;
    return null;
  }
  let args;
  try {
    ({ values: args } = parseArgs({
      args: argv,
      options: {
        port: { type: "string" },
        "http-port": { type: "string" },
        "no-https": { type: "boolean" },
        data: { type: "string" },
        parts: { type: "string" },
        model: { type: "string" },
        ollama: { type: "string" },
        open: { type: "boolean" },
        verbose: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exitCode = 2;
    return null;
  }
  if (args.help) {
    const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    console.log(source.split("\n").slice(1).filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return null;
  }
  const num = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`--${name} needs a port number`);
    return n;
  };
  let bridge;
  try {
    bridge = await createBridge({
      dataDir: args.data,
      port: num(args.port, "port"),
      httpPort: num(args["http-port"], "http-port"),
      https: !args["no-https"],
      partsDir: args.parts,
      model: args.model,
      ollamaUrl: args.ollama,
      verbose: args.verbose,
    });
    const info = await bridge.start();
    bridge.printStartup(info);
  } catch (err) {
    console.error(`\nTraining Room bridge could not start: ${err.message}\n`);
    process.exitCode = 1;
    await bridge?.stop().catch(() => {});
    return null;
  }
  if (args.open && bridge.laptopUrl()) openBrowser(bridge.laptopUrl());

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) process.exit(0);
    closing = true;
    console.log(`\n${signal}: saving the room and stopping…`);
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    await bridge.stop().catch((err) => console.error(err));
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.on("uncaughtException", (err) => console.error("[bridge] unexpected error (still running):", err));
  process.on("unhandledRejection", (err) => console.error("[bridge] unexpected error (still running):", err));
  return bridge;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
