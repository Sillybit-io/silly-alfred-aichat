import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { crc32, renderIcon } from "../scripts/icon";

const iconPath = resolve(import.meta.dir, "../Workflow/icon.png");

describe("icon", () => {
  const png = readFileSync(iconPath);

  test("has the PNG signature and a 512 by 512 RGBA header", () => {
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.toString("latin1", 12, 16)).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
  });

  test("every chunk checksum is valid and the image data inflates to full rows", () => {
    let offset = 8;
    const types: string[] = [];
    const data: Buffer[] = [];
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const type = png.toString("latin1", offset + 4, offset + 8);
      const body = png.subarray(offset + 8, offset + 8 + length);
      const stored = png.readUInt32BE(offset + 8 + length);
      expect(crc32(png.subarray(offset + 4, offset + 8 + length))).toBe(stored);
      types.push(type);
      if (type === "IDAT") data.push(body);
      offset += 12 + length;
    }
    expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(inflateSync(Buffer.concat(data)).length).toBe(512 * (512 * 4 + 1));
  });

  test("the committed icon is what the generator produces", () => {
    expect(Buffer.compare(png, Buffer.from(renderIcon()))).toBe(0);
  });
});
