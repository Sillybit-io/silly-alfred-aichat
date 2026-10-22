import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

export function bumpPackageJson(text: string, version: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`"${version}" is not a version like 1.2.3`);
  const next = text.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) throw new Error("package.json has no version field");
  return next;
}

// A version like 1.2.3 is used as given; patch, minor, and major count up from the current one.
export function nextVersion(current: string, kind: string): string {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!parts) throw new Error(`The current version "${current}" is not like 1.2.3`);
  const [major, minor, patch] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`"${kind}" is not patch, minor, major, or a version like 1.2.3`);
}

// "## Unreleased" becomes "## <version> — <date>", with a fresh, empty "## Unreleased" above it; the notes are the release notes.
export function bumpChangelog(text: string, version: string, date: string): string {
  const heading = /^## Unreleased[ \t]*$/m.exec(text);
  if (!heading) throw new Error("CHANGELOG.md has no `## Unreleased` heading to release");
  const rest = text.slice(heading.index + heading[0].length);
  const next = rest.search(/^## /m);
  if ((next < 0 ? rest : rest.slice(0, next)).trim() === "") throw new Error("CHANGELOG.md has no notes under `## Unreleased`, so there is nothing to release");
  return text.replace(/^## Unreleased[ \t]*$/m, `## Unreleased\n\n## ${version} — ${date}`);
}

if (import.meta.main) {
  const kind = process.argv[2];
  if (!kind) {
    console.error("usage: bun run bump <patch | minor | major | 1.2.3>");
    process.exit(2);
  }
  const date = new Date().toISOString().slice(0, 10);
  const packagePath = resolve(root, "package.json");
  const changelogPath = resolve(root, "CHANGELOG.md");
  const packageText = readFileSync(packagePath, "utf8");
  const version = nextVersion((JSON.parse(packageText) as { version: string }).version, kind);
  writeFileSync(packagePath, bumpPackageJson(packageText, version));
  const changelog = readFileSync(changelogPath, "utf8");
  // A changelog that already has this version was bumped by an earlier run that did not finish publishing.
  const alreadyBumped = new RegExp(`^## ${version.replace(/\./g, "\\.")}( — \\d{4}-\\d{2}-\\d{2})?\\s*$`, "m").test(changelog);
  if (!alreadyBumped) writeFileSync(changelogPath, bumpChangelog(changelog, version, date));
  const { renderPlist } = await import("./workflow");
  writeFileSync(resolve(root, "Workflow/info.plist"), renderPlist());
  console.log(`version ${version}: package.json, CHANGELOG.md, and Workflow/info.plist updated`);
}
