#!/usr/bin/env node
// Training Room doctor: checks this laptop for the bridge (Node.js, settings, the local model, a real
// voice command through it, vision, speech to text, the laptop voice, the network) and prints PASS,
// WARN, FAIL or SKIP per check. It writes only to the bridge data folder: config.json when it is
// missing (like the bridge) and its report, reports/doctor-<YYYYMMDD-HHMMSS>.json and .md.
//
// Usage: node doctor.mjs [--data <dir>] [--json] [--require stt,tts,vision] [--timeout <s>]
//   --data <dir>       bridge data folder (default: the bridge's; env TRAINING_ROOM_DATA also works)
//   --json             print the JSON report instead of the table
//   --require <list>   optional checks that must pass too: stt, tts, vision
//   --timeout <s>      time limit for each model call (default 60); other checks wait 10 s at most
// Exit code: 0 when node, config, ollama, model-command and every --require'd check pass (WARN counts
// as a pass for the first four); 1 otherwise; 2 for bad options.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { allMeta } from "../js/parts/meta/index.js";
import { planIntents } from "../js/core/execute.js";
import { createState } from "../js/core/room-state.js";
import { rightOf } from "../js/core/place.js";
import { asciiArt, projectStrokes, sketchStats } from "../js/core/sketch.js";
import { encodeWav, resampleLinear, wavInfo } from "../js/voice/wav.js";
import { LocalModel, catalogText, createMatcher } from "./llm.mjs";
import { SpeechToText } from "./stt.mjs";
import { TextToSpeech } from "./tts.mjs";
import { loadConfig, sanitizeConfig, defaultDataDir, isInside } from "./config.mjs";
import { lanAddresses, certIPs } from "./cert.mjs";
import { PartsBin } from "./parts-bin.mjs";
import { REPO_ROOT } from "./static.mjs";
import { VERSION, reportStamp, saveReport } from "./server.mjs";
import { encodePNG } from "./png.mjs";

const COMMAND = "AI, spawn a villa to my left";
// The player at the world origin looking toward -Z, where the game spawns them.
const PLAYER = { p: [0, 1.6, 0], yaw: 0, hands: { left: null, right: null } };
export const LABEL = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };
const CORE = ["node", "config", "ollama", "model-command"];
const OPTIONAL = ["stt", "tts", "vision"];
const STEP_MS = 10000;
const SPOKEN = "AI, spawn a crate.";
const USAGE = "Usage: node doctor.mjs [--data <dir>] [--json] [--require stt,tts,vision] [--timeout <s>]";
const quiet = { log() {}, warn() {}, error() {} };

// ---------- helpers shared with the other laptop checks ----------
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    const self = fs.realpathSync(fileURLToPath(metaUrl));
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    return process.platform === "win32" ? self.toLowerCase() === entry.toLowerCase() : self === entry;
  } catch {
    return false;
  }
}

// --data or the bridge's default folder. inRepo: the checks must not write there.
export function dataDirOf(arg) {
  const dataDir = path.resolve(arg || defaultDataDir());
  return { dataDir, inRepo: isInside(REPO_ROOT, dataDir) };
}

// Plain-text table; the last column is not padded.
export function formatTable(header, rows) {
  const all = [header, ...rows].map((row) => row.map((cell) => String(cell ?? "")));
  const widths = header.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  return all.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ").trimEnd()).join("\n");
}

export const mdCell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
export const fmtMs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

// Upstream errors carry { status, body: { error, detail?, raw? } }.
export function errorText(err) {
  const body = err?.body;
  if (body && typeof body === "object") {
    const more = body.detail || (body.raw ? `the model said ${JSON.stringify(String(body.raw).slice(0, 160))}` : "");
    return [body.error, more].filter(Boolean).join(": ");
  }
  return err?.cause?.code || err?.message || String(err);
}

// "spawn villa left, time night" for a list of normalized intents.
export function describeIntents(intents) {
  return (intents || []).map((i) => {
    const what = i.what?.custom ? `custom "${i.what.custom.name}"` : i.what?.part || i.target?.part || i.target?.ref || i.label || i.hint || i.value || i.behavior || "";
    return [i.do, what, i.place?.rel, i.count > 1 ? `x${i.count}` : ""].filter(Boolean).join(" ");
  }).join(", ") || "no intents";
}

