import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

export function bumpPackageJson(text: string, version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`"${version}" is not a version like 1.2.3`);
  const next = text.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) throw new Error("package.json has no version field");
  return next;
}

// "## Unreleased" becomes "## <version> — <date>"; the notes under it are the release notes.
export function bumpChangelog(text: string, version: string, date: string): string {
  if (!/^## Unreleased[ \t]*$/m.test(text)) throw new Error("CHANGELOG.md has no `## Unreleased` heading to release");
  return text.replace(/^## Unreleased[ \t]*$/m, `## ${version} — ${date}`);
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: bun run bump <version>");
    process.exit(2);
  }
  const date = new Date().toISOString().slice(0, 10);
  const packagePath = resolve(root, "package.json");
  const changelogPath = resolve(root, "CHANGELOG.md");
  writeFileSync(packagePath, bumpPackageJson(readFileSync(packagePath, "utf8"), version));
  writeFileSync(changelogPath, bumpChangelog(readFileSync(changelogPath, "utf8"), version, date));
  const { renderPlist } = await import("./workflow");
  writeFileSync(resolve(root, "Workflow/info.plist"), renderPlist());
  console.log(`version ${version}: package.json, CHANGELOG.md, and Workflow/info.plist updated`);
}
