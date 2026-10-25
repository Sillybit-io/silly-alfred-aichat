import { buildBody, chatUrl, encodeBody, type ContextTurn, type PayloadOptions } from "../core/payload";
import type { MappedError } from "../core/errors";
import { BUILTIN_COMMANDS, parseCommand, renderHelp, type HelpEntry } from "../core/commands";
import { standaloneMessage } from "../store/web-query";
import { contextLine, composeSystemPrompt } from "../core/system-prompt";
import { flattenTables } from "../core/tables";
import { ASSISTANT_HEADING, TURN_BREAK, YOU_HEADING, formatSize, renderTranscript } from "../core/transcript";
import {
  allCommands,
  collectFinalizers,
  collectFooterFlags,
  features,
  readConfig,
  renderLiveSection,
  type CommandContext,
  type Config,
  type PayloadContribution,
  type PayloadContext,
} from "../features/index";
import type { Host } from "../host/types";
import { ensureCatalog } from "../store/catalog";
import { clearCurrent, getChat, getCurrent, type AttachmentRef, type Chat } from "../store/chats";
import { currentChat, ensureCurrentChat } from "../store/current-chat";
import { admit, advance, currentRecord, finalizeDue, loadRecord, stop, type Finalizers, type Outcome, type RequestRecord } from "../store/requests";
import { getSettings } from "../store/settings";
import { readContextInfo } from "../store/system-context";
import { imagesFolder } from "../store/images";
import { imageError, viewJson as renderView, type ViewFrame } from "./view";

const RERUN_SECONDS = 0.1;
const PLACEHOLDER = "…";
const IDLE_HINT = "↩ send · ⌘↩ new · ⌥↩ copy · ⌃↩ copy all · ⇧↩ stop · ⌘⌥↩ chats";
const WELCOME = "Ask anything. Type `/help` for the commands.";

const PHASE_LABEL = { connecting: "connecting", processing: "processing", thinking: "thinking", answering: "answering" } as const;

const chatLane = (chatId: string) => `chat:${chatId}`;
const SOURCE_CAP = 8;

// The workflow's own pictures live in the images folder; no other image is ever shown.
function viewJson(host: Host, config: Config, frame: ViewFrame): string {
  return renderView({ ...frame, imageRoots: [imagesFolder(host, config)] });
}

function viewTranscript(chat: Chat): string {
  return flattenTables(renderTranscript(chat, { sourcesRowCap: SOURCE_CAP }));
}

function resolveModelId(host: Host, config: Config, chat: Chat | null): string {
  return chat?.model ?? getSettings(host).defaultModel ?? config.defaultModel;
}

function draftBlock(text: string, attachments: AttachmentRef[]): string {
  const lines = [YOU_HEADING, "", text];
  for (const attachment of attachments) lines.push("", `📎 ${attachment.name} (${formatSize(attachment.size)})`);
  return lines.join("\n");
}

function errorBlock(error: MappedError): string {
  return [`# ⚠️ ${error.title}`, "", error.detail, "", `**Next:** ${error.next}`].join("\n");
}

function join(...parts: (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== "").join("\n\n");
}

function footer(parts: string[]): string {
  return parts.filter((part) => part !== "").join(" · ");
}

function footerFlagsFor(host: Host, config: Config, chat: Chat | null, modelId: string, record: RequestRecord | null): string[] {
  const flags = collectFooterFlags({ host, config, chat, modelId, record });
  const notes = record && Array.isArray(record.meta.notes) ? (record.meta.notes as string[]) : [];
  return [...flags, ...notes];
}

function ensureModel(host: Host, modelId: string) {
  return ensureCatalog(host).models.find((model) => model.id === modelId) ?? null;
}

