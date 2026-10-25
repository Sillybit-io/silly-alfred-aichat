import { newId } from "../core/ids";
import type { Annotation } from "../core/stream";
import type { Host } from "../host/types";
import { withLock } from "./lock";

export type AttachmentRef = {
  name: string;
  kind: "image" | "file" | "text";
  mime: string;
  size: number;
  sha: string;
  // Snapshot path relative to the chat folder: attachments/<sha>.<ext>
  file: string;
};

export type MessageStatus = "ok" | "interrupted" | "stopped";

export type Message = {
  id: string;
  requestId: string;
  role: "user" | "assistant";
  content: string;
  attachments: AttachmentRef[];
  reasoning?: string;
  annotations?: Annotation[];
  status: MessageStatus;
  error?: string;
  createdAt: number;
};

export type ChatSettings = {
  web: boolean;
  showReasoning: boolean;
  effort: string | null;
  pdfEngine: string | null;
};

// A failed send keeps its draft here so /retry can resend it after the window closed.
export type RetryDraft = {
  requestId: string;
  text: string;
  attachments: AttachmentRef[];
  model: string;
  error: string;
};

export type Chat = {
  schema: 1;
  id: string;
  title: string;
  titleSource: "auto" | "manual";
  createdAt: number;
  updatedAt: number;
  revision: number;
  model: string | null;
  pinned: boolean;
  archived: boolean;
  settings: ChatSettings;
  pending: AttachmentRef[];
  retry: RetryDraft | null;
  messages: Message[];
};

export type ChatSummary = {
  id: string;
  title: string;
  titleSource: "auto" | "manual";
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  model: string | null;
  messageCount: number;
  hasRetry: boolean;
  preview: string;
};

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`chat ${id} does not exist`);
    this.name = "NotFoundError";
  }
}

export function dataDir(host: Host): string {
  const dir = host.env.alfred_workflow_data;
  if (!dir) throw new Error("alfred_workflow_data is not set");
  return dir.replace(/\/+$/, "");
}

export function cacheDir(host: Host): string {
  const dir = host.env.alfred_workflow_cache;
  if (!dir) throw new Error("alfred_workflow_cache is not set");
  return dir.replace(/\/+$/, "");
}

export const chatsDir = (host: Host) => `${dataDir(host)}/chats`;
export const chatDir = (host: Host, id: string) => `${chatsDir(host)}/${id}`;
export const chatFile = (host: Host, id: string) => `${chatDir(host, id)}/chat.json`;
export const attachmentsDir = (host: Host, id: string) => `${chatDir(host, id)}/attachments`;
const chatLock = (host: Host, id: string) => `${chatDir(host, id)}/.lock`;
const currentFile = (host: Host) => `${dataDir(host)}/current`;

export type ChatInit = {
  model?: string | null;
  settings?: Partial<ChatSettings>;
  title?: string;
};

export function defaultSettings(): ChatSettings {
  return { web: false, showReasoning: false, effort: null, pdfEngine: null };
}

// The folder is made with mkdirExclusive, so a clash in ids is an error, not a silent reuse.
export function createChat(host: Host, init: ChatInit = {}): Chat {
  host.mkdirp(chatsDir(host));
  const id = newId(host);
  if (!host.mkdirExclusive(chatDir(host, id))) throw new Error(`chat ${id} already exists`);
  host.mkdirExclusive(attachmentsDir(host, id));
  const now = host.nowMs();
  const chat: Chat = {
    schema: 1,
    id,
    title: init.title ?? "New chat",
    titleSource: "auto",
    createdAt: now,
    updatedAt: now,
    revision: 0,
    model: init.model ?? null,
    pinned: false,
    archived: false,
    settings: { ...defaultSettings(), ...init.settings },
    pending: [],
    retry: null,
    messages: [],
  };
  host.writeAtomic(chatFile(host, id), JSON.stringify(chat, null, 2));
  return chat;
}

export function getChat(host: Host, id: string): Chat | null {
  try {
    return JSON.parse(host.readText(chatFile(host, id))) as Chat;
  } catch {
    return null;
  }
}

// Read-modify-write under the chat's lock. The write goes through a temp file inside the existing
// folder, so a chat deleted meanwhile raises NotFoundError and is never recreated.
// The callback returns false to leave the chat untouched.
export function mutateChat(host: Host, id: string, fn: (chat: Chat) => void | false): Chat {
  if (!host.exists(chatDir(host, id))) throw new NotFoundError(id);
  try {
    return withLock(host, chatLock(host, id), () => {
      const chat = getChat(host, id);
      if (!chat) throw new NotFoundError(id);
      if (fn(chat) === false) return chat;
      chat.revision += 1;
      chat.updatedAt = host.nowMs();
      host.writeAtomic(chatFile(host, id), JSON.stringify(chat, null, 2));
      return chat;
    });
  } catch (error) {
    if (!(error instanceof NotFoundError) && !host.exists(chatDir(host, id))) throw new NotFoundError(id);
    throw error;
  }
}

export function setTitleIfAuto(host: Host, id: string, title: string): Chat {
  return mutateChat(host, id, (chat) => {
    if (chat.titleSource === "manual") return false;
    chat.title = title;
  });
}

export function setTitleManual(host: Host, id: string, title: string): Chat {
  return mutateChat(host, id, (chat) => {
    chat.title = title;
    chat.titleSource = "manual";
  });
}

export function setCurrent(host: Host, id: string): void {
  host.mkdirp(dataDir(host));
  host.writeAtomic(currentFile(host), id);
}

export function clearCurrent(host: Host): void {
  host.remove(currentFile(host));
}

