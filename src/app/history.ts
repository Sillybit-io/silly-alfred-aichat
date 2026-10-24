import { relativeTime } from "../core/titles";
import { collectFinalizers, readConfig } from "../features/index";
import type { Host } from "../host/types";
import { chatDir, listSummaries, pruneChats, type ChatSummary } from "../store/chats";
import { currentRecord, finalizeDue, lanesDir } from "../store/requests";

type Item = Record<string, unknown>;

// Chats with a request in flight, in any lane, are never pruned.
export function activeChats(host: Host): Set<string> {
  const active = new Set<string>();
  if (!host.exists(lanesDir(host))) return active;
  for (const lane of host.listDir(lanesDir(host))) {
    if (lane.endsWith(".lock") || lane.indexOf(".tmp-") >= 0) continue;
    const record = currentRecord(host, lane);
    if (record && !record.final && record.chatId !== null) active.add(record.chatId);
  }
  return active;
}

function modItem(subtitle: string, folder: string, action: string): Item {
  return { valid: true, subtitle, arg: folder, variables: { history_action: action } };
}

function itemFor(host: Host, summary: ChatSummary, now: number): Item {
  const folder = chatDir(host, summary.id);
  const state = [summary.pinned ? "pinned" : "", summary.archived ? "archived" : ""].filter((part) => part !== "");
  const parts = [summary.model ?? "default model", `${summary.messageCount} messages`, relativeTime(now, summary.updatedAt), ...state];
  return {
    title: `${summary.pinned ? "📌 " : ""}${summary.title !== "New chat" || summary.preview === "" ? summary.title : summary.preview.slice(0, 60)}`,
    subtitle: parts.join(" · "),
    arg: folder,
    type: "file",
    valid: true,
    variables: { history_action: "open" },
    mods: {
      cmd: modItem(summary.archived ? "Restore from the archive" : "Archive this chat", folder, "archive"),
      alt: modItem(summary.pinned ? "Unpin this chat" : "Pin this chat", folder, "pin"),
      ctrl: modItem("Delete this chat permanently", folder, "delete"),
    },
  };
}

// The history Script Filter: finalize what finished while the window was closed, apply the
// retention rules, then list pinned chats first and archived chats only for `archived`.
export function main(host: Host, argv: string[]): string {
  const config = readConfig(host);
  finalizeDue(host, collectFinalizers(config));
  pruneChats(host, config.retentionDays, config.maxChats, activeChats(host));

  const query = (argv[0] ?? "").trim();
  const wantsArchived = /^archived(\s|$)/i.test(query);
  const words = (wantsArchived ? query.replace(/^archived/i, "") : query)
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const now = host.nowMs();
  const summaries = listSummaries(host)
    .filter((summary) => summary.archived === wantsArchived)
    .filter((summary) => {
      const haystack = `${summary.title} ${summary.preview}`.toLowerCase();
      return words.every((word) => haystack.indexOf(word) >= 0);
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);

  const items = summaries.map((summary) => itemFor(host, summary, now));
  if (items.length === 0) {
    items.push({
      title: wantsArchived ? "No archived chats" : words.length > 0 ? "No chats match" : "No chats yet",
      subtitle: wantsArchived ? "Archive a chat with ⌘↩ in this list or /archive in a chat" : "Start one with the chat keyword",
      valid: false,
    });
  }
  return JSON.stringify({ items });
}
