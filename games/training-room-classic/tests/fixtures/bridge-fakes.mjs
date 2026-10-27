// Test doubles for the bridge: a fake Ollama (/api/tags, /api/version, /api/show, /api/chat) that
// answers with canned JSON chosen by the spoken command or the drawing, a fake whisper.cpp server
// (/inference), an OpenAI-compatible server (LM Studio / Kokoro style) and a fake Piper voice server.
import http from "node:http";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

export function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const TINY_DRAGON = {
  name: "Dragon Statue", desc: "small dragon", holdable: false,
  parts: [
    { shape: "box", p: [0, 0.25, 0], s: [1.2, 0.5, 1], color: "#888888", mat: "stone" },
    { shape: "capsule", p: [0, 1, 0], s: [0.5, 1, 0.5], color: "#4a7a48", mat: "stone", r: [90, 0, 0] },
    { shape: "cone", p: [0, 1.5, 0.5], s: [0.2, 0.4, 0.2], color: "#4a7a48", mat: "stone", r: [40, 0, 0] },
  ],
};

const FISH = {
  name: "Fish", desc: "orange cartoon fish", holdable: false,
  parts: [
    { shape: "sphere", p: [0, 0.5, 0], s: [1.1, 0.6, 0.3], color: "#ff8c1a", mat: "matte" },
    { shape: "cone", p: [-0.7, 0.5, 0], s: [0.4, 0.5, 0.1], color: "#ff8c1a", mat: "matte", r: [0, 0, 90] },
    { shape: "sphere", p: [0.35, 0.6, 0.14], s: [0.08, 0.08, 0.04], color: "#111111", mat: "plastic" },
  ],
};

// A 1x1 PNG as a data URL (stands in for the drawing snapshot).
export const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// ASCII art of a round blob in asciiArt()'s format (# ink, . empty).
export const ASCII_CIRCLE = ["......####......", "...###....###...", "..#..........#..", ".#............#.", "..#..........#..", "...###....###...", "......####......"].join("\n");

// Ink rows widen toward the middle and narrow again: a round blob.
function looksRound(ascii) {
  const rows = ascii.split("\n").filter((l) => l.includes("#"));
  if (rows.length < 3) return false;
  const widths = rows.map((l) => l.lastIndexOf("#") - l.indexOf("#") + 1);
  const middle = Math.max(...widths.slice(1, -1));
  return middle > widths[0] && middle > widths[widths.length - 1];
}

