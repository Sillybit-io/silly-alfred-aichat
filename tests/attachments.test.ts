import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderIcon } from "../scripts/icon";
import { parseEnvFile } from "../scripts/dev";
import { classifyName, MAX_BODY_BYTES, looksLikeText } from "../src/core/attachments";
import { normalizeModel, type ModelRecord } from "../src/core/capabilities";
import { buildBody, type PayloadOptions } from "../src/core/payload";
import { sha256Hex } from "../src/core/sha256";
import { feature } from "../src/features/attachments";
import { readConfig, type CommandContext, type PayloadContext } from "../src/features/index";
import { BunHost, type FakeCommand } from "../src/host/bun";
import { attachBytes, attachPaths } from "../src/store/attach";
import { chatDir, createChat, getChat, mutateChat, type Chat } from "../src/store/chats";
import { currentChat, ensureCurrentChat } from "../src/store/current-chat";

const root = resolve(import.meta.dir, "..");
const work = mkdtempSync(join(tmpdir(), "aichat-attachments-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const models = (JSON.parse(readFileSync(join(root, "tests/fixtures/models/models.json"), "utf8")).data as unknown[])
  .map(normalizeModel)
  .filter((m): m is ModelRecord => m !== null);
const model = (id: string) => models.find((m) => m.id === id)!;

class SpyHost extends BunHost {
  reads: string[] = [];
  readBytesFrom(path: string, offset: number, maxLength?: number) {
    this.reads.push(path);
    return super.readBytesFrom(path, offset, maxLength);
  }
}

let counter = 0;
function fresh(extra: Record<string, string> = {}, fakes: Record<string, FakeCommand> = {}) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "cache"), { recursive: true });
  mkdirSync(join(dir, "files"));
  writeFileSync(join(dir, "cache/models.json"), JSON.stringify({ fetchedAt: Date.now(), models }));
  const env = { PATH: process.env.PATH, ...parseEnvFile(join(root, "tests/fixtures/dev.env")), alfred_workflow_data: join(dir, "data"), alfred_workflow_cache: join(dir, "cache"), ...extra };
  const host = new SpyHost({ env, fakeCommands: fakes });
  const config = readConfig(host);
  const chat = createChat(host);
  return { dir, host, config, chat };
}

const png = renderIcon();
const pdfBytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Page>>endobj\n2 0 obj<</Type/Page>>endobj\n%%EOF");

function write(dir: string, name: string, data: Uint8Array | string) {
  const path = join(dir, "files", name);
  writeFileSync(path, data);
  return path;
}

function payloadContext(env: ReturnType<typeof fresh>, over: Partial<PayloadContext> & { modelId: string }): PayloadContext {
  const chat = getChat(env.host, env.chat.id)!;
  const options: PayloadOptions = { modelId: over.modelId, model: over.model ?? model(over.modelId) ?? null, stream: true, pdfEngine: "auto", web: false, privacy: "standard" };
  return {
    host: env.host,
    config: env.config,
    chat,
    modelId: over.modelId,
    model: options.model,
    turns: over.turns ?? [{ role: "user", content: "look" }],
    window: over.window ?? [],
    draft: over.draft ?? { text: "look", attachments: chat.pending },
    options,
  };
}

describe("sha256 and classification", () => {
  test("sha256 matches the reference for lengths around the block boundaries", () => {
    for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + length) & 255);
      expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  test("images, PDFs, and unknown types", () => {
    expect(classifyName("a.PNG")).toEqual({ kind: "image", ext: "png", mime: "image/png" });
    expect(classifyName("a.jpeg")).toEqual({ kind: "image", ext: "jpg", mime: "image/jpeg" });
    expect(classifyName("a.webp").mime).toBe("image/webp");
    expect(classifyName("a.gif").mime).toBe("image/gif");
    expect(classifyName("doc.pdf")).toEqual({ kind: "file", ext: "pdf", mime: "application/pdf" });
    expect(classifyName("notes.md").kind).toBe("unknown");
    expect(classifyName("Makefile")).toMatchObject({ kind: "unknown", ext: "txt" });
    expect(looksLikeText(Uint8Array.from([104, 105]))).toBe(true);
    expect(looksLikeText(Uint8Array.from([104, 0, 105]))).toBe(false);
  });
});

