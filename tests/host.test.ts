import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { main as probe } from "../src/app/probe";
import { BunHost } from "../src/host/bun";
import { SUPERVISOR_SCRIPT, supervisorArgv } from "../src/host/common";
import { startReplayServer } from "../scripts/replay-server";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-host-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function waitFor(path: string, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(20);
  }
  return existsSync(path);
}

let ok: ReturnType<typeof Bun.serve>;
let limited: ReturnType<typeof Bun.serve>;
let stalled: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  ok = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } }),
  });
  limited = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { "retry-after": "17" } }),
  });
  stalled = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: () => new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode(": OPENROUTER PROCESSING\n\n")) }), { headers: { "content-type": "text/event-stream" } }),
  });
});
afterAll(() => {
  ok.stop(true);
  limited.stop(true);
  stalled.stop(true);
});

function files(name: string) {
  const dir = join(work, name);
  mkdirSync(dir);
  return { dir, out: join(dir, "out"), headers: join(dir, "headers"), pid: join(dir, "pid"), exit: join(dir, "exit"), stderr: join(dir, "stderr") };
}

function curl(f: ReturnType<typeof files>, url: string): string[] {
  return ["curl", "-o", f.out, "-D", f.headers, "--silent", "--show-error", "--connect-timeout", "15", url];
}

describe("supervised transport", () => {
  test("a 200 stream ends with exit 0 and the body in out", async () => {
    const host = new BunHost();
    const f = files("ok");
    host.spawnSupervised(curl(f, `http://127.0.0.1:${ok.port}/`), f);
    expect(await waitFor(f.exit)).toBe(true);
    expect(readFileSync(f.exit, "utf8")).toBe("0");
    expect(readFileSync(f.out, "utf8")).toContain("[DONE]");
    expect(readFileSync(f.headers, "utf8")).toContain("200");
    expect(Number(readFileSync(f.pid, "utf8"))).toBeGreaterThan(1);
  });

  test("a 429 ends with exit 0 and Retry-After in the headers file", async () => {
    const host = new BunHost();
    const f = files("limited");
    host.spawnSupervised(curl(f, `http://127.0.0.1:${limited.port}/`), f);
    expect(await waitFor(f.exit)).toBe(true);
    expect(readFileSync(f.exit, "utf8")).toBe("0");
    expect(readFileSync(f.headers, "utf8").toLowerCase()).toContain("retry-after: 17");
    expect(readFileSync(f.headers, "utf8")).toContain("429");
  });

  test("a refused port ends with exit 7", async () => {
    const host = new BunHost();
    const f = files("refused");
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const port = closed.port;
    closed.stop(true);
    host.spawnSupervised(curl(f, `http://127.0.0.1:${port}/`), f);
    expect(await waitFor(f.exit)).toBe(true);
    expect(readFileSync(f.exit, "utf8")).toBe("7");
    expect(readFileSync(f.stderr, "utf8")).not.toBe("");
  });

  test("TERM after processCommand shows the out path ends with an exit above 128, then the process is gone", async () => {
    const host = new BunHost();
    const f = files("term");
    host.spawnSupervised(curl(f, `http://127.0.0.1:${stalled.port}/`), f);
    expect(await waitFor(f.pid)).toBe(true);
    await waitFor(f.out);
    const pid = Number(readFileSync(f.pid, "utf8"));
    expect(host.processCommand(pid)).toContain(f.out);
    expect(host.signalTerm(pid)).toBe(true);
    expect(await waitFor(f.exit)).toBe(true);
    expect(Number(readFileSync(f.exit, "utf8"))).toBeGreaterThan(128);
    expect(host.processCommand(pid)).toBeNull();
  });

  test("a supervisor launched from a parent process that exits at once still writes pid, headers, out, and exit 0", async () => {
    const f = files("orphan");
    const parent = Bun.spawnSync(["bun", join(root, "tests/fixtures/host/launch.ts"), f.out, f.headers, f.pid, f.exit, f.stderr, `http://127.0.0.1:${ok.port}/`]);
    expect(parent.exitCode).toBe(0);
    expect(await waitFor(f.exit)).toBe(true);
    expect(readFileSync(f.exit, "utf8")).toBe("0");
    expect(existsSync(f.pid) && existsSync(f.headers) && existsSync(f.out)).toBe(true);
  });

  test("signalTerm on a pid that already exited returns false without throwing, and processCommand is null", async () => {
    const host = new BunHost();
    const f = files("done");
    host.spawnSupervised(["/bin/sh", "-c", "exit 0"], f);
    expect(await waitFor(f.exit)).toBe(true);
    const pid = Number(readFileSync(f.pid, "utf8"));
    expect(host.signalTerm(pid)).toBe(false);
    expect(host.processCommand(pid)).toBeNull();
    expect(host.signalTerm(0)).toBe(false);
    expect(host.signalTerm(1)).toBe(false);
  });

  test("the supervisor argument vector carries the script and its files", () => {
    const argv = supervisorArgv(["curl", "x"], { pid: "p", exit: "e", stderr: "s" });
    expect(argv.slice(0, 4)).toEqual(["/bin/sh", "-c", SUPERVISOR_SCRIPT, "sh"]);
    expect(argv.slice(4)).toEqual(["p", "e", "s", "curl", "x"]);
    expect(() => supervisorArgv([], { pid: "p", exit: "e", stderr: "s" })).toThrow();
  });
});

