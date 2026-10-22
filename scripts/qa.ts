import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { buildEntries } from "./build";
import { packageProject } from "./package";

const root = resolve(import.meta.dir, "..");

export type Step = { id: string; action: string; expected: string; covers: string[] };
export type Shot = { name: string; step: string; minWidth: number; alt: string };
export type Row = { id: string; result: string; notes: string };
export type QaRecord = { version: string; digest: string; tester: string; date: string; rows: Row[] };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));

// docs/qa/checklist.md: a table whose rows start with M01, M02, ... and hold Step, Action, Expected, Covers.
export function parseChecklist(text: string): Step[] {
  const steps: Step[] = [];
  for (const line of text.split("\n")) {
    if (!/^\|\s*M\d+\s*\|/.test(line)) continue;
    const [id, action, expected, covers] = cells(line);
    steps.push({ id: id!, action: action ?? "", expected: expected ?? "", covers: (covers ?? "").split(/[,\s]+/).filter((part) => /^R\d+$/.test(part)) });
  }
  return steps;
}

export function parseScreenshots(text: string): Shot[] {
  const parsed = JSON.parse(text) as { screenshots?: Shot[] };
  return Array.isArray(parsed.screenshots) ? parsed.screenshots : [];
}

export function renderRecord(input: { version: string; digest: string; steps: Step[]; shots: Shot[] }): string {
  const lines = [
    `# AI Chat v${input.version} — manual macOS acceptance record`,
    "",
    `- Version: ${input.version}`,
    `- Content digest: ${input.digest}`,
    "- Candidate: dist/AI-Chat.alfredworkflow (from `bun run qa:candidate`) with dist/qa/probe.js",
    "- Tester: ",
    "- Date: ",
    "- macOS and Alfred versions: ",
    "",
    "Set every Result to PASS or FAIL after running the step in docs/qa/checklist.md by hand, fill in Tester and Date, save the screenshots listed below, then run `bun run qa:verify " + input.version + "`.",
    "",
    "## Steps",
    "",
    "| Step | Result | Notes |",
    "| --- | --- | --- |",
    ...input.steps.map((step) => `| ${step.id} | PENDING | |`),
    "",
    "## Screenshots",
    "",
    "| File | Step | Minimum width |",
    "| --- | --- | --- |",
    ...input.shots.map((shot) => `| Workflow/images/about/${shot.name}.png | ${shot.step} | ${shot.minWidth} |`),
    "",
  ];
  return lines.join("\n");
}

