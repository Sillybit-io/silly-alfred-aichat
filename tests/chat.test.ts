import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvFile } from "../scripts/dev";
import { main as chat } from "../src/app/chat";
import { main as copy } from "../src/app/copy";
import { main as session } from "../src/app/session";
import { BunHost } from "../src/host/bun";
import { getChat, getCurrent } from "../src/store/chats";
import { currentRecord } from "../src/store/requests";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-chat-"));
const encoder = new TextEncoder();
const frame = (data: unknown) => encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
const delta = (content: string) => frame({ choices: [{ delta: { content }, finish_reason: null }] });
const keepalive = encoder.encode(": OPENROUTER PROCESSING\n\n");
const usage = frame({ choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { total_tokens: 3, cost: 0.01 } });

type Step = { wait?: number; send?: Uint8Array; end?: boolean };
const scripts: Record<string, Step[]> = {
  ok: [{ send: keepalive }, { send: delta("Hel") }, { send: delta("lo") }, { send: usage }, { send: frame("[DONE]"), end: true }],
  slow: [{ send: keepalive }, { wait: 600, send: delta("a") }, { wait: 600, send: delta("b") }, { send: usage }, { send: frame("[DONE]"), end: true }],
  keepalive: [{ send: keepalive }, { wait: 400, send: keepalive }, { wait: 400, send: keepalive }, { wait: 400, send: delta("late") }, { send: frame("[DONE]"), end: true }],
  hang: [{ send: delta("part") }],
  errorChunk: [{ send: delta("part") }, { send: frame({ error: { code: "server_error", message: "Provider disconnected unexpectedly" }, choices: [{ delta: { content: "" }, finish_reason: "error" }] }) }],
  errorOnly: [{ send: frame({ error: { code: "server_error", message: "Provider disconnected unexpectedly" }, choices: [{ delta: { content: "" }, finish_reason: "error" }] }) }],
};

function scripted(steps: Step[]): Response {
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
    { headers: { "content-type": "text/event-stream" } },
  );
}

let queue: string[] = [];
let bodies: string[] = [];
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      bodies.push(await request.text());
      const behaviour = queue.shift() ?? "ok";
      if (behaviour === "401") return new Response('{"error":{"message":"No auth"}}', { status: 401, headers: { "content-type": "application/json" } });
      return scripted(scripts[behaviour]!);
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});

let counter = 0;
type Ctx = { dir: string; env: Record<string, string>; session: Record<string, string> };
function fresh(extra: Record<string, string> = {}): Ctx {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  const models = JSON.parse(readFileSync(join(root, "tests/fixtures/models/models.json"), "utf8")).data;
  writeFileSync(join(dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models: models.map((m: any) => ({ id: m.id, name: m.name, contextLength: m.context_length, promptPrice: 0, completionPrice: 0, inputModalities: m.architecture?.input_modalities ?? ["text"], outputModalities: ["text"], reasoning: null, supportedParameters: [] })) }));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...parseEnvFile(join(root, "tests/fixtures/dev.env")),
    alfred_workflow_data: join(dir, "data"),
    alfred_workflow_cache: join(dir, "cache"),
    aichat_api_base: `http://127.0.0.1:${server.port}/v1`,
    ...extra,
  };
  return { dir, env, session: {} };
}

function hostFor(ctx: Ctx, extra: Record<string, string> = {}) {
  return new BunHost({ env: { ...ctx.env, ...ctx.session, ...extra } });
}

type Frame = { response: string; footer: string; behaviour: { response: string; scroll: string; inputfield: string }; variables: { request_id: string; view_stage: string }; rerun?: number };

// One Alfred run: the previous frame's variables become the next run's environment.
function run(ctx: Ctx, argv: string[], extra: Record<string, string> = {}): Frame {
  const out = JSON.parse(chat(hostFor(ctx, extra), argv)) as Frame;
  ctx.session = { request_id: out.variables.request_id, view_stage: out.variables.view_stage };
  return out;
}

async function loop(ctx: Ctx, argv: string[], limitMs = 12000): Promise<Frame[]> {
  const frames: Frame[] = [];
  const deadline = Date.now() + limitMs;
  frames.push(run(ctx, argv));
  while (frames.at(-1)!.rerun !== undefined && Date.now() < deadline) {
    await Bun.sleep(60);
    frames.push(run(ctx, argv));
  }
  expect(frames.at(-1)!.rerun).toBeUndefined();
  return frames;
}

