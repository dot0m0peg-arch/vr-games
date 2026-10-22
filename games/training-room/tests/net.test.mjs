// Bridge client (Net) against an in-test fake bridge, plus Avatars and the laptop parts loader.
// Node 22 has fetch but no EventSource, so a minimal spec-like EventSource is defined here.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as THREE from "../vendor/three.module.min.js";
import { Net } from "../js/net/net.js";
import { Avatars } from "../js/net/avatars.js";
import { loadRemoteParts } from "../js/parts/remote.js";
import { buildBlueprint } from "../js/parts/build/blueprint.js";
import { encodeWav, wavInfo } from "../js/voice/wav.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, ms = 3000, label = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------- minimal EventSource (fetch streaming, named events, ids, retry, Last-Event-ID) ----------
class TestEventSource {
  static instances = [];

  constructor(url, options = {}) {
    this.url = url;
    this.withCredentials = !!options.withCredentials;
    this.readyState = 0;
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    this._listeners = new Map();
    this._lastId = "";
    this._retry = 1000;
    this._closed = false;
    TestEventSource.instances.push(this);
    queueMicrotask(() => this._connect());
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  close() {
    this._closed = true;
    this.readyState = 2;
    clearTimeout(this._timer);
    this._abort?.abort();
  }

  _dispatch(type, event) {
    if (type === "open") this.onopen?.(event);
    else if (type === "error") this.onerror?.(event);
    else if (type === "message") this.onmessage?.(event);
    for (const fn of this._listeners.get(type) || []) fn(event);
  }

  async _connect() {
    if (this._closed) return;
    const controller = new AbortController();
    this._abort = controller;
    let res;
    try {
      const headers = { accept: "text/event-stream" };
      if (this._lastId) headers["last-event-id"] = this._lastId;
      res = await fetch(this.url, { headers, signal: controller.signal });
    } catch {
      this._reconnect();
      return;
    }
    if (this._closed) return;
    if (res.status !== 200 || !String(res.headers.get("content-type") || "").startsWith("text/event-stream")) {
      // Spec: "fail the connection" → CLOSED, one error event, no reconnect.
      this.readyState = 2;
      this._closed = true;
      res.body?.cancel().catch(() => {});
      this._dispatch("error", { type: "error" });
      return;
    }
    this.readyState = 1;
    this._dispatch("open", { type: "open" });
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          this._block(block);
        }
      }
    } catch {
      // Stream aborted or reset.
    }
    this._reconnect();
  }

  _block(block) {
    let type = "message";
    const data = [];
    let id = null;
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const at = line.indexOf(":");
      const field = at < 0 ? line : line.slice(0, at);
      let value = at < 0 ? "" : line.slice(at + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") type = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
      else if (field === "retry" && /^\d+$/.test(value)) this._retry = Number(value);
    }
    if (id !== null) this._lastId = id;
    if (!data.length) return;
    this._dispatch(type, { type, data: data.join("\n"), lastEventId: this._lastId });
  }

  _reconnect() {
    if (this._closed) return;
    this.readyState = 0;
    this._dispatch("error", { type: "error" });
    this._timer = setTimeout(() => this._connect(), this._retry);
  }
}

