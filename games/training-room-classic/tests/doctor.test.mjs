// Laptop doctor (bridge/doctor.mjs) run as the owner's pipeline runs it: a child process whose exit
// code is the verdict. Fake Ollama, whisper.cpp and Piper servers stand in for the real ones.
// Run: node --test games/training-room/tests/doctor.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodePNG } from "../bridge/png.mjs";
import { generateCert, lanIPs } from "../bridge/cert.mjs";
import { startFakeOllama, startFakeWhisper, startFakePiper, closeServer } from "./fixtures/bridge-fakes.mjs";

const DOCTOR = fileURLToPath(new URL("../bridge/doctor.mjs", import.meta.url));
const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tr-doctor-test-"));
const DEAD = "http://127.0.0.1:9"; // nothing listens on the discard port

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [DOCTOR, ...args], { env: { ...process.env, TRAINING_ROOM_DATA: "" }, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

// A data folder whose config.json points at the given servers.
function dataDir(name, config) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ httpPort: 9, ...config }));
  return dir;
}

const statuses = (report) => Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
const savedReport = (dir) => {
  const names = fs.readdirSync(path.join(dir, "reports")).sort();
  const json = names.filter((n) => /^doctor-\d{8}-\d{6}(-\d+)?\.json$/.test(n));
  assert.equal(json.length, 1, `one JSON report in ${names.join(", ")}`);
  assert.ok(names.includes(json[0].replace(/\.json$/, ".md")), "the Markdown report sits beside it");
  return JSON.parse(fs.readFileSync(path.join(dir, "reports", json[0]), "utf8"));
};

describe("png encoder", () => {
  it("writes a valid RGBA PNG: signature, chunk CRCs, inflatable rows", () => {
    const rgba = new Uint8Array(3 * 2 * 4).fill(200);
    const png = encodePNG(3, 2, rgba);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks = [];
    for (let at = 8; at < png.length;) {
      const length = png.readUInt32BE(at);
      const type = png.toString("ascii", at + 4, at + 8);
      const data = png.subarray(at + 8, at + 8 + length);
      if (zlib.crc32) assert.equal(png.readUInt32BE(at + 8 + length), zlib.crc32(png.subarray(at + 4, at + 8 + length)), `${type} CRC`);
      chunks.push({ type, data });
      at += 12 + length;
    }
    assert.deepEqual(chunks.map((c) => c.type), ["IHDR", "IDAT", "IEND"]);
    assert.equal(png.readUInt32BE(png.length - 4), 0xae426082, "IEND CRC");
    assert.equal(chunks[0].data.readUInt32BE(0), 3);
    assert.equal(chunks[0].data.readUInt32BE(4), 2);
    assert.deepEqual([...chunks[0].data.subarray(8)], [8, 6, 0, 0, 0]);
    const raw = zlib.inflateSync(chunks[1].data);
    assert.equal(raw.length, 2 * (3 * 4 + 1));
    assert.equal(raw[0], 0);
    assert.equal(raw[1], 200);
    assert.throws(() => encodePNG(3, 2, new Uint8Array(5)), RangeError);
    assert.throws(() => encodePNG(0, 2, new Uint8Array(0)), RangeError);
  });
});

