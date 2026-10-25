import { openArgv } from "../core/imagegen";
import { readConfig } from "../features/index";
import type { Host } from "../host/types";
import { newestImage } from "../store/images";

// Opens the newest saved image in its default app (an SVG is shown in Finder); prints nothing for the next object.
export function main(host: Host, _argv: string[]): string {
  const path = newestImage(host, readConfig(host));
  if (path !== null) host.runSync(openArgv(path), { timeoutMs: 10000 });
  return "";
}
