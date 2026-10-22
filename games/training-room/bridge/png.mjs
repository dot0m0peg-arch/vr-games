// Tiny PNG encoder (Node built-ins only): 8-bit RGBA, no interlace, one zlib stream. The doctor uses
// it to draw a test sketch for the vision model.
import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// rgba: width * height * 4 bytes, rows top to bottom. → PNG file bytes.
export function encodePNG(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError("width and height must be positive integers");
  if (!rgba || rgba.length !== width * height * 4) throw new RangeError("rgba must hold width * height * 4 bytes");
  const pixels = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  const row = width * 4;
  const raw = Buffer.alloc((row + 1) * height); // each row starts with filter type 0 (none)
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  const header = Buffer.alloc(13); // compression, filter and interlace methods stay 0
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
