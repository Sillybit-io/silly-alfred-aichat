import { readConfig } from "../features/index";
import type { Host } from "../host/types";
import { newestImage } from "../store/images";

// The path Reveal in Finder receives: the newest saved image, or nothing.
export function main(host: Host, _argv: string[]): string {
  return newestImage(host, readConfig(host)) ?? "";
}
