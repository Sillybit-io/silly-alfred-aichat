import { imageBody, imageMarkdown, imagePathsIn, parseImagePrompt } from "../core/imagegen";
import { apiBase } from "../core/payload";
import { ImageSaveError, newestImage, saveImages } from "../store/images";
import { mutateChat, NotFoundError } from "../store/chats";
import { admit, type Finalizers } from "../store/requests";
import type { Command, Feature } from "./index";
import { readConfig } from "./index";

// Written to the chat as the assistant turn that holds an image; later requests send it as text.
export const IMAGE_MESSAGE_SUFFIX = "-img";

const imageFinalizer: NonNullable<Finalizers["image"]> = (host, record, outcome) => {
  if (outcome.state !== "done" || outcome.httpStatus !== 200) return;
  const prompt = record.draft.text;
  const config = readConfig(host);
  let paths: string[];
  try {
    paths = saveImages(host, config, outcome.bodyText, prompt);
  } catch (error) {
    if (!(error instanceof ImageSaveError)) throw error;
    record.meta.failure = error.message;
    return;
  }
  record.meta.files = paths;
  if (record.chatId === null || record.lane.indexOf("chat:") !== 0) return;
  try {
    mutateChat(host, record.chatId, (chat) => {
      if (chat.messages.some((message) => message.requestId === record.id)) return false;
      const now = host.nowMs();
      chat.messages.push({ id: `${record.id}-u`, requestId: record.id, role: "user", content: prompt, attachments: [], status: "ok", createdAt: now });
      chat.messages.push({ id: `${record.id}${IMAGE_MESSAGE_SUFFIX}`, requestId: record.id, role: "assistant", content: paths.map(imageMarkdown).join("\n\n"), attachments: [], status: "ok", createdAt: now });
    });
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
};

const image: Command = {
  usage: "/image <prompt> [--ar 16:9] [--res 2K] [--n 2] [--model id]",
  help: "Generate an image and keep it in this chat",
  run(ctx, args) {
    const parsed = parseImagePrompt(args);
    if (!parsed.ok) return { kind: "notice", text: parsed.message };
    const modelId = parsed.request.model ?? ctx.config.imageModel;
    if (modelId === "") return { kind: "notice", text: "Choose an image model first: set Image Model in the workflow's Configuration, or add `--model <id>`." };
    if (ctx.config.apiKey === "") return { kind: "notice", text: "Add your OpenRouter API key in the workflow's Configuration first." };
    const chat = ctx.ensureChat();
    const result = admit(
      ctx.host,
      {
        lane: `chat:${chat.id}`,
        kind: "image",
        chatId: chat.id,
        model: modelId,
        draft: { text: parsed.request.prompt, attachments: [] },
        body: imageBody(parsed.request, modelId),
        url: `${apiBase(ctx.host.env)}/images`,
        apiKey: ctx.config.apiKey,
        stream: false,
        timeoutSeconds: ctx.config.imageTimeoutSeconds,
        meta: { count: parsed.request.count },
      },
      { image: imageFinalizer },
    );
    if (!result.ok) return { kind: "notice", text: "A reply is still running in this chat. Wait for it or stop it with ⇧↩, then try again." };
    return { kind: "started", rid: result.rid };
  },
};

function newestChatImage(ctx: Parameters<Command["run"]>[0]): string | null {
  const messages = ctx.chat?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.id.slice(-IMAGE_MESSAGE_SUFFIX.length) === IMAGE_MESSAGE_SUFFIX) return imagePathsIn(messages[i]!.content).pop() ?? null;
  }
  return null;
}

const open: Command = {
  usage: "/open",
  help: "Open the newest image of this chat in its app",
  run(ctx) {
    const path = newestChatImage(ctx) ?? newestImage(ctx.host, ctx.config);
    if (path === null || !ctx.host.exists(path)) return { kind: "notice", text: "There is no image to open yet." };
    ctx.host.runSync(["/usr/bin/open", path], { timeoutMs: 10000 });
    return { kind: "notice", text: `Opened \`${path}\`.` };
  },
};

const reveal: Command = {
  usage: "/reveal",
  help: "Show the newest image of this chat in Finder",
  run(ctx) {
    const path = newestChatImage(ctx) ?? newestImage(ctx.host, ctx.config);
    if (path === null || !ctx.host.exists(path)) return { kind: "notice", text: "There is no image to show yet." };
    ctx.host.runSync(["/usr/bin/open", "-R", path], { timeoutMs: 10000 });
    return { kind: "notice", text: `Showing \`${path}\` in Finder.` };
  },
};

export const feature: Feature = {
  commands: { image, open, reveal },
  finalizers: { image: imageFinalizer },
  // An image turn costs nothing to describe and a lot to resend: later requests see its prompt as text.
  payloadOptions(ctx) {
    const offset = ctx.turns[0]?.role === "system" ? 1 : 0;
    let changed = false;
    const turns = ctx.turns.slice();
    ctx.window.forEach((message, i) => {
      if (message.role !== "assistant" || message.id.slice(-IMAGE_MESSAGE_SUFFIX.length) !== IMAGE_MESSAGE_SUFFIX) return;
      const prompt = ctx.window[i - 1]?.role === "user" ? ctx.window[i - 1]!.content : "";
      const turn = turns[offset + i];
      if (turn) {
        turns[offset + i] = { ...turn, content: `[image: ${prompt}]` };
        changed = true;
      }
    });
    return changed ? { turns } : undefined;
  },
};