// ---------- fake bridge ----------
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function fakeBridge({ key = null } = {}) {
  const s = {
    key,
    users: new Map(),
    clients: new Set(),
    seq: 0,
    nextId: 0,
    ops: [],
    poses: [],
    poseDelay: 60,
    inflight: 0,
    maxInflight: 0,
    commandMode: "ok",
    sttMode: "ok",
    audio: [],
    frames: [],
    leaves: [],
    say: [],
    eventsUrls: [],
    headers: [],
    port: 0,
  };
  const list = () => [...s.users.values()];
  const write = (client, event, data, id) => client.res.write(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event, data, id) => {
    for (const client of s.clients) write(client, event, data, id);
  };
  const handler = async (req, res) => {
    const url = new URL(req.url, "http://fake.invalid");
    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (url.pathname === "/html/hello") return send(200, "<!doctype html><p>not a bridge</p>", "text/html");
    if (!url.pathname.startsWith("/api/")) return send(404, "<!doctype html><p>404</p>", "text/html");
    const route = url.pathname.slice(5);
    const body = await readBody(req);
    const json = () => JSON.parse(body.toString("utf8") || "{}");
    s.headers.push({ route, headers: req.headers });
    const authed = !s.key || req.headers["x-room-key"] === s.key || url.searchParams.get("k") === s.key;
    if (route === "hello") return send(200, { bridge: true, auth: authed, version: "test", model: { available: true, name: "fake" }, stt: { available: true, kind: "fake" } });
    if (!authed) return send(401, { error: "auth" });
    const known = (id) => typeof id === "string" && s.users.has(id);
    const share = /^share\/([A-Za-z0-9_-]+)(\/stop)?$/.exec(route);
    if (share) {
      if (req.method === "POST" && !share[2]) {
        const user = url.searchParams.get("user");
        if (!known(user)) return send(410, { error: "gone" });
        s.frames.push({ stream: share[1], user, type: req.headers["content-type"], bytes: body.length });
        broadcast("share", { stream: share[1], user, active: true, n: s.frames.length });
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "POST" && share[2]) {
        broadcast("share", { stream: share[1], user: json().user, active: false, n: s.frames.length });
        res.writeHead(204);
        return res.end();
      }
    }
    switch (`${req.method} ${route}`) {
      case "POST join": {
        const b = json();
        const user = { id: `u${++s.nextId}`, name: b.name || "Someone", device: b.device || "desktop", color: b.color || "#d5fb6a", online: true };
        s.users.set(user.id, user);
        broadcast("users", list());
        return send(200, { user, users: list(), state: { objects: {}, seq: s.seq }, seq: s.seq });
      }
      case "GET events": {
        const id = url.searchParams.get("user");
        s.eventsUrls.push(req.url);
        if (!known(id)) return send(410, { error: "gone" });
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
        res.write("retry: 50\n\n");
        const client = { id, res };
        s.clients.add(client);
        write(client, "users", list());
        req.on("close", () => s.clients.delete(client));
        return;
      }
      case "POST op": {
        const b = json();
        if (!known(b.user)) return send(410, { error: "gone", detail: "unknown user, join again" });
        s.seq++;
        s.ops.push(b);
        broadcast("op", { seq: s.seq, op: { ...b.op, by: b.user } }, s.seq);
        return send(200, { seq: s.seq });
      }
      case "POST pose": {
        const b = json();
        if (!known(b.user)) return send(410, { error: "gone" });
        s.inflight++;
        s.maxInflight = Math.max(s.maxInflight, s.inflight);
        await sleep(s.poseDelay);
        s.inflight--;
        s.poses.push({ at: Date.now(), pose: b.pose });
        res.writeHead(204);
        return res.end();
      }
      case "POST fx": {
        const b = json();
        if (!known(b.user)) return send(410, { error: "gone" });
        broadcast("fx", { user: b.user, fx: b.fx });
        res.writeHead(204);
        return res.end();
      }
      case "POST say": {
        const b = json();
        if (!known(b.user)) return send(410, { error: "gone" });
        s.say.push(b.text);
        broadcast("say", { user: b.user, text: b.text });
        res.writeHead(204);
        return res.end();
      }
      case "POST command": {
        const b = json();
        if (s.commandMode === "no-model") return send(503, { error: "no-model", detail: "no local model installed" });
        if (s.commandMode === "bad") return send(200, { nope: true });
        if (s.commandMode === "html") return send(200, "<html>proxy page</html>", "text/html");
        if (s.commandMode === "slow") {
          await sleep(600);
          if (!res.destroyed) send(200, { intents: [], say: "late" });
          return;
        }
        return send(200, { intents: [{ do: "spawn", what: { part: "crate" } }], say: `ok: ${b.text}`, source: "model", model: "fake", ms: 4, ctxKeys: Object.keys(b.ctx || {}) });
      }
      case "POST transcribe": {
        const type = String(req.headers["content-type"] || "");
        const info = wavInfo(new Uint8Array(body));
        s.audio.push({ type, info, bytes: body.length });
        if (s.sttMode === "off") return send(503, { error: "no-stt", detail: "whisper is not running" });
        if (!type.startsWith("audio/wav") || !info) return send(400, { error: "bad-audio" });
        return send(200, { text: "AI, spawn a crate", ms: 3 });
      }
      case "GET parts":
        return send(200, { parts: [{ name: "lamp", aliases: [], category: "custom", desc: "x", size: [1, 1, 1], holdable: false, kind: "blueprint", blueprint: { parts: [] } }] });
      case "POST parts/save":
        return send(200, { name: json().blueprint?.name || "?" });
      case "POST leave": {
        const b = json(); // sent as text/plain by beacons
        s.leaves.push(b.user);
        s.users.delete(b.user);
        for (const client of [...s.clients]) {
          if (client.id !== b.user) continue;
          s.clients.delete(client);
          client.res.end();
        }
        broadcast("users", list());
        res.writeHead(204);
        return res.end();
      }
      default:
        return send(404, { error: "not-found" });
    }
  };
  const server = http.createServer(handler);
  s.server = server;
  s.start = (port = 0) => new Promise((resolve) => {
    s.server = http.createServer(handler);
    s.server.listen(port, "127.0.0.1", () => {
      s.port = s.server.address().port;
      resolve(s.port);
    });
  });
  s.stop = () => new Promise((resolve) => {
    for (const client of s.clients) client.res.destroy();
    s.clients.clear();
    s.server.close(() => resolve());
    s.server.closeAllConnections();
  });
  // Laptop restart: every user forgotten, streams cut.
  s.forgetAll = () => {
    s.users.clear();
    for (const client of [...s.clients]) client.res.end();
    s.clients.clear();
  };
  s.base = () => `http://127.0.0.1:${s.port}/api/`;
  return s;
}

