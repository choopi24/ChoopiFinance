#!/usr/bin/env node
/**
 * Rasterise the app icon into the PNGs a PWA install needs.
 *
 * iOS ignores SVG icons in a web manifest and uses <link rel="apple-touch-icon">,
 * which must be a PNG — so PNGs are not optional. Rather than add an image
 * library (and a build step, and a supply-chain dependency) for one small mark,
 * the icon is drawn here with signed distance fields and encoded with the zlib
 * that ships in Node.
 *
 * Run: npm run icons
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "web", "icons");

const BRAND = [0x2f, 0x6b, 0xed]; // --accent
const WHITE = [0xff, 0xff, 0xff];

// ── PNG encoding ─────────────────────────────────────────────────────────────

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: a Buffer of size*size*4. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  // 10..12 stay 0: deflate, adaptive filtering, no interlace.

  // One filter byte per scanline; filter 0 (None) keeps this simple and the
  // icons are tiny, so the extra bytes cost nothing.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── drawing ──────────────────────────────────────────────────────────────────

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to the segment ab. */
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * The mark: a rising line with a dot at its peak, on a rounded brand square.
 * Coordinates are in a 32×32 design space, matching web/favicon.svg.
 *
 * `padding` insets the artwork for the maskable variant, whose outer ~10% can
 * be cropped to any shape by the launcher.
 */
function drawIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4; // supersampling factor — 16 samples per pixel
  const scale = size / 32;

  // A maskable icon must fill the whole canvas: the launcher, not us, decides
  // the silhouette. A normal icon keeps its own rounded square.
  const inset = maskable ? 0 : 0;
  const artScale = maskable ? 0.72 : 1;
  const corner = maskable ? 0 : 7;

  const pts = [[7, 21.5], [13, 14], [18, 18], [25, 8.5]];
  const strokeW = 3;
  const dot = [25, 8.5];
  const dotR = 2.6;

  const toArt = (v) => 16 + (v - 16) * artScale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          // Sample position in the 32-unit design space.
          const px = ((x + (sx + 0.5) / SS) / scale);
          const py = ((y + (sy + 0.5) / SS) / scale);

          // Background: rounded square (or the full bleed, when maskable).
          const bgDist = maskable
            ? -1
            : sdRoundRect(px, py, 16, 16, 16 - inset, 16 - inset, corner);
          const inBg = bgDist <= 0;
          if (!inBg) continue;

          // Foreground: the polyline, plus the dot at its end.
          let fg = Infinity;
          for (let i = 0; i < pts.length - 1; i++) {
            fg = Math.min(fg, sdSegment(
              px, py,
              toArt(pts[i][0]), toArt(pts[i][1]),
              toArt(pts[i + 1][0]), toArt(pts[i + 1][1])
            ) - (strokeW * artScale) / 2);
          }
          fg = Math.min(fg, Math.hypot(px - toArt(dot[0]), py - toArt(dot[1])) - dotR * artScale);

          const [cr, cg, cb] = fg <= 0 ? WHITE : BRAND;
          r += cr; g += cg; b += cb; a += 255;
        }
      }

      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = Math.round(a / n);
    }
  }

  return encodePng(size, rgba);
}

// ── write them ───────────────────────────────────────────────────────────────

mkdirSync(outDir, { recursive: true });

const targets = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
  // iOS uses this one for the home-screen tile and applies its own rounding.
  { file: "apple-touch-icon.png", size: 180 },
];

for (const t of targets) {
  const png = drawIcon(t.size, { maskable: t.maskable });
  writeFileSync(join(outDir, t.file), png);
  console.log(`[icons] ${t.file.padEnd(26)} ${t.size}×${t.size}  ${Math.round(png.length / 1024)} KB`);
}
console.log(`[icons] written to ${outDir}`);
