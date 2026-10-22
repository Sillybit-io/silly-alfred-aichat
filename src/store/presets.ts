import { defaultPresetsJson, parsePresets, type Preset, type PresetError } from "../core/presets";
import type { Host } from "../host/types";
import { dataDir } from "./chats";

export const presetsPath = (host: Host) => `${dataDir(host)}/presets.json`;

export type LoadedPresets = { presets: Preset[]; errors: PresetError[]; path: string };

// presets.json is created with the defaults on first use and never overwritten afterwards.
export function loadPresets(host: Host): LoadedPresets {
  const path = presetsPath(host);
  if (!host.exists(path)) {
    host.mkdirp(dataDir(host));
    host.writeAtomic(path, defaultPresetsJson());
  }
  const parsed = parsePresets(host.readText(path));
  return { ...parsed, path };
}