function record(emitter, types) {
  const log = [];
  for (const type of types) emitter.on(type, (data) => log.push({ type, data }));
  return log;
}

const FAST = { offline: 300, probe: 500 };

// ---------- Net ----------

test("probe: bridge, auth and non-bridge answers", async () => {
  const bridge = fakeBridge({ key: "KEY1" });
  await bridge.start();
  try {
    const noKey = await Net.probe(bridge.base(), null);
    assert.equal(noKey.bridge, true);
    assert.equal(noKey.auth, false);
    const withKey = await Net.probe(bridge.base(), "KEY1");
    assert.deepEqual([withKey.bridge, withKey.auth, withKey.info.version], [true, true, "test"]);
    assert.equal((await Net.probe(`http://127.0.0.1:${bridge.port}/pages/api/`, null)).bridge, false, "404 page");
    assert.equal((await Net.probe(`http://127.0.0.1:${bridge.port}/html/`, null)).bridge, false, "HTML 200");
  } finally {
    await bridge.stop();
  }
  const started = Date.now();
  assert.equal((await Net.probe(`http://127.0.0.1:${bridge.port}/api/`, null)).bridge, false, "nothing listening");
  assert.ok(Date.now() - started < 3000);
});

test("join without the room key reports auth", async () => {
  const bridge = fakeBridge({ key: "KEY1" });
  await bridge.start();
  const net = new Net({ base: bridge.base(), EventSourceImpl: TestEventSource, timeouts: FAST });
  const log = record(net, ["status"]);
  try {
    await assert.rejects(net.join({ name: "Lap", device: "desktop" }), (err) => err.code === "auth" && err.status === 401);
    assert.deepEqual(log.map((e) => e.data), ["connecting", "auth"]);
    assert.equal(net.connected, false);
  } finally {
    net.leave();
    await bridge.stop();
  }
});