describe("file primitives", () => {
  test("writeAtomic and move into a moved-away folder fail and recreate nothing", () => {
    const host = new BunHost();
    const folder = join(work, "chat");
    host.mkdirp(folder);
    host.writeAtomic(join(folder, "chat.json"), "{}");
    renameSync(folder, join(work, "chat-trashed"));
    expect(() => host.writeAtomic(join(folder, "chat.json"), "{}")).toThrow();
    expect(() => host.move(join(work, "chat-trashed", "chat.json"), join(folder, "chat.json"))).toThrow();
    expect(existsSync(folder)).toBe(false);
    expect(readdirSync(join(work, "chat-trashed"))).toEqual(["chat.json"]);
  });

  test("mkdirExclusive returns false the second time and throws for a missing parent", () => {
    const host = new BunHost();
    const lock = join(work, "lock");
    expect(host.mkdirExclusive(lock)).toBe(true);
    expect(host.mkdirExclusive(lock)).toBe(false);
    expect(() => host.mkdirExclusive(join(work, "missing", "lock"))).toThrow();
  });

  test("move refuses an existing target; readBytesFrom reads past an offset only", () => {
    const host = new BunHost();
    host.writeAtomic(join(work, "m1"), "one");
    host.writeAtomic(join(work, "m2"), "two");
    expect(() => host.move(join(work, "m1"), join(work, "m2"))).toThrow();
    expect(readFileSync(join(work, "m2"), "utf8")).toBe("two");
    host.writeAtomic(join(work, "bytes"), Uint8Array.from([1, 2, 3, 4]));
    expect(Array.from(host.readBytesFrom(join(work, "bytes"), 2))).toEqual([3, 4]);
    expect(host.readBytesFrom(join(work, "bytes"), 9)).toHaveLength(0);
  });

  test("trash moves into the trash folder without losing the item", () => {
    const host = new BunHost({ trashDir: join(work, "Trash") });
    writeFileSync(join(work, "victim"), "v");
    host.trash(join(work, "victim"));
    host.writeAtomic(join(work, "victim"), "again");
    host.trash(join(work, "victim"));
    expect(existsSync(join(work, "victim"))).toBe(false);
    expect(readdirSync(join(work, "Trash")).length).toBe(2);
  });

  test("fake commands stand in for macOS tools and fixture hooks feed the pickers", () => {
    const host = new BunHost({
      fakeCommands: { sips: (args) => ({ exit: 0, stdout: `sips ${args.join(" ")}`, stderr: "" }) },
      chooseFiles: () => ({ cancelled: false, paths: ["/tmp/a.png"] }),
      clipboardText: () => "pasted",
    });
    expect(host.runSync(["/usr/bin/sips", "-Z", "10"]).stdout).toBe("sips -Z 10");
    expect(host.chooseFiles()).toEqual({ cancelled: false, paths: ["/tmp/a.png"] });
    expect(host.clipboardText()).toBe("pasted");
    expect(host.clipboardPng()).toBeNull();
    expect(new BunHost().chooseFiles()).toEqual({ cancelled: true });
  });

  test("runSync reports exit codes and a timeout as 124", () => {
    const host = new BunHost();
    expect(host.runSync(["/bin/sh", "-c", "printf a; exit 4"])).toEqual({ exit: 4, stdout: "a", stderr: "" });
    expect(host.runSync(["/bin/sleep", "5"], { timeoutMs: 100 }).exit).toBe(124);
  });
});

describe("probe and replay", () => {
  test("the probe passes every check under the bun host", () => {
    const host = new BunHost({ env: { ...process.env, TMPDIR: work }, trashDir: join(work, "ProbeTrash") });
    const result = JSON.parse(probe(host, []));
    const failed = result.checks.filter((c: { ok: boolean }) => !c.ok);
    expect(failed).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("the replay server answers from a fixture directory with status and headers", async () => {
    const dir = join(work, "fixture");
    mkdirSync(dir);
    writeFileSync(join(dir, "chat_completions.sse"), "data: [DONE]\n\n");
    writeFileSync(join(dir, "chat_completions.status"), "429\n");
    writeFileSync(join(dir, "chat_completions.headers"), "Retry-After: 17\n");
    const server = startReplayServer(dir);
    try {
      const reply = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, { method: "POST" });
      expect(reply.status).toBe(429);
      expect(reply.headers.get("retry-after")).toBe("17");
      expect(await reply.text()).toContain("[DONE]");
      expect((await fetch(`http://127.0.0.1:${server.port}/v1/models`)).status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});
