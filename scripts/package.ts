import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build as buildPlist, parse as parsePlist } from "plist";
import { buildEntries } from "./build";
import { zipFiles, type ZipEntry } from "./zip";

const root = resolve(import.meta.dir, "..");
export const ARCHIVE = "dist/AI-Chat.alfredworkflow";

export type Packaged = { path: string; entries: ZipEntry[]; sha256: string; contentDigest: string };

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

// Alfred's own export rule: variables named in variablesdontexport ship empty, in the variables
// dictionary and as configuration defaults.
export function blankExported(infoPlist: string): string {
  const info = parsePlist(infoPlist) as Record<string, unknown>;
  const names = new Set(Array.isArray(info.variablesdontexport) ? (info.variablesdontexport as string[]) : []);
  if (names.size === 0) return infoPlist;
  const variables = (info.variables ?? {}) as Record<string, unknown>;
  for (const name of names) if (name in variables) variables[name] = "";
  const fields = Array.isArray(info.userconfigurationconfig) ? (info.userconfigurationconfig as { variable?: string; config?: Record<string, unknown> }[]) : [];
  for (const field of fields) if (field.variable && names.has(field.variable) && field.config && "default" in field.config) field.config.default = "";
  return `${buildPlist(sortKeys(info) as Record<string, unknown>)}\n`;
}

function listFiles(folder: string, base = folder): string[] {
  const found: string[] = [];
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) found.push(...listFiles(path, base));
    else found.push(relative(base, path).split("\\").join("/"));
  }
  return found;
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

// SHA-256 over the sorted entry names and each entry's own SHA-256; the screenshots in images/ are left out.
export function contentDigest(entries: ZipEntry[]): string {
  const lines = entries
    .filter((entry) => !entry.name.startsWith("images/"))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => `${entry.name}\n${sha256(entry.data)}\n`);
  return sha256(lines.join(""));
}

// Zips the contents of a Workflow folder (never the folder itself) without prefs.plist or hidden files.
export function packageWorkflow(options: { workflowDir: string; out: string }): Packaged {
  const staging = mkdtempSync(join(tmpdir(), "aichat-package-"));
  try {
    const copy = join(staging, "Workflow");
    cpSync(options.workflowDir, copy, { recursive: true });
    rmSync(join(copy, "prefs.plist"), { force: true });
    const infoPath = join(copy, "info.plist");
    writeFileSync(infoPath, blankExported(readFileSync(infoPath, "utf8")));
    const entries: ZipEntry[] = listFiles(copy)
      .filter((name) => name.split("/").every((part) => !part.startsWith(".")))
      .map((name) => {
        const path = join(copy, name);
        return { name, data: new Uint8Array(readFileSync(path)), mode: statSync(path).mode & 0o111 ? 0o755 : 0o644 };
      });
    const archive = zipFiles(entries);
    mkdirSync(resolve(options.out, ".."), { recursive: true });
    writeFileSync(options.out, archive);
    return { path: options.out, entries, sha256: sha256(archive), contentDigest: contentDigest(entries) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function packageProject(projectRoot = root): Promise<Packaged> {
  await buildEntries(projectRoot, { entries: "src/entries", out: "Workflow" });
  const { renderPlist } = await import("./workflow");
  writeFileSync(join(projectRoot, "Workflow/info.plist"), renderPlist());
  return packageWorkflow({ workflowDir: join(projectRoot, "Workflow"), out: join(projectRoot, ARCHIVE) });
}

if (import.meta.main) {
  const packaged = await packageProject();
  console.log(`packaged ${packaged.path} (${packaged.entries.length} files, sha256 ${packaged.sha256})`);
}
