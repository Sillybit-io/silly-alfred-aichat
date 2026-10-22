import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvFile } from "../scripts/dev";
import { main as chat } from "../src/app/chat";
import { normalizeModel } from "../src/core/capabilities";
import { newStreamState } from "../src/core/stream";
import { allCommands, features, readConfig, type CommandOutcome } from "../src/features/index";
import { BunHost } from "../src/host/bun";
import { getChat, getCurrent } from "../src/store/chats";
import { currentChat, ensureCurrentChat } from "../src/store/current-chat";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-reasoning-"));
const encoder = new TextEncoder();
const frame = (data: unknown) => encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
const reason = (text: string) => frame({ choices: [{ delta: { reasoning: text }, finish_reason: null }] });
const content = (text: string) => frame({ choices: [{ delta: { content: text }, finish_reason: null }] });
type Step = { wait?: number; send?: Uint8Array; end?: boolean };
const script: Step[] = [{ send: reason("Weighing options. ") }, { send: reason("Second thought.") }, { wait: 900, send: content("The answer is 42.") }, { send: frame("[DONE]"), end: true }];
let bodies: any[] = [];
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      bodies.push(JSON.parse(await request.text()));
      return new Response(
        new ReadableStream({
          async start(controller) {
            for (const step of script) {
              if (step.wait) await Bun.sleep(step.wait);
              if (step.send) controller.enqueue(step.send);
              if (step.end) controller.close();
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(work, { recursive: true, force: true });
});
beforeEach(() => {
  bodies = [];
});

const models = (JSON.parse(readFileSync(join(root, "tests/fixtures/models/models.json"), "utf8")).data as unknown[]).map(normalizeModel).filter((m) => m !== null);
let counter = 0;
function fresh(model: string, extra: Record<string, string> = {}) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  writeFileSync(join(dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models }));
  const env = { PATH: process.env.PATH, ...parseEnvFile(join(root, "tests/fixtures/dev.env")), alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), aichat_api_base: `http://127.0.0.1:${server.port}/v1`, default_model: model, ...extra };
  const session: Record<string, string> = {};
  const host = (more: Record<string, string> = {}) => new BunHost({ env: { ...env, ...session, ...more } });
  return { dir, host, session };
}
type Ctx = ReturnType<typeof fresh>;
const command = (ctx: Ctx, name: string, args = ""): string => {
  const host = ctx.host();
  const outcome: CommandOutcome = allCommands()[name]!.run({ host, config: readConfig(host), chat: currentChat(host), ensureChat: () => ensureCurrentChat(host, readConfig(host)) }, args);
  return outcome.kind === "notice" ? outcome.text : "";
};
const settings = (ctx: Ctx) => getChat(ctx.host(), getCurrent(ctx.host())!)!.settings;

type Frame = { response: string; footer: string; rerun?: number; variables: { request_id: string; view_stage: string } };
function run(ctx: Ctx, argv: string[]): Frame {
  const out = JSON.parse(chat(ctx.host(), argv)) as Frame;
  ctx.session.request_id = out.variables.request_id;
  ctx.session.view_stage = out.variables.view_stage;
  return out;
}
async function loop(ctx: Ctx, argv: string[]): Promise<Frame[]> {
  const frames = [run(ctx, argv)];
  const deadline = Date.now() + 12000;
  while (frames.at(-1)!.rerun !== undefined && Date.now() < deadline) {
    await Bun.sleep(80);
    frames.push(run(ctx, argv));
  }
  return frames;
}

describe("/think", () => {
  test("lists what the model supports and sets a valid effort (off maps to none, model clears it)", () => {
    const ctx = fresh("anthropic/claude-sonnet-5.5");
    expect(command(ctx, "think")).toContain("`high`, `medium`, `low`, `off`");
    expect(command(ctx, "think", "high")).toContain("**high**");
    expect(settings(ctx).effort).toBe("high");
    expect(command(ctx, "think", "off")).toContain("**off**");
    expect(settings(ctx).effort).toBe("none");
    command(ctx, "think", "model");
    expect(settings(ctx).effort).toBeNull();
    expect(command(ctx, "think", "turbo")).toContain("Unknown effort");
    expect(command(ctx, "think", "max")).toContain("does not support `max`");
  });

  test("failure: off on a mandatory-reasoning model says it cannot be turned off and leaves the setting unchanged", () => {
    const ctx = fresh("deepseek/deepseek-r2");
    command(ctx, "think", "high");
    expect(command(ctx, "think", "off")).toContain("cannot be turned off");
    expect(settings(ctx).effort).toBe("high");
  });

  test("a model without reasoning controls refuses an effort", () => {
    const ctx = fresh("mistralai/mistral-small");
    expect(command(ctx, "think", "high")).toContain("no reasoning controls");
    expect(command(ctx, "think")).toContain("no reasoning controls");
  });
});

describe("/reasoning and /web", () => {
  test("reasoning visibility and web search persist per chat", () => {
    const ctx = fresh("anthropic/claude-sonnet-5.5");
    expect(command(ctx, "reasoning")).toContain("collapsed");
    expect(command(ctx, "reasoning", "on")).toContain("stay under");
    expect(settings(ctx).showReasoning).toBe(true);
    expect(command(ctx, "reasoning", "maybe")).toContain("Use `/reasoning on`");
    expect(command(ctx, "web")).toContain("**off**");
    expect(command(ctx, "web", "on")).toContain("up to 5 results");
    expect(settings(ctx).web).toBe(true);
    expect(command(ctx, "web", "status")).toContain("**on**");
    command(ctx, "web", "off");
    expect(settings(ctx).web).toBe(false);
    expect(command(ctx, "web", "sometimes")).toContain("Use `/web on`");
  });

  test("a new chat starts from the configured defaults", () => {
    const ctx = fresh("anthropic/claude-sonnet-5.5", { web_default: "1", keep_reasoning: "1", reasoning_default: "off" });
    command(ctx, "web", "status");
    ensureCurrentChat(ctx.host(), readConfig(ctx.host()));
    expect(settings(ctx)).toMatchObject({ web: true, showReasoning: true, effort: "none" });
  });
});

