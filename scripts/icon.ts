import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 512;
const SAMPLES = 3;

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function roundedRectDistance(x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number): number {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function insideTail(x: number, y: number): boolean {
  const ax = 150, ay = 340, bx = 150, by = 436, cx = 250, cy = 340;
  const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = side(x, y, ax, ay, bx, by);
  const d2 = side(x, y, bx, by, cx, cy);
  const d3 = side(x, y, cx, cy, ax, ay);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

function samplePixel(x: number, y: number): [number, number, number, number] {
  const background = roundedRectDistance(x, y, SIZE / 2, SIZE / 2, 244, 244, 112);
  if (background > 0) return [0, 0, 0, 0];
  const t = (x + y) / (2 * SIZE);
  let color: [number, number, number] = [
    Math.round(88 + 70 * t),
    Math.round(70 - 10 * t),
    Math.round(230 - 40 * t),
  ];
  const bubble = roundedRectDistance(x, y, SIZE / 2, 244, 168, 112, 56) <= 0 || insideTail(x, y);
  if (bubble) {
    color = [255, 255, 255];
    for (const dx of [-70, 0, 70]) {
      if (Math.hypot(x - (SIZE / 2 + dx), y - 244) <= 20) color = [96, 76, 214];
    }
  }
  return [color[0], color[1], color[2], 255];
}

export function renderIcon(): Uint8Array {
  const raw = new Uint8Array(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const [pr, pg, pb, pa] = samplePixel(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES);
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
        }
      }
      const offset = rowStart + 1 + x * 4;
      const count = SAMPLES * SAMPLES;
      raw[offset] = a === 0 ? 0 : Math.round(r / a);
      raw[offset + 1] = a === 0 ? 0 : Math.round(g / a);
      raw[offset + 2] = a === 0 ? 0 : Math.round(b / a);
      raw[offset + 3] = Math.round(a / count);
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, SIZE);
  view.setUint32(4, SIZE);
  header[8] = 8;
  header[9] = 6;
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

if (import.meta.main) {
  const target = process.argv[2] ?? "Workflow/icon.png";
  writeFileSync(target, renderIcon());
  console.log(`wrote ${target}`);
}
