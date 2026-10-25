import type { Host } from "../host/types";
import { baseName } from "../core/attachments";
import { chatDir, clearCurrent, forgetSummary, getChat, getCurrent, mutateChat, NotFoundError, setCurrent } from "../store/chats";
import { envelope } from "./view";

export type HistoryOutcome = { next: "view" | "list"; notice: string };

const CHAT_ID = /^[0-9a-z]{1,64}$/;

// Applies one action to the chat folder an item pointed at. Every write takes the chat's lock, and a chat
// that is gone is reported, never recreated.
export function applyHistoryAction(host: Host, action: string, folderArg: string): HistoryOutcome {
  const id = baseName(folderArg.trim().replace(/\/+$/, ""));
  const gone: HistoryOutcome = { next: "list", notice: "That chat no longer exists" };
  // Chat ids are lower-case letters and digits; anything else never names a chat folder.
  if (!CHAT_ID.test(id) || !getChat(host, id)) return gone;
  try {
    if (action === "archive") {
      mutateChat(host, id, (chat) => {
        chat.archived = !chat.archived;
      });
      return { next: "list", notice: "" };
    }
    if (action === "pin") {
      mutateChat(host, id, (chat) => {
        chat.pinned = !chat.pinned;
      });
      return { next: "list", notice: "" };
    }
    if (action === "delete") {
      const title = getChat(host, id)?.title ?? "this chat";
      if (!host.confirm(`Delete “${title}” permanently? Its messages and attachments cannot be recovered.`, "Delete")) return { next: "list", notice: "The chat was not deleted" };
      mutateChat(host, id, () => false);
      try {
        host.remove(chatDir(host, id));
      } catch (error) {
        host.log(`could not delete chat ${id}: ${String(error)}`);
        return { next: "list", notice: "The chat could not be deleted" };
      }
      forgetSummary(host, id);
      if (getCurrent(host) === id) clearCurrent(host);
      return { next: "list", notice: "" };
    }
  } catch (error) {
    if (error instanceof NotFoundError) return gone;
    throw error;
  }
  setCurrent(host, id);
  return { next: "view", notice: "" };
}

// The arg is the chat folder (the item is a file item); the envelope's arg is empty, so neither
// view_chat nor show_history ever receives the path as text.
export function main(host: Host, argv: string[]): string {
  const outcome = applyHistoryAction(host, (host.env.history_action ?? "open").trim(), argv[0] ?? "");
  return envelope("", { history_next: outcome.next, notice: outcome.notice, request_id: "", view_stage: "" });
}