// ---------- test inputs ----------
// A purple marker circle about 0.8 m wide, as the game sends it: PNG snapshot, ASCII art and stats.
function circleSketch(px = 160) {
  const rgba = new Uint8Array(px * px * 4).fill(255);
  const c = (px - 1) / 2;
  const r = px * 0.36;
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      if (Math.abs(Math.hypot(x - c, y - c) - r) > px * 0.025) continue;
      rgba.set([0x9b, 0x6b, 0xff, 255], (y * px + x) * 4);
    }
  }
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    pts.push(Math.round(Math.cos(a) * 400) / 1000, Math.round((1 + Math.sin(a)) * 400) / 1000, 0);
  }
  const strokes = [{ c: "#9b6bff", w: 0.012, pts }];
  const stats = sketchStats(strokes);
  return { image: `data:image/png;base64,${encodePNG(px, px, rgba).toString("base64")}`, ascii: asciiArt(projectStrokes(strokes)), stats, size: [stats.width, stats.height] };
}

// TTS audio (16-bit PCM WAV, any rate) → 16 kHz mono WAV like the game records; null if not PCM16.
function speechWav(audio) {
  const info = wavInfo(audio);
  if (!info || info.format !== 1 || info.bits !== 16 || !info.channels || !info.frames) return null;
  const start = audio.length - info.dataBytes; // TTS servers put the data chunk last
  const samples = new Float32Array(info.frames);
  for (let i = 0; i < info.frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < info.channels; ch++) sum += audio.readInt16LE(start + (i * info.channels + ch) * 2);
    samples[i] = sum / info.channels / 32768;
  }
  return Buffer.from(encodeWav(info.sampleRate === 16000 ? samples : resampleLinear(samples, info.sampleRate, 16000), 16000));
}

// The catalog the bridge gives the model: built-in parts plus the laptop parts bin (read only).
async function bridgeCatalog(config, dataDir) {
  const bin = new PartsBin({ dirs: [path.join(dataDir, "parts"), ...config.partsDirs.map((d) => path.resolve(dataDir, d))], log: quiet });
  await bin.scan();
  const byName = new Map(allMeta().map((m) => [m.name, m]));
  for (const meta of bin.metas()) byName.set(meta.name, meta);
  const metas = [...byName.values()];
  return { metas, text: catalogText(metas), compact: catalogText(metas, { compact: true }), match: createMatcher(metas) };
}

// ---------- checks: each returns { status, detail, info? } ----------
function checkNode() {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  if (major < 20) return { status: "fail", detail: `Node.js ${version}: the bridge needs 20 or newer (22 LTS recommended, https://nodejs.org)` };
  if (major < 22) return { status: "warn", detail: `Node.js ${version}: works; 22 LTS is recommended` };
  return { status: "pass", detail: `Node.js ${version}` };
}

function checkConfig(dataDir, inRepo, use) {
  if (inRepo) return { status: "fail", detail: `${dataDir} is inside the game repository; choose a data folder outside it (--data)` };
  const notes = [];
  const loaded = loadConfig(dataDir, { log: { log() {}, error() {}, warn: (m) => notes.push(String(m).replace(/^\[config\] /, "")) } });
  const c = loaded.config;
  use(c);
  const what = `${loaded.file}${loaded.created ? " (created with defaults)" : ""}: provider ${c.provider}, model ${c.model || "picked automatically"}, speech to text ${c.sttKind}, laptop voice ${c.ttsKind}`;
  return { status: notes.length ? "warn" : "pass", detail: [what, ...notes].join("; "), info: { file: loaded.file, created: loaded.created, broken: loaded.broken } };
}

async function checkModelServer(model) {
  await model.refresh(true);
  const label = model.provider === "openai" ? "OpenAI-compatible server" : "Ollama";
  const info = { provider: model.provider, url: model.url, version: model.version || null, models: model.models, model: model.available ? model.name : null, vision: model.vision };
  if (!model.available) return { status: "fail", detail: /not reachable/.test(model.detail) ? `${model.detail}; start ${label} first` : model.detail, info };
  info.capabilities = model.provider === "ollama" ? await model.capabilities(model.name) : null;
  const caps = info.capabilities ? ` (${info.capabilities.join(", ")})` : "";
  const detail = `${label}${model.version ? ` ${model.version}` : ""} at ${model.url}: ${model.models.length} model${model.models.length === 1 ? "" : "s"} installed; the bridge uses ${model.name}${caps}; drawings: ${model.vision ? `${model.vision} looks at them` : "read as ASCII art"}`;
  // With a model available, LocalModel's detail is only set for an Ollama older than 0.31.2.
  return { status: model.detail ? "warn" : "pass", detail: model.detail ? `${detail}; ${model.detail}` : detail, info };
}

