#!/usr/bin/env node
// Training Room model eval: runs the canonical voice commands in tests/fixtures/model-eval.json through
// the bridge's model path (LocalModel.command, then the game's planner) for one or more installed
// models and scores each: accuracy, latency (mean, median, p95) and every miss with what came back.
// It uses the built-in parts catalog (not the laptop parts bin), so runs compare across laptops.
// Saves reports/model-eval-<YYYYMMDD-HHMMSS>.json and .md in the bridge data folder.
//
// Usage: node eval-model.mjs [--data <dir>] [--model a,b] [--threshold 0.8] [--json] [--limit n] [--timeout <s>]
//   --data <dir>      bridge data folder (default: the bridge's); its config.json names the model server
//   --model a,b       models to compare (default: the one the bridge would pick)
//   --threshold <x>   accuracy every model needs, 0 to 1 (default 0.8)
//   --json            print the JSON report instead of the tables
//   --limit <n>       run only the first n commands
//   --timeout <s>     time limit per command (default 60; the bridge itself gives up after 25 s)
// Exit code: 0 when every model scores at least the threshold; 1 otherwise; 2 for bad options.
//
// A case is { id, text, scene?, expect } or { id, text, scene?, anyOf: [expect, …] } (passes when one
// matches). scene names a list of room records in the fixture's "scenes". expect may have:
//   intents  patterns for the normalized intents: the same number, in order. "say" intents are left
//            out unless a pattern has do: "say".
//   ops      patterns for the planned room ops: the same number, in any order ("$n": 3 repeats a
//            pattern). The planner must report no errors. Ops are matched as views:
//            add { id, part, label, custom, side, dist, held, onto, near, color, text, s }
//            set { id, part, and only what the op changes: side, dist, held, color, text, s, behavior }
//            del { ids, parts } (sorted), env { time }, clear {}
//            side: left | right | front | behind as seen by the player; dist: meters from the player;
//            held: the hand or null; onto/near: the part it stands on / the part nearest to it.
//   undo     the planner's undo count.  say: true = a non-empty spoken reply.
// Pattern values: a string matches ignoring case; numbers, booleans and null match exactly;
// { "$re": "…" } is a case-insensitive regular expression; { "$in": [ … ] } any one value;
// { "$gte": n, "$lte": n } a number range; { "$exists": bool }; an object matches the keys it lists;
// an array matches item by item and has the same length.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { allMeta } from "../js/parts/meta/index.js";
import { planIntents } from "../js/core/execute.js";
import { createState, applyOp, snapshot, summarize } from "../js/core/room-state.js";
import { forwardOf, rightOf } from "../js/core/place.js";
import { LocalModel, catalogText, createMatcher } from "./llm.mjs";
import { loadConfig } from "./config.mjs";
import { VERSION } from "./server.mjs";
import { isMain, dataDirOf, formatTable, mdCell, fmtMs, errorText, describeIntents, saveRun } from "./doctor.mjs";

const FIXTURE = fileURLToPath(new URL("../tests/fixtures/model-eval.json", import.meta.url));
const BRIDGE_TIMEOUT_MS = 25000; // createBridge's model time limit: slower answers never reach the game
const USAGE = "Usage: node eval-model.mjs [--data <dir>] [--model a,b] [--threshold 0.8] [--json] [--limit n] [--timeout <s>]";
const quiet = { log() {}, warn() {}, error() {} };

// ---------- matching ----------
const OPERATORS = {
  $re: (v, actual) => (typeof actual === "string" || typeof actual === "number") && new RegExp(v, "i").test(String(actual)),
  $in: (v, actual) => Array.isArray(v) && v.some((p) => matches(p, actual)),
  $gte: (v, actual) => typeof actual === "number" && actual >= v,
  $lte: (v, actual) => typeof actual === "number" && actual <= v,
  $exists: (v, actual) => (actual !== undefined) === !!v,
};

