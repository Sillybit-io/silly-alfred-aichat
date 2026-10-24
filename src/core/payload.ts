import { TEST_HOOKS } from "./hooks";
import { acceptsFile, efforts, type ModelRecord } from "./capabilities";
import type { Annotation } from "./stream";

export type PdfEngine = "auto" | "free" | "ocr" | "native";

// standard: any provider the account allows. deny: only providers that do not store or train on prompts.
// zdr: only zero-data-retention endpoints. Sent with every chat request; the image API has no such field.
export type PrivacyMode = "standard" | "deny" | "zdr";

export function providerPreferences(mode: PrivacyMode): Record<string, unknown> | null {
  if (mode === "zdr") return { data_collection: "deny", zdr: true };
  if (mode === "deny") return { data_collection: "deny" };
  return null;
}

export type AttachmentPart = {
  kind: "image" | "file";
  name: string;
  mime: string;
  base64: string;
};

export type ContextTurn = {
  role: "system" | "user" | "assistant";
  content: string;
  attachments?: AttachmentPart[];
  annotations?: Annotation[];
};

export type PayloadOptions = {
  modelId: string;
  model: ModelRecord | null;
  stream: boolean;
  pdfEngine: PdfEngine;
  web: boolean;
  webMaxResults?: number;
  effort?: string | null;
  excludeReasoning?: boolean;
  privacy: PrivacyMode;
};

export const DEFAULT_API_BASE = "https://openrouter.ai/api/v1";

export function apiBase(env: Record<string, string | undefined>): string {
  const configured = TEST_HOOKS ? (env.aichat_api_base ?? "").trim() : "";
  return (configured === "" ? DEFAULT_API_BASE : configured).replace(/\/+$/, "");
}

export function chatUrl(env: Record<string, string | undefined>): string {
  return `${apiBase(env)}/chat/completions`;
}

type Json = { [key: string]: unknown };

function contentFor(turn: ContextTurn): string | Json[] {
  const attachments = turn.attachments ?? [];
  if (attachments.length === 0) return turn.content;
  const parts: Json[] = [{ type: "text", text: turn.content }];
  for (const part of attachments) {
    if (part.kind === "image") {
      parts.push({ type: "image_url", image_url: { url: `data:${part.mime};base64,${part.base64}` } });
    }
  }
  for (const part of attachments) {
    if (part.kind === "file") {
      parts.push({ type: "file", file: { filename: part.name, file_data: `data:${part.mime};base64,${part.base64}` } });
    }
  }
  return parts;
}

function fileParserEngine(engine: PdfEngine, model: ModelRecord | null): string | null {
  if (engine === "free") return "cloudflare-ai";
  if (engine === "ocr") return "mistral-ocr";
  if (engine === "native") return "native";
  return acceptsFile(model) ? null : "cloudflare-ai";
}

function fileHash(annotation: Annotation): string | null {
  const file = annotation.file;
  if (typeof file === "object" && file !== null && !Array.isArray(file)) {
    const hash = (file as Json).hash;
    if (typeof hash === "string" && hash !== "") return hash;
  }
  return null;
}

function reasoningFor(options: PayloadOptions): Json | null {
  const model = options.model;
  if (!model || !model.reasoning) return null;
  const reasoning: Json = {};
  const effort = options.effort ?? null;
  if (effort !== null && efforts(model).includes(effort)) reasoning.effort = effort;
  if (options.excludeReasoning) reasoning.exclude = true;
  return Object.keys(reasoning).length > 0 ? reasoning : null;
}

export function buildBody(turns: ContextTurn[], options: PayloadOptions): Json {
  const hasFile = turns.some((turn) => (turn.attachments ?? []).some((part) => part.kind === "file"));
  const echoed = new Set<string>();
  const messages = turns.map((turn) => {
    const message: Json = { role: turn.role, content: contentFor(turn) };
    if (hasFile && turn.role === "assistant" && turn.annotations) {
      const fresh = turn.annotations.filter((annotation) => {
        const hash = annotation.type === "file" ? fileHash(annotation) : null;
        if (hash === null || echoed.has(hash)) return false;
        echoed.add(hash);
        return true;
      });
      if (fresh.length > 0) message.annotations = fresh;
    }
    return message;
  });

  const body: Json = { model: options.modelId, messages, stream: options.stream };
  const plugins: Json[] = [];
  if (hasFile) {
    const engine = fileParserEngine(options.pdfEngine, options.model);
    if (engine !== null) plugins.push({ id: "file-parser", pdf: { engine } });
  }
  if (options.web) {
    const web: Json = { id: "web" };
    if (options.webMaxResults !== undefined) web.max_results = options.webMaxResults;
    plugins.push(web);
  }
  if (plugins.length > 0) body.plugins = plugins;
  const reasoning = reasoningFor(options);
  if (reasoning) body.reasoning = reasoning;
  const provider = providerPreferences(options.privacy);
  if (provider) body.provider = provider;
  return body;
}

export function encodeBody(body: Json): string {
  return JSON.stringify(body);
}
