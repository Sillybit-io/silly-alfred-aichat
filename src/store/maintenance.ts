import type { Host } from "../host/types";
import { cacheDir, dataDir } from "./chats";
import { laneRecordId, loadRecord, requestDir, requestsDir } from "./requests";

const PRIVATE_MARK = ".private-v1";
const SWEPT_MARK = ".swept";
const SWEEP_EVERY_MS = 60 * 60 * 1000;

// Every script entry passes its host through here, so no way into the workflow skips the first-run work.
export function maintained(host: Host): Host {
  runMaintenance(host);
  return host;
}

// Once per install: data written by an earlier version becomes private to the user, and the icon cache of a removed
// feature goes. Every run, an expired preset reply goes. Then, at most hourly, leftover request folders are swept. Nothing here may stop the workflow, so a
// failure is only logged.
export function runMaintenance(host: Host): void {
  try {
    const data = dataDir(host);
    const cache = cacheDir(host);
    expirePresetResult(host);
    const swept = host.stat(`${data}/${SWEPT_MARK}`);
    const fresh = swept !== null && host.nowMs() - swept.mtimeMs <= SWEEP_EVERY_MS;
    if (fresh && host.exists(`${data}/${PRIVATE_MARK}`)) return;
    host.mkdirp(data);
    host.mkdirp(cache);
    if (!host.exists(`${data}/${PRIVATE_MARK}`)) {
      host.restrict(data);
      host.restrict(cache);
      host.remove(`${cache}/favicons`);
      host.writeAtomic(`${data}/${PRIVATE_MARK}`, "1");
    }
    if (!fresh) {
      sweepRequests(host);
      host.writeAtomic(`${data}/${SWEPT_MARK}`, String(host.nowMs()));
    }
  } catch (error) {
    host.log(`maintenance failed: ${String(error)}`);
  }
}

export const PRESET_RESULT_MAX_AGE_MS = 60 * 60 * 1000;

// The last preset reply is kept so its view can copy it. It holds text the user selected, so once it is an hour old it
// is never shown again and is deleted the next time any part of the workflow runs; this costs one stat, so it is checked
// on every run rather than with the hourly sweep. Returns whether a reply was there and is still current.
export function expirePresetResult(host: Host): boolean {
  const path = `${dataDir(host)}/last-preset.json`;
  const info = host.stat(path);
  if (info === null) return false;
  if (host.nowMs() - info.mtimeMs < PRESET_RESULT_MAX_AGE_MS) return true;
  host.remove(path);
  return false;
}

// What goes: a folder whose record is missing or unreadable, one already finalized, and one that no lane points to
// (nothing would ever pick it up). What stays, however old: a request that is running, and one that finished while the
// window was closed. Its body is already gone (the supervisor deletes it when curl ends), what is left is the reply,
// which the next visit saves into the chat; deleting it would lose a reply the user never saw.
function sweepRequests(host: Host): void {
  if (!host.exists(requestsDir(host))) return;
  const now = host.nowMs();
  for (const rid of host.listDir(requestsDir(host))) {
    const dir = requestDir(host, rid);
    const info = host.stat(dir);
    if (info === null || now - info.mtimeMs < SWEEP_EVERY_MS) continue;
    const record = loadRecord(host, rid);
    const valid = record !== null && typeof record.id === "string" && typeof record.lane === "string" && typeof record.startedAt === "number";
    if (!valid || record.final || laneRecordId(host, record.lane) !== rid) host.remove(dir);
  }
}
