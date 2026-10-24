// Laptop bridge end to end: static serving, auth, room sync over SSE, model/STT proxies (with fake
// Ollama and whisper servers), magic-marker interpretation (vision and ASCII art), the laptop voice
// (fake Piper and Kokoro-style servers, Net.tts and speak()), parts bin, shared frames, HTTPS
// certificate and persistence.
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
import { fileURLToPath } from "node:url";
import { createBridge, renderQR, GAME_PATH } from "../bridge/server.mjs";
import { generateCert, ensureCert, certIPs, lanIPs, lanAddresses } from "../bridge/cert.mjs";
import {
  extractJSON, normalizeOutput, buildPrompt, EXAMPLES, intentSchema, pickModel, createMatcher, catalogText, LocalModel,
  interpretSchema, buildInterpretPrompt, normalizeInterpret, attachImage, pickVisionModel, BEHAVIORS, VISION_NAME,
  MAX_INTENTS, ANSWER_TOKENS, DESIGN_PARTS, designSchema, buildDesignPrompt, normalizeDesign,
} from "../bridge/llm.mjs";
import { cleanTranscript, SpeechToText } from "../bridge/stt.mjs";
import { cleanSpeech } from "../bridge/tts.mjs";
import { sanitizeConfig, generateRoomKey, defaultDataDir } from "../bridge/config.mjs";
import { allMeta, getMeta } from "../js/parts/meta/index.js";
import { planIntents } from "../js/core/execute.js";
import { createState, applyOp } from "../js/core/room-state.js";
import { Net } from "../js/net/net.js";
import { qrcode } from "../vendor/qrcode.mjs";
import { startFakeOllama, startFakeWhisper, startFakeOpenAI, startFakePiper, makeWav, closeServer, PNG_DATA_URL, ASCII_CIRCLE } from "./fixtures/bridge-fakes.mjs";

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