// One pattern against one value (rules at the top of this file).
export function matches(pattern, actual) {
  if (typeof pattern === "string") return typeof actual === "string" && actual.trim().toLowerCase() === pattern.trim().toLowerCase();
  if (pattern === null || typeof pattern !== "object") return actual === pattern;
  if (Array.isArray(pattern)) return Array.isArray(actual) && actual.length === pattern.length && pattern.every((p, i) => matches(p, actual[i]));
  const keys = Object.keys(pattern);
  if (keys.some((k) => k.startsWith("$"))) {
    return keys.every((k) => {
      if (!OPERATORS[k]) throw new Error(`unknown pattern operator ${k}`);
      return OPERATORS[k](pattern[k], actual);
    });
  }
  return !!actual && typeof actual === "object" && !Array.isArray(actual) && keys.every((k) => matches(pattern[k], actual[k]));
}

// Every pattern takes a different view and no view is left over.
function assign(patterns, views) {
  if (patterns.length !== views.length) return false;
  const used = views.map(() => false);
  const step = (i) => {
    if (i === patterns.length) return true;
    for (let j = 0; j < views.length; j++) {
      if (used[j] || !matches(patterns[i], views[j])) continue;
      used[j] = true;
      if (step(i + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  return step(0);
}

// Planned ops → views (see the top of this file), replayed on a copy of the scene.
function opViews(ops, state, player) {
  const work = snapshot(state);
  const head = player.p;
  const fwd = forwardOf(player.yaw || 0);
  const right = rightOf(player.yaw || 0);
  const where = (p) => {
    const dx = p[0] - head[0];
    const dz = p[2] - head[2];
    const ahead = dx * fwd[0] + dz * fwd[2];
    const across = dx * right[0] + dz * right[2];
    const side = Math.abs(across) >= Math.abs(ahead) ? (across < 0 ? "left" : "right") : ahead >= 0 ? "front" : "behind";
    return { side, dist: Math.round(Math.hypot(dx, dz) * 10) / 10 };
  };
  const partOf = (id) => work.objects[id]?.part ?? null;
  return ops.map((op) => {
    let view;
    if (op.t === "add") {
      const o = op.obj;
      let near = null;
      let best = Infinity;
      for (const other of Object.values(work.objects)) {
        const d = Math.hypot(other.p[0] - o.p[0], other.p[2] - o.p[2]);
        if (d < best) {
          best = d;
          near = other.part;
        }
      }
      view = { t: "add", id: o.id, part: o.part, label: o.label, custom: !!o.data?.blueprint, ...where(o.p), held: o.attach?.hand ?? null, onto: o.onto ? partOf(o.onto) : null, near, color: o.color ?? null, text: o.text ?? null, s: o.s };
    } else if (op.t === "set") {
      const patch = op.patch || {};
      view = { t: "set", id: op.id, part: partOf(op.id) };
      if (patch.p) Object.assign(view, where(patch.p));
      if ("attach" in patch) view.held = patch.attach?.hand ?? null;
      for (const key of ["color", "text", "s"]) if (key in patch) view[key] = patch[key];
      if ("data" in patch) view.behavior = patch.data?.behavior?.kind ?? null;
    } else if (op.t === "del") {
      view = { t: "del", ids: [...op.ids].sort(), parts: op.ids.map(partOf).sort() };
    } else if (op.t === "env") {
      view = { t: "env", time: op.time };
    } else {
      view = { t: op.t };
    }
    applyOp(work, op);
    return view;
  });
}

const show = (value) => {
  const text = JSON.stringify(value, (key, v) => (v === null || v === false || (key === "id" && typeof v === "string" && /^oeval/.test(v)) ? undefined : v));
  return text.length > 400 ? `${text.slice(0, 399)}…` : text;
};

// → reasons the result does not meet `expect` (empty = pass).
function checkExpect(expect, got) {
  const reasons = [];
  if (expect.intents) {
    const list = expect.intents.some((p) => p?.do === "say") ? got.intents : got.intents.filter((i) => i.do !== "say");
    if (!matches(expect.intents, list)) reasons.push(`intents: want ${show(expect.intents)}, got ${show(list)}`);
  }
  if (expect.ops) {
    const want = expect.ops.flatMap(({ $n = 1, ...pattern }) => Array.from({ length: $n }, () => pattern));
    if (!assign(want, got.ops)) reasons.push(`ops: want ${show(want)}, got ${show(got.ops)}`);
    if (got.errors.length) reasons.push(`planner: ${got.errors.join("; ")}`);
  }
  if (expect.undo !== undefined && got.undo !== expect.undo) reasons.push(`undo: want ${expect.undo}, got ${got.undo}`);
  const said = [got.say, ...got.intents.filter((i) => i.do === "say").map((i) => i.text)].filter(Boolean).join(" ").trim();
  if (expect.say && !said) reasons.push("say: want a spoken reply, got none");
  return reasons;
}

// ---------- running ----------
function loadFixture(file = FIXTURE) {
  const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const item of fixture.cases) {
    if (item.scene && !fixture.scenes?.[item.scene]) throw new Error(`case ${item.id}: no scene "${item.scene}"`);
    if (!item.expect && !Array.isArray(item.anyOf)) throw new Error(`case ${item.id}: needs expect or anyOf`);
  }
  return fixture;
}

function sceneState(records) {
  const state = createState();
  for (const obj of records || []) applyOp(state, { t: "add", obj });
  return state;
}

// Deterministic planner randomness (deck shuffles).
function seeded(seed = 1) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// One case through the bridge's command path. → { id, text, pass, ms, reasons, got? }
async function runCase(model, item, fixture, catalog) {
  const player = fixture.player;
  const state = sceneState(fixture.scenes?.[item.scene]);
  // The same context the bridge builds for POST api/command.
  const held = [];
  const sceneNames = new Set();
  for (const record of Object.values(state.objects)) {
    if (record.part) sceneNames.add(String(record.part).toLowerCase());
    if (record.label) sceneNames.add(String(record.label).toLowerCase());
    if (record.attach?.user === player.user) held.push({ hand: record.attach.hand, label: record.label || record.part });
  }
  const started = Date.now();
  let result;
  try {
    result = await model.command({ text: item.text, ctx: { player }, held, scene: summarize(state, player), metas: catalog.metas, catalog: catalog.text, sceneNames, match: catalog.match });
  } catch (err) {
    return { id: item.id, text: item.text, pass: false, ms: Date.now() - started, reasons: [errorText(err)] };
  }
  let n = 0;
  const plan = planIntents(result.intents, { user: player.user, player, metas: catalog.metas, state, rng: seeded(), newId: (prefix) => `${prefix}eval${++n}`, now: () => 1700000000000 });
  const got = { intents: result.intents, say: result.say, ops: opViews(plan.ops, state, player), undo: plan.undo, errors: plan.errors };
  const alternatives = item.anyOf || [item.expect];
  const misses = [];
  for (const expect of alternatives) {
    let reasons;
    try {
      reasons = checkExpect(expect, got);
    } catch (err) {
      reasons = [`bad expectation: ${err.message}`];
    }
    if (!reasons.length) return { id: item.id, text: item.text, pass: true, ms: result.ms };
    misses.push(alternatives.length > 1 ? `option ${misses.length + 1}: ${reasons.join("; ")}` : reasons.join("; "));
  }
  return { id: item.id, text: item.text, pass: false, ms: result.ms, reasons: misses, got: { intents: describeIntents(result.intents), say: result.say, ops: got.ops, errors: got.errors } };
}

// Exact ratio: the rounded accuracy is only for reading.
const meets = (m, threshold) => m.total > 0 && m.passed / m.total >= threshold;

function stats(values) {
  if (!values.length) return { mean: 0, median: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const mid = sorted.length / 2;
  return {
    mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    median: Math.round(sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
  };
}

// name: a model to use, or null for the bridge's own pick. → per-model result.
async function evalModel(config, name, cases, fixture, catalog, timeoutMs) {
  const model = new LocalModel(name ? { ...config, model: name } : config, { log: quiet, timeoutMs, visionTimeoutMs: timeoutMs });
  await model.refresh(true);
  const base = { model: model.name || name, provider: model.provider, url: model.url, total: cases.length };
  if (!model.available) return { ...base, available: false, error: model.detail, passed: 0, accuracy: 0, latency: stats([]), slow: 0, failures: [], cases: [] };
  // One untimed command first, so loading the model into memory does not count as latency.
  const warm = Date.now();
  try {
    await model.command({ text: "spawn a crate", ctx: { player: fixture.player }, scene: [], metas: catalog.metas, catalog: catalog.text, match: catalog.match });
  } catch (err) {
    if (err.body?.error === "no-model") return { ...base, available: false, error: errorText(err), passed: 0, accuracy: 0, latency: stats([]), slow: 0, failures: [], cases: [] };
  }
  const warmupMs = Date.now() - warm;
  const results = [];
  for (const item of cases) results.push(await runCase(model, item, fixture, catalog));
  const passed = results.filter((r) => r.pass).length;
  return {
    ...base,
    model: model.name,
    available: true,
    warmupMs,
    passed,
    accuracy: Math.round((passed / cases.length) * 1000) / 1000,
    latency: stats(results.map((r) => r.ms)),
    slow: results.filter((r) => r.ms > BRIDGE_TIMEOUT_MS).length,
    failures: results.filter((r) => !r.pass).map(({ id, text, ms, reasons, got }) => ({ id, text, ms, reasons, ...(got ? { got } : {}) })),
    cases: results.map(({ id, pass, ms }) => ({ id, pass, ms })),
  };
}

// → the report object. models: names, or [] for the bridge's pick.
async function runEval({ dataArg, models = [], threshold = 0.8, limit = 0, timeoutMs = 60000, fixtureFile = FIXTURE } = {}) {
  const at = new Date();
  const { dataDir, inRepo } = dataDirOf(dataArg);
  if (inRepo) throw new Error(`the data folder ${dataDir} is inside the game repository; choose one outside it (--data)`);
  const { config } = loadConfig(dataDir, { log: quiet });
  const fixture = loadFixture(fixtureFile);
  const cases = limit > 0 ? fixture.cases.slice(0, limit) : fixture.cases;
  const metas = allMeta();
  const catalog = { metas, text: catalogText(metas), match: createMatcher(metas) };
  const results = [];
  for (const name of models.length ? models : [null]) results.push(await evalModel(config, name, cases, fixture, catalog, timeoutMs));
  const ranked = results.filter((r) => r.available).sort((a, b) => b.accuracy - a.accuracy || a.latency.median - b.latency.median);
  const below = results.filter((r) => !meets(r, threshold)).map((r) => r.model || "(none)");
  const ok = results.length > 0 && below.length === 0;
  const pct = `${Math.round(threshold * 100)}%`;
  const summary = !results.length ? "No model ran" : ok ? `Every model scored at least ${pct}` : `Below ${pct}: ${below.join(", ")}`;
  return { tool: "model-eval", version: 1, at: at.toISOString(), ok, summary, dataDir, inRepo, bridge: VERSION, threshold, cases: cases.length, recommended: ranked[0]?.model || null, models: results };
}

function markdown(report) {
  const lines = [
    "# Training Room model eval",
    "",
    `- When: ${report.at}`,
    `- Commands: ${report.cases}, threshold ${Math.round(report.threshold * 100)}%`,
    `- Result: **${report.ok ? "PASS" : "FAIL"}**. ${report.summary}.`,
    `- Recommended: ${report.recommended ? `\`${report.recommended}\`` : "none"}`,
    "",
    "| Model | Accuracy | Mean | Median | p95 | Over 25 s | Note |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const m of report.models) {
    lines.push(`| ${mdCell(m.model || "(none)")} | ${m.passed}/${m.total} (${Math.round(m.accuracy * 100)}%) | ${fmtMs(m.latency.mean)} | ${fmtMs(m.latency.median)} | ${fmtMs(m.latency.p95)} | ${m.slow} | ${mdCell(m.error || "")} |`);
  }
  for (const m of report.models.filter((x) => x.failures.length)) {
    lines.push("", `## Misses: ${m.model}`, "", "| Case | Command | Time | What went wrong |", "| --- | --- | --- | --- |");
    for (const f of m.failures) lines.push(`| ${f.id} | ${mdCell(f.text)} | ${fmtMs(f.ms)} | ${mdCell(f.reasons.join("; "))} |`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    ({ values: args } = parseArgs({
      args: argv,
      options: {
        data: { type: "string" }, model: { type: "string" }, threshold: { type: "string" }, json: { type: "boolean" },
        limit: { type: "string" }, timeout: { type: "string" }, help: { type: "boolean", short: "h" },
      },
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
  const threshold = args.threshold === undefined ? 0.8 : Number(args.threshold);
  const limit = args.limit === undefined ? 0 : Number(args.limit);
  const seconds = args.timeout === undefined ? 60 : Number(args.timeout);
  const problem = !(threshold >= 0 && threshold <= 1) ? "--threshold needs a number from 0 to 1"
    : !(Number.isInteger(limit) && limit >= 0) ? "--limit needs a whole number"
      : !(seconds > 0) ? "--timeout needs a number of seconds" : "";
  if (problem) {
    console.error(`${problem}\n${USAGE}`);
    return 2;
  }
  let report;
  try {
    report = await runEval({ dataArg: args.data, models: String(args.model || "").split(",").map((s) => s.trim()).filter(Boolean), threshold, limit, timeoutMs: seconds * 1000 });
  } catch (err) {
    console.error(`Model eval could not run: ${err.message}`);
    return 2;
  }
  const saved = await saveRun(report, "model-eval", markdown(report));
  if (args.json) {
    console.log(JSON.stringify({ ...report, files: saved.files }, null, 2));
    return report.ok ? 0 : 1;
  }
  const rows = report.models.map((m) => [
    m.model || "(none)", `${m.passed}/${m.total} (${Math.round(m.accuracy * 100)}%)`, fmtMs(m.latency.mean), fmtMs(m.latency.median), fmtMs(m.latency.p95), String(m.slow),
    meets(m, report.threshold) ? "PASS" : "FAIL", m.error || "",
  ]);
  const out = [
    `Training Room model eval · ${report.cases} commands · threshold ${Math.round(report.threshold * 100)}% · ${report.at}`,
    "",
    formatTable(["MODEL", "ACCURACY", "MEAN", "MEDIAN", "P95", ">25S", "RESULT", "NOTE"], rows),
  ];
  for (const m of report.models.filter((x) => x.failures.length)) {
    out.push("", `Misses for ${m.model}:`);
    for (const f of m.failures) out.push(`  ${f.id} "${f.text}" (${fmtMs(f.ms)}): ${f.reasons.join("; ")}`);
  }
  out.push(
    "",
    report.recommended ? `Recommended: ${report.recommended} (highest accuracy, then the fastest median).` : "Recommended: none (no model answered).",
    `RESULT: ${report.ok ? "PASS" : "FAIL"}. ${report.summary}.`,
    saved.files.length ? `Report: ${saved.files.join(" and ")}` : saved.note,
  );
  console.log(out.join("\n"));
  return report.ok ? 0 : 1;
}

if (isMain(import.meta.url)) main().then((code) => (process.exitCode = code));
