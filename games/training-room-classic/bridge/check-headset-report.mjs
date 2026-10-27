#!/usr/bin/env node
// Checks the newest headset self-test report against the acceptance criteria and prints PASS/FAIL per
// item. The game's self-test saves it through POST api/report as reports/headset-<YYYYMMDD-HHMMSS>-<user>.json
// in the bridge data folder.
//
// Usage: node check-headset-report.mjs [--data <dir>] [--file <path>] [--max-age-hours 72] [--min-fps 65]
//   --data <dir>           bridge data folder (default: the bridge's; env TRAINING_ROOM_DATA also works)
//   --file <path>          check this report instead of the newest one
//   --max-age-hours <h>    the report must be at most this old (default 72)
//   --min-fps <n>          lowest acceptable average frame rate in VR (default 65, same as the in-game check)
// Exit code: 0 when every required item passes; 1 otherwise (also with no report or a stale one);
// 2 for bad options.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isMain, dataDirOf, formatTable, LABEL } from "./doctor.mjs";

const USAGE = "Usage: node check-headset-report.mjs [--data <dir>] [--file <path>] [--max-age-hours 72] [--min-fps 65]";
const PREFIX = "headset-";

// Newest reports/headset-*.json by the save time in its name, then by file time. → path or null.
function newestReport(dataDir) {
  const dir = path.join(dataDir, "reports");
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(PREFIX) && n.endsWith(".json"));
  } catch {
    return null;
  }
  const items = names.map((name) => {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      // Listed but gone: sorts last.
    }
    return { name, stamp: name.slice(PREFIX.length, PREFIX.length + 15), mtime };
  });
  items.sort((a, b) => (a.stamp === b.stamp ? b.mtime - a.mtime : a.stamp < b.stamp ? 1 : -1));
  return items.length ? path.join(dir, items[0].name) : null;
}

const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const on = (v) => (v && typeof v === "object" ? !!v.available : !!v); // bridge.stt/tts: boolean or { available }

// report: the parsed self-test. → [{ id, required, status, detail }]
function checkReport(report, { minFps = 65, maxAgeHours = 72, now = Date.now(), fileTime = null } = {}) {
  const r = obj(report);
  const xr = obj(r.xr);
  const fps = obj(xr.fps);
  const mic = obj(r.mic);
  const bridge = obj(r.bridge);
  const whisper = obj(r.whisper);
  const tts = obj(r.tts);
  const items = [];
  const add = (id, required, status, detail) => items.push({ id, required, status, detail });
  const pass = (id, ok, good, bad) => add(id, true, ok ? "pass" : "fail", ok ? good : bad);

  const savedAt = Date.parse(r.at);
  const at = Number.isFinite(savedAt) ? savedAt : fileTime;
  if (at === null) add("fresh", true, "fail", "the report has no time (at)");
  else {
    const hours = Math.max(0, (now - at) / 3600000);
    const when = `${hours.toFixed(1)} h ago${Number.isFinite(savedAt) ? "" : " (file time; the report has no \"at\")"}`;
    pass("fresh", hours <= maxAgeHours, `saved ${when} (limit ${maxAgeHours} h)`, `the report is too old: saved ${when}, limit ${maxAgeHours} h. Run the self-test in the headset again`);
  }
  pass("secure-context", r.secureContext === true, "the page ran in a secure context",
    r.secureContext === false ? "not a secure context: open the game over https://<laptop-ip>:8787 or through adb reverse at http://localhost:8788" : "secureContext missing from the report");
  pass("xr-supported", xr.supported === true, "immersive VR supported", xr.api === false ? "the browser has no WebXR (navigator.xr)" : xr.supported === false ? "the browser says immersive VR is not supported" : "xr.supported missing from the report");
  pass("xr-session", xr.sessionStarted === true, `a VR session started${xr.referenceSpace ? ` (${xr.referenceSpace} space)` : ""}`,
    `no VR session started${xr.error ? `: ${xr.error}` : xr.sessionStarted === undefined ? " (xr.sessionStarted missing)" : ""}`);
  const avg = num(fps.avg);
  const fpsText = avg === null ? "" : `average ${avg.toFixed(1)} fps${num(fps.p5) !== null ? `, 5th percentile ${fps.p5.toFixed(1)}` : ""}${num(fps.frames) !== null ? `, ${fps.frames} frames` : ""}${num(fps.seconds) !== null ? ` in ${fps.seconds} s` : ""}${num(fps.droppedOver20ms) !== null ? `, ${fps.droppedOver20ms} over 20 ms` : ""}`;
  pass("fps", avg !== null && avg >= minFps, `${fpsText} (minimum ${minFps})`, avg === null ? "no frame rate measured (xr.fps.avg missing)" : `${fpsText}: below the minimum of ${minFps}`);
  const hands = new Map();
  for (const input of Array.isArray(xr.inputs) ? xr.inputs : []) {
    const side = obj(input).handedness;
    if (side === "left" || side === "right") hands.set(side, Array.isArray(input.profiles) && input.profiles[0] ? input.profiles[0] : "input");
  }
  const seen = [...hands].map(([side, profile]) => `${side}: ${profile}`).join(", ");
  pass("controllers", hands.has("left") && hands.has("right"), seen, `need a left and a right controller or hand; saw ${seen || "none"}`);
  const peak = num(mic.peakLevel);
  const micText = `permission ${mic.permission ?? "unknown"}, peak level ${peak ?? "unknown"}${mic.error ? `, error: ${mic.error}` : ""}`;
  pass("mic", mic.permission === "granted" && peak !== null && peak > 0, micText, `${micText}: the microphone must be allowed and hear something`);
  pass("bridge", bridge.reachable === true && bridge.auth === true, `bridge reachable, room key accepted${bridge.model ? `, model ${typeof bridge.model === "string" ? bridge.model : obj(bridge.model).name || "on"}` : ""}`,
    bridge.reachable !== true ? "the headset could not reach the laptop bridge" : "the bridge did not accept the room key (open the address with ?k=KEY again)");
  if (on(bridge.stt)) {
    pass("whisper", whisper.ok === true, `Whisper heard "${whisper.text ?? ""}"${num(whisper.ms) !== null ? ` in ${whisper.ms} ms` : ""}`,
      whisper.tried ? `Whisper failed${whisper.error ? `: ${whisper.error}` : ""}` : "the bridge has speech to text but the self-test did not try it");
  } else {
    add("whisper", false, "skip", "the bridge had no speech to text, so headset voice commands cannot work (start whisper-server)");
  }
  if (on(bridge.tts)) add("laptop-voice", false, tts.ok === true ? "pass" : "warn", tts.ok === true ? `played${num(tts.ms) !== null ? ` in ${tts.ms} ms` : ""}` : "the laptop voice did not play");
  else add("laptop-voice", false, "skip", "the bridge had no laptop voice; replies use the headset's browser voice or captions");
  return items;
}

