import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvFile } from "../scripts/dev";
import { main as modelAction } from "../src/app/model-action";
import { main as models } from "../src/app/models";
import { normalizeModel } from "../src/core/capabilities";
import { allCommands, readConfig } from "../src/features/index";
import { BunHost } from "../src/host/bun";
import { getChat, getCurrent, mutateChat, createChat, setCurrent } from "../src/store/chats";
import { currentChat, ensureCurrentChat } from "../src/store/current-chat";
import { getSettings } from "../src/store/settings";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-models-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let counter = 0;
function fresh(extra: Record<string, string> = {}) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  const list = (JSON.parse(readFileSync(join(root, "tests/fixtures/models/models.json"), "utf8")).data as unknown[]).map(normalizeModel).filter((m) => m !== null);
  writeFileSync(join(dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models: list }));
  const env = { PATH: process.env.PATH, ...parseEnvFile(join(root, "tests/fixtures/dev.env")), alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), ...extra };
  return { dir, host: (more: Record<string, string> = {}) => new BunHost({ env: { ...env, ...more } }) };
}
const parse = (text: string) => JSON.parse(text);
const run = (ctx: ReturnType<typeof fresh>, input: string) => allCommands().model!.run({ host: ctx.host(), config: readConfigFor(ctx), chat: current(ctx), ensureChat: () => ensure(ctx) }, input);

const readConfigFor = (ctx: ReturnType<typeof fresh>) => readConfig(ctx.host());
const current = (ctx: ReturnType<typeof fresh>) => currentChat(ctx.host());
const ensure = (ctx: ReturnType<typeof fresh>) => ensureCurrentChat(ctx.host(), readConfigFor(ctx));

describe("aimodels script filter", () => {
  test("lists matches with badges, price subtitles, and ↩ ⌘↩ ⌥↩ ⌃↩ actions", () => {
    const ctx = fresh();
    const out = parse(models(ctx.host(), ["#image gemini"]));
    expect(out.skipknowledge).toBe(true);
    expect(out.items[0].subtitle).toContain("🖼");
    expect(out.items[0].arg).toBe("google/gemini-3-flash");
    expect(out.items[0].variables.model_action).toBe("use");
    expect(out.items[0].mods.cmd.variables.model_action).toBe("default");
    expect(out.items[0].mods.alt.variables.model_action).toBe("favorite");
    expect(out.items[0].mods.ctrl.variables.model_action).toBe("copy");
    expect(out.items[0].mods.alt.arg).toBe("google/gemini-3-flash");
  });

  test("no match and an unavailable list are explained and not actionable", () => {
    const ctx = fresh();
    expect(parse(models(ctx.host(), ["zzzz"])).items[0]).toMatchObject({ title: "No models match", valid: false });
    const empty = fresh();
    writeFileSync(join(empty.dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models: [] }));
    expect(parse(models(empty.host(), [""])).items[0].title).toBe("The model list is not available");
  });

  test("happy: the alt item run through model-action adds the favorite and the next listing shows it first", () => {
    const ctx = fresh();
    const before = parse(models(ctx.host(), [""]));
    expect(before.items[0].arg).toBe("anthropic/claude-sonnet-5.5");
    const out = parse(modelAction(ctx.host({ model_action: "favorite" }), ["mistralai/mistral-small"]));
    expect(out.alfredworkflow).toEqual({ arg: "", variables: { model_next: "notify", notice: "Added Mistral: Small to favorites" } });
    const after = parse(models(ctx.host(), [""]));
    expect(after.items[0].arg).toBe("mistralai/mistral-small");
    expect(after.items[0].title).toContain("★");
    expect(after.items[0].mods.alt.subtitle).toBe("Remove from favorites");
    modelAction(ctx.host({ model_action: "favorite" }), ["mistralai/mistral-small"]);
    expect(getSettings(ctx.host()).favorites).toEqual([]);
  });
});

