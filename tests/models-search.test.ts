import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeModel, type ModelRecord } from "../src/core/capabilities";
import { badges, formatContext, formatPrice, formatSubtitle, parseQuery, searchModels } from "../src/core/models-search";

const models = (JSON.parse(readFileSync(resolve(import.meta.dir, "fixtures/models/models.json"), "utf8")).data as unknown[])
  .map(normalizeModel)
  .filter((m): m is ModelRecord => m !== null);
const ids = (list: ModelRecord[]) => list.map((m) => m.id);

describe("model search", () => {
  test("tokens filter by capability and words rank id and name matches", () => {
    expect(parseQuery("#image  Gemini #FREE")).toEqual({ words: ["gemini"], image: true, imagegen: false, file: false, free: true, reasoning: false });
    expect(ids(searchModels(models, "#imagegen"))).toEqual(["google/gemini-3-flash-image"]);
    expect(ids(searchModels(models, "#image gemini"))).toEqual(["google/gemini-3-flash", "google/gemini-3-flash-image"]);
    expect(ids(searchModels(models, "#free"))).toEqual(["meta-llama/llama-4-free:free"]);
    expect(ids(searchModels(models, "#reasoning"))).toEqual(["anthropic/claude-sonnet-5.5", "google/gemini-3-flash", "openai/gpt-5.4-nano", "deepseek/deepseek-r2"]);
    expect(ids(searchModels(models, "#file #image"))).toHaveLength(3);
    expect(searchModels(models, "zzz")).toEqual([]);
  });

  test("an exact or prefix match outranks a substring, and every word must match", () => {
    expect(ids(searchModels(models, "gemini flash image"))).toEqual(["google/gemini-3-flash-image"]);
    expect(searchModels(models, "claude")[0]!.id).toBe("anthropic/claude-sonnet-5.5");
    expect(searchModels(models, "mistral small")[0]!.id).toBe("mistralai/mistral-small");
  });

  test("favorites come first, in the order they were added, then the limit applies", () => {
    const list = searchModels(models, "", { favorites: ["openai/gpt-5.4-nano", "deepseek/deepseek-r2"], limit: 3 });
    expect(ids(list)).toEqual(["openai/gpt-5.4-nano", "deepseek/deepseek-r2", "anthropic/claude-sonnet-5.5"]);
  });

  test("badges, prices per million, and context length read as plain text", () => {
    const claude = models[0]!;
    expect(badges(claude)).toBe("🖼 📄 🧠");
    expect(badges(models.find((m) => m.id === "google/gemini-3-flash-image")!)).toBe("🖼 🎨");
    expect(formatSubtitle(claude)).toBe("🖼 📄 🧠 · $3 in · $15 out per 1M tokens · 1M context");
    expect(formatSubtitle(models.find((m) => m.id.endsWith(":free"))!)).toBe("🆓 · free · 131k context");
    expect(formatPrice(0.05)).toBe("$0.05");
    expect(formatPrice(0.075)).toBe("$0.075");
    expect(formatPrice(2.5)).toBe("$2.5");
    expect(formatContext(1048576)).toBe("1M");
    expect(formatContext(200000)).toBe("200k");
    expect(formatContext(512)).toBe("512");
  });

  test("the first item of a #image gemini search shows the image badge", () => {
    expect(formatSubtitle(searchModels(models, "#image gemini")[0]!)).toContain("🖼");
  });
});

describe("what counts as free", () => {
  const raw = (id: string, pricing: Record<string, string>, output: string[]) =>
    normalizeModel({ id, name: id, context_length: 66000, pricing: { prompt: "0", completion: "0", ...pricing }, architecture: { input_modalities: ["text"], output_modalities: output } })!;

  test("an image model with a zero token price is priced per image, not free", () => {
    const qwen = raw("qwen/qwen-image-2.1-turbo", { image_token: "0.0000044", image_output: "0.0000044" }, ["image"]);
    expect(formatSubtitle(qwen)).toBe("🎨 · priced per image · 66k context");
    expect(badges(qwen)).not.toContain("🆓");
    expect(ids(searchModels([qwen], "#free"))).toEqual([]);
    expect(formatSubtitle(raw("flux/plain", {}, ["image"]))).toContain("priced per image");
  });

  test("video and rerank models without a price say priced per use, and :free variants stay free", () => {
    expect(formatSubtitle(raw("alibaba/wan-3.0", {}, ["video"]))).toContain("priced per use");
    expect(formatSubtitle(raw("voyageai/rerank-3", {}, ["rerank"]))).toContain("priced per use");
    expect(formatSubtitle(raw("nvidia/rerank:free", {}, ["rerank"]))).toContain("free");
    expect(formatSubtitle(raw("some/text-model", {}, ["text"]))).toContain("free");
    expect(formatSubtitle(raw("some/paid-text", { web_search: "0.01" }, ["text"]))).toContain("free");
  });

  test("a model that bills input but not output shows only the input price", () => {
    const asr = normalizeModel({ id: "qwen/qwen3-asr-1.7b", name: "ASR", context_length: 0, pricing: { prompt: "0.0000075", completion: "0" }, architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] } })!;
    expect(formatSubtitle(asr)).toBe("$7.5 in per 1M tokens");
  });
});
