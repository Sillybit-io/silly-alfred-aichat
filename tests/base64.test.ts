import { describe, expect, test } from "bun:test";
import { decodeBase64, encodeBase64 } from "../src/core/base64";

describe("base64", () => {
  test("matches the reference encoder for every length up to 64", () => {
    for (let length = 0; length <= 64; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 255);
      const reference = Buffer.from(bytes).toString("base64");
      expect(encodeBase64(bytes)).toBe(reference);
      expect(Array.from(decodeBase64(reference))).toEqual(Array.from(bytes));
    }
  });

  test("decodes unpadded and line-wrapped input", () => {
    expect(Array.from(decodeBase64("aGk"))).toEqual([104, 105]);
    expect(Array.from(decodeBase64("aGVs\nbG8="))).toEqual([104, 101, 108, 108, 111]);
  });

  test("rejects characters outside the alphabet", () => {
    expect(() => decodeBase64("a*b=")).toThrow("invalid base64 character");
  });

  test("round-trips all byte values", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(decodeBase64(encodeBase64(bytes)))).toEqual(Array.from(bytes));
  });
});
