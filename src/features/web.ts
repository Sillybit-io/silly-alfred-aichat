import { lastReply, sourceLine, sourcesOf } from "../core/transcript";
import { mutateChat } from "../store/chats";
import type { Command, Feature } from "./index";

const web: Command = {
  usage: "/web [on | off | status]",
  help: "Let the model search the web in this chat",
  run(ctx, args) {
    const value = args.toLowerCase();
    if (value === "" || value === "status") {
      const on = ctx.chat ? ctx.chat.settings.web : ctx.config.webDefault;
      return { kind: "notice", text: `Web search is **${on ? "on" : "off"}** for this chat. Use \`/web on\` or \`/web off\`.` };
    }
    if (value !== "on" && value !== "off") return { kind: "notice", text: "Use `/web on` or `/web off`." };
    const chat = ctx.ensureChat();
    mutateChat(ctx.host, chat.id, (current) => {
      current.settings.web = value === "on";
    });
    return { kind: "notice", text: value === "on" ? `Web search is on for this chat (up to ${ctx.config.webMaxResults} results per message). OpenRouter bills web search separately, so turn it off when you do not need it.` : "Web search is off for this chat." };
  },
};

const sources: Command = {
  usage: "/sources",
  help: "List every source the last reply cited",
  run(ctx) {
    const reply = ctx.chat ? lastReply(ctx.chat) : null;
    const list = reply ? sourcesOf(reply) : [];
    if (list.length === 0) return { kind: "notice", text: "The last reply cited no sources." };
    return { kind: "notice", text: ["**Sources**", ...list.map((source, i) => `${i + 1}. ${sourceLine(source)}`)].join("\n") };
  },
};

export const feature: Feature = {
  commands: { web, sources },
  payloadOptions(ctx) {
    return { options: { web: ctx.chat.settings.web, webMaxResults: ctx.config.webMaxResults } };
  },
  footerFlags(ctx) {
    return ctx.chat?.settings.web ? ["web"] : [];
  },
};
