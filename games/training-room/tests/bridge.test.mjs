// Laptop bridge end to end: static serving, auth, room sync over SSE, model/STT proxies (with fake
// Ollama and whisper servers), parts bin, shared frames, HTTPS certificate and persistence.
// Run: node --test games/training-room/tests/bridge.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createBridge, renderQR, GAME_PATH } from "../bridge/server.mjs";
import { generateCert, ensureCert, certIPs, lanIPs } from "../bridge/cert.mjs";
import { extractJSON, normalizeOutput, buildPrompt, EXAMPLES, intentSchema, pickModel, createMatcher, catalogText } from "../bridge/llm.mjs";
import { cleanTranscript } from "../bridge/stt.mjs";
import { sanitizeConfig, generateRoomKey, defaultDataDir } from "../bridge/config.mjs";
import { allMeta, getMeta } from "../js/parts/meta/index.js";
import { qrcode } from "../vendor/qrcode.mjs";
import { startFakeOllama, startFakeWhisper, makeWav, closeServer } from "./fixtures/bridge-fakes.mjs";

const quietLog = { lines: [], log(...a) { this.lines.push(a.join(" ")); }, warn(...a) { this.lines.push(a.join(" ")); }, error(...a) { this.lines.push(a.join(" ")); } };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tr-bridge-test-"));
const dataDir = path.join(tmpRoot, "data");
const partsDir = path.join(tmpRoot, "parts");

// ---------- helpers ----------
function raw(port, reqPath, { method = "GET", headers = {}, body, secure = false } = {}) {
  return new Promise((resolve, reject) => {
    const lib = secure ? https : http;
    const req = lib.request({ host: "127.0.0.1", port, path: reqPath, method, headers, rejectUnauthorized: false, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        let json;
        try {
          json = JSON.parse(buffer.toString("utf8"));
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString("utf8"), json, socket: res.socket });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    req.end();
  });
}

function openSSE(port, reqPath, headers = {}) {
  const sse = { events: [], status: null, waiters: [] };
  sse.req = http.get({ host: "127.0.0.1", port, path: reqPath, headers, agent: false }, (res) => {
    sse.status = res.statusCode;
    sse.headers = res.headers;
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      let at;
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const ev = { event: "message", data: "", id: null };
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const key = line.slice(0, colon);
          const value = line.slice(colon + 1).replace(/^ /, "");
          if (key === "event") ev.event = value;
          else if (key === "data") ev.data += value;
          else if (key === "id") ev.id = value;
          else if (key === "retry") ev.retry = Number(value);
        }
        if (!ev.data && ev.retry === undefined) continue;
        try {
          ev.json = JSON.parse(ev.data);
        } catch {
          ev.json = undefined;
        }
        sse.events.push(ev);
        for (const waiter of [...sse.waiters]) waiter();
      }
    });
    res.on("end", () => {
      sse.ended = true;
      for (const waiter of [...sse.waiters]) waiter();
    });
  });
  sse.req.on("error", () => {});
  sse.mark = () => sse.events.length;
  sse.waitFor = (pred, { since = 0, ms = 3000 } = {}) => new Promise((resolve, reject) => {
    const check = () => {
      const found = sse.events.slice(since).find(pred);
      if (found) {
        cleanup();
        resolve(found);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`SSE wait timed out; got ${sse.events.map((e) => e.event).join(",")}`));
    }, ms);
    const cleanup = () => {
      clearTimeout(timer);
      sse.waiters = sse.waiters.filter((w) => w !== check);
    };
    sse.waiters.push(check);
    check();
  });
  sse.close = () => sse.req.destroy();
  return sse;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- pure units ----------
