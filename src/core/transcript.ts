import type { Chat, Message } from "../store/chats";
import { sourcesRow, type SourcesStyle } from "./favicons";

// Apple emoji mark who is speaking; Alfred's Text View takes Markdown only, so these (and a rule between turns) are the separators.
export const YOU_HEADING = "# 🧑 You";
export const ASSISTANT_HEADING = "# 🤖 Assistant";
export const TURN_BREAK = "---";

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type Source = { url: string; title: string };

export function sourcesOf(message: Message): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const annotation of message.annotations ?? []) {
    if (annotation.type !== "url_citation") continue;
    const inner = typeof annotation.url_citation === "object" && annotation.url_citation !== null ? (annotation.url_citation as Record<string, unknown>) : annotation;
    const url = typeof inner.url === "string" ? inner.url : "";
    if (url === "" || seen.has(url)) continue;
    seen.add(url);
    sources.push({ url, title: typeof inner.title === "string" && inner.title !== "" ? inner.title : url });
  }
  return sources;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

// With a style the sources are one row of linked icons for the Text View; without one they are a plain list that copies and exports well.
export function renderMessage(message: Message, style?: SourcesStyle): string {
  const parts: string[] = [message.role === "user" ? YOU_HEADING : ASSISTANT_HEADING];
  if (message.reasoning) parts.push(quote(message.reasoning.trim()));
  if (message.content !== "") parts.push(message.content);
  for (const attachment of message.attachments) parts.push(`📎 ${attachment.name} (${formatSize(attachment.size)})`);
  const sources = sourcesOf(message);
  if (sources.length > 0) {
    parts.push(style ? sourcesRow(sources, style) : ["**Sources**", ...sources.map((source) => `- [${source.title}](${source.url})`)].join("\n"));
  }
  if (message.status === "interrupted") parts.push(`_⚠ Interrupted${message.error ? `: ${message.error}` : ""}. Send "continue" to get the rest._`);
  if (message.status === "stopped") parts.push("_■ Stopped. Send \"continue\" to get the rest._");
  return parts.join("\n\n");
}

export function renderTranscript(chat: Chat, style?: SourcesStyle): string {
  return chat.messages.map((message, i) => `${message.role === "user" && i > 0 ? `${TURN_BREAK}\n\n` : ""}${renderMessage(message, style)}`).join("\n\n");
}

export function lastReply(chat: Chat): Message | null {
  for (let i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i]!.role === "assistant") return chat.messages[i]!;
  return null;
}

// The last reply as Markdown, without its heading: what ⌥↩ copies.
export function renderLastReply(chat: Chat): string {
  const reply = lastReply(chat);
  if (!reply) return "";
  return renderMessage(reply).replace(`${ASSISTANT_HEADING}\n\n`, "");
}