test("join, live events, ops, fx, say, key header and event-stream key", async () => {
  const bridge = fakeBridge({ key: "KEY1" });
  await bridge.start();
  const net = new Net({ base: bridge.base(), key: "KEY1", EventSourceImpl: TestEventSource, timeouts: FAST });
  const other = new Net({ base: bridge.base(), key: "KEY1", EventSourceImpl: TestEventSource, timeouts: FAST });
  const log = record(net, ["status", "users", "op", "fx", "say", "share"]);
  try {
    const joined = await net.join({ name: "Quest", device: "headset" });
    assert.equal(joined.user.name, "Quest");
    assert.equal(net.user.id, joined.user.id);
    assert.equal(net.connected, true);
    await until(() => net.status === "online", 2000, "online");
    assert.deepEqual(log.filter((e) => e.type === "status").map((e) => e.data), ["connecting", "online"]);
    const es = TestEventSource.instances.at(-1);
    assert.match(es.url, /events\?user=u\d+&k=KEY1$/);
    assert.equal(es.withCredentials, true);
    assert.ok(bridge.headers.filter((h) => h.route !== "events").every((h) => h.headers["x-room-key"] === "KEY1"), "x-room-key on every call");

    await other.join({ name: "Phone", device: "phone" });
    await until(() => log.some((e) => e.type === "users" && e.data.length === 2), 2000, "users event");

    const { seq } = await other.sendOp({ t: "env", time: "night" });
    assert.equal(seq, 1);
    await until(() => log.some((e) => e.type === "op"), 2000, "op event");
    const opEvent = log.find((e) => e.type === "op").data;
    assert.deepEqual([opEvent.seq, opEvent.op.t, opEvent.op.by], [1, "env", other.user.id]);
    assert.equal(net.seq, 1);

    assert.equal(await other.sendFx({ kind: "hit", id: "o1", power: 0.7 }), true);
    assert.equal(await other.sendSay("hello room"), true);
    await until(() => log.some((e) => e.type === "fx") && log.some((e) => e.type === "say"), 2000, "fx and say");
    assert.deepEqual(log.find((e) => e.type === "say").data, { user: other.user.id, text: "hello room" });

    // Frames: upload, viewer URL, stop.
    const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
    assert.equal(await other.postFrame("sabc", jpeg), true);
    assert.deepEqual(bridge.frames[0], { stream: "sabc", user: other.user.id, type: "image/jpeg", bytes: 4 });
    await other.stopShare("sabc");
    await until(() => log.filter((e) => e.type === "share").length === 2, 2000, "share events");
    assert.deepEqual(log.filter((e) => e.type === "share").map((e) => e.data.active), [true, false]);
    assert.equal(net.frameUrl("sabc", 3), `${bridge.base()}share/sabc?n=3&k=KEY1`);
  } finally {
    net.leave();
    other.leave();
    await bridge.stop();
  }
});

test("sendPose: at most 15 Hz, one request in flight, latest pose wins", async () => {
  const bridge = fakeBridge();
  await bridge.start();
  bridge.poseDelay = 90;
  const net = new Net({ base: bridge.base(), EventSourceImpl: TestEventSource, timeouts: FAST });
  try {
    await net.join({ name: "Quest", device: "headset" });
    const started = Date.now();
    let i = 0;
    while (Date.now() - started < 500) {
      net.sendPose({ p: [i++, 1.6, 0], yaw: 0, hands: { left: null, right: null } });
      await sleep(4);
    }
    const last = i - 1;
    await until(() => bridge.poses.length && bridge.poses.at(-1).pose.p[0] === last, 2000, "latest pose");
    await sleep(200);
    assert.equal(bridge.maxInflight, 1, "never two pose requests at once");
    assert.ok(bridge.poses.length <= Math.ceil(700 / 66) + 1, `sent ${bridge.poses.length} poses for ${i} calls`);
    assert.ok(bridge.poses.length >= 3);
    assert.equal(bridge.poses.at(-1).pose.p[0], last, "the newest pose arrived last");
    for (let k = 1; k < bridge.poses.length; k++) assert.ok(bridge.poses[k].pose.p[0] > bridge.poses[k - 1].pose.p[0]);
  } finally {
    net.leave();
    await bridge.stop();
  }
});

test("sendOp after the bridge forgot us (410) re-joins once and retries", async () => {
  const bridge = fakeBridge();
  await bridge.start();
  const net = new Net({ base: bridge.base(), EventSourceImpl: TestEventSource, timeouts: FAST });
  const log = record(net, ["rejoined", "status"]);
  try {
    await net.join({ name: "Lap", device: "desktop", color: "#6ad5fb" });
    await until(() => net.status === "online", 2000, "online");
    const firstId = net.user.id;
    bridge.users.delete(firstId); // forgotten without closing the stream
    const result = await net.sendOp({ t: "clear" });
    assert.equal(result.seq, 1);
    const rejoined = log.filter((e) => e.type === "rejoined");
    assert.equal(rejoined.length, 1);
    assert.notEqual(net.user.id, firstId);
    assert.equal(rejoined[0].data.user.id, net.user.id);
    assert.equal(net.user.color, "#6ad5fb", "keeps its color");
    assert.ok(rejoined[0].data.state && Array.isArray(rejoined[0].data.users));
    assert.equal(bridge.ops.at(-1).user, net.user.id);
    await until(() => net.status === "online", 2000, "online again");
  } finally {
    net.leave();
    await bridge.stop();
  }
});

