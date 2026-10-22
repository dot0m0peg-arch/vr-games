// Device self-test reports: POST api/report on the bridge (auth, size, kind, owner-only files that are
// never overwritten) and bridge/check-headset-report.mjs run as the owner's pipeline runs it (exit
// code = verdict) on passing, slow, sessionless, stale and empty reports.
// Run: node --test games/training-room/tests/report.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBridge, reportStamp } from "../bridge/server.mjs";

const CHECK = fileURLToPath(new URL("../bridge/check-headset-report.mjs", import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tr-report-test-"));
const log = { lines: [], log(...a) { this.lines.push(a.join(" ")); }, warn(...a) { this.lines.push(a.join(" ")); }, error(...a) { this.lines.push(a.join(" ")); } };
const mode = (file) => fs.statSync(file).mode & 0o777;
const posix = process.platform !== "win32";

function post(port, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: reqPath, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

function check(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CHECK, ...args], { env: { ...process.env, TRAINING_ROOM_DATA: "" }, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

// A self-test report from a Quest 3 that meets every criterion; edit(report) changes a copy.
function headset(edit = () => {}) {
  const report = {
    version: 1,
    at: new Date().toISOString(),
    ua: "Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 OculusBrowser/37.0 Chrome/132.0 VR Safari/537.36",
    device: "Meta Quest 3",
    secureContext: true,
    xr: {
      api: true, supported: true, sessionStarted: true, sessionEnded: true,
      fps: { avg: 71.8, p5: 64.2, frames: 1077, seconds: 15, droppedOver20ms: 4 },
      referenceSpace: "local-floor",
      inputs: [
        { handedness: "left", profiles: ["meta-quest-touch-plus", "generic-trigger-squeeze-thumbstick"], buttons: 7 },
        { handedness: "right", profiles: ["meta-quest-touch-plus", "generic-trigger-squeeze-thumbstick"], buttons: 7 },
      ],
    },
    mic: { permission: "granted", audioWorklet: true, mediaRecorder: { supported: true, opus: true }, peakLevel: 0.31 },
    speech: { recognition: false, synthesisVoices: 0 },
    bridge: { reachable: true, auth: true, model: "qwen3.5:4b", stt: true, tts: false },
    whisper: { tried: true, ok: true, text: "AI, spawn a crate", ms: 640 },
    tts: { tried: false, ok: false, ms: 0 },
    scene: { objects: 3, drawCalls: 41, triangles: 52000 },
  };
  edit(report);
  return report;
}

function writeReport(name, report) {
  const file = path.join(tmpRoot, "files", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof report === "string" ? report : JSON.stringify(report));
  return file;
}

describe("POST api/report", () => {
  let bridge;
  let port;
  let key;
  const dataDir = path.join(tmpRoot, "bridge-data");

  before(async () => {
    bridge = await createBridge({
      dataDir, partsDir: path.join(tmpRoot, "parts"), https: false, httpPort: 0, host: "127.0.0.1", log, scanMs: 60000,
      configOverrides: { ollamaUrl: "http://127.0.0.1:9", sttKind: "none" },
    });
    port = (await bridge.start()).ports.http;
    key = bridge.config.roomKey;
  });

  after(async () => {
    await bridge?.stop();
  });

  it("saves the report owner-only under reports/, never overwriting, and logs one line", async () => {
    const report = headset();
    const first = await post(port, "/api/report", { kind: "headset", user: "u1abc", report }, { "x-room-key": key });
    assert.equal(first.status, 200);
    assert.match(first.json.saved, /^headset-\d{8}-\d{6}-u1abc\.json$/);
    const file = path.join(dataDir, "reports", first.json.saved);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), report);
    if (posix) {
      assert.equal(mode(file), 0o600);
      assert.equal(mode(path.join(dataDir, "reports")), 0o700);
    }
    const again = await post(port, "/vr-games/games/training-room/api/report", { kind: "headset", user: "u1abc", report: { ...report, n: 2 } }, { "x-room-key": key });
    assert.equal(again.status, 200);
    assert.notEqual(again.json.saved, first.json.saved);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), report, "the first file is unchanged");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "reports", again.json.saved), "utf8")).n, 2);
    assert.ok(log.lines.some((l) => new RegExp(`POST /api/report 200 \\d+ms saved ${first.json.saved.replace(/\./g, "\\.")}$`).test(l)), log.lines.join("\n"));
  });

  it("names the file after a safe form of the user, else the caller's address", async () => {
    const odd = await post(port, "/api/report", { kind: "client", user: "../../etc/passwd", report: { ok: true } }, { "x-room-key": key });
    assert.equal(odd.status, 200);
    assert.match(odd.json.saved, /^client-\d{8}-\d{6}-etc-passwd\.json$/);
    assert.ok(fs.existsSync(path.join(dataDir, "reports", odd.json.saved)));
    const anon = await post(port, "/api/report", { kind: "client", report: { ok: true } }, { "x-room-key": key });
    assert.match(anon.json.saved, /^client-\d{8}-\d{6}-(ffff-)?127-0-0-1\.json$/);
  });

  it("needs the room key and a well-formed body of at most 128 KB", async () => {
    const before = fs.readdirSync(path.join(dataDir, "reports")).length;
    assert.equal((await post(port, "/api/report", { kind: "headset", report: {} })).status, 401);
    assert.equal((await post(port, "/api/report", { kind: "headset", report: {} }, { "x-room-key": "WRONGKEY23" })).status, 401);
    const bad = async (body, error) => {
      const res = await post(port, "/api/report", body, { "x-room-key": key });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal(res.json.error, error);
    };
    await bad({ kind: "laptop", report: {} }, "bad-kind");
    await bad({ report: {} }, "bad-kind");
    await bad({ kind: "headset" }, "bad-report");
    await bad({ kind: "headset", report: [1, 2] }, "bad-report");
    await bad({ kind: "headset", report: "fine" }, "bad-report");
    await bad("{not json", "bad-json");
    const big = await post(port, "/api/report", { kind: "headset", report: { pad: "x".repeat(130 * 1024) } }, { "x-room-key": key });
    assert.equal(big.status, 413);
    assert.equal(big.json.error, "too-large");
    const fits = await post(port, "/api/report", { kind: "headset", user: "big", report: { pad: "x".repeat(120 * 1024) } }, { "x-room-key": key });
    assert.equal(fits.status, 200);
    assert.equal(fs.readdirSync(path.join(dataDir, "reports")).length, before + 1, "only the valid one was saved");
    fs.rmSync(path.join(dataDir, "reports", fits.json.saved)); // not a self-test; keep it out of the next test
  });

  it("check-headset-report reads the newest report the headset posted", async () => {
    const fresh = await post(port, "/api/report", { kind: "headset", user: "u9zzz", report: headset() }, { "x-room-key": key });
    const res = await check(["--data", dataDir]);
    assert.equal(res.code, 0, res.stdout);
    assert.ok(res.stdout.includes(fresh.json.saved), "the newest file was checked");
    assert.match(res.stdout, /^RESULT: PASS\. All 9 required items passed\.$/m);
    assert.match(res.stdout, /^Device: Meta Quest 3 · Mozilla\/5\.0 .*OculusBrowser.* · scene: 3 objects, 41 draw calls, 52000 triangles$/m);
  });
});

