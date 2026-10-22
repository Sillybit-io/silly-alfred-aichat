import type { ContextInfo } from "../core/system-prompt";
import type { Host } from "../host/types";
import { cacheDir } from "./chats";

const MAX_AGE_MS = 60 * 60 * 1000;

type Cached = { at: number; timezone: string | null; locale: string | null; os: string | null };

function run(host: Host, argv: string[]): string | null {
  try {
    const result = host.runSync(argv, { timeoutMs: 3000 });
    const text = result.stdout.trim();
    return result.exit === 0 && text !== "" ? text : null;
  } catch {
    return null;
  }
}

// Locale, macOS version, and timezone name change rarely, so they are looked up at most once an hour.
export function readContextInfo(host: Host): ContextInfo {
  const path = `${cacheDir(host)}/context.json`;
  let cached: Cached | null = null;
  try {
    const parsed = JSON.parse(host.readText(path)) as Cached;
    if (host.nowMs() - parsed.at < MAX_AGE_MS) cached = parsed;
  } catch {
    // no cache yet
  }
  if (!cached) {
    const link = run(host, ["/usr/bin/readlink", "/etc/localtime"]);
    const zone = link ? /zoneinfo\/(.+)$/.exec(link)?.[1] : undefined;
    cached = {
      at: host.nowMs(),
      timezone: zone ?? null,
      locale: run(host, ["/usr/bin/defaults", "read", "-g", "AppleLocale"]),
      os: run(host, ["/usr/bin/sw_vers", "-productVersion"]),
    };
    try {
      host.mkdirp(cacheDir(host));
      host.writeAtomic(path, JSON.stringify(cached));
    } catch {
      // the lookup is repeated next time
    }
  }
  return { nowMs: host.nowMs(), offsetMinutes: new Date(host.nowMs()).getTimezoneOffset(), timezone: cached.timezone, locale: cached.locale, os: cached.os };
}
