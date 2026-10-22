import { readConfig } from "../features/index";
import type { Host } from "../host/types";
import { getModel } from "../store/catalog";
import { mutateChat } from "../store/chats";
import { ensureCurrentChat } from "../store/current-chat";
import { setDefaultModel, setLastModel, toggleFavorite } from "../store/settings";
import { envelope } from "./view";

// The arg is the model id only for the clipboard route, so view_chat never receives it as a message.
export function main(host: Host, argv: string[]): string {
  const id = (argv[0] ?? "").trim();
  const action = (host.env.model_action ?? "use").trim();
  if (id === "") return envelope("", { model_next: "notify", notice: "No model was chosen" });
  const label = getModel(host, id)?.name ?? id;

  if (action === "copy") return envelope(id, { model_next: "clipboard", notice: "" });
  if (action === "default") {
    setDefaultModel(host, id);
    return envelope("", { model_next: "notify", notice: `Default model: ${label}` });
  }
  if (action === "favorite") {
    const { favorite } = toggleFavorite(host, id);
    return envelope("", { model_next: "notify", notice: favorite ? `Added ${label} to favorites` : `Removed ${label} from favorites` });
  }
  const chat = ensureCurrentChat(host, readConfig(host));
  mutateChat(host, chat.id, (current) => {
    current.model = id;
  });
  setLastModel(host, id);
  return envelope("", { model_next: "view", notice: "" });
}
