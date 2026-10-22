import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(import.meta.dir, "..", path), "utf8");

describe("license", () => {
  test("the repository and Workflow copies are byte for byte equal", () => {
    expect(read("Workflow/LICENSE")).toBe(read("LICENSE"));
  });

  test("keeps the upstream copyright, the Sillybit line, the conditions, and the disclaimer", () => {
    const text = read("LICENSE");
    expect(text).toContain("BSD 3-Clause License");
    expect(text).toContain("Copyright (c) 2024, Running with Crayons Ltd");
    expect(text).toContain("Copyright (c) 2026, Sillybit");
    expect(text).toContain("1. Redistributions of source code must retain");
    expect(text).toContain("2. Redistributions in binary form must reproduce");
    expect(text).toContain("3. Neither the name of the copyright holder");
    expect(text).toContain('THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"');
  });
});
