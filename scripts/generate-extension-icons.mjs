/**
 * Generates extension toolbar icons matching the platform favicon
 * (green shield on dark navy - public/favicon.svg).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "extension", "icons");

const BG = [0x1a, 0x23, 0x32, 0xff];
const GREEN = [0x4a, 0xde, 0x80, 0xff];
const CLEAR = [0, 0, 0, 0];

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Point-in-polygon (ray cast) for the favicon shield silhouette. */
function inShield(nx, ny) {
  // Normalized coords in 0..32 space matching favicon.svg viewBox
  const pts = [
    [16, 6],
    [8, 10],
    [8, 16],
    [10, 21.5],
    [16, 27],
    [22, 21.5],
    [24, 16],
    [24, 10],
  ];
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > ny !== yj > ny && nx < ((xj - xi) * (ny - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function nearShieldEdge(nx, ny, strokeW) {
  const edges = [
    [16, 6, 8, 10],
    [8, 10, 8, 16],
    [8, 16, 10, 21.5],
    [10, 21.5, 16, 27],
    [16, 27, 22, 21.5],
    [22, 21.5, 24, 16],
    [24, 16, 24, 10],
    [24, 10, 16, 6],
  ];
  const half = strokeW / 2;
  for (const [ax, ay, bx, by] of edges) {
    if (distToSegment(nx, ny, ax, ay, bx, by) <= half) return true;
  }
  return false;
}

function inRoundedRect(x, y, size, radius) {
  const r = radius;
  if (x >= r && x < size - r && y >= 0 && y < size) return true;
  if (y >= r && y < size - r && x >= 0 && x < size) return true;
  const corners = [
    [r, r],
    [size - r - 1, r],
    [r, size - r - 1],
    [size - r - 1, size - r - 1],
  ];
  for (const [cx, cy] of corners) {
    if (Math.hypot(x - cx, y - cy) <= r) return true;
  }
  return false;
}

function makePng(size) {
  const row = 1 + size * 4;
  const raw = Buffer.alloc(row * size);
  const strokeW = size >= 48 ? 2.2 : size >= 32 ? 2.4 : 3.2;
  const dotR = size >= 48 ? 3 : size >= 32 ? 3.2 : 4;

  for (let y = 0; y < size; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * row + 1 + x * 4;
      const nx = (x + 0.5) * (32 / size);
      const ny = (y + 0.5) * (32 / size);
      const inBg = inRoundedRect(x, y, size, Math.max(2, Math.round(size * 0.25)));

      let rgba = CLEAR;
      if (inBg) {
        rgba = BG;
        const onStroke = nearShieldEdge(nx, ny, strokeW);
        const inDot = Math.hypot(nx - 16, ny - 15) <= dotR;
        // Hollow shield: fill only stroke + center dot (match favicon)
        if (onStroke || inDot) {
          rgba = GREEN;
        } else if (inShield(nx, ny) && size <= 16) {
          // At 16px, thicken silhouette slightly for legibility
          rgba = GREEN;
        }
      }

      raw[i] = rgba[0];
      raw[i + 1] = rgba[1];
      raw[i + 2] = rgba[2];
      raw[i + 3] = rgba[3];
    }
  }

  const compressed = zlib.deflateSync(raw, {
    level: 6,
    windowBits: 15,
    memLevel: 8,
    strategy: zlib.constants.Z_DEFAULT_STRATEGY,
  });
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), makePng(size));
}
console.log("Generated platform-matched extension icons in extension/icons/");