describe("model-action", () => {
  test("use creates a chat when none is current, sets its model, and passes no message to the view", () => {
    const ctx = fresh();
    const out = parse(modelAction(ctx.host({ model_action: "use" }), ["openai/gpt-5.4-nano"]));
    expect(out.alfredworkflow).toEqual({ arg: "", variables: { model_next: "view", notice: "" } });
    const id = getCurrent(ctx.host())!;
    expect(getChat(ctx.host(), id)!.model).toBe("openai/gpt-5.4-nano");
    expect(getSettings(ctx.host()).lastModel).toBe("openai/gpt-5.4-nano");
    expect(parse(models(ctx.host(), [""])).items.find((i: any) => i.arg === "openai/gpt-5.4-nano").title).toContain("●");
  });

  test("default sets the configured default and notifies; copy returns the id as the arg", () => {
    const ctx = fresh();
    const def = parse(modelAction(ctx.host({ model_action: "default" }), ["deepseek/deepseek-r2"]));
    expect(def.alfredworkflow.variables).toEqual({ model_next: "notify", notice: "Default model: DeepSeek: R2" });
    expect(def.alfredworkflow.arg).toBe("");
    expect(getSettings(ctx.host()).defaultModel).toBe("deepseek/deepseek-r2");
    const copy = parse(modelAction(ctx.host({ model_action: "copy" }), ["deepseek/deepseek-r2"]));
    expect(copy.alfredworkflow).toEqual({ arg: "deepseek/deepseek-r2", variables: { model_next: "clipboard", notice: "" } });
    expect(parse(modelAction(ctx.host({ model_action: "use" }), [""])).alfredworkflow.variables.model_next).toBe("notify");
  });
});

describe("/model", () => {
  test("with a query it lists matches; an exact id sets the chat model; default clears the override", () => {
    const ctx = fresh();
    const listing = run(ctx, "gemini");
    expect(listing.kind === "notice" && listing.text).toContain("`google/gemini-3-flash`");
    const set = run(ctx, "openai/gpt-5.4-nano");
    expect(set.kind === "notice" && set.text).toContain("Chat model: **OpenAI: GPT-5.4 Nano**");
    expect(getChat(ctx.host(), getCurrent(ctx.host())!)!.model).toBe("openai/gpt-5.4-nano");
    expect(run(ctx, "").kind === "notice" && (run(ctx, "") as any).text).toContain("`openai/gpt-5.4-nano`");
    run(ctx, "default");
    expect(getChat(ctx.host(), getCurrent(ctx.host())!)!.model).toBeNull();
    expect((run(ctx, "nonexistent-thing") as any).text).toContain("No model matches");
  });

  test("failure: a text-only model in a chat with an image turn and no vision fallback is refused and the chat model stays", () => {
    const ctx = fresh({ vision_fallback_model: "" });
    const chat = createChat(ctx.host(), { model: "anthropic/claude-sonnet-5.5" });
    setCurrent(ctx.host(), chat.id);
    mutateChat(ctx.host(), chat.id, (c) => {
      c.messages.push({ id: "u", requestId: "r", role: "user", content: "see", attachments: [{ name: "shot.png", kind: "image", mime: "image/png", size: 1, sha: "s", file: "attachments/s.png" }], status: "ok", createdAt: 1 });
    });
    const refused = run(ctx, "deepseek/deepseek-r2");
    expect((refused as any).text).toContain("cannot read the images already in this chat");
    expect(getChat(ctx.host(), chat.id)!.model).toBe("anthropic/claude-sonnet-5.5");
  });

  test("a vision fallback that accepts the parts allows the switch and says so", () => {
    const ctx = fresh({ vision_fallback_model: "anthropic/claude-sonnet-5.5" });
    const chat = createChat(ctx.host());
    setCurrent(ctx.host(), chat.id);
    mutateChat(ctx.host(), chat.id, (c) => {
      c.messages.push({ id: "u", requestId: "r", role: "user", content: "see", attachments: [{ name: "shot.png", kind: "image", mime: "image/png", size: 1, sha: "s", file: "attachments/s.png" }], status: "ok", createdAt: 1 });
    });
    const allowed = run(ctx, "deepseek/deepseek-r2") as any;
    expect(allowed.text).toContain("will use Anthropic: Claude Sonnet 5.5 instead");
    expect(getChat(ctx.host(), chat.id)!.model).toBe("deepseek/deepseek-r2");
  });
});
