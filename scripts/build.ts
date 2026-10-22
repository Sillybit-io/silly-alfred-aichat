import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const SHEBANG = "#!/usr/bin/osascript -l JavaScript";
const RUN_HANDLER = "function run(argv) { return __aichat_main(argv); }";

type Options = { entries: string; out: string };

function parseArgs(argv: string[]): Options {
  const options: Options = { entries: "src/entries", out: "Workflow" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--entries") options.entries = argv[++i] ?? options.entries;
    else if (arg === "--out") options.out = argv[++i] ?? options.out;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

export async function buildEntries(root: string, options: Options): Promise<string[]> {
  const entriesDir = resolve(root, options.entries);
  const outDir = resolve(root, options.out);
  const names = readdirSync(entriesDir)
    .filter((file) => file.endsWith(".ts"))
    .sort();
  if (names.length === 0) throw new Error(`no entries in ${options.entries}`);
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const file of names) {
    const result = await Bun.build({
      entrypoints: [join(entriesDir, file)],
      format: "iife",
      target: "browser",
      minify: false,
    });
    if (!result.success || result.outputs.length !== 1) {
      throw new Error(`build failed for ${file}:\n${result.logs.map(String).join("\n")}`);
    }
    const bundle = (await result.outputs[0]!.text()).trimEnd();
    const target = join(outDir, `${basename(file, ".ts")}.js`);
    writeFileSync(target, [SHEBANG, "var __aichat_main;", bundle, RUN_HANDLER, ""].join("\n"));
    chmodSync(target, 0o755);
    written.push(target);
  }
  return written;
}

if (import.meta.main) {
  const written = await buildEntries(process.cwd(), parseArgs(process.argv.slice(2)));
  for (const target of written) console.log(`built ${target}`);
}
