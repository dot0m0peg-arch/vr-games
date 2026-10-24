// Model eval (bridge/eval-model.mjs): the pattern matcher, the canonical command fixture, and the CLI
// as the owner's pipeline runs it (exit code = verdict) against a fake Ollama with a careful and a
// sloppy model.
// Run: node --test games/training-room/tests/eval-model.test.mjs
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { matches } from "../bridge/eval-model.mjs";
import { validateRecord } from "../js/core/room-state.js";
import { startFakeOllama, closeServer, EVAL_ANSWERS, EVAL_WRONG } from "./fixtures/bridge-fakes.mjs";

const EVAL = fileURLToPath(new URL("../bridge/eval-model.mjs", import.meta.url));
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/model-eval.json", import.meta.url), "utf8"));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tr-eval-test-"));
const TOTAL = fixture.cases.length;

function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [EVAL, ...args], { env: { ...process.env, TRAINING_ROOM_DATA: "" }, timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

describe("eval matcher", () => {
  it("strings ignore case; numbers, booleans and null are exact; missing is not null", () => {
    assert.ok(matches("Villa", "villa "));
    assert.ok(!matches("villa", "villas"));
    assert.ok(!matches("2", 2));
    assert.ok(matches(2, 2) && !matches(2, 2.01));
    assert.ok(matches(true, true) && !matches(true, 1));
    assert.ok(matches(null, null) && !matches(null, undefined));
  });

  it("operators: $re, $in, $gte/$lte, $exists", () => {
    assert.ok(matches({ $re: "^(a )?gun$" }, "A gun"));
    assert.ok(!matches({ $re: "^(a )?gun$" }, "shotgun"));
    assert.ok(!matches({ $re: "x" }, null));
    assert.ok(matches({ $in: ["left", "right"] }, "Right"));
    assert.ok(!matches({ $in: ["left", "right"] }, "front"));
    assert.ok(matches({ $gte: 15, $lte: 25 }, 20) && !matches({ $gte: 15, $lte: 25 }, 26) && !matches({ $gte: 1 }, "5"));
    assert.ok(matches({ a: { $exists: false } }, {}) && !matches({ a: { $exists: false } }, { a: 0 }));
    assert.throws(() => matches({ $near: 1 }, 1), /unknown pattern operator \$near/);
  });

  it("objects match the keys they list; arrays need the same length and order", () => {
    assert.ok(matches({ t: "add", part: "crate" }, { t: "add", part: "crate", side: "front" }));
    assert.ok(!matches({ t: "add" }, null));
    assert.ok(!matches({ t: "add" }, [{ t: "add" }]));
    assert.ok(matches([{ do: "realize" }], [{ do: "realize", hint: "x" }]));
    assert.ok(!matches([{ do: "realize" }], [{ do: "realize" }, { do: "say" }]));
    assert.ok(!matches([{ do: "a" }, { do: "b" }], [{ do: "b" }, { do: "a" }]));
    assert.ok(matches([], []));
  });
});

describe("eval fixture", () => {
  it("has about 30 cases with unique ids, the owner's three examples and valid scenes", () => {
    assert.ok(TOTAL >= 28 && TOTAL <= 40, `${TOTAL} cases`);
    const ids = fixture.cases.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, "unique ids");
    const texts = fixture.cases.map((c) => c.text);
    for (const text of ["AI, spawn a villa to my left", "AI, spawn an axe in my hand", "AI, spawn a deck of playing cards on a card table", "spawn a dragon statue", "AI, make it real", "no, it's a gun", "make it fly"]) {
      assert.ok(texts.includes(text), text);
    }
    for (const [name, records] of Object.entries(fixture.scenes)) {
      for (const record of records) assert.ok(validateRecord(record).ok, `${name}/${record.id}: ${validateRecord(record).error}`);
    }
    for (const item of fixture.cases) {
      assert.ok(!item.scene || fixture.scenes[item.scene], `${item.id} scene`);
      assert.ok(item.expect || item.anyOf, `${item.id} expectation`);
      assert.ok(EVAL_ANSWERS[item.text], `${item.id} has a canned answer in the fake`);
    }
    assert.deepEqual(fixture.player, { user: "u-eval", p: [0, 1.6, 0], yaw: 0, hands: { left: null, right: null } });
  });
});

