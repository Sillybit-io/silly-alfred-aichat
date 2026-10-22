import { readConfig } from "../features/index";
import type { Host } from "../host/types";
import { attachPaths } from "../store/attach";
import { clearCurrent } from "../store/chats";
import { ensureCurrentChat } from "../store/current-chat";
import { envelope } from "./view";

// Files arrive as separate arguments or as one tab-separated string from the Universal Action. They are
// snapshotted into the chat, and the envelope has an empty arg so view_chat never sees a path as a message.
export function main(host: Host, argv: string[]): string {
  const config = readConfig(host);
  const paths = argv.flatMap((item) => item.split("\t")).map((item) => item.trim()).filter((item) => item !== "");
  if ((host.env.attach_mode ?? "").trim() === "new") clearCurrent(host);
  const chat = ensureCurrentChat(host, config);
  const result = attachPaths(host, config, chat.id, paths);
  const notice = result.errors.join("; ");
  if (notice !== "") host.log(notice);
  return envelope("", { request_id: "", view_stage: "", attach_notice: notice });
}
