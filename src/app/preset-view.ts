import type { Host } from "../host/types";
import { loadLastResult } from "./preset-result";
import { viewJson } from "./view";

// Shows the last preset reply without touching the clipboard; ⌘↩ copies it through copy.js.
export function main(host: Host, _argv: string[]): string {
  const result = loadLastResult(host);
  return viewJson({
    response: result ? result.reply : "There is no preset result to show.",
    footer: result ? `${result.name} · ⌘↩ copy · ⌘⌥↩ chats` : "Run a preset with the aipresets keyword",
    mode: "replace",
    requestId: "",
    stage: "",
  });
}