beforeEach(() => {
  queue = [];
  bodies = [];
});

describe("chat view", () => {
  test("first-rerun-shows-connecting: a placeholder frame, rerun 0.1, input selected, request id set, then the assistant section", () => {
    queue.push("slow");
    const ctx = fresh();
    const first = run(ctx, ["hello"]);
    expect(first.rerun).toBe(0.1);
    expect(first.behaviour.inputfield).toBe("select");
    expect(first.behaviour.response).toBe("replace");
    expect(first.variables.request_id).not.toBe("");
    expect(first.response).toContain("# 🧑 You\n\nhello");
    expect(first.footer).toContain("test/model");
    expect(first.footer).toContain("connecting");
    const second = run(ctx, ["hello"]);
    expect(second.behaviour.response).toBe("append");
    expect(second.response).toBe("# 🤖 Assistant\n\n…");
    const third = run(ctx, ["hello"]);
    expect(third.behaviour.response).toBe("replacelast");
    expect(third.rerun).toBe(0.1);
  });

  test("happy: streams to a reply, the footer names the model and done and carries no price or token count, and the chat holds one pair", async () => {
    queue.push("ok");
    const ctx = fresh();
    const frames = await loop(ctx, ["hi there"]);
    const last = frames.at(-1)!;
    expect(last.response).toContain("# 🤖 Assistant\n\nHello");
    expect(last.footer).toBe("test/model · done");
    expect(`${last.footer}${last.response}`).not.toMatch(/\$|tokens?\b|cost/i);
    expect(last.variables.request_id).toBe("");
    const stored = getChat(hostFor(ctx), getCurrent(hostFor(ctx))!)!;
    expect(stored.messages.map((m) => m.content)).toEqual(["hi there", "Hello"]);
    expect(JSON.parse(bodies[0]!).messages.map((m: any) => m.role)).toEqual(["system", "user"]);
  });

  test("keep-alive-only-does-not-stall: comments show processing and the request still completes", async () => {
    queue.push("keepalive");
    const ctx = fresh();
    const frames = await loop(ctx, ["wait for it"]);
    expect(frames.some((f) => f.footer.includes("processing"))).toBe(true);
    expect(frames.at(-1)!.response).toContain("late");
    expect(frames.at(-1)!.footer).toContain("done");
  });

  test("mid-stream-error-keeps-input: a reply cut by an error is kept as interrupted and the input stays selected", async () => {
    queue.push("errorChunk");
    const ctx = fresh();
    const frames = await loop(ctx, ["go"]);
    const last = frames.at(-1)!;
    expect(last.behaviour.inputfield).toBe("select");
    expect(last.footer).toContain("interrupted");
    expect(last.response).toContain("part");
    expect(last.response).toContain("Interrupted");
    const stored = getChat(hostFor(ctx), getCurrent(hostFor(ctx))!)!;
    expect(stored.messages.at(-1)!.status).toBe("interrupted");
  });

  test("an error before any content renders the mapped error, commits nothing, and keeps the draft for /retry", async () => {
    queue.push("errorOnly");
    const ctx = fresh();
    const last = (await loop(ctx, ["go"])).at(-1)!;
    expect(last.response).toContain("# ⚠️ The model stopped with an error");
    expect(last.response).toContain("Provider disconnected unexpectedly");
    expect(last.response).toContain("**Next:**");
    expect(last.response).not.toContain("{");
    const stored = getChat(hostFor(ctx), getCurrent(hostFor(ctx))!)!;
    expect(stored.messages).toEqual([]);
    expect(stored.retry!.text).toBe("go");
  });

  test("reopen-without-request-id-resumes: a run with no request id and no text rejoins the open request", async () => {
    queue.push("slow");
    const ctx = fresh();
    const first = run(ctx, ["hello"]);
    ctx.session = {};
    const reopened = run(ctx, []);
    expect(reopened.variables.request_id).toBe(first.variables.request_id);
    expect(reopened.behaviour.response).toBe("replace");
    expect(reopened.response).toContain("# 🧑 You\n\nhello");
    const frames = [reopened];
    while (frames.at(-1)!.rerun !== undefined) {
      await Bun.sleep(60);
      frames.push(run(ctx, []));
    }
    const stored = getChat(hostFor(ctx), getCurrent(hostFor(ctx))!)!;
    expect(stored.messages.map((m) => m.content)).toEqual(["hello", "ab"]);
    expect(bodies).toHaveLength(1);
  });

  test("new-text-preempts-open-request: new text stops the open request, keeps its partial reply, and sends", async () => {
    queue.push("hang", "ok");
    const ctx = fresh();
    run(ctx, ["first"]);
    for (let i = 0; i < 100; i++) {
      await Bun.sleep(60);
      const frame = run(ctx, ["first"]);
      if (frame.response.includes("part")) break;
    }
    ctx.session = {};
    const frames = await loop(ctx, ["second"]);
    expect(frames.at(-1)!.response).toContain("Hello");
    const stored = getChat(hostFor(ctx), getCurrent(hostFor(ctx))!)!;
    expect(stored.messages.map((m) => [m.content, m.status])).toEqual([
      ["first", "ok"],
      ["part", "stopped"],
      ["second", "ok"],
      ["Hello", "ok"],
    ]);
    expect(bodies).toHaveLength(2);
  });

  test("rerun-after-final-does-not-resend: a stale request id with the original argument shows the chat and sends nothing", async () => {
    queue.push("ok");
    const ctx = fresh();
    const frames = await loop(ctx, ["once"]);
    const staleId = frames[0]!.variables.request_id;
    const again = run(ctx, ["once"], { request_id: staleId });
    expect(again.variables.request_id).toBe("");
    expect(again.rerun).toBeUndefined();
    expect(again.response).toContain("Hello");
    expect(bodies).toHaveLength(1);
    const stored = getChat(hostFor(ctx), getCurrent(hostFor(ctx))!)!;
    expect(stored.messages).toHaveLength(2);
  });

  test("a failed send renders Invalid API key with a next step; /retry after other text was typed resends the original draft", async () => {
    queue.push("401", "ok");
    const ctx = fresh();
    const failed = (await loop(ctx, ["original draft"])).at(-1)!;
    expect(failed.response).toContain("Invalid API key");
    expect(failed.response).toContain("**Next:**");
    expect(failed.footer).toContain("failed");
    const stored = getChat(hostFor(ctx), getCurrent(hostFor(ctx))!)!;
    expect(stored.messages).toEqual([]);
    ctx.session = {};
    const idle = run(ctx, []);
    expect(idle.response).toContain("/retry");
    const retried = (await loop(ctx, ["/retry"])).at(-1)!;
    expect(retried.response).toContain("Hello");
    expect(JSON.parse(bodies[1]!).messages.at(-1).content).toBe("original draft");
    const after = getChat(hostFor(ctx), getCurrent(hostFor(ctx))!)!;
    expect(after.retry).toBeNull();
    expect(after.messages.map((m) => m.content)).toEqual(["original draft", "Hello"]);
  });

  test("stop-then-view-finalizes-stopped: session stop writes the sentinel, then the next chat run commits the partial reply as stopped", async () => {
    queue.push("hang");
    const ctx = fresh();
    run(ctx, ["go"]);
    for (let i = 0; i < 100; i++) {
      await Bun.sleep(60);
      if (run(ctx, ["go"]).response.includes("part")) break;
    }
    const envelope = JSON.parse(session(hostFor(ctx, { session_action: "stop" }), ["go"])) as { alfredworkflow: { arg: string; variables: Record<string, string> } };
    expect(envelope.alfredworkflow.arg).toBe("");
    expect(envelope.alfredworkflow.variables.request_id).toBe("");
    ctx.session = {};
    const view = run(ctx, []);
    expect(view.variables.request_id).toBe("");
    expect(view.response).toContain("part");
    expect(view.response).toContain("Stopped");
    const stored = getChat(hostFor(ctx), getCurrent(hostFor(ctx))!)!;
    expect(stored.messages.at(-1)).toMatchObject({ content: "part", status: "stopped" });
    expect(currentRecord(hostFor(ctx), `chat:${stored.id}`)).toBeNull();
    const again = JSON.parse(session(hostFor(ctx, { session_action: "stop" }), [])) as { alfredworkflow: { arg: string } };
    expect(again.alfredworkflow.arg).toBe("");
  });
});