test("sendOp retried after a 410 re-join moves attach.user to the new user id", async () => {
  const bridge = fakeBridge();
  await bridge.start();
  const net = new Net({ base: bridge.base(), EventSourceImpl: TestEventSource, timeouts: FAST });
  try {
    await net.join({ name: "Quest", device: "headset" });
    await until(() => net.status === "online", 2000, "online");
    const firstId = net.user.id;
    bridge.users.delete(firstId);
    const grab = { t: "set", id: "o1", patch: { attach: { user: firstId, hand: "right", grip: "snap" }, onto: null }, transient: false };
    await net.sendOp(grab);
    const secondId = net.user.id;
    assert.notEqual(secondId, firstId);
    assert.deepEqual(bridge.ops.at(-1).op.patch, { attach: { user: secondId, hand: "right", grip: "snap" }, onto: null });
    assert.equal(grab.patch.attach.user, firstId, "the caller's op is not mutated");

    await until(() => net.status === "online", 2000, "online again");
    bridge.users.delete(secondId);
    await net.sendOp({ t: "add", obj: { id: "o2", part: "sword", p: [0, 1, 0], attach: { user: secondId, hand: "left", grip: "snap" } } });
    assert.equal(bridge.ops.at(-1).op.obj.attach.user, net.user.id);
    assert.notEqual(net.user.id, secondId);

    // Someone else's hand stays as it is.
    await until(() => net.status === "online", 2000, "online a third time");
    bridge.users.delete(net.user.id);
    await net.sendOp({ t: "set", id: "o3", patch: { attach: { user: "uOther", hand: "left", grip: "keep" } } });
    assert.equal(bridge.ops.at(-1).op.patch.attach.user, "uOther");
  } finally {
    net.leave();
    await bridge.stop();
  }
});

test("event stream: offline after the grace period, online again, re-join after a laptop restart", async () => {
  const bridge = fakeBridge();
  await bridge.start();
  const port = bridge.port;
  const net = new Net({ base: bridge.base(), EventSourceImpl: TestEventSource, timeouts: FAST });
  const log = record(net, ["status", "rejoined"]);
  try {
    await net.join({ name: "Quest", device: "headset" });
    await until(() => net.status === "online", 2000, "online");
    const id = net.user.id;

    // Network blip: the bridge disappears, comes back with the same users.
    await bridge.stop();
    await until(() => net.status === "offline", 3000, "offline");
    assert.equal(net.connected, true, "still joined while offline");
    await bridge.start(port);
    await until(() => net.status === "online", 3000, "back online");
    assert.equal(net.user.id, id, "same user after a blip");
    assert.equal(log.filter((e) => e.type === "rejoined").length, 0);

    // Laptop restart: users forgotten; the stream is refused (410) → probe → re-join.
    bridge.forgetAll();
    await until(() => log.some((e) => e.type === "rejoined"), 5000, "rejoined");
    await until(() => net.status === "online", 3000, "online after rejoin");
    assert.notEqual(net.user.id, id);
    assert.ok(bridge.users.has(net.user.id));
  } finally {
    net.leave();
    await bridge.stop();
  }
});

test("command: answers and error codes", async () => {
  const bridge = fakeBridge();
  await bridge.start();
  const net = new Net({ base: bridge.base(), EventSourceImpl: TestEventSource, timeouts: { ...FAST, command: 250 } });
  try {
    await net.join({ name: "Lap", device: "desktop" });
    const ok = await net.command("spawn a crate", { player: { p: [0, 1.6, 0], yaw: 0 }, scene: "empty", parts: [] });
    assert.equal(ok.intents[0].do, "spawn");
    assert.equal(ok.say, "ok: spawn a crate");
    assert.deepEqual(ok.ctxKeys, ["player", "scene", "parts"]);
    bridge.commandMode = "no-model";
    await assert.rejects(net.command("x"), (err) => err.code === "no-model" && err.status === 503);
    bridge.commandMode = "bad";
    await assert.rejects(net.command("x"), (err) => err.code === "bad-output");
    bridge.commandMode = "html";
    await assert.rejects(net.command("x"), (err) => err.code === "bad-output");
    bridge.commandMode = "slow";
    await assert.rejects(net.command("x"), (err) => err.code === "timeout");
  } finally {
    net.leave();
    await bridge.stop();
  }
  await assert.rejects(net.command("x"), (err) => err.code === "offline");
});

