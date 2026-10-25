import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHistoryAction } from "../src/app/history-action";
import { viewJson } from "../src/app/view";
import { decodeBase64, encodeBase64 } from "../src/core/base64";
import { mapCurlExit } from "../src/core/errors";
import { openArgv, xattrPlist } from "../src/core/imagegen";
import { sha256Hex } from "../src/core/sha256";
import { feed, newFramer } from "../src/core/sse";
import { newStreamState } from "../src/core/stream";
import { BunHost, type BunHostOptions } from "../src/host/bun";
import { curlProtocolArgs, MAX_RESPONSE_BYTES } from "../src/host/common";
import { loadLastResult, saveLastResult } from "../src/app/preset-result";
import { readConfig } from "../src/features/index";
import type { RunOptions, RunResult } from "../src/host/types";
import { chatDir, chatFile, createChat, listSummaries, mutateChat } from "../src/store/chats";
import { listImages } from "../src/store/images";
import { ensureCatalog } from "../src/store/catalog";
import { standaloneMessage } from "../src/store/web-query";
import { main as runPreset } from "../src/app/preset-run";
import { runMaintenance } from "../src/store/maintenance";
import { advance, lanesDir, requestDir, tick, type RequestKind, type RequestRecord } from "../src/store/requests";

const work = mkdtempSync(join(tmpdir(), "aichat-hardening-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const bytes = (text: string) => new TextEncoder().encode(text);

class CountingHost extends BunHost {
  writes: string[] = [];
  reads: string[] = [];
  readText(path: string) {
    this.reads.push(path);
    return super.readText(path);
  }
  writeAtomic(path: string, data: Uint8Array | string) {
    this.writes.push(path);
    super.writeAtomic(path, data);
  }
}

let counter = 0;
function fresh(options: Omit<BunHostOptions, "env"> = {}) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  const host = new CountingHost({ ...options, env: { alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache") } });
  return { dir, host };
}

describe("codecs", () => {
  test("base64 and SHA-256 match the reference on a large input and at every block boundary", () => {
    const big = Uint8Array.from({ length: 3 * 1024 * 1024 + 7 }, (_, i) => (i * 131 + (i >> 9)) & 255);
    expect(encodeBase64(big)).toBe(Buffer.from(big).toString("base64"));
    expect(Buffer.from(decodeBase64(Buffer.from(big).toString("base64"))).equals(Buffer.from(big))).toBe(true);
    expect(sha256Hex(big)).toBe(createHash("sha256").update(big).digest("hex"));
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129]) {
      const input = big.subarray(3, 3 + length);
      expect(sha256Hex(input), `length ${length}`).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });

  test("the framer keeps a partial line compactly and still resumes a record saved with a number array", () => {
    const state = newFramer();
    feed(state, bytes('data: {"a":"é'));
    expect(typeof state.line).toBe("string");
    expect(JSON.stringify(state).length).toBeLessThan(60);
    expect(feed(JSON.parse(JSON.stringify(state)), bytes('"}\n\n'))).toEqual([{ type: "data", data: '{"a":"é"}' }]);
    const old = { line: Array.from(bytes("data: par")), pendingCr: false, data: [] };
    expect(feed(old, bytes("tial\n\n"))).toEqual([{ type: "data", data: "partial" }]);
  });

  test("readBase64 gives the file's own base64", () => {
    const { dir, host } = fresh();
    const path = join(dir, "b.bin");
    writeFileSync(path, Uint8Array.from({ length: 256 }, (_, i) => i));
    expect(host.readBase64(path)).toBe(readFileSync(path).toString("base64"));
  });
});

describe("the streaming tick", () => {
  function openRecord(host: CountingHost, lastGrowthAt: number, kind: RequestKind = "chat"): string {
    const rid = "0000000000000001";
    mkdirSync(lanesDir(host), { recursive: true });
    mkdirSync(requestDir(host, rid), { recursive: true });
    const record: RequestRecord = {
      schema: 1, id: rid, lane: "chat:x", kind, chatId: null, model: "m", draft: { text: "", attachments: [] }, stream: kind === "chat", timeoutSeconds: 90,
      startedAt: lastGrowthAt, lastGrowthAt, offset: 0, framer: newFramer(), reducer: newStreamState(), state: "open", final: false, error: null,
      curlExit: null, httpStatus: null, finalizeAttempts: 0, meta: {},
    };
    writeFileSync(join(requestDir(host, rid), "request.json"), JSON.stringify(record));
    writeFileSync(join(requestDir(host, rid), "pid"), "4242");
    writeFileSync(join(lanesDir(host), "chat:x"), rid);
    return rid;
  }

  test("while the reply is fresh no ps runs, and a tick that read nothing writes no record", () => {
    let ps = 0;
    const { host } = fresh({ fakeCommands: { ps: () => (ps++, { exit: 1, stdout: "", stderr: "" }) } });
    const rid = openRecord(host, Date.now());
    expect(tick(host, rid)!.terminal).toBe(false);
    expect(tick(host, rid)!.terminal).toBe(false);
    expect(ps).toBe(0);
    expect(host.writes.filter((path) => path.endsWith("request.json"))).toEqual([]);
  });

  test("after the grace period the pid is checked, and a gone process ends the request", () => {
    let ps = 0;
    const { host } = fresh({ fakeCommands: { ps: () => (ps++, { exit: 1, stdout: "", stderr: "" }) } });
    const rid = openRecord(host, Date.now() - 10_000);
    expect(tick(host, rid)!.terminal).toBe(true);
    expect(ps).toBeGreaterThan(0);
  });

  test("a tick serializes the record only to save it: never when nothing arrived, once when something did", () => {
    const { host } = fresh({ fakeCommands: { ps: () => ({ exit: 1, stdout: "", stderr: "" }) } });
    const rid = openRecord(host, Date.now());
    const original = JSON.stringify;
    let records = 0;
    JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
      if (typeof value === "object" && value !== null && "reducer" in value) records++;
      return (original as (...args: unknown[]) => string)(value, ...rest);
    }) as typeof JSON.stringify;
    try {
      tick(host, rid);
      expect(records).toBe(0);
      writeFileSync(join(requestDir(host, rid), "out"), 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
      tick(host, rid);
      expect(records).toBe(1);
    } finally {
      JSON.stringify = original;
    }
    expect(host.writes.filter((path) => path.endsWith("request.json")).length).toBe(1);
  });

  // curl before 8.4.0 does not stop a stream with no announced length at --max-filesize, so the loop must.
  test("a stream past the cap ends as too large, keeps its reply so far, and reads nothing beyond the cap", () => {
    const { host } = fresh({ fakeCommands: { ps: () => ({ exit: 1, stdout: "", stderr: "" }) } });
    const rid = openRecord(host, Date.now());
    const reply = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n';
    writeFileSync(join(requestDir(host, rid), "out"), `${reply}:${"a".repeat(MAX_RESPONSE_BYTES)}\n`);
    const result = tick(host, rid)!;
    expect(result.terminal).toBe(true);
    expect(result.record.state).toBe("interrupted");
    expect(result.record.error!.title).toBe("Reply too large");
    expect(result.record.reducer.content).toBe("Hel");
    expect(result.record.offset).toBe(MAX_RESPONSE_BYTES);
  });

  test("a response that is not streamed and is over the cap fails and is never handed to its finalizer", () => {
    const { host } = fresh({ fakeCommands: { ps: () => ({ exit: 1, stdout: "", stderr: "" }) } });
    const rid = openRecord(host, Date.now(), "title");
    writeFileSync(join(requestDir(host, rid), "out"), "x".repeat(MAX_RESPONSE_BYTES + 1));
    let body: string | null = null;
    const step = advance(host, rid, { title: (_host, _record, outcome) => { body = outcome.bodyText; } });
    expect(step.tick!.record.state).toBe("failed");
    expect(step.tick!.record.error!.title).toBe("Reply too large");
    expect(body as string | null).toBe("");
  });

  test("the supervisor's file-size limit stops a command that writes past the cap, whatever writes it", async () => {
    const { dir } = fresh();
    const f = { pid: join(dir, "pid"), exit: join(dir, "exit"), stderr: join(dir, "stderr"), maxBytes: 4096 };
    const out = join(dir, "out");
    new BunHost().spawnSupervised(["/bin/sh", "-c", 'head -c 200000 /dev/zero > "$1"', "sh", out], f);
    for (let i = 0; i < 100 && !existsSync(f.exit); i++) await Bun.sleep(50);
    expect(readFileSync(f.exit, "utf8")).toBe("153");
    expect(statSync(out).size).toBeGreaterThan(4096);
    expect(statSync(out).size).toBeLessThanOrEqual(4096 + 1024);
    expect(mapCurlExit(153).title).toBe("Reply too large");
  });

  test("a bounded read returns at most the bytes asked for", () => {
    const { dir, host } = fresh();
    const path = join(dir, "b.bin");
    writeFileSync(path, Uint8Array.from({ length: 64 }, (_, i) => i));
    expect(Array.from(host.readBytesFrom(path, 10, 4))).toEqual([10, 11, 12, 13]);
    expect(host.readBytesFrom(path, 60, 100).length).toBe(4);
    expect(host.readBytesFrom(path, 0, 0).length).toBe(0);
  });
});

describe("chat summaries", () => {
  test("a deleting process waits for an older cache writer and then removes its private text", async () => {
    const { dir, host } = fresh();
    const chat = createChat(host, { title: "private concurrent title" });
    listSummaries(host);
    createChat(host); // makes the overlapping list save a new cache
    const fixture = join(import.meta.dir, "fixtures", "summary-race.ts");
    const writer = Bun.spawn(["bun", fixture, dir, "write", chat.id], { stdout: "pipe", stderr: "pipe" });
    let deleter: ReturnType<typeof Bun.spawn> | undefined;
    const waitFor = async (path: string) => {
      for (let i = 0; i < 200 && !existsSync(path); i++) await Bun.sleep(10);
      expect(existsSync(path)).toBe(true);
    };
    try {
      await waitFor(join(dir, "writer-ready"));
      deleter = Bun.spawn(["bun", fixture, dir, "delete", chat.id], { stdout: "pipe", stderr: "pipe" });
      await waitFor(join(dir, "delete-waiting"));
      writeFileSync(join(dir, "resume"), "1");
      expect(await writer.exited).toBe(0);
      expect(await deleter.exited).toBe(0);
      expect(existsSync(chatDir(host, chat.id))).toBe(false);
      expect(readFileSync(join(dir, "cache", "summaries.json"), "utf8")).not.toContain("private concurrent title");
    } finally {
      writer.kill();
      deleter?.kill();
    }
  });
  test("the cache reuses unchanged chats, sees a change, and forgets a deleted chat", () => {
    const { dir, host } = fresh();
    const a = createChat(host);
    const b = createChat(host);
    expect(listSummaries(host).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    const cache = join(dir, "cache", "summaries.json");
    expect(existsSync(cache)).toBe(true);
    mutateChat(host, a.id, (chat) => {
      chat.title = "Renamed after the cache was written";
    });
    utimesSync(chatFile(host, a.id), new Date(), new Date(Date.now() + 5000));
    expect(listSummaries(host).find((s) => s.id === a.id)!.title).toBe("Renamed after the cache was written");
    rmSync(join(dir, "data", "chats", b.id), { recursive: true });
    expect(listSummaries(host).map((s) => s.id)).toEqual([a.id]);
    expect(Object.keys(JSON.parse(readFileSync(cache, "utf8")).entries)).toEqual([a.id]);
  });

  test("a deleted chat leaves the cache at once, and the cache goes when the chats folder does", () => {
    const { dir, host } = fresh();
    const chat = createChat(host);
    mutateChat(host, chat.id, (c) => {
      c.title = "private title";
    });
    listSummaries(host);
    const cache = join(dir, "cache", "summaries.json");
    expect(readFileSync(cache, "utf8")).toContain("private title");
    applyHistoryAction(host, "delete", chatDir(host, chat.id));
    expect(readFileSync(cache, "utf8")).not.toContain("private title");
    createChat(host);
    listSummaries(host);
    rmSync(join(dir, "data", "chats"), { recursive: true });
    expect(listSummaries(host)).toEqual([]);
    expect(existsSync(cache)).toBe(false);
  });

  test("an unchanged chat is not read again, and a cache entry that is not a summary is not trusted", () => {
    const { dir, host } = fresh();
    const chat = createChat(host);
    listSummaries(host);
    host.reads = [];
    listSummaries(host);
    expect(host.reads.filter((path) => path.endsWith("chat.json"))).toEqual([]);
    const cache = join(dir, "cache", "summaries.json");
    const parsed = JSON.parse(readFileSync(cache, "utf8"));
    parsed.entries[chat.id].summary = "junk";
    writeFileSync(cache, JSON.stringify(parsed));
    expect(listSummaries(host)[0]!.id).toBe(chat.id);
  });

  test("without a cache folder the list still works", () => {
    const dir = join(work, `case-${counter++}`);
    const host = new BunHost({ env: { alfred_workflow_data: join(dir, "data") } });
    const chat = createChat(host);
    expect(listSummaries(host).map((s) => s.id)).toEqual([chat.id]);
  });
});

describe("gallery prompts", () => {
  function gallery(answers: RunResult[]) {
    let calls = 0;
    const { dir, host } = fresh({ fakeCommands: { xattr: () => answers[Math.min(calls++, answers.length - 1)]! } });
    const folder = join(dir, "images");
    mkdirSync(folder);
    writeFileSync(join(folder, "a.png"), "png");
    const config = { ...readConfig(host), imagesFolder: folder };
    return { dir, host, folder, config, calls: () => calls };
  }
  const prompt = (text: string): RunResult => ({ exit: 0, stdout: xattrPlist(text), stderr: "" });

  test("a cached prompt is used until the file's metadata changes, and a removed prompt is seen", () => {
    const g = gallery([prompt("private prompt"), { exit: 1, stdout: "", stderr: "No such xattr" }]);
    expect(listImages(g.host, g.config, 8)[0]!.prompt).toBe("private prompt");
    expect(listImages(g.host, g.config, 8)[0]!.prompt).toBe("private prompt");
    expect(g.calls()).toBe(1);
    // Removing an extended attribute changes ctime and leaves mtime alone; chmod does the same here.
    const mtime = statSync(join(g.folder, "a.png")).mtimeMs;
    chmodSync(join(g.folder, "a.png"), 0o640);
    expect(statSync(join(g.folder, "a.png")).mtimeMs).toBe(mtime);
    expect(listImages(g.host, g.config, 8)[0]!.prompt).toBe("");
    expect(g.calls()).toBe(2);
    expect(readFileSync(join(g.dir, "cache", "image-prompts.json"), "utf8")).not.toContain("private prompt");
  });

  test("an xattr that could not answer is asked again, and the cache goes with the images folder", () => {
    const g = gallery([{ exit: 124, stdout: "", stderr: "" }, prompt("later")]);
    expect(listImages(g.host, g.config, 8)[0]!.prompt).toBe("");
    expect(listImages(g.host, g.config, 8)[0]!.prompt).toBe("later");
    expect(g.calls()).toBe(2);
    rmSync(g.folder, { recursive: true });
    expect(listImages(g.host, g.config, 8)).toEqual([]);
    expect(existsSync(join(g.dir, "cache", "image-prompts.json"))).toBe(false);
  });
  test("exit-1 I/O and permission failures are retried even when metadata has not changed", () => {
    for (const stderr of ["Input/output error", "Permission denied", "No such xattr"]) {
      const g = gallery([{ exit: 1, stdout: "", stderr }, prompt("recovered")]);
      expect(listImages(g.host, g.config, 8)[0]!.prompt).toBe("");
      expect(listImages(g.host, g.config, 8)[0]!.prompt).toBe("recovered");
      expect(g.calls()).toBe(2);
    }
  });
});

describe("bounded synchronous commands", () => {
  test("a legacy-curl-like writer cannot exceed the cap on stdout, stderr, or a named output file", () => {
    const { dir, host } = fresh();
    const options = { maxBytes: 4096, timeoutMs: 5000 };
    for (const redirect of ["", "1>&2"]) {
      const result = host.runSync(["/bin/sh", "-c", `exec /bin/dd if=/dev/zero bs=1024 count=100 ${redirect}`], options);
      expect(result).toEqual({ exit: 63, stdout: "", stderr: "" });
    }
    const out = join(dir, "download");
    host.runSync(["/bin/sh", "-c", 'exec /bin/dd if=/dev/zero bs=1024 count=100 > "$1"', "sh", out], options);
    expect(statSync(out).size).toBeGreaterThan(4096);
    expect(statSync(out).size).toBeLessThanOrEqual(4608);
  });

  test("capture checks bytes before decoding, preserves stdin/exit codes, and times out", () => {
    const { host } = fresh();
    expect(host.runSync(["/bin/sh", "-c", "printf 'ééé'"], { maxBytes: 4 }).exit).toBe(63);
    expect(host.runSync(["/bin/sh", "-c", "printf 'éé'"], { maxBytes: 4 })).toEqual({ exit: 0, stdout: "éé", stderr: "" });
    expect(host.runSync(["/bin/sh", "-c", "/bin/cat; printf err >&2; exit 7"], { maxBytes: 4096, stdin: "input" })).toEqual({ exit: 7, stdout: "input", stderr: "err" });
    expect(host.runSync(["/bin/sleep", "5"], { maxBytes: 4096, timeoutMs: 50 }).exit).toBe(124);
  });

  test("cold catalog, presets, and rewrites all request the host's byte limit", () => {
    const { dir } = fresh();
    const caps: (number | undefined)[] = [];
    class InspectHost extends BunHost {
      runSync(argv: string[], options: RunOptions = {}): RunResult {
        caps.push(options.maxBytes);
        return { exit: 63, stdout: "", stderr: "" };
      }
    }
    const host = new InspectHost({ env: { alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), openrouter_api_key: "synthetic", preset_id: "translate" } });
    expect(ensureCatalog(host).note).toContain("Reply too large");
    expect(standaloneMessage(host, "synthetic", "standard", "model", [{ role: "user", content: "Earlier" }], "Follow up").text).toBeNull();
    expect(runPreset(host, ["Translate this"])).toContain("Reply too large");
    expect(caps).toEqual([MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES]);
  });
});

describe("small hardening", () => {
  test("a history action refuses an argument that is not a chat id", () => {
    const { host } = fresh();
    for (const arg of ["", ".", "..", "/x/..", "a b", "../../chats"]) expect(applyHistoryAction(host, "delete", arg).notice).toBe("That chat no longer exists");
  });

  test("the footer is one plain line", () => {
    const footer = JSON.parse(viewJson({ response: "", footer: "a\nb\u0007c\u2028d", mode: "replace", requestId: "", stage: "" })).footer;
    expect(footer).toBe("a b c d");
  });

  test("an SVG is revealed rather than opened, curl keeps a TLS floor, and an oversized reply has a clear error", () => {
    expect(openArgv("/p/a.svg")).toEqual(["/usr/bin/open", "-R", "/p/a.svg"]);
    expect(openArgv("/p/a.png")).toEqual(["/usr/bin/open", "/p/a.png"]);
    expect(curlProtocolArgs("https://openrouter.ai/api/v1")).toContain("--tlsv1.2");
    expect(mapCurlExit(63).title).toBe("Reply too large");
  });

  // The hourly sweep has just run, so these go through the gate that skips it, as a real second visit would.
  test("a preset reply an hour old is deleted by the next run of the workflow, even between hourly sweeps", () => {
    const { dir, host } = fresh();
    const path = join(dir, "data", "last-preset.json");
    runMaintenance(host);
    saveLastResult(host, "x", "secret");
    runMaintenance(host);
    expect(loadLastResult(host)?.reply).toBe("secret");
    const old = new Date(Date.now() - 61 * 60 * 1000);
    utimesSync(path, old, old);
    expect(existsSync(join(dir, "data", ".swept"))).toBe(true);
    runMaintenance(host);
    expect(existsSync(path)).toBe(false);
  });

  test("a preset reply an hour old is never shown, even when nothing has run since", () => {
    const { dir, host } = fresh();
    const path = join(dir, "data", "last-preset.json");
    saveLastResult(host, "x", "secret");
    const old = new Date(Date.now() - 61 * 60 * 1000);
    utimesSync(path, old, old);
    expect(loadLastResult(host)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });
});