describe("eval CLI", () => {
  let ollama;
  let dir;
  const reports = () => (fs.existsSync(path.join(dir, "reports")) ? fs.readdirSync(path.join(dir, "reports")).filter((n) => n.startsWith("model-eval-")) : []);

  before(async () => {
    ollama = await startFakeOllama({
      models: ["careful:7b", "sloppy:3b", "slowpoke:7b", "nomic-embed-text:latest"],
      answers: (command, model) => (model === "sloppy:3b" && EVAL_WRONG[command]) || EVAL_ANSWERS[command],
      delays: { "slowpoke:7b": 25 },
    });
    dir = path.join(tmpRoot, "data");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ollamaUrl: ollama.url, model: "careful:7b", sttKind: "none" }));
  });

  after(async () => {
    await closeServer(ollama?.server);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("the bridge's model answering every command right passes, with a saved report", async () => {
    const before = reports().length;
    const res = await run(["--data", dir]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, new RegExp(`careful:7b +${TOTAL}/${TOTAL} \\(100%\\) .* PASS`));
    assert.match(res.stdout, /^Recommended: careful:7b /m);
    assert.match(res.stdout, /^RESULT: PASS\. Every model scored at least 80%\.$/m);
    assert.equal(reports().length, before + 2, "JSON and Markdown");
    const json = reports().filter((n) => n.endsWith(".json")).sort().at(-1);
    const report = JSON.parse(fs.readFileSync(path.join(dir, "reports", json), "utf8"));
    assert.equal(report.ok, true);
    assert.equal(report.models[0].cases.length, TOTAL);
    for (const key of ["mean", "median", "p95", "max"]) assert.ok(Number.isFinite(report.models[0].latency[key]), key);
    // Commands reached the model with the scene the fixture describes.
    const remove = ollama.requests.find((r) => r.messages.at(-1).content.includes('Command: "remove the crate on my left"'));
    assert.match(remove.messages.at(-1).content, /Scene: .*crate id o-crate-l 4\.2 m front-left; crate id o-crate-r 4\.2 m front-right/);
    // What the catalog lacks was designed by its own call, like in the game.
    const design = ollama.requests.find((r) => r.messages.at(-1).content.startsWith('Design: "dragon statue"'));
    assert.ok(design, "the dragon statue was designed");
    assert.match(design.messages.at(-1).content, /The player said: "spawn a dragon statue"/);
    const drop = ollama.requests.find((r) => r.messages.at(-1).content.includes('Command: "drop the axe"'));
    assert.match(drop.messages.at(-1).content, /right hand: axe/);
  });

  it("scores a sloppy model, lists its misses with what came back, and fails below the threshold", async () => {
    const res = await run(["--data", dir, "--model", "careful:7b,sloppy:3b", "--json"]);
    assert.equal(res.code, 1);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.summary, "Below 80%: sloppy:3b");
    assert.equal(report.recommended, "careful:7b");
    const sloppy = report.models.find((m) => m.model === "sloppy:3b");
    const wrong = Object.keys(EVAL_WRONG).length;
    assert.equal(sloppy.passed, TOTAL - wrong);
    assert.equal(sloppy.accuracy, Math.round(((TOTAL - wrong) / TOTAL) * 1000) / 1000);
    assert.deepEqual(sloppy.failures.map((f) => f.text).sort(), Object.keys(EVAL_WRONG).sort());
    const villa = sloppy.failures.find((f) => f.id === "owner-villa");
    assert.match(villa.reasons[0], /^ops: want \[\{"t":"add","part":"villa","side":"left"\}\], got \[\{"t":"add","part":"villa".*"side":"right"/);
    assert.equal(villa.got.intents, "spawn villa right");
    const gun = sloppy.failures.find((f) => f.id === "marker-gun");
    assert.match(gun.reasons[0], /intents: want .*"correct".*got \[\{"do":"realize","hint":"gun"\}\]/);
    assert.equal(report.files.length, 2);
  });

  it("a lower threshold passes both; --limit runs the first n commands", async () => {
    const both = await run(["--data", dir, "--model", "careful:7b,sloppy:3b", "--threshold", "0.7"]);
    assert.equal(both.code, 0, both.stdout);
    assert.match(both.stdout, /sloppy:3b +\d+\/\d+ \(\d+%\) .* PASS/);
    const few = await run(["--data", dir, "--model", "sloppy:3b", "--limit", "3", "--json"]);
    const report = JSON.parse(few.stdout);
    assert.equal(report.cases, 3);
    assert.equal(report.models[0].passed, 2, "owner-villa is one of the sloppy answers");
    assert.equal(few.code, 1, "2/3 is below 80%");
  });

  it("equal accuracy: the faster median is recommended; a missing model scores 0", async () => {
    const res = await run(["--data", dir, "--model", "slowpoke:7b,careful:7b,ghost:1b", "--limit", "4", "--json"]);
    assert.equal(res.code, 1);
    const report = JSON.parse(res.stdout);
    assert.equal(report.recommended, "careful:7b");
    const ghost = report.models.find((m) => m.model === "ghost:1b");
    assert.equal(ghost.available, false);
    assert.equal(ghost.accuracy, 0);
    assert.match(ghost.error, /model "ghost:1b" is not installed \(ollama pull ghost:1b\)/);
    assert.equal(report.summary, "Below 80%: ghost:1b");
  });

  it("an unreachable model server fails; bad options exit with 2", async () => {
    const down = path.join(tmpRoot, "down");
    fs.mkdirSync(down, { recursive: true });
    fs.writeFileSync(path.join(down, "config.json"), JSON.stringify({ ollamaUrl: "http://127.0.0.1:9" }));
    const res = await run(["--data", down]);
    assert.equal(res.code, 1);
    assert.match(res.stdout, /Ollama not reachable at http:\/\/127\.0\.0\.1:9/);
    assert.match(res.stdout, /^Recommended: none/m);
    assert.equal((await run(["--threshold", "80"])).code, 2);
    assert.equal((await run(["--limit", "-1"])).code, 2);
    assert.equal((await run(["--models", "x"])).code, 2);
  });
});
