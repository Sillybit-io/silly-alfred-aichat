import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnvFile } from "../scripts/dev";
import { main as presets } from "../src/app/presets";
import { main as copy } from "../src/app/copy";
import { main as presetView } from "../src/app/preset-view";
import { main as presetRun } from "../src/app/preset-run";
import { normalizeModel } from "../src/core/capabilities";
import { DEFAULT_PRESETS, defaultPresetsJson, fillPrompt, parsePresets } from "../src/core/presets";
import { BunHost, type FakeCommand } from "../src/host/bun";
import { presetsPath } from "../src/store/presets";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-presets-"));
const servers: { kill(): void }[] = [];
afterAll(() => {
  servers.forEach((s) => s.kill());
  rmSync(work, { recursive: true, force: true });
});

async function replay(fixture: string): Promise<{ port: number; log: string }> {
  const log = join(work, `${fixture}.log`);
  writeFileSync(log, "");
  const proc = Bun.spawn(["bun", join(root, "scripts/replay-server.ts"), join(root, "tests/fixtures/http", fixture), log], { stdout: "pipe" });
  servers.push(proc);
  return { port: Number(new TextDecoder().decode((await proc.stdout.getReader().read()).value).trim()), log };
}

let ok: { port: number; log: string };
let denied: { port: number; log: string };
beforeAll(async () => {
  ok = await replay("presets");
  denied = await replay("presets-402");
});

let counter = 0;
function fresh(port: number, extra: Record<string, string> = {}, fakes: Record<string, FakeCommand> = {}, hooks: { clipboardText?: () => string | null } = {}) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  const env = { PATH: process.env.PATH, ...parseEnvFile(join(root, "tests/fixtures/dev.env")), alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), aichat_api_base: `http://127.0.0.1:${port}/v1`, ...extra };
  return { dir, host: (more: Record<string, string> = {}) => new BunHost({ env: { ...env, ...more }, fakeCommands: fakes, ...hooks }) };
}
const envelope = (text: string) => JSON.parse(text).alfredworkflow as { arg: string; variables: Record<string, string> };
const requestCount = (log: string) => readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("POST")).length;

describe("preset definitions", () => {
  test("the defaults parse cleanly and cover the six built-ins", () => {
    const parsed = parsePresets(defaultPresetsJson());
    expect(parsed.errors).toEqual([]);
    expect(parsed.presets.map((p) => p.id)).toEqual(["summarize", "explain", "translate", "proofread", "fix-code", "action-items"]);
    expect(parsed.presets).toEqual(DEFAULT_PRESETS);
  });

  test("{text} and {language} are filled, and braces inside the text stay as they are", () => {
    const translate = DEFAULT_PRESETS.find((p) => p.id === "translate")!;
    expect(fillPrompt(translate, "bonjour {language} {text}", "French")).toBe("Translate the following text to French. Reply with only the translation:\n\nbonjour {language} {text}");
  });

  test("a mistake is reported with its line number", () => {
    const broken = '[\n  {\n    "id": "a",\n    "name": "A",\n    "prompt": "no placeholder"\n  },\n  {\n    "id": "Bad Id",\n    "name": "B",\n    "prompt": "{text}",\n    "output": "email"\n  }\n]';
    const { presets, errors } = parsePresets(broken);
    expect(presets).toEqual([]);
    expect(errors).toEqual([
      { line: 5, message: '"prompt" must contain {text}, where the selected text goes' },
      { line: 8, message: '"id" may use only lower-case letters, digits, and hyphens (got "Bad Id")' },
      { line: 11, message: '"output" must be one of textview, clipboard, paste, largetype' },
    ]);
    expect(parsePresets('[\n  {\n    "id": "a",\n    "name": "A"\n    "prompt": "{text}"\n  }\n]').errors[0]).toEqual({ line: 5, message: 'expected "," or "}"' });
    expect(parsePresets('{"id": "a"}').errors[0]!.message).toContain("list of presets");
    expect(parsePresets("[1]").errors[0]!.message).toContain("object");
    expect(parsePresets('[{"id":"a","name":"A","prompt":"{text}"},{"id":"a","name":"B","prompt":"{text}"}]').errors[0]!.message).toContain("used twice");
    expect(parsePresets("").errors[0]!.message).toContain("too early");
  });

  test("optional fields are kept: system, model, web, think", () => {
    const { presets, errors } = parsePresets('[{"id":"x","name":"X","prompt":"{text}","system":"Be brief","model":"a/b","web":true,"think":"high","output":"paste"}]');
    expect(errors).toEqual([]);
    expect(presets[0]).toEqual({ id: "x", name: "X", prompt: "{text}", system: "Be brief", model: "a/b", web: true, think: "high", output: "paste" });
  });
});

