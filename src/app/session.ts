import type { Host } from "../host/types";
import { clearCurrent, getCurrent } from "../store/chats";
import { currentRecord, stop } from "../store/requests";
import { envelope } from "./view";

// Stop only writes the sentinel and signals an owned process; the next chat run finalizes the record.
export function stopCurrentRequest(host: Host): void {
  const chatId = getCurrent(host);
  if (chatId === null) return;
  const record = currentRecord(host, `chat:${chatId}`);
  if (record && !record.final) stop(host, record.id);
}

// The Text View closes before this runs. The next chat run shows the saved partial reply.
export function main(host: Host, argv: string[]): string {
  const action = (host.env.session_action ?? "").trim();
  stopCurrentRequest(host);
  if (action === "new") clearCurrent(host);
  // Stop passes nothing on, so a reopened view never resends the input text.
  return envelope(action === "new" ? (argv[0] ?? "") : "", { request_id: "", view_stage: "", session_action: "" });
}