describe("doctor", () => {
  let ollama;
  let blind;
  let wrong;
  let whisper;
  let piper;

  before(async () => {
    ollama = await startFakeOllama({ models: ["qwen2.5-coder:7b", "qwen2.5vl:7b", "nomic-embed-text:latest"] });
    blind = await startFakeOllama({ models: ["qwen2.5-coder:7b"], version: "0.30.0" });
    wrong = await startFakeOllama({ models: ["qwen2.5-coder:7b"], answers: (command) => (command.includes("villa") ? { intents: [{ do: "spawn", what: { part: "villa" }, place: { rel: "right" } }], say: "A villa." } : undefined) });
    whisper = await startFakeWhisper();
    piper = await startFakePiper();
  });

  after(async () => {
    await Promise.all([ollama, blind, wrong, whisper, piper].map((s) => closeServer(s?.server)));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("all pass: the model command, vision, a spoken TTS → STT round trip and the reports", async () => {
    const dir = dataDir("all-pass", { ollamaUrl: ollama.url, sttUrl: `${whisper.url}/inference`, ttsKind: "piper", ttsUrl: piper.url });
    const res = await run(["--data", dir, "--require", "stt,tts,vision"]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /^RESULT: PASS\. node, config, ollama, model-command, vision, tts, stt passed\.$/m);
    assert.match(res.stdout, /model-command \* +PASS .*"AI, spawn a villa to my left" → spawn villa left \(qwen2\.5-coder:7b/);
    assert.match(res.stdout, /vision \* +PASS .*qwen2\.5vl:7b looked at a drawn circle and guessed "fish"/);
    assert.match(res.stdout, /stt \* +PASS .*round trip: the laptop voice said "AI, spawn a crate\." and whisper\.cpp heard "AI, spawn a crate"/);
    const report = savedReport(dir);
    assert.equal(report.ok, true);
    assert.deepEqual(report.required, ["node", "config", "ollama", "model-command", "vision", "tts", "stt"]);
    assert.deepEqual(Object.keys(statuses(report)), ["node", "config", "ollama", "model-command", "vision", "tts", "stt", "network"]);
    for (const c of report.checks) assert.ok(Number.isInteger(c.ms) && typeof c.detail === "string" && c.detail, c.id);
    const ollamaCheck = report.checks.find((c) => c.id === "ollama");
    assert.equal(ollamaCheck.info.version, "0.40.1");
    assert.equal(ollamaCheck.info.model, "qwen2.5-coder:7b");
    assert.equal(ollamaCheck.info.vision, "qwen2.5vl:7b");
    assert.deepEqual(ollamaCheck.info.capabilities, ["completion"]);
    // The model got the real prompt with the real catalog, and the vision model got a PNG.
    const command = ollama.requests.find((r) => !r.format?.properties?.guess);
    assert.match(command.messages[0].content, /CATALOG[\s\S]*- villa \(mansion\)/);
    const sketch = ollama.requests.find((r) => r.format?.properties?.guess);
    assert.equal(sketch.model, "qwen2.5vl:7b");
    assert.equal(Buffer.from(sketch.messages.at(-1).images[0], "base64").toString("latin1", 1, 4), "PNG");
    // Piper's 22.05 kHz voice reached Whisper as 16 kHz mono, like the game records.
    const form = whisper.requests.at(-1);
    const wav = Buffer.from(form.slice(form.indexOf("RIFF")), "latin1");
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(piper.requests.at(-1).body.text, "AI, spawn a crate.");
  });

  it("model down: ollama and model-command fail and the exit code is 1; --json prints the report", async () => {
    const dir = dataDir("model-down", { ollamaUrl: DEAD, sttKind: "none" });
    const res = await run(["--data", dir, "--json"]);
    assert.equal(res.code, 1);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.summary.split(".")[0], "ollama, model-command failed");
    const { network, ...rest } = statuses(report); // network depends on this machine's adapters
    assert.deepEqual(rest, { node: "pass", config: "pass", ollama: "fail", "model-command": "fail", vision: "warn", tts: "skip", stt: "skip" });
    assert.ok(["pass", "warn"].includes(network));
    assert.match(report.checks[2].detail, /Ollama not reachable at http:\/\/127\.0\.0\.1:9 .*start Ollama first/);
    assert.equal(report.files.length, 2);
    assert.deepEqual(savedReport(dir).checks.map((c) => c.status), report.checks.map((c) => c.status));
  });

  it("a wrong model answer fails model-command", async () => {
    const dir = dataDir("wrong-answer", { ollamaUrl: wrong.url, sttKind: "none" });
    const res = await run(["--data", dir]);
    assert.equal(res.code, 1);
    assert.match(res.stdout, /model-command \* +FAIL .*spawn villa right .*placed it "right" instead of "left"; the villa did not land on the player's left/);
    assert.match(res.stdout, /^RESULT: FAIL\. model-command failed\./m);
  });

  it("optional parts missing: warnings, exit 0; an old Ollama is a warning too", async () => {
    const dir = dataDir("optional-missing", { ollamaUrl: blind.url, sttUrl: `${DEAD}/inference`, ttsKind: "none" });
    const res = await run(["--data", dir]);
    assert.equal(res.code, 0, res.stdout);
    const report = savedReport(dir);
    const s = statuses(report);
    assert.equal(s["model-command"], "pass");
    assert.equal(s.ollama, "warn");
    assert.match(report.checks.find((c) => c.id === "ollama").detail, /Ollama 0\.30\.0 is old; 0\.31\.2\+/);
    assert.equal(s.vision, "warn");
    assert.match(report.checks.find((c) => c.id === "vision").detail, /no vision model installed: qwen2\.5-coder:7b reads drawings as ASCII art/);
    assert.equal(s.stt, "warn");
    assert.equal(s.tts, "skip");
    assert.match(res.stdout, /^RESULT: PASS\. node, config, ollama, model-command passed\. Not required: vision WARN, tts SKIP, stt WARN(, network WARN)?\.$/m);
    assert.match(res.stdout, /stt +WARN .*whisper\.cpp: not reachable at http:\/\/127\.0\.0\.1:9\/inference/);
  });

  it("--require stt fails when speech to text is unreachable", async () => {
    const dir = dataDir("require-stt", { ollamaUrl: blind.url, sttUrl: `${DEAD}/inference`, ttsKind: "none" });
    const res = await run(["--data", dir, "--require", "stt"]);
    assert.equal(res.code, 1);
    const report = savedReport(dir);
    assert.equal(statuses(report).stt, "fail");
    assert.ok(report.checks.find((c) => c.id === "stt").required);
    assert.equal(statuses(report).vision, "warn", "not required, so still a warning");
    assert.match(res.stdout, /^RESULT: FAIL\. stt failed\./m);
  });

  it("without the laptop voice, STT is checked with a second of silence", async () => {
    const dir = dataDir("stt-silence", { ollamaUrl: blind.url, sttUrl: `${whisper.url}/inference`, ttsKind: "none" });
    const res = await run(["--data", dir, "--require", "stt"]);
    assert.equal(res.code, 0, res.stdout);
    assert.match(res.stdout, /stt \* +PASS .*answered 1 s of silence/);
    const form = whisper.requests.at(-1);
    const wav = Buffer.from(form.slice(form.indexOf("RIFF")), "latin1");
    assert.equal(wav.readUInt32LE(40), 32000, "1 s at 16 kHz, 16-bit");
  });

  it("network: a running bridge and the certificate's coverage, read only", async () => {
    const hello = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bridge: true, version: "9.9.9" }));
    });
    await new Promise((resolve) => hello.listen(0, "127.0.0.1", resolve));
    try {
      const good = dataDir("net-good", { ollamaUrl: blind.url, sttKind: "none", httpPort: hello.address().port });
      fs.writeFileSync(path.join(good, "cert.pem"), generateCert({ ips: ["127.0.0.1", ...lanIPs()] }).cert);
      await run(["--data", good]);
      const covered = savedReport(good).checks.find((c) => c.id === "network");
      assert.match(covered.detail, /bridge 9\.9\.9 is running on port \d+/);
      assert.match(covered.detail, /certificate covers 127\.0\.0\.1/);
      assert.equal(covered.info.bridgeRunning, true);

      const stale = dataDir("net-stale", { ollamaUrl: blind.url, sttKind: "none" });
      const pem = generateCert({ ips: ["10.255.255.1"] }).cert;
      fs.writeFileSync(path.join(stale, "cert.pem"), pem);
      const res = await run(["--data", stale]);
      assert.equal(res.code, 0, "network is never required");
      const check = savedReport(stale).checks.find((c) => c.id === "network");
      assert.equal(check.status, "warn");
      assert.match(check.detail, /bridge not running on port 9/);
      assert.match(check.detail, /the HTTPS certificate does not cover 127\.0\.0\.1/);
      assert.equal(fs.readFileSync(path.join(stale, "cert.pem"), "utf8"), pem, "the doctor does not renew the certificate");
    } finally {
      await closeServer(hello);
    }
  });

  it("refuses a data folder inside the repository and writes nothing there", async () => {
    const inside = path.join(GAME_DIR, "doctor-data-must-not-exist");
    const res = await run(["--data", inside]);
    assert.equal(res.code, 1);
    assert.match(res.stdout, /config \* +FAIL .*is inside the game repository/);
    assert.match(res.stdout, /report not saved: the data folder is inside the repository/);
    assert.equal(fs.existsSync(inside), false);
  });

  it("bad options exit with 2", async () => {
    assert.equal((await run(["--require", "gpu"])).code, 2);
    assert.equal((await run(["--timeout", "soon"])).code, 2);
    assert.equal((await run(["--frobnicate"])).code, 2);
  });
});