test("transcribe posts audio/wav and maps no-stt; parts and saveBlueprint", async () => {
  const bridge = fakeBridge();
  await bridge.start();
  const net = new Net({ base: bridge.base(), EventSourceImpl: TestEventSource, timeouts: FAST });
  try {
    await net.join({ name: "Quest", device: "headset" });
    const wav = new Blob([encodeWav(new Float32Array(1600).fill(0.1), 16000)], { type: "audio/wav" });
    const result = await net.transcribe(wav);
    assert.equal(result.text, "AI, spawn a crate");
    assert.equal(bridge.audio[0].type, "audio/wav");
    assert.equal(bridge.audio[0].info.sampleRate, 16000);
    assert.equal(bridge.audio[0].bytes, 44 + 3200);
    bridge.sttMode = "off";
    await assert.rejects(net.transcribe(wav), (err) => err.code === "no-stt" && err.status === 503);
    const manifest = await net.parts();
    assert.equal(manifest.parts[0].name, "lamp");
    assert.deepEqual(await net.saveBlueprint({ name: "dragon", parts: [] }), { name: "dragon" });
  } finally {
    net.leave();
    await bridge.stop();
  }
});

test("leave tells the bridge (fetch fallback without sendBeacon) and stops traffic", async () => {
  const bridge = fakeBridge({ key: "KEY1" });
  await bridge.start();
  const net = new Net({ base: bridge.base(), key: "KEY1", EventSourceImpl: TestEventSource, timeouts: FAST });
  try {
    await net.join({ name: "Phone", device: "phone" });
    const id = net.user.id;
    net.leave();
    assert.equal(net.connected, false);
    await until(() => bridge.leaves.includes(id), 2000, "leave");
    net.sendPose({ p: [0, 1, 0], yaw: 0, hands: {} });
    assert.equal(await net.sendSay("hi"), false);
    await assert.rejects(net.sendOp({ t: "clear" }), (err) => err.code === "offline");
  } finally {
    await bridge.stop();
  }
});

// ---------- Avatars ----------

test("Avatars: remote heads/hands/devices, smoothing, local user hidden", () => {
  const scene = new THREE.Scene();
  const avatars = new Avatars({ scene, localUser: () => "u1" });
  avatars.setUsers([
    { id: "u1", name: "Me", device: "headset", color: "#d5fb6a" },
    { id: "u2", name: "Quest", device: "headset", color: "#6ad5fb" },
    { id: "u3", name: "Phone", device: "phone", color: "#fb8f6a" },
  ]);
  assert.equal(avatars.count, 2);
  assert.equal(avatars.headPose("u1"), null, "local user is not drawn");
  assert.equal(avatars.headPose("u2"), null, "no pose yet");

  avatars.setPoses({
    u1: { p: [0, 1.6, 0], yaw: 0, hands: { left: null, right: null } },
    u2: { p: [0, 1.6, -2], yaw: 0.5, hands: { left: { p: [-0.2, 1.2, -2.3], q: [0, 0, 0, 1] }, right: null }, talking: true },
    u3: { p: [2, 1.4, 0], yaw: Math.PI / 2, hands: { left: null, right: null } },
  });
  avatars.update(1 / 72);
  const head = avatars.headPose("u2");
  assert.deepEqual(head.p.map((n) => +n.toFixed(3)), [0, 1.6, -2], "first pose snaps");
  assert.ok(Math.abs(head.yaw - 0.5) < 1e-9);
  assert.equal(head.q.length, 4);
  const left = avatars.handPose("u2", "left");
  assert.ok(left.p.isVector3 && left.q.isQuaternion);
  assert.deepEqual(left.p.toArray().map((n) => +n.toFixed(3)), [-0.2, 1.2, -2.3]);
  assert.equal(avatars.handPose("u2", "right"), null);
  const out = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  assert.equal(avatars.handPose("u2", "left", out), out, "fills the given object");

  const group2 = scene.getObjectByName("avatar:u2");
  const group3 = scene.getObjectByName("avatar:u3");
  assert.ok(group2.visible && group3.visible);
  assert.equal(group3.getObjectByName("device-phone").visible, true, "phone user without hands shows a phone");
  assert.equal(group2.getObjectByName("device-phone"), undefined);

  // Eases toward a new pose (~100 ms), converges, and jumps on teleports.
  avatars.setPoses({ u2: { p: [1, 1.6, -2], yaw: 0.5, hands: { left: null, right: null } } });
  avatars.update(0.05);
  const mid = avatars.headPose("u2").p[0];
  assert.ok(mid > 0.2 && mid < 0.6, `eased x ${mid}`);
  for (let i = 0; i < 60; i++) avatars.update(1 / 72);
  assert.ok(Math.abs(avatars.headPose("u2").p[0] - 1) < 1e-3);
  assert.equal(avatars.handPose("u2", "left"), null, "hand gone when tracking lost");
  avatars.setPoses({ u2: { p: [30, 1.6, -2], yaw: 0.5, hands: {} } });
  avatars.update(1 / 72);
  assert.equal(avatars.headPose("u2").p[0], 30, "teleport snaps");

  avatars.setUsers([{ id: "u2", name: "Quest", device: "headset", color: "#ffffff" }]);
  assert.equal(avatars.count, 1);
  assert.equal(scene.getObjectByName("avatar:u3"), undefined, "removed from the scene");
  avatars.dispose();
  assert.equal(scene.getObjectByName("avatars"), undefined);
});

