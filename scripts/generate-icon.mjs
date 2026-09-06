#!/usr/bin/env node
/**
 * Generates build/icon.ico — the Windows application, installer, shortcut and
 * taskbar icon.
 *
 * Drawn from code (no binary asset checked in without provenance) to match the
 * in-app wordmark sigil: a lime reticle on the product's near-black ground.
 * The .ico it writes IS committed so CI never depends on regenerating it.
 *
 * Output contains 16/24/32/48/64/128 px uncompressed BGRA entries (maximum
 * Explorer compatibility) plus a 256 px PNG-compressed entry (required by
 * electron-builder and used for large icon views).
 *
 * Usage: node scripts/generate-icon.mjs [--out build/icon.ico]
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const BG = [0x0d, 0x10, 0x15]; // app background
const FG = [0xc8, 0xf2, 0x4e]; // Aldo lime
const SUPERSAMPLE = 4;

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

/** Coverage of the rounded-square background at a supersampled point. */
function backgroundCoverage(x, y, size) {
  const radius = size * 0.22;
  const inset = size * 0.02;
  const min = inset;
  const max = size - inset;
  if (x < min || x > max || y < min || y > max) return 0;
  // Distance outside the inner rectangle whose corners the radius rounds off.
  const dx = Math.max(min + radius - x, 0, x - (max - radius));
  const dy = Math.max(min + radius - y, 0, y - (max - radius));
  return dx * dx + dy * dy <= radius * radius ? 1 : 0;
}

/** Coverage of the reticle mark at a supersampled point. */
function markCoverage(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const stroke = Math.max(size * 0.062, 1.1);

  // Outer ring.
  const ringRadius = size * 0.27;
  if (Math.abs(dist - ringRadius) <= stroke / 2) return 1;

  // Centre dot.
  if (dist <= size * 0.072) return 1;

  // Four ticks reaching from just outside the ring toward the border.
  const inner = size * 0.34;
  const outer = size * 0.44;
  const half = stroke / 2;
  if (Math.abs(dx) <= half && Math.abs(dy) >= inner && Math.abs(dy) <= outer) return 1;
  if (Math.abs(dy) <= half && Math.abs(dx) >= inner && Math.abs(dx) <= outer) return 1;

  return 0;
}

/** Renders one square RGBA bitmap (top-down, 4 bytes per pixel). */
function renderRgba(size) {
  const out = Buffer.alloc(size * size * 4);
  const step = 1 / SUPERSAMPLE;
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let mark = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          bg += backgroundCoverage(px, py, size);
          mark += markCoverage(px, py, size);
        }
      }
      bg /= samples;
      mark /= samples;
      const markAlpha = Math.min(mark, bg); // the mark never spills past the tile
      const alpha = Math.round(bg * 255);
      const r = Math.round(BG[0] * (1 - markAlpha) + FG[0] * markAlpha);
      const g = Math.round(BG[1] * (1 - markAlpha) + FG[1] * markAlpha);
      const b = Math.round(BG[2] * (1 - markAlpha) + FG[2] * markAlpha);
      const off = (y * size + x) * 4;
      out[off] = r;
      out[off + 1] = g;
      out[off + 2] = b;
      out[off + 3] = alpha;
    }
  }
  return out;
}

// ---- PNG encoder (only what an RGBA icon needs) -----------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Classic uncompressed ICO entry: BITMAPINFOHEADER + bottom-up BGRA + AND mask. */
function encodeBmpEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR image + AND mask
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bits per pixel
  header.writeUInt32LE(0, 16); // BI_RGB
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const xor = Buffer.alloc(size * size * 4);
  const and = Buffer.alloc(maskRowBytes * size); // all zero: alpha carries shape
  header.writeUInt32LE(xor.length + and.length, 20);
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y; // BMP rows run bottom-up
    for (let x = 0; x < size; x++) {
      const src = (srcRow * size + x) * 4;
      const dst = (y * size + x) * 4;
      xor[dst] = rgba[src + 2]; // B
      xor[dst + 1] = rgba[src + 1]; // G
      xor[dst + 2] = rgba[src]; // R
      xor[dst + 3] = rgba[src + 3]; // A
    }
  }
  return Buffer.concat([header, xor, and]);
}

function buildIco(entries) {
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach((entry, index) => {
    const at = 6 + index * 16;
    dir[at] = entry.size >= 256 ? 0 : entry.size;
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[at + 2] = 0; // palette
    dir[at + 3] = 0; // reserved
    dir.writeUInt16LE(1, at + 4); // planes
    dir.writeUInt16LE(32, at + 6); // bit count
    dir.writeUInt32LE(entry.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([dir, ...entries.map((e) => e.data)]);
}

const entries = SIZES.map((size) => {
  const rgba = renderRgba(size);
  return {
    size,
    data: size >= 256 ? encodePng(rgba, size) : encodeBmpEntry(rgba, size),
  };
});

const outPath = arg("--out", "build/icon.ico");
mkdirSync(dirname(outPath), { recursive: true });
const ico = buildIco(entries);
writeFileSync(outPath, ico);
console.log(`✓ ${outPath} — ${entries.length} entries (${SIZES.join(", ")} px), ${ico.length} bytes`);