export function parseRecord(text: string): QaRecord {
  const field = (label: string) => new RegExp(`^- ${label}:[ \\t]*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  const rows: Row[] = [];
  const steps = text.split("## Steps")[1]?.split("## Screenshots")[0] ?? "";
  for (const line of steps.split("\n")) {
    if (!/^\|\s*M\d+\s*\|/.test(line)) continue;
    const [id, result, notes] = cells(line);
    rows.push({ id: id!, result: (result ?? "").toUpperCase(), notes: notes ?? "" });
  }
  return { version: field("Version"), digest: field("Content digest"), tester: field("Tester"), date: field("Date"), rows };
}

export function pngWidth(bytes: Uint8Array): number | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((value, i) => bytes[i] !== value)) return null;
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return null;
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(16);
}

const recordPath = (projectRoot: string, version: string) => join(projectRoot, `docs/qa/v${version}.md`);
export const loadChecklist = (projectRoot: string) => parseChecklist(readFileSync(join(projectRoot, "docs/qa/checklist.md"), "utf8"));
export const loadShots = (projectRoot: string) => parseScreenshots(readFileSync(join(projectRoot, "docs/qa/screenshots.json"), "utf8"));

export type VerifyOptions = { computeDigest?: () => Promise<string> | string };

// A record passes only when every checklist step is PASS, the tester and date are filled, every
// screenshot exists at its minimum width, and the record's digest belongs to the code that would ship.
export async function verifyRecord(projectRoot: string, version: string, options: VerifyOptions = {}): Promise<string[]> {
  const errors: string[] = [];
  const path = recordPath(projectRoot, version);
  if (!existsSync(path)) return [`QA record docs/qa/v${version}.md is missing. Run \`bun run qa:candidate\`, then the checklist by hand.`];
  const record = parseRecord(readFileSync(path, "utf8"));
  const steps = loadChecklist(projectRoot);
  if (record.version !== version) errors.push(`The record is for version "${record.version}", not ${version}.`);
  if (record.tester === "") errors.push("Tester is empty.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date)) errors.push("Date must be filled in as YYYY-MM-DD.");
  for (const step of steps) {
    const row = record.rows.find((candidate) => candidate.id === step.id);
    if (!row) errors.push(`${step.id} has no row in the record.`);
    else if (row.result !== "PASS") errors.push(`${step.id} is ${row.result === "" ? "empty" : row.result}, not PASS.`);
  }
  for (const row of record.rows) if (!steps.some((step) => step.id === row.id)) errors.push(`${row.id} is not a step in docs/qa/checklist.md.`);
  for (const shot of loadShots(projectRoot)) {
    const file = join(projectRoot, "Workflow/images/about", `${shot.name}.png`);
    if (!existsSync(file)) {
      errors.push(`Screenshot Workflow/images/about/${shot.name}.png is missing.`);
      continue;
    }
    const width = pngWidth(new Uint8Array(readFileSync(file)));
    if (width === null) errors.push(`Screenshot ${shot.name}.png is not a PNG.`);
    else if (width < shot.minWidth) errors.push(`Screenshot ${shot.name}.png is ${width}px wide; the minimum is ${shot.minWidth}px.`);
  }
  const fresh = options.computeDigest ? await options.computeDigest() : (await packageProject(projectRoot)).contentDigest;
  if (record.digest !== fresh) errors.push(`The record's content digest (${record.digest.slice(0, 12)}…) is not the shipped archive's (${fresh.slice(0, 12)}…): the code changed after the manual run.`);
  return errors;
}

export type CandidateResult = { recordWritten: boolean; recordPath: string; archive: string; probe: string; digest: string; note: string };

// Packages the candidate and probe, and writes the record only while it is missing or still all PENDING.
export async function candidate(projectRoot = root, version = pkg.version): Promise<CandidateResult> {
  const packaged = await packageProject(projectRoot);
  await buildEntries(projectRoot, { entries: "src/qa", out: "dist/qa" });
  const path = recordPath(projectRoot, version);
  const steps = loadChecklist(projectRoot);
  const shots = loadShots(projectRoot);
  let write = true;
  let note = "";
  if (existsSync(path)) {
    const existing = parseRecord(readFileSync(path, "utf8"));
    if (existing.rows.some((row) => row.result !== "PENDING") || existing.tester !== "" || existing.date !== "") {
      write = false;
      note = existing.digest === packaged.contentDigest ? "The record already holds results and still matches this archive; it was left alone." : "The record holds results for different code; it was left alone. Re-run the checklist and update its digest by hand, or move it aside.";
    }
  }
  if (write) {
    mkdirSync(join(projectRoot, "docs/qa"), { recursive: true });
    writeFileSync(path, renderRecord({ version, digest: packaged.contentDigest, steps, shots }));
  }
  return { recordWritten: write, recordPath: path, archive: packaged.path, probe: join(projectRoot, "dist/qa/probe.js"), digest: packaged.contentDigest, note };
}

if (import.meta.main) {
  const [command, version = pkg.version] = process.argv.slice(2);
  if (command === "candidate") {
    const result = await candidate(root, version);
    console.log(`candidate: ${result.archive}\nprobe: ${result.probe}\ndigest: ${result.digest}\nrecord: ${result.recordPath}${result.recordWritten ? " (written, every step PENDING)" : ""}`);
    if (result.note) console.log(result.note);
  } else if (command === "verify") {
    const errors = await verifyRecord(root, version);
    if (errors.length > 0) {
      for (const error of errors) console.error(`✗ ${error}`);
      process.exit(1);
    }
    console.log(`QA record for v${version} passes.`);
  } else {
    console.error("usage: bun scripts/qa.ts candidate | verify [version]");
    process.exit(2);
  }
}
