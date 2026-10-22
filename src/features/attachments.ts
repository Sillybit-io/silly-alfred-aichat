import { MAX_BODY_BYTES, megabytes } from "../core/attachments";
import { encodeBase64 } from "../core/base64";
import { formatSize } from "../core/transcript";
import type { AttachmentPart, ContextTurn } from "../core/payload";
import { decodeUtf8 } from "../core/utf8";
import { attachBytes, attachPaths } from "../store/attach";
import { getModel } from "../store/catalog";
import { chatDir, mutateChat, type AttachmentRef } from "../store/chats";
import type { Command, CommandContext, CommandOutcome, Feature, PayloadContext, PayloadContribution } from "./index";
import { modelCovers } from "./model";

const PDF_ENGINES = ["auto", "free", "ocr", "native"];

function snapshotBytes(ctx: PayloadContext, ref: AttachmentRef): Uint8Array | null {
  const path = `${chatDir(ctx.host, ctx.chat.id)}/${ref.file}`;
  return ctx.host.exists(path) ? ctx.host.readBytesFrom(path, 0) : null;
}

// Builds the parts for one turn from its snapshots; text files go into the message itself.
function withAttachments(ctx: PayloadContext, turn: ContextTurn, refs: AttachmentRef[], needs: { image: boolean; file: boolean }): ContextTurn | string {
  const parts: AttachmentPart[] = [];
  let content = turn.content;
  for (const ref of refs) {
    const bytes = snapshotBytes(ctx, ref);
    if (bytes === null) return `The attachment **${ref.name}** is missing from this chat's saved files (${ref.file}), so nothing was sent. Remove it with \`/detach\` or attach it again.`;
    if (ref.kind === "text") {
      content += `\n\n<attached_file name="${ref.name}">\n${decodeUtf8(bytes)}\n</attached_file>`;
    } else {
      if (ref.kind === "image") needs.image = true;
      else if (ctx.options.pdfEngine === "native") needs.file = true;
      parts.push({ kind: ref.kind, name: ref.name, mime: ref.mime, base64: encodeBase64(bytes) });
    }
  }
  return { ...turn, content, ...(parts.length > 0 ? { attachments: parts } : {}) };
}

function payloadOptions(ctx: PayloadContext): PayloadContribution | void {
  const offset = ctx.turns[0]?.role === "system" ? 1 : 0;
  const turns = ctx.turns.slice();
  const needs = { image: false, file: false };
  for (let i = 0; i < ctx.window.length; i++) {
    const refs = ctx.window[i]!.attachments;
    if (refs.length === 0) continue;
    const built = withAttachments(ctx, turns[offset + i]!, refs, needs);
    if (typeof built === "string") return { refuse: built };
    turns[offset + i] = built;
  }
  if (ctx.draft.attachments.length > 0) {
    const last = turns.length - 1;
    const built = withAttachments(ctx, turns[last]!, ctx.draft.attachments, needs);
    if (typeof built === "string") return { refuse: built };
    turns[last] = built;
  }
  if (!needs.image && !needs.file) return { turns };

  // Every image and PDF in the outgoing history must be readable by the model that receives it.
  if (!ctx.model || modelCovers(ctx.model, needs)) return { turns };
  const fallback = ctx.config.visionFallbackModel === "" ? null : getModel(ctx.host, ctx.config.visionFallbackModel);
  const what = needs.image && needs.file ? "images and PDFs" : needs.image ? "images" : "PDFs";
  if (fallback && modelCovers(fallback, needs)) {
    return { turns, options: { modelId: fallback.id, model: fallback }, notes: [`${what} sent to ${fallback.id}`] };
  }
  return {
    refuse: `**${ctx.model.name}** cannot read the ${what} in this message or chat, and no vision fallback model is set. Nothing was sent and your text is still in the input. Switch with \`/model\`, set a vision fallback model in Configuration, or start a \`/new\` chat.`,
  };
}

function summarize(result: { added: AttachmentRef[]; errors: string[] }): string {
  const lines: string[] = [];
  if (result.added.length > 0) lines.push(`Attached: ${result.added.map((ref) => `${ref.name} (${formatSize(ref.size)})`).join(", ")}. They go with your next message.`);
  for (const error of result.errors) lines.push(`⚠ ${error}`);
  return lines.length > 0 ? lines.join("\n\n") : "Nothing was attached.";
}

