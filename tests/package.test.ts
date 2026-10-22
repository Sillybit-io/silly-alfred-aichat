import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "plist";
import { parse as parseYaml } from "yaml";
import { bumpChangelog, bumpPackageJson, nextVersion } from "../scripts/bump-version";
import { blankExported, contentDigest, packageWorkflow } from "../scripts/package";
import { zipFiles } from "../scripts/zip";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-package-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const unzip = (...args: string[]) => Bun.spawnSync(["unzip", ...args]);
const text = (result: ReturnType<typeof Bun.spawnSync>) => String(result.stdout);

describe("zip writer", () => {
  const entries = [
    { name: "b.txt", data: new TextEncoder().encode("bee ".repeat(100)), mode: 0o644 },
    { name: "a.js", data: new TextEncoder().encode("#!/usr/bin/osascript -l JavaScript\n"), mode: 0o755 },
    { name: "empty", data: new Uint8Array(0), mode: 0o644 },
    { name: "sub/é ü.txt", data: new TextEncoder().encode("unicode name"), mode: 0o644 },
  ];

  test("sorted entries, a fixed 1980 timestamp, Unix modes, and a valid archive for unzip", () => {
    const path = join(work, "t.zip");
    writeFileSync(path, zipFiles(entries));
    expect(unzip("-t", path).exitCode).toBe(0);
    expect(text(unzip("-Z1", path)).trim().split("\n")).toEqual(["a.js", "b.txt", "empty", "sub/é ü.txt"]);
    const listing = text(unzip("-Z", path));
    expect(listing).toContain("-rwxr-xr-x  2.0 unx       35 b- defN 80-Jan-01 00:00 a.js");
    expect(listing).toMatch(/-rw-r--r--.*b\.txt/);
    expect(text(unzip("-p", path, "b.txt"))).toBe("bee ".repeat(100));
  });

  test("the same entries in any order give the same bytes", () => {
    expect(Buffer.from(zipFiles(entries)).equals(Buffer.from(zipFiles(entries.slice().reverse())))).toBe(true);
  });
});