describe("attaching files", () => {
  test("happy: a PNG and a two-page PDF become one image_url part and one file part with cloudflare-ai, and moving the original PNG changes nothing", () => {
    const env = fresh({}, { sips: (args) => ({ exit: 0, stdout: args.includes("-g") ? "pixelWidth: 1200\npixelHeight: 900\n" : "", stderr: "" }) });
    const pngPath = write(env.dir, "shot.png", png);
    const pdfPath = write(env.dir, "doc.pdf", pdfBytes);
    const result = attachPaths(env.host, env.config, env.chat.id, [pngPath, pdfPath]);
    expect(result.errors).toEqual([]);
    expect(result.added.map((r) => [r.name, r.kind, r.mime])).toEqual([["shot.png", "image", "image/png"], ["doc.pdf", "file", "application/pdf"]]);
    expect(existsSync(join(chatDir(env.host, env.chat.id), result.added[0]!.file))).toBe(true);
    expect(result.added[0]!.sha).toBe(createHash("sha256").update(png).digest("hex"));
    expect(env.host.calls.filter((c) => c.includes("-Z"))).toEqual([]);

    const build = () => {
      const ctx = payloadContext(env, { modelId: "mistralai/mistral-small" });
      const contribution = feature.payloadOptions!(ctx);
      if (!contribution || contribution.refuse !== undefined) throw new Error("refused");
      return JSON.stringify(buildBody(contribution.turns ?? ctx.turns, ctx.options));
    };
    const first = build();
    const body = JSON.parse(first);
    expect(body.messages[0].content.map((p: any) => p.type)).toEqual(["text", "image_url", "file"]);
    expect(body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }]);
    renameSync(pngPath, `${pngPath}.moved`);
    expect(build()).toBe(first);
  });

  test("a PNG over the longest-edge setting is resized into a temporary copy and the source is untouched", () => {
    const small = renderIcon();
    const env = fresh({ image_max_edge: "1024" }, {
      sips: (args) => {
        if (args.includes("-g")) return { exit: 0, stdout: "pixelWidth: 3000\npixelHeight: 2000\n", stderr: "" };
        const out = args[args.indexOf("--out") + 1]!;
        writeFileSync(out, small);
        return { exit: 0, stdout: "", stderr: "" };
      },
    });
    const big = Uint8Array.from([...png, 1, 2, 3, 4]);
    const path = write(env.dir, "big.png", big);
    const result = attachPaths(env.host, env.config, env.chat.id, [path]);
    expect(result.added[0]!.sha).toBe(sha256Hex(small));
    expect(readFileSync(path).length).toBe(big.length);
    const resize = env.host.calls.find((c) => c.includes("-Z"))!;
    expect(resize.slice(1, 3)).toEqual(["-Z", "1024"]);
    expect(existsSync(resize[resize.indexOf("--out") + 1]!)).toBe(false);
  });

  test("a gif and a webp are sent as they are and never go through sips", () => {
    const env = fresh();
    const result = attachPaths(env.host, env.config, env.chat.id, [write(env.dir, "a.gif", "GIF89a"), write(env.dir, "b.webp", "RIFFxxxxWEBP")]);
    expect(result.errors).toEqual([]);
    expect(env.host.calls).toEqual([]);
  });

  test("failure: a PDF of 20 MB plus one byte is refused by its size before any read, naming the cap", () => {
    const env = fresh();
    const path = write(env.dir, "huge.pdf", Buffer.alloc(20 * 1024 * 1024 + 1));
    env.host.reads = [];
    const result = attachPaths(env.host, env.config, env.chat.id, [path]);
    expect(result.added).toEqual([]);
    expect(result.errors[0]).toContain("20 MB");
    expect(env.host.reads.filter((p) => p === path)).toEqual([]);
    expect(getChat(env.host, env.chat.id)!.pending).toEqual([]);
  });

  test("at most 8 files wait per message, text files are capped, and binary or missing files are explained", () => {
    const env = fresh({ text_attachment_max_kb: "1" });
    const paths = Array.from({ length: 9 }, (_, i) => write(env.dir, `f${i}.png`, Uint8Array.from([...png, i])));
    const result = attachPaths(env.host, env.config, env.chat.id, paths);
    expect(result.added).toHaveLength(8);
    expect(result.errors[0]).toContain("8 files");
    const second = fresh({ text_attachment_max_kb: "1" });
    const out = attachPaths(second.host, second.config, second.chat.id, [
      write(second.dir, "big.txt", "x".repeat(2048)),
      write(second.dir, "blob.bin", Uint8Array.from([1, 0, 2])),
      join(second.dir, "files/missing.txt"),
      join(second.dir, "files"),
      write(second.dir, "ok.txt", "hello"),
    ]);
    expect(out.added.map((r) => [r.name, r.kind])).toEqual([["ok.txt", "text"]]);
    expect(out.errors.map((e) => e.split(":")[0])).toEqual(["big.txt", "blob.bin", "missing.txt", "files"]);
    expect(out.errors[0]).toContain("1 KB");
  });

  test("text files are inlined into the message and pasted images become pending PNGs", () => {
    const env = fresh();
    attachPaths(env.host, env.config, env.chat.id, [write(env.dir, "notes.txt", "line one\nline two")]);
    const ctx = payloadContext(env, { modelId: "deepseek/deepseek-r2" });
    const contribution = feature.payloadOptions!(ctx) as { turns: { content: string; attachments?: unknown[] }[] };
    expect(contribution.turns[0]!.content).toBe('look\n\n<attached_file name="notes.txt">\nline one\nline two\n</attached_file>');
    expect(contribution.turns[0]!.attachments).toBeUndefined();
    const pasted = attachBytes(env.host, env.config, env.chat.id, "clipboard-1.png", png);
    expect(pasted.added[0]!.kind).toBe("image");
    expect(attachBytes(env.host, env.config, env.chat.id, "x.pdf", pdfBytes).errors[0]).toContain("only images");
  });

  test("a text file's name cannot end the tag it is quoted in", () => {
    const env = fresh();
    attachPaths(env.host, env.config, env.chat.id, [write(env.dir, 'a"><b>&.txt', "body")]);
    const ctx = payloadContext(env, { modelId: "deepseek/deepseek-r2" });
    const contribution = feature.payloadOptions!(ctx) as { turns: { content: string }[] };
    expect(contribution.turns[0]!.content).toContain('<attached_file name="a&quot;&gt;&lt;b&gt;&amp;.txt">');
  });

  test("a resized snapshot holds the smaller copy, and an image part is the snapshot's own base64", () => {
    const small = renderIcon();
    const env = fresh({ image_max_edge: "1024" }, {
      sips: (args) => {
        if (args.includes("-g")) return { exit: 0, stdout: "pixelWidth: 3000\npixelHeight: 2000\n", stderr: "" };
        writeFileSync(args[args.indexOf("--out") + 1]!, small);
        return { exit: 0, stdout: "", stderr: "" };
      },
    });
    const ref = attachPaths(env.host, env.config, env.chat.id, [write(env.dir, "big.png", Uint8Array.from([...png, 9]))]).added[0]!;
    const snapshot = join(env.dir, "data", "chats", env.chat.id, ref.file);
    expect(Buffer.from(readFileSync(snapshot)).equals(Buffer.from(small))).toBe(true);
    const ctx = payloadContext(env, { modelId: "google/gemini-3-flash" });
    const contribution = feature.payloadOptions!(ctx) as { turns: { attachments?: { base64: string }[] }[] };
    expect(contribution.turns.at(-1)!.attachments![0]!.base64).toBe(Buffer.from(small).toString("base64"));
  });
});

