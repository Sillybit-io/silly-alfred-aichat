import { readConfig } from "../features/index";
import { attachPaths } from "../store/attach";
import { clearCurrent } from "../store/chats";
import { ensureCurrentChat } from "../store/current-chat";
import type { Host } from "../host/types";
import { applyHistoryAction } from "./history-action";
import { stopCurrentRequest } from "./session";
import { envelope } from "./view";

type Next = "view" | "root" | "models" | "presets" | "image" | "history";

// One script for every item of the root list; root_next tells the workflow where to go afterwards.
// Continue and New chat pass the typed text on as the message, and no other action passes any arg.
export function main(host: Host, argv: string[]): string {
  const action = (host.env.root_action ?? "continue").trim();
  const arg = argv[0] ?? "";
  const done = (next: Next, text = "", notice = "") => envelope(text, { root_next: next, notice, request_id: "", view_stage: "" });

  switch (action) {
    case "continue":
      return done("view", arg.trim());
    case "new":
      stopCurrentRequest(host);
      clearCurrent(host);
      return done("view", arg.trim());
    case "attach":
    case "attach_new": {
      if (action === "attach_new") {
        stopCurrentRequest(host);
        clearCurrent(host);
      }
      const config = readConfig(host);
      const result = attachPaths(host, config, ensureCurrentChat(host, config).id, [arg.trim()]);
      return envelope("", { root_next: "view", notice: "", request_id: "", view_stage: "", attach_notice: result.errors.join("; ") });
    }
    case "models":
    case "presets":
    case "image":
    case "history":
      return done(action);
    default: {
      const outcome = applyHistoryAction(host, action, arg);
      return done(outcome.next === "view" ? "view" : "root", "", outcome.notice);
    }
  }
}
