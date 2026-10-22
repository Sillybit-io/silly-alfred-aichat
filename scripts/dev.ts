import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { BunHost } from "../src/host/bun";

const root = resolve(import.meta.dir, "..");

export function parseEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

type Options = { app: string; args: string[]; fixture: string | null; loop: boolean; frames: boolean };

export function parseArgs(argv: string[]): Options {
  const [app, ...rest] = argv;
  if (!app) throw new Error("usage: bun run dev <app> [args] [--fixture <name>] [--loop] [--frames]");
  const options: Options = { app, args: [], fixture: null, loop: false, frames: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--fixture") options.fixture = rest[++i] ?? null;
    else if (arg === "--loop") options.loop = true;
    else if (arg === "--frames") options.frames = options.loop = true;
    else options.args.push(arg);
  }
  return options;
}

// Alfred hands a script's `variables` to the next run as environment variables; the loop
// mimics that for rerun, which is how Text Views stream.
function nextEnvironment(output: string): Record<string, string> {
  try {
    const parsed = JSON.parse(output) as { variables?: Record<string, unknown> };
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.variables ?? {})) next[key] = String(value);
    return next;
  } catch {
    return {};
  }
}

export async function runDev(argv: string[]): Promise<string[]> {
  const options = parseArgs(argv);
  const dev = resolve(root, ".dev");
  const data = join(dev, "data");
  const cache = join(dev, "cache");
  if (options.fixture !== null) {
    rmSync(data, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
    const seed = join(root, "tests/fixtures/data", options.fixture);
    if (existsSync(seed)) cpSync(seed, data, { recursive: true });
  }
  mkdirSync(data, { recursive: true });
  mkdirSync(cache, { recursive: true });

  const replayArgs = ["bun", join(root, "scripts/replay-server.ts")];
  if (options.fixture !== null) replayArgs.push(join(root, "tests/fixtures/http", options.fixture));
  const server = Bun.spawn(replayArgs, { stdout: "pipe", stderr: "inherit" });
  const port = Number(new TextDecoder().decode((await server.stdout.getReader().read()).value).trim());
  const baseEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    ...parseEnvFile(join(root, "tests/fixtures/dev.env")),
    alfred_workflow_data: data,
    alfred_workflow_cache: cache,
    aichat_api_base: `http://127.0.0.1:${port}/v1`,
  };
  const module = await import(join(root, "src/app", `${options.app}.ts`));
  const frames: string[] = [];
  try {
    let session: Record<string, string> = {};
    for (let round = 0; round < 10000; round++) {
      const host = new BunHost({ env: { ...baseEnv, ...session }, trashDir: join(dev, "trash") });
      const output: string = module.main(host, options.args);
      frames.push(output);
      const rerun = (() => {
        try {
          return Number((JSON.parse(output) as { rerun?: unknown }).rerun ?? 0);
        } catch {
          return 0;
        }
      })();
      if (!options.loop || !(rerun > 0)) break;
      session = { ...session, ...nextEnvironment(output) };
      await Bun.sleep(rerun * 1000);
    }
  } finally {
    server.kill();
  }
  return options.frames ? frames : [frames[frames.length - 1] ?? ""];
}

if (import.meta.main) {
  for (const line of await runDev(process.argv.slice(2))) console.log(line);
  process.exit(0);
}
