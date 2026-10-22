import { formatSubtitle, searchModels } from "../core/models-search";
import type { ModelRecord } from "../core/capabilities";
import { readConfig } from "../features/index";
import type { Host } from "../host/types";
import { ensureCatalog } from "../store/catalog";
import { currentChat } from "../store/current-chat";
import { getSettings } from "../store/settings";

const MAX_ITEMS = 60;

type Item = Record<string, unknown>;

function modItem(subtitle: string, id: string, action: string): Item {
  return { valid: true, subtitle, arg: id, variables: { model_action: action } };
}

// The Script Filter for aimodels: search, mark the current, default, and favorite models, and
// refresh a stale list in the background (ensureCatalog does that without waiting).
export function main(host: Host, argv: string[]): string {
  const config = readConfig(host);
  const query = argv[0] ?? "";
  const catalog = ensureCatalog(host);
  const settings = getSettings(host);
  const chat = currentChat(host);
  const defaultId = settings.defaultModel ?? config.defaultModel;
  const currentId = chat?.model ?? defaultId;

  const found = searchModels(catalog.models, query, { favorites: settings.favorites, limit: MAX_ITEMS });
  const items: Item[] = found.map((model: ModelRecord) => {
    const favorite = settings.favorites.indexOf(model.id) >= 0;
    const marks = [model.id === currentId ? "●" : "", favorite ? "★" : "", model.id === defaultId ? "default" : ""].filter((m) => m !== "");
    return {
      title: marks.length > 0 ? `${model.name}  ${marks.join(" ")}` : model.name,
      subtitle: `${model.id} · ${formatSubtitle(model)}`,
      arg: model.id,
      autocomplete: model.id,
      valid: true,
      variables: { model_action: "use" },
      mods: {
        cmd: modItem("Set as the default model", model.id, "default"),
        alt: modItem(favorite ? "Remove from favorites" : "Add to favorites", model.id, "favorite"),
        ctrl: modItem("Copy the model id", model.id, "copy"),
      },
    };
  });
  if (items.length === 0) {
    items.push({
      title: catalog.models.length === 0 ? "The model list is not available" : "No models match",
      subtitle: catalog.models.length === 0 ? (catalog.note ?? "Check your connection and try again") : "Try fewer words, or #image #imagegen #file #free #reasoning",
      valid: false,
    });
  } else if (catalog.note) {
    items.push({ title: "Model list note", subtitle: catalog.note, valid: false });
  }
  return JSON.stringify({ skipknowledge: true, items });
}