// The view when nothing is running: the transcript, a kept draft, and an optional notice above it.
// A notice is information (ℹ️) unless the caller says it is a warning.
function idleView(host: Host, config: Config, notice?: string, icon = "ℹ️"): string {
  const chat = currentChat(host);
  const modelId = resolveModelId(host, config, chat);
  const body = chat && chat.messages.length > 0 ? viewTranscript(chat) : WELCOME;
  const retry = chat?.retry ? `The last message failed (${chat.retry.error}). Type \`/retry\` to send it again.` : null;
  const pending = chat?.pending ?? [];
  const waiting = pending.length > 0 ? ["**📎 Ready to send with your next message**", ...pending.map((ref) => `- ${ref.name} (${formatSize(ref.size)})`), "", "Type your question and press ↩. `/detach` removes a file."].join("\n") : null;
  const attachNotice = (host.env.attach_notice ?? "").trim() !== "" ? `⚠ ${host.env.attach_notice}` : null;
  const frame: ViewFrame = {
    // The view scrolls to the end, so a command's notice goes last, where it is seen.
    response: join(body, retry, attachNotice, waiting, notice ? `${icon} ${notice}` : null),
    footer: footer([modelId, IDLE_HINT, ...footerFlagsFor(host, config, chat, modelId, null)]),
    mode: "replace",
    requestId: "",
    stage: "",
  };
  return viewJson(host, config, frame);
}

function stateLabel(outcome: Outcome | null, record: RequestRecord): string {
  const state = outcome ? outcome.state : record.state;
  return state === "open" ? "failed" : state;
}

// After a terminal state the whole view is rendered again from the stored chat.
function finalView(host: Host, config: Config, record: RequestRecord, outcome: Outcome | null): string {
  const chat = record.chatId ? getChat(host, record.chatId) : null;
  const modelId = record.model;
  const parts: (string | null)[] = [];
  if (chat && chat.messages.length > 0) parts.push(viewTranscript(chat));
  const committed = chat !== null && chat.messages.some((message) => message.requestId === record.id);
  if (!committed) {
    if (record.kind !== "title") {
      if (parts.length > 0) parts.push(TURN_BREAK);
      parts.push(draftBlock(record.draft.text, record.draft.attachments));
    }
    if (record.error) parts.push(errorBlock(record.kind === "image" ? imageError(record.error) : record.error));
    else if (record.state === "stopped") parts.push("_■ Stopped before the first token. Type `/retry` to send it again._");
  }
  if (chat?.retry) parts.push(`_Type \`/retry\` to send the last message again._`);
  return viewJson(host, config, {
    response: join(...parts),
    footer: footer([modelId, stateLabel(outcome, record), ...footerFlagsFor(host, config, chat, modelId, record)]),
    mode: "replace",
    requestId: "",
    stage: "",
  });
}

function assistantSection(host: Host, config: Config, record: RequestRecord, chat: Chat | null): string {
  if (record.kind === "image") return `${ASSISTANT_HEADING}\n\n_Generating image…_`;
  const live = renderLiveSection({ host, config, chat, record, state: record.reducer });
  const body = live ?? (record.reducer.content !== "" ? record.reducer.content : PLACEHOLDER);
  return `${ASSISTANT_HEADING}\n\n${flattenTables(body)}`;
}

// Three frames build the view: the history and your message (replace), the assistant section
// (append), then only that section is rewritten on every tick (replacelast).
function liveView(host: Host, config: Config, record: RequestRecord, stage: string, typed: string): string {
  const chat = record.chatId ? getChat(host, record.chatId) : null;
  const elapsed = Math.max(0, Math.floor((host.nowMs() - record.startedAt) / 1000));
  const phase = record.kind === "image" ? "generating" : PHASE_LABEL[record.reducer.phase];
  const hint = typed !== "" && typed !== record.draft.text ? "⇧↩ to stop, then send your new message" : "";
  const bar = footer([record.model, `${phase} ${elapsed}s`, ...footerFlagsFor(host, config, chat, record.model, record), hint]);
  const base = { footer: bar, requestId: record.id, rerun: RERUN_SECONDS };
  if (stage === "live") {
    return viewJson(host, config, { ...base, response: assistantSection(host, config, record, chat), mode: "replacelast", stage: "live" });
  }
  if (stage === "header") {
    return viewJson(host, config, { ...base, response: assistantSection(host, config, record, chat), mode: "append", stage: "live" });
  }
  const history = chat && chat.messages.length > 0 ? viewTranscript(chat) : null;
  return viewJson(host, config, { ...base, response: join(history, history ? TURN_BREAK : null, draftBlock(record.draft.text, record.draft.attachments)), mode: "replace", stage: "header" });
}

