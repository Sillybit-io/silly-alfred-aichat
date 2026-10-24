import { relativeTime } from "../core/titles";
import { collectFinalizers, readConfig } from "../features/index";
import type { Host } from "../host/types";
import { baseName } from "../core/attachments";
import { chatDir, getCurrent, listSummaries, type ChatSummary } from "../store/chats";
import { finalizeDue } from "../store/requests";

const RECENT = 8;

type Item = Record<string, unknown>;

// A typed path that names an existing file (a leading ~ is the home folder).
function existingFile(host: Host, typed: string): string | null {
  if (typed.charAt(0) !== "/" && typed.slice(0, 2) !== "~/") return null;
  const path = typed.charAt(0) === "~" ? `${host.env.HOME ?? ""}${typed.slice(1)}` : typed;
  const info = host.stat(path);
  return info !== null && !info.isDirectory ? path : null;
}

const titleOf = (summary: ChatSummary) => (summary.title !== "New chat" || summary.preview === "" ? summary.title : summary.preview.slice(0, 60));

function mod(subtitle: string, arg: string, action: string): Item {
  return { valid: true, subtitle, arg, variables: { root_action: action } };
}

function shortcut(title: string, subtitle: string, action: string): Item {
  return { title, subtitle, arg: "", valid: true, variables: { root_action: action } };
}

// The list behind the chat keyword: continue, start fresh, recent chats, and the other lists. Text typed
// after the keyword filters the chats and is what Continue and New chat send.
export function main(host: Host, argv: string[]): string {
  const config = readConfig(host);
  finalizeDue(host, collectFinalizers(config));
  const typed = (argv[0] ?? "").trim();
  const words = typed.toLowerCase().split(/\s+/).filter((word) => word !== "");
  const now = host.nowMs();
  const all = listSummaries(host);
  const currentId = getCurrent(host);
  const current = currentId === null ? null : (all.find((summary) => summary.id === currentId) ?? null);
  const items: Item[] = [];

  // A file handed over with "Use for Workflow Script Filter" arrives as the typed text: offer to attach it.
  const file = existingFile(host, typed);
  if (file !== null) {
    const name = baseName(file);
    if (current) items.push({ title: `Attach “${name}” to this chat`, subtitle: `Continue: ${titleOf(current)}`, arg: file, valid: true, variables: { root_action: "attach" } });
    items.push({ title: `Attach “${name}” to a new chat`, subtitle: "Start an empty chat with this file waiting", arg: file, valid: true, variables: { root_action: "attach_new" } });
  }

  if (file === null && current) {
    items.push({
      title: `Continue: ${titleOf(current)}`,
      subtitle: typed !== "" ? `Send “${typed}” in this chat` : [current.model ?? "default model", `${current.messageCount} messages`, relativeTime(now, current.updatedAt)].join(" · "),
      arg: typed,
      valid: true,
      variables: { root_action: "continue" },
      mods: { cmd: mod(typed !== "" ? `Start a new chat and send “${typed}”` : "Start a new chat", typed, "new") },
    });
  }
  if (file === null) items.push({
    title: "New chat",
    subtitle: typed !== "" ? `Start a new chat and send “${typed}”` : "Start with an empty chat",
    arg: typed,
    valid: true,
    variables: { root_action: "new" },
  });

  const matching = all
    .filter((summary) => !summary.archived && summary.id !== currentId)
    .filter((summary) => {
      const haystack = `${summary.title} ${summary.preview}`.toLowerCase();
      return words.every((word) => haystack.indexOf(word) >= 0);
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  for (const summary of matching.slice(0, RECENT)) {
    const folder = chatDir(host, summary.id);
    items.push({
      title: `${summary.pinned ? "📌 " : ""}${titleOf(summary)}`,
      subtitle: [summary.model ?? "default model", `${summary.messageCount} messages`, relativeTime(now, summary.updatedAt), ...(summary.pinned ? ["pinned"] : [])].join(" · "),
      arg: folder,
      type: "file",
      valid: true,
      variables: { root_action: "open" },
      mods: {
        cmd: mod("Archive this chat", folder, "archive"),
        alt: mod(summary.pinned ? "Unpin this chat" : "Pin this chat", folder, "pin"),
        ctrl: mod("Delete this chat permanently", folder, "delete"),
      },
    });
  }
  if (typed === "" || matching.length > RECENT) {
    items.push(shortcut("All chats…", "Browse, pin, archive, and delete every chat", "history"));
  }

  const keywords = { models: host.env.keyword_models ?? "aimodels", presets: host.env.keyword_presets ?? "aipresets", image: host.env.keyword_image ?? "aiimage" };
  const shortcuts: [string, string, string][] = [
    ["AI Models", `Search and pick a model · or type ${keywords.models}`, "models"],
    ["AI Presets", `Run a prompt on selected text · or type ${keywords.presets}`, "presets"],
    ["AI Image", `Generate an image · or type ${keywords.image}`, "image"],
  ];
  for (const [title, subtitle, action] of shortcuts) {
    if (words.every((word) => `${title} ${action}`.toLowerCase().indexOf(word) >= 0)) items.push(shortcut(title, subtitle, action));
  }
  return JSON.stringify({ items });
}