// The text and image of the last user message (Ollama images or OpenAI content parts).
function lastUser(body) {
  const last = body.messages?.at(-1) || {};
  const text = typeof last.content === "string" ? last.content : (last.content || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const image = (Array.isArray(last.images) && last.images.length > 0) || (Array.isArray(last.content) && last.content.some((p) => p.type === "image_url"));
  return { text, image };
}

// Canned magic-marker answers: an image is "clearly a fish", round ASCII art is the catalog ball.
function interpretReply(body) {
  const { text, image } = lastUser(body);
  const words = (text.match(/^Player's words: "(.*)"$/m) || [])[1] || "";
  const ascii = (text.match(/```\n([\s\S]*?)\n```/) || [])[1] || "";
  const answer = (obj) => ({ content: JSON.stringify(obj) });
  if (words.includes("broken")) return { content: "What a lovely drawing! " + "wow ".repeat(200) };
  if (words.includes("number")) return { content: "7" };
  if (words.includes("fish") || image) return answer({ guess: "fish", confidence: 0.85, part: "", blueprint: FISH, behavior: "swim", say: "That's clearly a fish. Go on, little fish!" });
  if (ascii && looksRound(ascii)) return answer({ guess: "ball", confidence: 0.7, part: "Ball", behavior: "bounce", say: "A ball! Boing, boing." });
  return answer({ guess: "scribble", confidence: 0.2, part: "", behavior: "none", say: "Hmm, a scribble?" });
}

// Picks the canned model reply for a command.
function reply(command, body) {
  const text = command.toLowerCase();
  const answer = (obj) => JSON.stringify(obj);
  if (text.includes("broken")) return { content: "I cannot help with that, sorry. " + "blah ".repeat(200) };
  if (text.includes("shape number")) return { content: "42" };
  if (text.includes("nothink")) {
    if ("think" in body) return { status: 400, error: `"${body.model}" does not support thinking` };
    return { content: answer({ intents: [{ do: "spawn", what: { part: "crates" }, place: { rel: "front" } }], say: "A crate." }) };
  }
  if (text.includes("fenced")) return { content: "```json\n" + answer({ intents: [{ do: "spawn", what: { part: "axe" }, place: { rel: "hand" } }], say: "Axe." }) + "\n```" };
  if (text.includes("think")) return { content: "<think>They want it dark.</think>\n" + answer({ intents: [{ do: "time", value: "night" }], say: "Night." }) };
  if (text.includes("deck of cards")) {
    return {
      content: answer({
        intents: [
          { do: "spawn", what: { part: "card table" }, place: { rel: "front", dist: 1.5 } },
          { do: "spawn", what: { part: "deck of playing cards" }, place: { rel: "on", ref: { batch: 0 } } },
          { do: "spawn", what: { custom: TINY_DRAGON, label: "dragon statue" }, place: { rel: "front", dist: 6 } },
        ],
        say: "Table, cards and a dragon.",
      }),
    };
  }
  if (text.includes("villa")) return { content: answer({ intents: [{ do: "spawn", what: { part: "mansion" }, place: { rel: "left" } }], say: "A villa, on your left." }) };
  return { content: answer({ intents: [], say: "Not sure." }) };
}

// Capabilities /api/show reports: vision for llava/qwen2.5vl-style names unless caps overrides.
function capsOf(name, caps) {
  if (caps[name]) return caps[name];
  if (/embed/i.test(name)) return ["embedding"];
  return /llava|vl\b|vl:|vision/i.test(name) ? ["completion", "vision"] : ["completion"];
}

// show: false answers /api/show with 404 (a server that cannot report capabilities).
// refuseImages: models that answer 500 when a message carries images (a wrong name-based guess).
// answers(command, model) → the reply object for a command, or undefined for the canned replies above.
// delays: { model: ms } before each chat answer. version: what /api/version reports.
export async function startFakeOllama({ models = ["llama3.2:3b", "nomic-embed-text:latest", "qwen2.5-coder:7b"], slowMs = 4000, show = true, caps = {}, refuseImages = [], answers = null, delays = {}, version = "0.40.1" } = {}) {
  const requests = [];
  const shows = [];
  const server = http.createServer(async (req, res) => {
    const body = await readAll(req);
    if (req.method === "GET" && req.url === "/api/tags") return json(res, 200, { models: models.map((name) => ({ name, model: name })) });
    if (req.method === "GET" && req.url === "/api/version") return json(res, 200, { version });
    if (req.method === "POST" && req.url === "/api/show") {
      if (!show) return json(res, 404, "404 page not found");
      const name = JSON.parse(body.toString("utf8") || "{}").model;
      shows.push(name);
      if (!models.includes(name)) return json(res, 404, { error: `model '${name}' not found` });
      return json(res, 200, { details: { family: "llama" }, capabilities: capsOf(name, caps) });
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return json(res, 400, { error: "bad json" });
      }
      requests.push(parsed);
      if (!models.includes(parsed.model)) return json(res, 404, { error: `model "${parsed.model}" not found, try pulling it first` });
      const marker = !!parsed.format?.properties?.guess;
      const { text: last, image } = lastUser(parsed);
      if (image && refuseImages.includes(parsed.model)) return json(res, 500, { error: `${parsed.model} does not support images` });
      const command = marker ? (last.match(/^Player's words: "(.*)"$/m) || [])[1] || "" : (last.match(/Command: "(.*)"$/m) || [])[1] || "";
      if (delays[parsed.model]) await new Promise((resolve) => setTimeout(resolve, delays[parsed.model]));
      const canned = !marker && answers ? answers(command, parsed.model) : undefined;
      if (canned !== undefined) return json(res, 200, { model: parsed.model, message: { role: "assistant", content: JSON.stringify(canned) }, done: true });
      if (command.includes("slow")) {
        const timer = setTimeout(() => json(res, 200, { model: parsed.model, message: { role: "assistant", content: "{}" } }), slowMs);
        res.on("close", () => clearTimeout(timer));
        return;
      }
      if (marker) return json(res, 200, { model: parsed.model, message: { role: "assistant", content: interpretReply(parsed).content }, done: true });
      const out = reply(command, parsed);
      if (out.status) return json(res, out.status, { error: out.error });
      return json(res, 200, { model: parsed.model, created_at: new Date().toISOString(), message: { role: "assistant", content: out.content }, done: true });
    }
    json(res, 404, { error: "not found" });
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}`, requests, shows };
}

export async function startFakeWhisper() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readAll(req);
    if (req.method === "POST" && req.url === "/inference") {
      requests.push(body.toString("latin1"));
      return json(res, 200, { text: " [BLANK_AUDIO] AI, spawn a crate (wind blowing) " });
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>whisper.cpp server</html>");
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}`, requests };
}

// 16 kHz mono PCM16 WAV with a quiet tone.
export function makeWav(seconds = 0.5, rate = 16000) {
  const samples = Math.round(seconds * rate);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 2000), 44 + i * 2);
  return buffer;
}

// OpenAI-compatible server (LM Studio / Kokoro-FastAPI style): /v1/models, /v1/chat/completions,
// /v1/audio/transcriptions and /v1/audio/speech (answers with a short WAV).
export async function startFakeOpenAI({ models = ["text-embedding-nomic-embed-text-v1.5", "qwen2.5-7b-instruct"] } = {}) {
  const requests = [];
  const audio = makeWav(0.1, 24000);
  const server = http.createServer(async (req, res) => {
    const body = await readAll(req);
    if (req.method === "GET" && req.url === "/v1/models") return json(res, 200, { object: "list", data: models.map((id) => ({ id })) });
    if (req.method === "POST" && req.url === "/v1/audio/speech") {
      requests.push({ path: req.url, body: JSON.parse(body.toString("utf8")) });
      res.writeHead(200, { "content-type": "audio/wav" });
      return res.end(audio);
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const parsed = JSON.parse(body.toString("utf8"));
      requests.push({ path: req.url, body: parsed });
      const content = parsed.response_format?.json_schema?.name === "interpret"
        ? interpretReply(parsed).content
        : JSON.stringify({ intents: [{ do: "spawn", what: { part: "katana" }, place: { rel: "hand", hand: "right" } }], say: "Katana." });
      return json(res, 200, { id: "x", object: "chat.completion", model: parsed.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    }
    if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
      requests.push({ path: req.url, form: body.toString("latin1") });
      return json(res, 200, { text: "spawn a katana" });
    }
    json(res, 404, { error: { message: "not found" } });
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}`, requests, audio };
}

// piper1-gpl HTTP server: POST / with JSON { text } → WAV; GET → 405 like Flask. legacy: only
// POST /synthesize answers (/ is 404). Texts with "slow" take slowMs; every request takes delayMs.
// state.maxActive tells whether requests ever overlapped.
export async function startFakePiper({ legacy = false, delayMs = 0, slowMs = 3000 } = {}) {
  const requests = [];
  const state = { active: 0, maxActive: 0 };
  const audio = makeWav(0.1, 22050);
  const server = http.createServer(async (req, res) => {
    const body = await readAll(req);
    const route = req.url.split("?")[0];
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "text/html" });
      return res.end("<h1>Method Not Allowed</h1>");
    }
    if (route !== (legacy ? "/synthesize" : "/")) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<h1>Not Found</h1>");
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return json(res, 400, { error: "expected JSON" });
    }
    requests.push({ path: route, body: parsed, type: req.headers["content-type"] });
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    const timer = setTimeout(() => {
      state.active--;
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(audio);
    }, String(parsed.text).includes("slow") ? slowMs : delayMs);
    res.on("close", () => {
      if (res.writableEnded) return;
      clearTimeout(timer);
      state.active--;
    });
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}`, requests, audio, state };
}

// Model replies to the commands in model-eval.json, keyed by command text: a careful model answers
// EVAL_ANSWERS; a sloppy one answers EVAL_WRONG where it has an entry (8 of 33 wrong).
const spawn = (part, place, extra = {}) => ({ do: "spawn", what: { part }, ...(place ? { place } : {}), ...extra });
const one = (intent, say = "Done.") => ({ intents: [intent], say });
export const EVAL_ANSWERS = {
  "AI, spawn a villa to my left": one(spawn("villa", { rel: "left" }), "A villa, on your left."),
  "AI, spawn an axe in my hand": one(spawn("axe", { rel: "hand" }), "Axe in your hand."),
  "AI, spawn a deck of playing cards on a card table": { intents: [spawn("card table", { rel: "front", dist: 1.5 }), spawn("deck of cards", { rel: "on", ref: { batch: 0 } })], say: "Cards on a card table." },
  "spawn three crates in front of me": one(spawn("crate", { rel: "front" }, { count: 3 })),
  "AI, summon two training dummies behind me": one(spawn("training dummy", { rel: "behind" }, { count: 2 })),
  "give me a red sword in my left hand": one(spawn("sword", { rel: "hand", hand: "left" }, { color: "red" })),
  "spawn a blue ball in front of me": one(spawn("ball", { rel: "front" }, { color: "blue" })),
  "put a dagger in my right hand": one(spawn("dagger", { rel: "hand", hand: "right" })),
  "spawn a tree 20 meters in front of me": one(spawn("tree", { rel: "front", dist: 20 })),
  "put a monitor on the desk": one(spawn("monitor", { rel: "on", ref: { part: "desk" } })),
  "spawn a lamp post next to the villa": one(spawn("lamp post", { rel: "next", ref: { part: "villa" } })),
  "spawn a crate next to the barrel": one(spawn("crate", { rel: "next", ref: { part: "barrel" } })),
  "remove the crate on my left": one({ do: "remove", target: { id: "o-crate-l" } }),
  "get rid of all the crates": one({ do: "remove", target: { part: "crate", which: "all" } }),
  "move the training dummy behind me": one({ do: "move", target: { part: "training dummy" }, place: { rel: "behind" } }),
  "bring the barrel here": one({ do: "move", target: { part: "barrel" }, place: { rel: "here" } }),
  "make the tree twice as big": one({ do: "scale", target: { part: "tree" }, factor: 2 }),
  "paint the crate on my right green": one({ do: "color", target: { id: "o-crate-r" }, color: "green" }),
  "hold the sword in my left hand": one({ do: "hold", target: { part: "sword" }, hand: "left" }),
  "drop the axe": one({ do: "drop", hand: "right" }),
  "write Q3 goals on the whiteboard": one({ do: "write", target: { part: "whiteboard" }, text: "Q3 goals" }),
  "note: call the supplier": one({ do: "write", text: "call the supplier" }),
  "deal five cards": one({ do: "deal", count: 5 }),
  "undo": one({ do: "undo" }),
  "undo the last two things": one({ do: "undo", count: 2 }),
  "make it night": one({ do: "time", value: "night" }),
  "AI, change the time to sunset": one({ do: "time", value: "sunset" }),
  "spawn a dragon statue": one({ do: "spawn", what: { custom: TINY_DRAGON, label: "dragon statue" }, place: { rel: "front", dist: 6 } }),
  "AI, make it real": one({ do: "realize" }),
  "no, it's a gun": one({ do: "correct", label: "gun" }),
  "make it fly": one({ do: "animate", target: { ref: "it" }, behavior: "fly" }),
  "what is this?": one({ do: "guess" }),
  "what should we name our new product?": { intents: [], say: "How about Meadow?" },
};
export const EVAL_WRONG = {
  "AI, spawn a villa to my left": one(spawn("villa", { rel: "right" })),
  "spawn three crates in front of me": one(spawn("crate", { rel: "front" }, { count: 2 })),
  "spawn a blue ball in front of me": one(spawn("ball", { rel: "front" }, { color: "red" })),
  "remove the crate on my left": one({ do: "remove", target: { id: "o-crate-r" } }),
  "make the tree twice as big": one({ do: "scale", target: { part: "tree" }, factor: 0.5 }),
  "make it night": one({ do: "time", value: "day" }),
  "spawn a dragon statue": one(spawn("statue", { rel: "front" })),
  "no, it's a gun": one({ do: "realize", hint: "gun" }),
};
