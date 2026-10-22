import { describe, expect, test } from "bun:test";
import { acceptsFile, acceptsImage, efforts, normalizeModel, perMillion } from "../src/core/capabilities";
import { apiBase, buildBody, chatUrl, encodeBody, type AttachmentPart, type ContextTurn } from "../src/core/payload";

const textImage = normalizeModel({
  id: "vendor/vision",
  name: "Vision",
  context_length: 128000,
  pricing: { prompt: "0.000003", completion: "0.000015" },
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  supported_parameters: ["reasoning"],
})!;
const withFile = normalizeModel({ id: "vendor/pdf", architecture: { input_modalities: ["text", "file"] } })!;
const mandatory = normalizeModel({
  id: "vendor/think",
  architecture: { input_modalities: ["text"] },
  reasoning: { supported_efforts: ["high", "medium", "low"], mandatory: true, default_effort: "medium" },
})!;
const optional = normalizeModel({
  id: "vendor/opt",
  architecture: { input_modalities: ["text"] },
  reasoning: { supported_efforts: ["high", "low", "none"], mandatory: false },
})!;

const png: AttachmentPart = { kind: "image", name: "shot.png", mime: "image/png", base64: "AAAA" };
const pdf: AttachmentPart = { kind: "file", name: "doc.pdf", mime: "application/pdf", base64: "BBBB" };
const base = { stream: true, pdfEngine: "auto" as const, web: false };

describe("capabilities", () => {
  test("derives modalities, prices per million, and efforts", () => {
    expect(acceptsImage(textImage)).toBe(true);
    expect(acceptsFile(textImage)).toBe(false);
    expect(acceptsFile(withFile)).toBe(true);
    expect(perMillion(textImage.promptPrice)).toBe(3);
    expect(perMillion(textImage.completionPrice)).toBe(15);
    expect(efforts(mandatory)).toEqual(["high", "medium", "low"]);
    expect(efforts(optional)).toEqual(["high", "low", "none"]);
    expect(efforts(textImage)).toEqual([]);
  });

  test("drops entries without an id and defaults missing fields", () => {
    expect(normalizeModel({ name: "x" })).toBeNull();
    const bare = normalizeModel({ id: "a/b" })!;
    expect(bare.inputModalities).toEqual(["text"]);
    expect(bare.name).toBe("a/b");
    expect(bare.reasoning).toBeNull();
  });
});

describe("buildBody", () => {
  test("one PNG and one PDF for a text and image model under auto: image_url, file, and cloudflare-ai", () => {
    const turns: ContextTurn[] = [{ role: "user", content: "look", attachments: [pdf, png] }];
    const body = buildBody(turns, { ...base, modelId: textImage.id, model: textImage }) as any;
    const parts = body.messages[0].content;
    expect(parts.map((p: any) => p.type)).toEqual(["text", "image_url", "file"]);
    expect(parts[1].image_url.url).toBe("data:image/png;base64,AAAA");
    expect(parts[2].file).toEqual({ filename: "doc.pdf", file_data: "data:application/pdf;base64,BBBB" });
    expect(body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }]);
    expect(body.stream).toBe(true);
  });

  test("PDF engines: auto omits the plugin for a file-capable model, the rest map to their engines", () => {
    const turns: ContextTurn[] = [{ role: "user", content: "x", attachments: [pdf] }];
    const pick = (pdfEngine: any, model = withFile) => (buildBody(turns, { ...base, pdfEngine, modelId: model.id, model }) as any).plugins;
    expect(pick("auto")).toBeUndefined();
    expect(pick("free")).toEqual([{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }]);
    expect(pick("ocr")).toEqual([{ id: "file-parser", pdf: { engine: "mistral-ocr" } }]);
    expect(pick("native")).toEqual([{ id: "file-parser", pdf: { engine: "native" } }]);
  });

  test("no attachment means a string content and no file-parser plugin", () => {
    const body = buildBody([{ role: "user", content: "hi" }], { ...base, modelId: "m", model: null, stream: false }) as any;
    expect(body.messages[0].content).toBe("hi");
    expect(body.plugins).toBeUndefined();
    expect(body.stream).toBe(false);
  });

  test("web plugin carries max_results and combines with the file parser", () => {
    const turns: ContextTurn[] = [{ role: "user", content: "x", attachments: [pdf] }];
    const body = buildBody(turns, { ...base, web: true, webMaxResults: 3, modelId: textImage.id, model: textImage }) as any;
    expect(body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }, { id: "web", max_results: 3 }]);
  });

  test("reasoning only for models with a reasoning block, never none for a mandatory model", () => {
    const turns: ContextTurn[] = [{ role: "user", content: "x" }];
    const body = (model: any, effort: string | null) => buildBody(turns, { ...base, modelId: model.id, model, effort }) as any;
    expect(body(textImage, "high").reasoning).toBeUndefined();
    expect(body(mandatory, "none").reasoning).toBeUndefined();
    expect(body(mandatory, "low").reasoning).toEqual({ effort: "low" });
    expect(body(optional, "none").reasoning).toEqual({ effort: "none" });
    expect(body(optional, null).reasoning).toBeUndefined();
    expect(body(mandatory, "bogus").reasoning).toBeUndefined();
  });

  test("echoes a known file annotation once, by hash, and never sends deprecated usage options", () => {
    const annotation = { type: "file" as const, file: { hash: "h1", name: "doc.pdf", content: [] } };
    const turns: ContextTurn[] = [
      { role: "user", content: "a", attachments: [pdf] },
      { role: "assistant", content: "r1", annotations: [annotation, { type: "url_citation" }] },
      { role: "user", content: "b" },
      { role: "assistant", content: "r2", annotations: [annotation] },
      { role: "user", content: "c" },
    ];
    const body = buildBody(turns, { ...base, modelId: withFile.id, model: withFile }) as any;
    expect(body.messages[1].annotations).toEqual([annotation]);
    expect(body.messages[3].annotations).toBeUndefined();
    const text = encodeBody(body);
    expect(text).not.toContain("usage");
    expect(text).not.toContain("include_usage");
  });

  test("annotations are not echoed when no file is in the context", () => {
    const annotation = { type: "file" as const, file: { hash: "h1", content: [] } };
    const body = buildBody([{ role: "assistant", content: "r", annotations: [annotation] }], { ...base, modelId: "m", model: null }) as any;
    expect(body.messages[0].annotations).toBeUndefined();
  });
});

describe("api base", () => {
  test("uses aichat_api_base without a trailing slash, else OpenRouter", () => {
    expect(apiBase({})).toBe("https://openrouter.ai/api/v1");
    expect(chatUrl({ aichat_api_base: "http://127.0.0.1:9/v1/" })).toBe("http://127.0.0.1:9/v1/chat/completions");
  });
});