describe("commands and idle view", () => {
  test("/help lists the built-ins, unknown commands are named, and /new starts a fresh chat", () => {
    const ctx = fresh();
    const help = run(ctx, ["/help"]);
    expect(help.response).toContain("`/new`");
    expect(help.response).toContain("`/retry`");
    expect(help.rerun).toBeUndefined();
    expect(run(ctx, ["/nope"]).response).toContain("Unknown command `/nope`");
    expect(run(ctx, ["/retry"]).response).toContain("no failed message");
  });

  test("/new clears the current chat and a missing API key shows a notice instead of sending", async () => {
    queue.push("ok");
    const ctx = fresh();
    await loop(ctx, ["hello"]);
    expect(getCurrent(hostFor(ctx))).not.toBeNull();
    ctx.session = {};
    run(ctx, ["/new"]);
    expect(getCurrent(hostFor(ctx))).toBeNull();
    const blank = fresh({ openrouter_api_key: "" });
    const frame = run(blank, ["hello"]);
    expect(frame.response).toContain("Add your OpenRouter API key");
    expect(frame.variables.request_id).toBe("");
    expect(bodies).toHaveLength(1);
  });

  test("session new stops, clears current, and passes the typed text on; copy prints the last reply or the whole chat", async () => {
    queue.push("ok");
    const ctx = fresh();
    await loop(ctx, ["question"]);
    expect(copy(hostFor(ctx, { copy_mode: "last" }), [])).toBe("Hello");
    expect(copy(hostFor(ctx, { copy_mode: "all" }), [])).toBe("# 🧑 You\n\nquestion\n\n# 🤖 Assistant\n\nHello");
    const out = JSON.parse(session(hostFor(ctx, { session_action: "new" }), ["next topic"])) as { alfredworkflow: { arg: string; variables: Record<string, string> } };
    expect(out.alfredworkflow.arg).toBe("next topic");
    expect(out.alfredworkflow.variables.request_id).toBe("");
    expect(getCurrent(hostFor(ctx))).toBeNull();
    expect(copy(hostFor(ctx, { copy_mode: "all" }), [])).toBe("");
  });
});