function handleRerun(host: Host, config: Config, finalizers: Finalizers, rid: string, typed: string): string {
  const step = advance(host, rid, finalizers);
  if (!step.tick) return idleView(host, config);
  const record = step.tick.record;
  if (step.tick.terminal) return finalView(host, config, record, step.finalize?.outcome ?? null);
  return liveView(host, config, record, (host.env.view_stage ?? "").trim(), typed);
}

function window(chat: Chat, maxContext: number) {
  const messages = chat.messages.slice(-maxContext);
  while (messages.length > 0 && messages[0]!.role !== "user") messages.shift();
  return messages;
}

type SendOptions = { attachments?: AttachmentRef[]; retryOf?: string };

function send(host: Host, config: Config, finalizers: Finalizers, text: string, options: SendOptions = {}): string {
  if (config.apiKey === "") {
    return idleView(host, config, config.keyIssue ?? "**Add your OpenRouter API key.** Open this workflow's Configuration in Alfred Preferences and paste a key from openrouter.ai/keys. Your message is still in the input.", "⚠️");
  }
  const chat = ensureCurrentChat(host, config);
  const modelId = resolveModelId(host, config, chat);
  const model = ensureModel(host, modelId);
  const draft = { text, attachments: options.attachments ?? chat.pending };
  const history = window(chat, config.maxContext);
  const turns: ContextTurn[] = [];
  const systemPrompt = composeSystemPrompt({
    base: config.systemPrompt,
    context: config.systemContext ? contextLine(readContextInfo(host)) : null,
    web: chat.settings.web,
  });
  if (systemPrompt !== "") turns.push({ role: "system", content: systemPrompt });
  for (const message of history) turns.push({ role: message.role, content: message.content, ...(message.annotations ? { annotations: message.annotations } : {}) });
  const notes: string[] = [];
  let userText = text;
  if (chat.settings.web && config.webRewrite && draft.attachments.length === 0) {
    const standalone = standaloneMessage(host, config.apiKey, config.privacy, config.titleModel !== "" ? config.titleModel : config.defaultModel, history, text);
    if (standalone.text !== null) {
      userText = standalone.text;
      notes.push(`searched “${standalone.text.length > 60 ? `${standalone.text.slice(0, 60)}…` : standalone.text}”`);
    } else if (standalone.failed !== null) {
      notes.push("search rewrite failed");
    }
  }
  turns.push({ role: "user", content: userText });

  let payloadOptions: PayloadOptions = {
    modelId,
    model,
    stream: true,
    pdfEngine: (chat.settings.pdfEngine as PayloadOptions["pdfEngine"] | null) ?? config.pdfEngine,
    web: chat.settings.web,
    webMaxResults: config.webMaxResults,
    effort: chat.settings.effort,
    excludeReasoning: false,
    privacy: config.privacy,
  };
  let currentTurns = turns;
  const context = (): PayloadContext => ({ host, config, chat, modelId: payloadOptions.modelId, model: payloadOptions.model, turns: currentTurns, window: history, draft, options: payloadOptions });
  for (const feature of features) {
    const contribution: PayloadContribution | void = feature.payloadOptions ? feature.payloadOptions(context()) : undefined;
    if (!contribution) continue;
    if (contribution.refuse !== undefined) return idleView(host, config, contribution.refuse, "⚠️");
    if (contribution.options) payloadOptions = { ...payloadOptions, ...contribution.options };
    if (contribution.turns) currentTurns = contribution.turns;
    if (contribution.notes) notes.push(...contribution.notes);
  }
  const body = encodeBody(buildBody(currentTurns, payloadOptions));
  for (const feature of features) {
    const refusal = feature.validateBody ? feature.validateBody(context(), body) : null;
    if (refusal !== null) return idleView(host, config, refusal, "⚠️");
  }

  const result = admit(
    host,
    {
      lane: chatLane(chat.id),
      kind: "chat",
      chatId: chat.id,
      model: payloadOptions.modelId,
      draft,
      body,
      url: chatUrl(host.env),
      apiKey: config.apiKey,
      stream: true,
      timeoutSeconds: config.timeoutSeconds,
      takePending: options.attachments === undefined,
      meta: { notes, ...(options.retryOf ? { retryOf: options.retryOf } : {}) },
    },
    finalizers,
  );
  const record = loadRecord(host, result.rid);
  if (!record) return idleView(host, config, "The request could not be started. Try again.");
  return liveView(host, config, record, "", "");
}

