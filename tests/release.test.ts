import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { changelogSection, checkRelease } from "../scripts/release-check";
import { parseChecklist, parseScreenshots, renderRecord } from "../scripts/qa";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-release-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const DIGEST = "c".repeat(64);
const CHECKLIST = "| Step | Action | Expected | Covers |\n| --- | --- | --- | --- |\n| M01 | Install | Imports | R01 |\n";
const SHOTS = JSON.stringify({ screenshots: [] });
const plist = (version: string) => `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>version</key><string>${version}</string></dict></plist>`;

let counter = 0;
function project(options: { pkg?: string; plist?: string; changelog?: string; result?: string } = {}) {
  const dir = join(work, `p${counter++}`);
  mkdirSync(join(dir, "docs/qa"), { recursive: true });
  mkdirSync(join(dir, "Workflow"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: options.pkg ?? "0.1.0" }));
  writeFileSync(join(dir, "Workflow/info.plist"), plist(options.plist ?? "0.1.0"));
  writeFileSync(join(dir, "CHANGELOG.md"), options.changelog ?? "# Changelog\n\n## 0.1.0 — 2026-10-22\n\n- First release.\n- Streaming chat.\n\n## 0.0.1 — 2026-01-01\n\n- Old.\n");
  writeFileSync(join(dir, "docs/qa/checklist.md"), CHECKLIST);
  writeFileSync(join(dir, "docs/qa/screenshots.json"), SHOTS);
  const record = renderRecord({ version: "0.1.0", digest: DIGEST, steps: parseChecklist(CHECKLIST), shots: parseScreenshots(SHOTS) });
  writeFileSync(join(dir, "docs/qa/v0.1.0.md"), record.replace("- Tester: ", "- Tester: Ada").replace("- Date: ", "- Date: 2026-10-22").replace("| M01 | PENDING |", `| M01 | ${options.result ?? "PASS"} |`));
  return dir;
}
const check = (dir: string, tag = "v0.1.0") => checkRelease(dir, tag, { computeDigest: () => DIGEST });

describe("release check", () => {
  test("happy: tag, package, plist, changelog, and a passing QA record agree, and the notes are that version's section", async () => {
    const result = await check(project());
    expect(result.errors).toEqual([]);
    expect(result.notes).toBe("- First release.\n- Streaming chat.");
  });

  test("failure: a tag, plist, or changelog version mismatch is named", async () => {
    expect((await check(project(), "v9.9.9")).errors[0]).toContain("Version mismatch: the tag is v9.9.9 but package.json says v0.1.0");
    expect((await check(project({ plist: "0.0.9" }))).errors[0]).toContain("Version mismatch: Workflow/info.plist says 0.0.9");
    expect((await check(project({ changelog: "# Changelog\n\n## Unreleased\n\n- Not yet.\n" }))).errors[0]).toContain('Version mismatch: CHANGELOG.md has no "## 0.1.0 — <date>" heading');
    expect((await check(project({ changelog: "# Changelog\n\n## 0.1.0 — 2026-10-22\n\n## 0.0.1 — 2026-01-01\n- Old\n" }))).errors[0]).toContain("no notes under 0.1.0");
  });

  test("failure: a missing or failing QA record stops the release", async () => {
    const failing = await check(project({ result: "FAIL" }));
    expect(failing.errors).toContain("M01 is FAIL, not PASS.");
    expect(failing.notes).toBeNull();
    const missing = project();
    rmSync(join(missing, "docs/qa/v0.1.0.md"));
    expect((await check(missing)).errors[0]).toContain("QA record docs/qa/v0.1.0.md is missing");
    const stale = await checkRelease(project(), "v0.1.0", { computeDigest: () => "d".repeat(64) });
    expect(stale.errors[0]).toContain("content digest");
  });

  test("--no-qa style checks skip the manual record but still check the versions", async () => {
    const missing = project();
    rmSync(join(missing, "docs/qa/v0.1.0.md"));
    expect((await checkRelease(missing, "v0.1.0", { skipQa: true })).errors).toEqual([]);
    expect((await checkRelease(missing, "v0.2.0", { skipQa: true })).errors[0]).toContain("Version mismatch");
  });

  test("changelog sections end at the next heading and accept an undated heading", () => {
    expect(changelogSection("## 1.0.0\n\n- a\n\n## 0.9.0\n- b", "1.0.0")).toBe("- a");
    expect(changelogSection("## 1.0.10 — 2026-01-01\n- x", "1.0.1")).toBeNull();
  });

  test("bun run release:check v9.9.9 exits 1 naming the version mismatch", () => {
    const before = readFileSync(join(root, "package.json"), "utf8");
    const run = Bun.spawnSync(["bun", "scripts/release-check.ts", "v9.9.9"], { cwd: root });
    expect(run.exitCode).toBe(1);
    expect(String(run.stderr)).toContain("Version mismatch");
    expect(String(run.stderr)).toContain("v9.9.9");
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
  });
});
