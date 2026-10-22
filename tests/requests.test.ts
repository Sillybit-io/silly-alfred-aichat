import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BunHost } from "../src/host/bun";
import { createChat, getChat, mutateChat, type AttachmentRef } from "../src/store/chats";
import { finalize, laneRecordId, requestDir, tick } from "../src/store/requests";

const worker = resolve(import.meta.dir, "fixtures/store/requests-worker.ts");
const work = mkdtempSync(join(tmpdir(), "aichat-requests-"));
const encoder = new TextEncoder();
const frame = (data: unknown) => encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
const delta = (content: string) => frame({ choices: [{ delta: { content }, finish_reason: null }] });
const usage = frame({ choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { total_tokens: 3 } });
const keepalive = encoder.encode(": OPENROUTER PROCESSING\n\n");
const sse = { headers: { "content-type": "text/event-stream" } };

function scripted(steps: { wait?: number; send?: Uint8Array; end?: boolean }[]): Response {
  let cancelled = false;
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const step of steps) {
          if (cancelled) return;
          if (step.wait) await Bun.sleep(step.wait);
          if (step.send) controller.enqueue(step.send);
          if (step.end) controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    }),
    sse,
  );
}

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      await request.arrayBuffer();
      switch (new URL(request.url).pathname) {
        case "/ok":
          return scripted([{ send: keepalive }, { send: delta("Hel") }, { send: delta("lo") }, { send: usage }, { send: frame("[DONE]"), end: true }]);
        case "/slow":
          return scripted([{ send: delta("a") }, { wait: 500, send: delta("b") }, { wait: 500, send: delta("c") }, { send: usage }, { send: frame("[DONE]"), end: true }]);
        case "/keepalive":
          return scripted([{ send: keepalive }, { wait: 400, send: keepalive }, { wait: 400, send: keepalive }, { wait: 400, send: keepalive }, { wait: 400, send: delta("late") }, { send: frame("[DONE]"), end: true }]);
        case "/429":
          return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { "retry-after": "17", "content-type": "application/json" } });
        case "/401":
          return new Response('{"error":{"message":"No auth"}}', { status: 401, headers: { "content-type": "application/json" } });
        case "/stall":
          return scripted([{ send: keepalive }]);
        case "/silent":
          return scripted([]);
        case "/partial-hang":
          return scripted([{ send: delta("part") }]);
        case "/errorchunk":
          return scripted([{ send: delta("part") }, { send: frame({ error: { code: "server_error", message: "Provider disconnected unexpectedly" }, choices: [{ delta: { content: "" }, finish_reason: "error" }] }) }]);
        case "/cutoff":
          return scripted([{ send: delta("half"), end: true }]);
        case "/json":
          return new Response('{"data":[{"b64_json":"AAAA"}]}', { headers: { "content-type": "application/json" } });
        default:
          return new Response("no route", { status: 404 });
      }
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});

let counter = 0;
function fresh() {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(dir);
  const data = join(dir, "data");
  const host = new BunHost({ env: { alfred_workflow_data: data, alfred_workflow_cache: join(dir, "cache") }, trashDir: join(dir, "Trash") });
  const chat = createChat(host, { model: "test/model" });
  return { dir, data, host, chat };
}

async function call(data: string, command: string, args: Record<string, unknown> = {}): Promise<any> {
  const proc = Bun.spawn(["bun", worker, data, command, JSON.stringify(args)], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`worker ${command} failed: ${err}`);
  return JSON.parse(out.trim().split("\n").pop()!);
}

const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

async function send(env: ReturnType<typeof fresh>, path: string, extra: Record<string, unknown> = {}) {
  const admitted = await call(env.data, "admit", { lane: `chat:${env.chat.id}`, chatId: env.chat.id, url: url(path), ...extra });
  expect(admitted.ok).toBe(true);
  return admitted.rid as string;
}

async function drive(env: ReturnType<typeof fresh>, rid: string, limitMs = 12000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const step = await call(env.data, "advance", { rid });
    if (step.finalize?.finalized) return step.finalize;
    await Bun.sleep(40);
  }
  throw new Error("request never finalized");
}

const png: AttachmentRef = { name: "shot.png", kind: "image", mime: "image/png", size: 10, sha: "abc", file: "attachments/abc.png" };