async function until(predicate, ms = 3000, label = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await wait(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const FISH_PARTS = [{ shape: "sphere", p: [0, 2, 0], s: [1, 0.5, 0.3], color: "orange" }, { shape: "cone", p: [-0.6, 2, 0], s: [0.3, 0.4, 0.1], r: [0, 0, 90] }];

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

  it("ensureCert keeps earlier networks, so going back to a known Wi-Fi needs no new certificate", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "cert-roam-"));
    ensureCert(dir, { ips: ["127.0.0.1", "192.168.1.30"] });
    const work = ensureCert(dir, { ips: ["127.0.0.1", "10.0.4.17"] });
    assert.equal(work.generated, true);
    const covered = certIPs(new crypto.X509Certificate(work.cert));
    assert.ok(covered.includes("192.168.1.30") && covered.includes("10.0.4.17"), covered.join(","));
    const home = ensureCert(dir, { ips: ["127.0.0.1", "192.168.1.30"] });
    assert.equal(home.generated, false);
    assert.equal(home.cert, work.cert);
  });

  it("ensureCert does not regenerate for a changed VM/WSL adapter address", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "cert-vm-"));
    const first = ensureCert(dir, { ips: ["127.0.0.1", "192.168.1.30", "172.20.16.1"], required: ["127.0.0.1", "192.168.1.30"] });
    const reboot = ensureCert(dir, { ips: ["127.0.0.1", "192.168.1.30", "172.29.0.1"], required: ["127.0.0.1", "192.168.1.30"] });
    assert.equal(reboot.generated, false);
    assert.equal(reboot.cert, first.cert);
  });

  it("lanIPs lists non-internal IPv4, real adapters first", () => {
    const list = lanIPs({
      "vEthernet (WSL)": [{ family: "IPv4", address: "172.20.16.1", internal: false }],
      lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
      "Wi-Fi": [{ family: "IPv4", address: "192.168.1.44", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
    });
    assert.deepEqual(list, ["192.168.1.44", "172.20.16.1"]);
    assert.deepEqual(lanAddresses({ "vEthernet (WSL)": [{ family: "IPv4", address: "172.20.16.1", internal: false }], eth0: [{ family: "IPv4", address: "169.254.3.4", internal: false }] }).map((a) => a.virtual), [true, true]);
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
    assert.match(generateRoomKey(), /^[A-HJ-NP-Z2-9]{10}$/);
    assert.match(defaultDataDir({}, "linux"), /\.config[\\/]dot-training-room$/);
    assert.match(defaultDataDir({ APPDATA: "C:/Users/me/AppData/Roaming" }, "win32"), /Roaming[\\/]dot-training-room$/);
    assert.equal(defaultDataDir({ TRAINING_ROOM_DATA: "/srv/tr" }, "linux"), path.resolve("/srv/tr"));
  });

  it("config: vision model and laptop voice settings", () => {
    const { config: d } = sanitizeConfig({});
    assert.deepEqual([d.visionModel, d.ttsKind, d.ttsUrl, d.ttsVoice, d.ttsModel], ["", "none", "", "af_heart", "kokoro"]);
    const { config, problems } = sanitizeConfig({ visionModel: " llava ", ttsKind: "piper", ttsUrl: "http://127.0.0.1:5000/", ttsVoice: "bm_george" });
    assert.deepEqual(problems, []);
    assert.deepEqual([config.visionModel, config.ttsKind, config.ttsUrl, config.ttsVoice], ["llava", "piper", "http://127.0.0.1:5000", "bm_george"]);
    const bad = sanitizeConfig({ ttsKind: "espeak", ttsUrl: "file:///etc/passwd", ttsModel: "" });
    assert.deepEqual(bad.problems, ["ttsKind", "ttsUrl"]);
    assert.equal(bad.config.ttsKind, "none");
    assert.equal(bad.config.ttsUrl, "");
    assert.equal(bad.config.ttsModel, "kokoro");
    assert.equal(cleanSpeech(" Hello\n\tthere\u0007! "), "Hello there !");
    assert.equal(cleanSpeech("word ".repeat(200)), "word ".repeat(80).trim(), "at most 400 characters");
  });

  it("config: parser first and model timeouts for a slow laptop", () => {
    const { config: d } = sanitizeConfig({});
    assert.deepEqual([d.parserFirst, d.modelTimeoutSec, d.visionTimeoutSec], [false, 25, 45]);
    const { config, problems } = sanitizeConfig({ parserFirst: true, modelTimeoutSec: 90, visionTimeoutSec: 120 });
    assert.deepEqual(problems, []);
    assert.deepEqual([config.parserFirst, config.modelTimeoutSec, config.visionTimeoutSec], [true, 90, 120]);
    const bad = sanitizeConfig({ parserFirst: "yes", modelTimeoutSec: 2, visionTimeoutSec: 30.5 });
    assert.deepEqual(bad.problems, ["parserFirst", "modelTimeoutSec", "visionTimeoutSec"]);
    assert.deepEqual([bad.config.parserFirst, bad.config.modelTimeoutSec, bad.config.visionTimeoutSec], [false, 25, 45]);
  });

  it("magic marker prompt: honest-guess system prompt, catalog, ASCII art or image, the player's words", () => {
    const metas = allMeta();
    const schema = interpretSchema();
    assert.deepEqual(schema.required, ["guess", "confidence", "part", "behavior", "say"]);
    assert.deepEqual(schema.properties.behavior.enum, BEHAVIORS);
    assert.deepEqual(BEHAVIORS, ["swim", "fly", "walk", "hop", "roll", "spin", "float", "bounce", "sway", "none"]);
    assert.equal(schema.properties.blueprint.properties.parts.items.properties.shape.enum.length, 6);
    const stats = { strokes: 1, points: 64, closed: 1, aspect: 1.1, width: 0.6, height: 0.55 };
    const text = buildInterpretPrompt({ ascii: ASCII_CIRCLE + "\n`", stats, size: [0.6, 0.55], metas, extraParts: ["dragon statue", "ball"] });
    assert.equal(text.length, 2);
    assert.equal(text[0].role, "system");
    assert.match(text[0].content, /drew something in the air with a magic marker, like Harold and the Purple Crayon or ChalkZone/);
    assert.match(text[0].content, /do not flatter bad drawings: if it looks like a fish, say fish\. Then make it real\./);
    assert.match(text[0].content, /swim\|fly\|walk\|hop\|roll\|spin\|float\|bounce\|sway\|none/);
    assert.match(text[0].content, /^- ball \(soccer ball\) /m, "catalog included");
    assert.match(text[0].content, /"part":"","blueprint":\{"name":"snail"/, "a blueprint example");
    const user = text[1].content;
    assert.ok(user.includes("```\n" + ASCII_CIRCLE + "\n'\n```"), "ASCII art fenced, backticks neutralized");
    assert.match(user, /Size: about 0\.6 m wide and 0\.55 m tall\. 1 stroke, 64 points, 1 closed shape, aspect 1\.1 \(width \/ height\)\./);
    assert.match(user, /Also available parts: dragon statue\.$/m, "known catalog names are not repeated");
    assert.match(user, /Player's words: none \(guess from the drawing\)\./);
    const seen = buildInterpretPrompt({ ascii: ASCII_CIRCLE, stats: { closed: false }, size: [1, 0.5], hint: "make it a fish", metas, vision: true });
    assert.equal(seen[0].content, text[0].content, "the system prompt is identical across calls (KV cache)");
    assert.doesNotMatch(seen[1].content, /```|####/, "no ASCII art next to the image");
    assert.match(seen[1].content, /attached image/);
    assert.match(seen[1].content, /about 1 m wide and 0\.5 m tall\. Open lines\./);
    assert.match(seen[1].content, /Player's words: "make it a fish"/);
    const forOllama = attachImage(seen[1], PNG_DATA_URL, "ollama");
    assert.deepEqual(forOllama, { role: "user", content: seen[1].content, images: [PNG_DATA_URL.slice("data:image/png;base64,".length)] });
    const forOpenAI = attachImage(seen[1], PNG_DATA_URL, "openai");
    assert.deepEqual(forOpenAI, { role: "user", content: [{ type: "text", text: seen[1].content }, { type: "image_url", image_url: { url: PNG_DATA_URL } }] });
    // A small context window gets a names-only catalog.
    assert.match(user, /# is ink, dots and spaces are empty/);
    const tight = buildInterpretPrompt({ ascii: "#", metas, numCtx: 2048 });
    assert.doesNotMatch(tight[0].content, /^- ball/m);
    assert.match(tight[0].content, /\bball, /);
  });

  it("normalizeInterpret: catalog parts by name or head noun, honest blueprints, clamps and defaults", () => {
    const match = createMatcher(allMeta(), ["owner rocket"]);
    const n = (raw) => normalizeInterpret(raw, { match });
    assert.deepEqual(n({ guess: "Soccer Ball", confidence: 85, part: "soccer ball", blueprint: { parts: FISH_PARTS }, behavior: "Bouncing", say: " Boing! " }),
      { guess: "soccer ball", confidence: 0.85, part: "ball", behavior: "bounce", say: "Boing!" }, "alias → catalog name, no blueprint with a part");
    assert.equal(n({ guess: "big red ball", part: "big red ball", behavior: "roll", say: "Roll on." }).part, "ball", "head noun");
    assert.equal(n({ guess: "crate", part: "", behavior: "none", say: "A crate." }).part, "crate", "a guess that is a catalog name");
    assert.equal(n({ guess: "rocket", part: "Owner Rocket", behavior: "fly", say: "Up!" }).part, "owner rocket", "client parts");
    const house = n({ guess: "tree house", part: "tree house", behavior: "sway", say: "A tree house!", blueprint: { name: "Tree House", parts: FISH_PARTS } });
    assert.equal(house.part, "", "a tree house is not a tree");
    assert.equal(house.blueprint.name, "tree house");
    const fish = n({ guess: "a fish", confidence: 150, part: "fish", blueprint: { name: "Fish", parts: FISH_PARTS }, behavior: "swimming", say: "That's clearly a fish. ".repeat(20) });
    assert.equal(fish.guess, "fish");
    assert.equal(fish.confidence, 1);
    assert.equal(fish.part, "", "no fish in the catalog");
    assert.equal(fish.behavior, "swim");
    assert.ok(fish.say.length <= 160 && fish.say.startsWith("That's clearly a fish."));
    assert.equal(fish.blueprint.parts.length, 2);
    assert.ok(Math.abs(Math.min(...fish.blueprint.parts.map((p) => p.p[1] - p.s[1] / 2))) < 0.06, "re-centered to the ground");
    assert.equal(fish.blueprint.size.length, 3);
    assert.deepEqual(Object.keys(fish), ["guess", "confidence", "part", "blueprint", "behavior", "say"]);
    assert.deepEqual(n({ part: "crate", behavior: "teleport", confidence: -3 }), { guess: "crate", confidence: 0, part: "crate", behavior: "none", say: "That looks like a crate!" });
    assert.deepEqual(n({ guess: "octopus", behavior: "SWIM" }), { guess: "octopus", confidence: 0.5, part: "", behavior: "swim", say: "That looks like an octopus!" }, "no part, no blueprint: the client makes a doodle");
    assert.equal(n({ guess: "", part: "", say: "Hmm" }), null);
    assert.equal(n("fish"), null);
    assert.equal(n([{ guess: "fish" }]), null);
    assert.equal(n({ guess: "fish", blueprint: { parts: [] } }).blueprint, undefined, "invalid blueprints are dropped");
  });

  it("vision model: Ollama /api/show capabilities, name fallback, visionModel setting, cache", async () => {
    const fake = await startFakeOllama({ models: ["qwen2.5-coder:7b", "llava:7b", "qwen2.5vl:7b", "nomic-embed-text:latest"] });
    const textOnly = await startFakeOllama({ models: ["qwen2.5-coder:7b", "gemma3:1b"], caps: { "gemma3:1b": ["completion"] } });
    const noShow = await startFakeOllama({ models: ["qwen2.5-coder:7b", "llava:7b"], show: false });
    try {
      const model = new LocalModel({ ollamaUrl: fake.url }, { log: quietLog });
      await model.refresh(true);
      assert.equal(model.name, "qwen2.5-coder:7b");
      assert.equal(model.vision, "qwen2.5vl:7b", "Qwen VL ranks above LLaVA");
      assert.deepEqual([...fake.shows].sort(), ["llava:7b", "qwen2.5-coder:7b", "qwen2.5vl:7b"], "embedding models are not asked");
      await model.refresh(true);
      assert.equal(fake.shows.length, 3, "capabilities are cached per model");
      const pinned = new LocalModel({ ollamaUrl: fake.url, visionModel: "llava:7b" }, { log: quietLog });
      await pinned.refresh(true);
      assert.equal(pinned.vision, "llava:7b");
      const missing = new LocalModel({ ollamaUrl: fake.url, visionModel: "llama3.2-vision" }, { log: quietLog });
      await missing.refresh(true);
      assert.equal(missing.vision, null);
      const plain = new LocalModel({ ollamaUrl: textOnly.url }, { log: quietLog });
      await plain.refresh(true);
      assert.equal(plain.vision, null, "a vision-looking name without the capability does not count");
      const old = new LocalModel({ ollamaUrl: noShow.url }, { log: quietLog });
      await old.refresh(true);
      assert.equal(old.vision, "llava:7b", "name-based guess when /api/show cannot tell");
      assert.equal(pickVisionModel(["llava:7b", "gemma3:4b"], "gemma3:4b"), "gemma3:4b", "one model for both");
      assert.equal(pickVisionModel(["moondream:latest", "llava:13b"]), "llava:13b");
      assert.equal(pickVisionModel([]), null);
      for (const name of ["llava:7b", "qwen2.5vl:7b", "qwen3-vl:8b", "gemma3:4b", "minicpm-v:8b", "llama3.2-vision:11b", "moondream"]) assert.match(name, VISION_NAME);
      for (const name of ["qwen2.5-coder:7b", "llama3.2:3b", "mistral:7b"]) assert.doesNotMatch(name, VISION_NAME);
    } finally {
      await closeServer(fake.server);
      await closeServer(textOnly.server);
      await closeServer(noShow.server);
    }
  });

  it("OpenAI-compatible provider: the drawing goes along as an image_url content part", async () => {
    const fake = await startFakeOpenAI({ models: ["text-embedding-nomic-embed-text-v1.5", "qwen2.5-7b-instruct", "qwen2.5-vl-7b-instruct"] });
    try {
      const model = new LocalModel({ provider: "openai", openaiUrl: `${fake.url}/v1` }, { log: quietLog });
      await model.refresh(true);
      assert.equal(model.name, "qwen2.5-7b-instruct");
      assert.equal(model.vision, "qwen2.5-vl-7b-instruct");
      const out = await model.interpret({ image: PNG_DATA_URL, ascii: ASCII_CIRCLE, size: [1, 0.5], metas: allMeta() });
      assert.equal(out.guess, "fish");
      assert.equal(out.vision, true);
      assert.equal(out.model, "qwen2.5-vl-7b-instruct");
      const sent = fake.requests.at(-1).body;
      assert.equal(sent.response_format.json_schema.name, "interpret");
      assert.deepEqual(sent.messages.at(-1).content[1], { type: "image_url", image_url: { url: PNG_DATA_URL } });
      assert.equal(sent.messages.at(-1).content[0].type, "text");
      assert.equal(sent.temperature, 0.3);
      const text = await model.interpret({ ascii: ASCII_CIRCLE, size: [0.5, 0.5], metas: allMeta() });
      assert.deepEqual([text.part, text.vision, text.model], ["ball", false, "qwen2.5-7b-instruct"]);
    } finally {
      await closeServer(fake.server);
    }
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
        { do: "spawn", what: { part: "playing cards" }, place: { rel: "on", ref: { batch: 1 } } },
        { do: "summon", part: "axes", place: { rel: "hand", hand: "LEFT" } },
        { do: "spawn", what: { part: "flux capacitor" } },
        { do: "spawn", what: { custom: { name: "Snow Man", parts: [{ shape: "sphere", p: [0, 2, 0], s: [1, 1, 1], color: "white" }, { shape: "ball", p: [0, 2.8, 0], s: [0.6, 0.6, 0.6] }] } } },
        { do: "scale", target: "it", factor: 1000 },
        { do: "time", value: "evening" },
        { do: "remove", target: { part: "dragon statue" } },
        { do: "write", target: { part: "white board" }, text: "Q3 goals" },
        { do: "move", target: { id: "o1" } },
        { do: "move", target: { ref: "that" }, place: { rel: "left side", dist: "3" } },
      ],
      say: "Okay.",
    }, { metas, sceneNames: new Set(["dragon statue"]) });
    const [table, deck, axe, unknown, snow, scale, time, remove, write, move] = out.intents;
    assert.equal(out.intents.length, 10);
    assert.deepEqual(move, { do: "move", target: { ref: "it" }, place: { rel: "left", dist: 3 } });
    const [, crate] = normalizeOutput({ intents: [{ do: "dance" }, { do: "spawn", what: { part: "poker table" } }, { do: "spawn", what: "crate", place: { rel: "on", ref: 1 } }] }, { metas }).intents;
    assert.deepEqual(crate, { do: "spawn", what: { part: "crate" }, place: { rel: "on", ref: { batch: 0 } } });
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
    const many = normalizeOutput({ intents: Array.from({ length: 50 }, (_, i) => ({ do: "spawn", what: { part: "crate" }, place: { rel: "front", dist: i + 1 } })) }, { metas });
    assert.equal(many.intents.length, MAX_INTENTS, "capped");
    const repeats = normalizeOutput({ intents: Array.from({ length: 30 }, () => ({ do: "spawn", what: { part: "crate" } })) }, { metas });
    assert.equal(repeats.intents.length, 1, "a small model repeating itself spawns one, not thirty");
  });

  it("the command prompt forbids refusals and made-up names, and spells out category words", () => {
    const [system] = buildPrompt({ text: "give me a gun", catalog: catalogText(allMeta()) });
    assert.match(system.content, /Guns, swords, bows[^\n]*harmless props[^\n]*Never refuse/);
    assert.match(system.content, /For anything the catalog lacks, spawn what:\{label:"<what it is>"\}[^\n]*designed on the spot/);
    assert.doesNotMatch(system.content, /BLUEPRINT/, "no inline designs: they have their own call");
    assert.equal(intentSchema().properties.intents.items.properties.what.properties.custom, undefined);
    assert.match(system.content, /A category word \(furniture/);
    assert.match(system.content, /never the same intent twice/);
  });

  it("designSchema, buildDesignPrompt and normalizeDesign", () => {
    const schema = designSchema();
    assert.equal(schema.properties.parts.maxItems, DESIGN_PARTS);
    assert.ok(schema.required.includes("parts") && schema.required.includes("say"));
    const [system, user] = buildDesignPrompt({ name: "machine gun", hint: "AI give me a machine gun" });
    assert.match(system.content, /Never refuse/);
    assert.match(system.content, /business end \([^)]*\) along \+z/);
    assert.equal(user.content, 'Design: "machine gun"\nThe player said: "AI give me a machine gun"');
    assert.equal(buildDesignPrompt({ name: "lamp", hint: "Lamp" })[1].content, 'Design: "lamp"', "a hint that only repeats the name is left out");
    const parts = [
      { shape: "box", p: [0, 1, 0], s: [0.1, 0.1, 0.5], color: "#222222", mat: "metal" },
      { shape: "cylinder", p: [0, 1, 0.3], s: [0.03, 0.2, 0.03], color: "#111111", mat: "metal", r: [90, 0, 0] },
    ];
    const out = normalizeDesign({ name: "Blaster", holdable: true, parts, say: "Pew." }, "Machine Gun");
    assert.equal(out.blueprint.name, "machine gun", "keeps the requested name");
    assert.ok(out.blueprint.aliases.includes("blaster"), "the model's own name becomes an alias");
    assert.equal(out.blueprint.holdable, true);
    assert.ok(Math.abs(out.blueprint.parts[0].p[1] - 0.05) < 1e-6, "re-centered to the ground");
    assert.equal(out.say, "Pew.");
    assert.equal(normalizeDesign({ blueprint: { parts }, say: "" }, "anvil").say, "An anvil, made just for you.", "unwrapped, default say");
    assert.equal(normalizeDesign({ name: "x", parts: [], say: "I can't help with that." }, "gun"), null, "no shapes is a failure, not an empty thing");
    assert.equal(normalizeDesign("nope", "gun"), null);
    assert.equal(normalizeDesign([parts], "gun"), null);
  });

  it("normalizeOutput: a label alone is something to design, not the nearest catalog part", () => {
    const metas = allMeta();
    const what = (w) => normalizeOutput({ intents: [{ do: "spawn", what: w }] }, { metas }).intents[0].what;
    assert.deepEqual(what({ label: "dragon statue" }), { part: "dragon statue", label: "dragon statue" }, "not a statue");
    assert.deepEqual(what({ label: "machine gun" }), { part: "machine gun", label: "machine gun" });
    assert.deepEqual(what({ label: "swords" }), { part: "sword", label: "swords" }, "exact catalog names still count");
    assert.deepEqual(what({ part: "dragon statue" }), { part: "statue", label: "dragon statue" }, "a part name may still be fuzzy");
  });

  it("normalizeOutput keeps { batch: n } targets: the part spawned earlier in this command", () => {
    const metas = allMeta();
    const norm = (list) => normalizeOutput(list, { metas }).intents;
    const spawn = (part) => ({ do: "spawn", what: { part } });
    assert.deepEqual(norm([spawn("whiteboard"), { do: "write", target: { batch: 0 }, text: "Q3 goals" }])[1], { do: "write", target: { batch: 0 }, text: "Q3 goals" });
    assert.deepEqual(norm([spawn("crate"), { do: "remove", target: { batch: 0 } }])[1], { do: "remove", target: { batch: 0 } }, "not dropped");
    assert.deepEqual(norm([spawn("ball"), { do: "color", target: { batch: "0" }, color: "red" }])[1].target, { batch: 0 }, "not { ref: it }");
    assert.deepEqual(norm([spawn("ball"), { do: "scale", target: 0, factor: 2 }])[1].target, { batch: 0 }, "bare number");
    assert.deepEqual(norm([spawn("ball"), { do: "animate", target: { batch: 0 }, behavior: "bounce" }])[1].target, { batch: 0 });
    assert.deepEqual(norm([{ do: "nonsense" }, spawn("crate"), { do: "color", target: { batch: 1 }, color: "red" }])[1].target, { batch: 0 }, "renumbered after a dropped intent");
    assert.equal(norm([spawn("crate"), { do: "remove", target: { batch: 5 } }]).length, 1, "a batch that is not an earlier intent names nothing");
    assert.deepEqual(norm([{ do: "color", target: { batch: 0 }, color: "red" }])[0].target, { ref: "it" }, "no earlier intent: the usual fallback");
    assert.deepEqual(norm([spawn("crate"), { ...spawn("ball"), place: { rel: "on", ref: { batch: 0 } } }])[1].place.ref, { batch: 0 }, "placement refs unchanged");

    // The executor writes on the new whiteboard, not on the older one nearer the player.
    const state = createState();
    applyOp(state, { t: "add", obj: { id: "old", part: "whiteboard", label: "whiteboard", p: [0, 0, -1], ry: 0, s: 1 } });
    let n = 0;
    const plan = planIntents(norm([{ ...spawn("whiteboard"), place: { rel: "front", dist: 4 } }, { do: "write", target: { batch: 0 }, text: "Q3 goals" }]), {
      state, player: { p: [0, 1.6, 0], yaw: 0, hands: {} }, user: "u1", metas, metaOf: getMeta, newId: (prefix = "o") => `${prefix}${++n}`,
    });
    const added = plan.ops.filter((op) => op.t === "add");
    const wrote = plan.ops.find((op) => op.t === "set" && op.patch?.text === "Q3 goals");
    assert.equal(added.length, 1, "no sticky note");
    assert.equal(wrote?.id, added[0].obj.id);
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
    assert.match(messages[0].content, /- villa \(mansion\) 14x9x12:/);
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
    // A huge laptop parts bin still fits: custom parts collapse to names, examples are dropped.
    const big = [...metas, ...Array.from({ length: 400 }, (_, i) => ({ name: `custom thing ${i}`, aliases: [], category: "custom", desc: "a fairly long description of a generated design number " + i, size: [1, 1, 1], source: "laptop" }))];
    const fitted = buildPrompt({ text: "spawn a villa", metas: big, numCtx: 8192 });
    const chars = fitted.reduce((n, m) => n + m.content.length, 0);
    assert.ok(chars / 3.2 <= 8192 - 2200 + 50, `prompt too big: ${chars} chars`);
    assert.match(fitted[0].content, /- custom thing 119$/m);
    assert.match(fitted[0].content, /and 280 more saved parts/);
    assert.ok(fitted.length >= 7, "the core examples are kept");
    assert.match(fitted.at(-1).content, /Command: "spawn a villa"/);
    const schema = intentSchema();
    assert.deepEqual(schema.required, ["intents", "say"]);
    assert.equal(schema.properties.intents.items.properties.do.enum.length, 20);
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

  it("OpenAI-compatible provider (LM Studio): model list, json_schema chat, transcriptions", async () => {
    const fake = await startFakeOpenAI();
    try {
      const model = new LocalModel({ provider: "openai", openaiUrl: `${fake.url}/v1`, think: false }, { log: quietLog });
      const status = await model.refresh(true);
      assert.deepEqual(status, { available: true, name: "qwen2.5-7b-instruct", provider: "openai" });
      const result = await model.command({ text: "katana in my right hand", metas: allMeta() });
      assert.deepEqual(result.intents, [{ do: "spawn", what: { part: "katana" }, place: { rel: "hand", hand: "right" } }]);
      assert.equal(result.source, "model");
      const sent = fake.requests.find((r) => r.path === "/v1/chat/completions").body;
      assert.equal(sent.response_format.type, "json_schema");
      assert.equal(sent.response_format.json_schema.name, "intents");
      assert.equal(sent.response_format.json_schema.strict, false);
      assert.equal(sent.response_format.json_schema.schema.type, "object");
      assert.equal(sent.reasoning_effort, "none");
      assert.equal(sent.temperature, 0.1);
      const stt = new SpeechToText({ sttKind: "openai", sttUrl: `${fake.url}/v1/audio/transcriptions`, sttModel: "whisper-1" }, { log: quietLog });
      await stt.probe();
      assert.equal(stt.status().available, true);
      const heard = await stt.transcribe(makeWav(0.2));
      assert.equal(heard.text, "spawn a katana");
      const form = fake.requests.find((r) => r.path === "/v1/audio/transcriptions").form;
      assert.match(form, /name="model"\r\n\r\nwhisper-1/);
      assert.match(form, /name="file"; filename="speech.wav"/);
    } finally {
      await closeServer(fake.server);
    }
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
      visionTimeoutMs: 1500,
      ttsTimeoutMs: 1000,
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
    assert.match(config.roomKey, /^[A-HJ-NP-Z2-9]{10}$/);
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

  it("?k= redirects stay on the bridge: //host and /\\host become plain paths", async () => {
    const cases = [
      ["//evil.example/path?k=x&a=1", "/evil.example/path?a=1"],
      ["//evil.example?k=1", "/evil.example"],
      ["/\\evil.example/?k=1", "/evil.example/"],
      ["///\\//evil?k=1", "/evil"],
    ];
    for (const [reqPath, location] of cases) {
      const res = await raw(hp, reqPath);
      assert.equal(res.status, 302, reqPath);
      assert.equal(res.headers.location, location, reqPath);
      assert.equal(new URL(res.headers.location, `http://127.0.0.1:${hp}${reqPath}`).host, `127.0.0.1:${hp}`, `${reqPath} stays on this origin`);
    }
    const ok = await raw(hp, `/vr-games/games/training-room/?k=${key}`);
    assert.equal(ok.headers.location, "/vr-games/games/training-room/");
    assert.ok(ok.headers["set-cookie"]);
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
    assert.deepEqual(open.json.tts, { available: false, kind: "none" });
    const hello = await raw(hp, "/vr-games/games/training-room/api/hello", { headers: { "x-room-key": key } });
    assert.equal(hello.json.auth, true);
    assert.equal(hello.json.key, key);
    assert.deepEqual(hello.json.model, { available: true, name: "qwen2.5-coder:7b", provider: "ollama", vision: null });
    assert.deepEqual(hello.json.tts, { available: false, kind: "none", url: null, detail: "the laptop voice is off (ttsKind: none)" });
    assert.equal(hello.json.stt.available, true);
    assert.equal(hello.json.stt.kind, "whisper.cpp");
    assert.equal(hello.json.parts.count, 3);
    assert.equal(hello.json.parserFirst, false);
    assert.deepEqual(hello.json.timeouts, { model: 1500, vision: 1500 }, "the test bridge's model timeouts");
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

    it("a new stream gets only ops made after its join (no replay of old history)", async () => {
      const d = (await post("join", { name: "Late", device: "laptop" })).json;
      await post("op", { user: b.user.id, op: { t: "env", time: "sunset", uid: "opafterjoin" } });
      const sseD = openSSE(hp, `/api/events?user=${d.user.id}&k=${key}`);
      await sseD.waitFor((e) => e.event === "users");
      await wait(50);
      const ops = sseD.events.filter((e) => e.event === "op").map((e) => e.json.op.uid);
      assert.deepEqual(ops, ["opafterjoin"], "only the op between join and connect is replayed");
      sseD.close();
      await post("leave", { user: d.user.id });
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
      assert.deepEqual(sent.options, { temperature: 0.1, num_ctx: 8192, num_predict: ANSWER_TOKENS.command });
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

  describe("design on the spot", () => {
    it("designs a missing thing with a capped answer and the never-refuse prompt", async () => {
      const res = await post("design", { user: "u1", name: "pistol", hint: "AI give me a pistol" });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.source, "model");
      assert.equal(res.json.model, "qwen2.5-coder:7b");
      assert.equal(res.json.blueprint.name, "pistol");
      assert.equal(res.json.blueprint.holdable, true);
      assert.equal(res.json.blueprint.parts.length, 4);
      assert.equal(res.json.say, "A pistol, pew pew.");
      const sent = ollama.requests.at(-1);
      assert.equal(sent.options.num_predict, ANSWER_TOKENS.design);
      assert.equal(sent.format.properties.parts.maxItems, DESIGN_PARTS);
      assert.match(sent.messages[0].content, /Never refuse/);
      assert.equal(sent.messages[1].content, 'Design: "pistol"\nThe player said: "AI give me a pistol"');
    });

    it("a wrapped answer still works; refusals, junk and a missing name are errors", async () => {
      const wrapped = await post("design", { name: "wrapped blaster" });
      assert.equal(wrapped.status, 200, wrapped.text);
      assert.equal(wrapped.json.blueprint.name, "wrapped blaster");
      assert.ok(wrapped.json.blueprint.aliases.includes("pistol"));
      assert.equal(wrapped.json.say, "A wrapped blaster, made just for you.");
      const refused = await post("design", { name: "refuse this" });
      assert.equal(refused.status, 502);
      assert.equal(refused.json.error, "bad-output");
      assert.equal((await post("design", { name: "junk" })).status, 502);
      const none = await post("design", { name: "  " });
      assert.equal(none.status, 400);
      assert.equal(none.json.error, "no-name");
      assert.equal((await post("design", { name: "pistol" }, { "content-type": "application/json" })).status, 401, "needs the room key");
    });

    it("Net.design returns the blueprint and reports errors with .code", async () => {
      const net = new Net({ base: `http://127.0.0.1:${hp}/api/`, key, EventSourceImpl: null });
      const out = await net.design("pistol", "give me a pistol");
      assert.equal(out.blueprint.name, "pistol");
      await assert.rejects(net.design("junk"), (err) => err.code === "bad-output" && err.status === 502);
      bridge.model.configure({ ...bridge.config, ollamaUrl: "http://127.0.0.1:9" });
      try {
        await assert.rejects(net.design("pistol"), (err) => err.code === "no-model" && err.status === 503);
      } finally {
        bridge.model.configure(bridge.config);
        await bridge.model.refresh(true);
      }
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
      assert.match(byName["my sword"].url, new RegExp(`^http://127\\.0\\.0\\.1:${hp}/vr-games/games/training-room/api/parts/file/[0-9a-f]{16}/0/My_Sword\\.glb$`));
      assert.equal(byName.lantern.kind, "module");
      assert.ok(quietLog.lines.some((l) => /broken\.json/.test(l)), "invalid blueprint skipped with a warning");
    });

    it("serves parts files by capability URL, refuses traversal", async () => {
      const sword = manifest.parts.find((p) => p.name === "my sword");
      const rel = sword.url.slice(sword.url.indexOf("parts/file/"));
      const file = await raw(hp, new URL(sword.url).pathname);
      assert.equal(file.status, 200);
      assert.equal(file.headers["content-type"], "model/gltf-binary");
      assert.equal(file.text, "glTF fake binary");
      const viaAlias = await raw(hp, `/api/${rel}`);
      assert.equal(viaAlias.status, 200);
      assert.equal((await raw(hp, "/api/parts/file/0/My_Sword.glb")).status, 401);
      assert.equal((await raw(hp, "/api/parts/file/0123456789abcdef/0/My_Sword.glb")).status, 401, "wrong capability");
      assert.equal((await raw(hp, "/api/parts/file/0/My_Sword.glb", { headers: { "x-room-key": key } })).status, 200);
      const cap = rel.split("/")[2];
      for (const bad of [`${cap}/0/../../data/config.json`, `${cap}/0/%2e%2e/%2e%2e/etc/passwd`, `${cap}/0/notes.txt`, `${cap}/7/My_Sword.glb`, `${cap}/0/.hidden.json`, `${cap}/0/..%2fdata%2fconfig.json`]) {
        assert.equal((await raw(hp, `/api/parts/file/${bad}`)).status, 404, bad);
        assert.equal((await raw(hp, `/api/parts/file/${bad.slice(cap.length + 1)}`, { headers: { "x-room-key": key } })).status, 404, `${bad} with key`);
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

  describe("magic marker", () => {
    let vision;
    let picky;
    const sketch = { ascii: ASCII_CIRCLE, stats: { strokes: 1, points: 80, closed: 1, aspect: 1.1, width: 0.6, height: 0.55 }, size: [0.6, 0.55] };
    const useModel = async (url) => {
      bridge.model.configure({ ...bridge.config, ollamaUrl: url });
      await bridge.model.refresh(true);
    };

    before(async () => {
      vision = await startFakeOllama({ models: ["qwen2.5-coder:7b", "llava:7b"] });
      picky = await startFakeOllama({ models: ["qwen2.5-coder:7b", "llava-text:7b"], show: false, refuseImages: ["llava-text:7b"] });
    });

    after(async () => {
      await useModel(ollama.url);
      await closeServer(vision?.server);
      await closeServer(picky?.server);
    });

    it("without a vision model the text model reads the ASCII art (vision: false)", async () => {
      const res = await post("interpret", { ...sketch, image: PNG_DATA_URL, parts: ["dragon statue"] });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { guess: "ball", confidence: 0.7, part: "ball", behavior: "bounce", say: "A ball! Boing, boing.", source: "model", model: "qwen2.5-coder:7b", vision: false, ms: res.json.ms });
      assert.ok(res.json.ms >= 0);
      const sent = ollama.requests.at(-1);
      assert.equal(sent.model, "qwen2.5-coder:7b");
      assert.deepEqual(sent.format.required, ["guess", "confidence", "part", "behavior", "say"]);
      assert.equal(sent.options.temperature, 0.3);
      assert.equal(sent.think, false);
      assert.equal(sent.messages.length, 2);
      assert.match(sent.messages[0].content, /Harold and the Purple Crayon/);
      assert.match(sent.messages[0].content, /^- snowman$/m, "laptop parts are in the (compact) catalog");
      const user = sent.messages[1];
      assert.equal(user.images, undefined);
      assert.ok(user.content.includes("```\n" + ASCII_CIRCLE + "\n```"));
      assert.match(user.content, /about 0\.6 m wide and 0\.55 m tall/);
      assert.match(user.content, /Also available parts: dragon statue/);
      const hello = await raw(hp, "/api/hello", { headers: { "x-room-key": key } });
      assert.equal(hello.json.model.vision, null);
    });

    it("with a vision model the drawing goes along as an image (base64 without the data: prefix)", async () => {
      await useModel(vision.url);
      const hello = await raw(hp, "/api/hello", { headers: { "x-room-key": key } });
      assert.equal(hello.json.model.vision, "llava:7b");
      assert.equal(hello.json.model.name, "qwen2.5-coder:7b");
      const res = await raw(hp, `${GAME_PATH}api/interpret`, { method: "POST", headers: auth(), body: { ...sketch, image: PNG_DATA_URL } });
      assert.equal(res.status, 200, res.text);
      const { blueprint, ...rest } = res.json;
      assert.deepEqual(rest, { guess: "fish", confidence: 0.85, part: "", behavior: "swim", say: "That's clearly a fish. Go on, little fish!", source: "model", model: "llava:7b", vision: true, ms: rest.ms });
      assert.equal(blueprint.name, "fish");
      assert.equal(blueprint.parts.length, 3);
      assert.ok(blueprint.size[0] > 1 && blueprint.size[1] > 0.5);
      const sent = vision.requests.at(-1);
      assert.equal(sent.model, "llava:7b");
      assert.deepEqual(sent.messages[1].images, [PNG_DATA_URL.slice("data:image/png;base64,".length)]);
      assert.match(sent.messages[1].content, /attached image/);
      assert.doesNotMatch(sent.messages[1].content, /```/);
      // The same drawing without a picture goes to the text model.
      const text = await post("interpret", sketch);
      assert.equal(text.status, 200, text.text);
      assert.deepEqual([text.json.guess, text.json.part, text.json.vision, text.json.model], ["ball", "ball", false, "qwen2.5-coder:7b"]);
    });

    it("the player's words name the thing: no guessing", async () => {
      const res = await post("interpret", { ...sketch, hint: "make it a fish" });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.guess, "fish");
      assert.equal(res.json.behavior, "swim");
      assert.equal(res.json.vision, false);
      assert.match(vision.requests.at(-1).messages[1].content, /^Player's words: "make it a fish"$/m);
    });

    it("a model that refuses images (a wrong name-based guess) falls back to the ASCII art", async () => {
      await useModel(picky.url);
      assert.equal(bridge.model.vision, "llava-text:7b");
      const res = await post("interpret", { ...sketch, image: PNG_DATA_URL });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual([res.json.guess, res.json.vision, res.json.model], ["ball", false, "qwen2.5-coder:7b"]);
      assert.equal(picky.requests.length, 2);
      assert.equal(picky.requests[0].model, "llava-text:7b");
      await bridge.model.refresh(true);
      assert.equal(bridge.model.vision, null, "not tried with images again for a while");
      const image = await post("interpret", { image: PNG_DATA_URL });
      assert.equal(image.status, 400);
      assert.equal(image.json.error, "no-sketch");
    });

    it("errors: bad output 502, slow 504, bad input 400/413, auth 401, no model 503", async () => {
      await useModel(vision.url);
      const broken = await post("interpret", { ...sketch, hint: "broken" });
      assert.equal(broken.status, 502);
      assert.equal(broken.json.error, "bad-output");
      assert.match(broken.json.raw, /lovely drawing/);
      assert.ok(broken.json.raw.length <= 500);
      const number = await post("interpret", { ...sketch, hint: "number" });
      assert.equal(number.status, 502);
      assert.equal(number.json.error, "bad-output");
      const slowText = await post("interpret", { ...sketch, hint: "slow" });
      assert.equal(slowText.status, 504);
      assert.equal(slowText.json.error, "timeout");
      const slowVision = await post("interpret", { ...sketch, image: PNG_DATA_URL, hint: "slow" });
      assert.equal(slowVision.status, 504);
      assert.equal((await post("interpret", { ascii: "   ", size: [1, 1] })).json.error, "no-sketch");
      const badImage = await post("interpret", { ...sketch, image: "data:text/html;base64,PGh0bWw+" });
      assert.equal(badImage.status, 400);
      assert.equal(badImage.json.error, "bad-image");
      const big = await post("interpret", { ...sketch, image: `data:image/png;base64,${"A".repeat(620 * 1024)}` });
      assert.equal(big.status, 413);
      const fits = await post("interpret", { ...sketch, image: `data:image/png;base64,${"A".repeat(500 * 1024)}` });
      assert.equal(fits.status, 200, "a 500 KB snapshot fits the 600 KB limit");
      const denied = await post("interpret", sketch, { "content-type": "application/json" });
      assert.equal(denied.status, 401);
      await useModel("http://127.0.0.1:9");
      const down = await post("interpret", sketch);
      assert.equal(down.status, 503);
      assert.equal(down.json.error, "no-model");
    });

    it("Net.interpret returns the guess and reports errors with .code", async () => {
      await useModel(vision.url);
      const net = new Net({ base: `http://127.0.0.1:${hp}/api/`, key, EventSourceImpl: null });
      const out = await net.interpret({ ...sketch, image: PNG_DATA_URL });
      assert.deepEqual([out.guess, out.behavior, out.vision, out.model], ["fish", "swim", true, "llava:7b"]);
      assert.equal(out.blueprint.name, "fish");
      await assert.rejects(net.interpret({ ascii: "" }), (err) => err.code === "no-sketch" && err.status === 400);
      await useModel("http://127.0.0.1:9");
      await assert.rejects(net.interpret(sketch), (err) => err.code === "no-model" && err.status === 503);
    });
  });

  describe("laptop voice (TTS)", () => {
    let piper;
    let legacy;
    let kokoro;
    const useVoice = async (overrides) => {
      bridge.tts.configure({ ...bridge.config, ...overrides });
      await bridge.tts.probe();
    };

    before(async () => {
      piper = await startFakePiper({ delayMs: 40 });
      legacy = await startFakePiper({ legacy: true });
      kokoro = await startFakeOpenAI();
    });

    after(async () => {
      await useVoice({});
      await closeServer(piper?.server);
      await closeServer(legacy?.server);
      await closeServer(kokoro?.server);
    });

    it("is off by default: api/tts answers 503 no-tts", async () => {
      const res = await post("tts", { text: "Hello" });
      assert.equal(res.status, 503);
      assert.equal(res.json.error, "no-tts");
    });

    it("piper: POST / with { text } returns WAV, one request at a time", async () => {
      await useVoice({ ttsKind: "piper", ttsUrl: piper.url });
      const hello = await raw(hp, "/api/hello", { headers: { "x-room-key": key } });
      assert.deepEqual(hello.json.tts, { available: true, kind: "piper", url: piper.url });
      const open = await raw(hp, "/api/hello");
      assert.deepEqual(open.json.tts, { available: true, kind: "piper" });
      const res = await post("tts", { text: "  That's clearly\na fish!  " });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.headers["content-type"], "audio/wav");
      assert.equal(res.headers["cache-control"], "no-store");
      assert.ok(res.buffer.equals(piper.audio));
      assert.deepEqual(piper.requests.at(-1), { path: "/", body: { text: "That's clearly a fish!" }, type: "application/json" });
      const many = await Promise.all([1, 2, 3].map((i) => post("tts", { text: `line ${i}` })));
      assert.deepEqual(many.map((r) => r.status), [200, 200, 200]);
      assert.equal(piper.state.maxActive, 1, "serialized");
      await post("tts", { text: "word ".repeat(200) });
      assert.equal(piper.requests.at(-1).body.text, "word ".repeat(80).trim());
      assert.equal((await post("tts", { text: "  " })).status, 400);
      assert.equal((await post("tts", { text: "hi" }, { "content-type": "application/json" })).status, 401);
    });

    it("piper wrappers that answer POST /synthesize", async () => {
      await useVoice({ ttsKind: "piper", ttsUrl: legacy.url });
      const res = await post("tts", { text: "Hello" });
      assert.equal(res.status, 200, res.text);
      assert.ok(res.buffer.equals(legacy.audio));
      await post("tts", { text: "Again" });
      assert.deepEqual(legacy.requests.map((r) => r.path), ["/synthesize", "/synthesize"]);
      assert.equal(bridge.tts.piperTarget, `${legacy.url}/synthesize`);
    });

    it("openai (Kokoro-FastAPI): model, input, voice, response_format wav", async () => {
      await useVoice({ ttsKind: "openai", ttsUrl: `${kokoro.url}/v1/audio/speech` });
      const res = await post("tts", { text: "Hi from the laptop." });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.headers["content-type"], "audio/wav");
      assert.ok(res.buffer.equals(kokoro.audio));
      assert.deepEqual(kokoro.requests.at(-1), { path: "/v1/audio/speech", body: { model: "kokoro", input: "Hi from the laptop.", voice: "af_heart", response_format: "wav" } });
    });

    it("slow voice → 504, unreachable → 503 no-tts", async () => {
      await useVoice({ ttsKind: "piper", ttsUrl: piper.url });
      const slow = await post("tts", { text: "slow please" });
      assert.equal(slow.status, 504);
      assert.equal(slow.json.error, "tts-timeout");
      assert.equal((await post("tts", { text: "fast again" })).status, 200, "the queue moves on");
      await useVoice({ ttsKind: "openai", ttsUrl: "http://127.0.0.1:9/v1/audio/speech" });
      const down = await post("tts", { text: "Hello" });
      assert.equal(down.status, 503);
      assert.equal(down.json.error, "no-tts");
      assert.match(down.json.detail, /not reachable/);
    });

    it("Net.tts gives a Blob and speak() plays it, stops it and falls back to the browser voice", async () => {
      await useVoice({ ttsKind: "piper", ttsUrl: piper.url });
      const net = new Net({ base: `http://127.0.0.1:${hp}/api/`, key, EventSourceImpl: null });
      const blob = await net.tts("Hello");
      assert.equal(blob.size, piper.audio.length);
      assert.equal(blob.type, "audio/wav");
      const played = [];
      const spoken = [];
      class FakeAudio {
        static endAfter = 20;
        constructor() {
          this.paused = true;
          this.duration = NaN;
          this.src = "";
          this.timers = [];
          played.push(this);
        }
        play() {
          this.paused = false;
          this.timers.push(setTimeout(() => this.onplaying?.(), 5));
          this.timers.push(setTimeout(() => this.onended?.(), 5 + FakeAudio.endAfter));
          return Promise.resolve();
        }
        pause() {
          this.paused = true;
          this.timers.forEach(clearTimeout);
        }
        removeAttribute(name) {
          if (name === "src") this.src = "";
        }
        load() {}
      }
      const saved = { Audio: globalThis.Audio, speechSynthesis: globalThis.speechSynthesis, SpeechSynthesisUtterance: globalThis.SpeechSynthesisUtterance };
      globalThis.Audio = FakeAudio;
      globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
      globalThis.speechSynthesis = {
        speaking: false, pending: false, paused: false, getVoices: () => [], cancel() {},
        speak(utter) {
          spoken.push(utter.text);
          setTimeout(() => {
            utter.onstart?.();
            utter.onend?.();
          }, 5);
        },
      };
      const voice = await import("../js/voice/speak.js");
      const warn = console.warn;
      try {
        voice.setSpeechSource((text) => net.tts(text));
        assert.equal(voice.canSpeak(), true);
        let started = 0;
        let ended = null;
        assert.equal(await voice.speak("Hello from the laptop", { onstart: () => started++, onend: (ok) => (ended = ok) }), true);
        assert.equal(played.length, 1);
        assert.equal(started, 1);
        assert.equal(ended, true);
        assert.equal(played[0].src, "", "object URL released");
        assert.equal(piper.requests.at(-1).body.text, "Hello from the laptop");
        assert.deepEqual(spoken, []);
        FakeAudio.endAfter = 60000;
        const pending = voice.speak("A much longer line");
        await until(() => played.length === 2 && !played[1].paused, 3000, "playback");
        assert.equal(voice.isSpeaking(), true);
        voice.cancelSpeech();
        assert.equal(await pending, false);
        assert.equal(played[1].paused, true, "cancelSpeech stops the audio element");
        console.warn = () => {};
        voice.setSpeechSource(() => Promise.reject(Object.assign(new Error("off"), { code: "no-tts" })));
        assert.equal(await voice.speak("Fallback please"), true);
        assert.deepEqual(spoken, ["Fallback please"]);
        voice.setSpeechSource(null);
        assert.equal(await voice.speak("Browser only"), true);
        assert.equal(played.length, 2);
        await useVoice({});
        await assert.rejects(net.tts("Hello"), (err) => err.code === "no-tts" && err.status === 503);
      } finally {
        console.warn = warn;
        voice.setSpeechSource(null);
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete globalThis[name];
          else globalThis[name] = value;
        }
      }
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
    await post("op", { user, op: { t: "add", uid: "op11", obj: { id: "osword9", part: "sword", p: [1, 1.2, 1], attach: { user, hand: "left", grip: "snap" } } } });
    await bridge.stop();
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "room.json"), "utf8"));
    assert.deepEqual(saved.state.objects.obench1.p, [6, 0, 6], "transient change flushed on shutdown");
    assert.equal(saved.seq, seq + 2);
    assert.equal(saved.state.objects.osword9.attach.user, user);
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
    assert.equal(joined.json.seq, seq + 2);
    assert.equal(joined.json.state.objects.osword9.attach, undefined, "held things are released after a restart");
    assert.deepEqual(joined.json.state.objects.osword9.p, [1, 0, 1]);
    const hello = await raw(hp, "/api/hello", { headers: { "x-room-key": key } });
    assert.deepEqual(hello.json.lan, []);
  });

  it("refuses a data folder inside the repository", async () => {
    const inside = fileURLToPath(new URL("../bridge/data", import.meta.url));
    await assert.rejects(createBridge({ dataDir: inside, log: quietLog }), /inside the game repository/);
    assert.equal(fs.existsSync(inside), false);
  });
});
