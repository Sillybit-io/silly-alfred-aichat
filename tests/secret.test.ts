import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunHost } from "../src/host/bun";
import { curlAuthConfig, keyProblem, scrubbedEnv } from "../src/host/common";

const KEY = 'sk-or-v1-s3cr3t"with\\odd';
const work = mkdtempSync(join(tmpdir(), "aichat-secret-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function waitFor(path: string, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(20);
  }
  return existsSync(path);
}

function files(name: string) {
  const dir = join(work, name);
  mkdirSync(dir);
  return { dir, out: join(dir, "out"), pid: join(dir, "pid"), exit: join(dir, "exit"), stderr: join(dir, "stderr") };
}

describe("the API key travels on stdin only", () => {
  test("the curl config escapes quotes and backslashes and rejects control characters", () => {
    expect(curlAuthConfig("sk-abc")).toBe('header = "Authorization: Bearer sk-abc"\n');
    expect(curlAuthConfig(KEY)).toBe('header = "Authorization: Bearer sk-or-v1-s3cr3t\\"with\\\\odd"\n');
    expect(() => curlAuthConfig("a\nb")).toThrow();
    expect(() => curlAuthConfig("a\rb")).toThrow();
    expect(() => curlAuthConfig("")).toThrow();
    expect(keyProblem("a\nb")).toContain("line break");
    expect(keyProblem("sk-ok")).toBeNull();
  });

  test("scrubbedEnv drops the key variable and keeps the rest", () => {
    expect(scrubbedEnv({ openrouter_api_key: "k", PATH: "/bin", gone: undefined })).toEqual({ PATH: "/bin" });
  });

  test("a supervised command gets the key on stdin, and in neither its argv nor its environment", async () => {
    const host = new BunHost({ env: { PATH: process.env.PATH, openrouter_api_key: KEY } });
    const f = files("dump");
    const script = 'd=$1; shift; printf "%s\\n" "$@" > "$d/args"; env > "$d/env"; cat > "$d/stdin"';
    host.spawnSupervised(["/bin/sh", "-c", script, "dump", f.dir, "-K", "-"], f, { stdin: curlAuthConfig(KEY) });
    expect(await waitFor(f.exit)).toBe(true);
    expect(readFileSync(f.exit, "utf8")).toBe("0");
    expect(readFileSync(join(f.dir, "stdin"), "utf8")).toBe(curlAuthConfig(KEY));
    expect(readFileSync(join(f.dir, "args"), "utf8")).not.toContain("s3cr3t");
    const env = readFileSync(join(f.dir, "env"), "utf8");
    expect(env).not.toContain("s3cr3t");
    expect(env).not.toContain("openrouter_api_key");
  });

  test("a supervised command without stdin reads nothing", async () => {
    const host = new BunHost();
    const f = files("nostdin");
    host.spawnSupervised(["/bin/sh", "-c", 'cat > "$1"', "sh", join(f.dir, "got")], f);
    expect(await waitFor(f.exit)).toBe(true);
    expect(readFileSync(join(f.dir, "got"), "utf8")).toBe("");
  });

  test("curl reads the key with -K - and sends it as the Authorization header", async () => {
    let seen = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        seen = request.headers.get("authorization") ?? "";
        return new Response("{}");
      },
    });
    try {
      const host = new BunHost({ env: { PATH: process.env.PATH, openrouter_api_key: KEY } });
      const f = files("curl");
      host.spawnSupervised(["curl", "-o", f.out, "--silent", "--show-error", "-K", "-", `http://127.0.0.1:${server.port}/`], f, { stdin: curlAuthConfig(KEY) });
      expect(await waitFor(f.exit)).toBe(true);
      expect(readFileSync(f.exit, "utf8")).toBe("0");
      expect(seen).toBe(`Bearer ${KEY}`);
    } finally {
      server.stop(true);
    }
  });

  test("while the request runs, ps shows neither the key in the command line nor in the environment", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("data: x\n\n")) }), { headers: { "content-type": "text/event-stream" } }),
    });
    try {
      const host = new BunHost({ env: { PATH: process.env.PATH, openrouter_api_key: KEY } });
      const f = files("ps");
      host.spawnSupervised(["curl", "-o", f.out, "--silent", "-K", "-", `http://127.0.0.1:${server.port}/`], f, { stdin: curlAuthConfig(KEY) });
      expect(await waitFor(f.pid)).toBe(true);
      await waitFor(f.out);
      const pid = Number(readFileSync(f.pid, "utf8"));
      const ps = Bun.spawnSync(["/bin/ps", "eww", "-p", String(pid)]).stdout.toString();
      expect(ps).toContain(f.out);
      expect(ps).not.toContain("s3cr3t");
      const everyone = Bun.spawnSync(["/bin/ps", "ewwax"]).stdout.toString();
      expect(everyone).not.toContain("s3cr3t");
      host.signalTerm(pid);
      expect(await waitFor(f.exit)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("runSync passes stdin to the command and scrubs the key from its environment", () => {
    const host = new BunHost({ env: { PATH: process.env.PATH, openrouter_api_key: KEY } });
    const run = host.runSync(["/bin/sh", "-c", 'cat; printf "|%s" "${openrouter_api_key:-none}"'], { stdin: "hello" });
    expect(run).toEqual({ exit: 0, stdout: "hello|none", stderr: "" });
  });

  test("a fake command sees the stdin it was given", () => {
    let stdin: string | undefined;
    const host = new BunHost({
      fakeCommands: {
        curl: (_args, input) => {
          stdin = input;
          return { exit: 0, stdout: "", stderr: "" };
        },
      },
    });
    host.runSync(["curl", "-K", "-"], { stdin: "x" });
    expect(stdin).toBe("x");
  });

  test("the sources never put the key into a command line", () => {
    for (const path of ["src/store/requests.ts", "src/store/web-query.ts", "src/app/preset-run.ts"]) {
      const source = readFileSync(join(import.meta.dir, "..", path), "utf8");
      expect(source).not.toContain("Authorization: Bearer");
      expect(source).toContain("CURL_STDIN_CONFIG");
    }
  });

  test("the request body is deleted the moment the command ends, whether it worked or not", async () => {
    const host = new BunHost();
    for (const [name, script] of [["ok", "exit 0"], ["failing", "exit 9"]] as const) {
      const f = files(`body-${name}`);
      const body = join(f.dir, "body.json");
      writeFileSync(body, '{"messages":[{"content":"private conversation"}]}');
      host.spawnSupervised(["/bin/sh", "-c", script], { ...f, remove: body });
      expect(await waitFor(f.exit)).toBe(true);
      expect(existsSync(body), name).toBe(false);
    }
  });

  test("files a supervised command writes are private to the user", async () => {
    const host = new BunHost();
    const f = files("private");
    host.spawnSupervised(["/bin/sh", "-c", 'echo x > "$1"', "sh", join(f.dir, "made")], f);
    expect(await waitFor(f.exit)).toBe(true);
    expect([f.pid, f.exit, f.stderr, join(f.dir, "made")].map((path) => statSync(path).mode & 0o777)).toEqual([0o600, 0o600, 0o600, 0o600]);
  });
});
