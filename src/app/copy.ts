import { renderLastReply, renderTranscript } from "../core/transcript";
import type { Host } from "../host/types";
import { getChat, getCurrent } from "../store/chats";
import { loadLastResult } from "./preset-result";

export function main(host: Host, _argv: string[]): string {
  if ((host.env.copy_mode ?? "").trim() === "preset") return loadLastResult(host)?.reply ?? "";
  const id = getCurrent(host);
  const chat = id === null ? null : getChat(host, id);
  if (!chat) return "";
  return (host.env.copy_mode ?? "").trim() === "all" ? renderTranscript(chat) : renderLastReply(chat);
}
