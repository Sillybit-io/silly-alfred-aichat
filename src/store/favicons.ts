import { domainOf, isRasterIcon, isSafeDomain, MAX_ICON_BYTES } from "../core/favicons";
import { sha256Hex } from "../core/sha256";
import type { Host } from "../host/types";
import { cacheDir } from "./chats";

const ICON_SERVICE = "https://icons.duckduckgo.com/ip3";
const ICON_SIZE = 32;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const BAD_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const STUCK_MS = 30 * 1000;

const folder = (host: Host) => `${cacheDir(host)}/favicons`;

function ascii(text: string): Uint8Array {
  return Uint8Array.from({ length: text.length }, (_, i) => text.charCodeAt(i) & 0x7f);
}

export function faviconPaths(host: Host, domain: string) {
  const key = sha256Hex(ascii(domain)).slice(0, 24);
  const base = `${folder(host)}/${key}`;
  return { png: `${base}.png`, raw: `${base}.raw`, exit: `${base}.exit`, pid: `${base}.pid`, err: `${base}.err`, bad: `${base}.bad`, started: `${base}.started` };
}

function age(host: Host, path: string): number | null {
  const info = host.stat(path);
  return info ? host.nowMs() - info.mtimeMs : null;
}

function cleanup(host: Host, files: ReturnType<typeof faviconPaths>): void {
  for (const path of [files.raw, files.exit, files.pid, files.err, files.started]) host.remove(path);
}

// A finished download is checked, then re-encoded as a small PNG: nothing but sips' own output is ever shown.
function finish(host: Host, files: ReturnType<typeof faviconPaths>): string | null {
  let ok = false;
  try {
    const exit = Number(host.readText(files.exit).trim());
    const info = host.stat(files.raw);
    if (exit === 0 && info && info.size > 0 && info.size <= MAX_ICON_BYTES && isRasterIcon(host.readBytesFrom(files.raw, 0))) {
      const result = host.runSync(["/usr/bin/sips", "-s", "format", "png", "-Z", String(ICON_SIZE), files.raw, "--out", files.png], { timeoutMs: 10000 });
      ok = result.exit === 0 && host.exists(files.png);
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    host.remove(files.png);
    host.writeAtomic(files.bad, "bad");
  }
  cleanup(host, files);
  return ok ? files.png : null;
}

function start(host: Host, domain: string, files: ReturnType<typeof faviconPaths>): void {
  cleanup(host, files);
  const base = host.env.aichat_favicon_base ?? ICON_SERVICE;
  // Only the built-in https service is used; the override exists for tests that serve icons locally.
  const scheme = base.startsWith("http://") ? "http" : "https";
  host.writeAtomic(files.started, String(host.nowMs()));
  host.spawnSupervised(
    [
      host.env.aichat_curl ?? "/usr/bin/curl",
      "--silent",
      "--show-error",
      "--fail",
      "--proto", `=${scheme}`,
      "--proto-redir", "=https",
      "--max-redirs", "2",
      "--max-filesize", String(MAX_ICON_BYTES),
      "--connect-timeout", "4",
      "--max-time", "8",
      "-o", files.raw,
      `${base}/${domain}.ico`,
    ],
    { pid: files.pid, exit: files.exit, stderr: files.err },
  );
}

// The icon for each domain if it is cached. With start set, a missing one is downloaded in the background:
// only validated public domain names are ever requested, and only the domain leaves the machine.
export function resolveFavicons(host: Host, domains: string[], options: { start: boolean }): Map<string, string | null> {
  const found = new Map<string, string | null>();
  host.mkdirp(folder(host));
  for (const domain of domains) {
    if (!isSafeDomain(domain)) {
      found.set(domain, null);
      continue;
    }
    const files = faviconPaths(host, domain);
    const pngAge = age(host, files.png);
    if (pngAge !== null && pngAge < MAX_AGE_MS) {
      found.set(domain, files.png);
      continue;
    }
    const badAge = age(host, files.bad);
    if (badAge !== null && badAge < BAD_RETRY_MS) {
      found.set(domain, null);
      continue;
    }
    if (host.exists(files.exit)) {
      found.set(domain, finish(host, files));
      continue;
    }
    const startedAge = age(host, files.started);
    if (startedAge !== null && startedAge < STUCK_MS) {
      found.set(domain, null);
      continue;
    }
    if (options.start) start(host, domain, files);
    found.set(domain, null);
  }
  return found;
}

// Starts what is missing and waits a short moment for it, so a fresh reply shows its icons at once.
export function loadFavicons(host: Host, domains: string[], waitMs: number): Map<string, string | null> {
  let found = resolveFavicons(host, domains, { start: true });
  const deadline = host.nowMs() + waitMs;
  while (host.nowMs() < deadline && domains.some((domain) => found.get(domain) === null && isSafeDomain(domain) && host.exists(faviconPaths(host, domain).started))) {
    host.sleepMs(100);
    found = resolveFavicons(host, domains, { start: false });
  }
  return found;
}

export { domainOf };
