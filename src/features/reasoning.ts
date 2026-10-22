import { efforts, supportsReasoning, type ModelRecord } from "../core/capabilities";
import { getModel } from "../store/catalog";
import { mutateChat, type Chat } from "../store/chats";
import { getSettings } from "../store/settings";
import type { Command, CommandContext, Feature } from "./index";

const ALL_EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "model"];

function modelFor(ctx: CommandContext): ModelRecord | null {
  const id = ctx.chat?.model ?? getSettings(ctx.host).defaultModel ?? ctx.config.defaultModel;
  return getModel(ctx.host, id);
}

function blockquote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

function label(effort: string | null): string {
  return effort === null ? "the model's own default" : effort === "none" ? "off" : effort;
}

const think: Command = {
  usage: "/think [off | minimal | low | medium | high | xhigh | max | model]",
  help: "Set how hard the model reasons in this chat",
  run(ctx, args) {
    const model = modelFor(ctx);
    const requested = args.toLowerCase();
    if (requested === "") {
      const supported = efforts(model).map((e) => (e === "none" ? "off" : e));
      const current = label(ctx.chat?.settings.effort ?? null);
      return { kind: "notice", text: supported.length === 0 ? `Reasoning effort: ${current}. This model has no reasoning controls.` : `Reasoning effort: ${current}. This model supports ${supported.map((e) => `\`${e}\``).join(", ")}, or \`model\` for its own default.` };
    }
    if (ALL_EFFORTS.indexOf(requested) < 0) return { kind: "notice", text: `Unknown effort \`${args}\`. Use ${ALL_EFFORTS.map((e) => `\`${e}\``).join(", ")}.` };
    let value: string | null = requested === "model" ? null : requested === "off" ? "none" : requested;
    if (value !== null && model) {
      if (!supportsReasoning(model)) return { kind: "notice", text: `**${model.name}** has no reasoning controls, so the setting was not changed.` };
      if (value === "none" && model.reasoning!.mandatory) return { kind: "notice", text: `Reasoning cannot be turned off for **${model.name}**; it always reasons. The setting was not changed. Try ${efforts(model).map((e) => `\`${e}\``).join(", ")}.` };
      if (efforts(model).indexOf(value) < 0) return { kind: "notice", text: `**${model.name}** does not support \`${requested}\`. It supports ${efforts(model).map((e) => `\`${e === "none" ? "off" : e}\``).join(", ")}. The setting was not changed.` };
    }
    const chat = ctx.ensureChat();
    mutateChat(ctx.host, chat.id, (current) => {
      current.settings.effort = value;
    });
    return { kind: "notice", text: `Reasoning effort for this chat: **${label(value)}**.` };
  },
};

const reasoning: Command = {
  usage: "/reasoning [on | off]",
  help: "Keep the reasoning under each reply (on) or show it only while streaming (off)",
  run(ctx, args) {
    const value = args.toLowerCase();
    if (value === "" || value === "status") {
      return { kind: "notice", text: `Reasoning is ${ctx.chat?.settings.showReasoning ? "kept under each reply" : "shown while streaming and then collapsed"}. Use \`/reasoning on\` or \`/reasoning off\`.` };
    }
    if (value !== "on" && value !== "off") return { kind: "notice", text: "Use `/reasoning on` or `/reasoning off`." };
    const chat = ctx.ensureChat();
    mutateChat(ctx.host, chat.id, (current) => {
      current.settings.showReasoning = value === "on";
    });
    return { kind: "notice", text: value === "on" ? "Reasoning will stay under each new reply." : "Reasoning shows while streaming and collapses to the answer." };
  },
};

export function effortFor(chat: Chat): string | null {
  return chat.settings.effort;
}

export const feature: Feature = {
  commands: { think, reasoning },
  payloadOptions(ctx) {
    return { options: { effort: effortFor(ctx.chat) } };
  },
  // Reasoning appears as a quote under a thinking heading until the answer starts; it stays above
  // the answer only when the chat keeps reasoning.
  renderLive(ctx) {
    const text = ctx.state.reasoning;
    if (text.trim() === "") return null;
    if (ctx.state.content === "") return `**Thinking…**\n\n${blockquote(text)}`;
    if (ctx.chat?.settings.showReasoning) return `${blockquote(text)}\n\n${ctx.state.content}`;
    return null;
  },
  footerFlags(ctx) {
    const effort = ctx.chat?.settings.effort ?? null;
    return effort === null ? [] : [`🧠 ${label(effort)}`];
  },
};
