import { deflateRawSync } from "node:zlib";
import { crc32 } from "./icon";

export type ZipEntry = { name: string; data: Uint8Array; mode: number };

const encoder = new TextEncoder();
// 1980-01-01 00:00:00, the earliest DOS time, so the archive never depends on the clock.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UNIX_VERSION_MADE_BY = (3 << 8) | 20;
const UTF8_FLAG = 0x0800;

function compare(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

// A ZIP that is byte-identical for identical contents: sorted entries, a fixed timestamp, deflate level 9,
// and Unix file modes in the external attributes so scripts stay executable after unzipping.
export function zipFiles(entries: ZipEntry[]): Uint8Array {
  const sorted = entries.slice().sort((a, b) => compare(a.name, b.name));
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of sorted) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const packed = entry.data.length === 0 ? new Uint8Array(0) : deflateRawSync(entry.data, { level: 9 });
    const method = entry.data.length === 0 ? 0 : 8;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    chunks.push(local, packed);

    const header = new Uint8Array(46 + name.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, UNIX_VERSION_MADE_BY, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, ((0o100000 | (entry.mode & 0o7777)) << 16) >>> 0, true);
    cv.setUint32(42, offset, true);
    header.set(name, 46);
    central.push(header);
    offset += local.length + packed.length;
  }
  const directorySize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, sorted.length, true);
  ev.setUint16(10, sorted.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let position = 0;
  for (const part of all) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}
