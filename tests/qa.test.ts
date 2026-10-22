import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChecklist, parseRecord, parseScreenshots, pngWidth, renderRecord, verifyRecord } from "../scripts/qa";

const work = mkdtempSync(join(tmpdir(), "aichat-qa-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const CHECKLIST = `# Checklist

| Step | Action | Expected | Covers |
| --- | --- | --- | --- |
| M01 | Install the workflow | It imports | |
| M02 | Press \\| in chat | Pipe survives | R01, R02 |
| M03 | Stop a reply | Partial text is kept | R05 |
`;
const SHOTS = JSON.stringify({ screenshots: [{ name: "chat", step: "M02", minWidth: 1000, alt: "A chat" }, { name: "models", step: "M03", minWidth: 800, alt: "Models" }] });
const DIGEST = "a".repeat(64);

function png(width: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(600, 20);
  return header;
}

let counter = 0;
function project(options: { results?: string[]; tester?: string; date?: string; digest?: string; shots?: Record<string, number>; version?: string } = {}) {
  const dir = join(work, `p${counter++}`);
  mkdirSync(join(dir, "docs/qa"), { recursive: true });
  mkdirSync(join(dir, "Workflow/images/about"), { recursive: true });
  writeFileSync(join(dir, "docs/qa/checklist.md"), CHECKLIST);
  writeFileSync(join(dir, "docs/qa/screenshots.json"), SHOTS);
  const steps = parseChecklist(CHECKLIST);
  const base = renderRecord({ version: options.version ?? "0.1.0", digest: options.digest ?? DIGEST, steps, shots: parseScreenshots(SHOTS) });
  const results = options.results ?? ["PASS", "PASS", "PASS"];
  let record = base.replace("- Tester: ", `- Tester: ${options.tester ?? "Ada"}`).replace("- Date: ", `- Date: ${options.date ?? "2026-10-22"}`);
  steps.forEach((step, i) => {
    record = record.replace(`| ${step.id} | PENDING | |`, `| ${step.id} | ${results[i]} | |`);
  });
  writeFileSync(join(dir, "docs/qa/v0.1.0.md"), record);
  for (const [name, width] of Object.entries(options.shots ?? { chat: 1200, models: 900 })) writeFileSync(join(dir, "Workflow/images/about", `${name}.png`), png(width));
  return dir;
}
const verify = (dir: string, digest = DIGEST) => verifyRecord(dir, "0.1.0", { computeDigest: () => digest });

describe("checklist, record, and screenshots", () => {
  test("the checklist table is parsed into steps with their ROUTES ids, escaped pipes kept", () => {
    expect(parseChecklist(CHECKLIST)).toEqual([
      { id: "M01", action: "Install the workflow", expected: "It imports", covers: [] },
      { id: "M02", action: "Press | in chat", expected: "Pipe survives", covers: ["R01", "R02"] },
      { id: "M03", action: "Stop a reply", expected: "Partial text is kept", covers: ["R05"] },
    ]);
  });

  test("a rendered candidate record lists every step PENDING and every screenshot, and parses back", () => {
    const text = renderRecord({ version: "0.1.0", digest: DIGEST, steps: parseChecklist(CHECKLIST), shots: parseScreenshots(SHOTS) });
    const record = parseRecord(text);
    expect(record).toEqual({ version: "0.1.0", digest: DIGEST, tester: "", date: "", rows: [{ id: "M01", result: "PENDING", notes: "" }, { id: "M02", result: "PENDING", notes: "" }, { id: "M03", result: "PENDING", notes: "" }] });
    expect(text).toContain("| Workflow/images/about/chat.png | M02 | 1000 |");
    expect(text).toContain("| Workflow/images/about/models.png | M03 | 800 |");
  });

  test("png width reads the IHDR and refuses non-PNG bytes", () => {
    expect(pngWidth(png(1234))).toBe(1234);
    expect(pngWidth(new Uint8Array(40))).toBeNull();
    expect(pngWidth(new Uint8Array(3))).toBeNull();
  });
});

describe("qa verify", () => {
  test("happy: every step PASS, tester and date filled, screenshots wide enough, and a matching digest pass", async () => {
    expect(await verify(project())).toEqual([]);
  });

  test("failure: PENDING and FAIL steps are named", async () => {
    const errors = await verify(project({ results: ["PASS", "PENDING", "FAIL"] }));
    expect(errors).toContain("M02 is PENDING, not PASS.");
    expect(errors).toContain("M03 is FAIL, not PASS.");
    expect(errors).toHaveLength(2);
  });

  test("failure: a missing or narrow screenshot is named with the minimum width", async () => {
    const errors = await verify(project({ shots: { chat: 640 } }));
    expect(errors).toContain("Screenshot chat.png is 640px wide; the minimum is 1000px.");
    expect(errors).toContain("Screenshot Workflow/images/about/models.png is missing.");
    const notPng = project();
    writeFileSync(join(notPng, "Workflow/images/about/chat.png"), "not a png at all, definitely not");
    expect(await verify(notPng)).toContain("Screenshot chat.png is not a PNG.");
  });

  test("failure: a changed digest means the code changed after the manual run", async () => {
    const errors = await verify(project(), "b".repeat(64));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("content digest");
    expect(errors[0]).toContain("code changed after the manual run");
  });

  test("failure: a missing record, an empty tester, a bad date, a wrong version, and extra or missing rows", async () => {
    const empty = join(work, "empty");
    mkdirSync(join(empty, "docs/qa"), { recursive: true });
    expect((await verifyRecord(empty, "0.1.0", { computeDigest: () => DIGEST }))[0]).toContain("QA record docs/qa/v0.1.0.md is missing");
    const errors = await verify(project({ tester: "", date: "yesterday" }));
    expect(errors).toContain("Tester is empty.");
    expect(errors).toContain("Date must be filled in as YYYY-MM-DD.");
    const dir = project();
    const path = join(dir, "docs/qa/v0.1.0.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("| M03 | PASS | |", "| M09 | PASS | |"));
    const rows = await verify(dir);
    expect(rows).toContain("M03 has no row in the record.");
    expect(rows).toContain("M09 is not a step in docs/qa/checklist.md.");
    expect(await verify(project({ version: "0.0.9" }))).toContain('The record is for version "0.0.9", not 0.1.0.');
  });
});