async function checkCommand(model, catalog) {
  if (!model.available) return { status: "fail", detail: "skipped: no model to ask (see ollama)" };
  const player = { user: "u-doctor", ...PLAYER };
  const result = await model.command({ text: COMMAND, ctx: { player }, held: [], scene: [], metas: catalog.metas, catalog: catalog.text, sceneNames: new Set(), match: catalog.match });
  const plan = planIntents(result.intents, { user: player.user, player, metas: catalog.metas, state: createState() });
  const spawns = result.intents.filter((i) => i.do === "spawn");
  const adds = plan.ops.filter((op) => op.t === "add");
  const problems = [];
  if (spawns.length !== 1) problems.push(`${spawns.length} spawn intents instead of 1`);
  else {
    const part = spawns[0].what?.part;
    if (part !== "villa") problems.push(`spawned ${part ? `"${part}"` : "a custom part"} instead of "villa"`);
    if (spawns[0].place?.rel !== "left") problems.push(`placed it ${spawns[0].place?.rel ? `"${spawns[0].place.rel}"` : "nowhere"} instead of "left"`);
  }
  if (adds.length !== 1 || adds[0].obj.part !== "villa") problems.push(`planned ${adds.length} new object${adds.length === 1 ? "" : "s"} (${adds.map((op) => op.obj.part).join(", ") || "none"}) instead of one villa`);
  else {
    const right = rightOf(player.yaw);
    if ((adds[0].obj.p[0] - player.p[0]) * right[0] + (adds[0].obj.p[2] - player.p[2]) * right[2] >= 0) problems.push("the villa did not land on the player's left");
  }
  const detail = `"${COMMAND}" → ${describeIntents(result.intents)} (${result.model}, ${fmtMs(result.ms)})`;
  const info = { model: result.model, ms: result.ms, intents: result.intents, say: result.say, ops: plan.ops.length };
  return problems.length ? { status: "fail", detail: `${detail}: ${problems.join("; ")}`, info } : { status: "pass", detail, info };
}

async function checkVision(model, catalog) {
  if (!model.available) return { status: "warn", detail: "skipped: no model (see ollama)" };
  if (!model.vision) return { status: "warn", detail: `no vision model installed: ${model.name} reads drawings as ASCII art (a vision model such as qwen2.5vl:7b lets the AI see them)` };
  const result = await model.interpret({ ...circleSketch(), metas: catalog.metas, catalog: catalog.compact, match: catalog.match });
  const guessed = `guessed "${result.guess}" (${result.part || (result.blueprint ? "new part" : "doodle")}, ${result.behavior}, confidence ${result.confidence}, ${fmtMs(result.ms)})`;
  const info = { model: result.model, vision: result.vision, guess: result.guess, part: result.part, behavior: result.behavior, confidence: result.confidence, ms: result.ms };
  if (!result.vision) return { status: "warn", detail: `${model.vision} could not look at the picture; ${result.model} read the ASCII art instead and ${guessed}`, info };
  return { status: "pass", detail: `${result.model} looked at a drawn circle and ${guessed}`, info };
}

async function checkTts(config) {
  if (config.ttsKind === "none") return { status: "skip", detail: "the laptop voice is off (ttsKind: none): each device uses its own browser voice" };
  const tts = new TextToSpeech(config, { log: quiet, timeoutMs: STEP_MS });
  await tts.probe();
  if (!tts.available) return { status: "warn", detail: `${tts.kind}: ${tts.detail}` };
  const out = await tts.synthesize(SPOKEN);
  return { status: "pass", detail: `${tts.kind} at ${tts.url}: "${SPOKEN}" → ${Math.ceil(out.audio.length / 1024)} KB ${out.type} in ${fmtMs(out.ms)}`, audio: out.audio, info: { kind: tts.kind, url: tts.url, type: out.type, bytes: out.audio.length, ms: out.ms } };
}

