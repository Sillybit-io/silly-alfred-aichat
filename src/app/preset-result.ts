import type { Host } from "../host/types";
import { dataDir } from "../store/chats";

export type LastResult = { name: string; reply: string };

const path = (host: Host) => `${dataDir(host)}/last-preset.json`;

export function saveLastResult(host: Host, name: string, reply: string): void {
  host.mkdirp(dataDir(host));
  host.writeAtomic(path(host), JSON.stringify({ name, reply } satisfies LastResult));
}

export function loadLastResult(host: Host): LastResult | null {
  try {
    const parsed = JSON.parse(host.readText(path(host))) as Partial<LastResult>;
    return typeof parsed.reply === "string" ? { name: typeof parsed.name === "string" ? parsed.name : "Preset", reply: parsed.reply } : null;
  } catch {
    return null;
  }
}
