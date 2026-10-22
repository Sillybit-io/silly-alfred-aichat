import type { Chat } from "../store/chats";
import { acceptsFile, acceptsImage, type ModelRecord } from "../core/capabilities";
import { formatSubtitle, searchModels } from "../core/models-search";
import { ensureCatalog } from "../store/catalog";
import { mutateChat } from "../store/chats";
import { getSettings, setLastModel } from "../store/settings";
import type { Command, CommandContext, Feature } from "./index";

type Needs = { image: boolean; file: boolean };

// The parts already in the chat that a model must read itself. A PDF only needs a file-capable model
// under the native engine; the other engines turn it into text for any model.
export function chatNeeds(chat: Chat | null, pdfEngine: string): Needs {
  const needs: Needs = { image: false, file: false };
  if (!chat) return needs;
  const engine = chat.settings.pdfEngine ?? pdfEngine;
  for (const ref of [...chat.messages.flatMap((message) => message.attachments), ...chat.pending]) {
    if (ref.kind === "image") needs.image = true;
    if (ref.kind === "file" && engine === "native") needs.file = true;
  }
  return needs;
}

export function modelCovers(model: ModelRecord, needs: Needs): boolean {
  return (!needs.image || acceptsImage(model)) && (!needs.file || acceptsFile(model));
}

function setModel(ctx: CommandContext, models: ModelRecord[], id: string, record: ModelRecord | null): string {
  const needs = chatNeeds(ctx.chat, ctx.config.pdfEngine);
  let suffix = "";
  if (record && !modelCovers(record, needs)) {
    const fallbackId = ctx.config.visionFallbackModel;
    const fallback = fallbackId === "" ? null : (models.find((model) => model.id === fallbackId) ?? null);
    if (!fallback || !modelCovers(fallback, needs)) {
      const what = needs.image && needs.file ? "images and PDFs" : needs.image ? "images" : "PDFs";
      return `**${record.name}** cannot read the ${what} already in this chat, and no vision fallback model is set. The model was not changed. Start a \`/new\` chat or pick a model that accepts ${what}.`;
    }
    suffix = ` Requests that include ${needs.image ? "images" : "PDFs"} will use ${fallback.name} instead.`;
  }
  const chat = ctx.ensureChat();
  mutateChat(ctx.host, chat.id, (current) => {
    current.model = id;
  });
  setLastModel(ctx.host, id);
  return `Chat model: **${record?.name ?? id}** (\`${id}\`).${suffix}`;
}

const model: Command = {
  usage: "/model [query | id | default]",
  help: "Show or change this chat's model; a query lists matches",
  run(ctx, args) {
    const catalog = ensureCatalog(ctx.host);
    const settings = getSettings(ctx.host);
    const defaultId = settings.defaultModel ?? ctx.config.defaultModel;
    if (args === "") {
      const current = ctx.chat?.model;
      return { kind: "notice", text: current ? `Chat model: \`${current}\`. Default: \`${defaultId}\`.` : `Chat model: the default, \`${defaultId}\`.` };
    }
    if (args.toLowerCase() === "default") {
      const chat = ctx.ensureChat();
      mutateChat(ctx.host, chat.id, (current) => {
        current.model = null;
      });
      return { kind: "notice", text: `This chat now uses the default model, \`${defaultId}\`.` };
    }
    const exact = catalog.models.find((m) => m.id.toLowerCase() === args.toLowerCase());
    if (exact) return { kind: "notice", text: setModel(ctx, catalog.models, exact.id, exact) };
    if (catalog.models.length === 0 && /^[^\s/]+\/[^\s]+$/.test(args)) {
      return { kind: "notice", text: setModel(ctx, catalog.models, args, null) };
    }
    const matches = searchModels(catalog.models, args, { favorites: settings.favorites, limit: 8 });
    if (matches.length === 0) {
      return { kind: "notice", text: `No model matches \`${args}\`.${catalog.note ? ` ${catalog.note}.` : ""} Try the \`aimodels\` keyword to browse.` };
    }
    const lines = matches.map((m) => `- \`${m.id}\` — ${m.name} · ${formatSubtitle(m)}`);
    return { kind: "notice", text: [`**Models matching \`${args}\`**`, ...lines, "", "Use `/model <id>` to pick one."].join("\n") };
  },
};

export const feature: Feature = { commands: { model } };