async function checkStt(config, ttsAudio) {
  if (config.sttKind === "none") return { status: "skip", detail: "speech to text is off (sttKind: none): headset voice commands need it" };
  const stt = new SpeechToText(config, { log: quiet });
  await stt.probe();
  if (!stt.available) return { status: "warn", detail: `${stt.kind}: ${stt.detail}` };
  const speech = ttsAudio ? speechWav(ttsAudio) : null;
  let out;
  try {
    out = await stt.transcribe(speech || Buffer.from(encodeWav(new Float32Array(16000), 16000)), { signal: AbortSignal.timeout(STEP_MS) });
  } catch (err) {
    if (err.body?.error === "aborted") throw new Error(`no answer from ${stt.url} within ${STEP_MS / 1000} s`);
    throw err;
  }
  const info = { kind: stt.kind, url: stt.url, text: out.text, ms: out.ms, roundTrip: !!speech };
  if (!speech) return { status: "pass", detail: `${stt.kind} at ${stt.url} answered 1 s of silence in ${fmtMs(out.ms)}${out.text ? ` ("${out.text}")` : ""}; with the laptop voice running this becomes a spoken round trip`, info };
  if (!/crate/i.test(out.text)) return { status: "fail", detail: `round trip: the laptop voice said "${SPOKEN}" but ${stt.kind} heard "${out.text}"`, info };
  return { status: "pass", detail: `round trip: the laptop voice said "${SPOKEN}" and ${stt.kind} heard "${out.text}" in ${fmtMs(out.ms)}`, info };
}