describe("check-headset-report", () => {
  after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const row = (stdout, id) => (stdout.match(new RegExp(`^${id}( \\*)? +(PASS|FAIL|WARN|SKIP) +(.*)$`, "m")) || []).slice(2);

  it("passes a good report and prints every item", async () => {
    const res = await check(["--file", writeReport("good.json", headset())]);
    assert.equal(res.code, 0, res.stdout);
    for (const id of ["fresh", "secure-context", "xr-supported", "xr-session", "fps", "controllers", "mic", "bridge", "whisper"]) assert.equal(row(res.stdout, id)[0], "PASS", id);
    assert.deepEqual(row(res.stdout, "laptop-voice"), ["SKIP", "the bridge had no laptop voice; replies use the headset's browser voice or captions"]);
    assert.match(row(res.stdout, "fps")[1], /^average 71\.8 fps, 5th percentile 64\.2, 1077 frames in 15 s, 4 over 20 ms \(minimum 65\)$/);
    assert.equal(row(res.stdout, "controllers")[1], "left: meta-quest-touch-plus, right: meta-quest-touch-plus");
  });

  it("low frame rate fails unless --min-fps allows it", async () => {
    const file = writeReport("slow.json", headset((r) => (r.xr.fps.avg = 45.2)));
    const res = await check(["--file", file]);
    assert.equal(res.code, 1);
    assert.match(row(res.stdout, "fps")[1], /average 45\.2 fps.*: below the minimum of 65$/);
    assert.match(res.stdout, /^RESULT: FAIL\. fps failed\.$/m);
    assert.equal((await check(["--file", file, "--min-fps", "40"])).code, 0);
  });

  it("no VR session fails with the browser's error", async () => {
    const res = await check(["--file", writeReport("nosession.json", headset((r) => {
      r.xr.sessionStarted = false;
      r.xr.error = "NotAllowedError: requestSession needs a user gesture";
      delete r.xr.fps;
    }))]);
    assert.equal(res.code, 1);
    assert.deepEqual(row(res.stdout, "xr-session"), ["FAIL", "no VR session started: NotAllowedError: requestSession needs a user gesture"]);
    assert.equal(row(res.stdout, "fps")[1], "no frame rate measured (xr.fps.avg missing)");
  });

  it("a stale report fails with a clear message unless --max-age-hours allows it", async () => {
    const file = writeReport("stale.json", headset((r) => (r.at = new Date(Date.now() - 100 * 3600000).toISOString())));
    const res = await check(["--file", file]);
    assert.equal(res.code, 1);
    assert.match(row(res.stdout, "fresh")[1], /^the report is too old: saved 100\.0 h ago, limit 72 h\. Run the self-test in the headset again$/);
    assert.equal((await check(["--file", file, "--max-age-hours", "200"])).code, 0);
  });

  it("missing fields fail every required item without crashing", async () => {
    for (const body of [{}, [], "null", { version: 1, xr: "yes", mic: 3, bridge: null, inputs: 5 }]) {
      const res = await check(["--file", writeReport("empty.json", typeof body === "string" ? body : JSON.stringify(body))]);
      assert.equal(res.code, 1, JSON.stringify(body));
      assert.equal(res.stderr, "");
      assert.match(res.stdout, /^RESULT: FAIL\. secure-context, xr-supported, xr-session, fps, controllers, mic, bridge failed\.$/m);
      assert.equal(row(res.stdout, "fresh")[0], "PASS", "the file time stands in for a missing at");
      assert.equal(row(res.stdout, "whisper")[0], "SKIP");
    }
  });

  it("whisper must work when the bridge has speech to text; hands count as controllers", async () => {
    const deaf = await check(["--file", writeReport("deaf.json", headset((r) => Object.assign(r.whisper, { ok: false, error: "stt-timeout" })))]);
    assert.equal(deaf.code, 1);
    assert.deepEqual(row(deaf.stdout, "whisper"), ["FAIL", "Whisper failed: stt-timeout"]);
    const noStt = await check(["--file", writeReport("nostt.json", headset((r) => {
      r.bridge.stt = { available: false };
      r.whisper = { tried: false, ok: false };
    }))]);
    assert.equal(noStt.code, 0, noStt.stdout);
    assert.equal(row(noStt.stdout, "whisper")[0], "SKIP");
    const hands = await check(["--file", writeReport("hands.json", headset((r) => {
      r.xr.inputs = [{ handedness: "left", profiles: ["generic-hand"] }, { handedness: "right", profiles: ["generic-hand"] }];
    }))]);
    assert.equal(hands.code, 0);
    const oneHand = await check(["--file", writeReport("onehand.json", headset((r) => r.xr.inputs.shift()))]);
    assert.equal(oneHand.code, 1);
    assert.equal(row(oneHand.stdout, "controllers")[1], "need a left and a right controller or hand; saw right: meta-quest-touch-plus");
    const mute = await check(["--file", writeReport("mute.json", headset((r) => (r.mic.peakLevel = 0)))]);
    assert.equal(row(mute.stdout, "mic")[0], "FAIL");
  });

  it("picks the newest report by its saved time; no report or a broken one fails", async () => {
    const dir = path.join(tmpRoot, "pick");
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(path.join(dir, "reports", "headset-20200101-120000-old.json"), JSON.stringify(headset((r) => (r.secureContext = false))));
    const newest = `headset-${reportStamp()}-new.json`;
    fs.writeFileSync(path.join(dir, "reports", newest), JSON.stringify(headset()));
    fs.writeFileSync(path.join(dir, "reports", "client-20991231-000000-x.json"), "{}");
    const res = await check(["--data", dir]);
    assert.equal(res.code, 0, res.stdout);
    assert.ok(res.stdout.includes(newest));
    const empty = await check(["--data", path.join(tmpRoot, "nothing-here")]);
    assert.equal(empty.code, 1);
    assert.match(empty.stdout, /^RESULT: FAIL\. No headset report in .*: run the self-test in the headset with the bridge running\.$/m);
    const broken = await check(["--file", writeReport("broken.json", "{\"at\": ")]);
    assert.equal(broken.code, 1);
    assert.match(broken.stdout, /^RESULT: FAIL\. Cannot read /m);
    assert.equal((await check(["--min-fps", "fast"])).code, 2);
    assert.equal((await check(["--file"])).code, 2);
  });
});