function commandContext(host: Host, config: Config): CommandContext {
  return {
    host,
    config,
    chat: currentChat(host),
    ensureChat: () => ensureCurrentChat(host, config),
  };
}

function runCommand(host: Host, config: Config, finalizers: Finalizers, name: string, args: string): string {
  const registry = allCommands();
  if (name === "help") {
    const entries: HelpEntry[] = [
      ...BUILTIN_COMMANDS.map((command) => ({ usage: command.usage, help: command.help })),
      ...Object.values(registry).map((command) => ({ usage: command.usage, help: command.help })),
    ];
    return idleView(host, config, renderHelp(entries));
  }
  if (name === "new") {
    clearCurrent(host);
    return idleView(host, config, "Started a new chat.");
  }
  if (name === "retry") {
    const chat = currentChat(host);
    if (!chat || !chat.retry) return idleView(host, config, "There is no failed message to retry.");
    return send(host, config, finalizers, chat.retry.text, { attachments: chat.retry.attachments, retryOf: chat.retry.requestId });
  }
  const command = registry[name];
  if (!command) return idleView(host, config, `Unknown command \`/${name}\`. Type \`/help\` to see the commands.`);
  const outcome = command.run(commandContext(host, config), args);
  if (outcome.kind === "started") {
    const record = loadRecord(host, outcome.rid);
    if (record) return liveView(host, config, record, "", "");
    return idleView(host, config);
  }
  return idleView(host, config, outcome.text);
}

function handleFresh(host: Host, config: Config, finalizers: Finalizers, typed: string): string {
  // A record stopped by ⌘↩ or ⇧↩ belongs to a chat that may no longer be current.
  finalizeDue(host, finalizers);
  const chatId = getCurrent(host);
  const open = chatId ? currentRecord(host, chatLane(chatId)) : null;
  if (open && !open.final && open.state === "open") {
    if (typed === "") return liveView(host, config, open, "", "");
    stop(host, open.id);
    advance(host, open.id, finalizers);
  }
  if (typed.trim() === "") return idleView(host, config);
  const command = parseCommand(typed);
  if (command) return runCommand(host, config, finalizers, command.name, command.args);
  return send(host, config, finalizers, typed);
}

export function main(host: Host, argv: string[]): string {
  const config = readConfig(host);
  const finalizers = collectFinalizers(config);
  const typed = argv[0] ?? "";
  const requestId = (host.env.request_id ?? "").trim();
  // Reruns repeat the original argument, so a run that carries a request id never sends it.
  if (requestId !== "") return handleRerun(host, config, finalizers, requestId, typed);
  return handleFresh(host, config, finalizers, typed);
}