async function checkNetwork(config, dataDir) {
  const addresses = lanAddresses();
  const real = addresses.filter((a) => !a.virtual);
  const notes = [];
  const problems = [];
  if (real.length) notes.push(`headset address ${real.map((a) => `https://${a.address}:${config.port}/ (${a.ifname})`).join(", ")}`);
  else problems.push("no Wi-Fi or Ethernet address: the headset and phone cannot reach this laptop (connect to Wi-Fi, or use USB with adb reverse)");
  let hello = null;
  if (config.httpPort) {
    try {
      const res = await fetch(`http://127.0.0.1:${config.httpPort}/api/hello`, { signal: AbortSignal.timeout(STEP_MS) });
      hello = res.ok ? await res.json() : null;
    } catch {
      hello = null;
    }
  }
  notes.push(hello?.bridge ? `bridge ${hello.version} is running on port ${config.httpPort}` : `bridge not running on port ${config.httpPort}`);
  let certificate = null;
  try {
    const x509 = new crypto.X509Certificate(fs.readFileSync(path.join(dataDir, "cert.pem")));
    const covers = certIPs(x509);
    certificate = { covers, validTo: x509.validTo };
    const missing = ["127.0.0.1", ...real.map((a) => a.address)].filter((ip) => !covers.includes(ip));
    if (missing.length) problems.push(`the HTTPS certificate does not cover ${missing.join(", ")}: the bridge makes a new one at its next start and each device must accept it again`);
    else if (Date.parse(x509.validTo) <= Date.now() + 24 * 3600 * 1000) problems.push("the HTTPS certificate expires within a day: the bridge renews it at its next start");
    else notes.push(`certificate covers ${covers.join(", ")}`);
  } catch (err) {
    if (err.code === "ENOENT") notes.push("no certificate yet (the bridge makes one at its first start)");
    else problems.push(`the certificate in ${dataDir} is unreadable (${err.message}): the bridge makes a new one at its next start`);
  }
  return { status: problems.length ? "warn" : "pass", detail: [...notes, ...problems].join("; "), info: { addresses, bridgeRunning: !!hello?.bridge, bridgeVersion: hello?.version || null, certificate } };
}

// ---------- run ----------
// required: optional check ids (stt, tts, vision) that must pass. → the report object.
async function runDoctor({ dataArg, required = new Set(), modelMs = 60000 } = {}) {
  const at = new Date();
  const { dataDir, inRepo } = dataDirOf(dataArg);
  const checks = [];
  const run = async (id, fn) => {
    const started = Date.now();
    let result;
    try {
      result = await fn();
    } catch (err) {
      result = { status: "fail", detail: errorText(err) };
    }
    const optionalRequired = required.has(id);
    // A --require'd part that is off, missing or only half working fails.
    const status = optionalRequired && result.status !== "pass" ? "fail" : result.status;
    checks.push({ id, status, required: CORE.includes(id) || optionalRequired, ms: Date.now() - started, detail: result.detail, ...(result.info ? { info: result.info } : {}) });
    return result;
  };

  let config = sanitizeConfig({}).config;
  await run("node", checkNode);
  await run("config", () => checkConfig(dataDir, inRepo, (c) => (config = c)));
  const model = new LocalModel(config, { log: quiet, timeoutMs: modelMs, visionTimeoutMs: modelMs });
  await run("ollama", () => checkModelServer(model));
  let catalog = null;
  const getCatalog = () => (catalog ||= bridgeCatalog(config, dataDir));
  await run("model-command", async () => checkCommand(model, await getCatalog()));
  await run("vision", async () => checkVision(model, await getCatalog()));
  const tts = await run("tts", () => checkTts(config));
  await run("stt", () => checkStt(config, tts.audio));
  await run("network", () => checkNetwork(config, dataDir));

  const requiredIds = checks.filter((c) => c.required).map((c) => c.id);
  const failed = checks.filter((c) => c.required && c.status === "fail").map((c) => c.id);
  const others = checks.filter((c) => !c.required && c.status !== "pass").map((c) => `${c.id} ${LABEL[c.status]}`);
  const ok = failed.length === 0;
  const summary = `${ok ? `${requiredIds.join(", ")} passed` : `${failed.join(", ")} failed`}${others.length ? `. Not required: ${others.join(", ")}` : ""}.`;
  return { tool: "doctor", version: 1, at: at.toISOString(), ok, summary, dataDir, inRepo, bridge: VERSION, node: process.versions.node, platform: process.platform, required: requiredIds, checks };
}

function markdown(report) {
  const lines = [
    "# Training Room doctor",
    "",
    `- When: ${report.at}`,
    `- Data folder: \`${report.dataDir}\``,
    `- Bridge ${report.bridge}, Node.js ${report.node}, ${report.platform}`,
    `- Result: **${report.ok ? "PASS" : "FAIL"}**. ${report.summary}`,
    "",
    "| Check | Required | Status | Time | Detail |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const c of report.checks) lines.push(`| ${c.id} | ${c.required ? "yes" : "no"} | ${LABEL[c.status]} | ${fmtMs(c.ms)} | ${mdCell(c.detail)} |`);
  return `${lines.join("\n")}\n`;
}

// Saves the report as JSON and Markdown. → { files: [json, md] } or { note } when it cannot.
export async function saveRun(report, prefix, md) {
  if (report.inRepo) return { files: [], note: "report not saved: the data folder is inside the repository" };
  try {
    const files = await saveReport(report.dataDir, `${prefix}-${reportStamp(new Date(report.at))}`, { json: `${JSON.stringify(report, null, 2)}\n`, md });
    return { files };
  } catch (err) {
    return { files: [], note: `report not saved: ${err.message}` };
  }
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    ({ values: args } = parseArgs({
      args: argv,
      options: { data: { type: "string" }, json: { type: "boolean" }, require: { type: "string" }, timeout: { type: "string" }, help: { type: "boolean", short: "h" } },
      strict: true,
    }));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const required = new Set(String(args.require || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const unknown = [...required].filter((id) => !OPTIONAL.includes(id));
  const seconds = args.timeout === undefined ? 60 : Number(args.timeout);
  if (unknown.length || !(seconds > 0)) {
    console.error(`${unknown.length ? `--require takes ${OPTIONAL.join(", ")} (not ${unknown.join(", ")})` : "--timeout needs a number of seconds"}\n${USAGE}`);
    return 2;
  }
  const report = await runDoctor({ dataArg: args.data, required, modelMs: seconds * 1000 });
  const saved = await saveRun(report, "doctor", markdown(report));
  if (args.json) {
    console.log(JSON.stringify({ ...report, files: saved.files }, null, 2));
  } else {
    const rows = report.checks.map((c) => [`${c.id}${c.required ? " *" : ""}`, LABEL[c.status], fmtMs(c.ms), c.detail]);
    console.log([
      `Training Room doctor · bridge ${report.bridge} · ${report.at}`,
      `Data folder: ${report.dataDir}`,
      "",
      formatTable(["CHECK", "STATUS", "TIME", "DETAIL"], rows),
      "* required",
      "",
      `RESULT: ${report.ok ? "PASS" : "FAIL"}. ${report.summary}`,
      saved.files.length ? `Report: ${saved.files.join(" and ")}` : saved.note,
    ].join("\n"));
  }
  return report.ok ? 0 : 1;
}

if (isMain(import.meta.url)) main().then((code) => (process.exitCode = code));
