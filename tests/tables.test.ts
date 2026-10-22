import { describe, expect, test } from "bun:test";
import { flattenTables } from "../src/core/tables";

describe("tables in the Text View", () => {
  test("a table becomes one bullet per row, keeping the bold first column and the header names", () => {
    const table = "Next week:\n\n| Day | High / low | Notes |\n|---|---|---|\n| **Mon 26** | ~12 / 7-8 °C | Mostly dry |\n| Tue 27 | 14-18 / 8-11 °C | |\n\nAfter.";
    expect(flattenTables(table)).toBe("Next week:\n\n- **Mon 26** — High / low: ~12 / 7-8 °C · Notes: Mostly dry\n- **Tue 27** — High / low: 14-18 / 8-11 °C\n\nAfter.");
  });

  test("alignment colons, missing outer pipes, and escaped pipes are read", () => {
    expect(flattenTables("A | B\n:--- | ---:\nx \\| y | z")).toBe("- **x | y** — B: z");
  });

  test("a header line still streaming, code blocks, and plain pipes are left as they are", () => {
    expect(flattenTables("| Day | High |")).toBe("| Day | High |");
    const code = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
    expect(flattenTables(code)).toBe(code);
    expect(flattenTables("use a | b to pipe\nand c | d")).toBe("use a | b to pipe\nand c | d");
  });
});