describe("aipresets", () => {
  test("creates presets.json on first run and lists 6 presets plus the edit item, filtered by the query", () => {
    const ctx = fresh(ok.port);
    const out = JSON.parse(presets(ctx.host(), [""]));
    expect(out.items).toHaveLength(7);
    expect(existsSync(presetsPath(ctx.host()))).toBe(true);
    expect(out.items.at(-1)).toMatchObject({ title: "Edit presets.json", variables: { preset_id: "@edit" } });
    const sum = JSON.parse(presets(ctx.host(), ["sum"]));
    expect(sum.items.map((i: any) => i.title)).toEqual(["Summarize"]);
    expect(JSON.parse(presets(ctx.host(), ["edit"])).items.map((i: any) => i.title)).toEqual(["Edit presets.json"]);
  });

  test("the input is preset_text when set, else the clipboard, and is previewed in each subtitle and passed as the arg", () => {
    const clip = fresh(ok.port, {}, {}, { clipboardText: () => "from the clipboard" });
    const fromClipboard = JSON.parse(presets(clip.host(), [""]));
    expect(fromClipboard.items[0]).toMatchObject({ arg: "from the clipboard", valid: true, variables: { preset_id: "summarize" } });
    expect(fromClipboard.items[0].subtitle).toContain("“from the clipboard”");
    const selected = JSON.parse(presets(clip.host({ preset_text: "selected text" }), [""]));
    expect(selected.items[0].arg).toBe("selected text");
    const nothing = JSON.parse(presets(fresh(ok.port).host(), [""]));
    expect(nothing.items[0]).toMatchObject({ valid: false, arg: "" });
  });

  test("a broken presets.json shows its first problem and the edit item", () => {
    const ctx = fresh(ok.port);
    writeFileSync(join(ctx.dir, "data/presets.json"), '[\n  {"id": "a"}\n]');
    const out = JSON.parse(presets(ctx.host({ preset_text: "x" }), [""]));
    expect(out.items[0].title).toBe("presets.json has a problem on line 2");
    expect(out.items[0].valid).toBe(false);
    expect(out.items.at(-1).title).toBe("Edit presets.json");
  });
});