describe("notices", () => {
  test("a command's notice comes after the transcript, so it is at the bottom where the view scrolls to", async () => {
    queue.push("ok");
    const ctx = fresh();
    await loop(ctx, ["hello"]);
    ctx.session = {};
    const view = run(ctx, ["/help"]);
    const at = (text: string) => view.response.indexOf(text);
    expect(at("Hello")).toBeGreaterThan(-1);
    expect(at("**Commands**")).toBeGreaterThan(at("Hello"));
    expect(view.response.trimEnd().endsWith("Anything else you type is sent to the model.")).toBe(true);
    const blank = fresh();
    expect(run(blank, ["/nope"]).response.indexOf("Unknown command")).toBeGreaterThan(run(blank, ["/nope"]).response.indexOf("Ask anything"));
  });
});

describe("headings and notices", () => {
  test("turns are marked with emoji and a rule between them, and notices carry an info or warning icon", async () => {
    queue.push("ok", "ok");
    const ctx = fresh();
    await loop(ctx, ["first question"]);
    ctx.session = {};
    const frames = await loop(ctx, ["second question"]);
    const text = frames.at(-1)!.response;
    expect(text).toContain("# 🧑 You\n\nfirst question\n\n# 🤖 Assistant\n\nHello\n\n---\n\n# 🧑 You\n\nsecond question");
    expect(text.startsWith("# 🧑 You")).toBe(true);
    ctx.session = {};
    expect(run(ctx, ["/attachments"]).response.trimEnd().endsWith("ℹ️ No files are waiting. Use `/attach`, `/paste`, or the **AI Chat: Ask about these files** action.")).toBe(true);
    expect(run(ctx, ["/help"]).response).toContain("ℹ️ **Commands**");
    expect(run(ctx, ["/nope"]).response).toContain("ℹ️ Unknown command");
    const warn = run(fresh({ openrouter_api_key: "" }), ["hi"]);
    expect(warn.response).toContain("⚠️ **Add your OpenRouter API key.**");
  });

  test("a failed first message shows its draft under a rule only when there is history above it", async () => {
    queue.push("401");
    const ctx = fresh();
    const failed = (await loop(ctx, ["lonely"])).at(-1)!;
    expect(failed.response.startsWith("# 🧑 You\n\nlonely")).toBe(true);
    expect(failed.response).toContain("# ⚠️ Invalid API key");
    expect(failed.response).not.toContain("---");
  });
});