describe("history-wide modality checks", () => {
  function imageChat(env: ReturnType<typeof fresh>) {
    const ref = attachPaths(env.host, env.config, env.chat.id, [write(env.dir, "shot.png", png)]).added[0]!;
    mutateChat(env.host, env.chat.id, (c) => {
      c.pending = [];
      c.messages.push({ id: "u", requestId: "r", role: "user", content: "see", attachments: [ref], status: "ok", createdAt: 1 });
      c.messages.push({ id: "a", requestId: "r", role: "assistant", content: "cat", attachments: [], status: "ok", createdAt: 1 });
    });
    return ref;
  }
  const turns = (chat: Chat) => [
    { role: "user" as const, content: "see" },
    { role: "assistant" as const, content: "cat" },
    { role: "user" as const, content: "and now" },
    ...(chat.messages.length > 99 ? [] : []),
  ];

  test("an image earlier in the chat sent to a text-only model with no fallback is refused naming the model", () => {
    const env = fresh({ vision_fallback_model: "" });
    imageChat(env);
    const chat = getChat(env.host, env.chat.id)!;
    const ctx = payloadContext(env, { modelId: "deepseek/deepseek-r2", turns: turns(chat), window: chat.messages, draft: { text: "and now", attachments: [] } });
    const contribution = feature.payloadOptions!(ctx) as { refuse?: string };
    expect(contribution.refuse).toContain("DeepSeek: R2");
    expect(contribution.refuse).toContain("still in the input");
  });

  test("a vision fallback that accepts the parts is used for that request and named", () => {
    const env = fresh({ vision_fallback_model: "mistralai/mistral-small" });
    imageChat(env);
    const chat = getChat(env.host, env.chat.id)!;
    const ctx = payloadContext(env, { modelId: "deepseek/deepseek-r2", turns: turns(chat), window: chat.messages, draft: { text: "and now", attachments: [] } });
    const contribution = feature.payloadOptions!(ctx) as { options: { modelId: string }; notes: string[]; turns: { attachments?: unknown[] }[] };
    expect(contribution.options.modelId).toBe("mistralai/mistral-small");
    expect(contribution.notes[0]).toContain("mistralai/mistral-small");
    expect(contribution.turns[0]!.attachments).toHaveLength(1);
  });

  test("a model that reads images needs no fallback, and a missing snapshot refuses naming it", () => {
    const env = fresh();
    const ref = imageChat(env);
    const chat = getChat(env.host, env.chat.id)!;
    const build = () => payloadContext(env, { modelId: "mistralai/mistral-small", turns: turns(chat), window: chat.messages, draft: { text: "and now", attachments: [] } });
    expect((feature.payloadOptions!(build()) as { refuse?: string }).refuse).toBeUndefined();
    rmSync(join(chatDir(env.host, env.chat.id), ref.file));
    expect((feature.payloadOptions!(build()) as { refuse?: string }).refuse).toContain("shot.png");
  });

  test("a PDF needs a file-capable model only under the native engine", () => {
    const env = fresh();
    attachPaths(env.host, env.config, env.chat.id, [write(env.dir, "doc.pdf", pdfBytes)]);
    const ctx = payloadContext(env, { modelId: "mistralai/mistral-small" });
    expect((feature.payloadOptions!(ctx) as { refuse?: string }).refuse).toBeUndefined();
    ctx.options.pdfEngine = "native";
    expect((feature.payloadOptions!(ctx) as { refuse?: string }).refuse).toContain("PDFs");
  });

  test("an unknown model record cannot be checked and is let through", () => {
    const env = fresh();
    imageChat(env);
    const chat = getChat(env.host, env.chat.id)!;
    const ctx = payloadContext(env, { modelId: "x/unknown", model: null, turns: turns(chat), window: chat.messages, draft: { text: "and now", attachments: [] } });
    expect((feature.payloadOptions!(ctx) as { refuse?: string }).refuse).toBeUndefined();
  });

  test("the encoded body is refused above 32 MB", () => {
    const env = fresh();
    const ctx = payloadContext(env, { modelId: "mistralai/mistral-small" });
    expect(feature.validateBody!(ctx, "x".repeat(MAX_BODY_BYTES + 1))).toContain("32 MB");
    expect(feature.validateBody!(ctx, "small")).toBeNull();
  });
});

