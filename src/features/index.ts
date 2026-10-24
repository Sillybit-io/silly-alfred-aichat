import type { ModelRecord } from "../core/capabilities";
import type { ContextTurn, PayloadOptions, PdfEngine, PrivacyMode } from "../core/payload";
import type { StreamState } from "../core/stream";
import { keyProblem } from "../host/common";
import type { Host } from "../host/types";
import type { Chat, Message } from "../store/chats";
import type { Draft, Finalizers, Outcome, RequestKind, RequestRecord } from "../store/requests";
import { feature as attachments } from "./attachments";
import { feature as history } from "./history";
import { feature as image } from "./image";
import { feature as model } from "./model";
import { feature as reasoning } from "./reasoning";
import { feature as web } from "./web";

// Workflow Configuration arrives as environment variables; checkboxes are "1" or "0".
export type Config = {
  // Empty when missing or unusable; keyIssue then says why a present key was refused.
  apiKey: string;
  keyIssue: string | null;
  defaultModel: string;
  privacy: PrivacyMode;
  webRewrite: boolean;
  systemPrompt: string;
  systemContext: boolean;
  presetClipboard: boolean;
  maxContext: number;
  timeoutSeconds: number;
  pdfEngine: PdfEngine;
  webDefault: boolean;
  webMaxResults: number;
  reasoningDefault: string;
  keepReasoning: boolean;
  autoTitles: boolean;
  titleModel: string;
  translateLanguage: string;
  exportFolder: string;
  imagesFolder: string;
  imageModel: string;
  savePrompts: boolean;
  imageTimeoutSeconds: number;
  visionFallbackModel: string;
  retentionDays: number;
  maxChats: number;
  textAttachmentMaxKb: number;
  imageMaxEdge: number;
};

export const FALLBACK_MODEL = "openrouter/auto";

function int(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function text(value: string | undefined, fallback: string): string {
  return value !== undefined && value.trim() !== "" ? value.trim() : fallback;
}

export function readConfig(host: Host): Config {
  const env = host.env;
  const engine = text(env.pdf_engine, "auto");
  const privacy = text(env.privacy_mode, "deny");
  const key = (env.openrouter_api_key ?? "").trim();
  const keyIssue = keyProblem(key);
  return {
    apiKey: keyIssue === null ? key : "",
    keyIssue,
    defaultModel: text(env.default_model, FALLBACK_MODEL),
    privacy: privacy === "standard" || privacy === "zdr" ? privacy : "deny",
    webRewrite: env.web_rewrite !== "0",
    systemPrompt: env.system_prompt ?? "",
    systemContext: env.system_context !== "0",
    presetClipboard: env.preset_clipboard === "1",
    maxContext: Math.max(1, int(env.max_context, 20)),
    timeoutSeconds: Math.max(5, int(env.timeout_seconds, 90)),
    pdfEngine: engine === "free" || engine === "ocr" || engine === "native" ? engine : "auto",
    webDefault: env.web_default === "1",
    webMaxResults: Math.max(1, int(env.web_max_results, 5)),
    reasoningDefault: text(env.reasoning_default, "model"),
    keepReasoning: env.keep_reasoning === "1",
    autoTitles: env.auto_titles !== "0",
    titleModel: text(env.title_model, ""),
    translateLanguage: text(env.translate_language, "English"),
    exportFolder: text(env.export_folder, "~/Documents/AI Chat"),
    imagesFolder: text(env.images_folder, "~/Pictures/AI Chat"),
    imageModel: text(env.image_model, ""),
    savePrompts: env.image_save_prompt === "1",
    imageTimeoutSeconds: Math.max(10, int(env.image_timeout_seconds, 300)),
    visionFallbackModel: text(env.vision_fallback_model, ""),
    retentionDays: Math.max(0, int(env.retention_days, 0)),
    maxChats: Math.max(0, int(env.max_chats, 0)),
    textAttachmentMaxKb: Math.max(1, int(env.text_attachment_max_kb, 200)),
    imageMaxEdge: Math.max(64, int(env.image_max_edge, 2048)),
  };
}

export type CommandContext = {
  host: Host;
  config: Config;
  // The current chat, or null before the first message.
  chat: Chat | null;
  // Creates the chat (and makes it current) when a command needs somewhere to store a setting.
  ensureChat(): Chat;
};

// A notice is shown above the transcript; started hands a request the command admitted to the view.
export type CommandOutcome = { kind: "notice"; text: string } | { kind: "started"; rid: string };

export type Command = {
  usage: string;
  help: string;
  run(ctx: CommandContext, args: string): CommandOutcome;
};

export type PayloadContext = {
  host: Host;
  config: Config;
  chat: Chat;
  modelId: string;
  model: ModelRecord | null;
  // System prompt, the context window, then the draft as the last turn; attachments are not filled in yet.
  turns: ContextTurn[];
  // The messages behind the non-system history turns, in order.
  window: Message[];
  draft: Draft;
  options: PayloadOptions;
};

export type PayloadContribution = {
  // Overrides merged into the body options (effort, web, pdfEngine, a fallback model).
  options?: Partial<PayloadOptions>;
  // A replacement for the turns, e.g. with attachment parts built from snapshots.
  turns?: ContextTurn[];
  // Shown in the footer while the request runs, e.g. the vision fallback in use.
  notes?: string[];
  // Refuses the send: the text is shown, nothing is admitted, and the draft stays in the input.
  refuse?: string;
};

export type FooterContext = {
  host: Host;
  config: Config;
  chat: Chat | null;
  modelId: string;
  model: ModelRecord | null;
  record: RequestRecord | null;
};

export type LiveContext = {
  host: Host;
  config: Config;
  chat: Chat | null;
  record: RequestRecord;
  state: StreamState;
};

export type AfterCommitContext = {
  host: Host;
  config: Config;
  record: RequestRecord;
  outcome: Outcome;
};

export interface Feature {
  commands?: Record<string, Command>;
  payloadOptions?(ctx: PayloadContext): PayloadContribution | void;
  // Returns a refusal for an encoded body that is too large, or null.
  validateBody?(ctx: PayloadContext, body: string): string | null;
  footerFlags?(ctx: FooterContext): string[];
  // Returns Markdown for the assistant section while streaming, or null for the default.
  renderLive?(ctx: LiveContext): string | null;
  afterCommit?(ctx: AfterCommitContext): void;
  finalizers?: Partial<Record<Exclude<RequestKind, "chat">, NonNullable<Finalizers[RequestKind]>>>;
}

export const features: Feature[] = [model, attachments, reasoning, web, history, image];

export function allCommands(): Record<string, Command> {
  const commands: Record<string, Command> = {};
  for (const feature of features) Object.assign(commands, feature.commands ?? {});
  return commands;
}

export function collectFooterFlags(ctx: FooterContext): string[] {
  return features.flatMap((feature) => (feature.footerFlags ? feature.footerFlags(ctx) : []));
}

export function renderLiveSection(ctx: LiveContext): string | null {
  for (const feature of features) {
    const rendered = feature.renderLive ? feature.renderLive(ctx) : null;
    if (rendered !== null) return rendered;
  }
  return null;
}

// Every tick and every finalizeDue call passes these: title and image outcomes go to their
// features, and the chat entry observes each committed reply to run the afterCommit hooks.
export function collectFinalizers(config: Config): Finalizers {
  const finalizers: Finalizers = {};
  for (const feature of features) Object.assign(finalizers, feature.finalizers ?? {});
  finalizers.chat = (host, record, outcome) => {
    for (const feature of features) if (feature.afterCommit) feature.afterCommit({ host, config, record, outcome });
  };
  return finalizers;
}