// ---------- laptop parts bin loader ----------

test("loadRemoteParts registers blueprints and modules, collects failures", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-parts-"));
  fs.writeFileSync(path.join(dir, "lamp.mjs"), `export default {
    name: "ignored name", aliases: ["street lamp"], desc: "tall lamp post", size: [0.3, 3, 0.3], holdable: false,
    build(THREE, opts) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3, 0.3), new THREE.MeshStandardMaterial({ color: opts.color || "#888888" }));
      m.position.y = 1.5;
      const g = new THREE.Group(); g.add(m); return g;
    },
  };\n`);
  fs.writeFileSync(path.join(dir, "nobuild.mjs"), "export default { name: 'broken' };\n");
  const net = {
    base: pathToFileURL(dir + path.sep).href,
    parts: async () => ({
      parts: [
        { name: "Totem", aliases: ["pole"], category: "custom", desc: "stack", size: [0.5, 2, 0.5], holdable: false, kind: "blueprint", blueprint: { name: "totem", parts: [{ shape: "box", p: [0, 1, 0], s: [0.5, 2, 0.5], color: "#aa5500" }], size: [0.5, 2, 0.5] } },
        { name: "lamp post", aliases: [], category: "custom", desc: "part from the laptop parts bin", size: null, holdable: false, kind: "module", url: "lamp.mjs" },
        { name: "broken", kind: "module", url: "nobuild.mjs" },
        { name: "statue", kind: "gltf", url: "statue.glb" },
        { name: "zip", kind: "zip" },
        { kind: "blueprint" },
      ],
    }),
  };
  const metas = new Map();
  const builders = new Map();
  const result = await loadRemoteParts(net, {
    registerMeta: (meta) => metas.set(meta.name, meta),
    registerBuilder: (name, fn) => builders.set(name, fn),
    buildBlueprint,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.count, 2, JSON.stringify(result.errors));
  assert.deepEqual(result.errors.map((e) => e.name).sort(), ["?", "broken", "statue", "zip"]);
  assert.ok(result.errors.every((e) => typeof e.error === "string" && e.error.length));

  const totem = metas.get("totem");
  assert.deepEqual([totem.category, totem.source, totem.size.join()], ["custom", "laptop", "0.5,2,0.5"]);
  assert.ok(!("blueprint" in totem) && !("kind" in totem));
  const built = builders.get("totem")({ color: "#ff0000", data: {}, text: "", seed: 1 });
  assert.ok(built.isObject3D);

  const lamp = metas.get("lamp post");
  assert.equal(lamp.desc, "tall lamp post");
  assert.deepEqual(lamp.aliases, ["street lamp"]);
  assert.deepEqual(lamp.size, [0.3, 3, 0.3]);
  const lampObj = builders.get("lamp post")({ color: "#123456", data: {}, text: "", seed: 2 });
  lampObj.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(lampObj).getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.y - 3) < 1e-6);
});

test("loadRemoteParts reports a failing manifest instead of throwing", async () => {
  const result = await loadRemoteParts({ base: "http://x/", parts: async () => { throw new Error("offline"); } }, {});
  assert.deepEqual(result, { count: 0, errors: [{ name: "*", kind: "manifest", error: "offline" }] });
});
