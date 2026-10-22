import { normalizeModel, type ModelRecord } from "../core/capabilities";
import { lastStatus, mapCurlExit } from "../core/errors";
import { apiBase } from "../core/payload";
import type { Host } from "../host/types";
import { cacheDir } from "./chats";

export const CATALOG_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;
const STUCK_REFRESH_MS = 2 * 60 * 1000;

export type CatalogCache = { fetchedAt: number; models: ModelRecord[] };

export type CatalogResult = {
  models: ModelRecord[];
  // One line for the footer when the list is missing or a refresh failed.
  note: string | null;
  refreshing: boolean;
};

const cacheFile = (host: Host) => `${cacheDir(host)}/models.json`;
const transportDir = (host: Host) => `${cacheDir(host)}/catalog`;
const part = (host: Host) => `${transportDir(host)}/models.part`;
const files = (host: Host) => ({
  pid: `${transportDir(host)}/models.pid`,
  exit: `${transportDir(host)}/models.exit`,
  stderr: `${transportDir(host)}/models.stderr`,
  headers: `${transportDir(host)}/models.headers`,
});
const failedAt = (host: Host) => `${transportDir(host)}/failed-at`;
const startedAt = (host: Host) => `${transportDir(host)}/started-at`;

function curl(host: Host): string {
  return host.env.aichat_curl ?? "/usr/bin/curl";
}

// output_modalities=all keeps image-generation models, which the default text-only list omits.
function curlArgs(host: Host, extra: string[]): string[] {
  return [
    curl(host),
    "-o",
    part(host),
    "-D",
    files(host).headers,
    "--silent",
    "--show-error",
    "--connect-timeout",
    "10",
    ...extra,
    `${apiBase(host.env)}/models?output_modalities=all`,
  ];
}

export function loadCatalog(host: Host): CatalogCache | null {
  try {
    const parsed = JSON.parse(host.readText(cacheFile(host))) as Partial<CatalogCache>;
    if (typeof parsed.fetchedAt !== "number" || !Array.isArray(parsed.models)) return null;
    return { fetchedAt: parsed.fetchedAt, models: parsed.models };
  } catch {
    return null;
  }
}

function readTrimmed(host: Host, path: string): string | null {
  try {
    return host.readText(path).trim();
  } catch {
    return null;
  }
}

function clearTransport(host: Host): void {
  const f = files(host);
  for (const path of [part(host), f.pid, f.exit, f.stderr, f.headers, startedAt(host)]) host.remove(path);
}

// Accepts a download only when curl succeeded, the status is 200, and the body has a data array.
function installDownload(host: Host, curlExit: number): { ok: true } | { ok: false; reason: string } {
  if (curlExit !== 0) return { ok: false, reason: mapCurlExit(curlExit).title };
  const status = lastStatus(readTrimmed(host, files(host).headers) ?? "");
  if (!status || status.status !== 200) return { ok: false, reason: `HTTP ${status ? status.status : "?"}` };
  let body: unknown;
  try {
    body = JSON.parse(host.readText(part(host)));
  } catch {
    return { ok: false, reason: "unreadable list" };
  }
  const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return { ok: false, reason: "unexpected list" };
  const models = data.map(normalizeModel).filter((model): model is ModelRecord => model !== null);
  host.writeAtomic(cacheFile(host), JSON.stringify({ fetchedAt: host.nowMs(), models } satisfies CatalogCache));
  return { ok: true };
}

function refreshInFlight(host: Host): boolean {
  if (host.exists(files(host).exit)) return false;
  const started = Number(readTrimmed(host, startedAt(host)));
  if (!Number.isFinite(started) || started <= 0) return false;
  if (host.nowMs() - started > STUCK_REFRESH_MS) {
    clearTransport(host);
    return false;
  }
  return true;
}

// Returns at once whenever any cache exists: a finished background refresh is installed first,
// and a stale cache starts a new one that a later call installs.
export function ensureCatalog(host: Host): CatalogResult {
  host.mkdirp(transportDir(host));
  const f = files(host);
  let note: string | null = null;

  const finished = readTrimmed(host, f.exit);
  if (finished !== null) {
    const result = installDownload(host, Number(finished));
    clearTransport(host);
    if (!result.ok) {
      note = `Model list refresh failed (${result.reason}); showing the saved list`;
      host.writeAtomic(failedAt(host), String(host.nowMs()));
    } else {
      host.remove(failedAt(host));
    }
  }

  let cache = loadCatalog(host);
  if (!cache) {
    clearTransport(host);
    const run = host.runSync(curlArgs(host, ["--max-time", "10"]), { timeoutMs: 15000 });
    const result = installDownload(host, run.exit);
    clearTransport(host);
    if (!result.ok) return { models: [], note: `Could not load the model list (${result.reason})`, refreshing: false };
    cache = loadCatalog(host);
    return { models: cache ? cache.models : [], note: null, refreshing: false };
  }

  let refreshing = refreshInFlight(host);
  if (!refreshing && host.nowMs() - cache.fetchedAt > CATALOG_MAX_AGE_MS) {
    const failed = Number(readTrimmed(host, failedAt(host)) ?? 0);
    if (host.nowMs() - failed > RETRY_AFTER_FAILURE_MS) {
      clearTransport(host);
      host.writeAtomic(startedAt(host), String(host.nowMs()));
      host.spawnSupervised(curlArgs(host, ["--max-time", "60"]), { pid: f.pid, exit: f.exit, stderr: f.stderr });
      refreshing = true;
    }
  }
  return { models: cache.models, note, refreshing };
}

export function listModels(host: Host): ModelRecord[] {
  return ensureCatalog(host).models;
}

// Reads the cache only; never fetches, so a footer can name a model without waiting.
export function getModel(host: Host, id: string): ModelRecord | null {
  const cache = loadCatalog(host);
  return cache ? (cache.models.find((model) => model.id === id) ?? null) : null;
}
