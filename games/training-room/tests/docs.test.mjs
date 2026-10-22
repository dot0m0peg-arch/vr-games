// Setup docs stay in step with the bridge: every setting explained, only real keys named,
// voice setup commands complete.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DEFAULTS } from "../bridge/config.mjs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const example = JSON.parse(read("../bridge/config.example.json"));
const readme = read("../README.md");

test("config.example.json lists and explains every setting", () => {
  for (const key of Object.keys(DEFAULTS)) {
    assert.ok(key in example, `${key} missing from config.example.json`);
    assert.match(example._help, new RegExp(`\\b${key}\\b`), `${key} not explained in _help`);
  }
});

test("config keys quoted in the README exist", () => {
  const quoted = [...readme.matchAll(/`"(\w+)":/g)].map((m) => m[1]);
  assert.ok(quoted.length > 0);
  for (const key of quoted) assert.ok(key in DEFAULTS, `README names unknown setting "${key}"`);
});

test("README voice setup includes the model and voice downloads", () => {
  assert.match(readme, /ggml-base\.en\.bin/);
  assert.match(readme, /huggingface\.co\/ggerganov\/whisper\.cpp/);
  const install = readme.indexOf('pip install "piper-tts[http]"');
  const download = readme.indexOf("piper.download_voices en_US-lessac-medium");
  const serve = readme.indexOf("piper.http_server -m en_US-lessac-medium");
  assert.ok(install >= 0 && install < download && download < serve, "install, download, then serve");
});