describe("preset-run", () => {
  test("happy: with clipboard presets enabled, a clipboard preset returns the one reply as arg with preset_output clipboard", () => {
    const ctx = fresh(ok.port, { default_model: "anthropic/claude-sonnet-5.5", preset_clipboard: "1" });
    const before = requestCount(ok.log);
    const out = envelope(presetRun(ctx.host({ preset_id: "translate" }), ["Bonjour le monde"]));
    expect(out.arg).toBe("A short summary.");
    expect(out.variables.preset_output).toBe("clipboard");
    expect(requestCount(ok.log)).toBe(before + 1);
  });

  test("paste and largetype presets route by their output; the cache holds no leftover request files", () => {
    const ctx = fresh(ok.port, { preset_clipboard: "1" });
    expect(envelope(presetRun(ctx.host({ preset_id: "proofread" }), ["teh text"])).variables.preset_output).toBe("paste");
    expect(envelope(presetRun(ctx.host({ preset_id: "action-items" }), ["call Sam Friday"])).variables.preset_output).toBe("largetype");
    const leftovers = Bun.spawnSync(["ls", join(ctx.dir, "cache")]).stdout.toString().split("\n").filter((n) => n.startsWith("preset-"));
    expect(leftovers).toEqual([]);
  });

  test("by default a clipboard or paste preset only shows its reply: no arg, no clipboard output, and the reply is kept for the view and for ⌘↩", () => {
    const ctx = fresh(ok.port);
    const before = requestCount(ok.log);
    const translated = envelope(presetRun(ctx.host({ preset_id: "translate" }), ["Bonjour"]));
    expect(translated).toEqual({ arg: "", variables: { preset_output: "view", preset_error: "" } });
    expect(requestCount(ok.log)).toBe(before + 1);
    const view = JSON.parse(presetView(ctx.host(), []));
    expect(view.response).toBe("A short summary.");
    expect(view.footer).toBe("Translate · ⌘↩ copy · ⌘⌥↩ chats");
    expect(view.rerun).toBeUndefined();
    expect(copy(ctx.host({ copy_mode: "preset" }), [])).toBe("A short summary.");
    const proofread = envelope(presetRun(ctx.host({ preset_id: "proofread" }), ["teh text"]));
    expect(proofread.variables.preset_output).toBe("view");
    expect(JSON.parse(presetView(ctx.host(), [])).footer).toStartWith("Proofread");
    expect(envelope(presetRun(ctx.host({ preset_id: "action-items" }), ["call Sam"])).variables.preset_output).toBe("largetype");
  });

  test("the result view says so when nothing has run yet", () => {
    const ctx = fresh(ok.port);
    expect(JSON.parse(presetView(ctx.host(), [])).response).toContain("no preset result");
    expect(copy(ctx.host({ copy_mode: "preset" }), [])).toBe("");
  });

  test("a textview preset returns the filled prompt, asks for a new chat, and the server sees no request", () => {
    const ctx = fresh(ok.port);
    const before = requestCount(ok.log);
    const out = envelope(presetRun(ctx.host({ preset_id: "summarize" }), ["Long text here"]));
    expect(out.arg).toBe("Summarize the following text concisely:\n\nLong text here");
    expect(out.variables).toEqual({ preset_output: "textview", session_action: "new", preset_error: "" });
    expect(requestCount(ok.log)).toBe(before);
  });

  test("failure: a 402 routes to the error output with Out of credits and an empty arg, without the provider's message", () => {
    const ctx = fresh(denied.port);
    const out = envelope(presetRun(ctx.host({ preset_id: "translate" }), ["hello"]));
    expect(out.arg).toBe("");
    expect(out.variables.preset_output).toBe("error");
    expect(out.variables.preset_error.startsWith("Out of credits")).toBe(true);
    expect(out.variables.preset_error).not.toContain("$");
  });

  test("an unreachable server, a missing key, empty input, and an unknown preset all end in the error output", () => {
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = closed.port!;
    closed.stop(true);
    const dead = envelope(presetRun(fresh(port).host({ preset_id: "translate" }), ["hello"]));
    expect(dead.variables.preset_error.startsWith("Cannot reach OpenRouter")).toBe(true);
    const noKey = envelope(presetRun(fresh(ok.port, { openrouter_api_key: "" }).host({ preset_id: "translate" }), ["hello"]));
    expect(noKey.variables.preset_error).toContain("API key");
    const empty = envelope(presetRun(fresh(ok.port).host({ preset_id: "summarize" }), [""]));
    expect(empty.variables.preset_output).toBe("error");
    const unknown = envelope(presetRun(fresh(ok.port).host({ preset_id: "nope" }), ["x"]));
    expect(unknown.variables.preset_error).toContain('"nope"');
  });

  test("the edit item opens presets.json in the default text editor and matches no output route", () => {
    const calls: string[][] = [];
    const ctx = fresh(ok.port, {}, { open: (args) => (calls.push(args), { exit: 0, stdout: "", stderr: "" }) });
    const out = envelope(presetRun(ctx.host({ preset_id: "@edit" }), [""]));
    expect(out.variables.preset_output).toBe("edit");
    expect(out.arg).toBe("");
    expect(calls).toEqual([["-t", join(ctx.dir, "data/presets.json")]]);
  });

  test("the preset's own model, system prompt, web, and think reach the request body", () => {
    const ctx = fresh(ok.port, { default_model: "anthropic/claude-sonnet-5.5" });
    const models = (JSON.parse(readFileSync(join(root, "tests/fixtures/models/models.json"), "utf8")).data as unknown[]).map(normalizeModel).filter((m) => m !== null);
    writeFileSync(join(ctx.dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models }));
    writeFileSync(join(ctx.dir, "data/presets.json"), JSON.stringify([{ id: "custom", name: "Custom", prompt: "Do: {text}", system: "Be brief", model: "openai/gpt-5.4-nano", web: true, think: "high", output: "clipboard" }]));
    const captured: { args: string[]; body: any }[] = [];
    const host = new BunHost({
      env: { ...ctx.host().env, preset_id: "custom" },
      fakeCommands: {
        curl: (args) => {
          const path = args[args.indexOf("--data-binary") + 1]!.slice(1);
          captured.push({ args, body: JSON.parse(readFileSync(path, "utf8")) });
          return { exit: 7, stdout: "", stderr: "" };
        },
      },
    });
    presetRun(host, ["hi"]);
    const { args, body } = captured[0]!;
    expect(args[args.indexOf("--max-time") + 1]).toBe("60");
    expect(body.model).toBe("openai/gpt-5.4-nano");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: "system", content: "Be brief" }, { role: "user", content: "Do: hi" }]);
    expect(body.plugins).toEqual([{ id: "web", max_results: 5 }]);
    expect(body.reasoning).toEqual({ effort: "high" });
  });
});
