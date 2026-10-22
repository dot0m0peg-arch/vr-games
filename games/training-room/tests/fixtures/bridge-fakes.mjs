// Test doubles for the bridge: a fake Ollama (/api/tags, /api/version, /api/chat) that answers
// with canned JSON chosen by the spoken command, and a fake whisper.cpp server (/inference).
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

export async function startFakeOllama({ models = ["llama3.2:3b", "nomic-embed-text:latest", "qwen2.5-coder:7b"], slowMs = 4000 } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readAll(req);
    if (req.method === "GET" && req.url === "/api/tags") return json(res, 200, { models: models.map((name) => ({ name, model: name })) });
    if (req.method === "GET" && req.url === "/api/version") return json(res, 200, { version: "0.40.1" });
    if (req.method === "POST" && req.url === "/api/chat") {
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return json(res, 400, { error: "bad json" });
      }
      requests.push(parsed);
      const last = parsed.messages?.at(-1)?.content || "";
      const command = (last.match(/Command: "(.*)"$/m) || [])[1] || "";
      if (command.includes("slow")) {
        const timer = setTimeout(() => json(res, 200, { model: parsed.model, message: { role: "assistant", content: "{}" } }), slowMs);
        res.on("close", () => clearTimeout(timer));
        return;
      }
      const out = reply(command, parsed);
      if (out.status) return json(res, out.status, { error: out.error });
      return json(res, 200, { model: parsed.model, created_at: new Date().toISOString(), message: { role: "assistant", content: out.content }, done: true });
    }
    json(res, 404, { error: "not found" });
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}`, requests };
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

// OpenAI-compatible server (LM Studio style): /v1/models, /v1/chat/completions, /v1/audio/transcriptions.
export async function startFakeOpenAI() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readAll(req);
    if (req.method === "GET" && req.url === "/v1/models") return json(res, 200, { object: "list", data: [{ id: "text-embedding-nomic-embed-text-v1.5" }, { id: "qwen2.5-7b-instruct" }] });
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const parsed = JSON.parse(body.toString("utf8"));
      requests.push({ path: req.url, body: parsed });
      const content = JSON.stringify({ intents: [{ do: "spawn", what: { part: "katana" }, place: { rel: "hand", hand: "right" } }], say: "Katana." });
      return json(res, 200, { id: "x", object: "chat.completion", model: parsed.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
    }
    if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
      requests.push({ path: req.url, form: body.toString("latin1") });
      return json(res, 200, { text: "spawn a katana" });
    }
    json(res, 404, { error: { message: "not found" } });
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}`, requests };
}
