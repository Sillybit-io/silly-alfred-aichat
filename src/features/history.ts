import { cleanTitle, fileSafe, TITLE_PROMPT } from "../core/titles";
import { buildBody, chatUrl, encodeBody } from "../core/payload";
import { sanitizeMarkdown } from "../core/sanitize";
import { renderTranscript } from "../core/transcript";
import { imagesFolder } from "../store/images";
import type { Host } from "../host/types";
import { getChat, mutateChat, NotFoundError, setTitleIfAuto, setTitleManual, type Chat } from "../store/chats";
import { admit, type Finalizers } from "../store/requests";
import type { AfterCommitContext, Command, Config, Feature } from "./index";

const DEFAULT_TITLE = "New chat";
const MAX_TITLE_ATTEMPTS_MESSAGES = 4;

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function expandHome(host: Host, path: string): string {
  const home = host.env.HOME ?? "";
  return path === "~" ? home : path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
}

export function displayTitle(chat: Pick<Chat, "title" | "messages" | "retry">): string {
  if (chat.title !== DEFAULT_TITLE) return chat.title;
  const first = chat.messages.find((message) => message.role === "user")?.content ?? chat.retry?.text ?? "";
  const flat = first.replace(/\s+/g, " ").trim();
  return flat === "" ? DEFAULT_TITLE : clip(flat, 60);
}

// After a chat's first replies, one small request names it; a result that arrives late never wins over a manual title.
function requestTitle(host: Host, config: Config, chatId: string): void {
  const chat = getChat(host, chatId);
  if (!chat || chat.titleSource !== "auto" || chat.title !== DEFAULT_TITLE || chat.messages.length === 0 || chat.messages.length > MAX_TITLE_ATTEMPTS_MESSAGES) return;
  const user = chat.messages.find((message) => message.role === "user");
  const assistant = chat.messages.find((message) => message.role === "assistant");
  if (!user || config.apiKey === "") return;
  const modelId = config.titleModel !== "" ? config.titleModel : config.defaultModel;
  const body = encodeBody(
    buildBody(
      [
        { role: "system", content: TITLE_PROMPT },
        { role: "user", content: `User: ${clip(user.content, 600)}\n\nAssistant: ${clip(assistant?.content ?? "", 600)}` },
      ],
      { modelId, model: null, stream: false, pdfEngine: "auto", web: false, privacy: config.privacy },
    ),
  );
  admit(host, {
    lane: `title:${chatId}`,
    kind: "title",
    chatId,
    model: modelId,
    draft: { text: "", attachments: [] },
    body,
    url: chatUrl(host.env),
    apiKey: config.apiKey,
    stream: false,
    timeoutSeconds: 30,
  });
}

function afterCommit(ctx: AfterCommitContext): void {
  if (!ctx.config.autoTitles || ctx.record.chatId === null) return;
  requestTitle(ctx.host, ctx.config, ctx.record.chatId);
}

const titleFinalizer: NonNullable<Finalizers["title"]> = (host, record, outcome) => {
  if (outcome.state !== "done" || record.chatId === null) return;
  let reply = "";
  try {
    const parsed = JSON.parse(outcome.bodyText) as { choices?: { message?: { content?: unknown } }[] };
    const content = parsed.choices?.[0]?.message?.content;
    reply = typeof content === "string" ? content : "";
  } catch {
    return;
  }
  const title = cleanTitle(reply);
  if (title === "") return;
  try {
    setTitleIfAuto(host, record.chatId, title);
  } catch (error) {
    // A chat deleted in the meantime stays gone; nothing is recreated.
    if (!(error instanceof NotFoundError)) throw error;
  }
};

function exportChat(host: Host, config: Config, chat: Chat): string {
  const folder = expandHome(host, config.exportFolder);
  host.mkdirp(folder);
  const title = displayTitle(chat);
  const date = new Date(host.nowMs()).toISOString().slice(0, 10);
  const visible: Chat = chat.settings.showReasoning ? chat : { ...chat, messages: chat.messages.map(({ reasoning: _hidden, ...rest }) => rest) };
  const text = `${sanitizeMarkdown(`# ${title}\n\n_Exported ${date}${chat.model ? ` · ${chat.model}` : ""}_\n\n${renderTranscript(visible)}`, { imageRoots: [imagesFolder(host, config)] })}\n`;
  const base = `${folder}/${date} ${fileSafe(title)}`;
  let path = `${base}.md`;
  for (let n = 2; host.exists(path); n++) path = `${base} ${n}.md`;
  host.writeAtomic(path, text);
  return path;
}

const exportCommand: Command = {
  usage: "/export",
  help: "Save this chat as a Markdown file in the export folder",
  run(ctx) {
    if (!ctx.chat || ctx.chat.messages.length === 0) return { kind: "notice", text: "There is nothing to export yet." };
    try {
      const path = exportChat(ctx.host, ctx.config, ctx.chat);
      return { kind: "notice", text: `Exported to \`${path.replace(ctx.host.env.HOME ?? "\u0000", "~")}\`.` };
    } catch (error) {
      return { kind: "notice", text: `The export failed: ${String(error)}. Check the export folder in Configuration.` };
    }
  },
};

const title: Command = {
  usage: "/title <text>",
  help: "Name this chat yourself; automatic titles never replace it",
  run(ctx, args) {
    if (args === "") return { kind: "notice", text: `Title: **${ctx.chat ? displayTitle(ctx.chat) : DEFAULT_TITLE}**. Use \`/title <text>\` to rename it.` };
    const chat = ctx.ensureChat();
    setTitleManual(ctx.host, chat.id, args.slice(0, 120));
    return { kind: "notice", text: `Title set to **${args.slice(0, 120)}**.` };
  },
};

function toggle(field: "pinned" | "archived", on: string, off: string): Command["run"] {
  return (ctx) => {
    const chat = ctx.ensureChat();
    let value = false;
    mutateChat(ctx.host, chat.id, (current) => {
      current[field] = !current[field];
      value = current[field];
    });
    return { kind: "notice", text: value ? on : off };
  };
}

const pin: Command = {
  usage: "/pin",
  help: "Pin or unpin this chat so it stays at the top and is never pruned",
  run: toggle("pinned", "Pinned. It stays at the top of the history and is never pruned.", "Unpinned."),
};

const archive: Command = {
  usage: "/archive",
  help: "Archive or restore this chat",
  run: toggle("archived", "Archived. Find it with `archived` in the history list.", "Restored from the archive."),
};

export const feature: Feature = {
  commands: { export: exportCommand, title, pin, archive },
  afterCommit,
  finalizers: { title: titleFinalizer },
};
