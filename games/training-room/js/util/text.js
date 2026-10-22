// Canvas text rendering for in-world labels, notes, whiteboards, cards and VR panels.
// Returns null outside a browser so geometry code stays testable in Node.
import * as THREE from "../../vendor/three.module.min.js";

export const FONT = "Arial, Helvetica, sans-serif";

export function hasCanvas() {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

export function makeCanvas(width, height) {
  if (!hasCanvas()) return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// Word-wraps text into at most maxLines lines that fit maxWidth pixels.
export function wrapLines(ctx, text, maxWidth, maxLines = 20) {
  const lines = [];
  for (const paragraph of String(text ?? "").split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/.?$/, "…");
    return kept;
  }
  return lines;
}

// Draws text into a canvas (new or reused). Options:
// width, height (px), text, size (font px), weight, color, bg (null = transparent),
// padding, align ("left"|"center"), valign ("top"|"middle"), lineHeight (multiplier), maxLines, radius, border.
export function drawText(options = {}, canvas = null) {
  const o = {
    width: 512, height: 256, text: "", size: 40, weight: "400", color: "#eef1e9", bg: "#101412",
    padding: 24, align: "left", valign: "top", lineHeight: 1.25, maxLines: 20, radius: 0, border: null,
    font: FONT, ...options,
  };
  canvas = canvas || makeCanvas(o.width, o.height);
  if (!canvas) return null;
  if (canvas.width !== o.width) canvas.width = o.width;
  if (canvas.height !== o.height) canvas.height = o.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, o.width, o.height);
  if (o.bg) {
    ctx.fillStyle = o.bg;
    roundRect(ctx, 0, 0, o.width, o.height, o.radius);
    ctx.fill();
  }
  if (o.border) {
    ctx.strokeStyle = o.border;
    ctx.lineWidth = 4;
    roundRect(ctx, 2, 2, o.width - 4, o.height - 4, Math.max(0, o.radius - 2));
    ctx.stroke();
  }
  ctx.fillStyle = o.color;
  ctx.font = `${o.weight} ${o.size}px ${o.font}`;
  ctx.textBaseline = "top";
  ctx.textAlign = o.align === "center" ? "center" : "left";
  const lines = wrapLines(ctx, o.text, o.width - o.padding * 2, o.maxLines);
  const lh = o.size * o.lineHeight;
  let y = o.padding;
  if (o.valign === "middle") y = Math.max(o.padding, (o.height - lines.length * lh) / 2);
  const x = o.align === "center" ? o.width / 2 : o.padding;
  for (const line of lines) {
    if (y + o.size > o.height - o.padding / 2) break;
    ctx.fillText(line, x, y);
    y += lh;
  }
  return canvas;
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (!r) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function canvasTexture(canvas) {
  if (!canvas) return null;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// One-shot helper: text options -> CanvasTexture (or null in Node).
export function textTexture(options) {
  return canvasTexture(drawText(options));
}

// Redraws an existing texture's canvas with new options and flags it for upload.
export function updateTextTexture(texture, options) {
  if (!texture?.image) return;
  drawText(options, texture.image);
  texture.needsUpdate = true;
}