// A pointer whose folder is gone is cleared, so the next send starts a new chat.
export function getCurrent(host: Host): string | null {
  let id: string;
  try {
    id = host.readText(currentFile(host)).trim();
  } catch {
    return null;
  }
  if (id !== "" && host.exists(chatDir(host, id))) return id;
  clearCurrent(host);
  return null;
}

function summaryOf(chat: Chat): ChatSummary {
  const first = chat.messages.find((message) => message.role === "user");
  return {
    id: chat.id,
    title: chat.title,
    titleSource: chat.titleSource,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    pinned: chat.pinned,
    archived: chat.archived,
    model: chat.model,
    messageCount: chat.messages.length,
    hasRetry: chat.retry !== null,
    preview: (first?.content ?? chat.retry?.text ?? "").replace(/\s+/g, " ").slice(0, 120),
  };
}

// The chat lists run on every keystroke. Each summary is kept with the size and modification time of the chat file it
// came from, so only chats that changed since are read and parsed again.
type SummaryCache = { schema: 1; entries: Record<string, { mtimeMs: number; size: number; summary: ChatSummary }> };

const summaryCacheFile = (host: Host) => `${cacheDir(host)}/summaries.json`;
const summaryCacheLock = (host: Host) => `${cacheDir(host)}/.summaries.lock`;

function loadSummaryCache(host: Host): SummaryCache {
  try {
    const parsed = JSON.parse(host.readText(summaryCacheFile(host))) as Partial<SummaryCache>;
    if (parsed.schema === 1 && typeof parsed.entries === "object" && parsed.entries !== null) return { schema: 1, entries: parsed.entries };
  } catch {
    // no cache yet, or no cache folder
  }
  return { schema: 1, entries: {} };
}

function saveSummaryCache(host: Host, cache: SummaryCache): void {
  try {
    host.writeAtomic(summaryCacheFile(host), JSON.stringify(cache));
  } catch {
    // the summaries are built again next time
  }
}

// The cache holds titles and the start of first messages, so a chat that is deleted leaves it at once.
export function forgetSummary(host: Host, id: string): void {
  if (!host.env.alfred_workflow_cache || !host.exists(cacheDir(host))) return;
  withLock(host, summaryCacheLock(host), () => {
    const cache = loadSummaryCache(host);
    if (!Object.prototype.hasOwnProperty.call(cache.entries, id)) return;
    delete cache.entries[id];
    saveSummaryCache(host, cache);
  });
}

export function listSummaries(host: Host): ChatSummary[] {
  if (host.env.alfred_workflow_cache) {
    try {
      host.mkdirp(cacheDir(host));
      // This lock never takes a chat lock. Deletion/pruning can safely wait for it while holding a chat lock.
      return withLock(host, summaryCacheLock(host), () => listSummariesUnlocked(host, true));
    } catch {
      // A busy or unavailable cache must not stop the list. This fallback neither reads nor writes the cache.
    }
  }
  return listSummariesUnlocked(host, false);
}

function listSummariesUnlocked(host: Host, useCache: boolean): ChatSummary[] {
  if (!host.exists(chatsDir(host))) {
    // No chats at all: nothing the cache holds may outlive them.
    try {
      if (useCache) host.remove(summaryCacheFile(host));
    } catch {
      // removed next time
    }
    return [];
  }
  const cache: SummaryCache = useCache ? loadSummaryCache(host) : { schema: 1, entries: {} };
  const next: SummaryCache = { schema: 1, entries: {} };
  let changed = false;
  for (const id of host.listDir(chatsDir(host))) {
    const info = host.stat(chatFile(host, id));
    if (!info || info.isDirectory) continue;
    const hit = cache.entries[id];
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size && hit.summary?.id === id) {
      next.entries[id] = hit;
      continue;
    }
    const chat = getChat(host, id);
    if (!chat) continue;
    next.entries[id] = { mtimeMs: info.mtimeMs, size: info.size, summary: summaryOf(chat) };
    changed = true;
  }
  if (useCache && (changed || Object.keys(cache.entries).length !== Object.keys(next.entries).length)) saveSummaryCache(host, next);
  return Object.values(next.entries)
    .map((entry) => entry.summary)
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
}

// Retention: chats idle longer than retentionDays, then the oldest beyond maxChats; 0 turns a rule off.
// Pinned and active chats are re-checked under each chat's lock, and a pruned chat is deleted for good.
export function pruneChats(host: Host, retentionDays: number, maxChats: number, activeChatIds: string[] | Set<string>): string[] {
  const active = new Set(activeChatIds);
  const now = host.nowMs();
  if (retentionDays <= 0 && maxChats <= 0) return [];
  const all = listSummaries(host);
  const candidates = all.filter((summary) => !summary.pinned && !active.has(summary.id));
  const doomed = new Set<string>();
  if (retentionDays > 0) {
    for (const summary of candidates) if (now - summary.updatedAt > retentionDays * 86_400_000) doomed.add(summary.id);
  }
  if (maxChats > 0) {
    const kept = all.filter((summary) => !doomed.has(summary.id));
    for (const summary of kept.slice(maxChats)) if (!summary.pinned && !active.has(summary.id)) doomed.add(summary.id);
  }
  const pruned: string[] = [];
  for (const id of doomed) {
    try {
      withLock(host, chatLock(host, id), () => {
        const chat = getChat(host, id);
        if (!chat || chat.pinned || active.has(id)) return;
        try {
          host.remove(chatDir(host, id));
        } catch (error) {
          host.log(`could not prune chat ${id}: ${String(error)}`);
          return;
        }
        forgetSummary(host, id);
        pruned.push(id);
      });
    } catch (error) {
      if (host.exists(chatDir(host, id))) throw error;
    }
  }
  return pruned;
}
