// Laptop bridge hardening: room-key guessing is throttled before any key is checked (API, hello and
// ?k=), DNS-rebinding Host names are refused on plain HTTP, refused uploads close their connection,
// short stored keys keep working with a startup tip, and the data folder is owner-only.
// Run: node --test games/training-room/tests/bridge-auth.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import { createBridge } from "../bridge/server.mjs";
import { loadConfig } from "../bridge/config.mjs";
import { RoomStore } from "../bridge/store.mjs";

const quietLog = { lines: [], log(...a) { this.lines.push(a.join(" ")); }, warn(...a) { this.lines.push(a.join(" ")); }, error(...a) { this.lines.push(a.join(" ")); } };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tr-bridge-auth-"));
const SHORT_KEY = "ABC234"; // a 6-character key saved by an older bridge

function raw(port, reqPath, { method = "GET", headers = {}, body, secure = false } = {}) {
  return new Promise((resolve, reject) => {
    const lib = secure ? https : http;
    const req = lib.request({ host: "127.0.0.1", port, path: reqPath, method, headers, rejectUnauthorized: false, agent: false }, (res) => {
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
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

const mode = (file) => fs.statSync(file).mode & 0o777;

describe("bridge data folder", () => {
  it("config.json and room.json are owner-only; folders and files from older versions are tightened", { skip: process.platform === "win32" && "POSIX file modes" }, async () => {
    const umask = process.umask(0o022);
    try {
      const fresh = path.join(tmpRoot, "fresh");
      const { config } = loadConfig(fresh, { log: quietLog });
      assert.match(config.roomKey, /^[A-HJ-NP-Z2-9]{10}$/, "new keys have 10 characters");
      assert.equal(mode(fresh), 0o700);
      assert.equal(mode(path.join(fresh, "config.json")), 0o600);
      const store = new RoomStore({ dataDir: fresh, log: quietLog });
      await store.save();
      assert.equal(mode(path.join(fresh, "room.json")), 0o600);
      store.dirty = true;
      store.flush();
      assert.equal(mode(path.join(fresh, "room.json")), 0o600, "shutdown save too");
      store.stop();

      const old = path.join(tmpRoot, "old");
      fs.mkdirSync(old, { mode: 0o755 });
      fs.chmodSync(old, 0o755);
      fs.writeFileSync(path.join(old, "config.json"), JSON.stringify({ roomKey: SHORT_KEY }), { mode: 0o644 });
      fs.chmodSync(path.join(old, "config.json"), 0o644);
      const again = loadConfig(old, { log: quietLog });
      assert.equal(again.config.roomKey, SHORT_KEY, "an existing shorter key is kept");
      assert.equal(mode(old), 0o700);
      assert.equal(mode(path.join(old, "config.json")), 0o600);
    } finally {
      process.umask(umask);
    }
  });
});

describe("bridge room key", () => {
  let bridge;
  let key;
  let hp;
  let sp;
  const dataDir = path.join(tmpRoot, "data");

  before(async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ roomKey: SHORT_KEY.toLowerCase() }));
    bridge = await createBridge({
      dataDir,
      partsDir: path.join(tmpRoot, "parts"),
      port: 0,
      httpPort: 0,
      host: "127.0.0.1",
      quiet: true,
      log: quietLog,
      configOverrides: { ollamaUrl: "http://127.0.0.1:9", sttKind: "none" },
      scanMs: 60000,
    });
    const info = await bridge.start();
    key = bridge.config.roomKey;
    hp = info.ports.http;
    sp = info.ports.https;
  });

  after(async () => {
    await bridge?.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("a shorter saved key keeps working and the startup printout suggests a longer one", async () => {
    assert.equal(key, SHORT_KEY);
    const from = quietLog.lines.length;
    bridge.printStartup();
    const text = quietLog.lines.slice(from).join("\n");
    assert.match(text, /Room key: {2}ABC234\n {2}Tip: a longer room key is safer\. Delete "roomKey" in config\.json and restart to get a 10-character one\.\n/);
    const hello = await raw(hp, "/api/hello", { headers: { "x-room-key": key } });
    assert.equal(hello.json.auth, true);
    assert.equal(hello.json.key, SHORT_KEY);
  });

  it("plain HTTP answers only localhost Host names (DNS rebinding); HTTPS is unaffected", async () => {
    for (const host of [`rebind.attacker.example:${hp}`, "attacker.example", `192.168.1.20:${hp}`]) {
      for (const reqPath of ["/api/hello", "/", `/?k=${key}`, "/vr-games/"]) {
        const res = await raw(hp, reqPath, { headers: { host, "x-room-key": key } });
        assert.equal(res.status, 421, `${host} ${reqPath}`);
        assert.equal(res.headers["set-cookie"], undefined);
        assert.doesNotMatch(res.text, new RegExp(key));
      }
    }
    for (const host of [`localhost:${hp}`, `LOCALHOST:${hp}`, `127.0.0.1:${hp}`, `[::1]:${hp}`, "localhost"]) {
      assert.equal((await raw(hp, "/api/hello", { headers: { host } })).status, 200, host);
    }
    const lan = await raw(sp, "/api/hello", { secure: true, headers: { host: `192.168.1.20:${sp}` } });
    assert.equal(lan.status, 200);
  });

  it("a refused upload closes its connection instead of draining the body", async () => {
    const socket = net.connect(hp, "127.0.0.1");
    let reply = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (reply += chunk));
    socket.on("error", () => {});
    socket.write(`POST /api/op HTTP/1.1\r\nHost: 127.0.0.1:${hp}\r\nContent-Type: application/json\r\nContent-Length: 1000000000\r\n\r\n{"user":`);
    const closed = await Promise.race([
      new Promise((resolve) => socket.on("close", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    socket.destroy();
    assert.ok(closed, "the bridge closed the connection");
    assert.match(reply, /^HTTP\/1\.1 401 /);
    assert.match(reply, /\r\nconnection: close\r\n/i);
  });

  it("a stale cookie does not hide a fresh header key; requests without a key are not guesses", async () => {
    const join = await raw(hp, "/api/join", { method: "POST", headers: { cookie: "tr_key=OLDKEY2345", "x-room-key": key.toLowerCase(), "content-type": "application/json" }, body: { name: "Stale", device: "phone" } });
    assert.equal(join.status, 200);
    await raw(hp, "/api/leave", { method: "POST", headers: { "x-room-key": key }, body: { user: join.json.user.id } });
    for (let i = 0; i < 40; i++) {
      assert.equal((await raw(hp, "/api/hello")).json.auth, false);
      assert.equal((await raw(hp, "/api/parts")).status, 401);
    }
    assert.equal((await raw(hp, "/api/parts", { headers: { "x-room-key": key } })).status, 200);
  });

  it("after 30 wrong keys the address is refused before any key is checked: API, hello and ?k=", async () => {
    // Cookie, header and query each count as a guess: 10 requests are 30 guesses.
    const wrong = { cookie: "tr_key=WRONGC2345", "x-room-key": "WRONGH2345" };
    for (let i = 0; i < 10; i++) assert.equal((await raw(hp, "/api/parts?k=WRONGQ2345", { headers: wrong })).status, 401, `guess ${i}`);
    assert.ok(quietLog.lines.some((l) => /\[auth\] 30 wrong room keys from 127\.0\.0\.1; refusing it for 60 s/.test(l)), "the owner sees the lockout");

    const right = await raw(hp, "/api/parts", { headers: { "x-room-key": key } });
    assert.equal(right.status, 429, "the right key is not even checked while throttled");
    assert.deepEqual(right.json, { error: "slow-down" });
    assert.equal((await raw(sp, "/api/parts", { secure: true, headers: { "x-room-key": key } })).status, 429);
    const hello = await raw(hp, "/api/hello", { headers: { "x-room-key": key } });
    assert.equal(hello.status, 200);
    assert.equal(hello.json.auth, false);
    assert.equal(hello.json.key, undefined);
    const cookie = await raw(hp, `/?k=${key}`);
    assert.equal(cookie.status, 302);
    assert.equal(cookie.headers["set-cookie"], undefined);
  });
});