const attach: Command = {
  usage: "/attach",
  help: "Choose files to send with your next message",
  run(ctx: CommandContext): CommandOutcome {
    let picked;
    try {
      picked = ctx.host.chooseFiles({ prompt: "Choose files to attach", multiple: true });
    } catch {
      return { kind: "notice", text: "The file picker could not open. Use the **AI Chat: Ask about these files** Universal Action on the files in Alfred instead." };
    }
    if (picked.cancelled) return { kind: "notice", text: "No file was chosen." };
    const chat = ctx.ensureChat();
    return { kind: "notice", text: summarize(attachPaths(ctx.host, ctx.config, chat.id, picked.paths)) };
  },
};

const paste: Command = {
  usage: "/paste",
  help: "Attach the image on the clipboard",
  run(ctx): CommandOutcome {
    const bytes = ctx.host.clipboardPng();
    if (bytes === null) return { kind: "notice", text: "There is no image on the clipboard." };
    const chat = ctx.ensureChat();
    return { kind: "notice", text: summarize(attachBytes(ctx.host, ctx.config, chat.id, `clipboard-${ctx.host.nowMs()}.png`, bytes)) };
  },
};

const attachments: Command = {
  usage: "/attachments",
  help: "List the files waiting to be sent",
  run(ctx): CommandOutcome {
    const pending = ctx.chat?.pending ?? [];
    if (pending.length === 0) return { kind: "notice", text: "No files are waiting. Use `/attach`, `/paste`, or the **AI Chat: Ask about these files** action." };
    return { kind: "notice", text: ["**Waiting to be sent**", ...pending.map((ref, i) => `${i + 1}. ${ref.name} (${formatSize(ref.size)})`), "", "Remove one with `/detach <number>`."].join("\n") };
  },
};

const detach: Command = {
  usage: "/detach <number>",
  help: "Remove a waiting file",
  run(ctx, args): CommandOutcome {
    const pending = ctx.chat?.pending ?? [];
    const index = Number(args) - 1;
    if (!ctx.chat || !Number.isInteger(index) || index < 0 || index >= pending.length) {
      return { kind: "notice", text: pending.length === 0 ? "No files are waiting." : `Give a number from 1 to ${pending.length}. See \`/attachments\`.` };
    }
    const removed = pending[index]!;
    mutateChat(ctx.host, ctx.chat.id, (chat) => {
      chat.pending.splice(index, 1);
    });
    return { kind: "notice", text: `Removed ${removed.name}.` };
  },
};

const pdf: Command = {
  usage: "/pdf [auto | free | ocr | native]",
  help: "Choose how PDFs are read",
  run(ctx, args): CommandOutcome {
    const engine = args.toLowerCase();
    if (engine === "") {
      const current = ctx.chat?.settings.pdfEngine ?? ctx.config.pdfEngine;
      return { kind: "notice", text: `PDF engine: **${current}**. Choose with \`/pdf ${PDF_ENGINES.join("|")}\`. \`auto\` sends the PDF to models that read files and uses the free parser otherwise; \`ocr\` uses Mistral OCR, which OpenRouter bills per page.` };
    }
    if (PDF_ENGINES.indexOf(engine) < 0) return { kind: "notice", text: `Unknown PDF engine \`${args}\`. Use ${PDF_ENGINES.map((e) => `\`${e}\``).join(", ")}.` };
    const chat = ctx.ensureChat();
    mutateChat(ctx.host, chat.id, (current) => {
      current.settings.pdfEngine = engine;
    });
    return { kind: "notice", text: `PDF engine for this chat: **${engine}**${engine === "ocr" ? " (billed per page by OpenRouter)" : ""}.` };
  },
};

export const feature: Feature = {
  commands: { attach, paste, attachments, detach, pdf },
  payloadOptions,
  validateBody(_ctx, body) {
    return body.length > MAX_BODY_BYTES ? `The message with its files is ${megabytes(body.length)} once encoded, over the ${megabytes(MAX_BODY_BYTES).replace(".0", "")} limit. Nothing was sent; detach a file with \`/detach\`.` : null;
  },
  footerFlags(ctx) {
    const flags: string[] = [];
    const notice = ctx.host.env.attach_notice;
    if (notice) flags.push(`⚠ ${notice}`);
    // OCR is billed per page, so a chat that uses it says so.
    if ((ctx.chat?.settings.pdfEngine ?? ctx.config.pdfEngine) === "ocr") flags.push("pdf ocr");
    const pending = ctx.chat?.pending ?? [];
    if (pending.length > 0) flags.push(`📎 ${pending.length} waiting (${formatSize(pending.reduce((sum, ref) => sum + ref.size, 0))})`);
    return flags;
  },
};
