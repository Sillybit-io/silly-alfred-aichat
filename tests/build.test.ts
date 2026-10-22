import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInContext, createContext } from "node:vm";
import { buildEntries } from "../scripts/build";

const root = resolve(import.meta.dir, "..");

describe("build", () => {
  test("bundles an entry into an osascript file whose run handler reaches the entry", async () => {
    const out = mkdtempSync(join(tmpdir(), "aichat-build-"));
    const [target] = await buildEntries(root, { entries: "tests/fixtures/entries", out });
    const text = readFileSync(target!, "utf8");
    const lines = text.split("\n");
    expect(lines[0]).toBe("#!/usr/bin/osascript -l JavaScript");
    expect(lines[1]).toBe("var __aichat_main;");
    expect(lines[2]).toBe("(() => {");
    expect(statSync(target!).mode & 0o777).toBe(0o755);

    const context = createContext({});
    runInContext(lines.slice(1).join("\n"), context);
    expect(runInContext('run(["world"])', context)).toBe("hello world");
  });

  test("bundles use no module syntax", async () => {
    const out = mkdtempSync(join(tmpdir(), "aichat-build-"));
    const [target] = await buildEntries(root, { entries: "tests/fixtures/entries", out });
    const text = readFileSync(target!, "utf8");
    expect(text).not.toMatch(/^\s*(import|export)\s/m);
  });
});
