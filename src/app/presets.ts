import { outputLabel, type Preset } from "../core/presets";
import type { Host } from "../host/types";
import { loadPresets } from "../store/presets";

export const EDIT_ID = "@edit";

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 70 ? `${flat.slice(0, 67)}…` : flat;
}

// The input is the selected text handed over by the Universal Action, else the clipboard.
export function inputText(host: Host): string {
  const given = host.env.preset_text;
  if (given !== undefined && given !== "") return given;
  return host.clipboardText() ?? "";
}

function matches(preset: Preset, query: string): boolean {
  const haystack = `${preset.name} ${preset.id}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "")
    .every((word) => haystack.indexOf(word) >= 0);
}

export function main(host: Host, argv: string[]): string {
  const query = argv[0] ?? "";
  const loaded = loadPresets(host);
  const text = inputText(host);
  const items: Record<string, unknown>[] = [];

  if (loaded.errors.length > 0) {
    const first = loaded.errors[0]!;
    items.push({ title: `presets.json has a problem on line ${first.line}`, subtitle: `${first.message}${loaded.errors.length > 1 ? ` (and ${loaded.errors.length - 1} more)` : ""}. Fix it with Edit presets.json.`, valid: false });
  }
  for (const preset of loaded.presets.filter((candidate) => matches(candidate, query))) {
    const what = text === "" ? "No text: select some and use the Universal Action, or copy some first" : `“${preview(text)}”`;
    items.push({
      title: preset.name,
      subtitle: `${outputLabel(preset.output)} · ${what}`,
      arg: text,
      valid: text !== "",
      variables: { preset_id: preset.id },
    });
  }
  if (query.trim() === "" || "edit presets.json".indexOf(query.toLowerCase().trim()) >= 0 || "edit".indexOf(query.toLowerCase().trim()) >= 0) {
    items.push({ title: "Edit presets.json", subtitle: loaded.path.replace(host.env.HOME ?? "\u0000", "~"), arg: "", valid: true, variables: { preset_id: EDIT_ID } });
  }
  return JSON.stringify({ items });
}