describe("packaging", () => {
  test("happy: the archive holds the workflow at its root with executable scripts, the root LICENSE, and no prefs.plist; two runs are byte-identical", () => {
    const first = packageWorkflow({ workflowDir: join(root, "Workflow"), out: join(work, "one.alfredworkflow") });
    const second = packageWorkflow({ workflowDir: join(root, "Workflow"), out: join(work, "two.alfredworkflow") });
    expect(first.sha256).toBe(second.sha256);
    expect(Buffer.from(readFileSync(first.path)).equals(readFileSync(second.path))).toBe(true);
    const names = text(unzip("-Z1", first.path)).trim().split("\n");
    for (const required of ["info.plist", "icon.png", "LICENSE", "chat.js", "session.js", "models.js", "presets.js", "history.js", "image.js", "attach.js"]) expect(names).toContain(required);
    expect(names.some((name) => name.startsWith("Workflow/"))).toBe(false);
    expect(names).not.toContain("prefs.plist");
    expect(names.some((name) => /node_modules|tests\/|dist\/|qa\/probe/.test(name))).toBe(false);
    const modes = text(unzip("-Z", first.path)).split("\n");
    for (const script of names.filter((name) => name.endsWith(".js"))) expect(modes.find((line) => line.endsWith(` ${script}`))).toContain("-rwxr-xr-x");
    expect(modes.find((line) => line.endsWith(" info.plist"))).toContain("-rw-r--r--");
    expect(text(unzip("-p", first.path, "LICENSE"))).toBe(readFileSync(join(root, "LICENSE"), "utf8"));
    expect(unzip("-t", first.path).exitCode).toBe(0);
  });

  test("failure: a local prefs.plist and hidden files never reach the archive", () => {
    const copy = join(work, "Workflow-copy");
    cpSync(join(root, "Workflow"), copy, { recursive: true });
    writeFileSync(join(copy, "prefs.plist"), "<plist><dict><key>openrouter_api_key</key><string>sk-or-secret</string></dict></plist>");
    writeFileSync(join(copy, ".DS_Store"), "junk");
    const packaged = packageWorkflow({ workflowDir: copy, out: join(work, "clean.alfredworkflow") });
    const names = text(unzip("-Z1", packaged.path));
    expect(names).not.toContain("prefs.plist");
    expect(names).not.toContain(".DS_Store");
    expect(text(unzip("-p", packaged.path, "info.plist"))).not.toContain("sk-or-secret");
    expect(existsSync(join(copy, "prefs.plist"))).toBe(true);
  });

  test("variables named in variablesdontexport ship empty, as a variable and as a configuration default", () => {
    const source = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>variables</key><dict><key>openrouter_api_key</key><string>sk-live</string><key>keep</key><string>yes</string></dict><key>variablesdontexport</key><array><string>openrouter_api_key</string></array><key>userconfigurationconfig</key><array><dict><key>config</key><dict><key>default</key><string>sk-live</string></dict><key>variable</key><string>openrouter_api_key</string></dict><dict><key>config</key><dict><key>default</key><string>chat</string></dict><key>variable</key><string>keyword_chat</string></dict></array></dict></plist>`;
    const blanked = parse(blankExported(source)) as any;
    expect(blanked.variables).toEqual({ openrouter_api_key: "", keep: "yes" });
    expect(blanked.userconfigurationconfig.map((f: any) => f.config.default)).toEqual(["", "chat"]);
    expect(blankExported(readFileSync(join(root, "Workflow/info.plist"), "utf8"))).toBe(readFileSync(join(root, "Workflow/info.plist"), "utf8"));
  });

  test("the content digest covers names and bytes but not the screenshots in images/", () => {
    const base = [{ name: "a", data: Uint8Array.from([1]), mode: 0o644 }, { name: "b", data: Uint8Array.from([2]), mode: 0o755 }];
    const digest = contentDigest(base);
    expect(contentDigest([...base].reverse())).toBe(digest);
    expect(contentDigest([...base, { name: "images/about/x.png", data: Uint8Array.from([9]), mode: 0o644 }])).toBe(digest);
    expect(contentDigest([{ ...base[0]!, data: Uint8Array.from([3]) }, base[1]!])).not.toBe(digest);
    expect(contentDigest([{ ...base[0]!, name: "c" }, base[1]!])).not.toBe(digest);
  });

  test("bun run package exits 0 and writes dist/AI-Chat.alfredworkflow", () => {
    const run = Bun.spawnSync(["bun", "run", "package"], { cwd: root });
    expect(run.exitCode).toBe(0);
    expect(text(unzip("-Z1", join(root, "dist/AI-Chat.alfredworkflow"))).split("\n")).toContain("chat.js");
    expect(Bun.spawnSync(["git", "diff", "--exit-code", "--", "Workflow"], { cwd: root }).exitCode).toBe(0);
  });
});

describe("version bump", () => {
  test("package.json and the changelog heading are updated, and a bad version or a missing heading is refused", () => {
    expect(bumpPackageJson('{\n  "name": "x",\n  "version": "0.1.0",\n  "type": "module"\n}', "0.2.0")).toContain('"version": "0.2.0"');
    expect(() => bumpPackageJson("{}", "v2")).toThrow("not a version");
    expect(bumpChangelog("# Changelog\n\n## Unreleased\n\n- Added things\n", "0.2.0", "2026-10-22")).toBe("# Changelog\n\n## Unreleased\n\n## 0.2.0 — 2026-10-22\n\n- Added things\n");
    expect(() => bumpChangelog("# Changelog\n", "0.2.0", "2026-10-22")).toThrow("Unreleased");
    expect(() => bumpChangelog("## Unreleased\n\n## 0.1.0 — 2026-10-22\n\n- Old\n", "0.2.0", "2026-10-23")).toThrow("nothing to release");
  });

  test("patch, minor, and major count up from the current version, and an exact version is used as given", () => {
    expect(nextVersion("0.1.9", "patch")).toBe("0.1.10");
    expect(nextVersion("0.1.9", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.9", "major")).toBe("1.0.0");
    expect(nextVersion("0.1.9", "2.0.1")).toBe("2.0.1");
    expect(() => nextVersion("0.1.9", "huge")).toThrow("patch, minor, major");
    expect(() => nextVersion("beta", "patch")).toThrow("not like 1.2.3");
  });
});

describe("CI workflows", () => {
  const ci = parseYaml(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as any;
  const release = parseYaml(readFileSync(join(root, ".github/workflows/release.yml"), "utf8")) as any;
  const runs = (job: any) => job.steps.map((step: any) => step.run).filter(Boolean);

  test("CI runs on push and pull_request with the pinned toolchain and the stale-bundle check", () => {
    expect(Object.keys(ci.on).sort()).toEqual(["pull_request", "push"]);
    const steps = ci.jobs.test.steps;
    expect(steps[0].uses).toBe("actions/checkout@v7");
    expect(steps[1]).toMatchObject({ uses: "oven-sh/setup-bun@v2", with: { "bun-version-file": ".bun-version" } });
    expect(runs(ci.jobs.test)).toEqual(["bun install --frozen-lockfile", "bun run check", "bun test", "bun run build", "bun run plist", "git diff --exit-code -- Workflow", "bun run package"]);
  });

  test("release is a manual workflow on main that checks, bumps, commits, and publishes with the changelog notes", () => {
    expect(Object.keys(release.on)).toEqual(["workflow_dispatch"]);
    expect(release.on.workflow_dispatch.inputs.bump).toMatchObject({ type: "choice", default: "auto", options: ["auto", "patch", "minor", "major"] });
    expect(release.concurrency["cancel-in-progress"]).toBe(false);
    const job = release.jobs.release;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.permissions).toEqual({ contents: "write" });
    expect(job.env.GH_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    const commands = runs(job);
    expect(commands.slice(0, 6)).toEqual(runs(ci.jobs.test).slice(0, 6));
    const order = ["bun run bump \"$kind\"", "bun run package", 'bun run release:check "$RELEASE_TAG" --no-qa', "git push origin HEAD:main", "gh release create"].map((word) => commands.findIndex((command: string) => command.includes(word)));
    expect(order.every((position: number) => position >= 0)).toBe(true);
    expect([...order].sort((x: number, y: number) => x - y)).toEqual(order);
    expect(commands.find((command: string) => command.includes("gh release create"))).toBe('gh release create "$RELEASE_TAG" dist/AI-Chat.alfredworkflow --target "$(git rev-parse HEAD)" --title "AI Chat $RELEASE_TAG" --notes-file dist/notes.md');
    const uses = job.steps.map((step: any) => step.uses).filter(Boolean);
    expect(uses.every((u: string) => u.startsWith("actions/") || u.startsWith("oven-sh/setup-bun"))).toBe(true);
  });
});
