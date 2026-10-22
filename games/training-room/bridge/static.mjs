// Serves the repository under /vr-games/ the way GitHub Pages does, for the LAN bridge.
// Refuses dot-segments, the training-room bridge/ and tests/ folders, traversal and symlink escapes.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREFIX = "/vr-games/";
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// Relative to the repository root, lowercase, "/" separated.
const BLOCKED = ["games/training-room/bridge", "games/training-room/tests"];

export const MIME = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ktx2: "image/ktx2",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  bin: "application/octet-stream",
  wasm: "application/wasm",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  webmanifest: "application/manifest+json",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  xml: "application/xml",
};

// html/js/css/json change while developing; binary assets may be cached for an hour.
const NO_CACHE = new Set(["html", "htm", "js", "mjs", "css", "json", "map", "webmanifest", "md", "txt"]);

export function mimeOf(file) {
  return MIME[path.extname(file).slice(1).toLowerCase()] || "application/octet-stream";
}

function cacheControlOf(file) {
  return NO_CACHE.has(path.extname(file).slice(1).toLowerCase()) ? "no-cache" : "public, max-age=3600";
}

// Decodes and checks each URL path segment. Returns the segment list or null when unsafe.
export function safeSegments(rawPath) {
  const out = [];
  for (const raw of rawPath.split("/")) {
    if (raw === "") continue;
    let seg;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // Dot-files/dirs, "..", encoded separators, NUL, Windows drive/stream colons and trailing dots/spaces.
    if (seg.startsWith(".") || /[\\/\0:]/.test(seg) || /[. ]$/.test(seg)) return null;
    out.push(seg);
  }
  return out;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isBlocked(rel) {
  const lower = rel.split(path.sep).join("/").toLowerCase();
  if (lower.split("/").some((seg) => seg.startsWith("."))) return true;
  return BLOCKED.some((dir) => lower === dir || lower.startsWith(dir + "/"));
}

export function createStatic({ root = REPO_ROOT } = {}) {
  const absRoot = path.resolve(root);
  let realRoot = null;
  let notFoundBody = null;

  async function getRealRoot() {
    if (!realRoot) realRoot = await fsp.realpath(absRoot);
    return realRoot;
  }

  async function notFound(req, res) {
    if (notFoundBody === null) {
      try {
        notFoundBody = await fsp.readFile(path.join(absRoot, "404.html"));
      } catch {
        notFoundBody = Buffer.from("<!doctype html><title>Not found</title><h1>404</h1>");
      }
    }
    res.writeHead(404, { "content-type": MIME.html, "cache-control": "no-cache", "content-length": notFoundBody.length });
    res.end(req.method === "HEAD" ? undefined : notFoundBody);
  }

  // Resolves a URL path (after /vr-games/) to { file, stat } or { redirect } or null.
  async function resolve(rawRest, endsWithSlash) {
    const segments = safeSegments(rawRest);
    if (!segments) return null;
    const target = path.resolve(absRoot, ...segments);
    if (!isInside(absRoot, target)) return null;
    let real;
    try {
      real = await fsp.realpath(target);
    } catch {
      return null;
    }
    const base = await getRealRoot();
    if (!isInside(base, real) || isBlocked(path.relative(base, real))) return null;
    let stat = await fsp.stat(real);
    let file = real;
    if (stat.isDirectory()) {
      if (!endsWithSlash && segments.length) return { redirect: true };
      file = path.join(real, "index.html");
      try {
        stat = await fsp.stat(file);
      } catch {
        return null;
      }
    }
    if (!stat.isFile()) return null;
    return { file, stat };
  }

  // Handles GET/HEAD for any path. Returns true when a response was sent.
  async function serve(req, res, rawPath, search = "") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain" });
      res.end("Method not allowed");
      return true;
    }
    if (rawPath === "/vr-games") {
      res.writeHead(301, { location: PREFIX + search });
      res.end();
      return true;
    }
    if (!rawPath.startsWith(PREFIX)) {
      await notFound(req, res);
      return true;
    }
    const rest = rawPath.slice(PREFIX.length);
    const found = await resolve(rest, rawPath.endsWith("/")).catch(() => null);
    if (!found) {
      await notFound(req, res);
      return true;
    }
    if (found.redirect) {
      res.writeHead(301, { location: rawPath + "/" + search });
      res.end();
      return true;
    }
    const { file, stat } = found;
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const lastModified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString();
    const headers = {
      "content-type": mimeOf(file),
      "cache-control": cacheControlOf(file),
      etag,
      "last-modified": lastModified,
      "x-content-type-options": "nosniff",
    };
    const inm = req.headers["if-none-match"];
    const ims = req.headers["if-modified-since"];
    const fresh = inm
      ? inm.split(",").some((tag) => tag.trim() === etag || tag.trim() === "*")
      : ims && Date.parse(ims) >= Date.parse(lastModified);
    if (fresh) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    headers["content-length"] = stat.size;
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    await new Promise((done) => {
      const stream = fs.createReadStream(file);
      stream.on("error", () => {
        res.destroy();
        done();
      });
      stream.on("end", done);
      res.on("close", () => {
        stream.destroy();
        done();
      });
      stream.pipe(res);
    });
    return true;
  }

  return { serve, notFound, root: absRoot };
}