describe("request supervisor", () => {
  test("happy: keep-alives and content reach done, commit one user and one assistant turn tagged with the request id, and remove the record folder", async () => {
    const env = fresh();
    const rid = await send(env, "/ok", { text: "hi there" });
    const result = await drive(env, rid);
    expect(result.outcome.state).toBe("done");
    const chat = getChat(env.host, env.chat.id)!;
    expect(chat.messages.map((m) => [m.role, m.content, m.requestId, m.status])).toEqual([
      ["user", "hi there", rid, "ok"],
      ["assistant", "Hello", rid, "ok"],
    ]);
    expect(chat.retry).toBeNull();
    expect(existsSync(requestDir(env.host, rid))).toBe(false);
    expect(laneRecordId(env.host, `chat:${env.chat.id}`)).toBeNull();
    expect(JSON.stringify(chat)).not.toMatch(/usage|total_tokens/);
  });

  test("close-and-reopen-resumes: each tick runs in its own process and the stream resumes from the saved offset", async () => {
    const env = fresh();
    const rid = await send(env, "/slow");
    let partial = "";
    let offset = 0;
    const deadline = Date.now() + 12000;
    let finalized = false;
    while (Date.now() < deadline && !finalized) {
      const step = await call(env.data, "advance", { rid });
      if (step.tick && step.tick.record.reducer.content.length > partial.length) {
        expect(step.tick.record.reducer.content.startsWith(partial)).toBe(true);
        expect(step.tick.record.offset).toBeGreaterThanOrEqual(offset);
        partial = step.tick.record.reducer.content;
        offset = step.tick.record.offset;
      }
      finalized = Boolean(step.finalize?.finalized);
      await Bun.sleep(100);
    }
    expect(finalized).toBe(true);
    expect(partial.length).toBeGreaterThanOrEqual(1);
    expect(getChat(env.host, env.chat.id)!.messages.map((m) => m.content)).toEqual(["hello", "abc"]);
  });

  test("keep-alive-only streams do not stall: comments count as liveness", async () => {
    const env = fresh();
    const rid = await send(env, "/keepalive", { timeoutSeconds: 1 });
    const result = await drive(env, rid);
    expect(result.outcome.state).toBe("done");
    expect(getChat(env.host, env.chat.id)!.messages[1]!.content).toBe("late");
  });

  test("fail-before-token-keeps-draft: a 429 ends failed with no chat change and a retry record holding the draft text and attachment refs", async () => {
    const env = fresh();
    const rid = await send(env, "/429", { text: "draft text", attachments: [png] });
    const result = await drive(env, rid);
    expect(result.outcome.state).toBe("failed");
    expect(result.outcome.error.title).toBe("Rate limited");
    expect(result.outcome.error.next).toContain("retry in 17 s");
    const chat = getChat(env.host, env.chat.id)!;
    expect(chat.messages).toEqual([]);
    expect(chat.retry).toMatchObject({ requestId: rid, text: "draft text", attachments: [png], model: "test/model" });
    expect(chat.retry!.error).toContain("Rate limited");
    expect(existsSync(requestDir(env.host, rid))).toBe(false);
  });

  test("a 401 maps to Invalid API key and keeps the draft", async () => {
    const env = fresh();
    const result = await drive(env, await send(env, "/401", { text: "keep me" }));
    expect(result.outcome.error.title).toBe("Invalid API key");
    expect(getChat(env.host, env.chat.id)!.retry!.text).toBe("keep me");
  });

  test("retry-after-input-replaced: other text sent meanwhile leaves the kept draft; only its resend clears it", async () => {
    const env = fresh();
    const failed = await send(env, "/401", { text: "original" });
    await drive(env, failed);
    const keptId = getChat(env.host, env.chat.id)!.retry!.requestId;
    await drive(env, await send(env, "/ok", { text: "something else" }));
    expect(getChat(env.host, env.chat.id)!.retry!.text).toBe("original");
    await drive(env, await send(env, "/ok", { text: "original", meta: { retryOf: keptId } }));
    const chat = getChat(env.host, env.chat.id)!;
    expect(chat.retry).toBeNull();
    expect(chat.messages.map((m) => m.content).filter((c) => c === "original")).toHaveLength(1);
  });

  test("refused-with-empty-body-fails: a refused connection ends failed instead of polling forever", async () => {
    const env = fresh();
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = closed.port;
    closed.stop(true);
    const rid = (await call(env.data, "admit", { lane: `chat:${env.chat.id}`, chatId: env.chat.id, url: `http://127.0.0.1:${port}/x` })).rid;
    const result = await drive(env, rid);
    expect(result.outcome.state).toBe("failed");
    expect(result.record.curlExit).toBe(7);
    expect(result.outcome.error.title).toBe("Cannot reach OpenRouter");
    expect(getChat(env.host, env.chat.id)!.messages).toEqual([]);
  });

  test("stop-after-completion-is-noop: the sentinel is not written and nothing is signalled", async () => {
    const env = fresh();
    const rid = await send(env, "/ok");
    await drive(env, rid);
    expect(await call(env.data, "stop", { rid })).toEqual({ sentinel: false, signalled: false });
    expect(getChat(env.host, env.chat.id)!.messages).toHaveLength(2);
  });

  test("stop mid-stream signals the owned process and commits the partial reply marked stopped", async () => {
    const env = fresh();
    const rid = await send(env, "/partial-hang");
    let seen = "";
    for (let i = 0; i < 200 && seen === ""; i++) {
      seen = (await call(env.data, "tick", { rid })).record.reducer.content;
      await Bun.sleep(30);
    }
    expect(seen).toBe("part");
    const stopped = await call(env.data, "stop", { rid });
    expect(stopped).toEqual({ sentinel: true, signalled: true });
    const result = await drive(env, rid);
    expect(result.outcome.state).toBe("stopped");
    const last = getChat(env.host, env.chat.id)!.messages.at(-1)!;
    expect([last.content, last.status]).toEqual(["part", "stopped"]);
  });

  test("stale-pid-not-signalled: a pid that now belongs to another process gets no signal, and the sentinel alone ends the request", async () => {
    const env = fresh();
    const rid = await send(env, "/stall");
    const pidFile = join(requestDir(env.host, rid), "pid");
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await Bun.sleep(20);
    const realPid = Number(readFileSync(pidFile, "utf8"));
    const bystander = Bun.spawn(["sleep", "30"]);
    try {
      env.host.writeAtomic(pidFile, String(bystander.pid));
      const stopped = await call(env.data, "stop", { rid });
      expect(stopped).toEqual({ sentinel: true, signalled: false });
      expect(() => process.kill(bystander.pid, 0)).not.toThrow();
      const result = await drive(env, rid);
      expect(result.outcome.state).toBe("stopped");
      expect(() => process.kill(bystander.pid, 0)).not.toThrow();
    } finally {
      bystander.kill();
      try {
        process.kill(realPid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  });

  test("finalize-twice-commits-once, including a crash between the commit and the cleanup", async () => {
    const env = fresh();
    const rid = await send(env, "/ok", { text: "once" });
    let terminal = false;
    for (let i = 0; i < 300 && !terminal; i++) {
      terminal = (await call(env.data, "tick", { rid })).terminal;
      await Bun.sleep(30);
    }
    expect(terminal).toBe(true);
    const crashing = new BunHost({ env: env.host.env });
    const realRemove = crashing.remove.bind(crashing);
    crashing.remove = (path: string) => {
      if (path === requestDir(crashing, rid)) throw new Error("crash before cleanup");
      realRemove(path);
    };
    expect(() => finalize(crashing, rid)).toThrow("crash before cleanup");
    expect(getChat(env.host, env.chat.id)!.messages).toHaveLength(2);
    const second = await call(env.data, "finalize", { rid });
    expect(second.finalized).toBe(true);
    expect(second.committed).toBe(false);
    expect((await call(env.data, "finalize", { rid })).finalized).toBe(false);
    expect(getChat(env.host, env.chat.id)!.messages.map((m) => m.requestId)).toEqual([rid, rid]);
  });

  test("second-request-same-lane-refused while the first is open; admission finalizes an ended record first", async () => {
    const env = fresh();
    const first = await send(env, "/stall");
    const refused = await call(env.data, "admit", { lane: `chat:${env.chat.id}`, chatId: env.chat.id, url: url("/ok") });
    expect(refused).toEqual({ ok: false, reason: "busy", rid: first });
    await call(env.data, "stop", { rid: first });
    await Bun.sleep(100);
    const second = await call(env.data, "admit", { lane: `chat:${env.chat.id}`, chatId: env.chat.id, url: url("/ok"), text: "next" });
    expect(second.ok).toBe(true);
    expect(second.rid).not.toBe(first);
    await drive(env, second.rid);
    expect(existsSync(requestDir(env.host, first))).toBe(false);
  });

  test("a stream with an error chunk after content ends interrupted and keeps the partial reply", async () => {
    const env = fresh();
    const result = await drive(env, await send(env, "/errorchunk"));
    expect(result.outcome.state).toBe("interrupted");
    const last = getChat(env.host, env.chat.id)!.messages.at(-1)!;
    expect([last.content, last.status]).toEqual(["part", "interrupted"]);
    expect(last.error).toContain("Provider disconnected unexpectedly");
  });

  test("output that ends without DONE after content is interrupted, and with no content it fails and keeps the draft", async () => {
    const env = fresh();
    const result = await drive(env, await send(env, "/cutoff"));
    expect(result.outcome.state).toBe("interrupted");
    expect(getChat(env.host, env.chat.id)!.messages.at(-1)!.content).toBe("half");
    const silent = fresh();
    const failed = await drive(silent, await send(silent, "/silent", { timeoutSeconds: 1, text: "wait" }), 15000);
    expect(failed.outcome.state).toBe("failed");
    expect(getChat(silent.host, silent.chat.id)!.retry!.text).toBe("wait");
  });

  test("admission takes the chat's pending attachment refs", async () => {
    const env = fresh();
    mutateChat(env.host, env.chat.id, (chat) => {
      chat.pending.push(png, { ...png, sha: "def" });
    });
    const rid = await send(env, "/ok", { attachments: [png], takePending: true });
    expect(getChat(env.host, env.chat.id)!.pending.map((ref) => ref.sha)).toEqual(["def"]);
    await drive(env, rid);
    expect(getChat(env.host, env.chat.id)!.messages[0]!.attachments).toEqual([png]);
  });

  test("title and image requests reuse the lifecycle and hand their outcome to the registered finalizer", async () => {
    const env = fresh();
    const admitted = await call(env.data, "admit", { lane: `title:${env.chat.id}`, kind: "title", chatId: env.chat.id, url: url("/json"), stream: false, timeoutSeconds: 30, meta: { want: "title" } });
    const done = await drive(env, admitted.rid);
    expect(done.outcome.state).toBe("done");
    const recorded = JSON.parse(readFileSync(join(env.data, `finalized-title-${admitted.rid}.json`), "utf8"));
    expect(recorded.meta).toEqual({ want: "title" });
    expect(recorded.outcome.bodyText).toContain("b64_json");

    const failedImage = await call(env.data, "admit", { lane: "image", kind: "image", url: url("/429"), stream: false, timeoutSeconds: 30, text: "a cat" });
    const failed = await drive(env, failedImage.rid);
    expect(failed.outcome.state).toBe("failed");
    const imageRecord = JSON.parse(readFileSync(join(env.data, `finalized-image-${failedImage.rid}.json`), "utf8"));
    expect(imageRecord.outcome.error.title).toBe("Rate limited");
    expect(getChat(env.host, env.chat.id)!.messages).toEqual([]);
    expect(readdirSync(join(env.data, "requests"))).toEqual([]);
  });

  test("finalizeDue finalizes records whose transport ended or whose stop sentinel exists", async () => {
    const env = fresh();
    const rid = await send(env, "/ok");
    const exit = join(requestDir(env.host, rid), "exit");
    for (let i = 0; i < 300 && !existsSync(exit); i++) await Bun.sleep(30);
    expect(await call(env.data, "finalizeDue", {})).toEqual([rid]);
    expect(getChat(env.host, env.chat.id)!.messages).toHaveLength(2);

    const open = await send(env, "/stall");
    expect(await call(env.data, "finalizeDue", {})).toEqual([]);
    await call(env.data, "stop", { rid: open });
    expect(await call(env.data, "finalizeDue", {})).toEqual([open]);
  });

  test("tick returns null for an unknown record", () => {
    const env = fresh();
    expect(tick(env.host, "nope")).toBeNull();
  });
});