describe("bridge units", () => {
  it("generates a valid self-signed certificate with the LAN IPs in the SAN", () => {
    const { key, cert } = generateCert({ names: ["localhost", "laptop"], ips: ["127.0.0.1", "192.168.1.20", "10.0.0.7"] });
    const x509 = new crypto.X509Certificate(cert);
    assert.ok(x509.verify(x509.publicKey), "self signature verifies");
    assert.ok(x509.checkPrivateKey(crypto.createPrivateKey(key)));
    assert.deepEqual(certIPs(x509), ["127.0.0.1", "192.168.1.20", "10.0.0.7"]);
    assert.match(x509.subjectAltName, /DNS:localhost/);
    assert.match(x509.subjectAltName, /DNS:laptop/);
    assert.equal(x509.ca, false);
    assert.deepEqual(x509.keyUsage, ["1.3.6.1.5.5.7.3.1"]);
    assert.ok(x509.publicKey.asymmetricKeyDetails.modulusLength === 2048);
    const days = (Date.parse(x509.validTo) - Date.parse(x509.validFrom)) / 86400000;
    assert.ok(Math.abs(days - 398) < 0.01, `validity ${days} days`);
    assert.ok(Date.parse(x509.validFrom) < Date.now());
  });

  it("openssl reads the certificate (skipped without openssl)", (t) => {
    let has = true;
    try {
      execFileSync("openssl", ["version"], { stdio: "ignore" });
    } catch {
      has = false;
    }
    if (!has) return t.skip("openssl not installed");
    const dir = fs.mkdtempSync(path.join(tmpRoot, "ossl-"));
    const { cert } = generateCert({ ips: ["127.0.0.1", "192.168.50.5"] });
    fs.writeFileSync(path.join(dir, "cert.pem"), cert);
    const text = execFileSync("openssl", ["x509", "-noout", "-text", "-in", path.join(dir, "cert.pem")], { encoding: "utf8" });
    assert.match(text, /Version: 3/);
    assert.match(text, /sha256WithRSAEncryption/);
    assert.match(text, /Public-Key: \(2048 bit\)/);
    assert.match(text, /IP Address:192\.168\.50\.5/);
    assert.match(text, /CA:FALSE/);
    assert.match(text, /Digital Signature, Key Encipherment/);
    assert.match(text, /TLS Web Server Authentication/);
  });

  it("ensureCert reuses a good certificate and regenerates when an IP is missing", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "cert-"));
    const first = ensureCert(dir, { ips: ["127.0.0.1", "192.168.1.30"] });
    assert.equal(first.generated, true);
    const again = ensureCert(dir, { ips: ["127.0.0.1", "192.168.1.30"] });
    assert.equal(again.generated, false);
    assert.equal(again.cert, first.cert);
    const moved = ensureCert(dir, { ips: ["127.0.0.1", "192.168.1.31"] });
    assert.equal(moved.generated, true);
    assert.ok(certIPs(new crypto.X509Certificate(moved.cert)).includes("192.168.1.31"));
    fs.writeFileSync(path.join(dir, "cert.pem"), "garbage");
    assert.equal(ensureCert(dir, { ips: ["127.0.0.1"] }).generated, true);
  });

  it("lanIPs lists non-internal IPv4, real adapters first", () => {
    const list = lanIPs({
      "vEthernet (WSL)": [{ family: "IPv4", address: "172.20.16.1", internal: false }],
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      "Wi-Fi": [{ family: "IPv4", address: "192.168.1.44", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
    });
    assert.deepEqual(list, ["192.168.1.44", "172.20.16.1"]);
  });

  it("terminal QR matches the QR matrix module for module", () => {
    const text = "https://192.168.1.44:8787/?k=ABCDEF";
    const rendered = renderQR(text, { quiet: 2 }).split("\n");
    const qr = qrcode(0, "L");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const size = n + 4;
    assert.equal(rendered.length, Math.ceil(size / 2));
    for (const line of rendered) assert.equal([...line].length, size);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const ch = [...rendered[r >> 1]][c];
        const lightDrawn = r % 2 === 0 ? ch === "█" || ch === "▀" : ch === "█" || ch === "▄";
        const mr = r - 2;
        const mc = c - 2;
        const light = mr < 0 || mc < 0 || mr >= n || mc >= n || !qr.isDark(mr, mc);
        assert.equal(lightDrawn, light, `module ${mr},${mc}`);
      }
    }
  });

  it("config: defaults, validation and room keys", () => {
    const { config, problems } = sanitizeConfig({ port: "nope", think: null, partsDirs: ["a", 3], allowOrigins: ["https://x.example/", "bad"] });
    assert.equal(config.port, 8787);
    assert.equal(config.think, null);
    assert.deepEqual(config.partsDirs, ["a"]);
    assert.deepEqual(config.allowOrigins, ["https://x.example"]);
    assert.deepEqual(problems, ["port"]);
    assert.match(generateRoomKey(), /^[A-HJ-NP-Z2-9]{6}$/);
    assert.match(defaultDataDir({}, "linux"), /\.config[\\/]dot-training-room$/);
    assert.match(defaultDataDir({ APPDATA: "C:/Users/me/AppData/Roaming" }, "win32"), /Roaming[\\/]dot-training-room$/);
    assert.equal(defaultDataDir({ TRAINING_ROOM_DATA: "/srv/tr" }, "linux"), path.resolve("/srv/tr"));
  });

  it("extractJSON handles fences, thinking tags and chatter", () => {
    assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJSON('```json\n{"a":2}\n```'), { a: 2 });
    assert.deepEqual(extractJSON("<think>let me see {not json}</think>\n{\"a\":3}"), { a: 3 });
    assert.deepEqual(extractJSON('Sure! Here you go: {"a":{"b":"}"}} hope that helps'), { a: { b: "}" } });
    assert.throws(() => extractJSON("no json here"));
  });

  it("normalizeOutput keeps known intents, maps names and clamps numbers", () => {
    const metas = allMeta();
    const out = normalizeOutput({
      intents: [
        { do: "dance" },
        { do: "spawn", what: { part: "poker table" }, count: 400, place: { rel: "in front", dist: 9999 } },
        { do: "spawn", what: { part: "playing cards" }, place: { rel: "on", ref: { batch: 2 } } },
        { do: "summon", part: "axes", place: { rel: "hand", hand: "LEFT" } },
        { do: "spawn", what: { part: "flux capacitor" } },
        { do: "spawn", what: { custom: { name: "Snow Man", parts: [{ shape: "sphere", p: [0, 2, 0], s: [1, 1, 1], color: "white" }, { shape: "ball", p: [0, 2.8, 0], s: [0.6, 0.6, 0.6] }] } } },
        { do: "scale", target: "it", factor: 1000 },
        { do: "time", value: "evening" },
        { do: "remove", target: { part: "dragon statue" } },
        { do: "write", target: { part: "white board" }, text: "Q3 goals" },
        { do: "move", target: { id: "o1" } },
      ],
      say: "Okay.",
    }, { metas, sceneNames: new Set(["dragon statue"]) });
    const [table, deck, axe, unknown, snow, scale, time, remove, write] = out.intents;
    assert.equal(out.intents.length, 9);
    assert.deepEqual(table, { do: "spawn", what: { part: "card table" }, count: 20, place: { rel: "front", dist: 300 } });
    assert.deepEqual(deck.place, { rel: "on", ref: { batch: 0 } }, "batch index remapped after the dropped intent");
    assert.deepEqual(axe, { do: "spawn", what: { part: "axe" }, place: { rel: "hand", hand: "left" } });
    assert.deepEqual(unknown.what, { part: "flux capacitor", label: "flux capacitor" });
    assert.equal(snow.what.custom.name, "snow man");
    assert.equal(snow.what.custom.parts.length, 2);
    assert.ok(Math.abs(snow.what.custom.parts[0].p[1] - 0.5) < 1e-6, "re-centered to the ground");
    assert.deepEqual(snow.what.custom.size.map((n) => Math.round(n * 100) / 100), [1, 1.6, 1]);
    assert.deepEqual(scale, { do: "scale", target: { ref: "it" }, factor: 20 });
    assert.deepEqual(time, { do: "time", value: "sunset" });
    assert.deepEqual(remove.target, { part: "dragon statue" }, "custom scene parts are not fuzzy-matched to statue");
    assert.deepEqual(write, { do: "write", target: { part: "whiteboard" }, text: "Q3 goals" });
    assert.equal(out.say, "Okay.");
    const many = normalizeOutput({ intents: Array.from({ length: 50 }, () => ({ do: "clear" })) }, { metas });
    assert.equal(many.intents.length, 30);
  });

  it("prompt: static system first, catalog, examples that use real part names, live command last", () => {
    const metas = allMeta();
    for (const [, answer] of EXAMPLES) {
      for (const intent of answer.intents) {
        if (intent.what?.part) assert.ok(getMeta(intent.what.part), `example part ${intent.what.part} exists`);
        if (intent.target?.part) assert.ok(getMeta(intent.target.part), `example target ${intent.target.part} exists`);
      }
    }
    const messages = buildPrompt({ text: "spawn a villa to my left", player: { p: [1, 1.6, 2], yaw: 0.5 }, scene: [{ id: "o1", part: "crate", label: "crate", dist: 2, dir: "front" }], held: [{ hand: "right", label: "axe" }], metas, extraParts: ["dragon statue"] });
    assert.equal(messages[0].role, "system");
    assert.match(messages[0].content, /You turn a spoken command from a VR player into JSON intents/);
    assert.match(messages[0].content, /- villa \(mansion, mediterranean villa\) 14x9x12:/);
    assert.match(messages[0].content, /- deck of cards .*\[holdable, cards\]/);
    assert.ok(messages.length >= 1 + 2 * 8);
    const last = messages.at(-1);
    assert.equal(last.role, "user");
    assert.match(last.content, /right hand: axe/);
    assert.match(last.content, /crate id o1 2 m front/);
    assert.match(last.content, /Also available parts: dragon statue/);
    assert.match(last.content, /Command: "spawn a villa to my left"/);
    const again = buildPrompt({ text: "other", metas });
    assert.equal(again[0].content, messages[0].content, "system prompt is identical across calls (KV cache)");
    assert.ok(catalogText(metas).length < 12000, "catalog stays compact");
    const schema = intentSchema();
    assert.deepEqual(schema.required, ["intents", "say"]);
    assert.equal(schema.properties.intents.items.properties.do.enum.length, 16);
  });

  it("pickModel prefers coder, then qwen, never embedding models", () => {
    assert.equal(pickModel(["llama3.2:3b", "nomic-embed-text", "qwen3:8b", "qwen2.5-coder:7b"]), "qwen2.5-coder:7b");
    assert.equal(pickModel(["nomic-embed-text", "llama3.2:3b", "qwen3:8b"]), "qwen3:8b");
    assert.equal(pickModel(["nomic-embed-text:latest", "gemma3:4b"]), "gemma3:4b");
    assert.equal(pickModel(["qwen3:8b"], "qwen3:8b"), "qwen3:8b");
    assert.equal(pickModel(["qwen3:8b"], "llama3"), null);
    assert.equal(pickModel(["llama3:latest"], "llama3"), "llama3:latest");
  });

  it("createMatcher resolves aliases and plurals", () => {
    const match = createMatcher(allMeta());
    assert.equal(match("mansion").name, "villa");
    assert.equal(match("training dummies").name, "training dummy");
    assert.equal(match("the battle axe").name, "battle axe");
  });

  it("cleanTranscript strips Whisper tags and silence hallucinations", () => {
    assert.equal(cleanTranscript(" [BLANK_AUDIO] AI, spawn a crate (wind blowing) "), "AI, spawn a crate");
    assert.equal(cleanTranscript("[BLANK_AUDIO]"), "");
    assert.equal(cleanTranscript(" Thank you."), "");
    assert.equal(cleanTranscript("*music* ♪"), "");
  });
});

