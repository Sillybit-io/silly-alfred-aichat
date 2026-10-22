import type { Host } from "../host/types";
import { dataDir } from "./chats";
import { withLock } from "./lock";

export type Settings = {
  schema: 1;
  defaultModel: string | null;
  lastModel: string | null;
  favorites: string[];
};

function emptySettings(): Settings {
  return { schema: 1, defaultModel: null, lastModel: null, favorites: [] };
}

function path(host: Host): string {
  return `${dataDir(host)}/settings.json`;
}

export function getSettings(host: Host): Settings {
  try {
    const parsed = JSON.parse(host.readText(path(host))) as Partial<Settings>;
    return {
      schema: 1,
      defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : null,
      lastModel: typeof parsed.lastModel === "string" ? parsed.lastModel : null,
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites.filter((id): id is string => typeof id === "string") : [],
    };
  } catch {
    return emptySettings();
  }
}

// Field-level change under the settings lock; the API key and usage figures never live here.
export function mutateSettings(host: Host, fn: (settings: Settings) => void): Settings {
  host.mkdirp(dataDir(host));
  return withLock(host, `${dataDir(host)}/settings.lock`, () => {
    const settings = getSettings(host);
    fn(settings);
    host.writeAtomic(path(host), JSON.stringify(settings, null, 2));
    return settings;
  });
}

export function setDefaultModel(host: Host, id: string): Settings {
  return mutateSettings(host, (settings) => {
    settings.defaultModel = id;
  });
}

export function setLastModel(host: Host, id: string): Settings {
  return mutateSettings(host, (settings) => {
    settings.lastModel = id;
  });
}

export function toggleFavorite(host: Host, id: string): { settings: Settings; favorite: boolean } {
  let favorite = false;
  const settings = mutateSettings(host, (current) => {
    const index = current.favorites.indexOf(id);
    if (index >= 0) current.favorites.splice(index, 1);
    else {
      current.favorites.push(id);
      favorite = true;
    }
  });
  return { settings, favorite };
}