describe("live rendering and request bodies", () => {
  const renderLive = (chatSettings: { showReasoning: boolean }, reasoningText: string, contentText: string) => {
    const state = newStreamState();
    state.reasoning = reasoningText;
    state.content = contentText;
    const ctx = fresh("anthropic/claude-sonnet-5.5");
    const chatRecord = { ...ensureCurrentChat(ctx.host(), readConfig(ctx.host())), settings: { web: false, effort: null, pdfEngine: null, ...chatSettings } };
    return features.map((f) => (f.renderLive ? f.renderLive({ host: ctx.host(), config: readConfig(ctx.host()), chat: chatRecord, record: {} as any, state }) : null)).find((r) => r !== null) ?? null;
  };

  test("reasoning shows as a quote under a thinking heading until content arrives, then only the answer", () => {
    expect(renderLive({ showReasoning: false }, "step one\n\nstep two", "")).toBe("**Thinking…**\n\n> step one\n>\n> step two");
    expect(renderLive({ showReasoning: false }, "step one", "answer")).toBeNull();
    expect(renderLive({ showReasoning: true }, "step one", "answer")).toBe("> step one\n\nanswer");
    expect(renderLive({ showReasoning: false }, "", "")).toBeNull();
  });

  test("happy: the quote streams, the final transcript holds only the answer, and /reasoning on keeps the quote on the next reply", async () => {
    const ctx = fresh("anthropic/claude-sonnet-5.5");
    const frames = await loop(ctx, ["why?"]);
    expect(frames.some((f) => f.response.includes("**Thinking…**") && f.response.includes("> Weighing options."))).toBe(true);
    const last = frames.at(-1)!;
    expect(last.response).toContain("The answer is 42.");
    expect(last.response).not.toContain("Weighing options");
    ctx.session.request_id = "";
    command(ctx, "reasoning", "on");
    const second = (await loop(ctx, ["and again?"])).at(-1)!;
    expect(second.response).toContain("> Weighing options.");
    expect(second.response.match(/Weighing options/g)).toHaveLength(1);
  });

  test("/think and /web change the request body and the footer", async () => {
    const ctx = fresh("anthropic/claude-sonnet-5.5");
    command(ctx, "think", "high");
    command(ctx, "web", "on");
    const frames = await loop(ctx, ["search it"]);
    expect(bodies[0].reasoning).toEqual({ effort: "high" });
    expect(bodies[0].plugins).toEqual([{ id: "web", max_results: 5 }]);
    expect(frames[0]!.footer).toContain("🧠 high");
    expect(frames[0]!.footer).toContain("web");
    expect(frames.at(-1)!.footer).toContain("web");
  });

  test("a web follow-up is sent as a standalone message, while the chat keeps what the user typed", async () => {
    const ctx = fresh("anthropic/claude-sonnet-5.5");
    command(ctx, "web", "on");
    await loop(ctx, ["how is weather in New York right now?"]);
    expect(bodies.at(-1).messages.at(-1).content).toBe("how is weather in New York right now?");
    ctx.session.request_id = "";
    const plain = ctx.host;
    const rewrites: string[][] = [];
    ctx.host = (more) => {
      const host = plain(more);
      const real = host.runSync.bind(host);
      host.runSync = (argv, options) => {
        if (!argv.some((arg) => arg.endsWith("/chat/completions"))) return real(argv, options);
        rewrites.push(argv);
        return { exit: 0, stdout: JSON.stringify({ choices: [{ message: { content: "What is the weather in New York tomorrow?" } }] }), stderr: "" };
      };
      return host;
    };
    const frames = await loop(ctx, ["What about tomorrow?"]);
    expect(rewrites).toHaveLength(1);
    expect(bodies.at(-1).messages.at(-1)).toEqual({ role: "user", content: "What is the weather in New York tomorrow?" });
    expect(bodies.at(-1).plugins).toEqual([{ id: "web", max_results: 5 }]);
    expect(frames[0]!.footer).toContain("searched “What is the weather in New York tomorrow?”");
    expect(frames.at(-1)!.response).toContain("What about tomorrow?");
    expect(frames.at(-1)!.response).not.toContain("What is the weather in New York tomorrow?");
  });

  test("with web off, a follow-up is sent as typed and no rewrite request is made", async () => {
    const ctx = fresh("anthropic/claude-sonnet-5.5");
    await loop(ctx, ["first"]);
    ctx.session.request_id = "";
    const plain = ctx.host;
    let rewrites = 0;
    ctx.host = (more) => {
      const host = plain(more);
      const real = host.runSync.bind(host);
      host.runSync = (argv, options) => {
        if (argv.some((arg) => arg.endsWith("/chat/completions"))) rewrites++;
        return real(argv, options);
      };
      return host;
    };
    await loop(ctx, ["What about tomorrow?"]);
    expect(rewrites).toBe(0);
    expect(bodies.at(-1).messages.at(-1).content).toBe("What about tomorrow?");
  });

  test("with no setting the body carries neither a reasoning object nor a plugin", async () => {
    const ctx = fresh("anthropic/claude-sonnet-5.5");
    await loop(ctx, ["plain"]);
    expect(bodies[0].reasoning).toBeUndefined();
    expect(bodies[0].plugins).toBeUndefined();
  });
});