// ---------- the running bridge ----------
describe("bridge server", () => {
  let bridge;
  let ollama;
  let whisper;
  let key;
  let hp; // http port
  let sp; // https port
  const auth = () => ({ "x-room-key": key, "content-type": "application/json" });
  const post = (route, body, headers = auth()) => raw(hp, `/api/${route}`, { method: "POST", headers, body });

  before(async () => {
    fs.mkdirSync(partsDir, { recursive: true });
    fs.writeFileSync(path.join(partsDir, "snowman.json"), JSON.stringify({
      name: "Snowman", aliases: ["frosty"], desc: "three snowballs",
      parts: [
        { shape: "sphere", p: [0, 0.4, 0], s: [0.8, 0.8, 0.8], color: "white", mat: "matte" },
        { shape: "sphere", p: [0, 1.0, 0], s: [0.5, 0.5, 0.5], color: "#ffffff" },
        { shape: "cone", p: [0, 1.0, 0.35], s: [0.08, 0.3, 0.08], r: [90, 0, 0], color: "orange" },
      ],
    }));
    fs.writeFileSync(path.join(partsDir, "My_Sword.glb"), Buffer.from("glTF fake binary"));
    fs.writeFileSync(path.join(partsDir, "My_Sword.part.json"), JSON.stringify({ aliases: ["blade"], size: [0.1, 1.1, 0.05], holdable: true, grip: { p: [0, 0.2, 0], r: [-90, 0, 0] }, category: "combat", desc: "the owner's sword" }));
    fs.writeFileSync(path.join(partsDir, "lantern.mjs"), "export default { name: 'lantern', build(THREE) { return new THREE.Group(); } };\n");
    fs.writeFileSync(path.join(partsDir, "broken.json"), "{ not json");
    fs.writeFileSync(path.join(partsDir, "notes.txt"), "ignored");
    ollama = await startFakeOllama();
    whisper = await startFakeWhisper();
    bridge = await createBridge({
      dataDir,
      partsDir,
      port: 0,
      httpPort: 0,
      host: "127.0.0.1",
      quiet: true,
      log: quietLog,
      configOverrides: { ollamaUrl: ollama.url, sttUrl: `${whisper.url}/inference` },
      store: { dropAfter: 400, sweepMs: 100, poseHz: 20, saveDelay: 100 },
      modelTimeoutMs: 1500,
      scanMs: 60000,
    });
    const info = await bridge.start();
    key = bridge.config.roomKey;
    hp = info.ports.http;
    sp = info.ports.https;
    assert.ok(hp && sp);
  });

  after(async () => {
    await bridge?.stop();
    await closeServer(ollama?.server);
    await closeServer(whisper?.server);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("created the data folder with config, room key, certificate and parts README", () => {
    const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    assert.match(config.roomKey, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(config.ollamaUrl, "http://127.0.0.1:11434", "CLI/test overrides are not written back");
    assert.ok(config._help);
    assert.ok(fs.existsSync(path.join(dataDir, "key.pem")));
    assert.ok(fs.existsSync(path.join(dataDir, "cert.pem")));
    assert.ok(fs.existsSync(path.join(partsDir, "README.txt")));
    assert.ok(fs.existsSync(path.join(partsDir, "generated")));
  });

  it("serves the repository under /vr-games/ with MIME types and caching", async () => {
    const index = await raw(hp, "/vr-games/");
    assert.equal(index.status, 200);
    assert.match(index.headers["content-type"], /^text\/html/);
    assert.equal(index.headers["cache-control"], "no-cache");
    const css = await raw(hp, "/vr-games/assets/styles.css");
    assert.equal(css.status, 200);
    assert.match(css.headers["content-type"], /^text\/css/);
    const svg = await raw(hp, "/vr-games/assets/favicon.svg");
    assert.equal(svg.headers["content-type"], "image/svg+xml");
    assert.equal(svg.headers["cache-control"], "public, max-age=3600");
    const js = await raw(hp, "/vr-games/games/training-room/js/util/ids.js");
    assert.equal(js.status, 200);
    assert.match(js.headers["content-type"], /^text\/javascript/);
    assert.equal(js.headers["cache-control"], "no-cache");
    const mjs = await raw(hp, "/vr-games/games/training-room/vendor/qrcode.mjs");
    assert.match(mjs.headers["content-type"], /^text\/javascript/);
    const md = await raw(hp, "/vr-games/games/training-room/README.md");
    assert.match(md.headers["content-type"], /^text\/markdown/);
    const again = await raw(hp, "/vr-games/games/training-room/js/util/ids.js", { headers: { "if-none-match": js.headers.etag } });
    assert.equal(again.status, 304);
    const since = await raw(hp, "/vr-games/assets/favicon.svg", { headers: { "if-modified-since": svg.headers["last-modified"] } });
    assert.equal(since.status, 304);
    const dir = await raw(hp, "/vr-games/games");
    assert.equal(dir.status, 301);
    assert.equal(dir.headers.location, "/vr-games/games/");
    const head = await raw(hp, "/vr-games/assets/styles.css", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.buffer.length, 0);
  });

  it("refuses traversal, dot folders and the bridge/tests folders with the repo 404 page", async () => {
    const attempts = [
      "/vr-games/../../etc/passwd",
      "/vr-games/%2e%2e/%2e%2e/etc/passwd",
      "/vr-games/..%2f..%2fetc%2fpasswd",
      "/vr-games/games/..%5c..%5cetc/passwd",
      "/vr-games/.git/config",
      "/vr-games/.nojekyll",
      "/vr-games/games/training-room/bridge/server.mjs",
      "/vr-games/games/training-room/bridge/",
      "/vr-games/games/training-room/tests/bridge.test.mjs",
      "/vr-games/games/training-room/bridge%2fserver.mjs",
      "/vr-games/nope.html",
      "/etc/passwd",
      "/vr-games/index.html%00.txt",
    ];
    for (const attempt of attempts) {
      const res = await raw(hp, attempt);
      assert.equal(res.status, 404, attempt);
      assert.match(res.text, /Uncharted territory/, `${attempt} uses 404.html`);
      assert.doesNotMatch(res.text, /root:|createBridge|\[core\]/, attempt);
    }
  });

  it("redirects / to the game and turns ?k= into an HttpOnly cookie", async () => {
    const root = await raw(hp, "/");
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, GAME_PATH);
    const withKey = await raw(hp, `/?k=${key}`);
    assert.equal(withKey.status, 302);
    assert.equal(withKey.headers.location, GAME_PATH);
    const cookie = withKey.headers["set-cookie"][0];
    assert.match(cookie, new RegExp(`^tr_key=${key};`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=2592000/);
    const page = await raw(hp, `/vr-games/index.html?x=1&k=${key.toLowerCase()}`);
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, "/vr-games/index.html?x=1");
    assert.ok(page.headers["set-cookie"], "key is case-insensitive");
    const wrong = await raw(hp, "/?k=WRONG1");
    assert.equal(wrong.status, 302);
    assert.equal(wrong.headers["set-cookie"], undefined);
    const secure = await raw(sp, `/?k=${key}`, { secure: true });
    assert.match(secure.headers["set-cookie"][0], /; Secure/);
  });

  it("requires the room key for the API (header, cookie or query) and hello reports auth", async () => {
    const denied = await post("join", { name: "x" }, { "content-type": "application/json" });
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.json, { error: "auth" });
    const bad = await post("join", { name: "x" }, { "x-room-key": "NOPE22" });
    assert.equal(bad.status, 401);
    const viaCookie = await post("join", { name: "Cookie", device: "laptop" }, { cookie: `other=1; tr_key=${key}` });
    assert.equal(viaCookie.status, 200);
    const viaQuery = await raw(hp, `/api/join?k=${key}`, { method: "POST", body: { name: "Query", device: "phone" } });
    assert.equal(viaQuery.status, 200);
    await post("leave", { user: viaCookie.json.user.id });
    await post("leave", { user: viaQuery.json.user.id });

    const open = await raw(hp, "/api/hello");
    assert.equal(open.status, 200);
    assert.equal(open.json.bridge, true);
    assert.equal(open.json.auth, false);
    assert.equal(open.json.key, undefined);
    const hello = await raw(hp, "/vr-games/games/training-room/api/hello", { headers: { "x-room-key": key } });
    assert.equal(hello.json.auth, true);
    assert.equal(hello.json.key, key);
    assert.deepEqual(hello.json.model, { available: true, name: "qwen2.5-coder:7b", provider: "ollama" });
    assert.equal(hello.json.stt.available, true);
    assert.equal(hello.json.stt.kind, "whisper.cpp");
    assert.equal(hello.json.parts.count, 3);
    assert.ok(Array.isArray(hello.json.lan));
    for (const url of hello.json.lan) assert.match(url, new RegExp(`^https://[0-9.]+:${sp}/$`));
  });

  it("answers CORS preflights only for allowed origins", async () => {
    const ok = await raw(hp, "/api/op", { method: "OPTIONS", headers: { origin: "https://dot0m0peg-arch.github.io", "access-control-request-method": "POST", "access-control-request-private-network": "true" } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers["access-control-allow-origin"], "https://dot0m0peg-arch.github.io");
    assert.equal(ok.headers["access-control-allow-credentials"], "true");
    assert.equal(ok.headers["access-control-allow-private-network"], "true");
    assert.match(ok.headers["access-control-allow-headers"], /x-room-key/);
    assert.match(ok.headers["access-control-allow-methods"], /POST/);
    const local = await raw(hp, "/api/hello", { headers: { origin: "http://localhost:5173" } });
    assert.equal(local.headers["access-control-allow-origin"], "http://localhost:5173");
    const evil = await raw(hp, "/api/op", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    assert.equal(evil.status, 403);
    const evilGet = await raw(hp, "/api/hello", { headers: { origin: "https://evil.example" } });
    assert.equal(evilGet.headers["access-control-allow-origin"], undefined);
  });

  describe("shared room", () => {
    let a;
    let b;
    let sseA;

    before(async () => {
      a = (await post("join", { name: "Headset", device: "headset" })).json;
      b = (await post("join", { name: "  Phone\u0007 with a very very long name that goes on  ", device: "phone", color: "#123ABC" })).json;
      sseA = openSSE(hp, `/api/events?user=${a.user.id}&k=${key}`);
      await sseA.waitFor((e) => e.event === "users");
    });

    after(() => sseA?.close());

    it("join returns the user, the user list, the state and seq", () => {
      assert.match(a.user.id, /^u[a-z0-9]+$/);
      assert.equal(a.user.device, "headset");
      assert.match(a.user.color, /^#[0-9a-f]{6}$/);
      assert.ok(a.state && a.state.objects && Array.isArray(a.state.order));
      assert.equal(typeof a.seq, "number");
      assert.equal(b.user.name.length <= 32, true);
      assert.doesNotMatch(b.user.name, /\u0007/);
      assert.equal(b.user.color, "#123abc");
      assert.ok(b.users.some((u) => u.id === a.user.id));
    });

    it("event stream: headers, retry, users", () => {
      assert.equal(sseA.status, 200);
      assert.match(sseA.headers["content-type"], /^text\/event-stream/);
      assert.ok(sseA.events.some((e) => e.retry === 2000));
      const users = sseA.events.find((e) => e.event === "users").json;
      assert.ok(users.some((u) => u.id === b.user.id && u.device === "phone"));
    });

    it("broadcasts ops with seq and the sender forced as op.by", async () => {
      const since = sseA.mark();
      const op = { t: "add", uid: "op1", by: "uimpostor", obj: { id: "ocrate1", part: "crate", label: "crate", p: [1, 0, -3], ry: 0, s: 1 } };
      const res = await post("op", { user: b.user.id, op });
      assert.equal(res.status, 200);
      assert.ok(res.json.seq > 0);
      const ev = await sseA.waitFor((e) => e.event === "op", { since });
      assert.equal(ev.json.seq, res.json.seq);
      assert.equal(ev.id, String(res.json.seq));
      assert.equal(ev.json.op.by, b.user.id);
      assert.equal(ev.json.op.obj.id, "ocrate1");
      assert.ok(bridge.store.state.objects.ocrate1);
    });

    it("rejects bad ops (400) and unknown users (410)", async () => {
      const garbage = await post("op", { user: b.user.id, op: { t: "explode" } });
      assert.equal(garbage.status, 400);
      assert.equal(garbage.json.error, "bad-op");
      const badRecord = await post("op", { user: b.user.id, op: { t: "add", obj: { id: "BAD ID", part: "crate", p: [0, 0] } } });
      assert.equal(badRecord.status, 400);
      const notObject = await post("op", { user: b.user.id, op: "clear" });
      assert.equal(notObject.status, 400);
      const unknown = await post("op", { user: "unobody", op: { t: "env", time: "night" } });
      assert.equal(unknown.status, 410);
      const badJson = await raw(hp, "/api/op", { method: "POST", headers: auth(), body: "{nope" });
      assert.equal(badJson.status, 400);
      assert.equal(badJson.json.error, "bad-json");
      const tooBig = await raw(hp, "/api/op", { method: "POST", headers: auth(), body: JSON.stringify({ user: b.user.id, pad: "x".repeat(300 * 1024) }) });
      assert.equal(tooBig.status, 413);
      const missing = await raw(hp, "/api/nothing-here", { headers: auth() });
      assert.equal(missing.status, 404);
    });

    it("rebroadcasts poses at a fixed rate, plus fx and say", async () => {
      let since = sseA.mark();
      const pose = { p: [0.5, 1.6, 2], yaw: 0.3, hands: { left: null, right: { p: [0.7, 1.2, 1.7], q: [0, 0, 0, 1] } }, talking: true, junk: { deep: 1 } };
      const res = await post("pose", { user: b.user.id, pose });
      assert.equal(res.status, 204);
      const ev = await sseA.waitFor((e) => e.event === "poses" && e.json[b.user.id], { since });
      assert.deepEqual(ev.json[b.user.id].p, [0.5, 1.6, 2]);
      assert.equal(ev.json[b.user.id].talking, true);
      assert.equal(ev.json[b.user.id].junk, undefined);
      assert.equal((await post("pose", { user: b.user.id, pose: { p: "x" } })).status, 400);
      since = sseA.mark();
      assert.equal((await post("fx", { user: b.user.id, fx: { kind: "hit", id: "ocrate1", power: 0.7 } })).status, 204);
      const fx = await sseA.waitFor((e) => e.event === "fx", { since });
      assert.deepEqual(fx.json, { user: b.user.id, fx: { kind: "hit", id: "ocrate1", power: 0.7 } });
      assert.equal((await post("say", { user: b.user.id, text: "hello there" })).status, 204);
      const say = await sseA.waitFor((e) => e.event === "say", { since });
      assert.deepEqual(say.json, { user: b.user.id, text: "hello there" });
    });

    it("replays missed ops on reconnect with Last-Event-ID", async () => {
      const before0 = bridge.store.seq;
      await post("op", { user: b.user.id, op: { t: "env", time: "dawn", uid: "op2" } });
      await post("op", { user: b.user.id, op: { t: "env", time: "day", uid: "op3" } });
      const replay = openSSE(hp, `/api/events?user=${a.user.id}`, { "x-room-key": key, "last-event-id": String(before0) });
      const ev = await replay.waitFor((e) => e.event === "op" && e.json.op.uid === "op3");
      assert.ok(replay.events.some((e) => e.event === "op" && e.json.op.uid === "op2"));
      assert.equal(ev.json.seq, before0 + 2);
      replay.close();
      const gone = openSSE(hp, `/api/events?user=unobody&k=${key}`);
      await wait(150);
      assert.equal(gone.status, 410);
      gone.close();
    });

    it("shares frames: upload, fetch, stop", async () => {
      let since = sseA.mark();
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2048)]);
      const up = await raw(hp, `/api/share/screen?user=${b.user.id}`, { method: "POST", headers: { "x-room-key": key, "content-type": "image/jpeg" }, body: jpeg });
      assert.equal(up.status, 204);
      const ev = await sseA.waitFor((e) => e.event === "share", { since });
      assert.deepEqual(ev.json, { stream: "screen", user: b.user.id, active: true, n: 1 });
      const got = await raw(hp, "/api/share/screen", { headers: { "x-room-key": key } });
      assert.equal(got.status, 200);
      assert.equal(got.headers["content-type"], "image/jpeg");
      assert.ok(got.buffer.equals(jpeg));
      const badType = await raw(hp, `/api/share/screen?user=${b.user.id}`, { method: "POST", headers: { "x-room-key": key, "content-type": "text/plain" }, body: "hi" });
      assert.equal(badType.status, 415);
      since = sseA.mark();
      const stop = await post("share/screen/stop", { user: b.user.id });
      assert.equal(stop.status, 204);
      const ended = await sseA.waitFor((e) => e.event === "share" && e.json.active === false, { since });
      assert.equal(ended.json.stream, "screen");
      assert.equal((await raw(hp, "/api/share/screen", { headers: { "x-room-key": key } })).status, 404);
    });

    it("drops a user 20 s (here 0.4 s) after their stream closes and drops what they held", async () => {
      const c = (await post("join", { name: "Laptop", device: "laptop" })).json;
      const sseC = openSSE(hp, `/api/events?user=${c.user.id}&k=${key}`);
      await sseC.waitFor((e) => e.event === "users");
      await post("op", { user: c.user.id, op: { t: "add", uid: "op4", obj: { id: "oaxe1", part: "axe", p: [0, 1, 0], attach: { user: c.user.id, hand: "right", grip: "snap" } } } });
      await post("pose", { user: c.user.id, pose: { p: [3, 1.6, 4], yaw: 0, hands: { left: null, right: { p: [3.2, 1.1, 3.8], q: [0, 0, 0, 1] } } } });
      await wait(100);
      const since = sseA.mark();
      sseC.close();
      await wait(150);
      assert.ok(bridge.store.users.has(c.user.id), "kept during the grace period");
      const users = await sseA.waitFor((e) => e.event === "users" && !e.json.some((u) => u.id === c.user.id), { since, ms: 3000 });
      assert.ok(users);
      const dropped = sseA.events.slice(since).find((e) => e.event === "op" && e.json.op.id === "oaxe1");
      assert.ok(dropped, "held axe released");
      assert.equal(dropped.json.op.patch.attach, null);
      assert.deepEqual(dropped.json.op.patch.p, [3.2, 0, 3.8]);
      assert.equal(bridge.store.state.objects.oaxe1.attach, undefined);
      const gone = await post("op", { user: c.user.id, op: { t: "env", time: "night" } });
      assert.equal(gone.status, 410);
    });
  });

  describe("local model", () => {
    it("turns a command into normalized intents from the model", async () => {
      const res = await post("command", { user: "u1", text: "spawn a villa to my left", ctx: { player: { user: "u1", p: [0, 1.6, 0], yaw: 0 }, scene: [], parts: [] } });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.source, "model");
      assert.equal(res.json.model, "qwen2.5-coder:7b");
      assert.ok(res.json.ms >= 0);
      assert.deepEqual(res.json.intents, [{ do: "spawn", what: { part: "villa" }, place: { rel: "left" } }]);
      assert.equal(res.json.say, "A villa, on your left.");
      const sent = ollama.requests.at(-1);
      assert.equal(sent.model, "qwen2.5-coder:7b");
      assert.equal(sent.stream, false);
      assert.equal(sent.keep_alive, "30m");
      assert.equal(sent.think, false);
      assert.deepEqual(sent.options, { temperature: 0.1, num_ctx: 8192 });
      assert.equal(sent.format.type, "object");
      assert.equal(sent.messages[0].role, "system");
      assert.match(sent.messages[0].content, /- snowman \(frosty\)/, "laptop parts are in the catalog");
      assert.match(sent.messages.at(-1).content, /crate id ocrate1/, "server-side scene summary");
    });

    it("accepts fenced and thinking-wrapped output", async () => {
      const fenced = await post("command", { text: "fenced axe in my hand" });
      assert.equal(fenced.status, 200);
      assert.deepEqual(fenced.json.intents, [{ do: "spawn", what: { part: "axe" }, place: { rel: "hand" } }]);
      const thinking = await post("command", { text: "think then make it night" });
      assert.deepEqual(thinking.json.intents, [{ do: "time", value: "night" }]);
    });

    it("normalizes custom blueprints and the deck-on-table batch", async () => {
      const res = await post("command", { text: "deck of cards on a card table and a dragon" });
      assert.equal(res.status, 200, res.text);
      const [table, deck, dragon] = res.json.intents;
      assert.equal(table.what.part, "card table");
      assert.deepEqual(deck.place, { rel: "on", ref: { batch: 0 } });
      assert.equal(dragon.what.custom.name, "dragon statue");
      assert.equal(dragon.what.label, "dragon statue");
      assert.ok(Array.isArray(dragon.what.custom.size));
      assert.ok(dragon.what.custom.parts.every((p) => p.p[1] - p.s[1] / 2 >= -0.6));
    });

    it("bad model output → 502 with the raw text, wrong JSON shape → 502", async () => {
      const broken = await post("command", { text: "broken please" });
      assert.equal(broken.status, 502);
      assert.equal(broken.json.error, "bad-output");
      assert.match(broken.json.raw, /cannot help/);
      assert.ok(broken.json.raw.length <= 500);
      const shape = await post("command", { text: "shape number" });
      assert.equal(shape.status, 502);
      assert.equal(shape.json.error, "bad-output");
      assert.equal((await post("command", { text: "" })).status, 400);
    });

    it("retries without think when the model rejects it", async () => {
      const res = await post("command", { text: "nothink spawn a crate" });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.intents[0].what.part, "crate");
      const [first, second] = ollama.requests.slice(-2);
      assert.equal(first.think, false);
      assert.equal("think" in second, false);
    });

    it("slow model → 504, unreachable model → 503 no-model", async () => {
      const slow = await post("command", { text: "slow request" });
      assert.equal(slow.status, 504);
      assert.equal(slow.json.error, "timeout");
      bridge.model.configure({ ...bridge.config, ollamaUrl: "http://127.0.0.1:9" });
      const down = await post("command", { text: "spawn a villa" });
      assert.equal(down.status, 503);
      assert.equal(down.json.error, "no-model");
      assert.match(down.json.detail, /not reachable/);
      const hello = await raw(hp, "/api/hello", { headers: { "x-room-key": key } });
      assert.equal(hello.json.model.available, false);
      bridge.model.configure(bridge.config);
      await bridge.model.refresh(true);
      assert.equal((await post("command", { text: "spawn a villa" })).status, 200);
    });
  });

  describe("speech to text", () => {
    it("forwards WAV audio to whisper.cpp and cleans the transcript", async () => {
      const wav = makeWav(0.5);
      const res = await raw(hp, "/api/transcribe", { method: "POST", headers: { "x-room-key": key, "content-type": "audio/wav" }, body: wav });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.text, "AI, spawn a crate");
      assert.ok(res.json.ms >= 0);
      const form = whisper.requests.at(-1);
      assert.match(form, /name="file"; filename="speech.wav"/);
      assert.match(form, /Content-Type: audio\/wav/i);
      assert.match(form, /name="temperature"\r\n\r\n0\.0/);
      assert.match(form, /name="response_format"\r\n\r\njson/);
      assert.ok(form.includes("RIFF"));
    });

    it("rejects non-WAV bodies and reports a missing server as 503", async () => {
      const bad = await raw(hp, "/api/transcribe", { method: "POST", headers: { "x-room-key": key, "content-type": "audio/wav" }, body: Buffer.from("not a wav file at all, sorry") });
      assert.equal(bad.status, 400);
      bridge.stt.configure({ ...bridge.config, sttUrl: "http://127.0.0.1:9/inference" });
      await bridge.stt.probe();
      const down = await raw(hp, "/api/transcribe", { method: "POST", headers: { "x-room-key": key, "content-type": "audio/wav" }, body: makeWav(0.2) });
      assert.equal(down.status, 503);
      assert.equal(down.json.error, "no-stt");
      bridge.stt.configure(bridge.config);
      await bridge.stt.probe();
    });
  });

  describe("parts bin", () => {
    let manifest;
    before(async () => {
      manifest = (await raw(hp, "/api/parts", { headers: { "x-room-key": key } })).json;
    });

    it("lists blueprints inline and models/modules by URL", () => {
      const byName = Object.fromEntries(manifest.parts.map((p) => [p.name, p]));
      assert.deepEqual(Object.keys(byName).sort(), ["lantern", "my sword", "snowman"]);
      assert.equal(byName.snowman.kind, "blueprint");
      assert.deepEqual(byName.snowman.aliases, ["frosty"]);
      assert.equal(byName.snowman.blueprint.parts.length, 3);
      assert.equal(byName.snowman.size.length, 3);
      assert.equal(byName["my sword"].kind, "gltf");
      assert.equal(byName["my sword"].holdable, true);
      assert.deepEqual(byName["my sword"].grip, { p: [0, 0.2, 0], r: [-90, 0, 0] });
      assert.equal(byName["my sword"].category, "combat");
      assert.match(byName["my sword"].url, /^parts\/file\/[0-9a-f]{16}\/0\/My_Sword\.glb$/);
      assert.equal(byName.lantern.kind, "module");
      assert.ok(quietLog.lines.some((l) => /broken\.json/.test(l)), "invalid blueprint skipped with a warning");
    });

    it("serves parts files by capability URL, refuses traversal", async () => {
      const sword = manifest.parts.find((p) => p.name === "my sword");
      const file = await raw(hp, `/api/${sword.url}`);
      assert.equal(file.status, 200);
      assert.equal(file.headers["content-type"], "model/gltf-binary");
      assert.equal(file.text, "glTF fake binary");
      const viaGame = await raw(hp, `${GAME_PATH}api/${sword.url}`);
      assert.equal(viaGame.status, 200);
      assert.equal((await raw(hp, "/api/parts/file/0/My_Sword.glb")).status, 401);
      assert.equal((await raw(hp, "/api/parts/file/0/My_Sword.glb", { headers: { "x-room-key": key } })).status, 200);
      const cap = sword.url.split("/")[2];
      for (const bad of [`${cap}/0/../../data/config.json`, `${cap}/0/%2e%2e/%2e%2e/etc/passwd`, `${cap}/0/notes.txt`, `${cap}/7/My_Sword.glb`, `${cap}/0/.hidden.json`, `${cap}/0/..%2fdata%2fconfig.json`]) {
        const res = await raw(hp, `/api/parts/file/${bad}`);
        assert.equal(res.status, 404, bad);
      }
    });

    it("saves AI blueprints to generated/ without overwriting", async () => {
      const bp = { name: "Robot Butler", desc: "tall robot", parts: [{ shape: "box", p: [0, 1, 0], s: [0.6, 1, 0.4], color: "gray", mat: "metal" }, { shape: "sphere", p: [0, 1.7, 0], s: [0.4, 0.4, 0.4] }] };
      const saved = await post("parts/save", { blueprint: bp });
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.json.name, "robot butler");
      const file = path.join(partsDir, "generated", "robot-butler.json");
      assert.ok(fs.existsSync(file));
      assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).parts.length, 2);
      const same = await post("parts/save", { blueprint: bp });
      assert.equal(same.json.name, "robot butler");
      assert.equal(fs.readdirSync(path.join(partsDir, "generated")).length, 1, "identical design is not duplicated");
      const other = await post("parts/save", { blueprint: { ...bp, parts: [...bp.parts, { shape: "cone", p: [0, 2, 0], s: [0.1, 0.2, 0.1] }] } });
      assert.equal(other.json.name, "robot butler 2");
      fs.writeFileSync(path.join(partsDir, "generated", "x.json"), "{}");
      const third = await post("parts/save", { blueprint: { name: "robot butler 2", parts: [{ shape: "box", p: [0, 0.1, 0], s: [0.2, 0.2, 0.2] }] } });
      assert.equal(third.json.name, "robot butler 3");
      const bad = await post("parts/save", { blueprint: { name: "nothing", parts: [] } });
      assert.equal(bad.status, 400);
      const list = (await raw(hp, "/api/parts", { headers: { "x-room-key": key } })).json.parts.map((p) => p.name);
      assert.ok(list.includes("robot butler") && list.includes("robot butler 2") && list.includes("robot butler 3"));
    });
  });

  it("HTTPS: TLS handshake with the generated certificate", async () => {
    const res = await new Promise((resolve, reject) => {
      const req = https.get({ host: "127.0.0.1", port: sp, path: "/api/hello", rejectUnauthorized: false, agent: false }, (r) => {
        const peer = r.socket.getPeerX509Certificate?.();
        let body = "";
        r.on("data", (c) => (body += c));
        r.on("end", () => resolve({ status: r.statusCode, body, peer, authorized: r.socket.authorized }));
      });
      req.on("error", reject);
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).bridge, true);
    const pem = fs.readFileSync(path.join(dataDir, "cert.pem"), "utf8");
    const x509 = new crypto.X509Certificate(pem);
    assert.ok(res.peer, "peer certificate");
    assert.equal(res.peer.fingerprint256, x509.fingerprint256);
    for (const ip of ["127.0.0.1", ...lanIPs()]) assert.ok(certIPs(x509).includes(ip), `SAN has ${ip}`);
    // A client that trusts this exact certificate verifies the chain and the IP.
    const trusted = await new Promise((resolve, reject) => {
      https.get({ host: "127.0.0.1", port: sp, path: "/api/hello", ca: pem, agent: false }, (r) => {
        r.resume();
        r.on("end", () => resolve(r.statusCode));
      }).on("error", reject);
    });
    assert.equal(trusted, 200);
    const page = await raw(sp, "/vr-games/", { secure: true });
    assert.equal(page.status, 200);
  });

  it("persists the room to room.json and restores it after a restart", async () => {
    const res = await post("join", { name: "Saver", device: "desktop" });
    const user = res.json.user.id;
    const seq = (await post("op", { user, op: { t: "add", uid: "op9", obj: { id: "obench1", part: "bench", p: [5, 0, 5] } } })).json.seq;
    await post("op", { user, op: { t: "set", id: "obench1", patch: { p: [6, 0, 6] }, transient: true, uid: "op10" } });
    await bridge.stop();
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "room.json"), "utf8"));
    assert.deepEqual(saved.state.objects.obench1.p, [6, 0, 6], "transient change flushed on shutdown");
    assert.equal(saved.seq, seq + 1);
    bridge = await createBridge({
      dataDir, partsDir, port: 0, httpPort: 0, https: false, quiet: true, log: quietLog,
      configOverrides: { ollamaUrl: ollama.url, sttUrl: `${whisper.url}/inference` },
    });
    const info = await bridge.start();
    assert.equal(info.ports.https, null);
    hp = info.ports.http;
    const joined = await post("join", { name: "Back", device: "desktop" });
    assert.equal(joined.status, 200);
    assert.deepEqual(joined.json.state.objects.obench1.p, [6, 0, 6]);
    assert.ok(joined.json.state.objects.ocrate1);
    assert.equal(joined.json.seq, seq + 1);
    const hello = await raw(hp, "/api/hello", { headers: { "x-room-key": key } });
    assert.deepEqual(hello.json.lan, []);
  });

  it("refuses a data folder inside the repository", async () => {
    await assert.rejects(createBridge({ dataDir: path.resolve("games/training-room/bridge/data"), log: quietLog }), /inside the game repository/);
  });
});
