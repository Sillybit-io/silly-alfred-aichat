import { sanitizeMarkdown } from "../core/sanitize";
import { renderLastReply, renderTranscript } from "../core/transcript";
import { readConfig } from "../features/index";
import type { Host } from "../host/types";
import { getChat, getCurrent } from "../store/chats";
import { imagesFolder } from "../store/images";
import { loadLastResult } from "./preset-result";

// What is copied is cleaned like what is shown: pasting it elsewhere must not fetch an address a model chose.
export function main(host: Host, _argv: string[]): string {
  const clean = (text: string) => sanitizeMarkdown(text, { imageRoots: [imagesFolder(host, readConfig(host))] });
  if ((host.env.copy_mode ?? "").trim() === "preset") return clean(loadLastResult(host)?.reply ?? "");
  const id = getCurrent(host);
  const chat = id === null ? null : getChat(host, id);
  if (!chat) return "";
  return clean((host.env.copy_mode ?? "").trim() === "all" ? renderTranscript(chat) : renderLastReply(chat));
}
