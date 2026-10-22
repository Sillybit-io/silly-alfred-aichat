import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROUTES } from "../scripts/workflow";
import { parseChecklist, parseRecord, parseScreenshots } from "../scripts/qa";
import { BUILTIN_COMMANDS } from "../src/core/commands";
import { allCommands } from "../src/features/index";

const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const readme = read("README.md");
const faq = read("FAQ.md");
// The manual QA kit (docs/qa) is kept out of the repository, so these checks run only where it exists.
const hasQa = existsSync(resolve(root, "docs/qa/checklist.md"));
const steps = hasQa ? parseChecklist(read("docs/qa/checklist.md")) : [];
const shots = hasQa ? parseScreenshots(read("docs/qa/screenshots.json")) : [];
const KEYWORDS = ["aichat", "aimodels", "aipresets", "aiimage"];

describe("README", () => {
  test("the first H2 is Usage, and each keyword has a Usage sentence ending via the keyword", () => {
    expect(readme.split("\n").find((line) => line.startsWith("## "))).toBe("## Usage");
    for (const keyword of KEYWORDS) {
      expect(readme.split("\n").some((line) => line.trimEnd().endsWith(`via the \`${keyword}\` keyword.`)), `no sentence ends with "via the \`${keyword}\` keyword."`).toBe(true);
    }
  });

  test("every default keyword and every registered slash command appears", () => {
    for (const keyword of KEYWORDS) expect(readme, `keyword ${keyword} is missing from the README`).toContain(`\`${keyword}\``);
    const commands = [...BUILTIN_COMMANDS.map((command) => command.name), ...Object.keys(allCommands())];
    expect(commands.length).toBeGreaterThanOrEqual(20);
    for (const name of commands) expect(readme, `the slash command /${name} is missing from the README`).toMatch(new RegExp(`\`/${name}[\\s\`]`));
  });

  test.skipIf(!hasQa)("every markdown image is a listed screenshot, and every listed screenshot is used", () => {
    const listed = new Set(shots.map((shot) => `Workflow/images/about/${shot.name}.png`));
    const used = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const path of used) expect(listed.has(path), `${path} is not listed in docs/qa/screenshots.json`).toBe(true);
    for (const path of listed) expect(used, `${path} is listed but not used in the README`).toContain(path);
  });

  test("modifier lists use kbd keys, universal actions are named, and Alternatively pairs keywords with actions", () => {
    expect(readme).toMatch(/\* <kbd>⌘<\/kbd><kbd>↩︎<\/kbd> Start a new chat\./);
    expect(readme).toContain("Universal Action");
    expect(readme.match(/^Alternatively, /gm)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  test("the license attributes Running with Crayons", () => {
    expect(readme).toContain("Running with Crayons Ltd");
    expect(readme).toContain("BSD 3-Clause");
    expect(readme).not.toMatch(/paid feature/i);
  });
});

describe("README and FAQ", () => {
  const FIGURES = [/\$\s?\d/, /\b\d[\d.,]*\s*(tokens?|credits?|cents?|USD)\b/i, /\bbalance\b/i, /\bcredit total\b/i, /\btotal_credits\b/i, /\b(token|usage) count/i];
  for (const [name, text] of [["README.md", readme], ["FAQ.md", faq]] as const) {
    test(`${name} holds no balance, credit total, cost figure, or token count, and no key or local path`, () => {
      for (const pattern of FIGURES) expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
      expect(text).not.toMatch(/sk-or-[A-Za-z0-9]/);
      expect(text).not.toMatch(/\/Users\/(?!\[)[a-z]/i);
      expect(text).not.toMatch(/\/home\/[a-z]/i);
    });
  }

  test("the FAQ covers stalls, stop and provider billing, the presets file, the file-picker fallback, and the debugger", () => {
    for (const topic of [/stall/i, /⇧↩/, /bill/i, /presets\.json/, /Universal Action/, /debugger/i]) expect(faq).toMatch(topic);
  });
});

describe.skipIf(!hasQa)("manual QA checklist", () => {
  test("steps are numbered M01 upward without gaps, each with an action and an expected result", () => {
    expect(steps.length).toBeGreaterThan(30);
    steps.forEach((step, index) => {
      expect(step.id).toBe(`M${String(index + 1).padStart(2, "0")}`);
      expect(step.action.length).toBeGreaterThan(10);
      expect(step.expected.length).toBeGreaterThan(10);
    });
  });

  test("every ROUTES id is covered by a step", () => {
    const covered = new Set(steps.flatMap((step) => step.covers));
    for (const route of ROUTES) expect(covered.has(route.id), `${route.id} (${route.row}) is not covered by any checklist step`).toBe(true);
    for (const id of covered) expect(ROUTES.some((route) => route.id === id), `${id} is not a ROUTES id`).toBe(true);
  });

  test("the checklist covers the manual-only areas the plan names", () => {
    const text = steps.map((step) => `${step.action} ${step.expected}`).join("\n").toLowerCase();
    for (const topic of ["probe", "stop", "retry", "picker", "paste", "20 mb", "/pdf", "/model", "reasoning", "/web", "preset", "pin", "archive", "trash", "delete", "export", "title", "retention", "image", "reveal", "font"]) {
      expect(text, `no checklist step mentions ${topic}`).toContain(topic);
    }
  });

  test("screenshots name existing steps, are unique, and need at least 1000 px", () => {
    expect(new Set(shots.map((shot) => shot.name)).size).toBe(shots.length);
    for (const shot of shots) {
      expect(steps.some((step) => step.id === shot.step), `${shot.name} names the unknown step ${shot.step}`).toBe(true);
      expect(shot.minWidth).toBeGreaterThanOrEqual(1000);
      expect(shot.alt.length).toBeGreaterThan(3);
    }
  });

  test("the candidate record, once written, lists exactly the checklist steps", () => {
    expect(existsSync(resolve(root, "docs/qa/v0.1.0.md"))).toBe(true);
    const text = read("docs/qa/v0.1.0.md");
    const record = parseRecord(text);
    expect(record.rows.map((row) => row.id)).toEqual(steps.map((step) => step.id));
    for (const shot of shots) expect(text).toContain(`Workflow/images/about/${shot.name}.png`);
  });
});

describe("other documents", () => {
  test("the changelog starts with Unreleased, the release guide gives the order, and the forum post exists", () => {
    expect(read("CHANGELOG.md").startsWith("## Unreleased")).toBe(true);
    const release = read("docs/release.md").toLowerCase();
    const order = ["**checks.**", "**bump.**", "**changelog.**", "**package.**", "**publish.**"].map((word) => release.indexOf(word));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(read("docs/forum-post.md")).toContain("Share your Workflows");
    expect(`${read("docs/release.md")}${read("docs/forum-post.md")}`).not.toMatch(/will be (listed|accepted|included)/i);
  });
});
