import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parsePlist } from "plist";
import { verifyRecord, type VerifyOptions } from "./qa";

const root = resolve(import.meta.dir, "..");

export function changelogSection(changelog: string, version: string): string | null {
  const heading = new RegExp(`^## ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( — \\d{4}-\\d{2}-\\d{2})?\\s*$`);
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

export type ReleaseCheck = { errors: string[]; notes: string | null };

// A tag publishes only when the tag, package.json, info.plist, and CHANGELOG agree. The manual QA record is kept out
// of the repository, so CI runs this with --no-qa and the owner runs it without the flag before tagging.
export async function checkRelease(projectRoot: string, tag: string, options: VerifyOptions & { skipQa?: boolean } = {}): Promise<ReleaseCheck> {
  const errors: string[] = [];
  const version = (JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8")) as { version: string }).version;
  if (tag !== `v${version}`) errors.push(`Version mismatch: the tag is ${tag} but package.json says v${version}.`);
  const plistVersion = (parsePlist(readFileSync(join(projectRoot, "Workflow/info.plist"), "utf8")) as { version?: string }).version;
  if (plistVersion !== version) errors.push(`Version mismatch: Workflow/info.plist says ${plistVersion ?? "nothing"} but package.json says ${version}. Run \`bun run plist\`.`);
  const changelogPath = join(projectRoot, "CHANGELOG.md");
  const notes = existsSync(changelogPath) ? changelogSection(readFileSync(changelogPath, "utf8"), version) : null;
  if (notes === null) errors.push(`Version mismatch: CHANGELOG.md has no "## ${version} — <date>" heading. Run \`bun run bump ${version}\`.`);
  else if (notes === "") errors.push(`CHANGELOG.md has no notes under ${version}.`);
  if (errors.length === 0 && !options.skipQa) errors.push(...(await verifyRecord(projectRoot, version, options)));
  return { errors, notes: errors.length === 0 ? notes : null };
}

if (import.meta.main) {
  const skipQa = process.argv.includes("--no-qa");
  const tag = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (!tag) {
    console.error("usage: bun run release:check <tag>");
    process.exit(2);
  }
  const result = await checkRelease(root, tag, { skipQa });
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`✗ ${error}`);
    process.exit(1);
  }
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist/notes.md"), `${result.notes}\n`);
  console.log(`${tag} is ready to publish${skipQa ? " (manual QA record not checked here)" : ""}; notes written to dist/notes.md`);
}