describe("attachment commands", () => {
  function context(env: ReturnType<typeof fresh>): CommandContext {
    return { host: env.host, config: env.config, chat: currentChat(env.host), ensureChat: () => ensureCurrentChat(env.host, env.config) };
  }
  const run = (env: ReturnType<typeof fresh>, name: string, args = "") => (feature.commands![name]!.run(context(env), args) as { text: string }).text;

  test("/attach attaches the chosen files; cancel and picker errors have their own messages", () => {
    const base = fresh();
    const path = write(base.dir, "pic.png", png);
    const chosen = new BunHost({ env: base.host.env, chooseFiles: () => ({ cancelled: false, paths: [path] }) });
    const env = { ...base, host: chosen as unknown as SpyHost };
    expect(run(env, "attach")).toContain("Attached: pic.png");
    expect(currentChat(chosen)!.pending).toHaveLength(1);
    const cancelled = { ...base, host: new BunHost({ env: base.host.env }) as unknown as SpyHost };
    expect(run(cancelled, "attach")).toBe("No file was chosen.");
    const broken = { ...base, host: new BunHost({ env: base.host.env, chooseFiles: () => { throw new Error("no ui"); } }) as unknown as SpyHost };
    expect(run(broken, "attach")).toContain("Universal Action");
  });

  test("/paste, /attachments, /detach, and /pdf", () => {
    const base = fresh();
    const host = new BunHost({ env: base.host.env, clipboardPng: () => png });
    const env = { ...base, host: host as unknown as SpyHost };
    expect(run(env, "paste")).toContain("Attached: clipboard-");
    expect(run(env, "attachments")).toContain("1. clipboard-");
    expect(run(env, "detach", "5")).toContain("Give a number from 1 to 1");
    expect(run(env, "detach", "1")).toContain("Removed clipboard-");
    expect(run(env, "attachments")).toContain("No files are waiting");
    expect(run({ ...base, host: new BunHost({ env: base.host.env }) as unknown as SpyHost }, "paste")).toBe("There is no image on the clipboard.");

    expect(run(env, "pdf")).toContain("PDF engine: **auto**");
    expect(run(env, "pdf", "OCR")).toContain("billed per page");
    expect(currentChat(host)!.settings.pdfEngine).toBe("ocr");
    expect(run(env, "pdf", "auto")).toContain("**auto**");
    expect(currentChat(host)!.settings.pdfEngine).toBe("auto");
    expect(run(env, "pdf", "bogus")).toContain("Unknown PDF engine");
  });

  test("the footer counts waiting files", () => {
    const env = fresh();
    attachPaths(env.host, env.config, env.chat.id, [write(env.dir, "a.png", png)]);
    const flags = feature.footerFlags!({ host: env.host, config: env.config, chat: getChat(env.host, env.chat.id), modelId: "m", record: null });
    expect(flags).toEqual([expect.stringContaining("📎 1 waiting")]);
    mutateChat(env.host, env.chat.id, (chat) => {
      chat.settings.pdfEngine = "ocr";
    });
    const withOcr = feature.footerFlags!({ host: env.host, config: env.config, chat: getChat(env.host, env.chat.id), modelId: "m", record: null });
    expect(withOcr).toEqual(["pdf ocr", expect.stringContaining("📎 1 waiting")]);
  });
});
