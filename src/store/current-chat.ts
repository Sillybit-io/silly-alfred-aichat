import type { Config } from "../features/index";
import type { Host } from "../host/types";
import { createChat, getChat, getCurrent, setCurrent, type Chat, type ChatSettings } from "./chats";

// A new chat starts from the Workflow Configuration defaults.
export function initialSettings(config: Config): Partial<ChatSettings> {
  const reasoning = config.reasoningDefault;
  return {
    web: config.webDefault,
    showReasoning: config.keepReasoning,
    effort: reasoning === "model" ? null : reasoning === "off" ? "none" : reasoning,
  };
}

export function currentChat(host: Host): Chat | null {
  const id = getCurrent(host);
  return id === null ? null : getChat(host, id);
}

// The current chat, creating one (and making it current) when there is none.
export function ensureCurrentChat(host: Host, config: Config): Chat {
  const existing = currentChat(host);
  if (existing) return existing;
  const chat = createChat(host, { settings: initialSettings(config) });
  setCurrent(host, chat.id);
  return chat;
}
