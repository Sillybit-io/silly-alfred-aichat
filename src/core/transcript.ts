import type { Chat, Message } from "../store/chats";
import { escapeMarkdown, hostOf, safeUrl } from "./sanitize";

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

// Only https addresses without tracking parameters are cited; the title is plain text and is escaped where it is shown.
export function sourcesOf(message: Message): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const annotation of message.annotations ?? []) {
    if (annotation.type !== "url_citation") continue;
    const inner = typeof annotation.url_citation === "object" && annotation.url_citation !== null ? (annotation.url_citation as Record<string, unknown>) : annotation;
    const url = typeof inner.url === "string" ? safeUrl(inner.url) : null;
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    sources.push({ url, title: typeof inner.title === "string" && inner.title.trim() !== "" ? inner.title : url });
  }
  return sources;
}

function encodeParens(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\[/g, "%5B").replace(/\]/g, "%5D");
}

export function sourceLine(source: Source): string {
  return `[${escapeMarkdown(source.title)}](${encodeParens(source.url)})`;
}

// One paragraph: a short link per site (the first of each), capped, with a pointer to /sources for the rest.
export function sourcesRow(sources: Source[], cap: number): string {
  const seen = new Set<string>();
  const unique = sources.filter((source) => {
    const host = hostOf(source.url);
    if (seen.has(host)) return false;
    seen.add(host);
    return true;
  });
  const shown = unique.slice(0, cap);
  const links = shown.map((source) => `[${escapeMarkdown(hostOf(source.url))}](${encodeParens(source.url)})`);
  const more = unique.length > shown.length ? `  ·  +${unique.length - shown.length} more with \`/sources\`` : "";
  return `**Sources**  ${links.join("  ·  ")}${more}`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

export type RenderOptions = {
  // With a cap the sources are one row of short links for the Text View; without one they are a plain list that copies and exports well.
  sourcesRowCap?: number;
};

export function renderMessage(message: Message, options: RenderOptions = {}): string {
  const parts: string[] = [message.role === "user" ? YOU_HEADING : ASSISTANT_HEADING];
  if (message.reasoning) parts.push(quote(message.reasoning.trim()));
  if (message.content !== "") parts.push(message.content);
  for (const attachment of message.attachments) parts.push(`📎 ${attachment.name} (${formatSize(attachment.size)})`);
  const sources = sourcesOf(message);
  if (sources.length > 0) {
    parts.push(options.sourcesRowCap !== undefined ? sourcesRow(sources, options.sourcesRowCap) : ["**Sources**", ...sources.map((source) => `- ${sourceLine(source)}`)].join("\n"));
  }
  if (message.status === "interrupted") parts.push(`_⚠ Interrupted${message.error ? `: ${message.error}` : ""}. Send "continue" to get the rest._`);
  if (message.status === "stopped") parts.push("_■ Stopped. Send \"continue\" to get the rest._");
  return parts.join("\n\n");
}

export function renderTranscript(chat: Chat, options: RenderOptions = {}): string {
  return chat.messages.map((message, i) => `${message.role === "user" && i > 0 ? `${TURN_BREAK}\n\n` : ""}${renderMessage(message, options)}`).join("\n\n");
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