function main(argv = process.argv.slice(2)) {
  let args;
  try {
    ({ values: args } = parseArgs({
      args: argv,
      options: { data: { type: "string" }, file: { type: "string" }, "max-age-hours": { type: "string" }, "min-fps": { type: "string" }, help: { type: "boolean", short: "h" } },
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
  const maxAgeHours = args["max-age-hours"] === undefined ? 72 : Number(args["max-age-hours"]);
  const minFps = args["min-fps"] === undefined ? 65 : Number(args["min-fps"]);
  if (!(maxAgeHours > 0) || !(minFps >= 0)) {
    console.error(`--max-age-hours and --min-fps need positive numbers\n${USAGE}`);
    return 2;
  }
  const { dataDir } = dataDirOf(args.data);
  const file = args.file ? path.resolve(args.file) : newestReport(dataDir);
  if (!file) {
    console.log(`RESULT: FAIL. No headset report in ${path.join(dataDir, "reports")}: run the self-test in the headset with the bridge running.`);
    return 1;
  }
  let report;
  let fileTime = null;
  try {
    fileTime = fs.statSync(file).mtimeMs;
    report = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    console.log(`RESULT: FAIL. Cannot read ${file}: ${err.message}`);
    return 1;
  }
  const items = checkReport(report, { minFps, maxAgeHours, fileTime });
  const required = items.filter((i) => i.required);
  const failed = required.filter((i) => i.status !== "pass").map((i) => i.id);
  const r = obj(report);
  const device = [r.device && (typeof r.device === "string" ? r.device : JSON.stringify(r.device)), r.ua].filter(Boolean).join(" · ");
  const scene = obj(r.scene);
  console.log([
    `Training Room headset check · ${file}`,
    `Device: ${device || "unknown"}${num(scene.objects) !== null ? ` · scene: ${scene.objects} objects, ${scene.drawCalls ?? "?"} draw calls, ${scene.triangles ?? "?"} triangles` : ""}`,
    "",
    formatTable(["ITEM", "STATUS", "DETAIL"], items.map((i) => [`${i.id}${i.required ? " *" : ""}`, LABEL[i.status], i.detail])),
    "* required",
    "",
    failed.length ? `RESULT: FAIL. ${failed.join(", ")} failed.` : `RESULT: PASS. All ${required.length} required items passed.`,
  ].join("\n"));
  return failed.length ? 1 : 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
